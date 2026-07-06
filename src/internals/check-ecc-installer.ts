import { spawnSync } from "node:child_process";
import { ECC_NPM_BINS, ECC_NPM_PACKAGE } from "../ecc/install.js";

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

if (typeof bin !== "object" || bin === null) {
  console.error(`${ECC_NPM_PACKAGE} bin metadata is not an object`);
  process.exit(1);
}

const binRecord = bin as Record<string, unknown>;
const missing = ECC_NPM_BINS.filter((name) => typeof binRecord[name] !== "string");
if (missing.length > 0) {
  console.error(`${ECC_NPM_PACKAGE} does not expose required bin(s): ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`${ECC_NPM_PACKAGE} exposes ${ECC_NPM_BINS.join(", ")}.`);
