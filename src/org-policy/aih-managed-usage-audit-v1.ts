import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { canonicalStrictJsonBytesV1, parseStrictJsonObjectV1 } from "../contract/strict-json-v1.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import { policyAihIgnoreRollbackContents } from "../internals/gitignore.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";
import type { PlanContext } from "../internals/plan.js";
import { usageRecorderScript } from "../usage/capture.js";
import { verifyPolicyAuthorityReceipt } from "./authority.js";
import {
  governanceDecisionDigestV2,
  governanceDecisionRevocationDigestV2,
} from "./governance-decision-v2.js";
import {
  type AihManagedUsageOwnershipSnapshotV4,
  aihManagedUsageExpectedHostHookV4,
  aihManagedUsageOwnershipIsCodeDerivedV4,
} from "./project.js";

export const AIH_MANAGED_USAGE_RECEIPT_V4_PATH = ".aih/org-policy-hook-receipt.json";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type AihManagedUsageReceiptStateV4 = "claimed" | "configured" | "revoking" | "revoked";

export interface AihManagedUsageDescriptorV4 {
  readonly adapter: { readonly id: string; readonly version: string; readonly digest: string };
  readonly effect: string;
  readonly subject: {
    readonly id: string;
    readonly kind: string;
    readonly source: unknown;
    readonly sourceDigest: string;
    readonly subjectDigest: string;
  };
}

export interface AihManagedUsageReceiptHistoryV4 {
  readonly adapter: { readonly id: string; readonly version: string; readonly digest: string };
  readonly authorityReceiptDigest: string;
  readonly decision: { readonly id: string; readonly digest: string };
  readonly digest: string;
  readonly outputs: readonly { readonly path: string; readonly sha256: string }[];
  readonly previousDigest?: string;
  readonly qualification: {
    readonly attestor: string;
    readonly evidenceDigest: string;
    readonly record: string;
  };
  readonly revocationDigest?: string;
  readonly state: AihManagedUsageReceiptStateV4;
}

export interface AihManagedUsageReceiptRevocationV4 {
  readonly digest: string;
  readonly issuer: string;
  readonly revokedAt: string;
}

export interface AuthorizedAihManagedUsageRevocationV1 {
  readonly authorityReceiptDigest: string;
  readonly revocation: AihManagedUsageReceiptRevocationV4;
}

export interface AihManagedUsageReceiptV4 {
  readonly adapter: { readonly id: string; readonly version: string; readonly digest: string };
  readonly authorityReceiptDigest: string;
  readonly decision: { readonly id: string; readonly digest: string };
  readonly effect: string;
  readonly format: string;
  readonly history: readonly AihManagedUsageReceiptHistoryV4[];
  readonly outputs: readonly { readonly path: string; readonly sha256: string }[];
  readonly ownership: AihManagedUsageOwnershipSnapshotV4;
  readonly qualification: {
    readonly attestor: string;
    readonly evidenceDigest: string;
    readonly record: string;
  };
  readonly revocation: AihManagedUsageReceiptRevocationV4 | null;
  readonly state: AihManagedUsageReceiptStateV4;
  readonly subject: AihManagedUsageDescriptorV4["subject"];
  readonly target: "claude" | "codex";
  readonly version: number;
}

