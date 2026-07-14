# rlog-js

[![npm version](https://badge.fury.io/js/rlog-js.svg)](https://badge.fury.io/js/rlog-js)

一个现代化的 Node.js 日志库，完全使用 **TypeScript** 编写，提供完整的类型支持。

## 特性

- 完整的 TypeScript 支持
- 可设置时区与自定义时间格式
- 类型着色、字符串着色、敏感词脱敏
- 进度条、屏幕/文件分流、多行输出优化
- 平替 `console.log`，自动识别日志等级
- `rlog.exit()` 安全退出与退出钩子
- 2.2：metadata、JSONL、child logger、事件、日志等级与流捕获

![image](https://github.com/user-attachments/assets/bd5e1c3e-b872-4844-9f40-a19587eda847)

## 安装

```shell
npm install rlog-js
```

## 使用示例

### JavaScript

```javascript
const Rlog = require("rlog-js");
const rlog = new Rlog();
```

### TypeScript

```typescript
import Rlog from "rlog-js";

const rlog = new Rlog({
  enableColorfulOutput: true,
  logFilePath: "logs.txt",
  timezone: "Asia/Shanghai",
});

rlog.info("This is an information log");
rlog.warn("This is a warning log");
```

### 基础用法

如果项目之前使用 `console.log`，通常可直接替换为 `rlog.log` 或对应等级方法。`./demo.js` 有完整演示，`./test.js` 提供自动化回归测试。

```javascript
const Rlog = require("rlog-js");

const rlog = new Rlog({
  enableColorfulOutput: true,
  logFilePath: "logs.txt",
});

rlog.config.setConfig({
  timeFormat: "YYYY-MM-DD HH:mm:ss",
  timezone: "Asia/Shanghai",
  blockedWordsList: ["password", "secret"],
});

rlog.info("This is an information log");
rlog.log("This is an automatically recognized type of log output");
rlog.warn("This is a warning log");
rlog.error("This is an error log");
rlog.success("This is a success log");
```

## 进阶

### 配置

可在构造时、通过 `setConfig()` / `setConfigGlobal()`，或直接修改 `rlog.config` 设置配置：

```javascript
const rlog = new Rlog({
  logFilePath: "./log.txt",
  timezone: "Asia/Shanghai",
  autoInit: false,
});

rlog.config.setConfigGlobal({
  blockedWordsList: ["world", "[0-9]{9}"],
});

rlog.config.setConfig({ silent: true });
rlog.config.logFilePath = "./log.txt";
```

`setConfig` 只影响当前实例；`setConfigGlobal` 会更新当前进程内已有实例，并成为后续实例的默认配置。子进程不会继承内存中的全局配置。

### 自动判断日志级别

`rlog.log()` 使用 Node.js `console.log` 的多参数与占位符格式化语义，再根据关键词识别 `error`、`warning` 或 `success`：

```javascript
rlog.log("a", { b: 1 }, 1);
rlog.log("user=%s score=%d", "Ravello", 100);
```

### 自定义日志模板

默认模板为：

```javascript
{ logTemplate: "[{time}][{level}] {message}" }
```

支持 `{message}`、`{level}` / `{type}`、`{time}` 和 `{time:HH:mm:ss}`：

```javascript
const rlog = new Rlog({
  logTemplate: "{time:HH:mm:ss} {level}: {message}",
});

rlog.warn("disk usage", { used: "91%" });
```

没有 `{message}` 时，正文会自动追加。时间格式支持 `YYYY`、`MM`、`DD`、`HH`、`mm`、`ss`、`SSS`、`A/a`、星期、`Z/ZZ`，以及 `timestamp`、`ISO`、`GMT`、`UTC` 和 `[literal]`。

### 仅在屏幕/文件中输出

```javascript
rlog.info("This will be shown both screen and file");
rlog.file.info("file only");
rlog.screen.info("screen only");
```

`file` 与 `screen` 不提供自动判断类型的 `.log()` 方法。

### 强制退出与退出钩子

`rlog.exit(message)` 会记录 EXIT、串行执行 `onExit` hook、关闭 RLog 创建的流，随后终止进程。正常完成退出码为 0；hook 或关闭失败、超时时为 1。

```javascript
rlog.onExit(async () => {
  await saveConfiguration();
  rlog.warn("rlog.exit() called and event triggered.");
});

rlog.exit("This is a secure exit method");
```

hook 的默认超时为 5000ms，可通过 `exitListenerTimeoutMs`、`exitCloseTimeoutMs` 调整。长期运行服务如不应退出，请使用 `fatal()` 与 `await rlog.flush()`。

### 字符串着色

配置 `customColorRules` 实现字符串着色，规则支持正则表达式：

```javascript
rlog.config.setConfig({
  customColorRules: [
    { reg: "[a-zA-z]+://[^\\s]*", color: "cyan" },
  ],
});
```

支持 `red`、`green`、`yellow`、`blue`、`magenta`、`cyan`、`gray`。

### 敏感词加密

`blockedWordsList` 用于文本和格式化值的脱敏，支持正则表达式：

```javascript
rlog.config.setConfig({
  blockedWordsList: ["password", "[0-9]{9}"],
});
```

### 进度条

```javascript
const rlog = new Rlog();
rlog.progress(168, 1668);
```

进度条仅输出到 screen，不写入普通日志文件；它会遵循 `screenOutput`。非 TTY 输出时会使用稳定的新行输出。

### 多行输出

RLog 自动缩进正文的第二行及之后的行：

```javascript
rlog.info(`line1
line2`);

rlog.info("payload", {
  line1: "hello",
  line2: "world",
});
```

### 自动初始化与静默模式

默认会在设置 `logFilePath` 时初始化文件。可通过 `autoInit: false` 延迟，并手动调用 `rlog.file.init()`；`silent: true` 会隐藏自动初始化提示。

## 2.2 新功能

### 日志等级与输出目标

新增 `trace()`、`debug()`、`fatal()`；等级从低到高为 `trace`、`debug`、`info` / `success`、`warn`、`error`、`fatal`、`off`。

```javascript
const rlog = new Rlog({
  logFilePath: "./logs/app.log",
  screenOutput: "stderr",
  screenLogLevel: "warn",
  fileLogLevel: "debug",
});

rlog.debug("Only file");
rlog.warn("Screen and file");
```

`screenOutput` 支持 `"stdout"`（默认）、`"stderr"`、`"none"` 或任意 Node Writable。目标等级优先级为：目标等级 > argv > 环境变量 > `logLevel` > `info`。

```javascript
new Rlog({
  readLogLevelFromArgv: true,
  readLogLevelFromEnv: true,
});
// node app.js --log-level=warning
// RLOG_LEVEL=debug node app.js
```

### 链式 metadata 与 JSONL

正文对象不会被自动当作 metadata；请显式调用 `.meta()`：

```javascript
const rlog = new Rlog({
  logFilePath: "./app.log",
  jsonlFilePath: "./events.jsonl",
  redactKeys: ["token", "authorization", "apiKey"],
});

rlog
  .info("Device connected", { retry: 1 })
  .meta("device", "controller")
  .meta({ port: "COM9", token: "secret" });
```

screen 默认不显示 metadata；文本文件默认以块显示；JSONL 总是保存分离的 `context` 与 `meta`。JSONL 会安全处理 `BigInt`、`Date`、`Error`、`Buffer`、`undefined`、`Symbol`、函数与循环引用。`redactKeys` 会递归处理普通对象、数组、`Error` 的自定义字段和 `Error.cause`；不会修改原始对象。

### Child logger 与事件

```javascript
const root = new Rlog({ context: { app: "benchpilot" } });
const deviceLog = root.child({ device: "controller" });

deviceLog.info("Ready").meta({ port: "COM9" });
deviceLog.event("stage.completed", { durationMs: 4821 }, {
  level: "success",
});
```

child logger 继承 context，并与根实例共享队列、配置、流和生命周期。合并顺序为父 context → child context → `.meta()`。

### flush 与 close

```javascript
await rlog.flush(); // 等待已排队日志与 capture 已接收的数据
await rlog.close(); // flush 后结束 RLog 创建的流
```

`flush()` 后仍可记录；`close()` 幂等，关闭后写入会抛出 `RLogClosedError`。

### Capture

```javascript
const { spawn } = require("node:child_process");

const child = spawn("node", ["script.js"]);
const result = await rlog.capture.process(child, {
  stdoutFile: "./logs/build.stdout.log",
  stderrFile: "./logs/build.stderr.log",
  stdoutDisplay: "debug",
  stderrDisplay: "warn",
});
```

也支持文本和二进制流：

```javascript
const text = rlog.capture.stream(serialPort, {
  file: "./logs/controller.serial.log",
  displayLevel: "debug",
});

const binary = rlog.capture.binary(binaryStream, {
  file: "./logs/controller.raw.bin",
});
```

capture 使用增量写入，不会将整个流载入内存。binary 默认计算 SHA-256。`done` Promise 无论 resolve 或 reject，均表示 RLog 为该 capture 创建的文件资源已完成清理；因此完成后可立即读取或删除这些文件。capture 原始文件不会自动脱敏，请自行保护敏感数据。根 logger 在子进程结束前关闭时，会停止捕获并关闭 capture 文件，但不会 kill 子进程；对应 Promise 会以 `CaptureError` reject。

### 文件错误策略

```javascript
new Rlog({
  fileErrorPolicy: "throw", // throw | disable | stderr | ignore
  onFileError(error, context) {
    reportStorageError(error, context);
  },
});
```

普通日志调用不会同步抛出稍后发生的文件错误；在 `throw` 策略下，`flush()` 与 `close()` 会交付该错误。错误发生当时的策略决定是否进入后续的错误交付队列，因此后来将 `ignore` 或 `disable` 改为 `throw` 不会重新抛出历史错误。`onFileError` 自身抛出的异常始终会由后续 `flush()` 或 `close()` 交付。其他策略会禁用失败目标，让其余输出继续工作。

## 接口

### Rlog

| 方法 | 描述 |
| --- | --- |
| `trace/debug/info/warn/error/success/fatal(...args)` | 记录相应等级；普通方法返回可链式 `.meta()` 的 `LogEntry` |
| `log(...args)` | 自动识别 success / warning / error |
| `event(type, data?, options?)` | 记录结构化事件 |
| `child(context)` | 创建共享资源的 child logger |
| `flush()` / `close()` | 刷新或关闭输出资源 |
| `progress(num, max)` | 显示进度条 |
| `exit(message)` | 安全关闭后终止进程 |

`rlog.screen` 和 `rlog.file` 也提供 `trace/debug/info/warning/warn/error/success/fatal/exit`；它们只写入相应目标。

### Config

| 配置项 | 默认值 | 描述 |
| --- | --- | --- |
| `enableColorfulOutput` | `true` | 是否启用彩色输出 |
| `logFilePath` / `jsonlFilePath` | `undefined` | 文本 / JSONL 文件路径 |
| `timeFormat` | `YYYY-MM-DD HH:mm:ss.SSS` | 时间格式 |
| `timezone` | 本地时区 | IANA 时区 |
| `logTemplate` | `[{time}][{level}] {message}` | 日志模板 |
| `blockedWordsList` / `redactKeys` | `[]` | 文本 / 结构化脱敏 |
| `logLevel` | `info` | 基础等级 |
| `screenLogLevel` / `fileLogLevel` / `jsonlLogLevel` | `undefined` | 目标等级覆盖 |
| `screenOutput` | `stdout` | stdout、stderr、none 或 Writable |
| `context` | `{}` | 根 logger context |
| `screenMetadataOutput` / `fileMetadataOutput` | `none` / `block` | metadata 文本渲染 |
| `autoInit` / `silent` | `true` / `false` | 文件初始化与提示 |
| `fileErrorPolicy` | `throw` | 文件失败策略 |

`setConfig(obj)` 更新当前实例；`setConfigGlobal(obj)` 更新当前进程中的实例并作为后续默认值。

### Toolkit、Screen 与 File

`rlog.toolkit` 保留 `formatTime()`、`formatConsoleArgs()`、`formatLogMessage()`、`colorizeString()`、`encryptPrivacyContent()`、`padLines()` 等工具方法。`rlog.file.init()` 可手动初始化文本日志文件。

## 开发

```bash
git clone https://github.com/RavelloH/RLog.git
cd RLog
npm install
npm run build
npm test
npm pack --dry-run
```

2.1 用户无需修改现有普通日志代码；2.2 的新能力均为可选。不会自动发布 npm。

## License

MIT License
