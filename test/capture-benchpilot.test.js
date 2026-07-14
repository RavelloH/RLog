const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { PassThrough, Readable } = require("node:stream");
const test = require("node:test");
const { createRlog, memoryWritable, temporaryDirectory } = require("./helpers/rlog");

function spawnOutputPump() {
  const script = [
    'const chunk = Buffer.alloc(64 * 1024, "x");',
    'const waitForDrain = (stream) => new Promise((resolve) => stream.once("drain", resolve));',
    'const writeMany = async (stream, count) => { for (let index = 0; index < count; index += 1) if (!stream.write(chunk)) await waitForDrain(stream); };',
    'process.stdout.write("accepted-out\\n");',
    'process.stderr.write("accepted-err\\n");',
    'process.send({ type: "ready" });',
    'process.on("message", async (message) => {',
    '  if (message === "pump") { await Promise.all([writeMany(process.stdout, 192), writeMany(process.stderr, 192)]); process.send({ type: "pumped" }); }',
    '  if (message === "handoff") { process.stdout.write("handoff-out\\n"); process.stderr.write("handoff-err\\n"); process.send({ type: "handed-off" }); }',
    '});',
  ].join("\n");
  return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
}

function waitForMessage(child, type) {
  return new Promise((resolve) => {
    const listener = (message) => {
      if (message?.type !== type) return;
      child.removeListener("message", listener);
      resolve();
    };
    child.on("message", listener);
  });
}

function waitForChildClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}

async function terminateChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await waitForChildClose(child);
}

function listenerCounts(stream) {
  return Object.fromEntries(["data", "error", "end", "close"].map((event) => [event, stream.listenerCount(event)]));
}

test("child Capture mirrors retain child context and default only to screen", async () => {
  const temp = temporaryDirectory();
  try {
    const screen = memoryWritable();
    const text = path.join(temp.directory, "benchpilot.log");
    const jsonl = path.join(temp.directory, "events.jsonl");
    const rlog = createRlog({ screenOutput: screen.stream, logFilePath: text, jsonlFilePath: jsonl });
    const serial = rlog.child({ device: "controller", stage: "serial" });
    const capture = serial.capture.stream(Readable.from(["ready\n"]), { displayLevel: "info" });
    capture.mark("device-reconnected", { port: "COM9" });
    await capture.done;
    await rlog.close();

    assert.match(screen.text(), /ready/);
    assert(!fs.existsSync(text) || !/ready/.test(fs.readFileSync(text, "utf8")));
    const records = fs.readFileSync(jsonl, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 1);
    assert.equal(records[0].event.type, "capture.mark");
    assert.deepEqual(records[0].context, { device: "controller", stage: "serial" });
  } finally { temp.cleanup(); }
});

test("Capture mirrorTargets can explicitly include JSONL", async () => {
  const temp = temporaryDirectory();
  try {
    const jsonl = path.join(temp.directory, "events.jsonl");
    const rlog = createRlog({ screenOutput: "none", jsonlFilePath: jsonl });
    const child = rlog.child({ device: "vision" });
    await child.capture.stream(Readable.from(["booted\n"]), { displayLevel: "info", mirrorTargets: new Set(["jsonl"]) }).done;
    await rlog.close();
    const record = JSON.parse(fs.readFileSync(jsonl, "utf8"));
    assert.equal(record.message, "booted");
    assert.deepEqual(record.context, { device: "vision" });
  } finally { temp.cleanup(); }
});

test("text Capture provides decoded lines, handles consumer errors, and bounds oversized lines", async () => {
  const lines = [];
  const rlog = createRlog({ screenOutput: "none" });
  const result = await rlog.capture.stream(Readable.from([Buffer.from([0xe4, 0xb8]), Buffer.from([0xad, 0x0a]), "tail"]), {
    onLine: (line) => lines.push(line),
  }).done;
  assert.deepEqual(lines.map((line) => [line.text, line.terminated, line.lineNumber]), [["中", true, 1], ["tail", false, 2]]);
  assert.equal(result.lines, 2);
  await rlog.close();

  const consumerLogger = createRlog({ screenOutput: "none" });
  await assert.rejects(
    consumerLogger.capture.stream(Readable.from(["ready\n"]), { onLine: () => { throw new Error("handshake invalid"); } }).done,
    (error) => error.code === "CAPTURE_CONSUMER_ERROR",
  );
  await consumerLogger.close();

  const overflowLogger = createRlog({ screenOutput: "none" });
  await assert.rejects(
    overflowLogger.capture.stream(Readable.from(["abcdef"]), { maxLineBytes: 3, lineOverflowPolicy: "error" }).done,
    (error) => error.code === "CAPTURE_LINE_TOO_LONG",
  );
  await overflowLogger.close();
});