export function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalDigest(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(domain, "utf8").update(canonicalStrictJsonBytesV1(value)).digest("hex")}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function receiptHasSymlinkParent(root: string): boolean {
  try {
    const rootInfo = lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return true;
  } catch {
    return true;
  }
  let current = root;
  for (const segment of AIH_MANAGED_USAGE_RECEIPT_V4_PATH.split("/").slice(0, -1)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function safeRegularBytes(root: string, path: string, maxBytes: number): Buffer | undefined {
  if (receiptHasSymlinkParent(root)) return undefined;
  let parent = root;
  for (const segment of path.split("/").slice(0, -1)) {
    parent = join(parent, segment);
    try {
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }
  }
  const opened = readRegularFileWithStats(join(root, path), { maxBytes });
  return opened === undefined || opened.identity.nlink !== 1n ? undefined : opened.contents;
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function outputPaths(target: "claude" | "codex"): string[] {
  return [
    ".aih/usage-record.mjs",
    ".gitignore",
    target === "claude" ? ".claude/settings.json" : ".codex/hooks.json",
  ].sort();
}

function isOutput(value: unknown): value is { path: string; sha256: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    exactKeys(value as Record<string, unknown>, ["path", "sha256"]) &&
    typeof (value as Record<string, unknown>).path === "string" &&
    typeof (value as Record<string, unknown>).sha256 === "string" &&
    SHA256.test((value as Record<string, unknown>).sha256 as string)
  );
}

function validOwnership(value: unknown, target: "claude" | "codex"): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = (value as Record<string, unknown>).entries;
  if (!Array.isArray(entries) || entries.length !== 3) return false;
  if (
    !entries.every(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof entry.path === "string",
    ) ||
    !entries.every((entry, index) => {
      const path = entry.path as string;
      return index === 0 || ((entries[index - 1] as Record<string, unknown>).path as string) < path;
    })
  )
    return false;
  const hostPath = target === "claude" ? ".claude/settings.json" : ".codex/hooks.json";
  const byPath = new Map(
    entries
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
      .map((entry) => [entry.path, entry]),
  );
  if (byPath.size !== 3) return false;
  const host = byPath.get(hostPath);
  const recorder = byPath.get(".aih/usage-record.mjs");
  const ignore = byPath.get(".gitignore");
  return (
    host !== undefined &&
    exactKeys(host, ["expectedPostToolUse", "hooksPresent", "kind", "path", "preExisting"]) &&
    host.kind === "json-hook" &&
    host.path === hostPath &&
    (host.preExisting === "absent" || host.preExisting === "present") &&
    typeof host.hooksPresent === "boolean" &&
    host.expectedPostToolUse !== undefined &&
    recorder !== undefined &&
    exactKeys(recorder, ["expectedDigest", "kind", "path", "preExisting"]) &&
    recorder.kind === "text-file" &&
    recorder.path === ".aih/usage-record.mjs" &&
    recorder.preExisting === "absent" &&
    typeof recorder.expectedDigest === "string" &&
    SHA256.test(`sha256:${recorder.expectedDigest}`) &&
    recorder.expectedDigest === sha256(usageRecorderScript()).slice("sha256:".length) &&
    ignore !== undefined &&
    exactKeys(ignore, ["expectedDigest", "kind", "path", "preExisting"]) &&
    ignore.kind === "text-file" &&
    ignore.path === ".gitignore" &&
    (ignore.preExisting === "absent" || ignore.preExisting === "present") &&
    typeof ignore.expectedDigest === "string" &&
    SHA256.test(`sha256:${ignore.expectedDigest}`)
  );
}

function validHistory(
  value: unknown,
  state: AihManagedUsageReceiptStateV4,
): value is AihManagedUsageReceiptHistoryV4[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return false;
  const ordinal = ["claimed", "configured", "revoking", "revoked"] as const;
  let previous = -1;
  for (const [index, event] of value.entries()) {
    if (typeof event !== "object" || event === null || Array.isArray(event)) return false;
    const record = event as Record<string, unknown>;
    const revocationDigest = record.revocationDigest;
    if (
      !exactKeys(record, [
        "adapter",
        "authorityReceiptDigest",
        "decision",
        "digest",
        "outputs",
        ...(typeof record.previousDigest === "string" ? ["previousDigest"] : []),
        "qualification",
        ...(typeof revocationDigest === "string" ? ["revocationDigest"] : []),
        "state",
      ]) ||
      typeof record.authorityReceiptDigest !== "string" ||
      !SHA256.test(record.authorityReceiptDigest) ||
      typeof record.digest !== "string" ||
      !SHA256.test(record.digest) ||
      (index > 0 &&
        record.previousDigest !== (value[index - 1] as AihManagedUsageReceiptHistoryV4).digest) ||
      (index === 0 &&
        record.previousDigest !== undefined &&
        (typeof record.previousDigest !== "string" || !SHA256.test(record.previousDigest))) ||
      !isHistoryBinding(record) ||
      !ordinal.includes(record.state as AihManagedUsageReceiptStateV4) ||
      (record.state === "revoking" || record.state === "revoked") !==
        (typeof revocationDigest === "string") ||
      (typeof revocationDigest === "string" && !SHA256.test(revocationDigest))
    )
      return false;
    const payload = {
      adapter: record.adapter,
      authorityReceiptDigest: record.authorityReceiptDigest,
      decision: record.decision,
      outputs: record.outputs,
      ...(typeof record.previousDigest === "string"
        ? { previousDigest: record.previousDigest }
        : {}),
      qualification: record.qualification,
      ...(typeof revocationDigest === "string" ? { revocationDigest } : {}),
      state: record.state,
    };
    if (record.digest !== canonicalDigest("aih-org-policy-hook-receipt-history/v4\0", payload))
      return false;
    const phaseIndex = ordinal.indexOf(record.state as AihManagedUsageReceiptStateV4);
    if (phaseIndex < previous) return false;
    previous = phaseIndex;
  }
  return value[value.length - 1]?.state === state;
}

/** The terminal audit event is a second, bounded binding of the live receipt. */
function latestHistoryMatchesReceipt(value: Record<string, unknown>): boolean {
  const history = value.history;
  if (!Array.isArray(history) || history.length === 0) return false;
  const latest = history.at(-1) as Record<string, unknown>;
  const same = (left: unknown, right: unknown) =>
    canonicalStrictJsonBytesV1(left).compare(canonicalStrictJsonBytesV1(right)) === 0;
  const revocation = value.revocation as Record<string, unknown> | null;
  return (
    same(latest.adapter, value.adapter) &&
    latest.authorityReceiptDigest === value.authorityReceiptDigest &&
    same(latest.decision, value.decision) &&
    same(latest.qualification, value.qualification) &&
    same(latest.outputs, value.outputs) &&
    latest.state === value.state &&
    (revocation === null
      ? latest.revocationDigest === undefined
      : latest.revocationDigest === revocation.digest)
  );
}

function isHistoryBinding(value: Record<string, unknown>): boolean {
  const adapter = value.adapter;
  const decision = value.decision;
  const qualification = value.qualification;
  const outputs = value.outputs;
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    !Array.isArray(adapter) &&
    exactKeys(adapter as Record<string, unknown>, ["digest", "id", "version"]) &&
    typeof (adapter as Record<string, unknown>).id === "string" &&
    SAFE_ID.test((adapter as Record<string, unknown>).id as string) &&
    typeof (adapter as Record<string, unknown>).version === "string" &&
    typeof (adapter as Record<string, unknown>).digest === "string" &&
    SHA256.test((adapter as Record<string, unknown>).digest as string) &&
    typeof decision === "object" &&
    decision !== null &&
    !Array.isArray(decision) &&
    exactKeys(decision as Record<string, unknown>, ["digest", "id"]) &&
    typeof (decision as Record<string, unknown>).id === "string" &&
    SAFE_ID.test((decision as Record<string, unknown>).id as string) &&
    typeof (decision as Record<string, unknown>).digest === "string" &&
    SHA256.test((decision as Record<string, unknown>).digest as string) &&
    typeof qualification === "object" &&
    qualification !== null &&
    !Array.isArray(qualification) &&
    exactKeys(qualification as Record<string, unknown>, ["attestor", "evidenceDigest", "record"]) &&
    typeof (qualification as Record<string, unknown>).attestor === "string" &&
    SAFE_ID.test((qualification as Record<string, unknown>).attestor as string) &&
    typeof (qualification as Record<string, unknown>).record === "string" &&
    SAFE_ID.test((qualification as Record<string, unknown>).record as string) &&
    typeof (qualification as Record<string, unknown>).evidenceDigest === "string" &&
    SHA256.test((qualification as Record<string, unknown>).evidenceDigest as string) &&
    Array.isArray(outputs) &&
    outputs.every(isOutput) &&
    outputs.every(
      (output, index) => index === 0 || (outputs[index - 1] as { path: string }).path < output.path,
    )
  );
}

