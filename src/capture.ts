import { createHash, type Hash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { Dispatcher } from "./dispatcher";
import { normalizeCaptureDisplayLevel, type CaptureDisplayLevel } from "./levels";
import { ManagedFile, toError } from "./sinks";
import type {
  BinaryCaptureOptions, BinaryCaptureResult, BinaryStreamCaptureHandle, CaptureConsumerErrorPolicy,
  CaptureEndReason, CaptureErrorCode, CaptureFileMode, CaptureLine, CaptureLineOverflowPolicy,
  LogMetadata, LogTargets, ProcessCaptureHandle, ProcessCaptureOptions, ProcessCaptureResult,
  StreamCaptureOptions, StreamCaptureResult, TextStreamCaptureHandle,
} from "./types";
import { CaptureError } from "./types";

type CaptureState = "active" | "finishing" | "settled";
type CaptureDisplay = (level: CaptureDisplayLevel, args: unknown[], targets: LogTargets) => void;
type CaptureEvent = (type: string, data?: LogMetadata) => void;

export interface CaptureLoggerBinding {
  write: CaptureDisplay;
  event: CaptureEvent;
}

interface QueueOptions {
  highWaterMarkBytes: number;
  lowWaterMarkBytes: number;
  maxPendingBytes: number;
}

const defaultMirrorTargets: LogTargets = new Set(["screen"]);
const defaultQueue: QueueOptions = {
  highWaterMarkBytes: 4 * 1024 * 1024,
  lowWaterMarkBytes: 1 * 1024 * 1024,
  maxPendingBytes: 16 * 1024 * 1024,
};

function queueOptions(options: { highWaterMarkBytes?: number; lowWaterMarkBytes?: number; maxPendingBytes?: number }): QueueOptions {
  const highWaterMarkBytes = options.highWaterMarkBytes ?? defaultQueue.highWaterMarkBytes;
  const lowWaterMarkBytes = options.lowWaterMarkBytes ?? defaultQueue.lowWaterMarkBytes;
  const maxPendingBytes = options.maxPendingBytes ?? defaultQueue.maxPendingBytes;
  if (!Number.isFinite(highWaterMarkBytes) || highWaterMarkBytes <= 0) throw new Error("highWaterMarkBytes must be a positive finite number");
  if (!Number.isFinite(lowWaterMarkBytes) || lowWaterMarkBytes < 0 || lowWaterMarkBytes > highWaterMarkBytes) throw new Error("lowWaterMarkBytes must be between zero and highWaterMarkBytes");
  if (!Number.isFinite(maxPendingBytes) || maxPendingBytes < highWaterMarkBytes) throw new Error("maxPendingBytes must be at least highWaterMarkBytes");
  return { highWaterMarkBytes, lowWaterMarkBytes, maxPendingBytes };
}

function resultBase(startedAt: Date, reason: CaptureEndReason, bytes: number, file?: string) {
  const endedAt = new Date();
  return { startedAt, endedAt, durationMs: endedAt.valueOf() - startedAt.valueOf(), bytes, reason, file };
}

class ConsumerFailure extends Error {
  constructor(readonly original: Error) { super(original.message); this.name = "CaptureConsumerError"; }
}
class LineOverflowFailure extends Error {
  constructor(readonly original: Error) { super(original.message); this.name = "CaptureLineOverflowError"; }
}

function asLine(text: string, terminated: boolean, lineNumber: number, timestamp: Date): CaptureLine {
  return { text, timestamp, terminated, lineNumber, rawBytes: Buffer.byteLength(text) + (terminated ? 1 : 0) };
}

/** A text Capture with bounded queued work and source pause/resume backpressure. */
class TextCapture implements TextStreamCaptureHandle {
  readonly done: Promise<StreamCaptureResult>;
  private resolve!: (result: StreamCaptureResult) => void;
  private reject!: (error: CaptureError) => void;
  private readonly startedAt = new Date();
  private readonly decoder: StringDecoder;
  private readonly output: ManagedFile | undefined;
  private readonly hash: Hash | undefined;
  private readonly displayLevel: CaptureDisplayLevel;
  private readonly queueSettings: QueueOptions;
  private readonly mirrorTargets: LogTargets;
  private readonly fileMode: CaptureFileMode;
  private readonly consumerPolicy: CaptureConsumerErrorPolicy;
  private readonly maxLineBytes: number;
  private readonly lineOverflowPolicy: CaptureLineOverflowPolicy;
  private state: CaptureState = "active";
  private work: Promise<void> = Promise.resolve();
  private failure: Promise<void> | undefined;
  private bytes = 0;
  private chunks = 0;
  private lines = 0;
  private pendingBytes = 0;
  private paused = false;
  private lineBuffer = "";
  private discardingLongLine = false;
  private readonly dataListener: (chunk: Buffer | string) => void;
  private readonly endListener: () => void;
  private readonly closeListener: () => void;
  private readonly errorListener: (error: Error) => void;
  private readonly abortListener: () => void;

  constructor(
    private readonly source: Readable,
    private readonly options: Required<Pick<StreamCaptureOptions, "encoding" | "stripAnsiInFile" | "timestampLines" | "computeSha256">> & StreamCaptureOptions,
    private readonly dispatcher: Dispatcher,
    private readonly binding: CaptureLoggerBinding,
  ) {
    this.decoder = new StringDecoder(options.encoding);
    this.displayLevel = normalizeCaptureDisplayLevel(options.displayLevel);
    this.output = options.file ? new ManagedFile("capture", (error, context) => dispatcher.reportFileError(error, context)) : undefined;
    this.hash = options.file && options.computeSha256 ? createHash("sha256") : undefined;
    this.queueSettings = queueOptions(options);
    this.mirrorTargets = options.mirrorTargets ?? defaultMirrorTargets;
    this.fileMode = options.fileMode ?? "truncate";
    this.consumerPolicy = options.consumerErrorPolicy ?? "fail";
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.lineOverflowPolicy = options.lineOverflowPolicy ?? "split";
    this.done = new Promise<StreamCaptureResult>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.done.catch(() => undefined);
    this.dataListener = (chunk) => this.receive(chunk);
    this.endListener = () => { void this.finish("end"); };
    this.closeListener = () => { void this.finish("end"); };
    this.errorListener = (error) => { void this.fail(this.makeError("CAPTURE_SOURCE_ERROR", error, "error")); };
    this.abortListener = () => { void this.abort("Capture aborted by AbortSignal").catch(() => undefined); };
    source.on("data", this.dataListener);
    source.once("end", this.endListener);
    source.once("close", this.closeListener);
    source.once("error", this.errorListener);
    options.signal?.addEventListener("abort", this.abortListener, { once: true });
    dispatcher.addCapture(this);
    if (options.signal?.aborted) this.abortListener();
  }

  mark(label: string, metadata?: LogMetadata): void { this.binding.event("capture.mark", { label, ...(metadata ?? {}) }); }
  async flush(): Promise<void> {
    await this.work;
    await this.output?.flush();
    if (this.failure) await this.failure;
  }
  async close(): Promise<StreamCaptureResult> { await this.finish("manual-close"); return this.done; }
  async abort(reason = "Capture aborted"): Promise<never> {
    await this.fail(this.makeError("CAPTURE_ABORTED", new Error(reason), "aborted"));
    return this.done as never;
  }
  async closeForLogger(): Promise<void> { await this.finish("logger-close"); }

  private receive(chunk: Buffer | string): void {
    if (this.state !== "active") return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, this.options.encoding);
    this.bytes += buffer.length;
    this.chunks += 1;
    const decoded = this.decoder.write(buffer);
    this.enqueue(buffer.length, async () => this.processDecoded(decoded, false, new Date()));
  }

  private enqueue(bytes: number, task: () => Promise<void>): void {
    if (this.state === "settled") return;
    this.pendingBytes += bytes;
    if (this.pendingBytes > this.queueSettings.maxPendingBytes) {
      void this.fail(this.makeError("CAPTURE_BUFFER_OVERFLOW", new Error(`Capture queued data exceeded ${this.queueSettings.maxPendingBytes} bytes`), "error"));
      return;
    }
    if (this.pendingBytes >= this.queueSettings.highWaterMarkBytes && !this.paused && !this.source.destroyed) {
      this.source.pause();
      this.paused = true;
    }
    const next = this.work.then(task, task);
    this.work = next.then(
      () => this.afterTask(bytes),
      (reason: unknown) => {
        this.afterTask(bytes);
        const error = reason instanceof ConsumerFailure ? this.makeError("CAPTURE_CONSUMER_ERROR", reason.original, "error") : reason instanceof LineOverflowFailure ? this.makeError("CAPTURE_LINE_TOO_LONG", reason.original, "error") : this.makeError("CAPTURE_FILE_ERROR", toError(reason), "error");
        void this.fail(error);
      },
    );
  }

  private afterTask(bytes: number): void {
    this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
    if (this.paused && this.pendingBytes <= this.queueSettings.lowWaterMarkBytes && this.state === "active" && !this.source.destroyed) {
      this.paused = false;
      this.source.resume();
    }
  }

  private async processDecoded(text: string, final: boolean, timestamp: Date): Promise<void> {
    if (this.options.file && !this.options.timestampLines && text) await this.writeFile(this.options.stripAnsiInFile ? this.dispatcher.toolkit.stripAnsi(text) : text);
    this.lineBuffer += text;
    while (true) {
      const newline = this.lineBuffer.indexOf("\n");
      if (newline < 0) break;
      const raw = this.lineBuffer.slice(0, newline + 1);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      const value = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.slice(0, -1);
      const wasDiscarding = this.discardingLongLine;
      this.discardingLongLine = false;
      if (wasDiscarding) continue;
      await this.emitLine(value, true, timestamp, raw);
    }
    await this.enforceLineLimit(timestamp);
    if (final && this.lineBuffer) {
      const value = this.lineBuffer;
      this.lineBuffer = "";
      this.discardingLongLine = false;
      await this.emitLine(value, false, timestamp, value);
    }
  }

  private async enforceLineLimit(timestamp: Date): Promise<void> {
    while (Buffer.byteLength(this.lineBuffer) > this.maxLineBytes) {
      if (this.lineOverflowPolicy === "error") throw new LineOverflowFailure(new Error(`Capture line exceeded ${this.maxLineBytes} bytes`));
      const prefix = takePrefix(this.lineBuffer, this.maxLineBytes);
      this.lineBuffer = this.lineBuffer.slice(prefix.length);
      if (this.lineOverflowPolicy === "truncate") {
        if (!this.discardingLongLine) {
          this.discardingLongLine = true;
          await this.emitLine(`${prefix}…`, false, timestamp, prefix);
        }
        return;
      }
      await this.emitLine(prefix, false, timestamp, prefix);
    }
  }

  private async emitLine(value: string, terminated: boolean, timestamp: Date, raw: string): Promise<void> {
    this.lines += 1;
    if (this.options.file && this.options.timestampLines) {
      const fileValue = `[${this.dispatcher.toolkit.formatTime(undefined, timestamp)}] ${this.options.stripAnsiInFile ? this.dispatcher.toolkit.stripAnsi(raw) : raw}`;
      await this.writeFile(fileValue);
    }
    if (this.displayLevel !== "none") this.binding.write(this.displayLevel, [value], this.mirrorTargets);
    if (!this.options.onLine) return;
    try { await this.options.onLine(asLine(value, terminated, this.lines, timestamp)); }
    catch (reason) {
      if (this.consumerPolicy === "ignore") return;
      throw new ConsumerFailure(toError(reason));
    }
  }

  private async writeFile(value: string): Promise<void> {
    if (!value || !this.output || !this.options.file) return;
    const buffer = Buffer.from(value, this.options.encoding);
    this.hash?.update(buffer);
    await this.output.write(this.options.file, buffer, this.fileMode);
  }

  private async finish(reason: "end" | "manual-close" | "logger-close"): Promise<void> {
    if (this.state !== "active") return this.done.then(() => undefined, () => undefined);
    // A readable can have accepted bytes that have not yet emitted `data` when
    // logger.close() starts. Drain those bytes before detaching its listener.
    this.drainReadable();
    this.state = "finishing";
    this.detachSource();
    const rest = this.decoder.end();
    this.enqueue(Buffer.byteLength(rest, this.options.encoding), async () => this.processDecoded(rest, true, new Date()));
    try {
      await this.work;
      await this.output?.close();
      if (this.failure) return this.failure;
      this.settleSuccess({ ...resultBase(this.startedAt, reason, this.bytes, this.options.file), encoding: this.options.encoding, chunks: this.chunks, lines: this.lines, sha256: this.hash?.digest("hex") });
    } catch (reason) {
      await this.fail(this.makeError("CAPTURE_FILE_ERROR", toError(reason), "error"));
    }
  }

  private makeError(code: CaptureErrorCode, cause: Error, reason: CaptureEndReason): CaptureError {
    return new CaptureError(code, cause.message, resultBase(this.startedAt, reason, this.bytes, this.options.file), cause);
  }
  private settleSuccess(result: StreamCaptureResult): void {
    if (this.state === "settled") return;
    this.state = "settled";
    this.detach();
    this.dispatcher.removeCapture(this);
    this.resolve(result);
  }
  private fail(error: CaptureError): Promise<void> {
    if (!this.failure) this.failure = this.finalizeFailure(error);
    return this.failure;
  }
  private async finalizeFailure(error: CaptureError): Promise<void> {
    if (this.state === "settled") return;
    this.state = "finishing";
    this.detachSource();
    await this.output?.close().catch(() => undefined);
    this.state = "settled";
    this.detach();
    this.dispatcher.removeCapture(this);
    this.reject(error);
  }
  private detachSource(): void {
    this.source.removeListener("data", this.dataListener);
    this.source.removeListener("end", this.endListener);
    this.source.removeListener("close", this.closeListener);
    this.source.removeListener("error", this.errorListener);
    if (!this.source.destroyed) this.source.pause();
  }
  private drainReadable(): void {
    let chunk: Buffer | string | null;
    while ((chunk = this.source.read()) !== null) this.receive(chunk);
  }
  private detach(): void { this.detachSource(); this.options.signal?.removeEventListener("abort", this.abortListener); }
}

