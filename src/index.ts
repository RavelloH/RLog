import chalk from "chalk";
import * as fs from "fs-extra";
import moment from "moment";
import "moment-timezone";
import { formatWithOptions } from "util";

/** Types that can be converted to string for logging */
type Tostringable = string | null | boolean | undefined | number | bigint;

/** Top-level Rlog methods that write to both screen and file */
type RlogApiKey = 'info' | 'warning' | 'warn' | 'error' | 'success';

/** Top-level Rlog methods available for automatic level detection */
type AutoLogKey = 'success' | 'warning' | 'error';

/** Available chalk colors for string colorization */
type ChalkColor = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'gray';

/**
 * Custom color rule for string matching and colorization
 */
interface CustomColorRule {
  /** Regular expression pattern to match */
  reg: string;
  /** Color to apply to matched strings */
  color: ChalkColor;
}

/**
 * Configuration options for Rlog instance
 */
interface ConfigOptions {
  /** Enable colorful console output */
  enableColorfulOutput?: boolean;
  /** Path to log file. If undefined, logs won't be written to file */
  logFilePath?: string;
  /** Time format string (moment.js format) or 'timestamp', 'ISO', 'GMT', 'UTC' */
  timeFormat?: string;
  /** Timezone for time formatting (e.g., 'Asia/Shanghai') */
  timezone?: string;
  /** List of patterns (regex or string) to mask in logs */
  blockedWordsList?: string[];
  /** Maximum width for screen output */
  screenLength?: number;
  /** Automatically initialize log file on instance creation */
  autoInit?: boolean;
  /** Suppress automatic log messages (e.g., file initialization) */
  silent?: boolean;
  /** Custom rules for colorizing matched strings */
  customColorRules?: CustomColorRule[];
}

/**
 * Configuration class for Rlog
 * Manages all logging behavior settings
 */
class Config {
  private static globalDefaults: Partial<Config> = {};
  private static instances: Set<Config> = new Set();

  enableColorfulOutput: boolean = true;
  logFilePath?: string = undefined;
  timeFormat: string = "YYYY-MM-DD HH:mm:ss.SSS";
  timezone?: string = undefined;
  blockedWordsList: string[] = [];
  screenLength: number = process.stdout.columns || 80;
  autoInit: boolean = true;
  silent: boolean = false;
  customColorRules: CustomColorRule[] = [
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
  ];

  constructor() {
    Config.instances.add(this);
    this.setConfig(Config.globalDefaults);
  }

  private applyRuntimeSideEffects(): void {
    if (!this.enableColorfulOutput) {
      chalk.level = 0;
    }
  }

  /**
   * Update configuration for this instance only
   * @param obj - Partial configuration object
   * @example
   * ```typescript
   * rlog.config.setConfig({
   *   timezone: 'Asia/Shanghai',
   *   silent: true
   * });
   * ```
   */
  setConfig(obj?: Partial<Config>): void {
    if (!obj) return;
    let changed = false;

    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        (this as any)[key] = obj[key as keyof Config];
        changed = true;
      }
    }

    if (changed) this.applyRuntimeSideEffects();
  }

  /**
   * Update configuration globally for all instances
   * Changes active instances and defaults for future instances in this process
   * @param obj - Partial configuration object
   * @example
   * ```typescript
   * rlog.config.setConfigGlobal({
   *   blockedWordsList: ['password', 'secret']
   * });
   * ```
   */
  setConfigGlobal(obj?: Partial<Config>): void {
    if (!obj) return;

    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        const value = obj[key as keyof Config];
        (Config.globalDefaults as any)[key] = value;
      }
    }

    for (const instance of Config.instances) {
      instance.setConfig(obj);
    }
  }
}

/**
 * Toolkit class providing utility functions for log formatting
 */
class Toolkit {
  config: Config;
  screen!: Screen;
  private _regexCache?: RegExp[];
  private _regexCacheKey?: string;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Ensure log file exists, create if necessary
   * @param path - Path to log file
   */
  async checkLogFile(path: string): Promise<void> {
    try {
      fs.ensureFileSync(path);
      await fs.promises.access(path, fs.constants.F_OK);
    } catch (err) {
      try {
        await fs.promises.writeFile(path, "");
      } catch (err) {
        this.screen.error("Could not create file, error: " + err);
      }
    }
  }

