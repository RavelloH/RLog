const chalk = require("chalk");
const { Writable } = require("stream");
const fs = require("fs");
const moment = require("moment");
require("moment-timezone");

async function checkLogFile(path) {
  try {
    await fs.promises.access(path, fs.constants.F_OK);
  } catch (err) {
    try {
      await fs.promises.writeFile(path, "");
      rlog.screen.warning(
        `The specified log file ${path} does not exist, but successfully created.`,
      );
    } catch (err) {
      rlog.screen.error("Could not create file, error: " + err);
    }
  }
}

function colorizeString(str) {
  rlog.config.customColorRules.forEach((setting) => {
    const { reg, color } = setting;
    const regex = new RegExp(reg, "g");
    str = str.replace(regex, (match) => chalk[color](match));
  });

  return str;
}

function formatTime() {
  const now = moment();
  const str = rlog.config.timeFormat;
  const timezone = rlog.config.timezone;

  if (str === "timestamp") {
    return now.valueOf();
  } else if (str === "ISO") {
    return now.tz(timezone).toISOString();
  } else if (str === "GMT") {
    return now.tz("GMT").format("YYYY-MM-DDTHH:mm:ss.SSS") + "Z";
  } else if (str === "UTC") {
    return now.utc().format();
  } else {
    return now.tz(timezone).format(str);
  }
}

function encryptPrivacyContent(str) {
  if (typeof str !== "string" || rlog.config.blockedWordsList.length === 0) {
    return str;
  }
  rlog.config.blockedWordsList.forEach((regex) => {
    const pattern = new RegExp(regex, "g");
    const replacement = "*".repeat(regex.length);
    str = str.replace(pattern, replacement);
  });

  return str;
}

function colorizeType(variable) {
  let type = typeof variable;
  let coloredStr;

  switch (type) {
    case "string":
      coloredStr = variable;
      break;
    case "number":
      coloredStr = chalk.blue(variable);
      break;
    case "boolean":
      coloredStr = chalk.green(variable);
      break;
    case "object":
      coloredStr = chalk.magenta(JSON.stringify(variable));
      break;
    case "function":
      coloredStr = chalk.cyan(variable.toString());
      break;
    default:
      coloredStr = variable;
  }

  return coloredStr;
}

function padLines(str, width) {
  let lines = str.split("\n");
  let paddedLines = [];

  paddedLines.push(lines[0]);

  for (let i = 1; i < lines.length; i++) {
    let padding = " ".repeat(width);
    paddedLines.push(padding + lines[i]);
  }

  return paddedLines.join("\n");
}

