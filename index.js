const chalk = require("chalk");
const fs = require("fs-extra");
const moment = require("moment");
require("moment-timezone");

function Config() {
  if (!this.enableColorfulOutput) {
    chalk.level = 0;
  }
}
Config.prototype = {
  enableColorfulOutput: true,
  logFilePath: undefined,
  timeFormat: "YYYY-MM-DD HH:mm:ss.SSS",
  timezone: undefined,
  joinChar: " ",
  blockedWordsList: [],
  screenLength: process.stdout.columns,
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
    },
  ],
  setConfig(obj) {
    for (let key in obj) {
      if (obj.hasOwnProperty(key)) {
        this[key] = obj[key];
      }
    }
  },
  setConfigGlobal(obj) {
    for (let key in obj) {
      if (obj.hasOwnProperty(key)) {
        this[key] = Config.prototype[key] = obj[key];
      }
    }
  },
};

class Toolkit {
  constructor(config) {
    this.config = config;
  }
  /**@type {Config} */
  config = null;
  /**@type {Screen} */
  screen = null;
  async checkLogFile(path) {
    try {
      await fs.ensureFileSync(path);
      await fs.promises.access(path, fs.constants.F_OK);
    } catch (err) {
      try {
        await fs.promises.writeFile(path, "");
      } catch (err) {
        this.screen.error("Could not create file, error: " + err);
      }
    }
  }

