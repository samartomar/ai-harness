import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  type McpProjectionDecisionBindings,
  McpProjectionDecisionBindingsSchema,
} from "../config/marker.js";
import { readRegularFile } from "../internals/fsxn.js";
import {
  canAppendPolicyAihIgnore,
  policyAihIgnoreRollbackContents,
  policyAihIgnoreWrite,
} from "../internals/gitignore.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";
import { type Action, type PlanContext, remove, writeJson, writeText } from "../internals/plan.js";
import { managedMcpAllowlistSettings } from "../mcp/allowlist.js";
import { managedMcpExample } from "../mcp/enterprise.js";
import {
  kiroMcpProjectionActions,
  kiroMcpProjectionExpected,
  kiroMcpProjectionOnDisk,
  kiroMcpProjectionState,
} from "../mcp/kiro-managed-projection.js";
import {
  clearManagedMcpProjectionOwnershipAction,
  MANAGED_MCP_PROJECTION_KEYS,
  MANAGED_SETTINGS_PATH,
  managedMcpProjectionOnDisk,
  managedMcpProjectionOwnershipAction,
  managedMcpProjectionState,
  readManagedSettings,
  revokeManagedMcpProjectionOwnershipAction,
  unprovableResidueReason,
  withExpectedContents,
} from "../mcp/managed-projection.js";
import { mcpApprovalSubject } from "../mcp/policy.js";
import { coalesceMcpProjectionMarkerActions } from "../mcp/projection-marker.js";
import { type McpServer, mcpServers, type StdioServer } from "../mcp/servers.js";
import { scanRepo } from "../profile/scan.js";
import { usageRecorderScript } from "../usage/capture.js";
import { usageHookActions } from "../usage/hooks.js";
import { composeOrgPolicy } from "./compose.js";
import { planEccHookControlsProjection } from "./ecc-hook-controls-projection.js";
import {
  candidateIdentityDigest,
  type EffectiveOrgPolicy,
  resolveEffectiveOrgPolicy,
  stableJson,
} from "./effective.js";
import { HOOK_REGISTRAR_DESTINATION, hookRegistrarProjectionActions } from "./hook-registrar.js";
import { expectedHooksFromReceipt, readHookRegistrarReceipt } from "./hook-registrar-receipt.js";
import { type RuntimeOrgPolicyResolution, resolveRuntimeOrgPolicy } from "./runtime.js";
import { governanceOwnsAihSurfaces, type OrgPolicy, OrgPolicyError } from "./schema.js";

export const ORG_POLICY_HOOK_RECEIPT_PATH = ".aih/org-policy-hook-receipt.json";

function commandPolicyFor(composed: ReturnType<typeof composeOrgPolicy>): Record<string, unknown> {
  return {
    deny: composed.command.deny.map((rule) => ({ pattern: rule.pattern, reason: rule.reason })),
    ask: composed.command.ask.map((rule) => ({ pattern: rule.pattern, reason: rule.reason })),
    safeReadOnly: composed.command.safe_read_only.map((rule) => rule.pattern),
    safeVerification: composed.command.safe_verification.map((rule) => rule.pattern),
  };
}

/**
 * Blocking codes whose remediation actually reads the external authority registry —
 * evidence and approval verification. Everything else (target coverage, projector
 * availability, posture) resolves without it.
 */
const AUTHORITY_DEPENDENT_BLOCK_CODES: ReadonlySet<string> = new Set([
  "evidence-missing",
  "evidence-failed",
  "evidence-identity-drift",
  "authority-receipt-unverified",
  "authority-receipt-mismatch",
  "authority-target-coverage-mismatch",
  "approval-missing",
  "approval-ambiguous",
  "approval-expired",
  "approval-not-yet-valid",
  "approval-revoked",
  "approval-signer-untrusted",
  "approval-digest-mismatch",
  "approval-scope-mismatch",
  "approval-clarification-missing",
  "approval-policy-version-mismatch",
  "approval-duration-invalid",
  "decision-receipt-missing",
  "decision-receipt-version",
  "decision-receipt-expired",
  "decision-reference-missing",
  "decision-reference-unresolved",
  "decision-receipt-mismatch",
  "decision-signer-mismatch",
  "decision-subject-mismatch",
  "decision-control-mismatch",
  "decision-scope-mismatch",
  "decision-coverage-mismatch",
  "decision-rejected",
  "decision-revoked",
  "decision-not-yet-valid",
  "decision-expired",
  "decision-review-overdue",
]);

function candidateBlockDetail(candidate: EffectiveOrgPolicy["candidates"][number]): string {
  const decision = (candidate.decisionBlockers ?? []).map((blocker) => blocker.code);
  return (
    [...candidate.dangerCodes, ...candidate.blockingCodes, ...decision].join(", ") ||
    "not-effective"
  );
}

function policyDecisionBlockDetail(effective: EffectiveOrgPolicy): string {
  return effective.decisionBlockers
    .map(
      (blocker) => `${blocker.code}${blocker.decision === undefined ? "" : `:${blocker.decision}`}`,
    )
    .sort(ordinalCompare)
    .join(", ");
}

function blockedProjectionDetail(effective: EffectiveOrgPolicy): string {
  const candidates = effective.candidates
    .filter((candidate) => candidate.requested && !candidate.effective)
    .map(
      (candidate) =>
        `${candidate.id}: ${candidateBlockDetail(candidate)}${
          candidate.resolutionReasons.length === 0
            ? ""
            : `; resolution=${candidate.resolutionReasons.join(", ")}`
        }`,
    )
    .join("; ");
  const policy = policyDecisionBlockDetail(effective);
  return [candidates, policy === "" ? "" : `policy decision blockers: ${policy}`]
    .filter((detail) => detail !== "")
    .join("; ");
}

/**
 * The registry note, only when a blocked candidate's own codes depend on it.
 *
 * `verifyPolicyAuthorityReceipt` runs on every invocation, so its "registry
 * unavailable" problem was appended to EVERY blocked-candidate refusal regardless of
 * why the candidate blocked. An operator whose candidates were merely target-unselected
 * got sent chasing `AIH_POLICY_AUTHORITY_REPOSITORY`, then watched the note vanish once
 * the selection was fixed — not because the registry became available, but because
 * nothing threw. That reads as a prerequisite when it is a cascade.
 */
export function authoritySuffix(runtime: RuntimeOrgPolicyResolution): string {
  if (runtime.authorityProblem === undefined) return "";
  const dependsOnAuthority =
    runtime.effective.candidates.some(
      (candidate) =>
        candidate.requested &&
        !candidate.effective &&
        [
          ...candidate.dangerCodes,
          ...candidate.blockingCodes,
          ...(candidate.decisionBlockers ?? []).map((blocker) => blocker.code),
        ].some((code) => AUTHORITY_DEPENDENT_BLOCK_CODES.has(code)),
    ) || (runtime.effective.decisionBlockers?.length ?? 0) > 0;
  return dependsOnAuthority ? `; authority: ${runtime.authorityProblem}` : "";
}

