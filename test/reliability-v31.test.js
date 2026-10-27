const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const test = require("node:test");
const { createRlog, memoryWritable } = require("./helpers/rlog");

test("redactKeys also protects the formatted message in JSONL, text and screen", async () => {
  const jsonl = memoryWritable();
  const screen = memoryWritable();
  const text = memoryWritable();
  const logger = createRlog({
    redactKeys: ["accessToken"],
    jsonlOutput: jsonl.stream,
    screenOutput: screen.stream,
    logFilePath: undefined,
    enableColorfulOutput: false,
  });
  // Text output is optional; screen and JSONL must never receive the raw key value.
  logger.info({ accessToken: "SYNTHETIC-SECRET-ONLY", other: "safe" });
  await logger.close();
  for (const data of [jsonl.text(), screen.text(), text.text()]) {
    assert.equal(data.includes("SYNTHETIC-SECRET-ONLY"), false);
  }
  assert.equal(jsonl.text().includes("[REDACTED]"), true);
  assert.equal(screen.text().includes("[REDACTED]"), true);
});

test("withContext propagates through awaits, isolates siblings and supports nested contexts", async () => {
  const jsonl = memoryWritable();
  const logger = createRlog({ screenOutput: "none", jsonlOutput: jsonl.stream });
  const paths = ["a", "b"];
  await Promise.all(paths.map(name => logger.withContext({ task: name }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    logger.jsonl.event("inside", { name });
    await logger.withContext({ depth: 2 }, async () => {
      await Promise.resolve();
      logger.jsonl.event("nested", { name });
    });
    logger.jsonl.event("after", { name });
  })));
  logger.jsonl.event("outside");
  await logger.close();
  const records = jsonl.text().trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 7);
  for (const name of paths) {
    const inside = records.find(r => r.event.type === "inside" && r.event.data.name === name);
    const nested = records.find(r => r.event.type === "nested" && r.event.data.name === name);
    const after = records.find(r => r.event.type === "after" && r.event.data.name === name);
    assert.equal(inside.context.task, name);
    assert.equal(nested.context.task, name);
    assert.equal(nested.context.depth, 2);
    assert.equal(after.context.depth, undefined);
    assert.equal(after.context.task, name);
  }
  assert.equal(records.find(r => r.event.type === "outside").context.task, undefined);
});

test("isEnabled and debugLazy avoid evaluating filtered arguments", async () => {
  const jsonl = memoryWritable();
  const logger = createRlog({ screenOutput: "none", jsonlOutput: jsonl.stream, jsonlLogLevel: "info" });
  let computed = 0;
  assert.equal(logger.isEnabled("debug"), false);
  assert.equal(logger.debugLazy(() => { computed++; return ["hidden", computed]; }), undefined);
  logger.config.setConfig({ jsonlLogLevel: "debug" });
  assert.equal(logger.isEnabled("debug"), true);
  logger.debugLazy(() => { computed++; return ["shown", computed]; });
  await logger.close();
  assert.equal(computed, 1);
  assert.match(jsonl.text(), /shown/);
  assert.doesNotMatch(jsonl.text(), /hidden/);
});

test("bounded queue throws before accepting unbounded work and exposes counters", async () => {
  let chunks = 0;
  const slow = new Writable({ write(_c, _e, cb) { chunks++; setTimeout(cb, 15); } });
  const logger = createRlog({ screenOutput: "none", jsonlOutput: slow, maxQueuedRecords: 2 });
  logger.jsonl.info("first");
  logger.jsonl.info("second");
  assert.throws(() => logger.jsonl.info("third"), /RLog queue is full/);
  assert.equal(logger.diagnostics().queuedRecords, 2);
  await logger.flush();
  assert.equal(logger.diagnostics().queuedRecords, 0);
  assert.equal(logger.diagnostics().droppedRecords, 0);
  await logger.close();
  assert.equal(chunks, 2);
});

test("drop-debug overflow never silently drops critical records", async () => {
  const slow = new Writable({ write(_c, _e, cb) { setTimeout(cb, 15); } });
  const logger = createRlog({
    screenOutput: "none", jsonlOutput: slow, jsonlLogLevel: "debug",
    maxQueuedRecords: 1, queueOverflowPolicy: "drop-debug",
  });
  logger.jsonl.debug("accepted");
  logger.jsonl.debug("discarded");
  assert.equal(logger.diagnostics().droppedRecords, 1);
  assert.throws(() => logger.jsonl.error("must not disappear"), /RLog queue is full/);
  await logger.close();
  assert.equal(logger.diagnostics().queuedRecords, 0);
});

