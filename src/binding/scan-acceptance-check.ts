import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { AihError } from "../errors.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import shippedAcceptanceJson from "./scan-acceptance.json";
import { type DimensionReport, inspectTree, type ScanSeverity } from "./scan-gate.js";

export const SUPERPOWERS_ACCEPTANCE_COMMIT = "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const REPLACEMENT_REFS_MAX_BUFFER_BYTES = 64 * 1024;
const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
const ALLOWED_SUPERPOWERS_REMOTE_PATTERNS = [
  /^https:\/\/github\.com\/obra\/superpowers(?:\.git)?\/?$/i,
  /^git@github\.com:obra\/superpowers(?:\.git)?\/?$/i,
  /^ssh:\/\/git@github\.com\/obra\/superpowers(?:\.git)?\/?$/i,
];

const AcceptanceEntrySchema = z
  .object({
    repository: z.literal("obra/superpowers"),
    code: z.string().min(1).max(240),
    path: z.string().min(1).max(1_024),
    fileSha256: z.string().regex(SHA256_HEX),
    profile: z.string().min(1).max(240).optional(),
    acceptanceClass: z.string().min(1).max(240).optional(),
    conditions: z.array(z.string().min(1).max(1_024)).max(128).optional(),
  })
  .strict();

const AcceptanceArtifactSchema = z
  .object({
    schemaVersion: z.literal(2),
    reason: z.string().min(1),
    accepted: z.array(AcceptanceEntrySchema).max(2_000),
  })
  .strict();

export type ScanAcceptanceArtifact = z.infer<typeof AcceptanceArtifactSchema>;

export interface ScanAcceptanceCheckInput {
  /** Explicit absolute path to an independently cloned Superpowers checkout. */
  checkoutPath: string;
}

/** Test seams only; production calls use the shipped artifact, runtime inspector, and runner. */
export interface ScanAcceptanceCheckDeps {
  runner?: Runner;
  inspectTree?: (treePath: string) => readonly DimensionReport[];
  acceptanceArtifact?: unknown;
}

export interface ScanAcceptanceTuple {
  code: string;
  path: string;
  fileSha256: string;
}

export interface ScanAcceptanceObservedTuple extends ScanAcceptanceTuple {
  severity: ScanSeverity;
}

export interface ScanAcceptanceCheckReport {
  checkout: { repository: "obra/superpowers"; commitSha: string };
  observations: readonly ScanAcceptanceObservedTuple[];
  accepted: readonly ScanAcceptanceObservedTuple[];
  stale: readonly ScanAcceptanceTuple[];
  missing: readonly ScanAcceptanceTuple[];
  new: readonly ScanAcceptanceObservedTuple[];
  critical: readonly ScanAcceptanceObservedTuple[];
  /** This audit is observational only and never authorizes a runtime gate. */
  authorizes: false;
}

/** Fail-closed scan-acceptance input, checkout, or CLI error. */
export class ScanAcceptanceCheckError extends AihError {
  constructor(message: string) {
    super(message, "AIH_SCAN_ACCEPTANCE");
  }
}

interface CheckoutIdentity {
  root: string;
  dev: number;
  ino: number;
  commitSha: string;
}

function fail(message: string): never {
  throw new ScanAcceptanceCheckError(message);
}

function tupleKey(tuple: Pick<ScanAcceptanceTuple, "code" | "path">): string {
  return JSON.stringify([tuple.code, tuple.path]);
}

function fullTupleKey(tuple: ScanAcceptanceTuple): string {
  return JSON.stringify([tuple.code, tuple.path, tuple.fileSha256]);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareTuples(left: ScanAcceptanceTuple, right: ScanAcceptanceTuple): number {
  return (
    compareText(left.code, right.code) ||
    compareText(left.path, right.path) ||
    compareText(left.fileSha256, right.fileSha256)
  );
}

function severityRank(severity: ScanSeverity): number {
  return SEVERITIES.indexOf(severity);
}

function normalizeRelativePosixPath(path: string, label: string): void {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  ) {
    fail(`${label} must be a non-empty relative POSIX path`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail(`${label} must not contain empty, current-directory, or traversal segments`);
  }
}

function parseAcceptance(value: unknown): ScanAcceptanceArtifact {
  const parsed = AcceptanceArtifactSchema.safeParse(value);
  if (!parsed.success) fail("scan acceptance artifact is malformed");
  const keys = new Set<string>();
  for (const entry of parsed.data.accepted) {
    normalizeRelativePosixPath(entry.path, "acceptance entry path");
    const key = tupleKey(entry);
    if (keys.has(key)) fail(`duplicate acceptance entry: ${entry.code} ${entry.path}`);
    keys.add(key);
  }
  return parsed.data;
}

function gitResult(
  result: Awaited<ReturnType<Runner>>,
  operation: string,
): { stdout: string; code: number } {
  if (result.spawnError || result.truncated || result.code === null) {
    fail(`unable to verify Superpowers checkout (${operation})`);
  }
  return { stdout: result.stdout, code: result.code };
}

function canonicalGitTopLevel(stdout: string): { root: string; dev: number; ino: number } {
  const topLevel = stdout.trim();
  if (
    topLevel.length === 0 ||
    topLevel.includes("\r") ||
    topLevel.includes("\n") ||
    !isAbsolute(topLevel)
  ) {
    fail("Git top-level result is malformed");
  }
  try {
    const stat = lstatSync(topLevel);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("Git top-level result must name a real directory");
    }
    const root = realpathSync.native(topLevel);
    const canonicalStat = statSync(root);
    return { root, dev: canonicalStat.dev, ino: canonicalStat.ino };
  } catch (error) {
    if (error instanceof ScanAcceptanceCheckError) throw error;
    fail("Git top-level result is unavailable or unreadable");
  }
}

