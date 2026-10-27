# RLog 3.1.0 reliability and async context

This page describes **opt-in, backwards-compatible** improvements in the 3.1 development branch. No automatic publishing or migration occurs.

## Security: formatted messages and structured arguments

When redactKeys is configured, RLog redacts matching object keys **before** formatting log messages, and uses redacted arguments for Screen, Text and JSONL sinks, including Capture-mirrored arguments.

~~~js
const rlog = new Rlog({
  redactKeys: ["accessToken", "password"],
  jsonlFilePath: "./logs/events.jsonl",
});
rlog.info({ accessToken: "private", result: "ok" });
~~~

The key value is masked in the formatted message and structured args. **Important:** arbitrary literal strings, embedded token substrings, and developer-provided event messages cannot always be identified by field-name rules. Configure blockedWordsList or sanitize strings before logging. RLog is not a universal secret detector.

## Bounded accepted-record queue

The dispatcher supports an optional cap on accepted, not-yet-dispatched records, including in-flight operations. This is **not** a byte-level memory limit; very large records may still consume substantial memory.

~~~js
const rlog = new Rlog({
  jsonlFilePath: "./events.jsonl",
  maxQueuedRecords: 4096,
  queueOverflowPolicy: "drop-debug", // or "throw"
});
~~~

At capacity:
- throw: reject new records synchronously with RLogQueueFullError.
- drop-debug: skip new TRACE/DEBUG records and increase droppedRecords, but **throw** for INFO and more severe events.
- With no maxQueuedRecords: retain the v3 unlimited behavior for compatibility.

The drop policy is explicit opt-in. A successful enqueue does not guarantee physical disk durability; flush waits for streams but does not fsync.

## Async context propagation

~~~js
await rlog.withContext({ requestId: "req-42" }, async () => {
  await Promise.resolve();
  rlog.jsonl.event("request.completed", { ok: true });
});
~~~

Concurrent async scopes are isolated. Nested scopes inherit from parents. Existing child(context) is compatible; the latest async scope takes precedence if a key overlaps.

## Lazy logging

~~~js
rlog.debugLazy(() => ["snapshot", buildSnapshot()]);
rlog.jsonl.debugLazy(() => ["target snapshot", buildSnapshot()]);
rlog.logLazy("trace", () => ["details", collectTrace()]);
if (rlog.isEnabled("debug")) { /* ... */ }
~~~

The callback runs only when the selected output target can accept that level. Callback exceptions propagate synchronously.

## Read-only diagnostics

~~~js
const state = rlog.diagnostics();
// {
//   queuedRecords: 12,
//   maxQueuedRecords: 4096,
//   droppedRecords: 3,
//   sinkActive: { text: false, jsonl: true },
//   fileErrors: 0,
//   deferredErrors: 0
// }
~~~

After a file error, lastFileError contains the output, operation, truncated message and ISO timestamp. Snapshots do not reset counters.

## Timing

Span durations now use performance.now() rather than wall-clock subtraction; logged timestamps remain wall clock.

## Follow-up work requiring separate fault-injection testing

- Cross-process coordinated writes or a dedicated single-writer transport.
- File Sink reopen/retry after I/O errors and explicit fsync durability modes.
- Time retention, compression and log-query readers.
- Flight Recorder, processors/transports, OpenTelemetry adapters, error deduplication.
- Byte-level queue ceilings and maximum record sizes.

The per-instance Promise queue is **not** a cross-process lock. See the rotation and Capture guides for their existing guarantees.


## Explicit file recovery and OS sync

RLog does not automatically reopen a disabled file sink after an I/O error, because it
cannot infer whether past writes completed. The application can opt in to recovery:

~~~js
const outcome = await rlog.recoverFiles();
// { text: true | false | null, jsonl: true | false | null }
~~~

- true: the local destination is usable or the reopen attempt succeeded.
- false: the local destination remains unavailable.
- null: this destination has no configured path.
- Previously failed records are **not replayed**. The caller must handle application-level delivery guarantees.
- Caller-owned JSONL Writable streams are not reopened or reset by recoverFiles().

For critical checkpoints, use:

~~~js
await rlog.syncFiles();
~~~

This drains pending logger records and asks the OS to fsync the opened local text and
JSONL files. It is more expensive than flush(), and is **not a universal guarantee
against power loss or hardware cache failures**. If a configured file was never opened,
there is no handle to sync. syncFiles() never synchronizes remote/user-owned streams.

## Multi-process-safe isolation (opt-in)

