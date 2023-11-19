# rlog-js

这是一个名为 `rlog-js` 的npm包，用于日志记录和输出。

## 安装

在项目目录下执行以下命令进行安装：

```
npm install rlog-js
```

## 使用

```javascript
const rlog = require("rlog-js");
```

## API

### rlog.init()

初始化rlog。如果配置了日志文件路径（`config.logFilePath`），将会创建日志文件并初始化日志流。

### rlog.info(message)

记录一条信息级别的日志，并同时在控制台和日志文件中输出。

### rlog.warning(message)

记录一条警告级别的日志，并同时在控制台和日志文件中输出。

### rlog.error(message)

记录一条错误级别的日志，并同时在控制台和日志文件中输出。

### rlog.success(message)

记录一条成功级别的日志，并同时在控制台和日志文件中输出。

### rlog.exit(message)

记录一条退出级别的日志，并同时在控制台和日志文件中输出。然后终止进程。

### rlog.config

rlog的配置对象，可以通过修改配置对象中的属性来自定义rlog的行为。

#### 可配置属性

- `enableColorfulOutput` (boolean): 是否启用控制台输出的颜色，默认为 `true`。
- `logFilePath` (string): 日志文件路径，默认为 `undefined`，表示不写入日志文件。
- `timeFormat` (string): 时间格式，默认为 `"YYYY-MM-DD HH:mm:ss.SSS"`。
- `timezone` (string): 时区，默认为 `"GMT"`。
- `blockedWordsList` (array): 需要屏蔽的敏感词列表，默认为空数组。
- `customColorRules` (array): 自定义颜色规则列表，默认包含一些基本规则。

#### rlog.screen

控制台输出相关的方法。

#### rlog.file

日志文件输出相关的方法。

## 示例

```javascript
const rlog = require("rlog-js");

rlog.config.setConfig({
  enableColorfulOutput: true,
  logFilePath: "logs.txt",
  timeFormat: "YYYY-MM-DD HH:mm:ss",
  timezone: "Asia/Shanghai",
  blockedWordsList: ["password", "secret"],
});

rlog.init();

rlog.info("This is an information log");
rlog.warning("This is a warning log");
rlog.error("This is an error log");
rlog.success("This is a success log");
rlog.exit("This is an exit log");
```
