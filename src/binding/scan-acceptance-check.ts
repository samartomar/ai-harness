import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import shippedAcceptanceJson from "./scan-acceptance.json";

export const SUPERPOWERS_ACCEPTANCE_COMMIT = "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
const ALLOWED_REMOTES = new Set([
  "https://github.com/obra/superpowers.git",
  "git@github.com:obra/superpowers.git",
]);

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

const ObservationSchema = z
  .object({
    code: z.string().min(1).max(240),
    severity: z.enum(SEVERITIES),
    path: z.string().min(1).max(1_024),
  })
  .strict();

export type ScanAcceptanceArtifact = z.infer<typeof AcceptanceArtifactSchema>;
export type ScanAcceptanceObservation = z.infer<typeof ObservationSchema>;

export interface ScanAcceptanceCheckInput {
  /** An explicit, independently cloned Superpowers checkout; this checker never acquires one. */
  checkoutPath: string;
  /** The committed acceptance artifact to audit. It is never modified. */
  acceptance: unknown;
  /** Static scanner findings to compare; the checker reads but never executes their source files. */
  observations: readonly unknown[];
  /** Optional explicit report destination. It must be absolute and outside the scanned checkout. */
  outputPath?: string;
  /** Test seam for git only. Production callers use the hermetic default runner. */
  runner?: Runner;
}

export type ShippedScanAcceptanceCheckInput = Omit<ScanAcceptanceCheckInput, "acceptance">;

export interface ScanAcceptanceTuple {
  code: string;
  path: string;
  fileSha256: string;
}

export interface ScanAcceptanceObservedTuple extends ScanAcceptanceTuple {
  severity: (typeof SEVERITIES)[number];
}

export interface ScanAcceptanceCheckReport {
  checkout: { path: string; commitSha: string };
  observations: readonly ScanAcceptanceObservedTuple[];
  accepted: readonly ScanAcceptanceObservedTuple[];
  stale: readonly ScanAcceptanceTuple[];
  missing: readonly ScanAcceptanceTuple[];
  new: readonly ScanAcceptanceObservedTuple[];
  critical: readonly ScanAcceptanceObservedTuple[];
  /** This audit is observational only and can never authorize a runtime gate. */
  authorizes: false;
}

/** Fail-closed scan-acceptance input, checkout, or output-boundary error. */
export class ScanAcceptanceCheckError extends AihError {
  constructor(message: string) {
    super(message, "AIH_SCAN_ACCEPTANCE");
  }
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

function compareTuples(
  left: Pick<ScanAcceptanceTuple, "code" | "path">,
  right: Pick<ScanAcceptanceTuple, "code" | "path">,
): number {
  if (left.code !== right.code) return left.code < right.code ? -1 : 1;
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  return 0;
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

function parseObservations(values: readonly unknown[]): ScanAcceptanceObservation[] {
  const parsed: ScanAcceptanceObservation[] = [];
  const keys = new Set<string>();
  for (const value of values) {
    const result = ObservationSchema.safeParse(value);
    if (!result.success) fail("scan acceptance observation is malformed");
    normalizeRelativePosixPath(result.data.path, "observation path");
    const key = tupleKey(result.data);
    if (keys.has(key))
      fail(`duplicate scan acceptance observation: ${result.data.code} ${result.data.path}`);
    keys.add(key);
    parsed.push(result.data);
  }
  return parsed.sort(compareTuples);
}

function gitResult(
  result: Awaited<ReturnType<Runner>>,
  operation: string,
): { stdout: string; code: number | null } {
  if (result.spawnError || result.truncated || result.code === null) {
    fail(`unable to verify Superpowers checkout (${operation})`);
  }
  return { stdout: result.stdout, code: result.code };
}

async function assertExternalPinnedCheckout(checkoutPath: string, runner: Runner): Promise<string> {
  let checkout: string;
  try {
    const stat = lstatSync(checkoutPath);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("vendor checkout must be a real directory");
    checkout = realpathSync(checkoutPath);
  } catch (error) {
    if (error instanceof ScanAcceptanceCheckError) throw error;
    fail("vendor checkout is unavailable or unreadable");
  }

  const packageJson = resolve(checkout, "package.json");
  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
    if (parsed.name === "@aihq/harness")
      fail("AI-Harness checkout cannot be scanned as Superpowers");
  } catch (error) {
    if (error instanceof ScanAcceptanceCheckError) throw error;
    // A Superpowers checkout need not have a package manifest; malformed local metadata is ignored.
  }

  const inside = gitResult(
    await runner(["git", "-C", checkout, "rev-parse", "--is-inside-work-tree"]),
    "repository status",
  );
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    fail("vendor checkout is not a Git work tree");
  }
  const remote = gitResult(
    await runner(["git", "-C", checkout, "remote", "get-url", "origin"]),
    "origin remote",
  );
  if (remote.code !== 0 || !ALLOWED_REMOTES.has(remote.stdout.trim())) {
    fail("vendor checkout origin is not obra/superpowers");
  }
  const branch = gitResult(
    await runner(["git", "-C", checkout, "symbolic-ref", "-q", "HEAD"]),
    "detached HEAD",
  );
  if (branch.code !== 1 || branch.stdout.trim().length !== 0) {
    fail("vendor checkout must have a detached HEAD");
  }
  const head = gitResult(
    await runner(["git", "-C", checkout, "rev-parse", "HEAD"]),
    "HEAD revision",
  );
  const commitSha = head.stdout.trim();
  if (head.code !== 0 || !SHA40.test(commitSha) || commitSha !== SUPERPOWERS_ACCEPTANCE_COMMIT) {
    fail(`vendor checkout must be detached at ${SUPERPOWERS_ACCEPTANCE_COMMIT}`);
  }
  const status = gitResult(
    await runner(["git", "-C", checkout, "status", "--porcelain=v1", "--untracked-files=all"]),
    "working tree status",
  );
  if (status.code !== 0 || status.stdout.trim().length !== 0) {
    fail("vendor checkout must be clean and immutable");
  }
  return checkout;
}

