# Migrating from RLog v2 to v3

## Target facades

`rlog.file` still works, but is deprecated. It is exactly the same facade instance as `rlog.text`:

```js
rlog.file === rlog.text; // true
```

Use `rlog.text` for normal text files. Add `rlog.jsonl` for JSON Lines-only output.

```js
rlog.info("all configured outputs");
rlog.text.info("text only");
rlog.jsonl.info("jsonl only");
```

## Explicit timestamps

v2 target methods treated a second parameter as a timestamp. v3 treats every level method as console-style `...args`.

```js
// v2: second value was interpreted as time
rlog.screen.info("ready", someTime);

// v3
rlog.screen.at(someTime).info("ready");

// v3: this is normal message data
rlog.screen.info("ready", someTime);
```

`at()` accepts the existing `Tostringable` type and returns a lightweight facade that shares all underlying resources.

## JSONL

`rlog.jsonl` writes only JSONL: it never writes screen or text output. Existing JSONL fields remain `timestamp`, `level`, `message`, `args`, `context`, `meta`, and `event`; v3 adds numeric `id`.

## File helpers

The v2 aliases are kept but deprecated:

| v2 | v3 preferred |
| --- | --- |
| `rlog.file.init()` | `rlog.text.init()` |
| `rlog.file.logStream` | `rlog.text.stream` |
| `rlog.file.writeLog()` | `rlog.text.writeRaw()` |
| `rlog.file.writeLogToStream()` | `rlog.text.writeRaw()` |

## Rotation

Rotation is new and disabled by default. Configure `textRotation` and `jsonlRotation` independently. `maxFiles` means the count of historical files and does not include the active file.

```js
new Rlog({
  logFilePath: "app.log",
  textRotation: { maxBytes: 1024 * 1024, maxFiles: 3 },
});
```

See [rotation.md](rotation.md) for details.
