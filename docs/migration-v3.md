# 从 RLog v2 迁移到 v3

RLog v3 是一次面向多输出目标、结构化日志和可靠流捕获的主版本升级。它要求 Node.js 20 或更高版本，并继续支持 CommonJS：

```js
const Rlog = require("rlog-js");
```

TypeScript 仍可使用默认导入：

```ts
import Rlog from "rlog-js";
```

本页说明需要改动的调用方式，并列出保留的兼容入口。

## 输出目标

v3 将普通文本文件和 JSONL 明确区分为两个目标：`text` 与 `jsonl`。根 Logger 仍会写入所有已配置目标，无须改成 `rlog.all`。

| 调用 | 写入目标 |
| --- | --- |
| `rlog.info("...")` | 已配置的 screen、text、jsonl |
| `rlog.screen.info("...")` | 仅 screen |
| `rlog.text.info("...")` | 仅普通文本文件 |
| `rlog.jsonl.info("...")` | 仅 JSONL |

```js
rlog.info("所有已配置目标");
rlog.screen.info("仅终端");
rlog.text.info("仅文本文件");
rlog.jsonl.info("仅 JSONL");
```

### `file` 兼容别名

旧的 `rlog.file` 未被移除，但已弃用；它与 `rlog.text` 是同一个 facade：

```js
rlog.file === rlog.text; // true
```

请把新代码迁移到 `rlog.text`。以下旧帮助方法仍可用，但不建议在新代码中使用旧名称：

| 旧入口 | 推荐入口 |
| --- | --- |
| `rlog.file.init()` | `await rlog.text.init()` |
| `rlog.file.logStream` | `rlog.text.stream` |
| `rlog.file.writeLog()` | `rlog.text.writeRaw()` |
| `rlog.file.writeLogToStream()` | `rlog.text.writeRaw()` |

`rlog.text.stream`（以及 `file.logStream`）是高级兼容逃生口。直接向底层 `WriteStream` 写入会绕过受控队列、轮转大小统计、有序关闭和延迟文件错误交付。普通原始写入应使用 `await rlog.text.writeRaw("...")`。

## 统一的参数与时间语义

v2 的目标 facade 曾把等级方法的第二个参数解释为时间。该语义已移除：所有等级方法现在都使用 Node.js `console` 风格的 `...args`。

```js
// v2：第二个参数可能被理解为时间
rlog.screen.info("ready", someTime);

// v3：第二个参数始终是消息参数
rlog.screen.info("ready", someTime);

// v3：显式绑定时间
rlog.screen.at(someTime).info("ready");
```

根 Logger 和每个目标都提供 `at(timestamp)`：

```js
rlog.at(time).info("所有目标");
rlog.screen.at(time).info("screen");
rlog.text.at(time).info("text");
rlog.jsonl.at(time).info("jsonl");
```

`at()` 接受原有的 `Tostringable`：`Date`、字符串、数字、布尔值、`bigint`、`null` 和 `undefined`。它只创建轻量 facade，不会创建新的 Dispatcher、Sink 或文件流。JSONL 会确定性保留显式时间：`Date` 为 ISO 字符串，`bigint` 为带 `n` 后缀的字符串，`undefined` 为 `"[undefined]"`；不会用当前时间悄悄替换它们。

## JSONL 与事件

新增的 `rlog.jsonl` 专用于 JSON Lines，不会回写到 screen 或 text。用 `event()` 记录结构化事件：

```js
rlog.jsonl.event("device.connected", { port: "COM9" });
rlog.jsonl.at(456).info("设备已连接");
```

每条 JSONL 记录保留以下稳定基础字段：`schema: "rlog.record"`、`version: 1`、`id`、`timestamp`、`level`、`message`、`args`、`context`、`meta`、`event`。可用 `jsonlBaseFields` 为所有记录添加生产者字段，或用 `jsonlOutput` 同时写入调用方拥有的 `Writable`（RLog 不会关闭它）。

## 轮转

文本与 JSONL 各自支持按大小轮转，默认关闭。`maxFiles` 表示历史文件数量，不包含活动文件：

```js
const rlog = new Rlog({
  logFilePath: "./logs/app.log",
  jsonlFilePath: "./logs/events.jsonl",
  textRotation: { maxBytes: 1024 * 1024, maxFiles: 3 },
  jsonlRotation: { maxBytes: 5 * 1024 * 1024, maxFiles: 2 },
});
```

可以通过 `setConfig()` 或 `setConfigGlobal()` 修改运行中实例的轮转配置；配置会在后续写入时生效。详见[文件轮转](rotation.md)。

## Capture 迁移与新增能力

`capture.stream()`、`capture.binary()` 与 `capture.process()` 保持可用；新增能力包括：

- 从 Child Logger 创建的 Capture 镜像记录会继承该 Child Logger 的 context；
- 镜像默认只写入 `screen`，可用 `mirrorTargets` 显式加入 `text`、`jsonl` 或 `all`；
- 文本和进程 Capture 支持 `onLine`、`onStdoutLine`、`onStderrLine`；回调异常默认以 `CAPTURE_CONSUMER_ERROR` 失败；
- `capture.processHandle()` 可单独 `abort()` 一个进程 Capture，默认不杀死子进程；
- 所有 Capture 支持 `AbortSignal`、背压上限和长行策略；
- Capture 文件默认 `fileMode: "truncate"`，可选择 `"exclusive"` 或 `"append"`；Capture 文件不参与普通日志轮转。

请阅读 [Capture 指南](capture.md)，尤其是外部流数据可能包含敏感信息的安全说明。

## 静态 facade 兼容入口

`Rlog.Screen` 与 `Rlog.File` 仍保留为兼容构造入口：`new Rlog.Screen(rlog)` 绑定 screen，`new Rlog.File(rlog)` 绑定 text。它们同样支持等级方法、`event()` 和 `at()`。

新代码仍推荐使用实例上的 `rlog.screen`、`rlog.text` 和 `rlog.jsonl`。实例 facade 已经共享正确的配置、Sink、Capture 与关闭生命周期，也不需要额外构造对象。

## 迁移检查清单

- [ ] 运行环境升级到 Node.js 20 或更高版本。
- [ ] 将新代码中的 `rlog.file` 改为 `rlog.text`。
- [ ] 将隐式第二参数时间改为 `.at(timestamp)`。
- [ ] 为仅机器消费的记录使用 `rlog.jsonl` 或 `event()`。
- [ ] 根据文件大小增长情况配置 text/jsonl 轮转。
- [ ] 检查高频 Capture 是否只镜像到 screen，并配置文件权限和保留策略。
- [ ] 使用 `await rlog.close()` 完成收尾；不要让 Capture 或文件流悬空。
