const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const npmCli = process.env.npm_execpath;

function runNpm(args, options) {
  if (!npmCli) throw new Error("npm_execpath is required for package-boundary tests");
  return execFileSync(process.execPath, [npmCli, ...args], options);
}

function packInto(directory) {
  const output = runNpm(["pack", "--json", "--pack-destination", directory], { cwd: root, encoding: "utf8" });
  return path.join(directory, JSON.parse(output)[0].filename);
}

test("packed CommonJS, ESM default, and TypeScript entry points match declarations", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rlog-package-"));
  try {
    const tarball = packInto(temporary);
    fs.writeFileSync(path.join(temporary, "package.json"), JSON.stringify({ private: true }));
    runNpm(["install", "--ignore-scripts", tarball], { cwd: temporary, stdio: "pipe" });
    const commonjs = `
      const Rlog = require('rlog-js');
      const { CaptureError, RLogClosedError, LogEntryAlreadyCommittedError, TargetLogger, ScreenTargetLogger, TextTargetLogger } = require('rlog-js');
      if (typeof Rlog !== 'function' || !CaptureError || !RLogClosedError || !LogEntryAlreadyCommittedError || !TargetLogger || !ScreenTargetLogger || !TextTargetLogger) process.exit(1);
      const rlog = new Rlog({ autoInit: false, silent: true, screenOutput: 'none' });
      if (!(new Rlog.Screen(rlog) instanceof ScreenTargetLogger) || !(new Rlog.File(rlog) instanceof TextTargetLogger)) process.exit(2);
      rlog.close();
    `;
    execFileSync(process.execPath, ["-e", commonjs], { cwd: temporary, stdio: "pipe" });
    execFileSync(process.execPath, ["--input-type=module", "-e", "import Rlog from 'rlog-js'; if (typeof Rlog !== 'function') process.exit(1);"], { cwd: temporary, stdio: "pipe" });
    fs.writeFileSync(path.join(temporary, "consumer.ts"), `import Rlog, { CaptureError, RLogClosedError, LogEntryAlreadyCommittedError, TargetLogger, ScreenTargetLogger, TextTargetLogger } from "rlog-js";
const rlog = new Rlog({ autoInit: false });
void [CaptureError, RLogClosedError, LogEntryAlreadyCommittedError, TargetLogger, ScreenTargetLogger, TextTargetLogger, rlog];\n`);
    fs.writeFileSync(path.join(temporary, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020", module: "Node16", moduleResolution: "Node16", esModuleInterop: true, strict: true, skipLibCheck: true, noEmit: true } }));
    execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], { cwd: temporary, stdio: "pipe" });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
