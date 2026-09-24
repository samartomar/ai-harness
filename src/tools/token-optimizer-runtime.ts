import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  type BigIntStats,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readBoundedFileDescriptor } from "../internals/fsxn.js";
import { hermeticGitEnv } from "../internals/git-env.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import { findOnPath } from "../live/runner.js";

/** The two root-scoped profiles supported by the ordinary adopter flow. */
export type TokenOptimizerProfile = "quiet" | "balanced";

export type DeveloperToolLifecycleState =
  | "selected-pending"
  | "installed"
  | "configured"
  | "verified"
  | "policy-excluded"
  | "blocked";

export interface TokenOptimizerProject {
  readonly canonicalRoot: string;
  readonly stateRoot: string;
}

/**
 * A receipt claim is content-bound. A path by itself is never enough to remove
 * a project setting, because a user may have edited or replaced it since the
 * tool was configured.
 */
export interface TokenOptimizerOwnedPath {
  readonly path: string;
  readonly sha256: string;
  readonly ownership: "file" | "managed-block";
}

export interface TokenOptimizerReceipt {
  readonly version: "developer-tool-receipt/v1";
  readonly toolId: "token-optimizer";
  readonly sourceDigest: string;
  readonly canonicalRoot: string;
  readonly profile: TokenOptimizerProfile;
  readonly ownedPaths: readonly TokenOptimizerOwnedPath[];
}

export interface TokenOptimizerReconcileInput {
  readonly project: TokenOptimizerProject;
  readonly installRoot: string;
  readonly selected: boolean;
  readonly acceptLicense: boolean;
  readonly profile: TokenOptimizerProfile;
}

export interface TokenOptimizerAcquireRequest {
  readonly installRoot: string;
  readonly source: typeof TOKEN_OPTIMIZER_PIN;
}

export interface TokenOptimizerAcquireResult {
  readonly checkoutRoot: string;
  readonly sourceDigest: string;
  readonly reused: boolean;
}

export interface TokenOptimizerVerifyRequest {
  readonly checkoutRoot: string;
  readonly project: TokenOptimizerProject;
  readonly profile: TokenOptimizerProfile;
}

export interface TokenOptimizerConfigureRequest extends TokenOptimizerVerifyRequest {
  readonly sourceDigest: string;
  readonly existingReceipt?: TokenOptimizerReceipt;
}

export interface TokenOptimizerConfigureResult {
  readonly ownedPaths: readonly TokenOptimizerOwnedPath[];
  readonly detail: string;
  readonly changed: boolean;
}

export interface TokenOptimizerReconcileDeps {
  readonly acquire?: (
    request: TokenOptimizerAcquireRequest,
  ) => Promise<TokenOptimizerAcquireResult>;
  readonly configure?: (
    request: TokenOptimizerConfigureRequest,
  ) => Promise<TokenOptimizerConfigureResult>;
  readonly verifyRuntime?: (
    request: TokenOptimizerVerifyRequest,
  ) => Promise<{ readonly ok: boolean; readonly detail: string }>;
  readonly readReceipt?: (path: string) => Promise<unknown | undefined>;
  readonly writeReceipt?: (path: string, value: TokenOptimizerReceipt) => Promise<void>;
  readonly deleteReceipt?: (path: string) => Promise<void>;
}

export interface TokenOptimizerReconcileResult {
  readonly toolId: "token-optimizer";
  readonly state: DeveloperToolLifecycleState;
  readonly detail: string;
  readonly receipt?: TokenOptimizerReceipt;
  readonly changed: boolean;
}

/** The qualified fallback binds the latest verified immutable source identity. */
export const TOKEN_OPTIMIZER_PIN = {
  repository: "alexgreensh/token-optimizer",
  tag: "v5.13.21",
  commit: "e3c0fa6223b1a936bfc32485651f2f03add5c52b",
  tree: "e954dfc0f4d521149fc47abd01d4b26a1e38175b",
  manifestSha256: "3c451a291818c7937e20cd114cafcf98eded4cd42cca53adfcd75b6bd3da4a6f",
  manifestRecords: 159,
} as const;

const TOKEN_OPTIMIZER_MARKER = "token-optimizer/scripts";
export const TOKEN_OPTIMIZER_SOURCE_DIGEST = `git-sha1:${TOKEN_OPTIMIZER_PIN.commit};tree:${TOKEN_OPTIMIZER_PIN.tree};manifest-sha256:${TOKEN_OPTIMIZER_PIN.manifestSha256}`;
export const TOKEN_OPTIMIZER_LICENSE = "PolyForm-Noncommercial-1.0.0";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_PATH_CHARS = 8_192;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_CHECKSUM_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CHECKOUT_ENTRIES = 50_000;

export function tokenOptimizerReceiptPath(project: TokenOptimizerProject): string {
  return join(project.stateRoot, "token-optimizer", "receipt.json");
}

export function tokenOptimizerIntegrationPath(project: TokenOptimizerProject): string {
  return join(project.stateRoot, "token-optimizer", "integration.json");
}

