import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Runner } from "../internals/proc.js";
import { classifyTuple, type HostTuple } from "./host-tuple.js";
import type { DimensionReport, ResolvedSource, ScanFinding, ScanSeverity } from "./scan-gate.js";
import type { BindingSource, FrameworkId } from "./schema.js";

/**
 * D12 scan cache tiers (W7 design §C) — the two derived, rebuildable caches that
 * sit ABOVE the fast-scan cache, plus the two async deep-scanner dimensions.
 *
 * Two keys, both a sha256 over CANONICAL JSON so byte-identical inputs always
 * digest identically and any field change changes the key:
 *  - {@link deepScanKey}     — `framework + sourceId + treeDigest + scannerVersion
 *                              + policyVersion`. Content identity, host-independent.
 *  - {@link runtimeQualKey}  — the deep-scan fields PLUS `selectedProfile`,
 *                              `adapterVersion`, and the host tuple's
 *                              `claudeCode / osBuild / arch / node / bun`. The tuple
 *                              is IN the key, so a Linux / older-CLI qualification
 *                              computes a DIFFERENT key and can never be read under
 *                              the pinned Windows tuple — off-tuple never satisfies,
 *                              STRUCTURALLY (design §C.2). Defense in depth: the read
 *                              additionally re-checks the stored tuple with the SAME
 *                              {@link classifyTuple} semantics the D16 doctor uses.
 *
 * The runtime-qual key deliberately mirrors the FIXED host-tuple semantics
 * (`host-tuple.ts`, O5 addenda): `osBuild` is the Windows BUILD number only — the
 * monthly UBR patch is PROVENANCE and is NEVER in the key; `claudeCode` (the CLI
 * version) IS in the key (D12), so a CLI bump is a different key = a cache miss
 * even when every hard fact is equal; and the read-time tuple guard gates RAM only
 * DOWNWARD (a rollback below the qualified class misses; the recorded dynamic-memory
 * balloon above it is drift, not off-tuple) and counts LOGICAL vCPUs.
 *
 * Both tiers are read/written ONLY inside an explicit provision / acceptance /
 * doctor flow — NOTHING here scans at session start (D12). Every read is
 * fail-safe: a corrupt, schema-invalid, or guard-mismatched record is a MISS
 * (a recompute), never a throw and never a served-wrong artifact; every write is
 * best-effort atomic (temp -> rename) like the fast-scan cache.
 */

// -- versions (bump => every older record becomes a cache miss / recompute) ----

/** Bump on ANY deep-scanner ruleset change — a different value re-keys both tiers. */
export const DEEP_SCANNER_VERSION = 1 as const;
/** Bump on ANY decision-policy change — a different value re-keys both tiers. */
export const SCAN_POLICY_VERSION = 1 as const;

const HEX64 = /^[0-9a-f]{64}$/;
const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

// -- canonical key material --------------------------------------------------

/**
 * Deterministic, key-sorted JSON (recursive) — the stable pre-image both tier keys
 * hash. Sorting keys means field ORDER never perturbs the digest; only field VALUES
 * do. The key objects here are flat records of strings/numbers, but the recursion
 * keeps it correct for any nested shape.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The five content-identity fields both tiers key on. */
export interface DeepScanKeyInput {
  framework: FrameworkId;
  /** git commitSha | npm "package@exactVersion". */
  sourceId: string;
  treeDigest: string;
  /** Defaults to {@link DEEP_SCANNER_VERSION}. */
  scannerVersion?: number;
  /** Defaults to {@link SCAN_POLICY_VERSION}. */
  policyVersion?: number;
}

function resolvedScannerVersion(input: DeepScanKeyInput): number {
  return input.scannerVersion ?? DEEP_SCANNER_VERSION;
}

function resolvedPolicyVersion(input: DeepScanKeyInput): number {
  return input.policyVersion ?? SCAN_POLICY_VERSION;
}

