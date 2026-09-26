import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function snapshot(root: string): string[] {
  const entries: string[] = [];
  function walk(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { entries.push(`${name}/`); walk(path, name); }
      else if (entry.isFile()) entries.push(`${name}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      else entries.push(`${name}:other`);
    }
  }
  walk(root, "");
  return entries.sort();
}

it.each(["init", "policy project"])("%s --ecc-path refuses without a run log or any filesystem write", (command) => {
  const root = mkdtempSync(join(tmpdir(), "aih-ecc-retired-cli-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  writeFileSync(join(root, ".aih-config.json"), JSON.stringify({
    schemaVersion: 1, contextDir: "ai-coding", targets: ["claude"],
  }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TSX_DISABLE_CACHE: "true" };
  for (const key of Object.keys(env)) if (key === "AIH" || key.startsWith("AIH_")) delete env[key];
  const before = snapshot(root);
  const child = spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
    ...command.split(" "), "--ecc-path", join(root, "ecc-source"),
  ], { cwd: root, env, encoding: "utf8", timeout: 45_000 });
  expect(child.status, child.stderr).toBe(1);
  expect(`${child.stdout}\n${child.stderr}`).toContain("was retired");
  expect(snapshot(root)).toEqual(before);
}, 60_000);