test("line limits apply before complete newline-delimited lines are emitted", async () => {
  for (const input of ["abcdef", "abcdef\n"]) {
    const lines = [];
    const rlog = createRlog({ screenOutput: "none" });
    await rlog.capture.stream(Readable.from([input]), {
      maxLineBytes: 3,
      lineOverflowPolicy: "truncate",
      onLine: (line) => lines.push(line.text),
    }).done;
    assert.deepEqual(lines, ["abc…"]);
    await rlog.close();
  }

  const rlog = createRlog({ screenOutput: "none" });
  await assert.rejects(
    rlog.capture.stream(Readable.from(["abcdef\n"]), { maxLineBytes: 3, lineOverflowPolicy: "error" }).done,
    (error) => error.code === "CAPTURE_LINE_TOO_LONG",
  );
  await rlog.close();
});

test("a Capture failure drains accepted work and never writes later queued chunks", async () => {
  const temp = temporaryDirectory();
  try {
    const file = path.join(temp.directory, "consumer-failure.log");
    const rlog = createRlog({ screenOutput: "none", fileErrorPolicy: { capture: "ignore" } });
    const capture = rlog.capture.stream(Readable.from(["one\n", "two\n", "three\n"]), {
      file,
      onLine: (line) => { if (line.text === "two") throw new Error("stop after two"); },
    });
    await assert.rejects(capture.done, (error) => error.code === "CAPTURE_CONSUMER_ERROR");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.readFileSync(file, "utf8"), "one\ntwo\n");
    await rlog.close();
  } finally { temp.cleanup(); }
});

test("Capture defaults to truncation, supports exclusive files, and AbortSignal settles without killing a source", async () => {
  const temp = temporaryDirectory();
  try {
    const file = path.join(temp.directory, "serial.log");
    fs.writeFileSync(file, "old\n");
    const rlog = createRlog({ screenOutput: "none" });
    await rlog.capture.stream(Readable.from(["new\n"]), { file }).done;
    assert.equal(fs.readFileSync(file, "utf8"), "new\n");
    await assert.rejects(
      rlog.capture.stream(Readable.from(["other\n"]), { file, fileMode: "exclusive" }).done,
      (error) => error.code === "CAPTURE_FILE_ERROR",
    );

    const controller = new AbortController();
    const source = new PassThrough();
    const aborted = rlog.capture.stream(source, { signal: controller.signal, file: path.join(temp.directory, "abort.log") });
    source.write("accepted\n");
    controller.abort();
    await assert.rejects(aborted.done, (error) => error.code === "CAPTURE_ABORTED");
    assert.equal(source.destroyed, false);
    await assert.rejects(rlog.close(), /EEXIST/);
  } finally { temp.cleanup(); }
});

test("processHandle aborts Capture without killing the child process", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const rlog = createRlog({ screenOutput: "none" });
  const capture = rlog.capture.processHandle(child, { stdoutDisplay: "none", stderrDisplay: "none" });
  await assert.rejects(capture.abort("operation-timeout"), (error) => error.code === "CAPTURE_ABORTED");
  assert.equal(child.killed, false);
  child.kill();
  await new Promise((resolve) => child.once("close", resolve));
  await rlog.close();
});

