import { createHash, type Hash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { Dispatcher } from "./dispatcher";
import { normalizeCaptureDisplayLevel, type CaptureDisplayLevel } from "./levels";
import { ManagedFile, toError } from "./sinks";
import type { BinaryCaptureOptions, BinaryCaptureResult, BinaryStreamCaptureHandle, CaptureEndReason, CaptureErrorCode, ProcessCaptureOptions, ProcessCaptureResult, StreamCaptureOptions, StreamCaptureResult, TextStreamCaptureHandle } from "./types";
import { CaptureError } from "./types";

type CaptureState = "active" | "finishing" | "settled";
type Display = (level: CaptureDisplayLevel, line: string) => void;
type EventWriter = (type: string, data?: Record<string, unknown>) => void;

function resultBase(startedAt: Date, reason: CaptureEndReason, bytes: number, file?: string) {
  const endedAt = new Date();
  return { startedAt, endedAt, durationMs: endedAt.valueOf() - startedAt.valueOf(), bytes, reason, file };
}

class TextCapture implements TextStreamCaptureHandle {
  readonly done: Promise<StreamCaptureResult>;
  private resolve!: (result: StreamCaptureResult) => void;
  private reject!: (error: CaptureError) => void;
  private readonly startedAt = new Date();
  private readonly decoder: StringDecoder;
  private readonly output: ManagedFile | undefined;
  private readonly hash: Hash | undefined;
  private readonly displayLevel: CaptureDisplayLevel;
  private state: CaptureState = "active";
  private failurePromise: Promise<void> | undefined;
  private work: Promise<void> = Promise.resolve();
  private bytes = 0;
  private chunks = 0;
  private lines = 0;
  private displayBuffer = "";
  private fileBuffer = "";
  private readonly dataListener: (chunk: Buffer | string) => void;
  private readonly endListener: () => void;
  private readonly closeListener: () => void;
  private readonly errorListener: (error: Error) => void;

  constructor(private readonly source: Readable, private readonly options: Required<Pick<StreamCaptureOptions, "encoding" | "stripAnsiInFile" | "timestampLines" | "computeSha256">> & StreamCaptureOptions, private readonly dispatcher: Dispatcher, private readonly display: Display, private readonly event: EventWriter) {
    this.decoder = new StringDecoder(options.encoding);
    this.displayLevel = normalizeCaptureDisplayLevel(options.displayLevel);
    this.output = options.file ? new ManagedFile("capture", (error, context) => dispatcher.reportFileError(error, context)) : undefined;
    this.hash = options.file && options.computeSha256 ? createHash("sha256") : undefined;
    this.done = new Promise<StreamCaptureResult>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.done.catch(() => undefined);
    this.dataListener = (chunk) => this.receive(chunk);
    this.endListener = () => { void this.finish("end"); };
    this.closeListener = () => { void this.finish("end"); };
    this.errorListener = (error) => { void this.fail(this.makeError("CAPTURE_SOURCE_ERROR", error, "error")); };
    source.on("data", this.dataListener); source.once("end", this.endListener); source.once("close", this.closeListener); source.once("error", this.errorListener);
    dispatcher.addCapture(this);
  }

  mark(label: string, metadata?: Record<string, unknown>): void { this.event("capture.mark", { label, ...(metadata ?? {}) }); }
  async flush(): Promise<void> {
    try { await this.work; await this.output?.flush(); }
    catch (reason) {
      const error = toError(reason);
      await this.fail(this.makeError("CAPTURE_FILE_ERROR", error, "error"));
      throw error;
    }
  }
  async close(): Promise<StreamCaptureResult> { await this.finish("manual-close"); return this.done; }
  async closeForLogger(): Promise<void> { await this.finish("logger-close"); }

  private receive(chunk: Buffer | string): void {
    if (this.state !== "active") return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, this.options.encoding);
    this.bytes += buffer.length; this.chunks += 1;
    this.consume(this.decoder.write(buffer));
  }

  private consume(text: string): void {
    this.displayLines(text, false);
    if (!this.options.file) return;
    if (!this.options.timestampLines) {
      this.queueFile(this.options.stripAnsiInFile ? this.dispatcher.toolkit.stripAnsi(text) : text);
      return;
    }
    this.fileBuffer += text;
    const parts = this.fileBuffer.split(/(\r?\n)/);
    this.fileBuffer = parts.pop() ?? "";
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const line = `${parts[index]}${parts[index + 1]}`;
      this.queueFile(`[${this.dispatcher.toolkit.formatTime()}] ${this.options.stripAnsiInFile ? this.dispatcher.toolkit.stripAnsi(line) : line}`);
    }
  }

  private displayLines(text: string, final: boolean): void {
    this.displayBuffer += text;
    const lines = this.displayBuffer.split(/\r?\n/);
    this.displayBuffer = final ? "" : lines.pop() ?? "";
    if (final && text === "" && lines.length === 1 && lines[0] === "") return;
    for (const line of lines) {
      if (!line && !final) continue;
      this.lines += 1;
      if (this.displayLevel !== "none") this.display(this.displayLevel, line);
    }
  }

  private queueFile(value: string): void {
    if (!value || !this.output || !this.options.file) return;
    const buffer = Buffer.from(value, this.options.encoding);
    this.hash?.update(buffer);
    this.work = this.work.then(() => this.output!.write(this.options.file!, buffer));
    void this.work.catch((reason: unknown) => this.fail(this.makeError("CAPTURE_FILE_ERROR", toError(reason), "error")));
  }

  private async finish(reason: "end" | "manual-close" | "logger-close"): Promise<void> {
    if (this.state !== "active") return this.done.then(() => undefined, () => undefined);
    this.state = "finishing";
    this.detach();
    try {
      const remaining = this.decoder.end();
      if (remaining) this.consume(remaining);
      if (this.options.timestampLines && this.fileBuffer) this.queueFile(`[${this.dispatcher.toolkit.formatTime()}] ${this.options.stripAnsiInFile ? this.dispatcher.toolkit.stripAnsi(this.fileBuffer) : this.fileBuffer}`);
      this.displayLines("", true);
      await this.flush();
      await this.output?.close();
      if (this.failurePromise) return this.failurePromise;
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
    this.detach(); this.dispatcher.removeCapture(this); this.resolve(result);
  }

  private fail(error: CaptureError): Promise<void> {
    if (!this.failurePromise) this.failurePromise = this.finalizeFailure(error);
    return this.failurePromise;
  }

  private async finalizeFailure(error: CaptureError): Promise<void> {
    if (this.state === "settled") return;
    this.state = "finishing";
    this.detach();
    await this.work.catch(() => undefined);
    await this.output?.close().catch(() => undefined);
    this.dispatcher.removeCapture(this);
    this.state = "settled";
    this.reject(error);
  }

  private detach(): void { this.source.removeListener("data", this.dataListener); this.source.removeListener("end", this.endListener); this.source.removeListener("close", this.closeListener); this.source.removeListener("error", this.errorListener); if (!this.source.destroyed) this.source.pause(); }
}