/**
 * `sha256(canonicalJson({ framework, sourceId, treeDigest, scannerVersion,
 * policyVersion }))`. Content identity only — host-independent, so the same tree
 * digests identically on any machine.
 */
export function deepScanKey(input: DeepScanKeyInput): string {
  return sha256Hex(
    canonicalJson({
      framework: input.framework,
      sourceId: input.sourceId,
      treeDigest: input.treeDigest,
      scannerVersion: resolvedScannerVersion(input),
      policyVersion: resolvedPolicyVersion(input),
    }),
  );
}

/** The runtime-qual key inputs — the deep-scan fields plus the host qualification axis. */
export interface RuntimeQualKeyInput extends DeepScanKeyInput {
  selectedProfile: string;
  adapterVersion: number;
  tuple: HostTuple;
}

/**
 * `sha256(canonicalJson({ ...deepScanFields, selectedProfile, adapterVersion,
 * claudeCode, osBuild, arch, node, bun }))`. The host tuple flows in as five fields
 * with the FIXED semantics: `osBuild` is the Windows BUILD number (`tuple.windowsBuild`)
 * — the UBR patch (`tuple.windowsUbr`) is provenance and is NEVER keyed; `claudeCode`
 * is `tuple.claudeCode.measuredOn` and IS keyed (a CLI bump = a different key = a miss,
 * D12). RAM class and vCPU class are deliberately NOT in the key — they are enforced
 * on read by {@link readRuntimeQualification}'s {@link classifyTuple} guard (RAM gates
 * downward only, vCPU exact), so the recorded dynamic-memory balloon never re-keys.
 */
export function runtimeQualKey(input: RuntimeQualKeyInput): string {
  return sha256Hex(
    canonicalJson({
      framework: input.framework,
      sourceId: input.sourceId,
      treeDigest: input.treeDigest,
      scannerVersion: resolvedScannerVersion(input),
      policyVersion: resolvedPolicyVersion(input),
      selectedProfile: input.selectedProfile,
      adapterVersion: input.adapterVersion,
      claudeCode: input.tuple.claudeCode.measuredOn,
      osBuild: input.tuple.windowsBuild,
      arch: input.tuple.arch,
      node: input.tuple.node,
      bun: input.tuple.bun,
    }),
  );
}

/** git commitSha | npm "package@exactVersion" — the `sourceId` both tiers key on. */
export function sourceIdOf(source: BindingSource): string {
  return source.kind === "git" ? source.commitSha : `${source.package}@${source.exactVersion}`;
}

/**
 * The `{ sourceId, treeDigest }` a resolved source contributes to the deep-scan key.
 * Fails closed for an npm source whose tree was never acquired (identity-only
 * resolution has no `treeDigest`): a deep scan can never key on an absent tree.
 */
export function deepScanIdentityOf(resolved: ResolvedSource): {
  sourceId: string;
  treeDigest: string;
} {
  if (resolved.kind === "git") {
    return { sourceId: resolved.commitSha, treeDigest: resolved.treeDigest };
  }
  if (resolved.treeDigest === undefined) {
    throw new ScanCacheTierError(
      "npm source has no materialized tree digest; acquire the tarball (acquireNpmTree) before a deep scan",
    );
  }
  return {
    sourceId: `${resolved.package}@${resolved.exactVersion}`,
    treeDigest: resolved.treeDigest,
  };
}

/** Fail-closed error for the tier caches (only thrown by the fail-closed identity guard). */
export class ScanCacheTierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanCacheTierError";
  }
}

// -- shared record schemas ---------------------------------------------------

const DeepScanFindingSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(SEVERITIES),
    detail: z.string(),
    coverage: z.enum(["complete", "incomplete"]),
    path: z.string().min(1).optional(),
  })
  .strict();

const DeepDimensionReportSchema = z
  .object({
    dimension: z.string().min(1),
    status: z.enum(["produced", "missing"]),
    reason: z.string().min(1).optional(),
    findings: z.array(DeepScanFindingSchema),
  })
  .strict();

