import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { normalizeLevel, parseArgvLevel } from "./levels";
import type { ConfigOptions, CustomColorRule, FileErrorPolicy, FileErrorPolicyConfig, LogLevel, LogMetadata, MetadataOutputMode, RotationOptions, ScreenOutput, FlightRecorderOptions, LogProcessor, LogTransport, AutoRecoverOptions } from "./types";

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
  textFileIsolation: "shared" | "instance" = "shared";
  jsonlFileIsolation: "shared" | "instance" = "shared";
  private readonly logInstanceId = randomUUID().replace(/-/g, "");
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
  maxQueuedRecords: number | undefined;
  maxQueuedBytes: number | undefined;
  maxRecordBytes: number | undefined;
  queueOverflowPolicy: "throw" | "drop-debug" = "throw";
  flightRecorder: FlightRecorderOptions | false = false;
  processors: LogProcessor[] = [];
  transports: LogTransport[] = [];
  autoRecoverFiles: AutoRecoverOptions | false = false;
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
    if (next.textFileIsolation !== undefined && !["shared", "instance"].includes(next.textFileIsolation)) throw new Error("Invalid textFileIsolation");
    if (next.jsonlFileIsolation !== undefined && !["shared", "instance"].includes(next.jsonlFileIsolation)) throw new Error("Invalid jsonlFileIsolation");
    if (next.exitListenerTimeoutMs !== undefined && (!Number.isFinite(next.exitListenerTimeoutMs) || next.exitListenerTimeoutMs < 0)) throw new Error("exitListenerTimeoutMs must be a non-negative finite number");
    if (next.exitCloseTimeoutMs !== undefined && (!Number.isFinite(next.exitCloseTimeoutMs) || next.exitCloseTimeoutMs < 0)) throw new Error("exitCloseTimeoutMs must be a non-negative finite number");
    if (next.maxQueuedRecords !== undefined && (!Number.isSafeInteger(next.maxQueuedRecords) || next.maxQueuedRecords < 1)) throw new Error("maxQueuedRecords must be a positive safe integer");
    if (next.maxQueuedBytes !== undefined && (!Number.isSafeInteger(next.maxQueuedBytes) || next.maxQueuedBytes < 1)) throw new Error("maxQueuedBytes must be a positive safe integer");
    if (next.maxRecordBytes !== undefined && (!Number.isSafeInteger(next.maxRecordBytes) || next.maxRecordBytes < 1)) throw new Error("maxRecordBytes must be a positive safe integer");
    if (next.queueOverflowPolicy !== undefined && !["throw", "drop-debug"].includes(next.queueOverflowPolicy)) throw new Error("Invalid queueOverflowPolicy");
    if (next.processors !== undefined && (!Array.isArray(next.processors) || next.processors.some(fn => typeof fn !== "function"))) throw new Error("Invalid processors");
    if (next.transports !== undefined && (!Array.isArray(next.transports) || next.transports.some(item => !item || typeof item.write !== "function"))) throw new Error("Invalid transports");
    if (next.autoRecoverFiles !== undefined && next.autoRecoverFiles !== false) {
      const recover = next.autoRecoverFiles;
      if (!recover || typeof recover !== "object" || Array.isArray(recover)) throw new Error("Invalid autoRecoverFiles");
      if (recover.initialDelayMs !== undefined && (!Number.isSafeInteger(recover.initialDelayMs) || recover.initialDelayMs < 1)) throw new Error("autoRecoverFiles.initialDelayMs must be a positive integer");
      if (recover.maxDelayMs !== undefined && (!Number.isSafeInteger(recover.maxDelayMs) || recover.maxDelayMs < 1)) throw new Error("autoRecoverFiles.maxDelayMs must be a positive integer");
      if (recover.multiplier !== undefined && (!Number.isFinite(recover.multiplier) || recover.multiplier < 1)) throw new Error("autoRecoverFiles.multiplier must be at least 1");
      if ((recover.maxDelayMs ?? 60000) < (recover.initialDelayMs ?? 1000)) throw new Error("autoRecoverFiles.maxDelayMs must not be smaller than initialDelayMs");
    }
    if (next.flightRecorder !== undefined && next.flightRecorder !== false) {
      const fr = next.flightRecorder;
      if (!fr || typeof fr !== "object" || Array.isArray(fr)) throw new Error("Invalid flightRecorder options");
      if (fr.maxRecords !== undefined && (!Number.isSafeInteger(fr.maxRecords) || fr.maxRecords < 1)) throw new Error("flightRecorder.maxRecords must be a positive safe integer");
      if (fr.maxBytes !== undefined && (!Number.isSafeInteger(fr.maxBytes) || fr.maxBytes < 1)) throw new Error("flightRecorder.maxBytes must be a positive safe integer");
      if (fr.captureLevels !== undefined && (!Array.isArray(fr.captureLevels) || !fr.captureLevels.length || fr.captureLevels.some(level => !["trace","debug","info","success","warn","error","fatal"].includes(level)))) throw new Error("Invalid flightRecorder.captureLevels");
      if (fr.includeEventData !== undefined && typeof fr.includeEventData !== "boolean") throw new Error("Invalid flightRecorder.includeEventData");
    }
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
    if (next.flightRecorder !== undefined) this.flightRecorder = next.flightRecorder === false ? false : { ...next.flightRecorder, ...(next.flightRecorder.captureLevels ? { captureLevels: [...next.flightRecorder.captureLevels] } : {}) };
    if (next.processors !== undefined) this.processors = [...next.processors];
    if (next.transports !== undefined) this.transports = [...next.transports];
    if (next.autoRecoverFiles !== undefined) this.autoRecoverFiles = next.autoRecoverFiles === false ? false : { ...next.autoRecoverFiles };
    for (const [key, value] of Object.entries(next) as Array<[keyof ConfigOptions, ConfigOptions[keyof ConfigOptions]]>) {
      if (["logLevel", "screenLogLevel", "fileLogLevel", "jsonlLogLevel", "screenOutput", "jsonlOutput", "context", "jsonlBaseFields", "blockedWordsList", "redactKeys", "customColorRules", "fileErrorPolicy", "flightRecorder", "processors", "transports", "autoRecoverFiles"].includes(key)) continue;
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

  /** Resolved destination, stable for the lifetime of this logger. */
  resolveFilePath(target: "text" | "jsonl"): string | undefined {
    const name = target === "text" ? this.logFilePath : this.jsonlFilePath;
    if (!name) return undefined;
    const isolation = target === "text" ? this.textFileIsolation : this.jsonlFileIsolation;
    if (isolation !== "instance") return name;
    const parsed = path.parse(name);
    return path.join(parsed.dir, parsed.name + "." + process.pid + "." + this.logInstanceId + parsed.ext);
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
      processors: options.processors ? [...options.processors] : undefined,
      transports: options.transports ? [...options.transports] : undefined,
      autoRecoverFiles: options.autoRecoverFiles === undefined || options.autoRecoverFiles === false
        ? options.autoRecoverFiles : { ...options.autoRecoverFiles },
      flightRecorder: options.flightRecorder === undefined || options.flightRecorder === false
        ? options.flightRecorder
        : { ...options.flightRecorder, ...(options.flightRecorder.captureLevels ? { captureLevels: [...options.flightRecorder.captureLevels] } : {}) },
    };
  }
}