function stdioAllowedServers(
  policy: OrgPolicy,
  runtime: RuntimeOrgPolicyResolution,
  allowed: readonly string[],
  disabled: readonly string[],
  enforceAllowlist: boolean,
): { servers: Record<string, StdioServer>; effective: EffectiveOrgPolicy } {
  const { catalog, effective } = runtime;
  if (effective.blocking) {
    const blocked = blockedProjectionDetail(effective);
    throw new OrgPolicyError(
      `policy project refuses blocked candidate activation(s): ${blocked || "unknown policy resolution failure"}${authoritySuffix(runtime)}`,
    );
  }
  // Governance is authoritative: legacy `mcp.allowedServers` / `disabledServers`
  // never add to or subtract from a reviewed control selection. `allowManagedOnly`
  // is still the explicit adapter enablement gate checked by the resolver.
  const governed = governanceOwnsAihSurfaces(policy);
  const allowedSet = new Set(
    governed
      ? effective.candidates
          .filter(
            (candidate) => candidate.effective && isProjectionSurfaceCandidate(candidate, "mcp"),
          )
          .map((candidate) => candidate.id)
      : [...allowed],
  );
  const disabledSet = new Set(governed ? [] : disabled);
  const out: Record<string, StdioServer> = {};
  for (const [name, server] of Object.entries(catalog)) {
    if (
      disabledSet.has(name) ||
      (enforceAllowlist && !allowedSet.has(name)) ||
      server.type !== "stdio"
    )
      continue;
    out[name] = server;
  }
  return { servers: out, effective };
}

interface PolicyHookReceiptEntry {
  kind: "json-hook" | "text-file";
  path: string;
  preExisting: "absent" | "present";
  expectedDigest?: string;
  expectedPostToolUse?: unknown;
  hooksPresent?: boolean;
}

interface PolicyHookReceipt {
  format: "aih-org-policy-hook-receipt";
  version: 2 | 3;
  policyVersion?: string;
  hooks: Array<{ id: string; sourceDigest: string; targets: string[] }>;
  entries: PolicyHookReceiptEntry[];
  /** v3 binds current, effective decisions without embedding decision prose. */
  decisions?: McpProjectionDecisionBindings;
  /** Domain-separated integrity digest; it never grants authority by itself. */
  selfDigest?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isProjectionSurfaceCandidate(
  candidate: EffectiveOrgPolicy["candidates"][number],
  surface: "mcp" | "usage-hook",
): boolean {
  return surface === "mcp"
    ? candidate.kind === "mcp" && candidate.projection.projector === "mcp-managed-settings"
    : candidate.kind === "hook" &&
        candidate.projection.projector === "usage-hook" &&
        candidate.source.type === "hook" &&
        candidate.source.handler === "usage-metering";
}

function decisionBindingsFor(
  effective: EffectiveOrgPolicy,
  surface: "mcp" | "usage-hook",
  target: string | ReadonlySet<string>,
): McpProjectionDecisionBindings {
  const includesTarget = (candidate: EffectiveOrgPolicy["candidates"][number]) =>
    typeof target === "string"
      ? candidate.projection.requestedTargets.includes(target)
      : candidate.projection.requestedTargets.some((item) => target.has(item));
  return effective.candidates
    .filter(
      (candidate) =>
        candidate.effective &&
        isProjectionSurfaceCandidate(candidate, surface) &&
        includesTarget(candidate) &&
        candidate.decision !== undefined,
    )
    .map((candidate) => {
      const decision = candidate.decision;
      if (decision === undefined) throw new OrgPolicyError("missing effective decision binding");
      const expiresAt =
        decision.reviewBy !== undefined &&
        Date.parse(decision.reviewBy) < Date.parse(decision.expiresAt)
          ? decision.reviewBy
          : decision.expiresAt;
      return {
        candidate: candidate.id,
        id: decision.id,
        issuer: decision.issuer,
        digest: decision.digest,
        expiresAt,
      };
    })
    .sort((left, right) =>
      left.candidate === right.candidate
        ? ordinalCompare(left.id, right.id)
        : ordinalCompare(left.candidate, right.candidate),
    );
}

function usageHookIdentities(
  effective: EffectiveOrgPolicy,
  currentTargets: ReadonlySet<string>,
): Array<{ id: string; sourceDigest: string; targets: string[] }> {
  return effective.candidates
    .filter(
      (candidate) =>
        candidate.effective &&
        candidate.kind === "hook" &&
        candidate.projection.projector === "usage-hook" &&
        candidate.source.type === "hook" &&
        candidate.source.handler === "usage-metering",
    )
    .map((candidate) => ({
      id: candidate.id,
      sourceDigest: candidate.sourceDigest,
      targets: candidate.projection.requestedTargets.filter((target) => currentTargets.has(target)),
    }))
    .filter((candidate) => candidate.targets.length > 0)
    .sort((left, right) => ordinalCompare(left.id, right.id));
}

function decisionReceiptState(
  ownership: { schemaVersion: number; decisions?: McpProjectionDecisionBindings },
  effective: EffectiveOrgPolicy,
  surface: "mcp" | "usage-hook",
  target: string | ReadonlySet<string>,
): "upgrade-required" | "retained-invalid-decision" | undefined {
  const matchesTarget = (candidate: EffectiveOrgPolicy["candidates"][number]) =>
    typeof target === "string"
      ? candidate.projection.requestedTargets.includes(target)
      : candidate.projection.requestedTargets.some((item) => target.has(item));
  const requestedOnSurface = effective.candidates.some(
    (candidate) =>
      candidate.requested &&
      isProjectionSurfaceCandidate(candidate, surface) &&
      matchesTarget(candidate),
  );
  if (ownership.schemaVersion === 1) {
    return requestedOnSurface ? "upgrade-required" : undefined;
  }
  const prior = ownership.decisions ?? [];
  const current = decisionBindingsFor(effective, surface, target);
  if (stableJson(prior) === stableJson(current)) return undefined;
  const stillRequested = effective.candidates.some(
    (candidate) =>
      candidate.requested &&
      isProjectionSurfaceCandidate(candidate, surface) &&
      matchesTarget(candidate) &&
      (prior.some((binding) => binding.candidate === candidate.id) ||
        current.some((binding) => binding.candidate === candidate.id)),
  );
  return stillRequested ? "retained-invalid-decision" : undefined;
}

export function publicDecisionView(
  decision: NonNullable<EffectiveOrgPolicy["candidates"][number]["decision"]>,
) {
  return {
    id: decision.id,
    digest: decision.digest,
    issuer: decision.issuer,
    actor: decision.actor,
    disposition: decision.disposition,
    notBefore: decision.notBefore,
    expiresAt: decision.expiresAt,
    ...(decision.reviewBy === undefined ? {} : { reviewBy: decision.reviewBy }),
    acceptedFindings: decision.acceptedFindings,
    acceptedGaps: decision.acceptedGaps,
    observedFindings: decision.observedFindings,
    observedGaps: decision.observedGaps,
    ...(decision.riskState === undefined ? {} : { riskState: decision.riskState }),
  };
}

function hookReceiptPayload(
  policyVersion: string | undefined,
  hooks: PolicyHookReceipt["hooks"],
  entries: PolicyHookReceiptEntry[],
  decisions: McpProjectionDecisionBindings,
) {
  return {
    format: "aih-org-policy-hook-receipt" as const,
    version: 3 as const,
    ...(policyVersion === undefined ? {} : { policyVersion }),
    hooks,
    entries,
    decisions,
  };
}

function hookReceiptSelfDigest(payload: ReturnType<typeof hookReceiptPayload>): string {
  return `sha256:${sha256(`aih-org-policy-hook-receipt/v3\0${stableJson(payload)}`)}`;
}

function usageHookSourceDigest(): string {
  return candidateIdentityDigest({
    source: {
      type: "hook",
      handler: "usage-metering",
      scriptDigest: `sha256:${sha256(usageRecorderScript())}`,
    },
  } as never);
}

function assertOwnedPathHasNoSymlinkParent(ctx: PlanContext, rel: string): void {
  const parts = rel.split(/[\\/]+/).filter((part) => part.length > 0);
  let current = ctx.root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new OrgPolicyError(`${rel} has an unsafe symlinked parent (${part})`);
      }
    } catch (error) {
      if (error instanceof OrgPolicyError) throw error;
      // A not-yet-created parent cannot redirect an ownership read.
    }
  }
}