const CoverageEntrySchema = z
  .object({
    dimension: z.string().min(1),
    status: z.enum(["produced", "missing"]),
    reason: z.string().min(1).optional(),
  })
  .strict();

export type CoverageEntry = z.infer<typeof CoverageEntrySchema>;

const HostTupleSchema = z
  .object({
    claudeCode: z.object({ measuredOn: z.string().min(1) }).strict(),
    windowsBuild: z.string().min(1),
    windowsUbr: z.string().min(1).optional(),
    arch: z.string().min(1),
    node: z.string().min(1),
    bun: z.string().min(1),
    ramClassGb: z.number().int().nonnegative(),
    vcpuClass: z.number().int().nonnegative(),
  })
  .strict();

// -- deep-scan cache tier (design §C.1) --------------------------------------

const DeepScanRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    deepScanKey: z.string().regex(HEX64),
    framework: z.string().min(1),
    sourceId: z.string().min(1),
    treeDigest: z.string().min(1),
    scannerVersion: z.number().int().nonnegative(),
    policyVersion: z.number().int().nonnegative(),
    scannedAt: z.string().min(1),
    dimensionReports: z.array(DeepDimensionReportSchema),
    coverage: z.array(CoverageEntrySchema),
  })
  .strict();

export type DeepScanRecord = z.infer<typeof DeepScanRecordSchema>;

function deepScanCachePath(cacheHome: string, key: string): string {
  return join(cacheHome, "deep-scan-cache", `${key}.json`);
}

function runtimeQualCachePath(cacheHome: string, key: string): string {
  return join(cacheHome, "runtime-qual-cache", `${key}.json`);
}