export interface TokenOptimizerCommandInvocation {
  readonly argv: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Build the supported, on-demand report operation without executing it. */
export function buildTokenOptimizerReportInvocation(
  checkoutRoot: string,
  project: TokenOptimizerProject,
  pythonExecutable?: string,
): TokenOptimizerCommandInvocation {
  const executable =
    pythonExecutable ??
    defaultPythonExecutable(tokenOptimizerExecutableExclusions(project, checkoutRoot));
  const script = join(checkoutRoot, "skills", "token-optimizer", "scripts", "measure.py");
  const reportRoot = join(project.stateRoot, "token-optimizer", "report-data");
  const syntheticHome = join(project.stateRoot, "token-optimizer", "synthetic-home");
  const codexHome = join(syntheticHome, ".codex");
  const env = scopedPythonEnv({
    snapshotDir: reportRoot,
    codexHome,
    home: syntheticHome,
  });
  return {
    argv: [executable, script, "report"],
    cwd: project.canonicalRoot,
    env,
  };
}

/**
 * Hash the canonical JSON representation of one upstream hook group. This is
 * the content identity used by receipt-owned managed-block claims.
 */
export function tokenOptimizerManagedBlockSha256(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

export interface TokenOptimizerDefaultDepsOptions {
  /** Process seam used by production and focused tests. */
  readonly runner?: Runner;
  /** Absolute Python executable in production; tests may provide a fixed token. */
  readonly pythonExecutable?: string;
  /** Curl executable used to fetch the signed release manifest. */
  readonly curlExecutable?: string;
}

/**
 * Concrete production seams. The orchestrator can inject narrow callbacks for
 * tests, while omitted callbacks still acquire, configure, and verify the
 * actual pinned upstream tool.
 */
export function createDefaultTokenOptimizerDeps(
  options: TokenOptimizerDefaultDepsOptions = {},
): Required<
  Pick<
    TokenOptimizerReconcileDeps,
    "acquire" | "configure" | "verifyRuntime" | "readReceipt" | "writeReceipt" | "deleteReceipt"
  >
> {
  const runner = options.runner ?? defaultRunner;
  return {
    acquire: (request) => acquirePinnedTokenOptimizer(request, runner, options.curlExecutable),
    configure: (request) =>
      configureTokenOptimizerProject(request, runner, options.pythonExecutable),
    verifyRuntime: (request) =>
      verifyTokenOptimizerReport(request, runner, options.pythonExecutable),
    readReceipt: async (path) => readReceiptFile(path),
    writeReceipt: async (path, value) => writeReceiptFile(path, value),
    deleteReceipt: async (path) => deleteReceiptFile(path),
  };
}

/** Reconcile one project without letting a failed optional tool stop siblings. */
export async function reconcileTokenOptimizer(
  input: TokenOptimizerReconcileInput,
  deps: TokenOptimizerReconcileDeps = {},
): Promise<TokenOptimizerReconcileResult> {
  const normalized = validateInput(input);
  const defaults = createDefaultTokenOptimizerDeps();
  const effective = {
    acquire: deps.acquire ?? defaults.acquire,
    configure: deps.configure ?? defaults.configure,
    verifyRuntime: deps.verifyRuntime ?? defaults.verifyRuntime,
    readReceipt: deps.readReceipt ?? defaults.readReceipt,
    writeReceipt: deps.writeReceipt ?? defaults.writeReceipt,
    deleteReceipt: deps.deleteReceipt ?? defaults.deleteReceipt,
  };
  const receiptPath = tokenOptimizerReceiptPath(normalized.project);
  const rawReceipt = await effective.readReceipt(receiptPath);
  const receipt =
    rawReceipt === undefined ? undefined : validateReceipt(rawReceipt, normalized.project);

  if (!normalized.input.selected) {
    return reconcileExcluded(normalized.project, receiptPath, receipt, effective);
  }

  if (!normalized.input.acceptLicense) {
    return {
      toolId: "token-optimizer",
      state: "blocked",
      detail:
        "Token Optimizer is selected but blocked until the user accepts its PolyForm Noncommercial license; no acquisition or configuration was attempted",
      receipt,
      changed: false,
    };
  }

  if (receipt !== undefined) {
    const existingStatus = inspectOwnedIntegration(receipt, normalized.project);
    if (existingStatus.conflict !== undefined) {
      return {
        toolId: "token-optimizer",
        state: "blocked",
        detail: existingStatus.conflict,
        receipt,
        changed: false,
      };
    }
  }

  let acquired: TokenOptimizerAcquireResult;
  try {
    acquired = await effective.acquire({
      installRoot: normalized.installRoot,
      source: TOKEN_OPTIMIZER_PIN,
    });
    validateAcquireResult(acquired);
  } catch (error) {
    return blockedResult(
      receipt,
      `Token Optimizer acquisition was blocked: ${safeErrorDetail(error)}`,
    );
  }

  let configured: TokenOptimizerConfigureResult;
  try {
    configured = await effective.configure({
      checkoutRoot: resolve(acquired.checkoutRoot),
      project: normalized.project,
      profile: normalized.input.profile,
      sourceDigest: acquired.sourceDigest,
      existingReceipt: receipt,
    });
    validateConfigureResult(configured, normalized.project);
    validateConfiguredIntegration(
      configured.ownedPaths,
      normalized.project,
      resolve(acquired.checkoutRoot),
      normalized.input.profile,
    );
  } catch (error) {
    return blockedResult(
      receipt,
      `Token Optimizer project configuration was blocked: ${safeErrorDetail(error)}`,
      acquired.reused === false,
    );
  }

  const nextReceipt: TokenOptimizerReceipt = {
    version: "developer-tool-receipt/v1",
    toolId: "token-optimizer",
    sourceDigest: acquired.sourceDigest,
    canonicalRoot: normalized.project.canonicalRoot,
    profile: normalized.input.profile,
    ownedPaths: Object.freeze(configured.ownedPaths.map((owned) => ({ ...owned }))),
  };
  const receiptChanged =
    receipt === undefined || canonicalJson(receipt) !== canonicalJson(nextReceipt);
  try {
    if (receiptChanged) await effective.writeReceipt(receiptPath, nextReceipt);
  } catch (error) {
    return blockedResult(
      receipt ?? nextReceipt,
      `Token Optimizer ownership receipt could not be persisted: ${safeErrorDetail(error)}`,
      acquired.reused === false || configured.changed,
    );
  }

  let verification: { readonly ok: boolean; readonly detail: string };
  try {
    verification = await effective.verifyRuntime({
      checkoutRoot: resolve(acquired.checkoutRoot),
      project: normalized.project,
      profile: normalized.input.profile,
    });
    if (
      verification === null ||
      typeof verification !== "object" ||
      typeof verification.ok !== "boolean" ||
      typeof verification.detail !== "string" ||
      verification.detail.length === 0
    ) {
      throw new Error("verifier returned an invalid result");
    }
  } catch (error) {
    return blockedResult(
      nextReceipt,
      `Token Optimizer verification was blocked: ${safeErrorDetail(error)}`,
      acquired.reused === false || configured.changed || receiptChanged,
    );
  }
  if (verification.ok !== true) {
    return blockedResult(
      nextReceipt,
      `Token Optimizer verification was blocked: ${verification.detail}`,
      acquired.reused === false || configured.changed || receiptChanged,
    );
  }

  return {
    toolId: "token-optimizer",
    state: "verified",
    detail: `Token Optimizer ${normalized.input.profile} profile is configured and verified with an offline report: ${verification.detail}`,
    receipt: nextReceipt,
    changed: acquired.reused === false || configured.changed || receiptChanged,
  };
}

interface NormalizedInput {
  readonly input: TokenOptimizerReconcileInput;
  readonly project: TokenOptimizerProject;
  readonly installRoot: string;
}

function validateInput(input: TokenOptimizerReconcileInput): NormalizedInput {
  if (input === null || typeof input !== "object") throw new Error("invalid Token Optimizer input");
  if (typeof input.selected !== "boolean" || typeof input.acceptLicense !== "boolean") {
    throw new Error("invalid Token Optimizer selection or license flag");
  }
  if (input.profile !== "quiet" && input.profile !== "balanced") {
    throw new Error("invalid Token Optimizer profile");
  }
  if (input.project === null || typeof input.project !== "object") {
    throw new Error("invalid Token Optimizer project");
  }
  const canonicalRoot = validateDirectoryPath(
    input.project.canonicalRoot,
    "project canonicalRoot",
    true,
  );
  const stateRoot = validateDirectoryPath(input.project.stateRoot, "project stateRoot", false);
  const installRoot = validateDirectoryPath(input.installRoot, "installRoot", false);
  const project = { canonicalRoot, stateRoot } as const;
  // The install cache may be shared by projects, but never allow it to resolve
  // to a file. A state root may intentionally be project-local.
  if (samePath(installRoot, canonicalRoot)) {
    throw new Error("installRoot must be distinct from project canonicalRoot");
  }
  return { input, project, installRoot };
}

function validateDirectoryPath(value: unknown, label: string, mustExist: boolean): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_CHARS ||
    !isSafeText(value)
  ) {
    throw new Error(`invalid ${label}`);
  }
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const absolute = resolve(value);
  assertNoSymlinkOnExistingPath(absolute, label);
  if (!existsSync(absolute)) {
    if (mustExist) throw new Error(`${label} does not exist`);
    return absolute;
  }
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`${label} must be a regular directory`);
  return resolve(absolute);
}

function assertNoSymlinkOnExistingPath(path: string, label: string): void {
  let current = path;
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`${label} traverses a symlink`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function validateReceipt(value: unknown, project: TokenOptimizerProject): TokenOptimizerReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Token Optimizer receipt");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    canonicalJson(keys) !==
    canonicalJson(["canonicalRoot", "ownedPaths", "profile", "sourceDigest", "toolId", "version"])
  ) {
    throw new Error("invalid Token Optimizer receipt fields");
  }
  if (record.version !== "developer-tool-receipt/v1" || record.toolId !== "token-optimizer") {
    throw new Error("invalid Token Optimizer receipt identity");
  }
  if (
    typeof record.sourceDigest !== "string" ||
    record.sourceDigest.length === 0 ||
    record.sourceDigest.length > 512 ||
    !isSafeText(record.sourceDigest)
  ) {
    throw new Error("invalid Token Optimizer receipt source identity");
  }
  if (record.profile !== "quiet" && record.profile !== "balanced") {
    throw new Error("invalid Token Optimizer receipt profile");
  }
  if (typeof record.canonicalRoot !== "string" || !isAbsolute(record.canonicalRoot)) {
    throw new Error("invalid Token Optimizer receipt canonical root");
  }
  if (!samePath(record.canonicalRoot, project.canonicalRoot)) {
    throw new Error("Token Optimizer receipt canonical root does not match the project");
  }
  if (!Array.isArray(record.ownedPaths) || record.ownedPaths.length > 256) {
    throw new Error("invalid Token Optimizer receipt owned paths");
  }
  const ownedPaths: TokenOptimizerOwnedPath[] = [];
  const seen = new Set<string>();
  for (const value of record.ownedPaths) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid Token Optimizer receipt owned path");
    }
    const pathRecord = value as Record<string, unknown>;
    const pathKeys = Object.keys(pathRecord).sort();
    if (canonicalJson(pathKeys) !== canonicalJson(["ownership", "path", "sha256"])) {
      throw new Error("invalid Token Optimizer receipt owned path fields");
    }
    if (
      typeof pathRecord.path !== "string" ||
      !isAbsolute(pathRecord.path) ||
      !isSafeText(pathRecord.path) ||
      pathRecord.path.includes("#") ||
      typeof pathRecord.sha256 !== "string" ||
      !SHA256_HEX.test(pathRecord.sha256) ||
      (pathRecord.ownership !== "file" && pathRecord.ownership !== "managed-block")
    ) {
      throw new Error("invalid Token Optimizer receipt owned path identity");
    }
    const path = resolve(pathRecord.path);
    if (!isOwnedRootPath(path, project)) {
      throw new Error("Token Optimizer receipt owned path escapes project state");
    }
    const integrationPath = resolve(tokenOptimizerIntegrationPath(project));
    const hooksPath = resolve(join(project.canonicalRoot, ".codex", "hooks.json"));
    if (
      (pathRecord.ownership === "file" && !samePath(path, integrationPath)) ||
      (pathRecord.ownership === "managed-block" && !samePath(path, hooksPath))
    ) {
      throw new Error("Token Optimizer receipt owned path is outside the integration allowlist");
    }
    assertNoSymlinkOnExistingPath(path, "Token Optimizer receipt owned path");
    const identity = `${path}\0${pathRecord.sha256}\0${pathRecord.ownership}`;
    if (seen.has(identity)) throw new Error("ambiguous Token Optimizer receipt owned path");
    seen.add(identity);
    ownedPaths.push({
      path,
      sha256: pathRecord.sha256 as string,
      ownership: pathRecord.ownership,
    });
  }
  const ownershipByPath = new Map<string, string>();
  for (const owned of ownedPaths) {
    const prior = ownershipByPath.get(owned.path);
    if (prior !== undefined && prior !== owned.ownership) {
      throw new Error("ambiguous Token Optimizer receipt ownership claim");
    }
    ownershipByPath.set(owned.path, owned.ownership);
  }
  return {
    version: "developer-tool-receipt/v1",
    toolId: "token-optimizer",
    sourceDigest: record.sourceDigest,
    canonicalRoot: project.canonicalRoot,
    profile: record.profile,
    ownedPaths: Object.freeze(ownedPaths),
  };
}

