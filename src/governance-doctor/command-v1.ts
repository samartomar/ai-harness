import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAihConfig } from "../config/marker.js";
import { deepFreezeStrictJsonV1 } from "../contract/strict-json-v1.js";
import { readRegularFile } from "../internals/fsxn.js";
import { type CommandSpec, digest, type PlanContext, plan, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { governanceOwnsAihSurfaces, type OrgPolicy, readOrgPolicy } from "../org-policy/schema.js";
import {
  canonicalGovernanceDoctorAuditV1Bytes,
  canonicalGovernanceDoctorGuideV1Bytes,
  type GovernanceDoctorAuditV1Result,
  type GovernanceDoctorGuideV1,
} from "./audit-guide-v1.js";
import {
  assertEnumV1,
  assertExactKeysV1,
  assertRecordV1,
  assertSha256V1,
  failGovernanceDoctorV1,
  GOVERNANCE_DOCTOR_V1_LIMITS,
  type GovernanceDoctorQuotedProseV1,
  governanceDoctorSha256V1,
} from "./capability-v1.js";
import {
  canonicalGovernanceDoctorOperationV1Bytes,
  createGovernanceDoctorOperationalContextV1,
  type GovernanceDoctorOperationRecordV1,
  type GovernanceDoctorOperationV1,
  governanceDoctorOperationalPlanContextV1,
  runGovernanceDoctorOperationV1,
} from "./operational-v1.js";
import {
  type GovernanceDoctorProfileV1,
  parseGovernanceDoctorProfileV1Json,
} from "./profile-v1.js";
import {
  type GovernanceDoctorRepairEligibilityV1,
  mintGovernanceDoctorRepairEligibilityV1,
} from "./repair-eligibility-v1.js";
import {
  type GovernanceDoctorRepairPlanPreviewV1,
  presentGovernanceDoctorRepairPlanPreviewV1,
} from "./repair-plan-preview-v1.js";

/**
 * `aih governance-doctor` -- the operator-facing, zero-write presentation of the
 * Governance Doctor Audit and Guide.
 *
 * The route is deliberately its own top-level name rather than an extension of
 * `aih doctor`. The operational adapter already plans and probes the Doctor
 * command as one of its two code-owned diagnostics, so hanging this presentation
 * off Doctor would make Doctor re-enter itself. A separate name makes that
 * recursion structurally impossible instead of merely discouraged.
 *
 * Everything this command consumes is code-owned. The profile is the single
 * shipped canonical artifact inside this package; no flag, option, environment
 * variable, or positional value can name another one, because the loader takes
 * no argument at all. The policy decision and its revision are derived here from
 * the org-policy state AIH already validates and from the posture the shared
 * ladder already resolved -- never from a caller-supplied decision, callback, or
 * opaque revision. The adapter runs exactly once per invocation.
 *
 * What it presents is a projection, not a passthrough. Every field is drawn from
 * the Audit, the Guide, and the operation record, all of which are already
 * bounded, closed, and canonical; prose stays quoted, attributed, and marked
 * `authority: "none"`. Raw diagnostic check text, command lines, argv,
 * environment values, filesystem locations, child-process output, support
 * tickets, and run-ledger rows have no field to occupy. The Guide's next action
 * is reported by id and stays non-runnable: this command executes no next
 * action, no Status, and no Repair.
 */
export type GovernanceDoctorPolicySourceV1 = "absent" | "governed" | "ungoverned" | "unreadable";

export interface GovernanceDoctorPolicyStateV1 {
  readonly decision: "allowed" | "denied";
  readonly revisionSha256: string;
  readonly source: GovernanceDoctorPolicySourceV1;
}

const policyStateBrands = new WeakSet<object>();

/** Completed and refused outcomes stay distinct rather than collapsing into one verdict. */
export type GovernanceDoctorPresentationOutcomeV1 =
  | "completed"
  | "evidence-gap"
  | "refused"
  | "unavailable";

/**
 * Why a run is not a completed audit. The first two are the foundation's own
 * audit-level refusals; the last two are this command failing closed when the
 * shipped artifact or the adapter produced no run at all.
 */
export type GovernanceDoctorPresentationStateV1 =
  | "adapter-unavailable"
  | "compatibility-required"
  | "policy-denied"
  | "profile-unavailable";

export interface GovernanceDoctorPresentationIdentityV1 {
  readonly auditSha256: string;
  readonly contextSha256: string;
  readonly guideSha256: string;
  readonly operationSha256: string;
  readonly profileSha256: string;
  readonly rootSha256: string;
  readonly surfaceRevisionSha256: string;
}

/**
 * The closed presentation payload. Its key set is fixed across every outcome --
 * absent values are `null` or an empty list, never a missing key -- so a machine
 * consumer parses one shape whether the run completed, refused, or failed closed.
 */
export interface GovernanceDoctorAuditReportV1 {
  readonly conflicts: readonly {
    readonly conflictId: string;
    readonly conflictsWithSurfaceId: string;
    readonly note: GovernanceDoctorQuotedProseV1;
  }[];
  readonly dispatchedDiagnosticIds: readonly string[];
  readonly findings: readonly {
    readonly code: string;
    readonly diagnosticId: string;
    readonly severity: "critical" | "high" | "info" | "low" | "medium";
    readonly summary: GovernanceDoctorQuotedProseV1;
  }[];
  readonly guidance: GovernanceDoctorQuotedProseV1 | null;
  readonly identity: GovernanceDoctorPresentationIdentityV1 | null;
  readonly nextAction: {
    readonly actionId: string | null;
    readonly executable: false;
    readonly owner: "aih";
    readonly unavailable: boolean;
  };
  readonly outcome: GovernanceDoctorPresentationOutcomeV1;
  readonly policy: GovernanceDoctorPolicyStateV1;
  readonly prerequisites: readonly {
    readonly note: GovernanceDoctorQuotedProseV1;
    readonly prerequisiteId: string;
    readonly satisfiedBy: "aih" | "operator" | "org-policy";
  }[];
  readonly protocol: "GovernanceDoctorPresentationV1";
  readonly refusals: readonly { readonly diagnosticId: string; readonly state: string }[];
  readonly repairPosture: "guided-only" | "unavailable" | null;
  readonly roles: readonly {
    readonly owner: "aih" | "catalog-publisher" | "operator" | "org-policy";
    readonly roleId: string;
    readonly summary: GovernanceDoctorQuotedProseV1;
  }[];
  readonly state: GovernanceDoctorPresentationStateV1 | null;
  readonly surfaceId: string | null;
  readonly targetId: string | null;
}

export interface GovernanceDoctorPresentationV1 {
  /** Drives the CLI exit code: only a completed audit passes. */
  readonly check: Check;
  readonly report: GovernanceDoctorAuditReportV1;
  readonly text: string;
}

/** The one artifact this command may read, relative to the harness package root. */
export const SHIPPED_GOVERNANCE_DOCTOR_PROFILE_RELATIVE_PATH_V1 =
  "packs/governance-quality/governance-doctor-audit-guide/profile.json";

const POLICY_DECISIONS = ["allowed", "denied"] as const;
const POLICY_SOURCES = ["absent", "governed", "ungoverned", "unreadable"] as const;
const UNAVAILABLE_STATES = ["adapter-unavailable", "profile-unavailable"] as const;
const POLICY_REVISION_DOMAIN = "aih.governance-doctor-command-policy-revision-v1";
const PROTOCOL = "GovernanceDoctorPresentationV1";
const CHECK_NAME = "governance-doctor-audit-guide";
const HARNESS_PACKAGE_NAME = "@aihq/harness";

/**
 * The package this module was loaded from. Resolution walks up from the module
 * itself, never from a caller-influenced working directory or root argument, so
 * the shipped artifact is located by installation layout alone.
 */
function harnessPackageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (manifest.name === HARNESS_PACKAGE_NAME) return current;
    } catch {
      // A missing or malformed nearer manifest must not redirect the package root.
    }
    const parent = dirname(current);
    if (parent === current)
      return failGovernanceDoctorV1("shipped governance doctor profile is unavailable");
    current = parent;
  }
}

