#!/usr/bin/env node
/**
 * Packed-consumer proof of the Core/Catalog package boundary (WO Step 3A).
 *
 * `@aihq/catalog` is an optional peer of `@aihq/core`, and the historical ECC
 * runtime descriptor now arrives only through the INSTALLED Catalog's
 * `./catalog-runtime-descriptors.json`, accepted only against Core's pinned
 * sha256. This installs a packed Core tarball into disposable consumers OUTSIDE
 * every repository, always with `--ignore-scripts`, an empty npm user config and
 * never `npm link`, and checks:
 *
 *   Packed dist: no Catalog implementation bundled; `@aihq/catalog` imported
 *     only dynamically, from one module; the manifest declares it an optional
 *     peer only.
 *   Core-only consumer (neither Scan nor Catalog installed):
 *     - the package still starts up unaffected: the index loads
 *       `runSessionGuardrails`, `aih --version` and `aih --help` answer, and a
 *       TypeScript file importing `@aihq/core` compiles with skipLibCheck false;
 *     - `aih ecc --lifecycle install` on a temporary fixture whose schema-v3
 *       policy selects the historical ECC source now exits non-zero with the
 *       exact named refusal `catalog-package-unavailable`: no provenance line,
 *       no fallback to Core's embedded copy and no stack trace.
 *   Core + Scan + Catalog consumer (the given tarballs beside Core):
 *     - the same TypeScript file plus Catalog's public runtime-descriptor reader
 *       compiles with skipLibCheck false;
 *     - the same ECC route resolves the descriptor from `installed-catalog`, and a
 *       module resolve trace shows the INSTALLED node_modules/@aihq/catalog loaded;
 *     - after one byte of the installed descriptor is changed, the route refuses
 *       by name and does not fall back to Core's embedded copy.
 *
 * The fixture policy is hand-written: it reaches the descriptor resolution (the
 * proof's subject) and is then refused by the later Workbench consumption check,
 * even when the descriptor comes from `installed-catalog`, so this tool records
 * that refusal and never asserts a full ECC lifecycle success.
 *
 * usage:
 *   node tools/verify-packed-catalog-boundary.mjs --scan <aihq-scan.tgz> --catalog <aihq-catalog.tgz> [--incompatible-catalog <old.tgz>] (--core <aihq-core.tgz> --ecc-plugin <aihq-framework-ecc.tgz> | --stage-from <core-repo> [--core-version 0.7.0]) [--work <dir>] [--keep]
 *
 * `--stage-from` builds the given Core checkout's dist with its own tsup config
 * and declaration emit into a staging directory and packs that; it never writes
 * into the checkout. The work directory must not be inside a git repository.
 * Every consumer also installs `@aihq/framework-ecc`: the ECC route is the
 * plugin's, and the plugin reaches the Catalog only through Core. `--stage-from`
 * builds and packs it from the checkout's `packages/framework-ecc`; with `--core`,
 * pass its tarball as `--ecc-plugin`. No install bypasses peer validation: with
 * `--stage-from`, the staged Core (a copy; the checkout's manifest is never
 * edited) is versioned `<--core-version, default 0.7.0>+<checkout short sha>`,
 * which satisfies the plugin's `@aihq/core` peer range while naming the
 * checkout it was built from (a `-<sha>` prerelease would not satisfy it); a
 * `--core` tarball must satisfy it as it is. The one deliberately out-of-range
 * package, `--incompatible-catalog`, is first shown to be refused by npm itself,
 * then added on its own (the only `--legacy-peer-deps`) to a consumer whose
 * Core and plugin were installed peer-validated, so Core's runtime refusal of it
 * can be exercised.
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
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const toolRepo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ECC_REPOSITORY = "affaan-m/ECC";
const ECC_COMMIT = "5064474d4d762dc9640234a41617cccb79185cec";
const PINNED_SHA256 = "158f63e265f1ca18a7e65c97e372b1259200d6fb60eab87d70c20600d9d9abf0";
const DESCRIPTOR_PATH = `defaults/runtime-descriptors/github.com/${ECC_REPOSITORY}/${ECC_COMMIT}/ecc-runtime-descriptor-v1.json`;
const PROVENANCE = `historical ECC runtime descriptor ${ECC_REPOSITORY}@${ECC_COMMIT} sha256:${PINNED_SHA256} from `;
/** String literals that exist only inside Catalog's implementation, never in Core's source. */
const CATALOG_IMPLEMENTATION_MARKERS = [
  "descriptor-identity-mismatch",
  "source-not-in-index",
  "unordered-entries",
  "aih-catalog-runtime-descriptors",
];
const CATALOG_EXPORT_NAMES = [
  "readCatalogContentV1Result",
  "readCatalogRuntimeDescriptorsV1Result",
  "readCatalogRuntimeDescriptorsV1",
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
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  ];
  const lookup = run(process.platform === "win32" ? "where.exe" : "which", ["npm"], process.cwd());
  for (const value of (lookup.stdout || "").trim().split(/\r?\n/).filter(Boolean)) {
    candidates.push(join(dirname(value), "node_modules/npm/bin/npm-cli.js"));
  }
  const cli = candidates.find((path) => path && /npm-cli\.js$/.test(path) && existsSync(path));
  if (!cli) throw new Error("npm-cli.js not found");
  return cli;
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Regular files of a gzip'd npm tarball, by archive path (ustar headers; pax records skipped). */
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
    if (type === "0" || type === "\u0000")
      files.set(name, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const scanTarball = option("--scan");
const catalogTarball = option("--catalog");
const incompatibleCatalogTarball = option("--incompatible-catalog");
const coreTarballArg = option("--core");
const stageFrom = option("--stage-from");
const eccPluginTarballArg = option("--ecc-plugin");
const coreVersionBase = option("--core-version") ?? "0.7.0";
if (!scanTarball || !catalogTarball || (!coreTarballArg) === !stageFrom || (coreTarballArg !== undefined && !eccPluginTarballArg)) {
  process.stderr.write(
    "usage: verify-packed-catalog-boundary.mjs --scan <scan.tgz> --catalog <catalog.tgz> [--incompatible-catalog <old.tgz>] (--core <core.tgz> --ecc-plugin <framework-ecc.tgz> | --stage-from <core-repo> [--core-version 0.7.0]) [--work <dir>] [--keep]\n",
  );
  process.exit(2);
}
const keep = process.argv.includes("--keep");
const work = realpathSync(
  option("--work") !== undefined
    ? (mkdirSync(resolve(option("--work")), { recursive: true }), resolve(option("--work")))
    : mkdtempSync(join(tmpdir(), "aih-packed-catalog-boundary-")),
);
if (insideGitRepository(work)) throw new Error(`work directory ${work} is inside a git repository`);
const npm = npmCli();
const emptyUserConfig = join(work, "empty.npmrc");
writeFileSync(emptyUserConfig, "");
// The consumer's npm must not inherit configuration from whatever npm launched
// this tool: drop every inherited npm_config_* variable and point the user
// config at an empty file.
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

try {
  // ---- Core tarball ------------------------------------------------------
  let coreTarball = coreTarballArg === undefined ? undefined : resolve(coreTarballArg);
  let stagedCoreVersion;
  let eccPluginTarball = eccPluginTarballArg === undefined ? undefined : resolve(eccPluginTarballArg);
  if (stageFrom !== undefined) {
    const repo = resolve(stageFrom);
    const stage = join(work, "stage");
    mkdirSync(stage, { recursive: true });
    must(
      run(process.execPath, [join(repo, "node_modules/tsup/dist/cli-default.js"), "--out-dir", join(stage, "dist")], repo),
      "tsup",
    );
    must(
      run(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.dts.json", "--outDir", join(stage, "dist")], repo),
      "declaration emit",
    );
    cpSync(join(repo, "schemas"), join(stage, "schemas"), { recursive: true });
    const packageManifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    // The staged copy carries a version inside the plugin's peer range, with the
    // checkout's short sha as build metadata; the checkout's manifest is untouched.
    const shortSha = must(run("git", ["-C", repo, "rev-parse", "--short=8", "HEAD"], repo), "git rev-parse").trim();
    stagedCoreVersion = `${coreVersionBase}+${shortSha}`;
    writeFileSync(join(stage, "package.json"), `${JSON.stringify({ ...packageManifest, version: stagedCoreVersion }, null, 2)}\n`);
    for (const entry of packageManifest.files ?? []) {
      if (entry === "dist" || entry === "schemas" || entry.startsWith("!")) continue;
      const source = join(repo, entry);
      if (!existsSync(source)) continue;
      cpSync(source, join(stage, entry), { recursive: true });
    }
    const packed = JSON.parse(
      must(npmRun(["pack", "--json", "--ignore-scripts", "--pack-destination", work], stage), "npm pack"),
    );
    coreTarball = join(work, packed[0].filename);
    // The ECC framework plugin, built the same way from its own package.
    const pluginSource = join(repo, "packages", "framework-ecc");
    const pluginStage = join(work, "stage-framework-ecc");
    mkdirSync(pluginStage, { recursive: true });
    must(
      run(process.execPath, [join(repo, "node_modules/tsup/dist/cli-default.js"), "--out-dir", join(pluginStage, "dist")], pluginSource),
      "framework-ecc tsup",
    );
    for (const file of ["package.json", "README.md", "LICENSE"]) cpSync(join(pluginSource, file), join(pluginStage, file));
    const pluginPacked = JSON.parse(
      must(npmRun(["pack", "--json", "--ignore-scripts", "--pack-destination", work], pluginStage), "framework-ecc npm pack"),
    );
    eccPluginTarball = join(work, pluginPacked[0].filename);
  }
  const coreSha256 = sha256(coreTarball);
  process.stdout.write(`core tarball ${coreTarball} sha256 ${coreSha256}\n`);
  process.stdout.write(`scan tarball ${resolve(scanTarball)} sha256 ${sha256(resolve(scanTarball))}\n`);
  process.stdout.write(`framework-ecc tarball ${eccPluginTarball} sha256 ${sha256(eccPluginTarball)}\n`);
  process.stdout.write(`catalog tarball ${resolve(catalogTarball)} sha256 ${sha256(resolve(catalogTarball))}\n`);

  // ---- Packed dist: no Catalog implementation, one dynamic import --------
  const packedFiles = readPackedFiles(coreTarball);
  const text = new Map(
    [...packedFiles]
      .filter(([path]) => /^package\/dist\/[^/]+\.js$/.test(path))
      .map(([path, bytes]) => [path.slice("package/dist/".length), bytes.toString("utf8")]),
  );
  const markerHits = [...text].flatMap(([file, body]) =>
    CATALOG_IMPLEMENTATION_MARKERS.filter((marker) => body.includes(marker)).map((m) => `${file}: ${m}`),
  );
  // esbuild keepNames emits `name(fn,"exportName")` for every function it bundles.
  const definitionHits = [...text].flatMap(([file, body]) =>
    CATALOG_EXPORT_NAMES.filter((name) => new RegExp(`\\(\\s*[\\w$]+\\s*,\\s*"${name}"\\s*\\)`).test(body)).map(
      (name) => `${file}: defines ${name}`,
    ),
  );
  check("packed dist carries no Catalog implementation", markerHits.length + definitionHits.length === 0, [...markerHits, ...definitionHits].join("; "));
  const staticImports = [...text].filter(([, body]) => /from\s*"@aihq\/catalog"|import\s*"@aihq\/catalog"/.test(body)).map(([f]) => f);
  const dynamicImports = [...text].filter(([, body]) => /import\s*\(\s*"@aihq\/catalog"\s*\)/.test(body)).map(([f]) => f);
  check("packed dist imports @aihq/catalog only dynamically, from one module", staticImports.length === 0 && dynamicImports.length === 1, `static: ${staticImports.join(",") || "none"}; dynamic: ${dynamicImports.join(",") || "none"}`);
  const manifest = JSON.parse(
    (packedFiles.get("package/package.json") ?? Buffer.from("{}")).toString("utf8"),
  );
  check(
    "packed manifest declares @aihq/catalog as an optional peer only",
    manifest.peerDependencies?.["@aihq/catalog"] === ">=0.3.0 <0.4.0" &&
      manifest.peerDependenciesMeta?.["@aihq/catalog"]?.optional === true &&
      manifest.dependencies?.["@aihq/catalog"] === undefined,
    JSON.stringify({ peer: manifest.peerDependencies, meta: manifest.peerDependenciesMeta }),
  );
  check(
    "packed Core carries no Catalog authoring or qualification data",
    !packedFiles.has("package/dist/packaged-source-data-data.json") &&
      !packedFiles.has("package/dist/catalog-qualification-data.json") &&
      !packedFiles.has("package/dist/packaged-collection-evidence-data.json"),
  );

  // ---- Fixture and TypeScript sources ------------------------------------
  const fixture = join(work, "fixture-root");
  mkdirSync(fixture, { recursive: true });
  // A hand-written schema-v3 policy whose one ECC source tuple is the historical
  // revision, so `aih ecc --lifecycle install` takes the sealed-descriptor route.
  writeFileSync(
    join(fixture, "aih-org-policy.json"),
    `${JSON.stringify(
      {
        schemaVersion: 3,
        minimumPosture: "vibe",
        minimumCoreVersion: "0.6.0",
        references: { repoContract: "ai-coding/project.json" },
        authoringSelections: {
          selectionVersion: "workbench-selection/v1",
          roots: [],
          exclusions: [],
          requests: [],
          drafts: [],
        },
        governance: {
          policyVersion: "fixture-v1",
          catalog: { reviewed: [], custom: [] },
          externalSelections: [
            {
              framework: "ecc",
              items: [
                {
                  kind: "skill",
                  id: "skill:tdd-workflow",
                  source: { repository: ECC_REPOSITORY, commit: ECC_COMMIT, path: "skills/tdd-workflow/SKILL.md" },
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
  const policyFixture = join(work, "policy-fixture-root");
  mkdirSync(join(policyFixture, "ai-coding"), { recursive: true });
  writeFileSync(join(policyFixture, "ai-coding", "project.json"), "{}\n");
  writeFileSync(
    join(policyFixture, "aih-org-policy.json"),
    `${JSON.stringify(
      {
        schemaVersion: 3,
        minimumPosture: "vibe",
        minimumCoreVersion: "0.6.0",
        references: { repoContract: "ai-coding/project.json" },
        authoringSelections: {
          selectionVersion: "workbench-selection/v1",
          roots: [],
          exclusions: [],
          requests: [],
          drafts: [],
        },
      },
      null,
      2,
    )}\n`,
  );
  must(run("git", ["init", "--quiet"], policyFixture), "policy fixture git init");
  must(run("git", ["add", "aih-org-policy.json", "ai-coding/project.json"], policyFixture), "policy fixture git add");
  must(
    run(
      "git",
      ["-c", "user.name=W1 boundary proof", "-c", "user.email=w1-boundary@example.invalid", "commit", "--quiet", "-m", "fixture"],
      policyFixture,
    ),
    "policy fixture git commit",
  );
  // No machine-local source-data receipt may take precedence over the package carriers.
  const absentWorkbenchData = join(work, "absent-workbench-data");
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  const coreTs = [
    'import * as core from "@aihq/core";',
    "export const guardrails: typeof core.runSessionGuardrails = core.runSessionGuardrails;",
    "",
  ].join("\n");
  const typeRoot = join(toolRepo, "node_modules", "@types");
  const tsconfig = (files) =>
    JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        target: "es2022",
        module: "nodenext",
        moduleResolution: "nodenext",
        types: ["node"],
        typeRoots: [typeRoot],
      },
      files,
    });
  const tsc = join(toolRepo, "node_modules", "typescript", "bin", "tsc");
  const cli = (consumer) => join(consumer, "node_modules", "@aihq", "core", "dist", "cli.js");
  // Operator overrides that would change which policy or source is selected are removed.
  const routeEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(AIH_ORG_POLICY|AIH_ECC_REF|AIH_POLICY_AUTHORITY_REPOSITORY|AIH_WORKBENCH_DATA)$/iu.test(name),
      ),
    ),
    AIH_WORKBENCH_DATA: absentWorkbenchData,
    HOME: home,
    USERPROFILE: home,
  };
  const eccRoute = (consumer, extraNodeArgs = []) => {
    const result = spawnSync(
      process.execPath,
      [...extraNodeArgs, cli(consumer), "ecc", "--lifecycle", "install", "--root", fixture, "--no-log"],
      { cwd: work, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000, env: routeEnv },
    );
    if (result.error) throw new Error(`aih ecc: ${result.error.message}`);
    return result;
  };
  const policyRoute = (consumer, args, root = policyFixture) => {
    const result = spawnSync(process.execPath, [cli(consumer), ...args, "--root", root, "--no-log"], {
      cwd: work,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      env: routeEnv,
    });
    if (result.error) throw new Error(`aih policy ${args.join(" ")}: ${result.error.message}`);
    return result;
  };
  const output = (result) => `${result.stdout}\n${result.stderr}`;
  const provenanceOf = (result) =>
    output(result).split(/\r?\n/).find((line) => line.startsWith("historical ECC runtime descriptor ")) ?? "";
  /** The route's own refusal line, when it stopped after the resolution; recorded, not asserted. */
  const refusalLine = (result) =>
    output(result).split(/\r?\n/).find((line) => line.startsWith("error [")) ?? "<none>";
  const noStack = (result) => !/\n\s+at .+\(.+:\d+:\d+\)/.test(output(result));

  // ---- Core-only consumer -------------------------------------------------
  const coreOnly = join(work, "consumer-core-only");
  mkdirSync(coreOnly, { recursive: true });
  writeFileSync(join(coreOnly, "package.json"), JSON.stringify({ name: "core-only-consumer", private: true, type: "module" }));
  must(npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", coreTarball, eccPluginTarball], coreOnly), "Core-only install");
  const installedCoreVersion = JSON.parse(readFileSync(join(coreOnly, "node_modules", "@aihq", "core", "package.json"), "utf8")).version;
  const eccPeerRange = JSON.parse(readFileSync(join(coreOnly, "node_modules", "@aihq", "framework-ecc", "package.json"), "utf8")).peerDependencies?.["@aihq/core"];
  check(
    "Core-only: Core and the ECC plugin install with peer validation (no --legacy-peer-deps)",
    typeof eccPeerRange === "string" && eccPeerRange.length > 0,
    `@aihq/core ${installedCoreVersion}; @aihq/framework-ecc peer @aihq/core ${eccPeerRange}`,
  );
  check(
    "Core-only consumer has neither @aihq/scan nor @aihq/catalog installed (the ECC plugin is)",
    !existsSync(join(coreOnly, "node_modules", "@aihq", "catalog")) &&
      !existsSync(join(coreOnly, "node_modules", "@aihq", "scan")) &&
      existsSync(join(coreOnly, "node_modules", "@aihq", "framework-ecc", "package.json")),
  );
  // Startup and index load must be unaffected by the Catalog cutover.
  const coreOnlyLibrary = run(
    process.execPath,
    ["--input-type=module", "-e", "const m = await import('@aihq/core'); if (typeof m.runSessionGuardrails !== 'function') process.exit(3);"],
    coreOnly,
  );
  check("Core-only: @aihq/core index.js loads and exports runSessionGuardrails", coreOnlyLibrary.status === 0, coreOnlyLibrary.stderr.trim().slice(0, 300));
  const coreOnlyVersion = run(process.execPath, [cli(coreOnly), "--version"], coreOnly);
  check("Core-only: aih --version", coreOnlyVersion.status === 0, coreOnlyVersion.stdout.trim());
  const coreOnlyHelp = run(process.execPath, [cli(coreOnly), "--help"], coreOnly);
  check("Core-only: aih --help", coreOnlyHelp.status === 0 && coreOnlyHelp.stdout.includes("trust"), `exit ${coreOnlyHelp.status}`);
  writeFileSync(join(coreOnly, "consumer.ts"), coreTs);
  writeFileSync(join(coreOnly, "tsconfig.json"), tsconfig(["consumer.ts"]));
  const coreOnlyTypes = run(process.execPath, [tsc, "-p", "tsconfig.json"], coreOnly);
  check("Core-only: TypeScript consumer compiles with skipLibCheck false", coreOnlyTypes.status === 0, (coreOnlyTypes.stdout + coreOnlyTypes.stderr).trim().slice(0, 1500));
  // The historical ECC descriptor is Catalog-only now: the route must stop by
  // name instead of quietly reading Core's embedded copy.
  const coreOnlyRoute = eccRoute(coreOnly);
  const coreOnlyProvenance = provenanceOf(coreOnlyRoute);
  const coreOnlyOutput = output(coreOnlyRoute);
  const coreOnlyRefusal = refusalLine(coreOnlyRoute);
  check(
    "Core-only: the ECC route refuses by name because Catalog is not installed",
    coreOnlyRoute.status === 1 &&
      coreOnlyRefusal.includes("catalog-package-unavailable") &&
      coreOnlyProvenance === "" &&
      !coreOnlyOutput.includes("from core-embedded"),
    `exit ${coreOnlyRoute.status}; refusal: ${coreOnlyRefusal.slice(0, 300)}; provenance: ${coreOnlyProvenance || "<none>"}`,
  );
  check("Core-only: ECC route output carries no stack trace", noStack(coreOnlyRoute), `exit ${coreOnlyRoute.status}; refusal: ${coreOnlyRefusal.slice(0, 300)}`);
  const coreOnlyPolicy = policyRoute(coreOnly, ["policy", "evaluate"]);
  check(
    "Core-only: a Catalog-dependent policy command refuses as unavailable",
    coreOnlyPolicy.status === 1 && output(coreOnlyPolicy).includes("catalog-package-unavailable"),
    `exit ${coreOnlyPolicy.status}; ${output(coreOnlyPolicy).trim().slice(0, 400)}`,
  );

  // ---- Core + an explicitly incompatible older Catalog ------------------
  let incompatibleRefusal = "<not requested>";
  if (incompatibleCatalogTarball !== undefined) {
    const old = join(work, "consumer-core-incompatible-catalog");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "package.json"), JSON.stringify({ name: "core-incompatible-catalog-consumer", private: true, type: "module" }));
    // Core and the plugin first, peer-validated.
    must(npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", coreTarball, eccPluginTarball], old), "Core+plugin install");
    // npm itself refuses the out-of-range Catalog while peers are validated.
    const peerRefused = npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", resolve(incompatibleCatalogTarball)], old);
    check(
      "Core+incompatible-Catalog: npm refuses the out-of-range Catalog under peer validation",
      peerRefused.status !== 0 && /ERESOLVE|peer/i.test(`${peerRefused.stdout}\n${peerRefused.stderr}`),
      `exit ${peerRefused.status}`,
    );
    // Then that one deliberately incompatible package alone, so Core's own
    // runtime refusal of it is exercised.
    must(
      npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--legacy-peer-deps", resolve(incompatibleCatalogTarball)], old),
      "incompatible Catalog install (deliberately out of range)",
    );
    const oldRoute = eccRoute(old);
    incompatibleRefusal = refusalLine(oldRoute);
    check(
      "Core+incompatible-Catalog: the ECC route refuses the older package by name",
      oldRoute.status === 1 &&
        incompatibleRefusal.includes("catalog-package-incompatible") &&
        incompatibleRefusal.includes("version 0.2.0") &&
        provenanceOf(oldRoute) === "" &&
        !output(oldRoute).includes("core-embedded"),
      `exit ${oldRoute.status}; refusal: ${incompatibleRefusal.slice(0, 400)}`,
    );
    check("Core+incompatible-Catalog: refusal carries no stack trace", noStack(oldRoute));
  }

  // ---- Core + Scan + Catalog consumer --------------------------------------
  const full = join(work, "consumer-core-scan-catalog");
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, "package.json"), JSON.stringify({ name: "core-scan-catalog-consumer", private: true, type: "module" }));
  must(
    npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", coreTarball, eccPluginTarball, resolve(scanTarball), resolve(catalogTarball)], full),
    "Core+Scan+Catalog install",
  );
  const catalogManifest = JSON.parse(readFileSync(join(full, "node_modules", "@aihq", "catalog", "package.json"), "utf8"));
  process.stdout.write(`installed @aihq/catalog ${catalogManifest.version}\n`);
  const installedDescriptor = join(full, "node_modules", "@aihq", "catalog", ...DESCRIPTOR_PATH.split("/"));
  check(
    "Core+Scan+Catalog: the installed Catalog carries the descriptor bytes Core pins",
    existsSync(installedDescriptor) && sha256(installedDescriptor) === PINNED_SHA256,
    existsSync(installedDescriptor) ? sha256(installedDescriptor) : "<absent>",
  );
  const fullTs = [
    coreTs,
    'import { readCatalogRuntimeDescriptorsV1Result, type CatalogRuntimeDescriptorsV1Result } from "@aihq/catalog";',
    "export const read: (request: Parameters<typeof readCatalogRuntimeDescriptorsV1Result>[0]) => CatalogRuntimeDescriptorsV1Result = readCatalogRuntimeDescriptorsV1Result;",
    "",
  ].join("\n");
  writeFileSync(join(full, "consumer.ts"), fullTs);
  writeFileSync(join(full, "tsconfig.json"), tsconfig(["consumer.ts"]));
  const fullTypes = run(process.execPath, [tsc, "-p", "tsconfig.json"], full);
  check("Core+Scan+Catalog: TypeScript consumer with Catalog's reader compiles with skipLibCheck false", fullTypes.status === 0, (fullTypes.stdout + fullTypes.stderr).trim().slice(0, 1500));
  const traceLog = join(work, "catalog-module-trace.log");
  const trace = join(work, "catalog-module-trace.mjs");
  writeFileSync(
    trace,
    [
      'import { appendFileSync } from "node:fs";',
      'import { registerHooks } from "node:module";',
      "registerHooks({",
      "  resolve(specifier, context, nextResolve) {",
      "    const resolved = nextResolve(specifier, context);",
      `    if (/[\\\\/]@aihq[\\\\/]catalog[\\\\/]/.test(resolved.url)) appendFileSync(${JSON.stringify(traceLog)}, resolved.url + "\\n");`,
      "    return resolved;",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  const fullRoute = eccRoute(full, ["--import", pathToFileURL(trace).href]);
  const loaded = existsSync(traceLog) ? [...new Set(readFileSync(traceLog, "utf8").trim().split("\n"))] : [];
  const installedRoot = pathToFileURL(join(realpathSync(full), "node_modules", "@aihq", "catalog")).href.toLowerCase();
  check(
    "Core+Scan+Catalog: the ECC route loaded the INSTALLED @aihq/catalog",
    loaded.some((url) => url.toLowerCase() === `${installedRoot}/dist/index.js`),
    loaded.join(" ") || "<nothing traced>",
  );
  const fullProvenance = provenanceOf(fullRoute);
  const carrierPrefix = `${PROVENANCE}installed-catalog (@aihq/catalog ${catalogManifest.version}, aih-catalog-runtime-descriptors v1 sha256:`;
  check(
    "Core+Scan+Catalog: the ECC route resolved the descriptor from installed-catalog",
    fullProvenance.startsWith(carrierPrefix) &&
      fullProvenance.endsWith("); resolution: local-source-data=no-match, installed-catalog=selected"),
    fullProvenance || "<no provenance line>",
  );
  check("Core+Scan+Catalog: ECC route output carries no stack trace", noStack(fullRoute), `exit ${fullRoute.status}; refusal: ${refusalLine(fullRoute).slice(0, 300)}`);

  const policyCommands = ["validate", "evaluate", "project"];
  const policyCommandResults = Object.fromEntries(
    policyCommands.map((name) => [name, policyRoute(full, ["policy", name])]),
  );
  for (const name of policyCommands) {
    const result = policyCommandResults[name];
    check(
      `Core+Scan+Catalog: aih policy ${name} succeeds on a schema-v3 policy`,
      result.status === 0,
      `exit ${result.status}; ${output(result).trim().slice(0, 500)}`,
    );
  }
  const preparedSourceData = join(work, "prepared-ecc-source-data.json");
  const prepareResult = spawnSync(process.execPath, [
    cli(full),
    "policy",
    "data",
    "prepare",
    "--apply",
    "--source",
    "source:ecc",
    "--sequence",
    "1",
    "--out",
    preparedSourceData,
  ], {
    cwd: policyFixture,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    env: routeEnv,
  });
  let preparedFormat;
  try {
    preparedFormat = JSON.parse(readFileSync(preparedSourceData, "utf8")).version;
  } catch {
    preparedFormat = undefined;
  }
  check(
    "Core+Scan+Catalog: aih policy data prepare delegates and writes a v1 payload",
    prepareResult.status === 0 && preparedFormat === "workbench-source-data/v1",
    `exit ${prepareResult.status}; format ${preparedFormat ?? "<absent>"}; ${output(prepareResult).trim().slice(0, 400)}`,
  );

  // ---- Temporary global-prefix install ----------------------------------
  const globalPrefix = join(work, "global-prefix");
  mkdirSync(globalPrefix, { recursive: true });
  must(
    npmRun(
      ["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--prefix", globalPrefix, coreTarball, eccPluginTarball, resolve(scanTarball), resolve(catalogTarball)],
      work,
    ),
    "global-prefix install",
  );
  const globalCli = join(globalPrefix, "node_modules", "@aihq", "core", "dist", "cli.js");
  const globalVersion = run(process.execPath, [globalCli, "--version"], work);
  check("Global prefix: aih --version", globalVersion.status === 0, globalVersion.stdout.trim());
  const globalValidate = spawnSync(
    process.execPath,
    [globalCli, "policy", "validate", "--root", policyFixture, "--no-log"],
    { cwd: work, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000, env: routeEnv },
  );
  check(
    "Global prefix: schema-v3 policy validate resolves the installed Catalog peer",
    globalValidate.status === 0,
    `exit ${globalValidate.status}; ${output(globalValidate).trim().slice(0, 500)}`,
  );

  // ---- The installed Catalog is damaged: refusal, never the embedded copy --
  const bytes = readFileSync(installedDescriptor);
  const marker = Buffer.from('"compilerInputDigest":"sha256:');
  const at = bytes.indexOf(marker) + marker.length;
  bytes[at] = bytes[at] === 0x30 ? 0x31 : 0x30;
  writeFileSync(installedDescriptor, bytes);
  const damagedRoute = eccRoute(full);
  const damaged = output(damagedRoute);
  check(
    "Core+Scan+Catalog with one descriptor byte changed: the ECC route refuses by name and does not fall back",
    damagedRoute.status !== 0 &&
      damaged.includes("catalog-descriptor-unverified") &&
      damaged.includes("descriptor-digest-mismatch") &&
      !damaged.includes("core-embedded") &&
      provenanceOf(damagedRoute) === "",
    `exit ${damagedRoute.status}; refusal: ${refusalLine(damagedRoute).slice(0, 400)}`,
  );
  check("Core+Scan+Catalog damaged: refusal carries no stack trace", noStack(damagedRoute));

  const failed = results.filter((entry) => !entry.ok);
  const summary = {
      ok: failed.length === 0,
      work,
      coreTarball,
      coreSha256,
      stagedCoreVersion,
      installedCoreVersion,
      eccPeerRange,
      peerBypass: incompatibleCatalogTarball === undefined ? "none" : "only the deliberately incompatible Catalog",
      scanTarball: resolve(scanTarball),
      scanSha256: sha256(resolve(scanTarball)),
      catalogTarball: resolve(catalogTarball),
      catalogSha256: sha256(resolve(catalogTarball)),
      catalogVersion: catalogManifest.version,
      incompatibleCatalogTarball:
        incompatibleCatalogTarball === undefined ? undefined : resolve(incompatibleCatalogTarball),
      incompatibleRefusal: incompatibleRefusal.slice(0, 400),
      coreOnlyEccExit: coreOnlyRoute.status,
      coreOnlyProvenance,
      coreOnlyRefusal: coreOnlyRefusal.slice(0, 400),
      fullEccExit: fullRoute.status,
      policyCommandExits: Object.fromEntries(
        policyCommands.map((name) => [name, policyCommandResults[name].status]),
      ),
      policyDataPrepareExit: prepareResult.status,
      preparedSourceDataFormat: preparedFormat,
      globalPrefix,
      globalVersionExit: globalVersion.status,
      globalPolicyValidateExit: globalValidate.status,
      fullProvenance,
      fullRefusal: refusalLine(fullRoute).slice(0, 400),
      catalogModulesLoaded: loaded,
      damagedEccExit: damagedRoute.status,
      damagedRefusal: refusalLine(damagedRoute).slice(0, 400),
      failed: failed.map((entry) => entry.name),
    };
  const jsonOutput = option("--json-output");
  if (jsonOutput !== undefined) {
    mkdirSync(dirname(resolve(jsonOutput)), { recursive: true });
    writeFileSync(resolve(jsonOutput), `${JSON.stringify(summary, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  if (!keep && option("--work") === undefined) rmSync(work, { recursive: true, force: true });
}
