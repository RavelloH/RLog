# Changelog

## Unreleased

- Capture now inherits the calling child logger context and mirrors to `screen` only by default; `mirrorTargets` selects additional targets.
- Added Capture line callbacks, AbortSignal support, bounded source backpressure, bounded text lines, capture file modes, and `processHandle()`.
- Added JSONL Writable output, stable JSONL schema/version fields, and optional JSONL base fields.
- Added output-specific file error policies and defensive copies for mutable configuration arrays.
- Added `withSpan()` and `progressTask()` structured lifecycle helpers.
- Removed the unreachable `CAPTURE_DECODE_ERROR` code; text Capture documents Node.js replacement decoding instead.
- Fixed bounded line framing for complete newline-delimited chunks and truncated final tails.
- Fixed Capture failure finalization to drain accepted work before closing files, Binary Capture draining during close, non-destructive process hash snapshots, and independent JSONL file/Writable delivery.

## 3.0.0

Requires Node.js 20 or newer.

- Added target-based `screen`, `text`, and `jsonl` facades with consistent console-style `...args` level methods.
- Added `rlog.at()`, `rlog.screen.at()`, `rlog.text.at()`, and `rlog.jsonl.at()` for explicit timestamps.
- Added JSONL-only logging and structured events.
- Kept `rlog.file` as a deprecated alias for `rlog.text`.
- Reworked Dispatcher around a `Map<LogTarget, LogSink>`.
- Added independent size-based text and JSONL rotation.
- Added Node built-in test runner coverage and cross-platform CI.
- Reworked README and added migration, Capture, and rotation documentation.

### Breaking changes

- Target facade level methods no longer interpret a second argument as time; use `at(timestamp)`.
- Internal `LogDestination` has been replaced by explicit `LogTarget` / `LogTargets`.