/** Read a JSON file, returning `undefined` on any I/O or parse failure (never throws). */
function readJsonSafe(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Best-effort atomic write (temp -> rename), swallowing errors — the cache is rebuildable. */
function writeJsonAtomic(path: string, value: unknown): void {
  try {
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true });
    const temporary = join(dir, `.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch {
    // derived cache: a write failure only forces a recompute next time
  }
}

/**
 * Read the deep-scan cache for `key`. A HIT requires the record to PARSE and its
 * identity fields (`deepScanKey`, `framework`, `sourceId`, `treeDigest`,
 * `scannerVersion`, `policyVersion`) to equal the request — the same digest-guard
 * re-check the fast-scan cache applies. Any mismatch, corruption, or absence is a
 * MISS (undefined), never a throw.
 */
export function readDeepScanCache(
  cacheHome: string,
  input: DeepScanKeyInput,
): DeepScanRecord | undefined {
  const key = deepScanKey(input);
  const parsed = DeepScanRecordSchema.safeParse(readJsonSafe(deepScanCachePath(cacheHome, key)));
  if (!parsed.success) return undefined;
  const record = parsed.data;
  if (
    record.deepScanKey !== key ||
    record.framework !== input.framework ||
    record.sourceId !== input.sourceId ||
    record.treeDigest !== input.treeDigest ||
    record.scannerVersion !== resolvedScannerVersion(input) ||
    record.policyVersion !== resolvedPolicyVersion(input)
  ) {
    return undefined;
  }
  return record;
}

function coverageOf(reports: readonly DimensionReport[]): CoverageEntry[] {
  return reports.map((report) => ({
    dimension: report.dimension,
    status: report.status,
    ...(report.reason !== undefined ? { reason: report.reason } : {}),
  }));
}

function writeDeepScanCache(cacheHome: string, record: DeepScanRecord): void {
  writeJsonAtomic(deepScanCachePath(cacheHome, record.deepScanKey), record);
}

// -- async deep-scanner dimensions (design §C.3, O6) -------------------------

/** The context an async deep-scanner dimension runs against. */
export interface DeepDimensionContext {
  treePath: string;
  runner: Runner;
  /** Generous per-scan budget; defaults to {@link DEEP_SCAN_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * An async deep-scanner dimension. Unlike the fast `DimensionInspector` (synchronous,
 * in-process), a deep dimension spawns an external tool through the injected runner,
 * so its `run` is async. It NEVER throws: an unavailable tool, a spawn failure, a
 * non-zero exit, or unparseable output all resolve to `status: "missing"` with a
 * reason — never a fabricated pass, never an automatic failure (design §C.3, H9).
 */
export interface DeepDimensionInspector {
  dimension: string;
  run(ctx: DeepDimensionContext): Promise<DimensionReport>;
}

/** A generous default deep-scan budget — these tools scan a whole framework tree. */
export const DEEP_SCAN_TIMEOUT_MS = 300_000;
const AVAILABILITY_TIMEOUT_MS = 30_000;
const MAX_DEEP_FINDINGS = 100;

/** The pinned Cisco skill-scanner package + its console-script (see tools/cisco-skill-scanner). */
const CISCO_SKILL_SCANNER_SPEC = "cisco-ai-skill-scanner==2.0.12";
const CISCO_CONSOLE_SCRIPT = "skill-scanner";

function missingReport(dimension: string, reason: string): DimensionReport {
  return { dimension, status: "missing", reason, findings: [] };
}

/** Normalize a SARIF artifact uri to a determinism-safe relative path + display label. */
function normalizeSarifPath(uri: unknown): { path?: string; display: string } {
  if (typeof uri !== "string" || uri.length === 0) return { display: "(no location)" };
  const normalized = uri.replace(/\\/g, "/").replace(/^\.\//, "");
  // Absolute POSIX / UNC / drive paths are machine-local: drop the path pin and
  // display the basename only, so a cache record stays portable and deterministic.
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    const base = normalized.split("/").filter(Boolean).at(-1) ?? "(no location)";
    return { display: base };
  }
  return { path: normalized, display: normalized };
}

function sarifLevelToSeverity(level: unknown): ScanSeverity {
  if (level === "error") return "high";
  if (level === "warning") return "medium";
  return "low";
}

interface SarifResult {
  ruleId?: unknown;
  level?: unknown;
  message?: { text?: unknown };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri?: unknown };
      region?: { startLine?: unknown };
    };
  }>;
}

/**
 * Map a scanner's SARIF stdout to sorted, bounded {@link ScanFinding}s — DETERMINISTIC
 * (findings sorted by detail). Returns `undefined` when the output is not a SARIF
 * envelope with a `runs` array, so the caller reports the dimension MISSING rather
 * than fabricating a pass. Zero results in a valid envelope is a PRODUCED clean scan.
 */
function parseSarifFindings(stdout: string, code: string): ScanFinding[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const runs = (parsed as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return undefined;
  const findings: ScanFinding[] = [];
  for (const run of runs) {
    const results = (run as { results?: unknown })?.results;
    if (!Array.isArray(results)) continue;
    for (const raw of results as SarifResult[]) {
      const message =
        typeof raw?.message?.text === "string" && raw.message.text.length > 0
          ? raw.message.text
          : "(no message)";
      const physical = raw?.locations?.[0]?.physicalLocation;
      const { path, display } = normalizeSarifPath(physical?.artifactLocation?.uri);
      const startLine =
        typeof physical?.region?.startLine === "number" ? physical.region.startLine : undefined;
      const where = startLine !== undefined ? `${display}:${startLine}` : display;
      const finding: ScanFinding = {
        code,
        severity: sarifLevelToSeverity(raw?.level),
        detail: `${where} — ${message}`,
        coverage: "complete",
      };
      if (path !== undefined) finding.path = path;
      findings.push(finding);
    }
  }
  findings.sort((left, right) => left.detail.localeCompare(right.detail));
  return findings.slice(0, MAX_DEEP_FINDINGS);
}

interface ExternalSarifScannerConfig {
  dimension: string;
  findingCode: string;
  toolLabel: string;
  availabilityArgv: readonly string[];
  buildScanArgv: (treePath: string) => string[];
}

/**
 * The shared "probe availability -> scan -> map SARIF" flow both external deep
 * dimensions use. Availability is checked FIRST (e.g. `uvx --version` / `docker
 * --version`) so an absent tool is a clean `missing`, not a scan attempt; a spawn
 * failure, non-zero exit, or unparseable output is likewise `missing` with a reason.
 */
async function runExternalSarifDimension(
  ctx: DeepDimensionContext,
  config: ExternalSarifScannerConfig,
): Promise<DimensionReport> {
  const available = await ctx.runner([...config.availabilityArgv], {
    timeoutMs: AVAILABILITY_TIMEOUT_MS,
  });
  if (available.spawnError || available.code !== 0) {
    return missingReport(
      config.dimension,
      `${config.toolLabel} is unavailable on this host — ${config.dimension} deep scan not run (incomplete coverage)`,
    );
  }
  const result = await ctx.runner(config.buildScanArgv(ctx.treePath), {
    timeoutMs: ctx.timeoutMs ?? DEEP_SCAN_TIMEOUT_MS,
  });
  if (result.spawnError) {
    return missingReport(config.dimension, `${config.dimension} scanner failed to spawn`);
  }
  if (result.code !== 0) {
    return missingReport(
      config.dimension,
      `${config.dimension} scanner exited with code ${String(result.code)}`,
    );
  }
  const findings = parseSarifFindings(result.stdout, config.findingCode);
  if (findings === undefined) {
    return missingReport(
      config.dimension,
      `${config.dimension} scanner produced no parseable SARIF output`,
    );
  }
  return { dimension: config.dimension, status: "produced", findings };
}

/**
 * The Cisco AI Defense skill-scanner deep dimension (design §C.3, O6 — `cisco@uvx`).
 * Runs the pinned `cisco-ai-skill-scanner` console-script (`skill-scanner`) through
 * `uvx`, OFFLINE, emitting SARIF. Available on AIH-DEV, so it PRODUCES here. Its
 * output maps deterministically to `trust.cisco-finding` findings; any spawn / exit
 * / parse failure reports the dimension MISSING (never a fabricated pass).
 */
export const ciscoSkillScannerInspector: DeepDimensionInspector = {
  dimension: "cisco-skill-scanner",
  run: (ctx) =>
    runExternalSarifDimension(ctx, {
      dimension: "cisco-skill-scanner",
      findingCode: "trust.cisco-finding",
      toolLabel: "uvx",
      availabilityArgv: ["uvx", "--version"],
      buildScanArgv: (treePath) => [
        "uvx",
        "--from",
        CISCO_SKILL_SCANNER_SPEC,
        CISCO_CONSOLE_SCRIPT,
        "--offline",
        "--format",
        "sarif",
        treePath,
      ],
    }),
};

/**
 * The SkillSpector deep dimension (design §C.3, O6 — `skillspector@docker`). Requires
 * docker, which is ABSENT on this VM, so it reports MISSING here (incomplete coverage,
 * the designed first-class path — never a false green). Where docker exists it runs the
 * pinned image over the mounted tree and maps its SARIF like the Cisco dimension.
 */
export const skillspectorInspector: DeepDimensionInspector = {
  dimension: "skillspector",
  run: (ctx) =>
    runExternalSarifDimension(ctx, {
      dimension: "skillspector",
      findingCode: "trust.detector-finding",
      toolLabel: "docker",
      availabilityArgv: ["docker", "--version"],
      buildScanArgv: (treePath) => [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${treePath}:/scan:ro`,
        "skillspector",
        "scan",
        "--format",
        "sarif",
        "/scan",
      ],
    }),
};