test("invalid queue settings are rejected", () => {
  assert.throws(() => createRlog({ maxQueuedRecords: 0 }), /maxQueuedRecords/);
  assert.throws(() => createRlog({ queueOverflowPolicy: "silent" }), /queueOverflowPolicy/);
});

test("target-local lazy logging follows the selected destination", async () => {
  const jsonl = memoryWritable();
  const logger = createRlog({ screenOutput: "none", jsonlOutput: jsonl.stream, jsonlLogLevel: "debug" });
  let calls = 0;
  logger.screen.debugLazy(() => { calls++; return ["screen filtered"]; });
  logger.jsonl.debugLazy(() => { calls++; return ["jsonl included"]; });
  await logger.close();
  assert.equal(calls, 1);
  assert.match(jsonl.text(), /jsonl included/);
});

test("diagnostics expose file write errors and distinguish disabled/unconfigured destinations", async () => {
  const { temporaryDirectory } = require("./helpers/rlog");
  const tmp = temporaryDirectory();
  try {
    const logger = createRlog({
      screenOutput: "none",
      jsonlFilePath: tmp.directory,
      fileErrorPolicy: "disable",
    });
    assert.equal(logger.diagnostics().sinkActive.text, false);
    logger.jsonl.info("write into a directory must fail");
    await logger.flush();
    assert.equal(logger.diagnostics().sinkActive.jsonl, false);
    assert.ok(logger.diagnostics().fileErrors >= 1);
    assert.equal(logger.diagnostics().lastFileError.output, "jsonl");
    await logger.close();
  } finally { tmp.cleanup(); }
});

test("queue overflow error class is available via CommonJS export", async () => {
  const Rlog = require("../dist/index.js");
  assert.equal(typeof Rlog.RLogQueueFullError, "function");
  const log = createRlog({ screenOutput: "none", jsonlOutput: memoryWritable().stream, maxQueuedRecords: 1 });
  log.jsonl.info("first");
  assert.throws(() => log.jsonl.info("second"), Rlog.RLogQueueFullError);
  await log.close();
});

test("redacted structured fields do not leak into actual text file output", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { temporaryDirectory } = require("./helpers/rlog");
  const tmp = temporaryDirectory();
  try {
    const file = path.join(tmp.directory, "text.log");
    const logger = createRlog({
      screenOutput: "none", logFilePath: file, redactKeys: ["password"],
      fileMetadataOutput: "inline",
    });
    logger.info({ password: "SYNTHETIC-REDACT-91", safe: true });
    await logger.close();
    const contents = fs.readFileSync(file, "utf8");
    assert.equal(contents.includes("SYNTHETIC-REDACT-91"), false);
    assert.match(contents, /REDACTED/);
  } finally { tmp.cleanup(); }
});

test("disabled file sink can be explicitly reopened after the filesystem is repaired", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { temporaryDirectory } = require("./helpers/rlog");
  const tmp = temporaryDirectory();
  const target = path.join(tmp.directory, "events.jsonl");
  fs.mkdirSync(target);
  const logger = createRlog({
    jsonlFilePath: target, screenOutput: "none",
    fileErrorPolicy: "disable",
  });
  try {
    logger.jsonl.info("failed-not-replayed");
    await logger.flush();
    assert.equal(logger.diagnostics().sinkActive.jsonl, false);
    assert.deepEqual(await logger.recoverFiles(), { text: null, jsonl: false });
    fs.rmdirSync(target);
    assert.deepEqual(await logger.recoverFiles(), { text: null, jsonl: true });
    logger.jsonl.info("written-after-recovery");
    await logger.syncFiles();
    await logger.close();
    const rows = fs.readFileSync(target, "utf8");
    assert.match(rows, /written-after-recovery/);
    assert.doesNotMatch(rows, /failed-not-replayed/);
    assert.ok(logger.diagnostics().fileErrors >= 2);
  } finally {
    await logger.close().catch(() => undefined);
    tmp.cleanup();
  }
});

test("syncFiles waits for queued writes without implicitly creating disabled file targets", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { temporaryDirectory } = require("./helpers/rlog");
  const tmp = temporaryDirectory();
  const file = path.join(tmp.directory, "sync.jsonl");
  const log = createRlog({ jsonlFilePath: file, screenOutput: "none" });
  try {
    for (let i = 0; i < 5; i++) log.jsonl.info("sync-record-%d", i);
    await log.syncFiles();
    assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 5);
    await log.close();
  } finally {
    await log.close().catch(() => undefined);
    tmp.cleanup();
  }
});

