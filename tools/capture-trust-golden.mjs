#!/usr/bin/env node
/**
 * Golden capture for Core -> Scan detector delegation (W2, step 1).
 *
 * Runs Core's CURRENT trust engines through their library entry point
 * (`scanTrustTreeWithAnalyzers`) against every case of
 * tests/fixtures/trust-parity/cases.json, each copied to a fresh temporary root,
 * and writes normalized golden outputs: check name/code, relative path, line,
 * multiplicity (one entry per check, in Core's order), detector availability and
 * the raw analyzer occurrences Core recorded. It never runs the aih CLI and never
 * points any engine at a checkout.
 *
 *   node --import tsx tools/capture-trust-golden.mjs capture --label <env> --detectors <list>
 *        --fixtures <dir> --out <dir> [--transcripts <dir>] [--core-commit <sha>] [--cases a,b]
 *   node --import tsx tools/capture-trust-golden.mjs recorded-snyk --label <env>
 *        --fixtures <dir> --out <dir> [--core-commit <sha>]
 *   node --import tsx tools/capture-trust-golden.mjs merge --fixtures <dir> --out <golden dir>
 *        <partial dir>...
 *
 * `--detectors` takes `native` and any of skillspector, cisco, semgrep,
 * snyk-agent-scan, mcp-scanner. Each detector runs in its own scan with only that
 * detector selected; its checks are the slice Core appends after the native checks.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, platform as hostPlatform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRunner, fakeRunner } from "../src/internals/proc.ts";
import {
  SKILLSPECTOR_IMAGE,
  SKILLSPECTOR_IMAGE_DIGEST,
  SKILLSPECTOR_SOURCE_REVISION,
} from "../src/trust/images.ts";
import { scanTrustTreeWithAnalyzers } from "../src/trust/scan.ts";
import {
  CISCO_MCP_SCANNER_PROJECT,
  CISCO_MCP_SCANNER_VERSION,
  CISCO_SKILL_SCANNER_PROJECT,
  CISCO_SKILL_SCANNER_VERSION,
  SEMGREP_PROJECT,
  SEMGREP_VERSION,
  SNYK_AGENT_SCAN_PROJECT,
  SNYK_AGENT_SCAN_VERSION,
} from "../src/trust/scanner-runtime-identity.ts";

const GOLDEN_FORMAT = "aih-trust-parity-golden";
const GOLDEN_VERSION = 1;
const POSTURE = "vibe";
const RUNTIME_DETECTORS = ["skillspector", "cisco", "semgrep", "snyk-agent-scan", "mcp-scanner"];
const SCAN_DETECTOR_IDS = {
  native: "detector.aih-trust-lint",
  skillspector: "detector.skillspector",
  cisco: "detector.cisco",
  semgrep: "detector.semgrep",
  "snyk-agent-scan": "detector.snyk-agent-scan",
  "mcp-scanner": "detector.cisco-mcp-scanner",
};
const MAX_TRANSCRIPT_STDOUT = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_STDERR = 64 * 1024;

const LINT_NAMES = new Set([
  "trust.prompt-injection",
  "trust.external-egress",
  "trust.hidden-unicode",
  "trust.visible-unicode",
]);
const TRUST_LINT_NAMES = new Set([
  ...LINT_NAMES,
  "trust.auto-exec-hook",
  "trust.permission-risk",
  "trust.typosquat",
  "trust.dependency-confusion",
  "trust.unpinned-dependency",
  "trust.malicious-code",
  "plaintext-secret",
  "mcp-hardcoded-secret",
  "mcp-config-invalid",
]);
const MCP_POLICY_NAMES = new Set([
  "mcp.policy-denied",
  "incoming MCP policy",
  "skills-over-MCP evidence",
]);

function fail(message) {
  console.error(`capture-trust-golden: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { positional: [] };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg.startsWith("--")) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      index++;
    } else {
      options.positional.push(arg);
    }
  }
  return { command, options };
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) fail(`--${key} is required`);
  return value;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function corePlatform() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

// ---------------------------------------------------------------------------
// Normalization: temporary roots and host paths never reach a golden.
// ---------------------------------------------------------------------------

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathForms(path) {
  const forms = new Set();
  for (const candidate of [path, safeRealpath(path)]) {
    if (candidate === undefined || candidate.length < 4) continue;
    const posix = candidate.replace(/\\/g, "/");
    for (const form of [candidate, posix, `/${posix}`]) {
      forms.add(form);
      if (/^[A-Za-z]:/.test(form)) {
        forms.add(form[0].toLowerCase() + form.slice(1));
        forms.add(form[0].toUpperCase() + form.slice(1));
      }
    }
  }
  return [...forms];
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function makeNormalizer(root, context) {
  const replacements = [];
  const add = (path, token) => {
    if (path === undefined) return;
    for (const form of pathForms(path)) {
      replacements.push([form, token]);
      // The same path inside JSON text (analyzer stdout) has its backslashes escaped.
      if (form.includes("\\")) replacements.push([form.replace(/\\/g, "\\\\"), token]);
    }
  };
  if (root !== undefined) add(root, "<root>");
  add(context.coreRoot, "<core>");
  if (context.uvCacheDir !== undefined) add(context.uvCacheDir, "<uv-cache>");
  add(tmpdir(), "<tmp>");
  add(homedir(), "<home>");
  replacements.sort((left, right) => right[0].length - left[0].length);
  return (value) => {
    if (typeof value !== "string") return value;
    // Semgrep prefixes each rule id with the dotted path of the config file Core
    // wrote into a fresh temporary directory, e.g.
    // "C.Users.<user>.AppData.Local.Temp.aih-semgrep-rules-AbC123.semgrep.prompt-injection".
    let out = value.replace(
      /(?:[A-Za-z0-9_~-]+\.)*aih-semgrep-rules-[A-Za-z0-9]{6}\.(?=semgrep\.)/g,
      "<semgrep-config-dir>.",
    );
    for (const [from, token] of replacements) {
      out = out.replace(new RegExp(escapeRegExp(from), "g"), token);
    }
    return out
      .replace(/aih-(semgrep-rules|cisco-sarif|mcp-scanner)-[A-Za-z0-9]{6}/g, "aih-$1-<random>")
      .replace(/aih-skillspector-[0-9a-f-]{36}/g, "aih-skillspector-<uuid>");
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

function loadCases(fixtures, only) {
  const manifest = readJson(join(fixtures, "cases.json"));
  if (manifest.format !== "aih-trust-parity-corpus" || manifest.version !== 1)
    fail("cases.json is not an aih-trust-parity-corpus v1 manifest");
  const selected = only === undefined ? undefined : new Set(only.split(","));
  return manifest.cases.filter((entry) => selected === undefined || selected.has(entry.id));
}

/**
 * Copy file CONTENTS only, so every file gets the creating process's default mode
 * the way a fresh checkout does (a bind-mounted source can report other modes).
 */