/** No-follow read with root-to-leaf symlink protection for ownership state. */
function ownedText(ctx: PlanContext, rel: string): string | undefined {
  assertOwnedPathHasNoSymlinkParent(ctx, rel);
  const abs = join(ctx.root, rel);
  const value = readRegularFile(abs)?.toString("utf8");
  if (value !== undefined) return value;
  try {
    lstatSync(abs);
  } catch {
    return undefined;
  }
  throw new OrgPolicyError(`${rel} is not a regular, AIH-safe policy hook path`);
}

function readHookSlot(
  raw: string | undefined,
  path: string,
): {
  filePresent: boolean;
  hooksPresent: boolean;
  postToolUse?: unknown;
} {
  if (raw === undefined) return { filePresent: false, hooksPresent: false };
  let parsed: unknown;
  try {
    parsed = parseJsoncText(raw);
  } catch {
    throw new OrgPolicyError(`${path} is malformed; refusing policy hook ownership`);
  }
  if (!isPlainObject(parsed)) {
    throw new OrgPolicyError(`${path} is not a JSON object; refusing policy hook ownership`);
  }
  const hooks = parsed.hooks;
  if (hooks !== undefined && !isPlainObject(hooks)) {
    throw new OrgPolicyError(`${path}.hooks is not an object; refusing policy hook ownership`);
  }
  return {
    filePresent: true,
    hooksPresent: hooks !== undefined,
    ...(hooks !== undefined && Object.hasOwn(hooks, "PostToolUse")
      ? { postToolUse: hooks.PostToolUse }
      : {}),
  };
}

function expectedHostHook(
  ctx: PlanContext,
  target: "claude" | "codex",
): {
  path: string;
  postToolUse: unknown;
} {
  const action = usageHookActions(ctx, [target]).find(
    (item): item is Extract<Action, { kind: "write" }> =>
      item.kind === "write" && item.json !== undefined,
  );
  if (action === undefined || !isPlainObject(action.json) || !isPlainObject(action.json.hooks)) {
    throw new OrgPolicyError(`AIH has no safe host hook generator for ${target}`);
  }
  const postToolUse = action.json.hooks.PostToolUse;
  if (postToolUse === undefined)
    throw new OrgPolicyError(`AIH host hook generator for ${target} is incomplete`);
  return { path: action.path, postToolUse };
}

/** Persisted receipt metadata must retain the policy's authored text boundary. */
function isSafePolicyVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 500 &&
    value === value.trim() &&
    /\S/u.test(value) &&
    !/\p{C}/u.test(value)
  );
}

function parseHookReceipt(ctx: PlanContext): { receipt?: PolicyHookReceipt; raw?: string } {
  const raw = ownedText(ctx, ORG_POLICY_HOOK_RECEIPT_PATH);
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OrgPolicyError(
      `${ORG_POLICY_HOOK_RECEIPT_PATH} is malformed; refusing hook ownership`,
    );
  }
  if (
    !isPlainObject(value) ||
    value.format !== "aih-org-policy-hook-receipt" ||
    (value.version !== 2 && value.version !== 3)
  ) {
    throw new OrgPolicyError(`${ORG_POLICY_HOOK_RECEIPT_PATH} is not an AIH policy hook receipt`);
  }
  const allowedTopLevel = new Set(
    value.version === 2
      ? ["format", "version", "policyVersion", "hooks", "entries"]
      : ["format", "version", "policyVersion", "hooks", "entries", "decisions", "selfDigest"],
  );
  if (Object.keys(value).some((key) => !allowedTopLevel.has(key))) {
    throw new OrgPolicyError(`${ORG_POLICY_HOOK_RECEIPT_PATH} has unexpected receipt fields`);
  }
  if (!Array.isArray(value.hooks) || !Array.isArray(value.entries)) {
    throw new OrgPolicyError(`${ORG_POLICY_HOOK_RECEIPT_PATH} has incomplete ownership entries`);
  }
  if (value.hooks.length === 0) {
    throw new OrgPolicyError(`${ORG_POLICY_HOOK_RECEIPT_PATH} has no owned hook identity`);
  }
  const hooks = value.hooks.map((hook) => {
    if (
      !isPlainObject(hook) ||
      Object.keys(hook).some((key) => !["id", "sourceDigest", "targets"].includes(key)) ||
      hook.id !== "usage-metering" ||
      typeof hook.sourceDigest !== "string" ||
      hook.sourceDigest !== usageHookSourceDigest() ||
      !Array.isArray(hook.targets) ||
      hook.targets.length === 0 ||
      !hook.targets.every((target) => target === "claude" || target === "codex") ||
      new Set(hook.targets).size !== hook.targets.length
    ) {
      throw new OrgPolicyError(`${ORG_POLICY_HOOK_RECEIPT_PATH} has invalid hook identity entries`);
    }
    return { id: hook.id, sourceDigest: hook.sourceDigest, targets: [...hook.targets] as string[] };
  });
  if (new Set(hooks.map((hook) => hook.id)).size !== hooks.length) {
    throw new OrgPolicyError(`${ORG_POLICY_HOOK_RECEIPT_PATH} has duplicate hook identities`);
  }
  const selectedTargets = [...new Set(hooks.flatMap((hook) => hook.targets))].sort();
  const entries: PolicyHookReceiptEntry[] = [];
  const paths = new Set<string>();
  for (const entry of value.entries) {
    if (!isPlainObject(entry) || typeof entry.path !== "string" || paths.has(entry.path)) {
      throw new OrgPolicyError(`${ORG_POLICY_HOOK_RECEIPT_PATH} has conflicting ownership entries`);
    }
    paths.add(entry.path);
    if (
      (entry.kind !== "json-hook" && entry.kind !== "text-file") ||
      (entry.preExisting !== "absent" && entry.preExisting !== "present")
    ) {
      throw new OrgPolicyError(`${ORG_POLICY_HOOK_RECEIPT_PATH} has invalid ownership entries`);
    }
    const allowedEntryFields =
      entry.kind === "json-hook"
        ? ["kind", "path", "preExisting", "hooksPresent", "expectedPostToolUse"]
        : ["kind", "path", "preExisting", "expectedDigest"];
    if (Object.keys(entry).some((key) => !allowedEntryFields.includes(key))) {
      throw new OrgPolicyError(`${ORG_POLICY_HOOK_RECEIPT_PATH} has unexpected ownership fields`);
    }
    if (entry.kind === "json-hook") {
      if (
        (entry.path !== ".claude/settings.json" && entry.path !== ".codex/hooks.json") ||
        typeof entry.hooksPresent !== "boolean" ||
        entry.expectedPostToolUse === undefined
      ) {
        throw new OrgPolicyError(
          `${ORG_POLICY_HOOK_RECEIPT_PATH} has unsafe hook ownership entries`,
        );
      }
      const target = entry.path === ".claude/settings.json" ? "claude" : "codex";
      if (
        stableJson(entry.expectedPostToolUse) !==
        stableJson(expectedHostHook(ctx, target).postToolUse)
      ) {
        throw new OrgPolicyError(
          `${ORG_POLICY_HOOK_RECEIPT_PATH} does not match the AIH hook generator`,
        );
      }
    } else if (
      (entry.path !== ".aih/usage-record.mjs" && entry.path !== ".gitignore") ||
      (entry.path === ".aih/usage-record.mjs" && entry.preExisting !== "absent") ||
      typeof entry.expectedDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.expectedDigest) ||
      (entry.path === ".aih/usage-record.mjs" &&
        entry.expectedDigest !== sha256(usageRecorderScript()))
    ) {
      throw new OrgPolicyError(`${ORG_POLICY_HOOK_RECEIPT_PATH} has unsafe text ownership entries`);
    }
    entries.push({
      kind: entry.kind,
      path: entry.path,
      preExisting: entry.preExisting,
      ...(typeof entry.expectedDigest === "string" ? { expectedDigest: entry.expectedDigest } : {}),
      ...(entry.expectedPostToolUse === undefined
        ? {}
        : { expectedPostToolUse: entry.expectedPostToolUse }),
      ...(typeof entry.hooksPresent === "boolean" ? { hooksPresent: entry.hooksPresent } : {}),
    });
  }
  const expectedPaths = new Set<string>([
    ".aih/usage-record.mjs",
    ".gitignore",
    ...selectedTargets.map((target) =>
      target === "claude" ? ".claude/settings.json" : ".codex/hooks.json",
    ),
  ]);
  if (paths.size !== expectedPaths.size || [...expectedPaths].some((path) => !paths.has(path))) {
    throw new OrgPolicyError(
      `${ORG_POLICY_HOOK_RECEIPT_PATH} does not prove exactly one host entry per selected target`,
    );
  }
  if (Object.hasOwn(value, "policyVersion") && !isSafePolicyVersion(value.policyVersion)) {
    throw new OrgPolicyError(`${ORG_POLICY_HOOK_RECEIPT_PATH} has an invalid policyVersion`);
  }
  const policyVersion = value.policyVersion as string | undefined;
  if (value.version === 2) {
    return {
      raw,
      receipt: {
        format: "aih-org-policy-hook-receipt",
        version: 2,
        ...(policyVersion === undefined ? {} : { policyVersion }),
        hooks,
        entries,
      },
    };
  }
  const parsedDecisions = McpProjectionDecisionBindingsSchema.safeParse(value.decisions);
  if (!parsedDecisions.success || typeof value.selfDigest !== "string") {
    throw new OrgPolicyError(`${ORG_POLICY_HOOK_RECEIPT_PATH} has invalid v3 decision bindings`);
  }
  const payload = hookReceiptPayload(policyVersion, hooks, entries, parsedDecisions.data);
  if (value.selfDigest !== hookReceiptSelfDigest(payload)) {
    throw new OrgPolicyError(`${ORG_POLICY_HOOK_RECEIPT_PATH} has an invalid v3 self-digest`);
  }
  return { raw, receipt: { ...payload, selfDigest: value.selfDigest } };
}