/**
 * Reads and parses the shipped canonical profile. It takes no argument by
 * design: there is no parameter for a caller to supply a location, bytes, or an
 * alternate registry entry. A link, a non-regular entry, an oversized file, or
 * any non-canonical encoding fails closed with a fixed message that names no
 * filesystem location.
 */
export function loadShippedGovernanceDoctorProfileV1(): GovernanceDoctorProfileV1 {
  const target = join(harnessPackageRoot(), SHIPPED_GOVERNANCE_DOCTOR_PROFILE_RELATIVE_PATH_V1);
  const bytes = readRegularFile(target, {
    maxBytes: GOVERNANCE_DOCTOR_V1_LIMITS.maxTransportBytes,
  });
  if (bytes === undefined)
    return failGovernanceDoctorV1("shipped governance doctor profile is unavailable");
  return parseGovernanceDoctorProfileV1Json(bytes);
}

/**
 * Derives this run's policy state from AIH-owned inputs only: the org policy the
 * shared schema validates, and the posture the shared ladder resolved (including
 * its org floor). Nothing here reads a command option, a positional value, or an
 * environment-supplied verdict.
 *
 * It fails closed twice. An org policy that cannot be read or parsed denies the
 * run -- in the normal CLI path posture resolution has already refused such a
 * policy before planning, so this is the second, independent guard. A run whose
 * resolved posture sits below the policy's declared floor is likewise denied,
 * because a presentation gated at a weaker posture than the organization
 * requires is not the presentation the organization authorized.
 *
 * The revision digests exactly the facts the decision used, so a record minted
 * under one policy state can never be read as evidence for another.
 */
