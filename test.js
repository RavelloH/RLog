const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
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
}

run()
  .then(() => {
    console.log("All RLog compatibility tests passed.");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