function validRevocation(
  value: unknown,
  state: AihManagedUsageReceiptStateV4,
): value is AihManagedUsageReceiptRevocationV4 | null {
  if (state === "claimed" || state === "configured") return value === null;
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    exactKeys(value as Record<string, unknown>, ["digest", "issuer", "revokedAt"]) &&
    typeof (value as Record<string, unknown>).digest === "string" &&
    SHA256.test((value as Record<string, unknown>).digest as string) &&
    typeof (value as Record<string, unknown>).issuer === "string" &&
    SAFE_ID.test((value as Record<string, unknown>).issuer as string) &&
    typeof (value as Record<string, unknown>).revokedAt === "string" &&
    UTC_MILLIS.test((value as Record<string, unknown>).revokedAt as string) &&
    Number.isFinite(Date.parse((value as Record<string, unknown>).revokedAt as string)) &&
    new Date(Date.parse((value as Record<string, unknown>).revokedAt as string)).toISOString() ===
      (value as Record<string, unknown>).revokedAt
  );
}

export function receiptPayloadV4(input: {
  readonly authorityReceiptDigest: string;
  readonly descriptor: AihManagedUsageDescriptorV4;
  readonly qualification: AihManagedUsageReceiptV4["qualification"];
  readonly request: {
    readonly decision: string;
    readonly digest: string;
    readonly target: "claude" | "codex";
  };
  readonly state: AihManagedUsageReceiptStateV4;
  readonly ownership: AihManagedUsageOwnershipSnapshotV4;
  readonly outputs?: readonly { path: string; sha256: string }[];
  readonly prior?: AihManagedUsageReceiptV4;
  readonly revocation?: AihManagedUsageReceiptRevocationV4;
}): Record<string, unknown> {
  const outputs = [...(input.outputs ?? [])].sort((left, right) =>
    ordinalCompare(left.path, right.path),
  );
  const eventPayload = {
    adapter: input.descriptor.adapter,
    authorityReceiptDigest: input.authorityReceiptDigest,
    decision: { digest: input.request.digest, id: input.request.decision },
    outputs,
    ...(input.prior?.history.at(-1) === undefined
      ? {}
      : { previousDigest: input.prior.history.at(-1)?.digest }),
    qualification: input.qualification,
    ...(input.revocation === undefined ? {} : { revocationDigest: input.revocation.digest }),
    state: input.state,
  };
  const history = [
    ...(input.prior?.history ?? []),
    {
      ...eventPayload,
      digest: canonicalDigest("aih-org-policy-hook-receipt-history/v4\0", eventPayload),
    },
  ].slice(-8);
  const payload = {
    adapter: input.descriptor.adapter,
    authorityReceiptDigest: input.authorityReceiptDigest,
    decision: { digest: input.request.digest, id: input.request.decision },
    effect: input.descriptor.effect,
    format: "aih-org-policy-hook-receipt",
    history,
    outputs,
    ownership: input.ownership,
    qualification: input.qualification,
    revocation: input.revocation ?? null,
    state: input.state,
    subject: input.descriptor.subject,
    target: input.request.target,
    version: 4,
  };
  return { ...payload, selfDigest: canonicalDigest("aih-org-policy-hook-receipt/v4\0", payload) };
}

