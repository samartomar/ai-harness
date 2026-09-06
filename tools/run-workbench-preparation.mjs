import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(".aih-scratch/workbench-evidence");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run preparation through npm so npm_execpath is available");

const projects = [
  {
    name: "pure",
    args: ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.workbench-pure.config.ts", "--coverage"],
    budgetMs: 10000,
  },
  { name: "build", args: [npmCli, "run", "build"] },
];

const children = new Set();
let interruption;

function stopChildren(signal, external = false) {
  if (external) interruption ??= signal;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopChildren(signal, true));
}

function runProject(project) {
  return new Promise((complete) => {
    const started = performance.now();
    const child = spawn(process.execPath, project.args, {
      stdio: "inherit",
      windowsHide: true,
    });
    children.add(child);
    let settled = false;
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      children.delete(child);
      const result = {
        name: project.name,
        command: [process.execPath, ...project.args],
        code,
        signal,
        ...(project.budgetMs ? { budgetMs: project.budgetMs } : {}),
        ...(error ? { error: error.message } : {}),
        wallMs: performance.now() - started,
      };
      if (code !== 0 || signal || error) stopChildren("SIGTERM");
      complete(result);
    };
    child.once("error", (error) => finish(1, null, error));
    child.once("exit", (code, signal) => finish(code, signal));
  });
}

const results = await Promise.all(projects.map(runProject));
const pure = results.find((result) => result.name === "pure");
let failed = Boolean(interruption) || results.some((result) => result.code !== 0 || result.signal || result.error);
if (pure.wallMs >= pure.budgetMs) failed = true;

await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "preparation.json"), JSON.stringify({
  children: results,
  ...(interruption ? { interruption } : {}),
}, null, 2) + "\n");

if (pure.wallMs >= pure.budgetMs) {
  console.error("pure exceeded " + pure.budgetMs + " ms: " + pure.wallMs.toFixed(0));
}
if (failed) process.exitCode = 1;
