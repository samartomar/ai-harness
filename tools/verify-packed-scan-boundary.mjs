#!/usr/bin/env node
/**
 * Packed-consumer proof of the Core/Scan package boundary (WO Step 1).
 *
 * `@aihq/scan` is an optional peer of `@aihq/core`. This installs a packed Core
 * tarball into disposable consumers OUTSIDE every repository, always with
 * `--ignore-scripts`, an empty npm user config and never `npm link`, and checks:
 *
 *   Core-only consumer (Scan absent):
 *     - `@aihq/core`'s index.js and `aih --version` / `aih --help` load;
 *     - a TypeScript file importing `@aihq/core` compiles with skipLibCheck false;
 *     - `aih trust scan <temporary fixture>` keeps every Core detector in Core,
 *       names them `core-legacy`, and states `scan-package-unavailable` with the
 *       install command, without a stack trace.
 *   Core + Scan consumer (the given Scan tarball beside Core):
 *     - the same TypeScript file plus Scan's public functions typed as Core's
 *       adapter seams compiles with skipLibCheck false;
 *     - `aih trust scan <temporary fixture>` loads the INSTALLED Scan (a module
 *       resolve trace names node_modules/@aihq/scan/dist files), records Scan's
 *       `detector.aih-native` identity observation under `in-process-native-v1`
 *       (or states `scan-package-incompatible` for a Scan without the runner),
 *       and still attributes no Core detector result to Scan;
 *   and the packed Core `dist/` holds no Scan implementation and imports
 *   `@aihq/scan` only dynamically, from one module.
 *
 * usage:
 *   node tools/verify-packed-scan-boundary.mjs --scan <aihq-scan.tgz> (--core <aihq-core.tgz> | --stage-from <core-repo>) [--work <dir>] [--keep]
 *
 * `--stage-from` builds the given Core checkout's dist with its own tsup config
 * and declaration emit into a staging directory and packs that; it never writes
 * into the checkout. The work directory must not be inside a git repository.
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
const SCAN_OWNED = ["skillspector", "cisco", "semgrep"];
const INSTALL_COMMAND = "npm install -g @aihq/core @aihq/scan";
/**
 * String literals that exist only inside Scan's implementation, never in Core's
 * source. Each was present in the packed Core of 8a111b84, which bundled Scan.
 */
