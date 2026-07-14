import { createHash, type Hash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { Dispatcher } from "./dispatcher";
import { normalizeLevel } from "./levels";
import { ManagedFile, toError } from "./sinks";
import type { BinaryCaptureOptions, BinaryCaptureResult, BinaryStreamCaptureHandle, CaptureEndReason, ProcessCaptureOptions, ProcessCaptureResult, StreamCaptureOptions, StreamCaptureResult, TextStreamCaptureHandle } from "./types";
import { CaptureError } from "./types";

type Display = (level: ReturnType<typeof normalizeLevel>, line: string) => void;
type EventWriter = (type: string, data?: Record<string, unknown>) => void;

function nowResult(startedAt: Date, reason: CaptureEndReason, bytes: number, file?: string) {
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
  private work: Promise<void> = Promise.resolve();
  private ended = false;
  private bytes = 0;
  private chunks = 0;
  private lines = 0;
  private displayBuffer = "";
  private fileBuffer = "";
  private readonly dataListener: (chunk: Buffer | string) => void;
  private readonly endListener: () => void;
  private readonly closeListener: () => void;
  private readonly errorListener: (error: Error) => void;

  constructor(private readonly source: Readable, private readonly options: Required<Pick<StreamCaptureOptions, "encoding" | "displayLevel" | "stripAnsiInFile" | "timestampLines" | "computeSha256">> & StreamCaptureOptions, private readonly dispatcher: Dispatcher, private readonly display: Display, private readonly event: EventWriter) {
    this.decoder = new StringDecoder(options.encoding);
    this.output = options.file ? new ManagedFile("capture", (error, context) => dispatcher.reportFileError(error, context)) : undefined;
    this.hash = options.file && options.computeSha256 ? createHash("sha256") : undefined;
    this.done = new Promise<StreamCaptureResult>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.done.catch(() => undefined);
    this.dataListener = (chunk) => this.receive(chunk);
    this.endListener = () => this.complete("end");
    this.closeListener = () => this.complete("end");
    this.errorListener = (error) => this.fail("CAPTURE_SOURCE_ERROR", error, "error");
    source.on("data", this.dataListener); source.once("end", this.endListener); source.once("close", this.closeListener); source.once("error", this.errorListener);
    dispatcher.addCapture(this);
  }

  mark(label: string, metadata?: Record<string, unknown>): void { this.event("capture.mark", { label, ...(metadata ?? {}) }); }
  async flush(): Promise<void> { await this.work; await this.output?.flush(); }
  async close(): Promise<StreamCaptureResult> { await this.complete("manual-close"); return this.done; }
  async closeForLogger(): Promise<void> { await this.complete("logger-close"); }

  private receive(chunk: Buffer | string): void {
    if (this.ended) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, this.options.encoding);
    this.bytes += buffer.length; this.chunks += 1;
    const text = this.decoder.write(buffer);
    this.consume(text);
  }

  private consume(text: string): void {
    this.displayLines(text, false);
    if (!this.options.file) return;
    if (this.options.timestampLines) {
      this.fileBuffer += text;
      const parts = this.fileBuffer.split(/(\r?\n)/);
      this.fileBuffer = parts.pop() ?? "";
      for (let index = 0; index + 1 < parts.length; index += 2) {
        const line = `${parts[index]}${parts[index + 1]}`;
        this.queueFile(`[${this.dispatcher.toolkit.formatTime()}] ${this.options.stripAnsiInFile ? this.dispatcher.toolkit.stripAnsi(line) : line}`);
      }
    } else this.queueFile(this.options.stripAnsiInFile ? this.dispatcher.toolkit.stripAnsi(text) : text);
  }

  private displayLines(text: string, final: boolean): void {
    this.displayBuffer += text;
    const lines = this.displayBuffer.split(/\r?\n/);
    this.displayBuffer = final ? "" : lines.pop() ?? "";
    if (final && text === "" && lines.length === 1 && lines[0] === "") return;
    for (const line of lines) {
      if (!line && !final) continue;
      this.lines += 1;
      if (this.options.displayLevel !== "none") this.display(normalizeLevel(this.options.displayLevel), line);
    }
  }

  private queueFile(value: string): void {
    if (!value || !this.output || !this.options.file) return;
    const buffer = Buffer.from(value, this.options.encoding);
    this.hash?.update(buffer);
    this.work = this.work.then(() => this.output!.write(this.options.file!, buffer)).catch((reason: unknown) => {
      this.fail("CAPTURE_FILE_ERROR", toError(reason), "error");
    });
  }

  private async complete(reason: "end" | "manual-close" | "logger-close"): Promise<void> {
    if (this.ended) return this.done.then(() => undefined, () => undefined);
    this.ended = true; this.detach();
    const remaining = this.decoder.end();
    if (remaining) this.consume(remaining);
    if (this.options.timestampLines && this.fileBuffer) this.queueFile(`[${this.dispatcher.toolkit.formatTime()}] ${this.options.stripAnsiInFile ? this.dispatcher.toolkit.stripAnsi(this.fileBuffer) : this.fileBuffer}`);
    this.displayLines("", true);
    try {
      await this.flush(); await this.output?.close();
      const result: StreamCaptureResult = { ...nowResult(this.startedAt, reason, this.bytes, this.options.file), encoding: this.options.encoding, chunks: this.chunks, lines: this.lines, sha256: this.hash?.digest("hex") };
      this.dispatcher.removeCapture(this); this.resolve(result);
    } catch (error) { this.fail("CAPTURE_FILE_ERROR", toError(error), "error"); }
  }

  private fail(code: CaptureError["code"], cause: Error, reason: CaptureEndReason): void {
    if (this.ended && reason !== "error") return;
    this.ended = true; this.detach(); this.dispatcher.removeCapture(this);
    void this.output?.close().catch(() => undefined);
    this.reject(new CaptureError(code, cause.message, nowResult(this.startedAt, reason, this.bytes, this.options.file), cause));
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
  private work: Promise<void> = Promise.resolve(); private ended = false; private bytes = 0; private chunks = 0;
  private readonly dataListener: (chunk: Buffer | string) => void;
  private readonly endListener: () => void;
  private readonly closeListener: () => void;
  private readonly errorListener: (error: Error) => void;
  constructor(private readonly source: Readable, private readonly options: Required<BinaryCaptureOptions>, private readonly dispatcher: Dispatcher) {
    this.output = new ManagedFile("capture", (error, context) => dispatcher.reportFileError(error, context)); this.hash = options.computeSha256 ? createHash("sha256") : undefined;
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); void this.done.catch(() => undefined);
    this.dataListener = (chunk) => { if (!this.ended) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); this.bytes += data.length; this.chunks += 1; this.hash?.update(data); this.work = this.work.then(() => this.output.write(options.file, data)).catch((reason: unknown) => this.fail("CAPTURE_FILE_ERROR", toError(reason))); } };
    this.endListener = () => void this.finish("end"); this.closeListener = () => void this.finish("end"); this.errorListener = (error) => this.fail("CAPTURE_SOURCE_ERROR", error);
    source.on("data", this.dataListener); source.once("end", this.endListener); source.once("close", this.closeListener); source.once("error", this.errorListener); dispatcher.addCapture(this);
  }
  async flush(): Promise<void> { await this.work; await this.output.flush(); }
  async close(): Promise<BinaryCaptureResult> { await this.finish("manual-close"); return this.done; }
  async closeForLogger(): Promise<void> { await this.finish("logger-close"); }
  private async finish(reason: "end" | "manual-close" | "logger-close"): Promise<void> { if (this.ended) return; this.ended = true; this.detach(); try { await this.flush(); await this.output.close(); this.dispatcher.removeCapture(this); this.resolve({ ...nowResult(this.startedAt, reason, this.bytes, this.options.file), chunks: this.chunks, sha256: this.hash?.digest("hex") }); } catch (error) { this.fail("CAPTURE_FILE_ERROR", toError(error)); } }
  private fail(code: CaptureError["code"], cause: Error): void { if (this.ended) return; this.ended = true; this.detach(); this.dispatcher.removeCapture(this); void this.output.close().catch(() => undefined); this.reject(new CaptureError(code, cause.message, nowResult(this.startedAt, "error", this.bytes, this.options.file), cause)); }
  private detach(): void { this.source.removeListener("data", this.dataListener); this.source.removeListener("end", this.endListener); this.source.removeListener("close", this.closeListener); this.source.removeListener("error", this.errorListener); if (!this.source.destroyed) this.source.pause(); }
}