test("instance file isolation is stable within a logger and unique across independent instances", async () => {
  const path = require("node:path");
  const { temporaryDirectory } = require("./helpers/rlog");
  const tmp = temporaryDirectory();
  try {
    const destination = path.join(tmp.directory, "events.jsonl");
    const make = () => createRlog({ screenOutput: "none", jsonlFilePath: destination, jsonlFileIsolation: "instance" });
    const a = make();
    const b = make();
    const pathA = a.filePaths().jsonl;
    const pathB = b.filePaths().jsonl;
    assert.notEqual(pathA, pathB);
    assert.ok(pathA.endsWith(".jsonl"));
    assert.equal(a.filePaths().jsonl, pathA);
    assert.equal(a.child({ nested: true }).filePaths().jsonl, pathA);
    a.jsonl.event("first", { source: "a" });
    b.jsonl.event("second", { source: "b" });
    await Promise.all([a.close(), b.close()]);
    const fs = require("node:fs");
    assert.match(fs.readFileSync(pathA, "utf8"), /"first"/);
    assert.match(fs.readFileSync(pathB, "utf8"), /"second"/);
  } finally { tmp.cleanup(); }
});

test("multiple Node processes independently rotate isolated JSONL files without losing complete records", { timeout: 30000 }, async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawn } = require("node:child_process");
  const { temporaryDirectory } = require("./helpers/rlog");
  const tmp = temporaryDirectory();
  try {
    const destination = path.join(tmp.directory, "events.jsonl");
    const lib = require.resolve("../dist/index.js");
    const childScript = [
      'const Rlog=require(process.argv[1]);',
      'const file=process.argv[2];const owner=process.argv[3];',
      'const log=new Rlog({screenOutput:"none",jsonlFilePath:file,jsonlFileIsolation:"instance",jsonlRotation:{maxBytes:250,maxFiles:70}});',
      'for(let i=0;i<36;i++)log.jsonl.event("multi",{owner,i});',
      'log.close().catch(error=>{console.error(error);process.exitCode=1});',
    ].join("\n");
    const workers = ["one", "two", "three"].map(owner => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", childScript, lib, destination, owner], { stdio: ["ignore","pipe","pipe"] });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error(owner + ": " + stderr + " / exit " + code)));
    }));
    await Promise.all(workers);
    const files = fs.readdirSync(tmp.directory).filter(f => /^events\.[0-9]+\.[a-f0-9]{32}\.jsonl(?:\.[0-9]+)?$/.test(f));
    assert.ok(files.length >= 3, "expected at least one file per worker");
    const records = files.flatMap(file => fs.readFileSync(path.join(tmp.directory,file),"utf8")
      .split("\n").filter(Boolean).map(JSON.parse));
    assert.equal(records.length, 108, "all records must survive independent rotations");
    for (const owner of ["one","two","three"]) {
      const seqs = records.filter(r => r.event?.data?.owner === owner).map(r => r.event.data.i).sort((a,b) => a-b);
      assert.deepEqual(seqs, Array.from({length:36}, (_,i) => i));
    }
  } finally { tmp.cleanup(); }
});

test("readJsonl discovers rotated and isolated files and applies streaming filters", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const Rlog = require("../dist/index.js");
  const { temporaryDirectory } = require("./helpers/rlog");
  const tmp = temporaryDirectory();
  try {
    const base = path.join(tmp.directory, "events.jsonl");
    const a = createRlog({
      screenOutput:"none",jsonlFilePath:base,jsonlFileIsolation:"instance",
      jsonlRotation:{maxBytes:240,maxFiles:20}
    });
    for(let i=0;i<15;i++) a.jsonl.event("selected",{writer:"a",i},{level:i%2?"warn":"info"});
    await a.close();
    const b = createRlog({screenOutput:"none",jsonlFilePath:base,jsonlFileIsolation:"instance"});
    b.jsonl.event("ignored",{writer:"b"},{level:"info"});
    b.jsonl.event("selected",{writer:"b"},{level:"error"});
    await b.close();
    const files = await Rlog.listJsonlFiles(base);
    assert.ok(files.length >= 3, "must include rotations and isolated streams");
    assert.deepEqual(await Rlog.listJsonlFiles(base,false), []);
    const rows = [];
    for await(const result of Rlog.readJsonl({filePath:base,eventTypes:["selected"],levels:["warn","error"]})) {
      rows.push(result);
    }
    assert.equal(rows.length,8);
    assert.equal(rows.every(row => row.lineNumber >= 1 && fs.existsSync(row.filePath)),true);
    const limited = [];
    for await(const row of Rlog.readJsonl({filePath:base,limit:3})) limited.push(row);
    assert.equal(limited.length,3);
    const future = [];
    for await(const row of Rlog.readJsonl({filePath:base,since:"2099-01-01T00:00:00Z"}))future.push(row);
    assert.equal(future.length,0);
    await assert.rejects(async()=>{for await(const _ of Rlog.readJsonl({filePath:base,limit:0})){void _;}},/limit/);
  } finally { tmp.cleanup(); }
});

