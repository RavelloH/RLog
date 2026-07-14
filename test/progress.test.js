const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const test = require("node:test");
const { createRlog } = require("./helpers/rlog");

test("close waits for a slow progress write", async () => {
  let completed = false;
  const output = new Writable({ write(_chunk, _encoding, callback) { setTimeout(() => { completed = true; callback(); }, 30); } });
  const rlog = createRlog({ screenOutput: output });
  rlog.progress(50, 100);
  const close = rlog.close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(completed, false);
  await close;
  assert.equal(completed, true);
});

for (const mode of ["callback", "event"]) {
  test(`progress ${mode} errors are delivered by close without listener leaks`, async () => {
    const error = new Error(`progress ${mode} failure`);
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        if (mode === "callback") callback(error);
        else { callback(); process.nextTick(() => this.emit("error", error)); }
      },
    });
    const rlog = createRlog({ screenOutput: output });
    const baseline = output.listenerCount("error");
    rlog.progress(1, 2);
    await assert.rejects(rlog.close(), /progress .* failure/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(output.listenerCount("error"), baseline);
  });
}

test("many progress writes do not leak error listeners", async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const rlog = createRlog({ screenOutput: output });
  const baseline = output.listenerCount("error");
  for (let index = 0; index < 50; index += 1) rlog.progress(index, 50);
  await rlog.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(output.listenerCount("error"), baseline);
  await rlog.close();
});
