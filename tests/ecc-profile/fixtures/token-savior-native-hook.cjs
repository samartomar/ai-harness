"use strict";

const { writeFileSync } = require("node:fs");

const marker = process.env.AIH_NATIVE_HOOK_MARKER;
const encodedOutput = process.env.AIH_NATIVE_HOOK_OUTPUT_BASE64;
if (!marker || !encodedOutput) {
  process.stderr.write("native hook fixture environment is incomplete\n");
  process.exitCode = 2;
} else {
  writeFileSync(marker, "executed", { encoding: "utf8", flag: "wx" });
  const output = Buffer.from(encodedOutput, "base64").toString("utf8");
  process.stdin.resume();
  process.stdin.on("end", () => process.stdout.write(output));
}