class ProcessCapture {
  private readonly startedAt = new Date(); private readonly stdout: Channel; private readonly stderr: Channel; private readonly promise: Promise<ProcessCaptureResult>;
  private resolve!: (result: ProcessCaptureResult) => void; private reject!: (error: CaptureError) => void; private ended = false;
  private readonly closeListener: (code: number | null, signal: NodeJS.Signals | null) => void;
  private readonly errorListener: (error: Error) => void;
  constructor(private readonly child: ChildProcess, options: Required<Pick<ProcessCaptureOptions, "preserveRawBytes" | "stripAnsiInFiles" | "encoding" | "computeSha256" | "stdoutDisplay" | "stderrDisplay">> & ProcessCaptureOptions, private readonly dispatcher: Dispatcher, display: Display) {
    this.stdout = new Channel(child.stdout, options.stdoutFile, options, options.stdoutDisplay, dispatcher, display, "stdout");
    this.stderr = new Channel(child.stderr, options.stderrFile, options, options.stderrDisplay, dispatcher, display, "stderr");
    this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); void this.promise.catch(() => undefined);
    this.closeListener = (code, signal) => void this.complete(code, signal); this.errorListener = (error) => this.abort("CAPTURE_SOURCE_ERROR", error, "error");
    child.once("close", this.closeListener); child.once("error", this.errorListener); dispatcher.addCapture(this);
  }
  result(): Promise<ProcessCaptureResult> { return this.promise; }
  async flush(): Promise<void> { await Promise.all([this.stdout.flush(), this.stderr.flush()]); }
  async closeForLogger(): Promise<void> { if (this.ended) return; this.ended = true; this.child.removeListener("close", this.closeListener); this.child.removeListener("error", this.errorListener); await Promise.all([this.stdout.abort(), this.stderr.abort()]); this.dispatcher.removeCapture(this); const endedAt = new Date(); this.reject(new CaptureError("CAPTURE_ABORTED_BY_LOGGER_CLOSE", "Process capture was aborted because RLog closed", { reason: "logger-close", startedAt: this.startedAt, endedAt, durationMs: endedAt.valueOf() - this.startedAt.valueOf(), stdoutBytes: this.stdout.bytes, stderrBytes: this.stderr.bytes }, undefined)); }
  private async complete(code: number | null, signal: NodeJS.Signals | null): Promise<void> { if (this.ended) return; this.ended = true; try { await Promise.all([this.stdout.finish(), this.stderr.finish()]); const endedAt = new Date(); this.dispatcher.removeCapture(this); this.resolve({ exitCode: code, signal, stdoutBytes: this.stdout.bytes, stderrBytes: this.stderr.bytes, stdoutSha256: this.stdout.digest(), stderrSha256: this.stderr.digest(), startedAt: this.startedAt, endedAt, durationMs: endedAt.valueOf() - this.startedAt.valueOf(), reason: "process-close" }); } catch (error) { this.abort("CAPTURE_FILE_ERROR", toError(error), "error"); } }
  private abort(code: CaptureError["code"], error: Error, reason: CaptureEndReason): void { if (this.ended) return; this.ended = true; void Promise.all([this.stdout.abort(), this.stderr.abort()]); this.dispatcher.removeCapture(this); const endedAt = new Date(); this.reject(new CaptureError(code, error.message, { reason, startedAt: this.startedAt, endedAt, durationMs: endedAt.valueOf() - this.startedAt.valueOf(), stdoutBytes: this.stdout.bytes, stderrBytes: this.stderr.bytes }, error)); }
}

