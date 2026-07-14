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
/** A string keeps the v3 API compatible; the object form lets critical outputs opt into stricter delivery. */
export type FileErrorPolicyConfig = FileErrorPolicy | {
  default?: FileErrorPolicy;
  text?: FileErrorPolicy;
  jsonl?: FileErrorPolicy;
  capture?: FileErrorPolicy;
};
export type CaptureFileMode = "append" | "truncate" | "exclusive";
export type CaptureConsumerErrorPolicy = "fail" | "ignore";
export type CaptureLineOverflowPolicy = "truncate" | "split" | "error";

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
  /** Optional second JSONL destination. RLog never closes caller-owned streams. */
  jsonlOutput?: ScreenOutput;
  /** Extra stable fields added to every JSONL record. Required RLog fields win on conflict. */
  jsonlBaseFields?: LogMetadata;
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
  fileErrorPolicy?: FileErrorPolicyConfig;
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

export interface LogSpan {
  readonly name: string;
  readonly startedAt: Date;
  info(...args: unknown[]): LogEntry;
  event(type: string, data?: LogMetadata, options?: EventOptions): LogEntry;
  success(data?: LogMetadata): void;
  fail(error: unknown, data?: LogMetadata): void;
}

export interface ProgressTaskOptions {
  label: string;
  total: number;
  /** Initial value rendered to the screen target and included in progress.started. */
  current?: number;
}

export interface ProgressTask {
  /** Updates screen progress and JSONL only; text records lifecycle milestones, not every update. */
  update(current: number): void;
  complete(data?: LogMetadata): void;
  fail(reason?: unknown, data?: LogMetadata): void;
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

export type CaptureEndReason = "end" | "process-close" | "manual-close" | "logger-close" | "aborted" | "error";
export type CaptureErrorCode =
  | "CAPTURE_SOURCE_ERROR"
  | "CAPTURE_FILE_ERROR"
  | "CAPTURE_ABORTED_BY_LOGGER_CLOSE"
  | "CAPTURE_ABORTED"
  | "CAPTURE_CONSUMER_ERROR"
  | "CAPTURE_BUFFER_OVERFLOW"
  | "CAPTURE_LINE_TOO_LONG";

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
  stdoutLines?: number;
  stderrLines?: number;
  stdoutFile?: string;
  stderrFile?: string;
  stdoutSha256?: string;
  stderrSha256?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  failedChannel?: "stdout" | "stderr" | "process";
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
  abort(reason?: string): Promise<never>;
}

export interface TextStreamCaptureHandle extends StreamCaptureHandle<StreamCaptureResult> {
  mark(label: string, metadata?: LogMetadata): void;
}

export interface BinaryStreamCaptureHandle extends StreamCaptureHandle<BinaryCaptureResult> {}

export interface ProcessCaptureHandle {
  readonly done: Promise<ProcessCaptureResult>;
  flush(): Promise<void>;
  /** Stops capturing without killing the caller-owned child process. */
  abort(reason?: string): Promise<never>;
}

export interface CaptureLine {
  text: string;
  timestamp: Date;
  terminated: boolean;
  lineNumber: number;
  rawBytes?: number;
}

export interface CaptureBaseOptions {
  /** Stops Capture only. It does not terminate a caller-owned child by default. */
  signal?: AbortSignal;
  /** Capture files default to truncate so a reused path cannot mix two captures. */
  fileMode?: CaptureFileMode;
  /** Capture display mirrors default to screen rather than every configured log target. */
  mirrorTargets?: LogTargets;
  /** Async consumer failures fail Capture by default because they commonly verify a protocol handshake. */
  consumerErrorPolicy?: CaptureConsumerErrorPolicy;
  highWaterMarkBytes?: number;
  lowWaterMarkBytes?: number;
  maxPendingBytes?: number;
}

export interface ProcessCaptureOptions extends CaptureBaseOptions {
  stdoutFile?: string;
  stderrFile?: string;
  stdoutDisplay?: LogLevelInput | "none";
  stderrDisplay?: LogLevelInput | "none";
  preserveRawBytes?: boolean;
  stripAnsiInFiles?: boolean;
  encoding?: BufferEncoding;
  computeSha256?: boolean;
  onLine?: (line: CaptureLine & { channel: "stdout" | "stderr" }) => void | Promise<void>;
  onStdoutLine?: (line: CaptureLine) => void | Promise<void>;
  onStderrLine?: (line: CaptureLine) => void | Promise<void>;
  maxLineBytes?: number;
  lineOverflowPolicy?: CaptureLineOverflowPolicy;
  /** Opt in only: process ownership remains with the caller by default. */
  killProcessOnAbort?: boolean;
  killSignal?: NodeJS.Signals;
  /**
   * How stdout/stderr are treated after Capture stops. Defaults to drain so a
   * still-running caller-owned child cannot block on a full pipe.
   */
  detachMode?: ProcessCaptureDetachMode;
}

/** Strategy for a caller-owned process's stdout/stderr after Process Capture stops. */
export type ProcessCaptureDetachMode = "drain" | "pause" | "handoff";

export interface StreamCaptureOptions extends CaptureBaseOptions {
  file?: string;
  encoding?: BufferEncoding;
  displayLevel?: LogLevelInput | "none";
  stripAnsiInFile?: boolean;
  timestampLines?: boolean;
  computeSha256?: boolean;
  onLine?: (line: CaptureLine) => void | Promise<void>;
  maxLineBytes?: number;
  lineOverflowPolicy?: CaptureLineOverflowPolicy;
}

export interface BinaryCaptureOptions extends CaptureBaseOptions {
  file: string;
  computeSha256?: boolean;
}
