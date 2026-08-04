import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pinnedEvidenceJson from "../../tests/fixtures/ecc-profile/pinned-source-evidence.json";
import sourceClosureJson from "../../tests/fixtures/ecc-profile/projected-source-closure.json";
import reviewReceiptJson from "../../tests/fixtures/ecc-profile/review-receipt.json";
import { AihError } from "../errors.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import { type PlanContext, plan } from "../internals/plan.js";
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
  type EccProfileInstalledSourceTrust,
  type EccProfileLifecycleOperation,
  planEccProfileLifecycle,
  planInstalledEccProfileLifecycle,
  readEccProfileOwnership,
} from "./lifecycle.js";
import {
  buildNativeEccRegistration,
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

async function acquirePackagedProjection(ctx: PlanContext): Promise<EccProjection> {
  const source = requestedSource(ctx);
  const packaged = createPackagedEccProfileEvidence();
  try {
    let sourceRoot: string;
    if (source.kind === "github") {
      const acquisitionContext: PlanContext = {
        ...ctx,
        root: source.quarantineRoot,
        apply: true,
        verify: false,
        options: { ...ctx.options, force: true },
      };
      const acquired = await executePlan(
        plan("ecc-profile: acquire exact source", trustFetchExec(source, acquisitionContext)),
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

function combineResults(...results: PlanResult[]): PlanResult {
  const first = results[0];
  if (!first) throw new Error("ECC lifecycle produced no execution result");
  return {
    capability: "ecc-profile: projection and native registration",
    applied: results.every((result) => result.applied),
    writes: results.flatMap((result) => result.writes),
    docs: results.flatMap((result) => result.docs),
    probes: results.flatMap((result) => result.probes),
    execs: results.flatMap((result) => result.execs),
    digests: results.flatMap((result) => result.digests),
    backups: results.flatMap((result) => result.backups),
    removed: results.flatMap((result) => result.removed),
    ...(results.findLast((result) => result.report !== undefined)?.report === undefined
      ? {}
      : { report: results.findLast((result) => result.report !== undefined)?.report }),
    ...(results.findLast((result) => result.verification !== undefined)?.verification === undefined
      ? {}
      : {
          verification: results.findLast((result) => result.verification !== undefined)
            ?.verification,
        }),
  };
}

async function compensateProjectionAfterRegistrationFailure(
  ctx: PlanContext,
  operation: "install" | "update",
  originalError: unknown,
): Promise<never> {
  const source = readEccProfileOwnership(ctx.root)?.source;
  if (source === undefined) throw originalError;
  try {
    await executePlan(
      planInstalledEccProfileLifecycle(
        ctx.root,
        operation === "install" ? "uninstall" : "rollback",
        [source],
      ),
      ctx,
    );
  } catch (recoveryError) {
    throw new AggregateError(
      [originalError, recoveryError],
      "native ECC registration failed and projection recovery also failed",
    );
  }
  throw originalError;
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
        plan(
          "ecc-profile: atomic projection and native registration uninstall",
          ...projectionPlan.actions,
          ...nativePlan.actions,
        ),
        ctx,
      );
    }
    const projection = await executePlan(
      planInstalledEccProfileLifecycle(
        ctx.root,
        operation,
        deps.installedSourceTrust ?? PACKAGED_ECC_PROFILE_INSTALLATION_TRUST,
      ),
      ctx,
    );
    const native = nativeEnabled
      ? await executePlan(planInstalledNativeEccRegistration(ctx.root, operation), ctx)
      : undefined;
    return native === undefined ? projection : combineResults(native, projection);
  }
  const projection = await (deps.loadProjection ?? acquirePackagedProjection)(ctx);
  const projected = await executePlan(
    planEccProfileLifecycle(ctx.root, projection, operation),
    ctx,
  );
  if (!nativeEnabled) return projected;
  try {
    const registration = (deps.loadNativeRegistration ?? defaultNativeRegistration)(ctx);
    const registered = await executePlan(
      planNativeEccRegistration(ctx.root, registration, operation),
      ctx,
    );
    return combineResults(projected, registered);
  } catch (error) {
    if (ctx.apply && projected.applied) {
      return compensateProjectionAfterRegistrationFailure(ctx, operation, error);
    }
    throw error;
  }
}
