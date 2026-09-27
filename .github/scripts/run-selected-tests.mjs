import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

if (process.env.FULL_SUITE === "true") {
  console.log("Classifier selected the complete suite; authoritative matrix owns it.");
  process.exit(0);
}

const tests = JSON.parse(process.env.SELECTED_TESTS_JSON ?? "null");
if (!Array.isArray(tests) || tests.some((value) => typeof value !== "string")) {
  throw new Error("classifier emitted an invalid selected-test list");
}
if (tests.length === 0) {
  console.log("No Vitest file selected; static and documentation gates remain authoritative.");
  process.exit(0);
}

const providerTests = JSON.parse(process.env.PROVIDER_TESTS_JSON ?? "[]");
if (!Array.isArray(providerTests) || providerTests.some((value) => typeof value !== "string")) {
  throw new Error("classifier emitted an invalid provider-test list");
}
if (providerTests.some((path) => !tests.includes(path))) {
  throw new Error("provider receipt is not a subset of the selected tests");
}

const lane = process.env.TEST_LANE;
if (!["docs", "core", "workbench", "both"].includes(lane)) {
  throw new Error("classifier emitted an invalid selected test lane");
}
const executable = process.execPath;
const vitestEntrypoint = resolve("node_modules/vitest/vitest.mjs");
// Match the authoritative Ubuntu verification envelope. Large selected suites
// otherwise overcommit the hosted runner and can push filesystem-heavy tests
// past Vitest's stricter default timeout even when the full gate is green.
const result = spawnSync(
  executable,
  [vitestEntrypoint, "run", "--maxWorkers=2", "--testTimeout=15000", ...tests],
  {
    encoding: "utf8",
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
