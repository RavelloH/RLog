import { Config } from "./config";
import { FlightRecorder } from "./flight-recorder";
import { ConsoleSink, JsonlFileSink, TextFileSink, toError, type LogSink } from "./sinks";
import { RLogClosedError, RLogQueueFullError, RLogQueueBytesExceededError, RLogRecordTooLargeError } from "./types";
import { Toolkit } from "./toolkit";
import type { FileErrorContext, LogRecord, LogTarget, LoggerDiagnostics, FlightRecorderStatus, FlightRecord } from "./types";

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
  private queuedRecords = 0;
  private queuedBytes = 0;
  private readonly byteSizes = new WeakMap<LogRecord, number>();
  private droppedRecords = 0;
  private readonly flightRecorder: FlightRecorder;
  private processorDropped = 0;
  private processorErrors = 0;
  private transportErrors = 0;
  private readonly usedTransports = new Set<import("./types").LogTransport>();
  private flightCaptureErrors = 0;
  private fileErrors = 0;
  private lastFileError: LoggerDiagnostics["lastFileError"];
  private readonly errors: Error[] = [];
  private readonly reportedFileErrors = new WeakSet<Error>();
  private closePromise: Promise<void> | undefined;
  private readonly captures = new Set<{ closeForLogger(): Promise<void>; flush(): Promise<void> }>();

  constructor(readonly config: Config) {
    this.toolkit = new Toolkit(config);
    this.flightRecorder = new FlightRecorder(config, this.toolkit);
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
    this.enqueueAccepted(record);
  }

  /** Internal Capture mirror path. Capture is allowed to drain while close is in progress. */
  enqueueCapture(record: LogRecord): void {
    if (this.state === "closed") throw new RLogClosedError();
    this.enqueueAccepted(record);
  }

  diagnostics(): LoggerDiagnostics {
    return {
      queuedRecords: this.queuedRecords,
      queuedBytes: this.queuedBytes,
      maxQueuedBytes: this.config.maxQueuedBytes ?? null,
      maxRecordBytes: this.config.maxRecordBytes ?? null,
      maxQueuedRecords: this.config.maxQueuedRecords ?? null,
      droppedRecords: this.droppedRecords,
      sinkActive: {
        text: Boolean(this.config.logFilePath) && this.text.file.active,
        jsonl: Boolean(this.config.jsonlFilePath) && this.jsonl.file.active,
      },
      fileErrors: this.fileErrors,
      ...(this.lastFileError ? { lastFileError: { ...this.lastFileError } } : {}),
      deferredErrors: this.errors.length,
      processorDropped: this.processorDropped,
      processorErrors: this.processorErrors,
      transportErrors: this.transportErrors,
      recovery: { text: this.text.file.recoveryStatus(), jsonl: this.jsonl.file.recoveryStatus() },
    };
  }

  flightRecorderEnabled(level: LogRecord["level"]): boolean { return this.flightRecorder.isEnabled(level); }
  flightRecorderStatus(): FlightRecorderStatus {
    this.commitPending();
    this.flightRecorder.applyLimits();
    return { ...this.flightRecorder.status(), captureErrors: this.flightCaptureErrors };
  }
  flightRecorderSnapshot(): FlightRecord[] {
    this.commitPending();
    this.flightRecorder.applyLimits();
    return this.flightRecorder.snapshot();
  }
  clearFlightRecorder(): void { this.flightRecorder.clear(); }
  async exportFlightRecorder(filePath: string): Promise<number> {
    this.commitPending();
    this.flightRecorder.applyLimits();
    return this.flightRecorder.export(filePath);
  }

  private estimateRecordBytes(record: LogRecord): number {
    const payload = {
      timestamp: record.timestamp, level: record.level,
      message: record.message, args: record.args,
      context: record.context, meta: record.metadata, event: record.event ?? null,
    };
    return Buffer.byteLength(JSON.stringify(this.toolkit.safeJson(payload)), "utf8") + 1;
  }

  private byteLimitError(size: number, oldSize = 0): Error | undefined {
    if (this.config.maxRecordBytes !== undefined && size > this.config.maxRecordBytes)
      return new RLogRecordTooLargeError(this.config.maxRecordBytes, size);
    if (this.config.maxQueuedBytes !== undefined && this.queuedBytes - oldSize + size > this.config.maxQueuedBytes)
      return new RLogQueueBytesExceededError(this.config.maxQueuedBytes, this.queuedBytes - oldSize + size);
    return undefined;
  }

  private discardIfDebug(record: LogRecord): boolean {
    if (this.config.queueOverflowPolicy !== "drop-debug" || (record.level !== "trace" && record.level !== "debug")) return false;
    this.droppedRecords++;
    record.committed = true;
    return true;
  }

  private enqueueAccepted(record: LogRecord): void {
    const limit = this.config.maxQueuedRecords;
    if (limit !== undefined && this.queuedRecords >= limit) {
      if (this.discardIfDebug(record)) return;
      throw new RLogQueueFullError(limit);
    }
    const size = this.config.maxQueuedBytes !== undefined || this.config.maxRecordBytes !== undefined
      ? this.estimateRecordBytes(record) : 0;
    const error = this.byteLimitError(size);
    if (error) {
      if (this.discardIfDebug(record)) return;
      throw error;
    }
    this.byteSizes.set(record, size);
    this.queuedRecords++;
    this.queuedBytes += size;
    // The default screen format does not include metadata, so it is safe to
    // retain 2.1's synchronous terminal behavior while file/JSONL waits one
    // microtask for a chained .meta() call.
    if (this.config.maxQueuedBytes === undefined && this.config.maxRecordBytes === undefined &&
        this.config.processors.length === 0 &&
        this.config.screenMetadataOutput === "none" && (record.targets === "all" || record.targets.has("screen"))) {
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
      if (this.config.maxQueuedBytes !== undefined || this.config.maxRecordBytes !== undefined) {
        const original = this.byteSizes.get(record) ?? 0;
        try {
          const updated = this.estimateRecordBytes(record);
          const error = this.byteLimitError(updated, original);
          if (error) {
            this.queuedRecords--;
            this.queuedBytes -= original;
            if (!this.discardIfDebug(record)) this.pushDeferredError(error);
            continue;
          }
          this.byteSizes.set(record, updated);
          this.queuedBytes += updated - original;
        } catch (error) {
          this.queuedRecords--;
          this.queuedBytes -= original;
          this.pushDeferredError(toError(error));
          continue;
        }
      }
      try { this.flightRecorder.capture(record); }
      catch { this.flightCaptureErrors++; }
      this.work = this.work.then(() => this.dispatch(record)).catch((reason: unknown) => {
        const error = toError(reason);
        if (!this.reportedFileErrors.has(error)) this.pushDeferredError(error);
      }).finally(() => {
        this.queuedRecords--;
        this.queuedBytes -= this.byteSizes.get(record) ?? 0;
      });
    }
  }

  /** Detach and sanitize user-controlled metadata before plugin callbacks. */
  private safeRecord(record: LogRecord): LogRecord {
    const safe = this.toolkit.safeJson({
      message: record.message, args: record.args, context: record.context,
      metadata: record.metadata, event: record.event ?? null,
    }) as Record<string, unknown>;
    const event = safe.event as { type: string; data?: Record<string, unknown> } | null;
    return {
      id: record.id, timestamp: record.timestamp, level: record.level,
      message: String(safe.message), args: safe.args as unknown[],
      context: safe.context as Record<string, unknown>,
      metadata: safe.metadata as Record<string, unknown>,
      ...(event ? { event: { type: event.type, data: event.data } } : {}),
      targets: record.targets, committed: true, screenWritten: record.screenWritten,
      processed: record.processed, displayLabel: record.displayLabel,
    };
  }

  private async dispatch(record: LogRecord): Promise<void> {
    let current = record;
    if (this.config.processors.length) {
      current = this.safeRecord(record);
      try {
        for (const processor of this.config.processors) {
          const result = await processor(current);
          if (result === null) { this.processorDropped++; return; }
          if (result !== undefined) current = result;
        }
        current = this.safeRecord({ ...current, id: record.id, timestamp: record.timestamp,
          targets: record.targets, screenWritten: record.screenWritten, committed: true, processed: true });
        if (this.config.maxRecordBytes !== undefined || this.config.maxQueuedBytes !== undefined) {
          const length = this.estimateRecordBytes(current);
          const previousLength = this.byteSizes.get(record) ?? 0;
          const sizeError = this.byteLimitError(length, previousLength);
          if (sizeError) throw sizeError;
          this.byteSizes.set(record, length);
          this.queuedBytes += length - previousLength;
        }
      } catch (reason) {
        this.processorErrors++;
        throw toError(reason);
      }
    }
    let firstError: Error | undefined;
    for (const sink of this.sinks.values()) {
      if (sink.target === "screen" && current.screenWritten) continue;
      try { await sink.write(current); }
      catch (reason) { firstError ??= toError(reason); }
    }
    for (const transport of this.config.transports) {
      this.usedTransports.add(transport);
      try { await transport.write(this.safeRecord(current)); }
      catch (reason) {
        this.transportErrors++;
        firstError ??= toError(reason);
      }
    }
    if (firstError) throw firstError;
  }

  reportFileError(error: Error, context: FileErrorContext): void {
    this.fileErrors++;
    this.lastFileError = {
      output: context.output, operation: context.operation,
      message: error.message.slice(0, 1024), timestamp: new Date().toISOString(),
    };
    this.reportedFileErrors.add(error);
    try { this.config.onFileError?.(error, context); } catch (callbackError) { this.pushDeferredError(toError(callbackError)); }
    const policy = this.config.fileErrorPolicyFor(context.output);
    if (policy === "stderr") process.stderr.write(`RLog file error (${context.operation}, ${context.output}): ${error.message}\n`);
    if (policy === "throw") this.pushDeferredError(error);
  }

  private captureFileError(error: Error): void {
    if (this.config.fileErrorPolicyFor("capture") === "throw") this.pushDeferredError(error);
  }

  private pushDeferredError(error: Error): void {
    if (!this.errors.includes(error)) this.errors.push(error);
  }

  /** Explicitly retry disabled file sinks; caller-owned Writable outputs are not reset. */
  async recoverFiles(): Promise<{ text: boolean | null; jsonl: boolean | null }> {
    this.assertOpen();
    this.commitPending();
    await this.work;
    const text = this.config.logFilePath
      ? await this.text.file.recover(this.config.resolveFilePath("text")!) : null;
    const jsonl = this.config.jsonlFilePath
      ? await this.jsonl.file.recover(this.config.resolveFilePath("jsonl")!) : null;
    return { text, jsonl };
  }

  /** Wait for queued records and sync configured file handles. */
  async syncFiles(): Promise<void> {
    this.assertOpen();
    this.commitPending();
    await this.work;
    const outcomes = await Promise.allSettled([
      ...(this.config.logFilePath ? [this.text.file.sync()] : []),
      ...(this.config.jsonlFilePath ? [this.jsonl.file.sync()] : []),
    ]);
    const errors = outcomes.filter((value): value is PromiseRejectedResult => value.status === "rejected");
    if (errors.length) throw errors[0].reason;
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
    const transportOutcomes = await Promise.allSettled(
      [...this.usedTransports].map((transport) => Promise.resolve().then(() => transport.flush?.())),
    );
    for (const result of transportOutcomes) {
      if (result.status === "rejected") {
        this.transportErrors++;
        this.pushDeferredError(toError(result.reason));
      }
    }
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
    const transportOutcomes = await Promise.allSettled(
      [...new Set([...this.usedTransports, ...this.config.transports])].map((transport) => Promise.resolve().then(() => transport.close?.())),
    );
    for (const result of transportOutcomes) {
      if (result.status === "rejected") {
        this.transportErrors++;
        this.pushDeferredError(toError(result.reason));
      }
    }
    this.state = "closed";
    this.throwDeferredErrors();
  }

  progress(num: number, max: number): void {
    this.assertOpen();
    // Start synchronously so progress retains its immediate terminal behavior,
    // but retain the promise so flush()/close() await it and receive errors.
    const write = this.console.progress(num, max).catch((reason: unknown) => { this.pushDeferredError(toError(reason)); });
    this.screenWork = Promise.all([this.screenWork, write]).then(() => undefined);
  }
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
