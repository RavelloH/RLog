# RLog

RLog 是面向 Node.js CLI、自动化流程、构建工具和硬件工具的 TypeScript 日志与流捕获库。它提供与 `console` 一致的参数格式化、屏幕/文本/JSONL 多目标输出、结构化事件、上下文、隐私脱敏、进程与流 Capture、可靠的关闭生命周期，以及零运行时第三方依赖。

## 特性

- 所有日志方法支持 Node.js `console` 风格的 `...args` 格式化
- 独立的 `screen`、`text` 和 JSON Lines `jsonl` 输出目标
- 日志等级、时间模板、时区、彩色与自定义着色规则
- Context、Child Logger、延迟提交 Metadata 与结构化 Event
- 文本、进程和二进制流 Capture，支持 SHA-256、ANSI 清理与 UTF-8 跨 chunk 解码
- `flush()`、幂等 `close()`、有序 `exit()` 生命周期
- `blockedWordsList` 文本遮蔽与 `redactKeys` 结构化字段脱敏
- 文本和 JSONL 的按大小轮转

## 安装

RLog v3 需要 Node.js 20 或更高版本。

```bash
npm install rlog-js
```

```js
// CommonJS
const Rlog = require("rlog-js");
```

```ts
// TypeScript
import Rlog from "rlog-js";
```

## 快速开始

```js
const Rlog = require("rlog-js");

const rlog = new Rlog({
  logFilePath: "./logs/app.log",
  jsonlFilePath: "./logs/events.jsonl",
  context: { service: "flasher" },
});

rlog.info("connected to %s", "COM9");
rlog.success("flash complete in %dms", 42);
rlog.jsonl.event("flash.completed", { durationMs: 42 });

await rlog.close();
```

## 日志方法与格式化

根 Logger、`screen`、`text` 和 `jsonl` 都提供以下方法：

```js
rlog.trace(...args);
rlog.debug(...args);
rlog.info(...args);
rlog.success(...args);
rlog.warn(...args);
rlog.warning(...args);
rlog.error(...args);
rlog.fatal(...args);
```

参数使用 Node.js 的 `util.formatWithOptions()` 语义，支持 `%s`、`%d`、`%j`、对象、`Error`、循环引用以及自定义 inspect：

```js
rlog.info("device=%s retries=%d", "controller", 2);
rlog.warn("unexpected response", { code: 503, retryable: true });
rlog.error(new Error("port unavailable"));
```

`log(...args)` 会依据文本中的常见关键词自动选择 `info`、`success`、`warn` 或 `error` 等级：

```js
rlog.log("upload done");
rlog.log("connection failed");
```

等级阈值从低到高为 `trace`、`debug`、`info` / `success`、`warn`、`error`、`fatal`、`off`。`warning` 是 `warn` 的同义方法。

## 输出目标

根 Logger 会写入所有已配置目标；目标 Logger 只写入自己的目标。

| 调用 | screen | text | jsonl |
| --- | :---: | :---: | :---: |
| `rlog.info("...")` | ✓ | ✓ | ✓ |
| `rlog.screen.info("...")` | ✓ | | |
| `rlog.text.info("...")` | | ✓ | |
| `rlog.jsonl.info("...")` | | | ✓ |

```js
rlog.info("visible everywhere");
rlog.screen.info("terminal only");
rlog.text.info("plain text only");
rlog.jsonl.info("JSONL only");
```

### Screen

`screenOutput` 可为 `"stdout"`、`"stderr"`、`"none"` 或任何 Node.js `Writable`：

```js
const rlog = new Rlog({
  screenOutput: "stderr",
  screenLogLevel: "warn",
});
```

屏幕输出支持颜色、宽字符对齐、多行缩进和进度条：

```js
rlog.progress(35, 100);
```

### Text

配置 `logFilePath` 后，文本目标会写入格式化日志：

```js
const rlog = new Rlog({ logFilePath: "./logs/app.log" });
rlog.text.info("plain text record");

// 按需初始化或直接写入受控的原始文本
await rlog.text.init();
await rlog.text.writeRaw("raw line\n");
```