const usageHostPaths = [
  ["claude", ".claude/settings.json"],
  ["codex", ".codex/hooks.json"],
] as const;

/**
 * The exact PostToolUse value the hook registrar's receipt proves AIH wrote
 * into its destination, or undefined when no registrar receipt exists or it
 * cannot be believed.
 *
 * The usage projector and the hook registrar are different owners of the same
 * `.claude/settings.json`, and the usage scan below runs on EVERY projection —
 * registrar-only policies included. Without consulting the registrar's receipt
 * the scan mistook AIH's own receipted projection for an unreceipted legacy
 * artifact and refused every run after the first (6.0.1 field regression). An
 * unreadable or invalid registrar receipt proves nothing and keeps the
 * fail-closed refusal.
 */
function hookRegistrarClaimedPostToolUse(ctx: PlanContext): unknown {
  try {
    const receipt = readHookRegistrarReceipt(ctx.root);
    if (receipt === undefined) return undefined;
    const hooks = expectedHooksFromReceipt(receipt);
    return Object.hasOwn(hooks, "PostToolUse") ? hooks.PostToolUse : undefined;
  } catch {
    return undefined;
  }
}

function usagePostToolUseDescription(
  ctx: PlanContext,
  target: "claude" | "codex",
  postToolUse: unknown,
): string {
  return stableJson(postToolUse) === stableJson(expectedHostHook(ctx, target).postToolUse)
    ? "matching PostToolUse"
    : "conflicting PostToolUse";
}

/**
 * Every removal and active-state check scans both supported host paths. A
 * receipt proves only its exact selection; it never authorizes an extra hook
 * left by legacy usage or a prior wider projection.
 */
function usageArtifactOwnershipIssue(
  ctx: PlanContext,
  receipt?: PolicyHookReceipt,
): string | undefined {
  const entries = new Map(receipt?.entries.map((entry) => [entry.path, entry]));
  const recorder = ownedText(ctx, ".aih/usage-record.mjs");
  const recorderEntry = entries.get(".aih/usage-record.mjs");
  if (receipt === undefined) {
    if (recorder !== undefined) {
      return `unreceipted ${recorder === usageRecorderScript() ? "matching" : "conflicting"} usage recorder`;
    }
  } else if (recorder === undefined) {
    return "receipt-owned usage recorder is absent";
  } else if (
    recorderEntry?.kind !== "text-file" ||
    recorderEntry.expectedDigest !== sha256(usageRecorderScript()) ||
    recorder !== usageRecorderScript()
  ) {
    return "receipt-owned usage recorder drifted from the exact AIH recorder";
  }

  const ignoreEntry = entries.get(".gitignore");
  if (receipt !== undefined) {
    const ignore = ownedText(ctx, ".gitignore");
    if (ignore === undefined || ignoreEntry?.kind !== "text-file") {
      return "receipt-owned .gitignore policy marker is absent";
    }
    if (
      ignoreEntry.expectedDigest !== sha256(ignore) ||
      policyAihIgnoreRollbackContents(ignore) === undefined
    ) {
      return "receipt-owned .gitignore is not the exact AIH policy marker state";
    }
  }

  for (const [target, path] of usageHostPaths) {
    const raw = ownedText(ctx, path);
    if (raw === undefined) {
      const entry = entries.get(path);
      if (entry?.kind === "json-hook") return `${path} receipt-owned host hook is absent`;
      continue;
    }
    const slot = readHookSlot(raw, path);
    if (slot.postToolUse === undefined) {
      const entry = entries.get(path);
      if (entry?.kind === "json-hook") return `${path} receipt-owned PostToolUse hook is absent`;
      continue;
    }
    const entry = entries.get(path);
    // A PostToolUse slot the hook registrar's receipt claims EXACTLY is that
    // projector's own receipted output, not a legacy usage artifact. Anything
    // beyond the exact claim (drift, an extra group) stays a fail-closed refusal.
    if (entry?.kind !== "json-hook" && path === HOOK_REGISTRAR_DESTINATION) {
      const claimed = hookRegistrarClaimedPostToolUse(ctx);
      if (claimed !== undefined && stableJson(claimed) === stableJson(slot.postToolUse)) continue;
    }
    const description = usagePostToolUseDescription(ctx, target, slot.postToolUse);
    if (receipt === undefined || entry?.kind !== "json-hook") {
      return `${path} has an unreceipted ${description}`;
    }
    if (stableJson(slot.postToolUse) !== stableJson(entry.expectedPostToolUse)) {
      return `${path} receipt-owned PostToolUse hook changed since AIH projection`;
    }
  }
  return undefined;
}