class BinaryCapture implements BinaryStreamCaptureHandle {
  readonly done: Promise<BinaryCaptureResult>;
  private resolve!: (result: BinaryCaptureResult) => void;
  private reject!: (error: CaptureError) => void;
  private readonly startedAt = new Date();
  private readonly output: ManagedFile;
  private readonly hash: Hash | undefined;
  private state: CaptureState = "active";
  private failurePromise: Promise<void> | undefined;
  private work: Promise<void> = Promise.resolve();
  private bytes = 0;
  private chunks = 0;
  private readonly dataListener: (chunk: Buffer | string) => void;
  private readonly endListener: () => void;
  private readonly closeListener: () => void;
  private readonly errorListener: (error: Error) => void;

  constructor(private readonly source: Readable, private readonly options: Required<BinaryCaptureOptions>, private readonly dispatcher: Dispatcher) {
    this.output = new ManagedFile("capture", (error, context) => dispatcher.reportFileError(error, context));
    this.hash = options.computeSha256 ? createHash("sha256") : undefined;
    this.done = new Promise<BinaryCaptureResult>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.done.catch(() => undefined);
    this.dataListener = (chunk) => this.receive(chunk);
    this.endListener = () => { void this.finish("end"); };
    this.closeListener = () => { void this.finish("end"); };
    this.errorListener = (error) => { void this.fail(this.makeError("CAPTURE_SOURCE_ERROR", error)); };
    source.on("data", this.dataListener); source.once("end", this.endListener); source.once("close", this.closeListener); source.once("error", this.errorListener);
    dispatcher.addCapture(this);
  }

