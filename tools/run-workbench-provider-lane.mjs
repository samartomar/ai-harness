import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  providerTestsFor,
  WORKBENCH_PROVIDER_IDS,
} from "../src/internals/workbench-provider-ownership.ts";

function requiredJsonArray(name) {
  const raw = process.env[name];
  if (raw === undefined) throw new Error(`${name} is missing`);
  const value = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) =>
        typeof entry !== "string" || !entry.startsWith("tests/") || !entry.endsWith(".test.ts"),
    )
  ) {
    throw new Error(`${name} must contain selected repository test paths`);
  }
  const sorted = [...new Set(value)].sort((left, right) => left.localeCompare(right));
  if (sorted.length !== value.length || JSON.stringify(sorted) !== JSON.stringify(value)) {
    throw new Error(`${name} must be sorted and unique`);
  }
  return sorted;
}

function requiredProviderIds() {
  const raw = process.env.AFFECTED_PROVIDERS_JSON;
  if (raw === undefined) throw new Error("AFFECTED_PROVIDERS_JSON is missing");
  const value = JSON.parse(raw);
  const known = new Set(WORKBENCH_PROVIDER_IDS);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !known.has(entry))
  ) {
    throw new Error("AFFECTED_PROVIDERS_JSON must contain known provider IDs");
  }
  const sorted = [...new Set(value)].sort((left, right) => left.localeCompare(right));
  if (sorted.length !== value.length || JSON.stringify(sorted) !== JSON.stringify(value)) {
    throw new Error("AFFECTED_PROVIDERS_JSON must be sorted and unique");
  }
  return sorted;
}

const providerTests = requiredJsonArray("PROVIDER_TESTS_JSON");
const providers = requiredProviderIds();
const expectedProviderTests = providerTestsFor(providers);
if (JSON.stringify(providerTests) !== JSON.stringify(expectedProviderTests)) {
  throw new Error("PROVIDER_TESTS_JSON does not match the reviewed provider ownership");
}
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this lane through npm so npm_execpath is available");
const evidenceDirectory = resolve(".aih-scratch/workbench-evidence");
await mkdir(evidenceDirectory, { recursive: true });
const receipt = { providers, providerTests, stages: [] };

async function run(name, args) {
  const started = performance.now();
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolveCode(exitCode ?? 1));
  });
  receipt.stages.push({
    name,
    args: [process.execPath, ...args],
    wallMs: performance.now() - started,
    code,
  });
  await writeFile(
    resolve(evidenceDirectory, "provider-lane.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  if (code !== 0) throw new Error(`${name} failed with exit ${code}`);
}

await run("provider-contracts", [
  resolve("node_modules/vitest/vitest.mjs"),
  "run",
  "--maxWorkers=2",
  "--testTimeout=15000",
  ...providerTests,
]);
await run("build", [npmCli, "run", "build"]);
await run("packed-artifact", [
  resolve("node_modules/@playwright/test/cli.js"),
  "test",
  "--config",
  "playwright.workbench.config.ts",
  "packed.spec.ts",
]);