function hookDeactivationActions(ctx: PlanContext): Action[] {
  const { receipt, raw: receiptRaw } = parseHookReceipt(ctx);
  const ownershipIssue = usageArtifactOwnershipIssue(ctx, receipt);
  if (ownershipIssue !== undefined) {
    const remediation =
      receipt === undefined
        ? "remove or migrate the legacy artifacts manually before policy projection"
        : "repair the owned artifact or remove the receipt only after manual remediation";
    throw new OrgPolicyError(
      `refusing conservative policy-hook rollback: ${ownershipIssue}; ${remediation}`,
    );
  }
  if (receipt === undefined || receiptRaw === undefined) return [];
  const actions: Action[] = [];
  for (const entry of receipt.entries) {
    const current = ownedText(ctx, entry.path);
    if (current === undefined) {
      throw new OrgPolicyError(
        `refusing conservative policy-hook rollback: ${entry.path} is absent`,
      );
    }
    if (entry.kind === "text-file") {
      if (sha256(current) !== entry.expectedDigest) {
        throw new OrgPolicyError(
          `refusing conservative policy-hook rollback: ${entry.path} changed since AIH projection`,
        );
      }
      if (entry.path === ".gitignore") {
        const rollback = policyAihIgnoreRollbackContents(current);
        if (rollback === undefined) {
          throw new OrgPolicyError(
            "refusing conservative policy-hook rollback: .gitignore is not an AIH policy marker state",
          );
        }
        if (rollback.contents === undefined) {
          actions.push(
            remove(entry.path, "remove unchanged AIH-owned policy hook ignore file", {
              expect: { sha256: sha256(current) },
            }),
          );
        } else {
          actions.push(
            withExpectedContents(
              writeText(entry.path, rollback.contents, "restore unchanged pre-policy .gitignore"),
              current,
            ),
          );
        }
        continue;
      }
      actions.push(
        remove(entry.path, `remove unchanged AIH-owned policy hook artifact ${entry.path}`, {
          expect: { sha256: sha256(current) },
        }),
      );
      continue;
    }
    const slot = readHookSlot(current, entry.path);
    if (stableJson(slot.postToolUse) !== stableJson(entry.expectedPostToolUse)) {
      throw new OrgPolicyError(
        `refusing conservative policy-hook rollback: ${entry.path} PostToolUse changed since AIH projection`,
      );
    }
    let parsed: unknown;
    try {
      parsed = parseJsoncText(current);
    } catch {
      throw new OrgPolicyError(
        `refusing conservative policy-hook rollback: ${entry.path} cannot be parsed safely`,
      );
    }
    const root = isPlainObject(parsed) ? { ...parsed } : undefined;
    const hooks = root !== undefined && isPlainObject(root.hooks) ? { ...root.hooks } : undefined;
    if (root === undefined || hooks === undefined) {
      throw new OrgPolicyError(
        `refusing conservative policy-hook rollback: ${entry.path} has no removable hook container`,
      );
    }
    const onlyGeneratedHook = Object.keys(root).length === 1 && Object.keys(hooks).length === 1;
    if (entry.preExisting === "absent" && !entry.hooksPresent && onlyGeneratedHook) {
      actions.push(
        remove(entry.path, `remove unchanged AIH-owned policy hook host file ${entry.path}`, {
          expect: { sha256: sha256(current) },
        }),
      );
    } else {
      delete hooks.PostToolUse;
      if (!entry.hooksPresent && Object.keys(hooks).length === 0) delete root.hooks;
      else root.hooks = hooks;
      actions.push(
        withExpectedContents(
          writeJson(entry.path, root, `remove unchanged AIH-owned policy hook from ${entry.path}`),
          current,
        ),
      );
    }
  }
  actions.push(
    remove(ORG_POLICY_HOOK_RECEIPT_PATH, "remove completed AIH policy hook ownership receipt", {
      expect: { sha256: sha256(receiptRaw) },
    }),
  );
  return actions;
}

/** Read-only receipt/drift state shared by policy evaluation, reports, and doctor. */
export function orgPolicyHookReceiptState(
  ctx: PlanContext,
  effective: EffectiveOrgPolicy,
): {
  state:
    | "absent"
    | "active"
    | "retained"
    | "retained-invalid-decision"
    | "upgrade-required"
    | "drifted"
    | "invalid"
    | "unowned";
  detail: string;
} {
  let parsed: { receipt?: PolicyHookReceipt };
  try {
    parsed = parseHookReceipt(ctx);
  } catch (error) {
    return { state: "invalid", detail: (error as Error).message };
  }
  if (parsed.receipt === undefined) {
    try {
      const ownershipIssue = usageArtifactOwnershipIssue(ctx);
      if (ownershipIssue !== undefined) {
        return {
          state: "unowned",
          detail:
            `unreceipted usage artifacts detected (${ownershipIssue}); ` +
            "AIH will not adopt or delete ambiguous legacy artifacts—remove or migrate them manually, then re-run policy projection",
        };
      }
    } catch (error) {
      return { state: "invalid", detail: (error as Error).message };
    }
    return { state: "absent", detail: "no policy hook receipt on disk" };
  }
  try {
    const ownershipIssue = usageArtifactOwnershipIssue(ctx, parsed.receipt);
    if (ownershipIssue !== undefined) {
      return {
        state: "drifted",
        detail:
          `conservative rollback of the policy hook is blocked: ${ownershipIssue}; ` +
          "repair the owned artifact or remove the receipt only after manual remediation",
      };
    }
  } catch (error) {
    return { state: "drifted", detail: (error as Error).message };
  }
  const currentTargets = new Set(ctx.targets ?? ["claude"]);
  if (parsed.receipt.version === 3) {
    const bindingState = decisionReceiptState(
      { schemaVersion: 2, decisions: parsed.receipt.decisions },
      effective,
      "usage-hook",
      currentTargets,
    );
    if (bindingState === "retained-invalid-decision") {
      return {
        state: bindingState,
        detail:
          "receipt and owned artifacts retain a decision binding that is no longer current; policy project must refresh or remove it",
      };
    }
  }
  const active = usageHookIdentities(effective, currentTargets);
  if (stableJson(active) !== stableJson(parsed.receipt.hooks)) {
    return {
      state: "retained",
      detail: "receipt names a hook no longer effective; conservative rollback is required",
    };
  }
  if (parsed.receipt.version === 2) {
    return {
      state: "upgrade-required",
      detail: "legacy v2 policy-hook receipt and owned artifacts require a v3 receipt refresh",
    };
  }
  const decisions = decisionBindingsFor(effective, "usage-hook", currentTargets);
  if (stableJson(parsed.receipt.decisions) !== stableJson(decisions)) {
    return {
      state: "retained-invalid-decision",
      detail:
        "receipt and owned artifacts retain a decision binding that is no longer current; policy project must refresh or remove it",
    };
  }
  if (parsed.receipt.policyVersion !== effective.policyVersion) {
    return {
      state: "upgrade-required",
      detail: "policy-hook receipt policyVersion is stale and requires a receipt-only refresh",
    };
  }
  return { state: "active", detail: "receipt and every AIH-owned hook artifact match" };
}

/** Read-only managed-MCP ownership/drift status for policy report and doctor. */
export function orgPolicyMcpReceiptState(
  ctx: PlanContext,
  effective: EffectiveOrgPolicy,
): {
  state:
    | "not-requested"
    | "clean"
    | "retained"
    | "retained-invalid-decision"
    | "upgrade-required"
    | "missing"
    | "altered"
    | "revoked"
    | "malformed"
    | "unsafe-path";
  detail: string;
} {
  const activeIds = effective.candidates
    .filter(
      (candidate) =>
        candidate.effective &&
        isProjectionSurfaceCandidate(candidate, "mcp") &&
        candidate.projection.requestedTargets.includes("claude"),
    )
    .map((candidate) => candidate.id);
  const catalog = mcpServers(
    "project",
    scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir }),
  );
  const expected = managedMcpAllowlistSettings(
    Object.fromEntries(
      activeIds.flatMap((id) => (catalog[id] === undefined ? [] : [[id, catalog[id]]])),
    ),
  );
  const state = managedMcpProjectionState(ctx.root);
  const prior = managedMcpProjectionOnDisk(ctx.root);
  const bindingState =
    state.state === "clean" && prior !== undefined
      ? decisionReceiptState(prior.ownership, effective, "mcp", "claude")
      : undefined;
  if (bindingState !== undefined) {
    return {
      state: bindingState,
      detail:
        bindingState === "upgrade-required"
          ? "legacy v1 managed-MCP receipt and owned settings require a strict v2 receipt refresh"
          : "managed-MCP receipt and owned settings retain a decision binding that is no longer current; policy project must refresh or remove it",
    };
  }
  if (activeIds.length === 0) {
    if (state.state === "clean" && prior !== undefined) {
      return {
        state: "retained",
        detail:
          "managed-MCP receipt and owned settings retain a prior governed selection; policy project must reconcile its removal",
      };
    }
    return state.state === "missing"
      ? { state: "not-requested", detail: "no effective managed-MCP control or ownership receipt" }
      : state;
  }
  if (
    state.state === "clean" &&
    prior !== undefined &&
    stableJson(prior.ownership.expected) !== stableJson(expected)
  ) {
    return {
      state: "retained",
      detail:
        "managed-MCP receipt and owned settings retain a different governed selection; policy project must reconcile the requested selection",
    };
  }
  return state;
}

