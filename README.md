# rlog-js

[![npm version](https://badge.fury.io/js/rlog-js.svg)](https://badge.fury.io/js/rlog-js)

rlog-js是一个用于记录日志的npm包。它提供了一系列的接口，用于在控制台和文件中打印日志。同时，它还提供了一些工具函数，用于格式化日志信息、加密敏感内容等。

## 安装

使用npm进行安装：

```shell
npm install rlog-js
```

## 使用示例

使用rlog-js非常简单，首先导入rlog-js:

```javascript
const Rlog = require("rlog-js");
```

然后创建一个Rlog实例:

```javascript
const rlog = new Rlog();
```

接下来就可以使用各种接口来输出日志了。

具体来说，`./test.js`中有大量对rlog的调用示例，以供查看。

一个最简单的使用示例如下：

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
rlog.log('This is an automatically recognized type of log output')
rlog.warning("This is a warning log");
rlog.error("This is an error log");
rlog.success("This is a success log");
rlog.exit("This is a secure exit method");
```

## 接口

### Rlog

```javascript
rlog.methodName()
```
Rlog是rlog-js的主类，用于创建日志实例，会自动调用File和Screen方法。它具有以下方法：

- `info(message)`：打印一条信息日志，并将其写入日志文件。
- `warning(message)`：打印一条警告日志，并将其写入日志文件。
- `error(message)`：打印一条错误日志，并将其写入日志文件。
- `success(message)`：打印一条成功日志，并将其写入日志文件。
- `exit(message)`：打印一条退出日志，并将其写入日志文件，然后终止应用程序。
- `log(message)`: 自动识别message类型并调用相关函数。


### Config

```javascript
rlog.config
```

Config是一个用于配置rlog-js的类。可设置的项，详见[#配置](#配置)。

- `enableColorfulOutput`（boolean）：是否启用彩色输出，默认为true。
- `logFilePath`（string）：日志文件的路径，默认为undefined，表示不将日志写入文件。
- `timeFormat`（string）：时间的格式，默认为"YYYY-MM-DD HH:mm:ss.SSS"。
- `timezone`（string）：时区，默认为"GMT"。
- `blockedWordsList`（Array\<string\>）：需要屏蔽的敏感词列表，默认为空数组。
- `customColorRules`（Array\<{reg: string, color: string}\>）：自定义的颜色规则列表，默认包含一些常用规则。

Config类提供了以下方法：

- `setConfig(obj)`：根据传入的对象更新配置。
- `setConfigGlobal(obj)`：根据传入的对象更新配置，并将更新后的配置应用到全局。

### Toolkit

```javascript
rlog.toolkit.methodName();
```

Toolkit是一个工具类，用于提供一些常用的工具函数。它具有以下方法：

- `checkLogFile(path, rlog)`：检查日志文件是否存在，如果不存在则创建该文件。
- `colorizeString(str)`：根据配置的颜色规则对字符串进行着色。
- `formatTime()`：根据配置的时间格式和时区生成时间字符串。
- `encryptPrivacyContent(str)`：对字符串中的敏感内容进行加密。
- `colorizeType(variable)`：根据变量的类型对其进行着色。
- `padLines(str, width)`：对字符串中除第一行外的每一行进行缩进。

### Screen

```javascript
rlog.screen.methodName()
```

Screen是用于在控制台打印日志的类。调用此方法，将仅在屏幕中输出，不会写入至文件。它具有以下方法：

- `info(message, time)`：打印一条信息日志。
- `warning(message, time)`：打印一条警告日志。
- `error(message, time)`：打印一条错误日志。
- `success(message, time)`：打印一条成功日志。
- `exit(message, time)`：打印一条退出日志，并终止应用程序。

### File

```javascript
rlog.file.methodName()
```

File是用于将日志写入文件的类。调用此方法，若已设置日志文件路径，将会写入至文件，不会在屏幕输出。它具有以下方法：

- `init()`：初始化日志文件，如果配置了日志文件路径。不需要手动调用。
- `writeLogToStream(text)`：将日志写入文件流。
- `writeLog(text)`：将日志写入文件。
- `info(message, time)`：写入一条信息日志。
- `warning(message, time)`：写入一条警告日志。
- `error(message, time)`：写入一条错误日志。
- `success(message, time)`：写入一条成功日志。
- `exit(message, time)`：写入一条退出日志，并终止应用程序。

## 配置

rlog-js还提供了一些配置选项，可以在创建Rlog实例时进行配置，也可以使用`setConfig()`和`setConfigGlobal()`或者以`rlog.config[config] = <value>`的方式设置。

以下是可用的配置选项及其默认值:

```javascript
{
    enableColorfulOutput: true,
    // 是否启用彩色输出
    logFilePath: undefined,
    // 日志文件路径，如果不设置则不会输出到文件
    timeFormat: "YYYY-MM-DD HH:mm:ss.SSS",
    // 时间格式
    timezone: "GMT",
    // 时区
    blockedWordsList: [],
    // 需要屏蔽的词汇列表
    customColorRules: [// 自定义颜色规则
        {
            reg: "false",
            color: "red",
        },
        {
            reg: "true",
            color: "green",
        },
        {
            reg: "((2(5[0-5]|[0-4]\\d))|[0-1]?\\d{1,2})(\\.((2(5[0-5]|[0-4]\\d))|[0-1]?\\d{1,2})){3}",
            color: "cyan",
        },
        {
            reg: "[a-zA-z]+://[^\\s]*",
            color: "cyan",
        },
        {
            reg: "\\d{4}-\\d{1,2}-\\d{1,2}",
            color: "green",
        },
        {
            reg: "\\w+([-+.]\\w+)*@\\w+([-.]\\w+)*\\.\\w+([-.]\\w+)*",
            color: "cyan",
        },
        {
            reg: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
            color: "cyan",
        },
        {
            reg: "(w+)s*:s*([^;]+)",
            color: "cyan",
        },
    ]
}
```

可以通过传递一个配置对象来配置Rlog实例:

```javascript
const config = {
    enableColorfulOutput: true,
    logFilePath: "/path/to/logfile.log",
    timeFormat: "YYYY-MM-DD HH:mm:ss.SSS",
    timezone: "GMT",
    blockedWordsList: ["password",
        "secret"],
    customColorRules: [{
        reg: "error",
        color: "red",
    },
        {
            reg: "warning",
            color: "yellow",
        },
        {
            reg: "success",
            color: "green",
        },
    ],
};

const rlog = new Rlog(config);
```

或者使用相关函数设置:

```javascript
rlog.config.setConfig({
    timeFormat: "YYYY-MM-DD HH:mm:ss",
    timezone: "Asia/Shanghai",
    blockedWordsList: ["password", "secret"],
});

rlog.config.setConfigGlobal({
    timeFormat: "YYYY-MM-DD HH:mm:ss",
    timezone: "Asia/Shanghai",
    blockedWordsList: ["password", "secret"],
});
```


## License

MIT License
