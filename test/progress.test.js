const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Writable } = require("node:stream");
const test = require("node:test");
const { createRlog, memoryWritable, temporaryDirectory } = require("./helpers/rlog");

function jsonlRecords(file) {
  return fs.existsSync(file) && fs.readFileSync(file, "utf8").trim() ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [];
}

test("close waits for a slow progress write", async () => {
  let completed = false;
  const output = new Writable({ write(_chunk, _encoding, callback) { setTimeout(() => { completed = true; callback(); }, 30); } });
  const rlog = createRlog({ screenOutput: output });
  rlog.screen.progressTask({ label: "slow", total: 100 }).update(50);
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
    rlog.screen.progressTask({ label: `failure-${mode}`, total: 2 }).update(1);
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

test("root progressTask routes screen, text lifecycle, and JSONL events", async () => {
  const temp = temporaryDirectory();
  try {
    const screen = memoryWritable();
    const text = path.join(temp.directory, "app.log");
    const jsonl = path.join(temp.directory, "events.jsonl");
    const rlog = createRlog({ screenOutput: screen.stream, logFilePath: text, jsonlFilePath: jsonl });
    const task = rlog.progressTask({ label: "root task", total: 3, current: 1 });
    task.update(2);
    task.complete({ run: "r-1" });
    await rlog.close();
    assert.match(screen.text(), /PROG/);
    assert.match(fs.readFileSync(text, "utf8"), /root task: started \(1\/3\)/);
    assert.match(fs.readFileSync(text, "utf8"), /root task: complete/);
    assert.deepEqual(jsonlRecords(jsonl).map((record) => record.event.type), ["progress.started", "progress.updated", "progress.completed"]);
  } finally { temp.cleanup(); }
});

test("screen progressTask writes only screen", async () => {
  const temp = temporaryDirectory();
  try {
    const screen = memoryWritable();
    const text = path.join(temp.directory, "app.log");
    const jsonl = path.join(temp.directory, "events.jsonl");
    const rlog = createRlog({ screenOutput: screen.stream, logFilePath: text, jsonlFilePath: jsonl });
    const task = rlog.screen.progressTask({ label: "screen task", total: 2 });
    task.update(1); task.complete();
    await rlog.close();
    assert.match(screen.text(), /PROG/);
    assert(!fs.existsSync(text) || !fs.readFileSync(text, "utf8").includes("screen task"));
    assert.equal(jsonlRecords(jsonl).filter((record) => record.event?.data?.label === "screen task").length, 0);
  } finally { temp.cleanup(); }
});

test("text progressTask writes lifecycle milestones without screen or JSONL updates", async () => {
  const temp = temporaryDirectory();
  try {
    const screen = memoryWritable();
    const text = path.join(temp.directory, "app.log");
    const jsonl = path.join(temp.directory, "events.jsonl");
    const rlog = createRlog({ screenOutput: screen.stream, logFilePath: text, jsonlFilePath: jsonl });
    const task = rlog.text.progressTask({ label: "text task", total: 2 });
    task.update(1); task.complete();
    await rlog.close();
    assert.doesNotMatch(screen.text(), /PROG|text task/);
    const output = fs.readFileSync(text, "utf8");
    assert.match(output, /text task: started \(0\/2\)/);
    assert.match(output, /text task: complete/);
    assert.doesNotMatch(output, /progress\.updated/);
    assert.equal(jsonlRecords(jsonl).filter((record) => record.event?.data?.label === "text task").length, 0);
  } finally { temp.cleanup(); }
});

test("JSONL progressTask emits structured lifecycle events with child context only", async () => {
  const temp = temporaryDirectory();
  try {
    const screen = memoryWritable();
    const text = path.join(temp.directory, "app.log");
    const jsonl = path.join(temp.directory, "events.jsonl");
    const rlog = createRlog({ screenOutput: screen.stream, logFilePath: text, jsonlFilePath: jsonl });
    const task = rlog.child({ device: "controller" }).jsonl.progressTask({ label: "json task", total: 2 });
    task.update(1); task.complete();
    await rlog.close();
    assert.doesNotMatch(screen.text(), /PROG|json task/);
    assert(!fs.existsSync(text) || !fs.readFileSync(text, "utf8").includes("json task"));
    const events = jsonlRecords(jsonl);
    assert.deepEqual(events.map((record) => record.event.type), ["progress.started", "progress.updated", "progress.completed"]);
    assert(events.every((record) => record.context.device === "controller"));
  } finally { temp.cleanup(); }
});

test("progressTask fail is routed only to its selected target", async () => {
  for (const target of ["screen", "text", "jsonl"]) {
    const temp = temporaryDirectory();
    try {
      const screen = memoryWritable();
      const text = path.join(temp.directory, "app.log");
      const jsonl = path.join(temp.directory, "events.jsonl");
      const rlog = createRlog({ screenOutput: screen.stream, logFilePath: text, jsonlFilePath: jsonl });
      rlog[target].progressTask({ label: `${target} failure`, total: 1 }).fail(new Error("broken"));
      await rlog.close();
      const screenHas = screen.text().includes(`${target} failure`);
      const textHas = fs.existsSync(text) && fs.readFileSync(text, "utf8").includes(`${target} failure`);
      const jsonlHas = jsonlRecords(jsonl).some((record) => record.event?.type === "progress.failed" && record.event.data.label === `${target} failure`);
      assert.deepEqual([screenHas, textHas, jsonlHas], [target === "screen", target === "text", target === "jsonl"]);
    } finally { temp.cleanup(); }
  }
});

test("progressTask complete and fail are idempotent and updates stop after completion", async () => {
  const temp = temporaryDirectory();
  try {
    const jsonl = path.join(temp.directory, "events.jsonl");
    const rlog = createRlog({ screenOutput: "none", jsonlFilePath: jsonl });
    const task = rlog.jsonl.progressTask({ label: "idempotent", total: 2 });
    task.update(1); task.complete(); task.complete(); task.fail(new Error("late")); task.update(2);
    await rlog.close();
    assert.deepEqual(jsonlRecords(jsonl).map((record) => record.event.type), ["progress.started", "progress.updated", "progress.completed"]);
  } finally { temp.cleanup(); }
});