export function receiptTextV4(payload: Record<string, unknown>): string {
  return canonicalStrictJsonBytesV1(payload).toString("utf8");
}

/** Current V3 attestation and immutable decision/revocation only; never qualification evidence. */
export async function resolveAihManagedUsageRevocationV1(
  ctx: PlanContext,
  receipt: AihManagedUsageReceiptV4,
): Promise<AuthorizedAihManagedUsageRevocationV1 | undefined> {
  const verified = await verifyPolicyAuthorityReceipt(ctx);
  if (verified.authority === undefined || verified.authority.receipt.version !== 3)
    return undefined;
  const decision = verified.authority.receipt.decisions.find(
    (candidate) =>
      candidate.id === receipt.decision.id &&
      governanceDecisionDigestV2(candidate) === receipt.decision.digest,
  );
  if (
    decision === undefined ||
    decision.subject.subjectDigest !== receipt.subject.subjectDigest ||
    !decision.targets.includes(receipt.target) ||
    !decision.allowedEffects.includes("configure")
  )
    return undefined;
  const raw = verified.authority.receipt.decisionRevocations.find(
    (candidate) =>
      candidate.decisionDigest === receipt.decision.digest &&
      candidate.issuer === decision.issuer &&
      Date.parse(candidate.revokedAt) <= Date.now(),
  );
  if (raw === undefined) return undefined;
  return {
    authorityReceiptDigest: verified.authority.receiptDigest,
    revocation: {
      digest: governanceDecisionRevocationDigestV2(raw),
      issuer: raw.issuer,
      revokedAt: raw.revokedAt,
    },
  };
}