class BinaryCapture implements BinaryStreamCaptureHandle {
  readonly done: Promise<BinaryCaptureResult>;
  private resolve!: (result: BinaryCaptureResult) => void;
  private reject!: (error: CaptureError) => void;
  private readonly startedAt = new Date();
  private readonly output: ManagedFile;
  private readonly hash: Hash | undefined;
  private readonly queueSettings: QueueOptions;
  private readonly fileMode: CaptureFileMode;
  private state: CaptureState = "active";
  private work: Promise<void> = Promise.resolve();
  private failure: Promise<void> | undefined;
  private bytes = 0;
  private chunks = 0;
  private pendingBytes = 0;
  private paused = false;
  private readonly dataListener: (chunk: Buffer | string) => void;
  private readonly endListener: () => void;
  private readonly closeListener: () => void;
  private readonly errorListener: (error: Error) => void;
  private readonly abortListener: () => void;

  constructor(private readonly source: Readable, private readonly options: Required<Pick<BinaryCaptureOptions, "computeSha256">> & BinaryCaptureOptions, private readonly dispatcher: Dispatcher) {
    this.output = new ManagedFile("capture", (error, context) => dispatcher.reportFileError(error, context));
    this.hash = options.computeSha256 ? createHash("sha256") : undefined;
    this.queueSettings = queueOptions(options);
    this.fileMode = options.fileMode ?? "truncate";
    this.done = new Promise<BinaryCaptureResult>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.done.catch(() => undefined);
    this.dataListener = (chunk) => this.receive(chunk);
    this.endListener = () => { void this.finish("end"); };
    this.closeListener = () => { void this.finish("end"); };
    this.errorListener = (error) => { void this.fail(this.makeError("CAPTURE_SOURCE_ERROR", error, "error")); };
    this.abortListener = () => { void this.abort("Capture aborted by AbortSignal").catch(() => undefined); };
    source.on("data", this.dataListener); source.once("end", this.endListener); source.once("close", this.closeListener); source.once("error", this.errorListener);
    options.signal?.addEventListener("abort", this.abortListener, { once: true });
    dispatcher.addCapture(this);
    if (options.signal?.aborted) this.abortListener();
  }

