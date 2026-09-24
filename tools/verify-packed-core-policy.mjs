#!/usr/bin/env node
/** Installed Core smoke: retained policy validation, retired UI, and package topology. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { packedConsumerInstallFiles, packedNpmChild } from "./lib/packed-consumer.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--evidence-dir" || !args[1])) {
  throw new Error("usage: verify-packed-core-policy [--evidence-dir <existing-directory>]");
}
const evidenceDir = args.length === 2 ? realpathSync(args[1]) : undefined;
if (evidenceDir && !statSync(evidenceDir).isDirectory()) {
  throw new Error("evidence-dir must be an existing directory");
}
const npmCli = process.env.npm_execpath;
if (typeof npmCli !== "string" || !npmCli.endsWith("npm-cli.js") || !existsSync(npmCli)) {
  throw new Error("Run through npm: the installed npm CLI path is required");
}

const temp = mkdtempSync(join(tmpdir(), "aih-packed-core-policy-"));
const consumer = join(temp, "consumer");
const fixture = join(temp, "fixture");
const home = join(temp, "home");
const emptyUserConfig = join(temp, "empty.npmrc");
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    !/^npm_config_(?:allow[-_]scripts|userconfig)$/i.test(key) &&
    !/^AIH(?:_|$)/i.test(key)),
);
childEnv.npm_config_userconfig = emptyUserConfig;
childEnv.npm_config_ignore_scripts = "true";
childEnv.npm_config_audit = "false";
childEnv.npm_config_fund = "false";
childEnv.HOME = home;
childEnv.USERPROFILE = home;
childEnv.APPDATA = join(home, "AppData", "Roaming");
childEnv.LOCALAPPDATA = join(home, "AppData", "Local");
childEnv.XDG_CONFIG_HOME = join(home, ".config");
childEnv.XDG_CACHE_HOME = join(home, ".cache");
childEnv.XDG_DATA_HOME = join(home, ".local", "share");
childEnv.XDG_STATE_HOME = join(home, ".local", "state");
if (process.platform === "win32") {
  childEnv.HOMEDRIVE = home.slice(0, 2);
  childEnv.HOMEPATH = home.slice(2);
}

function run(args, cwd, env = childEnv) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${(result.stderr || result.stdout).slice(-1800)}`);
  }
  return result.stdout;
}

function absent(path, label) {
  if (existsSync(path)) throw new Error(`${label} unexpectedly present: ${path}`);
}

try {
  mkdirSync(consumer);
  mkdirSync(fixture);
  for (const directory of [home, childEnv.APPDATA, childEnv.LOCALAPPDATA,
    childEnv.XDG_CONFIG_HOME, childEnv.XDG_CACHE_HOME, childEnv.XDG_DATA_HOME,
    childEnv.XDG_STATE_HOME]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(emptyUserConfig, "");
  writeFileSync(
    join(fixture, "aih-org-policy.json"),
    `${JSON.stringify({ schemaVersion: 2, minimumPosture: "vibe", references: { repoContract: "ai-coding/project.json" } })}\n`,
  );
  const packed = JSON.parse(requireSuccess(
    run([npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", temp], repo),
    "Core pack",
  ));
  if (!Array.isArray(packed) || packed.length !== 1) throw new Error("Core pack manifest invalid");
  const tarball = join(temp, packed[0].filename);
  const archiveSha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  const installFiles = packedConsumerInstallFiles(packed[0]);
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify(installFiles.manifest, null, 2)}\n`);
  writeFileSync(join(consumer, "package-lock.json"), `${JSON.stringify(installFiles.lock, null, 2)}\n`);
  const install = packedNpmChild(
    [npmCli, "ci", "--no-audit", "--no-fund", "--ignore-scripts", "--omit=optional"],
    emptyUserConfig,
    childEnv,
  );
  requireSuccess(
    run(install.args, consumer, install.environment),
    "Core consumer install",
  );
  const installed = join(consumer, "node_modules", "@aihq", "core");
  const cli = join(installed, "dist", "cli.js");
  if (!existsSync(cli)) throw new Error("installed Core CLI missing");
  for (const relative of [
    "dist/default-catalog-preassembly.generated.cjs",
    "dist/packaged-source-data-data.json",
    "dist/catalog-qualification-data.json",
    "dist/packaged-collection-evidence-data.json",
    "dist/bundle.generated.cjs",
    "dist/org-policy/ui-server.d.ts",
    "dist/org-policy/studio-model.d.ts",
    "dist/org-policy/studio-template.d.ts",
  ]) absent(join(installed, relative), "retired browser artifact");
  const version = requireSuccess(run([cli, "--version"], fixture), "installed version").trim();
  if (version !== packed[0].version) throw new Error("installed Core version differs from package manifest");
  requireSuccess(run([cli, "policy", "validate"], fixture), "installed policy validation");
  writeFileSync(join(fixture, "aih-org-policy.json"), "{\n");
  const malformed = run([cli, "policy", "validate"], fixture);
  if (malformed.status === 0 || !/invalid|parse|json|policy/i.test(`${malformed.stdout}\n${malformed.stderr}`)) {
    throw new Error("installed policy validation accepted malformed policy");
  }
  for (const args of [["--ui"], ["policy", "generate"]]) {
    const refusal = run([cli, ...args], fixture);
    if (refusal.status === 0 || !/unknown (option|command)/i.test(`${refusal.stdout}\n${refusal.stderr}`)) {
      throw new Error(`retired CLI route was not rejected: ${args.join(" ")}`);
    }
  }
  const receipt = { ok: true, version, archiveSha256, archiveRetained: Boolean(evidenceDir),
    installedPackageSource: "disposable consumer", checks: 9 };
  if (evidenceDir) {
    const evidenceArchive = join(evidenceDir, `core-policy-${archiveSha256}.tgz`);
    const evidenceReceipt = join(evidenceDir, `core-policy-${archiveSha256}.json`);
    copyFileSync(tarball, evidenceArchive, constants.COPYFILE_EXCL);
    writeFileSync(evidenceReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  const resolvedTemp = realpathSync(temp);
  const resolvedParent = realpathSync(tmpdir());
  if (!resolvedTemp.startsWith(`${resolvedParent}${sep}`) ||
      !resolvedTemp.startsWith(`${resolvedParent}${sep}aih-packed-core-policy-`)) {
    throw new Error(`refusing to remove unexpected temp target: ${resolvedTemp}`);
  }
  rmSync(resolvedTemp, { recursive: true, force: true });
}