test("readJsonl reports malformed records with source location and supports explicit skips", async () => {
  const fs=require("node:fs");
  const path=require("node:path");
  const Rlog=require("../dist/index.js");
  const { temporaryDirectory }=require("./helpers/rlog");
  const tmp=temporaryDirectory();
  try {
    const base=path.join(tmp.directory,"broken.jsonl");
    fs.writeFileSync(base, '{"level":"info","message":"ok"}\n{broken-json\n{"level":"warn","message":"later"}\n');
    await assert.rejects(async()=>{
      for await (const _ of Rlog.readJsonl({filePath:base})) { void _; }
    },/Invalid JSONL at .*broken\.jsonl:2/);
    const rows=[];
    for await(const row of Rlog.readJsonl({filePath:base,skipMalformed:true}))rows.push(row);
    assert.equal(rows.length,2);
    assert.equal(rows[1].lineNumber,3);
  } finally { tmp.cleanup(); }
});

test("flight recorder preserves filtered trace/debug history with strict record and byte caps", async () => {
  const jsonl = memoryWritable();
  const logger = createRlog({
    screenOutput: "none", jsonlOutput: jsonl.stream, jsonlLogLevel: "warn",
    flightRecorder: { maxRecords: 3, maxBytes: 1500 },
  });
  logger.debug("flight-0");
  logger.debug("flight-1");
  logger.trace("flight-2");
  logger.debug("flight-3");
  const status = logger.flightRecorderStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.records, 3);
  assert.equal(status.evictedRecords, 1);
  assert.ok(status.bytes <= 1500);
  const snapshot = logger.flightRecorderSnapshot();
  assert.deepEqual(snapshot.map(x => x.message), ["flight-1","flight-2","flight-3"]);
  assert.equal(jsonl.text(), "");
  snapshot[0].message = "mutated";
  assert.equal(logger.flightRecorderSnapshot()[0].message, "flight-1");
  await logger.close();
});

test("flight recorder redacts sensitive fields, snapshots chained metadata and excludes event payloads by default", async () => {
  const logger = createRlog({
    screenOutput:"none", redactKeys:["apiKey"],
    flightRecorder:{maxRecords:10,maxBytes:4096},
  });
  const entry = logger.debug({ apiKey:"FLIGHT-SYNTHETIC-TOKEN-52", normal:"fine" });
  entry.meta({apiKey:"METADATA-SYNTHETIC-51", stage:"init"});
  logger.jsonl.event("internal.phase",{apiKey:"EVENT-SYNTHETIC-53",phase:1},{level:"debug"});
  const records = logger.flightRecorderSnapshot();
  assert.equal(records.length,2);
  assert.equal(records[0].meta.apiKey,"[REDACTED]");
  assert.equal(records[0].meta.stage,"init");
  assert.equal(records[1].event.type,"internal.phase");
  assert.equal(records[1].event.data,undefined);
  assert.equal(JSON.stringify(records).includes("FLIGHT-SYNTHETIC-TOKEN-52"),false);
  assert.equal(JSON.stringify(records).includes("EVENT-SYNTHETIC-53"),false);
  await logger.close();
});

test("flight recorder can include sanitized event data and capture lazy logs despite disabled sinks", async () => {
  const logger = createRlog({
    screenOutput:"none",
    redactKeys:["authorization"],
    flightRecorder:{
      maxRecords:10,maxBytes:4096,includeEventData:true,captureLevels:["debug","error"]
    },
  });
  assert.equal(logger.isEnabled("debug"),true);
  logger.debugLazy(()=>["lazy-flight"]);
  logger.jsonl.event("auth.failed",{ authorization:"SYNTHETIC-ABC", retryable:true },{level:"error"});
  logger.info("not-selected");
  const records=logger.flightRecorderSnapshot();
  assert.equal(records.length,2);
  assert.equal(records[1].event.data.authorization,"[REDACTED]");
  assert.equal(records[1].event.data.retryable,true);
  assert.ok(logger.flightRecorderStatus().bytes>0);
  logger.clearFlightRecorder();
  assert.equal(logger.flightRecorderStatus().records,0);
  await logger.close();
});

test("flight recorder drops oversized entries and exports exclusive private JSONL snapshots", async () => {
  const fs=require("node:fs");
  const path=require("node:path");
  const { temporaryDirectory }=require("./helpers/rlog");
  const tmp=temporaryDirectory();
  try {
    const logger=createRlog({screenOutput:"none",flightRecorder:{maxRecords:6,maxBytes:340}});
    logger.debug("X".repeat(1200));
    logger.debug("small-message");
    assert.equal(logger.flightRecorderStatus().oversizedRecords,1);
    const file=path.join(tmp.directory,"flight.jsonl");
    assert.equal(await logger.exportFlightRecorder(file),1);
    const data=fs.readFileSync(file,"utf8").trim().split("\n").map(JSON.parse);
    assert.equal(data[0].message,"small-message");
    await assert.rejects(logger.exportFlightRecorder(file),e=>e.code==="EEXIST");
    logger.config.setConfig({flightRecorder:false});
    assert.equal(logger.flightRecorderStatus().records,0);
    assert.equal(logger.isEnabled("debug"),false);
    await logger.close();
  } finally {tmp.cleanup();}
});