  async flush(): Promise<void> { await this.work; await this.output.flush(); if (this.failure) await this.failure; }
  async close(): Promise<BinaryCaptureResult> { await this.finish("manual-close"); return this.done; }
  async abort(reason = "Capture aborted"): Promise<never> { await this.fail(this.makeError("CAPTURE_ABORTED", new Error(reason), "aborted")); return this.done as never; }
  async closeForLogger(): Promise<void> { await this.finish("logger-close"); }

  private receive(chunk: Buffer | string): void {
    if (this.state !== "active") return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes += data.length; this.chunks += 1; this.hash?.update(data);
    this.pendingBytes += data.length;
    if (this.pendingBytes > this.queueSettings.maxPendingBytes) { void this.fail(this.makeError("CAPTURE_BUFFER_OVERFLOW", new Error(`Capture queued data exceeded ${this.queueSettings.maxPendingBytes} bytes`), "error")); return; }
    if (this.pendingBytes >= this.queueSettings.highWaterMarkBytes && !this.paused && !this.source.destroyed) { this.source.pause(); this.paused = true; }
    const write = this.work.then(() => this.output.write(this.options.file, data, this.fileMode), () => this.output.write(this.options.file, data, this.fileMode));
    this.work = write.then(
      () => this.afterWrite(data.length),
      (reason: unknown) => { this.afterWrite(data.length); void this.fail(this.makeError("CAPTURE_FILE_ERROR", toError(reason), "error")); },
    );
  }
  private afterWrite(bytes: number): void { this.pendingBytes = Math.max(0, this.pendingBytes - bytes); if (this.paused && this.pendingBytes <= this.queueSettings.lowWaterMarkBytes && this.state === "active" && !this.source.destroyed) { this.paused = false; this.source.resume(); } }
  private async finish(reason: "end" | "manual-close" | "logger-close"): Promise<void> {
    if (this.state !== "active") return this.done.then(() => undefined, () => undefined);
    this.state = "finishing"; this.detachSource();
    try { await this.work; await this.output.close(); if (this.failure) return this.failure; this.settleSuccess({ ...resultBase(this.startedAt, reason, this.bytes, this.options.file), chunks: this.chunks, sha256: this.hash?.digest("hex") }); }
    catch (failure) { await this.fail(this.makeError("CAPTURE_FILE_ERROR", toError(failure), "error")); }
  }
  private makeError(code: CaptureErrorCode, cause: Error, reason: CaptureEndReason): CaptureError { return new CaptureError(code, cause.message, resultBase(this.startedAt, reason, this.bytes, this.options.file), cause); }
  private settleSuccess(result: BinaryCaptureResult): void { if (this.state === "settled") return; this.state = "settled"; this.detach(); this.dispatcher.removeCapture(this); this.resolve(result); }
  private fail(error: CaptureError): Promise<void> { if (!this.failure) this.failure = this.finalizeFailure(error); return this.failure; }
  private async finalizeFailure(error: CaptureError): Promise<void> { if (this.state === "settled") return; this.state = "finishing"; this.detachSource(); await this.output.close().catch(() => undefined); this.state = "settled"; this.detach(); this.dispatcher.removeCapture(this); this.reject(error); }
  private detachSource(): void { this.source.removeListener("data", this.dataListener); this.source.removeListener("end", this.endListener); this.source.removeListener("close", this.closeListener); this.source.removeListener("error", this.errorListener); if (!this.source.destroyed) this.source.pause(); }
  private detach(): void { this.detachSource(); this.options.signal?.removeEventListener("abort", this.abortListener); }
}

