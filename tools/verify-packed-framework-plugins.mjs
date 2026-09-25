#!/usr/bin/env node
/**
 * Packed-consumer proof that the framework plugins ship inside @aihq/core (D71).
 *
 * Builds @aihq/core from the given checkout into a staging directory OUTSIDE
 * the checkout, with both framework plugins built into the stage at their
 * source layout (`packages/framework-*`), packs Core alone, and installs that
 * one tarball into a disposable project AND a disposable global prefix (always
 * `--ignore-scripts`, an empty npm user config, never `npm link`). It then checks:
 *
 *   Tarball: Core carries each plugin's manifest and built entry and, under
 *     `packages/`, nothing but the entries its `files` names (no sources, no
 *     tests); Core's own dist carries no plugin code and imports no plugin by
 *     package name; each plugin's dist imports Core only through
 *     `@aihq/core/framework-host` and Node built-ins; Core declares no
 *     dependency or peer on the plugins, which stay private at 0.1.0.
 *   Core alone, no Catalog: `aih superpowers` refuses with
 *     `catalog-package-unavailable`; the descriptor is Catalog data.
 *   Core + the pinned Catalog 0.3.0, project and global install: `aih
 *     superpowers <fixture>` exits 0 with the exact-pinned acquisition preview
 *     and `aih ecc --lifecycle install <fixture>` previews the ECC profile from
 *     the installed Catalog, writing nothing, each plugin loaded from INSIDE the
 *     installed Core and its `@aihq/core/framework-host` resolved to that same
 *     Core; `aih init` (dry run) runs the Superpowers evidence-gated preview.
 *   Bundled plugin damaged (package.json version changed): the command refuses
 *     with `framework-plugin-incompatible`, never treating it as absent.
 *   Catalog identity record differs, or a Catalog without identities (0.2.0):
 *     `framework-plugin-incompatible`.
 *   Bundled plugin removed from the install: `aih superpowers` and `aih ecc`
 *     refuse with `framework-plugin-unavailable` naming the `@aihq/core`
 *     reinstall and without a stack trace; `aih init` (dry run) reports the
 *     Superpowers phase as refused with that reason and still exits 0.
 *
 * The staged Core manifest carries `--core-version` (default 0.7.0, the
 * candidate the plugins' identity records name); the checkout is never modified.
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
  readdirSync,
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
import { globalNodeModules } from "./lib/packed-consumer.mjs";

const PIN = "5bf4e78011075bcfc0dc295f0724994cd123ee71";
const SUPERPOWERS = "@aihq/framework-superpowers";
const ECC = "@aihq/framework-ecc";
const BUNDLED = [
  { frameworkId: "ecc", name: ECC, directory: "packages/framework-ecc" },
  { frameworkId: "superpowers", name: SUPERPOWERS, directory: "packages/framework-superpowers" },
];
const REINSTALL = "Reinstall @aihq/core with: npm install -g @aihq/core";
/** Identifiers that exist only in the plugins' sources, never in Core's. */
const PLUGIN_ONLY_MARKERS = [
  "superpowers descriptor refused",
  "readSuperpowersHookInventory",
  "readSuperpowersDescriptor",
  "superpowersActionsForCli",
  "executeEccEvidencePipeline",
  "applyPreparedGovernedEccDelivery",
  "planEccMaterialization",
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
const npmInstall = (args, cwd, label) =>
  must(npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", ...args], cwd), label);
// Build tools resolve from the checkout's own dependency tree (a worktree resolves
// them from an ancestor node_modules).
const requireFromRepo = createRequire(join(repo, "package.json"));
const tsupCli = join(dirname(requireFromRepo.resolve("tsup/package.json")), "dist", "cli-default.js");
const tscCli = join(dirname(requireFromRepo.resolve("typescript/package.json")), "bin", "tsc");

const summary = { ok: false, work, coreVersion };
try {
  // ---- stage and pack Core, the plugins built inside it ------------------------
  const coreStage = join(work, "stage-core");
  mkdirSync(coreStage, { recursive: true });
  let started = Date.now();
  must(run(process.execPath, [tsupCli, "--out-dir", join(coreStage, "dist")], repo), "Core tsup build");
  must(
    run(process.execPath, [tscCli, "-p", "tsconfig.dts.json", "--outDir", join(coreStage, "dist")], repo),
    "Core declaration emit",
  );
  for (const { directory } of BUNDLED)
    must(
      run(process.execPath, [tsupCli, "--out-dir", join(coreStage, directory, "dist")], join(repo, directory)),
      `${directory} tsup build`,
    );
  const coreManifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  // Build outputs come from the builds above, never from whatever the checkout holds.
  for (const entry of coreManifest.files) {
    if (entry.startsWith("!") || /^(packages\/[^/]+\/)?dist$/.test(entry)) continue;
    const source = join(repo, entry);
    if (!existsSync(source)) continue;
    mkdirSync(dirname(join(coreStage, entry)), { recursive: true });
    cpSync(source, join(coreStage, entry), { recursive: true });
  }
  writeFileSync(join(coreStage, "package.json"), `${JSON.stringify({ ...coreManifest, version: coreVersion }, null, 2)}\n`);
  summary.buildMs = Date.now() - started;
  started = Date.now();
  const corePacked = JSON.parse(
    must(npmRun(["pack", "--json", "--ignore-scripts", "--pack-destination", work], coreStage), "Core npm pack"),
  );
  summary.packMs = Date.now() - started;
  const coreTarball = join(work, corePacked[0].filename);
  Object.assign(summary, {
    coreTarball,
    coreSha256: sha256(coreTarball),
    coreTarballBytes: corePacked[0].size,
    coreUnpackedBytes: corePacked[0].unpackedSize,
    coreFileCount: corePacked[0].entryCount,
  });
  process.stdout.write(`core tarball ${coreTarball} sha256 ${summary.coreSha256}\n`);

  // ---- tarball contents ---------------------------------------------------------
  const coreFiles = readPackedFiles(coreTarball);
  const corePaths = [...coreFiles.keys()];
  for (const { name, directory } of BUNDLED)
    check(
      `Core tarball carries ${name}'s manifest and built entry`,
      coreFiles.has(`package/${directory}/package.json`) && coreFiles.has(`package/${directory}/dist/index.js`),
    );
  const bundledEntries = coreManifest.files.filter((entry) => entry.startsWith("packages/"));
  const strayPackagePaths = corePaths.filter((path) => {
    if (!path.startsWith("package/packages/")) return false;
    const inner = path.slice("package/".length);
    return !bundledEntries.some((entry) => inner === entry || inner.startsWith(`${entry}/`));
  });
  check(
    "Core tarball carries under packages/ only the entries its files names",
    strayPackagePaths.length === 0,
    strayPackagePaths.join(", "),
  );
  const packedSourcesOrTests = corePaths.filter(
    (path) => path.startsWith("package/packages/") && (/\.tsx?$/.test(path) || /\/tests?\//.test(path)),
  );
  check(
    "Core tarball carries no plugin source or test file",
    packedSourcesOrTests.length === 0,
    packedSourcesOrTests.join(", "),
  );
  const coreJs = [...coreFiles]
    .filter(([path]) => /^package\/dist\/[^/]+\.js$/.test(path))
    .map(([path, bytes]) => [path.slice("package/dist/".length), bytes.toString("utf8")]);
  const markerHits = coreJs.flatMap(([file, body]) =>
    PLUGIN_ONLY_MARKERS.filter((marker) => body.includes(marker)).map((marker) => `${file}: ${marker}`),
  );
  check("Core dist carries no plugin-only identifier", markerHits.length === 0, markerHits.join("; "));
  for (const { name } of BUNDLED) {
    const escaped = name.replace(/[/.]/g, (c) => `\\${c}`);
    const hits = coreJs.filter(([, body]) =>
      new RegExp(`from\\s*"${escaped}"|import\\s*"${escaped}"|import\\s*\\(\\s*"${escaped}"\\s*\\)`).test(body),
    );
    check(`Core dist imports ${name} by no package specifier`, hits.length === 0, hits.map(([file]) => file).join(","));
  }
  check(
    "Core tarball ships dist/framework-host.js and its declarations",
    coreFiles.has("package/dist/framework-host.js") && coreFiles.has("package/dist/framework-host/index.d.ts"),
  );
  const packedCoreManifest = JSON.parse(coreFiles.get("package/package.json").toString("utf8"));
  check(
    "Core manifest exports ./framework-host and declares no dependency or peer on the plugins",
    packedCoreManifest.exports?.["./framework-host"]?.import === "./dist/framework-host.js" &&
      BUNDLED.every(
        ({ name }) =>
          packedCoreManifest.dependencies?.[name] === undefined &&
          packedCoreManifest.peerDependencies?.[name] === undefined &&
          packedCoreManifest.peerDependenciesMeta?.[name] === undefined,
      ),
  );
  for (const { name, directory } of BUNDLED) {
    const bundledManifest = JSON.parse(coreFiles.get(`package/${directory}/package.json`).toString("utf8"));
    check(
      `bundled ${name} keeps its name and version and stays private`,
      bundledManifest.name === name && bundledManifest.version === "0.1.0" && bundledManifest.private === true,
      `${bundledManifest.name}@${bundledManifest.version} private=${bundledManifest.private}`,
    );
    const pluginJs = coreFiles.get(`package/${directory}/dist/index.js`).toString("utf8");
    // Module statements only: top-level import/export ... from, side-effect imports, and dynamic import().
    const pluginImports = [
      ...pluginJs.matchAll(/^(?:import|export)\s[^;"]*?from\s*"([^"]+)"/gm),
      ...pluginJs.matchAll(/^import\s*"([^"]+)"/gm),
      ...pluginJs.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
    ].map((match) => match[1]);
    check(
      `bundled ${name} dist imports only @aihq/core/framework-host and node:*`,
      pluginImports.length > 0 &&
        pluginImports.every((specifier) => specifier === "@aihq/core/framework-host" || specifier.startsWith("node:")),
      [...new Set(pluginImports)].join(", "),
    );
  }

  // ---- consumers: Core alone, project and global -----------------------------------
  const consumer = join(work, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "framework-plugin-consumer", private: true, type: "module" }));
  started = Date.now();
  npmInstall([coreTarball], consumer, "Core install");
  const globalPrefix = join(work, "global");
  mkdirSync(globalPrefix, { recursive: true });
  npmInstall(["--global", "--prefix", globalPrefix, coreTarball], work, "Core global install");
  summary.installMs = Date.now() - started;
  const installs = [
    { label: "project", modules: join(consumer, "node_modules") },
    { label: "global", modules: globalNodeModules(globalPrefix) },
  ].map((install) => ({ ...install, core: join(install.modules, "@aihq", "core") }));
  for (const { label, modules, core } of installs)
    check(
      `${label} install has only @aihq/core, carrying both plugins inside it`,
      existsSync(join(core, "package.json")) &&
        BUNDLED.every(
          ({ name, directory }) =>
            existsSync(join(core, directory, "dist", "index.js")) && !existsSync(join(modules, ...name.split("/"))),
        ),
    );
  const [project, global] = installs;
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
      `    if (/@aihq[\\\\/]core[\\\\/](packages|dist[\\\\/]framework-host)/.test(resolved.url)) appendFileSync(${JSON.stringify(traceLog)}, specifier + " -> " + resolved.url + "\\n");`,
      "    return resolved;",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  const aihAt = (core, args, extraNodeArgs = []) => {
    const result = spawnSync(process.execPath, [...extraNodeArgs, join(core, "dist", "cli.js"), ...args], {
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
  const aih = (args, extraNodeArgs = []) => aihAt(project.core, args, extraNodeArgs);
  const json = (result) => {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
  };
  const errorText = (result) => (json(result)?.error?.message ?? `${result.stdout}\n${result.stderr}`).trim().slice(0, 300);
  const noStack = (result) => !/\n\s+at .+\(.+:\d+:\d+\)/.test(`${result.stdout}\n${result.stderr}`);
  const fixture = join(work, "fixture");
  mkdirSync(fixture, { recursive: true });

  // ---- Catalog absent: the descriptor is Catalog data (C1) --------------------------
  const withoutCatalog = aih(["superpowers", fixture, "--json", "--no-log"]);
  const withoutCatalogError = json(withoutCatalog)?.error;
  summary.withoutCatalog = { exit: withoutCatalog.status, error: withoutCatalogError };
  check(
    "without Catalog, aih superpowers refuses with catalog-package-unavailable and no embedded fallback",
    withoutCatalog.status === 1 && withoutCatalogError?.message?.includes("catalog-package-unavailable") === true,
    errorText(withoutCatalog),
  );

  // The real Catalog 0.3.0 this repository pins carries both framework
  // descriptors and the plugin identity records the loader checks.
  const pinnedCatalog = join(repo, "tests", "fixtures", "packages", "aihq-catalog-0.3.0-c8e2c03.tgz");
  npmInstall([pinnedCatalog], consumer, "Catalog 0.3.0 install");
  npmInstall(["--global", "--prefix", globalPrefix, pinnedCatalog], work, "Catalog 0.3.0 global install");

  // ---- one plugin-backed path per framework, from each install --------------------
  summary.paths = {};
  for (const { label, core } of installs) {
    const coreUrl = pathToFileURL(realpathSync(core)).href.toLowerCase();
    const traced = (result) => {
      const lines = existsSync(traceLog) ? [...new Set(readFileSync(traceLog, "utf8").trim().split(/\r?\n/))] : [];
      rmSync(traceLog, { force: true });
      return { result, lines };
    };
    const superpowers = traced(aihAt(core, ["superpowers", fixture, "--json", "--no-log"], ["--import", pathToFileURL(trace).href]));
    const superpowersResult = json(superpowers.result);
    const eccRoot = join(work, `fixture-ecc-${label}`);
    mkdirSync(eccRoot, { recursive: true });
    const ecc = traced(
      aihAt(core, ["ecc", "--lifecycle", "install", eccRoot, "--json", "--no-log"], ["--import", pathToFileURL(trace).href]),
    );
    const eccResult = json(ecc.result);
    summary.paths[label] = {
      superpowers: {
        exit: superpowers.result.status,
        capability: superpowersResult?.capability,
        execs: superpowersResult?.execs?.map((entry) => ({ describe: entry.describe, ran: entry.ran })),
        moduleTrace: superpowers.lines,
      },
      ecc: {
        exit: ecc.result.status,
        capability: eccResult?.capability,
        previewedWrites: eccResult?.writes?.length,
        moduleTrace: ecc.lines,
      },
    };
    check(
      `aih superpowers <fixture> previews the exact pin through the bundled plugin (${label} install)`,
      superpowers.result.status === 0 &&
        superpowersResult?.capability === "superpowers: acquire exact baseline source" &&
        superpowersResult.execs?.length === 1 &&
        superpowersResult.execs[0].ran === false &&
        JSON.stringify(superpowersResult).includes(PIN),
      `exit ${superpowers.result.status}; ${errorText(superpowers.result)}`,
    );
    check(
      `aih ecc --lifecycle install <fixture> previews the profile from the installed Catalog through the bundled plugin, writing nothing (${label} install)`,
      ecc.result.status === 0 &&
        eccResult?.capability === "ecc-profile: atomic projection and native registration install" &&
        eccResult.applied === false &&
        eccResult.writes?.length > 0 &&
        readdirSync(eccRoot).length === 0,
      `exit ${ecc.result.status}; ${errorText(ecc.result)}`,
    );
    for (const [{ directory }, { lines }] of [
      [BUNDLED[1], superpowers],
      [BUNDLED[0], ecc],
    ]) {
      check(
        `${directory} was loaded from inside the INSTALLED Core (${label} install)`,
        lines.some((line) => line.toLowerCase().endsWith(`-> ${coreUrl}/${directory}/dist/index.js`)),
        lines.join(" | ") || "<nothing traced>",
      );
      check(
        `${directory}'s @aihq/core/framework-host resolved to that same Core (${label} install)`,
        lines.some(
          (line) =>
            line.startsWith("@aihq/core/framework-host -> ") &&
            line.toLowerCase().endsWith(`${coreUrl}/dist/framework-host.js`),
        ),
      );
    }
  }
  const initFixture = join(work, "fixture-init");
  mkdirSync(initFixture, { recursive: true });
  const initWithPlugin = aih(["init", initFixture, "--json", "--no-log"]);
  const initWithPluginResult = json(initWithPlugin);
  check(
    "aih init (dry run) runs the bundled Superpowers plugin's evidence-gated preview",
    initWithPlugin.status === 0 &&
      (initWithPluginResult?.execs ?? []).some(
        (entry) => entry.describe.includes(`obra/Superpowers@${PIN}`) && entry.ran === false,
      ),
    `exit ${initWithPlugin.status}; ${initWithPlugin.stderr.trim().slice(0, 300)}`,
  );

  // ---- bundled plugin damaged: incompatible, never absent -------------------------
  const superpowersDirectory = join(project.core, ...BUNDLED[1].directory.split("/"));
  const pluginManifestPath = join(superpowersDirectory, "package.json");
  const pluginManifestBytes = readFileSync(pluginManifestPath);
  writeFileSync(pluginManifestPath, `${JSON.stringify({ ...JSON.parse(pluginManifestBytes.toString("utf8")), version: "0.1.1" }, null, 2)}\n`);
  const damaged = aih(["superpowers", fixture, "--json", "--no-log"]);
  const damagedError = json(damaged)?.error;
  summary.damaged = { exit: damaged.status, error: damagedError };
  check(
    "a damaged bundled plugin refuses as framework-plugin-incompatible and names the Core reinstall",
    damaged.status === 1 &&
      damagedError?.code === "AIH_FRAMEWORK_PLUGIN" &&
      typeof damagedError.message === "string" &&
      damagedError.message.startsWith("framework-plugin-incompatible: ") &&
      damagedError.message.includes(REINSTALL),
    errorText(damaged),
  );
  writeFileSync(pluginManifestPath, pluginManifestBytes);

  // ---- the plugin must equal Catalog's identity record ----------------------------
  // The pinned real Catalog 0.3.0 (a rewritten record), then the real 0.2.0
  // tarball, which does not publish plugin identities.
  const identities = (superpowersVersion) => ({
    format: "aih-catalog-framework-plugins",
    version: 1,
    entries: [
      {
        frameworkId: "ecc",
        packageName: ECC,
        version: "0.1.0",
        contractVersion: 1,
        upstream: { repository: "affaan-m/ECC", commit: "5064474d4d762dc9640234a41617cccb79185cec" },
        supportedCore: ">=0.7.0 <0.8.0",
        supportedHosts: ["claude", "codex", "cursor", "kiro", "kimi", "opencode"],
        status: "candidate",
      },
      {
        frameworkId: "superpowers",
        packageName: SUPERPOWERS,
        version: superpowersVersion,
        contractVersion: 1,
        upstream: { repository: "obra/Superpowers", commit: PIN },
        supportedCore: ">=0.7.0 <0.8.0",
        supportedHosts: ["antigravity", "claude", "codex", "copilot", "cursor", "gemini", "kiro", "kimi", "opencode", "windsurf", "zed"],
        status: "candidate",
      },
    ],
  });
  const installedIdentities = join(consumer, "node_modules", "@aihq", "catalog", "defaults", "catalog-framework-plugins-v1.json");
  writeFileSync(installedIdentities, `${JSON.stringify(identities("0.1.9"))}\n`);
  const mismatched = aih(["superpowers", fixture, "--json", "--no-log"]);
  const mismatchedError = json(mismatched)?.error;
  summary.catalogMismatch = { exit: mismatched.status, error: mismatchedError };
  check(
    "a plugin version that differs from Catalog's identity record refuses as incompatible",
    mismatched.status === 1 &&
      mismatchedError?.message?.startsWith("framework-plugin-incompatible: ") === true &&
      mismatchedError.message.includes(`does not equal @aihq/catalog 0.3.0's identity record ${SUPERPOWERS} 0.1.9`),
    errorText(mismatched),
  );
  const oldCatalog = join(repo, "tests", "fixtures", "packages", "aihq-catalog-0.2.0-517e43d.tgz");
  if (existsSync(oldCatalog)) {
    npmInstall([oldCatalog], consumer, "Catalog 0.2.0 install");
    const withOldCatalog = aih(["superpowers", fixture, "--json", "--no-log"]);
    const withOldCatalogError = json(withOldCatalog)?.error;
    summary.catalogWithoutIdentities = { exit: withOldCatalog.status, error: withOldCatalogError };
    check(
      "a Catalog without plugin identities (0.2.0) is incompatible, never treated as absent",
      withOldCatalog.status === 1 &&
        withOldCatalogError?.message?.startsWith("framework-plugin-incompatible: ") === true &&
        withOldCatalogError.message.includes("catalog-package-incompatible"),
      errorText(withOldCatalog),
    );
  } else {
    check("the repository's Catalog 0.2.0 fixture tarball exists", false, oldCatalog);
  }
  must(npmRun(["uninstall", "--ignore-scripts", "--no-audit", "--no-fund", "@aihq/catalog"], consumer), "Catalog uninstall");

  // ---- bundled plugins removed from the install: explicit refusal ------------------
  for (const { directory } of BUNDLED) rmSync(join(project.core, ...directory.split("/")), { recursive: true, force: true });
  check("the bundled plugins are removed from the project install", BUNDLED.every(({ directory }) => !existsSync(join(project.core, directory))));
  for (const [command, name] of [
    ["superpowers", SUPERPOWERS],
    ["ecc", ECC],
  ]) {
    const without = aih([command, fixture, "--json", "--no-log"]);
    const withoutError = json(without)?.error;
    summary[`${command}WithoutPlugin`] = { exit: without.status, error: withoutError };
    check(
      `aih ${command} refuses with framework-plugin-unavailable and names the @aihq/core reinstall`,
      without.status === 1 &&
        withoutError?.code === "AIH_FRAMEWORK_PLUGIN" &&
        typeof withoutError.message === "string" &&
        withoutError.message.startsWith(`framework-plugin-unavailable: ${name} ships inside @aihq/core`) &&
        withoutError.message.includes(REINSTALL) &&
        !withoutError.message.includes(`npm install -g @aihq/core ${name}`),
      errorText(without),
    );
  }
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

  // ---- the refusal's reinstall routes restore the bundled plugins -------------------
  const restored = (core) => BUNDLED.every(({ directory }) => existsSync(join(core, ...directory.split("/"), "dist", "index.js")));
  rmSync(project.core, { recursive: true, force: true });
  npmInstall([], consumer, "project reinstall");
  check("in a project, deleting node_modules/@aihq/core and running npm install restores both bundled plugins", restored(project.core));
  for (const { directory } of BUNDLED) rmSync(join(global.core, ...directory.split("/")), { recursive: true, force: true });
  npmInstall(["--global", "--prefix", globalPrefix, coreTarball], work, "global reinstall");
  check("npm install -g of Core restores both bundled plugins in a global install", restored(global.core));
  summary.globalModules = global.modules;

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
