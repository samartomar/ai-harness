import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type Action,
  AihError,
  assertTrustTreeSafe,
  beginMarker,
  buildNativeEccRegistration,
  eccRuntimeScriptPath,
  endMarker,
  NATIVE_ECC_REGISTRATION_SCOPE,
  type NativeEccRegistration,
  type Plan,
  type PlanContext,
  type PlanResult,
  plan,
  planInstalledNativeEccRegistration,
  planNativeEccRegistration,
  type RemoveAction,
  readTrustFetchMetadata,
  removeManagedBlock,
  resolveEccNativeStateRootV1,
  type TrustSource,
  trustFetchExec,
  upsertTextBlock,
  type WriteAction,
} from "@aihq/core/framework-host";
import { cleanupQuarantine, executePlan, resolveTrustSource } from "../core-runtime.js";
import { UPSTREAM } from "../identity.js";
import { currentEccProfileEvidenceV1, type EccProfileEvidenceV1 } from "./descriptor-evidence.js";
import type { EccProfile } from "./index.js";
import {
  ECC_PROFILE_MANAGED_SCOPE,
  type EccProfileInstalledSourceTrust,
  type EccProfileLifecycleOperation,
  planEccProfileLifecycle,
  planInstalledEccProfileLifecycle,
} from "./lifecycle.js";
import { type EccProjection, renderEccProjection } from "./render.js";

export const ECC_PROFILE_LIFECYCLE_OPERATIONS = [
  "install",
  "update",
  "repair",
  "rollback",
  "uninstall",
] as const satisfies readonly EccProfileLifecycleOperation[];

export interface MaterializedEccProfileEvidence {
  evidenceRoot: string;
  profile: EccProfile;
  evidence: unknown;
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

/** Append-only identities for installations that this package can recover or remove offline. */
export const PACKAGED_ECC_PROFILE_INSTALLATION_TRUST = [
  {
    repository: "affaan-m/ECC",
    commit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
    sourceClosureId: "ecc-projected-source-closure-v1",
    sourceClosureSha256: "8dadd2c412511d690555243773f8bc4a0ed1e7ba43fc0804bc1d955b3b7bca37",
    projectionSha256: "8bfa1837b2f7d4239b69955540c20a76a795c4ef86dc3555390d5d18e30bc585",
  },
  // Version 2 of the same installation: also binds each file's merge strategy.
  {
    recoveryIdentityVersion: 2,
    repository: "affaan-m/ECC",
    commit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
    sourceClosureId: "ecc-projected-source-closure-v1",
    sourceClosureSha256: "8dadd2c412511d690555243773f8bc4a0ed1e7ba43fc0804bc1d955b3b7bca37",
    projectionSha256: "1d9367486f2075d4f90fea24d8d59ba5cb8b0ace087ec8a0382c53890ca7cbe2",
  },
] as const satisfies readonly EccProfileInstalledSourceTrust[];

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
    // The projection keeps its merge destination; stripping the native block
    // never turns that into a deletion.
    const contents = removeManagedBlock(projection.contents, NATIVE_ECC_REGISTRATION_SCOPE);
    if (contents.trim().length > 0) return { ...projection, contents };
    return {
      ...projection,
      contents,
      describe: `uninstall composed ECC profile configuration; kept ${projection.path}, now only whitespace, because aih cannot prove it created the whole file: remove it by hand if nothing uses it`,
    };
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

function writeEvidenceFile(root: string, relativePath: string, contents: string): void {
  const destination = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

/**
 * Materialize the digest-bound evidence documents of Core-verified descriptor
 * bytes into an owner-only disposable root.
 */
export function materializeEccProfileEvidence(
  verified: EccProfileEvidenceV1,
): MaterializedEccProfileEvidence {
  const root = mkdtempSync(join(tmpdir(), "aih-ecc-profile-evidence-"));
  try {
    chmodSync(root, 0o700);
  } catch {
    // mkdtemp is owner-only on POSIX; Windows ACLs are platform-managed.
  }
  try {
    for (const [path, text] of verified.documents) writeEvidenceFile(root, path, text);
    return { evidenceRoot: root, profile: verified.profile, evidence: verified.evidence };
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
  if (requestedRef.length > 0 && requestedRef !== UPSTREAM.commit) {
    throw new AihError("AIH_ECC_REF cannot move the reviewed ECC profile source pin", "AIH_CONFIG");
  }
}

function requestedSource(ctx: PlanContext, commit: string): TrustSource {
  const local = typeof ctx.options.eccPath === "string" ? ctx.options.eccPath.trim() : "";
  if (local.length > 0) return resolveTrustSource(local, { root: ctx.root });
  return resolveTrustSource(UPSTREAM.repository, { root: ctx.root, pin: commit });
}

function verifiedGitHubSourceRoot(
  source: Extract<TrustSource, { kind: "github" }>,
  commit: string,
): string {
  const metadata = readTrustFetchMetadata(source);
  if (
    metadata.kind !== "github" ||
    metadata.owner.toLowerCase() !== "affaan-m" ||
    metadata.repo.toLowerCase() !== "ecc" ||
    metadata.pinnedSha !== commit ||
    resolve(metadata.treePath) !== resolve(source.treePath)
  ) {
    throw new AihError(
      "quarantined ECC source metadata does not match the reviewed profile pin",
      "AIH_TRUST",
    );
  }
  return assertTrustTreeSafe(source.treePath);
}

async function acquireDescriptorProjection(
  ctx: PlanContext,
  transactionPins: EccProfileLifecycleCommandDeps["transactionPins"],
): Promise<EccProjection> {
  // Refuse before any acquisition while the installed Catalog carries no usable
  // profile evidence for this plugin's one upstream commit.
  const verified = currentEccProfileEvidenceV1();
  const source = requestedSource(ctx, verified.sourceCommit);
  const packaged = materializeEccProfileEvidence(verified);
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
      sourceRoot = verifiedGitHubSourceRoot(source, verified.sourceCommit);
    } else {
      sourceRoot = assertTrustTreeSafe(source.root);
    }
    return await renderEccProjection(
      packaged.profile,
      packaged.evidence,
      { sourceRoot, evidenceRoot: packaged.evidenceRoot },
      verified.trust,
    );
  } finally {
    rmSync(packaged.evidenceRoot, { recursive: true, force: true });
    cleanupQuarantine(source);
  }
}

/**
 * The native registration runs Core's own runtime script, located by Core
 * through framework-host: the plugin build ships no runtime of its own.
 */
export function defaultNativeRegistrationInput(
  ctx: PlanContext,
): Parameters<typeof buildNativeEccRegistration>[0] {
  return {
    root: ctx.root,
    stateRoot: resolveEccNativeStateRootV1(ctx.env, ctx.host.platform),
    executable: process.execPath,
    cliScript: eccRuntimeScriptPath(),
  };
}

function defaultNativeRegistration(ctx: PlanContext): NativeEccRegistration {
  return buildNativeEccRegistration(defaultNativeRegistrationInput(ctx));
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
    ((context: PlanContext) => acquireDescriptorProjection(context, deps.transactionPins))
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
