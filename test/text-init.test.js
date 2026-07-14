const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createRlog, temporaryDirectory } = require("./helpers/rlog");

test("text and file init are awaitable, idempotent, and ready for writeRaw", async () => {
  const temp = temporaryDirectory();
  try {
    const file = path.join(temp.directory, "init.log");
    const rlog = createRlog({ screenOutput: "none", logFilePath: file });
    await Promise.all([rlog.text.init(), rlog.file.init()]);
    assert.ok(rlog.text.stream);
    await rlog.text.writeRaw("ready\n");
    await rlog.close();
    assert.equal(fs.readFileSync(file, "utf8"), "ready\n");
  } finally { temp.cleanup(); }
});

test("throw-policy init reports an invalid target immediately", async () => {
  const temp = temporaryDirectory();
  try {
    const target = path.join(temp.directory, "invalid\0target");
    const rlog = createRlog({ screenOutput: "none", logFilePath: target, fileErrorPolicy: "throw" });
    await assert.rejects(rlog.text.init());
    await assert.rejects(rlog.close());
  } finally { temp.cleanup(); }
});
