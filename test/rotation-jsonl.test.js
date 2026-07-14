const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createRlog, temporaryDirectory } = require("./helpers/rlog");

test("JSONL rotation is independent from text rotation and retains valid complete lines", async () => {
  const temp = temporaryDirectory();
  try {
    const text = path.join(temp.directory, "app.log");
    const jsonl = path.join(temp.directory, "events.jsonl");
    const rlog = createRlog({ screenOutput: "none", logFilePath: text, jsonlFilePath: jsonl, jsonlRotation: { maxBytes: 120, maxFiles: 1 } });
    for (let index = 0; index < 5; index += 1) rlog.jsonl.event("item", { index, value: "xxxxxxxxxxxx" });
    await rlog.close();
    assert.ok(fs.existsSync(jsonl)); assert.ok(fs.existsSync(`${jsonl}.1`)); assert.ok(!fs.existsSync(text), "jsonl-only logs do not initialize text output");
    for (const name of [`${jsonl}.1`, jsonl]) for (const line of fs.readFileSync(name, "utf8").trim().split("\n")) assert.equal(JSON.parse(line).event.type, "item");
  } finally { temp.cleanup(); }
});