`rlog.file` 是 `rlog.text` 的弃用别名，两者指向同一对象。请在新代码中使用 `text`。
`rlog.text.stream`（以及兼容的 `rlog.file.logStream`）是高级逃生口：直接写底层流会绕过轮转统计、受控写入顺序和延迟文件错误交付。新代码请使用 `rlog.text.writeRaw()`。

### JSONL

配置 `jsonlFilePath` 后，每条记录写为一行独立 JSON：

```js
const rlog = new Rlog({ jsonlFilePath: "./logs/events.jsonl" });
rlog.jsonl.info("device=%s", "controller");
```

输出字段：

```json
{
  "id": 1,
  "timestamp": "2026-07-14T10:00:00.000Z",
  "level": "info",
  "message": "Device connected",
  "args": [],
  "context": {},
  "meta": {},
  "event": null
}
```

JSONL 仅写入 JSONL 文件，不会显示到终端或写入文本文件。

显式时间会原样保留：`Date` 写为 ISO 字符串；数字、字符串、布尔值和 `null` 保持 JSON 值；`bigint` 写为如 `"9n"` 的安全字符串；`undefined` 写为 `"[undefined]"`。因此同一条记录在 text 和 JSONL 中不会拥有不同的时间含义。

## 时间、模板与时区

用 `at(timestamp)` 为一次或多次调用绑定明确时间。它只创建轻量 facade，不会创建新的文件流或 Dispatcher。

```js
const time = new Date("2026-07-14T10:00:00Z");

rlog.at(time).info("all targets");
rlog.screen.at(time).info("screen");
rlog.text.at(time).info("text");
rlog.jsonl.at(time).info("jsonl");
```

日志参数始终是普通的 `...args`：

```js
rlog.screen.info("value", 123); // 输出 value 123
```

`logTemplate` 可使用 `{time}`、`{time:FORMAT}`、`{level}`、`{type}` 与 `{message}`：

```js
const rlog = new Rlog({
  timezone: "Asia/Shanghai",
  timeFormat: "YYYY-MM-DD HH:mm:ss.SSS Z",
  logTemplate: "[{time}][{level}] {message}",
});
```

支持 `YYYY`、`MM`、`DD`、`HH`、`mm`、`ss`、`SSS`、`Z`、`ZZ`、`ddd`、`MMMM`、`A` 等日期 token，也支持 `timestamp`、`ISO`、`GMT`、`UTC` 作为时间格式。

## Context、Child Logger 与 Metadata

`context` 会附加到该 Logger 的每条记录。Child Logger 合并父 context，并共享配置、输出 Sink、Capture、写入队列与关闭生命周期。

```js
const rlog = new Rlog({ context: { service: "flasher" } });
const device = rlog.child({ device: "controller" });

device.info("connected");
device.text.info("port opened");
device.jsonl.info("ready");
```

每个日志调用都会返回 `LogEntry`，可在当前 microtask 内附加 metadata：

```js
rlog.info("connected").meta({ port: "COM9", baudRate: 115200 });
rlog.text.info("connected").meta("port", "COM9");
```

记录提交后不能再修改 metadata，届时 `.meta()` 会抛出 `LogEntryAlreadyCommittedError`。

`screenMetadataOutput` 与 `fileMetadataOutput` 取值为 `"none"`、`"inline"` 或 `"block"`：

```js
const rlog = new Rlog({
  screenMetadataOutput: "inline",
  fileMetadataOutput: "block",
});
```

## 结构化事件

`event(type, data?, options?)` 将事件类型和数据加入日志记录。`options` 支持 `level` 和展示用 `message`。

```js
rlog.event("device.connected", { port: "COM9" }, {
  level: "success",
  message: "device connected",
}).meta({ requestId: "req-1" });

rlog.jsonl.event("flash.completed", { durationMs: 42 });
```

事件数据参与文本 metadata 渲染，并以 `event: { type, data }` 写入 JSONL。

## 隐私与安全序列化

`blockedWordsList` 会替换消息与 JSON 中匹配的文本；`redactKeys` 会将对象中匹配的键值替换为 `[REDACTED]`，键名不区分大小写。

```js
const rlog = new Rlog({
  blockedWordsList: ["secret", "AKIA[0-9A-Z]+"],
  redactKeys: ["password", "token", "authorization"],
});

rlog.info("token=secret");
rlog.jsonl.event("request", { authorization: "Bearer secret" });
```