  async flush(): Promise<void> {
    try { await this.work; await this.output.flush(); }
    catch (reason) {
      const error = toError(reason);
      await this.fail(this.makeError("CAPTURE_FILE_ERROR", error));
      throw error;
    }
  }
  async close(): Promise<BinaryCaptureResult> { await this.finish("manual-close"); return this.done; }
  async closeForLogger(): Promise<void> { await this.finish("logger-close"); }

  private receive(chunk: Buffer | string): void {
    if (this.state !== "active") return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes += data.length; this.chunks += 1; this.hash?.update(data);
    this.work = this.work.then(() => this.output.write(this.options.file, data));
    void this.work.catch((reason: unknown) => this.fail(this.makeError("CAPTURE_FILE_ERROR", toError(reason))));
  }

  private async finish(reason: "end" | "manual-close" | "logger-close"): Promise<void> {
    if (this.state !== "active") return this.done.then(() => undefined, () => undefined);
    this.state = "finishing";
    this.detach();
    try {
      await this.flush();
      await this.output.close();
      if (this.failurePromise) return this.failurePromise;
      this.settleSuccess({ ...resultBase(this.startedAt, reason, this.bytes, this.options.file), chunks: this.chunks, sha256: this.hash?.digest("hex") });
    } catch (reason) {
      await this.fail(this.makeError("CAPTURE_FILE_ERROR", toError(reason)));
    }
  }

  private makeError(code: CaptureErrorCode, cause: Error): CaptureError { return new CaptureError(code, cause.message, resultBase(this.startedAt, "error", this.bytes, this.options.file), cause); }
  private settleSuccess(result: BinaryCaptureResult): void { if (this.state === "settled") return; this.state = "settled"; this.detach(); this.dispatcher.removeCapture(this); this.resolve(result); }
  private fail(error: CaptureError): Promise<void> { if (!this.failurePromise) this.failurePromise = this.finalizeFailure(error); return this.failurePromise; }
  private async finalizeFailure(error: CaptureError): Promise<void> {
    if (this.state === "settled") return;
    this.state = "finishing";
    this.detach();
    await this.work.catch(() => undefined);
    await this.output.close().catch(() => undefined);
    this.dispatcher.removeCapture(this);
    this.state = "settled";
    this.reject(error);
  }
  private detach(): void { this.source.removeListener("data", this.dataListener); this.source.removeListener("end", this.endListener); this.source.removeListener("close", this.closeListener); this.source.removeListener("error", this.errorListener); if (!this.source.destroyed) this.source.pause(); }
}

class ProcessCapture {
  private readonly startedAt = new Date();
  private readonly stdout: Channel;
  private readonly stderr: Channel;
  private readonly promise: Promise<ProcessCaptureResult>;
  private resolve!: (result: ProcessCaptureResult) => void;
  private reject!: (error: CaptureError) => void;
  private state: CaptureState = "active";
  private failurePromise: Promise<void> | undefined;
  private readonly closeListener: (code: number | null, signal: NodeJS.Signals | null) => void;
  private readonly errorListener: (error: Error) => void;

