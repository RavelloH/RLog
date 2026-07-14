const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const Rlog = require("./dist/index.js");

const logDirectory = path.join(__dirname, "demo-logs");
fs.rmSync(logDirectory, { recursive: true, force: true });
fs.mkdirSync(logDirectory, { recursive: true });

async function main() {
  const rlog = new Rlog({
    logFilePath: path.join(logDirectory, "app.log"),
    jsonlFilePath: path.join(logDirectory, "events.jsonl"),
    timezone: "Asia/Shanghai",
    context: { application: "rlog-demo", environment: "local" },
    screenMetadataOutput: "inline",
    fileMetadataOutput: "block",
    blockedWordsList: ["super-secret"],
    redactKeys: ["token", "password"],
    textRotation: { maxBytes: 700, maxFiles: 2 },
    jsonlRotation: { maxBytes: 700, maxFiles: 2 },
  });

  // init() is awaitable; normal writes can begin immediately afterwards.
  await rlog.text.init();
  rlog.info("RLog v3 demo started").meta({ pid: process.pid });

  // Console-compatible arguments and all log levels.
  rlog.trace("trace detail: %j", { stage: "boot" });
  rlog.debug("debug value=%d", 42);
  rlog.info("device=%s port=%s", "controller", "COM9");
  rlog.success("flash completed in %dms", 42);
  rlog.warn("retrying after %dms", 100);
  rlog.error(new Error("sample error"));
  rlog.fatal("sample fatal record; the demo continues");
  rlog.log("automatic success detection: done");
  rlog.log("automatic warning detection: notice this");

  // Target routing: root writes everywhere; each facade writes only one sink.
  rlog.screen.info("screen-only record");
  rlog.text.info("text-only record");
  rlog.jsonl.info("jsonl-only record");
  rlog.info("file alias points to text: %s", rlog.file === rlog.text);

  // Explicit timestamps preserve the same value in text and JSONL.
  rlog.at(new Date("2026-07-14T10:00:00Z")).info("date-bound record");
  rlog.at(456).info("numeric-bound record");
  rlog.jsonl.at(9n).info("bigint-bound JSONL record");

  // Context, child loggers, metadata, and structured events.
  const controller = rlog.child({ device: "controller" });
  controller.info("connected").meta("port", "COM9");
  controller.jsonl
    .event("device.connected", { port: "COM9" }, { level: "success", message: "device connected" })
    .meta({ requestId: "req-1", token: "super-secret" });

  // Text masking applies to messages; redactKeys applies to structured values.
  rlog.info("blocked value: super-secret");
  rlog.jsonl.event("request.received", { password: "super-secret", method: "POST" });

  // Formatting, color rules, time templates, and multiline alignment.
  rlog.config.setConfig({
    customColorRules: [{ reg: "COM\\d+", color: "cyan" }],
    logTemplate: "[{time:HH:mm:ss}][{level}] {message}",
  });
  rlog.info("multiline payload\nCOM9 ready\nnext step");
  rlog.config.setConfig({ logTemplate: "[{time}][{level}] {message}" });

  // Managed raw writes participate in ordering, errors, flush, and rotation.
  await Promise.all([
    rlog.text.writeRaw("raw text record A\n"),
    rlog.text.writeRaw("raw text record B\n"),
  ]);

  // A small threshold makes the demo produce app.log.1 / events.jsonl.1.
  for (let index = 0; index < 8; index += 1) {
    rlog.info("rotation sample %d: %s", index, "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  }

  // Progress writes are included in flush() and close().
  rlog.progress(1, 3);
  rlog.progress(2, 3);
  rlog.progress(3, 3);
  process.stdout.write("\n");

  // Text Capture: streaming text, timestamps, ANSI cleanup, mark, and SHA-256.
  const streamCapture = rlog.capture.stream(Readable.from(["serial boot\n", "serial ready\n"]), {
    file: path.join(logDirectory, "serial-capture.log"),
    timestampLines: true,
    stripAnsiInFile: true,
    displayLevel: "debug",
    computeSha256: true,
  });
  streamCapture.mark("serial-ready", { port: "COM9" });
  const streamResult = await streamCapture.done;
  rlog.info("stream capture bytes=%d sha256=%s", streamResult.bytes, streamResult.sha256);

  // Binary Capture stores raw bytes and optionally computes SHA-256.
  const binaryResult = await rlog.capture.binary(Readable.from([Buffer.from([0, 1, 2, 3])]), {
    file: path.join(logDirectory, "capture.bin"),
    computeSha256: true,
  }).done;
  rlog.info("binary capture bytes=%d sha256=%s", binaryResult.bytes, binaryResult.sha256);

  // Process Capture independently handles stdout/stderr, files, display and hashes.
  const child = spawn(process.execPath, ["-e", "process.stdout.write('tool output\\n'); process.stderr.write('tool warning\\n')"]);
  const processResult = await rlog.capture.process(child, {
    stdoutFile: path.join(logDirectory, "tool.stdout.log"),
    stderrFile: path.join(logDirectory, "tool.stderr.log"),
    stdoutDisplay: "info",
    stderrDisplay: "warn",
    computeSha256: true,
  });
  rlog.jsonl.event("tool.finished", { exitCode: processResult.exitCode, stdoutBytes: processResult.stdoutBytes });

  // Runtime configuration changes also affect existing sinks.
  rlog.config.setConfig({ logLevel: "debug", textRotation: false });
  rlog.text.debug("runtime configuration updated; text rotation is now disabled");

  await rlog.flush();
  rlog.info("flush completed; logger remains usable");
  await rlog.close();

  console.log(`Demo complete. Inspect ${logDirectory}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