export function resolveGovernanceDoctorPolicyStateV1(
  context: unknown,
): GovernanceDoctorPolicyStateV1 {
  const ctx = governanceDoctorOperationalPlanContextV1(context);
  let policy: OrgPolicy | undefined;
  let source: GovernanceDoctorPolicySourceV1;
  try {
    policy = readOrgPolicy(ctx.root, ctx.env);
    source =
      policy === undefined
        ? "absent"
        : governanceOwnsAihSurfaces(policy)
          ? "governed"
          : "ungoverned";
  } catch {
    policy = undefined;
    source = "unreadable";
  }
  const minimumPosture = policy?.minimumPosture ?? null;
  const posture = ctx.posture ?? null;
  const belowFloor = minimumPosture === "enterprise" && posture !== "enterprise";
  const decision = source === "unreadable" || belowFloor ? "denied" : "allowed";
  const revisionSha256 = governanceDoctorSha256V1(POLICY_REVISION_DOMAIN, {
    decision,
    minimumPosture,
    policyVersion:
      policy !== undefined && governanceOwnsAihSurfaces(policy)
        ? policy.governance.policyVersion
        : null,
    posture,
    postureSource: ctx.postureSource ?? null,
    source,
  });
  const state = Object.freeze({ decision, revisionSha256, source });
  policyStateBrands.add(state);
  return state;
}

/** Closed-schema validation of a policy state at the presentation boundary. */
function policyState(value: unknown): GovernanceDoctorPolicyStateV1 {
  const record = assertRecordV1(value, "governance doctor policy state");
  assertExactKeysV1(
    record,
    ["decision", "revisionSha256", "source"],
    "governance doctor policy state",
  );
  if (!policyStateBrands.has(record))
    failGovernanceDoctorV1("governance doctor policy state is not AIH-owned");
  return {
    decision: assertEnumV1(record.decision, POLICY_DECISIONS, "governance doctor policy decision"),
    revisionSha256: assertSha256V1(record.revisionSha256, "governance doctor policy revision"),
    source: assertEnumV1(record.source, POLICY_SOURCES, "governance doctor policy source"),
  };
}

