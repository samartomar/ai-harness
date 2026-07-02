#!/usr/bin/env node
import { buildProgramWithPlugins } from "./program.js";

// This module is the executable bin entry only — it is never imported elsewhere,
// so parsing argv at top level is safe (tests import the builders from program.ts).
// Plugin warnings surface on stderr BEFORE parse so a broken @aihq/enterprise
// install is visible even when the invoked command writes nothing itself; the
// probe fails open, so a broken plugin never blocks the local CLI.
buildProgramWithPlugins()
  .then(({ program, warnings }) => {
    for (const warning of warnings) process.stderr.write(`aih: plugin: ${warning}\n`);
    return program.parseAsync(process.argv);
  })
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