JSONL 与 metadata 序列化不会修改原对象，并安全处理 `BigInt`、`Date`、`Error` 和 `Error.cause`、`Buffer`、`undefined`、`Symbol`、函数、循环引用以及过深对象。

每条 JSONL 记录都有稳定的 `schema: "rlog.record"` 与 `version: 1`。除了 `jsonlFilePath`，还可以把同一条 JSONL 写入调用方拥有的 `Writable`，例如为 Agent 提供实时事件流；RLog 不会关闭该 stream：

```js
const rlog = new Rlog({
  jsonlFilePath: "./runs/r-1/events.jsonl",
  jsonlOutput: process.stdout,
  jsonlBaseFields: { producer: "benchpilot", protocolVersion: 1 },
});
```

## 文件轮转

文本和 JSONL 可分别按大小轮转；默认关闭。`maxFiles` 是保留的历史文件数量，不包括当前活动文件。

```js
const rlog = new Rlog({
  logFilePath: "./logs/app.log",
  jsonlFilePath: "./logs/events.jsonl",
  textRotation: { maxBytes: 10 * 1024 * 1024, maxFiles: 5 },
  jsonlRotation: { maxBytes: 20 * 1024 * 1024, maxFiles: 3 },
});
```

文件命名为：

```text
app.log       # 当前文件
app.log.1     # 最新历史文件
app.log.2
```

一条记录始终完整写入单个文件；超出阈值的单条记录允许完整写入新文件。轮转与写入串行执行，`flush()` 和 `close()` 都会等待其完成。Capture 文件不参与轮转。

## Capture

### 文本流

`capture.stream()` 递增读取文本流，支持编码、展示等级、文件输出、ANSI 清理、逐行时间戳、SHA-256、标记事件、行回调、取消与背压控制。Capture 镜像默认只写入 `screen`，不会把高频设备行重复写入 text 或 JSONL。

```js
const handle = rlog.capture.stream(readable, {
  file: "./logs/serial.log",
  encoding: "utf8",
  displayLevel: "info",
  stripAnsiInFile: true,
  timestampLines: true,
  computeSha256: true,
  mirrorTargets: "screen",
  fileMode: "truncate",
  onLine(line) {
    // 已处理 UTF-8 跨 chunk，尾行的 terminated 为 false。
    if (line.text.startsWith('{')) inspectDeviceEvent(line.text);
  },
});

handle.mark("flash-start", { image: "firmware.bin" });
await handle.flush();
const result = await handle.done;
// result: bytes, chunks, lines, sha256, startedAt, endedAt, durationMs ...
```

未换行尾部、UTF-8 跨 chunk 字符和 ANSI 序列都会正确收尾。`handle.close()` 可手动成功结束 Capture；`AbortSignal` 会停止 Capture、落盘已排队数据并使 `done` 以 `CAPTURE_ABORTED` 拒绝。Capture 默认以 `truncate` 创建文件，另可选择 `append` 或避免覆盖证据的 `exclusive`。默认 4 MiB/1 MiB 高低水位会暂停/恢复来源；`maxPendingBytes` 防止写入慢于来源时无限占用内存。`maxLineBytes` 与 `lineOverflowPolicy` 可限制无换行输入。

> 安全提示：Capture 文件保存的是外部流的原始内容（或由 Capture 选项要求的最小转换），不会自动应用 `blockedWordsList` 或 `redactKeys`。它们可能包含 token、密码、设备输出或其他敏感信息。调用者应负责文件权限、保存位置和清理策略；Capture 文件也不参与普通日志轮转。

### 二进制流

`capture.binary()` 将原始字节写入文件，可选 SHA-256：

```js
const handle = rlog.capture.binary(binaryReadable, {
  file: "./logs/firmware.bin",
  computeSha256: true,
});

const result = await handle.done;
```

### 子进程

`capture.process()` 同时处理 stdout/stderr，可分别设置文件、显示等级、实时行回调，并控制 ANSI 与原始字节保留：

```js
const { spawn } = require("node:child_process");

const child = spawn("tool", ["--flash", "firmware.bin"]);
const result = await rlog.capture.process(child, {
  stdoutFile: "./logs/tool.stdout.log",
  stderrFile: "./logs/tool.stderr.log",
  stdoutDisplay: "info",
  stderrDisplay: "warn",
  preserveRawBytes: false,
  stripAnsiInFiles: true,
  encoding: "utf8",
  computeSha256: true,
});

console.log(result.exitCode, result.signal, result.stdoutSha256);
```