function presentationCheck(report: GovernanceDoctorAuditReportV1): Check {
  return {
    name: CHECK_NAME,
    verdict: report.outcome === "completed" ? "pass" : "fail",
    detail: report.state === null ? report.outcome : `${report.outcome}: ${report.state}`,
  };
}

function quotedLine(label: string, prose: GovernanceDoctorQuotedProseV1): string {
  return `  ${label} [${prose.attribution}, authority ${prose.authority}]: ${prose.quoted}`;
}

/**
 * Renders the report as bounded operator prose. Every value is already bounded
 * and canonical, and the collections are already ordered by the foundation, so
 * the rendering is stable for a given run and carries no ad-hoc formatting
 * decision that could vary between platforms.
 */
function renderText(report: GovernanceDoctorAuditReportV1): string {
  const lines = [
    "Governance Doctor audit and guide",
    `  outcome: ${report.outcome}`,
    `  state: ${report.state ?? "none"}`,
    `  policy decision: ${report.policy.decision} (source: ${report.policy.source})`,
    `  policy revision: ${report.policy.revisionSha256}`,
  ];
  if (report.surfaceId !== null) lines.push(`  surface: ${report.surfaceId}`);
  if (report.targetId !== null) lines.push(`  target: ${report.targetId}`);
  if (report.repairPosture !== null) lines.push(`  repair posture: ${report.repairPosture}`);
  lines.push(
    `  next action: ${report.nextAction.actionId ?? "withheld"} (owner: ${
      report.nextAction.owner
    }, executable: false)`,
  );
  if (report.dispatchedDiagnosticIds.length > 0)
    lines.push(`  dispatched diagnostics: ${report.dispatchedDiagnosticIds.join(", ")}`);
  if (report.identity !== null) {
    lines.push(`  profile: ${report.identity.profileSha256}`);
    lines.push(`  audit: ${report.identity.auditSha256}`);
    lines.push(`  guide: ${report.identity.guideSha256}`);
    lines.push(`  operation: ${report.identity.operationSha256}`);
    lines.push(`  root binding: ${report.identity.rootSha256}`);
    lines.push(`  context binding: ${report.identity.contextSha256}`);
    lines.push(`  surface revision: ${report.identity.surfaceRevisionSha256}`);
  }
  if (report.guidance !== null) lines.push(quotedLine("guidance", report.guidance));
  for (const role of report.roles)
    lines.push(quotedLine(`role ${role.roleId} (owner: ${role.owner})`, role.summary));
  for (const prerequisite of report.prerequisites)
    lines.push(
      quotedLine(
        `prerequisite ${prerequisite.prerequisiteId} (satisfied by: ${prerequisite.satisfiedBy})`,
        prerequisite.note,
      ),
    );
  for (const conflict of report.conflicts)
    lines.push(
      quotedLine(
        `conflict ${conflict.conflictId} (with: ${conflict.conflictsWithSurfaceId})`,
        conflict.note,
      ),
    );
  for (const finding of report.findings)
    lines.push(
      quotedLine(
        `finding ${finding.code} (severity: ${finding.severity}, diagnostic: ${finding.diagnosticId})`,
        finding.summary,
      ),
    );
  for (const refusal of report.refusals)
    lines.push(`  refusal ${refusal.diagnosticId}: ${refusal.state}`);
  lines.push(
    "  Read-only presentation: no next action, Status, or Repair is executed, and nothing is written.",
  );
  return `${lines.join("\n")}\n`;
}

function presentation(report: GovernanceDoctorAuditReportV1): GovernanceDoctorPresentationV1 {
  const frozen = deepFreezeStrictJsonV1(report);
  return Object.freeze({
    check: Object.freeze(presentationCheck(frozen)),
    report: frozen,
    text: renderText(frozen),
  });
}

/**
 * Binds the presented policy state to the run it actually gated. A refusal
 * carrying `policy-denied` must come from a denied decision and a denied
 * decision must produce that refusal, and every identity in the audit and the
 * guide must be the identity the record minted. A mismatched or hand-built
 * policy state therefore cannot be presented beside someone else's audit.
 */