function validateAcquireResult(result: TokenOptimizerAcquireResult): void {
  if (result === null || typeof result !== "object") throw new Error("invalid acquisition result");
  if (
    typeof result.checkoutRoot !== "string" ||
    !isAbsolute(result.checkoutRoot) ||
    typeof result.sourceDigest !== "string" ||
    result.sourceDigest.length === 0 ||
    !isSafeText(result.sourceDigest) ||
    typeof result.reused !== "boolean"
  ) {
    throw new Error("invalid acquisition result identity");
  }
  const checkoutRoot = resolve(result.checkoutRoot);
  if (!existsSync(checkoutRoot) || !lstatSync(checkoutRoot).isDirectory()) {
    throw new Error("acquisition checkout root does not exist");
  }
}

function validateConfigureResult(
  result: TokenOptimizerConfigureResult,
  project: TokenOptimizerProject,
): void {
  if (result === null || typeof result !== "object" || typeof result.changed !== "boolean") {
    throw new Error("invalid configuration result");
  }
  if (
    typeof result.detail !== "string" ||
    result.detail.length === 0 ||
    !Array.isArray(result.ownedPaths)
  ) {
    throw new Error("invalid configuration result detail");
  }
  const receiptLike: TokenOptimizerReceipt = {
    version: "developer-tool-receipt/v1",
    toolId: "token-optimizer",
    sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
    canonicalRoot: project.canonicalRoot,
    profile: "quiet",
    ownedPaths: result.ownedPaths,
  };
  validateReceipt(receiptLike, project);
}

interface IntegrationInspection {
  readonly conflict?: string;
}

function inspectOwnedIntegration(
  receipt: TokenOptimizerReceipt,
  project: TokenOptimizerProject,
): IntegrationInspection {
  const paths = receipt.ownedPaths;
  const fileClaims = paths.filter((owned) => owned.ownership === "file");
  const managedClaims = paths.filter((owned) => owned.ownership === "managed-block");
  for (const owned of fileClaims) {
    const status = inspectOwnedFile(owned);
    if (status !== undefined) return { conflict: status };
  }
  const byPath = new Map<string, TokenOptimizerOwnedPath[]>();
  for (const owned of managedClaims) {
    const group = byPath.get(owned.path) ?? [];
    group.push(owned);
    byPath.set(owned.path, group);
  }
  for (const [path, claims] of byPath) {
    const status = inspectManagedBlocks(path, claims);
    if (status !== undefined) return { conflict: status };
  }
  // Keep this explicit so future ownership classes cannot silently broaden the
  // cleanup roots without changing the receipt validator.
  if (paths.some((owned) => !isOwnedRootPath(owned.path, project))) {
    return {
      conflict:
        "Token Optimizer receipt ownership escaped the project roots; integration preserved",
    };
  }
  return {};
}

function inspectOwnedFile(owned: TokenOptimizerOwnedPath): string | undefined {
  return inspectOwnedFileSnapshot(owned).conflict;
}

function inspectOwnedFileSnapshot(owned: TokenOptimizerOwnedPath): {
  readonly conflict?: string;
  readonly snapshot?: RegularFileSnapshot;
} {
  try {
    assertNoSymlinkOnExistingPath(owned.path, "Token Optimizer receipt-owned path");
  } catch {
    return {
      conflict: `Token Optimizer receipt-owned path traverses a symlink; integration preserved (${owned.path})`,
    };
  }
  if (!existsSync(owned.path)) return {};
  try {
    const snapshot = readRegularFileSnapshot(
      owned.path,
      MAX_RECEIPT_BYTES,
      "Token Optimizer receipt-owned path",
    );
    if (snapshot.sha256 !== owned.sha256) {
      return {
        conflict: `Token Optimizer receipt-owned file changed; integration preserved (${owned.path})`,
      };
    }
    return { snapshot };
  } catch {
    return {
      conflict: `Token Optimizer receipt-owned file could not be inspected; integration preserved (${owned.path})`,
    };
  }
}

function inspectManagedBlocks(
  path: string,
  claims: readonly TokenOptimizerOwnedPath[],
): string | undefined {
  try {
    assertNoSymlinkOnExistingPath(path, "Token Optimizer hooks path");
  } catch {
    return `Token Optimizer hooks path traverses a symlink; integration preserved (${path})`;
  }
  if (!existsSync(path)) return undefined;
  try {
    const { root: parsed } = readHooksSnapshot(path);
    const expected = new Set(claims.map((claim) => claim.sha256));
    for (const group of hookGroups(parsed)) {
      const digest = tokenOptimizerManagedBlockSha256(group.value);
      if (containsTokenOptimizerMarker(group.value) && !expected.has(digest)) {
        return `Token Optimizer managed hook changed or is unreceipted; integration preserved (${path})`;
      }
    }
    return undefined;
  } catch {
    return `Token Optimizer hooks configuration is unreadable; integration preserved (${path})`;
  }
}

async function reconcileExcluded(
  project: TokenOptimizerProject,
  receiptPath: string,
  receipt: TokenOptimizerReceipt | undefined,
  deps: ReturnType<typeof createDefaultTokenOptimizerDeps>,
): Promise<TokenOptimizerReconcileResult> {
  if (receipt === undefined) {
    return {
      toolId: "token-optimizer",
      state: "policy-excluded",
      detail: "Token Optimizer is policy-excluded; no owned integration was present",
      changed: false,
    };
  }
  const inspection = inspectOwnedIntegration(receipt, project);
  if (inspection.conflict !== undefined) {
    return {
      toolId: "token-optimizer",
      state: "blocked",
      detail: inspection.conflict,
      receipt,
      changed: false,
    };
  }
  const plan = planCleanup(receipt);
  if (plan.conflict !== undefined) {
    return {
      toolId: "token-optimizer",
      state: "blocked",
      detail: plan.conflict,
      receipt,
      changed: false,
    };
  }
  try {
    applyCleanup(plan);
    await deps.deleteReceipt(receiptPath);
  } catch (error) {
    return {
      toolId: "token-optimizer",
      state: "blocked",
      detail: `Token Optimizer policy exclusion could not complete safely: ${safeErrorDetail(error)}`,
      receipt,
      changed: plan.changed,
    };
  }
  return {
    toolId: "token-optimizer",
    state: "policy-excluded",
    detail:
      plan.changed || receipt.ownedPaths.length > 0
        ? "Token Optimizer is policy-excluded; unchanged receipt-owned integration was removed and custom project settings were preserved"
        : "Token Optimizer is policy-excluded",
    changed: plan.changed || receipt.ownedPaths.length > 0,
  };
}

interface RegularFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  // Existing receipts may own a regular hardlink; bind its link count rather than changing that policy.
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface RegularFileSnapshot {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly identity: RegularFileIdentity;
}

interface CleanupOperation {
  readonly kind: "remove-file" | "write-hooks";
  readonly path: string;
  readonly expectedSha256?: string;
  readonly expectedIdentity?: RegularFileIdentity;
  readonly bytes?: Buffer;
}

interface CleanupPlan {
  readonly operations: readonly CleanupOperation[];
  readonly conflict?: string;
  readonly changed: boolean;
}

