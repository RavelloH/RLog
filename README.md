# rlog-js

[![npm version](https://badge.fury.io/js/rlog-js.svg)](https://badge.fury.io/js/rlog-js)

一个现代化的 Node.js 日志库，完全使用 **TypeScript** 编写，提供完整的类型支持。

## 特性

- 完整的 TypeScript 支持
- 可设置时区
- 自定义时间格式
- 类型着色
- 字符串着色
- 敏感词加密
- 可显示进度条
- 分别设定某个日志输出到屏幕或文件
- 平替`console.log`，无缝迁移，自动识别日志等级
- 多行输出优化
- 自定义连接符
- rlog.exit()安全退出方法与退出钩子

![image](https://github.com/user-attachments/assets/bd5e1c3e-b872-4844-9f40-a19587eda847)

## 安装

使用npm进行安装：

```shell
npm install rlog-js
```

## 使用示例

### JavaScript

使用rlog-js非常简单，首先导入rlog-js:

```javascript
const Rlog = require("rlog-js");
```

然后创建一个Rlog实例:

```javascript
const rlog = new Rlog();
```

### TypeScript

rlog-js 完全使用 TypeScript 编写，提供原生的类型支持：

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

接下来就可以使用各种接口来输出日志了。
如果你的项目之前一直是用console.log来输出日志，那么直接替换所有`console`为`rlog`即可一步到位。

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
rlog.log("This is an automatically recognized type of log output");
rlog.warn("This is a warning log");
rlog.error("This is an error log");
rlog.success("This is a success log");
rlog.exit("This is a secure exit method");
```

## 进阶

rlog致力于成为nodejs端最好用的日志系统。以下是一些进阶使用方式：

### 配置

有三种方法可修改RLog的配置：  

```javascript
// Apply configuration when creating an instance
// 创建实例时应用配置
const rlog = new Rlog({
  logFilePath: "./log.txt",
  timezone: "Asia/Shanghai",
  autoInit: false,
});

// Use setConfig to set configuration
// 使用 setConfig 设置配置
rlog.config.setConfigGlobal({
  blockedWordsList: ["world", "[0-9]{9}"],
});
rlog.config.setConfig({
  silent: true
})

// Set config directly
// 直接设置配置
rlog.config.logFilePath = './log.txt'
rlog.config.timezone = 'Asia/Shanghai'
```

其中，`setConfig` 用于实例级配置，`setConfigGlobal` 用于全局默认配置。

### 自动判断日志级别

rlog提供了一个特殊的`rlog.log()`，以平替`console.log`。此方法通过关键词匹配，自动确定日志是否属于 `error`、`warning` 或 `success`，否则为 `info`。  

### 仅在屏幕/文件中输出

有些时候，日志输出并不一定要做到屏幕显示与文件同步。  
例如，要显示某个操作的进度(eg:11/100 11%)，就适合只显示在屏幕上而不应被写入文件中。  
而大段的错误信息，例如某网页/api请求后返回了错误的状态码，你可以仅在屏幕上显示一个大致的错误信息，而在日志文件中输出整个返回的响应，方便定位错误的同时保证输出的整洁性。  

```javascript
rlog.info("This will be shown both screen and file");
rlog.file.info("file only")
rlog.screen.info("screen only")
```

注：file与screen方式不提供自动判断类型的.log()方法，毕竟如果使用这个特性你肯定知道自己log的类型是什么。

### 强制退出

日志系统免不了与错误打交道，rlog提供了一个 `rlog.exit(message)`，你可以轻松的通过调用此函数来安全终止程序的运行。调用后，会在屏幕与文件中记录错误信息，然后阻塞进程，直到日志保存完后退出。  
不推荐使用`process.exit`的方法来关闭进程。由于文件日志写入是异步的，直接这样退出会导致日志无法成功保存，请使用`rlog.exit`来退出。  

### 退出钩子

很多程序在错误的时候会返回点什么统一的提示，例如给个Github Issue地址或者文档地址；或者完成什么配置保存工作或者关闭文件之类的事。显然每个错误的地方都写一条太麻烦了，你可以通过注册一个统一的 `onExit`，在调用 `rlog.exit()`之前做你想要的事。

```javascript
rlog.onExit(() => {
  rlog.warn("rlog.exit() called and event triggered.");
});
```

### 字符串着色

配置`customColorRules`来实现字符串的着色。支持正则表达式。  

```js
rlog.setConfig({
    customColorRules: [
       {
          reg: "[a-zA-z]+://[^\\s]*",
          color: "cyan",
        },
    ],
});
```

支持的颜色：  
![image](https://github.com/user-attachments/assets/d354c492-c6cb-42ea-9357-5bfd26d26589)

### 敏感词加密

配置`blockedWordsList`来实现敏感词的加密，或者说，日志脱敏。支持正则表达式。  

```js
rlog.setConfig({
    blockedWordsList: [
       "password",
       "[0-9]{9}"
    ],
});
```

你也可以在碰见敏感词的时候，就将其push到`rlog.config.blockedWordsList`中。

### 进度条

在屏幕上显示一个进度条真是太酷了。你可以简单的调用 `rlog.progress(num, max);`，rlog会自动计算比例，并显示一个进度条。  
多次调用porgress时，屏幕上只会保留最后一个进度条。

```js
const Rlog = require("rlog-js");
const rlog = new Rlog();

rlog.log('当一个progress单独出现时，不会影响上下文')
rlog.progress(168,1668)
rlog.log('当更多progress一块出现时，屏幕只显示最新的')

let i = 0
let a = setInterval(()=>{
    i +=1
    if (i == 234) {
        clearImmediate(a)
        process.exit()
    }
    rlog.progress(i,233)
},10)

```

![progess](https://github.com/RavelloH/RLog/assets/68409330/a699236a-ada8-427a-943e-e9bee0ab9c68)

进度条只会在screen中输出，随便调用，不会污染日志。

### 指定joinChar  

有的时候你可能想让程序整齐一点，输出多行内容的时候，代码也能赏心悦目，与输出的格式相同：

```javascript
// bad
rlog.info(`line1
line2`);

// bad
rlog.info("line1\nline2")

// good
rlog.config.joinChar = "\n"
rlog.info(
  "line1",
  "line2"
)
```

### 自动初始化

通常情况下，rlog会在创建实例时自动初始化日志文件。  
可在一些特殊情况下，例如Next.js 的构建流程会在多个阶段甚至子进程/线程中多次加载并实例化日志库，会导致日志文件被多次创建。  
在这种情况下，你可以通过设置`autoInit`为false来禁用自动初始化。  
在没有自动初始化的情况下，rlog也会在被首次调用时自行初始化。  
如果你想手动控制初始化的时机，可以在创建实例后调用`rlog.file.init()`来初始化日志文件。  

### 静默模式

rlog会自动输出一些信息，例如初始化日志文件的路径。  
你可以通过设置`silent`为true来启用静默模式，让rlog只输出你手动调用的日志。

## 接口

### Rlog

```javascript
rlog.methodName();
```

Rlog是rlog-js的主类，用于创建日志实例，会自动调用File和Screen方法。

| 方法                | 描述                                                   |
| ------------------- | ------------------------------------------------------ |
| `info(message)`     | 打印一条信息日志，并将其写入日志文件                   |
| `warn(message)`     | 打印一条警告日志，并将其写入日志文件                   |
| `error(message)`    | 打印一条错误日志，并将其写入日志文件                   |
| `success(message)`  | 打印一条成功日志，并将其写入日志文件                   |
| `exit(message)`     | 打印一条退出日志，并将其写入日志文件，然后终止应用程序 |
| `log(message)`      | 自动识别message类型并调用相关函数                      |
| `progress(num,max)` | 打印进度条，num为当前进度，max为总进度                 |

### Config

```javascript
rlog.config;
```

Config是一个用于配置rlog-js的类。可设置的项，详见[#配置项](#配置项)。

| 配置项                 | 类型                                  | 默认值                    | 描述                                     |
| ---------------------- | ------------------------------------- | ------------------------- | ---------------------------------------- |
| `enableColorfulOutput` | boolean                               | true                      | 是否启用彩色输出                         |
| `logFilePath`          | string                                | undefined                 | 日志文件的路径，默认表示不将日志写入文件 |
| `timeFormat`           | string                                | "YYYY-MM-DD HH:mm:ss.SSS" | 时间的格式                               |
| `timezone`             | string                                | "GMT"                     | 时区                                     |
| `blockedWordsList`     | Array\<string\>                       | []                        | 需要屏蔽的敏感词列表                     |
| `customColorRules`     | Array\<{reg: string, color: string}\> | 预设规则                  | 自定义的颜色规则列表                     |
| `screenLength`         | number                                | 自动获取                  | 屏幕输出的最大宽度                       |
| `joinChar`             | string                                | " "                       | 传入多个参数时的连接符                   |
| `silent`               | boolean                               | false                     | 是否启用静默模式                         |
| `autoInit`             | boolean                               | true                      | 是否自动初始化日志文件                   |

Config类方法：

| 方法                   | 描述                                               |
| ---------------------- | -------------------------------------------------- |
| `setConfig(obj)`       | 根据传入的对象更新配置                             |
| `setConfigGlobal(obj)` | 根据传入的对象更新配置，并将更新后的配置应用到全局 |

### Toolkit

```javascript
rlog.toolkit.methodName();
```

Toolkit是一个工具类，用于提供一些常用的工具函数。

| 方法                         | 描述                                         |
| ---------------------------- | -------------------------------------------- |
| `checkLogFile(path)`         | 检查日志文件是否存在，如果不存在则创建该文件 |
| `colorizeString(str)`        | 根据配置的颜色规则对字符串进行着色           |
| `formatTime()`               | 根据配置的时间格式和时区生成时间字符串       |
| `encryptPrivacyContent(str)` | 对字符串中的敏感内容进行加密                 |
| `colorizeType(variable)`     | 根据变量的类型对其进行着色                   |
| `padLines(str, width)`       | 对字符串中除第一行外的每一行进行缩进         |

### Screen

```javascript
rlog.screen.methodName();
```

Screen是用于在控制台打印日志的类。调用此方法，将仅在屏幕中输出，不会写入至文件。

| 方法                     | 描述                             |
| ------------------------ | -------------------------------- |
| `info(message, time)`    | 打印一条信息日志                 |
| `warn(message, time)`    | 打印一条警告日志                 |
| `error(message, time)`   | 打印一条错误日志                 |
| `success(message, time)` | 打印一条成功日志                 |
| `exit(message, time)`    | 打印一条退出日志，并终止应用程序 |

### File

```javascript
rlog.file.methodName();
```

File是用于将日志写入文件的类。调用此方法，若已设置日志文件路径，将会写入至文件，不会在屏幕输出。

| 方法                     | 描述                                                   |
| ------------------------ | ------------------------------------------------------ |
| `init()`                 | 初始化日志文件，如果配置了日志文件路径。不需要手动调用 |
| `writeLogToStream(text)` | 将日志写入文件流                                       |
| `writeLog(text)`         | 将日志写入文件                                         |
| `info(message, time)`    | 写入一条信息日志                                       |
| `warn(message, time)`    | 写入一条警告日志                                       |
| `error(message, time)`   | 写入一条错误日志                                       |
| `success(message, time)` | 写入一条成功日志                                       |
| `exit(message, time)`    | 写入一条退出日志，并终止应用程序                       |

## 配置项

rlog-js还提供了一些配置选项，可以在创建Rlog实例时进行配置，也可以使用`setConfig()`和`setConfigGlobal()`或者以`rlog.config[config] = <value>`的方式设置。

以下是可用的配置选项及其默认值:

```javascript
{
    enableColorfulOutput: true, // 是否启用彩色输出
    logFilePath: undefined,     // 日志文件路径，如果不设置则不会输出到文件
    timeFormat: "YYYY-MM-DD HH:mm:ss.SSS", // 时间格式
    timezone: "GMT",      // 时区
    joinChar: " ",        // 指定传入多参数时应如何连接
    blockedWordsList: [], // 需要屏蔽的词汇列表
    autoInit: true,       // 是否自动初始化日志文件
    customColorRules: [   // 自定义颜色规则
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

关于如何更改配置项，请查看[#配置](#配置)部分。

## 开发

### 从源码构建

本项目使用 TypeScript 编写，需要先编译才能使用：

```bash
# 克隆仓库
git clone https://github.com/RavelloH/RLog.git
cd RLog

# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 运行测试
npm test
```

### 项目结构

```text
RLog/
├── src/           # TypeScript 源码
│   └── index.ts   # 主文件
├── dist/          # 编译输出 (自动生成)
│   ├── index.js   # 编译后的 JS
│   └── index.d.ts # 类型声明文件
├── test.js        # 测试文件
└── tsconfig.json  # TypeScript 配置
```

### 类型安全

使用 TypeScript 重写后，所有潜在的类型错误都在编译期被捕获：

- ✅ 所有 `chalk` 颜色调用都有类型检查
- ✅ 配置项有完整的接口定义
- ✅ 异步操作有正确的 Promise 类型
- ✅ 所有类方法都有明确的返回类型

## License

MIT License