Independent Node.js processes **must not** share the same rotating file path under
the default shared mode. Promise write queues and file size rotation are per Logger
instance, not cross-process locks.

For safe concurrent writers without coordinating an IPC writer process, choose
isolated files:

~~~js
const rlog = new Rlog({
  jsonlFilePath: "./logs/events.jsonl",
  jsonlFileIsolation: "instance",
  jsonlRotation: { maxBytes: 2 * 1024 * 1024, maxFiles: 3 },
  textFileIsolation: "instance", // optional if logFilePath is configured
});
console.log(rlog.filePaths().jsonl);
~~~

An instance creates a stable unique path such as
events.1234.d177e6e86b9c4ecbaf1d08447992391f.jsonl. Its rotations use that
resolved filename, and different processes/instances never need to rename the same
file. The default is "shared" to preserve the existing v3 file naming behavior.

**Tradeoff:** file budgets are per instance, not an aggregate storage quota; a host
application must clean up obsolete instance files. One global chronological stream
is not guaranteed without an external merger.

## Read isolated and rotated JSONL files

~~~js
const { listJsonlFiles, readJsonl } = require("rlog-js");

const names = await listJsonlFiles("./logs/events.jsonl");
for await (const row of readJsonl({
  filePath: "./logs/events.jsonl",
  levels: ["warn", "error", "fatal"],
  eventTypes: ["worker.exited", "oauth.refresh_failed"],
  since: new Date(Date.now() - 24 * 60 * 60 * 1000),
  limit: 1000,
})) {
  console.log(row.filePath, row.lineNumber, row.record);
}
~~~

The reader uses streaming parsing and bounded memory. It recognizes the shared base
file, rotated backups, and instance-isolated file families. It preserves rotation
order **within an instance**, not a global chronological ordering across independent
instances. A read while another process is rotating does not provide snapshot
isolation. By default malformed lines raise an error with path and line number;
set skipMalformed: true only when the consumer intentionally accepts data loss.


## Flight Recorder (opt-in, bounded, in-memory)

RLog can retain debug context even when normal outputs filter out DEBUG and TRACE.
It does **not** automatically persist or replay these events. Applications decide
when to export a snapshot, such as in an explicit error handler.

~~~js
const logger = new Rlog({
  jsonlFilePath: "./logs/app.jsonl",
  jsonlLogLevel: "info",
  flightRecorder: {
    maxRecords: 200,
    maxBytes: 256 * 1024,
    captureLevels: ["trace", "debug"],
    // includeEventData: false, // default
  },
});

logger.debug("before the error"); // Normally filtered; retained in RAM.
console.log(logger.flightRecorderStatus());
// { enabled, records, bytes, evictedRecords, oversizedRecords, captureErrors }
const snapshot = logger.flightRecorderSnapshot(); // detached, mutable copies
await logger.exportFlightRecorder("./logs/diagnostic-snapshot.jsonl"); // exclusive, 0600
logger.clearFlightRecorder();
~~~

- Default is disabled. Passing an object enables the recorder.
- It captures accepted logs **before** normal Sink severity filtering.
- Records are bounded by serialized bytes AND record count. Oversized entries
  are skipped, not partially serialized. Ring-buffer evictions are counted.
- Fields and user-supplied objects follow existing RLog redaction rules. Event
  data is excluded unless includeEventData is explicitly true. No record args
  are stored separately: the message is formatted, not a binary payload.
- **Do not treat redaction as a guarantee against secrets in literal strings.**
  Blocked text patterns and application-level data classification still matter.
- Snapshot export uses wx/exclusive creation; an existing file is never
  overwritten. Export is not automatic on fatal or process exit, and the caller
  must create the destination directory and handle file I/O errors.
- Disabled by default so existing RLog users retain no additional log records in memory.
- Changing flightRecorder options through setConfig updates limits at the next
  capture/snapshot; explicitly disabling clears the ring on next access.

## Optional record and queue byte budgets

~~~js
const logger = new Rlog({
  maxQueuedRecords: 4096,
  maxQueuedBytes: 2 * 1024 * 1024,
  maxRecordBytes: 16 * 1024,
  queueOverflowPolicy: "drop-debug", // opt-in, or use "throw"
});
console.log(logger.diagnostics().queuedBytes);
~~~

Both byte limits are disabled unless explicitly configured. Byte sizing uses
the safely serialized representation of the pending LogRecord (message,
arguments, context, metadata, event). Since runtime object allocation and
output-specific JSONL/text framing can differ, this is **a bounded
serialization estimate, not an exact process-RSS or file-size guarantee**.
Very large original arguments are formatted before these limits are applied.