class ProcessCapture implements ProcessCaptureHandle {
  readonly done: Promise<ProcessCaptureResult>;
  private resolve!: (result: ProcessCaptureResult) => void;
  private reject!: (error: CaptureError) => void;
  private readonly startedAt = new Date();
  private readonly stdout: ProcessChannel;
  private readonly stderr: ProcessChannel;
  private state: CaptureState = "active";
  private failure: Promise<void> | undefined;
  private exitCode: number | null | undefined;
  private exitSignal: NodeJS.Signals | null | undefined;
  private readonly closeListener: (code: number | null, signal: NodeJS.Signals | null) => void;
  private readonly errorListener: (error: Error) => void;
  private readonly abortListener: () => void;

  constructor(private readonly child: ChildProcess, private readonly options: Required<Pick<ProcessCaptureOptions, "preserveRawBytes" | "stripAnsiInFiles" | "encoding" | "computeSha256">> & ProcessCaptureOptions, private readonly dispatcher: Dispatcher, binding: CaptureLoggerBinding) {
    this.done = new Promise<ProcessCaptureResult>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.done.catch(() => undefined);
    const failChannel = (channel: "stdout" | "stderr", error: CaptureError) => { void this.fail(this.withChannel(error, channel)); };
    this.stdout = new ProcessChannel("stdout", child.stdout, options.stdoutFile, options, normalizeCaptureDisplayLevel(options.stdoutDisplay), dispatcher, binding, failChannel);
    this.stderr = new ProcessChannel("stderr", child.stderr, options.stderrFile, options, normalizeCaptureDisplayLevel(options.stderrDisplay), dispatcher, binding, failChannel);
    this.closeListener = (code, signal) => { void this.complete(code, signal); };
    this.errorListener = (error) => { void this.fail(this.makeError("CAPTURE_SOURCE_ERROR", error, "error")); };
    this.abortListener = () => { void this.abort("Process capture aborted by AbortSignal").catch(() => undefined); };
    child.once("close", this.closeListener); child.once("error", this.errorListener);
    options.signal?.addEventListener("abort", this.abortListener, { once: true });
    dispatcher.addCapture(this);
    if (options.signal?.aborted) this.abortListener();
  }