  /**
   * Apply custom color rules to colorize matched patterns in string
   * Preserves existing ANSI color codes
   * @param str - String to colorize
   * @returns Colorized string with ANSI codes
   */
  colorizeString(str: string): string {
    if (!str || typeof str !== "string") return str;
    const ansiColorRegex = /(\u001b\[\d+m)/g;
    const parts = str.split(ansiColorRegex);

    let activeColorStack: string[] = [];
    const result: string[] = [];

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
          const chalkFn = chalk[color];
          if (typeof chalkFn !== 'function') {
            return match;
          }
          const coloredMatch = chalkFn(match);
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

  /**
   * Format current time according to config
   * @returns Formatted time string or timestamp number
   * @example
   * ```typescript
   * formatTime() // "2025-12-18 10:30:00.123"
   * // With timeFormat: 'timestamp'
   * formatTime() // 1734501000123
   * ```
   */
  formatTime(): string | number {
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

  /**
   * Format logging arguments with the same argument semantics as Node.js console.log.
   * @param args - Values passed to a top-level Rlog API
   * @returns Console-compatible formatted message
   */
  formatConsoleArgs(args: any[]): string {
    return formatWithOptions({ colors: false }, ...args);
  }

  /**
   * Mask sensitive content in string using blocked words list
   * Supports both literal strings and regex patterns
   * @param str - String to process
   * @returns String with sensitive content replaced by asterisks
   * @example
   * ```typescript
   * // With blockedWordsList: ['password', '[0-9]{9}']
   * encryptPrivacyContent('password: 123456789')
   * // Returns: "********: *********"
   * ```
   */
  encryptPrivacyContent(str: string): string {
    if (typeof str !== "string" || !this.config.blockedWordsList?.length) {
      return str;
    }
    const regexCacheKey = this.config.blockedWordsList.join("\u0000");

    if (!this._regexCache || this._regexCacheKey !== regexCacheKey) {
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
      this._regexCacheKey = regexCacheKey;
    }
    return this._regexCache.reduce((result, regex) => {
      return result.replace(regex, (match) => {
        return "*".repeat(match.length);
      });
    }, str);
  }

  /**
   * Colorize variable based on its type
   * @param variable - Variable to colorize
   * @returns Colored string representation
   */
  colorizeType(variable: any): string {
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

  /**
   * Add padding to multi-line strings (indent lines after first)
   * @param str - String to pad
   * @param width - Number of spaces to add
   * @returns Padded string
   */
  padLines(str: string, width: number): string {
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

  /**
   * Convert any object to string representation
   * @param obj - Object to stringify
   * @returns String representation
   */
  stringify(obj: any): string {
    if (typeof obj === "string") {
      return obj;
    }
    if (typeof obj === "object") {
      return JSON.stringify(obj, null, 2);
    }
    return obj.toString();
  }
}

/**
 * Screen class for console output
 * Handles all terminal/stdout logging with colors and formatting
 */
class Screen {
  toolkit: Toolkit;

  constructor(toolkit: Toolkit) {
    this.toolkit = toolkit;
  }

  /**
   * Format a log message with timestamp and type
   * @private
   */
  private _formatMessage(type: string, color: ChalkColor, message: any, time?: Tostringable): string {
    const timeheader = `[${time || this.toolkit.formatTime()}]`;
    const chalkFn = chalk[color];
    const colorizedType = typeof chalkFn === 'function' ? chalkFn(type) : type;

    const processedMessage = this.toolkit.encryptPrivacyContent(
      this.toolkit.padLines(
        type === "SUCC" || type === "EXIT"
          ? (typeof chalkFn === 'function' ? chalkFn(message) : message)
          : this.toolkit.colorizeType(message),
        timeheader.length + 7
      )
    );

    return `${timeheader}[${colorizedType}] ${this.toolkit.colorizeString(
      processedMessage
    )}\n`;
  }

  /**
   * Write log to stdout
   * @private
   */
  private _log(type: string, color: ChalkColor, message: any, time?: Tostringable): void {
    process.stdout.write(this._formatMessage(type, color, message, time));
  }

  /**
   * Log an information message to console
   * @param message - Message to log
   * @param time - Optional custom timestamp
   */
  info(message: any, time?: Tostringable): void {
    this._log("INFO", "cyan", message, time);
  }

  /**
   * Log a warning message to console
   * @param message - Message to log
   * @param time - Optional custom timestamp
   */
  warning(message: any, time?: Tostringable): void {
    this._log("WARN", "yellow", message, time);
  }

  /**
   * Log a warning message to console (alias for warning)
   * @param message - Message to log
   * @param time - Optional custom timestamp
   */
  warn(message: any, time?: Tostringable): void {
    this._log("WARN", "yellow", message, time);
  }

  /**
   * Log an error message to console
   * @param message - Message to log
   * @param time - Optional custom timestamp
   */
  error(message: any, time?: Tostringable): void {
    this._log("ERR!", "red", message, time);
  }

  /**
   * Log a success message to console
   * @param message - Message to log
   * @param time - Optional custom timestamp
   */
  success(message: any, time?: Tostringable): void {
    this._log("SUCC", "green", message, time);
  }

  /**
   * Log an exit message to console
   * @param message - Message to log
   * @param time - Optional custom timestamp
   */
  exit(message: any, time?: Tostringable): void {
    this._log("EXIT", "red", message, time);
  }
}

/**
 * File class for writing logs to file system
 * Manages log file stream and async writes
 */
class File {
  toolkit: Toolkit;
  config: Config;
  screen: Screen;
  /** Write stream for log file */
  logStream: fs.WriteStream | null = null;

  constructor(toolkit: Toolkit, config: Config, screen: Screen) {
    this.toolkit = toolkit;
    this.config = config;
    this.screen = screen;
    if (this.config.autoInit) this.init();
  }

  /**
   * Initialize log file and create write stream
   * Called automatically if autoInit is true
   */
  init(): void {
    if (this.config.logFilePath && !this.logStream) {
      this.toolkit.checkLogFile(this.config.logFilePath);
      try {
        this.logStream = fs.createWriteStream(this.config.logFilePath, {
          flags: "a",
        });
        if (!this.config.silent)
          this.screen.info(
            "The log will be written to " + this.config.logFilePath
          );
        this.logStream.on("error", (err) => {
          this.exit("Error writing to log file: " + err);
        });
      } catch (err) {
        this.exit("Error creating log stream: " + err);
      }
    }
  }

  /**
   * Format message for file output (without colors)
   * @private
   */
  private _formatMessage(type: string, message: any, time?: Tostringable): string {
    return `[${time || this.toolkit.formatTime()
      }][${type}] ${this.toolkit.encryptPrivacyContent(
        this.toolkit.stringify(message)
      )}`;
  }

  /**
   * Write log to file
   * @private
   */
  private _log(type: string, message: any, time?: Tostringable): void {
    if (!this.config.logFilePath) return;

    if (!this.logStream) {
      if (!this.config.silent)
        this.screen.warning(
          "RLog not initialized, automatic init in progress..."
        );
      this.init();
    }

    this.writeLogToStream(this._formatMessage(type, message, time) + "\n");
  }

  /**
   * Write text to log stream asynchronously
   * @param text - Text to write
   * @returns Promise that resolves when write completes
   */
  writeLogToStream(text: string): Promise<void> {
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

  /**
   * Write an information log to file
   * @param message - Message to log
   * @param time - Optional custom timestamp
   */
  info(message: any, time?: Tostringable): void {
    this._log("INFO", message, time);
  }

  /**
   * Write a warning log to file
   * @param message - Message to log
   * @param time - Optional custom timestamp
   */
  warning(message: any, time?: Tostringable): void {
    this._log("WARN", message, time);
  }

  /**
   * Write a warning log to file (alias for warning)
   * @param message - Message to log
   * @param time - Optional custom timestamp
   */
  warn(message: any, time?: Tostringable): void {
    this._log("WARN", message, time);
  }

  /**
   * Write an error log to file
   * @param message - Message to log
   * @param time - Optional custom timestamp
   */
  error(message: any, time?: Tostringable): void {
    this._log("ERROR", message, time);
  }

  /**
   * Write a success log to file
   * @param message - Message to log
   * @param time - Optional custom timestamp
   */
  success(message: any, time?: Tostringable): void {
    this._log("SUCCESS", message, time);
  }

  /**
   * Write an exit log to file
   * @param message - Message to log
   * @param time - Optional custom timestamp
   */
  exit(message: any, time?: Tostringable): void {
    this._log("EXIT", message, time);
  }
}

/**
 * RLog exit error interface
 * Special error type for handling rlog.exit() calls
 */
export interface RLogExitError extends Error {
  isRLogExit: boolean;
  message: string;
  time: string | number;
}

/**
 * Global context for exit handling
 */
export interface RLogExitContext {
  file: File;
  exitListeners: (() => void | Promise<void>)[];
}

// 使用 globalThis 避免类型声明冲突
if (typeof globalThis !== 'undefined') {
  (globalThis as any).__RLOG_EXIT_CONTEXT = null;
}

/**
 * Main Rlog class
 * A comprehensive logging library for Node.js with TypeScript support
 *
 * @example
 * ```typescript
 * import Rlog from 'rlog-js';
 *
 * const rlog = new Rlog({
 *   logFilePath: './logs.txt',
 *   timezone: 'Asia/Shanghai',
 *   enableColorfulOutput: true
 * });
 *
 * rlog.info('Application started');
 * rlog.warn('Warning message');
 * rlog.error('Error occurred');
 * rlog.success('Operation completed');
 * ```
 */
class Rlog {
  static Config = Config;
  static Toolkit = Toolkit;
  static Screen = Screen;
  static File = File;

  /** Configuration instance */
  config: Config;
  /** Toolkit utilities */
  toolkit: Toolkit;
  /** Screen logger */
  screen: Screen;
  /** File logger */
  file: File;
  /** Exit event listeners */
  exitListeners: (() => void | Promise<void>)[];
  /** Keyword patterns for auto log level detection */
  private keywordPatterns: { key: AutoLogKey; regex: RegExp }[];

  /**
   * Create a new Rlog instance
   * @param config - Optional configuration object
   */
  constructor(config?: ConfigOptions) {
    this.config = new Config();
    this.config.setConfig(config || {});
    this.toolkit = new Toolkit(this.config);
    this.screen = new Screen(this.toolkit);
    this.toolkit.screen = this.screen;
    this.file = new File(this.toolkit, this.config, this.screen);
    this.exitListeners = [];

    this.keywordPatterns = [
      { key: "success", regex: /(success|ok|done|✓)/i },
      { key: "warning", regex: /(warn|but|notice|see|problem)/i },
      { key: "error", regex: /(error|fail|mistake|problem|fatal)/i },
    ];
  }

  /**
   * Write an already formatted message through the selected top-level API.
   * @private
   */
  #writeFormatted(key: RlogApiKey, message: string): void {
    const time = this.toolkit.formatTime();
    this.file[key](message, time);
    this.screen[key](message, time);
  }

  /**
   * Generate unified logging API methods
   * @private
   */
  #genApi(key: RlogApiKey) {
    return (...args: any[]) => {
      this.#writeFormatted(key, this.toolkit.formatConsoleArgs(args));
    };
  }

  /**
   * Log an information message
   * Outputs to both screen and file
   * @param args - Messages to log
   */
  info = this.#genApi("info");

  /**
   * Log a warning message
   * Outputs to both screen and file
   * @param args - Messages to log
   */
  warning = this.#genApi("warning");

  /**
   * Log a warning message (alias for warning)
   * Outputs to both screen and file
   * @param args - Messages to log
   */
  warn = this.#genApi("warn");

  /**
   * Log an error message
   * Outputs to both screen and file
   * @param args - Messages to log
   */
  error = this.#genApi("error");

  /**
   * Log a success message
   * Outputs to both screen and file
   * @param args - Messages to log
   */
  success = this.#genApi("success");

  /**
   * Display a progress bar in the console
   * @param num - Current progress value
   * @param max - Maximum progress value
   * @example
   * ```typescript
   * for (let i = 0; i <= 100; i++) {
   *   rlog.progress(i, 100);
   *   await sleep(10);
   * }
   * ```
   */
  progress(num: number, max: number): void {
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
   * Exit the program safely
   * Ensures all logs are written before terminating
   * @param message - Exit message
   * @throws {RLogExitError} Special error that triggers exit handler
   * @example
   * ```typescript
   * if (criticalError) {
   *   rlog.exit('Critical error occurred');
   * }
   * ```
   */
  exit(message: any): never {
    const time = this.toolkit.formatTime();
    this.screen.exit(message, time);
    const ExitError = new Error("RLog_EXIT_PROCESS") as RLogExitError;
    ExitError.isRLogExit = true;
    ExitError.message = message;
    ExitError.time = time;
    (globalThis as any).__RLOG_EXIT_CONTEXT = {
      file: this.file,
      exitListeners: this.exitListeners,
    };
    throw ExitError;
  }

  /**
   * Smart logging function that automatically determines log level
   * Analyzes message content and routes to appropriate log method
   * @param args - Messages to log
   * @example
   * ```typescript
   * rlog.log('Operation successful');  // -> success
   * rlog.log('Warning: disk space low');  // -> warning
   * rlog.log('Error occurred');  // -> error
   * rlog.log('Processing...');  // -> info
   * ```
   */
  log(...args: any[]): void {
    const message = this.toolkit.formatConsoleArgs(args);
    for (const { key, regex } of this.keywordPatterns) {
      if (regex.test(message)) {
        this.#writeFormatted(key, message);
        return;
      }
    }
    this.#writeFormatted("info", message);
  }

  /**
   * Register a callback to be executed before program exit
   * Useful for cleanup operations, saving state, etc.
   * @param callback - Function to call on exit
   * @example
   * ```typescript
   * rlog.onExit(async () => {
   *   await db.close();
   *   console.log('Database closed');
   * });
   * ```
   */
  onExit(callback: () => void | Promise<void>): void {
    if (typeof callback === "function") {
      this.exitListeners.push(callback);
    }
  }
}

process.on("uncaughtException", async (err: Error) => {
  const rlogErr = err as RLogExitError;
  if (rlogErr.isRLogExit && (globalThis as any).__RLOG_EXIT_CONTEXT) {
    const { file, exitListeners } = (globalThis as any).__RLOG_EXIT_CONTEXT;

    try {
      file.exit(rlogErr.message, rlogErr.time);
      await Promise.all(
        exitListeners.map((listener: () => void | Promise<void>) => {
          try {
            return Promise.resolve(listener());
          } catch (e) {
            return Promise.resolve();
          }
        })
      );

      if (file.logStream) {
        if (typeof (file.logStream as any).flush === "function") {
          (file.logStream as any).flush();
        }
        await new Promise<void>((resolve, reject) => {
          file.logStream!.once("finish", resolve);
          file.logStream!.once("error", reject);
          file.logStream!.end();
        });
      }
    } catch (e) {
      console.error("Error during log finalization:", e);
    } finally {
      (globalThis as any).__RLOG_EXIT_CONTEXT = null;
      process.exit(0);
    }
  } else {
    console.error("Uncaught exception:", err);
    process.exit(1);
  }
});

process.on("beforeExit", async () => {
  const ctx = (globalThis as any).__RLOG_EXIT_CONTEXT;
  if (ctx?.file?.logStream) {
    const stream = ctx.file.logStream;
    await new Promise<void>((resolve) => {
      stream.once("finish", resolve);
      stream.end();
    });
  }
});

export default Rlog;
module.exports = Rlog;
module.exports.default = Rlog;