test("flight recorder option validation and defensive copies", async () => {
  for (const config of [
    { maxRecords:0 }, { maxBytes:0 }, {captureLevels:[]},
    {captureLevels:["off"]}, {includeEventData:"yes"}
  ]) {
    assert.throws(()=>createRlog({flightRecorder:config}),/flightRecorder/);
  }
  const opt={maxRecords:2,maxBytes:2048,captureLevels:["debug"]};
  const logger=createRlog({screenOutput:"none",flightRecorder:opt});
  opt.captureLevels.push("info");
  logger.info("not-recorded");
  logger.debug("recorded");
  assert.equal(logger.flightRecorderSnapshot().length,1);
  await logger.close();
});

test("queued byte budget rejects additional records before output and recovers after draining", async () => {
  const slow = new Writable({ write(_chunk, _enc, done) { setTimeout(done, 20); } });
  const logger = createRlog({ screenOutput:"none", jsonlOutput:slow, maxQueuedBytes:380 });
  logger.jsonl.info("one".repeat(15));
  const used = logger.diagnostics().queuedBytes;
  assert.ok(used > 0 && used < 380);
  assert.throws(() => logger.jsonl.info("two".repeat(160)), /queued byte limit exceeded/);
  assert.equal(logger.diagnostics().queuedBytes,used);
  await logger.flush();
  assert.equal(logger.diagnostics().queuedBytes,0);
  logger.jsonl.info("after drain");
  await logger.close();
});

test("maxRecordBytes rejects oversized JSONL events and metadata added within the same turn", async () => {
  const out=memoryWritable();
  const logger=createRlog({screenOutput:"none",jsonlOutput:out.stream,maxRecordBytes:360});
  assert.throws(()=>logger.jsonl.info("S".repeat(900)),/record exceeds maxRecordBytes/);
  logger.jsonl.info("simple");
  logger.jsonl.info("late-meta").meta("large","M".repeat(800));
  logger.jsonl.event("late-event",{payload:"E".repeat(900)});
  await assert.rejects(logger.flush(), /record exceeds maxRecordBytes/);
  assert.equal(logger.diagnostics().queuedBytes,0);
  assert.equal(logger.diagnostics().queuedRecords,0);
  const contents=out.text();
  assert.match(contents,/simple/);
  assert.doesNotMatch(contents,/late-meta|late-event/);
  await logger.close();
});

test("debug drop byte budget is explicit and never silently loses error records", async () => {
  const sink=memoryWritable();
  const logger=createRlog({
    screenOutput:"none",jsonlOutput:sink.stream,jsonlLogLevel:"debug",
    maxQueuedBytes:270,maxRecordBytes:350,queueOverflowPolicy:"drop-debug",
  });
  logger.debug("kept");
  logger.debug("X".repeat(1200));
  assert.equal(logger.diagnostics().droppedRecords,1);
  assert.throws(()=>logger.error("Y".repeat(1200)),/record exceeds maxRecordBytes/);
  await logger.close();
  assert.equal(logger.diagnostics().queuedBytes,0);
});

test("byte limits validate positive safe integers and exported error classes", async () => {
  for(const opts of [{maxQueuedBytes:0},{maxRecordBytes:0},{maxQueuedBytes:1.5}]) {
    assert.throws(()=>createRlog(opts), /maxQueuedBytes|maxRecordBytes/);
  }
  const Rlog=require("../dist/index.js");
  assert.equal(typeof Rlog.RLogQueueBytesExceededError,"function");
  assert.equal(typeof Rlog.RLogRecordTooLargeError,"function");
});

test("processors filter and enrich records before built-in sinks and custom transports", async () => {
  const Rlog = require("../dist/index.js");
  const jsonl = memoryWritable();
  const delivered = [];
  const processor = async record => {
    if (record.message === "reject-me") return null;
    record.context = { ...record.context, source: "processor" };
    record.message = record.message + "-changed";
    return record;
  };
  const transport = {
    write(record) { delivered.push({ message: record.message, source: record.context.source }); }
  };
  const log = createRlog({ screenOutput: "none", jsonlOutput: jsonl.stream,
    processors: [processor], transports: [transport] });
  log.jsonl.info("hello");
  log.jsonl.info("reject-me");
  await log.close();
  const rows = jsonl.text().trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message, "hello-changed");
  assert.equal(rows[0].context.source, "processor");
  assert.deepEqual(delivered, [{message:"hello-changed", source:"processor"}]);
  assert.equal(log.diagnostics().processorDropped,1);
  assert.equal(typeof Rlog, "function");
});