test("Process Capture defaults to drain without blocking a caller-owned child or leaking listeners", { timeout: 15000 }, async () => {
  const child = spawnOutputPump();
  const rlog = createRlog({ screenOutput: "none" });
  const stdoutBaseline = listenerCounts(child.stdout);
  const stderrBaseline = listenerCounts(child.stderr);
  try {
    const capture = rlog.capture.processHandle(child, {
      stdoutDisplay: "none",
      stderrDisplay: "none",
      onStdoutLine: (line) => { if (line.text === "accepted-out") child.emit("capture-ready-out"); },
      onStderrLine: (line) => { if (line.text === "accepted-err") child.emit("capture-ready-err"); },
    });
    const ready = waitForMessage(child, "ready");
    const accepted = Promise.all([
      new Promise((resolve) => child.once("capture-ready-out", resolve)),
      new Promise((resolve) => child.once("capture-ready-err", resolve)),
    ]);
    await ready;
    await accepted;
    await assert.rejects(capture.abort(), (error) => error.code === "CAPTURE_ABORTED");
    assert.equal(child.killed, false);
    await new Promise((resolve) => setImmediate(resolve));
    for (const [stream, baseline] of [[child.stdout, stdoutBaseline], [child.stderr, stderrBaseline]]) {
      assert.equal(stream.listenerCount("data"), baseline.data + 1);
      assert.equal(stream.listenerCount("error"), baseline.error + 1);
      assert.equal(stream.listenerCount("end"), baseline.end + 1);
      assert.equal(stream.listenerCount("close"), baseline.close + 1);
    }
    child.send("pump");
    await waitForMessage(child, "pumped");
  } finally {
    await terminateChild(child);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(listenerCounts(child.stdout), stdoutBaseline);
    assert.deepEqual(listenerCounts(child.stderr), stderrBaseline);
    await rlog.close();
  }
});

test("Logger close drains Process Capture without waiting for the child", { timeout: 15000 }, async () => {
  const child = spawnOutputPump();
  const rlog = createRlog({ screenOutput: "none" });
  try {
    const capture = rlog.capture.processHandle(child, { stdoutDisplay: "none", stderrDisplay: "none" });
    await waitForMessage(child, "ready");
    await rlog.close();
    await assert.rejects(capture.done, (error) => error.code === "CAPTURE_ABORTED_BY_LOGGER_CLOSE");
    assert.equal(child.killed, false);
    child.send("pump");
    await waitForMessage(child, "pumped");
  } finally { await terminateChild(child); }
});

test("Process Capture pause is explicit and leaves both output streams paused", async () => {
  const child = spawnOutputPump();
  const rlog = createRlog({ screenOutput: "none" });
  try {
    const capture = rlog.capture.processHandle(child, { stdoutDisplay: "none", stderrDisplay: "none", detachMode: "pause" });
    await waitForMessage(child, "ready");
    await assert.rejects(capture.abort(), (error) => error.code === "CAPTURE_ABORTED");
    assert.equal(child.stdout.isPaused(), true);
    assert.equal(child.stderr.isPaused(), true);
  } finally { await terminateChild(child); await rlog.close(); }
});

test("Process Capture handoff lets the caller consume later stdout and stderr without recording them", async () => {
  const temp = temporaryDirectory();
  const child = spawnOutputPump();
  const rlog = createRlog({ screenOutput: "none" });
  try {
    const stdout = [];
    const stderr = [];
    const capture = rlog.capture.processHandle(child, {
      stdoutFile: path.join(temp.directory, "stdout.log"),
      stderrFile: path.join(temp.directory, "stderr.log"),
      stdoutDisplay: "none",
      stderrDisplay: "none",
      detachMode: "handoff",
    });
    await waitForMessage(child, "ready");
    await capture.flush();
    await assert.rejects(capture.abort(), (error) => error.code === "CAPTURE_ABORTED");
    child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    child.send("handoff");
    await waitForMessage(child, "handed-off");
    assert.match(stdout.join(""), /handoff-out/);
    assert.match(stderr.join(""), /handoff-err/);
    assert.doesNotMatch(fs.readFileSync(path.join(temp.directory, "stdout.log"), "utf8"), /handoff-out/);
    assert.doesNotMatch(fs.readFileSync(path.join(temp.directory, "stderr.log"), "utf8"), /handoff-err/);
  } finally { await terminateChild(child); await rlog.close(); temp.cleanup(); }
});

