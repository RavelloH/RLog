const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createRlog, temporaryDirectory } = require("./helpers/rlog");

test("JSONL preserves every explicit Tostringable timestamp deterministically", async () => {
  const temp = temporaryDirectory();
  try {
    const file = path.join(temp.directory, "timestamps.jsonl");
    const rlog = createRlog({ screenOutput: "none", jsonlFilePath: file });
    rlog.at(456).info("root");
    rlog.jsonl.at(789).info("jsonl");
    rlog.at(9n).info("bigint");
    rlog.at("legacy").info("string");
    rlog.at(undefined).info("undefined");
    await rlog.close();
    const records = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(records.map((record) => record.timestamp), [456, 789, "9n", "legacy", "[undefined]"]);
  } finally { temp.cleanup(); }
});
