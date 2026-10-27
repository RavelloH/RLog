import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { LogLevelInput } from "./types";

export interface JsonlReadResult {
  filePath: string;
  lineNumber: number;
  record: Record<string, unknown>;
}
export interface JsonlReadOptions {
  /** Configured base file path, not an instance-specific resolved path. */
  filePath: string;
  includeInstances?: boolean;
  skipMalformed?: boolean;
  since?: string | number | Date;
  limit?: number;
  levels?: readonly LogLevelInput[];
  eventTypes?: readonly string[];
}

interface DiscoveredFile { name: string; rotation: number; streamId: string; }
function escaped(value: string): string {
  return [...value].map(char => ("\\^$.*+?()[]{}|".includes(char) ? "\\" + char : char)).join("");
}

/** Discover active and rotated JSONL files. Each stream's older rotations precede its active file. */
export async function listJsonlFiles(filePath: string, includeInstances = true): Promise<string[]> {
  const absolute = path.resolve(filePath);
  const parsed = path.parse(absolute);
  const matcher = new RegExp("^" + escaped(parsed.name) +
    (includeInstances ? "(?:\\.([0-9]+)\\.([a-f0-9]{32}))?" : "") +
    escaped(parsed.ext) + "(?:\\.([0-9]+))?$");
  let names: string[];
  try { names = await fs.promises.readdir(parsed.dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: DiscoveredFile[] = names.flatMap(entry => {
    const match = matcher.exec(entry);
    if (!match) return [];
    const rotation = Number(match[match.length - 1] || 0);
    if (!Number.isSafeInteger(rotation)) return [];
    const streamId = includeInstances && match[1] ? match[1] + "." + match[2] : "shared";
    return [{ name: entry, rotation, streamId }];
  });
  files.sort((a,b) => a.streamId.localeCompare(b.streamId) || b.rotation - a.rotation);
  return files.map(file => path.join(parsed.dir, file.name));
}

function timestampValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

/**
 * Stream parsed records with bounded memory. Within one writer, rotated files
 * are visited oldest-first. No global chronological order is promised across
 * independently rotated writer instances or arbitrary custom timestamps.
 * Concurrent rotation does not provide snapshot isolation.
 */
export async function* readJsonl(options: JsonlReadOptions): AsyncGenerator<JsonlReadResult> {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new RangeError("limit must be a positive safe integer");
  }
  const cutoff = options.since === undefined ? undefined : timestampValue(options.since);
  if (cutoff !== undefined && !Number.isFinite(cutoff)) throw new RangeError("Invalid since timestamp");
  const levels = options.levels && new Set<string>(options.levels);
  const events = options.eventTypes && new Set(options.eventTypes);
  let count = 0;
  for (const filePath of await listJsonlFiles(options.filePath, options.includeInstances !== false)) {
    const input = fs.createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber++;
        if (!line.trim()) continue;
        let value: unknown;
        try { value = JSON.parse(line); }
        catch (error) {
          if (options.skipMalformed) continue;
          throw new SyntaxError("Invalid JSONL at " + filePath + ":" + lineNumber + ": " + String(error));
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          if (options.skipMalformed) continue;
          throw new TypeError("Invalid JSONL record at " + filePath + ":" + lineNumber);
        }
        const record = value as Record<string, unknown>;
        if (cutoff !== undefined && !(timestampValue(record.timestamp) >= cutoff)) continue;
        if (levels && !levels.has(String(record.level))) continue;
        const event = record.event as { type?: unknown } | null | undefined;
        if (events && !events.has(String(event?.type))) continue;
        yield { filePath, lineNumber, record };
        if (++count >= (options.limit ?? Number.MAX_SAFE_INTEGER)) return;
      }
    } catch (error) {
      // A concurrent rotation can remove a discovered file before opening it.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      lines.close();
      input.destroy();
    }
  }
}