若需要单独停止某个 Capture 而继续使用 Logger，请使用 `processHandle()`。`abort()` 默认不杀死调用方拥有的子进程：

```js
const capture = rlog.capture.processHandle(child, {
  stdoutFile: "./runs/r-1/flash.stdout.log",
  onStdoutLine(line) { observeToolOutput(line.text); },
});

// BenchPilot 决定进程生命周期；RLog 只停止 Capture。
child.kill();
try {
  await capture.abort("operation-timeout");
} catch (error) {
  // CaptureError: CAPTURE_ABORTED
}
```

关闭 Logger 会使活动 Process Capture 以 `CAPTURE_ABORTED_BY_LOGGER_CLOSE` settle，但不会杀死被捕获的子进程，也不会等待该子进程退出。Process Capture 停止记录后默认继续 drain 两路 pipe，避免仍在运行的子进程因 pipe 缓冲区写满而间接阻塞。drain 后的数据不会写 Capture 文件、触发回调或镜像，也不会计入结果字节数、行数或 SHA-256。

可用 `detachMode` 明确选择停止 Capture 后 stdout/stderr 的处理方式：

| 值 | 行为 |
| --- | --- |
| `"drain"`（默认） | RLog 丢弃并持续消费后续两路输出，直到流结束；不会等待子进程退出。 |
| `"pause"` | 保留旧行为：停止读取并暂停流。若子进程继续输出，pipe 可能写满并使子进程阻塞。 |
| `"handoff"` | RLog 移除自身 listener，但不暂停、resume 或 drain；调用方必须立即自行添加 `data` listener 或 `pipe()` 到目标，否则仍可能阻塞。 |

`killProcessOnAbort: true` 仍是唯一会请求终止子进程的显式 opt-in；即使启用它，Capture 也会按 `detachMode` 处理信号送达至进程实际退出期间的剩余输出。

## 生命周期与退出

`flush()` 等待已排队记录、屏幕写入、全部 Sink、活动 Capture 数据和轮转；完成后可继续写日志。

```js
await rlog.flush();
rlog.info("continue after flush");
```

`close()` 幂等。关闭开始后新的用户日志会抛出 `RLogClosedError`，已排队日志和 Capture 收尾会被处理完毕。

```js
await rlog.close();
await rlog.close();
```

`onExit()` 注册退出前任务；`exit()` 写入 EXIT 记录、按注册顺序执行任务、关闭资源并退出进程。任务失败或超时会以状态码 `1` 退出。

```js
rlog.onExit(async () => {
  await saveCheckpoint();
});

rlog.exit("finished");
```

## Span 与进度任务

`withSpan()` 为通用阶段计时生成 `span.started`、`span.completed` 或 `span.failed` 事件，并保留调用 Logger 的 context：

```js
await rlog.child({ device: "controller" }).withSpan(
  "flash",
  { image: "firmware.bin" },
  async (span) => {
    span.info("Connecting to XDS110");
    await flash();
  },
);
```

`progressTask()` 遵守创建它的 Logger target 范围；Child Logger 的 context 会随 JSONL 事件继承。根 Logger 等同于 all targets：screen 显示进度，text 记录生命周期，JSONL 写稳定的 `progress.started`、`progress.updated`、`progress.completed` 和 `progress.failed` 事件。

| 调用入口 | screen | text | JSONL |
| --- | --- | --- | --- |
| `rlog.progressTask()` | 可视进度 | `started`、`completed`、`failed` | 全部四种事件 |
| `rlog.screen.progressTask()` | 仅可视进度（失败会显示错误） | 不写 | 不写 |
| `rlog.text.progressTask()` | 不写 | 仅 `started`、`completed`、`failed` | 不写 |
| `rlog.jsonl.progressTask()` | 不写 | 不写 | 全部四种事件 |

text 不记录每次 `update()`，避免高频任务淹没文本日志。构造时会按范围写入初始 screen 进度；`complete()` 与 `fail()` 幂等，终止后的 `update()` 会被忽略：

