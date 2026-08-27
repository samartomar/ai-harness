import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pinnedEvidenceJson from "../../tests/fixtures/ecc-profile/pinned-source-evidence.json";
import sourceClosureJson from "../../tests/fixtures/ecc-profile/projected-source-closure.json";
import reviewReceiptJson from "../../tests/fixtures/ecc-profile/review-receipt.json";
import { AihError } from "../errors.js";
import { removeManagedBlock, upsertTextBlock } from "../internals/envfile.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import {
  type Action,
  type Plan,
  type PlanContext,
  plan,
  type RemoveAction,
  remove,
  type WriteAction,
} from "../internals/plan.js";
import { beginMarker, endMarker } from "../internals/render.js";
import {
  assertTrustTreeSafe,
  cleanupQuarantine,
  readTrustFetchMetadata,
  resolveTrustSource,
  type TrustSource,
  trustFetchExec,
} from "../trust/fetch.js";
import { AIH_ECC_PROFILE_TEMPLATE, type EccProfile, eccProfileSchema } from "./index.js";
import {
  ECC_PROFILE_MANAGED_SCOPE,
  type EccProfileInstalledSourceTrust,
  type EccProfileLifecycleOperation,
  planEccProfileLifecycle,
  planInstalledEccProfileLifecycle,
} from "./lifecycle.js";
import {
  buildNativeEccRegistration,
  NATIVE_ECC_REGISTRATION_SCOPE,
  type NativeEccRegistration,
  planInstalledNativeEccRegistration,
  planNativeEccRegistration,
} from "./native-registration.js";
import { type EccProjection, renderEccProjection } from "./render.js";
import { TRUSTED_PROJECTED_SOURCE } from "./source-closure.js";

export const ECC_PROFILE_LIFECYCLE_OPERATIONS = [
  "install",
  "update",
  "repair",
  "rollback",
  "uninstall",
] as const satisfies readonly EccProfileLifecycleOperation[];

interface PackagedReviewReceipt {
  id: string;
  evidencePath: string;
  sourceCommit: string;
  evidenceSha256: string;
}

interface PackagedPinnedEvidence {
  reviewReceipt: PackagedReviewReceipt;
  [key: string]: unknown;
}

export interface PackagedEccProfileEvidence {
  evidenceRoot: string;
  profile: EccProfile;
  evidence: PackagedPinnedEvidence;
}

export interface EccProfileLifecycleCommandDeps {
  /** Internal hermetic-test seam; the public command always uses authenticated acquisition. */
  loadProjection?: (ctx: PlanContext) => Promise<EccProjection>;
  /** Internal future-pin seam; shipped packages use the append-only trust registry below. */
  installedSourceTrust?: readonly EccProfileInstalledSourceTrust[];
  /** Internal hermetic-test seam; injected projection tests do not touch native config by default. */
  loadNativeRegistration?: (ctx: PlanContext) => NativeEccRegistration;
  /** Protected-policy pins supplied by the command that authorized this lifecycle mutation. */
  transactionPins?: Pick<Plan, "fileAssertions" | "commitNotAfter" | "commitLock">;
}

const PACKAGED_EVIDENCE = pinnedEvidenceJson as unknown as PackagedPinnedEvidence;

/** Append-only identities for installations that this package can recover or remove offline. */
export const PACKAGED_ECC_PROFILE_INSTALLATION_TRUST = [
  {
    repository: "affaan-m/ECC",
    commit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
    sourceClosureId: TRUSTED_PROJECTED_SOURCE.id,
    sourceClosureSha256: TRUSTED_PROJECTED_SOURCE.aggregateSha256,
    projectionSha256: "8bfa1837b2f7d4239b69955540c20a76a795c4ef86dc3555390d5d18e30bc585",
  },
] as const satisfies readonly EccProfileInstalledSourceTrust[];

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

type FileMutation = WriteAction | RemoveAction;

