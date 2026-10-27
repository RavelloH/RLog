"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Rlog = require("../dist/index.js");

// The kernel /dev/full reliably returns ENOSPC without consuming disk space.
// Do not use this test on a real volume or simulate exhaustion by filling /tmp.
test("Linux: ENOSPC disables the affected JSONL Sink and records the I/O failure", {
  skip: process.platform !== "linux" || !fs.existsSync("/dev/full"),
}, async () => {
  const logger = new Rlog({
    screenOutput: "none",
    jsonlFilePath: "/dev/full",
    fileErrorPolicy: "disable",
  });
  try {
    logger.jsonl.info("simulated disk full");
    await logger.flush();
    const state = logger.diagnostics();
    assert.equal(state.recovery.jsonl.disabled, true);
    assert.ok(state.fileErrors >= 1);
    assert.equal(state.lastFileError.output, "jsonl");
    assert.ok(["write","open"].includes(state.lastFileError.operation));
  } finally {
    await logger.close().catch(() => undefined);
  }
});
