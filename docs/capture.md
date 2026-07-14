# Capture

RLog Capture supports child processes, text streams, and binary streams without changing the capture source's lifecycle.

- `capture.process(child, options)` captures stdout/stderr, optional file output, display mirroring, encoding, hashes, and process exit result.
- `capture.stream(stream, options)` incrementally decodes text, handles UTF-8 split across chunks, optional ANSI cleanup, per-line timestamps, marks, hashes, and an unterminated final line.
- `capture.binary(stream, options)` writes raw bytes and optionally computes SHA-256.

All handles expose `done`, `flush()`, and `close()`. The logger's `flush()` waits for active Capture data. The logger's `close()` asks active Capture work to settle but does not kill captured child processes. A final optional display mirror that races logger closing ignores only `RLogClosedError`; ordinary user logs are still rejected while closing.