/** The deep dimensions wired in W7 (O6): cisco (uvx, produced) + skillspector (docker, missing here). */
export const DEEP_DIMENSION_INSPECTORS: readonly DeepDimensionInspector[] = [
  ciscoSkillScannerInspector,
  skillspectorInspector,
];

// -- deep-scan tier orchestration (consult cache -> scan -> write) -----------

/** Input to {@link runDeepScanTier} — the identity, the tree, and the async runner. */
export interface DeepScanTierInput {
  cacheHome: string;
  framework: FrameworkId;
  sourceId: string;
  treeDigest: string;
  treePath: string;
  runner: Runner;
  /** Defaults to {@link DEEP_DIMENSION_INSPECTORS}. */
  inspectors?: readonly DeepDimensionInspector[];
  timeoutMs?: number;
  scannerVersion?: number;
  policyVersion?: number;
}

/** Output of {@link runDeepScanTier} — the deep dimensions to fold + the key + hit flag. */
export interface DeepScanTierResult {
  deepScanKey: string;
  dimensionReports: DimensionReport[];
  coverage: CoverageEntry[];
  /** True when the result came from the cache (no deep scanner ran). */
  cacheHit: boolean;
}

/**
 * Run the deep-scan tier for one source: consult the deep-scan cache first, and on a
 * HIT return the cached dimensions WITHOUT running any scanner (so a warm second run
 * spawns nothing — the runner-call capture in the tests proves it). On a MISS, run the
 * async deep inspectors, write the cache best-effort, and return the produced/missing
 * dimensions. The returned `dimensionReports` are folded through the SAME
 * `decide()`/coverage path as the fast dimensions by the caller (the one scan-gate
 * seam: `runFastScanGate(..., { deepDimensionReports })`). Never throws on scan errors —
 * a failed dimension is `missing`, i.e. incomplete coverage.
 */
