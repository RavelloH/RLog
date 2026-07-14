import * as fs from "node:fs";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { labelFor, shouldLog } from "./levels";
import type { Config } from "./config";
import type { CaptureFileMode, FileErrorContext, LogColor, LogRecord, LogTarget, RotationOptions } from "./types";
import { Toolkit } from "./toolkit";

export type ErrorReporter = (error: Error, context: FileErrorContext) => void;

/** Shared lifecycle contract used by Dispatcher. */
export interface LogSink {
  readonly target: LogTarget;
  write(record: LogRecord): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface ConsoleErrorGuard { active: number; installed: boolean; errors: Error[]; listener: (error: Error) => void; }
const consoleErrorGuards = new WeakMap<Writable, ConsoleErrorGuard>();

function guardConsoleTarget(target: Writable): { release(afterError: boolean): void; takeError(): Error | undefined } {
  let guard = consoleErrorGuards.get(target);
  if (!guard) {
    guard = { active: 0, installed: false, errors: [], listener: () => undefined };
    guard.listener = (error) => { guard!.errors.push(error); };
    consoleErrorGuards.set(target, guard);
  }
  if (!guard.installed) { target.on("error", guard.listener); guard.installed = true; }
  guard.active += 1;
  const errorIndex = guard.errors.length;
  return {
    takeError: () => guard!.errors.slice(errorIndex)[0],
    release: (afterError: boolean) => {
    guard!.active -= 1;
    if (guard!.active !== 0) return;
    const remove = () => { if (guard!.active === 0 && guard!.installed) { target.removeListener("error", guard!.listener); guard!.installed = false; } };
    if (afterError) setImmediate(remove); else remove();
    },
  };
}

function writeTo(stream: Writable, value: string | Buffer, listenForError = true): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!listenForError) {
      try { stream.write(value, (error?: Error | null) => error ? reject(error) : resolve()); } catch (reason) { reject(toError(reason)); }
      return;
    }
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      if (error) { setImmediate(() => stream.removeListener("error", onError)); reject(error); }
      else { stream.removeListener("error", onError); resolve(); }
    };
    const onError = (error: Error) => finish(error);
    stream.once("error", onError);
    try { stream.write(value, (error?: Error | null) => finish(error)); } catch (reason) { finish(toError(reason)); }
  });
}

async function writeToExternal(stream: Writable, value: string): Promise<void> {
  const guard = guardConsoleTarget(stream); let failed = false;
  try {
    await writeTo(stream, value, false);
    await afterCurrentTurn();
    const emitted = guard.takeError();
    if (emitted) throw emitted;
  } catch (reason) { failed = true; throw reason; }
  finally { guard.release(failed); }
}

/**
 * A serial, append-only file. Rotation is deliberately contained here so both
 * file sinks retain identical Windows-safe close/rename/reopen behavior.
 */
export class ManagedFile {
  private writeStream: fs.WriteStream | undefined;
  private disabled = false;
  private openedPath: string | undefined;
  private openedMode: CaptureFileMode = "append";
  private currentBytes = 0;
  private readonly reportedErrors = new WeakSet<Error>();
  private activeOperation: FileErrorContext["operation"] | undefined;
  /** Always resolves, so a failed operation never blocks the remaining queue. */
  private operations: Promise<void> = Promise.resolve();

  constructor(private readonly output: FileErrorContext["output"], private readonly report: ErrorReporter, private readonly getRotation: () => RotationOptions | false = () => false) {}

  get active(): boolean { return !this.disabled; }
  /**
   * Advanced escape hatch. Direct writes bypass rotation accounting, the
   * managed operation queue, and deferred error delivery. Prefer writeRaw().
   */
  get stream(): fs.WriteStream | null { return this.writeStream ?? null; }