export function sameAihManagedUsageRevocationV1(
  left: AihManagedUsageReceiptRevocationV4 | null,
  right: AihManagedUsageReceiptRevocationV4,
): boolean {
  return (
    left !== null &&
    left.digest === right.digest &&
    left.issuer === right.issuer &&
    left.revokedAt === right.revokedAt
  );
}

/** Strict byte-bounded V4 receipt parser; legacy V1-V3 receipts are never accepted here. */
export function parseAihManagedUsageReceiptV4(
  root: string,
  descriptor: AihManagedUsageDescriptorV4,
): { receipt: AihManagedUsageReceiptV4; digest: string; text: string } | undefined {
  if (receiptHasSymlinkParent(root)) return undefined;
  const bytes = safeRegularBytes(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH, 65_536);
  if (bytes === undefined) return undefined;
  try {
    const value = parseStrictJsonObjectV1(bytes.toString("utf8"), "AIH managed usage receipt");
    const outputs = value.outputs as unknown[];
    const target = value.target as "claude" | "codex";
    if (
      !exactKeys(value, [
        "adapter",
        "authorityReceiptDigest",
        "decision",
        "effect",
        "format",
        "history",
        "outputs",
        "ownership",
        "qualification",
        "revocation",
        "selfDigest",
        "state",
        "subject",
        "target",
        "version",
      ]) ||
      canonicalStrictJsonBytesV1(value).compare(bytes) !== 0 ||
      value.format !== "aih-org-policy-hook-receipt" ||
      value.version !== 4 ||
      (value.state !== "claimed" &&
        value.state !== "configured" &&
        value.state !== "revoking" &&
        value.state !== "revoked") ||
      typeof value.qualification !== "object" ||
      value.qualification === null ||
      Array.isArray(value.qualification) ||
      !exactKeys(value.qualification as Record<string, unknown>, [
        "attestor",
        "evidenceDigest",
        "record",
      ]) ||
      typeof (value.qualification as Record<string, unknown>).attestor !== "string" ||
      !SAFE_ID.test((value.qualification as Record<string, unknown>).attestor as string) ||
      typeof (value.qualification as Record<string, unknown>).record !== "string" ||
      !SAFE_ID.test((value.qualification as Record<string, unknown>).record as string) ||
      typeof (value.qualification as Record<string, unknown>).evidenceDigest !== "string" ||
      !SHA256.test((value.qualification as Record<string, unknown>).evidenceDigest as string) ||
      typeof value.selfDigest !== "string" ||
      !SHA256.test(value.selfDigest) ||
      typeof value.ownership !== "object" ||
      value.ownership === null ||
      Array.isArray(value.ownership) ||
      !exactKeys(value.ownership as Record<string, unknown>, ["entries"]) ||
      !validOwnership(value.ownership, target) ||
      !aihManagedUsageOwnershipIsCodeDerivedV4(
        target,
        value.ownership as AihManagedUsageOwnershipSnapshotV4,
      ) ||
      !validHistory(value.history, value.state as AihManagedUsageReceiptStateV4) ||
      !validRevocation(value.revocation, value.state as AihManagedUsageReceiptStateV4) ||
      !latestHistoryMatchesReceipt(value) ||
      (value.target !== "claude" && value.target !== "codex") ||
      typeof value.effect !== "string" ||
      typeof value.authorityReceiptDigest !== "string" ||
      !SHA256.test(value.authorityReceiptDigest) ||
      typeof value.adapter !== "object" ||
      value.adapter === null ||
      Array.isArray(value.adapter) ||
      !exactKeys(value.adapter as Record<string, unknown>, ["digest", "id", "version"]) ||
      typeof value.decision !== "object" ||
      value.decision === null ||
      Array.isArray(value.decision) ||
      !exactKeys(value.decision as Record<string, unknown>, ["digest", "id"]) ||
      typeof (value.decision as Record<string, unknown>).id !== "string" ||
      !SAFE_ID.test((value.decision as Record<string, unknown>).id as string) ||
      typeof (value.decision as Record<string, unknown>).digest !== "string" ||
      !SHA256.test((value.decision as Record<string, unknown>).digest as string) ||
      !Array.isArray(outputs) ||
      !outputs.every(isOutput) ||
      !outputs.every(
        (output, index) =>
          index === 0 || (outputs[index - 1] as { path: string }).path < output.path,
      ) ||
      (value.state === "claimed" && outputs.length !== 0) ||
      (value.state === "revoked" &&
        (outputs.length !== outputPaths(target).length ||
          outputs.some(
            (output, index) => isOutput(output) && output.path !== outputPaths(target)[index],
          ))) ||
      ((value.state === "configured" || value.state === "revoking") &&
        (outputs.length !== outputPaths(target).length ||
          outputs.some(
            (output, index) => isOutput(output) && output.path !== outputPaths(target)[index],
          )))
    )
      return undefined;
    const { selfDigest, ...unsigned } = value;
    if (
      selfDigest !== canonicalDigest("aih-org-policy-hook-receipt/v4\0", unsigned) ||
      canonicalStrictJsonBytesV1(value.adapter).compare(
        canonicalStrictJsonBytesV1(descriptor.adapter),
      ) !== 0 ||
      value.effect !== descriptor.effect ||
      canonicalStrictJsonBytesV1(value.subject).compare(
        canonicalStrictJsonBytesV1(descriptor.subject),
      ) !== 0
    )
      return undefined;
    return {
      receipt: value as unknown as AihManagedUsageReceiptV4,
      digest: sha256(bytes),
      text: bytes.toString("utf8"),
    };
  } catch {
    return undefined;
  }
}

