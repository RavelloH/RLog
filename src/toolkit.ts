import { formatWithOptions, inspect } from "node:util";
import type { Config } from "./config";
import type { LogColor, LogMetadata } from "./types";

const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SPLIT = /(\u001b\[\d+m)/g;
const COLORS: Record<LogColor, number> = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 };
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export class Toolkit {
  constructor(readonly config: Config) {}

  colorText(value: string, color: LogColor): string {
    if (!this.config.enableColorfulOutput || !value) return value;
    const code = COLORS[color];
    return `\u001b[${code}m${value.replace(/\u001b\[39m/g, `\u001b[39m\u001b[${code}m`)}\u001b[39m`;
  }

  formatConsoleArgs(args: readonly unknown[], colors = false): string {
    return formatWithOptions({ colors }, ...args);
  }

  formatTime(format = this.config.timeFormat, time: Date = new Date()): string | number {
    if (format === "timestamp") return time.valueOf();
    if (format === "ISO") return time.toISOString();
    const zone = format === "GMT" || format === "UTC" ? "UTC" : this.config.timezone;
    if (format === "GMT") return `${this.formatDate(time, "YYYY-MM-DDTHH:mm:ss.SSS", zone)}Z`;
    if (format === "UTC") return this.formatDate(time, "YYYY-MM-DDTHH:mm:ss[Z]", zone);
    return this.formatDate(time, format, zone);
  }

  private formatDate(date: Date, format: string, timezone?: string): string {
    let year: number; let month: number; let day: number; let hour: number; let minute: number; let second: number; let weekday: number; let offset: number;
    if (timezone) {
      try {
        const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
        const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
        year = Number(values.year); month = Number(values.month); day = Number(values.day); hour = Number(values.hour); minute = Number(values.minute); second = Number(values.second);
        weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
        offset = Math.round((Date.UTC(year, month - 1, day, hour, minute, second, date.getMilliseconds()) - date.valueOf()) / 60000);
      } catch { return this.formatDate(date, format); }
    } else {
      year = date.getFullYear(); month = date.getMonth() + 1; day = date.getDate(); hour = date.getHours(); minute = date.getMinutes(); second = date.getSeconds(); weekday = date.getDay(); offset = -date.getTimezoneOffset();
    }
    const pad = (number: number, length = 2) => String(Math.abs(Math.trunc(number))).padStart(length, "0");
    const offsetText = (colon: boolean) => `${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}${colon ? ":" : ""}${pad(Math.abs(offset) % 60)}`;
    const values: Record<string, string> = {
      YYYY: pad(year, 4), YY: pad(year % 100), MMMM: MONTH_LONG[month - 1], MMM: MONTH_SHORT[month - 1], MM: pad(month), M: String(month), DD: pad(day), D: String(day), HH: pad(hour), H: String(hour), hh: pad(hour % 12 || 12), h: String(hour % 12 || 12), mm: pad(minute), m: String(minute), ss: pad(second), s: String(second), SSS: pad(date.getMilliseconds(), 3), SS: pad(Math.floor(date.getMilliseconds() / 10)), S: String(Math.floor(date.getMilliseconds() / 100)), A: hour < 12 ? "AM" : "PM", a: hour < 12 ? "am" : "pm", dddd: WEEKDAY_LONG[weekday], ddd: WEEKDAY_SHORT[weekday], dd: WEEKDAY_SHORT[weekday].slice(0, 2), d: String(weekday), Z: offsetText(true), ZZ: offsetText(false),
    };
    return format.replace(/\[([^\]]*)\]|YYYY|MMMM|MMM|MM|M|DD|D|HH|H|hh|h|mm|m|ss|s|SSS|SS|S|A|a|dddd|ddd|dd|d|ZZ|Z/g, (match, literal: string | undefined) => literal ?? values[match] ?? match);
  }

  formatLogMessage(level: string, message: string, time: Date, coloredLevel?: string): string {
    const template = this.config.logTemplate || "{message}";
    let includedMessage = false;
    const output = template.replace(/\{(message|level|type|time(?::([^}]+))?)\}/g, (_token, name: string, timeFormat: string | undefined) => {
      if (name === "message") { includedMessage = true; return this.padLines(message, this.displayWidthSoFar(template, _token)); }
      if (name === "level" || name === "type") return coloredLevel ?? level;
      return String(this.formatTime(timeFormat || this.config.timeFormat, time));
    });
    if (includedMessage) return output;
    return `${output}${this.padLines(message, this.displayWidth(output))}`;
  }

  private displayWidthSoFar(template: string, token: string): number {
    return this.displayWidth(template.slice(0, template.indexOf(token))
      .replace(/\{(level|type)\}/g, "INFO")
      .replace(/\{time(?::[^}]+)?\}/g, String(this.formatTime())));
  }

  padLines(value: string, width: number): string {
    if (!value.includes("\n")) return value;
    const padding = " ".repeat(Math.max(0, width));
    return value.split("\n").map((line, index) => index === 0 ? line : `${padding}${line}`).join("\n");
  }

  private displayWidth(value: string): number {
    const clean = value.replace(ANSI, "");
    let width = 0;
    for (const char of clean) {
      const code = char.codePointAt(0) ?? 0;
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x300 && code <= 0x36f)) continue;
      width += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || code >= 0xf900) ? 2 : 1;
    }
    return width;
  }

  encryptPrivacyContent(value: string): string {
    let output = value;
    for (const pattern of this.config.blockedWordsList) {
      let expression: RegExp;
      try { expression = new RegExp(pattern, "g"); }
      catch { expression = new RegExp(pattern.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g"); }
      output = output.replace(expression, (match) => "*".repeat(match.length));
    }
    return output;
  }

  colorizeString(value: string): string {
    if (!this.config.enableColorfulOutput || !value) return value;
    let result = value;
    for (const rule of this.config.customColorRules) {
      try { result = result.replace(new RegExp(rule.reg, "g"), (match) => this.colorText(match, rule.color)); }
      catch { /* invalid user rule is ignored until configuration is corrected */ }
    }
    return result;
  }

  redact(value: unknown): unknown {
    const keys = new Set(this.config.redactKeys.map((key) => key.toLowerCase()));
    const seen = new WeakSet<object>();
    const visit = (input: unknown, key?: string, depth = 0): unknown => {
      if (key && keys.has(key.toLowerCase())) return "[REDACTED]";
      if (depth > 32) return "[Truncated]";
      if (typeof input !== "object" || input === null) return input;
      if (seen.has(input)) return "[Circular]";
      seen.add(input);
      if (Array.isArray(input)) return input.map((item) => visit(item, undefined, depth + 1));
      if (input instanceof Date || input instanceof Error || Buffer.isBuffer(input)) return input;
      const result: LogMetadata = {};
      for (const [entryKey, entryValue] of Object.entries(input)) result[entryKey] = visit(entryValue, entryKey, depth + 1);
      return result;
    };
    return visit(value);
  }

  safeJson(value: unknown): unknown {
    const seen = new WeakSet<object>();
    const visit = (input: unknown, depth = 0): unknown => {
      if (depth > 32) return "[Truncated]";
      if (typeof input === "string") return this.encryptPrivacyContent(input);
      if (input === undefined) return "[undefined]";
      if (typeof input === "bigint") return `${input}n`;
      if (typeof input === "symbol") return input.toString();
      if (typeof input === "function") return `[Function ${(input as Function).name || "anonymous"}]`;
      if (input instanceof Date) return input.toISOString();
      if (input instanceof Error) {
        const extra = Object.fromEntries(Object.entries(input).map(([key, item]) => [key, visit(item, depth + 1)]));
        return { name: input.name, message: input.message, stack: input.stack, ...extra };
      }
      if (Buffer.isBuffer(input)) return { type: "Buffer", length: input.length, preview: input.subarray(0, 32).toString("hex") };
      if (typeof input !== "object" || input === null) return input;
      if (seen.has(input)) return "[Circular]";
      seen.add(input);
      if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, visit(item, depth + 1)]));
    };
    return visit(this.redact(value));
  }

  safeInspect(value: unknown): string {
    return this.encryptPrivacyContent(inspect(this.redact(value), { colors: false, depth: 8, breakLength: 120 }));
  }

  stripAnsi(value: string): string { return value.replace(ANSI, ""); }
  get ansiRegex(): RegExp { return ANSI; }
  get ansiSplitRegex(): RegExp { return ANSI_SPLIT; }
}
