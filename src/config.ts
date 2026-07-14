import { normalizeLevel, parseArgvLevel } from "./levels";
import type { ConfigOptions, CustomColorRule, FileErrorPolicy, LogLevel, LogMetadata, MetadataOutputMode, RotationOptions, ScreenOutput } from "./types";

const defaultRules: CustomColorRule[] = [
  { reg: "false", color: "red" }, { reg: "true", color: "green" },
  { reg: "((2(5[0-5]|[0-4]\\d))|[0-1]?\\d{1,2})(\\.((2(5[0-5]|[0-4]\\d))|[0-1]?\\d{1,2})){3}", color: "cyan" },
  { reg: "[a-zA-z]+://[^\\s]*", color: "cyan" }, { reg: "\\d{4}-\\d{1,2}-\\d{1,2}", color: "green" },
  { reg: "\\w+([-+.]\\w+)*@\\w+([-.]\\w+)*\\.\\w+([-.]\\w+)*", color: "cyan" },
];

export class Config {
  private static readonly instances = new Set<Config>();
  private static globalDefaults: ConfigOptions = {};
  enableColorfulOutput = true;
  logFilePath: string | undefined;
  timeFormat = "YYYY-MM-DD HH:mm:ss.SSS";
  timezone: string | undefined;
  logTemplate = "[{time}][{level}] {message}";
  blockedWordsList: string[] = [];
  screenLength = process.stdout.columns || 80;
  autoInit = true;
  silent = false;
  customColorRules: CustomColorRule[] = defaultRules.map((rule) => ({ ...rule }));
  logLevel: LogLevel = "info";
  screenLogLevel: LogLevel | undefined;
  fileLogLevel: LogLevel | undefined;
  jsonlLogLevel: LogLevel | undefined;
  screenOutput: ScreenOutput = "stdout";
  jsonlFilePath: string | undefined;
  textRotation: RotationOptions | false = false;
  jsonlRotation: RotationOptions | false = false;
  context: LogMetadata = {};
  screenMetadataOutput: MetadataOutputMode = "none";
  fileMetadataOutput: MetadataOutputMode = "block";
  redactKeys: string[] = [];
  readLogLevelFromArgv = false;
  readLogLevelFromEnv = false;
  logLevelArgumentName = "--log-level";
  logLevelEnvironmentName = "RLOG_LEVEL";
  fileErrorPolicy: FileErrorPolicy = "throw";
  onFileError: ((error: Error, context: import("./types").FileErrorContext) => void) | undefined;
  exitListenerTimeoutMs = 5000;
  exitCloseTimeoutMs = 5000;

  constructor(options?: ConfigOptions) {
    Config.instances.add(this);
    this.setConfig(Config.globalDefaults);
    this.setConfig(options);
  }

  setConfig(options?: ConfigOptions): void {
    if (!options) return;
    const next = { ...options };
    if (next.screenOutput !== undefined && typeof next.screenOutput === "string" && !["stdout", "stderr", "none"].includes(next.screenOutput)) throw new Error(`Invalid screenOutput: ${next.screenOutput}`);
    if (next.screenOutput !== undefined && typeof next.screenOutput !== "string" && typeof next.screenOutput.write !== "function") throw new Error("screenOutput must be stdout, stderr, none, or a Writable stream");
    if (next.screenMetadataOutput !== undefined && !["none", "inline", "block"].includes(next.screenMetadataOutput)) throw new Error(`Invalid screenMetadataOutput: ${next.screenMetadataOutput}`);
    if (next.fileMetadataOutput !== undefined && !["none", "inline", "block"].includes(next.fileMetadataOutput)) throw new Error(`Invalid fileMetadataOutput: ${next.fileMetadataOutput}`);
    if (next.fileErrorPolicy !== undefined && !["throw", "disable", "stderr", "ignore"].includes(next.fileErrorPolicy)) throw new Error(`Invalid fileErrorPolicy: ${next.fileErrorPolicy}`);
    if (next.textRotation !== undefined) this.validateRotation(next.textRotation, "textRotation");
    if (next.jsonlRotation !== undefined) this.validateRotation(next.jsonlRotation, "jsonlRotation");
    if (next.exitListenerTimeoutMs !== undefined && (!Number.isFinite(next.exitListenerTimeoutMs) || next.exitListenerTimeoutMs < 0)) throw new Error("exitListenerTimeoutMs must be a non-negative finite number");
    if (next.exitCloseTimeoutMs !== undefined && (!Number.isFinite(next.exitCloseTimeoutMs) || next.exitCloseTimeoutMs < 0)) throw new Error("exitCloseTimeoutMs must be a non-negative finite number");
    if (next.logLevel !== undefined) this.logLevel = normalizeLevel(next.logLevel);
    if (next.screenLogLevel !== undefined) this.screenLogLevel = normalizeLevel(next.screenLogLevel);
    if (next.fileLogLevel !== undefined) this.fileLogLevel = normalizeLevel(next.fileLogLevel);
    if (next.jsonlLogLevel !== undefined) this.jsonlLogLevel = normalizeLevel(next.jsonlLogLevel);
    if (next.screenOutput !== undefined) this.screenOutput = next.screenOutput;
    if (next.context !== undefined) this.context = { ...next.context };
    for (const [key, value] of Object.entries(next) as Array<[keyof ConfigOptions, ConfigOptions[keyof ConfigOptions]]>) {
      if (["logLevel", "screenLogLevel", "fileLogLevel", "jsonlLogLevel", "screenOutput", "context"].includes(key)) continue;
      if (value !== undefined) Reflect.set(this, key, key === "textRotation" || key === "jsonlRotation" ? (value === false ? false : { ...(value as RotationOptions) }) : value);
    }
  }

  setConfigGlobal(options?: ConfigOptions): void {
    if (!options) return;
    Config.globalDefaults = { ...Config.globalDefaults, ...options };
    for (const instance of Config.instances) instance.setConfig(options);
  }

  effectiveLevel(target: "screen" | "file" | "jsonl"): LogLevel {
    const explicit = target === "screen" ? this.screenLogLevel : target === "file" ? this.fileLogLevel : this.jsonlLogLevel;
    if (explicit) return explicit;
    const argv = this.readLogLevelFromArgv ? parseArgvLevel(process.argv.slice(2), this.logLevelArgumentName) : undefined;
    const environment = this.readLogLevelFromEnv ? process.env[this.logLevelEnvironmentName] : undefined;
    return argv ?? normalizeLevel(environment as import("./types").LogLevelInput | undefined, this.logLevel);
  }

  private validateRotation(value: RotationOptions | false, name: string): void {
    if (value === false) return;
    if (!value || !Number.isFinite(value.maxBytes) || value.maxBytes <= 0 || !Number.isInteger(value.maxFiles) || value.maxFiles < 0) {
      throw new Error(`${name} must be false or { maxBytes: positive finite number, maxFiles: non-negative integer }`);
    }
  }
}