function assertBoundOperation(
  audit: GovernanceDoctorAuditV1Result,
  guide: GovernanceDoctorGuideV1,
  record: GovernanceDoctorOperationRecordV1,
  policy: GovernanceDoctorPolicyStateV1,
): void {
  if (
    audit.auditSha256 !== record.auditSha256 ||
    guide.guideSha256 !== record.guideSha256 ||
    audit.profileSha256 !== record.profileSha256 ||
    guide.profileSha256 !== record.profileSha256 ||
    audit.policyRevisionSha256 !== record.policyRevisionSha256
  )
    failGovernanceDoctorV1("governance doctor operation identities do not match");
  if (policy.revisionSha256 !== record.policyRevisionSha256)
    failGovernanceDoctorV1("governance doctor policy revision does not bind this operation");
  const denied = audit.kind === "refused" && audit.state === "policy-denied";
  if (denied !== (policy.decision === "denied"))
    failGovernanceDoctorV1("governance doctor policy decision does not bind this operation");
  if ((audit.kind === "refused") !== (guide.kind === "withheld"))
    failGovernanceDoctorV1("governance doctor audit and guide disagree about refusal");
}

/**
 * Projects one adapter run into the closed presentation. The three members are
 * accepted only when each carries the brand its own module minted, so a proxy, a
 * value with accessors, or a structurally identical parse of the record's own
 * bytes is refused before any field is read.
 */
export function presentGovernanceDoctorOperationV1(
  value: unknown,
  policy: unknown,
): GovernanceDoctorPresentationV1 {
  const request = assertRecordV1(value, "governance doctor operation");
  assertExactKeysV1(request, ["audit", "guide", "record"], "governance doctor operation");
  canonicalGovernanceDoctorOperationV1Bytes(request.record);
  canonicalGovernanceDoctorAuditV1Bytes(request.audit);
  canonicalGovernanceDoctorGuideV1Bytes(request.guide);
  const audit = request.audit as GovernanceDoctorAuditV1Result;
  const guide = request.guide as GovernanceDoctorGuideV1;
  const record = request.record as GovernanceDoctorOperationRecordV1;
  const policyValue = policyState(policy);
  assertBoundOperation(audit, guide, record, policyValue);

  const identity: GovernanceDoctorPresentationIdentityV1 = {
    auditSha256: record.auditSha256,
    contextSha256: record.contextSha256,
    guideSha256: record.guideSha256,
    operationSha256: record.operationSha256,
    profileSha256: record.profileSha256,
    rootSha256: record.rootSha256,
    surfaceRevisionSha256: record.surfaceRevisionSha256,
  };
  if (guide.kind === "withheld")
    return presentation({
      conflicts: [],
      dispatchedDiagnosticIds: [],
      findings: [],
      guidance: null,
      identity,
      nextAction: { actionId: null, executable: false, owner: "aih", unavailable: true },
      outcome: "refused",
      policy: policyValue,
      prerequisites: [],
      protocol: PROTOCOL,
      refusals: [],
      repairPosture: null,
      roles: [],
      state: guide.state,
      surfaceId: null,
      targetId: record.targetId,
    });
  return presentation({
    conflicts: guide.conflicts.map((conflict) => ({
      conflictId: conflict.conflictId,
      conflictsWithSurfaceId: conflict.conflictsWithSurfaceId,
      note: conflict.note,
    })),
    dispatchedDiagnosticIds: record.kind === "completed" ? [...record.dispatchedDiagnosticIds] : [],
    findings: guide.findings.map((finding) => ({
      code: finding.code,
      diagnosticId: finding.diagnosticId,
      severity: finding.severity,
      summary: finding.summary,
    })),
    guidance: guide.guidance,
    identity,
    nextAction: {
      actionId: guide.nextAction.actionId,
      executable: false,
      owner: guide.nextAction.owner,
      unavailable: false,
    },
    outcome: guide.refusals.length === 0 ? "completed" : "evidence-gap",
    policy: policyValue,
    prerequisites: guide.prerequisites.map((prerequisite) => ({
      note: prerequisite.note,
      prerequisiteId: prerequisite.prerequisiteId,
      satisfiedBy: prerequisite.satisfiedBy,
    })),
    protocol: PROTOCOL,
    refusals: guide.refusals.map((refusal) => ({
      diagnosticId: refusal.diagnosticId,
      state: refusal.state,
    })),
    repairPosture: guide.repairPosture,
    roles: guide.roles.map((role) => ({
      owner: role.owner,
      roleId: role.roleId,
      summary: role.summary,
    })),
    state: null,
    surfaceId: guide.surfaceId,
    targetId: guide.targetId,
  });
}

