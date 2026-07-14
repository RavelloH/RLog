const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createRlog, temporaryDirectory } = require("./helpers/rlog");

test("rotation options update for existing text and JSONL sinks", async () => {
  const temp = temporaryDirectory();
  try {
    const text = path.join(temp.directory, "dynamic.log");
    const jsonl = path.join(temp.directory, "dynamic.jsonl");
    const rlog = createRlog({ screenOutput: "none", logFilePath: text, jsonlFilePath: jsonl, textRotation: false, jsonlRotation: false });
    rlog.info("before rotation");
    await rlog.flush();
    assert.equal(fs.existsSync(`${text}.1`), false);
    rlog.config.setConfig({ textRotation: { maxBytes: 1, maxFiles: 1 }, jsonlRotation: { maxBytes: 1, maxFiles: 1 } });
    rlog.info("after rotation");
    await rlog.flush();
    assert.ok(fs.existsSync(`${text}.1`)); assert.ok(fs.existsSync(`${jsonl}.1`));
    rlog.config.setConfig({ textRotation: false, jsonlRotation: false });
    rlog.info("rotation disabled");
    await rlog.close();
    assert.equal(fs.existsSync(`${text}.2`), false); assert.equal(fs.existsSync(`${jsonl}.2`), false);
  } finally { temp.cleanup(); }
});

test("setConfigGlobal updates rotation for existing instances without retaining caller objects", async () => {
  const temp = temporaryDirectory();
  try {
    const file = path.join(temp.directory, "global.log");
    const rlog = createRlog({ screenOutput: "none", logFilePath: file });
    const options = { textRotation: { maxBytes: 1, maxFiles: 1 } };
    rlog.config.setConfigGlobal(options);
    options.textRotation.maxBytes = 100000;
    rlog.text.info("first"); rlog.text.info("second");
    await rlog.close();
    assert.ok(fs.existsSync(`${file}.1`));
    rlog.config.setConfigGlobal({ textRotation: false, jsonlRotation: false });
  } finally { temp.cleanup(); }
});
