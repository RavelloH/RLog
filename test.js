const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { Readable } = require("stream");
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
    colorBoundaryRlog.screen.info(
      "message 2026-04-29",
      new Date("2026-04-29T00:00:00.000Z")
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
    stripAnsi(captureStdout(() => timezoneRlog.screen.info("time", fixedDate))),
    "2026-04-28 22:37:36.051 +08:00 +0800 Tue Tuesday Apr April PM pm time\n",
    "time formatter should support common tokens and IANA timezones"
  );

  const chicagoRlog = createRlog({
    timezone: "America/Chicago",
    logTemplate: "{time:YYYY-MM-DD HH:mm:ss Z} {message}",
  });
  assert.strictEqual(
    stripAnsi(captureStdout(() => chicagoRlog.screen.info("time", fixedDate))),
    "2026-04-28 09:37:36 -05:00 time\n",
    "time formatter should apply daylight-saving timezone offsets"
  );

  const specialTimeRlog = createRlog({
    timezone: "Asia/Shanghai",
    logTemplate: "{time:ISO}|{time:GMT}|{time:UTC}|{time:timestamp}|{message}",
  });
  assert.strictEqual(
    stripAnsi(captureStdout(() => specialTimeRlog.screen.info("time", fixedDate))),
    "2026-04-28T14:37:36.051Z|2026-04-28T14:37:36.051Z|2026-04-28T14:37:36Z|1777387056051|time\n",
    "time formatter should support ISO, GMT, UTC, and timestamp special formats"
  );

  const literalTimeRlog = createRlog({
    timezone: "UTC",
    logTemplate: "{time:YYYY[year]MM[month]DD} {message}",
  });
  assert.strictEqual(
    stripAnsi(captureStdout(() => literalTimeRlog.screen.info("time", fixedDate))),
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

    const lateEntryRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none" });
    const lateEntry = lateEntryRlog.info("late metadata");
    await lateEntryRlog.flush();
    assert.throws(() => lateEntry.meta({ tooLate: true }), /already been committed/);
    await lateEntryRlog.close();

    const lowLevelExit = new Rlog({ autoInit: false, silent: true, screenOutput: "none", logFilePath: path.join(tempDir, "low-exit.log") });
    lowLevelExit.file.exit("file-only exit");
    await lowLevelExit.close();
    assert.match(fs.readFileSync(path.join(tempDir, "low-exit.log"), "utf8"), /\[EXIT\] file-only exit/, "file.exit remains a file-only log operation");

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

    let fileErrorCalls = 0;
    const failingRlog = new Rlog({ autoInit: false, silent: true, screenOutput: "none", logFilePath: tempDir, fileErrorPolicy: "throw", onFileError() { fileErrorCalls += 1; } });
    failingRlog.info("write failure");
    await assert.rejects(failingRlog.flush());
    assert.ok(fileErrorCalls >= 1, "file errors are reported before flush rejects");
    await assert.rejects(failingRlog.close());
    for (const policy of ["disable", "ignore"]) {
      const tolerant = new Rlog({ autoInit: false, silent: true, screenOutput: "none", logFilePath: tempDir, fileErrorPolicy: policy });
      tolerant.info(`policy ${policy}`);
      await tolerant.flush();
      await tolerant.close();
    }

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
    const timeoutResult = spawnSync(process.execPath, ["-e", `const Rlog = require(${JSON.stringify(path.join(__dirname, "dist", "index.js"))}); const r = new Rlog({autoInit:false,silent:true,screenOutput:'none',exitListenerTimeoutMs:10}); r.onExit(() => new Promise(() => {})); r.exit('timeout');`], { encoding: "utf8", timeout: 1000 });
    assert.strictEqual(timeoutResult.status, 1, "listener timeout produces exit code 1");
    const ordinaryResult = spawnSync(process.execPath, ["-e", `const Rlog = require(${JSON.stringify(path.join(__dirname, "dist", "index.js"))}); new Rlog({silent:true}); throw new Error("ordinary failure");`], { encoding: "utf8" });
    assert.notStrictEqual(ordinaryResult.status, 0, "ordinary uncaught errors remain failures");
    assert.match(ordinaryResult.stderr, /ordinary failure/);
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
