import * as fs from "fs";
import * as pathModule from "path";
import { formatWithOptions } from "util";

/** Types that can be converted to string for logging */
type Tostringable = string | null | boolean | undefined | number | bigint | Date;

/** Top-level Rlog methods that write to both screen and file */
type RlogApiKey = 'info' | 'warning' | 'warn' | 'error' | 'success';

/** Top-level Rlog methods available for automatic level detection */
type AutoLogKey = 'success' | 'warning' | 'error';

/** Log template token compiled for fast rendering */
type LogTemplatePart =
  | { type: "literal"; value: string }
  | { type: "message" }
  | { type: "level" }
  | { type: "time"; format?: string };

/** Precompiled custom color rule for hot log formatting paths */
type CompiledColorRule = {
  regex: RegExp;
  colorize: (value: string) => string;
};

/** Available ANSI colors for string colorization */
type LogColor = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'gray';

type TimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  weekday: number;
  offsetMinutes: number;
};

/**
 * Custom color rule for string matching and colorization
 */
interface CustomColorRule {
  /** Regular expression pattern to match */
  reg: string;
  /** Color to apply to matched strings */
  color: LogColor;
}

/**
 * Configuration options for Rlog instance
 */
interface ConfigOptions {
  /** Enable colorful console output */
  enableColorfulOutput?: boolean;
  /** Path to log file. If undefined, logs won't be written to file */
  logFilePath?: string;
  /** Time format string (RLog token format) or 'timestamp', 'ISO', 'GMT', 'UTC' */
  timeFormat?: string;
  /** Timezone for time formatting (e.g., 'Asia/Shanghai') */
  timezone?: string;
  /** Log output template. Supports {time}, {time:FORMAT}, {level}, {type}, and {message} */
  logTemplate?: string;
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
  logTemplate: string = "[{time}][{level}] {message}";
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
    // Reserved for future config side effects.
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
  private _logTemplateCache?: LogTemplatePart[];
  private _logTemplateCacheKey?: string;
  private _colorRuleCache?: CompiledColorRule[];
  private _colorRuleCacheKey?: string;
  private _timeCacheKey?: string;
  private _timeCacheValue?: string | number;
  private static readonly ansiRegex = /\x1B\[[0-?]*[ -/]*[@-~]/g;
  private static readonly ansiColorSplitRegex = /(\u001b\[\d+m)/g;
  private static readonly ansiColorCodes: Record<LogColor, number> = {
    red: 31,
    green: 32,
    yellow: 33,
    blue: 34,
    magenta: 35,
    cyan: 36,
    gray: 90,
  };
  private static readonly intlFormatterCache = new Map<string, Intl.DateTimeFormat>();
  private static readonly monthNamesShort = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  private static readonly monthNamesLong = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  private static readonly weekdayNamesShort = [
    "Sun",
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
  ];
  private static readonly weekdayNamesLong = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  constructor(config: Config) {
    this.config = config;
  }

  colorText(str: string, color: LogColor): string {
    if (!this.config.enableColorfulOutput || !str) return str;
    const colorCode = Toolkit.ansiColorCodes[color];
    if (!colorCode) return str;
    const colorStart = `\u001b[${colorCode}m`;
    const colorEnd = "\u001b[39m";
    return colorStart + str.replace(/\u001b\[39m/g, colorEnd + colorStart) + colorEnd;
  }

  private padNumber(value: number, length: number = 2): string {
    return String(Math.abs(Math.trunc(value))).padStart(length, "0");
  }

  private normalizeTimezone(timezone?: string): string | undefined {
    if (!timezone) return undefined;
    if (timezone === "GMT") return "UTC";
    return timezone;
  }

  private getIntlFormatter(timezone: string): Intl.DateTimeFormat {
    let formatter = Toolkit.intlFormatterCache.get(timezone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      Toolkit.intlFormatterCache.set(timezone, formatter);
    }
    return formatter;
  }

  private getTimeParts(date: Date, timezone?: string): TimeParts {
    const normalizedTimezone = this.normalizeTimezone(timezone);

    if (!normalizedTimezone) {
      return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
        millisecond: date.getMilliseconds(),
        weekday: date.getDay(),
        offsetMinutes: -date.getTimezoneOffset(),
      };
    }

    try {
      const partMap: Record<string, string> = {};
      for (const part of this.getIntlFormatter(normalizedTimezone).formatToParts(date)) {
        if (part.type !== "literal") partMap[part.type] = part.value;
      }

      const year = Number(partMap.year);
      const month = Number(partMap.month);
      const day = Number(partMap.day);
      const hour = Number(partMap.hour);
      const minute = Number(partMap.minute);
      const second = Number(partMap.second);
      const millisecond = date.getMilliseconds();
      const asUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);

      return {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millisecond,
        weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
        offsetMinutes: Math.round((asUtc - date.valueOf()) / 60000),
      };
    } catch (err) {
      return this.getTimeParts(date);
    }
  }

  private formatOffset(offsetMinutes: number, colon: boolean): string {
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absoluteMinutes = Math.abs(offsetMinutes);
    const hours = this.padNumber(Math.floor(absoluteMinutes / 60));
    const minutes = this.padNumber(absoluteMinutes % 60);
    return colon ? `${sign}${hours}:${minutes}` : `${sign}${hours}${minutes}`;
  }

  private formatDate(date: Date, format: string, timezone?: string): string {
    const parts = this.getTimeParts(date, timezone);
    const hour12 = parts.hour % 12 || 12;
    const tokenValues: Record<string, string> = {
      YYYY: this.padNumber(parts.year, 4),
      YY: this.padNumber(parts.year % 100),
      MMMM: Toolkit.monthNamesLong[parts.month - 1],
      MMM: Toolkit.monthNamesShort[parts.month - 1],
      MM: this.padNumber(parts.month),
      M: String(parts.month),
      DD: this.padNumber(parts.day),
      D: String(parts.day),
      HH: this.padNumber(parts.hour),
      H: String(parts.hour),
      hh: this.padNumber(hour12),
      h: String(hour12),
      mm: this.padNumber(parts.minute),
      m: String(parts.minute),
      ss: this.padNumber(parts.second),
      s: String(parts.second),
      SSS: this.padNumber(parts.millisecond, 3),
      SS: this.padNumber(Math.floor(parts.millisecond / 10), 2),
      S: String(Math.floor(parts.millisecond / 100)),
      A: parts.hour < 12 ? "AM" : "PM",
      a: parts.hour < 12 ? "am" : "pm",
      dddd: Toolkit.weekdayNamesLong[parts.weekday],
      ddd: Toolkit.weekdayNamesShort[parts.weekday],
      dd: Toolkit.weekdayNamesShort[parts.weekday].slice(0, 2),
      d: String(parts.weekday),
      ZZ: this.formatOffset(parts.offsetMinutes, false),
      Z: this.formatOffset(parts.offsetMinutes, true),
    };

    return format.replace(
      /\[([^\]]*)\]|YYYY|MMMM|MMM|MM|M|DD|D|HH|H|hh|h|mm|m|ss|s|SSS|SS|S|A|a|dddd|ddd|dd|d|ZZ|Z/g,
      (match, literal: string | undefined) => {
        if (literal !== undefined) return literal;
        return tokenValues[match] ?? match;
      }
    );
  }

