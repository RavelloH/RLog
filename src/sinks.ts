import * as fs from "node:fs";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { labelFor, shouldLog } from "./levels";
import type { Config } from "./config";
import type { FileErrorContext, LogColor, LogRecord } from "./types";
import { Toolkit } from "./toolkit";

export type ErrorReporter = (error: Error, context: FileErrorContext) => void;

function writeTo(stream: Writable, value: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(value, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

export class ManagedFile {
  private writeStream: fs.WriteStream | undefined;
  private disabled = false;
  private openedPath: string | undefined;
  private opening: Promise<void> | undefined;
  private readonly reportedErrors = new WeakSet<Error>();

  constructor(private readonly output: FileErrorContext["output"], private readonly report: ErrorReporter) {}

  get active(): boolean { return !this.disabled; }
  get stream(): fs.WriteStream | null { return this.writeStream ?? null; }

  async init(filePath: string): Promise<void> { if (!this.disabled) await this.open(filePath); }

  async write(filePath: string, value: string | Buffer): Promise<void> {
    if (this.disabled) return;
    try {
      await this.open(filePath);
      await writeTo(this.writeStream!, value);
    } catch (reason) {
      const error = toError(reason);
      this.disabled = true;
      this.reportOnce(error, { filePath, output: this.output, operation: "write" });
      throw error;
    }
  }

  async flush(): Promise<void> {
    if (!this.writeStream || this.disabled) return;
    await new Promise<void>((resolve, reject) => {
      this.writeStream!.once("error", reject);
      this.writeStream!.write("", (error) => error ? reject(error) : resolve());
    });
  }

  async close(): Promise<void> {
    if (this.opening) {
      try { await this.opening; } catch { return; }
    }
    await this.closeCurrent();
  }

  private async closeCurrent(): Promise<void> {
    if (!this.writeStream) return;
    const stream = this.writeStream;
    this.writeStream = undefined;
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.once("finish", resolve);
      stream.end();
    }).catch((reason: unknown) => {
      const error = toError(reason);
      this.reportOnce(error, { filePath: this.openedPath, output: this.output, operation: "close" });
      throw error;
    });
  }

  private async open(filePath: string): Promise<void> {
    if (this.writeStream && this.openedPath === filePath) return;
    if (this.opening) {
      await this.opening;
      return this.open(filePath);
    }
    this.opening = this.doOpen(filePath);
    try { await this.opening; } finally { this.opening = undefined; }
  }

  private async doOpen(filePath: string): Promise<void> {
    if (this.writeStream) await this.closeCurrent();
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      this.writeStream = fs.createWriteStream(filePath, { flags: "a" });
      this.openedPath = filePath;
      this.writeStream.on("error", (reason: Error) => {
        this.disabled = true;
        this.reportOnce(reason, { filePath: this.openedPath, output: this.output, operation: "write" });
      });
      await new Promise<void>((resolve, reject) => {
        this.writeStream!.once("open", resolve);
        this.writeStream!.once("error", reject);
      });
    } catch (reason) {
      const error = toError(reason);
      this.disabled = true;
      this.reportOnce(error, { filePath, output: this.output, operation: "open" });
      throw error;
    }
  }

  private reportOnce(error: Error, context: FileErrorContext): void {
    if (this.reportedErrors.has(error)) return;
    this.reportedErrors.add(error);
    this.report(error, context);
  }
}

export class ConsoleSink {
  constructor(private readonly config: Config, private readonly toolkit: Toolkit) {}

  async write(record: LogRecord): Promise<void> {
    if (record.destination === "file" || !shouldLog(record.level, this.config.effectiveLevel("screen"))) return;
    const target = this.resolveTarget();
    if (!target) return;
    const label = record.displayLabel ?? labelFor(record.level, "screen");
    const color = levelColor(record.level);
    const body = this.renderMessage(record, "screen");
    const processed = this.toolkit.colorizeString(this.toolkit.encryptPrivacyContent(body));
    const coloredBody = record.level === "success" ? this.toolkit.colorText(processed, "green") : processed;
    const line = this.toolkit.formatLogMessage(label, coloredBody, record.timestamp, this.toolkit.colorText(label, color));
    await writeTo(target, `${line}\n`);
  }

