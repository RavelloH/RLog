# Capture 指南

Capture 用于把文本流、二进制流或子进程的 stdout/stderr 增量保存到文件，并可选择镜像为 RLog 记录。它适合 CLI 工具输出、串口日志、构建过程和硬件调试数据。

Capture 不负责创建 Run 目录、决定文件名、保留或清理产物；调用方传入确定路径并负责这些业务策略。Capture 也不拥有传入的子进程，默认不会终止它。

## 安全边界

Capture 文件保存外部流数据。它们不会自动应用 `blockedWordsList` 或 `redactKeys`，因此可能包含 token、密码、设备输出、固件数据或其他敏感信息。调用方必须负责：

- 选择安全的保存位置和文件权限；
- 避免将敏感 Capture 文件提交到版本库；
- 制定保留与清理策略；
- 为证据文件选择合适的覆盖策略。

Capture 文件不参与普通 text 或 JSONL 轮转。

## 文本流 Capture

```js
const handle = rlog.capture.stream(serial, {
  file: "./runs/r-1/controller.serial.log",
  encoding: "utf8",
  fileMode: "truncate",
  displayLevel: "info",
  mirrorTargets: "screen",
  stripAnsiInFile: true,
  timestampLines: true,
  computeSha256: true,
  onLine(line) {
    // text、timestamp、terminated、lineNumber、rawBytes
    const message = tryParseJson(line.text);
    if (message?.type === "boot") onBoot(message);
  },
});

handle.mark("serial-opened", { port: "COM9" });
await handle.flush();
const result = await handle.done;
```

文本 Capture 使用 `StringDecoder` 处理 UTF-8 跨 chunk 字符；非法 UTF-8 会按 Node.js 的宽松替换语义处理。流结束时未换行的尾部也会作为 `terminated: false` 的最后一行交付。

`handle` 提供：

- `done`：完成时解析 `StreamCaptureResult`，失败时拒绝 `CaptureError`；
- `flush()`：等待已接受的数据、回调和文件写入；
- `close()`：手动成功结束 Capture，返回最终结果；
- `abort(reason?)`：停止 Capture，落盘已接受队列后以 `CAPTURE_ABORTED` 拒绝；
- `mark(label, metadata?)`：写出低频 `capture.mark` JSONL 结构化事件。

## 二进制 Capture

```js
const handle = rlog.capture.binary(binaryReadable, {
  file: "./runs/r-1/frame.raw",
  fileMode: "exclusive",
  computeSha256: true,
});

const result = await handle.done;
console.log(result.bytes, result.sha256);
```

二进制 Capture 不解码或变换字节，适用于固件、帧数据和协议转储。它提供 `done`、`flush()`、`close()` 和 `abort()`；关闭 Logger 时会排空已进入 `Readable` 缓冲区的数据，再关闭文件。

## 子进程 Capture

```js
const { spawn } = require("node:child_process");

const child = spawn("tool", ["--flash", "firmware.bin"]);
const result = await rlog.capture.process(child, {
  stdoutFile: "./runs/r-1/flash.stdout.log",
  stderrFile: "./runs/r-1/flash.stderr.log",
  stdoutDisplay: "info",
  stderrDisplay: "warn",
  mirrorTargets: "screen",
  preserveRawBytes: false,
  stripAnsiInFiles: true,
  computeSha256: true,
  onStdoutLine(line) {
    observeToolOutput(line.text);
  },
  onStderrLine(line) {
    observeToolWarning(line.text);
  },
});

console.log(result.exitCode, result.signal);
```

`process()` 保持原有 Promise 入口。若需要停止某个 Capture、但继续使用 Logger，请使用 `processHandle()`：

```js
const capture = rlog.capture.processHandle(child, {
  stdoutFile: "./runs/r-1/tool.stdout.log",
});

// 调用方管理进程生命周期；RLog 默认只停止 Capture。
child.kill();
await capture.abort("operation-timeout");
```

`ProcessCaptureHandle` 提供 `done`、`flush()` 和 `abort()`。除非显式设置 `killProcessOnAbort: true`，`abort()`、`AbortSignal` 和 Logger `close()` 都不会杀死子进程。

## 路由、上下文与行回调

从 Child Logger 创建 Capture 时，镜像记录和 `mark()` 事件会保留当前 Child Logger 的 context：

