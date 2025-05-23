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
  autoInit: true,
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
    if (!str || typeof str !== "string") return str;
    const ansiColorRegex = /(\u001b\[\d+m)/g;
    const parts = str.split(ansiColorRegex);

    let activeColorStack = [];
    const result = [];

    for (const part of parts) {
      if (part.startsWith("\u001b[")) {
        if (part === "\u001b[39m") {
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
        const regex = new RegExp(reg, "g");

        processedText = processedText.replace(regex, (match) => {
          const coloredMatch = chalk[color](match);
          const colorParts = coloredMatch.split(ansiColorRegex).filter(Boolean);
          const colorStart = colorParts[0];
          const matchText = colorParts
            .filter((p) => !p.startsWith("\u001b["))
            .join("");

          const restoreColor =
            currentColorState.length > 0
              ? currentColorState.join("")
              : "\u001b[39m";

          return colorStart + matchText + restoreColor;
        });
      }

      result.push(processedText);
    }

    return result.join("");
  }

  formatTime() {
    const now = moment();
    const { timeFormat, timezone } = this.config;

    if (timeFormat === "timestamp") {
      return now.valueOf();
    }

    if (timezone) {
      switch (timeFormat) {
        case "ISO":
          return now.tz(timezone).toISOString();
        case "GMT":
          return now.tz("GMT").format("YYYY-MM-DDTHH:mm:ss.SSS") + "Z";
        case "UTC":
          return now.utc().format();
        default:
          return now.tz(timezone).format(timeFormat);
      }
    }

    return now.format(timeFormat);
  }

  encryptPrivacyContent(str) {
    if (typeof str !== "string" || !this.config.blockedWordsList?.length) {
      return str;
    }
    if (!this._regexCache) {
      this._regexCache = this.config.blockedWordsList.map((pattern) => {
        try {
          return new RegExp(pattern, "g");
        } catch (e) {
          return new RegExp(
            pattern.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"),
            "g"
          );
        }
      });
    }
    return this._regexCache.reduce((result, regex, index) => {
      return result.replace(regex, (match) => {
        return "*".repeat(match.length);
      });
    }, str);
  }

  colorizeType(variable) {
    if (variable === null) return chalk.red("null");
    if (variable === undefined) return chalk.gray("undefined");

    const type = typeof variable;

    switch (type) {
      case "string":
        return variable;
      case "number":
        return chalk.blue(variable.toString());
      case "boolean":
        return variable ? chalk.green("true") : chalk.red("false");
      case "object":
        try {
          if (Array.isArray(variable)) {
            return chalk.yellow(JSON.stringify(variable, null, 2));
          }
          return chalk.magenta(JSON.stringify(variable, null, 2));
        } catch (e) {
          return chalk.red("[Circular Object]");
        }
      case "function":
        return chalk.cyan(variable.toString().split("\n")[0] + "...");
      case "symbol":
        return chalk.yellow(variable.toString());
      default:
        return String(variable);
    }
  }

  padLines(str, width) {
    if (!str) return "";

    str = String(str);

    if (!str.includes("\n")) return str;

    const lines = str.split("\n");
    const padding = " ".repeat(width);

    return (
      lines[0] +
      "\n" +
      lines
        .slice(1)
        .map((line) => padding + line)
        .join("\n")
    );
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
  _formatMessage(type, color, message, time) {
    const timeheader = `[${time || this.toolkit.formatTime()}]`;
    const colorizedType = chalk[color](type);

    const processedMessage = this.toolkit.encryptPrivacyContent(
      this.toolkit.padLines(
        type === "SUCC" || type === "EXIT"
          ? chalk[color](message)
          : this.toolkit.colorizeType(message),
        timeheader.length + 7
      )
    );

    return `${timeheader}[${colorizedType}] ${this.toolkit.colorizeString(
      processedMessage
    )}\n`;
  }
  _log(type, color, message, time) {
    process.stdout.write(this._formatMessage(type, color, message, time));
  }

  info(message, time) {
    this._log("INFO", "cyan", message, time);
  }

  warning(message, time) {
    this._log("WARN", "yellow", message, time);
  }

  error(message, time) {
    this._log("ERR!", "red", message, time);
  }

  success(message, time) {
    this._log("SUCC", "green", message, time);
  }

  exit(message, time) {
    this._log("EXIT", "red", message, time, true);
  }
}

class File {
  constructor(toolkit, config, screen) {
    this.toolkit = toolkit;
    this.config = config;
    this.screen = screen;
    if (this.config.autoInit) this.init();
  }
  /**@type {Toolkit} */
  toolkit = null;
  /**@type {Config} */
  config = null;
  /**@type {Screen} */
  screen = null;
  /**@type {fs.WriteStream} */
  logStream = null;

  init() {
    if (this.config.logFilePath && !this.logStream) {
      this.toolkit.checkLogFile(this.config.logFilePath);
      try {
        this.logStream = fs.createWriteStream(this.config.logFilePath, {
          flags: "a",
        });
        this.screen.info(
          "The log will be written to " + this.config.logFilePath
        );
        this.logStream.on("error", (err) => {
          this.exit("Error writing to log file: " + err);
        });
        this.logStream.on("finish", () => {
          this.screen.info("Log stream closed.");
        });
      } catch (err) {
        this.exit("Error creating log stream: " + err);
      }
    }
  }

  _formatMessage(type, message, time) {
    return `[${
      time || this.toolkit.formatTime()
    }][${type}] ${this.toolkit.encryptPrivacyContent(
      this.toolkit.stringify(message)
    )}`;
  }

  _log(type, message, time) {
    if (!this.config.logFilePath) return;

    if (!this.logStream) {
      this.screen.warning(
        "RLog not initialized, automatic init in progress..."
      );
      this.init();
    }

    this.writeLogToStream(this._formatMessage(type, message, time) + "\n");
  }

  writeLogToStream(text) {
    return new Promise((resolve, reject) => {
      if (this.logStream) {
        this.logStream.write(text, (err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        reject(new Error("Log stream not initialized"));
      }
    });
  }

  info(message, time) {
    this._log("INFO", message, time);
  }

  warning(message, time) {
    this._log("WARNING", message, time);
  }

  error(message, time) {
    this._log("ERROR", message, time);
  }

  success(message, time) {
    this._log("SUCCESS", message, time);
  }

  exit(message, time) {
    this._log("EXIT", message, time);
  }
}

class Rlog {
  static Config = Config;
  static Toolkit = Toolkit;
  static Screen = Screen;
  static File = File;

  /**
   * @param {Object} config - Configuration options for the logger
   */
  constructor(config) {
    this.config = new Config();
    this.config.setConfig(config || {});
    this.toolkit = new Toolkit(this.config);
    this.screen = new Screen(this.toolkit);
    this.toolkit.screen = this.screen;
    this.file = new File(this.toolkit, this.config, this.screen);
    this.exitListeners = [];

    // Pre-compile regex patterns for better performance
    this.keywordPatterns = {
      success: /(success|ok|done|✓)/i,
      warning: /(warn|but|notice|see|problem)/i,
      error: /(error|fail|mistake|problem|fatal)/i,
    };
  }

  /**
   * Creates logging methods that output to both screen and file
   * @private
   */
  #genApi(key) {
    return (...args) => {
      const message =
        args.length === 1 ? args[0] : args.join(this.config.joinChar);
      const time = this.toolkit.formatTime();
      this.file[key](message, time);
      this.screen[key](message, time);
    };
  }

  // Define logging methods
  info = this.#genApi("info");
  warning = this.#genApi("warning");
  error = this.#genApi("error");
  success = this.#genApi("success");

  /**
   * Display a progress bar in the console
   * @param {number} num - Current progress value
   * @param {number} max - Maximum progress value
   */
  progress(num, max) {
    const timeheader = `[${this.toolkit.formatTime()}]`;
    const percent = Math.floor(100 * (num / max)) + "%";
    const paddedPercent = " ".repeat(4 - percent.length) + percent;

    const numStr = num.toString();
    const maxStr = max.toString();
    const state = `${" ".repeat(
      maxStr.length - numStr.length
    )}${numStr}/${maxStr}`;

    const availableLength =
      process.stdout.columns -
      timeheader.length -
      6 -
      3 -
      state.length -
      1 -
      paddedPercent.length;

    if (availableLength <= 1) {
      process.stdout.write(
        `\r${timeheader}[${chalk.magenta("PROG")}] ${paddedPercent} ${state}`
      );
    } else {
      const doneLength = Math.floor(availableLength * (num / max));
      process.stdout.write(
        `\r${timeheader}[${chalk.magenta("PROG")}] [${"|".repeat(
          doneLength
        )}${" ".repeat(availableLength - doneLength)}]${paddedPercent} ${state}`
      );
    }
  }

  /**
   * Exit the program with a message
   * @param {string} message - Exit message
   */
  exit(message) {
    const time = this.toolkit.formatTime();
    this.screen.exit(message, time);
    const ExitError = new Error("RLog_EXIT_PROCESS");
    ExitError.isRLogExit = true;
    ExitError.message = message;
    ExitError.time = time;
    global.__RLOG_EXIT_CONTEXT = {
      file: this.file,
      exitListeners: this.exitListeners,
    };
    throw ExitError;
  }

  /**
   * Smart logging function that determines log level based on content
   */
  log(...args) {
    const message = args.join(this.config.joinChar);

    // Check for specific patterns to determine log level
    for (const [key, regex] of Object.entries(this.keywordPatterns)) {
      if (regex.test(message)) {
        this[key](message);
        return;
      }
    }

    // Default to info level
    this.info(message);
  }

  /**
   * Register a function to be called before program exit
   * @param {Function} callback - Function to call on exit
   */
  onExit(callback) {
    if (typeof callback === "function") {
      this.exitListeners.push(callback);
    }
  }
}

process.on("uncaughtException", async (err) => {
  if (err.isRLogExit && global.__RLOG_EXIT_CONTEXT) {
    const { file, exitListeners } = global.__RLOG_EXIT_CONTEXT;

    try {
      if (file.logStream) {
        file.exit(err.message, err.time);
        if (typeof file.logStream.flush === "function") {
          file.logStream.flush();
        }
        await new Promise((resolve, reject) => {
          file.logStream.on("finish", resolve);
          file.logStream.on("error", reject);
          file.logStream.end();
        });
      }
      await Promise.all(
        exitListeners.map((listener) => {
          try {
            return Promise.resolve(listener());
          } catch (e) {
            return Promise.resolve();
          }
        })
      );
    } catch (e) {
      console.error("Error during log finalization:", e);
    } finally {
      global.__RLOG_EXIT_CONTEXT = null;
      process.exit(0);
    }
  } else {
    console.error("Uncaught exception:", err);
    process.exit(1);
  }
});

process.on("beforeExit", async () => {
  const ctx = global.__RLOG_EXIT_CONTEXT;
  if (ctx?.file?.logStream) {
    const stream = ctx.file.logStream;
    await new Promise((resolve) => {
      stream.once("finish", resolve);
      stream.end();
    });
  }
});

module.exports = Rlog;
