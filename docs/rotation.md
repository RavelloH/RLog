# 文件轮转

RLog v3 为普通文本日志和 JSONL 日志提供按大小轮转。轮转默认关闭，只使用 Node.js 内置文件系统能力；它不适用于 screen、文本/二进制 Capture 文件，也不提供按时间轮转、压缩或远程传输。

## 配置

`textRotation` 与 `jsonlRotation` 独立配置：

```js
const rlog = new Rlog({
  logFilePath: "./logs/app.log",
  jsonlFilePath: "./logs/events.jsonl",
  textRotation: {
    maxBytes: 10 * 1024 * 1024,
    maxFiles: 5,
  },
  jsonlRotation: {
    maxBytes: 20 * 1024 * 1024,
    maxFiles: 3,
  },
});
```

- `maxBytes`：活动文件的大小阈值，必须是正的有限数字。
- `maxFiles`：保留的历史轮转文件数量，不包含当前活动文件；必须为非负整数。
- `false` 或未配置：禁用该目标的轮转。

文本使用 `logFilePath`，JSONL 使用 `jsonlFilePath`；一个目标未配置文件路径时，该目标不会轮转。

## 命名与保留规则

若活动文件为 `app.log` 且 `maxFiles: 3`，文件集合为：

```text
app.log     当前活动文件
app.log.1   最新历史文件
app.log.2
app.log.3   最旧历史文件
```

轮转时按以下顺序执行：

1. 删除超出 `maxFiles` 的最旧历史文件；
2. 从大到小移动现有历史文件，例如 `.2` 变为 `.3`；
3. 将活动文件移动为 `.1`；
4. 创建新的活动文件；
5. 将触发轮转的完整记录写入新文件。

`maxFiles: 0` 不保留历史文件：活动文件在轮转时被移除并重新创建。

## 写入时机与顺序保证

RLog 在写入一条记录之前判断：

```text
当前活动文件大小 + 下一条记录大小 > maxBytes
```

满足条件时先轮转，再写入该记录。因此单条日志不会跨两个文件。若一条记录本身大于 `maxBytes`，它会完整写入新的活动文件，不会反复触发轮转。

每个受控文件都有独立串行操作链。普通日志、`text.writeRaw()`、`flush()`、轮转和 `close()` 都在同一链中执行，保证：

- 并发写入不会并发打开、关闭或重命名同一文件；
- 记录与原始文本保持调用顺序；
- `currentBytes` 与轮转判断一致；
- `flush()` 等待此前所有写入和轮转；
- `close()` 等待此前操作后再关闭文件。

Windows 上会先关闭流再重命名，避免依赖 Unix 的“打开文件可重命名”行为。

## 运行时更新配置

`setConfig()` 会更新当前 Logger，`setConfigGlobal()` 会更新所有仍打开的实例及后续新实例。轮转选项不会在 Sink 创建时冻结，而是在每次写入时读取：

```js
// 初始未启用轮转，后续开启。
rlog.config.setConfig({
  textRotation: { maxBytes: 1024, maxFiles: 2 },
});

// 修改阈值，或显式关闭 JSONL 轮转。
rlog.config.setConfig({
  textRotation: { maxBytes: 4096, maxFiles: 4 },
  jsonlRotation: false,
});
```

配置对象会被复制；调用方之后修改传入对象，不会改变 Logger 的实际配置。

## 错误处理

轮转失败会以 `operation: "rotate"` 通过 `onFileError` 报告，并遵循 `fileErrorPolicy`。策略可以统一配置，也可按目标分别设置：

```js
const rlog = new Rlog({
  fileErrorPolicy: {
    text: "stderr",
    jsonl: "throw",
    default: "throw",
  },
  onFileError(error, context) {
    console.error(context.output, context.operation, error);
  },
});
```

- `"throw"`：在后续 `flush()` 或 `close()` 交付错误。
- `"disable"`：禁用失败目标，其他目标继续工作。
- `"stderr"`：输出到标准错误并禁用失败目标。
- `"ignore"`：静默禁用失败目标。

轮转失败不会让其他 Sink 停止写入。直接使用 `rlog.text.stream` / `rlog.file.logStream` 写底层流不受这套保证保护：它会绕过大小统计、轮转、顺序和错误交付；请使用 `rlog.text.writeRaw()`。

## Capture 文件

Capture 文件具有“一次任务一个文件”的语义，默认以 `truncate` 模式创建，不参与 text 或 JSONL 轮转。路径命名、Run 目录、保留策略和清理由调用方负责。详情见 [Capture 指南](capture.md)。
