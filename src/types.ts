import type { Writable } from "node:stream";

export type LogLevel =
  | "trace"
  | "debug"
  | "info"
  | "success"
  | "warn"
  | "error"
  | "fatal"
  | "off";

export type LogLevelInput = LogLevel | "warning";
export type Tostringable = string | null | boolean | undefined | number | bigint | Date;
export type LogMetadata = Record<string, unknown>;
/** A concrete output target. `file` is intentionally not a target: text and JSONL are independent. */
export type LogTarget = "screen" | "text" | "jsonl";
export type LogTargets = "all" | ReadonlySet<LogTarget>;
export type ScreenOutput = "stdout" | "stderr" | "none" | Writable;
export type MetadataOutputMode = "none" | "inline" | "block";
export type FileErrorPolicy = "throw" | "disable" | "stderr" | "ignore";

/** `maxFiles` is the number of retained historical files; it excludes the active file. */
export interface RotationOptions {
  maxBytes: number;
  maxFiles: number;
}

export interface CustomColorRule {
  reg: string;
  color: LogColor;
}

export type LogColor = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "gray";

export interface FileErrorContext {
  filePath?: string;
  output: "text" | "jsonl" | "capture";
  operation: "open" | "write" | "flush" | "close" | "rotate";
}

export interface ConfigOptions {
  enableColorfulOutput?: boolean;
  logFilePath?: string;
  timeFormat?: string;
  timezone?: string;
  logTemplate?: string;
  blockedWordsList?: string[];
  screenLength?: number;
  autoInit?: boolean;
  silent?: boolean;
  customColorRules?: CustomColorRule[];
  logLevel?: LogLevelInput;
  screenLogLevel?: LogLevelInput;
  fileLogLevel?: LogLevelInput;
  jsonlLogLevel?: LogLevelInput;
  screenOutput?: ScreenOutput;
  jsonlFilePath?: string;
  /** Size-based rotation for the text log. Disabled by default. */
  textRotation?: RotationOptions | false;
  /** Size-based rotation for the JSONL log. Disabled by default. */
  jsonlRotation?: RotationOptions | false;
  context?: LogMetadata;
  screenMetadataOutput?: MetadataOutputMode;
  fileMetadataOutput?: MetadataOutputMode;
  redactKeys?: string[];
  readLogLevelFromArgv?: boolean;
  readLogLevelFromEnv?: boolean;
  logLevelArgumentName?: string;
  logLevelEnvironmentName?: string;
  fileErrorPolicy?: FileErrorPolicy;
  onFileError?: (error: Error, context: FileErrorContext) => void;
  exitListenerTimeoutMs?: number;
  exitCloseTimeoutMs?: number;
}

export interface LogRecord {
  id: number;
  timestamp: Tostringable;
  level: Exclude<LogLevel, "off">;
  args: unknown[];
  message: string;
  metadata: LogMetadata;
  context: LogMetadata;
  targets: LogTargets;
  event?: { type: string; data?: LogMetadata };
  committed: boolean;
  screenWritten?: boolean;
  displayLabel?: string;
}

export interface LogEntry {
  meta(metadata: LogMetadata): LogEntry;
  meta(key: string, value: unknown): LogEntry;
}

export interface EventOptions {
  level?: LogLevelInput;
  message?: string;
}

export interface RLogExitError extends Error {
  isRLogExit: true;
}

export class RLogClosedError extends Error {
  constructor() {
    super("RLog is closed and cannot accept new records");
    this.name = "RLogClosedError";
  }
}

export class LogEntryAlreadyCommittedError extends Error {
  constructor() {
    super("This LogEntry has already been committed");
    this.name = "LogEntryAlreadyCommittedError";
  }
}

export type CaptureEndReason = "end" | "process-close" | "manual-close" | "logger-close" | "error";
export type CaptureErrorCode =
  | "CAPTURE_SOURCE_ERROR"
  | "CAPTURE_FILE_ERROR"
  | "CAPTURE_DECODE_ERROR"
  | "CAPTURE_ABORTED_BY_LOGGER_CLOSE";

export interface CaptureResultBase {
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  bytes: number;
  reason: CaptureEndReason;
  file?: string;
}

export interface StreamCaptureResult extends CaptureResultBase {
  encoding: BufferEncoding;
  chunks: number;
  lines?: number;
  sha256?: string;
}

export interface BinaryCaptureResult extends CaptureResultBase {
  chunks: number;
  sha256?: string;
}

export interface ProcessCaptureResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256?: string;
  stderrSha256?: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  reason: "process-close";
}

export interface CapturePartialResult {
  reason: CaptureEndReason;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  bytes?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  file?: string;
}

export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  readonly cause?: unknown;
  readonly partialResult: CapturePartialResult;

  constructor(code: CaptureErrorCode, message: string, partialResult: CapturePartialResult, cause?: unknown) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
    this.partialResult = partialResult;
    this.cause = cause;
  }
}

export interface StreamCaptureHandle<TResult extends CaptureResultBase> {
  readonly done: Promise<TResult>;
  flush(): Promise<void>;
  close(): Promise<TResult>;
}

export interface TextStreamCaptureHandle extends StreamCaptureHandle<StreamCaptureResult> {
  mark(label: string, metadata?: LogMetadata): void;
}

export interface BinaryStreamCaptureHandle extends StreamCaptureHandle<BinaryCaptureResult> {}

export interface ProcessCaptureOptions {
  stdoutFile?: string;
  stderrFile?: string;
  stdoutDisplay?: LogLevelInput | "none";
  stderrDisplay?: LogLevelInput | "none";
  preserveRawBytes?: boolean;
  stripAnsiInFiles?: boolean;
  encoding?: BufferEncoding;
  computeSha256?: boolean;
}

export interface StreamCaptureOptions {
  file?: string;
  encoding?: BufferEncoding;
  displayLevel?: LogLevelInput | "none";
  stripAnsiInFile?: boolean;
  timestampLines?: boolean;
  computeSha256?: boolean;
}

export interface BinaryCaptureOptions {
  file: string;
  computeSha256?: boolean;
}
