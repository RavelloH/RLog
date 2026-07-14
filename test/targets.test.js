const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createRlog, memoryWritable, temporaryDirectory } = require("./helpers/rlog");

test("root and target facades route records to only their requested sinks", async () => {
  const temp = temporaryDirectory();
  try {
    const screen = memoryWritable();
    const text = path.join(temp.directory, "app.log");
    const jsonl = path.join(temp.directory, "events.jsonl");
    const rlog = createRlog({ screenOutput: screen.stream, logFilePath: text, jsonlFilePath: jsonl });
    assert.strictEqual(rlog.file, rlog.text);
    rlog.info("root=%d", 1);
    rlog.screen.info("screen=%d", 2);
    rlog.text.info("text=%d", 3);
    rlog.file.info("file=%d", 4);
    rlog.jsonl.info("jsonl=%d", 5);
    await rlog.close();
    const screenText = screen.text();
    const textText = fs.readFileSync(text, "utf8");
    const records = fs.readFileSync(jsonl, "utf8").trim().split("\n").map(JSON.parse);
    assert.match(screenText, /root=1/); assert.match(screenText, /screen=2/);
    assert.doesNotMatch(screenText, /text=3|file=4|jsonl=5/);
    assert.match(textText, /root=1/); assert.match(textText, /text=3/); assert.match(textText, /file=4/);
    assert.doesNotMatch(textText, /screen=2|jsonl=5/);
    assert.deepEqual(records.map((record) => record.message), ["root=1", "jsonl=5"]);
  } finally { temp.cleanup(); }
});

test("at binds time while a second facade argument stays a console argument", async () => {
  const temp = temporaryDirectory();
  try {
    const screen = memoryWritable();
    const text = path.join(temp.directory, "time.log");
    const jsonl = path.join(temp.directory, "time.jsonl");
    const rlog = createRlog({ screenOutput: screen.stream, logFilePath: text, jsonlFilePath: jsonl });
    rlog.screen.info("value", 123);
    rlog.at(456).info("all time");
    rlog.screen.at(123).info("screen time");
    rlog.text.at(789).info("text time");
    rlog.jsonl.at(new Date("2026-07-14T10:00:00.000Z")).info("json time");
    await rlog.close();
    assert.match(screen.text(), /value 123/);
    assert.match(screen.text(), /^\[123\]\[INFO\] screen time/m);
    const textOutput = fs.readFileSync(text, "utf8");
    assert.match(textOutput, /^\[456\]\[INFO\] all time/m);
    assert.match(textOutput, /^\[789\]\[INFO\] text time/m);
    const records = fs.readFileSync(jsonl, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records.at(-1).timestamp, "2026-07-14T10:00:00.000Z");
  } finally { temp.cleanup(); }
});

test("target events, metadata, and child facades retain target scope and context", async () => {
  const temp = temporaryDirectory();
  try {
    const jsonl = path.join(temp.directory, "events.jsonl");
    const rlog = createRlog({ screenOutput: "none", jsonlFilePath: jsonl });
    const child = rlog.child({ device: "controller" });
    assert.strictEqual(child.file, child.text);
    child.jsonl.event("device.connected", { port: "COM9" }).meta({ requestId: "req-1" });
    await rlog.close();
    const record = JSON.parse(fs.readFileSync(jsonl, "utf8"));
    assert.deepEqual(record.context, { device: "controller" });
    assert.deepEqual(record.meta, { requestId: "req-1" });
    assert.deepEqual(record.event, { type: "device.connected", data: { port: "COM9" } });
  } finally { temp.cleanup(); }
});