test("processor hooks see redacted data including context and meta, and nested secrets added by processors are redacted again", async () => {
  const jsonl = memoryWritable();
  const captured = [];
  const logger = createRlog({
    screenOutput: "none", jsonlOutput: jsonl.stream, redactKeys:["password"],
    processors: [rec => {
      captured.push(JSON.stringify(rec));
      rec.context.injected = { password: "SYNTHETIC-INJECTED" };
      return rec;
    }]
  });
  logger.withContext({ password: "SYNTHETIC-SCOPE", operationId: "op-1" }, () => {
    logger.info({ password:"SYNTHETIC-ARGS", ok:true }).meta("password","SYNTHETIC-META");
  });
  await logger.close();
  const contents = jsonl.text();
  for (const value of ["SYNTHETIC-ARGS","SYNTHETIC-META","SYNTHETIC-SCOPE","SYNTHETIC-INJECTED"]) {
    assert.equal(contents.includes(value),false);
    assert.equal(captured.some(x => x.includes(value)),false);
  }
  assert.equal(JSON.parse(contents).context.injected.password,"[REDACTED]");
});

test("processor error fails closed for that record, and other later records still succeed", async () => {
  const jsonl = memoryWritable();
  const logger = createRlog({screenOutput:"none",jsonlOutput:jsonl.stream,
    processors:[record => { if (record.message==="bad") throw Error("processor boom"); return record; }]});
  logger.info("good-first");
  logger.info("bad");
  logger.info("good-last");
  await assert.rejects(logger.flush(),/processor boom/);
  assert.equal(logger.diagnostics().processorErrors,1);
  assert.match(jsonl.text(),/good-first/);
  assert.match(jsonl.text(),/good-last/);
  assert.doesNotMatch(jsonl.text(),/\"message\":\"bad\"/);
  await logger.close();
});

test("transports are serialized, awaited by flush, and isolated from JSONL sink errors", async () => {
  const jsonl=memoryWritable();
  let active=0, peak=0, closed=0, flushed=0;
  const received=[];
  const transport={
    async write(rec) {
      active++; peak=Math.max(peak,active);
      await new Promise(resolve=>setTimeout(resolve,6));
      received.push(rec.message);active--;
      if(rec.message==="transport-fails")throw new Error("custom sink failure");
    },
    flush(){flushed++;},
    close(){closed++;}
  };
  const logger=createRlog({screenOutput:"none",jsonlOutput:jsonl.stream,transports:[transport]});
  logger.info("ok");
  logger.info("transport-fails");
  logger.info("later");
  await assert.rejects(logger.flush(),/custom sink failure/);
  assert.deepEqual(received,["ok","transport-fails","later"]);
  assert.equal(peak,1);
  assert.equal(flushed,1);
  assert.equal(logger.diagnostics().transportErrors,1);
  assert.equal(jsonl.text().trim().split("\n").length,3);
  await logger.close();
  assert.equal(closed,1);
});

test("transports permit lazy logs without built-in outputs and config arrays are defensive copies", async () => {
  const original = [];
  const observed = [];
  const transport={write(rec){observed.push(rec.message);}};
  original.push(transport);
  const processors=[rec=>{rec.message+="!";return rec;}];
  const logger=createRlog({screenOutput:"none",transports:original,processors});
  original.length=0;processors.length=0;
  assert.equal(logger.isEnabled("debug"),true);
  logger.debugLazy(()=>["transport-only"]);
  await logger.close();
  assert.deepEqual(observed,["transport-only!"]);
  assert.throws(()=>createRlog({processors:[false]}),/Invalid processors/);
  assert.throws(()=>createRlog({transports:[{}]}),/Invalid transports/);
});

test("autoRecoverFiles retries only on a later record, respects cooldown and never replays uncertain writes", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { temporaryDirectory } = require("./helpers/rlog");
  const tmp = temporaryDirectory();
  const target = path.join(tmp.directory, "events.jsonl");
  fs.mkdirSync(target);
  const logger = createRlog({
    screenOutput:"none", jsonlFilePath:target,
    fileErrorPolicy:"disable",
    autoRecoverFiles:{initialDelayMs:45,maxDelayMs:70,multiplier:2},
  });
  try {
    logger.jsonl.info("initial-failure");
    await logger.flush();
    const initial = logger.diagnostics().recovery.jsonl;
    assert.equal(initial.disabled,true);
    assert.equal(initial.attempts,0);
    assert.ok(initial.nextAttemptAt);
    logger.jsonl.info("skipped-before-delay");
    await logger.flush();
    assert.equal(logger.diagnostics().recovery.jsonl.attempts,0);
    await new Promise(resolve=>setTimeout(resolve,60));
    logger.jsonl.info("failed-at-first-retry");
    await logger.flush();
    const next = logger.diagnostics().recovery.jsonl;
    assert.equal(next.attempts,1);
    assert.equal(next.failures,1);
    assert.ok(next.nextAttemptAt);
    fs.rmdirSync(target);
    logger.jsonl.info("skipped-during-backoff");
    await logger.flush();
    assert.equal(logger.diagnostics().recovery.jsonl.attempts,1);
    await new Promise(resolve=>setTimeout(resolve,90));
    logger.jsonl.info("written-after-auto-recovery");
    await logger.flush();
    const recovered = logger.diagnostics().recovery.jsonl;
    assert.equal(recovered.attempts,2);
    assert.equal(recovered.successes,1);
    assert.equal(recovered.disabled,false);
    assert.equal(recovered.nextAttemptAt,null);
    assert.ok(recovered.skippedRecords>=2);
    const lines=fs.readFileSync(target,"utf8");
    assert.match(lines,/written-after-auto-recovery/);
    assert.doesNotMatch(lines,/initial-failure|skipped-before-delay|failed-at-first-retry|skipped-during-backoff/);
  } finally {
    await logger.close().catch(()=>{});
    tmp.cleanup();
  }
});

