#!/usr/bin/env node
/** Packed guidance-only ECC plugin boundary, runnable without a Catalog checkout. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginRoot = join(repo, "packages", "framework-ecc");
const removed = [
  "packages/framework-ecc/src/ecc/chrome-devtools-opt-out.cjs",
  "src/ecc/chrome-devtools-opt-out.cjs",
];
const checks = [];

function check(label, condition, detail = "") {
  checks.push({ label, ok: condition, detail });
  process.stdout.write(`${condition ? "PASS" : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}\n`);
}

function manifest(root) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function packFiles(root) {
  const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const result = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`npm pack --dry-run failed for ${root}: ${result.stderr || result.stdout}`);
  const [packed] = JSON.parse(result.stdout);
  if (!packed || !Array.isArray(packed.files)) throw new Error(`npm pack returned no files for ${root}`);
  return new Set(packed.files.map((file) => file.path));
}

try {
  const core = manifest(repo);
  const plugin = manifest(pluginRoot);
  const coreFiles = packFiles(repo);
  const pluginFiles = packFiles(pluginRoot);
  for (const [name, root, value] of [["Core", repo, core], ["ECC plugin", pluginRoot, plugin]]) {
    const missing = value.files.filter((entry) => !entry.startsWith("!") && !existsSync(join(root, entry)));
    check(`${name} files entries exist`, missing.length === 0, missing.join(", "));
  }
  check("Core bundles the ECC plugin manifest and dist", coreFiles.has("packages/framework-ecc/package.json") && coreFiles.has("packages/framework-ecc/dist/index.js"));
  check("ECC plugin pack contains its manifest and dist", pluginFiles.has("package.json") && pluginFiles.has("dist/index.js"));
  check("retired installer helper is not packed", removed.every((path) => !coreFiles.has(path) && !pluginFiles.has(path)));
  check("retired installer helper is absent from files lists", [core, plugin].every((value) => value.files.every((entry) => !entry.includes("chrome-devtools-opt-out"))));
  const bundle = readFileSync(join(pluginRoot, "dist", "index.js"), "utf8");
  check("packed plugin exports the ECC contract", /\baihFrameworkPluginV1\b/.test(bundle) && /cleanupVersion/.test(bundle));
  check("plugin exposes guidance and legacy MCP removal", bundle.includes("ecc mcp remove") && bundle.includes("ecc: guidance"));
  check("plugin excludes retired MCP Add and materialization writers", !bundle.includes("planExplicitEccMcpAdd") && !bundle.includes("applyEccMaterialization"));
  check("plugin retains receipt cleanup and status readers", bundle.includes("legacy ECC receipt cleanup") && bundle.includes("explicit-ecc-mcp:"));
} catch (error) {
  check("packed ECC plugin verification", false, error instanceof Error ? error.message : String(error));
}

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, passed: checks.length - failed.length, failed: failed.map((entry) => entry.label) })}\n`);
if (failed.length > 0) process.exitCode = 1;
