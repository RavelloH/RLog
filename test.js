const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { formatWithOptions, inspect } = require("util");
const Rlog = require("./dist/index.js");

const INSPECT_OPTIONS = { colors: false };
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function expectedMessage(...args) {
  return formatWithOptions(INSPECT_OPTIONS, ...args);
}

function stripAnsi(value) {
  return value.replace(ANSI_RE, "");
}

function createRlog(config = {}) {
  return new Rlog({
    autoInit: false,
    silent: true,
    timeFormat: "timestamp",
    customColorRules: [],
    ...config,
  });
}

function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let output = "";

  process.stdout.write = function writeCapture(chunk, encoding, callback) {
    output += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);

    if (typeof encoding === "function") {
      encoding();
    }
    if (typeof callback === "function") {
      callback();
    }

    return true;
  };

  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
  }

  return output;
}

function parseRlogOutput(output) {
  const clean = stripAnsi(output);
  const match = /^\[([^\]]*)\]\[([^\]]+)\] ([\s\S]*)\n$/.exec(clean);

  assert.ok(match, `Unexpected Rlog output shape:\n${clean}`);

  const [, time, type, paddedMessage] = match;
  const padding = " ".repeat(`[${time}][${type}] `.length);
  const message = paddedMessage
    .split("\n")
    .map((line, index) => {
      if (index === 0) return line;
      return line.startsWith(padding) ? line.slice(padding.length) : line;
    })
    .join("\n");

  return { clean, message, padding, time, type };
}

function assertRlogCall(rlog, method, args, expectedType, label) {
  const output = captureStdout(() => {
    rlog[method](...args);
  });
  const parsed = parseRlogOutput(output);

  assert.strictEqual(parsed.type, expectedType, `${label}: log level`);
  assert.strictEqual(
    parsed.message,
    expectedMessage(...args),
    `${label}: console-compatible message`
  );

  return parsed;
}

function assertRlogMessage(rlog, method, args, expectedType, message, label) {
  const output = captureStdout(() => {
    rlog[method](...args);
  });
  const parsed = parseRlogOutput(output);

  assert.strictEqual(parsed.type, expectedType, `${label}: log level`);
  assert.strictEqual(parsed.message, message, `${label}: message`);

  return parsed;
}

function closeLogStream(rlog) {
  const stream = rlog.file.logStream;
  if (!stream) return Promise.resolve();

  return new Promise((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
    stream.end();
  });
}