  colorizeString(str) {
    if (!str || typeof str !== 'string') return str;
    const ansiColorRegex = /(\u001b\[\d+m)/g;
    const parts = str.split(ansiColorRegex);
    
    let activeColorStack = [];
    const result = [];

    for (const part of parts) {
      if (part.startsWith('\u001b[')) {
        if (part === '\u001b[39m') {
          activeColorStack = [];
        } else {
          activeColorStack.push(part);
        }
        result.push(part);
        continue;
      }

      if (!part) continue;
      
      const currentColorState = [...activeColorStack];
      let processedText = part;
      for (const { reg, color } of this.config.customColorRules) {
        const regex = new RegExp(reg, 'g');
        
        processedText = processedText.replace(regex, (match) => {
          const coloredMatch = chalk[color](match);
          const colorParts = coloredMatch.split(ansiColorRegex).filter(Boolean);
          const colorStart = colorParts[0];
          const matchText = colorParts
            .filter(p => !p.startsWith('\u001b['))
            .join('');

          const restoreColor = currentColorState.length > 0
            ? currentColorState.join('')
            : '\u001b[39m';

          return colorStart + matchText + restoreColor;
        });
      }

      result.push(processedText);
    }

    return result.join('');
  }

  formatTime() {
    const now = moment();
    const str = this.config.timeFormat;
    const timezone = this.config.timezone;
    if (timezone) {
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
    } else {
      return now.format(str);
    }
  }

  encryptPrivacyContent(str) {
    if (typeof str !== "string" || this.config.blockedWordsList.length === 0) {
      return str;
    }
    this.config.blockedWordsList.forEach((regex) => {
      const pattern = new RegExp(regex, "g");
      const replacement = "*".repeat(regex.length);
      str = str.replace(pattern, replacement);
    });

    return str;
  }

  colorizeType(variable) {
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

  padLines(str, width) {
    let lines = str.split("\n");
    let paddedLines = [];

    paddedLines.push(lines[0]);

    for (let i = 1; i < lines.length; i++) {
      let padding = " ".repeat(width);
      paddedLines.push(padding + lines[i]);
    }

    return paddedLines.join("\n");
  }

  stringify(obj) {
    if (typeof obj === "string") {
      return obj;
    }
    if (typeof obj === "object") {
      return JSON.stringify(obj, null, 2);
    }
    return obj.toString();
  }
}

class Screen {
  constructor(toolkit) {
    this.toolkit = toolkit;
  }
  /**@type {Toolkit} */
  toolkit = null;
  info(message, time) {
    const timeheader = `[${time || this.toolkit.formatTime()}]`;
    process.stdout.write(
      `${timeheader}[${chalk.cyan("INFO")}] ${this.toolkit.colorizeString(
        this.toolkit.encryptPrivacyContent(
          this.toolkit.padLines(
            this.toolkit.colorizeType(message),
            timeheader.length + 7
          )
        )
      )}\n`
    );
  }
  warning(message, time) {
    const timeheader = `[${time || this.toolkit.formatTime()}]`;
    process.stdout.write(
      `${timeheader}[${chalk.yellow("WARN")}] ${this.toolkit.colorizeString(
        this.toolkit.encryptPrivacyContent(
          this.toolkit.padLines(
            this.toolkit.colorizeType(message),
            timeheader.length + 7
          )
        )
      )}\n`
    );
  }
  error(message, time) {
    const timeheader = `[${time || this.toolkit.formatTime()}]`;
    process.stdout.write(
      `${timeheader}[${chalk.red("ERR!")}] ${this.toolkit.colorizeString(
        this.toolkit.encryptPrivacyContent(
          this.toolkit.padLines(
            this.toolkit.colorizeType(message),
            timeheader.length + 7
          )
        )
      )}\n`
    );
  }
  success(message, time) {
    const timeheader = `[${time || this.toolkit.formatTime()}]`;
    process.stdout.write(
      `${timeheader}[${chalk.green("SUCC")}] ${this.toolkit.colorizeString(
        this.toolkit.encryptPrivacyContent(
          this.toolkit.padLines(chalk.green(message), timeheader.length + 7)
        )
      )}\n`
    );
  }
  exit(message, time) {
    const timeheader = `[${time || this.toolkit.formatTime()}]`;
    process.stdout.write(
      `${timeheader}[${chalk.bold.red("EXIT")}] ${this.toolkit.colorizeString(
        this.toolkit.encryptPrivacyContent(
          this.toolkit.padLines(chalk.bold.red(message), timeheader.length + 7)
        )
      )}\n`
    );
  }
}

class File {
  constructor(toolkit, config, screen) {
    this.config = config;
    this.toolkit = toolkit;
    this.screen = screen;
    this.init();
  }
  /**@type {Config} */
  config = null;
  /**@type {Toolkit} */
  toolkit = null;
  /**@type {Screen} */
  screen = null;
  /**@type {fs.WriteStream} */
  logStream = null;

  init() {
    if (this.config.logFilePath) {
      this.toolkit.checkLogFile(this.config.logFilePath);
      try {
        this.logStream = fs.createWriteStream(this.config.logFilePath, {
          flags: "a",
        });
        this.screen.info(
          "The log will be written to " + this.config.logFilePath
        );
      } catch (err) {
        this.screen.exit("Error creating log stream: ", err);
      }
    }
  }
  writeLogToStream(text) {
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
  }
  writeLog(text) {
    if (this.config.logFilePath) {
      if (!this.logStream) {
        this.screen.warning(
          "RLog not initialized, automatic execution in progress..."
        );
        this.init();
      }
      this.logStream.write(`${text}\n`);
    }
  }

  info(message, time) {
    this.writeLog(
      `[${
        time || this.toolkit.formatTime()
      }][INFO] ${this.toolkit.encryptPrivacyContent(
        this.toolkit.stringify(message),
        this.config.blockedWordsList
      )}`
    );
  }
  warning(message, time) {
    this.writeLog(
      `[${
        time || this.toolkit.formatTime()
      }][WARNING] ${this.toolkit.encryptPrivacyContent(
        this.toolkit.stringify(message),
        this.config.blockedWordsList
      )}`
    );
  }
  error(message, time) {
    this.writeLog(
      `[${
        time || this.toolkit.formatTime()
      }][ERROR] ${this.toolkit.encryptPrivacyContent(
        this.toolkit.stringify(message),
        this.config.blockedWordsList
      )}`
    );
  }
  success(message, time) {
    this.writeLog(
      `[${
        time || this.toolkit.formatTime()
      }][SUCCESS] ${this.toolkit.encryptPrivacyContent(
        this.toolkit.stringify(message),
        this.config.blockedWordsList
      )}`
    );
  }
  exit(message, time) {
    this.writeLog(
      `[${
        time || this.toolkit.formatTime()
      }][EXIT] ${this.toolkit.encryptPrivacyContent(
        this.toolkit.stringify(message),
        this.config.blockedWordsList
      )}`
    );
  }
}

class Rlog {
  static Config = Config;
  static Toolkit = Toolkit;
  static Screen = Screen;
  static File = File;
  /**
   * @param {Config} config
   */
  constructor(config) {
    this.config.setConfig(config);
    this.toolkit.screen = this.screen = new Screen(this.toolkit);
    this.file = new File(this.toolkit, this.config, this.screen);
    this.exitListeners = [];
  }
  /**@type {Config} */
  config = new Config();
  /**@type {Screen} */
  screen = null;
  /**@type {Toolkit} */
  toolkit = new Toolkit(this.config);
  /**@type {File} */
  file = null;
  #genApi(key) {
    return (...args) => {
      const message =
        args.length === 1 ? args[0] : args.join(this.config.joinChar);
      const time = this.toolkit.formatTime();
      this.screen[key](message, time);
      this.file[key](message, time);
    };
  }
  info = this.#genApi("info");
  warning = this.#genApi("warning");
  error = this.#genApi("error");
  success = this.#genApi("success");
  progress = (num, max) => {
    const timeheader = `[${this.toolkit.formatTime()}]`;
    let percent = Math.floor(100 * (num / max)) + "%" + "";
    percent = " ".repeat(4 - percent.length) + percent;
    const state = `${" ".repeat(
      max.toString().length - num.toString().length
    )}${num}/${max}`;
    const avaliableLength =
      process.stdout.columns -
      timeheader.length -
      6 -
      3 -
      state.length -
      1 -
      percent.length;
    const doneLength = Math.floor(avaliableLength * (num / max));
    if (avaliableLength <= 1) {
      process.stdout.write(
        `\r${timeheader}[${chalk.magenta("PROG")}] ${percent} ${state}`
      );
    } else {
      process.stdout.write(
        `\r${timeheader}[${chalk.magenta("PROG")}] [${"|".repeat(
          doneLength
        )}${" ".repeat(avaliableLength - doneLength)}]${percent} ${state}`
      );
    }
  };
  async exit(message) {
    const time = this.toolkit.formatTime();
    this.screen.exit(message, time);
    await this.file.writeLogToStream(`[${time}][EXIT]${message}\n`);
    this.exitListeners.forEach((listener) => listener());
    process.exit();
  }
  log(...args) {
    const message = args.join(this.config.joinChar);
    const time = this.toolkit.formatTime();
    const keywords = {
      success: /(success|ok|done|✓)/i,
      warning: /(warn|but|notice|see|problem)/i,
      error: /(error|fail|mistake|problem|fatal)/i,
    };

    for (let key in keywords) {
      if (keywords.hasOwnProperty(key)) {
        const regex = keywords[key];
        if (regex.test(message)) {
          this[key](message);
          return;
        }
      }
    }
    this.info(message);
  }
  onExit(callback) {
    this.exitListeners.push(callback);
  }
}

process.on("beforeExit", async () => {
  const rlog = new Rlog();
  if (rlog.file.logStream) {
    await new Promise((resolve) => {
      rlog.file.logStream.end(resolve);
    });
  }
});

module.exports = Rlog;
