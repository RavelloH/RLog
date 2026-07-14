const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { Readable } = require("stream");
const { formatWithOptions, inspect } = require("util");
const Rlog = require("./dist/index.js");

assert.strictEqual(typeof Rlog, "function", "CommonJS entry remains constructable");
assert.strictEqual(typeof Rlog.default, "function", "CommonJS default export is retained");
assert.strictEqual(typeof Rlog.CaptureError, "function", "CommonJS CaptureError export is retained");
assert.strictEqual(typeof Rlog.RLogClosedError, "function", "CommonJS RLogClosedError export is retained");
assert.strictEqual(typeof Rlog.LogEntryAlreadyCommittedError, "function", "CommonJS LogEntryAlreadyCommittedError export is retained");

const INSPECT_OPTIONS = { colors: false };
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function expectedMessage(...args) {
  return formatWithOptions(INSPECT_OPTIONS, ...args);
}

function stripAnsi(value) {
  return value.replace(ANSI_RE, "");
}

function hasAnsi(value) {
  ANSI_RE.lastIndex = 0;
  return ANSI_RE.test(value);
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
  return rlog.close();
}

function runExitChild(body, extraEnv = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rlog-exit-test-"));
  const logFile = path.join(tempDir, "exit.log");
  const markerFile = path.join(tempDir, "marker.txt");
  const distEntry = path.join(__dirname, "dist", "index.js");
  const childCode = `
    const fs = require("fs");
    const Rlog = require(${JSON.stringify(distEntry)});
    process.stdout.write = (_chunk, encoding, callback) => {
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") done();
      return true;
    };
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

function runScriptTree(files, entryFile) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rlog-tree-test-"));

  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, name), content);
    }

    return spawnSync(process.execPath, [path.join(tempDir, entryFile)], {
      cwd: tempDir,
      env: {
        ...process.env,
        RLOG_DIST_ENTRY: path.join(__dirname, "dist", "index.js"),
      },
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseRlogLines(output) {
  return stripAnsi(output)
    .trimEnd()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = /^\[([^\]]*)\]\[([^\]]+)\] (.*)$/.exec(line);
      assert.ok(match, `Unexpected Rlog line shape:\n${line}`);
      return {
        time: match[1],
        type: match[2],
        message: match[3],
      };
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

  const typeColorRlog = createRlog({
    logTemplate: "{message}",
    customColorRules: [],
  });
  const typeColorSamples = [
    { label: "number", args: [123] },
    { label: "boolean", args: [true] },
    { label: "object", args: [{ time: 1777431351982, text: "example" }] },
    { label: "array", args: [[1, 2, "5"]] },
    { label: "function", args: [sampleFunction] },
    { label: "error", args: [new Error("demo error")] },
  ];

  for (const item of typeColorSamples) {
    const output = captureStdout(() => {
      typeColorRlog.info(...item.args);
    });
    assert.ok(hasAnsi(output), `${item.label}: screen output should include type color`);
    assert.strictEqual(
      stripAnsi(output),
      `${expectedMessage(...item.args)}\n`,
      `${item.label}: colored screen output should preserve console text`
    );
  }

  const defaultRuleRlog = new Rlog({
    autoInit: false,
    silent: true,
    timeFormat: "timestamp",
    logTemplate: "{message}",
  });
  assert.strictEqual(
    stripAnsi(captureStdout(() => defaultRuleRlog.info(true))),
    "true\n",
    "default string color rules should not duplicate colored boolean output"
  );

  const lowLevelScreenNumber = captureStdout(() => {
    typeColorRlog.screen.info(123);
  });
  assert.ok(
    lowLevelScreenNumber.includes("\u001b[33m123"),
    "low-level screen output should use Node inspect type colors"
  );
  assert.strictEqual(
    stripAnsi(lowLevelScreenNumber),
    "123\n",
    "low-level screen type colors should preserve console text"
  );

  const successOutput = captureStdout(() => {
    typeColorRlog.success("success message");
  });
  assert.ok(
    successOutput.includes("\u001b[32msuccess message"),
    "success message body should be green"
  );
  assert.strictEqual(
    stripAnsi(successOutput),
    "success message\n",
    "success message color should preserve console text"
  );

  const progressOutput = captureStdout(() => {
    typeColorRlog.progress(5, 10);
  });
  assert.ok(
    progressOutput.includes("\u001b[35mPROG\u001b[39m"),
    "progress label should be magenta"
  );

  const noColorRlog = createRlog({
    enableColorfulOutput: false,
    logTemplate: "{message}",
    customColorRules: [{ reg: "red-word", color: "red" }],
  });
  const noColorOutput = captureStdout(() => {
    noColorRlog.success("red-word", { ok: true });
    noColorRlog.progress(1, 2);
  });
  assert.ok(
    !hasAnsi(noColorOutput),
    "enableColorfulOutput=false should disable type, rule, level, success, and progress colors"
  );

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

  const templateRlog = createRlog({
    logTemplate: "<{level}> {time:YYYY} :: {message}",
  });
  assert.match(
    stripAnsi(captureStdout(() => templateRlog.info("templated"))),
    /^<INFO> \d{4} :: templated\n$/,
    "custom template should render level, inline time format, and message"
  );

  const colorBoundaryRlog = createRlog({
    logTemplate: "T={time:YYYY-MM-DD} L={level} M={message}",
    customColorRules: [{ reg: "2026-04-29", color: "red" }],
  });
  const colorBoundaryOutput = captureStdout(() => {
    colorBoundaryRlog.screen.at(new Date("2026-04-29T00:00:00.000Z")).info(
      "message 2026-04-29",
    );
  });

  assert.ok(
    colorBoundaryOutput.includes("T=2026-04-29 L="),
    "custom color rules should not colorize template time"
  );
  assert.ok(
    colorBoundaryOutput.includes("M=message \u001b[31m2026-04-29"),
    "custom color rules should still colorize message content"
  );

  const fixedDate = new Date("2026-04-28T14:37:36.051Z");
  const timezoneRlog = createRlog({
    timezone: "Asia/Shanghai",
    logTemplate:
      "{time:YYYY-MM-DD HH:mm:ss.SSS Z ZZ ddd dddd MMM MMMM A a} {message}",
  });
  assert.strictEqual(
    stripAnsi(captureStdout(() => timezoneRlog.screen.at(fixedDate).info("time"))),
    "2026-04-28 22:37:36.051 +08:00 +0800 Tue Tuesday Apr April PM pm time\n",
    "time formatter should support common tokens and IANA timezones"
  );

  const chicagoRlog = createRlog({
    timezone: "America/Chicago",
    logTemplate: "{time:YYYY-MM-DD HH:mm:ss Z} {message}",
  });
  assert.strictEqual(
    stripAnsi(captureStdout(() => chicagoRlog.screen.at(fixedDate).info("time"))),
    "2026-04-28 09:37:36 -05:00 time\n",
    "time formatter should apply daylight-saving timezone offsets"
  );

  const specialTimeRlog = createRlog({
    timezone: "Asia/Shanghai",
    logTemplate: "{time:ISO}|{time:GMT}|{time:UTC}|{time:timestamp}|{message}",
  });
  assert.strictEqual(
    stripAnsi(captureStdout(() => specialTimeRlog.screen.at(fixedDate).info("time"))),
    "2026-04-28T14:37:36.051Z|2026-04-28T14:37:36.051Z|2026-04-28T14:37:36Z|1777387056051|time\n",
    "time formatter should support ISO, GMT, UTC, and timestamp special formats"
  );

  const literalTimeRlog = createRlog({
    timezone: "UTC",
    logTemplate: "{time:YYYY[year]MM[month]DD} {message}",
  });
  assert.strictEqual(
    stripAnsi(captureStdout(() => literalTimeRlog.screen.at(fixedDate).info("time"))),
    "2026year04month28 time\n",
    "time formatter should support bracket literals"
  );

  const appendTemplateRlog = createRlog({
    logTemplate: "[{level}] ",
  });
  assert.strictEqual(
    stripAnsi(captureStdout(() => appendTemplateRlog.info("appended"))),
    "[INFO] appended\n",
    "template without {message} should append message at the end"
  );

  const widePrefixRlog = createRlog({
    logTemplate: "前缀{level}: {message}",
  });
  assert.strictEqual(
    stripAnsi(captureStdout(() => widePrefixRlog.info("one\ntwo"))),
    `前缀INFO: one\n${" ".repeat(10)}two\n`,
    "multiline padding should use terminal display width"
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

  const templateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rlog-template-"));
  const templateLogFilePath = path.join(templateTempDir, "rlog.log");

  try {
    const templateFileRlog = createRlog({
      autoInit: true,
      logFilePath: templateLogFilePath,
      logTemplate: "<{level}> {time:YYYY} {message}",
    });

    captureStdout(() => templateFileRlog.info("file", { b: 1 }, 1));
    await closeLogStream(templateFileRlog);

    const templateFileContent = fs.readFileSync(templateLogFilePath, "utf8");
    assert.match(
      templateFileContent,
      /^<INFO> \d{4} file \{ b: 1 \} 1\r?\n$/,
      "file output should use custom template"
    );
  } finally {
    fs.rmSync(templateTempDir, { recursive: true, force: true });
  }

  const sameProcessTree = runScriptTree(
    {
      "child.js": `
        const Rlog = require(process.env.RLOG_DIST_ENTRY);

        const childRlog = new Rlog({
          autoInit: false,
          silent: true,
          timeFormat: "YYYY-MM-DD HH:mm:ss.SSS",
          blockedWordsList: ["child-secret"],
          customColorRules: [],
        });

        exports.runAfterParentGlobal = function runAfterParentGlobal() {
          childRlog.info("same child existing global-secret child-secret");
        };

        exports.runNewAfterParentGlobal = function runNewAfterParentGlobal() {
          const newChildRlog = new Rlog({
            autoInit: false,
            silent: true,
            customColorRules: [],
          });
          newChildRlog.info("same child new global-secret child-secret");
        };

        exports.runAfterLocalOverride = function runAfterLocalOverride() {
          childRlog.config.setConfig({
            blockedWordsList: ["child-secret"],
          });
          childRlog.info("same child local global-secret child-secret");
        };
      `,
      "parent.js": `
        const Rlog = require(process.env.RLOG_DIST_ENTRY);
        const child = require("./child.js");

        const parentRlog = new Rlog({
          autoInit: false,
          silent: true,
          blockedWordsList: ["parent-secret"],
          customColorRules: [],
        });

        parentRlog.config.setConfigGlobal({
          timeFormat: "timestamp",
          blockedWordsList: ["global-secret"],
          customColorRules: [],
        });

        parentRlog.info("same parent global-secret parent-secret");
        child.runAfterParentGlobal();
        child.runNewAfterParentGlobal();
        child.runAfterLocalOverride();
      `,
    },
    "parent.js"
  );
  assert.strictEqual(sameProcessTree.status, 0, "same-process tree exits");
  assert.strictEqual(sameProcessTree.stderr, "", "same-process tree stderr");

  const sameProcessLines = parseRlogLines(sameProcessTree.stdout);
  assert.strictEqual(
    sameProcessLines.length,
    4,
    "same-process tree should emit four log lines"
  );
  assert.ok(
    !sameProcessLines[0].message.includes("global-secret") &&
      sameProcessLines[0].message.includes("parent-secret"),
    "same-process tree: global config overrides existing parent instance"
  );
  assert.ok(
    !sameProcessLines[1].message.includes("global-secret") &&
      sameProcessLines[1].message.includes("child-secret"),
    "same-process tree: global config overrides existing child instance"
  );
  assert.ok(
    !sameProcessLines[2].message.includes("global-secret") &&
      sameProcessLines[2].message.includes("child-secret"),
    "same-process tree: child instance created after global config inherits it"
  );
  assert.ok(
    sameProcessLines[3].message.includes("global-secret") &&
      !sameProcessLines[3].message.includes("child-secret"),
    "same-process tree: local child config can override global defaults after the global call"
  );

  const spawnedProcessTree = runScriptTree(
    {
      "spawn-child.js": `
        const Rlog = require(process.env.RLOG_DIST_ENTRY);
        const childRlog = new Rlog({
          autoInit: false,
          silent: true,
          timeFormat: "timestamp",
          customColorRules: [],
        });
        childRlog.info("spawn child global-secret child-secret");
      `,
      "parent.js": `
        const path = require("path");
        const { spawnSync } = require("child_process");
        const Rlog = require(process.env.RLOG_DIST_ENTRY);

        const parentRlog = new Rlog({
          autoInit: false,
          silent: true,
          customColorRules: [],
        });
        parentRlog.config.setConfigGlobal({
          timeFormat: "timestamp",
          blockedWordsList: ["global-secret"],
          customColorRules: [],
        });

        parentRlog.info("spawn parent global-secret child-secret");

        const childResult = spawnSync(process.execPath, [
          path.join(__dirname, "spawn-child.js"),
        ], {
          env: process.env,
          encoding: "utf8",
        });

        process.stdout.write(childResult.stdout);
        if (childResult.status !== 0) {
          process.stderr.write(childResult.stderr);
          process.exit(childResult.status || 1);
        }
      `,
    },
    "parent.js"
  );
  assert.strictEqual(spawnedProcessTree.status, 0, "spawned tree exits");
  assert.strictEqual(spawnedProcessTree.stderr, "", "spawned tree stderr");

  const spawnedLines = parseRlogLines(spawnedProcessTree.stdout);
  assert.strictEqual(
    spawnedLines.length,
    2,
    "spawned tree should emit two log lines"
  );
  assert.ok(
    !spawnedLines[0].message.includes("global-secret") &&
      spawnedLines[0].message.includes("child-secret"),
    "spawned tree: parent process uses its global config"
  );
  assert.ok(
    spawnedLines[1].message.includes("global-secret") &&
      spawnedLines[1].message.includes("child-secret"),
    "spawned tree: child process does not inherit parent process global config"
  );

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

async function runV22() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rlog-v22-test-"));
  const textFile = path.join(tempDir, "records.log");
  const jsonlFile = path.join(tempDir, "records.jsonl");

  try {
    const rlog = new Rlog({
      autoInit: false,
      silent: true,
      enableColorfulOutput: false,
      screenOutput: "none",
      logFilePath: textFile,
      jsonlFilePath: jsonlFile,
      context: { app: "test", token: "visible" },
      redactKeys: ["token"],
    });
    const child = rlog.child({ device: "controller" });
    child.info("Payload", { value: 123 }).meta({ requestId: "req-1", token: "hidden" });
    child.event("stage.completed", { durationMs: 42 }, { level: "success" }).meta("stage", "flash");
    await rlog.close();

    const text = fs.readFileSync(textFile, "utf8");
    assert.match(text, /Payload \{ value: 123 \}/, "body object stays in message");
    assert.match(text, /requestId: 'req-1'/, "metadata is rendered to text files");
    assert.doesNotMatch(text, /hidden|visible/, "structured keys are redacted in text output");
    const records = fs.readFileSync(jsonlFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.strictEqual(records.length, 2, "JSONL writes one record per line");
    assert.deepStrictEqual(records[0].context, { app: "test", device: "controller", token: "[REDACTED]" });
    assert.strictEqual(records[0].meta.requestId, "req-1");
    assert.strictEqual(records[1].event.type, "stage.completed");
    assert.strictEqual(records[1].event.data.durationMs, 42);
    assert.match(text, /durationMs: 42/, "event data is rendered with text metadata");

    const redactionTextFile = path.join(tempDir, "error-redaction.log");
    const redactionJsonlFile = path.join(tempDir, "error-redaction.jsonl");
    let redactionScreen = "";
    const redactionTarget = new (require("stream").Writable)({ write(chunk, _encoding, callback) { redactionScreen += chunk.toString(); callback(); } });
    const nestedError = Object.assign(new Error("nested"), { token: "nested-secret" });
    const structuredError = Object.assign(new Error("failed"), { token: "top-secret", authorization: "Bearer secret-token", cause: nestedError });
    nestedError.cause = structuredError;
    const redactionRlog = new Rlog({ autoInit: false, silent: true, enableColorfulOutput: false, screenOutput: redactionTarget, screenMetadataOutput: "block", logFilePath: redactionTextFile, jsonlFilePath: redactionJsonlFile, redactKeys: ["token", "authorization"] });
    redactionRlog.error("request failed").meta({ error: structuredError });
    redactionRlog.event("operation.failed", { error: structuredError });
    redactionRlog.child({ error: structuredError }).info("child error context");
    await redactionRlog.close();
    const redactionText = fs.readFileSync(redactionTextFile, "utf8");
    for (const secret of ["top-secret", "nested-secret", "Bearer secret-token"]) {
      assert.doesNotMatch(redactionText, new RegExp(secret), "text metadata redacts Error custom fields");
      assert.doesNotMatch(redactionScreen, new RegExp(secret), "screen metadata redacts Error custom fields");
    }
    assert.match(redactionText, /\[REDACTED\]/, "text metadata preserves redaction markers");
    const redactionRecords = fs.readFileSync(redactionJsonlFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.strictEqual(redactionRecords[0].meta.error.token, "[REDACTED]");
    assert.strictEqual(redactionRecords[0].meta.error.authorization, "[REDACTED]");
    assert.strictEqual(redactionRecords[0].meta.error.cause.token, "[REDACTED]");
    assert.strictEqual(redactionRecords[0].meta.error.cause.cause, "[Circular]");
    assert.strictEqual(redactionRecords[1].event.data.error.cause.token, "[REDACTED]");
    assert.strictEqual(redactionRecords[2].context.error.token, "[REDACTED]");

    const lateEntryRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none" });
    const lateEntry = lateEntryRlog.info("late metadata");
    await lateEntryRlog.flush();
    assert.throws(() => lateEntry.meta({ tooLate: true }), /already been committed/);
    await lateEntryRlog.close();

    const lowLevelExit = new Rlog({ autoInit: false, silent: true, screenOutput: "none", logFilePath: path.join(tempDir, "low-exit.log") });
    lowLevelExit.file.exit("file-only exit");
    await lowLevelExit.close();
    assert.match(fs.readFileSync(path.join(tempDir, "low-exit.log"), "utf8"), /\[EXIT\] file-only exit/, "file.exit remains a file-only log operation");

    const legacyTimeFile = path.join(tempDir, "legacy-time.log");
    let legacyScreen = "";
    const legacyTarget = new (require("stream").Writable)({ write(chunk, _encoding, callback) { legacyScreen += chunk.toString(); callback(); } });
    const legacyTime = new Rlog({ autoInit: false, silent: true, enableColorfulOutput: false, screenOutput: legacyTarget, logFilePath: legacyTimeFile, timeFormat: "timestamp" });
    legacyTime.screen.info("numeric value", 123);
    legacyTime.screen.warn("boolean value", false);
    legacyTime.file.info("bigint value", 9n);
    legacyTime.file.error("string value", "legacy");
    legacyTime.screen.at(123).info("numeric time");
    legacyTime.file.at(9n).info("bigint time");
    await legacyTime.close();
    assert.match(legacyScreen, /numeric value 123/, "facade second argument is a console-style body argument");
    assert.match(legacyScreen, /^\[123\]\[INFO\] numeric time/m, "screen.at retains non-Date time compatibility");
    const legacyText = fs.readFileSync(legacyTimeFile, "utf8");
    assert.match(legacyText, /bigint value 9n/, "file alias uses console-style arguments");
    assert.match(legacyText, /^\[9\]\[INFO\] bigint time/m, "text.at retains bigint time compatibility");

    const levelFile = path.join(tempDir, "levels.log");
    const levelRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none", logFilePath: levelFile, screenLogLevel: "off", fileLogLevel: "debug" });
    levelRlog.trace("trace hidden");
    levelRlog.debug("debug visible");
    levelRlog.info("info visible");
    await levelRlog.close();
    const levelText = fs.readFileSync(levelFile, "utf8");
    assert.doesNotMatch(levelText, /trace hidden/);
    assert.match(levelText, /debug visible/);
    assert.match(levelText, /info visible/);

    let customOutput = "";
    const customWritable = new (require("stream").Writable)({ write(chunk, _encoding, callback) { customOutput += chunk.toString(); callback(); } });
    const outputRlog = new Rlog({ autoInit: false, silent: true, enableColorfulOutput: false, screenOutput: customWritable });
    outputRlog.info("custom target");
    await outputRlog.close();
    assert.match(customOutput, /custom target/, "custom screen target receives logs");

    const slowOutput = [];
    const slowWarnings = [];
    const slowTarget = new (require("stream").Writable)({
      write(chunk, _encoding, callback) {
        setTimeout(() => { slowOutput.push(chunk.toString()); callback(); }, 2);
      },
    });
    const warningListener = (warning) => {
      if (warning && warning.name === "MaxListenersExceededWarning") slowWarnings.push(warning);
    };
    process.on("warning", warningListener);
    try {
      const slowRlog = new Rlog({ autoInit: false, silent: true, enableColorfulOutput: false, screenOutput: slowTarget });
      for (let index = 0; index < 100; index += 1) slowRlog.info("line %d", index);
      await slowRlog.close();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.removeListener("warning", warningListener);
    }
    assert.strictEqual(slowOutput.length, 100, "slow Writable receives every screen record");
    assert.match(slowOutput[0], /line 0/, "slow Writable preserves the first record");
    assert.match(slowOutput[99], /line 99/, "slow Writable preserves the final record");
    assert.strictEqual(slowWarnings.length, 0, "serial screen writes do not accumulate error listeners");

    const originalArgv = process.argv;
    const originalEnv = process.env.RLOG_LEVEL;
    process.argv = [...process.argv, "--log-level=error"];
    process.env.RLOG_LEVEL = "debug";
    const priorityRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none", readLogLevelFromArgv: true, readLogLevelFromEnv: true });
    assert.strictEqual(priorityRlog.config.effectiveLevel("screen"), "error", "argv overrides environment");
    priorityRlog.config.setConfig({ screenLogLevel: "warn" });
    assert.strictEqual(priorityRlog.config.effectiveLevel("screen"), "warn", "target level overrides argv");
    process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.RLOG_LEVEL;
    else process.env.RLOG_LEVEL = originalEnv;
    await priorityRlog.close();

    for (const argv of [["--log-level"], ["--log-level="], ["--log-level", "--other"]]) {
      process.argv = [originalArgv[0], originalArgv[1], ...argv];
      const invalidArgvRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none", readLogLevelFromArgv: true });
      assert.throws(() => invalidArgvRlog.config.effectiveLevel("screen"), /--log-level requires a value/, `invalid argv ${argv.join(" ")} is rejected`);
      await invalidArgvRlog.close();
    }
    process.argv = originalArgv;

    for (const invalidLevel of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "prototype"]) {
      assert.throws(() => new Rlog({ autoInit: false, silent: true, screenOutput: "none", logLevel: invalidLevel }), /Invalid RLog level/, `${invalidLevel} is not a valid own log level`);
    }
    process.argv = [originalArgv[0], originalArgv[1], "--log-level=constructor"];
    const invalidArgvLevel = new Rlog({ autoInit: false, silent: true, screenOutput: "none", readLogLevelFromArgv: true });
    assert.throws(() => invalidArgvLevel.config.effectiveLevel("screen"), /Invalid RLog level/);
    await invalidArgvLevel.close();
    process.argv = originalArgv;
    process.env.RLOG_LEVEL = "toString";
    const invalidEnvLevel = new Rlog({ autoInit: false, silent: true, screenOutput: "none", readLogLevelFromEnv: true });
    assert.throws(() => invalidEnvLevel.config.effectiveLevel("screen"), /Invalid RLog level/);
    await invalidEnvLevel.close();
    if (originalEnv === undefined) delete process.env.RLOG_LEVEL;
    else process.env.RLOG_LEVEL = originalEnv;

    const captureRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none" });
    const streamCapture = captureRlog.capture.stream(Readable.from([Buffer.from("a\n"), Buffer.from([0xe4, 0xb8]), Buffer.from([0xad, 0x0a])]), { file: path.join(tempDir, "stream.log"), computeSha256: true });
    const streamResult = await streamCapture.done;
    assert.strictEqual(streamResult.reason, "end");
    assert.strictEqual(streamResult.lines, 2, "text capture counts completed lines even when display is disabled");
    assert.strictEqual(fs.readFileSync(path.join(tempDir, "stream.log"), "utf8"), "a\n中\n");
    assert.ok(streamResult.sha256, "text capture computes optional SHA-256");
    const timestampCapture = captureRlog.capture.stream(Readable.from(["line\n", "tail"]), { file: path.join(tempDir, "timestamp.log"), timestampLines: true });
    await timestampCapture.done;
    const timestampText = fs.readFileSync(path.join(tempDir, "timestamp.log"), "utf8");
    assert.match(timestampText, /^\[[^\]]+\] line\r?\n\[[^\]]+\] tail$/, "timestampLines prefixes complete and final lines");
    const binaryCapture = captureRlog.capture.binary(Readable.from([Buffer.from([0, 1, 2])]), { file: path.join(tempDir, "stream.bin") });
    const binaryResult = await binaryCapture.done;
    assert.strictEqual(binaryResult.sha256, "ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc", "binary SHA-256 is recorded");
    assert.deepStrictEqual(fs.readFileSync(path.join(tempDir, "stream.bin")), Buffer.from([0, 1, 2]));

    let captureDisplay = "";
    const captureTarget = new (require("stream").Writable)({ write(chunk, _encoding, callback) { captureDisplay += chunk.toString(); callback(); } });
    const silentCaptureRlog = new Rlog({ autoInit: false, silent: true, enableColorfulOutput: false, screenOutput: captureTarget });
    await silentCaptureRlog.capture.stream(Readable.from(["not displayed\n"]), { displayLevel: "off", file: path.join(tempDir, "off-stream.log") }).done;
    const offChild = spawn(process.execPath, ["-e", "process.stdout.write('out\\n'); process.stderr.write('err\\n')"]);
    await silentCaptureRlog.capture.process(offChild, { stdoutDisplay: "off", stderrDisplay: "off" });
    await silentCaptureRlog.close();
    assert.strictEqual(captureDisplay, "", 'capture display level "off" is normalized to "none"');

    const completedChild = spawn(process.execPath, ["-e", "process.stdout.write('out\\n'); process.stderr.write('err\\n')"]);
    const completedProcess = await captureRlog.capture.process(completedChild, { stdoutFile: path.join(tempDir, "process-out.log"), stderrFile: path.join(tempDir, "process-err.log"), computeSha256: true });
    assert.strictEqual(completedProcess.reason, "process-close");
    assert.strictEqual(completedProcess.exitCode, 0);
    assert.strictEqual(fs.readFileSync(path.join(tempDir, "process-out.log"), "utf8"), "out\n");
    assert.strictEqual(fs.readFileSync(path.join(tempDir, "process-err.log"), "utf8"), "err\n");

    const childProcess = spawn(process.execPath, ["-e", "let i=0; setInterval(() => console.log(i++), 5)"]);
    const processPromise = captureRlog.capture.process(childProcess, { stdoutFile: path.join(tempDir, "process.log") });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await captureRlog.close();
    await assert.rejects(processPromise, (error) => error && error.code === "CAPTURE_ABORTED_BY_LOGGER_CLOSE" && error.partialResult.reason === "logger-close");
    assert.strictEqual(childProcess.exitCode, null, "closing RLog does not terminate the child process");
    childProcess.kill();

    const captureTimeout = (promise, label) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 1000)),
    ]);
    const closeActiveTextCapture = async (screenOutput, input, options = {}) => {
      const source = new (require("stream").PassThrough)();
      const logger = new Rlog({ autoInit: false, silent: true, enableColorfulOutput: false, screenOutput });
      const handle = logger.capture.stream(source, { displayLevel: "info", ...options });
      source.write(input);
      const closePromise = logger.close();
      assert.throws(() => logger.info("late user log"), Rlog.RLogClosedError, "ordinary user logs remain rejected while closing");
      await captureTimeout(closePromise, "text capture close");
      const result = await captureTimeout(handle.done, "text capture done");
      assert.strictEqual(result.reason, "logger-close");
      return result;
    };

    let partialOutput = "";
    const partialTarget = new (require("stream").Writable)({ write(chunk, _encoding, callback) { partialOutput += chunk.toString(); callback(); } });
    await closeActiveTextCapture(partialTarget, "partial line");
    assert.strictEqual(typeof partialOutput, "string", "custom Writable supports closing text captures");
    await closeActiveTextCapture("stdout", "stdout partial");
    await closeActiveTextCapture("stderr", "stderr partial");
    await closeActiveTextCapture("none", "none partial");

    let completeOutput = "";
    const completeTarget = new (require("stream").Writable)({ write(chunk, _encoding, callback) { completeOutput += chunk.toString(); callback(); } });
    await closeActiveTextCapture(completeTarget, "complete line\n");
    assert.match(completeOutput, /complete line/, "complete lines are mirrored before close");

    const utf8File = path.join(tempDir, "closing-utf8.log");
    const utf8Source = new (require("stream").PassThrough)();
    const utf8Rlog = new Rlog({ autoInit: false, silent: true, enableColorfulOutput: false, screenOutput: "none" });
    const utf8Capture = utf8Rlog.capture.stream(utf8Source, { displayLevel: "info", file: utf8File });
    utf8Source.write(Buffer.from([0xe4, 0xb8]));
    utf8Source.write(Buffer.from([0xad]));
    await captureTimeout(utf8Rlog.close(), "UTF-8 capture close");
    await captureTimeout(utf8Capture.done, "UTF-8 capture done");
    assert.strictEqual(fs.readFileSync(utf8File, "utf8"), "中", "split UTF-8 data is flushed without corruption");

    const failingTarget = new (require("stream").Writable)({ write(_chunk, _encoding, callback) { callback(new Error("display failed")); } });
    const failingSource = new (require("stream").PassThrough)();
    const failingDisplayRlog = new Rlog({ autoInit: false, silent: true, enableColorfulOutput: false, screenOutput: failingTarget });
    const failingDisplayCapture = failingDisplayRlog.capture.stream(failingSource, { displayLevel: "info" });
    failingSource.write("complete display line\n");
    await assert.rejects(captureTimeout(failingDisplayRlog.close(), "failing display close"), /display failed/, "display Writable errors are delivered by close");
    const failingDisplayResult = await captureTimeout(failingDisplayCapture.done, "failing display capture done");
    assert.strictEqual(failingDisplayResult.reason, "logger-close", "a display failure never leaves Capture pending");

    const assertCaptureReleased = async (promise, expectedError, releaseDir, label) => {
      await assert.rejects(captureTimeout(promise, label), expectedError);
      fs.rmSync(releaseDir, { recursive: true, force: false });
    };
    const sourceErrorRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none", fileErrorPolicy: "ignore" });
    const sourceError = new Readable({ read() { this.destroy(new Error("capture source failed")); } });
    const sourceHandle = sourceErrorRlog.capture.stream(sourceError, { file: path.join(tempDir, "source-error.log") });
    await assert.rejects(captureTimeout(sourceHandle.done, "source capture"), (error) => error && error.code === "CAPTURE_SOURCE_ERROR" && error.partialResult.reason === "error");
    await sourceErrorRlog.close();

    const textFailureDir = path.join(tempDir, "text-failure");
    const textFailureTarget = path.join(textFailureDir, "target");
    fs.mkdirSync(textFailureTarget, { recursive: true });
    const textFailureRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none", fileErrorPolicy: "ignore" });
    const textFailure = textFailureRlog.capture.stream(Readable.from(["text failure\n"]), { file: textFailureTarget });
    await assertCaptureReleased(textFailure.done, (error) => error && error.code === "CAPTURE_FILE_ERROR" && error.partialResult.reason === "error", textFailureDir, "text file capture");
    await textFailureRlog.close();

    const binaryFailureDir = path.join(tempDir, "binary-failure");
    const binaryFailureTarget = path.join(binaryFailureDir, "target");
    fs.mkdirSync(binaryFailureTarget, { recursive: true });
    const binaryFailureRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none", fileErrorPolicy: "ignore" });
    const binaryFailure = binaryFailureRlog.capture.binary(Readable.from([Buffer.from("binary failure")]), { file: binaryFailureTarget });
    await assertCaptureReleased(binaryFailure.done, (error) => error && error.code === "CAPTURE_FILE_ERROR" && error.partialResult.reason === "error", binaryFailureDir, "binary file capture");
    await binaryFailureRlog.close();

    const processFailureDir = path.join(tempDir, "process-failure");
    const processFailureTarget = path.join(processFailureDir, "target");
    fs.mkdirSync(processFailureTarget, { recursive: true });
    const processFailureRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none", fileErrorPolicy: "ignore" });
    const failingChild = spawn(process.execPath, ["-e", "process.stdout.write('first\\n'); setInterval(() => {}, 1000)"]);
    const failingProcess = processFailureRlog.capture.process(failingChild, { stdoutFile: processFailureTarget });
    await assertCaptureReleased(failingProcess, (error) => error && error.code === "CAPTURE_FILE_ERROR" && error.partialResult.reason === "error", processFailureDir, "process file capture");
    assert.strictEqual(failingChild.exitCode, null, "process file capture failure does not terminate the child");
    await processFailureRlog.close();
    failingChild.kill();

    const loggerCloseDir = path.join(tempDir, "logger-close-release");
    const loggerCloseFile = path.join(loggerCloseDir, "stdout.log");
    fs.mkdirSync(loggerCloseDir, { recursive: true });
    const loggerCloseRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none" });
    const loggerCloseChild = spawn(process.execPath, ["-e", "setInterval(() => process.stdout.write('line\\n'), 5)"]);
    const loggerClosePromise = loggerCloseRlog.capture.process(loggerCloseChild, { stdoutFile: loggerCloseFile });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await loggerCloseRlog.close();
    await assertCaptureReleased(loggerClosePromise, (error) => error && error.code === "CAPTURE_ABORTED_BY_LOGGER_CLOSE" && error.partialResult.reason === "logger-close", loggerCloseDir, "logger close capture");
    assert.strictEqual(loggerCloseChild.exitCode, null, "logger-close cleanup does not kill the child");
    loggerCloseChild.kill();

    let fileErrorCalls = 0;
    const failingRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none", logFilePath: tempDir, fileErrorPolicy: "throw", onFileError() { fileErrorCalls += 1; } });
    failingRlog.info("write failure");
    await assert.rejects(failingRlog.flush());
    assert.ok(fileErrorCalls >= 1, "file errors are reported before flush rejects");
    // The error has already been delivered by flush(). Some platforms close a
    // failed stream silently while others surface a second close error; both
    // are valid as long as the first delivery is deterministic.
    await failingRlog.close().catch(() => undefined);
    for (const policy of ["disable", "ignore"]) {
      const tolerant = new Rlog({ autoInit: false, silent: true, screenOutput: "none", logFilePath: tempDir, fileErrorPolicy: policy });
      tolerant.info(`policy ${policy}`);
      await tolerant.flush();
      await tolerant.close();
    }

    const historicalErrorDir = path.join(tempDir, "historical-error");
    fs.mkdirSync(historicalErrorDir, { recursive: true });
    const historicalErrorRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none", logFilePath: historicalErrorDir, fileErrorPolicy: "ignore" });
    historicalErrorRlog.info("ignored error");
    await historicalErrorRlog.flush();
    historicalErrorRlog.config.setConfig({ fileErrorPolicy: "throw" });
    await historicalErrorRlog.flush();
    historicalErrorRlog.config.setConfig({ fileErrorPolicy: "ignore" });
    await historicalErrorRlog.close();

    const callbackErrorDir = path.join(tempDir, "callback-error");
    fs.mkdirSync(callbackErrorDir, { recursive: true });
    const callbackErrorRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none", logFilePath: callbackErrorDir, fileErrorPolicy: "ignore", onFileError() { throw new Error("callback failed"); } });
    callbackErrorRlog.info("callback error");
    await assert.rejects(callbackErrorRlog.close(), /callback failed/, "onFileError callback failures are delivered even for ignore");

    for (const policy of ["throw", "disable", "stderr", "ignore"]) {
      const flushFile = path.join(tempDir, `flush-${policy}.log`);
      let reports = 0;
      const flushRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none", logFilePath: flushFile, fileErrorPolicy: policy, onFileError(_error, context) { if (context.operation === "flush") reports += 1; } });
      flushRlog.info("before flush failure");
      await flushRlog.flush();
      const stream = flushRlog.textLogStream;
      const originalWrite = stream.write;
      const originalStderrWrite = process.stderr.write;
      let stderrOutput = "";
      if (policy === "stderr") {
        process.stderr.write = function captureFileError(chunk, encoding, callback) {
          stderrOutput += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
          const done = typeof encoding === "function" ? encoding : callback;
          if (typeof done === "function") done();
          return true;
        };
      }
      stream.write = function failingFlushWrite(chunk, encoding, callback) {
        const done = typeof encoding === "function" ? encoding : callback;
        if (chunk === "") { process.nextTick(() => done(new Error("flush failure"))); return true; }
        return originalWrite.call(this, chunk, encoding, callback);
      };
      if (policy === "throw") await assert.rejects(flushRlog.flush(), /flush failure/);
      else await flushRlog.flush();
      stream.write = originalWrite;
      process.stderr.write = originalStderrWrite;
      assert.strictEqual(reports, 1, `${policy} reports the flush error once`);
      if (policy === "stderr") assert.match(stderrOutput, /RLog file error \(flush, text\): flush failure/, "stderr policy uses the direct stderr fallback");
      await flushRlog.close();
    }

    const listenerLeakFile = path.join(tempDir, "listener-leak.log");
    const listenerLeakRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none", logFilePath: listenerLeakFile });
    listenerLeakRlog.info("listener baseline");
    await listenerLeakRlog.flush();
    const listenerLeakStream = listenerLeakRlog.textLogStream;
    const baselineErrorListeners = listenerLeakStream.listenerCount("error");
    for (let index = 0; index < 100; index += 1) await listenerLeakRlog.flush();
    assert.strictEqual(listenerLeakStream.listenerCount("error"), baselineErrorListeners, "repeated flush calls do not leak error listeners");
    await listenerLeakRlog.close();

    const exitScript = `
      const Rlog = require(${JSON.stringify(path.join(__dirname, "dist", "index.js"))});
      const r = new Rlog({ autoInit: false, silent: true, screenOutput: "none", exitListenerTimeoutMs: 25 });
      r.onExit(() => { throw new Error("listener failure"); });
      r.onExit(() => require("fs").writeFileSync(${JSON.stringify(path.join(tempDir, "after-listener"))}, "ran"));
      r.exit("done");
    `;
    const exitResult = spawnSync(process.execPath, ["-e", exitScript], { encoding: "utf8" });
    assert.strictEqual(exitResult.status, 1, "listener failure produces exit code 1");
    assert.strictEqual(fs.readFileSync(path.join(tempDir, "after-listener"), "utf8"), "ran", "later exit listeners still execute");
    const rejectedListenerResult = spawnSync(process.execPath, ["-e", `const Rlog = require(${JSON.stringify(path.join(__dirname, "dist", "index.js"))}); const r = new Rlog({autoInit:false,silent:true,screenOutput:'none'}); r.onExit(() => Promise.reject(new Error('listener rejection'))); r.exit('rejected listener');`], { encoding: "utf8" });
    assert.strictEqual(rejectedListenerResult.status, 1, "listener promise rejection produces exit code 1");
    const timeoutResult = spawnSync(process.execPath, ["-e", `const Rlog = require(${JSON.stringify(path.join(__dirname, "dist", "index.js"))}); const r = new Rlog({autoInit:false,silent:true,screenOutput:'none',exitListenerTimeoutMs:10}); r.onExit(() => new Promise(() => {})); r.exit('timeout');`], { encoding: "utf8", timeout: 1000 });
    assert.strictEqual(timeoutResult.status, 1, "listener timeout produces exit code 1");
    const closeRejectResult = spawnSync(process.execPath, ["-e", `const Rlog = require(${JSON.stringify(path.join(__dirname, "dist", "index.js"))}); const r = new Rlog({autoInit:false,silent:true,screenOutput:'none'}); r.close = async () => { throw new Error('close rejection'); }; r.exit('close rejection');`], { encoding: "utf8" });
    assert.strictEqual(closeRejectResult.status, 1, "close rejection produces exit code 1");
    const closeTimeoutResult = spawnSync(process.execPath, ["-e", `const Rlog = require(${JSON.stringify(path.join(__dirname, "dist", "index.js"))}); const r = new Rlog({autoInit:false,silent:true,screenOutput:'none',exitCloseTimeoutMs:10}); r.close = () => new Promise(() => {}); r.exit('close timeout');`], { encoding: "utf8", timeout: 1000 });
    assert.strictEqual(closeTimeoutResult.status, 1, "close timeout produces exit code 1");
    const ordinaryResult = spawnSync(process.execPath, ["-e", `const Rlog = require(${JSON.stringify(path.join(__dirname, "dist", "index.js"))}); new Rlog({silent:true}); throw new Error("ordinary failure");`], { encoding: "utf8" });
    assert.notStrictEqual(ordinaryResult.status, 0, "ordinary uncaught errors remain failures");
    assert.match(ordinaryResult.stderr, /ordinary failure/);
    const hostListenerResult = spawnSync(process.execPath, ["-e", `const Rlog = require(${JSON.stringify(path.join(__dirname, "dist", "index.js"))}); let seen = 0; process.on('uncaughtException', () => { seen += 1; }); const before = process.listenerCount('uncaughtException'); new Rlog({silent:true}); const after = process.listenerCount('uncaughtException'); if (before !== after || seen !== 0) process.exit(2);`], { encoding: "utf8" });
    assert.strictEqual(hostListenerResult.status, 0, "constructing RLog does not alter host uncaughtException listeners");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run()
  .then(runV22)
  .then(() => {
    console.log("All RLog compatibility tests passed.");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