  init(filePath: string, mode: CaptureFileMode = "append"): Promise<void> { return this.enqueue(() => this.doInit(filePath, mode)); }
  write(filePath: string, value: string | Buffer, mode: CaptureFileMode = "append"): Promise<void> { return this.enqueue(() => this.doWrite(filePath, value, mode)); }
  flush(): Promise<void> { return this.enqueue(() => this.doFlush()); }
  close(): Promise<void> { return this.enqueue(() => this.doClose()); }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }

  private async doInit(filePath: string, mode: CaptureFileMode): Promise<void> { if (!this.disabled) await this.open(filePath, mode); }

  private async doWrite(filePath: string, value: string | Buffer, mode: CaptureFileMode): Promise<void> {
    if (this.disabled) return;
    try {
      await this.open(filePath, mode);
      const bytes = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);
      const rotation = this.getRotation();
      if (rotation && mode === "append" && this.currentBytes > 0 && this.currentBytes + bytes > rotation.maxBytes) await this.rotate(filePath, rotation);
      await writeTo(this.writeStream!, value);
      this.currentBytes += bytes;
    } catch (reason) {
      const error = toError(reason);
      this.disabled = true;
      // rotate() has already reported its more useful operation context.
      if (this.activeOperation !== "rotate") this.reportOnce(error, { filePath, output: this.output, operation: "write" });
      throw error;
    }
  }

  private async doFlush(): Promise<void> {
    if (!this.writeStream || this.disabled) return;
    const stream = this.writeStream;
    this.activeOperation = "flush";
    try { await this.waitForStreamOperation(stream, (done) => stream.write("", done)); }
    catch (reason) { const error = toError(reason); this.disabled = true; this.reportOnce(error, { filePath: this.openedPath, output: this.output, operation: "flush" }); throw error; }
    finally { this.activeOperation = undefined; }
  }

  private async doClose(): Promise<void> { await this.closeCurrent(); }

  private async rotate(filePath: string, rotation: RotationOptions): Promise<void> {
    this.activeOperation = "rotate";
    try {
      // Close before rename: essential on Windows, and makes the operation portable.
      await this.closeCurrent();
      const { maxFiles } = rotation;
      if (maxFiles === 0) {
        await fs.promises.rm(filePath, { force: true });
      } else {
        await fs.promises.rm(`${filePath}.${maxFiles}`, { force: true });
        for (let index = maxFiles - 1; index >= 1; index -= 1) {
          const source = `${filePath}.${index}`;
          try { await fs.promises.rename(source, `${filePath}.${index + 1}`); }
          catch (reason) { if ((reason as NodeJS.ErrnoException).code !== "ENOENT") throw reason; }
        }
        try { await fs.promises.rename(filePath, `${filePath}.1`); }
        catch (reason) { if ((reason as NodeJS.ErrnoException).code !== "ENOENT") throw reason; }
      }
      await this.open(filePath, "append");
      this.currentBytes = 0;
    } catch (reason) {
      const error = toError(reason);
      this.disabled = true;
      this.reportOnce(error, { filePath, output: this.output, operation: "rotate" });
      throw error;
    } finally { this.activeOperation = undefined; }
  }

  private async closeCurrent(): Promise<void> {
    if (!this.writeStream) return;
    const stream = this.writeStream;
    this.writeStream = undefined;
    // A failed WriteStream can have emitted error and closed before Capture's
    // failure finalizer gets here (notably EISDIR on Unix). Do not wait for
    // finish/error events that have already happened.
    if (stream.closed || stream.destroyed) return;
    const operation = this.activeOperation ?? "close";
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => finish(error);
      const onFinish = () => finish();
      const onClose = () => finish();
      const finish = (error?: Error) => {
        stream.removeListener("error", onError);
        stream.removeListener("finish", onFinish);
        stream.removeListener("close", onClose);
        error ? reject(error) : resolve();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.once("close", onClose);
      stream.end();
    }).catch((reason: unknown) => { const error = toError(reason); this.reportOnce(error, { filePath: this.openedPath, output: this.output, operation }); throw error; });
  }

  private async open(filePath: string, mode: CaptureFileMode): Promise<void> {
    if (this.writeStream && this.openedPath === filePath && this.openedMode === mode) return;
    await this.doOpen(filePath, mode);
  }

  private async doOpen(filePath: string, mode: CaptureFileMode): Promise<void> {
    if (this.writeStream) await this.closeCurrent();
    // A failed reopen is part of a rotation transaction, not an ordinary open.
    const operation: FileErrorContext["operation"] = this.activeOperation === "rotate" ? "rotate" : "open";
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      this.activeOperation = operation;
      const stat = await fs.promises.stat(filePath).catch((reason: unknown) => {
        if ((reason as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw reason;
      });
      this.currentBytes = stat?.size ?? 0;
      const flags: "a" | "w" | "wx" = mode === "append" ? "a" : mode === "truncate" ? "w" : "wx";
      this.writeStream = fs.createWriteStream(filePath, { flags });
      this.openedPath = filePath;
      this.openedMode = mode;
      this.writeStream.on("error", (reason: Error) => { this.disabled = true; this.reportOnce(reason, { filePath: this.openedPath, output: this.output, operation: this.activeOperation ?? "write" }); });
      await new Promise<void>((resolve, reject) => { this.writeStream!.once("open", resolve); this.writeStream!.once("error", reject); });
    } catch (reason) {
      const error = toError(reason); this.disabled = true; this.reportOnce(error, { filePath, output: this.output, operation }); throw error;
    } finally { this.activeOperation = undefined; }
  }

  private waitForStreamOperation(stream: fs.WriteStream, operation: (done: (error?: Error | null) => void) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => { if (settled) return; settled = true; stream.removeListener("error", onError); error ? reject(error) : resolve(); };
      const onError = (error: Error) => finish(error);
      stream.once("error", onError); operation(finish);
    });
  }

  private reportOnce(error: Error, context: FileErrorContext): void { if (!this.reportedErrors.has(error)) { this.reportedErrors.add(error); this.report(error, context); } }
}