function copyTreeContents(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(target, { recursive: true });
      copyTreeContents(source, target);
    } else if (entry.isFile()) {
      writeFileSync(target, readFileSync(source));
    } else {
      fail(`fixture ${source} is neither a regular file nor a directory`);
    }
  }
}

/** A fresh temporary root holding exactly the case's files. */
function materializeCase(fixtures, entry) {
  const root = mkdtempSync(join(tmpdir(), "aih-trust-golden-"));
  if (entry.tree !== null) copyTreeContents(join(fixtures, ...entry.tree.split("/")), root);
  for (const item of entry.materialize ?? []) {
    const target = join(root, ...item.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    if (typeof item.utf8 === "string") writeFileSync(target, item.utf8, "utf8");
    else if (typeof item.base64 === "string") writeFileSync(target, Buffer.from(item.base64, "base64"));
    else fail(`case ${entry.id}: materialize entry ${item.path} has no content`);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Checks and occurrences
// ---------------------------------------------------------------------------

function familyOf(check) {
  if (check.name === "trust scan") return "summary";
  if (check.name === "skill sandbox smoke test") return "sandbox-smoke";
  if (MCP_POLICY_NAMES.has(check.name)) return "mcp-policy";
  if (LINT_NAMES.has(check.name) && (check.location?.uri ?? "").includes("#"))
    return "mcp-description-lint";
  if (TRUST_LINT_NAMES.has(check.name)) return "trust-lint";
  fail(`unclassified native check ${JSON.stringify(check.name)}`);
  return undefined;
}

function goldenCheck(check, normalize, family) {
  const detail = check.detail === undefined ? null : normalize(check.detail);
  return {
    ...(family === undefined ? {} : { family }),
    name: check.name,
    verdict: check.verdict,
    code: check.code ?? null,
    uri: check.location?.uri ?? null,
    startLine: check.location?.startLine ?? null,
    detail,
    fingerprint: check.fingerprint ?? null,
    ...(detail !== (check.detail ?? null) ? { hostDependentDetail: true } : {}),
  };
}

function goldenOccurrence(occurrence, normalize) {
  const message = normalize(occurrence.message);
  const ruleId = normalize(occurrence.ruleId);
  return {
    analyzer: occurrence.analyzer,
    ruleId,
    level: occurrence.level ?? null,
    message,
    uri: occurrence.location?.uri ?? null,
    startLine: occurrence.location?.startLine ?? null,
    sourceValue: occurrence.sourceValue ?? null,
    fingerprint: occurrence.fingerprint,
    ...(message !== occurrence.message ? { hostDependentMessage: true } : {}),
    // A host-dependent rule id also makes this row's and its check's fingerprints host-dependent.
    ...(ruleId !== occurrence.ruleId ? { hostDependentRuleId: true } : {}),
  };
}

function nativeNonSmoke(checks) {
  // Core appends the sandbox smoke check last, and emits the summary pass check
  // only when nothing else was found.
  const withoutSmoke = checks.slice(0, -1);
  return withoutSmoke.length === 1 && withoutSmoke[0].name === "trust scan" ? [] : withoutSmoke;
}

// ---------------------------------------------------------------------------
// Recording runner: Core's own defaultRunner, with every call written down.
// ---------------------------------------------------------------------------

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function bounded(text, limit) {
  if (typeof text !== "string") return text;
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]` : text;
}

function recordingRunner(base, calls) {
  return async (argv, opts = {}) => {
    const toolsIndex = argv.indexOf("--tools");
    const toolsInput = toolsIndex >= 0 ? safeRead(argv[toolsIndex + 1]) : undefined;
    const started = Date.now();
    const result = await base(argv, opts);
    const outputIndex = argv.indexOf("--output-sarif");
    const outputSarif = outputIndex >= 0 ? safeRead(argv[outputIndex + 1]) : undefined;
    calls.push({
      argv: [...argv],
      cwd: opts.cwd ?? null,
      timeoutMs: opts.timeoutMs ?? null,
      // Variable names only: values never reach a transcript.
      envKeys: Object.keys(opts.env ?? {}).sort(),
      code: result.code,
      spawnError: result.spawnError === true,
      truncated: result.truncated === true,
      durationMs: Date.now() - started,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(toolsInput === undefined ? {} : { toolsInput }),
      ...(outputSarif === undefined ? {} : { outputSarif }),
    });
    return result;
  };
}

function normalizedTranscript(calls, normalize) {
  return calls.map((call) => ({
    ...call,
    argv: call.argv.map(normalize),
    cwd: normalize(call.cwd),
    stdout: normalize(bounded(call.stdout, MAX_TRANSCRIPT_STDOUT)),
    stderr: normalize(bounded(call.stderr, MAX_TRANSCRIPT_STDERR)),
    ...(call.toolsInput === undefined ? {} : { toolsInput: normalize(call.toolsInput) }),
    ...(call.outputSarif === undefined ? {} : { outputSarif: normalize(call.outputSarif) }),
  }));
}

/** Tool identities the analyzers stated about themselves in their own SARIF. */
function sarifDrivers(calls) {
  const drivers = new Map();
  for (const call of calls) {
    for (const text of [call.stdout, call.outputSarif]) {
      if (typeof text !== "string" || !text.trimStart().startsWith("{")) continue;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      for (const run of Array.isArray(parsed?.runs) ? parsed.runs : []) {
        const driver = run?.tool?.driver;
        if (driver === undefined || typeof driver.name !== "string") continue;
        const version = driver.semanticVersion ?? driver.version ?? null;
        drivers.set(`${driver.name}@${version}`, { name: driver.name, version });
      }
    }
  }
  return [...drivers.values()];
}

// ---------------------------------------------------------------------------
// Environment facts
// ---------------------------------------------------------------------------

function probe(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 180_000,
    cwd: options.cwd,
    windowsHide: true,
  });
  if (result.error !== undefined) return { ok: false, detail: String(result.error.message) };
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim().slice(0, 2000),
  };
}

function uvPackageVersion(project, distribution) {
  // Core's own locked, isolated, offline invocation, asking the interpreter what it imported.
  const result = probe([
    "uv",
    "run",
    "--project",
    project,
    "--locked",
    "--isolated",
    "--python",
    "3.12",
    "--offline",
    "--no-python-downloads",
    "--no-env-file",
    "python",
    "-c",
    `import importlib.metadata as m; print(m.version(${JSON.stringify(distribution)}))`,
  ]);
  return result.ok
    ? { state: "resolved", version: result.stdout }
    : { state: "unresolved", detail: (result.stderr || result.detail || "").split("\n").slice(-3).join(" ") };
}

function environmentFacts(label, detectors) {
  const uv = probe(["uv", "--version"]);
  const uvCache = probe(["uv", "cache", "dir"]);
  const python = probe(["uv", "python", "find", "3.12", "--no-python-downloads"]);
  const pythonVersion = python.ok ? probe([python.stdout, "--version"]) : undefined;
  const docker = probe(["docker", "version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"]);
  const image = docker.ok
    ? probe(["docker", "image", "inspect", SKILLSPECTOR_IMAGE, "--format", "{{.Id}} {{json .RepoDigests}}"])
    : undefined;
  const analyzers = {};
  if (detectors.includes("semgrep")) analyzers.semgrep = uvPackageVersion(SEMGREP_PROJECT, "semgrep");
  if (detectors.includes("cisco"))
    analyzers.cisco = uvPackageVersion(CISCO_SKILL_SCANNER_PROJECT, "cisco-ai-skill-scanner");
  if (detectors.includes("mcp-scanner"))
    analyzers["mcp-scanner"] = uvPackageVersion(CISCO_MCP_SCANNER_PROJECT, "cisco-ai-mcp-scanner");
  if (detectors.includes("snyk-agent-scan"))
    analyzers["snyk-agent-scan"] = uvPackageVersion(SNYK_AGENT_SCAN_PROJECT, "snyk-agent-scan");
  return {
    label,
    os: process.platform,
    arch: arch(),
    osRelease: hostPlatform(),
    node: process.version,
    uv: uv.ok ? uv.stdout : `unavailable: ${uv.detail ?? uv.stderr}`,
    uvCacheDir: uvCache.ok ? uvCache.stdout : undefined,
    python312: pythonVersion?.ok ? pythonVersion.stdout || pythonVersion.stderr : "unavailable",
    docker: docker.ok ? docker.stdout : `unavailable: ${docker.detail ?? docker.stderr}`,
    skillspectorImage: image?.ok ? image.stdout : image === undefined ? "docker unavailable" : image.stderr,
    pinnedAnalyzers: {
      semgrep: SEMGREP_VERSION,
      cisco: CISCO_SKILL_SCANNER_VERSION,
      "mcp-scanner": CISCO_MCP_SCANNER_VERSION,
      "snyk-agent-scan": SNYK_AGENT_SCAN_VERSION,
      skillspector: {
        image: SKILLSPECTOR_IMAGE,
        digest: SKILLSPECTOR_IMAGE_DIGEST,
        sourceRevision: SKILLSPECTOR_SOURCE_REVISION,
      },
    },
    installedAnalyzers: analyzers,
  };
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

async function capture(options) {
  const label = required(options, "label");
  const fixtures = resolve(required(options, "fixtures"));
  const out = resolve(required(options, "out"));
  const transcriptsDir = options.transcripts === undefined ? undefined : resolve(options.transcripts);
  const detectors = required(options, "detectors").split(",");
  for (const detector of detectors) {
    if (detector !== "native" && !RUNTIME_DETECTORS.includes(detector))
      fail(`unknown detector ${detector}`);
  }
  const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const facts = environmentFacts(label, detectors);
  const context = { coreRoot, uvCacheDir: facts.uvCacheDir };
  const partialDir = join(out, label);
  const hostNormalize = makeNormalizer(undefined, context);
  const environmentPath = join(partialDir, "environment.json");
  const earlierEnvironment = existsSync(environmentPath) ? readJson(environmentPath) : undefined;
  writeJson(environmentPath, {
    ...facts,
    uvCacheDir: facts.uvCacheDir === undefined ? null : "<uv-cache>",
    installedAnalyzers: {
      ...earlierEnvironment?.installedAnalyzers,
      ...Object.fromEntries(
        Object.entries(facts.installedAnalyzers).map(([name, value]) => [
          name,
          value.state === "resolved" ? value : { ...value, detail: hostNormalize(value.detail) },
        ]),
      ),
    },
    coreCommit: options["core-commit"] ?? null,
    capturedAt: new Date().toISOString(),
    detectors: [...new Set([...(earlierEnvironment?.detectors ?? []), ...detectors])],
  });

  const env = process.env;
  const platform = corePlatform();
  for (const entry of loadCases(fixtures, options.cases)) {
    const root = materializeCase(fixtures, entry);
    const normalize = makeNormalizer(root, context);
    const internalScopes = entry.internalScopes ?? [];
    const golden = {
      format: GOLDEN_FORMAT,
      version: GOLDEN_VERSION,
      case: entry.id,
      environment: label,
      coreCommit: options["core-commit"] ?? null,
      posture: POSTURE,
      internalScopes,
      detectors: {},
    };
    try {
      console.error(`[${label}] ${entry.id}: native`);
      const native = await scanTrustTreeWithAnalyzers(root, { posture: POSTURE, internalScopes });
      const nativeChecks = nativeNonSmoke(native.checks);
      const nativeRawCount = native.rawOccurrences?.length ?? 0;
      if (detectors.includes("native")) {
        golden.native = {
          scanDetectorId: SCAN_DETECTOR_IDS.native,
          checks: native.checks.map((check) => goldenCheck(check, normalize, familyOf(check))),
          analyzersRun: native.analyzersRun,
          nativeRawOccurrences: nativeRawCount,
        };
      }
      for (const detector of detectors.filter((name) => name !== "native")) {
        console.error(`[${label}] ${entry.id}: ${detector}`);
        const calls = [];
        const started = Date.now();
        const result = await scanTrustTreeWithAnalyzers(root, {
          posture: POSTURE,
          internalScopes,
          env,
          platform,
          run: recordingRunner(defaultRunner, calls),
          detectors: [detector],
          skillspectorImageApprovals: [],
        });
        const durationMs = Date.now() - started;
        const all = result.checks;
        const smoke = all.at(-1);
        if (smoke?.name !== "skill sandbox smoke test") fail(`${entry.id}/${detector}: smoke check is not last`);
        const nonSmoke = all.slice(0, -1);
        const detectorChecks =
          nonSmoke.length === 1 && nonSmoke[0].name === "trust scan" ? [] : nonSmoke.slice(nativeChecks.length);
        const nativePart = nonSmoke.slice(0, nativeChecks.length);
        if (
          detectorChecks.length > 0 &&
          JSON.stringify(nativePart) !== JSON.stringify(nativeChecks)
        )
          fail(`${entry.id}/${detector}: native checks differ between the two scans`);
        const rawOccurrences = (result.rawOccurrences ?? []).slice(nativeRawCount);
        const executions = result.detectorExecutions ?? [];
        const unavailable = detectorChecks.find(
          (check) => check.code === "trust.detector-unavailable",
        );
        const outcome =
          detectorChecks.length === 0
            ? "not-applicable"
            : unavailable !== undefined
              ? "unavailable"
              : "completed";
        let transcriptSha256 = null;
        if (transcriptsDir !== undefined && calls.length > 0) {
          const transcript = {
            case: entry.id,
            detector,
            environment: label,
            calls: normalizedTranscript(calls, normalize),
          };
          const text = `${JSON.stringify(transcript, null, 2)}\n`;
          const path = join(transcriptsDir, label, entry.id, `${detector}.json`);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, text, "utf8");
          transcriptSha256 = sha256(text);
        }
        const occurrences = rawOccurrences.map((occurrence) =>
          goldenOccurrence(occurrence, normalize),
        );
        golden.detectors[detector] = {
          scanDetectorId: SCAN_DETECTOR_IDS[detector],
          mode: "executed",
          outcome,
          fingerprintsHostDependent: occurrences.some(
            (occurrence) => occurrence.hostDependentRuleId || occurrence.hostDependentMessage,
          ),
          ...(unavailable === undefined ? {} : { reason: normalize(unavailable.detail ?? "") }),
          analyzersRun: result.analyzersRun,
          durationMs,
          checks: detectorChecks.map((check) => goldenCheck(check, normalize)),
          rawOccurrences: occurrences,
          executions,
          scanObservations: (result.scanObservations ?? []).map((observation) => ({
            ...observation,
            ...(observation.detail === undefined ? {} : { detail: normalize(observation.detail) }),
          })),
          analyzerDrivers: sarifDrivers(calls),
          runnerCalls: calls.length,
          transcriptSha256,
        };
        golden.sandboxSmoke ??= goldenCheck(smoke, normalize, "sandbox-smoke");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // A later invocation for the same environment adds its detectors to the same case.
    const path = join(partialDir, "cases", `${entry.id}.json`);
    const earlier = existsSync(path) ? readJson(path) : undefined;
    writeJson(path, {
      ...golden,
      native: golden.native ?? earlier?.native,
      sandboxSmoke: golden.sandboxSmoke ?? earlier?.sandboxSmoke,
      detectors: { ...earlier?.detectors, ...golden.detectors },
    });
  }
}

// ---------------------------------------------------------------------------
// recorded-snyk: Core's engine over Snyk output recorded in Core's own tests
// ---------------------------------------------------------------------------

function substituteRoot(value, root) {
  const replace = (text) => {
    if (text === "<ROOT>") return root;
    if (text.startsWith("<ROOT>/")) return join(root, ...text.slice("<ROOT>/".length).split("/"));
    return text;
  };
  if (typeof value === "string") return replace(value);
  if (Array.isArray(value)) return value.map((item) => substituteRoot(item, root));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [replace(key), substituteRoot(item, root)]),
    );
  }
  return value;
}

async function recordedSnyk(options) {
  const label = required(options, "label");
  const fixtures = resolve(required(options, "fixtures"));
  const out = resolve(required(options, "out"));
  const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const recorded = readJson(join(fixtures, "recorded", "snyk-agent-scan.json"));
  const results = [];
  for (const entry of recorded.cases) {
    const root = mkdtempSync(join(tmpdir(), "aih-trust-golden-"));
    const normalize = makeNormalizer(root, { coreRoot });
    try {
      for (const [rel, text] of Object.entries(entry.files)) {
        const target = join(root, ...rel.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text, "utf8");
      }
      const stdout =
        entry.scanStdout ?? JSON.stringify(substituteRoot(entry.report ?? null, root));
      const calls = [];
      const replay = fakeRunner((argv) => {
        if (!argv.includes("snyk-agent-scan")) return undefined;
        if (argv.includes("help")) return { code: 0, stdout: "snyk-agent-scan help\n" };
        if (argv.includes("scan")) return { code: entry.scanExitCode, stdout };
        return undefined;
      });
      const native = await scanTrustTreeWithAnalyzers(root, { posture: POSTURE });
      const nativeChecks = nativeNonSmoke(native.checks);
      const result = await scanTrustTreeWithAnalyzers(root, {
        posture: POSTURE,
        // A replay needs Core's availability gate to pass; this is not a credential.
        env: { SNYK_TOKEN: "recorded-replay-no-real-token" },
        platform: corePlatform(),
        run: recordingRunner(replay, calls),
        detectors: ["snyk-agent-scan"],
      });
      const nonSmoke = result.checks.slice(0, -1);
      const detectorChecks = nonSmoke.slice(nativeChecks.length);
      const unavailable = detectorChecks.find((check) => check.code === "trust.detector-unavailable");
      results.push({
        id: entry.id,
        source: { ...recorded.source, line: entry.sourceLine },
        mode: "recorded",
        outcome: unavailable === undefined ? "completed" : "unavailable",
        ...(unavailable === undefined ? {} : { reason: normalize(unavailable.detail ?? "") }),
        files: entry.files,
        nativeChecks: native.checks.map((check) => goldenCheck(check, normalize, familyOf(check))),
        checks: detectorChecks.map((check) => goldenCheck(check, normalize)),
        rawOccurrences: (result.rawOccurrences ?? [])
          .slice(native.rawOccurrences?.length ?? 0)
          .map((occurrence) => goldenOccurrence(occurrence, normalize)),
        executions: result.detectorExecutions ?? [],
        analyzersRun: result.analyzersRun,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  writeJson(join(out, label, "recorded-snyk-agent-scan.json"), {
    format: GOLDEN_FORMAT,
    version: GOLDEN_VERSION,
    detector: "snyk-agent-scan",
    scanDetectorId: SCAN_DETECTOR_IDS["snyk-agent-scan"],
    mode: "recorded",
    note: "Snyk Agent Scan was NOT executed: no SNYK_TOKEN exists on the capture host. These goldens replay output recorded in Core's own tests through Core's engine.",
    environment: label,
    coreCommit: options["core-commit"] ?? null,
    posture: POSTURE,
    cases: results,
  });
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

/**
 * A result's host-independent content. Fingerprints are dropped only where the
 * capture flagged them as host-dependent (a Semgrep rule id carries the dotted
 * path of Core's temporary config directory, so they change on every run).
 */
function comparable(entry) {
  if (entry === undefined) return undefined;
  const { durationMs: _d, runnerCalls: _r, transcriptSha256: _t, scanObservations: _o, ...rest } =
    entry;
  if (rest.fingerprintsHostDependent === true) {
    rest.checks = rest.checks.map(({ fingerprint: _f, ...check }) => check);
    rest.rawOccurrences = rest.rawOccurrences.map(({ fingerprint: _f, ...row }) => row);
  }
  return JSON.stringify(rest);
}

function merge(options) {
  const fixtures = resolve(required(options, "fixtures"));
  const out = resolve(required(options, "out"));
  const partials = options.positional.map((path) => resolve(path));
  if (partials.length === 0) fail("merge needs at least one partial directory");
  const environments = {};
  const byCase = new Map();
  let recordedSnykFile;
  for (const partial of partials) {
    for (const label of readdirSync(partial)) {
      const dir = join(partial, label);
      const environmentPath = join(dir, "environment.json");
      if (existsSync(environmentPath)) environments[label] = readJson(environmentPath);
      const casesDir = join(dir, "cases");
      if (existsSync(casesDir)) {
        for (const name of readdirSync(casesDir)) {
          const golden = readJson(join(casesDir, name));
          if (!byCase.has(golden.case)) byCase.set(golden.case, []);
          byCase.get(golden.case).push(golden);
        }
      }
      const recordedPath = join(dir, "recorded-snyk-agent-scan.json");
      if (existsSync(recordedPath)) recordedSnykFile = readJson(recordedPath);
    }
  }
  const cases = loadCases(fixtures);
  const divergences = [];
  const summary = [];
  for (const entry of cases) {
    const partialsForCase = byCase.get(entry.id) ?? [];
    if (partialsForCase.length === 0) fail(`no capture for case ${entry.id}`);
    const merged = {
      format: GOLDEN_FORMAT,
      version: GOLDEN_VERSION,
      case: entry.id,
      coreCommit: partialsForCase[0].coreCommit,
      posture: POSTURE,
      internalScopes: partialsForCase[0].internalScopes,
      native: { byEnvironment: {} },
      detectors: {},
      sandboxSmoke: { byEnvironment: {} },
    };
    for (const partial of partialsForCase) {
      if (partial.native !== undefined) merged.native.byEnvironment[partial.environment] = partial.native;
      if (partial.sandboxSmoke !== undefined)
        merged.sandboxSmoke.byEnvironment[partial.environment] = partial.sandboxSmoke;
      for (const [detector, result] of Object.entries(partial.detectors)) {
        merged.detectors[detector] ??= { scanDetectorId: result.scanDetectorId, byEnvironment: {} };
        merged.detectors[detector].byEnvironment[partial.environment] = result;
      }
    }
    const nativeEnvs = Object.entries(merged.native.byEnvironment);
    merged.native.identicalAcrossEnvironments =
      new Set(nativeEnvs.map(([, value]) => JSON.stringify(value.checks))).size <= 1;
    if (!merged.native.identicalAcrossEnvironments)
      divergences.push(`${entry.id}: native checks differ across ${nativeEnvs.map(([env]) => env).join(", ")}`);
    for (const [detector, value] of Object.entries(merged.detectors)) {
      const envs = Object.entries(value.byEnvironment);
      const completed = envs.filter(([, result]) => result.outcome === "completed");
      value.executedOn = completed.map(([env]) => env);
      value.identicalAcrossEnvironments =
        new Set(envs.map(([, result]) => comparable(result))).size <= 1;
      if (completed.length > 1 && new Set(completed.map(([, result]) => comparable(result))).size > 1)
        divergences.push(`${entry.id}/${detector}: completed results differ across ${value.executedOn.join(", ")}`);
      summary.push({
        case: entry.id,
        detector,
        outcomes: Object.fromEntries(envs.map(([env, result]) => [env, result.outcome])),
        findings: Object.fromEntries(
          envs.map(([env, result]) => [
            env,
            result.checks.filter((check) => !check.name.startsWith("trust detector ")).length,
          ]),
        ),
      });
    }
    writeJson(join(out, `${entry.id}.json`), merged);
  }
  if (recordedSnykFile !== undefined) writeJson(join(out, "recorded-snyk-agent-scan.json"), recordedSnykFile);
  writeJson(join(out, "metadata.json"), {
    format: `${GOLDEN_FORMAT}-metadata`,
    version: GOLDEN_VERSION,
    coreCommit: cases.length > 0 ? byCase.get(cases[0].id)?.[0]?.coreCommit : null,
    provenance:
      "Core's trust engines at coreCommit, unmodified, driven through scanTrustTreeWithAnalyzers on a fresh temporary copy of each case with Core's own defaultRunner; this script and the corpus were the only additions. win32-x64 ran the sources under tsx on the capture host; linux-x64 ran an esbuild bundle of the same sources in a local container (Node 22, uv 0.12.4, CPython 3.12) after a locked uv sync of Core's analyzer projects. Snyk Agent Scan was never executed (no SNYK_TOKEN): its goldens replay output recorded in Core's tests. Transcripts of every analyzer call are kept outside the repository; each run's transcriptSha256 names its transcript.",
    posture: POSTURE,
    environments,
    divergences,
    summary,
  });
  console.error(`merged ${cases.length} case(s); ${divergences.length} divergence(s)`);
}

// ---------------------------------------------------------------------------

const { command, options } = parseArgs(process.argv.slice(2));
if (command === "capture") await capture(options);
else if (command === "recorded-snyk") await recordedSnyk(options);
else if (command === "merge") merge(options);
else fail("usage: capture | recorded-snyk | merge (see the header of this file)");