class Channel {
  bytes = 0; private chunks = 0; private readonly file: ManagedFile | undefined; private readonly hash: Hash | undefined; private decoder: StringDecoder; private work: Promise<void> = Promise.resolve(); private line = ""; private readonly data: (chunk: Buffer) => void;
  constructor(private readonly source: Readable | null, private readonly filePath: string | undefined, private readonly options: Required<Pick<ProcessCaptureOptions, "preserveRawBytes" | "stripAnsiInFiles" | "encoding" | "computeSha256">>, private readonly displayLevel: Required<Pick<ProcessCaptureOptions, "stdoutDisplay">>["stdoutDisplay"], private readonly dispatcher: Dispatcher, private readonly display: Display, _name: string) {
    this.file = filePath ? new ManagedFile("capture", (error, context) => dispatcher.reportFileError(error, context)) : undefined; this.hash = filePath && options.computeSha256 ? createHash("sha256") : undefined; this.decoder = new StringDecoder(options.encoding);
    this.data = (chunk) => this.receive(chunk); source?.on("data", this.data);
  }
  private receive(chunk: Buffer): void { this.bytes += chunk.length; this.chunks += 1; if (this.options.preserveRawBytes) { this.queue(chunk); this.mirror(this.decoder.write(chunk)); return; } const text = this.decoder.write(chunk); this.queue(Buffer.from(this.options.stripAnsiInFiles ? this.dispatcher.toolkit.stripAnsi(text) : text, this.options.encoding)); this.mirror(text); }
  private queue(buffer: Buffer): void { if (!this.file || !this.filePath) return; this.hash?.update(buffer); this.work = this.work.then(() => this.file!.write(this.filePath!, buffer)); }
  private mirror(value: string): void { if (this.displayLevel === "none") return; this.line += value; const parts = this.line.split(/\r?\n/); this.line = parts.pop() ?? ""; for (const part of parts) this.display(normalizeLevel(this.displayLevel), part); }
  async finish(): Promise<void> { const rest = this.decoder.end(); if (rest) { if (!this.options.preserveRawBytes) this.queue(Buffer.from(this.options.stripAnsiInFiles ? this.dispatcher.toolkit.stripAnsi(rest) : rest, this.options.encoding)); this.mirror(rest); } if (this.line && this.displayLevel !== "none") this.display(normalizeLevel(this.displayLevel), this.line); await this.work; await this.file?.close(); this.detach(); }
  async flush(): Promise<void> { await this.work; await this.file?.flush(); }
  async abort(): Promise<void> { this.detach(); this.source?.resume(); await this.work.catch(() => undefined); await this.file?.close().catch(() => undefined); }
  digest(): string | undefined { return this.hash?.digest("hex"); }
  private detach(): void { this.source?.removeListener("data", this.data); }
}

export class CaptureManager {
  constructor(private readonly dispatcher: Dispatcher, private readonly display: Display, private readonly event: EventWriter) {}
  stream(source: Readable, options: StreamCaptureOptions = {}): TextStreamCaptureHandle { return new TextCapture(source, { encoding: "utf8", displayLevel: "none", stripAnsiInFile: false, timestampLines: false, computeSha256: false, ...options }, this.dispatcher, this.display, this.event); }
  binary(source: Readable, options: BinaryCaptureOptions): BinaryStreamCaptureHandle { return new BinaryCapture(source, { computeSha256: true, ...options }, this.dispatcher); }
  process(child: ChildProcess, options: ProcessCaptureOptions = {}): Promise<ProcessCaptureResult> { return new ProcessCapture(child, { preserveRawBytes: false, stripAnsiInFiles: true, encoding: "utf8", computeSha256: false, stdoutDisplay: "none", stderrDisplay: "none", ...options }, this.dispatcher, this.display).result(); }
}
