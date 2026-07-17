#!/usr/bin/env node
import { buildProgram, buildProgramWithPlugins, isVersionFastPath } from "./program.js";
import { writeMethodologyParserFailure } from "./methodology/index.js";

// This module is the executable bin entry only — it is never imported elsewhere,
// so parsing argv at top level is safe (tests import the builders from program.ts).
// `aih --version`/`-V` takes the sync fast path with ZERO plugin probing: version
// output can never wait on — or be broken by — the optional plugin's import.
// `--help` stays on the async path on purpose: help must list plugin commands.
// Plugin warnings surface on stderr BEFORE parse so a broken @aihq/enterprise
// install is visible even when the invoked command writes nothing itself; the
// probe fails open, so a broken plugin never blocks the local CLI.
if (isVersionFastPath(process.argv)) {
  buildProgram().parse(process.argv);
} else {
  buildProgramWithPlugins()
    .then(({ program, warnings }) => {
      for (const warning of warnings) process.stderr.write(`aih: plugin: ${warning}\n`);
      return program.parseAsync(process.argv);
    })
    .catch((err: unknown) => {
      if (writeMethodologyParserFailure(process.argv)) {
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
