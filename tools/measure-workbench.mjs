import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { resolve } from "node:path";
import { measureProcess } from "./workbench-process-metrics.mjs";

const delimiter = process.argv.indexOf("--");
if (delimiter < 0 || !process.argv[delimiter + 1]) {
  throw new Error("Usage: node tools/measure-workbench.mjs <receipt.json> -- <Node entry> [args...]");
}
const receiptPath = resolve(process.argv[2]);
const entry = resolve(process.argv[delimiter + 1]);
const nodeOptions = process.env.NODE_OPTIONS ?? "";
if (/max[-_]old[-_]space[-_]size/u.test(nodeOptions)) {
  throw new Error("Performance evidence must not inherit a heap enlargement");
}
const result = await measureProcess(process.execPath, [entry, ...process.argv.slice(delimiter + 2)]);
const receipt = {
  schemaVersion: "workbench-performance/v1",
  environment: {
    node: process.version, platform: process.platform, architecture: process.arch,
    processors: availableParallelism(), totalMemoryBytes: totalmem(), nodeOptions,
  },
  command: [process.execPath, entry, ...process.argv.slice(delimiter + 2)],
  sampling: { metric: "summed resident bytes of process tree", intervalMs: 250,
    includesOsQueryOverhead: true, interpretation: "sampled peak; not an allocation limit" },
  ...result,
};
await mkdir(resolve(receiptPath, ".."), { recursive: true });
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt, null, 2));
process.exitCode = result.code ?? 1;
