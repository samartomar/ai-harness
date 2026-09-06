import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// The generated package is immutable during these independent test projects.
// One parent process lets the lane measure their combined resident memory.
const projects = [
  ["contracts-and-retained-forms", ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.workbench-retained.config.ts", "--coverage"]],
  ["chromium-and-packed", ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.workbench.config.ts"]],
];
const children = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  for (const child of children) child.kill(signal);
  process.exitCode = 1;
});
const results = await Promise.all(projects.map(([name, args]) => new Promise((complete) => {
  const started = performance.now();
  const child = spawn(process.execPath, args, { stdio: "inherit", windowsHide: true });
  children.add(child);
  let settled = false;
  const finish = (code, signal, error) => {
    if (settled) return;
    settled = true;
    children.delete(child);
    complete({ name, command: [process.execPath, ...args], code, signal, ...(error ? { error: error.message } : {}), wallMs: performance.now() - started });
  };
  child.once("error", error => finish(1, null, error));
  child.once("exit", (code, signal) => finish(code, signal));
})));
const directory = resolve(".aih-scratch/workbench-evidence");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "acceptance-projects.json"), JSON.stringify(results, null, 2) + "\n");
if (results.some(result => result.code !== 0)) process.exitCode = 1;
