# Changelog

All notable changes to RLog are documented here.

## [3.1.0] - 2026-10-27

### Added

- Async context propagation with **withContext()** for request/task correlation.
- Lazy logging helpers so expensive diagnostic payloads are only created when needed.
- Optional queue record, serialized-byte and per-record size budgets, with explicit overflow policies.
- Instance-isolated text and JSONL files to avoid concurrent processes rotating the same file.
- Explicit file recovery, opt-in exponential-backoff auto-recovery, and **syncFiles()** durability checkpoints.
- Streaming JSONL reader helpers for querying active, rotated and instance-isolated log files.
- Bounded in-memory Flight Recorder snapshots and explicit export/clear/status APIs.
- Ordered processors and custom transports with flush/close lifecycle integration.
- Expanded diagnostics for queue pressure, dropped records, processor/transport errors, file failures and recovery.
- Linux-specific /dev/full fault-injection test and reusable throughput/soak benchmark scripts.
- GitHub Actions CI matrix for Node.js 20, 22 and 24 on Ubuntu, Windows and macOS.
- OIDC-based npm Trusted Publishing workflow, triggered only by a version tag.

### Improved

- Re-check serialized size after metadata/event enrichment and processor transformations so transformed records cannot bypass configured byte budgets.
- Report fsync failures through file-sink diagnostics and disable the affected sink according to its error policy.
- Use monotonic timing for span durations.
- Document file isolation, recovery, failure semantics, extension points and security boundaries.

### Compatibility and operational notes

- Node.js 20 or newer is required.
- Resource budgets, Flight Recorder and automatic file recovery are opt-in; defaults preserve existing queue and file-path behavior.
- The drop-debug policy intentionally drops only TRACE/DEBUG records under configured pressure; higher-severity records fail explicitly rather than being silently dropped.
- Instance isolation gives each logger instance its own file/rotation sequence; it is not a cross-process lock for a shared file.
- Automatic recovery does not replay writes whose outcome was uncertain.
- Capture files retain raw content and are not automatically covered by normal structured-log redaction.
