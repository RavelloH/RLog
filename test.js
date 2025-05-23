const Rlog = require("./index.js");

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
  silent: false,
})

// Set config directly
// 直接设置配置
rlog.config.logFilePath = './log.txt'
rlog.config.timezone = 'Asia/Shanghai'


// Create exit event hook
// 创建退出事件钩子
rlog.onExit(() => {
  rlog.warning("rlog.exit() called and event triggered.");
});

function test() {
  let a = null;
}

// Regular call method
// 常规调用方式
rlog.info("This is a info");
rlog.success("This is a success");
rlog.warning("This is a warning");
rlog.error("This is a error");


// Test colorize type
// 测试类型着色
rlog.info("Testing colorize type:");
rlog.info(123);
rlog.info(true);
rlog.info({
  time: Date.now(),
  text: "example",
});
rlog.info([1, 2, "5"]);
rlog.info(test);

// Test blocked words
// 测试屏蔽词
rlog.info("Testing lock words:");
rlog.info(`hello world !! 123456789`);

// Test string colorize
// 测试字符串着色
rlog.info("");
rlog.info("Testing colorize string:");
rlog.info("Welcome to https://github.com/RavelloH/RLog");
rlog.info("This is a ip: 123.45.67.89");
rlog.info("This is a date: 1970-12-12");
rlog.info("Boolean false true");

// Test multi line output
// 测试多行输出
rlog.info("");
rlog.info("Test multi line output");
rlog.info(`1\n22\n333\n4444`);

rlog.info("");
rlog.info("Test automatic recognition");
rlog.log("This is a success message.");
rlog.log("This is a warning message.");
rlog.log("This is an error message.");
rlog.log("This is an info message.");

// Test time zone
// 测试时区
rlog.info("");
rlog.info("Test Time Zone Conversion");
rlog.config.timezone = "Pacific/Port_Moresby";
rlog.info("Pacific/Port_Moresby");
rlog.config.timezone = "America/Chicago";
rlog.info("America/Chicago");
rlog.config.timezone = "Asia/Shanghai";
rlog.info("Asia/Shanghai");

// Test time format
// 测试时间格式
rlog.info("");
rlog.info("Test Time Format");
rlog.config.timeFormat = "UTC";
rlog.info("UTC");
rlog.config.timeFormat = "timestamp";
rlog.info("timestamp");
rlog.config.timeFormat = "ISO";
rlog.info("ISO");
rlog.config.timeFormat = "YYYY-MM-DD HH:mm:ss.SSS";
rlog.info("YYYY-MM-DD HH:mm:ss.SSS");

// Test multiple parameters
// 测试多参数传入
rlog.info("");
rlog.log("Hello world!", "This is a message", 123, true);
rlog.info("Hello world!", "This is a message", 123, true);

// Test custom joinChar
// 测试自定义连接符 
rlog.info("");
rlog.info("Test joinChar");
rlog.config.joinChar = "\n";
rlog.log("Line 1", "Line2");

// Test progress bar
// 测试进度条
rlog.progress(10, 100);
rlog.progress(50, 100);
rlog.progress(100, 100);

// Test exit method
// 测试exit方式
rlog.info("Test security exit");
rlog.exit("Force to exit after saving logs");
console.log("This will not be printed");

// 性能测试
// Performance test
// console.time()
// for (i=0;i<=100000;i++) {
//     rlog.info(i)
//     if (i === 10000) {
//         rlog.exit("Force to exit after saving logs");
//     }
// }
// console.timeEnd();