test("Process Capture drain excludes post-abort output from partial bytes, lines, and hashes", async () => {
  const temp = temporaryDirectory();
  const child = spawnOutputPump();
  const rlog = createRlog({ screenOutput: "none" });
  try {
    const stdoutFile = path.join(temp.directory, "stdout.log");
    const stderrFile = path.join(temp.directory, "stderr.log");
    const capture = rlog.capture.processHandle(child, { stdoutFile, stderrFile, stdoutDisplay: "none", stderrDisplay: "none", computeSha256: true });
    await waitForMessage(child, "ready");
    await capture.flush();
    let error;
    try { await capture.abort(); } catch (reason) { error = reason; }
    assert.equal(error.code, "CAPTURE_ABORTED");
    child.send("pump");
    await waitForMessage(child, "pumped");
    const expectedOut = "accepted-out\n";
    const expectedErr = "accepted-err\n";
    assert.equal(error.partialResult.stdoutBytes, Buffer.byteLength(expectedOut));
    assert.equal(error.partialResult.stderrBytes, Buffer.byteLength(expectedErr));
    assert.equal(error.partialResult.stdoutLines, 1);
    assert.equal(error.partialResult.stderrLines, 1);
    assert.equal(error.partialResult.stdoutSha256, createHash("sha256").update(expectedOut).digest("hex"));
    assert.equal(error.partialResult.stderrSha256, createHash("sha256").update(expectedErr).digest("hex"));
    assert.equal(fs.readFileSync(stdoutFile, "utf8"), expectedOut);
    assert.equal(fs.readFileSync(stderrFile, "utf8"), expectedErr);
  } finally { await terminateChild(child); await rlog.close(); temp.cleanup(); }
});

test("Binary Capture drains a paused Readable buffer before logger close", async () => {
  const temp = temporaryDirectory();
  try {
    const file = path.join(temp.directory, "paused.bin");
    const source = new PassThrough();
    const rlog = createRlog({ screenOutput: "none" });
    const capture = rlog.capture.binary(source, { file, highWaterMarkBytes: 4, lowWaterMarkBytes: 1, maxPendingBytes: 64 });
    source.write(Buffer.from("aaaa"));
    source.write(Buffer.from("bbbb"));
    await rlog.close();
    await capture.done;
    assert.equal(fs.readFileSync(file, "utf8"), "aaaabbbb");
  } finally { temp.cleanup(); }
});

test("process Capture delivers decoded stdout and stderr line callbacks", async () => {
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, ["-e", "process.stdout.write('boot\\n'); process.stderr.write('warn\\n')"]);
  const rlog = createRlog({ screenOutput: "none" });
  const result = await rlog.capture.process(child, {
    stdoutDisplay: "none",
    stderrDisplay: "none",
    onStdoutLine: (line) => stdout.push(line.text),
    onStderrLine: (line) => stderr.push(line.text),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(stdout, ["boot"]);
  assert.deepEqual(stderr, ["warn"]);
  await rlog.close();
});

test("process Capture errors retain process timing, files, and non-destructive hash snapshots", async () => {
  const temp = temporaryDirectory();
  try {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('boot\\n'); setTimeout(() => process.stdout.write('later\\n'), 20)"]);
    const rlog = createRlog({ screenOutput: "none", fileErrorPolicy: { capture: "ignore" } });
    const started = Date.now();
    await assert.rejects(
      rlog.capture.process(child, {
        stdoutFile: temp.directory,
        computeSha256: true,
        stdoutDisplay: "none",
        stderrDisplay: "none",
      }),
      (error) => {
        assert.equal(error.code, "CAPTURE_FILE_ERROR");
        assert.equal(error.partialResult.stdoutFile, temp.directory);
        assert.equal(error.partialResult.failedChannel, "stdout");
        assert(error.partialResult.startedAt.valueOf() >= started - 10);
        assert(error.partialResult.durationMs >= 0);
        assert.match(error.partialResult.stdoutSha256, /^[a-f0-9]{64}$/);
        return true;
      },
    );
    await rlog.close();
  } finally { temp.cleanup(); }
});
