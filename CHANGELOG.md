# Changelog

## 3.0.0

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
