import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { canonicalStrictJsonBytesV1, parseStrictJsonObjectV1 } from "../contract/strict-json-v1.js";
import { type Cli, SUPPORTED_CLIS } from "../internals/clis.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { CommandSpec, Plan, PlanContext } from "../internals/plan.js";
import { dynamicDigest, plan, probe } from "../internals/plan.js";
import type { Check, CheckCode } from "../internals/verify.js";
import { POLICY_AUTHORITY_RECEIPT_PATH, verifyPolicyAuthorityReceipt } from "./authority.js";
import {
  custodyOrganizationEvidenceV1,
  isContainedEvidenceRelativePathV1,
} from "./evidence-custody-v1.js";
import { type GovernanceDecisionV2, governanceDecisionDigestV2 } from "./governance-decision-v2.js";
import {
  parseOrganizationEvidenceEnvelopeV1Bytes,
  verifyOrganizationQualificationV1,
} from "./qualification-v1.js";
import {
  type ObservedEffectResolution,
  resolveObservedEffect,
  type UpstreamObservationReceiptV1,
  upstreamObservationReceiptDigestV1,
  verifyUpstreamObservationV1,
} from "./upstream-observation-receipt-v1.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
/** Large enterprise lockfiles are common; still bounded before strict parsing. */
const MAX_LOCK_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const OBSERVER_CONTRACT = Object.freeze({
  format: "aih-npm-package-observer",
  version: 1,
  effect: "install",
  lockfileVersion: 3,
});
const OBSERVER = Object.freeze({
  id: "npm-package-observer",
  version: "1.0.0",
  digest: `sha256:${createHash("sha256")
    .update("aih-npm-package-observer/v1\0", "utf8")
    .update(canonicalStrictJsonBytesV1(OBSERVER_CONTRACT))
    .digest("hex")}`,
});
const INTEGRATION = Object.freeze({
  mode: "upstream-managed" as const,
  owner: "npm-package-observer",
  version: "1.0.0",
});

type Reason =
  | "invalid-input"
  | "invalid-evidence-path"
  | "unsafe-evidence-custody"
  | "evidence-unavailable"
  | "evidence-changed"
  | "authority-unverified"
  | "authority-version"
  | "authority-not-current"
  | "decision-missing-or-mismatch"
  | "decision-rejected"
  | "decision-revoked"
  | "decision-not-current"
  | "decision-scope-mismatch"
  | "qualification-unverified"
  | "installed-evidence-unavailable"
  | "installed-evidence-unsafe"
  | "installed-evidence-changed"
  | "installed-identity-mismatch"
  | "observation-unverified";
export type NpmPackageObservationEffectiveV1 =
  | "observed-effective"
  | "observation-missing"
  | Reason
  | ObservedEffectResolution["state"];
export interface NpmPackageObservationResultV1 {
  readonly authority: "verified" | "unverified";
  readonly qualification: "qualified" | "unqualified";
  readonly effective: NpmPackageObservationEffectiveV1;
  readonly outcome: "observed-effective" | "partial" | "refused";
  readonly reason?: Reason;
  readonly observationDigest?: string;
}
export interface NpmPackageObservationLifecycleHandoffV1 {
  readonly authorityReceiptDigest: string;
  readonly custody: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  /** Exact decision verified in the same final observation that minted receipt. */
  readonly decision: GovernanceDecisionV2;
  readonly receipt: UpstreamObservationReceiptV1;
}
/**
 * Non-public hand-off for the sibling lifecycle writer. A result alone remains
 * the sealed CLI API; only this module can associate it with the exact receipt
 * freshly minted by the code-owned observer.
 */
const lifecycleObservationReceipts = new WeakMap<object, NpmPackageObservationLifecycleHandoffV1>();

