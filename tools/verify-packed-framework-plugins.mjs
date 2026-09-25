#!/usr/bin/env node
/**
 * Packed-consumer proof of the Core / framework plugin boundary (C3).
 *
 * Builds @aihq/core and @aihq/framework-superpowers from the given checkout
 * into staging directories OUTSIDE the checkout, packs both, and installs the
 * tarballs into a disposable consumer (always `--ignore-scripts`, an empty npm
 * user config, never `npm link`). It then checks:
 *
 *   Tarballs: Core carries no plugin code (no `packages/`, no plugin-only
 *     identifiers in dist, each plugin imported only dynamically from one
 *     module) and ships `dist/framework-host.js` with its declarations; the
 *     plugin carries only its dist, which imports Core only through
 *     `@aihq/core/framework-host` and Node built-ins.
 *   Core + plugin, no Catalog: `aih superpowers` refuses with
 *     `catalog-package-unavailable`; the descriptor is Catalog data.
 *   Core + plugin + the pinned Catalog 0.3.0: `aih superpowers <fixture>` exits 0 with the
 *     exact-pinned acquisition preview, loaded from the INSTALLED plugin, whose
 *     `@aihq/core/framework-host` resolved to the INSTALLED Core; `aih init`
 *     (dry run) runs the same evidence-gated preview.
 *   Installed plugin damaged (package.json version changed): the command
 *     refuses with `framework-plugin-incompatible`, never treating it as absent.
 *   Plugin uninstalled: `aih superpowers` refuses with
 *     `framework-plugin-unavailable` naming the install command and without a
 *     stack trace; `aih init` (dry run) reports the Superpowers phase as refused
 *     with that reason and still exits 0.
 *
 * The staged Core manifest carries `--core-version` (default 0.7.0, the
 * candidate the plugin's peer range names); the checkout is never modified.
 *
 * usage:
 *   node tools/verify-packed-framework-plugins.mjs --stage-from <core-repo> [--core-version 0.7.0] [--work <dir>] [--keep] [--report <file>]
 *
 * Prints one JSON summary line last; exits non-zero if any check fails.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const PIN = "5bf4e78011075bcfc0dc295f0724994cd123ee71";
const PLUGIN = "@aihq/framework-superpowers";
/** Identifiers that exist only in the plugin's sources, never in Core's. */
const PLUGIN_ONLY_MARKERS = [
  "superpowers descriptor refused",
  "readSuperpowersHookInventory",
  "readSuperpowersDescriptor",
  "superpowersActionsForCli",
];

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}\n`);
}

function run(command, args, cwd, extra = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    ...extra,
    env: { ...process.env, ...(extra.env ?? {}) },
  });
  if (result.error) throw new Error(`${command} ${args.join(" ")}: ${result.error.message}`);
  return result;
}

function must(result, label) {
  if (result.status !== 0)
    throw new Error(`${label} failed (${result.status}):\n${(result.stderr || result.stdout).slice(-3000)}`);
  return result.stdout;
}

function insideGitRepository(path) {
  return run("git", ["-C", path, "rev-parse", "--show-toplevel"], path).status === 0;
}

function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")];
  const cli = candidates.find((path) => path && /npm-cli\.js$/.test(path) && existsSync(path));
  if (!cli) throw new Error("npm-cli.js not found");
  return cli;
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Regular files of a gzip'd npm tarball, by archive path (ustar headers). */
function readPackedFiles(tarball) {
  const archive = gunzipSync(readFileSync(tarball));
  const files = new Map();
  const field = (header, start, length) =>
    header.subarray(start, start + length).toString("utf8").replace(/\u0000.*$/s, "");
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = field(header, 345, 155);
    const name = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
    if (type === "0" || type === "\u0000") files.set(name, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const stageFrom = option("--stage-from");
if (!stageFrom) {
  process.stderr.write(
    "usage: verify-packed-framework-plugins.mjs --stage-from <core-repo> [--core-version 0.7.0] [--work <dir>] [--keep] [--report <file>]\n",
  );
  process.exit(2);
}
const repo = resolve(stageFrom);
const coreVersion = option("--core-version") ?? "0.7.0";
const keep = process.argv.includes("--keep");
const work = realpathSync(
  option("--work") !== undefined
    ? (mkdirSync(resolve(option("--work")), { recursive: true }), resolve(option("--work")))
    : mkdtempSync(join(tmpdir(), "aih-packed-framework-plugins-")),
);
if (insideGitRepository(work)) throw new Error(`work directory ${work} is inside a git repository`);
const npm = npmCli();
const emptyUserConfig = join(work, "empty.npmrc");
writeFileSync(emptyUserConfig, "");
const isolatedNpmEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^npm_config_/iu.test(name)),
);
const npmRun = (args, cwd) =>
  spawnSync(process.execPath, [npm, ...args, "--userconfig", emptyUserConfig], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    env: { ...isolatedNpmEnv, npm_config_userconfig: emptyUserConfig, npm_execpath: npm },
  });
// Build tools resolve from the checkout's own dependency tree (a worktree resolves
// them from an ancestor node_modules).
const requireFromRepo = createRequire(join(repo, "package.json"));
const tsupCli = join(dirname(requireFromRepo.resolve("tsup/package.json")), "dist", "cli-default.js");
const tscCli = join(dirname(requireFromRepo.resolve("typescript/package.json")), "bin", "tsc");

const summary = { ok: false, work, coreVersion };
try {
  // ---- stage and pack Core ---------------------------------------------------
  const coreStage = join(work, "stage-core");
  mkdirSync(coreStage, { recursive: true });
  must(run(process.execPath, [tsupCli, "--out-dir", join(coreStage, "dist")], repo), "Core tsup build");
  must(
    run(process.execPath, [tscCli, "-p", "tsconfig.dts.json", "--outDir", join(coreStage, "dist")], repo),
    "Core declaration emit",
  );
  const coreManifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  for (const entry of coreManifest.files) {
    if (entry.startsWith("!") || entry === "dist") continue;
    const source = join(repo, entry);
    if (!existsSync(source)) continue;
    mkdirSync(dirname(join(coreStage, entry)), { recursive: true });
    cpSync(source, join(coreStage, entry), { recursive: true });
  }
  writeFileSync(join(coreStage, "package.json"), `${JSON.stringify({ ...coreManifest, version: coreVersion }, null, 2)}\n`);
  const corePacked = JSON.parse(
    must(npmRun(["pack", "--json", "--ignore-scripts", "--pack-destination", work], coreStage), "Core npm pack"),
  );
  const coreTarball = join(work, corePacked[0].filename);

  // ---- stage and pack the Superpowers plugin -----------------------------------
  const pluginSource = join(repo, "packages", "framework-superpowers");
  const pluginStage = join(work, "stage-framework-superpowers");
  mkdirSync(pluginStage, { recursive: true });
  must(run(process.execPath, [tsupCli, "--out-dir", join(pluginStage, "dist")], pluginSource), "plugin tsup build");
  for (const file of ["package.json", "README.md", "LICENSE"]) cpSync(join(pluginSource, file), join(pluginStage, file));
  const pluginPacked = JSON.parse(
    must(npmRun(["pack", "--json", "--ignore-scripts", "--pack-destination", work], pluginStage), "plugin npm pack"),
  );
  const pluginTarball = join(work, pluginPacked[0].filename);
  Object.assign(summary, {
    coreTarball,
    coreSha256: sha256(coreTarball),
    pluginTarball,
    pluginSha256: sha256(pluginTarball),
  });
  process.stdout.write(`core tarball ${coreTarball} sha256 ${summary.coreSha256}\n`);
  process.stdout.write(`plugin tarball ${pluginTarball} sha256 ${summary.pluginSha256}\n`);

  // ---- tarball contents ---------------------------------------------------------
  const coreFiles = readPackedFiles(coreTarball);
  const corePaths = [...coreFiles.keys()];
  check("Core tarball has no packages/ entry", corePaths.every((path) => !path.startsWith("package/packages/")));
  check(
    "Core tarball has no framework plugin package file",
    corePaths.every((path) => !/framework-(superpowers|ecc)/.test(path)),
    corePaths.filter((path) => /framework-(superpowers|ecc)/.test(path)).join(", "),
  );
  const coreJs = [...coreFiles]
    .filter(([path]) => /^package\/dist\/[^/]+\.js$/.test(path))
    .map(([path, bytes]) => [path.slice("package/dist/".length), bytes.toString("utf8")]);
  const markerHits = coreJs.flatMap(([file, body]) =>
    PLUGIN_ONLY_MARKERS.filter((marker) => body.includes(marker)).map((marker) => `${file}: ${marker}`),
  );
  check("Core dist carries no plugin-only identifier", markerHits.length === 0, markerHits.join("; "));
  for (const name of ["@aihq/framework-superpowers", "@aihq/framework-ecc"]) {
    const escaped = name.replace(/[/.]/g, (c) => `\\${c}`);
    const staticHits = coreJs.filter(([, body]) => new RegExp(`from\\s*"${escaped}"|import\\s*"${escaped}"`).test(body));
    const dynamicHits = coreJs.filter(([, body]) => new RegExp(`import\\s*\\(\\s*"${escaped}"\\s*\\)`).test(body));
    check(
      `Core dist imports ${name} only dynamically, from one module`,
      staticHits.length === 0 && dynamicHits.length === 1,
      `static: ${staticHits.map(([f]) => f).join(",") || "none"}; dynamic: ${dynamicHits.map(([f]) => f).join(",") || "none"}`,
    );
  }
  check(
    "Core tarball ships dist/framework-host.js and its declarations",
    coreFiles.has("package/dist/framework-host.js") && coreFiles.has("package/dist/framework-host/index.d.ts"),
  );
  const packedCoreManifest = JSON.parse(coreFiles.get("package/package.json").toString("utf8"));
  check(
    "Core manifest exports ./framework-host and peers the plugins optionally",
    packedCoreManifest.exports?.["./framework-host"]?.import === "./dist/framework-host.js" &&
      packedCoreManifest.peerDependenciesMeta?.[PLUGIN]?.optional === true &&
      packedCoreManifest.dependencies?.[PLUGIN] === undefined,
  );
  const pluginFiles = readPackedFiles(pluginTarball);
  const pluginPaths = [...pluginFiles.keys()].sort();
  check(
    "plugin tarball carries only its dist, manifest, README and LICENSE",
    pluginPaths.join(",") === ["package/LICENSE", "package/README.md", "package/dist/index.js", "package/package.json"].join(","),
    pluginPaths.join(", "),
  );
  const pluginJs = pluginFiles.get("package/dist/index.js").toString("utf8");
  const pluginImports = [...pluginJs.matchAll(/(?:from\s*|import\s*\(?\s*)"([^"]+)"/g)].map((match) => match[1]);
  check(
    "plugin dist imports only @aihq/core/framework-host and node:*",
    pluginImports.length > 0 && pluginImports.every((specifier) => specifier === "@aihq/core/framework-host" || specifier.startsWith("node:")),
    [...new Set(pluginImports)].join(", "),
  );

  // ---- consumer: Core + plugin ----------------------------------------------------
  const consumer = join(work, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "framework-plugin-consumer", private: true, type: "module" }));
  must(
    npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", coreTarball, pluginTarball], consumer),
    "Core + plugin install",
  );
  const installedPlugin = join(consumer, "node_modules", "@aihq", "framework-superpowers");
  const installedCore = join(consumer, "node_modules", "@aihq", "core");
  check(
    "consumer has Core and the plugin installed side by side",
    existsSync(join(installedPlugin, "package.json")) && existsSync(join(installedCore, "package.json")),
  );
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  const cliEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(AIH_[A-Z_]+|npm_config_.*)$/iu.test(name),
      ),
    ),
    HOME: home,
    USERPROFILE: home,
  };
  const traceLog = join(work, "module-trace.log");
  const trace = join(work, "module-trace.mjs");
  writeFileSync(
    trace,
    [
      'import { appendFileSync } from "node:fs";',
      'import { registerHooks } from "node:module";',
      "registerHooks({",
      "  resolve(specifier, context, nextResolve) {",
      "    const resolved = nextResolve(specifier, context);",
      `    if (/@aihq[\\\\/](framework-superpowers|core)[\\\\/]/.test(resolved.url)) appendFileSync(${JSON.stringify(traceLog)}, specifier + " -> " + resolved.url + "\\n");`,
      "    return resolved;",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  const aih = (args, extraNodeArgs = []) => {
    const result = spawnSync(process.execPath, [...extraNodeArgs, join(installedCore, "dist", "cli.js"), ...args], {
      cwd: work,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      env: cliEnv,
    });
    if (result.error) throw new Error(`aih ${args.join(" ")}: ${result.error.message}`);
    return result;
  };
  const json = (result) => {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
  };
  const noStack = (result) => !/\n\s+at .+\(.+:\d+:\d+\)/.test(`${result.stdout}\n${result.stderr}`);
  const fixture = join(work, "fixture");
  mkdirSync(fixture, { recursive: true });

  // ---- plugin installed, Catalog absent: the descriptor is Catalog data (C1) ------
  const withoutCatalog = aih(["superpowers", fixture, "--json", "--no-log"]);
  const withoutCatalogError = json(withoutCatalog)?.error;
  summary.withoutCatalog = { exit: withoutCatalog.status, error: withoutCatalogError };
  check(
    "without Catalog, aih superpowers refuses with catalog-package-unavailable and no embedded fallback",
    withoutCatalog.status === 1 && withoutCatalogError?.message?.includes("catalog-package-unavailable") === true,
    withoutCatalogError?.message?.slice(0, 300) ?? withoutCatalog.stdout.slice(0, 300),
  );

  // The real Catalog 0.3.0 this repository pins carries the Superpowers descriptor
  // and the plugin identity record the loader checks.
  const pinnedCatalog = join(repo, "tests", "fixtures", "packages", "aihq-catalog-0.3.0-c8e2c03.tgz");
  must(
    npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", pinnedCatalog], consumer),
    "Catalog 0.3.0 install",
  );
  const withPlugin = aih(["superpowers", fixture, "--json", "--no-log"], ["--import", pathToFileURL(trace).href]);
  const withPluginResult = json(withPlugin);
  summary.withPlugin = {
    exit: withPlugin.status,
    capability: withPluginResult?.capability,
    execs: withPluginResult?.execs?.map((entry) => ({ describe: entry.describe, ran: entry.ran })),
  };
  check(
    "aih superpowers <fixture> succeeds through the installed plugin",
    withPlugin.status === 0 &&
      withPluginResult?.capability === "superpowers: acquire exact baseline source" &&
      withPluginResult.execs?.length === 1 &&
      withPluginResult.execs[0].ran === false &&
      JSON.stringify(withPluginResult).includes(PIN),
    `exit ${withPlugin.status}; ${withPlugin.stderr.trim().slice(0, 300)}`,
  );
  const traced = existsSync(traceLog) ? [...new Set(readFileSync(traceLog, "utf8").trim().split(/\r?\n/))] : [];
  summary.moduleTrace = traced;
  const pluginUrl = pathToFileURL(realpathSync(installedPlugin)).href.toLowerCase();
  const coreUrl = pathToFileURL(realpathSync(installedCore)).href.toLowerCase();
  check(
    "the INSTALLED plugin was loaded",
    traced.some((line) => line.startsWith(`${PLUGIN} -> `) && line.toLowerCase().includes(`${pluginUrl}/dist/index.js`)),
    traced.join(" | ") || "<nothing traced>",
  );
  check(
    "the plugin's @aihq/core/framework-host resolved to the INSTALLED Core",
    traced.some(
      (line) =>
        line.startsWith("@aihq/core/framework-host -> ") &&
        line.toLowerCase().includes(`${coreUrl}/dist/framework-host.js`),
    ),
  );
  const initFixture = join(work, "fixture-init");
  mkdirSync(initFixture, { recursive: true });
  const initWithPlugin = aih(["init", initFixture, "--json", "--no-log"]);
  const initWithPluginResult = json(initWithPlugin);
  check(
    "aih init (dry run) runs the plugin's evidence-gated preview",
    initWithPlugin.status === 0 &&
      (initWithPluginResult?.execs ?? []).some(
        (entry) => entry.describe.includes(`obra/Superpowers@${PIN}`) && entry.ran === false,
      ),
    `exit ${initWithPlugin.status}; ${initWithPlugin.stderr.trim().slice(0, 300)}`,
  );

  // ---- installed plugin damaged: incompatible, never absent -----------------------
  const pluginManifestPath = join(installedPlugin, "package.json");
  const pluginManifestBytes = readFileSync(pluginManifestPath);
  writeFileSync(pluginManifestPath, `${JSON.stringify({ ...JSON.parse(pluginManifestBytes.toString("utf8")), version: "0.1.1" }, null, 2)}\n`);
  const damaged = aih(["superpowers", fixture, "--json", "--no-log"]);
  const damagedError = json(damaged)?.error;
  summary.damaged = { exit: damaged.status, error: damagedError };
  check(
    "a damaged installed plugin refuses as framework-plugin-incompatible",
    damaged.status === 1 &&
      damagedError?.code === "AIH_FRAMEWORK_PLUGIN" &&
      typeof damagedError.message === "string" &&
      damagedError.message.startsWith("framework-plugin-incompatible: "),
    damagedError?.message?.slice(0, 300) ?? damaged.stdout.slice(0, 300),
  );
  writeFileSync(pluginManifestPath, pluginManifestBytes);

  // ---- Catalog installed: the plugin must equal Catalog's identity record ----------
  // The pinned real Catalog 0.3.0 (its identity record, then a rewritten record),
  // then the real 0.2.0 tarball, which does not publish plugin identities.
  const identities = (superpowersVersion) => ({
    format: "aih-catalog-framework-plugins",
    version: 1,
    entries: [
      {
        frameworkId: "ecc",
        packageName: "@aihq/framework-ecc",
        version: "0.1.0",
        contractVersion: 1,
        upstream: { repository: "affaan-m/ECC", commit: "5064474d4d762dc9640234a41617cccb79185cec" },
        supportedCore: ">=0.7.0 <0.8.0",
        supportedHosts: ["claude", "codex", "cursor", "kiro", "kimi", "opencode"],
        status: "candidate",
      },
      {
        frameworkId: "superpowers",
        packageName: PLUGIN,
        version: superpowersVersion,
        contractVersion: 1,
        upstream: { repository: "obra/Superpowers", commit: PIN },
        supportedCore: ">=0.7.0 <0.8.0",
        supportedHosts: ["antigravity", "claude", "codex", "copilot", "cursor", "gemini", "kiro", "kimi", "opencode", "windsurf", "zed"],
        status: "candidate",
      },
    ],
  });
  const matched = aih(["superpowers", fixture, "--json", "--no-log"]);
  check(
    "with Catalog's matching identity record installed, aih superpowers succeeds",
    matched.status === 0 && json(matched)?.capability === "superpowers: acquire exact baseline source",
    `exit ${matched.status}; ${(json(matched)?.error?.message ?? matched.stderr).slice(0, 300)}`,
  );
  const installedIdentities = join(consumer, "node_modules", "@aihq", "catalog", "defaults", "catalog-framework-plugins-v1.json");
  writeFileSync(installedIdentities, `${JSON.stringify(identities("0.1.9"))}\n`);
  const mismatched = aih(["superpowers", fixture, "--json", "--no-log"]);
  const mismatchedError = json(mismatched)?.error;
  summary.catalogMismatch = { exit: mismatched.status, error: mismatchedError };
  check(
    "a plugin version that differs from Catalog's identity record refuses as incompatible",
    mismatched.status === 1 &&
      mismatchedError?.message?.startsWith("framework-plugin-incompatible: ") === true &&
      mismatchedError.message.includes("does not equal @aihq/catalog 0.3.0's identity record @aihq/framework-superpowers 0.1.9"),
    mismatchedError?.message?.slice(0, 300) ?? mismatched.stdout.slice(0, 300),
  );
  const realCatalog = join(repo, "tests", "fixtures", "packages", "aihq-catalog-0.2.0-517e43d.tgz");
  if (existsSync(realCatalog)) {
    must(
      npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", realCatalog], consumer),
      "Catalog 0.2.0 install",
    );
    const oldCatalog = aih(["superpowers", fixture, "--json", "--no-log"]);
    const oldCatalogError = json(oldCatalog)?.error;
    summary.catalogWithoutIdentities = { exit: oldCatalog.status, error: oldCatalogError };
    check(
      "a Catalog without plugin identities (0.2.0) is incompatible, never treated as absent",
      oldCatalog.status === 1 &&
        oldCatalogError?.message?.startsWith("framework-plugin-incompatible: ") === true &&
        oldCatalogError.message.includes("catalog-package-incompatible"),
      oldCatalogError?.message?.slice(0, 300) ?? oldCatalog.stdout.slice(0, 300),
    );
  } else {
    check("the repository's Catalog 0.2.0 fixture tarball exists", false, realCatalog);
  }
  must(npmRun(["uninstall", "--ignore-scripts", "--no-audit", "--no-fund", "@aihq/catalog"], consumer), "Catalog uninstall");

  // ---- plugin uninstalled: explicit refusal ---------------------------------------
  must(npmRun(["uninstall", "--ignore-scripts", "--no-audit", "--no-fund", PLUGIN], consumer), "plugin uninstall");
  check("the plugin is uninstalled", !existsSync(installedPlugin));
  const without = aih(["superpowers", fixture, "--json", "--no-log"]);
  const withoutError = json(without)?.error;
  summary.withoutPlugin = { exit: without.status, error: withoutError };
  check(
    "aih superpowers refuses with framework-plugin-unavailable and names the install command",
    without.status === 1 &&
      withoutError?.code === "AIH_FRAMEWORK_PLUGIN" &&
      typeof withoutError.message === "string" &&
      withoutError.message.startsWith("framework-plugin-unavailable: ") &&
      withoutError.message.includes(`npm install -g @aihq/core ${PLUGIN}`),
    withoutError?.message?.slice(0, 300) ?? without.stdout.slice(0, 300),
  );
  const withoutText = aih(["superpowers", fixture, "--no-log"]);
  check(
    "the text-mode refusal carries no stack trace",
    withoutText.status === 1 && withoutText.stdout.includes("error [AIH_FRAMEWORK_PLUGIN]: framework-plugin-unavailable") && noStack(withoutText),
    withoutText.stdout.trim().slice(0, 300),
  );
  const initFixtureWithout = join(work, "fixture-init-without-plugin");
  mkdirSync(initFixtureWithout, { recursive: true });
  const initWithout = aih(["init", initFixtureWithout, "--json", "--no-log"]);
  const initWithoutResult = json(initWithout);
  const refusedCheck = initWithoutResult?.report?.checks?.find((entry) => entry.code === "framework-plugin.unavailable");
  summary.initWithoutPlugin = { exit: initWithout.status, check: refusedCheck };
  check(
    "aih init (dry run) reports the Superpowers phase as refused with its reason and still succeeds",
    initWithout.status === 0 &&
      (initWithoutResult?.docs ?? []).some(
        (entry) => entry.describe === "init: superpowers — refused (framework-plugin-unavailable)",
      ) &&
      refusedCheck?.verdict === "skip",
    `exit ${initWithout.status}; ${initWithout.stderr.trim().slice(0, 300)}`,
  );

  const failed = results.filter((entry) => !entry.ok);
  summary.ok = failed.length === 0;
  summary.checks = results;
  summary.failed = failed.map((entry) => entry.name);
  process.exitCode = summary.ok ? 0 : 1;
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  summary.checks = results;
  process.exitCode = 1;
} finally {
  const report = option("--report");
  if (report !== undefined) {
    mkdirSync(dirname(resolve(report)), { recursive: true });
    writeFileSync(resolve(report), `${JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, ...summary }, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!keep && option("--work") === undefined) rmSync(work, { recursive: true, force: true });
}
