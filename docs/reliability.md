# 可靠性、资源预算与诊断

本指南介绍 RLog 的队列保护、文件恢复、日志查询、Flight Recorder 和扩展流水线。除特别说明外，这些能力均为可选功能；未启用时，既有的 v3 队列和文件命名行为保持不变。

## 安全与脱敏边界

配置 `redactKeys` 后，RLog 会在格式化日志前对匹配的结构化字段进行脱敏，并将脱敏后的参数用于 Screen、Text 和 JSONL 输出。

```js
const rlog = new Rlog({
  redactKeys: ["accessToken", "password"],
  jsonlFilePath: "./logs/events.jsonl",
});

rlog.info({ accessToken: "private", result: "ok" });
```

字段名规则无法识别所有秘密：任意字符串中的 token 子串、嵌入在文本中的凭据，以及调用方提供的事件消息都可能包含敏感信息。必要时请配置 `blockedWordsList`，并在写入前自行清理文本。

`capture.stream()` 和 `capture.binary()` 保存的是原始外部流数据，不会自动应用普通日志的 `blockedWordsList` 或 `redactKeys`。请自行管理文件权限、保存位置和保留期限。

## 队列与记录大小预算

```js
const rlog = new Rlog({
  jsonlFilePath: "./logs/events.jsonl",
  maxQueuedRecords: 4096,
  maxQueuedBytes: 2 * 1024 * 1024,
  maxRecordBytes: 16 * 1024,
  queueOverflowPolicy: "drop-debug", // 或 "throw"
});
```

- `maxQueuedRecords` 限制已接受但尚未完成派发的记录数，包括正在处理的操作。
- `maxQueuedBytes` 限制待处理记录的累计序列化大小；`maxRecordBytes` 限制单条记录的序列化大小。
- 字节数是基于安全序列化结果的估算，不等于进程 RSS，也不保证与最终文件字节数完全一致。原始参数仍可能在检查前产生内存开销。
- 元数据、事件数据或 Processor 转换可能扩大记录。RLog 会在派发前重新检查；这类延迟检查产生的错误可能在 `flush()` 或 `close()` 时交付。
- `queueOverflowPolicy: "drop-debug"` 只会计数并丢弃超限的 TRACE/DEBUG 记录。INFO 及更高级别的记录不会被静默丢弃，而会抛出相应错误。
- 不配置上限时，保留 v3 原有的队列行为。队列预算不涵盖 Capture 自身的缓冲区；Capture 有独立的背压配置。

## 异步上下文与延迟日志

`withContext()` 使用异步上下文传播机制，让上下文跨越 `await` 继承，并隔离并发执行的作用域。它可以与既有的 `child(context)` 配合使用。

```js
await rlog.withContext({ requestId: "req-42" }, async () => {
  await doWork();
  rlog.jsonl.event("request.completed", { ok: true });
});
```

`logLazy(level, argumentsFactory)`、`debugLazy()` 等延迟日志方法仅在相关输出确实需要处理该等级时执行工厂函数。工厂函数应返回参数数组，例如：

```js
rlog.debugLazy(() => ["snapshot", buildExpensiveSnapshot()]);
```

回调执行时产生的异常会同步传播。配置 Flight Recorder 或自定义 Transport 时，即使内置输出目标过滤了某个等级，相关记录仍可能被这些功能接收；需要额外过滤时，请在 Processor 或 Transport 中实现。

## 文件隔离、恢复与同步

### 多实例写入

```js
const rlog = new Rlog({
  jsonlFilePath: "./logs/events.jsonl",
  jsonlFileIsolation: "instance",
  jsonlRotation: { maxBytes: 2 * 1024 * 1024, maxFiles: 3 },
  textFileIsolation: "instance", // logFilePath 已配置时生效
});
```

`textFileIsolation: "instance"` 和 `jsonlFileIsolation: "instance"` 会为每个 Logger 实例生成独立的文件路径及轮转序列。默认值 `"shared"` 保留原有路径行为。

隔离模式可避免不同进程或实例竞争重命名同一个轮转文件，但**它不是跨进程文件锁**。每个实例各自计算轮转保留数量，不构成整个应用的总磁盘配额；旧实例文件仍需由应用清理。不同实例之间也不保证全局时间顺序。

### 手动恢复与自动恢复

文件 Sink 在打开、写入、刷新或轮转时遇到错误后，可能按 `fileErrorPolicy` 停用。可以显式尝试恢复：

```js
const outcome = await rlog.recoverFiles();
// { text: true | false | null, jsonl: true | false | null }
```

- `true`：目标可用或重新打开成功。
- `false`：目标仍不可用。
- `null`：该目标没有配置本地文件路径。

也可以选择性启用退避恢复：

```js
const rlog = new Rlog({
  jsonlFilePath: "./logs/events.jsonl",
  fileErrorPolicy: "disable",
  autoRecoverFiles: {
    initialDelayMs: 1000,
    maxDelayMs: 60000,
    multiplier: 2,
  },
});
```

自动恢复没有后台定时器：只有新记录到来且冷却时间结束时，才会触发下一次尝试。恢复成功后只写入触发恢复的这条新记录及后续记录；结果不确定的旧写入不会重放。Capture 文件和调用方拥有的 Writable 不使用该恢复机制。

