#!/usr/bin/env node
import { writeMethodologyParserFailure } from "./methodology/index.js";
import {
  buildProgram,
  buildProgramWithPlugins,
  isMethodologyNoPluginFastPath,
  isVersionFastPath,
} from "./program.js";

function commanderExitCode(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    typeof error.exitCode === "number"
  ) {
    return error.exitCode;
  }
  return undefined;
}

// This module is the executable bin entry only — it is never imported elsewhere,
// so parsing argv at top level is safe (tests import the builders from program.ts).
// `aih --version`/`-V` and every methodology invocation take the local-only path.
// Phase 1 methodology handling may never import plugin code, even for invalid argv.
// Other `--help` paths stay async so they can list valid plugin commands.
// Plugin warnings surface on stderr BEFORE parse so a broken @aihq/enterprise
// install is visible even when the invoked command writes nothing itself; the
// probe fails open, so a broken plugin never blocks the local CLI.
const methodologyNoPluginPath = isMethodologyNoPluginFastPath(process.argv);
const methodologyJsonInformationalRequest =
  methodologyNoPluginPath &&
  process.argv.includes("--json") &&
  (process.argv.includes("--help") ||
    process.argv.includes("-h") ||
    process.argv.includes("--version") ||
    process.argv.includes("-V"));
if (methodologyJsonInformationalRequest) {
  writeMethodologyParserFailure(process.argv);
  process.exitCode = 1;
} else if (isVersionFastPath(process.argv)) {
  buildProgram().parse(process.argv);
} else {
  (methodologyNoPluginPath
    ? Promise.resolve({ program: buildProgram(), warnings: [] })
    : buildProgramWithPlugins()
  )
    .then(({ program, warnings }) => {
      for (const warning of warnings) process.stderr.write(`aih: plugin: ${warning}\n`);
      if (methodologyNoPluginPath) program.exitOverride();
      return program.parseAsync(process.argv);
    })
    .catch((err: unknown) => {
      if (writeMethodologyParserFailure(process.argv)) {
        process.exitCode = 1;
        return;
      }
      const exitCode = commanderExitCode(err);
      if (exitCode !== undefined) {
        process.exitCode = exitCode;
        return;
      }
      process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
