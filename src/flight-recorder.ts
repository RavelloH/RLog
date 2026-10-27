import * as fs from "node:fs";
import type { Config } from "./config";
import { Toolkit } from "./toolkit";
import type { FlightRecorderOptions, FlightRecorderStatus, FlightRecord, LogLevel, LogRecord } from "./types";

/**
 * Bounded in-memory diagnostic flight recorder. Keeps a serialized, detached
 * copy of each accepted record so mutable caller data cannot change history.
 */
export class FlightRecorder {
  private readonly entries: Array<{ json: string; bytes: number }> = [];
  private bytes = 0;
  private evicted = 0;
  private oversized = 0;

  constructor(private readonly config: Config, private readonly toolkit: Toolkit) {}

  isEnabled(level: LogLevel): boolean {
    const opts = this.config.flightRecorder;
    if (!opts || level === "off") return false;
    return (opts.captureLevels ?? ["trace", "debug"]).includes(level);
  }

  capture(record: LogRecord): void {
    const opts = this.config.flightRecorder;
    if (!opts || !this.isEnabled(record.level)) return;
    const maxBytes = opts.maxBytes ?? 256 * 1024;
    const maxRecords = opts.maxRecords ?? 200;
    const entry: FlightRecord = {
      id: record.id,
      timestamp: this.toolkit.safeJson(record.timestamp) as string | number,
      level: record.level,
      message: this.toolkit.encryptPrivacyContent(record.message),
      context: this.toolkit.safeJson(record.context) as Record<string, unknown>,
      meta: this.toolkit.safeJson(record.metadata) as Record<string, unknown>,
      ...(record.event ? {
        event: {
          type: this.toolkit.encryptPrivacyContent(record.event.type),
          ...(opts.includeEventData ? { data: this.toolkit.safeJson(record.event.data ?? {}) as Record<string, unknown> } : {})
        }
      } : {})
    };
    const json = JSON.stringify(entry);
    const size = Buffer.byteLength(json, "utf8") + 1;
    if (size > maxBytes) { this.oversized++; return; }
    this.entries.push({ json, bytes: size });
    this.bytes += size;
    while (this.entries.length > maxRecords || this.bytes > maxBytes) {
      const oldest = this.entries.shift()!;
      this.bytes -= oldest.bytes;
      this.evicted++;
    }
  }

  snapshot(): FlightRecord[] {
    return this.entries.map(entry => JSON.parse(entry.json) as FlightRecord);
  }

  status(): Omit<FlightRecorderStatus, "captureErrors"> {
    return {
      enabled: !!this.config.flightRecorder,
      records: this.entries.length,
      bytes: this.bytes,
      evictedRecords: this.evicted,
      oversizedRecords: this.oversized,
    };
  }

  clear(): void {
    this.entries.length = 0;
    this.bytes = 0;
  }

  /** Exclusive, private snapshot export. Caller chooses when and where to persist. */
  async export(filePath: string): Promise<number> {
    if (!this.config.flightRecorder) return 0;
    const snapshot = this.entries.map(entry => entry.json).join("\n");
    const payload = snapshot ? snapshot + "\n" : "";
    await fs.promises.writeFile(filePath, payload, { flag: "wx", mode: 0o600 });
    return this.entries.length;
  }

  /** Trim history after a runtime reduction of the configured limits. */
  applyLimits(): void {
    const opts: FlightRecorderOptions | false = this.config.flightRecorder;
    if (!opts) { this.clear(); return; }
    const maxBytes = opts.maxBytes ?? 256 * 1024;
    const maxRecords = opts.maxRecords ?? 200;
    while (this.entries.length > maxRecords || this.bytes > maxBytes) {
      const oldest = this.entries.shift()!;
      this.bytes -= oldest.bytes;
      this.evicted++;
    }
  }
}