export function configuredOutputsMatchV4(root: string, receipt: AihManagedUsageReceiptV4): boolean {
  if (receipt.state !== "configured" && receipt.state !== "revoking") return false;
  const outputs: { path: string; sha256: string }[] = [];
  for (const path of outputPaths(receipt.target)) {
    let parent = root;
    for (const segment of path.split("/").slice(0, -1)) {
      parent = join(parent, segment);
      try {
        if (lstatSync(parent).isSymbolicLink()) return false;
      } catch {
        return false;
      }
    }
    const contents = safeRegularBytes(root, path, 1_048_576);
    if (contents === undefined) return false;
    outputs.push({ path, sha256: sha256(contents) });
  }
  return (
    JSON.stringify(outputs) === JSON.stringify(receipt.outputs) &&
    configuredCodeOutputsPresentV4(root, receipt.target)
  );
}

function optionalSafeBytes(root: string, path: string): Buffer | null | undefined {
  const contents = safeRegularBytes(root, path, 1_048_576);
  if (contents !== undefined) return contents;
  try {
    lstatSync(join(root, path));
    return undefined;
  } catch {
    return null;
  }
}

function fixedHostPresent(target: "claude" | "codex", contents: Buffer): boolean | undefined {
  try {
    const root = parseJsoncText(contents.toString("utf8"));
    if (
      !isPlainObject(root) ||
      !isPlainObject(root.hooks) ||
      !Object.hasOwn(root.hooks, "PostToolUse")
    )
      return false;
    return (
      canonicalStrictJsonBytesV1(root.hooks.PostToolUse).compare(
        canonicalStrictJsonBytesV1(aihManagedUsageExpectedHostHookV4(target).postToolUse),
      ) === 0
    );
  } catch {
    return undefined;
  }
}