function runExitChild(body, extraEnv = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rlog-exit-test-"));
  const logFile = path.join(tempDir, "exit.log");
  const markerFile = path.join(tempDir, "marker.txt");
  const distEntry = path.join(__dirname, "dist", "index.js");
  const childCode = `
    const fs = require("fs");
    const Rlog = require(${JSON.stringify(distEntry)});
    process.stdout.write = () => true;
    ${body}
  `;

  const result = spawnSync(process.execPath, ["-e", childCode], {
    cwd: __dirname,
    env: {
      ...process.env,
      RLOG_EXIT_LOG: logFile,
      RLOG_EXIT_MARKER: markerFile,
      ...extraEnv,
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });

  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  const marker = fs.existsSync(markerFile)
    ? fs.readFileSync(markerFile, "utf8")
    : "";

  fs.rmSync(tempDir, { recursive: true, force: true });

  return { log, marker, result };
}

function assertSuccessfulExit(result, label) {
  assert.strictEqual(result.status, 0, `${label}: child exits with code 0`);
  assert.strictEqual(result.signal, null, `${label}: child has no signal`);
  assert.strictEqual(result.stderr, "", `${label}: no stderr output`);
}

async function run() {
  const rlog = createRlog();
  const circular = { name: "root" };
  circular.self = circular;
  const customInspect = {
    [inspect.custom]() {
      return "custom-inspect-value";
    },
  };
  const sampleFunction = function sampleFunction(value) {
    return value;
  };

  const compatibilityCases = [
    { label: "empty args", args: [] },
    { label: "plain string", args: ["plain text"] },
    { label: "mixed values", args: ["a", { b: 1 }, 1] },
    {
      label: "format placeholders",
      args: ["user=%s count=%d ratio=%f %%", "Ravello", 7, 3.5],
    },
    {
      label: "inspect placeholders",
      args: ["int=%i object=%o compact=%O", "42.9", { deep: { value: 1 } }, { a: 1 }],
    },
    { label: "json placeholder", args: ["json=%j", circular] },
    { label: "object", args: [{ nested: { b: 1 }, list: [1, 2] }] },
    { label: "array", args: [[1, "x", true]] },
    { label: "error", args: [new Error("boom")] },
    { label: "date", args: [new Date("2020-01-02T03:04:05.000Z")] },
    { label: "map", args: [new Map([["a", 1]])] },
    { label: "set", args: [new Set([1, 2])] },
    { label: "bigint", args: [123n] },
    { label: "symbol", args: [Symbol("x")] },
    { label: "null", args: [null] },
    { label: "undefined", args: [undefined] },
    { label: "function", args: [sampleFunction] },
    { label: "circular object", args: [circular] },
    { label: "custom inspect", args: [customInspect] },
  ];

  for (const item of compatibilityCases) {
    assertRlogCall(rlog, "info", item.args, "INFO", item.label);
  }

  assertRlogCall(rlog, "warn", ["warn method", { code: 1 }], "WARN", "warn");
  assertRlogCall(
    rlog,
    "warning",
    ["warning method", { code: 2 }],
    "WARN",
    "warning"
  );
  assertRlogCall(rlog, "error", ["error method", { code: 3 }], "ERR!", "error");
  assertRlogCall(
    rlog,
    "success",
    ["success method", { code: 4 }],
    "SUCC",
    "success"
  );
  assertRlogCall(rlog, "log", ["neutral", { b: 1 }, 1], "INFO", "log info");
  assertRlogCall(
    rlog,
    "log",
    ["operation success", { code: 200 }],
    "SUCC",
    "log success auto-detect"
  );
  assertRlogCall(
    rlog,
    "log",
    ["warning: disk space low", { free: "1GB" }],
    "WARN",
    "log warning auto-detect"
  );
  assertRlogCall(
    rlog,
    "log",
    ["fatal error", { code: 500 }],
    "ERR!",
    "log error auto-detect"
  );

  const multiline = assertRlogCall(
    rlog,
    "info",
    ["line1\nline2\nline3"],
    "INFO",
    "multiline padding"
  );
  assert.ok(
    multiline.clean.includes(`\n${multiline.padding}line2`),
    "multiline output should indent second line"
  );

  const privacyRlog = createRlog({
    blockedWordsList: ["secret", "[0-9]{4}"],
  });
  assertRlogMessage(
    privacyRlog,
    "info",
    ["token=%s code=%d", "secret", 1234],
    "INFO",
    "token=****** code=****",
    "privacy filtering"
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rlog-test-"));
  const logFilePath = path.join(tempDir, "rlog.log");

  try {
    const fileRlog = createRlog({
      autoInit: true,
      logFilePath,
    });

    assertRlogCall(
      fileRlog,
      "info",
      ["file", { b: 1 }, 1],
      "INFO",
      "file screen output"
    );
    await closeLogStream(fileRlog);

    const fileContent = fs.readFileSync(logFilePath, "utf8");
    assert.match(
      fileContent,
      /\[[^\]]+\]\[INFO\] file \{ b: 1 \} 1\r?\n/,
      "file output should contain console-compatible message"
    );
    assert.doesNotMatch(
      fileContent,
      ANSI_RE,
      "file output should not contain ANSI color codes"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const basicExit = runExitChild(`
    const rlog = new Rlog({
      logFilePath: process.env.RLOG_EXIT_LOG,
      autoInit: true,
      silent: true,
      timeFormat: "timestamp",
      customColorRules: [],
    });
    fs.writeFileSync(process.env.RLOG_EXIT_MARKER, "before\\n");
    rlog.info("before exit log", { saved: true });
    rlog.exit("exit now");
    fs.appendFileSync(process.env.RLOG_EXIT_MARKER, "after\\n");
    rlog.info("after exit log should not happen");
  `);
  assertSuccessfulExit(basicExit.result, "basic exit");
  assert.strictEqual(
    basicExit.marker,
    "before\n",
    "basic exit: code after rlog.exit did not run"
  );
  assert.match(
    basicExit.log,
    /\[[^\]]+\]\[INFO\] before exit log \{ saved: true \}\r?\n/,
    "basic exit: pre-exit log was saved"
  );
  assert.match(
    basicExit.log,
    /\[[^\]]+\]\[EXIT\] exit now\r?\n/,
    "basic exit: exit log was saved"
  );
  assert.doesNotMatch(
    basicExit.log,
    /after exit log should not happen/,
    "basic exit: post-exit log was not saved"
  );

  const noAutoInitExit = runExitChild(`
    const rlog = new Rlog({
      logFilePath: process.env.RLOG_EXIT_LOG,
      autoInit: false,
      silent: true,
      timeFormat: "timestamp",
      customColorRules: [],
    });
    rlog.exit("exit without prior init");
  `);
  assertSuccessfulExit(noAutoInitExit.result, "exit without prior init");
  assert.match(
    noAutoInitExit.log,
    /\[[^\]]+\]\[EXIT\] exit without prior init\r?\n/,
    "exit without prior init: exit log was saved"
  );

  const listenerExit = runExitChild(`
    const rlog = new Rlog({
      logFilePath: process.env.RLOG_EXIT_LOG,
      autoInit: true,
      silent: true,
      timeFormat: "timestamp",
      customColorRules: [],
    });
    rlog.info("before listener exit");
    rlog.onExit(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      rlog.warn("listener log should be saved");
    });
    rlog.exit("listener exit");
  `);
  assertSuccessfulExit(listenerExit.result, "listener exit");
  assert.match(
    listenerExit.log,
    /\[[^\]]+\]\[INFO\] before listener exit\r?\n/,
    "listener exit: pre-exit log was saved"
  );
  assert.match(
    listenerExit.log,
    /\[[^\]]+\]\[EXIT\] listener exit\r?\n/,
    "listener exit: exit log was saved"
  );
  assert.match(
    listenerExit.log,
    /\[[^\]]+\]\[WARN\] listener log should be saved\r?\n/,
    "listener exit: async onExit log was saved"
  );

  const bulkCount = 5000;
  const bulkExit = runExitChild(
    `
      const rlog = new Rlog({
        logFilePath: process.env.RLOG_EXIT_LOG,
        autoInit: true,
        silent: true,
        timeFormat: "timestamp",
        customColorRules: [],
      });
      fs.writeFileSync(process.env.RLOG_EXIT_MARKER, "before\\n");
      for (let i = 0; i < Number(process.env.RLOG_EXIT_COUNT); i += 1) {
        rlog.info("bulk line %d", i);
      }
      rlog.exit("bulk exit");
      fs.appendFileSync(process.env.RLOG_EXIT_MARKER, "after\\n");
    `,
    { RLOG_EXIT_COUNT: String(bulkCount) }
  );
  assertSuccessfulExit(bulkExit.result, "bulk exit");
  assert.strictEqual(
    bulkExit.marker,
    "before\n",
    "bulk exit: code after rlog.exit did not run"
  );
  const bulkLines = bulkExit.log.trimEnd().split(/\r?\n/);
  assert.strictEqual(
    bulkLines.length,
    bulkCount + 1,
    "bulk exit: all queued logs plus exit log were saved"
  );
  assert.match(
    bulkLines[0],
    /\[[^\]]+\]\[INFO\] bulk line 0$/,
    "bulk exit: first queued log was saved"
  );
  assert.match(
    bulkLines[bulkCount - 1],
    new RegExp("\\[[^\\]]+\\]\\[INFO\\] bulk line " + (bulkCount - 1) + "$"),
    "bulk exit: last queued log was saved"
  );
  assert.match(
    bulkLines[bulkCount],
    /\[[^\]]+\]\[EXIT\] bulk exit$/,
    "bulk exit: exit log was saved last"
  );
}

run()
  .then(() => {
    console.log("All RLog compatibility tests passed.");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
