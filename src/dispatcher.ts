import { Config } from "./config";
import { ConsoleSink, JsonlFileSink, TextFileSink, toError, type LogSink } from "./sinks";
import { RLogClosedError } from "./types";
import { Toolkit } from "./toolkit";
import type { FileErrorContext, LogRecord, LogTarget } from "./types";

type State = "open" | "closing" | "closed";

export class Dispatcher {
  readonly toolkit: Toolkit;
  readonly console: ConsoleSink;
  readonly text: TextFileSink;
  readonly jsonl: JsonlFileSink;
  readonly sinks: ReadonlyMap<LogTarget, LogSink>;
  private state: State = "open";
  private readonly pending: LogRecord[] = [];
  private work: Promise<void> = Promise.resolve();
  private screenWork: Promise<void> = Promise.resolve();
  private scheduled = false;
  private sequence = 0;
  private readonly errors: Error[] = [];
  private readonly reportedFileErrors = new WeakSet<Error>();
  private closePromise: Promise<void> | undefined;
  private readonly captures = new Set<{ closeForLogger(): Promise<void>; flush(): Promise<void> }>();

  constructor(readonly config: Config) {
    this.toolkit = new Toolkit(config);
    const report = (error: Error, context: FileErrorContext) => this.reportFileError(error, context);
    this.console = new ConsoleSink(config, this.toolkit);
    this.text = new TextFileSink(config, this.toolkit, report);
    this.jsonl = new JsonlFileSink(config, this.toolkit, report);
    this.sinks = new Map<LogTarget, LogSink>([
      [this.console.target, this.console],
      [this.text.target, this.text],
      [this.jsonl.target, this.jsonl],
    ]);
  }

  nextId(): number { this.sequence += 1; return this.sequence; }
  assertOpen(): void { if (this.state !== "open") throw new RLogClosedError(); }

  enqueue(record: LogRecord): void {
    this.assertOpen();
    // The default screen format does not include metadata, so it is safe to
    // retain 2.1's synchronous terminal behavior while file/JSONL waits one
    // microtask for a chained .meta() call.
    if (this.config.screenMetadataOutput === "none" && (record.targets === "all" || record.targets.has("screen"))) {
      record.screenWritten = true;
      const write = this.console.write(record).catch((reason: unknown) => {
        this.pushDeferredError(toError(reason));
      });
      this.screenWork = Promise.all([this.screenWork, write]).then(() => undefined);
    }
    this.pending.push(record);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => { this.scheduled = false; this.commitPending(); });
    }
  }

  private commitPending(): void {
    const records = this.pending.splice(0);
    for (const record of records) {
      record.committed = true;
      this.work = this.work.then(() => this.dispatch(record)).catch((reason: unknown) => {
        const error = toError(reason);
        if (!this.reportedFileErrors.has(error)) this.pushDeferredError(error);
      });
    }
  }

  private async dispatch(record: LogRecord): Promise<void> {
    let firstError: Error | undefined;
    for (const sink of this.sinks.values()) {
      if (sink.target === "screen" && record.screenWritten) continue;
      try { await sink.write(record); }
      catch (reason) { firstError ??= toError(reason); }
    }
    if (firstError) throw firstError;
  }

  reportFileError(error: Error, context: FileErrorContext): void {
    this.reportedFileErrors.add(error);
    try { this.config.onFileError?.(error, context); } catch (callbackError) { this.pushDeferredError(toError(callbackError)); }
    if (this.config.fileErrorPolicy === "stderr") process.stderr.write(`RLog file error (${context.operation}, ${context.output}): ${error.message}\n`);
    if (this.config.fileErrorPolicy === "throw") this.pushDeferredError(error);
  }

  private captureFileError(error: Error): void {
    if (this.config.fileErrorPolicy === "throw") this.pushDeferredError(error);
  }

  private pushDeferredError(error: Error): void {
    if (!this.errors.includes(error)) this.errors.push(error);
  }

  async flush(): Promise<void> {
    this.commitPending();
    await this.work;
    await this.screenWork;
    const outcomes = await Promise.allSettled([
      ...[...this.captures].map((capture) => capture.flush()),
      ...[...this.sinks.values()].map((sink) => sink.flush()),
    ]);
    for (const outcome of outcomes) if (outcome.status === "rejected") this.captureFileError(toError(outcome.reason));
    this.throwDeferredErrors();
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closing";
    const captures = await Promise.allSettled([...this.captures].map((capture) => capture.closeForLogger()));
    for (const outcome of captures) if (outcome.status === "rejected") this.captureFileError(toError(outcome.reason));
    this.commitPending();
    await this.work;
    await this.screenWork;
    const outcomes = await Promise.allSettled([...this.sinks.values()].map((sink) => sink.close()));
    for (const outcome of outcomes) if (outcome.status === "rejected") this.captureFileError(toError(outcome.reason));
    this.state = "closed";
    this.throwDeferredErrors();
  }

  async progress(num: number, max: number): Promise<void> { this.assertOpen(); await this.console.progress(num, max); }
  addCapture(capture: { closeForLogger(): Promise<void>; flush(): Promise<void> }): void { this.captures.add(capture); }
  removeCapture(capture: { closeForLogger(): Promise<void>; flush(): Promise<void> }): void { this.captures.delete(capture); }

  private throwDeferredErrors(): void {
    if (!this.errors.length) return;
    const errors = this.errors.splice(0);
    if (errors.length === 1) throw errors[0];
    const combined = new Error(`RLog encountered ${errors.length} file write errors: ${errors.map((error) => error.message).join("; ")}`);
    combined.name = "RLogWriteError";
    throw combined;
  }
}