/**
 * The fail-closed presentation for a run that produced no audit at all: the
 * shipped artifact could not be read as a canonical profile, or the adapter did
 * not return a bound run. It reports the bounded reason and nothing else --
 * there is no audit to summarize and no identity to claim.
 */
export function presentGovernanceDoctorUnavailableV1(
  state: unknown,
  policy: unknown,
): GovernanceDoctorPresentationV1 {
  return presentation({
    conflicts: [],
    dispatchedDiagnosticIds: [],
    findings: [],
    guidance: null,
    identity: null,
    nextAction: { actionId: null, executable: false, owner: "aih", unavailable: true },
    outcome: "unavailable",
    policy: policyState(policy),
    prerequisites: [],
    protocol: PROTOCOL,
    refusals: [],
    repairPosture: null,
    roles: [],
    state: assertEnumV1(state, UNAVAILABLE_STATES, "governance doctor unavailable state"),
    surfaceId: null,
    targetId: null,
  });
}

/** One run's presentation plus the exact records a preview may be minted from. */
interface GovernanceDoctorRunV1 {
  readonly context: Readonly<{ readonly protocol: "GovernanceDoctorOperationalContextV1" }>;
  readonly operation: GovernanceDoctorOperationV1 | undefined;
  readonly presented: GovernanceDoctorPresentationV1;
  readonly profile: GovernanceDoctorProfileV1 | undefined;
}

/** One adapter invocation per command run; every failure becomes a bounded outcome. */
async function runPresentation(ctx: PlanContext): Promise<GovernanceDoctorRunV1> {
  const context = createGovernanceDoctorOperationalContextV1(ctx);
  const policy = resolveGovernanceDoctorPolicyStateV1(context);
  let profile: GovernanceDoctorProfileV1;
  try {
    profile = loadShippedGovernanceDoctorProfileV1();
  } catch {
    return {
      context,
      operation: undefined,
      presented: presentGovernanceDoctorUnavailableV1("profile-unavailable", policy),
      profile: undefined,
    };
  }
  try {
    const operation: GovernanceDoctorOperationV1 = await runGovernanceDoctorOperationV1({
      context,
      policy: { decision: policy.decision, revisionSha256: policy.revisionSha256 },
      profile,
    });
    return {
      context,
      operation,
      presented: presentGovernanceDoctorOperationV1(operation, policy),
      profile,
    };
  } catch {
    return {
      context,
      operation: undefined,
      presented: presentGovernanceDoctorUnavailableV1("adapter-unavailable", policy),
      profile,
    };
  }
}