function isFileMutation(action: Action): action is FileMutation {
  return action.kind === "write" || action.kind === "remove";
}

function mutationExpect(action: FileMutation): string {
  return JSON.stringify(action.expect ?? null);
}

function managedTextBody(contents: string, scope: string): string {
  const normalized = contents.replace(/\r\n/g, "\n");
  const begin = `${beginMarker(scope)}\n`;
  const end = `\n${endMarker(scope)}`;
  const start = normalized.indexOf(begin);
  const finish = normalized.indexOf(end, start + begin.length);
  if (
    start < 0 ||
    finish < 0 ||
    normalized.indexOf(begin, start + begin.length) >= 0 ||
    normalized.indexOf(end, finish + end.length) >= 0
  ) {
    throw new Error(`ECC lifecycle managed block is missing or ambiguous: ${scope}`);
  }
  return normalized.slice(start + begin.length, finish);
}

function composeOverlappingConfigMutation(
  projection: FileMutation,
  native: FileMutation,
  operation: EccProfileLifecycleOperation,
): FileMutation {
  if (
    projection.path !== ".codex/config.toml" ||
    native.path !== projection.path ||
    mutationExpect(projection) !== mutationExpect(native)
  ) {
    throw new Error("ECC lifecycle plans have ambiguous overlapping file ownership");
  }
  if (operation === "uninstall") {
    if (projection.kind === "remove") {
      if (native.kind !== "remove") {
        throw new Error("ECC lifecycle uninstall has contradictory overlapping mutations");
      }
      return projection;
    }
    if (typeof projection.contents !== "string") {
      throw new Error("ECC lifecycle uninstall has a non-text projection mutation");
    }
    const contents = removeManagedBlock(projection.contents, NATIVE_ECC_REGISTRATION_SCOPE);
    if (contents.trim().length > 0) return { ...projection, contents };
    const expected =
      projection.expect && "sha256" in projection.expect
        ? { sha256: projection.expect.sha256 }
        : undefined;
    if (expected === undefined) {
      throw new Error("ECC lifecycle uninstall overlap lacks an apply-time content pin");
    }
    return remove(projection.path, "uninstall composed ECC profile configuration", {
      expect: expected,
    });
  }
  if (
    projection.kind !== "write" ||
    native.kind !== "write" ||
    typeof projection.contents !== "string" ||
    typeof native.contents !== "string" ||
    projection.json !== undefined ||
    native.json !== undefined
  ) {
    throw new Error("ECC lifecycle recovery has contradictory overlapping mutations");
  }
  const nativeBody = managedTextBody(native.contents, NATIVE_ECC_REGISTRATION_SCOPE);
  const contents = upsertTextBlock(projection.contents, NATIVE_ECC_REGISTRATION_SCOPE, nativeBody);
  if (!contents.includes(beginMarker(ECC_PROFILE_MANAGED_SCOPE))) {
    throw new Error("ECC lifecycle recovery composition omitted the projection block");
  }
  return { ...projection, contents };
}

function composeInstalledLifecyclePlan(
  capability: string,
  projectionPlan: Plan,
  nativePlan: Plan,
  operation: EccProfileLifecycleOperation,
): Plan {
  const actions = [...projectionPlan.actions];
  const projectionMutations = new Map<string, number>();
  for (const [index, action] of actions.entries()) {
    if (!isFileMutation(action)) continue;
    if (projectionMutations.has(action.path)) {
      throw new Error(`ECC projection lifecycle plan repeats a mutation: ${action.path}`);
    }
    projectionMutations.set(action.path, index);
  }
  const nativeMutations = new Set<string>();
  for (const action of nativePlan.actions) {
    if (!isFileMutation(action)) {
      actions.push(action);
      continue;
    }
    if (nativeMutations.has(action.path)) {
      throw new Error(`ECC native lifecycle plan repeats a mutation: ${action.path}`);
    }
    nativeMutations.add(action.path);
    const existingIndex = projectionMutations.get(action.path);
    if (existingIndex === undefined) {
      projectionMutations.set(action.path, actions.push(action) - 1);
      continue;
    }
    const existing = actions[existingIndex];
    if (!existing || !isFileMutation(existing)) {
      throw new Error("ECC lifecycle overlap lost its projection mutation");
    }
    actions[existingIndex] = composeOverlappingConfigMutation(existing, action, operation);
  }
  return plan(capability, ...actions);
}