  async progress(num: number, max: number): Promise<void> {
    const target = this.resolveTarget();
    if (!target) return;
    const safeMax = max > 0 ? max : 1;
    const percent = `${Math.floor((100 * num) / safeMax)}%`;
    const state = `${num}/${max}`;
    const streamInfo = target as unknown as { columns?: unknown };
    const columns = typeof streamInfo.columns === "number" ? streamInfo.columns : this.config.screenLength || 80;
    const header = `[${this.toolkit.formatTime()}][${this.toolkit.colorText("PROG", "magenta")}] `;
    const width = Math.max(0, columns - header.length - state.length - percent.length - 6);
    const bar = width > 1 ? `[${"|".repeat(Math.max(0, Math.min(width, Math.floor(width * num / safeMax))))}${" ".repeat(Math.max(0, width - Math.floor(width * num / safeMax)))}] ` : "";
    const tty = Boolean((target as { isTTY?: boolean }).isTTY);
    await writeTo(target, `${tty ? "\r" : ""}${header}${bar}${percent} ${state}${tty ? "" : "\n"}`);
  }

  private resolveTarget(): Writable | undefined {
    if (this.config.screenOutput === "none") return undefined;
    if (this.config.screenOutput === "stdout") return process.stdout;
    if (this.config.screenOutput === "stderr") return process.stderr;
    return this.config.screenOutput;
  }

  private renderMessage(record: LogRecord, target: "screen" | "file"): string {
    let text = target === "screen"
      ? this.toolkit.formatConsoleArgs(record.args, this.config.enableColorfulOutput)
      : record.message;
    const mode = target === "screen" ? this.config.screenMetadataOutput : this.config.fileMetadataOutput;
    const metadata = { ...record.context, ...record.metadata };
    if (!Object.keys(metadata).length || mode === "none") return text;
    const redacted = this.toolkit.redact(metadata) as Record<string, unknown>;
    const rendered = this.toolkit.safeInspect(redacted);
    if (mode === "inline") return `${text} ${rendered}`;
    return `${text}\n${Object.entries(redacted).map(([key, value]) => `  ${key}: ${this.toolkit.safeInspect(value)}`).join("\n")}`;
  }
}

export class TextFileSink {
  readonly file: ManagedFile;
  constructor(private readonly config: Config, private readonly toolkit: Toolkit, report: ErrorReporter) { this.file = new ManagedFile("text", report); }
  async write(record: LogRecord): Promise<void> {
    if (!this.config.logFilePath || record.destination === "screen" || !shouldLog(record.level, this.config.effectiveLevel("file"))) return;
    const label = record.displayLabel ?? labelFor(record.level, "file");
    const metadata = { ...record.context, ...record.metadata };
    const redacted = this.toolkit.redact(metadata) as Record<string, unknown>;
    let body = this.toolkit.encryptPrivacyContent(record.message);
    if (Object.keys(metadata).length && this.config.fileMetadataOutput !== "none") {
      body += this.config.fileMetadataOutput === "inline" ? ` ${this.toolkit.safeInspect(redacted)}` : `\n${Object.entries(redacted).map(([key, value]) => `  ${key}: ${this.toolkit.safeInspect(value)}`).join("\n")}`;
    }
    const line = this.toolkit.formatLogMessage(label, body, record.timestamp);
    await this.file.write(this.config.logFilePath, `${line}\n`);
  }
}

export class JsonlFileSink {
  readonly file: ManagedFile;
  constructor(private readonly config: Config, private readonly toolkit: Toolkit, report: ErrorReporter) { this.file = new ManagedFile("jsonl", report); }
  async write(record: LogRecord): Promise<void> {
    if (!this.config.jsonlFilePath || record.destination !== "all" || !shouldLog(record.level, this.config.effectiveLevel("jsonl"))) return;
    const value = {
      timestamp: record.timestamp.toISOString(), level: record.level, message: this.toolkit.encryptPrivacyContent(record.message),
      args: this.toolkit.safeJson(record.args), context: this.toolkit.safeJson(record.context), meta: this.toolkit.safeJson(record.metadata),
      event: record.event ? { type: record.event.type, data: this.toolkit.safeJson(record.event.data ?? {}) } : null,
    };
    await this.file.write(this.config.jsonlFilePath, `${JSON.stringify(value)}\n`);
  }
}

function levelColor(level: LogRecord["level"]): LogColor {
  switch (level) { case "trace": return "gray"; case "debug": return "blue"; case "info": return "cyan"; case "success": return "green"; case "warn": return "yellow"; case "error": case "fatal": return "red"; }
}

export function toError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