export async function runDeepScanTier(input: DeepScanTierInput): Promise<DeepScanTierResult> {
  const keyInput: DeepScanKeyInput = {
    framework: input.framework,
    sourceId: input.sourceId,
    treeDigest: input.treeDigest,
    scannerVersion: input.scannerVersion,
    policyVersion: input.policyVersion,
  };
  const key = deepScanKey(keyInput);

  const cached = readDeepScanCache(input.cacheHome, keyInput);
  if (cached !== undefined) {
    return {
      deepScanKey: key,
      dimensionReports: cached.dimensionReports,
      coverage: cached.coverage,
      cacheHit: true,
    };
  }

  const inspectors = input.inspectors ?? DEEP_DIMENSION_INSPECTORS;
  const dimensionReports = await Promise.all(
    inspectors.map((inspector) =>
      inspector.run({ treePath: input.treePath, runner: input.runner, timeoutMs: input.timeoutMs }),
    ),
  );
  const coverage = coverageOf(dimensionReports);
  writeDeepScanCache(input.cacheHome, {
    schemaVersion: 1,
    deepScanKey: key,
    framework: input.framework,
    sourceId: input.sourceId,
    treeDigest: input.treeDigest,
    scannerVersion: resolvedScannerVersion(keyInput),
    policyVersion: resolvedPolicyVersion(keyInput),
    scannedAt: new Date().toISOString(),
    dimensionReports: dimensionReports.map((report) => ({
      dimension: report.dimension,
      status: report.status,
      ...(report.reason !== undefined ? { reason: report.reason } : {}),
      findings: report.findings.map((finding) => ({
        code: finding.code,
        severity: finding.severity,
        detail: finding.detail,
        coverage: finding.coverage,
        ...(finding.path !== undefined ? { path: finding.path } : {}),
      })),
    })),
    coverage,
  });

  return { deepScanKey: key, dimensionReports, coverage, cacheHit: false };
}

// -- runtime-qualification cache tier (design §C.2) --------------------------

/** The three qualification outcomes recorded for a host (D12). */
export type RuntimeQualResult = "qualified" | "incomplete" | "blocked";

const RuntimeQualRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeQualKey: z.string().regex(HEX64),
    framework: z.string().min(1),
    sourceId: z.string().min(1),
    treeDigest: z.string().min(1),
    scannerVersion: z.number().int().nonnegative(),
    policyVersion: z.number().int().nonnegative(),
    selectedProfile: z.string().min(1),
    adapterVersion: z.number().int().nonnegative(),
    tuple: HostTupleSchema,
    result: z.enum(["qualified", "incomplete", "blocked"]),
    evidence: z.string(),
    qualifiedAt: z.string().min(1),
  })
  .strict();

