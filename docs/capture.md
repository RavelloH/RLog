# Capture

RLog Capture supports child processes, text streams, and binary streams without changing the capture source's lifecycle.

- `capture.process(child, options)` captures stdout/stderr, optional file output, target-selectable display mirroring, decoded line callbacks, encoding, hashes, and process exit result.
- `capture.processHandle(child, options)` returns a handle for `flush()` and Capture-only `abort()`; it does not kill the caller-owned child unless `killProcessOnAbort` is explicitly enabled.
- `capture.stream(stream, options)` incrementally decodes text, handles UTF-8 split across chunks, optional ANSI cleanup, per-line timestamps, marks, hashes, an unterminated final line, and `onLine` protocol consumers.
- `capture.binary(stream, options)` writes raw bytes and optionally computes SHA-256.

Text and binary handles expose `done`, `flush()`, `close()`, and `abort()`. Process handles expose `done`, `flush()`, and `abort()`. The logger's `flush()` waits for active Capture data. The logger's `close()` asks active Capture work to settle but does not kill captured child processes. A final optional display mirror may drain during logger closing; ordinary user logs are still rejected while closing.

## Routing, context, and consumers

Capture created from a child logger inherits that child context for mirror records and `capture.mark()` events. Mirroring defaults to `screen` only, so a high-frequency serial capture does not also flood text and JSONL. `capture.mark()` is instead emitted as a low-frequency JSONL structured event. Set `mirrorTargets` to `"all"` or a target set only when line duplication is intentional.

`onLine`, `onStdoutLine`, and `onStderrLine` receive decoded `CaptureLine` values: `text`, `timestamp`, `terminated`, and `lineNumber`; process callbacks also receive `channel`. Callback errors fail Capture with `CAPTURE_CONSUMER_ERROR` by default. Set `consumerErrorPolicy: "ignore"` for observers that must not affect an operation.

## File safety, cancellation, and backpressure

Capture files use `fileMode: "truncate"` by default. Use `"exclusive"` for evidence files that must never overwrite an existing path, or `"append"` only when concatenation is intentional. Capture files are not rotated.

All Capture options accept `signal`. Aborting stops accepting new source data, flushes queued writes, closes Capture files, and rejects `done` with `CAPTURE_ABORTED`. It does not terminate a process unless `killProcessOnAbort` is set.

Capture pauses a readable source at `highWaterMarkBytes` (default 4 MiB) and resumes it below `lowWaterMarkBytes` (default 1 MiB). `maxPendingBytes` defaults to 16 MiB and rejects with `CAPTURE_BUFFER_OVERFLOW` instead of allowing unbounded memory growth. Text captures also default `maxLineBytes` to 1 MiB; choose `lineOverflowPolicy: "split"`, `"truncate"`, or `"error"`.

## Security

Capture files contain external stream data. RLog does not apply `blockedWordsList` or `redactKeys` to them, so they can contain tokens, passwords, device output, or other sensitive material. Choose a safe location, set suitable permissions, and clean up files according to your retention policy. Capture files are task files and do not participate in normal text or JSONL rotation.
