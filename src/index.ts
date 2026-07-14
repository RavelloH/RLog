import type { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { CaptureManager, type CaptureLoggerBinding } from "./capture";
import { Config } from "./config";
import { Dispatcher } from "./dispatcher";
import { normalizeLevel } from "./levels";
import { Toolkit } from "./toolkit";
import type { BinaryCaptureOptions, BinaryStreamCaptureHandle, ConfigOptions, EventOptions, LogEntry, LogLevelInput, LogMetadata, LogSpan, LogTargets, LogTarget, ProcessCaptureHandle, ProcessCaptureOptions, ProcessCaptureResult, ProgressTask, ProgressTaskOptions, StreamCaptureOptions, TextStreamCaptureHandle, Tostringable } from "./types";
import { CaptureError, LogEntryAlreadyCommittedError, RLogClosedError, type LogRecord, type RLogExitError } from "./types";

export * from "./types";

class LogEntryImpl implements LogEntry {
  constructor(private readonly record: LogRecord) {}
  meta(metadata: LogMetadata): LogEntry;
  meta(key: string, value: unknown): LogEntry;
  meta(keyOrMetadata: string | LogMetadata, value?: unknown): LogEntry {
    if (this.record.committed) throw new LogEntryAlreadyCommittedError();
    if (typeof keyOrMetadata === "string") this.record.metadata[keyOrMetadata] = value;
    else Object.assign(this.record.metadata, keyOrMetadata);
    return this;
  }
  setEvent(type: string, data?: LogMetadata): void { this.record.event = { type, data }; }
}

class RLogExitSignal extends Error implements RLogExitError {
  readonly isRLogExit = true as const;
  constructor(readonly root: Rlog, message: string) { super(message); this.name = "RLogExitError"; }
}
type ExitListener = () => void | Promise<void>;

/** A lightweight logger bound to one output target (or the root's all-target scope) and optionally a timestamp. */
export class TargetLogger {
  constructor(protected readonly logger: Rlog, protected readonly targets: LogTargets, protected readonly timestamp?: Tostringable, protected readonly hasTimestamp = false) {}
  trace(...args: unknown[]): LogEntry { return this.logger.writeToTargets("trace", args, this.targets, undefined, this.timestamp, this.hasTimestamp); }
  debug(...args: unknown[]): LogEntry { return this.logger.writeToTargets("debug", args, this.targets, undefined, this.timestamp, this.hasTimestamp); }
  info(...args: unknown[]): LogEntry { return this.logger.writeToTargets("info", args, this.targets, undefined, this.timestamp, this.hasTimestamp); }
  success(...args: unknown[]): LogEntry { return this.logger.writeToTargets("success", args, this.targets, undefined, this.timestamp, this.hasTimestamp); }
  warn(...args: unknown[]): LogEntry { return this.logger.writeToTargets("warn", args, this.targets, undefined, this.timestamp, this.hasTimestamp); }
  warning(...args: unknown[]): LogEntry { return this.warn(...args); }
  error(...args: unknown[]): LogEntry { return this.logger.writeToTargets("error", args, this.targets, undefined, this.timestamp, this.hasTimestamp); }
  fatal(...args: unknown[]): LogEntry { return this.logger.writeToTargets("fatal", args, this.targets, undefined, this.timestamp, this.hasTimestamp); }
  /** Legacy target-local EXIT label. It logs only; use `rlog.exit()` to terminate the process. */
  exit(...args: unknown[]): LogEntry { return this.logger.writeToTargets("fatal", args, this.targets, "EXIT", this.timestamp, this.hasTimestamp); }
  event(type: string, data?: LogMetadata, options: EventOptions = {}): LogEntry {
    const entry = this.logger.writeToTargets(normalizeLevel(options.level), [options.message ?? type], this.targets, undefined, this.timestamp, this.hasTimestamp);
    (entry as LogEntryImpl).setEvent(type, data);
    return entry;
  }
  at(timestamp: Tostringable): TargetLogger { return new TargetLogger(this.logger, this.targets, timestamp, true); }
  withSpan<T>(name: string, operation: (span: LogSpan) => Promise<T> | T): Promise<T>;
  withSpan<T>(name: string, data: LogMetadata, operation: (span: LogSpan) => Promise<T> | T): Promise<T>;
  withSpan<T>(name: string, dataOrOperation: LogMetadata | ((span: LogSpan) => Promise<T> | T), possibleOperation?: (span: LogSpan) => Promise<T> | T): Promise<T> {
    return this.logger.withSpanForTargets(this.targets, name, dataOrOperation, possibleOperation);
  }
  progressTask(options: ProgressTaskOptions): ProgressTask { return this.logger.progressTaskForTargets(this.targets, options); }
}

class LogSpanImpl implements LogSpan {
  readonly startedAt = new Date();
  private finished = false;
  constructor(readonly name: string, private readonly target: TargetLogger, private readonly data: LogMetadata) {}
  info(...args: unknown[]): LogEntry { return this.target.info(...args); }
  event(type: string, data?: LogMetadata, options?: EventOptions): LogEntry { return this.target.event(type, data, options); }
  success(data?: LogMetadata): void { if (!this.finished) { this.finished = true; this.target.event("span.completed", { ...this.data, ...(data ?? {}), durationMs: Date.now() - this.startedAt.valueOf() }); } }
  fail(error: unknown, data?: LogMetadata): void {
    if (this.finished) return;
    this.finished = true;
    const rendered = error instanceof Error ? { name: error.name, message: error.message } : String(error);
    this.target.event("span.failed", { ...this.data, ...(data ?? {}), durationMs: Date.now() - this.startedAt.valueOf(), error: rendered }, { level: "error" });
  }
}

class ProgressTaskImpl implements ProgressTask {
  private current: number;
  private done = false;
  private readonly jsonl: TargetLogger;
  constructor(private readonly owner: Rlog, private readonly target: TargetLogger, private readonly options: ProgressTaskOptions) {
    this.current = options.current ?? 0;
    this.jsonl = new TargetLogger(owner, new Set<LogTarget>(["jsonl"]));
    this.jsonl.event("progress.started", { label: options.label, current: this.current, total: options.total });
    this.owner.progress(this.current, this.options.total);
  }
  update(current: number): void {
    if (this.done) return;
    this.current = current;
    this.owner.progress(current, this.options.total);
    this.jsonl.event("progress.updated", { label: this.options.label, current, total: this.options.total });
  }
  complete(data?: LogMetadata): void {
    if (this.done) return;
    this.done = true;
    this.owner.progress(this.options.total, this.options.total);
    this.target.success(`${this.options.label}: complete`);
    this.jsonl.event("progress.completed", { label: this.options.label, current: this.options.total, total: this.options.total, ...(data ?? {}) });
  }
  fail(reason?: unknown, data?: LogMetadata): void {
    if (this.done) return;
    this.done = true;
    this.target.error(`${this.options.label}: failed`, reason ?? "");
    this.jsonl.event("progress.failed", { label: this.options.label, current: this.current, total: this.options.total, ...(data ?? {}), reason: reason instanceof Error ? reason.message : reason }, { level: "error" });
  }
}

/** Static screen facade constructor for `new Rlog.Screen(rlog)`. */
export class ScreenTargetLogger extends TargetLogger {
  constructor(logger: Rlog, timestamp?: Tostringable, hasTimestamp = false) { super(logger, new Set<LogTarget>(["screen"]), timestamp, hasTimestamp); }
  override at(timestamp: Tostringable): ScreenTargetLogger { return new ScreenTargetLogger(this.logger, timestamp, true); }
}

/** Text target plus v2-compatible file-stream helpers. */
export class TextTargetLogger extends TargetLogger {
  constructor(logger: Rlog, timestamp?: Tostringable, hasTimestamp = false) { super(logger, new Set<LogTarget>(["text"]), timestamp, hasTimestamp); }
  override at(timestamp: Tostringable): TextTargetLogger { return new TextTargetLogger(this.logger, timestamp, true); }
  /** @deprecated Advanced escape hatch; direct writes bypass rotation and lifecycle accounting. Use writeRaw(). */
  get stream() { return this.logger.textLogStream; }
  /** @deprecated Advanced escape hatch; use writeRaw() for managed writes. */
  get logStream() { return this.stream; }
  init(): Promise<void> { return this.logger.initText(); }
  writeRaw(text: string): Promise<void> { return this.logger.writeRawText(text); }
  /** @deprecated Use `writeRaw`. */
  writeLogToStream(text: string): Promise<void> { return this.writeRaw(text); }
  /** @deprecated Use `writeRaw`. */
  writeLog(text: string): Promise<void> { return this.writeRaw(text); }
}

export default class Rlog {
  static Config = Config;
  static Toolkit = Toolkit;
  static Screen = ScreenTargetLogger;
  static File = TextTargetLogger;
  readonly config: Config;
  readonly toolkit: Toolkit;
  readonly screen: TargetLogger;
  readonly text: TextTargetLogger;
  /** @deprecated Use `text`. Kept as the same facade instance for v2 compatibility. */
  readonly file: TextTargetLogger;
  readonly jsonl: TargetLogger;
  readonly capture: {
    process: (child: ChildProcess, options?: ProcessCaptureOptions) => Promise<ProcessCaptureResult>;
    processHandle: (child: ChildProcess, options?: ProcessCaptureOptions) => ProcessCaptureHandle;
    stream: (stream: Readable, options?: StreamCaptureOptions) => TextStreamCaptureHandle;
    binary: (stream: Readable, options: BinaryCaptureOptions) => BinaryStreamCaptureHandle;
  };
  private readonly dispatcher: Dispatcher;
  private readonly root: Rlog;
  private readonly context: LogMetadata;
  private readonly exitListeners: ExitListener[];
  private readonly captureManager: CaptureManager;
  private exiting = false;

  constructor(options?: ConfigOptions, internals?: { root: Rlog; context: LogMetadata }) {
    if (internals) {
      this.root = internals.root; this.config = this.root.config; this.dispatcher = this.root.dispatcher; this.toolkit = this.root.toolkit; this.context = internals.context; this.exitListeners = this.root.exitListeners; this.captureManager = this.root.captureManager;
    } else {
      this.root = this; this.config = new Config(options); this.dispatcher = new Dispatcher(this.config); this.toolkit = this.dispatcher.toolkit; this.context = { ...this.config.context }; this.exitListeners = [];
      this.captureManager = new CaptureManager(this.dispatcher);
      if (this.config.autoInit && this.config.logFilePath) {
        void this.initText().catch(() => undefined);
        if (!this.config.silent) this.writeToTargets("info", [`The log will be written to ${this.config.logFilePath}`], new Set<LogTarget>(["screen"]));
      }
    }
    this.screen = new ScreenTargetLogger(this);
    this.text = new TextTargetLogger(this);
    this.file = this.text;
    this.jsonl = new TargetLogger(this, new Set<LogTarget>(["jsonl"]));
    this.capture = {
      process: (child, captureOptions) => this.captureManager.process(child, captureOptions ?? {}, this.captureBinding()),
      processHandle: (child, captureOptions) => this.captureManager.processHandle(child, captureOptions ?? {}, this.captureBinding()),
      stream: (stream, captureOptions) => this.captureManager.stream(stream, captureOptions ?? {}, this.captureBinding()),
      binary: (stream, captureOptions) => this.captureManager.binary(stream, captureOptions),
    };
  }

  trace(...args: unknown[]): LogEntry { return this.writeToTargets("trace", args, "all"); }
  debug(...args: unknown[]): LogEntry { return this.writeToTargets("debug", args, "all"); }
  info(...args: unknown[]): LogEntry { return this.writeToTargets("info", args, "all"); }
  success(...args: unknown[]): LogEntry { return this.writeToTargets("success", args, "all"); }
  warn(...args: unknown[]): LogEntry { return this.writeToTargets("warn", args, "all"); }
  warning(...args: unknown[]): LogEntry { return this.warn(...args); }
  error(...args: unknown[]): LogEntry { return this.writeToTargets("error", args, "all"); }
  fatal(...args: unknown[]): LogEntry { return this.writeToTargets("fatal", args, "all"); }
  log(...args: unknown[]): LogEntry {
    const message = this.toolkit.formatConsoleArgs(args);
    const level = /(error|fail|mistake|fatal)/i.test(message) ? "error" : /(warn|but|notice|see|problem)/i.test(message) ? "warn" : /(success|ok|done|✓)/i.test(message) ? "success" : "info";
    return this.writeToTargets(level, args, "all");
  }
  event(type: string, data?: LogMetadata, options: EventOptions = {}): LogEntry { return new TargetLogger(this, "all").event(type, data, options); }
  withSpan<T>(name: string, operation: (span: LogSpan) => Promise<T> | T): Promise<T>;
  withSpan<T>(name: string, data: LogMetadata, operation: (span: LogSpan) => Promise<T> | T): Promise<T>;
  withSpan<T>(name: string, dataOrOperation: LogMetadata | ((span: LogSpan) => Promise<T> | T), possibleOperation?: (span: LogSpan) => Promise<T> | T): Promise<T> {
    return this.withSpanForTargets("all", name, dataOrOperation, possibleOperation);
  }
  progressTask(options: ProgressTaskOptions): ProgressTask { return this.progressTaskForTargets("all", options); }
  /** Bind an explicit timestamp without allocating another Dispatcher, Config, Sink, or stream. */
  at(timestamp: Tostringable): TargetLogger { return new TargetLogger(this, "all", timestamp, true); }

  child(context: LogMetadata): Rlog { return new Rlog(undefined, { root: this.root, context: { ...this.currentContext(), ...context } }); }
  onExit(listener: ExitListener): void { this.root.exitListeners.push(listener); }
  async flush(): Promise<void> { return this.root.dispatcher.flush(); }
  async close(): Promise<void> {
    try { await this.root.dispatcher.close(); }
    finally { this.root.config.dispose(); }
  }
  progress(num: number, max: number): void { void this.root.dispatcher.progress(num, max); }

  exit(message: unknown): never {
    const root = this.root;
    if (root.exiting) throw new Error("RLog exit is already in progress");
    root.exiting = true; root.writeToTargets("fatal", [message], "all", "EXIT");
    const signal = new RLogExitSignal(root, this.toolkit.formatConsoleArgs([message])); let started = false;
    const handler = (caught: Error) => { if (caught !== signal) { setImmediate(() => { throw caught; }); return; } started = true; void root.runExitCoordinator(); };
    process.prependOnceListener("uncaughtException", handler);
    setImmediate(() => { if (!started) process.removeListener("uncaughtException", handler); });
    throw signal;
  }

  /** Internal shared write path used by root, target, timestamp, and Capture facades. */
  writeToTargets(level: LogLevelInput, args: readonly unknown[], targets: LogTargets, specialLabel?: string, timestamp?: Tostringable, hasTimestamp = false): LogEntry {
    this.root.dispatcher.assertOpen();
    const normalized = normalizeLevel(level);
    if (normalized === "off") throw new Error("Cannot log with level off");
    const record: LogRecord = { id: this.root.dispatcher.nextId(), timestamp: hasTimestamp ? timestamp : new Date(), level: specialLabel ? "fatal" : normalized, args: [...args], message: this.toolkit.formatConsoleArgs(args), metadata: {}, context: this.currentContext(), targets, committed: false, displayLabel: specialLabel };
    this.root.dispatcher.enqueue(record);
    return new LogEntryImpl(record);
  }

  /** Capture-only write path. It may drain records during root closing, unlike public logging APIs. */
  private writeCaptureToTargets(level: LogLevelInput, args: readonly unknown[], targets: LogTargets): void {
    const normalized = normalizeLevel(level);
    if (normalized === "off") return;
    const record: LogRecord = {
      id: this.root.dispatcher.nextId(), timestamp: new Date(), level: normalized, args: [...args],
      message: this.toolkit.formatConsoleArgs(args), metadata: {}, context: this.currentContext(), targets,
      committed: false,
    };
    this.root.dispatcher.enqueueCapture(record);
  }

  async writeRawText(text: string): Promise<void> { this.root.dispatcher.assertOpen(); if (this.config.logFilePath) await this.root.dispatcher.text.file.write(this.config.logFilePath, text); }
  /** @deprecated Use `writeRawText` through `rlog.text.writeRaw`. */
  async writeRawFile(text: string): Promise<void> { return this.writeRawText(text); }
  get textLogStream() { return this.root.dispatcher.text.file.stream; }
  async initText(): Promise<void> {
    if (!this.config.logFilePath) return;
    try { await this.root.dispatcher.text.file.init(this.config.logFilePath); }
    catch (reason) {
      // ManagedFile has already reported the failure. Throw-policy callers can
      // observe it immediately; tolerant policies retain the disabled target.
      if (this.config.fileErrorPolicyFor("text") === "throw") throw reason;
    }
  }
  /** @deprecated Use `initText` through `rlog.text.init`. */
  async initFile(): Promise<void> { return this.initText(); }

  private currentContext(): LogMetadata { return this === this.root ? { ...this.config.context } : { ...this.context }; }
  withSpanForTargets<T>(targets: LogTargets, name: string, dataOrOperation: LogMetadata | ((span: LogSpan) => Promise<T> | T), possibleOperation?: (span: LogSpan) => Promise<T> | T): Promise<T> {
    const data = typeof dataOrOperation === "function" ? {} : dataOrOperation;
    const operation = typeof dataOrOperation === "function" ? dataOrOperation : possibleOperation;
    if (!operation) return Promise.reject(new TypeError("withSpan requires an operation callback"));
    const spanLogger = this.child({ ...data, span: name });
    const target = new TargetLogger(spanLogger, targets);
    const span = new LogSpanImpl(name, target, data);
    target.event("span.started", { ...data, startedAt: span.startedAt.toISOString() });
    return Promise.resolve()
      .then(() => operation(span))
      .then((result) => { span.success(); return result; }, (error: unknown) => { span.fail(error); throw error; });
  }
  progressTaskForTargets(targets: LogTargets, options: ProgressTaskOptions): ProgressTask {
    if (!options.label || !Number.isFinite(options.total) || options.total <= 0) throw new Error("progressTask requires a non-empty label and positive finite total");
    return new ProgressTaskImpl(this, new TargetLogger(this, targets), options);
  }
  private captureBinding(): CaptureLoggerBinding {
    return {
      write: (level, args, targets) => {
        if (level === "none") return;
        try { this.writeCaptureToTargets(level, args, targets); }
        catch (error) {
          // A final optional Capture mirror may race root closing. User logs are still rejected.
          if (!(error instanceof RLogClosedError)) throw error;
        }
      },
      event: (type, data) => {
        // Marks are low-frequency structured capture facts, not display lines.
        try { this.jsonl.event(type, data); }
        catch (error) { if (!(error instanceof RLogClosedError)) throw error; }
      },
    };
  }
  private async runExitCoordinator(): Promise<void> {
    let failed = false;
    for (const listener of this.exitListeners) { try { await withTimeout(Promise.resolve().then(listener), this.config.exitListenerTimeoutMs, "Exit listener timed out"); } catch (reason) { failed = true; process.stderr.write(`RLog exit listener failed: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`); } }
    try { await withTimeout(this.close(), this.config.exitCloseTimeoutMs, "RLog close timed out"); } catch (reason) { failed = true; process.stderr.write(`RLog exit close failed: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`); }
    process.exit(failed ? 1 : 0);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(message)), timeoutMs); promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); }); });
}

module.exports = Rlog;
module.exports.default = Rlog;
module.exports.TargetLogger = TargetLogger;
module.exports.ScreenTargetLogger = ScreenTargetLogger;
module.exports.TextTargetLogger = TextTargetLogger;
module.exports.CaptureError = CaptureError;
module.exports.RLogClosedError = RLogClosedError;
module.exports.LogEntryAlreadyCommittedError = LogEntryAlreadyCommittedError;