/** Read-only Kiro workspace-MCP ownership/drift state for policy report and doctor. */
export function orgPolicyKiroMcpReceiptState(
  ctx: PlanContext,
  effective: EffectiveOrgPolicy,
): {
  state:
    | "not-requested"
    | "clean"
    | "retained"
    | "retained-invalid-decision"
    | "upgrade-required"
    | "absent"
    | "altered"
    | "missing"
    | "unsafe-path"
    | "revoked"
    | "malformed";
  detail: string;
} {
  const activeIds = effective.candidates
    .filter(
      (candidate) =>
        candidate.effective &&
        isProjectionSurfaceCandidate(candidate, "mcp") &&
        candidate.projection.requestedTargets.includes("kiro"),
    )
    .map((candidate) => candidate.id);
  const catalog = mcpServers(
    "project",
    scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir }),
  );
  const expected = kiroMcpProjectionExpected(
    Object.fromEntries(
      activeIds.flatMap((id) => {
        const server = catalog[id];
        return server?.type === "stdio" ? [[id, server] as const] : [];
      }),
    ),
  );
  const state = kiroMcpProjectionState(ctx.root);
  const prior = kiroMcpProjectionOnDisk(ctx.root);
  const bindingState =
    state.state === "clean" && prior !== undefined
      ? decisionReceiptState(prior.ownership, effective, "mcp", "kiro")
      : undefined;
  if (bindingState !== undefined) {
    return {
      state: bindingState,
      detail:
        bindingState === "upgrade-required"
          ? "legacy v1 Kiro workspace-MCP receipt and owned entries require a strict v2 receipt refresh"
          : "Kiro workspace-MCP receipt and owned entries retain a decision binding that is no longer current; policy project must refresh or remove it",
    };
  }
  if (activeIds.length === 0) {
    return state.state === "clean" && prior !== undefined
      ? {
          state: "retained",
          detail:
            "Kiro workspace-MCP receipt retains a prior governed selection; policy project must reconcile its removal",
        }
      : state.state === "absent"
        ? {
            state: "not-requested",
            detail: "no effective Kiro workspace-MCP control or ownership receipt",
          }
        : state;
  }
  if (
    state.state === "clean" &&
    prior !== undefined &&
    stableJson(prior.ownership.expected) !== stableJson(expected)
  ) {
    return {
      state: "retained",
      detail:
        "Kiro workspace-MCP receipt retains a different governed selection; policy project must reconcile the requested selection",
    };
  }
  return state;
}

/**
 * Does the usage-hook ownership receipt already own hook entries at this path?
 *
 * Ownership outlives a single plan. The projector skips its own write while its
 * receipt is active, so asking only what it emits this run mistakes an
 * idempotent skip for an absent owner.
 */
function usageHookReceiptOwnsPath(ctx: PlanContext, path: string): boolean {
  const { receipt } = parseHookReceipt(ctx);
  return (receipt?.entries ?? []).some(
    (entry) => entry.kind === "json-hook" && entry.path === path,
  );
}

function hookReceiptAction(
  raw: string | undefined,
  policyVersion: string | undefined,
  hooks: PolicyHookReceipt["hooks"],
  entries: PolicyHookReceiptEntry[],
  decisions: McpProjectionDecisionBindings,
): Action {
  const payload = hookReceiptPayload(policyVersion, hooks, entries, decisions);
  return withExpectedContents(
    writeJson(
      ORG_POLICY_HOOK_RECEIPT_PATH,
      { ...payload, selfDigest: hookReceiptSelfDigest(payload) },
      "record AIH-owned policy hook receipt for conservative rollback",
    ),
    raw,
  );
}

function usageHookProjectionActions(ctx: PlanContext, effective: EffectiveOrgPolicy): Action[] {
  const currentTargets = new Set(ctx.targets ?? ["claude"]);
  const targets = [
    ...new Set(
      effective.candidates.flatMap((candidate) =>
        candidate.effective &&
        candidate.kind === "hook" &&
        candidate.source.type === "hook" &&
        candidate.source.handler === "usage-metering"
          ? candidate.projection.requestedTargets.filter(
              (target): target is "claude" | "codex" =>
                (target === "claude" || target === "codex") && currentTargets.has(target),
            )
          : [],
      ),
    ),
  ];
  if (targets.length === 0) return hookDeactivationActions(ctx);
  const existing = parseHookReceipt(ctx);
  const hooks = usageHookIdentities(effective, currentTargets);
  const decisions = decisionBindingsFor(effective, "usage-hook", currentTargets);
  if (existing.receipt !== undefined) {
    if (stableJson(existing.receipt.hooks) === stableJson(hooks)) {
      const ownershipIssue = usageArtifactOwnershipIssue(ctx, existing.receipt);
      if (ownershipIssue !== undefined) {
        throw new OrgPolicyError(
          `${ORG_POLICY_HOOK_RECEIPT_PATH} cannot refresh projection: ${ownershipIssue}`,
        );
      }
      if (
        existing.receipt.version === 3 &&
        stableJson(existing.receipt.decisions) === stableJson(decisions) &&
        existing.receipt.policyVersion === effective.policyVersion
      ) {
        return [];
      }
      // A legacy v2 or a changed decision binding refreshes only the receipt;
      // the exact, receipt-owned host artifacts remain untouched.
      return [
        hookReceiptAction(
          existing.raw,
          effective.policyVersion,
          hooks,
          existing.receipt.entries,
          decisions,
        ),
      ];
    }
    throw new OrgPolicyError(
      `${ORG_POLICY_HOOK_RECEIPT_PATH} owns a different hook selection; deactivate it first`,
    );
  }

  const unowned = usageArtifactOwnershipIssue(ctx);
  if (unowned !== undefined) {
    throw new OrgPolicyError(
      `policy hook projection found ${unowned}; AIH will not adopt or overwrite legacy usage artifacts—remove or migrate them manually first`,
    );
  }

  const hostActions: Action[] = [];
  const entries: PolicyHookReceiptEntry[] = [];
  for (const target of targets) {
    const expected = expectedHostHook(ctx, target);
    const raw = ownedText(ctx, expected.path);
    const slot = readHookSlot(raw, expected.path);
    if (slot.postToolUse !== undefined) {
      // Reached before the two-writers plan-shape gate can name the conflict,
      // because that gate needs this projector's actions computed first. When
      // the registrar's receipt claims the slot, say so — "already has
      // PostToolUse hooks" reads as operator-owned legacy and misdirects.
      const claimed =
        expected.path === HOOK_REGISTRAR_DESTINATION
          ? hookRegistrarClaimedPostToolUse(ctx)
          : undefined;
      // The settling run needs the usage selection OFF too: this throw happens
      // while the usage actions are being planned, before the registrar's
      // revocation can ever be reached, so "drop the registrations" alone
      // re-refuses right here on the next run.
      throw new OrgPolicyError(
        claimed !== undefined && stableJson(claimed) === stableJson(slot.postToolUse)
          ? `${expected.path} PostToolUse is owned by the hook registrar receipt; a usage-metering ` +
              "activation and hook registrations cannot both own it — drop the hook registrations " +
              "and deactivate the usage-metering selection, project once so the registrar's " +
              "receipt is revoked, then activate usage metering"
          : `${expected.path} already has PostToolUse hooks; refusing ownership conflict`,
      );
    }
    const generated = usageHookActions(ctx, [target]).find(
      (action): action is Extract<Action, { kind: "write" }> =>
        action.kind === "write" && action.path === expected.path,
    );
    if (generated === undefined)
      throw new OrgPolicyError(`AIH has no safe hook action for ${target}`);
    hostActions.push(withExpectedContents(generated, raw));
    entries.push({
      kind: "json-hook",
      path: expected.path,
      preExisting: slot.filePresent ? "present" : "absent",
      hooksPresent: slot.hooksPresent,
      expectedPostToolUse: expected.postToolUse,
    });
  }
  const recorder = ownedText(ctx, ".aih/usage-record.mjs");
  const ignore = ownedText(ctx, ".gitignore");
  if (recorder !== undefined)
    throw new OrgPolicyError(
      "policy hook recorder already exists without a policy ownership receipt",
    );
  if (!canAppendPolicyAihIgnore(ignore)) {
    throw new OrgPolicyError(
      ".gitignore contains AIH-shaped rules with ambiguous policy-hook ownership",
    );
  }
  const recorderContents = usageRecorderScript();
  const ignoreAction = policyAihIgnoreWrite(ctx.root);
  entries.push(
    {
      kind: "text-file",
      path: ".aih/usage-record.mjs",
      preExisting: "absent",
      expectedDigest: sha256(recorderContents),
    },
    {
      kind: "text-file",
      path: ".gitignore",
      preExisting: ignore === undefined ? "absent" : "present",
      expectedDigest: sha256(ignoreAction.contents ?? ""),
    },
  );
  return [
    withExpectedContents(
      writeText(
        ".aih/usage-record.mjs",
        recorderContents,
        "AIH-owned usage hook recorder selected by org policy",
        { mode: 0o755 },
      ),
      recorder,
    ),
    withExpectedContents(ignoreAction, ignore),
    ...hostActions,
    hookReceiptAction(existing.raw, effective.policyVersion, hooks, entries, decisions),
  ];
}