  /**
   * Ensure log file exists, create if necessary
   * @param path - Path to log file
   */
  async checkLogFile(path: string): Promise<void> {
    try {
      fs.mkdirSync(pathModule.dirname(path), { recursive: true });
      fs.closeSync(fs.openSync(path, "a"));
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
  private getCompiledColorRules(): CompiledColorRule[] {
    const rules = this.config.customColorRules;
    if (!rules?.length) return [];

    const cacheKey = rules
      .map(({ reg, color }) => `${color}\u0000${reg}`)
      .join("\u0001");

    if (this._colorRuleCache && this._colorRuleCacheKey === cacheKey) {
      return this._colorRuleCache;
    }

    this._colorRuleCache = rules
      .map(({ reg, color }) => {
        return {
          regex: new RegExp(reg, "g"),
          colorize: (value: string) => this.colorText(value, color),
        };
      })
      .filter((rule): rule is CompiledColorRule => rule !== null);
    this._colorRuleCacheKey = cacheKey;

    return this._colorRuleCache;
  }

  colorizeString(str: string): string {
    if (!str || typeof str !== "string") return str;
    const colorRules = this.getCompiledColorRules();
    if (!colorRules.length) return str;

    const parts = str.split(Toolkit.ansiColorSplitRegex);

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
      for (const { regex, colorize } of colorRules) {
        regex.lastIndex = 0;
        processedText = processedText.replace(regex, (match) => {
          const coloredMatch = colorize(match);
          Toolkit.ansiRegex.lastIndex = 0;
          const hasColor = Toolkit.ansiRegex.test(coloredMatch);
          Toolkit.ansiRegex.lastIndex = 0;
          if (!hasColor) return match;

          const restoreColor =
            currentColorState.length > 0
              ? currentColorState.join("")
              : "";

          return coloredMatch + restoreColor;
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
  formatTime(format?: string, time?: Tostringable): string | number | boolean | bigint | null {
    if (time !== undefined && time !== null && !(time instanceof Date)) {
      return time;
    }

    const sourceTime = time instanceof Date ? time : new Date();
    const timeFormat = format || this.config.timeFormat;
    const { timezone } = this.config;
    const timeValue = sourceTime.valueOf();

    if (timeFormat === "timestamp") {
      return timeValue;
    }

    const cacheKey = `${timeValue}\u0000${timeFormat}\u0000${timezone || ""}`;
    if (this._timeCacheKey === cacheKey && this._timeCacheValue !== undefined) {
      return this._timeCacheValue;
    }

    let formattedTime: string;

    switch (timeFormat) {
      case "ISO":
        formattedTime = sourceTime.toISOString();
        break;
      case "GMT":
        formattedTime = this.formatDate(sourceTime, "YYYY-MM-DDTHH:mm:ss.SSS", "UTC") + "Z";
        break;
      case "UTC":
        formattedTime = this.formatDate(sourceTime, "YYYY-MM-DDTHH:mm:ss[Z]", "UTC");
        break;
      default:
        formattedTime = this.formatDate(sourceTime, timeFormat, timezone);
    }

    this._timeCacheKey = cacheKey;
    this._timeCacheValue = formattedTime;

    return formattedTime;
  }

  private compileLogTemplate(template: string): LogTemplatePart[] {
    if (this._logTemplateCache && this._logTemplateCacheKey === template) {
      return this._logTemplateCache;
    }

    const parts: LogTemplatePart[] = [];
    const tokenRegex = /\{(message|level|type|time(?::([^}]+))?)\}/g;
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(template))) {
      if (match.index > cursor) {
        parts.push({ type: "literal", value: template.slice(cursor, match.index) });
      }

      const token = match[1];
      if (token === "message") {
        parts.push({ type: "message" });
      } else if (token === "level" || token === "type") {
        parts.push({ type: "level" });
      } else {
        parts.push({ type: "time", format: match[2] });
      }

      cursor = match.index + match[0].length;
    }

    if (cursor < template.length) {
      parts.push({ type: "literal", value: template.slice(cursor) });
    }

    this._logTemplateCache = parts;
    this._logTemplateCacheKey = template;

    return parts;
  }

  private stripAnsi(str: string): string {
    return str.replace(Toolkit.ansiRegex, "");
  }

  private isCombiningCodePoint(code: number): boolean {
    return (
      (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0x1ab0 && code <= 0x1aff) ||
      (code >= 0x1dc0 && code <= 0x1dff) ||
      (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0xfe20 && code <= 0xfe2f)
    );
  }

  private isFullWidthCodePoint(code: number): boolean {
    return (
      code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1f64f) ||
        (code >= 0x1f900 && code <= 0x1f9ff) ||
        (code >= 0x20000 && code <= 0x3fffd))
    );
  }

  private displayWidth(str: string): number {
    let width = 0;
    const clean = this.stripAnsi(str);

    for (const char of clean) {
      const code = char.codePointAt(0);
      if (code === undefined) continue;
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
      if (this.isCombiningCodePoint(code)) continue;
      width += this.isFullWidthCodePoint(code) ? 2 : 1;
    }

    return width;
  }

  private currentLineDisplayWidth(str: string): number {
    const lastLineBreak = str.lastIndexOf("\n");
    return this.displayWidth(
      lastLineBreak === -1 ? str : str.slice(lastLineBreak + 1)
    );
  }

  private formatTemplateTime(format: string | undefined, time?: Tostringable): string {
    return String(this.formatTime(format, time));
  }

  /**
   * Render a full log line from the configured template.
   * @param level - Log level label
   * @param message - Already formatted log message
   * @param time - Shared timestamp for screen/file output
   * @param colorizedLevel - Optional colored level label for screen output
   * @returns Rendered log line without trailing newline
   */
  formatLogMessage(
    level: string,
    message: string,
    time?: Tostringable,
    colorizedLevel?: string
  ): string {
    const parts = this.compileLogTemplate(this.config.logTemplate || "{message}");
    const renderedLevel = colorizedLevel || level;
    let output = "";
    let hasMessage = false;

    const appendMessage = () => {
      output += this.padLines(message, this.currentLineDisplayWidth(output));
      hasMessage = true;
    };

    for (const part of parts) {
      switch (part.type) {
        case "literal":
          output += part.value;
          break;
        case "level":
          output += renderedLevel;
          break;
        case "time":
          output += this.formatTemplateTime(part.format, time);
          break;
        case "message":
          appendMessage();
          break;
      }
    }

    if (!hasMessage) {
      appendMessage();
    }

    return output;
  }

  /**
   * Format logging arguments with the same argument semantics as Node.js console.log.
   * @param args - Values passed to a top-level Rlog API
   * @returns Console-compatible formatted message
   */
  formatConsoleArgs(args: any[], colors: boolean = false): string {
    return formatWithOptions({ colors }, ...args);
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
    const padding = " ".repeat(Math.max(0, width));

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
  private _formatMessage(type: string, color: LogColor, message: any, time?: Tostringable): string {
    const colorizedType = this.toolkit.colorText(type, color);
    const inspectedMessage =
      typeof message === "string"
        ? message
        : this.toolkit.formatConsoleArgs(
            [message],
            this.toolkit.config.enableColorfulOutput
          );

    const processedMessage = this.toolkit.colorizeString(
      this.toolkit.encryptPrivacyContent(inspectedMessage)
    );
    const coloredMessage =
      type === "SUCC" || type === "EXIT"
        ? this.toolkit.colorText(processedMessage, color)
        : processedMessage;

    return this.toolkit.formatLogMessage(type, coloredMessage, time, colorizedType) + "\n";
  }

  /**
   * Write log to stdout
   * @private
   */
  private _log(type: string, color: LogColor, message: any, time?: Tostringable): void {
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
    return this.toolkit.formatLogMessage(
      type,
      this.toolkit.encryptPrivacyContent(this.toolkit.stringify(message)),
      time
    );
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
  time: Tostringable;
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
  #writeFormatted(key: RlogApiKey, fileMessage: string, screenMessage: string = fileMessage): void {
    const time = new Date();
    this.file[key](fileMessage, time);
    this.screen[key](screenMessage, time);
  }

  /**
   * Generate unified logging API methods
   * @private
   */
  #genApi(key: RlogApiKey) {
    return (...args: any[]) => {
      this.#writeFormatted(
        key,
        this.toolkit.formatConsoleArgs(args),
        this.toolkit.formatConsoleArgs(args, this.config.enableColorfulOutput)
      );
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
    const progressLabel = this.toolkit.colorText("PROG", "magenta");

    if (availableLength <= 1) {
      process.stdout.write(
        `\r${timeheader}[${progressLabel}] ${paddedPercent} ${state}`
      );
    } else {
      const doneLength = Math.floor(availableLength * (num / max));
      process.stdout.write(
        `\r${timeheader}[${progressLabel}] [${"|".repeat(
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
    const time = new Date();
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
    const screenMessage = this.toolkit.formatConsoleArgs(
      args,
      this.config.enableColorfulOutput
    );
    for (const { key, regex } of this.keywordPatterns) {
      if (regex.test(message)) {
        this.#writeFormatted(key, message, screenMessage);
        return;
      }
    }
    this.#writeFormatted("info", message, screenMessage);
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