function hashObservedFile(root: string, path: string): string {
  const target = resolve(root, ...path.split("/"));
  const sourceRelative = relative(root, target);
  if (
    sourceRelative.length === 0 ||
    sourceRelative === ".." ||
    sourceRelative.startsWith("../") ||
    sourceRelative.startsWith("..\\")
  ) {
    fail(`observation path escapes vendor checkout: ${path}`);
  }
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail(`observation path is not a readable regular file: ${path}`);
    const text = readFileSync(target, "utf8").replace(/\r\n?/g, "\n");
    return createHash("sha256").update(text, "utf8").digest("hex");
  } catch (error) {
    if (error instanceof ScanAcceptanceCheckError) throw error;
    fail(`observation file is unavailable or unreadable: ${path}`);
  }
}

function assertOutputOutsideCheckout(outputPath: string, checkout: string): string {
  if (!isAbsolute(outputPath)) fail("scan acceptance output path must be explicit and absolute");
  const output = resolve(outputPath);
  let outputDir: string;
  try {
    outputDir = realpathSync(dirname(output));
  } catch {
    fail("scan acceptance output directory is unavailable or unreadable");
  }
  const relativeDir = relative(checkout, outputDir);
  const outsideCheckout =
    relativeDir === ".." || relativeDir.startsWith("../") || relativeDir.startsWith("..\\");
  if (!outsideCheckout) {
    fail("scan acceptance output path must be outside the scanned checkout");
  }
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) {
    fail("scan acceptance output path must not be a symbolic link");
  }
  return output;
}

/**
 * Read-only audit of a supplied Superpowers checkout against a supplied committed
 * acceptance artifact. The audit never changes the artifact and never authorizes
 * a scan/provisioning decision; its only optional mutation is a caller-selected
 * JSON report outside the scanned source tree.
 */
export async function checkSuperpowersScanAcceptance(
  input: ScanAcceptanceCheckInput,
): Promise<ScanAcceptanceCheckReport> {
  const acceptance = parseAcceptance(input.acceptance);
  const observations = parseObservations(input.observations);
  const checkout = await assertExternalPinnedCheckout(
    input.checkoutPath,
    input.runner ?? defaultRunner,
  );
  const observed = observations.map((entry) => ({
    ...entry,
    fileSha256: hashObservedFile(checkout, entry.path),
  }));
  const observedByPath = new Map(observed.map((entry) => [tupleKey(entry), entry]));
  const acceptedEntries = [...acceptance.accepted].sort(compareTuples);
  const accepted: ScanAcceptanceObservedTuple[] = [];
  const stale: ScanAcceptanceTuple[] = [];
  const missing: ScanAcceptanceTuple[] = [];
  for (const entry of acceptedEntries) {
    const tuple: ScanAcceptanceTuple = {
      code: entry.code,
      path: entry.path,
      fileSha256: entry.fileSha256,
    };
    if (hashObservedFile(checkout, entry.path) !== entry.fileSha256) {
      stale.push(tuple);
      continue;
    }
    const current = observedByPath.get(tupleKey(tuple));
    if (current === undefined) {
      missing.push(tuple);
      continue;
    }
    if (current.severity !== "critical") accepted.push(current);
  }
  const acceptedKeys = new Set(accepted.map(fullTupleKey));
  const critical = observed.filter((entry) => entry.severity === "critical");
  const newFindings = observed.filter(
    (entry) => entry.severity === "critical" || !acceptedKeys.has(fullTupleKey(entry)),
  );
  const report: ScanAcceptanceCheckReport = {
    checkout: { path: checkout, commitSha: SUPERPOWERS_ACCEPTANCE_COMMIT },
    observations: observed,
    accepted,
    stale,
    missing,
    new: newFindings,
    critical,
    authorizes: false,
  };
  if (input.outputPath !== undefined) {
    writeFileSync(
      assertOutputOutsideCheckout(input.outputPath, checkout),
      `${JSON.stringify(report)}\n`,
      "utf8",
    );
  }
  return report;
}

/** Audit the repository's committed Superpowers acceptance artifact. */
export async function checkShippedSuperpowersScanAcceptance(
  input: ShippedScanAcceptanceCheckInput,
): Promise<ScanAcceptanceCheckReport> {
  return checkSuperpowersScanAcceptance({ ...input, acceptance: shippedAcceptanceJson });
}
