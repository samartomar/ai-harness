#!/usr/bin/env node
import { buildProgram } from "./program.js";

// This module is the executable bin entry only — it is never imported elsewhere,
// so parsing argv at top level is safe (tests import `buildProgram` from program.ts).
buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