- maxRecordBytes rejects individual oversized records synchronously when
  already oversized at creation.
- maxQueuedBytes limits cumulative accepted pending work, including in-flight
  writes.
- If metadata or an event payload is attached via a chain after the logging
  call, the new size is rechecked before dispatch. In that case a rejection is
  reported on flush() or close(), not from the original log call.
- When either byte budget is enabled, Screen writes wait until the record
  has passed the metadata/event recheck instead of using the legacy early
  output behavior.
- On overflow, the explicit "drop-debug" policy may skip TRACE/DEBUG. Other
  levels cause RLogRecordTooLargeError or RLogQueueBytesExceededError.
- A runtime change to limits applies to subsequent accepting/checking actions;
  pending records are not retroactively resized at configuration change time.

The budget does not cover Capture stream buffers; Capture has independent
backpressure controls. Application owners must set limits appropriate for
their machine and workload.


## Extensibility: Processor and Transport pipeline (opt-in)

Configure processors to enrich, normalize or filter records. Processors are invoked
**serially after the current-turn metadata/event chain is complete**, but before
the built-in Screen, Text and JSONL sinks. Returning null intentionally drops a
record; returning undefined preserves in-place edits; returning a LogRecord
replaces it. Processor callbacks may be async.

~~~js
const logger = new Rlog({
  screenOutput: "none",
  jsonlFilePath: "./events.jsonl",
  processors: [
    async record => {
      if (record.event?.type === "heartbeat") return null;
      record.context = { ...record.context, deployment: "local" };
      return record;
    },
  ],
  transports: [
    {
      async write(record) {
        // Caller-provided output. It receives a sanitized detached snapshot.
        await externalSink.write(record);
      },
      async flush() { await externalSink.flush(); },
      async close() { await externalSink.close(); },
    },
  ],
});
~~~

- All hooks are **opt-in**. By default, the v3 direct-to-sink path remains.
- Processors receive a sanitized copy; newly added structured properties are
  sanitized again before built-in sinks and transports.
- Processor transformations to message appear in all three built-in outputs.
  They should update both args and message when the two need to agree.
- Exceptions are reported by flush() or close(); a failed processor does not
  send that record to built-in sinks or transports. Later records are processed
  normally. A null result intentionally drops the record; it is counted in
  diagnostics().processorDropped.
- Each transport receives a separate detached sanitized object after built-in
  sinks have been attempted. One transport failure does not block the next
  transport or prevent built-in output, but is reported by flush()/close().
  Writes are serial within one RLog dispatcher.
- Transport hooks may be slow: they contribute to pending queue pressure, so
  configure maxQueuedRecords/maxQueuedBytes for heavy use.
- Lazy logging considers the Flight Recorder and transports, not only the
  severity thresholds of built-in sinks. If a transport is configured, it
  receives logging calls regardless of built-in sink thresholds; implement
  filtering in processors or the transport itself.
- Processor or transport code is **trusted application code**. Do not pass
  untrusted plugins; structured redaction does not recognize secrets embedded
  in arbitrary literal strings. Plugins should avoid retaining large object
  graphs indefinitely.

## Opportunistic file recovery (opt-in)

~~~js
const logger = new Rlog({
  jsonlFilePath: "./events.jsonl",
  fileErrorPolicy: "disable",
  autoRecoverFiles: {
    initialDelayMs: 1000,
    maxDelayMs: 60000,
    multiplier: 2,
  },
});
const recovery = logger.diagnostics().recovery.jsonl;
// { disabled, attempts, successes, failures, nextAttemptAt, skippedRecords }
~~~

An existing file Sink may be disabled by failed open, write, flush, or rotate.
Once disabled, a **subsequent new append** can trigger an attempt to reopen it,
but only after its next allowed retry time. There are **no timers**, background
tasks or writes while the application is idle. Each destination tracks its own
cooldown and success/failure counts.

If the retry succeeds, only that new record and later records are written.
Records with uncertain outcome are never replayed. A manual recoverFiles()
attempt still bypasses the automatic cooldown. Capture-managed files and
caller-owned Writable streams do not use this feature.

By default autoRecoverFiles is false and existing v3 behavior is retained.
There is no guarantee a write succeeds merely because recovery reopened the
stream; later I/O failures are handled using the existing fileErrorPolicy.
Applications needing at-least-once/exactly-once delivery must own a durable
application-level journal.
