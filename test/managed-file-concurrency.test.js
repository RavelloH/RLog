const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createRlog, temporaryDirectory } = require("./helpers/rlog");

function allFiles(file, maxFiles) {
  return Array.from({ length: maxFiles }, (_, index) => `${file}.${maxFiles - index}`).concat(file).filter((name) => fs.existsSync(name));
}

test("managed text writes serialize concurrent raw and logged records through rotation", async () => {
  const temp = temporaryDirectory();
  try {
    const file = path.join(temp.directory, "concurrent.log");
    const rlog = createRlog({ screenOutput: "none", logFilePath: file, textRotation: { maxBytes: 500, maxFiles: 5 } });
    const raw = Array.from({ length: 100 }, (_, index) => `raw-${String(index).padStart(3, "0")}\n`);
    const writes = raw.map((line, index) => {
      if (index % 10 === 0) rlog.text.info("log-%d", index);
      return rlog.text.writeRaw(line);
    });
    await Promise.all(writes);
    await rlog.flush();
    await rlog.close();
    const output = allFiles(file, 5).flatMap((name) => fs.readFileSync(name, "utf8").match(/raw-\d{3}/g) || []);
    assert.deepEqual(output, raw.map((line) => line.trim()));
    assert.ok(allFiles(file, 6).length <= 6);
  } finally { temp.cleanup(); }
});
