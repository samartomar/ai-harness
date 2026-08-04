#!/usr/bin/env node
import { runNativeEccRuntime } from "./ecc-profile/native-runtime-cli.js";

runNativeEccRuntime(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