const SCAN_IMPLEMENTATION_MARKERS = [
  "request canonical bytes require validated value",
  "receipt canonical bytes require validated value",
  "BaselineVetAttestationV1 envelope",
  "canonical JSON requires own data properties",
  "Cisco linux/amd64 must be first supported platform",
];
const SCAN_EXPORT_NAMES = [
  "canonicalBaselineVetRequestV1Bytes",
  "createBaselineVetRequestV1",
  "verifyBaselineVetAttestationV1",
  "verifyScanAttestationV2",
  "listDetectorCapabilitiesV1",
  "runDetectorV1",
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
const coreTarballArg = option("--core");
const stageFrom = option("--stage-from");
if (!scanTarball || (!coreTarballArg) === !stageFrom) {
  process.stderr.write(
    "usage: verify-packed-scan-boundary.mjs --scan <scan.tgz> (--core <core.tgz> | --stage-from <core-repo>) [--work <dir>] [--keep]\n",
  );
  process.exit(2);
}
const keep = process.argv.includes("--keep");
const work = realpathSync(
  option("--work") !== undefined
    ? (mkdirSync(resolve(option("--work")), { recursive: true }), resolve(option("--work")))
    : mkdtempSync(join(tmpdir(), "aih-packed-scan-boundary-")),
);
if (insideGitRepository(work)) throw new Error(`work directory ${work} is inside a git repository`);
const npm = npmCli();
const emptyUserConfig = join(work, "empty.npmrc");
writeFileSync(emptyUserConfig, "");
// The consumer's npm must not inherit configuration from whatever npm launched
// this tool (for example a repository's own `npm test`): drop every inherited
// npm_config_* variable and point the user config at an empty file.
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
    cpSync(join(repo, "package.json"), join(stage, "package.json"));
    cpSync(join(repo, "schemas"), join(stage, "schemas"), { recursive: true });
    const packed = JSON.parse(
      must(npmRun(["pack", "--json", "--ignore-scripts", "--pack-destination", work], stage), "npm pack"),
    );
    coreTarball = join(work, packed[0].filename);
  }
  const coreSha256 = sha256(coreTarball);
  process.stdout.write(`core tarball ${coreTarball} sha256 ${coreSha256}\n`);
  process.stdout.write(`scan tarball ${resolve(scanTarball)} sha256 ${sha256(resolve(scanTarball))}\n`);

  // ---- Packed dist: no Scan implementation, one dynamic import -----------
  const packedFiles = readPackedFiles(coreTarball);
  const text = new Map(
    [...packedFiles]
      .filter(([path]) => /^package\/dist\/[^/]+\.js$/.test(path))
      .map(([path, bytes]) => [path.slice("package/dist/".length), bytes.toString("utf8")]),
  );
  const markerHits = [...text].flatMap(([file, body]) =>
    SCAN_IMPLEMENTATION_MARKERS.filter((marker) => body.includes(marker)).map((m) => `${file}: ${m}`),
  );
  // esbuild keepNames emits `name(fn,"exportName")` for every function it bundles.
  const definitionHits = [...text].flatMap(([file, body]) =>
    SCAN_EXPORT_NAMES.filter((name) => new RegExp(`\\(\\s*[\\w$]+\\s*,\\s*"${name}"\\s*\\)`).test(body)).map(
      (name) => `${file}: defines ${name}`,
    ),
  );
  check("packed dist carries no Scan implementation", markerHits.length + definitionHits.length === 0, [...markerHits, ...definitionHits].join("; "));
  const staticScanImports = [...text].filter(([, body]) => /from\s*"@aihq\/scan"|import\s*"@aihq\/scan"/.test(body)).map(([f]) => f);
  const dynamicScanImports = [...text].filter(([, body]) => /import\s*\(\s*"@aihq\/scan"\s*\)/.test(body)).map(([f]) => f);
  check("packed dist imports @aihq/scan only dynamically, from one module", staticScanImports.length === 0 && dynamicScanImports.length === 1, `static: ${staticScanImports.join(",") || "none"}; dynamic: ${dynamicScanImports.join(",") || "none"}`);
  const manifest = JSON.parse(
    (packedFiles.get("package/package.json") ?? Buffer.from("{}")).toString("utf8"),
  );
  check(
    "packed manifest declares @aihq/scan as an optional peer only",
    manifest.peerDependencies?.["@aihq/scan"] === ">=0.4.0 <1.0.0" &&
      manifest.peerDependenciesMeta?.["@aihq/scan"]?.optional === true &&
      manifest.dependencies?.["@aihq/scan"] === undefined,
    JSON.stringify({ peer: manifest.peerDependencies, meta: manifest.peerDependenciesMeta }),
  );

  // ---- Fixture and TypeScript sources ------------------------------------
  const fixture = join(work, "fixture-root");
  mkdirSync(join(fixture, "skills", "demo"), { recursive: true });
  writeFileSync(join(fixture, "SKILL.md"), "# Fixture skill\n\nUse this skill for fixture hygiene.\n");
  writeFileSync(join(fixture, "skills", "demo", "SKILL.md"), "# Demo\n\nNothing alarming here.\n");
  const coreTs = [
    'import * as core from "@aihq/core";',
    'import type { ScanExecutionAdapterV1, ScanVerificationAdapterV1 } from "@aihq/core";',
    "export const guardrails: typeof core.runSessionGuardrails = core.runSessionGuardrails;",
    "export type Seams = [ScanExecutionAdapterV1, ScanVerificationAdapterV1];",
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
  const trustScan = (consumer, extraNodeArgs = []) => {
    const result = run(
      process.execPath,
      [...extraNodeArgs, cli(consumer), "trust", "scan", fixture, "--root", fixture, "--json", "--no-log"],
      work,
    );
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      report = undefined;
    }
    return { result, report };
  };
  const detectorDetails = (report) => {
    const details = {};
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (value === null || typeof value !== "object") return;
      if (typeof value.name === "string" && value.name.startsWith("trust detector ") && typeof value.detail === "string")
        details[value.name.slice("trust detector ".length)] = { detail: value.detail, verdict: value.verdict };
      Object.values(value).forEach(visit);
    };
    visit(report);
    return details;
  };
  const advisoryOf = (report) =>
    (report?.digests ?? []).find((digest) => digest?.describe === "trust runtime advisory")?.text ?? "";
  const noStack = (result) => !/\n\s+at .+\(.+:\d+:\d+\)/.test(`${result.stdout}\n${result.stderr}`);
  // Step 1 delegates no detector to Scan: Core keeps executing all of them and says so.
  const CORE_EXECUTORS = "Detector executors: skillspector=core-legacy, cisco=core-legacy, semgrep=core-legacy";

  // ---- Core-only consumer -------------------------------------------------
  const coreOnly = join(work, "consumer-core-only");
  mkdirSync(coreOnly, { recursive: true });
  writeFileSync(join(coreOnly, "package.json"), JSON.stringify({ name: "core-only-consumer", private: true, type: "module" }));
  must(npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", coreTarball], coreOnly), "Core-only install");
  check("Core-only consumer has no @aihq/scan installed", !existsSync(join(coreOnly, "node_modules", "@aihq", "scan")));
  const library = run(process.execPath, ["--input-type=module", "-e", "const m = await import('@aihq/core'); if (typeof m.runSessionGuardrails !== 'function') process.exit(3);"], coreOnly);
  check("Core-only: @aihq/core index.js loads", library.status === 0, library.stderr.trim().slice(0, 300));
  const version = run(process.execPath, [cli(coreOnly), "--version"], coreOnly);
  check("Core-only: aih --version", version.status === 0, version.stdout.trim());
  const help = run(process.execPath, [cli(coreOnly), "--help"], coreOnly);
  check("Core-only: aih --help", help.status === 0 && help.stdout.includes("trust"), `exit ${help.status}`);
  writeFileSync(join(coreOnly, "consumer.ts"), coreTs);
  writeFileSync(join(coreOnly, "tsconfig.json"), tsconfig(["consumer.ts"]));
  const coreOnlyTypes = run(process.execPath, [tsc, "-p", "tsconfig.json"], coreOnly);
  check("Core-only: TypeScript consumer compiles with skipLibCheck false", coreOnlyTypes.status === 0, (coreOnlyTypes.stdout + coreOnlyTypes.stderr).trim().slice(0, 1500));
  const coreOnlyScan = trustScan(coreOnly);
  const coreOnlyAdvisory = advisoryOf(coreOnlyScan.report);
  const coreOnlyObservation =
    coreOnlyAdvisory.split("\n").find((line) => line.startsWith("@aihq/scan observation")) ?? "";
  check(
    "Core-only: trust scan states scan-package-unavailable with the install command",
    coreOnlyObservation.includes("scan-package-unavailable") &&
      coreOnlyObservation.includes(INSTALL_COMMAND),
    coreOnlyObservation || "<no observation line>",
  );
  check(
    "Core-only: every Core detector keeps Core's execution and is named core-legacy",
    coreOnlyAdvisory.includes(CORE_EXECUTORS),
    coreOnlyAdvisory.split("\n").find((line) => line.startsWith("Detector executors")) ?? "<none>",
  );
  check("Core-only: trust scan output carries no stack trace", noStack(coreOnlyScan.result), `exit ${coreOnlyScan.result.status}`);

  // ---- Core + Scan consumer -----------------------------------------------
  const withScan = join(work, "consumer-core-scan");
  mkdirSync(withScan, { recursive: true });
  writeFileSync(join(withScan, "package.json"), JSON.stringify({ name: "core-scan-consumer", private: true, type: "module" }));
  must(npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", coreTarball, resolve(scanTarball)], withScan), "Core+Scan install");
  const scanManifest = JSON.parse(readFileSync(join(withScan, "node_modules", "@aihq", "scan", "package.json"), "utf8"));
  const exported = run(process.execPath, ["--input-type=module", "-e", "const m = await import('@aihq/scan'); console.log(JSON.stringify({ runner: typeof m.runDetectorV1 === 'function' && typeof m.listDetectorCapabilitiesV1 === 'function' }));"], withScan);
  const runner = JSON.parse(must(exported, "Scan export probe")).runner === true;
  process.stdout.write(`installed @aihq/scan ${scanManifest.version}; exports the detector runner: ${runner}\n`);
  const scanTs = [
    coreTs,
    'import * as scan from "@aihq/scan";',
    "export const verification: ScanVerificationAdapterV1 = {",
    "  verifyScanAttestationV2: (input) => scan.verifyScanAttestationV2(input as never),",
    "  projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1: (input) => scan.projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1(input as never),",
    "  canonicalCoreOrganizationEvidenceEnvelopeV1Bytes: (value) => scan.canonicalCoreOrganizationEvidenceEnvelopeV1Bytes(value as never),",
    "};",
    ...(runner
      ? [
          "// Scan's own public functions ARE Core's execution adapter, with no narrowing.",
          "export const execution: ScanExecutionAdapterV1 = {",
          "  listDetectorCapabilitiesV1: scan.listDetectorCapabilitiesV1,",
          "  runDetectorV1: scan.runDetectorV1,",
          "};",
        ]
      : []),
    "",
  ].join("\n");
  writeFileSync(join(withScan, "consumer.ts"), scanTs);
  writeFileSync(join(withScan, "tsconfig.json"), tsconfig(["consumer.ts"]));
  const withScanTypes = run(process.execPath, [tsc, "-p", "tsconfig.json"], withScan);
  check(
    `Core+Scan: TypeScript consumer with Scan's adapters compiles with skipLibCheck false${runner ? "" : " (this Scan exports no detector runner; execution adapter typing not checked)"}`,
    withScanTypes.status === 0,
    (withScanTypes.stdout + withScanTypes.stderr).trim().slice(0, 1500),
  );
  const traceLog = join(work, "scan-module-trace.log");
  const trace = join(work, "scan-module-trace.mjs");
  writeFileSync(
    trace,
    [
      'import { appendFileSync } from "node:fs";',
      'import { registerHooks } from "node:module";',
      "registerHooks({",
      "  resolve(specifier, context, nextResolve) {",
      "    const resolved = nextResolve(specifier, context);",
      `    if (/[\\\\/]@aihq[\\\\/]scan[\\\\/]/.test(resolved.url)) appendFileSync(${JSON.stringify(traceLog)}, resolved.url + "\\n");`,
      "    return resolved;",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  const withScanScan = trustScan(withScan, ["--import", pathToFileURL(trace).href]);
  const loaded = existsSync(traceLog) ? [...new Set(readFileSync(traceLog, "utf8").trim().split("\n"))] : [];
  const installedRoot = pathToFileURL(join(realpathSync(withScan), "node_modules", "@aihq", "scan", "dist")).href.toLowerCase();
  check(
    "Core+Scan: trust scan loaded the INSTALLED @aihq/scan",
    loaded.some((url) => url.toLowerCase().startsWith(`${installedRoot}/index.js`)) &&
      (!runner || loaded.some((url) => url.toLowerCase().startsWith(`${installedRoot}/runner/run-detector-v1.js`))),
    loaded.filter((url) => /index\.js$|run-detector-v1\.js$/.test(url)).join(" "),
  );
  const withScanAdvisory = advisoryOf(withScanScan.report);
  const withScanObservation =
    withScanAdvisory.split("\n").find((line) => line.startsWith("@aihq/scan observation")) ?? "";
  check(
    runner
      ? "Core+Scan: the installed @aihq/scan recorded detector.aih-native under in-process-native-v1 with an annex digest"
      : "Core+Scan: this Scan predates the runner, and the trust scan says scan-package-incompatible",
    runner
      ? withScanObservation.startsWith(
          "@aihq/scan observation detector.aih-native recorded by the installed @aihq/scan",
        ) &&
          withScanObservation.includes("under execution profile in-process-native-v1") &&
          /annex sha256 [0-9a-f]{64}/.test(withScanObservation)
      : withScanObservation.includes("scan-package-incompatible"),
    withScanObservation || "<no observation line>",
  );
  check(
    "Core+Scan: every Core detector keeps Core's execution and is named core-legacy",
    withScanAdvisory.includes(CORE_EXECUTORS),
    withScanAdvisory.split("\n").find((line) => line.startsWith("Detector executors")) ?? "<none>",
  );
  const withScanDetails = detectorDetails(withScanScan.report);
  check(
    "Core+Scan: no Core detector result is attributed to Scan",
    SCAN_OWNED.every((name) => !(withScanDetails[name]?.detail ?? "").includes("@aihq/scan")),
    SCAN_OWNED.map((name) => `${name}: ${withScanDetails[name]?.verdict ?? "<missing>"}`).join(", "),
  );
  check("Core+Scan: trust scan output carries no stack trace", noStack(withScanScan.result), `exit ${withScanScan.result.status}`);

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(
    `${JSON.stringify({
      ok: failed.length === 0,
      work,
      coreTarball,
      coreSha256,
      scanTarball: resolve(scanTarball),
      scanSha256: sha256(resolve(scanTarball)),
      scanVersion: scanManifest.version,
      scanExportsRunner: runner,
      coreOnlyTrustScanExit: coreOnlyScan.result.status,
      coreScanTrustScanExit: withScanScan.result.status,
      coreOnlyObservation,
      coreScanObservation: withScanObservation,
      scanModulesLoaded: loaded.filter((url) => /index.js$|run-detector-v1.js$/.test(url)),
      failed: failed.map((entry) => entry.name),
    })}\n`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  if (!keep && option("--work") === undefined) rmSync(work, { recursive: true, force: true });
}