function isAllowedSuperpowersRemote(stdout: string): boolean {
  const remote = stdout.trim();
  return ALLOWED_SUPERPOWERS_REMOTE_PATTERNS.some((pattern) => pattern.test(remote));
}

function assertFullyMaterializedIndex(stdout: string): void {
  if (stdout.length === 0) return;
  if (!stdout.endsWith("\0")) fail("vendor checkout index state is malformed");
  for (const entry of stdout.slice(0, -1).split("\0")) {
    if (entry.length < 3 || entry[0] !== "H" || entry[1] !== " " || entry.slice(2).length === 0) {
      fail("vendor checkout index contains concealed tracked entries");
    }
  }
}

async function assertNoReplacementRefs(root: string, runner: Runner): Promise<void> {
  const refs = gitResult(
    await runner(
      [
        "git",
        "--no-replace-objects",
        "-C",
        root,
        "for-each-ref",
        "refs/replace",
        "--format=%(refname)",
      ],
      { maxBufferBytes: REPLACEMENT_REFS_MAX_BUFFER_BYTES },
    ),
    "replacement refs",
  );
  if (refs.code !== 0 || refs.stdout !== "") {
    fail("vendor checkout must not contain replacement refs");
  }
}

async function checkoutIdentity(checkoutPath: string, runner: Runner): Promise<CheckoutIdentity> {
  let root: string;
  let dev: number;
  let ino: number;
  try {
    const stat = lstatSync(checkoutPath);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("vendor checkout must be a real directory");
    root = realpathSync.native(checkoutPath);
    const canonicalStat = statSync(root);
    dev = canonicalStat.dev;
    ino = canonicalStat.ino;
  } catch (error) {
    if (error instanceof ScanAcceptanceCheckError) throw error;
    fail("vendor checkout is unavailable or unreadable");
  }

  try {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: unknown;
    };
    if (packageJson.name === "@aihq/core" || packageJson.name === "@aihq/harness")
      fail("AI-Harness checkout cannot be scanned as Superpowers");
  } catch (error) {
    if (error instanceof ScanAcceptanceCheckError) throw error;
  }

  const inside = gitResult(
    await runner(["git", "--no-replace-objects", "-C", root, "rev-parse", "--is-inside-work-tree"]),
    "repository status",
  );
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    fail("vendor checkout is not a Git work tree");
  }
  const topLevel = gitResult(
    await runner(["git", "--no-replace-objects", "-C", root, "rev-parse", "--show-toplevel"]),
    "repository top-level",
  );
  if (topLevel.code !== 0) fail("vendor checkout must be the Git work-tree top-level");
  const gitRoot = canonicalGitTopLevel(topLevel.stdout);
  if (gitRoot.root !== root || gitRoot.dev !== dev || gitRoot.ino !== ino) {
    fail("vendor checkout must be the Git work-tree top-level");
  }
  await assertNoReplacementRefs(root, runner);
  const remote = gitResult(
    await runner(["git", "--no-replace-objects", "-C", root, "remote", "get-url", "origin"]),
    "origin remote",
  );
  if (remote.code !== 0 || !isAllowedSuperpowersRemote(remote.stdout)) {
    fail("vendor checkout origin is not obra/superpowers");
  }
  const branch = gitResult(
    await runner(["git", "--no-replace-objects", "-C", root, "symbolic-ref", "-q", "HEAD"]),
    "detached HEAD",
  );
  if (branch.code !== 1 || branch.stdout.trim().length !== 0) {
    fail("vendor checkout must have a detached HEAD");
  }
  const head = gitResult(
    await runner(["git", "--no-replace-objects", "-C", root, "rev-parse", "HEAD"]),
    "HEAD revision",
  );
  const commitSha = head.stdout.trim();
  if (head.code !== 0 || !SHA40.test(commitSha) || commitSha !== SUPERPOWERS_ACCEPTANCE_COMMIT) {
    fail(`vendor checkout must be detached at ${SUPERPOWERS_ACCEPTANCE_COMMIT}`);
  }
  const status = gitResult(
    await runner([
      "git",
      "--no-replace-objects",
      "-C",
      root,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=matching",
    ]),
    "working tree status",
  );
  if (status.code !== 0 || status.stdout.trim().length !== 0) {
    fail("vendor checkout must be clean and immutable");
  }
  const index = gitResult(
    await runner(["git", "--no-replace-objects", "-C", root, "ls-files", "-v", "-z"]),
    "tracked index state",
  );
  if (index.code !== 0) fail("vendor checkout index is unavailable");
  assertFullyMaterializedIndex(index.stdout);
  return { root, dev, ino, commitSha };
}

