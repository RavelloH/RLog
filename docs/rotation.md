# Size-based file rotation

RLog v3 rotates only normal `text` and `jsonl` sinks. Capture files intentionally retain their single-task-file semantics.

`maxBytes` is the active file threshold. `maxFiles` is the number of historical files retained, excluding the active file.

For `app.log` with `maxFiles: 3`, the files are:

```text
app.log     active
app.log.1   newest history
app.log.2
app.log.3   oldest history
```

Before a record is written, RLog tests `currentSize + recordSize > maxBytes`. If true, it flushes and closes the active stream, deletes the oldest history, renames histories from high to low, renames the active file to `.1`, opens a new active file, then writes the entire record. A record is never split across files. An oversized record is allowed as the first record of a new active file and does not cause a rotation loop.

`maxFiles: 0` means no history: the active file is discarded at rotation time and recreated. Rotation is serialized with sink writes; `flush()` and `close()` wait for it. On Windows, streams are closed before any rename.

Rotation failures use the existing `fileErrorPolicy` and `onFileError` callback with `operation: "rotate"`; the failed sink is disabled and other targets remain active.