/** Code-derived configured semantics, never receipt-selected output digests. */
function configuredCodeOutputsPresentV4(root: string, target: "claude" | "codex"): boolean {
  const recorder = optionalSafeBytes(root, ".aih/usage-record.mjs");
  const ignore = optionalSafeBytes(root, ".gitignore");
  const host = optionalSafeBytes(root, aihManagedUsageExpectedHostHookV4(target).path);
  return (
    recorder !== null &&
    recorder !== undefined &&
    recorder.toString("utf8") === usageRecorderScript() &&
    ignore !== null &&
    ignore !== undefined &&
    policyAihIgnoreRollbackContents(ignore.toString("utf8")) !== undefined &&
    host !== null &&
    host !== undefined &&
    fixedHostPresent(target, host) === true
  );
}

export function outputDigestsV4(
  root: string,
  target: "claude" | "codex",
): readonly { path: string; sha256: string }[] | undefined {
  const outputs: { path: string; sha256: string }[] = [];
  for (const path of outputPaths(target)) {
    let parent = root;
    for (const segment of path.split("/").slice(0, -1)) {
      parent = join(parent, segment);
      try {
        if (lstatSync(parent).isSymbolicLink()) return undefined;
      } catch {
        return undefined;
      }
    }
    const contents = safeRegularBytes(root, path, 1_048_576);
    if (contents === undefined) return undefined;
    outputs.push({ path, sha256: sha256(contents) });
  }
  return outputs;
}

export function exactOutputTextsV4(
  root: string,
  target: "claude" | "codex",
): readonly { path: string; contents: string; sha256: string }[] | undefined {
  const values: { path: string; contents: string; sha256: string }[] = [];
  for (const path of outputPaths(target)) {
    const contents = safeRegularBytes(root, path, 1_048_576);
    if (contents === undefined) return undefined;
    values.push({ path, contents: contents.toString("utf8"), sha256: sha256(contents) });
  }
  return values;
}

export function revokedOutputsClearV4(root: string, receipt: AihManagedUsageReceiptV4): boolean {
  if (receipt.state !== "revoked") return false;
  const recorder = optionalSafeBytes(root, ".aih/usage-record.mjs");
  const ignore = optionalSafeBytes(root, ".gitignore");
  const host = optionalSafeBytes(root, aihManagedUsageExpectedHostHookV4(receipt.target).path);
  return (
    recorder !== undefined &&
    (recorder === null || recorder.toString("utf8") !== usageRecorderScript()) &&
    ignore !== undefined &&
    (ignore === null || policyAihIgnoreRollbackContents(ignore.toString("utf8")) === undefined) &&
    host !== undefined &&
    (host === null || fixedHostPresent(receipt.target, host) === false)
  );
}

export function inspectAihManagedUsageReceiptV4(
  root: string,
  descriptor: AihManagedUsageDescriptorV4,
): {
  readonly state:
    | "absent"
    | "claimed"
    | "configured"
    | "revoking"
    | "revoked"
    | "drifted"
    | "invalid";
  readonly receiptDigest?: string;
} {
  if (receiptHasSymlinkParent(root)) return { state: "invalid" };
  try {
    lstatSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH));
  } catch {
    return { state: "absent" };
  }
  const parsed = parseAihManagedUsageReceiptV4(root, descriptor);
  if (parsed === undefined) return { state: "invalid" };
  if (parsed.receipt.state === "claimed")
    return { state: parsed.receipt.state, receiptDigest: parsed.digest };
  if (parsed.receipt.state === "revoked")
    return revokedOutputsClearV4(root, parsed.receipt)
      ? { state: "revoked", receiptDigest: parsed.digest }
      : { state: "drifted", receiptDigest: parsed.digest };
  return configuredOutputsMatchV4(root, parsed.receipt)
    ? { state: parsed.receipt.state, receiptDigest: parsed.digest }
    : { state: "drifted", receiptDigest: parsed.digest };
}