```js
const flash = rlog.child({ device: "controller", stage: "flash" });
flash.capture.stream(serial, {
  file: "./runs/r-1/serial.log",
  displayLevel: "info",
});
```

镜像默认只写入 `screen`，以免高频串口或工具输出淹没普通文本与 JSONL。需要时显式指定：

```js
mirrorTargets: "all"
// 或
mirrorTargets: new Set(["screen", "jsonl"])
```

`onLine`（文本流）、`onStdoutLine`、`onStderrLine`（进程）和进程统一 `onLine` 都支持返回 Promise。回调的异常默认会使 Capture 以 `CAPTURE_CONSUMER_ERROR` 失败，这适合启动握手等关键验证；纯旁观用途可设置：

```js
consumerErrorPolicy: "ignore"
```

## 文件模式

Capture 的 `fileMode` 默认是 `"truncate"`：路径复用时会先清空旧内容，确保文件内容与本次结果的字节数和哈希一致。

| 值 | Node.js 打开方式 | 用途 |
| --- | --- | --- |
| `"truncate"` | `w` | 默认；一次任务一个新文件 |
| `"append"` | `a` | 只有明确需要拼接时使用 |
| `"exclusive"` | `wx` | 证据文件；目标已存在即失败 |

## 取消、背压与长行

所有 Capture 选项都支持 `signal`：

```js
const controller = new AbortController();
const handle = rlog.capture.stream(source, {
  file: "./runs/r-1/serial.log",
  signal: controller.signal,
});

controller.abort();
```

取消后 Capture 停止接收新数据，等待已接受的写入收尾，关闭文件，并让 `done` 以 `CAPTURE_ABORTED` 拒绝。Logger 关闭导致的进程 Capture 结束使用 `CAPTURE_ABORTED_BY_LOGGER_CLOSE`。无论哪种情况，都应 `await` 或捕获 `done`。

为避免来源速度高于磁盘写入速度时无限占用内存，Capture 使用以下默认值：

| 选项 | 默认值 | 作用 |
| --- | ---: | --- |
| `highWaterMarkBytes` | 4 MiB | 队列达到此值时暂停 Readable |
| `lowWaterMarkBytes` | 1 MiB | 队列降到此值时恢复 Readable |
| `maxPendingBytes` | 16 MiB | 超过时以 `CAPTURE_BUFFER_OVERFLOW` 失败 |
| `maxLineBytes` | 1 MiB | 单行文本上限 |
| `lineOverflowPolicy` | `"split"` | 超长行处理策略 |

超长行策略如下：

- `"split"`：拆成不超过上限的片段；
- `"truncate"`：保留前缀并追加 `…`，丢弃该行其余数据；
- `"error"`：以 `CAPTURE_LINE_TOO_LONG` 失败。

上限会在完整换行行和未换行尾行交付前执行，避免单个大 chunk 绕过限制。

## 错误与部分结果

`CaptureError` 提供 `code`、`cause` 和 `partialResult`。常见错误码：

| 错误码 | 含义 |
| --- | --- |
| `CAPTURE_SOURCE_ERROR` | 来源流或子进程报告错误 |
| `CAPTURE_FILE_ERROR` | Capture 文件打开、写入、刷新或关闭失败 |
| `CAPTURE_ABORTED` | 调用 `abort()` 或 `AbortSignal` 取消 |
| `CAPTURE_ABORTED_BY_LOGGER_CLOSE` | Logger 关闭时停止进程 Capture |
| `CAPTURE_CONSUMER_ERROR` | 行回调失败且策略为 `fail` |
| `CAPTURE_BUFFER_OVERFLOW` | 已接受的排队字节超过上限 |
| `CAPTURE_LINE_TOO_LONG` | 超长行策略为 `error` |

进程 Capture 的 `partialResult` 会包含已知的 stdout/stderr 字节数、行数、文件路径、非破坏性 SHA-256 快照、退出码、signal 和失败 channel，便于调用方写入业务结果。

## 与 Logger 生命周期的关系

- `await rlog.flush()` 等待已排队日志和活动 Capture 当前已接收的数据，之后 Logger 仍可继续使用。
- `await rlog.close()` 拒绝新的用户日志，要求 Capture 收尾，等待屏幕/文件/轮转并关闭 Sink。
- Logger `close()` 不杀死被 Capture 的子进程。
- 失败 Capture 在 `done` settle 前会先等待已接受队列停止，之后不会继续留下后台文件写入。