  async flush(): Promise<void> { await Promise.all([this.stdout.flush(), this.stderr.flush()]); if (this.failure) await this.failure; }
  async abort(reason = "Process capture aborted"): Promise<never> {
    if (this.options.killProcessOnAbort && !this.child.killed) this.child.kill(this.options.killSignal);
    await this.fail(this.makeError("CAPTURE_ABORTED", new Error(reason), "aborted"));
    return this.done as never;
  }
  async closeForLogger(): Promise<void> { if (this.state === "active") await this.fail(this.makeError("CAPTURE_ABORTED_BY_LOGGER_CLOSE", new Error("Process capture was aborted because RLog closed"), "logger-close")); }

  private async complete(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.state !== "active") return;
    this.exitCode = code;
    this.exitSignal = signal;
    this.state = "finishing";
    this.detachChild();
    try {
      await Promise.all([this.stdout.finish(), this.stderr.finish()]);
      if (this.failure) return this.failure;
      const endedAt = new Date();
      this.settleSuccess({ exitCode: code, signal, stdoutBytes: this.stdout.bytes, stderrBytes: this.stderr.bytes, stdoutSha256: this.stdout.digest(), stderrSha256: this.stderr.digest(), startedAt: this.startedAt, endedAt, durationMs: endedAt.valueOf() - this.startedAt.valueOf(), reason: "process-close" });
    } catch (reason) { await this.fail(this.makeError("CAPTURE_FILE_ERROR", toError(reason), "error")); }
  }
  private partial(reason: CaptureEndReason, channel?: "stdout" | "stderr" | "process") {
    const endedAt = new Date();
    return { reason, startedAt: this.startedAt, endedAt, durationMs: endedAt.valueOf() - this.startedAt.valueOf(), exitCode: this.exitCode, signal: this.exitSignal, stdoutBytes: this.stdout.bytes, stderrBytes: this.stderr.bytes, stdoutLines: this.stdout.lines, stderrLines: this.stderr.lines, stdoutFile: this.options.stdoutFile, stderrFile: this.options.stderrFile, stdoutSha256: this.stdout.digest(), stderrSha256: this.stderr.digest(), failedChannel: channel };
  }
  private makeError(code: CaptureErrorCode, cause: Error, reason: CaptureEndReason): CaptureError { return new CaptureError(code, cause.message, this.partial(reason, "process"), cause); }
  private withChannel(error: CaptureError, channel: "stdout" | "stderr"): CaptureError { return new CaptureError(error.code, error.message, { ...this.partial(error.partialResult.reason, channel), ...error.partialResult, failedChannel: channel }, error.cause); }
  private settleSuccess(result: ProcessCaptureResult): void { if (this.state === "settled") return; this.state = "settled"; this.detach(); this.dispatcher.removeCapture(this); this.resolve(result); }
  private fail(error: CaptureError): Promise<void> { if (!this.failure) this.failure = this.finalizeFailure(error); return this.failure; }
  private async finalizeFailure(error: CaptureError): Promise<void> { if (this.state === "settled") return; this.state = "finishing"; this.detachChild(); await Promise.all([this.stdout.abort(), this.stderr.abort()]); this.state = "settled"; this.detach(); this.dispatcher.removeCapture(this); this.reject(error); }
  private detachChild(): void { this.child.removeListener("close", this.closeListener); this.child.removeListener("error", this.errorListener); }
  private detach(): void { this.detachChild(); this.options.signal?.removeEventListener("abort", this.abortListener); }
}

