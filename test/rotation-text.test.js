const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createRlog, temporaryDirectory } = require("./helpers/rlog");

test("text rotation keeps whole records, ordering, and only maxFiles histories", async () => {
  const temp = temporaryDirectory();
  try {
    const file = path.join(temp.directory, "应用 日志.log");
    const rlog = createRlog({ screenOutput: "none", logFilePath: file, textRotation: { maxBytes: 45, maxFiles: 2 } });
    for (let index = 0; index < 7; index += 1) rlog.text.info("record-%d-xxxxxxxx", index);
    await rlog.flush();
    assert.ok(fs.existsSync(`${file}.1`), "flush waits for rotations");
    await rlog.close();
    assert.ok(fs.existsSync(file)); assert.ok(fs.existsSync(`${file}.1`)); assert.ok(fs.existsSync(`${file}.2`)); assert.ok(!fs.existsSync(`${file}.3`));
    const orderedFiles = [`${file}.2`, `${file}.1`, file];
    const numbers = orderedFiles.flatMap((name) => fs.readFileSync(name, "utf8").match(/record-(\d+)/g) || []).map((entry) => Number(entry.match(/\d+/)[0]));
    assert.deepEqual(numbers, [4, 5, 6]);
    for (const name of orderedFiles) assert.ok(!fs.readFileSync(name, "utf8").includes("record-4-xxxxxxxx\n["), "records are not split across files");
  } finally { temp.cleanup(); }
});

test("text rotation permits an oversized first record and maxFiles zero retains no history", async () => {
  const temp = temporaryDirectory();
  try {
    const file = path.join(temp.directory, "zero.log");
    const rlog = createRlog({ screenOutput: "none", logFilePath: file, textRotation: { maxBytes: 10, maxFiles: 0 } });
    rlog.text.info("this single record is intentionally larger than the limit");
    rlog.text.info("next");
    await rlog.close();
    assert.ok(fs.existsSync(file)); assert.ok(!fs.existsSync(`${file}.1`));
    assert.match(fs.readFileSync(file, "utf8"), /next/);
  } finally { temp.cleanup(); }
});

test("a text rotation failure reports rotate once and does not stop JSONL", async () => {
  const temp = temporaryDirectory();
  const originalRename = fs.promises.rename;
  try {
    const file = path.join(temp.directory, "broken.log");
    const jsonl = path.join(temp.directory, "survives.jsonl");
    const contexts = [];
    const rlog = createRlog({ screenOutput: "none", logFilePath: file, jsonlFilePath: jsonl, textRotation: { maxBytes: 5, maxFiles: 1 }, onFileError(_error, context) { contexts.push(context); } });
    fs.promises.rename = async () => { throw new Error("rename blocked"); };
    rlog.info("first text record");
    rlog.info("second text record");
    await assert.rejects(rlog.flush(), /rename blocked/);
    fs.promises.rename = originalRename;
    await rlog.close();
    assert.deepEqual(contexts.map((context) => context.operation), ["rotate"]);
    assert.match(fs.readFileSync(jsonl, "utf8"), /second text record/);
  } finally { fs.promises.rename = originalRename; temp.cleanup(); }
});