function managedSettings(
  policy: OrgPolicy,
  runtime: RuntimeOrgPolicyResolution,
): {
  settings: Record<string, unknown>;
  managedMcp: Record<string, unknown>;
  managedMcpEnabled: boolean;
  managedMcpSettings: ReturnType<typeof managedMcpAllowlistSettings>;
  effective: EffectiveOrgPolicy;
} {
  const composed = composeOrgPolicy(policy);
  const selected = stdioAllowedServers(
    policy,
    runtime,
    composed.mcp.allowedServers,
    composed.mcp.disabledServers,
    composed.mcp.allowManagedOnly,
  );
  const stdio = selected.servers;
  const settings: Record<string, unknown> = {
    organizationPolicy: {
      minimumPosture: composed.minimumPosture,
      references: composed.references,
      ...(selected.effective.policyVersion === undefined
        ? {}
        : {
            effectiveCandidates: selected.effective.candidates.map((candidate) => ({
              id: candidate.id,
              requested: candidate.requested,
              effective: candidate.effective,
              sourceDigest: candidate.sourceDigest,
              evidence: candidate.evidence,
              evidenceRecord: candidate.evidenceRecord,
              ...(candidate.approval === undefined ? {} : { approval: candidate.approval }),
              ...(candidate.decision === undefined
                ? {}
                : {
                    // Managed settings are a public operator surface. Keep only
                    // status/identity facts; the canonical decision digest binds
                    // any private conditions in the external authority receipt.
                    decision: publicDecisionView(candidate.decision),
                  }),
              dangerCodes: candidate.dangerCodes,
              blockingCodes: candidate.blockingCodes,
              decisionBlockers: candidate.decisionBlockers,
              ...(candidate.clarification === undefined
                ? {}
                : { clarification: candidate.clarification }),
              ...(candidate.annotation === undefined ? {} : { annotation: candidate.annotation }),
              projection: candidate.projection,
            })),
          }),
    },
    sandbox: {
      commandPolicy: commandPolicyFor(composed),
    },
  };
  const managedMcpSettings = managedMcpAllowlistSettings(stdio);
  if (composed.mcp.allowManagedOnly) Object.assign(settings, managedMcpSettings);
  return {
    settings,
    managedMcp: managedMcpExample(stdio),
    managedMcpEnabled: composed.mcp.allowManagedOnly,
    managedMcpSettings,
    effective: selected.effective,
  };
}

