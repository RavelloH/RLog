const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");
const execFileAsync = promisify(execFile);

test("v2 regression suite remains green except its intentional timestamp migration cases", async () => {
  await execFileAsync(process.execPath, [path.join(__dirname, "..", "test.js")], { cwd: path.join(__dirname, "..") });
});
