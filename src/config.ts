import { normalizeLevel, parseArgvLevel } from "./levels";
import type { ConfigOptions, CustomColorRule, FileErrorPolicy, FileErrorPolicyConfig, LogLevel, LogMetadata, MetadataOutputMode, RotationOptions, ScreenOutput } from "./types";

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
  jsonlOutput: ScreenOutput = "none";
  jsonlBaseFields: LogMetadata = {};
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
  fileErrorPolicy: FileErrorPolicyConfig = "throw";
  onFileError: ((error: Error, context: import("./types").FileErrorContext) => void) | undefined;
  exitListenerTimeoutMs = 5000;
  exitCloseTimeoutMs = 5000;
  private disposed = false;

  constructor(options?: ConfigOptions) {
    Config.instances.add(this);
    this.setConfig(Config.globalDefaults);
    this.setConfig(options);
  }

  setConfig(options?: ConfigOptions): void {
    if (!options) return;
    const next = { ...options };
    if (next.screenOutput !== undefined) this.validateOutput(next.screenOutput, "screenOutput");
    if (next.jsonlOutput !== undefined) this.validateOutput(next.jsonlOutput, "jsonlOutput");
    if (next.screenMetadataOutput !== undefined && !["none", "inline", "block"].includes(next.screenMetadataOutput)) throw new Error(`Invalid screenMetadataOutput: ${next.screenMetadataOutput}`);
    if (next.fileMetadataOutput !== undefined && !["none", "inline", "block"].includes(next.fileMetadataOutput)) throw new Error(`Invalid fileMetadataOutput: ${next.fileMetadataOutput}`);
    if (next.fileErrorPolicy !== undefined) this.validateFileErrorPolicy(next.fileErrorPolicy);
    if (next.textRotation !== undefined) this.validateRotation(next.textRotation, "textRotation");
    if (next.jsonlRotation !== undefined) this.validateRotation(next.jsonlRotation, "jsonlRotation");
    if (next.exitListenerTimeoutMs !== undefined && (!Number.isFinite(next.exitListenerTimeoutMs) || next.exitListenerTimeoutMs < 0)) throw new Error("exitListenerTimeoutMs must be a non-negative finite number");
    if (next.exitCloseTimeoutMs !== undefined && (!Number.isFinite(next.exitCloseTimeoutMs) || next.exitCloseTimeoutMs < 0)) throw new Error("exitCloseTimeoutMs must be a non-negative finite number");
    if (next.logLevel !== undefined) this.logLevel = normalizeLevel(next.logLevel);
    if (next.screenLogLevel !== undefined) this.screenLogLevel = normalizeLevel(next.screenLogLevel);
    if (next.fileLogLevel !== undefined) this.fileLogLevel = normalizeLevel(next.fileLogLevel);
    if (next.jsonlLogLevel !== undefined) this.jsonlLogLevel = normalizeLevel(next.jsonlLogLevel);
    if (next.screenOutput !== undefined) this.screenOutput = next.screenOutput;
    if (next.jsonlOutput !== undefined) this.jsonlOutput = next.jsonlOutput;
    if (next.context !== undefined) this.context = { ...next.context };
    if (next.jsonlBaseFields !== undefined) this.jsonlBaseFields = { ...next.jsonlBaseFields };
    if (next.blockedWordsList !== undefined) this.blockedWordsList = [...next.blockedWordsList];
    if (next.redactKeys !== undefined) this.redactKeys = [...next.redactKeys];
    if (next.customColorRules !== undefined) this.customColorRules = next.customColorRules.map((rule) => ({ ...rule }));
    for (const [key, value] of Object.entries(next) as Array<[keyof ConfigOptions, ConfigOptions[keyof ConfigOptions]]>) {
      if (["logLevel", "screenLogLevel", "fileLogLevel", "jsonlLogLevel", "screenOutput", "jsonlOutput", "context", "jsonlBaseFields", "blockedWordsList", "redactKeys", "customColorRules", "fileErrorPolicy"].includes(key)) continue;
      if (value !== undefined) Reflect.set(this, key, key === "textRotation" || key === "jsonlRotation" ? (value === false ? false : { ...(value as RotationOptions) }) : value);
    }
    if (next.fileErrorPolicy !== undefined) this.fileErrorPolicy = typeof next.fileErrorPolicy === "string" ? next.fileErrorPolicy : { ...next.fileErrorPolicy };
  }

  setConfigGlobal(options?: ConfigOptions): void {
    if (!options) return;
    Config.globalDefaults = Config.cloneOptions({ ...Config.globalDefaults, ...options });
    for (const instance of Config.instances) instance.setConfig(options);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    Config.instances.delete(this);
  }

  effectiveLevel(target: "screen" | "file" | "jsonl"): LogLevel {
    const explicit = target === "screen" ? this.screenLogLevel : target === "file" ? this.fileLogLevel : this.jsonlLogLevel;
    if (explicit) return explicit;
    const argv = this.readLogLevelFromArgv ? parseArgvLevel(process.argv.slice(2), this.logLevelArgumentName) : undefined;
    const environment = this.readLogLevelFromEnv ? process.env[this.logLevelEnvironmentName] : undefined;
    return argv ?? normalizeLevel(environment as import("./types").LogLevelInput | undefined, this.logLevel);
  }

  fileErrorPolicyFor(output: "text" | "jsonl" | "capture"): FileErrorPolicy {
    if (typeof this.fileErrorPolicy === "string") return this.fileErrorPolicy;
    return this.fileErrorPolicy[output] ?? this.fileErrorPolicy.default ?? "throw";
  }

  private validateRotation(value: RotationOptions | false, name: string): void {
    if (value === false) return;
    if (!value || !Number.isFinite(value.maxBytes) || value.maxBytes <= 0 || !Number.isInteger(value.maxFiles) || value.maxFiles < 0) {
      throw new Error(`${name} must be false or { maxBytes: positive finite number, maxFiles: non-negative integer }`);
    }
  }

  private validateFileErrorPolicy(value: FileErrorPolicyConfig): void {
    const validate = (policy: FileErrorPolicy | undefined): void => {
      if (policy !== undefined && !["throw", "disable", "stderr", "ignore"].includes(policy)) throw new Error(`Invalid fileErrorPolicy: ${policy}`);
    };
    if (typeof value === "string") { validate(value); return; }
    validate(value.default); validate(value.text); validate(value.jsonl); validate(value.capture);
  }

  private validateOutput(value: ScreenOutput, name: string): void {
    if (typeof value === "string" && !["stdout", "stderr", "none"].includes(value)) throw new Error(`Invalid ${name}: ${value}`);
    if (typeof value !== "string" && typeof value.write !== "function") throw new Error(`${name} must be stdout, stderr, none, or a Writable stream`);
  }

  private static cloneOptions(options: ConfigOptions): ConfigOptions {
    return {
      ...options,
      textRotation: options.textRotation === undefined || options.textRotation === false ? options.textRotation : { ...options.textRotation },
      jsonlRotation: options.jsonlRotation === undefined || options.jsonlRotation === false ? options.jsonlRotation : { ...options.jsonlRotation },
      fileErrorPolicy: typeof options.fileErrorPolicy === "object" ? { ...options.fileErrorPolicy } : options.fileErrorPolicy,
      context: options.context ? { ...options.context } : options.context,
      jsonlBaseFields: options.jsonlBaseFields ? { ...options.jsonlBaseFields } : options.jsonlBaseFields,
      blockedWordsList: options.blockedWordsList ? [...options.blockedWordsList] : options.blockedWordsList,
      redactKeys: options.redactKeys ? [...options.redactKeys] : options.redactKeys,
      customColorRules: options.customColorRules?.map((rule) => ({ ...rule })),
    };
  }
}