function targetsRecord(record: LogRecord, target: LogTarget): boolean { return record.targets === "all" || record.targets.has(target); }

export class ConsoleSink implements LogSink {
  readonly target = "screen" as const;
  constructor(private readonly config: Config, private readonly toolkit: Toolkit) {}
  async write(record: LogRecord): Promise<void> {
    if (!targetsRecord(record, this.target) || !shouldLog(record.level, this.config.effectiveLevel("screen"))) return;
    const target = this.resolveTarget(); if (!target) return;
    const label = record.displayLabel ?? labelFor(record.level, "screen");
    const body = this.renderMessage(record);
    const processed = this.toolkit.colorizeString(this.toolkit.encryptPrivacyContent(body));
    const coloredBody = record.level === "success" ? this.toolkit.colorText(processed, "green") : processed;
    const line = this.toolkit.formatLogMessage(label, coloredBody, record.timestamp, this.toolkit.colorText(label, levelColor(record.level)));
    const guard = guardConsoleTarget(target); let failed = false;
    try {
      await writeTo(target, `${line}\n`, false);
      await afterCurrentTurn();
      const emitted = guard.takeError();
      if (emitted) throw emitted;
    } catch (reason) { failed = true; throw reason; } finally { guard.release(failed); }
  }
  async flush(): Promise<void> { /* screen writes are awaited by Dispatcher */ }
  async close(): Promise<void> { /* caller owns stdout/stderr/custom Writable */ }
  async progress(num: number, max: number): Promise<void> {
    const target = this.resolveTarget(); if (!target) return;
    const safeMax = max > 0 ? max : 1; const percent = `${Math.floor((100 * num) / safeMax)}%`; const state = `${num}/${max}`;
    const columns = typeof (target as { columns?: unknown }).columns === "number" ? (target as unknown as { columns: number }).columns : this.config.screenLength || 80;
    const header = `[${this.toolkit.formatTime()}][${this.toolkit.colorText("PROG", "magenta")}] `;
    const width = Math.max(0, columns - header.length - state.length - percent.length - 6);
    const filled = Math.max(0, Math.min(width, Math.floor(width * num / safeMax)));
    const bar = width > 1 ? `[${"|".repeat(filled)}${" ".repeat(Math.max(0, width - filled))}] ` : "";
    const guard = guardConsoleTarget(target); let failed = false;
    try {
      await writeTo(target, `${(target as { isTTY?: boolean }).isTTY ? "\r" : ""}${header}${bar}${percent} ${state}${(target as { isTTY?: boolean }).isTTY ? "" : "\n"}`, false);
      await afterCurrentTurn();
      const emitted = guard.takeError();
      if (emitted) throw emitted;
    } catch (reason) { failed = true; throw reason; } finally { guard.release(failed); }
  }
  private resolveTarget(): Writable | undefined { return this.config.screenOutput === "none" ? undefined : this.config.screenOutput === "stdout" ? process.stdout : this.config.screenOutput === "stderr" ? process.stderr : this.config.screenOutput; }
  private renderMessage(record: LogRecord): string {
    const text = this.toolkit.formatConsoleArgs(record.args, this.config.enableColorfulOutput);
    const metadata = { ...record.context, ...(record.event?.data ?? {}), ...record.metadata };
    if (!Object.keys(metadata).length || this.config.screenMetadataOutput === "none") return text;
    const redacted = this.toolkit.redact(metadata) as Record<string, unknown>; const rendered = this.toolkit.safeInspect(redacted);
    return this.config.screenMetadataOutput === "inline" ? `${text} ${rendered}` : `${text}\n${Object.entries(redacted).map(([key, value]) => `  ${key}: ${this.toolkit.safeInspect(value)}`).join("\n")}`;
  }
}