  constructor(private readonly child: ChildProcess, options: Required<Pick<ProcessCaptureOptions, "preserveRawBytes" | "stripAnsiInFiles" | "encoding" | "computeSha256">> & ProcessCaptureOptions, private readonly dispatcher: Dispatcher, display: Display) {
    this.promise = new Promise<ProcessCaptureResult>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.promise.catch(() => undefined);
    const onChannelFailure = (error: Error) => { void this.fail(this.makeError("CAPTURE_FILE_ERROR", error, "error")); };
    this.stdout = new Channel(child.stdout, options.stdoutFile, options, normalizeCaptureDisplayLevel(options.stdoutDisplay), dispatcher, display, onChannelFailure);
    this.stderr = new Channel(child.stderr, options.stderrFile, options, normalizeCaptureDisplayLevel(options.stderrDisplay), dispatcher, display, onChannelFailure);
    this.closeListener = (code, signal) => { void this.complete(code, signal); };
    this.errorListener = (error) => { void this.fail(this.makeError("CAPTURE_SOURCE_ERROR", error, "error")); };
    child.once("close", this.closeListener); child.once("error", this.errorListener); dispatcher.addCapture(this);
  }

  result(): Promise<ProcessCaptureResult> { return this.promise; }
  async flush(): Promise<void> { await Promise.all([this.stdout.flush(), this.stderr.flush()]); }

  async closeForLogger(): Promise<void> {
    if (this.state !== "active") return this.promise.then(() => undefined, () => undefined);
    await this.fail(this.makeError("CAPTURE_ABORTED_BY_LOGGER_CLOSE", new Error("Process capture was aborted because RLog closed"), "logger-close"));
  }

  private async complete(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.state !== "active") return;
    this.state = "finishing";
    this.detachChild();
    try {
      await Promise.all([this.stdout.finish(), this.stderr.finish()]);
      const endedAt = new Date();
      if (this.failurePromise) return this.failurePromise;
      this.settleSuccess({ exitCode: code, signal, stdoutBytes: this.stdout.bytes, stderrBytes: this.stderr.bytes, stdoutSha256: this.stdout.digest(), stderrSha256: this.stderr.digest(), startedAt: this.startedAt, endedAt, durationMs: endedAt.valueOf() - this.startedAt.valueOf(), reason: "process-close" });
    } catch (reason) {
      await this.fail(this.makeError("CAPTURE_FILE_ERROR", toError(reason), "error"));
    }
  }

  private makeError(code: CaptureErrorCode, cause: Error, reason: CaptureEndReason): CaptureError {
    const endedAt = new Date();
    return new CaptureError(code, cause.message, { reason, startedAt: this.startedAt, endedAt, durationMs: endedAt.valueOf() - this.startedAt.valueOf(), stdoutBytes: this.stdout.bytes, stderrBytes: this.stderr.bytes }, cause);
  }
  private settleSuccess(result: ProcessCaptureResult): void { if (this.state === "settled") return; this.state = "settled"; this.detachChild(); this.dispatcher.removeCapture(this); this.resolve(result); }
  private fail(error: CaptureError): Promise<void> { if (!this.failurePromise) this.failurePromise = this.finalizeFailure(error); return this.failurePromise; }
  private async finalizeFailure(error: CaptureError): Promise<void> {
    if (this.state === "settled") return;
    this.state = "finishing";
    this.detachChild();
    await Promise.all([this.stdout.abort(), this.stderr.abort()]);
    this.dispatcher.removeCapture(this);
    this.state = "settled";
    this.reject(error);
  }
  private detachChild(): void { this.child.removeListener("close", this.closeListener); this.child.removeListener("error", this.errorListener); }
}