### 文件同步

```js
await rlog.syncFiles();
```

`syncFiles()` 会排空待处理日志，并请求操作系统对已打开的本地 Text/JSONL 文件执行 `fsync`。它比普通 `flush()` 更昂贵，但无法保证在所有硬件故障、电源故障或设备写缓存场景下绝对不丢数据。尚未打开的文件没有可同步的文件句柄；调用方拥有的流和远程目标也不会被同步。

## 查询当前、轮转及隔离的 JSONL 文件

```js
const { listJsonlFiles, readJsonl } = require("rlog-js");

const paths = await listJsonlFiles("./logs/events.jsonl");
for await (const item of readJsonl({
  filePath: "./logs/events.jsonl",
  levels: ["warn", "error", "fatal"],
  eventTypes: ["worker.failed"],
  since: new Date(Date.now() - 24 * 60 * 60 * 1000),
  limit: 100,
})) {
  console.log(item.filePath, item.lineNumber, item.record);
}
```

读取器以流式方式解析数据，可识别活动文件、历史轮转文件及实例隔离文件，并支持按等级、事件类型、时间下限和数量筛选。默认遇到格式错误的行会抛出包含文件路径和行号的异常；只有明确接受跳过坏数据时才设置 `skipMalformed: true`。

查询期间若另一个进程正在轮转，读取结果不保证是一个原子快照；多个实例之间也不保证全局时间顺序。

## Flight Recorder

Flight Recorder 是可选的、有界内存环形记录器，用于在正常输出过滤掉 DEBUG/TRACE 时保留最近的诊断上下文。

```js
const rlog = new Rlog({
  jsonlFilePath: "./logs/app.jsonl",
  jsonlLogLevel: "info",
  flightRecorder: {
    maxRecords: 200,
    maxBytes: 256 * 1024,
    captureLevels: ["trace", "debug"],
    // includeEventData: false, // 默认不保留事件 payload
  },
});

rlog.debug("before the error");
console.log(rlog.flightRecorderStatus());
const snapshot = rlog.flightRecorderSnapshot();
await rlog.exportFlightRecorder("./logs/diagnostic-snapshot.jsonl");
rlog.clearFlightRecorder();
```

- 默认关闭；启用后按记录数量和序列化字节数双重限制，超限记录会被跳过，环形缓冲淘汰也会计数。
- 记录器在普通 Sink 的等级过滤之前收集已接受的日志。默认不保留事件 payload；记录中保存格式化消息，而不是原始参数对象。
- `flightRecorderSnapshot()` 返回与内部状态分离的副本。
- `exportFlightRecorder()` 使用排他创建方式写文件，不会覆盖已有文件。调用方须提前创建目录并处理 I/O 错误。
- Flight Recorder 不会在 fatal 日志或进程退出时自动导出；必须由应用主动调用导出接口。
- 脱敏规则不能识别任意字符串中的全部秘密，导出的快照仍需按敏感数据处理。

## Processor 与 Transport

Processor 可按顺序修改、补充或过滤记录；Transport 可将记录发送到额外的输出目标。两者均为可选功能。

```js
const rlog = new Rlog({
  jsonlFilePath: "./logs/events.jsonl",
  processors: [
    async record => {
      if (record.event?.type === "heartbeat") return null;
      record.context = { ...record.context, deployment: "prod" };
      return record;
    },
  ],
  transports: [{
    async write(record) { await mySink.write(record); },
    async flush() { await mySink.flush(); },
    async close() { await mySink.close(); },
  }],
});
```

- Processor 在当前记录的 metadata/event 链完成后串行执行，并在内置 Screen、Text 和 JSONL 输出之前运行。返回 `null` 表示有意过滤记录；返回 `undefined` 保留原地修改；返回记录对象则以该对象继续处理。回调可以是异步的。
- Processor 接收经过结构化脱敏的副本；新增的结构化字段会在交给内置输出和 Transport 前再次脱敏。
- 每个 Transport 接收独立的脱敏副本。内置输出尝试完成后再调用 Transport；一个 Transport 失败不会阻止其他 Transport 或内置输出，但错误会通过 `flush()` / `close()` 交付。
- Processor 失败时，该记录不会继续发送到内置输出或 Transport；后续记录仍可继续处理。
- 慢速 Transport 会占用待处理队列，应结合 `maxQueuedRecords` / `maxQueuedBytes` 配置预算。
- Processor 和 Transport 属于受信任的应用代码，不应直接执行不可信插件，也不应无限期保留大型对象。

## 诊断与计时

`diagnostics()` 返回当前状态快照，可用于检查队列积压、丢弃数量、文件 Sink 状态、文件错误、恢复统计、Processor/Transport 错误等信息。读取快照不会重置计数器。

`flightRecorderStatus()` 返回记录数、占用字节、淘汰记录及捕获错误等状态。

Span 的持续时间使用单调时钟 `performance.now()` 计算；日志时间戳仍使用墙上时钟。

## 保证范围

RLog 的每实例队列不是跨进程互斥锁。它不提供多个实例之间的全局日志排序、自动压缩或按时间清理、崩溃时自动导出 Flight Recorder，也不提供 exactly-once 日志交付协议。需要更强交付语义的应用应自行实现持久化日志或业务级重试机制。
