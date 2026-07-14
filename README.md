# RLog

RLog is a zero-runtime-dependency TypeScript logging and stream-capture library for Node.js CLI tools, automation workflows, build systems, and hardware tooling. It provides console-compatible formatting, independent screen/text/JSONL targets, structured events, Capture, deterministic shutdown, privacy redaction, and size-based file rotation.

## Features

- Console-style `...args` logging on every facade
- Independent `screen`, `text`, and JSON Lines (`jsonl`) targets
- Context, child loggers, metadata, and structured events
- Process, text-stream, and binary-stream Capture
- `flush()`, idempotent `close()`, and coordinated `exit()` lifecycle handling
- Safe JSON serialization and `blockedWordsList` / `redactKeys` privacy controls
- Size-based text and JSONL rotation using Node.js built-ins

## Install

```bash
npm install rlog-js
```

CommonJS remains supported:

```js
const Rlog = require("rlog-js");
```

TypeScript default imports remain supported:

```ts
import Rlog from "rlog-js";
```

## Quick start

```js
const Rlog = require("rlog-js");

const rlog = new Rlog({
  logFilePath: "./logs/app.log",
  jsonlFilePath: "./logs/events.jsonl",
});

rlog.info("connected to %s", "COM9");
rlog.success("flash complete in %dms", 42);
await rlog.close();
```

## Log levels

`trace`, `debug`, `info`, `success`, `warn` / `warning`, `error`, and `fatal` are available on the root logger and all target facades. `log(...args)` infers a level from the rendered message.

All level methods use Node.js console formatting semantics:

```js
rlog.info("device=%s retries=%d", "controller", 2);
rlog.screen.warn("unexpected value", { received: 12 });
```

## Output targets

The root facade writes to every configured target. A target facade writes only to that target.

```js
rlog.info("everywhere");        // screen + text + jsonl
rlog.screen.info("terminal");  // screen only
rlog.text.info("plain file");  // text only
rlog.jsonl.info("structured"); // JSONL only
```

`rlog.file` is a deprecated compatibility alias for `rlog.text`; both are the same instance (`rlog.file === rlog.text`). Existing `file.init()`, `file.logStream`, `file.writeLog()`, and `file.writeLogToStream()` remain available. Prefer `rlog.text.init()`, `rlog.text.stream`, and `rlog.text.writeRaw()` in new code.

## Custom time

Bind a timestamp explicitly with `at()`. It is lightweight and shares the logger's Dispatcher, sinks, streams, configuration, and lifecycle.

```js
const when = new Date("2026-07-14T10:00:00Z");
rlog.at(when).info("device=%s state=%s", "controller", "ready");
rlog.screen.at(when).info("screen only");
rlog.text.at(when).info("text only");
rlog.jsonl.at(when).info("JSONL only");
```

The second parameter to a level method is now always a normal log argument: `rlog.screen.info("value", 123)` renders `value 123`.

## Context, child loggers, and metadata

```js
const child = rlog.child({ device: "controller" });
child.text.info("connected").meta("port", "COM9");
child.jsonl.event("device.connected", { port: "COM9" }).meta({ requestId: "req-1" });
```

Metadata attaches until the dispatch microtask commits the entry. Calling `.meta()` afterwards throws `LogEntryAlreadyCommittedError`, as in v2.

## Structured events and JSONL

JSONL records keep v2 field names and add an `id` field:

```json
{"id":1,"timestamp":"2026-07-14T10:00:00.000Z","level":"info","message":"Device connected","args":[],"context":{},"meta":{},"event":null}
```

`rlog.jsonl.event()` writes only JSONL. JSON serialization safely handles BigInt, Date, Error (including causes), Buffer, undefined, Symbol, Function, circular references, depth limits, and redaction without mutating user objects.

## Redaction

Use `blockedWordsList` to mask rendered text and `redactKeys` to mask structured metadata/JSONL fields.

```js
const rlog = new Rlog({
  blockedWordsList: ["secret"],
  redactKeys: ["password", "token"],
});
```

## Capture

Capture APIs are unchanged:

```js
const processResult = await rlog.capture.process(child, { stdoutDisplay: "info" });
const streamHandle = rlog.capture.stream(readable, { file: "./logs/source.log", timestampLines: true });
const binaryHandle = rlog.capture.binary(readable, { file: "./logs/data.bin", computeSha256: true });
```

See [Capture details](docs/capture.md). Closing a logger settles active Capture work but never kills a captured child process.

## File rotation

Rotation is disabled by default and applies only to normal text and JSONL sinks, never Capture files.

```js
const rlog = new Rlog({
  logFilePath: "./logs/app.log",
  jsonlFilePath: "./logs/events.jsonl",
  textRotation: { maxBytes: 10 * 1024 * 1024, maxFiles: 5 },
  jsonlRotation: { maxBytes: 20 * 1024 * 1024, maxFiles: 3 },
});
```

See [rotation behavior](docs/rotation.md).

## flush, close, and exit

`await rlog.flush()` waits for queued records, screen writes, configured sink writes, active Capture data, and rotations; the logger remains usable afterwards. `await rlog.close()` is idempotent, rejects new user records once closing begins, settles Capture, flushes and closes sinks, then delivers deferred file errors.

`rlog.exit(message)` records `EXIT`, runs registered `onExit()` listeners in order, closes RLog resources, and exits with status `1` if a listener or close operation fails or times out.

## File errors

`fileErrorPolicy` accepts `throw` (default), `disable`, `stderr`, and `ignore`. Failures call `onFileError(error, context)` once. Context includes the target (`text`, `jsonl`, or `capture`) and operation (`open`, `write`, `flush`, `close`, or `rotate`). A failed target is disabled; other targets continue logging.

## Complete configuration

```ts
new Rlog({
  enableColorfulOutput: true,
  logFilePath: "./logs/app.log",
  jsonlFilePath: "./logs/events.jsonl",
  logLevel: "info",
  screenLogLevel: "info",
  fileLogLevel: "debug",
  jsonlLogLevel: "info",
  screenOutput: "stdout",
  screenMetadataOutput: "none",
  fileMetadataOutput: "block",
  timeFormat: "YYYY-MM-DD HH:mm:ss.SSS",
  timezone: "Asia/Shanghai",
  context: { service: "flasher" },
  blockedWordsList: [],
  redactKeys: ["token"],
  textRotation: false,
  jsonlRotation: false,
  fileErrorPolicy: "throw",
});
```

## API reference

- Root: level methods, `log`, `event`, `at`, `child`, `flush`, `close`, `progress`, `onExit`, `exit`
- Target facade: level methods, `event`, `at`; text/file also exposes its compatibility stream helpers
- Capture: `capture.process`, `capture.stream`, `capture.binary`
- Errors: `CaptureError`, `RLogClosedError`, `LogEntryAlreadyCommittedError`

## Migrating from v2

Read [the v3 migration guide](docs/migration-v3.md) before upgrading. The key behavioral change is replacing the old ambiguous second timestamp argument with `at(timestamp)`.

## Development and testing

```bash
npm ci
npm run build
npm test
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution expectations.