function withTransactionPins(
  lifecyclePlan: Plan,
  transactionPins: EccProfileLifecycleCommandDeps["transactionPins"],
): Plan {
  if (transactionPins === undefined) return lifecyclePlan;
  return {
    ...lifecyclePlan,
    ...(transactionPins.fileAssertions === undefined
      ? {}
      : { fileAssertions: transactionPins.fileAssertions }),
    ...(transactionPins.commitNotAfter === undefined
      ? {}
      : { commitNotAfter: transactionPins.commitNotAfter }),
    ...(transactionPins.commitLock === undefined ? {} : { commitLock: transactionPins.commitLock }),
  };
}

function sourceClosureBytes(): string {
  // The accepted receipt was committed with CRLF records and one final LF.
  // Reproduce that reviewed byte encoding exactly, then bind it to the trusted digest below.
  return `${JSON.stringify(sourceClosureJson, null, 2).replace(/\n/g, "\r\n")}\n`;
}

function writeEvidenceFile(root: string, relativePath: string, contents: string): void {
  const destination = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

/** Materialize only authenticated public receipt bytes into an owner-only disposable root. */
export function createPackagedEccProfileEvidence(): PackagedEccProfileEvidence {
  const evidence = PACKAGED_EVIDENCE;
  const receiptBytes = stableJson(reviewReceiptJson);
  const closureBytes = sourceClosureBytes();
  if (sha256(receiptBytes) !== evidence.reviewReceipt.evidenceSha256) {
    throw new Error("packaged ECC review receipt does not match its trusted digest");
  }
  if (sha256(closureBytes) !== TRUSTED_PROJECTED_SOURCE.evidenceSha256) {
    throw new Error("packaged ECC projected-source receipt does not match its trusted digest");
  }
  const profile = eccProfileSchema.parse({
    ...AIH_ECC_PROFILE_TEMPLATE,
    source: {
      ...AIH_ECC_PROFILE_TEMPLATE.source,
      reviewReceipt: evidence.reviewReceipt,
    },
  });
  const root = mkdtempSync(join(tmpdir(), "aih-ecc-profile-evidence-"));
  try {
    chmodSync(root, 0o700);
  } catch {
    // mkdtemp is owner-only on POSIX; Windows ACLs are platform-managed.
  }
  try {
    writeEvidenceFile(root, evidence.reviewReceipt.evidencePath, receiptBytes);
    writeEvidenceFile(root, TRUSTED_PROJECTED_SOURCE.evidencePath, closureBytes);
    return { evidenceRoot: root, profile, evidence };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function lifecycleOperation(ctx: PlanContext): EccProfileLifecycleOperation {
  const raw = ctx.options.lifecycle;
  if (
    typeof raw !== "string" ||
    !ECC_PROFILE_LIFECYCLE_OPERATIONS.includes(raw as EccProfileLifecycleOperation)
  ) {
    throw new AihError(
      `--lifecycle must be one of ${ECC_PROFILE_LIFECYCLE_OPERATIONS.join("|")}`,
      "AIH_CONFIG",
    );
  }
  return raw as EccProfileLifecycleOperation;
}

function assertLifecycleOptions(ctx: PlanContext): void {
  if (ctx.options.profile !== undefined && ctx.options.profile !== "minimal") {
    throw new AihError("--profile cannot be combined with --lifecycle", "AIH_CONFIG");
  }
  const declarations = ctx.options.with;
  if (Array.isArray(declarations) ? declarations.length > 0 : declarations !== undefined) {
    throw new AihError("--with cannot be combined with --lifecycle", "AIH_CONFIG");
  }
  for (const [key, flag] of [
    ["cli", "--cli"],
    ["allTools", "--all-tools"],
    ["detect", "--detect"],
  ] as const) {
    if (ctx.options[key] !== undefined && ctx.options[key] !== false) {
      throw new AihError(`${flag} cannot be combined with --lifecycle`, "AIH_CONFIG");
    }
  }
  const requestedRef = (ctx.env.AIH_ECC_REF ?? "").trim();
  if (requestedRef.length > 0 && requestedRef !== AIH_ECC_PROFILE_TEMPLATE.source.commit) {
    throw new AihError("AIH_ECC_REF cannot move the reviewed ECC profile source pin", "AIH_CONFIG");
  }
}

function requestedSource(ctx: PlanContext): TrustSource {
  const local = typeof ctx.options.eccPath === "string" ? ctx.options.eccPath.trim() : "";
  if (local.length > 0) return resolveTrustSource(local, { root: ctx.root });
  return resolveTrustSource(AIH_ECC_PROFILE_TEMPLATE.source.repository, {
    root: ctx.root,
    pin: AIH_ECC_PROFILE_TEMPLATE.source.commit,
  });
}

function verifiedGitHubSourceRoot(source: Extract<TrustSource, { kind: "github" }>): string {
  const metadata = readTrustFetchMetadata(source);
  if (
    metadata.kind !== "github" ||
    metadata.owner.toLowerCase() !== "affaan-m" ||
    metadata.repo.toLowerCase() !== "ecc" ||
    metadata.pinnedSha !== AIH_ECC_PROFILE_TEMPLATE.source.commit ||
    resolve(metadata.treePath) !== resolve(source.treePath)
  ) {
    throw new AihError(
      "quarantined ECC source metadata does not match the reviewed profile pin",
      "AIH_TRUST",
    );
  }
  return assertTrustTreeSafe(source.treePath);
}

async function acquirePackagedProjection(
  ctx: PlanContext,
  transactionPins: EccProfileLifecycleCommandDeps["transactionPins"],
): Promise<EccProjection> {
  const source = requestedSource(ctx);
  const packaged = createPackagedEccProfileEvidence();
  try {
    let sourceRoot: string;
    if (source.kind === "github") {
      const acquisitionContext: PlanContext = {
        ...ctx,
        apply: true,
        verify: false,
        options: { ...ctx.options, force: true },
      };
      const acquired = await executePlan(
        withTransactionPins(
          plan("ecc-profile: acquire exact source", trustFetchExec(source, acquisitionContext)),
          transactionPins,
        ),
        acquisitionContext,
        { skipWorktreeGate: true },
      );
      if (
        acquired.execs.some((entry) => entry.ran && entry.ok === false) ||
        (acquired.report?.exitCode() ?? 0) !== 0
      ) {
        throw new AihError(
          `could not acquire ${source.display} into a disposable quarantine`,
          "AIH_TRUST",
        );
      }
      sourceRoot = verifiedGitHubSourceRoot(source);
    } else {
      sourceRoot = assertTrustTreeSafe(source.root);
    }
    return await renderEccProjection(packaged.profile, packaged.evidence, {
      sourceRoot,
      evidenceRoot: packaged.evidenceRoot,
    });
  } finally {
    rmSync(packaged.evidenceRoot, { recursive: true, force: true });
    cleanupQuarantine(source);
  }
}

function stateRootFor(ctx: PlanContext): string {
  const explicit = ctx.env.AIH_ECC_STATE_ROOT?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new AihError("AIH_ECC_STATE_ROOT must be absolute", "AIH_CONFIG");
    }
    return resolve(explicit);
  }
  if (ctx.host.platform === "windows") {
    const base = ctx.env.LOCALAPPDATA?.trim() || ctx.env.USERPROFILE?.trim();
    if (base) return resolve(base, "aih", "ecc-profile");
  } else {
    const base = ctx.env.XDG_STATE_HOME?.trim();
    if (base) return resolve(base, "aih", "ecc-profile");
    const home = ctx.env.HOME?.trim();
    if (home) return resolve(home, ".local", "state", "aih", "ecc-profile");
  }
  throw new AihError(
    "native ECC registration needs AIH_ECC_STATE_ROOT or a platform home/state directory",
    "AIH_CONFIG",
  );
}

function defaultNativeRegistration(ctx: PlanContext): NativeEccRegistration {
  return buildNativeEccRegistration({
    root: ctx.root,
    stateRoot: stateRootFor(ctx),
    executable: process.execPath,
    cliScript: resolve(dirname(fileURLToPath(import.meta.url)), "ecc-runtime.js"),
  });
}

export async function executeEccProfileLifecycleCommand(
  ctx: PlanContext,
  deps: EccProfileLifecycleCommandDeps = {},
): Promise<PlanResult> {
  const operation = lifecycleOperation(ctx);
  assertLifecycleOptions(ctx);
  const nativeEnabled =
    deps.loadProjection === undefined || deps.loadNativeRegistration !== undefined;
  if (operation === "repair" || operation === "uninstall" || operation === "rollback") {
    if (operation === "uninstall") {
      const projectionPlan = planInstalledEccProfileLifecycle(
        ctx.root,
        operation,
        deps.installedSourceTrust ?? PACKAGED_ECC_PROFILE_INSTALLATION_TRUST,
      );
      if (!nativeEnabled) return executePlan(projectionPlan, ctx);
      const nativePlan = planInstalledNativeEccRegistration(ctx.root, operation);
      return executePlan(
        composeInstalledLifecyclePlan(
          "ecc-profile: atomic projection and native registration uninstall",
          projectionPlan,
          nativePlan,
          operation,
        ),
        ctx,
        // Receipt-bound lifecycle planning rejects unowned or drifted bytes;
        // the generic gate would misclassify the managed projection as dirt.
        { skipWorktreeGate: true },
      );
    }
    const projectionPlan = planInstalledEccProfileLifecycle(
      ctx.root,
      operation,
      deps.installedSourceTrust ?? PACKAGED_ECC_PROFILE_INSTALLATION_TRUST,
    );
    if (!nativeEnabled)
      return executePlan(withTransactionPins(projectionPlan, deps.transactionPins), ctx);
    const nativePlan = planInstalledNativeEccRegistration(ctx.root, operation);
    return executePlan(
      withTransactionPins(
        composeInstalledLifecyclePlan(
          `ecc-profile: atomic projection and native registration ${operation}`,
          projectionPlan,
          nativePlan,
          operation,
        ),
        deps.transactionPins,
      ),
      ctx,
      { skipWorktreeGate: true },
    );
  }
  const projection = await (
    deps.loadProjection ??
    ((context: PlanContext) => acquirePackagedProjection(context, deps.transactionPins))
  )(ctx);
  const projectionPlan = planEccProfileLifecycle(ctx.root, projection, operation);
  if (!nativeEnabled)
    return executePlan(withTransactionPins(projectionPlan, deps.transactionPins), ctx, {
      skipWorktreeGate: true,
    });
  const registration = (deps.loadNativeRegistration ?? defaultNativeRegistration)(ctx);
  const nativePlan = planNativeEccRegistration(ctx.root, registration, operation);
  return executePlan(
    withTransactionPins(
      composeInstalledLifecyclePlan(
        `ecc-profile: atomic projection and native registration ${operation}`,
        projectionPlan,
        nativePlan,
        operation,
      ),
      deps.transactionPins,
    ),
    ctx,
    { skipWorktreeGate: true },
  );
}
