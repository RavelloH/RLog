const Rlog = require("./dist/index.js");

const rlog = new Rlog({
  logFilePath: "./log.txt",
  timezone: "Asia/Shanghai",
  autoInit: false,
});

rlog.config.setConfig({
  blockedWordsList: ["world", "[0-9]{9}"],
  silent: false,
});

rlog.onExit(() => {
  rlog.warn("rlog.exit() called and event triggered.");
});

function sampleFunction(value) {
  return value;
}

rlog.info("This is an info message");
rlog.success("This is a success message");
rlog.warn("This is a warning message");
rlog.error("This is an error message");

rlog.info("");
rlog.info("Console-compatible argument formatting:");
rlog.log("a", { b: 1 }, 1);
rlog.log("user=%s score=%d", "Ravello", 100);
rlog.log(new Map([["feature", "console-compatible"]]));

rlog.info("");
rlog.info("Type rendering examples:");
rlog.info(123);
rlog.info(true);
rlog.info({
  time: Date.now(),
  text: "example",
});
rlog.info([1, 2, "5"]);
rlog.info(sampleFunction);
rlog.info(new Error("demo error"));

rlog.info("");
rlog.info("Blocked words:");
rlog.info("hello world !! 123456789");

rlog.info("");
rlog.info("String color rules:");
rlog.info("Welcome to https://github.com/RavelloH/RLog");
rlog.info("This is an ip: 123.45.67.89");
rlog.info("This is a date: 1970-12-12");
rlog.info("Boolean false true");

rlog.info("");
rlog.info("Multiline output:");
rlog.info(`1
22
333
4444`);
rlog.info("payload", {
  line1: "hello",
  line2: "world",
});

rlog.info("");
rlog.info("Automatic level recognition:");
rlog.log("This is a success message.", { code: 200 });
rlog.log("This is a warning message.", { code: 300 });
rlog.log("This is an error message.", { code: 500 });
rlog.log("This is an info message.", { code: 100 });

rlog.info("");
rlog.info("Time zone conversion:");
rlog.config.timezone = "Pacific/Port_Moresby";
rlog.info("Pacific/Port_Moresby");
rlog.config.timezone = "America/Chicago";
rlog.info("America/Chicago");
rlog.config.timezone = "Asia/Shanghai";
rlog.info("Asia/Shanghai");

rlog.info("");
rlog.info("Time format:");
rlog.config.timeFormat = "UTC";
rlog.info("UTC");
rlog.config.timeFormat = "timestamp";
rlog.info("timestamp");
rlog.config.timeFormat = "ISO";
rlog.info("ISO");
rlog.config.timeFormat = "YYYY-MM-DD HH:mm:ss.SSS";
rlog.info("YYYY-MM-DD HH:mm:ss.SSS");

rlog.info("");
rlog.info("Progress bar:");
rlog.progress(10, 100);
rlog.progress(50, 100);
rlog.progress(100, 100);
process.stdout.write("\n");

rlog.info("");
rlog.info("Exit demo is intentionally disabled to keep the demo process alive.");
// rlog.exit("Force to exit after saving logs");