test("autoRecoverFiles is disabled by default and invalid options are rejected", async () => {
  for(const options of [
    {initialDelayMs:0}, {maxDelayMs:0}, {multiplier:0.2},
    {initialDelayMs:100,maxDelayMs:10}, []
  ]) {
    assert.throws(()=>createRlog({autoRecoverFiles:options}),/autoRecoverFiles/);
  }
  const fs=require("node:fs");
  const path=require("node:path");
  const {temporaryDirectory}=require("./helpers/rlog");
  const tmp=temporaryDirectory();
  const target=path.join(tmp.directory,"disabled.jsonl");
  fs.mkdirSync(target);
  const logger=createRlog({screenOutput:"none",jsonlFilePath:target,fileErrorPolicy:"disable"});
  try {
    logger.jsonl.info("failure");
    await logger.flush();
    fs.rmdirSync(target);
    await new Promise(resolve=>setTimeout(resolve,30));
    logger.jsonl.info("no-auto-recovery");
    await logger.flush();
    assert.equal(fs.existsSync(target),false);
    assert.equal(logger.diagnostics().recovery.jsonl.attempts,0);
    assert.equal(logger.diagnostics().recovery.jsonl.nextAttemptAt,null);
  } finally {
    await logger.close().catch(()=>{});
    tmp.cleanup();
  }
});

test("transport flush rejection surfaces even when Capture errors are configured to be ignored", async () => {
  const log = createRlog({
    screenOutput:"none",
    fileErrorPolicy:{default:"ignore",capture:"ignore"},
    transports:[{write(){},flush(){throw new Error("transport flush failed")}}],
  });
  log.info("activates transport");
  await assert.rejects(log.flush(),/transport flush failed/);
  assert.equal(log.diagnostics().transportErrors,1);
  await log.close();
});

test("transport close rejection is reported without leaving the logger open", async () => {
  let closes=0;
  const log=createRlog({
    screenOutput:"none",
    fileErrorPolicy:{default:"ignore",capture:"ignore"},
    transports:[{write(){},async close(){closes++;throw new Error("transport close failed")}}],
  });
  log.info("opens transport");
  await assert.rejects(log.close(),/transport close failed/);
  assert.equal(closes,1);
  assert.equal(log.diagnostics().transportErrors,1);
  assert.throws(()=>log.info("after close"),/closed/);
});

test("processor message transforms are consistent in Screen, Text and JSONL", async () => {
  const fs=require("node:fs");
  const path=require("node:path");
  const {temporaryDirectory}=require("./helpers/rlog");
  const temp=temporaryDirectory();
  const screen=memoryWritable();
  const jsonl=memoryWritable();
  try {
    const file=path.join(temp.directory,"display.log");
    const logger=createRlog({
      screenOutput:screen.stream,jsonlOutput:jsonl.stream,logFilePath:file,
      processors:[record=>{record.message="processor-visible";return record;}],
    });
    logger.info("original-message");
    await logger.close();
    assert.match(screen.text(),/processor-visible/);
    assert.doesNotMatch(screen.text(),/original-message/);
    assert.match(fs.readFileSync(file,"utf8"),/processor-visible/);
    assert.match(jsonl.text(),/processor-visible/);
  } finally {temp.cleanup();}
});