```js
const progress = rlog.progressTask({ label: "Flashing controller", total: 100 });
progress.update(35);
progress.complete();
```

## 文件错误策略

`fileErrorPolicy` 决定文本、JSONL、Capture 文件或轮转失败时的行为。它可以是统一字符串，也可以按输出类型分别配置：

| 值 | 行为 |
| --- | --- |
| `"throw"` | 在后续 `flush()` 或 `close()` 交付错误 |
| `"disable"` | 禁用失败目标，其他目标继续写入 |
| `"stderr"` | 写入标准错误并禁用失败目标 |
| `"ignore"` | 静默禁用失败目标 |

`onFileError` 可接收失败文件、目标和操作：

```js
const rlog = new Rlog({
  fileErrorPolicy: {
    text: "stderr",
    jsonl: "throw",
    capture: "throw",
    default: "throw",
  },
  onFileError(error, context) {
    console.error("RLog file error", context.output, context.operation, error);
  },
});
```

`context.output` 为 `text`、`jsonl` 或 `capture`；`context.operation` 为 `open`、`write`、`flush`、`close` 或 `rotate`。

## 配置

```ts
const rlog = new Rlog({
  enableColorfulOutput: true,
  logFilePath: "./logs/app.log",
  jsonlFilePath: "./logs/events.jsonl",
  jsonlOutput: "none",
  jsonlBaseFields: { producer: "my-cli" },
  timeFormat: "YYYY-MM-DD HH:mm:ss.SSS",
  timezone: "Asia/Shanghai",
  logTemplate: "[{time}][{level}] {message}",
  blockedWordsList: [],
  screenLength: 120,
  autoInit: true,
  silent: false,
  customColorRules: [{ reg: "COM\\d+", color: "cyan" }],
  logLevel: "info",
  screenLogLevel: "info",
  fileLogLevel: "debug",
  jsonlLogLevel: "info",
  screenOutput: "stdout",
  textRotation: { maxBytes: 10 * 1024 * 1024, maxFiles: 5 },
  jsonlRotation: false,
  context: { service: "flasher" },
  screenMetadataOutput: "none",
  fileMetadataOutput: "block",
  redactKeys: ["token"],
  readLogLevelFromArgv: true,
  readLogLevelFromEnv: true,
  logLevelArgumentName: "--log-level",
  logLevelEnvironmentName: "RLOG_LEVEL",
  fileErrorPolicy: "throw",
  onFileError: (error, context) => {},
  exitListenerTimeoutMs: 5000,
  exitCloseTimeoutMs: 5000,
});
```

`setConfig()` 立即更新当前实例。`setConfigGlobal()` 会立即更新所有仍处于打开状态的实例，并成为后续新实例的默认值；已关闭 Logger 会从全局实例集合释放。传入的 rotation、context、脱敏数组和颜色规则会被复制，后续修改原对象不会影响 RLog：

```js
rlog.config.setConfig({ logLevel: "debug" });
rlog.config.setConfigGlobal({ enableColorfulOutput: false });
```

启用 `readLogLevelFromArgv` 后可传入 `--log-level=debug` 或 `--log-level debug`；启用 `readLogLevelFromEnv` 后可使用 `RLOG_LEVEL=debug`，名称可通过对应配置项修改。

## 错误类

以下错误类可从包入口获得：

```js
const {
  CaptureError,
  RLogClosedError,
  LogEntryAlreadyCommittedError,
} = require("rlog-js");
```

`CaptureError` 带有 `code`、`cause` 与 `partialResult`。文本 Capture 使用 Node.js 宽松 UTF-8 解码（非法字节会被替换，不产生 decode error）；错误代码包括 `CAPTURE_SOURCE_ERROR`、`CAPTURE_FILE_ERROR`、`CAPTURE_ABORTED`、`CAPTURE_ABORTED_BY_LOGGER_CLOSE`、`CAPTURE_CONSUMER_ERROR`、`CAPTURE_BUFFER_OVERFLOW` 与 `CAPTURE_LINE_TOO_LONG`。

## 开发

```bash
npm ci
npm run build
npm test
npm run test:coverage
npm pack --dry-run
```

贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

详细文档：

- [从 v2 迁移到 v3](docs/migration-v3.md)
- [Capture 指南](docs/capture.md)
- [文件轮转](docs/rotation.md)
