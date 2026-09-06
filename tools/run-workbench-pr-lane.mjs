import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, platform, release, totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { measureProcess } from "./workbench-process-metrics.mjs";

if (/max[-_]old[-_]space[-_]size/u.test(process.env.NODE_OPTIONS ?? ""))
  throw new Error("Workbench acceptance runs without a heap override");
const directory = resolve(".aih-scratch/workbench-evidence");
await mkdir(directory, { recursive: true });
const started = performance.now();
const receipt = {
  node: process.version, platform: platform(), release: release(),
  processors: cpus().length, totalMemoryBytes: totalmem(),
  runner: { os: process.env.RUNNER_OS, image: process.env.ImageOS, version: process.env.ImageVersion },
  nodeOptions: process.env.NODE_OPTIONS ?? "", heapLimitBytes: getHeapStatistics().heap_size_limit,
  chromium: JSON.parse(await readFile("node_modules/playwright-core/browsers.json", "utf8")).browsers.find(browser => browser.name === "chromium"),
  sampling: { metric: "summed process-tree resident bytes", intervalMs: 250, includesOsQueryOverhead: true },
  stages: [],
};
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this lane with npm run test:workbench:pr");
for (const [name, args, budgetMs] of [
  ["pure", ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.workbench-pure.config.ts", "--coverage"], 10000],
  ["build", [npmCli, "run", "build"], undefined],
  ["parallel-acceptance-projects", ["tools/run-workbench-acceptance-projects.mjs"], undefined],
]) {
  const metrics = await measureProcess(process.execPath, args);
  receipt.stages.push({ name, command: [process.execPath, ...args], ...metrics, budgetMs });
  receipt.wallMs = performance.now() - started;
  receipt.peakResidentBytes = Math.max(...receipt.stages.map(stage => stage.peakResidentBytes));
  await writeFile(resolve(directory, "pr-lane.json"), JSON.stringify(receipt, null, 2) + "\n");
  if (metrics.code !== 0) throw new Error(name + " failed with exit " + metrics.code);
  if (metrics.peakResidentBytes <= 0) throw new Error(name + " has no usable resident-memory sample");
  if (budgetMs && metrics.wallMs >= budgetMs)
    throw new Error(name + " exceeded " + budgetMs + " ms: " + metrics.wallMs.toFixed(0));
}
if (receipt.wallMs >= 60000) throw new Error("Complete Workbench lane exceeded 60000 ms: " + receipt.wallMs.toFixed(0));
console.log(JSON.stringify(receipt, null, 2));