export type RuntimeQualRecord = z.infer<typeof RuntimeQualRecordSchema>;

/** Input to {@link recordRuntimeQualification} — the qualification a provision/acceptance flow writes. */
export interface RecordRuntimeQualificationInput extends RuntimeQualKeyInput {
  cacheHome: string;
  result: RuntimeQualResult;
  evidence: string;
}

/**
 * Write a runtime-qualification record (design §C.2). The provision / acceptance flow
 * calls this AFTER a deep scan qualifies (or fails to qualify) a host — there is no
 * adapter wiring in this phase; this is the API W8's acceptance flow drives. Returns
 * the written record (with its key). Best-effort atomic like the deep-scan cache.
 */
export function recordRuntimeQualification(
  input: RecordRuntimeQualificationInput,
): RuntimeQualRecord {
  const key = runtimeQualKey(input);
  const record: RuntimeQualRecord = {
    schemaVersion: 1,
    runtimeQualKey: key,
    framework: input.framework,
    sourceId: input.sourceId,
    treeDigest: input.treeDigest,
    scannerVersion: resolvedScannerVersion(input),
    policyVersion: resolvedPolicyVersion(input),
    selectedProfile: input.selectedProfile,
    adapterVersion: input.adapterVersion,
    tuple: input.tuple,
    result: input.result,
    evidence: input.evidence,
    qualifiedAt: new Date().toISOString(),
  };
  writeJsonAtomic(runtimeQualCachePath(input.cacheHome, key), record);
  return record;
}

/** Input to {@link readRuntimeQualification} — the key inputs plus the cache home. */
export interface ReadRuntimeQualificationInput extends RuntimeQualKeyInput {
  cacheHome: string;
}

/**
 * Read a runtime-qualification record. A HIT requires:
 *  1. the FULL key to match (so a Linux / older-CLI / different-profile / different
 *     adapter-version request computes a different key and cannot find this file), AND
 *  2. every keyed field on the record to equal the request (digest-guard re-check), AND
 *  3. the stored tuple to still qualify the REQUESTED tuple under the D16
 *     {@link classifyTuple} semantics — NOT off-tuple. So a RAM rollback below the
 *     qualified class, or any hard-fact drift the key did not already exclude, MISSES;
 *     the recorded dynamic-memory balloon above the class (version-drift) still HITS.
 * Any corruption or guard failure is a MISS (undefined), never a throw. Off-tuple can
 * never satisfy — structurally (the key) and defensively (the guard).
 */
export function readRuntimeQualification(
  input: ReadRuntimeQualificationInput,
): RuntimeQualRecord | undefined {
  const key = runtimeQualKey(input);
  const parsed = RuntimeQualRecordSchema.safeParse(
    readJsonSafe(runtimeQualCachePath(input.cacheHome, key)),
  );
  if (!parsed.success) return undefined;
  const record = parsed.data;
  if (
    record.runtimeQualKey !== key ||
    record.framework !== input.framework ||
    record.sourceId !== input.sourceId ||
    record.treeDigest !== input.treeDigest ||
    record.scannerVersion !== resolvedScannerVersion(input) ||
    record.policyVersion !== resolvedPolicyVersion(input) ||
    record.selectedProfile !== input.selectedProfile ||
    record.adapterVersion !== input.adapterVersion
  ) {
    return undefined;
  }
  // Defense in depth (design §C.2): the tuple is already in the key for
  // claudeCode/osBuild/arch/node/bun, but RAM class and vCPU class are not — enforce
  // them (and re-assert the rest) with the SAME semantics the D16 doctor uses.
  if (classifyTuple(input.tuple, record.tuple) === "off-tuple") return undefined;
  return record;
}
