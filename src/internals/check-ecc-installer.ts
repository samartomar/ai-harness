import { spawnSync } from "node:child_process";
import { ECC_NPM_BIN, ECC_NPM_PACKAGE } from "../ecc/install.js";

const argv = ["view", ECC_NPM_PACKAGE, "bin", "--json"];
const command = process.platform === "win32" ? "cmd.exe" : "npm";
const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...argv] : argv;
const result = spawnSync(command, args, {
  encoding: "utf8",
});

if (result.error) {
  console.error(`ECC installer package check failed to run npm: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(result.stderr.trim() || `npm view ${ECC_NPM_PACKAGE} failed`);
  process.exit(result.status ?? 1);
}

let bin: unknown;
try {
  bin = JSON.parse(result.stdout);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`npm view ${ECC_NPM_PACKAGE} bin did not return JSON: ${detail}`);
  process.exit(1);
}

if (
  typeof bin !== "object" ||
  bin === null ||
  typeof (bin as Record<string, unknown>)[ECC_NPM_BIN] !== "string"
) {
  console.error(`${ECC_NPM_PACKAGE} does not expose the required ${ECC_NPM_BIN} bin`);
  process.exit(1);
}

console.log(`${ECC_NPM_PACKAGE} exposes ${ECC_NPM_BIN}.`);
