const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");
const Rlog = require("../../dist/index.js");

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rlog-v3-"));
  // Windows can retain a just-closed WriteStream directory entry briefly.
  return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

function memoryWritable() {
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  return { stream, text: () => output };
}

function createRlog(options = {}) {
  return new Rlog({ autoInit: false, silent: true, enableColorfulOutput: false, timeFormat: "timestamp", ...options });
}

module.exports = { createRlog, memoryWritable, temporaryDirectory };
