const Rlog = require("./index.js");
const rlog = new Rlog({
  logFilePath: "./log.txt",
  timezone: "Asia/Shanghai",
});

rlog.config.setConfigGlobal({
  blockedWordsList: ["world", "[0-9]{9}"],
});
// rlog.config.logFilePath = './log.txt'
// rlog.config.timezone = 'Asia/Shanghai'

// Register an exit callback to display additional information
rlog.onExit(() => {
  rlog.warning('rlog.exit() called and event triggered.');
});

function test() {
  let a = null;
}
rlog.info("This is a info");
rlog.success("This is a success");
rlog.warning("This is a warning");
rlog.error("This is a error");

rlog.info("Testing colorize type:");
rlog.info(123);
rlog.info(true);
rlog.info({
  time: Date.now(),
  text: "example",
});
rlog.info([1, 2, "5"]);
rlog.info(test);

rlog.info("Testing lock words:");
rlog.info(`hello world !! 123456789`);

rlog.info("");
rlog.info("Testing colorize string:");
rlog.info("Welcome to https://github.com/RavelloH/RLog");
rlog.info("This is a ip: 123.45.67.89");
rlog.info("This is a date: 1970-12-12");
rlog.info("Boolean false true");

rlog.info("");
rlog.info("Test multi line output");
rlog.info(`1\n22\n333\n4444`);

rlog.info("");
rlog.info("Test automatic recognition");
rlog.log("This is a success message.");
rlog.log("This is a warning message.");
rlog.log("This is an error message.");
rlog.log("This is an info message.");

rlog.info("");
rlog.info("Test Time Zone Conversion");
rlog.config.timezone = "Pacific/Port_Moresby";
rlog.info("Pacific/Port_Moresby");
rlog.config.timezone = "America/Chicago";
rlog.info("America/Chicago");
rlog.config.timezone = "Asia/Shanghai";
rlog.info("Asia/Shanghai");

rlog.info("");
rlog.info("Test Time Format");
rlog.config.timeFormat = "UTC",
rlog.info("UTC")
rlog.config.timeFormat = "timestamp",
rlog.info("timestamp")
rlog.config.timeFormat = "ISO",
rlog.info("ISO")
rlog.config.timeFormat = "YYYY-MM-DD HH:mm:ss.SSS",
rlog.info("YYYY-MM-DD HH:mm:ss.SSS")

rlog.info("");
rlog.info("Test security exit");
rlog.exit("Force to exit after saving logs");
/* console.time()

for (i=0;i<=1000;i++) {
    rlog.info(i)
}

console.timeEnd() */