class ProcessChannel {
  bytes = 0;
  lines = 0;
  private readonly file: ManagedFile | undefined;
  private readonly hash: Hash | undefined;
  private readonly decoder: StringDecoder;
  private readonly queueSettings: QueueOptions;
  private readonly fileMode: CaptureFileMode;
  private readonly mirrorTargets: LogTargets;
  private readonly consumerPolicy: CaptureConsumerErrorPolicy;
  private readonly maxLineBytes: number;
  private readonly lineOverflowPolicy: CaptureLineOverflowPolicy;
  private work: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private paused = false;
  private accepting = true;
  private lineBuffer = "";
  private discardingLongLine = false;
  private readonly dataListener: (chunk: Buffer | string) => void;
  private readonly errorListener: (error: Error) => void;

  constructor(
    private readonly channel: "stdout" | "stderr",
    private readonly source: Readable | null,
    private readonly filePath: string | undefined,
    private readonly options: Required<Pick<ProcessCaptureOptions, "preserveRawBytes" | "stripAnsiInFiles" | "encoding" | "computeSha256">> & ProcessCaptureOptions,
    private readonly displayLevel: CaptureDisplayLevel,
    private readonly dispatcher: Dispatcher,
    private readonly binding: CaptureLoggerBinding,
    private readonly onFailure: (channel: "stdout" | "stderr", error: CaptureError) => void,
  ) {
    this.file = filePath ? new ManagedFile("capture", (error, context) => dispatcher.reportFileError(error, context)) : undefined;
    this.hash = filePath && options.computeSha256 ? createHash("sha256") : undefined;
    this.decoder = new StringDecoder(options.encoding);
    this.queueSettings = queueOptions(options);
    this.fileMode = options.fileMode ?? "truncate";
    this.mirrorTargets = options.mirrorTargets ?? defaultMirrorTargets;
    this.consumerPolicy = options.consumerErrorPolicy ?? "fail";
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.lineOverflowPolicy = options.lineOverflowPolicy ?? "split";
    this.dataListener = (chunk) => this.receive(chunk);
    this.errorListener = (error) => this.onFailure(this.channel, this.makeError("CAPTURE_SOURCE_ERROR", error, "error"));
    source?.on("data", this.dataListener);
    source?.once("error", this.errorListener);
  }
  private receive(chunk: Buffer | string): void {
    if (!this.accepting) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, this.options.encoding);
    this.bytes += data.length;
    const text = this.decoder.write(data);
    this.enqueue(data.length, async () => {
      if (this.filePath) {
        const value = this.options.preserveRawBytes ? data : Buffer.from(this.options.stripAnsiInFiles ? this.dispatcher.toolkit.stripAnsi(text) : text, this.options.encoding);
        await this.writeFile(value);
      }
      await this.processLines(text, false, new Date());
    });
  }
  private enqueue(bytes: number, task: () => Promise<void>): void {
    this.pendingBytes += bytes;
    if (this.pendingBytes > this.queueSettings.maxPendingBytes) { this.onFailure(this.channel, this.makeError("CAPTURE_BUFFER_OVERFLOW", new Error(`Capture queued data exceeded ${this.queueSettings.maxPendingBytes} bytes`), "error")); return; }
    if (this.pendingBytes >= this.queueSettings.highWaterMarkBytes && !this.paused && !this.source?.destroyed) { this.source?.pause(); this.paused = true; }
    const next = this.work.then(task, task);
    this.work = next.then(
      () => this.afterTask(bytes),
      (reason: unknown) => { this.afterTask(bytes); const code: CaptureErrorCode = reason instanceof ConsumerFailure ? "CAPTURE_CONSUMER_ERROR" : reason instanceof LineOverflowFailure ? "CAPTURE_LINE_TOO_LONG" : "CAPTURE_FILE_ERROR"; const cause = reason instanceof ConsumerFailure || reason instanceof LineOverflowFailure ? reason.original : toError(reason); this.onFailure(this.channel, this.makeError(code, cause, "error")); },
    );
  }
  private afterTask(bytes: number): void { this.pendingBytes = Math.max(0, this.pendingBytes - bytes); if (this.paused && this.pendingBytes <= this.queueSettings.lowWaterMarkBytes && this.accepting && !this.source?.destroyed) { this.paused = false; this.source?.resume(); } }
  private async processLines(text: string, final: boolean, timestamp: Date): Promise<void> {
    this.lineBuffer += text;
    while (true) {
      const newline = this.lineBuffer.indexOf("\n"); if (newline < 0) break;
      const raw = this.lineBuffer.slice(0, newline + 1); this.lineBuffer = this.lineBuffer.slice(newline + 1);
      const value = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.slice(0, -1); const wasDiscarding = this.discardingLongLine; this.discardingLongLine = false;
      if (wasDiscarding) continue;
      await this.emitLine(value, true, timestamp);
    }
    while (Buffer.byteLength(this.lineBuffer) > this.maxLineBytes) {
      if (this.lineOverflowPolicy === "error") throw new LineOverflowFailure(new Error(`Capture line exceeded ${this.maxLineBytes} bytes`));
      const prefix = takePrefix(this.lineBuffer, this.maxLineBytes); this.lineBuffer = this.lineBuffer.slice(prefix.length);
      if (this.lineOverflowPolicy === "truncate") { if (!this.discardingLongLine) { this.discardingLongLine = true; await this.emitLine(`${prefix}…`, false, timestamp); } return; }
      await this.emitLine(prefix, false, timestamp);
    }
    if (final && this.lineBuffer) { const value = this.lineBuffer; this.lineBuffer = ""; this.discardingLongLine = false; await this.emitLine(value, false, timestamp); }
  }
  private async emitLine(value: string, terminated: boolean, timestamp: Date): Promise<void> {
    this.lines += 1;
    if (this.displayLevel !== "none") this.binding.write(this.displayLevel, [value], this.mirrorTargets);
    const listener = this.options.onLine ?? (this.channel === "stdout" ? this.options.onStdoutLine : this.options.onStderrLine);
    if (!listener) return;
    try { await listener({ ...asLine(value, terminated, this.lines, timestamp), channel: this.channel }); }
    catch (reason) { if (this.consumerPolicy === "ignore") return; throw new ConsumerFailure(toError(reason)); }
  }
  private async writeFile(value: Buffer): Promise<void> { if (!this.file || !this.filePath || !value.length) return; this.hash?.update(value); await this.file.write(this.filePath, value, this.fileMode); }
  async flush(): Promise<void> { await this.work; await this.file?.flush(); }
  async finish(): Promise<void> { this.accepting = false; this.detach(); const rest = this.decoder.end(); this.enqueue(Buffer.byteLength(rest, this.options.encoding), async () => { if (rest && this.filePath && !this.options.preserveRawBytes) await this.writeFile(Buffer.from(this.options.stripAnsiInFiles ? this.dispatcher.toolkit.stripAnsi(rest) : rest, this.options.encoding)); await this.processLines(rest, true, new Date()); }); await this.work; await this.file?.close(); }
  async abort(): Promise<void> { this.accepting = false; this.detach(); await this.work; await this.file?.close(); }
  digest(): string | undefined { return this.hash?.digest("hex"); }
  private makeError(code: CaptureErrorCode, cause: Error, reason: CaptureEndReason): CaptureError { return new CaptureError(code, cause.message, { ...resultBase(new Date(), reason, this.bytes, this.filePath), file: this.filePath, failedChannel: this.channel }, cause); }
  private detach(): void { this.source?.removeListener("data", this.dataListener); this.source?.removeListener("error", this.errorListener); if (!this.source?.destroyed) this.source?.pause(); }
}

function takePrefix(text: string, maxBytes: number): string {
  let end = 0;
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (end > 0 && bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, Math.max(end, 1));
}

export class CaptureManager {
  constructor(private readonly dispatcher: Dispatcher) {}
  stream(source: Readable, options: StreamCaptureOptions, binding: CaptureLoggerBinding): TextStreamCaptureHandle {
    return new TextCapture(source, { encoding: "utf8", stripAnsiInFile: false, timestampLines: false, computeSha256: false, ...options }, this.dispatcher, binding);
  }
  binary(source: Readable, options: BinaryCaptureOptions): BinaryStreamCaptureHandle { return new BinaryCapture(source, { computeSha256: true, ...options }, this.dispatcher); }
  process(child: ChildProcess, options: ProcessCaptureOptions, binding: CaptureLoggerBinding): Promise<ProcessCaptureResult> { return this.processHandle(child, options, binding).done; }
  processHandle(child: ChildProcess, options: ProcessCaptureOptions, binding: CaptureLoggerBinding): ProcessCaptureHandle {
    return new ProcessCapture(child, { preserveRawBytes: false, stripAnsiInFiles: true, encoding: "utf8", computeSha256: false, ...options }, this.dispatcher, binding);
  }
}
