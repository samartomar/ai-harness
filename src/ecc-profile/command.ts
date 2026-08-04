import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
} from "./lifecycle.js";
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

export async function executeEccProfileLifecycleCommand(
  ctx: PlanContext,
  deps: EccProfileLifecycleCommandDeps = {},
): Promise<PlanResult> {
  const operation = lifecycleOperation(ctx);
  assertLifecycleOptions(ctx);
  if (operation === "repair" || operation === "uninstall" || operation === "rollback") {
    return executePlan(
      planInstalledEccProfileLifecycle(
        ctx.root,
        operation,
        deps.installedSourceTrust ?? PACKAGED_ECC_PROFILE_INSTALLATION_TRUST,
      ),
      ctx,
    );
  }
  const projection = await (deps.loadProjection ?? acquirePackagedProjection)(ctx);
  return executePlan(planEccProfileLifecycle(ctx.root, projection, operation), ctx);
}