class Channel {
  bytes = 0;
  private readonly file: ManagedFile | undefined;
  private readonly hash: Hash | undefined;
  private readonly decoder: StringDecoder;
  private work: Promise<void> = Promise.resolve();
  private line = "";
  private accepting = true;
  private readonly dataListener: (chunk: Buffer | string) => void;

  constructor(private readonly source: Readable | null, private readonly filePath: string | undefined, private readonly options: Required<Pick<ProcessCaptureOptions, "preserveRawBytes" | "stripAnsiInFiles" | "encoding" | "computeSha256">>, private readonly displayLevel: CaptureDisplayLevel, private readonly dispatcher: Dispatcher, private readonly display: Display, private readonly onFailure: (error: Error) => void) {
    this.file = filePath ? new ManagedFile("capture", (error, context) => dispatcher.reportFileError(error, context)) : undefined;
    this.hash = filePath && options.computeSha256 ? createHash("sha256") : undefined;
    this.decoder = new StringDecoder(options.encoding);
    this.dataListener = (chunk) => this.receive(chunk);
    source?.on("data", this.dataListener);
  }

  private receive(chunk: Buffer | string): void {
    if (!this.accepting) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, this.options.encoding);
    this.bytes += data.length;
    if (this.options.preserveRawBytes) { this.queue(data); this.mirror(this.decoder.write(data)); return; }
    const text = this.decoder.write(data);
    this.queue(Buffer.from(this.options.stripAnsiInFiles ? this.dispatcher.toolkit.stripAnsi(text) : text, this.options.encoding));
    this.mirror(text);
  }

  private queue(data: Buffer): void {
    if (!this.file || !this.filePath) return;
    this.hash?.update(data);
    this.work = this.work.then(() => this.file!.write(this.filePath!, data));
    void this.work.catch((reason: unknown) => this.onFailure(toError(reason)));
  }
  private mirror(text: string): void { if (this.displayLevel === "none") return; this.line += text; const lines = this.line.split(/\r?\n/); this.line = lines.pop() ?? ""; for (const line of lines) this.display(this.displayLevel, line); }
  async flush(): Promise<void> {
    try { await this.work; await this.file?.flush(); }
    catch (reason) { const error = toError(reason); this.onFailure(error); throw error; }
  }
  async finish(): Promise<void> { this.accepting = false; const rest = this.decoder.end(); if (rest) { if (!this.options.preserveRawBytes) this.queue(Buffer.from(this.options.stripAnsiInFiles ? this.dispatcher.toolkit.stripAnsi(rest) : rest, this.options.encoding)); this.mirror(rest); } if (this.line && this.displayLevel !== "none") this.display(this.displayLevel, this.line); await this.flush(); await this.file?.close(); this.detach(); }
  async abort(): Promise<void> { this.accepting = false; this.detach(); this.source?.resume(); await this.work.catch(() => undefined); await this.file?.close().catch(() => undefined); }
  digest(): string | undefined { return this.hash?.digest("hex"); }
  private detach(): void { this.source?.removeListener("data", this.dataListener); }
}

export class CaptureManager {
  constructor(private readonly dispatcher: Dispatcher, private readonly display: Display, private readonly event: EventWriter) {}
  stream(source: Readable, options: StreamCaptureOptions = {}): TextStreamCaptureHandle { return new TextCapture(source, { encoding: "utf8", stripAnsiInFile: false, timestampLines: false, computeSha256: false, ...options }, this.dispatcher, this.display, this.event); }
  binary(source: Readable, options: BinaryCaptureOptions): BinaryStreamCaptureHandle { return new BinaryCapture(source, { computeSha256: true, ...options }, this.dispatcher); }
  process(child: ChildProcess, options: ProcessCaptureOptions = {}): Promise<ProcessCaptureResult> { return new ProcessCapture(child, { preserveRawBytes: false, stripAnsiInFiles: true, encoding: "utf8", computeSha256: false, ...options }, this.dispatcher, this.display).result(); }
}
