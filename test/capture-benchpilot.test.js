const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { PassThrough, Readable } = require("node:stream");
const test = require("node:test");
const { createRlog, memoryWritable, temporaryDirectory } = require("./helpers/rlog");

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
