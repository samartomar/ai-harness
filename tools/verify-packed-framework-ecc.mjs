#!/usr/bin/env node
/**
 * Packed-consumer proof of the ECC framework plugin (C3, phase 2).
 *
 * Builds @aihq/core, @aihq/framework-ecc and @aihq/framework-superpowers from
 * the given checkout into staging directories OUTSIDE the checkout, packs the
 * given Catalog candidate as it is, and installs the four tarballs into a
 * disposable project AND a disposable global prefix (always `--ignore-scripts`,
 * an empty npm user config, never `npm link`). Against temp fixture roots only,
 * it then checks:
 *
 *   Tarballs: Core carries no ECC implementation (no plugin package file, no
 *     ECC implementation function name in dist); the ECC plugin carries only its
 *     dist, which imports Core only through `@aihq/core/framework-host`.
 *   `aih ecc <tmpRoot>` previews through the INSTALLED plugin, from the project
 *     install and from the global install.
 *   Governed delivery round trip: a file-authority policy selecting ECC content
 *     is projected with `--apply`, the owned files and receipt land, and
 *     `aih uninstall --apply` removes exactly the receipt-owned content.
 *   Hook controls: an ECC hook disabled by policy and another by the project's
 *     user list both reach the projected Claude `settings.json` env.
 *   Plugin removed: `aih ecc`, governed projection, uninstall, prune and hook
 *     controls refuse with `framework-plugin-unavailable` naming the install
 *     command and write nothing; doctor and the policy delivery report state the
 *     ECC checks were not run. The plugin is then reinstalled and the uninstall
 *     completes the round trip.
 *
 * usage:
 *   node tools/verify-packed-framework-ecc.mjs --stage-from <core-repo> --catalog <catalog-repo>
 *     --ecc-source <ECC checkout at the Catalog pin> [--overlay-rev <rev>] [--core-version 0.7.0] [--work <dir>] [--reuse] [--keep] [--report <file>] [--transcript <file>]
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const ECC = "@aihq/framework-ecc";
const SUPERPOWERS = "@aihq/framework-superpowers";
/** ECC implementation function names; Core keeps names in its build, so a bundled copy would carry them. */
const ECC_IMPLEMENTATION_NAMES = [
  "executeEccEvidencePipeline",
  "applyPreparedGovernedEccDelivery",
  "eccPruneReconciliationActions",
  "planGovernedCodexRoleRegistration",
  "buildEccProfileParityReceipt",
  "describeEccEffectiveDiscovery",
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

const transcript = [];
function record(label, args, result) {
  transcript.push(
    [
      `$ aih ${args.join(" ")}    # ${label}`,
      `exit ${result.status}`,
      result.stdout.trimEnd(),
      result.stderr.trim() ? `[stderr]\n${result.stderr.trimEnd()}` : "",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
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
const catalogRepo = option("--catalog");
const eccSourceOption = option("--ecc-source");
if (!stageFrom || !catalogRepo || !eccSourceOption) {
  process.stderr.write(
    "usage: verify-packed-framework-ecc.mjs --stage-from <core-repo> --catalog <catalog-repo> --ecc-source <ecc-checkout> [--overlay-rev <rev>] [--core-version 0.7.0] [--work <dir>] [--reuse] [--keep] [--report <file>] [--transcript <file>]\n",
  );
  process.exit(2);
}
const repo = resolve(stageFrom);
const eccSource = realpathSync(resolve(eccSourceOption));
const coreVersion = option("--core-version") ?? "0.7.0";
const keep = process.argv.includes("--keep");
const reuse = process.argv.includes("--reuse");
const work = realpathSync(
  option("--work") !== undefined
    ? (mkdirSync(resolve(option("--work")), { recursive: true }), resolve(option("--work")))
    : mkdtempSync(join(tmpdir(), "aih-packed-framework-ecc-")),
);
if (insideGitRepository(work)) throw new Error(`work directory ${work} is inside a git repository`);
const npm = npmCli();
const emptyUserConfig = join(work, "empty.npmrc");
writeFileSync(emptyUserConfig, "");
const isolatedNpmEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/iu.test(name)));
const npmRun = (args, cwd) =>
  spawnSync(process.execPath, [npm, ...args, "--userconfig", emptyUserConfig], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    env: { ...isolatedNpmEnv, npm_config_userconfig: emptyUserConfig, npm_execpath: npm },
  });
const requireFromRepo = createRequire(join(repo, "package.json"));
const tsupCli = join(dirname(requireFromRepo.resolve("tsup/package.json")), "dist", "cli-default.js");
const tscCli = join(dirname(requireFromRepo.resolve("typescript/package.json")), "bin", "tsc");

const tarballs = join(work, "tarballs");
const summary = { ok: false, work, coreVersion };

function pack(stage, label) {
  const packed = JSON.parse(must(npmRun(["pack", "--json", "--ignore-scripts", "--pack-destination", tarballs], stage), `${label} npm pack`));
  return join(tarballs, packed[0].filename);
}

/**
 * Core's build inputs. With `--overlay-rev`, a copy of them outside the
 * checkout with the named files replaced by their content at that revision (the
 * checkout is never modified); the copy resolves build tools through a
 * junction to the checkout's dependency tree.
 */
const overlayRev = option("--overlay-rev");
const OVERLAY_PATHS = ["src/catalog-package/framework-descriptors.ts", "src/catalog-package/load-catalog-package.ts"];
function coreBuildRoot() {
  if (overlayRev === undefined) return repo;
  const copy = join(work, "core-src");
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  for (const entry of ["src", "tsup.config.ts", "tsconfig.json", "tsconfig.dts.json", "package.json", ...manifest.files]) {
    if (entry.startsWith("!") || entry === "dist" || !existsSync(join(repo, entry))) continue;
    mkdirSync(dirname(join(copy, entry)), { recursive: true });
    cpSync(join(repo, entry), join(copy, entry), { recursive: true });
  }
  const overlays = [];
  for (const path of OVERLAY_PATHS) {
    const bytes = must(run("git", ["-C", repo, "show", `${overlayRev}:${path}`], repo), `git show ${overlayRev}:${path}`);
    writeFileSync(join(copy, path), bytes);
    overlays.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  // Integration shim: W1 names the descriptor load result `FrameworkDescriptorBytesV1Result`
  // (same shape); the plugin runner imports it as `FrameworkDescriptorLoadV1`.
  const shim = "export type FrameworkDescriptorLoadV1 = FrameworkDescriptorBytesV1Result;\n";
  writeFileSync(join(copy, OVERLAY_PATHS[0]), `${readFileSync(join(copy, OVERLAY_PATHS[0]), "utf8")}${shim}`);
  overlays.push({ shim: shim.trim(), appendedTo: OVERLAY_PATHS[0] });
  const modules = dirname(dirname(requireFromRepo.resolve("tsup/package.json")));
  symlinkSync(modules, join(copy, "node_modules"), "junction");
  must(run(process.execPath, [tscCli, "-p", "tsconfig.dts.json", "--noEmit"], copy), "overlaid Core typecheck");
  summary.overlay = {
    revision: must(run("git", ["-C", repo, "rev-parse", overlayRev], repo), "rev-parse").trim(),
    files: overlays,
  };
  return copy;
}

function stageAndPack() {
  rmSync(tarballs, { recursive: true, force: true });
  mkdirSync(tarballs, { recursive: true });
  // ---- Core ---------------------------------------------------------------------
  const coreRoot = coreBuildRoot();
  const coreStage = join(work, "stage-core");
  rmSync(coreStage, { recursive: true, force: true });
  mkdirSync(coreStage, { recursive: true });
  must(run(process.execPath, [tsupCli, "--out-dir", join(coreStage, "dist")], coreRoot), "Core tsup build");
  must(run(process.execPath, [tscCli, "-p", "tsconfig.dts.json", "--outDir", join(coreStage, "dist")], coreRoot), "Core declaration emit");
  for (const source of [
    "src/org-policy/workbench/default-catalog-preassembly.generated.cjs",
    "src/org-policy/workbench/core/packaged-source-data-data.json",
    "src/org-policy/workbench/core/catalog-qualification-data.json",
    "src/org-policy/packaged-collection-evidence-data.json",
  ]) {
    if (existsSync(join(coreRoot, source))) cpSync(join(coreRoot, source), join(coreStage, "dist", source.split("/").at(-1)));
  }
  const coreManifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  for (const entry of coreManifest.files) {
    if (entry.startsWith("!") || entry === "dist") continue;
    const source = join(repo, entry);
    if (!existsSync(source)) continue;
    mkdirSync(dirname(join(coreStage, entry)), { recursive: true });
    cpSync(source, join(coreStage, entry), { recursive: true });
  }
  writeFileSync(join(coreStage, "package.json"), `${JSON.stringify({ ...coreManifest, version: coreVersion }, null, 2)}\n`);
  const core = pack(coreStage, "Core");
  // ---- the two framework plugins ------------------------------------------------------
  const plugins = {};
  for (const [name, dir] of [
    [ECC, "framework-ecc"],
    [SUPERPOWERS, "framework-superpowers"],
  ]) {
    const source = join(repo, "packages", dir);
    const stage = join(work, `stage-${dir}`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    must(run(process.execPath, [tsupCli, "--out-dir", join(stage, "dist")], source), `${name} tsup build`);
    for (const file of ["package.json", "README.md", "LICENSE"]) cpSync(join(source, file), join(stage, file));
    plugins[name] = pack(stage, name);
  }
  // ---- the Catalog candidate, packed as it is; record which tree that was ------------------
  const catalogHead = run("git", ["-C", resolve(catalogRepo), "rev-parse", "HEAD"], resolve(catalogRepo));
  const catalogStatus = run("git", ["-C", resolve(catalogRepo), "status", "--porcelain"], resolve(catalogRepo));
  summary.catalogCandidate = {
    head: catalogHead.status === 0 ? catalogHead.stdout.trim() : undefined,
    uncommitted: catalogStatus.status === 0 ? catalogStatus.stdout.split("\n").filter(Boolean) : undefined,
  };
  const catalog = pack(resolve(catalogRepo), "Catalog");
  return { core, ecc: plugins[ECC], superpowers: plugins[SUPERPOWERS], catalog };
}

function existingTarballs() {
  const names = readdirSync(tarballs);
  const find = (prefix) => {
    const hit = names.find((name) => name.startsWith(prefix));
    if (!hit) throw new Error(`--reuse: no ${prefix}*.tgz in ${tarballs}`);
    return join(tarballs, hit);
  };
  return {
    core: find("aihq-core-"),
    ecc: find("aihq-framework-ecc-"),
    superpowers: find("aihq-framework-superpowers-"),
    catalog: find("aihq-catalog-"),
  };
}

try {
  const packed = reuse && existsSync(tarballs) ? existingTarballs() : stageAndPack();
  summary.tarballs = Object.fromEntries(
    Object.entries(packed).map(([key, path]) => [key, { file: path.split(/[\\/]/).at(-1), sha256: sha256(path) }]),
  );
  for (const [key, value] of Object.entries(summary.tarballs)) process.stdout.write(`${key} ${value.file} sha256 ${value.sha256}\n`);

  // ---- tarball contents -------------------------------------------------------------------
  const coreFiles = readPackedFiles(packed.core);
  const corePaths = [...coreFiles.keys()];
  check(
    "Core tarball has no framework plugin package file",
    corePaths.every((path) => !path.startsWith("package/packages/") && !/framework-(superpowers|ecc)/.test(path)),
  );
  const coreJs = [...coreFiles]
    .filter(([path]) => /^package\/dist\/[^/]+\.js$/.test(path))
    .map(([path, bytes]) => [path.slice("package/dist/".length), bytes.toString("utf8")]);
  const implementationHits = coreJs.flatMap(([file, body]) =>
    ECC_IMPLEMENTATION_NAMES.filter((name) => body.includes(name)).map((name) => `${file}: ${name}`),
  );
  check("Core dist carries no ECC implementation function", implementationHits.length === 0, implementationHits.join("; "));
  const eccFiles = readPackedFiles(packed.ecc);
  const eccPaths = [...eccFiles.keys()].sort();
  check(
    "ECC plugin tarball carries only its dist, manifest, README and LICENSE",
    eccPaths.join(",") === ["package/LICENSE", "package/README.md", "package/dist/index.js", "package/package.json"].join(","),
    eccPaths.join(", "),
  );
  const eccJs = eccFiles.get("package/dist/index.js").toString("utf8");
  // Module statements only: top-level import/export ... from, side-effect imports, and dynamic import().
  const eccImports = [
    ...new Set(
      [
        ...eccJs.matchAll(/^(?:import|export)\s[^;"]*?from\s*"([^"]+)"/gm),
        ...eccJs.matchAll(/^import\s*"([^"]+)"/gm),
        ...eccJs.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
      ].map((match) => match[1]),
    ),
  ];
  check(
    "ECC plugin dist imports only @aihq/core/framework-host and node:*",
    eccImports.length > 0 && eccImports.every((specifier) => specifier === "@aihq/core/framework-host" || specifier.startsWith("node:")),
    eccImports.join(", "),
  );

  // ---- installs: a project and a global prefix -------------------------------------------------
  const project = join(work, "project");
  const globalPrefix = join(work, "global");
  const globalModules = process.platform === "win32" ? join(globalPrefix, "node_modules") : join(globalPrefix, "lib", "node_modules");
  // A previous run ends with the plugin removed from the global prefix; reinstall then.
  if (!reuse || ![join(project, "node_modules"), globalModules].every((modules) => existsSync(join(modules, "@aihq", "framework-ecc")))) {
    rmSync(project, { recursive: true, force: true });
    rmSync(globalPrefix, { recursive: true, force: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(globalPrefix, { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "framework-ecc-consumer", private: true, type: "module" }));
    const all = [packed.core, packed.catalog, packed.ecc, packed.superpowers];
    must(npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", ...all], project), "project install");
    must(
      npmRun(["install", "-g", "--prefix", globalPrefix, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", ...all], work),
      "global install",
    );
  }
  const projectCore = join(project, "node_modules", "@aihq", "core");
  const globalCore = join(globalModules, "@aihq", "core");
  check(
    "project and global prefix each have Core, Catalog and both plugins installed side by side",
    [join(project, "node_modules"), globalModules].every((modules) =>
      ["core", "catalog", "framework-ecc", "framework-superpowers"].every((name) => existsSync(join(modules, "@aihq", name, "package.json"))),
    ),
  );

  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  const cliEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AIH_[A-Z_]+|npm_config_.*)$/iu.test(name))),
    HOME: home,
    USERPROFILE: home,
  };
  const aihAt = (coreDir) => (label, args, env = {}) => {
    const result = spawnSync(process.execPath, [join(coreDir, "dist", "cli.js"), ...args], {
      cwd: work,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      env: { ...cliEnv, ...env },
    });
    if (result.error) throw new Error(`aih ${args.join(" ")}: ${result.error.message}`);
    record(label, args, result);
    return result;
  };
  const aih = aihAt(projectCore);
  const aihGlobal = aihAt(globalCore);
  const json = (result) => {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
  };
  summary.json = json;

  // ---- aih ecc <tmpRoot> preview -------------------------------------------------------------------
  const previewRoot = join(work, "fixture-preview");
  rmSync(previewRoot, { recursive: true, force: true });
  mkdirSync(previewRoot, { recursive: true });
  const preview = aih("ECC preview (project install)", ["ecc", previewRoot, "--json", "--no-log"]);
  const previewResult = json(preview);
  summary.preview = { exit: preview.status, capability: previewResult?.capability };
  check(
    "aih ecc <tmpRoot> previews through the installed plugin (project install)",
    preview.status === 0 && typeof previewResult?.capability === "string" && previewResult.capability.startsWith("ecc"),
    `exit ${preview.status}; ${(previewResult?.error?.message ?? preview.stderr).slice(0, 300)}`,
  );
  const previewGlobal = aihGlobal("ECC preview (global install)", ["ecc", previewRoot, "--json", "--no-log"]);
  check(
    "aih ecc <tmpRoot> previews through the installed plugin (global install)",
    previewGlobal.status === 0 && json(previewGlobal)?.capability === previewResult?.capability,
    `exit ${previewGlobal.status}; ${(json(previewGlobal)?.error?.message ?? previewGlobal.stderr).slice(0, 300)}`,
  );

  // ---- governed delivery: apply through the installed plugin --------------------------------------
  // The ECC source checkout must sit at the commit the installed Catalog pins.
  const catalogDescriptor = readFileSync(
    join(project, "node_modules", "@aihq", "catalog", "defaults", "catalog-framework-ecc-v1.json"),
    "utf8",
  );
  const pins = [...new Set([...catalogDescriptor.matchAll(/"pinnedSha":"([0-9a-f]{40})"/g)].map((match) => match[1]))];
  const eccHead = run("git", ["-C", eccSource, "rev-parse", "HEAD"], eccSource).stdout.trim();
  summary.eccSource = { head: eccHead, catalogPins: pins };
  if (pins.length !== 1 || eccHead !== pins[0])
    throw new Error(`--ecc-source HEAD ${eccHead || "(none)"} is not the Catalog pin ${pins.join(",") || "(none)"}`);
  const fixtureGit = (root, args) =>
    must(
      run("git", ["-c", "user.name=AIH Fixture", "-c", "user.email=fixture@example.invalid", ...args], root),
      `fixture git ${args[0]}`,
    );
  const governed = join(work, "fixture-governed");
  rmSync(governed, { recursive: true, force: true });
  mkdirSync(governed, { recursive: true });
  // Legacy schema-2 policy input stays accepted; a schema-3 selection needs pinned
  // authoring roots that no public command authors.
  writeFileSync(
    join(governed, "aih-org-policy.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        minimumPosture: "vibe",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          supportedClis: ["claude"],
          policyVersion: "w3-packed-proof-v1",
          catalog: { reviewed: [], custom: [] },
          externalSelections: [
            {
              framework: "ecc",
              items: [
                {
                  kind: "skill",
                  id: "skill:tdd-workflow",
                  source: { repository: "affaan-m/ECC", commit: eccHead, path: ".agents/skills/tdd-workflow" },
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  fixtureGit(governed, ["init", "-q"]);
  fixtureGit(governed, ["add", "-A"]);
  fixtureGit(governed, ["commit", "-qm", "policy"]);
  const bound = aih("bind the governed fixture", [
    "policy",
    "bind",
    "--root",
    governed,
    "--policy",
    join(governed, "aih-org-policy.json"),
    "--project",
    "w3-packed-proof",
    "--cli",
    "claude",
    "--apply",
    "--json",
    "--no-log",
  ]);
  check(
    "policy bind records the governed fixture's project binding",
    bound.status === 0 && json(bound)?.applied === true,
    `exit ${bound.status}; ${(json(bound)?.error?.message ?? bound.stderr).slice(0, 240)}`,
  );
  const projectArgs = [
    "policy",
    "project",
    "--root",
    governed,
    "--posture",
    "vibe",
    "--cli",
    "claude",
    "--ecc-path",
    eccSource,
    "--apply",
    "--json",
    "--no-log",
  ];
  const applied = aih("governed ECC delivery apply", projectArgs);
  const receiptPath = join(governed, ".aih", "ecc", "materialization-v1.json");
  const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : undefined;
  const owned = (receipt?.components ?? []).flatMap((component) =>
    (component.files ?? []).map((file) => (typeof file === "string" ? file : file.path)),
  );
  summary.governed = {
    applyExit: applied.status,
    receiptComponents: (receipt?.components ?? []).map((component) => component.id),
    ownedFiles: owned,
  };
  check(
    "policy project --apply delivers the selected ECC skill through the installed plugin",
    applied.status === 0 &&
      summary.governed.receiptComponents.join(",") === "skill:tdd-workflow" &&
      owned.length > 0 &&
      owned.every((path) => typeof path === "string" && existsSync(join(governed, path))),
    `exit ${applied.status}; ${owned.join(", ") || (json(applied)?.error?.message ?? applied.stderr).slice(0, 300)}`,
  );

  // ---- hook controls: policy, then the project's user list ----------------------------------------
  // Hook controls project only through verified authority: an administrator-protected
  // PolicyBundle V2 outside the target, named by AIH_ORG_POLICY.
  const hooks = join(work, "fixture-hooks");
  const bundle = join(work, "admin", "policies", "policy-bundle.json");
  rmSync(hooks, { recursive: true, force: true });
  rmSync(dirname(bundle), { recursive: true, force: true });
  mkdirSync(hooks, { recursive: true });
  mkdirSync(dirname(bundle), { recursive: true });
  const stamp = (offset) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, "Z");
  const issuedAt = stamp(-60 * 60 * 1000);
  writeFileSync(
    bundle,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        bundleVersion: "w3.1",
        issuer: "W3 packed proof",
        issuedAt,
        policy: {
          schemaVersion: 3,
          minimumCoreVersion: "0.7.0",
          minimumPosture: "enterprise",
          references: { repoContract: "ai-coding/project.json" },
          authoringSelections: {
            selectionVersion: "workbench-selection/v1",
            roots: [],
            exclusions: [],
            requests: [],
            drafts: [],
          },
          governance: {
            supportedClis: ["claude"],
            policyVersion: "w3-packed-proof-hooks-v1",
            catalog: { reviewed: [], custom: [] },
            frameworkHookControls: { ecc: { disabledHookIds: ["pre:write:doc-file-warning"] } },
          },
        },
        authorityReceipt: {
          format: "aih-policy-authority-receipt",
          version: 3,
          issuerRepository: "fictional-adopter/governance",
          issuedAt,
          expiresAt: stamp(7 * 24 * 60 * 60 * 1000),
          trustedIssuers: [{ id: "platform-security", githubRepository: "fictional-adopter/governance" }],
          targets: ["claude"],
          decisions: [],
          decisionRevocations: [],
        },
      },
      null,
      2,
    )}\n`,
  );
  const bundleEnv = { AIH_ORG_POLICY: bundle };
  const hookArgs = ["policy", "project", "--root", hooks, "--posture", "enterprise", "--cli", "claude", "--apply", "--json", "--no-log"];
  const settingsPath = join(hooks, ".claude", "settings.json");
  const settingsEnv = () => (existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")).env : undefined);
  const userList = (disabledHookIds) =>
    writeFileSync(
      join(hooks, ".aih-config.json"),
      `${JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", frameworkHookControls: { ecc: { disabledHookIds } } })}\n`,
    );
  const byPolicy = aih("hook controls: policy disables one ECC hook", hookArgs, bundleEnv);
  summary.hookControls = { policy: settingsEnv() };
  check(
    "a policy-disabled ECC hook reaches the projected Claude settings env",
    byPolicy.status === 0 && summary.hookControls.policy?.ECC_DISABLED_HOOKS === "pre:write:doc-file-warning",
    `exit ${byPolicy.status}; env ${JSON.stringify(summary.hookControls.policy)}`,
  );
  userList(["stop:desktop-notify"]);
  const byUser = aih("hook controls: the project's user list adds a disable", hookArgs, bundleEnv);
  summary.hookControls.policyAndUser = settingsEnv();
  check(
    "a user-list disable is added to the policy's in the projected env",
    byUser.status === 0 &&
      summary.hookControls.policyAndUser?.ECC_DISABLED_HOOKS === "pre:write:doc-file-warning,stop:desktop-notify",
    `exit ${byUser.status}; env ${JSON.stringify(summary.hookControls.policyAndUser)}`,
  );
  userList(["pre:bash:dispatcher"]);
  const ineligible = aih("hook controls: the user list names a hook ECC cannot disable", hookArgs, bundleEnv);
  check(
    "the plugin refuses a user-list hook that is not disable-eligible, leaving settings unchanged",
    ineligible.status !== 0 &&
      /not individually disable-eligible/.test(json(ineligible)?.error?.message ?? "") &&
      JSON.stringify(settingsEnv()) === JSON.stringify(summary.hookControls.policyAndUser),
    (json(ineligible)?.error?.message ?? ineligible.stderr).slice(0, 300),
  );
  userList(["stop:desktop-notify"]);

  // ---- plugin removed: refusals, then reinstall and finish the round trip ---------------------------
  must(npmRun(["uninstall", "--no-audit", "--no-fund", ECC], project), "project plugin uninstall");
  must(npmRun(["uninstall", "-g", "--prefix", globalPrefix, "--no-audit", "--no-fund", ECC], work), "global plugin uninstall");
  check(
    "the plugin is gone from the project and the global prefix; Core, Catalog and Superpowers stay",
    [join(project, "node_modules"), globalModules].every(
      (modules) =>
        !existsSync(join(modules, "@aihq", "framework-ecc")) &&
        ["core", "catalog", "framework-superpowers"].every((name) => existsSync(join(modules, "@aihq", name, "package.json"))),
    ),
  );
  const refusal = (result) => {
    const message = json(result)?.error?.message ?? "";
    return (
      result.status !== 0 &&
      json(result)?.error?.code === "AIH_FRAMEWORK_PLUGIN" &&
      message.startsWith("framework-plugin-unavailable:") &&
      message.includes("npm install -g @aihq/core @aihq/framework-ecc") &&
      !/\n\s+at /.test(`${result.stdout}\n${result.stderr}`)
    );
  };
  const refusalDetail = (result) => `exit ${result.status}; ${(json(result)?.error?.message ?? result.stderr).slice(0, 240)}`;
  const snapshot = (root) => {
    const files = {};
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else files[path.slice(root.length + 1).replaceAll("\\", "/")] = sha256(path);
      }
    };
    visit(root);
    return JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
  };
  summary.refusals = {};
  for (const [label, runner] of [
    ["project", aih],
    ["global", aihGlobal],
  ]) {
    const refused = runner(`plugin removed: aih ecc (${label} install)`, ["ecc", previewRoot, "--json", "--no-log"]);
    summary.refusals[`ecc-${label}`] = json(refused)?.error?.message;
    check(`aih ecc refuses with framework-plugin-unavailable and the install command (${label} install)`, refusal(refused), refusalDetail(refused));
  }
  const governedBefore = snapshot(governed);
  const refusedApply = aih("plugin removed: governed ECC delivery", projectArgs);
  summary.refusals.governedDelivery = json(refusedApply)?.error?.message;
  check("governed delivery with an ECC selection refuses and writes nothing", refusal(refusedApply) && snapshot(governed) === governedBefore, refusalDetail(refusedApply));
  const refusedUninstall = aih("plugin removed: uninstall with ECC state present", ["uninstall", governed, "--apply", "--force", "--json", "--no-log"]);
  summary.refusals.uninstall = json(refusedUninstall)?.error?.message;
  check("uninstall with aih ECC state present refuses and keeps the receipt", refusal(refusedUninstall) && snapshot(governed) === governedBefore, refusalDetail(refusedUninstall));
  const refusedPrune = aih("plugin removed: prune with ECC state present", ["prune", governed, "--apply", "--json", "--no-log"]);
  summary.refusals.prune = json(refusedPrune)?.error?.message;
  check("prune with aih ECC state present refuses and names the state", refusal(refusedPrune) && /\.aih[\\/]ecc\b/.test(json(refusedPrune)?.error?.message ?? "") && snapshot(governed) === governedBefore, refusalDetail(refusedPrune));
  const hooksBefore = snapshot(hooks);
  const refusedHooks = aih("plugin removed: hook controls", hookArgs, bundleEnv);
  summary.refusals.hookControls = json(refusedHooks)?.error?.message;
  check("hook controls naming ECC refuse and leave settings unchanged", refusal(refusedHooks) && snapshot(hooks) === hooksBefore, refusalDetail(refusedHooks));
  const notRun = /ECC checks were not run: framework-plugin-unavailable/;
  const doctor = aih("plugin removed: doctor", ["doctor", governed, "--json", "--no-log"]);
  const findCheck = (value) => {
    if (Array.isArray(value)) return value.map(findCheck).find(Boolean);
    if (value === null || typeof value !== "object") return undefined;
    if (value.name === "ECC checks") return value;
    return Object.values(value).map(findCheck).find(Boolean);
  };
  const doctorCheck = findCheck(json(doctor));
  summary.refusals.doctor = doctorCheck;
  check("doctor states the ECC checks were not run", notRun.test(doctorCheck?.detail ?? ""), JSON.stringify(doctorCheck ?? doctor.stdout.slice(0, 200)));
  const evaluate = aih("plugin removed: policy delivery report", ["policy", "evaluate", "--root", governed, "--cli", "claude", "--json", "--no-log"]);
  const evaluateNotRun = evaluate.stdout.match(/ECC checks were not run: [^"\\]*/)?.[0];
  summary.refusals.policyDeliveryReport = evaluateNotRun;
  check("the policy delivery report states the ECC checks were not run", evaluateNotRun !== undefined && notRun.test(evaluateNotRun), `exit ${evaluate.status}`);

  must(npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", packed.ecc], project), "project plugin reinstall");
  const uninstalled = aih("governed ECC uninstall after the plugin is reinstalled", ["uninstall", governed, "--apply", "--force", "--json", "--no-log"]);
  summary.governed.uninstallExit = uninstalled.status;
  summary.governed.eccCleanup = json(uninstalled)?.digests?.find?.((digest) => digest.data?.eccCleanup)?.data?.eccCleanup;
  check(
    "uninstall --apply removes the ECC receipt and every receipt-owned file",
    uninstalled.status === 0 &&
      summary.governed.eccCleanup?.state === "complete" &&
      !existsSync(receiptPath) &&
      owned.length > 0 &&
      owned.every((path) => !existsSync(join(governed, path))),
    refusalDetail(uninstalled),
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
  delete summary.json;
  const report = option("--report");
  if (report !== undefined) {
    mkdirSync(dirname(resolve(report)), { recursive: true });
    writeFileSync(
      resolve(report),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, ...summary }, null, 2)}\n`,
    );
  }
  const transcriptPath = option("--transcript");
  if (transcriptPath !== undefined) {
    mkdirSync(dirname(resolve(transcriptPath)), { recursive: true });
    writeFileSync(resolve(transcriptPath), `${transcript.join("\n")}\n`);
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!keep && option("--work") === undefined) rmSync(work, { recursive: true, force: true });
}