function projectionActionsFromRuntime(
  ctx: PlanContext,
  policy: OrgPolicy,
  runtime: RuntimeOrgPolicyResolution,
): Action[] {
  const posture = ctx.posture ?? policy.minimumPosture;
  const targets = ctx.targets ?? ["claude"];
  if (runtime.effective.blocking) {
    const blocked = blockedProjectionDetail(runtime.effective);
    throw new OrgPolicyError(
      `policy project refuses blocked candidate activation(s): ${blocked || "unknown policy resolution failure"}${authoritySuffix(runtime)}`,
    );
  }
  if (posture === "vibe") return [];
  const actions: Action[] = [];
  const mcpSettings = targets.includes("claude") ? managedSettings(policy, runtime) : undefined;
  if (targets.includes("claude")) {
    const { settings, managedMcp, managedMcpEnabled, managedMcpSettings } =
      mcpSettings ?? managedSettings(policy, runtime);
    const onDisk = managedMcpProjectionOnDisk(ctx.root);
    if (onDisk?.unprovable === "not-a-regular-file") {
      throw new OrgPolicyError(
        `policy project refuses unsafe managed-MCP ownership path: ${unprovableResidueReason(onDisk.unprovable)}`,
      );
    }
    if (managedMcpEnabled && onDisk?.unprovable === "pair-drifted") {
      throw new OrgPolicyError(
        `policy project refuses managed-MCP ownership conflict: ${unprovableResidueReason(onDisk.unprovable)}`,
      );
    }
    const owned = managedMcpEnabled
      ? managedMcpProjectionOwnershipAction(
          ctx,
          ["claude"],
          managedMcpSettings,
          decisionBindingsFor(runtime.effective, "mcp", "claude"),
        )
      : undefined;
    // The deactivation branch reuses the shared managed-MCP lifecycle
    // (`src/mcp/managed-projection.ts`), but folds the key subtraction into the
    // managed-settings write this projection already emits — the executor collapses
    // repeated writes to one path, so a second write action would be dropped.
    // The apply-time pin comes from a regular-file, no-follow read — never a plain
    // content read, which throws EISDIR on a directory planted at the projected path
    // and would take the whole projection down before it could plan anything.
    // Once an active ownership record is present, its safe no-follow read is
    // authoritative. Never fall back to a path read that could launder bytes
    // through a symlinked/occupied managed-settings path.
    const settingsSource =
      onDisk === undefined ? readManagedSettings(ctx.root) : onDisk.settingsSource;
    const strictLegacyMarkerRefresh =
      managedMcpEnabled &&
      onDisk?.matches === true &&
      onDisk.ownership.schemaVersion === 1 &&
      stableJson(onDisk.ownership.expected) === stableJson(managedMcpSettings) &&
      settingsSource !== undefined &&
      (() => {
        try {
          return stableJson(JSON.parse(settingsSource)) === stableJson(settings);
        } catch {
          return false;
        }
      })();
    if (!strictLegacyMarkerRefresh) {
      actions.push(
        withExpectedContents(
          writeJson(
            MANAGED_SETTINGS_PATH,
            settings,
            "project managed-settings compiled from aih-org-policy.json",
            {
              merge: true,
              replaceJsonKeys: managedMcpEnabled ? [...MANAGED_MCP_PROJECTION_KEYS] : undefined,
              replaceJsonChildKeys: {
                organizationPolicy: ["minimumPosture", "references", "effectiveCandidates"],
                sandbox: ["commandPolicy"],
              },
              // Only subtract the managed keys when the governed selection is
              // being deactivated. An already clean active projection must keep
              // its exact replacement keys, or a later doctor plan would claim
              // the same owned settings should be absent.
              removeJsonTopLevelKeys:
                !managedMcpEnabled && onDisk?.matches
                  ? [...MANAGED_MCP_PROJECTION_KEYS]
                  : undefined,
            },
          ),
          settingsSource,
        ),
      );
    }
    if (owned !== undefined) actions.push(owned);
    else if (onDisk !== undefined) {
      actions.push(
        onDisk.matches
          ? clearManagedMcpProjectionOwnershipAction(onDisk.markerSource)
          : revokeManagedMcpProjectionOwnershipAction(onDisk.ownership, onDisk.markerSource),
      );
    }
    if (posture === "enterprise") {
      actions.push(
        writeJson(
          "managed-settings.json.example",
          settings,
          "org admin: system-path managed-settings.json example compiled from aih-org-policy.json",
        ),
        writeJson(
          "managed-mcp.json.example",
          managedMcp,
          "org admin: system-path managed-mcp.json example compiled from aih-org-policy.json",
        ),
      );
    }
  }
  if (targets.includes("kiro")) {
    const selectedIds = runtime.effective.candidates
      .filter(
        (candidate) =>
          candidate.effective &&
          isProjectionSurfaceCandidate(candidate, "mcp") &&
          candidate.projection.requestedTargets.includes("kiro"),
      )
      .map((candidate) => candidate.id);
    const selected = Object.fromEntries(
      selectedIds.flatMap((id) => {
        const server = runtime.catalog[id];
        return server?.type === "stdio" ? [[id, server] as const] : [];
      }),
    );
    // No Kiro activation and no Kiro receipt is a true no-op. In particular it
    // must never turn a Claude-only governed policy into a Kiro projection.
    if (selectedIds.length > 0 || kiroMcpProjectionOnDisk(ctx.root) !== undefined) {
      actions.push(
        ...kiroMcpProjectionActions(
          ctx,
          selected,
          decisionBindingsFor(runtime.effective, "mcp", "kiro"),
        ),
      );
    }
  }
  // Legacy org policies retain the established generic usage lifecycle. Only a
  // governed inventory owns hook activation and conservative rollback; running
  // that lifecycle for a legacy policy would mistake its generic recorder for
  // an unreceipted governed artifact.
  if (governanceOwnsAihSurfaces(policy)) {
    const usage = usageHookProjectionActions(ctx, runtime.effective);
    actions.push(...usage);
    if (targets.includes("claude")) {
      // G4: the hook registrar is reachable through the verified projector. A
      // policy declaring registrations gets the registrar's projection; one
      // declaring none gets its revocation (a no-op without a receipt).
      const controls = planEccHookControlsProjection(ctx, policy.governance.eccHookControls);
      const registrar = hookRegistrarProjectionActions(ctx, policy.governance.hookRegistrations, {
        policyVersion: policy.governance.policyVersion,
        envPatch: controls.envPatch,
        destinationRead: controls.destinationRead,
      });
      const touchesDestination = (planned: readonly Action[]) =>
        planned.some((action) => "path" in action && action.path === HOOK_REGISTRAR_DESTINATION);
      // Two independent ways the usage-hook side lays claim to this
      // destination, and either one blocks the registrar:
      //
      //  - OWNERSHIP. An active usage-hook receipt keeps that projector's entry
      //    on disk on every later run, including runs where it emits nothing.
      //    The registrar's whole-key write would rewrite that entry, leaving it
      //    claimed by two receipts with the usage receipt no longer matching.
      //  - PLAN SHAPE. Both projectors emitting a write in one plan. Still
      //    load-bearing on its own: on the first-ever projection no receipt
      //    exists yet, so ownership is silent and only this catches it. The
      //    executor collapses repeated writes to one path, dropping an owner's
      //    entries.
      const usageOwnsDestination = usageHookReceiptOwnsPath(ctx, HOOK_REGISTRAR_DESTINATION);
      const registrarTouchesDestination = touchesDestination(registrar);
      const controlsWriteStandalone =
        !registrarTouchesDestination && controls.standaloneSettingsAction !== undefined;
      if ((usageOwnsDestination || touchesDestination(usage)) && controlsWriteStandalone) {
        throw new OrgPolicyError(
          `policy project refuses two hook writers into ${HOOK_REGISTRAR_DESTINATION}: the ` +
            "usage-hook projector and ECC hook controls cannot both own it; deactivate the " +
            "usage-hook selection or remove eccHookControls before projecting",
        );
      }
      if ((usageOwnsDestination || touchesDestination(usage)) && registrarTouchesDestination) {
        // Branch-specific, because the remedies differ. Once the usage receipt
        // owns the destination, "deactivate the usage-hook selection" does NOT
        // clear the refusal: deactivation itself emits a write, so it re-refuses
        // through the plan-shape half. The registrations have to come out for
        // one projection so the usage-hook side can settle first.
        throw new OrgPolicyError(
          `policy project refuses two hook writers into ${HOOK_REGISTRAR_DESTINATION}: the ` +
            "usage-hook projector and the hook registrar " +
            (usageOwnsDestination
              ? `cannot both own it — ${ORG_POLICY_HOOK_RECEIPT_PATH} already owns hook entries ` +
                "there; drop the hook registrations and project once so the usage-hook receipt " +
                "settles or is subtracted, then declare them again"
              : "both emit writes for it in this projection; deactivate the usage-hook selection " +
                "or drop the hook registrations before projecting"),
        );
      }
      if (registrarTouchesDestination) {
        actions.push(...registrar, ...controls.receiptActions);
      } else {
        if (controls.standaloneSettingsAction !== undefined) {
          actions.push(controls.standaloneSettingsAction);
        }
        actions.push(...controls.receiptActions, ...registrar);
      }
    }
  }
  return coalesceMcpProjectionMarkerActions(actions);
}

/** Governed projection: authority is verified before any policy-selected action is emitted. */
export async function verifiedOrgPolicyProjectionActions(
  ctx: PlanContext,
  policy: OrgPolicy,
): Promise<Action[]> {
  return projectionActionsFromRuntime(ctx, policy, await resolveRuntimeOrgPolicy(ctx, policy));
}

/**
 * Legacy internal projection seam retained for pre-governance callers/tests.
 * It refuses governance inventories so a synchronous caller cannot accidentally
 * bypass external authority verification.
 */
export function orgPolicyProjectionActions(ctx: PlanContext, policy: OrgPolicy): Action[] {
  if (governanceOwnsAihSurfaces(policy)) {
    throw new OrgPolicyError(
      "governed policy projection requires externally verified authority; use the verified policy projector",
    );
  }
  const catalog = mcpServers(
    "project",
    scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir }),
  );
  const effective = resolveEffectiveOrgPolicy(policy, {
    targets: ctx.targets ?? ["claude"],
    mcpIdentities: Object.fromEntries(
      Object.entries(catalog).map(([name, server]) => [
        name,
        {
          subject: mcpApprovalSubject(server),
          projectable: server.type === "stdio",
          kiroProjectable: server.type === "stdio",
        },
      ]),
    ),
  });
  return projectionActionsFromRuntime(ctx, policy, {
    catalog: catalog as Record<string, McpServer>,
    effective,
  });
}
