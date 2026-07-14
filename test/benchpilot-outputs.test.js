const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Writable } = require("node:stream");
const test = require("node:test");
const { createRlog, memoryWritable, temporaryDirectory } = require("./helpers/rlog");

test("JSONL can write a file and caller-owned Writable with a stable schema", async () => {
  const temp = temporaryDirectory();
  try {
    const file = path.join(temp.directory, "events.jsonl");
    const output = memoryWritable();
    const rlog = createRlog({
      screenOutput: "none",
      jsonlFilePath: file,
      jsonlOutput: output.stream,
      jsonlBaseFields: { producer: "benchpilot", schema: "caller-must-not-override" },
    });
    rlog.jsonl.event("stage.started", { stage: "flash" }).meta({ runId: "r-1" });
    await rlog.close();
    const disk = fs.readFileSync(file, "utf8");
    assert.equal(output.text(), disk);
    const record = JSON.parse(disk);
    assert.equal(record.schema, "rlog.record");
    assert.equal(record.version, 1);
    assert.equal(record.producer, "benchpilot");
    assert.equal(record.event.type, "stage.started");
  } finally { temp.cleanup(); }
});

test("config defensively copies mutable logging and redaction options", async () => {
  const blocked = ["secret"];
  const keys = ["token"];
  const rules = [{ reg: "ready", color: "green" }];
  const rlog = createRlog({ screenOutput: "none", blockedWordsList: blocked, redactKeys: keys, customColorRules: rules });
  blocked.length = 0; keys.length = 0; rules[0].reg = "changed";
  assert.deepEqual(rlog.config.blockedWordsList, ["secret"]);
  assert.deepEqual(rlog.config.redactKeys, ["token"]);
  assert.equal(rlog.config.customColorRules[0].reg, "ready");
  await rlog.close();
});

test("file error policy can make JSONL critical while text and Capture tolerate failure", async () => {
  const temp = temporaryDirectory();
  try {
    const rlog = createRlog({
      screenOutput: "none",
      logFilePath: temp.directory,
      jsonlFilePath: temp.directory,
      fileErrorPolicy: { text: "ignore", jsonl: "throw", capture: "ignore" },
    });
    rlog.info("text failure is tolerated");
    rlog.jsonl.info("jsonl failure is critical");
    await assert.rejects(rlog.close(), /EISDIR|EACCES|EPERM/);
  } finally { temp.cleanup(); }
});

test("JSONL Writable failures use the jsonl file-error policy while the file destination remains usable", async () => {
  const temp = temporaryDirectory();
  try {
    const file = path.join(temp.directory, "events.jsonl");
    const broken = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("agent pipe closed")); } });
    const tolerant = createRlog({ screenOutput: "none", jsonlFilePath: file, jsonlOutput: broken, fileErrorPolicy: { jsonl: "ignore" } });
    tolerant.jsonl.info("persisted despite stream failure");
    await tolerant.close();
    assert.match(fs.readFileSync(file, "utf8"), /persisted despite stream failure/);

    const strict = createRlog({ screenOutput: "none", jsonlOutput: new Writable({ write(_chunk, _encoding, callback) { callback(new Error("agent pipe closed")); } }), fileErrorPolicy: { jsonl: "throw" } });
    strict.jsonl.info("must fail");
    await assert.rejects(strict.close(), /agent pipe closed/);
  } finally { temp.cleanup(); }
});

test("spans and progress tasks emit structured lifecycle events with child context", async () => {
  const temp = temporaryDirectory();
  try {
    const file = path.join(temp.directory, "events.jsonl");
    const rlog = createRlog({ screenOutput: "none", jsonlFilePath: file });
    const device = rlog.child({ device: "controller" });
    const value = await device.withSpan("flash", { image: "firmware.bin" }, async (span) => {
      span.info("Connecting");
      return 42;
    });
    assert.equal(value, 42);
    const progress = device.progressTask({ label: "Flashing controller", total: 100 });
    progress.update(35);
    progress.complete({ image: "firmware.bin" });
    await rlog.close();
    const events = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    assert(events.some((record) => record.event?.type === "span.started" && record.context.device === "controller"));
    assert(events.some((record) => record.event?.type === "span.completed" && record.context.span === "flash"));
    assert(events.some((record) => record.event?.type === "progress.updated" && record.context.device === "controller"));
    assert(events.some((record) => record.event?.type === "progress.completed" && record.context.device === "controller"));
  } finally { temp.cleanup(); }
});