function assertSameCheckout(before: CheckoutIdentity, after: CheckoutIdentity): void {
  if (
    before.root !== after.root ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.commitSha !== after.commitSha
  ) {
    fail("vendor checkout identity changed during inspection");
  }
}

function scannerCandidates(reports: readonly DimensionReport[]): ScanAcceptanceObservedTuple[] {
  const candidates = new Map<string, ScanAcceptanceObservedTuple>();
  for (const report of reports) {
    for (const finding of report.findings) {
      if (finding.path === undefined || finding.contentSha256 === undefined) continue;
      if (!SHA256_HEX.test(finding.contentSha256))
        fail("inspector emitted an invalid content SHA-256");
      normalizeRelativePosixPath(finding.path, "inspector finding path");
      const candidate: ScanAcceptanceObservedTuple = {
        code: finding.code,
        path: finding.path,
        fileSha256: finding.contentSha256,
        severity: finding.severity,
      };
      const key = fullTupleKey(candidate);
      const prior = candidates.get(key);
      if (prior === undefined || severityRank(candidate.severity) > severityRank(prior.severity)) {
        candidates.set(key, candidate);
      }
    }
  }
  return [...candidates.values()].sort(compareTuples);
}

/**
 * Audit scanner-derived content findings against the committed Superpowers
 * acceptance artifact. The caller provides only the checkout; observations are
 * always produced by the existing runtime inspector and no files are written.
 */
export async function checkSuperpowersScanAcceptance(
  input: ScanAcceptanceCheckInput,
  deps: ScanAcceptanceCheckDeps = {},
): Promise<ScanAcceptanceCheckReport> {
  if (!isAbsolute(input.checkoutPath)) fail("vendor checkout path must be explicit and absolute");
  const acceptance = parseAcceptance(deps.acceptanceArtifact ?? shippedAcceptanceJson);
  const runner = deps.runner ?? defaultRunner;
  const before = await checkoutIdentity(input.checkoutPath, runner);
  let reports: readonly DimensionReport[];
  try {
    reports = (deps.inspectTree ?? inspectTree)(before.root);
  } catch {
    fail("vendor checkout inspection is unavailable or unreadable");
  }
  const observations = scannerCandidates(reports);
  const after = await checkoutIdentity(input.checkoutPath, runner);
  assertSameCheckout(before, after);

  const observationsByTuple = new Map(observations.map((entry) => [fullTupleKey(entry), entry]));
  const observationsByCodePath = new Map<string, ScanAcceptanceObservedTuple[]>();
  for (const observation of observations) {
    const key = tupleKey(observation);
    observationsByCodePath.set(key, [...(observationsByCodePath.get(key) ?? []), observation]);
  }
  const accepted: ScanAcceptanceObservedTuple[] = [];
  const stale: ScanAcceptanceTuple[] = [];
  const missing: ScanAcceptanceTuple[] = [];
  for (const entry of [...acceptance.accepted].sort(compareTuples)) {
    const tuple: ScanAcceptanceTuple = {
      code: entry.code,
      path: entry.path,
      fileSha256: entry.fileSha256,
    };
    const exact = observationsByTuple.get(fullTupleKey(tuple));
    if (exact !== undefined) {
      if (exact.severity !== "critical") accepted.push(exact);
      continue;
    }
    if (observationsByCodePath.has(tupleKey(tuple))) stale.push(tuple);
    else missing.push(tuple);
  }
  const acceptedKeys = new Set(accepted.map(fullTupleKey));
  const critical = observations.filter((entry) => entry.severity === "critical");
  const newFindings = observations.filter(
    (entry) => entry.severity === "critical" || !acceptedKeys.has(fullTupleKey(entry)),
  );
  return {
    checkout: { repository: "obra/superpowers", commitSha: before.commitSha },
    observations,
    accepted,
    stale,
    missing,
    new: newFindings,
    critical,
    authorizes: false,
  };
}

export interface ScanAcceptanceCliDeps {
  check?: (input: ScanAcceptanceCheckInput) => Promise<ScanAcceptanceCheckReport>;
}

/** Parse the intentionally narrow stdout-only scan-acceptance command. */
export async function runScanAcceptanceCli(
  argv: readonly string[],
  deps: ScanAcceptanceCliDeps = {},
): Promise<string> {
  const checkoutPath = argv[1] ?? "";
  if (argv.length !== 2 || argv[0] !== "--checkout" || !isAbsolute(checkoutPath)) {
    fail("usage: check:scan-acceptance --checkout <absolute-superpowers-checkout>");
  }
  const report = await (deps.check ?? checkSuperpowersScanAcceptance)({ checkoutPath });
  return `${JSON.stringify(report)}\n`;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  void runScanAcceptanceCli(process.argv.slice(2))
    .then((output) => process.stdout.write(output))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "scan acceptance check failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