function planCleanup(receipt: TokenOptimizerReceipt): CleanupPlan {
  const operations: CleanupOperation[] = [];
  const managedByPath = new Map<string, TokenOptimizerOwnedPath[]>();
  for (const owned of receipt.ownedPaths) {
    if (owned.ownership === "file") {
      if (!existsSync(owned.path)) continue;
      const inspection = inspectOwnedFileSnapshot(owned);
      if (inspection.conflict !== undefined)
        return { operations: [], conflict: inspection.conflict, changed: false };
      if (inspection.snapshot === undefined) continue;
      operations.push({
        kind: "remove-file",
        path: owned.path,
        expectedSha256: inspection.snapshot.sha256,
        expectedIdentity: inspection.snapshot.identity,
      });
      continue;
    }
    const claims = managedByPath.get(owned.path) ?? [];
    claims.push(owned);
    managedByPath.set(owned.path, claims);
  }
  for (const [path, claims] of managedByPath) {
    if (!existsSync(path)) continue;
    let hooksSnapshot: {
      readonly root: Record<string, unknown>;
      readonly snapshot: RegularFileSnapshot;
    };
    try {
      hooksSnapshot = readHooksSnapshot(path);
    } catch {
      return {
        operations: [],
        conflict: `Token Optimizer hooks configuration is unreadable; integration preserved (${path})`,
        changed: false,
      };
    }
    const expected = new Set(claims.map((claim) => claim.sha256));
    let removed = 0;
    const hooks = hooksSnapshot.root.hooks;
    if (hooks !== null && typeof hooks === "object" && !Array.isArray(hooks)) {
      const hookObject = hooks as Record<string, unknown>;
      for (const [event, value] of Object.entries(hookObject)) {
        if (!Array.isArray(value)) continue;
        const kept: unknown[] = [];
        for (const group of value) {
          const digest = tokenOptimizerManagedBlockSha256(group);
          if (expected.has(digest)) {
            removed += 1;
            continue;
          }
          if (containsTokenOptimizerMarker(group)) {
            return {
              operations: [],
              conflict: `Token Optimizer managed hook changed or is unreceipted; integration preserved (${path})`,
              changed: false,
            };
          }
          kept.push(group);
        }
        if (kept.length === 0) delete hookObject[event];
        else hookObject[event] = kept;
      }
    }
    if (removed > 0) {
      const bytes = Buffer.from(`${JSON.stringify(hooksSnapshot.root, null, 2)}\n`, "utf8");
      operations.push({
        kind: "write-hooks",
        path,
        bytes,
        expectedSha256: hooksSnapshot.snapshot.sha256,
        expectedIdentity: hooksSnapshot.snapshot.identity,
      });
    }
  }
  return { operations, changed: operations.length > 0 };
}

function applyCleanup(plan: CleanupPlan): void {
  for (const operation of plan.operations) {
    if (operation.kind === "remove-file") {
      if (!existsSync(operation.path)) continue;
      let snapshot: RegularFileSnapshot;
      try {
        snapshot = readRegularFileSnapshot(
          operation.path,
          MAX_RECEIPT_BYTES,
          "Token Optimizer receipt-owned path",
        );
      } catch {
        throw new Error(`owned path changed before removal (${operation.path})`);
      }
      if (!cleanupSnapshotMatches(operation, snapshot)) {
        throw new Error(`owned path changed before removal (${operation.path})`);
      }
      assertSnapshotStillNamesFile(
        operation.path,
        snapshot.identity,
        `owned path changed before removal (${operation.path})`,
      );
      unlinkSync(operation.path);
      continue;
    }
    if (operation.bytes === undefined) throw new Error("invalid cleanup operation");
    if (!existsSync(operation.path))
      throw new Error(`hooks path changed before removal (${operation.path})`);
    let snapshot: RegularFileSnapshot;
    try {
      snapshot = readRegularFileSnapshot(
        operation.path,
        MAX_RECEIPT_BYTES,
        "Token Optimizer hooks path",
      );
    } catch {
      throw new Error(`hooks path changed before removal (${operation.path})`);
    }
    if (!cleanupSnapshotMatches(operation, snapshot)) {
      throw new Error(`hooks path changed before removal (${operation.path})`);
    }
    writeFileAtomically(operation.path, operation.bytes, snapshot.identity);
  }
}

function cleanupSnapshotMatches(
  operation: CleanupOperation,
  snapshot: RegularFileSnapshot,
): boolean {
  return (
    (operation.expectedSha256 === undefined || operation.expectedSha256 === snapshot.sha256) &&
    (operation.expectedIdentity === undefined ||
      sameRegularFileIdentity(operation.expectedIdentity, snapshot.identity))
  );
}

interface HookGroup {
  readonly event: string;
  readonly index: number;
  readonly value: unknown;
}

function hookGroups(root: Record<string, unknown>): HookGroup[] {
  const hooks = root.hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const groups: HookGroup[] = [];
  for (const [event, value] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const [index, group] of value.entries()) {
      groups.push({ event, index, value: group });
    }
  }
  return groups;
}

function containsTokenOptimizerMarker(value: unknown): boolean {
  if (typeof value === "string") {
    const normalized = value.replace(/\\/g, "/");
    // Retain legacy recognition for receipt-owned upgrades and exclusions.
    // Recognition alone never admits a command: configuration validates its
    // complete argv, selected interpreter and immutable checkout below.
    return (
      normalized.includes(TOKEN_OPTIMIZER_MARKER) ||
      (normalized.includes("TOKEN_OPTIMIZER_RUNTIME=codex") && normalized.includes("/hooks/run.py"))
    );
  }
  if (Array.isArray(value)) return value.some((item) => containsTokenOptimizerMarker(item));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) =>
      containsTokenOptimizerMarker(item),
    );
  }
  return false;
}

function isOwnedRootPath(path: string, project: TokenOptimizerProject): boolean {
  return isWithin(project.canonicalRoot, path) || isWithin(project.stateRoot, path);
}