test("configured transports are closed even when no log records are emitted", async () => {
  let closed=0;
  const logger=createRlog({
    screenOutput:"none",
    transports:[{write(){},close(){closed++;}}],
  });
  await logger.close();
  assert.equal(closed,1);
});

test("auto recovery rejects implicit initial delay greater than the default maximum", () => {
  assert.throws(()=>createRlog({autoRecoverFiles:{initialDelayMs:120000}}),/maxDelayMs/);
});

test("processor expansion cannot bypass maxQueuedBytes; failed record is never delivered", async () => {
  const jsonl=memoryWritable();
  const logger=createRlog({
    screenOutput:"none",jsonlOutput:jsonl.stream,maxQueuedBytes:650,
    processors:[record=>{
      if (record.message==="inflate") record.message="P".repeat(3000);
      return record;
    }],
  });
  logger.info("inflate");
  await assert.rejects(logger.flush(),/queued byte limit exceeded/);
  assert.equal(logger.diagnostics().queuedBytes,0);
  assert.equal(logger.diagnostics().queuedRecords,0);
  assert.doesNotMatch(jsonl.text(),/PPPPPP/);
  logger.info("after-rejection");
  await logger.flush();
  assert.match(jsonl.text(),/after-rejection/);
  await logger.close();
});

test("fsync EIO is reported in diagnostics and disables its file destination", async () => {
  const fs=require("node:fs");
  const path=require("node:path");
  const {temporaryDirectory}=require("./helpers/rlog");
  const tmp=temporaryDirectory();
  const original=fs.fsync;
  const file=path.join(tmp.directory,"sync.jsonl");
  const logger=createRlog({
    screenOutput:"none",jsonlFilePath:file,fileErrorPolicy:"disable"
  });
  try {
    logger.info("write-before-fsync");
    await logger.flush();
    fs.fsync=(fd,cb)=>process.nextTick(()=>cb(Object.assign(new Error("simulated fsync EIO"),{code:"EIO"})));
    await assert.rejects(logger.syncFiles(),/simulated fsync EIO/);
    const result=logger.diagnostics();
    assert.equal(result.recovery.jsonl.disabled,true);
    assert.equal(result.lastFileError.operation,"sync");
    assert.ok(result.fileErrors>=1);
  } finally {
    fs.fsync=original;
    await logger.close().catch(()=>{});
    tmp.cleanup();
  }
});

test("an externally terminated process retains all records acknowledged by syncFiles", { timeout: 12000 }, async () => {
  const fs=require("node:fs");
  const path=require("node:path");
  const {spawn}=require("node:child_process");
  const {temporaryDirectory}=require("./helpers/rlog");
  const tmp=temporaryDirectory();
  const destination=path.join(tmp.directory,"synced-before-termination.jsonl");
  const lib=require.resolve("../dist/index.js");
  const code=[
    'const Rlog=require(process.argv[1]);',
    '(async()=>{const log=new Rlog({screenOutput:"none",jsonlFilePath:process.argv[2]});',
    'for(let i=0;i<30;i++) log.jsonl.event("checkpoint",{i});',
    'await log.syncFiles(); process.stdout.write("READY\\n");',
    'setInterval(()=>undefined,1000);',
    '})().catch(error=>{console.error(error);process.exitCode=1});'
  ].join("\n");
  const cp=spawn(process.execPath,["-e",code,lib,destination],{stdio:["ignore","pipe","pipe"]});
  let stderr="";
  cp.stderr.on("data",chunk=>{stderr+=chunk.toString();});
  try {
    await new Promise((resolve,reject)=>{
      let received="",done=false;
      const timer=setTimeout(()=>settle(new Error("checkpoint child timeout: "+stderr)),6500);
      const settle=error=>{
        if(done)return;
        done=true;clearTimeout(timer);error?reject(error):resolve();
      };
      cp.stdout.on("data",chunk=>{
        received+=chunk.toString();
        if(received.includes("READY"))settle();
      });
      cp.once("error",settle);
      cp.once("exit",(code,signal)=>settle(new Error("exited before checkpoint: "+code+"/"+signal+" "+stderr)));
    });
    const exited = new Promise(resolve=>cp.once("close",resolve));
    assert.equal(cp.kill("SIGKILL"),true);
    await exited;
    const rows=fs.readFileSync(destination,"utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows.length,30);
    assert.deepEqual(rows.map(r=>r.event.data.i),Array.from({length:30},(_,i)=>i));
  } finally {
    if(cp.exitCode===null && cp.signalCode===null)cp.kill("SIGKILL");
    tmp.cleanup();
  }
});