export class TextFileSink implements LogSink {
  readonly target = "text" as const;
  readonly file: ManagedFile;
  constructor(private readonly config: Config, private readonly toolkit: Toolkit, report: ErrorReporter) { this.file = new ManagedFile("text", report, () => config.textRotation); }
  async write(record: LogRecord): Promise<void> {
    if (!this.config.logFilePath || !targetsRecord(record, this.target) || !shouldLog(record.level, this.config.effectiveLevel("file"))) return;
    const label = record.displayLabel ?? labelFor(record.level, "file"); const metadata = { ...record.context, ...(record.event?.data ?? {}), ...record.metadata };
    const redacted = this.toolkit.redact(metadata) as Record<string, unknown>; let body = this.toolkit.encryptPrivacyContent(record.message);
    if (Object.keys(metadata).length && this.config.fileMetadataOutput !== "none") body += this.config.fileMetadataOutput === "inline" ? ` ${this.toolkit.safeInspect(redacted)}` : `\n${Object.entries(redacted).map(([key, value]) => `  ${key}: ${this.toolkit.safeInspect(value)}`).join("\n")}`;
    await this.file.write(this.config.logFilePath, `${this.toolkit.formatLogMessage(label, body, record.timestamp)}\n`);
  }
  flush(): Promise<void> { return this.file.flush(); }
  close(): Promise<void> { return this.file.close(); }
}

export class JsonlFileSink implements LogSink {
  readonly target = "jsonl" as const;
  readonly file: ManagedFile;
  private outputDisabled = false;
  constructor(private readonly config: Config, private readonly toolkit: Toolkit, private readonly report: ErrorReporter) { this.file = new ManagedFile("jsonl", report, () => config.jsonlRotation); }
  async write(record: LogRecord): Promise<void> {
    if ((!this.config.jsonlFilePath && !this.resolveOutput()) || !targetsRecord(record, this.target) || !shouldLog(record.level, this.config.effectiveLevel("jsonl"))) return;
    const value = {
      ...this.toolkit.safeJson(this.config.jsonlBaseFields) as Record<string, unknown>,
      schema: "rlog.record",
      version: 1,
      id: record.id,
      timestamp: this.toolkit.safeJson(record.timestamp),
      level: record.level,
      message: this.toolkit.encryptPrivacyContent(record.message),
      args: this.toolkit.safeJson(record.args),
      context: this.toolkit.safeJson(record.context),
      meta: this.toolkit.safeJson(record.metadata),
      event: record.event ? { type: record.event.type, data: this.toolkit.safeJson(record.event.data ?? {}) } : null,
    };
    const line = `${JSON.stringify(value)}\n`;
    if (this.config.jsonlFilePath) await this.file.write(this.config.jsonlFilePath, line);
    const output = this.resolveOutput();
    if (output) {
      try { await writeToExternal(output, line); }
      catch (reason) {
        const error = toError(reason);
        this.outputDisabled = true;
        this.report(error, { output: "jsonl", operation: "write" });
        throw error;
      }
    }
  }
  flush(): Promise<void> { return this.file.flush(); }
  close(): Promise<void> { return this.file.close(); }
  private resolveOutput(): Writable | undefined {
    if (this.outputDisabled || this.config.jsonlOutput === "none") return undefined;
    return this.config.jsonlOutput === "stdout" ? process.stdout : this.config.jsonlOutput === "stderr" ? process.stderr : this.config.jsonlOutput;
  }
}

function levelColor(level: LogRecord["level"]): LogColor { switch (level) { case "trace": return "gray"; case "debug": return "blue"; case "info": return "cyan"; case "success": return "green"; case "warn": return "yellow"; case "error": case "fatal": return "red"; } }
function afterCurrentTurn(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
export function toError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
