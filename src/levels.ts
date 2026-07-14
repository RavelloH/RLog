import type { LogLevel, LogLevelInput } from "./types";

const priorities: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  success: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  off: Number.POSITIVE_INFINITY,
};

export function normalizeLevel(value: LogLevelInput | undefined, fallback: LogLevel = "info"): LogLevel {
  if (value === undefined) return fallback;
  const normalized = value === "warning" ? "warn" : value;
  if (!(normalized in priorities)) throw new Error(`Invalid RLog level: ${String(value)}`);
  return normalized;
}

export function shouldLog(level: LogLevel, threshold: LogLevel): boolean {
  return priorities[level] >= priorities[threshold];
}

export function parseArgvLevel(argv: readonly string[], argumentName: string): LogLevel | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === argumentName) return normalizeLevel(argv[index + 1] as LogLevelInput | undefined);
    if (argument.startsWith(`${argumentName}=`)) return normalizeLevel(argument.slice(argumentName.length + 1) as LogLevelInput);
  }
  return undefined;
}

export function labelFor(level: LogLevel, target: "screen" | "file"): string {
  switch (level) {
    case "trace": return "TRCE";
    case "debug": return "DEBG";
    case "info": return "INFO";
    case "success": return target === "screen" ? "SUCC" : "SUCCESS";
    case "warn": return "WARN";
    case "error": return target === "screen" ? "ERR!" : "ERROR";
    case "fatal": return "FATL";
    case "off": return "OFF";
  }
}