function isWithin(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function acquirePinnedTokenOptimizer(
  request: TokenOptimizerAcquireRequest,
  runner: Runner,
  curlExecutableOverride: string | undefined,
): Promise<TokenOptimizerAcquireResult> {
  assertPinnedSource(request.source);
  const installRoot = validateDirectoryPath(request.installRoot, "installRoot", false);
  const versionRoot = join(installRoot, "token-optimizer", request.source.tag);
  assertNoSymlinkOnExistingPath(versionRoot, "Token Optimizer cache");
  const excludedRoots = [installRoot, versionRoot] as const;
  const gitExecutable = requiredExternalExecutable("git", excludedRoots);
  const curlExecutable = curlExecutableOverride ?? defaultCurlExecutable(excludedRoots);
  if (existsSync(versionRoot)) {
    if (!lstatSync(versionRoot).isDirectory())
      throw new Error("Token Optimizer cache is not a directory");
    await authenticateCheckout(versionRoot, request.source, runner, gitExecutable, curlExecutable);
    return {
      checkoutRoot: resolve(versionRoot),
      sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
      reused: true,
    };
  }
  mkdirSync(dirname(versionRoot), { recursive: true });
  const staging = createStagingDirectory(installRoot);
  try {
    const remote = `https://github.com/${request.source.repository}.git`;
    await runGit(
      runner,
      gitExecutable,
      [
        "clone",
        "--config",
        "core.autocrlf=false",
        "--config",
        "core.eol=lf",
        "--branch",
        request.source.tag,
        "--single-branch",
        remote,
        staging,
      ],
      installRoot,
    );
    await runGit(
      runner,
      gitExecutable,
      ["-C", staging, "config", "core.autocrlf", "false"],
      installRoot,
    );
    await runGit(runner, gitExecutable, ["-C", staging, "config", "core.eol", "lf"], installRoot);
    await runGit(
      runner,
      gitExecutable,
      ["-C", staging, "checkout", "--detach", "--force", request.source.commit],
      installRoot,
    );
    await authenticateCheckout(staging, request.source, runner, gitExecutable, curlExecutable);
    moveStagingIntoPlace(staging, versionRoot);
    return {
      checkoutRoot: resolve(versionRoot),
      sourceDigest: TOKEN_OPTIMIZER_SOURCE_DIGEST,
      reused: false,
    };
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function assertPinnedSource(source: typeof TOKEN_OPTIMIZER_PIN): void {
  if (
    source.repository !== TOKEN_OPTIMIZER_PIN.repository ||
    source.tag !== TOKEN_OPTIMIZER_PIN.tag ||
    source.commit !== TOKEN_OPTIMIZER_PIN.commit ||
    source.tree !== TOKEN_OPTIMIZER_PIN.tree ||
    source.manifestSha256 !== TOKEN_OPTIMIZER_PIN.manifestSha256 ||
    source.manifestRecords !== TOKEN_OPTIMIZER_PIN.manifestRecords
  ) {
    throw new Error("Token Optimizer source is not the qualified immutable pin");
  }
}

function createStagingDirectory(installRoot: string): string {
  const staging = join(
    installRoot,
    `.token-optimizer-staging-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(staging, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  return staging;
}

function moveStagingIntoPlace(staging: string, target: string): void {
  if (existsSync(target)) throw new Error("Token Optimizer cache appeared during acquisition");
  try {
    renameSync(staging, target);
  } catch (error) {
    if (existsSync(target)) throw error;
    throw new Error("Token Optimizer cache could not be committed");
  }
}

async function runGit(
  runner: Runner,
  gitExecutable: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const result = await runner([gitExecutable, ...args], {
    cwd,
    env: { ...hermeticGitEnv(), GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: 120_000,
    maxBufferBytes: 16 * 1024 * 1024,
  });
  if (result.code !== 0 || result.spawnError === true || result.truncated === true) {
    throw new Error(`git ${args[0] ?? "operation"} failed`);
  }
  return result.stdout;
}

async function fetchReleaseManifest(
  source: typeof TOKEN_OPTIMIZER_PIN,
  runner: Runner,
  curlExecutable: string,
): Promise<Buffer> {
  const url = `https://github.com/${source.repository}/releases/download/${source.tag}/CHECKSUMS.sha256`;
  const result = await runner(
    [curlExecutable, "--fail", "--location", "--silent", "--show-error", "--max-time", "120", url],
    {
      env: scopedNetworkEnv(),
      timeoutMs: 120_000,
      maxBufferBytes: MAX_MANIFEST_BYTES,
    },
  );
  if (result.code !== 0 || result.spawnError === true || result.truncated === true) {
    throw new Error("Token Optimizer release manifest download failed");
  }
  const bytes = Buffer.from(result.stdout, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error("Token Optimizer release manifest size is invalid");
  }
  return bytes;
}

async function authenticateCheckout(
  checkoutRoot: string,
  source: typeof TOKEN_OPTIMIZER_PIN,
  runner: Runner,
  gitExecutable: string,
  curlExecutable: string,
): Promise<void> {
  assertNoSymlinkTree(checkoutRoot);
  const head = (
    await runGit(runner, gitExecutable, ["-C", checkoutRoot, "rev-parse", "HEAD"], checkoutRoot)
  ).trim();
  if (head !== source.commit) throw new Error("Token Optimizer commit identity mismatch");
  const tagCommit = (
    await runGit(
      runner,
      gitExecutable,
      ["-C", checkoutRoot, "rev-parse", `${source.tag}^{commit}`],
      checkoutRoot,
    )
  ).trim();
  if (tagCommit !== source.commit) throw new Error("Token Optimizer tag identity mismatch");
  const tree = (
    await runGit(
      runner,
      gitExecutable,
      ["-C", checkoutRoot, "rev-parse", "HEAD^{tree}"],
      checkoutRoot,
    )
  ).trim();
  if (tree !== source.tree) throw new Error("Token Optimizer tree identity mismatch");
  const autocrlf = (
    await runGit(
      runner,
      gitExecutable,
      ["-C", checkoutRoot, "config", "--get", "core.autocrlf"],
      checkoutRoot,
    )
  ).trim();
  if (autocrlf !== "false") throw new Error("Token Optimizer checkout EOL conversion is enabled");
  const eol = (
    await runGit(
      runner,
      gitExecutable,
      ["-C", checkoutRoot, "config", "--get", "core.eol"],
      checkoutRoot,
    )
  ).trim();
  if (eol !== "lf") throw new Error("Token Optimizer checkout EOL policy is not LF");
  const manifest = await fetchReleaseManifest(source, runner, curlExecutable);
  if (sha256Hex(manifest) !== source.manifestSha256) {
    throw new Error("Token Optimizer manifest identity mismatch");
  }
  const records = parseManifest(manifest);
  if (records.length !== source.manifestRecords) {
    throw new Error("Token Optimizer manifest record count mismatch");
  }
  for (const record of records) {
    const path = resolve(checkoutRoot, record.path);
    if (!isWithin(checkoutRoot, path) || path === resolve(checkoutRoot)) {
      throw new Error("Token Optimizer manifest path escapes checkout");
    }
    const bytes = readRegularBytes(path, MAX_CHECKSUM_FILE_BYTES);
    if (sha256Hex(bytes) !== record.sha256) {
      throw new Error(`Token Optimizer manifest content mismatch (${record.path})`);
    }
  }
}

interface ManifestRecord {
  readonly path: string;
  readonly sha256: string;
}

function parseManifest(bytes: Buffer): ManifestRecord[] {
  if (bytes.includes(0) || bytes.includes(13))
    throw new Error("Token Optimizer manifest uses unsafe line endings");
  const text = bytes.toString("utf8");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const records: ManifestRecord[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (match === null) throw new Error("Token Optimizer manifest syntax mismatch");
    const path = match[2];
    const digest = match[1];
    if (path === undefined || digest === undefined)
      throw new Error("Token Optimizer manifest syntax mismatch");
    if (
      path.length === 0 ||
      path.includes("\\") ||
      isAbsolute(path) ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error("Token Optimizer manifest path is unsafe");
    }
    if (seen.has(path)) throw new Error("Token Optimizer manifest contains a duplicate path");
    seen.add(path);
    records.push({ path, sha256: digest });
  }
  return records;
}

function assertNoSymlinkTree(root: string): void {
  const stack = [root];
  let entries = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Token Optimizer checkout contains a symlink");
    if (!stat.isDirectory()) continue;
    for (const child of readdirSync(current)) {
      entries += 1;
      if (entries > MAX_CHECKOUT_ENTRIES) throw new Error("Token Optimizer checkout is too large");
      stack.push(join(current, child));
    }
  }
}

async function configureTokenOptimizerProject(
  request: TokenOptimizerConfigureRequest,
  runner: Runner,
  pythonExecutableOverride: string | undefined,
): Promise<TokenOptimizerConfigureResult> {
  const script = join(request.checkoutRoot, "skills", "token-optimizer", "scripts", "measure.py");
  assertRegularFile(script, "Token Optimizer measure script");
  const hooksPath = join(request.project.canonicalRoot, ".codex", "hooks.json");
  const beforeHooks = readOptionalRegularBytes(hooksPath);
  let beforeRoot: Record<string, unknown> | undefined;
  if (beforeHooks !== undefined) {
    beforeRoot = parseHooks(beforeHooks, hooksPath);
    if (
      hookGroups(beforeRoot).some((group) => containsTokenOptimizerMarker(group.value)) &&
      request.existingReceipt === undefined
    ) {
      throw new Error("existing Token Optimizer hooks have no ownership receipt");
    }
  }
  const integrationPath = tokenOptimizerIntegrationPath(request.project);
  const beforeIntegration = readOptionalRegularBytes(integrationPath);
  if (beforeIntegration !== undefined && request.existingReceipt === undefined) {
    throw new Error("existing Token Optimizer integration has no ownership receipt");
  }
  if (
    beforeIntegration !== undefined &&
    request.existingReceipt !== undefined &&
    !request.existingReceipt.ownedPaths.some(
      (owned) =>
        owned.ownership === "file" &&
        samePath(owned.path, integrationPath) &&
        owned.sha256 === sha256Hex(beforeIntegration),
    )
  ) {
    throw new Error("existing Token Optimizer integration is not receipt-owned");
  }
  const pythonExecutable =
    pythonExecutableOverride ??
    defaultPythonExecutable(
      tokenOptimizerExecutableExclusions(request.project, request.checkoutRoot),
    );
  let preparedOwnedHooks = false;
  if (request.existingReceipt !== undefined) {
    const receipt = validateReceipt(request.existingReceipt, request.project);
    const inspection = inspectOwnedIntegration(receipt, request.project);
    if (inspection.conflict !== undefined) throw new Error(inspection.conflict);
    const cleanup = planCleanup(receipt);
    if (cleanup.conflict !== undefined) throw new Error(cleanup.conflict);
    const operations = cleanup.operations.filter(
      (operation) => operation.kind === "write-hooks" && samePath(operation.path, hooksPath),
    );
    // The upstream installer can append its new wrappers on repeat setup.
    // Reuse receipt-bound cleanup to replace only unchanged owned groups.
    applyCleanup({ operations, changed: operations.length > 0 });
    preparedOwnedHooks = operations.length > 0;
  }
  try {
    const invocation = {
      argv: [
        pythonExecutable,
        script,
        "codex-install",
        "--project",
        request.project.canonicalRoot,
        "--profile",
        request.profile,
        "--skip-compact-prompt",
        "--json",
      ],
      cwd: request.project.canonicalRoot,
      env: scopedPythonEnv({
        snapshotDir: join(request.project.stateRoot, "token-optimizer", "install-data"),
        codexHome: join(request.project.stateRoot, "token-optimizer", "install-home", ".codex"),
        home: join(request.project.stateRoot, "token-optimizer", "install-home"),
      }),
    } satisfies TokenOptimizerCommandInvocation;
    const result = await runner(invocation.argv, {
      cwd: invocation.cwd,
      env: invocation.env,
      timeoutMs: 120_000,
      maxBufferBytes: 4 * 1024 * 1024,
    });
    if (result.code !== 0 || result.spawnError === true || result.truncated === true) {
      throw new Error("supported Codex project hook installer failed");
    }
    const afterHooks = readOptionalRegularBytes(hooksPath);
    if (afterHooks === undefined)
      throw new Error("supported Codex project hook installer produced no hooks");
    const afterRoot = parseHooks(afterHooks, hooksPath);
    const preservationError = inspectPreexistingConfiguration(beforeRoot, afterRoot);
    if (preservationError !== undefined) {
      try {
        if (beforeHooks !== undefined) writeFileAtomically(hooksPath, beforeHooks);
      } catch (error) {
        throw new Error(
          `${preservationError}; restoring the preexisting Codex hooks failed: ${safeErrorDetail(error)}`,
        );
      }
      throw new Error(preservationError);
    }
    const managed = hookGroups(afterRoot).filter((group) =>
      containsTokenOptimizerMarker(group.value),
    );
    if (managed.length === 0)
      throw new Error("supported Codex project hook installer produced no managed hooks");
    validateManagedHookConfiguration(
      afterRoot,
      request.checkoutRoot,
      request.profile,
      pythonExecutable,
    );

    const metadata = {
      version: "token-optimizer-integration/v1",
      toolId: "token-optimizer",
      license: TOKEN_OPTIMIZER_LICENSE,
      source: TOKEN_OPTIMIZER_PIN,
      sourceDigest: request.sourceDigest,
      canonicalRoot: request.project.canonicalRoot,
      checkoutRoot: resolve(request.checkoutRoot),
      profile: request.profile,
      report: {
        runtime: "codex",
        scope: "project",
        operation: "report",
      },
    } as const;
    const integrationBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    if (beforeIntegration === undefined || !beforeIntegration.equals(integrationBytes)) {
      writeFileAtomically(integrationPath, integrationBytes);
    }
    const ownedPaths: TokenOptimizerOwnedPath[] = [
      {
        path: resolve(integrationPath),
        sha256: sha256Hex(integrationBytes),
        ownership: "file",
      },
      ...managed.map((group) => ({
        path: resolve(hooksPath),
        sha256: tokenOptimizerManagedBlockSha256(group.value),
        ownership: "managed-block" as const,
      })),
    ];
    const changed =
      beforeHooks === undefined ||
      !beforeHooks.equals(afterHooks) ||
      beforeIntegration === undefined ||
      !beforeIntegration.equals(integrationBytes);
    return {
      ownedPaths,
      detail: "project-scoped Token Optimizer Codex hooks and on-demand report configured",
      changed,
    };
  } catch (error) {
    if (preparedOwnedHooks && beforeHooks !== undefined) {
      try {
        writeFileAtomically(hooksPath, beforeHooks);
      } catch (restoreError) {
        throw new Error(
          `Token Optimizer reconfiguration failed and restoring receipt-owned hooks failed: ${safeErrorDetail(restoreError)}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function inspectPreexistingConfiguration(
  beforeRoot: Record<string, unknown> | undefined,
  afterRoot: Record<string, unknown>,
): string | undefined {
  if (beforeRoot === undefined) return undefined;
  for (const [key, value] of Object.entries(beforeRoot)) {
    if (key === "hooks") continue;
    if (!(key in afterRoot) || canonicalJson(afterRoot[key]) !== canonicalJson(value)) {
      return `supported Codex project hook installer changed existing setting ${key}`;
    }
  }
  const beforeHooks = beforeRoot.hooks;
  const afterHooks = afterRoot.hooks;
  if (
    beforeHooks === null ||
    typeof beforeHooks !== "object" ||
    Array.isArray(beforeHooks) ||
    afterHooks === null ||
    typeof afterHooks !== "object" ||
    Array.isArray(afterHooks)
  ) {
    return canonicalJson(beforeHooks) === canonicalJson(afterHooks)
      ? undefined
      : "supported Codex project hook installer changed existing hooks configuration";
  }
  const afterHookObject = afterHooks as Record<string, unknown>;
  for (const [event, value] of Object.entries(beforeHooks as Record<string, unknown>)) {
    const afterValue = afterHookObject[event];
    if (!Array.isArray(value)) {
      if (canonicalJson(afterValue) !== canonicalJson(value)) {
        return `supported Codex project hook installer changed existing ${event} hook settings`;
      }
      continue;
    }
    if (!Array.isArray(afterValue)) {
      const customGroups = value.filter((group) => !containsTokenOptimizerMarker(group));
      if (customGroups.length > 0) {
        return `supported Codex project hook installer removed existing custom ${event} hooks`;
      }
      continue;
    }
    const remaining = [...afterValue];
    for (const group of value) {
      if (containsTokenOptimizerMarker(group)) continue;
      const index = remaining.findIndex(
        (candidate) => canonicalJson(candidate) === canonicalJson(group),
      );
      if (index < 0) {
        return `supported Codex project hook installer removed existing custom ${event} hooks`;
      }
      remaining.splice(index, 1);
    }
  }
  return undefined;
}

interface SupportedHookInvocation {
  readonly event: string;
  readonly script: string;
  readonly args: readonly string[];
  readonly quiet: boolean;
  readonly pythonExecutable?: string;
}

const SUPPORTED_HOOK_INVOCATIONS: readonly SupportedHookInvocation[] = [
  {
    event: "Stop",
    script: "hooks/stop_runner.py",
    args: [],
    quiet: true,
  },
  {
    event: "SessionStart",
    script: "hooks/sessionstart_runner.py",
    args: [],
    quiet: false,
  },
  {
    event: "UserPromptSubmit",
    script: "hooks/userpromptsubmit_runner.py",
    args: [],
    quiet: false,
  },
  {
    event: "SubagentStart",
    script: "skills/token-optimizer/scripts/codex_hook_bridge.py",
    args: ["subagent-start"],
    quiet: false,
  },
  {
    event: "SubagentStop",
    script: "skills/token-optimizer/scripts/codex_hook_bridge.py",
    args: ["subagent-stop"],
    quiet: true,
  },
];

function validateConfiguredIntegration(
  ownedPaths: readonly TokenOptimizerOwnedPath[],
  project: TokenOptimizerProject,
  checkoutRoot: string,
  profile: TokenOptimizerProfile,
): void {
  const integrationClaim = ownedPaths.find((owned) => owned.ownership === "file");
  if (
    integrationClaim === undefined ||
    !existsSync(integrationClaim.path) ||
    inspectOwnedFile(integrationClaim) !== undefined
  ) {
    throw new Error("Token Optimizer integration receipt does not match its configured file");
  }
  const hooksPath = resolve(join(project.canonicalRoot, ".codex", "hooks.json"));
  const hooksBytes = readOptionalRegularBytes(hooksPath);
  if (hooksBytes === undefined) throw new Error("Token Optimizer configured hooks are missing");
  const root = parseHooks(hooksBytes, hooksPath);
  const groups = validateManagedHookConfiguration(root, checkoutRoot, profile);
  const claims = ownedPaths.filter(
    (owned) => owned.ownership === "managed-block" && samePath(owned.path, hooksPath),
  );
  const claimDigests = new Set(claims.map((claim) => claim.sha256));
  const actualDigests = new Set(
    groups.map((group) => tokenOptimizerManagedBlockSha256(group.value)),
  );
  if (actualDigests.size !== claimDigests.size) {
    throw new Error("Token Optimizer configured hooks do not match their ownership receipt");
  }
  for (const digest of actualDigests) {
    if (!claimDigests.has(digest)) {
      throw new Error("Token Optimizer configured hooks do not match their ownership receipt");
    }
  }
}

function validateManagedHookConfiguration(
  root: Record<string, unknown>,
  checkoutRoot: string,
  profile: TokenOptimizerProfile,
  pythonExecutable?: string,
): HookGroup[] {
  const hookRunner = join(checkoutRoot, "hooks", "run.py");
  assertRegularFile(hookRunner, "Token Optimizer hook runner");
  if (process.platform !== "win32") {
    assertExecutableRegular(
      join(checkoutRoot, "hooks", "python-launcher.sh"),
      "Token Optimizer Python launcher",
    );
  }
  if (pythonExecutable !== undefined) {
    if (!isAbsolute(pythonExecutable)) {
      throw new Error("selected Token Optimizer Python executable must be absolute");
    }
    assertExecutableRegular(pythonExecutable, "selected Token Optimizer Python executable");
  }
  const expectedEvents = new Set(
    SUPPORTED_HOOK_INVOCATIONS.filter(
      (invocation) => profile === "balanced" || invocation.event === "Stop",
    ).map((invocation) => invocation.event),
  );
  const managed = hookGroups(root).filter((group) => containsTokenOptimizerMarker(group.value));
  if (managed.length !== expectedEvents.size) {
    throw new Error("supported Codex project hook installer produced an unexpected hook profile");
  }
  const seenEvents = new Set<string>();
  for (const group of managed) {
    if (!expectedEvents.has(group.event) || seenEvents.has(group.event)) {
      throw new Error("supported Codex project hook installer produced an unexpected hook event");
    }
    seenEvents.add(group.event);
    if (group.value === null || typeof group.value !== "object" || Array.isArray(group.value)) {
      throw new Error("supported Codex project hook installer produced an invalid hook group");
    }
    const value = group.value as Record<string, unknown>;
    const hooks = value.hooks;
    if (!Array.isArray(hooks) || hooks.length !== 1) {
      throw new Error("supported Codex project hook installer produced an invalid hook list");
    }
    const hook = hooks[0];
    if (hook === null || typeof hook !== "object" || Array.isArray(hook)) {
      throw new Error("supported Codex project hook installer produced an invalid command hook");
    }
    const hookRecord = hook as Record<string, unknown>;
    if (hookRecord.type !== "command" || typeof hookRecord.command !== "string") {
      throw new Error("supported Codex project hook installer produced an unsupported hook type");
    }
    const invocation = parseSupportedHookCommand(hookRecord.command, checkoutRoot);
    if (invocation === undefined || invocation.event !== group.event) {
      throw new Error("supported Codex project hook installer produced an invalid hook command");
    }
    if (pythonExecutable !== undefined && process.platform === "win32") {
      const executableCandidates = [
        resolve(pythonExecutable),
        canonicalExistingPath(pythonExecutable),
      ].filter((candidate): candidate is string => candidate !== undefined);
      if (
        invocation.pythonExecutable === undefined ||
        !executableCandidates.some((candidate) =>
          samePath(candidate, invocation.pythonExecutable ?? ""),
        )
      ) {
        throw new Error("supported Codex project hook installer did not use the selected Python");
      }
    }
  }
  if (seenEvents.size !== expectedEvents.size) {
    throw new Error("supported Codex project hook installer omitted a required hook event");
  }
  return managed;
}

function parseSupportedHookCommand(
  command: string,
  checkoutRoot: string,
): SupportedHookInvocation | undefined {
  if (!isSafeText(command)) return undefined;
  const checkoutCandidates = [resolve(checkoutRoot), canonicalExistingPath(checkoutRoot)].filter(
    (candidate): candidate is string => candidate !== undefined,
  );
  const windows = process.platform === "win32";
  const interpreter = windows
    ? /^set "TOKEN_OPTIMIZER_RUNTIME=codex" && (?:"([^"\r\n]+)"|([^\s"]+)) /.exec(command)
    : undefined;
  const pythonExecutable = interpreter?.[1] ?? interpreter?.[2];
  if (windows && (pythonExecutable === undefined || !isAbsolute(pythonExecutable)))
    return undefined;
  for (const checkout of checkoutCandidates) {
    // cmd expands percent/delayed-expansion variables even inside quotes.
    // Do not admit a generated path whose bytes can become another command.
    if (windows && /[&|<>^%!]/.test(`${checkout}${pythonExecutable}`)) continue;
    for (const invocation of SUPPORTED_HOOK_INVOCATIONS) {
      const runner = join(checkout, "hooks", "run.py");
      const args = [invocation.script, ...invocation.args];
      const expected = windows
        ? `set "TOKEN_OPTIMIZER_RUNTIME=codex" && ${[pythonExecutable ?? "", runner, ...args]
            .map(quoteWindowsHookArg)
            .join(" ")}${invocation.quiet ? " >NUL 2>&1" : ""}`
        : `for b in bash /bin/bash /usr/bin/bash /usr/local/bin/bash /opt/homebrew/bin/bash; do command -v "$b" >/dev/null 2>&1 && TOKEN_OPTIMIZER_RUNTIME=codex exec "$b" ${[
            join(checkout, "hooks", "python-launcher.sh"),
            runner,
            ...args,
          ]
            .map(quotePosixHookArg)
            .join(" ")}${invocation.quiet ? " >/dev/null 2>&1" : ""}; done; exit 0`;
      if (command === expected) return { ...invocation, pythonExecutable };
    }
  }
  return undefined;
}

function quoteWindowsHookArg(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function quotePosixHookArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function verifyTokenOptimizerReport(
  request: TokenOptimizerVerifyRequest,
  runner: Runner,
  pythonExecutableOverride: string | undefined,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const script = join(request.checkoutRoot, "skills", "token-optimizer", "scripts", "measure.py");
  try {
    assertRegularFile(script, "Token Optimizer measure script");
    const pythonExecutable =
      pythonExecutableOverride ??
      defaultPythonExecutable(
        tokenOptimizerExecutableExclusions(request.project, request.checkoutRoot),
      );
    const hooksPath = join(request.project.canonicalRoot, ".codex", "hooks.json");
    const hooksBytes = readOptionalRegularBytes(hooksPath);
    if (hooksBytes === undefined) {
      return { ok: false, detail: "configured Codex hooks are missing" };
    }
    const hooksRoot = parseHooks(hooksBytes, hooksPath);
    const managed = validateManagedHookConfiguration(
      hooksRoot,
      request.checkoutRoot,
      request.profile,
      pythonExecutable,
    );
    const stopGroup = managed.find((group) => group.event === "Stop");
    if (stopGroup === undefined) {
      return { ok: false, detail: "configured Codex Stop hook is missing" };
    }
    const stopValue = stopGroup.value as Record<string, unknown>;
    const stopHook = (stopValue.hooks as unknown[])[0] as Record<string, unknown>;
    const hookInvocation = parseSupportedHookCommand(
      stopHook.command as string,
      request.checkoutRoot,
    );
    if (hookInvocation === undefined) {
      return { ok: false, detail: "configured Codex Stop hook could not be resolved" };
    }
    const hookRunner = join(request.checkoutRoot, "hooks", "run.py");
    assertRegularFile(hookRunner, "Token Optimizer hook runner");
    const hookLauncher = join(request.checkoutRoot, "hooks", "python-launcher.sh");
    if (process.platform !== "win32") {
      assertExecutableRegular(hookLauncher, "Token Optimizer Python launcher");
    }
    const hookEnv = scopedPythonEnv({
      snapshotDir: join(request.project.stateRoot, "token-optimizer", "hook-data"),
      codexHome: join(request.project.stateRoot, "token-optimizer", "hook-home", ".codex"),
      home: join(request.project.stateRoot, "token-optimizer", "hook-home"),
    });
    hookEnv.CLAUDE_PLUGIN_ROOT = resolve(request.checkoutRoot);
    const hookArgv =
      process.platform === "win32"
        ? [pythonExecutable, hookRunner, hookInvocation.script, ...hookInvocation.args]
        : [hookLauncher, hookRunner, hookInvocation.script, ...hookInvocation.args];
    const hookResult = await runner(hookArgv, {
      cwd: request.project.canonicalRoot,
      env: hookEnv,
      timeoutMs: 120_000,
      maxBufferBytes: 8 * 1024 * 1024,
    });
    if (hookResult.code !== 0 || hookResult.spawnError === true || hookResult.truncated === true) {
      return { ok: false, detail: "configured Codex Stop hook invocation failed" };
    }
    const invocation = buildTokenOptimizerReportInvocation(
      request.checkoutRoot,
      request.project,
      pythonExecutable,
    );
    mkdirSync(join(request.project.stateRoot, "token-optimizer", "report-data"), {
      recursive: true,
    });
    mkdirSync(join(request.project.stateRoot, "token-optimizer", "synthetic-home", ".codex"), {
      recursive: true,
    });
    const result = await runner(invocation.argv, {
      cwd: invocation.cwd,
      env: invocation.env,
      timeoutMs: 120_000,
      maxBufferBytes: 8 * 1024 * 1024,
    });
    if (result.code !== 0 || result.spawnError === true || result.truncated === true) {
      return { ok: false, detail: "the offline report command failed" };
    }
    if (result.stdout.trim().length === 0) {
      return { ok: false, detail: "the offline report command returned no report" };
    }
    return { ok: true, detail: "configured Stop hook and synthetic offline report succeeded" };
  } catch {
    return { ok: false, detail: "the offline report command could not be executed" };
  }
}

function tokenOptimizerExecutableExclusions(
  project: TokenOptimizerProject,
  checkoutRoot: string,
): string[] {
  const checkoutParent = dirname(checkoutRoot);
  const roots = [project.canonicalRoot, project.stateRoot, checkoutRoot, checkoutParent];
  if (basename(checkoutParent).toLowerCase() === "token-optimizer") {
    roots.push(dirname(checkoutParent));
  }
  return roots;
}

function defaultPythonExecutable(excludeRoots: readonly string[] = []): string {
  const names = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  const executable = names
    .map((name) => findExternalExecutable(name, excludeRoots))
    .find((candidate): candidate is string => candidate !== undefined);
  if (executable === undefined) {
    throw new Error("Token Optimizer Python executable is unavailable outside governed roots");
  }
  return executable;
}

function defaultCurlExecutable(excludeRoots: readonly string[] = []): string {
  const executable = findExternalExecutable("curl", excludeRoots);
  if (executable === undefined) {
    throw new Error("Token Optimizer curl executable is unavailable outside governed roots");
  }
  return executable;
}

function requiredExternalExecutable(name: string, excludeRoots: readonly string[]): string {
  const executable = findExternalExecutable(name, excludeRoots);
  if (executable === undefined) {
    throw new Error(`Token Optimizer ${name} executable is unavailable outside governed roots`);
  }
  return executable;
}

/**
 * Find an absolute executable while excluding every governed root. The shared
 * PATH helper can canonicalize one exclusion root; this wrapper filters all
 * lexical roots and retries when a symlinked PATH candidate resolves into a
 * later root. A bare command name is never returned to an execFile caller.
 */
function findExternalExecutable(name: string, excludeRoots: readonly string[]): string | undefined {
  const separator = process.platform === "win32" ? ";" : ":";
  const pathValue = process.env.PATH ?? process.env.Path ?? process.env.path ?? "";
  const lexicalRoots = excludeRoots.map((root) => resolve(root));
  const canonicalRoots = excludeRoots
    .map((root) => canonicalExistingPath(root))
    .filter((root): root is string => root !== undefined);
  const firstCanonicalRoot = canonicalRoots[0];
  let directories = pathValue.split(separator).filter((directory) => {
    if (!isAbsolute(directory)) return true;
    const absolute = resolve(directory);
    return !lexicalRoots.some((root) => isWithin(root, absolute));
  });

  while (directories.length > 0) {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: directories.join(separator) };
    const candidate = findOnPath(name, env, process.platform, {
      ...(firstCanonicalRoot === undefined ? {} : { excludeRoot: firstCanonicalRoot }),
      windowsExeOnly: process.platform === "win32",
    });
    if (candidate === undefined) return undefined;
    const absoluteCandidate = resolve(candidate);
    const canonicalCandidate = canonicalExistingPath(absoluteCandidate);
    const excluded =
      lexicalRoots.some((root) => isWithin(root, absoluteCandidate)) ||
      (canonicalCandidate !== undefined &&
        canonicalRoots.some((root) => isWithin(root, canonicalCandidate)));
    if (!excluded) return canonicalCandidate ?? absoluteCandidate;

    const nextDirectories = directories.filter(
      (directory) =>
        !pathEntryContainsCandidate(directory, name, absoluteCandidate, canonicalCandidate),
    );
    if (nextDirectories.length === directories.length) return undefined;
    directories = nextDirectories;
  }
  return undefined;
}

function pathEntryContainsCandidate(
  directory: string,
  name: string,
  candidate: string,
  canonicalCandidate: string | undefined,
): boolean {
  if (!isAbsolute(directory)) return false;
  const leaves = process.platform === "win32" ? [`${name}.exe`] : [name];
  for (const leaf of leaves) {
    const path = resolve(join(directory, leaf));
    if (samePath(path, candidate)) return true;
    if (canonicalCandidate !== undefined) {
      const canonicalPath = canonicalExistingPath(path);
      if (canonicalPath !== undefined && samePath(canonicalPath, canonicalCandidate)) return true;
    }
  }
  return false;
}

function canonicalExistingPath(path: string): string | undefined {
  try {
    return resolve(realpathSync.native(path));
  } catch {
    return undefined;
  }
}

function scopedPythonEnv(options: {
  readonly snapshotDir: string;
  readonly codexHome: string;
  readonly home: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "COMSPEC",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.TOKEN_OPTIMIZER_RUNTIME = "codex";
  env.TOKEN_OPTIMIZER_SNAPSHOT_DIR = options.snapshotDir;
  env.CODEX_HOME = options.codexHome;
  env.HOME = options.home;
  env.USERPROFILE = options.home;
  env.XDG_CONFIG_HOME = join(options.home, ".config");
  env.XDG_DATA_HOME = join(options.home, ".local", "share");
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  return env;
}

function scopedNetworkEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "COMSPEC",
    "TEMP",
    "TMP",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function readReceiptFile(path: string): unknown | undefined {
  assertNoSymlinkOnExistingPath(path, "Token Optimizer receipt");
  if (!existsSync(path)) return undefined;
  assertRegularFile(path, "Token Optimizer receipt");
  try {
    return JSON.parse(readRegularBytes(path, MAX_RECEIPT_BYTES).toString("utf8")) as unknown;
  } catch {
    throw new Error("Token Optimizer receipt is unreadable");
  }
}

function writeReceiptFile(path: string, value: TokenOptimizerReceipt): void {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  writeFileAtomically(path, bytes);
}

function deleteReceiptFile(path: string): void {
  assertNoSymlinkOnExistingPath(path, "Token Optimizer receipt");
  if (!existsSync(path)) return;
  assertRegularFile(path, "Token Optimizer receipt");
  unlinkSync(path);
}

function readOptionalRegularBytes(path: string): Buffer | undefined {
  assertNoSymlinkOnExistingPath(path, "Token Optimizer file");
  if (!existsSync(path)) return undefined;
  return readRegularBytes(path, MAX_RECEIPT_BYTES);
}

function readRegularBytes(path: string, maxBytes: number): Buffer {
  return readRegularFileSnapshot(path, maxBytes, "file").bytes;
}

function readHooksSnapshot(path: string): {
  readonly root: Record<string, unknown>;
  readonly snapshot: RegularFileSnapshot;
} {
  const snapshot = readRegularFileSnapshot(path, MAX_RECEIPT_BYTES, "Token Optimizer hooks path");
  return { root: parseHooks(snapshot.bytes, path), snapshot };
}

function readRegularFileSnapshot(
  path: string,
  maxBytes: number,
  label: string,
): RegularFileSnapshot {
  assertNoSymlinkOnExistingPath(path, label);
  let before: RegularFileIdentity;
  try {
    before = regularFileIdentity(lstatSync(path, { bigint: true }), label);
  } catch {
    throw new Error(`${label} must be a regular file`);
  }
  const noFollow = (constants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
  const nonblock = (constants as Record<string, number | undefined>).O_NONBLOCK ?? 0;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow | nonblock, 0o600);
  } catch {
    throw new Error(`${label} could not be opened safely`);
  }
  try {
    const opened = regularFileIdentity(fstatSync(descriptor, { bigint: true }), label);
    const current = regularFileIdentity(lstatSync(path, { bigint: true }), label);
    assertNoSymlinkOnExistingPath(path, label);
    if (!sameRegularFileIdentity(before, opened) || !sameRegularFileIdentity(opened, current)) {
      throw new Error(`${label} changed while opening`);
    }
    if (opened.size > BigInt(maxBytes)) throw new Error("file exceeds bounded size");
    const bytes = readBoundedFileDescriptor(descriptor, maxBytes);
    if (bytes === undefined) throw new Error("file exceeds bounded size");
    const after = regularFileIdentity(fstatSync(descriptor, { bigint: true }), label);
    const currentAfter = regularFileIdentity(lstatSync(path, { bigint: true }), label);
    assertNoSymlinkOnExistingPath(path, label);
    if (!sameRegularFileIdentity(opened, after) || !sameRegularFileIdentity(opened, currentAfter)) {
      throw new Error(`${label} changed while reading`);
    }
    return { bytes, sha256: sha256Hex(bytes), identity: opened };
  } finally {
    closeSync(descriptor);
  }
}

function regularFileIdentity(stats: BigIntStats, label: string): RegularFileIdentity {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.ino === 0n) {
    throw new Error(`${label} must be a regular file`);
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameRegularFileIdentity(left: RegularFileIdentity, right: RegularFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertSnapshotStillNamesFile(
  path: string,
  expected: RegularFileIdentity,
  message: string,
): void {
  try {
    assertNoSymlinkOnExistingPath(path, "Token Optimizer output");
    const current = regularFileIdentity(
      lstatSync(path, { bigint: true }),
      "Token Optimizer output",
    );
    if (!sameRegularFileIdentity(expected, current)) throw new Error(message);
  } catch {
    throw new Error(message);
  }
}

function assertRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
}

function assertExecutableRegular(path: string, label: string): void {
  assertNoSymlinkOnExistingPath(path, label);
  assertRegularFile(path, label);
  if (process.platform !== "win32") {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      throw new Error(`${label} is not executable`);
    }
  }
}

function parseHooks(bytes: Buffer, path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("hooks root");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`hooks configuration is unreadable (${path})`);
  }
}

function writeFileAtomically(
  path: string,
  bytes: Buffer,
  expectedIdentity?: RegularFileIdentity,
): void {
  assertNoSymlinkOnExistingPath(path, "Token Optimizer output");
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (expectedIdentity === undefined) assertRegularFile(path, "Token Optimizer output");
    else assertSnapshotStillNamesFile(path, expectedIdentity, "Token Optimizer output changed");
  }
  const temporary = join(
    dirname(path),
    `.${path.split(/[\\/]/).pop() ?? "output"}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    if (expectedIdentity === undefined) {
      if (existsSync(path)) assertRegularFile(path, "Token Optimizer output");
    } else {
      assertSnapshotStillNamesFile(path, expectedIdentity, "Token Optimizer output changed");
    }
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    throw error;
  }
}

function safeErrorDetail(error: unknown): string {
  if (error instanceof Error && error.message.length > 0 && isSafeText(error.message)) {
    return error.message.slice(0, 240);
  }
  return "an implementation prerequisite failed";
}

function isSafeText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  return true;
}

function blockedResult(
  receipt: TokenOptimizerReceipt | undefined,
  detail: string,
  changed = false,
): TokenOptimizerReconcileResult {
  return { toolId: "token-optimizer", state: "blocked", detail, receipt, changed };
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, canonicalValue(object[key])]),
    );
  }
  return value;
}