/**
 * Resolves this run's Repair eligibility. This is the trusted configuration
 * boundary: the preview module holds no filesystem, settings, or environment
 * capability, so the committed marker is read, validated, and reduced to a
 * branded record here, and only the record crosses over.
 *
 * Every input is AIH-owned. The root comes from the sanitized operational
 * context, not from an option or a caller argument; the marker is read through
 * the shared reader, which returns nothing for an absent or invalid marker and
 * raises for a governance-controlled field it must not ignore; and the run's
 * resolved execution context directory is the one the same context already
 * bound. An override that disagrees with the committed marker, a marker naming
 * any other directory, and a marker that could not be read at all all resolve to
 * nothing, because the mint refuses everything but the canonical constant.
 *
 * The digest binds the record to this operation's root, so an eligibility record
 * cannot be presented beside a different repository's audit.
 *
 * Two limits are recorded rather than claimed away. The shared marker reader
 * opens the committed file through the ordinary read-if-exists path, which
 * follows a symlink and asserts nothing about the entry being regular; a
 * substituted marker can therefore make a run ineligible or eligible according
 * to whatever it names. And the marker is read after the audit's own diagnostics
 * ran, so the two filesystem observations are not one atomic view. Neither is
 * load-bearing while the preview is unexecutable and mutates nothing, and both
 * would have to be closed before any of this became authority to write.
 */
function resolveGovernanceDoctorRepairEligibilityV1(
  context: unknown,
  rootSha256: string,
): GovernanceDoctorRepairEligibilityV1 | undefined {
  try {
    const ctx = governanceDoctorOperationalPlanContextV1(context);
    const marker = readAihConfig(ctx.root);
    if (marker === undefined) return undefined;
    return mintGovernanceDoctorRepairEligibilityV1(marker.contextDir, ctx.contextDir, rootSha256);
  } catch {
    // A marker this run cannot read or validate is not authority to repair.
    return undefined;
  }
}

/**
 * Renders the preview as bounded operator prose. Every populated value is a
 * digest, a recipe name, or a summary field whose arguments are already
 * validated managed tokens, digests, and managed-relative paths.
 */
function renderRepairPlanPreviewText(previewed: GovernanceDoctorRepairPlanPreviewV1): string {
  const lines = [
    "Governance Doctor repair plan preview",
    `  outcome: ${previewed.outcome}`,
    "  executable: false",
  ];
  if (previewed.planSha256 !== null) {
    lines.push(`  plan: ${previewed.planSha256}`);
    lines.push(`  recipe: ${previewed.recipeId ?? "none"}`);
    lines.push(`  summary: ${previewed.summarySha256 ?? "none"}`);
    lines.push(`  expires at epoch ms: ${previewed.expiresAtEpochMs ?? "none"}`);
  }
  for (const effect of previewed.effects)
    lines.push(
      `  effect ${effect.effectId} (${effect.effectKind}): ${Object.entries(effect.arguments)
        .map(([name, value]) => `${name}=${value}`)
        .join(", ")}`,
    );
  lines.push(`  ${previewed.notice}`);
  return `${lines.join("\n")}\n`;
}

export const command: CommandSpec = {
  name: "governance-doctor",
  summary:
    "Present the shipped read-only Governance Doctor Audit and Guide (zero-write; no next action or mutation is executed)",
  readOnly: true,
  honorReadOnlyPostureFlag: true,
  zeroWrite: true,
  options: [
    {
      flags: "--repair-plan",
      description:
        "Additionally present the preview-only mechanical Repair plan derivation (mints no authority; nothing becomes executable)",
    },
  ],
  plan: async (ctx) => {
    const run = await runPresentation(ctx);
    const actions = [
      probe("governance doctor audit and guide", () => run.presented.check),
      digest("governance doctor audit and guide", run.presented.text, run.presented.report),
    ];
    if (ctx.options.repairPlan === true) {
      // The preview consumes only this run's own records; an unavailable run
      // collapses inside the preview module to its fixed no-plan outcome. The
      // marker is read only on this subroute, so the default read-only
      // presentation reaches no configuration it did not already need.
      const previewed = presentGovernanceDoctorRepairPlanPreviewV1({
        eligibility:
          run.operation === undefined
            ? undefined
            : resolveGovernanceDoctorRepairEligibilityV1(
                run.context,
                run.operation.record.rootSha256,
              ),
        operation: run.operation,
        profile: run.profile,
      });
      actions.push(
        digest(
          "governance doctor repair plan preview",
          renderRepairPlanPreviewText(previewed),
          previewed,
        ),
      );
    }
    return plan("governance-doctor", ...actions);
  },
};