/** @internal Never exported from the package root or wired to a caller option. */
export function npmPackageObservationHandoffForLifecycleV1(
  result: NpmPackageObservationResultV1,
): NpmPackageObservationLifecycleHandoffV1 | undefined {
  const handoff = lifecycleObservationReceipts.get(result);
  return handoff === undefined ? undefined : structuredClone(handoff);
}
const CODE: Readonly<Record<Reason, CheckCode>> = {
  "invalid-input": "org-policy.observe-input-invalid",
  "invalid-evidence-path": "org-policy.observe-input-invalid",
  "unsafe-evidence-custody": "org-policy.observe-evidence-invalid",
  "evidence-unavailable": "org-policy.observe-evidence-invalid",
  "evidence-changed": "org-policy.observe-evidence-changed",
  "authority-unverified": "org-policy.observe-authority-unverified",
  "authority-version": "org-policy.observe-authority-unverified",
  "authority-not-current": "org-policy.observe-authority-not-current",
  "decision-missing-or-mismatch": "org-policy.observe-decision-mismatch",
  "decision-rejected": "org-policy.observe-decision-rejected",
  "decision-revoked": "org-policy.observe-decision-revoked",
  "decision-not-current": "org-policy.observe-decision-not-current",
  "decision-scope-mismatch": "org-policy.observe-decision-scope-mismatch",
  "qualification-unverified": "org-policy.observe-qualification-unverified",
  "installed-evidence-unavailable": "org-policy.observe-installed-evidence-unavailable",
  "installed-evidence-unsafe": "org-policy.observe-installed-evidence-invalid",
  "installed-evidence-changed": "org-policy.observe-installed-evidence-changed",
  "installed-identity-mismatch": "org-policy.observe-installed-identity-mismatch",
  "observation-unverified": "org-policy.observe-invariant-violation",
};

/** Hermetic custody-race seam; not exported by the package or wired to the CLI. */
let afterInstalledReadForInternalTest: (() => void) | undefined;

/** @internal Test-only hook for the final evidence/time recheck boundary. */
export function __setNpmPackageObserverInternalTestHookV1(hook: (() => void) | undefined): void {
  afterInstalledReadForInternalTest = hook;
}

function effectiveRefusal(
  state: ObservedEffectResolution["state"],
  qualification: "qualified" | "unqualified" = "unqualified",
): NpmPackageObservationResultV1 {
  const reason: Reason =
    state === "authority-not-current" ||
    state === "decision-missing-or-mismatch" ||
    state === "decision-rejected" ||
    state === "decision-revoked" ||
    state === "decision-not-current" ||
    state === "decision-scope-mismatch"
      ? state
      : state === "authority-unverified" || state === "authority-version"
        ? "authority-unverified"
        : state === "qualification-missing" ||
            state === "qualification-unverified" ||
            state === "qualification-mismatch"
          ? "qualification-unverified"
          : "observation-unverified";
  return { ...refusal(reason, "verified", state), qualification };
}