const rlog = {
  init: async function () {
    if (this.config.logFilePath) {
      checkLogFile(this.config.logFilePath);
      try {
        this.logStream = fs.createWriteStream(this.config.logFilePath, {
          flags: "a",
        });
        this.screen.info(
          "The log will be written to " + this.config.logFilePath,
        );
      } catch (err) {
        this.screen.exit("Error creating log stream: ", err);
      }
    }
    if (!this.config.enableColorfulOutput) {
      chalk.level = 0;
    }
  },
  info: function (message) {
    const time = formatTime();
    this.screen.info(message, time);
    this.file.info(message, time);
  },
  warning: function (message) {
    const time = formatTime();
    this.screen.warning(message, time);
    this.file.warning(message, time);
  },
  error: function (message) {
    const time = formatTime();
    this.screen.error(message, time);
    this.file.error(message, time);
  },
  success: function (message) {
    const time = formatTime();
    this.screen.success(message, time);
    this.file.success(message, time);
  },
  exit: async function (message) {
    const time = formatTime();
    this.screen.exit(message, time);
    await this.writeLogToStream(`${time}[EXIT]${message}\n`);
    process.exit();
  },
  writeLogToStream: function (text) {
    return new Promise((resolve, reject) => {
      if (this.logStream) {
        this.logStream.write(text, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      } else {
        reject(new Error("Log stream not initialized"));
      }
    });
  },
  screen: {
    info: (message, time) => {
      const timeheader = `[${time || formatTime()}]`;
      console.log(
        `${timeheader}[${chalk.cyan("INFO")}] ${colorizeString(
          encryptPrivacyContent(
            padLines(colorizeType(message), timeheader.length + 7),
          ),
        )}`,
      );
    },
    warning: (message, time) => {
      const timeheader = `[${time || formatTime()}]`;
      console.log(
        `${timeheader}[${chalk.yellow("WARNING")}] ${colorizeString(
          encryptPrivacyContent(
            padLines(colorizeType(message), timeheader.length + 10),
          ),
        )}`,
      );
    },
    error: (message, time) => {
      const timeheader = `[${time || formatTime()}]`;
      console.log(
        `${timeheader}[${chalk.red("ERROR")}] ${colorizeString(
          encryptPrivacyContent(
            padLines(colorizeType(message), timeheader.length + 8),
          ),
        )}`,
      );
    },
    success: (message, time) => {
      const timeheader = `[${time || formatTime()}]`;
      console.log(
        `${timeheader}[${chalk.green("SUCCESS")}] ${colorizeString(
          encryptPrivacyContent(
            padLines(chalk.green(message), timeheader.length + 10),
          ),
        )}`,
      );
    },
    exit: (message, time) => {
      const timeheader = `[${time || formatTime()}]`;
      console.log(
        `${timeheader}[${chalk.bold.red("EXIT")}] ${colorizeString(
          encryptPrivacyContent(
            padLines(chalk.bold.red(message), timeheader.length + 7),
          ),
        )}`,
      );
    },
  },
  file: {
    info: (message, time) => {
      rlog.writeLog(
        `[${time || formatTime()}][INFO] ${encryptPrivacyContent(
          message,
          rlog.config.blockedWordsList,
        )}`,
      );
    },
    warning: (message, time) => {
      rlog.writeLog(
        `[${time || formatTime()}][WARNING] ${encryptPrivacyContent(
          message,
          rlog.config.blockedWordsList,
        )}`,
      );
    },
    error: (message, time) => {
      rlog.writeLog(
        `[${time || formatTime()}][ERROR] ${encryptPrivacyContent(
          message,
          rlog.config.blockedWordsList,
        )}`,
      );
    },
    success: (message, time) => {
      rlog.writeLog(
        `[${time || formatTime()}][SUCCESS] ${encryptPrivacyContent(
          message,
          rlog.config.blockedWordsList,
        )}`,
      );
    },
    exit: (message, time) => {
      rlog.writeLog(
        `[${time || formatTime()}][EXIT] ${encryptPrivacyContent(
          message,
          rlog.config.blockedWordsList,
        )}`,
      );
    },
  },
  writeLog: function (text) {
    if (this.config.logFilePath) {
      if (!this.logStream) {
        this.screen.warning(
          "RLog not initialized, automatic execution in progress...",
        );
        this.init();
      }
      this.logStream.write(`${text}\n`);
    }
  },
  config: {
    enableColorfulOutput: true,
    logFilePath: undefined,
    timeFormat: "YYYY-MM-DD HH:mm:ss.SSS",
    timezone: "GMT",
    blockedWordsList: [],
    customColorRules: [
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
        reg: "[a-zA-z]+://[^\\s]*", // 网址
        color: "cyan",
      },
      {
        reg: "\\d{4}-\\d{1,2}-\\d{1,2}", // IP
        color: "green",
      },
      {
        reg: "\\w+([-+.]\\w+)*@\\w+([-.]\\w+)*\\.\\w+([-.]\\w+)*", // 邮箱
        color: "cyan",
      },
      {
        reg: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", // uuid
        color: "cyan",
      },
      {
        reg: "(w+)s*:s*([^;]+)", // 键值对
        color: "cyan",
      }
    ],
    setConfig: function (obj) {
      for (let key in obj) {
        if (obj.hasOwnProperty(key)) {
          rlog.config[key] = obj[key];
        }
      }
    },
  },
};

process.on("beforeExit", async () => {
  if (rlog.logStream) {
    await new Promise((resolve) => {
      rlog.logStream.end(resolve);
    });
  }
});

module.exports = rlog;
