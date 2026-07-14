import type { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { CaptureManager } from "./capture";
import { Config } from "./config";
import { Dispatcher } from "./dispatcher";
import { normalizeLevel } from "./levels";
import { Toolkit } from "./toolkit";
import type { BinaryCaptureOptions, BinaryStreamCaptureHandle, ConfigOptions, EventOptions, LogDestination, LogEntry, LogLevelInput, LogMetadata, ProcessCaptureOptions, ProcessCaptureResult, StreamCaptureOptions, TextStreamCaptureHandle, Tostringable } from "./types";
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

class ScreenFacade {
  constructor(private readonly logger: Rlog) {}
  info(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("info", [message], "screen", undefined, time); }
  warning(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("warn", [message], "screen", undefined, time); }
  warn(message: unknown, time?: Tostringable): LogEntry { return this.warning(message, time); }
  error(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("error", [message], "screen", undefined, time); }
  success(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("success", [message], "screen", undefined, time); }
  trace(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("trace", [message], "screen", undefined, time); }
  debug(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("debug", [message], "screen", undefined, time); }
  fatal(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("fatal", [message], "screen", undefined, time); }
  exit(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("fatal", [message], "screen", "EXIT", time); }
}

class FileFacade {
  constructor(private readonly logger: Rlog) {}
  get logStream() { return this.logger.textLogStream; }
  init(): void { void this.logger.initFile(); }
  writeLogToStream(text: string): Promise<void> { return this.logger.writeRawFile(text); }
  writeLog(text: string): Promise<void> { return this.writeLogToStream(text); }
  info(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("info", [message], "file", undefined, time); }
  warning(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("warn", [message], "file", undefined, time); }
  warn(message: unknown, time?: Tostringable): LogEntry { return this.warning(message, time); }
  error(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("error", [message], "file", undefined, time); }
  success(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("success", [message], "file", undefined, time); }
  trace(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("trace", [message], "file", undefined, time); }
  debug(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("debug", [message], "file", undefined, time); }
  fatal(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("fatal", [message], "file", undefined, time); }
  exit(message: unknown, time?: Tostringable): LogEntry { return this.logger.write("fatal", [message], "file", "EXIT", time); }
}

export default class Rlog {
  static Config = Config;
  static Toolkit = Toolkit;
  static Screen = ScreenFacade;
  static File = FileFacade;
  readonly config: Config;
  readonly toolkit: Toolkit;
  readonly screen: ScreenFacade;
  readonly file: FileFacade;
  readonly capture: { process: (child: ChildProcess, options?: ProcessCaptureOptions) => Promise<ProcessCaptureResult>; stream: (stream: Readable, options?: StreamCaptureOptions) => TextStreamCaptureHandle; binary: (stream: Readable, options: BinaryCaptureOptions) => BinaryStreamCaptureHandle };
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
      this.captureManager = new CaptureManager(this.dispatcher, (level, line) => {
        if (level === "none") return;
        try { this.write(level, [line], "all"); }
        catch (error) {
          // Capture finalization can run after Dispatcher enters "closing".
          // A user log must still be rejected then, but a trailing mirrored line
          // is optional and must not prevent the Capture from settling.
          if (!(error instanceof RLogClosedError)) throw error;
        }
      }, (type, data) => { this.event(type, data); });
      if (this.config.autoInit && this.config.logFilePath) {
        void this.initFile();
        if (!this.config.silent) this.write("info", [`The log will be written to ${this.config.logFilePath}`], "screen");
      }
    }
    this.screen = new ScreenFacade(this); this.file = new FileFacade(this);
    this.capture = { process: (child, captureOptions) => this.captureManager.process(child, captureOptions), stream: (stream, captureOptions) => this.captureManager.stream(stream, captureOptions), binary: (stream, captureOptions) => this.captureManager.binary(stream, captureOptions) };
  }

  info(...args: unknown[]): LogEntry { return this.write("info", args, "all"); }
  warning(...args: unknown[]): LogEntry { return this.write("warn", args, "all"); }
  warn(...args: unknown[]): LogEntry { return this.warning(...args); }
  error(...args: unknown[]): LogEntry { return this.write("error", args, "all"); }
  success(...args: unknown[]): LogEntry { return this.write("success", args, "all"); }
  trace(...args: unknown[]): LogEntry { return this.write("trace", args, "all"); }
  debug(...args: unknown[]): LogEntry { return this.write("debug", args, "all"); }
  fatal(...args: unknown[]): LogEntry { return this.write("fatal", args, "all"); }

  log(...args: unknown[]): LogEntry {
    const message = this.toolkit.formatConsoleArgs(args);
    const level = /(error|fail|mistake|fatal)/i.test(message) ? "error" : /(warn|but|notice|see|problem)/i.test(message) ? "warn" : /(success|ok|done|✓)/i.test(message) ? "success" : "info";
    return this.write(level, args, "all");
  }

  event(type: string, data?: LogMetadata, options: EventOptions = {}): LogEntry {
    const level = normalizeLevel(options.level);
    const entry = this.write(level, [options.message ?? type], "all");
    // Event fields must be attached before the dispatcher microtask commits the record.
    (entry as LogEntryImpl).setEvent(type, data);
    return entry;
  }

  child(context: LogMetadata): Rlog { return new Rlog(undefined, { root: this.root, context: { ...this.currentContext(), ...context } }); }
  onExit(listener: ExitListener): void { this.root.exitListeners.push(listener); }
  async flush(): Promise<void> { return this.root.dispatcher.flush(); }
  async close(): Promise<void> { return this.root.dispatcher.close(); }
  progress(num: number, max: number): void { void this.root.dispatcher.progress(num, max); }

  exit(message: unknown): never {
    const root = this.root;
    if (root.exiting) throw new Error("RLog exit is already in progress");
    root.exiting = true;
    root.write("fatal", [message], "all", "EXIT");
    const signal = new RLogExitSignal(root, this.toolkit.formatConsoleArgs([message]));
    let started = false;
    const handler = (caught: Error) => {
      if (caught !== signal) {
        // This can only happen if user code catches the exit signal and later throws.
        // Re-throw after the once-listener is removed rather than swallowing it.
        setImmediate(() => { throw caught; });
        return;
      }
      started = true;
      void root.runExitCoordinator();
    };
    process.prependOnceListener("uncaughtException", handler);
    setImmediate(() => { if (!started) process.removeListener("uncaughtException", handler); });
    throw signal;
  }

  write(level: LogLevelInput, args: readonly unknown[], destination: LogDestination, specialLabel?: string, timestamp: Tostringable = new Date()): LogEntry {
    this.root.dispatcher.assertOpen();
    const normalized = normalizeLevel(level);
    if (normalized === "off") throw new Error("Cannot log with level off");
    const record: LogRecord = { id: this.root.dispatcher.nextId(), timestamp, level: normalized, args: [...args], message: this.toolkit.formatConsoleArgs(args), metadata: {}, context: this.currentContext(), destination, committed: false, displayLabel: specialLabel };
    if (specialLabel) record.level = "fatal";
    this.root.dispatcher.enqueue(record);
    return new LogEntryImpl(record);
  }

  async writeRawFile(text: string): Promise<void> {
    if (!this.config.logFilePath) return;
    await this.dispatcher.text.file.write(this.config.logFilePath, text);
  }

  get textLogStream() { return this.dispatcher.text.file.stream; }
  async initFile(): Promise<void> {
    if (!this.config.logFilePath) return;
    try { await this.dispatcher.text.file.init(this.config.logFilePath); }
    catch { /* the dispatcher retains throw-policy errors for flush/close */ }
  }

  private currentContext(): LogMetadata { return this === this.root ? { ...this.config.context } : { ...this.context }; }

  private async runExitCoordinator(): Promise<void> {
    let failed = false;
    for (const listener of this.exitListeners) {
      try { await withTimeout(Promise.resolve().then(listener), this.config.exitListenerTimeoutMs, "Exit listener timed out"); }
      catch (reason) { failed = true; process.stderr.write(`RLog exit listener failed: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`); }
    }
    try { await withTimeout(this.close(), this.config.exitCloseTimeoutMs, "RLog close timed out"); }
    catch (reason) { failed = true; process.stderr.write(`RLog exit close failed: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`); }
    process.exit(failed ? 1 : 0);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

module.exports = Rlog;
module.exports.default = Rlog;
module.exports.CaptureError = CaptureError;
module.exports.RLogClosedError = RLogClosedError;
module.exports.LogEntryAlreadyCommittedError = LogEntryAlreadyCommittedError;