function refusal(
  reason: Reason,
  authority: "verified" | "unverified" = "unverified",
  effective: NpmPackageObservationEffectiveV1 = reason,
): NpmPackageObservationResultV1 {
  return { authority, qualification: "unqualified", effective, outcome: "refused", reason };
}
function refusalAfterQualified(
  reason: Reason,
  effective: NpmPackageObservationEffectiveV1 = reason,
): NpmPackageObservationResultV1 {
  return { ...refusal(reason, "verified", effective), qualification: "qualified" };
}
function option(ctx: PlanContext, key: string): string | undefined {
  const value = ctx.options[key];
  return typeof value === "string" && value.trim() === value && value.length > 0
    ? value
    : undefined;
}
function request(
  ctx: PlanContext,
): { decision: string; digest: string; target: Cli; evidence: string } | undefined {
  const decision = option(ctx, "decision");
  const digest = option(ctx, "decisionDigest");
  const target = option(ctx, "target");
  const evidence = option(ctx, "evidence");
  return decision !== undefined &&
    /^[a-z][a-z0-9-]{0,63}$/.test(decision) &&
    digest !== undefined &&
    SHA256.test(digest) &&
    target !== undefined &&
    SUPPORTED_CLIS.includes(target as Cli) &&
    evidence !== undefined
    ? { decision, digest, target: target as Cli, evidence }
    : undefined;
}
function decisionFor(
  authority: Awaited<ReturnType<typeof verifyPolicyAuthorityReceipt>>["authority"],
  request: { decision: string; digest: string },
): GovernanceDecisionV2 | undefined {
  return authority?.receipt.version === 3
    ? authority.receipt.decisions.find(
        (candidate) =>
          candidate.id === request.decision &&
          governanceDecisionDigestV2(candidate) === request.digest,
      )
    : undefined;
}
function safeStat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
function hasSymlinkedParent(root: string, path: string): boolean {
  const rootStat = safeStat(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return true;
  const rel = relative(root, path);
  if (!isContainedEvidenceRelativePathV1(rel)) return true;
  let cursor = root;
  for (const segment of rel.split(sep).slice(0, -1)) {
    cursor = resolve(cursor, segment);
    const stat = safeStat(cursor);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return true;
  }
  return false;
}
function custody(
  root: string,
  relativePath: string,
  maxBytes: number,
): { bytes: Buffer; sha256: string; unchanged: () => boolean } | undefined | "unsafe" {
  const path = resolve(root, relativePath);
  const rel = relative(root, path);
  if (!isContainedEvidenceRelativePathV1(rel)) return "unsafe";
  if (hasSymlinkedParent(root, path)) return safeStat(path) === undefined ? undefined : "unsafe";
  const opened = readRegularFileWithStats(path, { maxBytes });
  if (opened === undefined) return safeStat(path)?.isSymbolicLink() ? "unsafe" : undefined;
  const bytes = Buffer.from(opened.contents);
  const identity = { dev: opened.stats.dev, ino: opened.stats.ino, size: opened.stats.size };
  return {
    bytes,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    unchanged: () => {
      if (hasSymlinkedParent(root, path)) return false;
      const current = readRegularFileWithStats(path, { maxBytes });
      return (
        current !== undefined &&
        current.stats.dev === identity.dev &&
        current.stats.ino === identity.ino &&
        current.stats.size === identity.size &&
        current.contents.equals(bytes)
      );
    },
  };
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function parse(custodied: { bytes: Buffer }): Record<string, unknown> | undefined {
  try {
    return parseStrictJsonObjectV1(
      new TextDecoder("utf-8", { fatal: true }).decode(custodied.bytes),
      "npm installed artifact",
    );
  } catch {
    return undefined;
  }
}
function npmInstalledIdentity(
  source: Extract<GovernanceDecisionV2["subject"]["source"], { type: "npm" }>,
): {
  id: string;
  digest: string;
} {
  return {
    id: "npm-package",
    digest: `sha256:${createHash("sha256")
      .update(
        canonicalStrictJsonBytesV1({
          integrity: source.integrity,
          name: source.package,
          version: source.version,
        }),
      )
      .digest("hex")}`,
  };
}
function installed(
  root: string,
  decision: GovernanceDecisionV2,
):
  | {
      installed: { id: string; digest: string };
      custody: readonly { path: string; sha256: string }[];
      unchanged: () => boolean;
    }
  | Reason {
  const source = decision.subject.source;
  if (source.type !== "npm") return "installed-identity-mismatch";
  const lock = custody(root, "package-lock.json", MAX_LOCK_BYTES);
  const manifest = custody(
    root,
    join("node_modules", source.package, "package.json"),
    MAX_MANIFEST_BYTES,
  );
  if (lock === "unsafe" || manifest === "unsafe") return "installed-evidence-unsafe";
  if (lock === undefined || manifest === undefined) return "installed-evidence-unavailable";
  const parsedLock = parse(lock);
  const parsedManifest = parse(manifest);
  const packages = parsedLock === undefined ? undefined : object(parsedLock.packages);
  const entry =
    packages === undefined ? undefined : object(packages[`node_modules/${source.package}`]);
  if (
    parsedLock?.lockfileVersion !== 3 ||
    (entry !== undefined && Object.hasOwn(entry, "link")) ||
    entry?.version !== source.version ||
    entry.integrity !== source.integrity ||
    parsedManifest?.name !== source.package ||
    parsedManifest.version !== source.version
  )
    return "installed-identity-mismatch";
  return {
    custody: [
      { path: "package-lock.json", sha256: lock.sha256 },
      { path: `node_modules/${source.package}/package.json`, sha256: manifest.sha256 },
    ],
    installed: npmInstalledIdentity(source),
    unchanged: () => lock.unchanged() && manifest.unchanged(),
  };
}

/** Internal-only fixed npm observation path; caller controls neither package, effect, nor verifier. */
export async function observeNpmPackageV1(
  ctx: PlanContext,
): Promise<NpmPackageObservationResultV1> {
  const requested = request(ctx);
  if (requested === undefined) return refusal("invalid-input");
  const evidence = custodyOrganizationEvidenceV1(ctx.root, requested.evidence);
  if ("problem" in evidence) return refusal(evidence.problem);
  const evidenceEnvelope = parseOrganizationEvidenceEnvelopeV1Bytes(evidence.evidence.bytes);
  if (evidenceEnvelope === undefined) return refusal("qualification-unverified");
  const verified = await verifyPolicyAuthorityReceipt(ctx);
  if (verified.authority === undefined) return refusal("authority-unverified");
  if (verified.authority.receipt.version !== 3) return refusal("authority-version", "verified");
  if (!evidence.evidence.unchanged()) return refusal("evidence-changed", "verified");
  const decision = decisionFor(verified.authority, requested);
  if (decision === undefined) return refusal("decision-missing-or-mismatch", "verified");
  if (decision.subject.kind !== "package" || decision.subject.source.type !== "npm")
    return refusal("installed-identity-mismatch", "verified");
  const expectedInstalled = npmInstalledIdentity(decision.subject.source);
  const qualificationInput = {
    authority: verified.authority,
    bytes: evidence.evidence.bytes,
    decisionReference: { id: requested.decision, digest: requested.digest },
    effect: "install" as const,
    subject: decision.subject,
    supportedTargets: SUPPORTED_CLIS,
    target: requested.target,
  };
  const initiallyObservedAt = new Date().toISOString();
  const qualification = verifyOrganizationQualificationV1({
    ...qualificationInput,
    now: initiallyObservedAt,
  });
  const initialCurrent = resolveObservedEffect({
    authority: verified.authority,
    decisionReference: { id: requested.decision, digest: requested.digest },
    qualification,
    subject: decision.subject,
    target: requested.target,
    effect: "install",
    supportedTargets: SUPPORTED_CLIS,
    expectedVerifier: OBSERVER,
    expectedInstalled,
    expectedIntegration: INTEGRATION,
    now: initiallyObservedAt,
  });
  if (initialCurrent.state !== "observation-missing") return effectiveRefusal(initialCurrent.state);
  const local = installed(ctx.root, decision);
  if (typeof local === "string") {
    if (local === "installed-evidence-unavailable") {
      afterInstalledReadForInternalTest?.();
      if (!evidence.evidence.unchanged()) return refusalAfterQualified("evidence-changed");
      const observedAt = new Date().toISOString();
      const currentQualification = verifyOrganizationQualificationV1({
        ...qualificationInput,
        now: observedAt,
      });
      const current = resolveObservedEffect({
        authority: verified.authority,
        decisionReference: { id: requested.decision, digest: requested.digest },
        qualification: currentQualification,
        subject: decision.subject,
        target: requested.target,
        effect: "install",
        supportedTargets: SUPPORTED_CLIS,
        expectedVerifier: OBSERVER,
        expectedInstalled,
        expectedIntegration: INTEGRATION,
        now: observedAt,
      });
      if (current.state !== "observation-missing")
        return effectiveRefusal(
          current.state,
          currentQualification === undefined ? "unqualified" : "qualified",
        );
      return {
        authority: "verified",
        qualification: "qualified",
        effective: "observation-missing",
        outcome: "partial",
        reason: local,
      };
    }
    return { ...refusal(local, "verified"), qualification: "qualified" };
  }
  afterInstalledReadForInternalTest?.();
  if (!evidence.evidence.unchanged()) return refusalAfterQualified("evidence-changed");
  if (!local.unchanged()) return refusalAfterQualified("installed-evidence-changed");
  // The receipt's time begins only after every local read is re-proved stable.
  // Requalify and re-evaluate at that instant so no earlier authority/evidence
  // window can be carried across a slow or raced installed-artifact observation.
  const observedAt = new Date().toISOString();
  const currentQualification = verifyOrganizationQualificationV1({
    ...qualificationInput,
    now: observedAt,
  });
  const current = resolveObservedEffect({
    authority: verified.authority,
    decisionReference: { id: requested.decision, digest: requested.digest },
    qualification: currentQualification,
    subject: decision.subject,
    target: requested.target,
    effect: "install",
    supportedTargets: SUPPORTED_CLIS,
    expectedVerifier: OBSERVER,
    expectedInstalled,
    expectedIntegration: INTEGRATION,
    now: observedAt,
  });
  if (current.state !== "observation-missing")
    return effectiveRefusal(
      current.state,
      currentQualification === undefined ? "unqualified" : "qualified",
    );
  const validUntil = new Date(
    Math.min(
      Date.parse(verified.authority.receipt.expiresAt),
      Date.parse(decision.expiresAt),
      Date.parse(evidenceEnvelope.expiresAt),
      decision.disposition === "accepted-with-conditions"
        ? Date.parse(decision.reviewBy)
        : Number.POSITIVE_INFINITY,
      Date.parse(observedAt) + 60_000,
    ),
  ).toISOString();
  const receipt = {
    format: "aih-upstream-observation-receipt" as const,
    version: 1 as const,
    id: "observation-npm-package",
    decision: { id: requested.decision, digest: requested.digest },
    subject: {
      kind: decision.subject.kind,
      id: decision.subject.id,
      sourceDigest: decision.subject.sourceDigest,
      subjectDigest: decision.subject.subjectDigest,
    },
    targets: [requested.target],
    allowedEffects: ["install" as const],
    integration: INTEGRATION,
    installed: local.installed,
    verifier: OBSERVER,
    observedAt,
    validUntil,
    outcome: "observed-success" as const,
  };
  const observation = verifyUpstreamObservationV1({
    receipt,
    expectedVerifier: OBSERVER,
    expectedInstalled,
    expectedIntegration: INTEGRATION,
    subject: decision.subject,
    target: requested.target,
    effect: "install",
    supportedTargets: SUPPORTED_CLIS,
    now: observedAt,
    verify: (candidate) =>
      upstreamObservationReceiptDigestV1(candidate) === upstreamObservationReceiptDigestV1(receipt),
  });
  const effective = resolveObservedEffect({
    authority: verified.authority,
    decisionReference: { id: requested.decision, digest: requested.digest },
    qualification: currentQualification,
    observation,
    subject: decision.subject,
    target: requested.target,
    effect: "install",
    supportedTargets: SUPPORTED_CLIS,
    expectedVerifier: OBSERVER,
    expectedInstalled: local.installed,
    expectedIntegration: INTEGRATION,
    now: observedAt,
  });
  if (effective.state !== "observed-effective")
    return effectiveRefusal(effective.state, "qualified");
  const result: NpmPackageObservationResultV1 = {
    authority: "verified",
    qualification: "qualified",
    effective: effective.state,
    outcome: "observed-effective",
    observationDigest: upstreamObservationReceiptDigestV1(receipt),
  };
  lifecycleObservationReceipts.set(
    result,
    structuredClone({
      authorityReceiptDigest: verified.authority.receiptDigest,
      custody: [
        {
          path: requested.evidence,
          sha256: `sha256:${createHash("sha256").update(evidence.evidence.bytes).digest("hex")}`,
        },
        { path: POLICY_AUTHORITY_RECEIPT_PATH, sha256: verified.authority.receiptDigest },
        ...local.custody,
      ],
      decision,
      receipt,
    }),
  );
  return result;
}
function check(result: NpmPackageObservationResultV1): Check {
  return result.outcome === "observed-effective"
    ? {
        name: "policy observe npm-package",
        verdict: "pass",
        detail: "policy observe npm-package observed-effective",
      }
    : {
        name: "policy observe npm-package",
        verdict: "fail",
        code: CODE[result.reason ?? "observation-unverified"],
        detail: `policy observe npm-package ${result.reason ?? "observation-unverified"}`,
      };
}
export function npmPackageObservePlan(ctx: PlanContext): Plan {
  let value: Promise<NpmPackageObservationResultV1> | undefined;
  const once = () => (value ??= observeNpmPackageV1(ctx));
  return plan(
    "policy observe npm-package",
    dynamicDigest("policy observe npm-package", async () => {
      const result = await once();
      return { text: JSON.stringify(result), data: result };
    }),
    probe("policy observe npm-package", async () => check(await once())),
  );
}
export const npmPackageObserveCommand: CommandSpec = {
  name: "npm-package",
  summary:
    "Observe an exact npm package installation under current V3 organization policy without executing it",
  readOnly: true,
  zeroWrite: true,
  alwaysVerify: true,
  options: [
    { flags: "--decision <id>", description: "exact V3 governance decision identifier (required)" },
    {
      flags: "--decision-digest <sha256>",
      description: "exact V3 governance decision digest (required)",
    },
    { flags: "--target <cli>", description: "exact supported target (required)" },
    {
      flags: "--evidence <path>",
      description: "root-relative organization evidence path (required)",
    },
  ],
  plan: npmPackageObservePlan,
};
