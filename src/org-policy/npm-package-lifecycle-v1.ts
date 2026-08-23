import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { canonicalStrictJsonBytesV1, parseStrictJsonObjectV1 } from "../contract/strict-json-v1.js";
import { type Cli, SUPPORTED_CLIS } from "../internals/clis.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { CommandSpec, Plan, PlanContext, WriteAction } from "../internals/plan.js";
import { dynamicDigest, plan, probe } from "../internals/plan.js";
import type { Check, CheckCode } from "../internals/verify.js";
import { verifyPolicyAuthorityReceipt } from "./authority.js";
import type {
  GovernanceDecisionRevocationV2,
  GovernanceDecisionV2,
} from "./governance-decision-v2.js";
import { governanceDecisionDigestV2 } from "./governance-decision-v2.js";
import {
  type NpmPackageObservationResultV1,
  npmPackageObservationHandoffForLifecycleV1,
  observeNpmPackageV1,
} from "./npm-package-observer-v1.js";
import {
  parseUpstreamObservationReceiptV1,
  type UpstreamObservationReceiptV1,
  upstreamObservationReceiptDigestV1,
} from "./upstream-observation-receipt-v1.js";

const STORE = [".aih", "governance", "npm-package-lifecycle", "v1"] as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_STORE_FILE_BYTES = 512 * 1024;
const MAX_RECORDS_PER_LINEAGE = 4_096;

type LifecycleReason =
  | "invalid-input"
  | "authority-unverified"
  | "authority-not-current"
  | "authority-drift"
  | "decision-revoked"
  | "observation-unverified"
  | "observation-partial"
  | "store-unsafe"
  | "store-corrupt"
  | "store-collision"
  | "store-detached"
  | "head-conflict";

export interface NpmPackageLifecycleResultV1 {
  readonly applied: boolean;
  readonly outcome: "fulfilled" | "partial" | "refused" | "reported-only";
  readonly reason?: LifecycleReason;
  readonly recordDigest?: string;
  readonly state: "decision-revoked" | "observed-effective" | LifecycleReason;
}

interface Lineage {
  readonly digest: string;
  readonly integration: {
    readonly mode: "upstream-managed";
    readonly owner: string;
    readonly version: string;
  };
  readonly npm: { readonly package: string; readonly registry: string };
  readonly subjectId: string;
  readonly target: string;
  readonly effect: "install";
}

interface Existing {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly text: string;
}

interface Prepared {
  readonly actions: readonly WriteAction[];
  readonly commitNotAfter?: string;
  readonly commitLock?: string;
  readonly postcondition?: {
    bindingPath: string;
    bindingText: string;
    claimPath: string;
    claimText: string;
    headPath: string;
    headText: string;
    lineage: Lineage;
    recordPath: string;
    recordText: string;
  };
  readonly result: NpmPackageLifecycleResultV1;
}
interface LifecycleHead {
  readonly lineageDigest: string;
  readonly recordDigest: string;
  readonly sequence: number;
  readonly subjectDigest: string;
}

type CurrentAuthorityRevocation =
  | { readonly kind: "authority-unverified" }
  | { readonly kind: "authority-not-current" }
  | { readonly kind: "authority-drift" }
  | {
      readonly kind: "revoked";
      readonly authorityReceiptDigest: string;
      readonly authorityExpiresAt: string;
      readonly decision: GovernanceDecisionV2;
      readonly revocation: GovernanceDecisionRevocationV2;
    };

function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestOf(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`${domain}\0`, "utf8")
    .update(canonicalStrictJsonBytesV1(value))
    .digest("hex")}`;
}

function option(ctx: PlanContext, key: string): string | undefined {
  const value = ctx.options[key];
  return typeof value === "string" && value.length > 0 && value.trim() === value
    ? value
    : undefined;
}

function input(
  ctx: PlanContext,
): { decision: string; digest: string; evidence: string; target: Cli } | undefined {
  const decision = option(ctx, "decision");
  const decisionDigest = option(ctx, "decisionDigest");
  const evidence = option(ctx, "evidence");
  const target = option(ctx, "target");
  if (
    decision === undefined ||
    !ID.test(decision) ||
    decisionDigest === undefined ||
    !SHA256.test(decisionDigest) ||
    evidence === undefined ||
    target === undefined ||
    !SUPPORTED_CLIS.includes(target as Cli)
  )
    return undefined;
  return { decision, digest: decisionDigest, evidence, target: target as Cli };
}

function lstat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function safeRelativePath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel !== "" &&
    !rel.startsWith("..") &&
    !rel.includes(":") &&
    !rel.split(/[\\/]+/).some((part) => part === "" || part === "." || part === "..")
  );
}

/** Refuse every linked or non-directory parent on the fixed governance-store path. */
function safeStorePath(root: string, ...parts: string[]): string | undefined {
  const rootStat = lstat(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return undefined;
  const path = resolve(root, ...parts);
  if (!safeRelativePath(root, path)) return undefined;
  let cursor = root;
  for (const segment of relative(root, path).split(sep).slice(0, -1)) {
    cursor = resolve(cursor, segment);
    const stat = lstat(cursor);
    if (stat !== undefined && (!stat.isDirectory() || stat.isSymbolicLink())) return undefined;
  }
  return path;
}

function readCanonicalStoreFile(
  root: string,
  ...parts: string[]
): Existing | "absent" | "unsafe" | "corrupt" {
  const path = safeStorePath(root, ...parts);
  if (path === undefined) return "unsafe";
  const opened = readRegularFileWithStats(path, { maxBytes: MAX_STORE_FILE_BYTES });
  if (opened === undefined) return lstat(path) === undefined ? "absent" : "unsafe";
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(opened.contents);
    const parsed = parseStrictJsonObjectV1(text, "npm lifecycle store");
    if (!canonicalStrictJsonBytesV1(parsed).equals(opened.contents)) return "corrupt";
    return { bytes: Buffer.from(opened.contents), sha256: hash(opened.contents), text };
  } catch {
    return "corrupt";
  }
}

function canonicalText(value: unknown): string {
  return canonicalStrictJsonBytesV1(value).toString("utf8");
}

function pin(path: string, existing: Existing, describe: string): WriteAction {
  return {
    kind: "write",
    path,
    contents: existing.text,
    exactContents: true,
    describe,
    expect: { sha256: existing.sha256 },
    assertUnchanged: true,
  };
}

function staged(
  path: string,
  contents: string,
  existing: Existing | "absent",
  describe: string,
  durable = false,
): WriteAction {
  return {
    kind: "write",
    path,
    contents,
    exactContents: true,
    ...(durable ? { durable: true as const } : {}),
    describe,
    expect: existing === "absent" ? { absent: true } : { sha256: existing.sha256 },
  };
}

function subjectLockPath(subjectId: string, target: string): string {
  return [...STORE, "locks", `${hash(`${subjectId}\0${target}`)}.lock`].join("/");
}

function lifecycleReason(result: NpmPackageObservationResultV1): LifecycleReason {
  if (result.reason === "authority-unverified" || result.reason === "authority-version")
    return "authority-unverified";
  if (result.reason === "authority-not-current") return "authority-not-current";
  if (result.reason === "decision-revoked") return "decision-revoked";
  if (result.outcome === "partial") return "observation-partial";
  return "observation-unverified";
}

function refused(reason: LifecycleReason, outcome: "partial" | "refused" = "refused"): Prepared {
  return {
    actions: [],
    result: { applied: false, outcome, reason, state: reason },
  };
}

function persisted(root: string, postcondition: NonNullable<Prepared["postcondition"]>): boolean {
  const binding = readCanonicalStoreFile(root, ...postcondition.bindingPath.split("/"));
  const claim = readCanonicalStoreFile(root, ...postcondition.claimPath.split("/"));
  const record = readCanonicalStoreFile(root, ...postcondition.recordPath.split("/"));
  const head = readCanonicalStoreFile(root, ...postcondition.headPath.split("/"));
  const parsedBinding = typeof binding === "string" ? undefined : parseBinding(binding);
  const parsedHead = typeof head === "string" ? undefined : parseHead(head, postcondition.lineage);
  return (
    typeof binding !== "string" &&
    typeof claim !== "string" &&
    typeof record !== "string" &&
    typeof head !== "string" &&
    binding.text === postcondition.bindingText &&
    claim.text === postcondition.claimText &&
    record.text === postcondition.recordText &&
    head.text === postcondition.headText &&
    parsedBinding !== undefined &&
    canonicalText(parsedBinding) === canonicalText(postcondition.lineage) &&
    parsedHead !== undefined &&
    verifyHistory(root, parsedHead, postcondition.lineage) &&
    hasOnlyExpectedSuccessor(root, parsedHead, postcondition.lineage)
  );
}

function reportedResult(ctx: PlanContext, prepared: Prepared): NpmPackageLifecycleResultV1 {
  if (
    ctx.apply &&
    prepared.postcondition !== undefined &&
    !persisted(ctx.root, prepared.postcondition)
  ) {
    return {
      applied: false,
      outcome: "refused",
      reason: "store-detached",
      state: "store-detached",
    };
  }
  return prepared.result;
}

function pinObservedCustody(
  root: string,
  custody: { path: string; sha256: string },
): WriteAction | undefined {
  if (!SHA256.test(custody.sha256)) return undefined;
  const path = safeStorePath(root, ...custody.path.split("/"));
  if (path === undefined) return undefined;
  const opened = readRegularFileWithStats(path, { maxBytes: 16 * 1024 * 1024 });
  if (opened === undefined) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(opened.contents);
    if (
      !Buffer.from(text, "utf8").equals(opened.contents) ||
      `sha256:${hash(opened.contents)}` !== custody.sha256
    )
      return undefined;
    return pin(
      custody.path,
      { bytes: Buffer.from(opened.contents), sha256: hash(opened.contents), text },
      `pin observed ${custody.path}`,
    );
  } catch {
    return undefined;
  }
}

function subjectBindingPath(subjectId: string, target: string): readonly string[] {
  return [...STORE, "subjects", `${hash(`${subjectId}\0${target}`)}.json`] as const;
}

/**
 * Immutable local index for a subject+target lineage. It makes binding-loss
 * recovery bounded to this subject rather than turning normal onboarding into
 * a scan of every organization lineage.
 */
function subjectClaimPath(subjectId: string, target: string): readonly string[] {
  return [...STORE, "claims", `${hash(`${subjectId}\0${target}`)}.json`] as const;
}

function headPath(lineageDigest: string): readonly string[] {
  return [...STORE, "heads", `${lineageDigest.slice("sha256:".length)}.json`] as const;
}

function recordPath(lineage: Pick<Lineage, "digest">, recordDigest: string): readonly string[] {
  return [
    ...STORE,
    "records",
    lineage.digest.slice("sha256:".length),
    `${recordDigest.slice("sha256:".length)}.json`,
  ] as const;
}

function parseObject(existing: Existing): Record<string, unknown> | undefined {
  try {
    return parseStrictJsonObjectV1(existing.text, "npm lifecycle store");
  } catch {
    return undefined;
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stableText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    ? value
    : undefined;
}

function parseLineage(value: unknown): Lineage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    !exactKeys(item, ["digest", "effect", "integration", "npm", "subjectId", "target"]) ||
    item.effect !== "install" ||
    stableText(item.digest) === undefined ||
    stableText(item.subjectId) === undefined ||
    stableText(item.target) === undefined ||
    item.integration === null ||
    typeof item.integration !== "object" ||
    Array.isArray(item.integration) ||
    item.npm === null ||
    typeof item.npm !== "object" ||
    Array.isArray(item.npm)
  )
    return undefined;
  const integration = item.integration as Record<string, unknown>;
  const npm = item.npm as Record<string, unknown>;
  if (
    !exactKeys(integration, ["mode", "owner", "version"]) ||
    integration.mode !== "upstream-managed" ||
    stableText(integration.owner) === undefined ||
    stableText(integration.version) === undefined ||
    !exactKeys(npm, ["package", "registry"]) ||
    stableText(npm.package) === undefined ||
    stableText(npm.registry) === undefined
  )
    return undefined;
  const base = {
    effect: "install" as const,
    integration: {
      mode: "upstream-managed" as const,
      owner: integration.owner as string,
      version: integration.version as string,
    },
    npm: { package: npm.package as string, registry: npm.registry as string },
    subjectId: item.subjectId as string,
    target: item.target as string,
  };
  const lineage = {
    ...base,
    digest: digestOf("aih-npm-package-lifecycle-lineage/v1", base),
  };
  return item.digest === lineage.digest ? lineage : undefined;
}

function parseBinding(value: Existing): Lineage | undefined {
  const item = parseObject(value);
  if (
    item === undefined ||
    !exactKeys(item, ["format", "lineage", "version"]) ||
    item.format !== "aih-npm-package-lifecycle-subject" ||
    item.version !== 1
  )
    return undefined;
  return parseLineage(item.lineage);
}

function parseHead(value: Existing, lineage: Lineage): LifecycleHead | undefined {
  const item = parseObject(value);
  const sequence = item?.sequence;
  if (
    item === undefined ||
    !exactKeys(item, [
      "format",
      "lineageDigest",
      "recordDigest",
      "sequence",
      "subjectDigest",
      "version",
    ]) ||
    item.format !== "aih-npm-package-lifecycle-head" ||
    item.version !== 1 ||
    item.lineageDigest !== lineage.digest ||
    typeof item.recordDigest !== "string" ||
    !SHA256.test(item.recordDigest) ||
    typeof item.subjectDigest !== "string" ||
    !SHA256.test(item.subjectDigest) ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1
  )
    return undefined;
  return {
    lineageDigest: item.lineageDigest,
    recordDigest: item.recordDigest,
    sequence,
    subjectDigest: item.subjectDigest,
  };
}

function recordLink(
  value: Existing,
  recordDigest: string,
  lineage: Lineage,
):
  | {
      decisionDigest: string;
      previous?: string;
      sequence: number;
      state: "decision-revoked" | "observed-effective";
      subjectDigest: string;
    }
  | undefined {
  const item = parseObject(value);
  const recordLineage = item === undefined ? undefined : parseLineage(item.lineage);
  if (
    item === undefined ||
    item.format !== "aih-npm-package-lifecycle-record" ||
    item.version !== 1 ||
    (item.state !== "observed-effective" && item.state !== "decision-revoked") ||
    !Number.isSafeInteger(item.sequence) ||
    (item.sequence as number) < 1 ||
    recordLineage === undefined ||
    canonicalText(recordLineage) !== canonicalText(lineage) ||
    digestOf("aih-npm-package-lifecycle-record/v1", item) !== recordDigest
  )
    return undefined;
  const previous = item.previousRecordDigest;
  if (previous !== undefined && (typeof previous !== "string" || !SHA256.test(previous)))
    return undefined;
  if ((item.sequence as number) === 1 ? previous !== undefined : previous === undefined)
    return undefined;
  const decision = item.decision;
  if (
    decision === null ||
    typeof decision !== "object" ||
    Array.isArray(decision) ||
    !exactKeys(decision as Record<string, unknown>, ["digest", "id"]) ||
    stableText((decision as Record<string, unknown>).id) === undefined ||
    !SHA256.test(stableText((decision as Record<string, unknown>).digest) ?? "") ||
    !SHA256.test(stableText(item.authorityReceiptDigest) ?? "") ||
    !SHA256.test(stableText(item.subjectDigest) ?? "")
  )
    return undefined;
  if (item.state === "observed-effective") {
    if (
      !exactKeys(
        item,
        [
          "decision",
          "authorityReceiptDigest",
          "format",
          "lineage",
          "observation",
          "observationDigest",
          "previousRecordDigest",
          "sequence",
          "state",
          "subjectDigest",
          "version",
        ].filter((key) => key !== "previousRecordDigest" || previous !== undefined),
      )
    )
      return undefined;
    try {
      const observation = parseUpstreamObservationReceiptV1(item.observation);
      if (
        !SHA256.test(stableText(item.observationDigest) ?? "") ||
        upstreamObservationReceiptDigestV1(observation) !== item.observationDigest
      )
        return undefined;
      if (
        observation.decision.id !== (decision as Record<string, unknown>).id ||
        observation.decision.digest !== (decision as Record<string, unknown>).digest ||
        observation.subject.id !== lineage.subjectId ||
        observation.subject.subjectDigest !== item.subjectDigest ||
        observation.targets.length !== 1 ||
        observation.targets[0] !== lineage.target ||
        observation.allowedEffects.length !== 1 ||
        observation.allowedEffects[0] !== lineage.effect ||
        canonicalText(observation.integration) !== canonicalText(lineage.integration)
      )
        return undefined;
    } catch {
      return undefined;
    }
  } else if (
    !exactKeys(
      item,
      [
        "decision",
        "authorityReceiptDigest",
        "format",
        "lineage",
        "previousRecordDigest",
        "recordedAt",
        "revocation",
        "sequence",
        "state",
        "subjectDigest",
        "version",
      ].filter((key) => key !== "previousRecordDigest" || previous !== undefined),
    )
  )
    return undefined;
  if (item.state === "decision-revoked") {
    const revocation = item.revocation;
    if (
      revocation === null ||
      typeof revocation !== "object" ||
      Array.isArray(revocation) ||
      !exactKeys(revocation as Record<string, unknown>, [
        "decisionDigest",
        "format",
        "issuer",
        "reason",
        "revokedAt",
        "version",
      ]) ||
      (revocation as Record<string, unknown>).format !== "aih-governance-decision-revocation" ||
      (revocation as Record<string, unknown>).version !== 2 ||
      (revocation as Record<string, unknown>).decisionDigest !==
        (decision as Record<string, unknown>).digest ||
      stableText((revocation as Record<string, unknown>).issuer) === undefined ||
      stableText((revocation as Record<string, unknown>).reason) === undefined ||
      !Number.isFinite(
        Date.parse(stableText((revocation as Record<string, unknown>).revokedAt) ?? ""),
      )
    )
      return undefined;
    if (!Number.isFinite(Date.parse(stableText(item.recordedAt) ?? ""))) return undefined;
  }
  return {
    decisionDigest: (decision as Record<string, unknown>).digest as string,
    ...(previous === undefined ? {} : { previous }),
    sequence: item.sequence as number,
    state: item.state,
    subjectDigest: item.subjectDigest as string,
  };
}

function verifyHistory(root: string, head: LifecycleHead, lineage: Lineage): boolean {
  let digest = head.recordDigest;
  let expectedSequence = head.sequence;
  for (let count = 0; count < MAX_RECORDS_PER_LINEAGE; count += 1) {
    const prior = readCanonicalStoreFile(root, ...recordPath(lineage, digest));
    if (typeof prior === "string") return false;
    const link = recordLink(prior, digest, lineage);
    if (link === undefined || link.sequence !== expectedSequence) return false;
    if (digest === head.recordDigest && link.subjectDigest !== head.subjectDigest) return false;
    if (link.previous === undefined) return expectedSequence === 1;
    digest = link.previous;
    expectedSequence -= 1;
  }
  return false;
}

/**
 * A content-addressed orphan is recoverable only when it is exactly the record
 * this invocation would have staged. Any other direct successor makes this head
 * stale or forked and must block an advance rather than silently choosing a fork.
 */
function hasOnlyExpectedSuccessor(
  root: string,
  head: LifecycleHead | undefined,
  lineage: Lineage,
  expectedOrphanDigest?: string,
): boolean {
  const directory = safeStorePath(
    root,
    ...STORE,
    "records",
    lineage.digest.slice("sha256:".length),
  );
  if (directory === undefined) return false;
  const info = lstat(directory);
  if (info === undefined) return true;
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch {
    return false;
  }
  if (
    names.length > MAX_RECORDS_PER_LINEAGE ||
    names.some((name) => !/^[0-9a-f]{64}\.json$/.test(name))
  )
    return false;
  const links = new Map<
    string,
    ReturnType<typeof recordLink> extends infer T ? Exclude<T, undefined> : never
  >();
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const recordDigest = `sha256:${name.slice(0, -5)}`;
    const existing = readCanonicalStoreFile(
      root,
      ...STORE,
      "records",
      lineage.digest.slice("sha256:".length),
      name,
    );
    if (typeof existing === "string") return false;
    const item = parseObject(existing);
    const recordLineage = item === undefined ? undefined : parseLineage(item.lineage);
    if (recordLineage === undefined || recordLineage.digest !== lineage.digest) return false;
    const link = recordLink(existing, recordDigest, lineage);
    if (link === undefined) return false;
    links.set(recordDigest, link);
  }
  const chain = new Set<string>();
  let cursor = head?.recordDigest;
  for (let count = 0; cursor !== undefined && count < MAX_RECORDS_PER_LINEAGE; count += 1) {
    const link = links.get(cursor);
    if (link === undefined || chain.has(cursor)) return false;
    chain.add(cursor);
    cursor = link.previous;
  }
  if (cursor !== undefined) return false;
  for (const [recordDigest, link] of links) {
    if (chain.has(recordDigest)) continue;
    if (expectedOrphanDigest === undefined || recordDigest !== expectedOrphanDigest) return false;
    if (
      head === undefined
        ? link.sequence !== 1 || link.previous !== undefined
        : link.sequence !== head.sequence + 1 || link.previous !== head.recordDigest
    )
      return false;
  }
  return true;
}

/** Avoid starting a bounded history walk when a new record would exceed its capacity. */
function capacityAllowsCandidate(root: string, lineage: Lineage, candidateDigest: string): boolean {
  const directory = safeStorePath(
    root,
    ...STORE,
    "records",
    lineage.digest.slice("sha256:".length),
  );
  if (directory === undefined) return false;
  const info = lstat(directory);
  if (info === undefined) return true;
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return false;
  }
  return (
    names.length < MAX_RECORDS_PER_LINEAGE ||
    (names.length === MAX_RECORDS_PER_LINEAGE &&
      names.includes(`${candidateDigest.slice("sha256:".length)}.json`))
  );
}

function currentAuthorityRevocation(
  ctx: PlanContext,
  requested: { decision: string; digest: string; target: Cli },
): Promise<CurrentAuthorityRevocation> {
  return verifyPolicyAuthorityReceipt(ctx).then((verified) => {
    const authority = verified.authority;
    if (authority === undefined)
      return {
        kind:
          verified.problem === "authority receipt is not currently valid"
            ? "authority-not-current"
            : "authority-unverified",
      };
    if (authority.receipt.version !== 3) return { kind: "authority-unverified" };
    const receipt = authority.receipt;
    const now = Date.now();
    if (now < Date.parse(receipt.issuedAt) || now >= Date.parse(receipt.expiresAt))
      return { kind: "authority-not-current" };
    const decision = receipt.decisions.find(
      (candidate) =>
        candidate.id === requested.decision &&
        governanceDecisionDigestV2(candidate) === requested.digest,
    );
    const revocation = receipt.decisionRevocations.find(
      (candidate) => candidate.decisionDigest === requested.digest,
    );
    if (
      decision === undefined ||
      revocation === undefined ||
      Date.parse(revocation.revokedAt) > now ||
      decision.subject.source.type !== "npm" ||
      !decision.targets.includes(requested.target)
    )
      return { kind: "authority-drift" };
    if (
      now < Date.parse(decision.notBefore) ||
      now >= Date.parse(decision.expiresAt) ||
      (decision.disposition === "accepted-with-conditions" && now >= Date.parse(decision.reviewBy))
    )
      return { kind: "authority-not-current" };
    return {
      kind: "revoked",
      authorityReceiptDigest: authority.receiptDigest,
      authorityExpiresAt: receipt.expiresAt,
      decision,
      revocation,
    };
  });
}

function lineageFromDecision(
  decision: GovernanceDecisionV2,
  target: string,
  integration: UpstreamObservationReceiptV1["integration"],
): Lineage | undefined {
  const source = decision.subject.source;
  if (source.type !== "npm" || source.registry === undefined || source.package === undefined)
    return undefined;
  const base = {
    effect: "install" as const,
    integration: {
      mode: integration.mode,
      owner: integration.owner,
      version: integration.version,
    },
    npm: { package: source.package, registry: source.registry },
    subjectId: decision.subject.id,
    target,
  };
  return { ...base, digest: digestOf("aih-npm-package-lifecycle-lineage/v1", base) };
}

function lifecycleActions(
  ctx: PlanContext,
  handoff: {
    authorityReceiptDigest: string;
    custody: readonly { path: string; sha256: string }[];
    decision: GovernanceDecisionV2;
    receipt: UpstreamObservationReceiptV1;
  },
  requested: { evidence: string; target: string },
): Prepared {
  const { receipt } = handoff;
  const lineage = lineageFromDecision(handoff.decision, requested.target, receipt.integration);
  if (lineage === undefined) return refused("observation-unverified");
  const custody = handoff.custody.map((item) => pinObservedCustody(ctx.root, item));
  if (!custody.every((item): item is WriteAction => item !== undefined))
    return refused("observation-unverified");
  const bindingParts = subjectBindingPath(lineage.subjectId, lineage.target);
  const claimParts = subjectClaimPath(lineage.subjectId, lineage.target);
  const headParts = headPath(lineage.digest);
  const binding = readCanonicalStoreFile(ctx.root, ...bindingParts);
  const claim = readCanonicalStoreFile(ctx.root, ...claimParts);
  const head = readCanonicalStoreFile(ctx.root, ...headParts);
  if (binding === "unsafe" || claim === "unsafe" || head === "unsafe")
    return refused("store-unsafe");
  if (binding === "corrupt" || claim === "corrupt" || head === "corrupt")
    return refused("store-corrupt");
  const existingLineage = binding === "absent" ? undefined : parseBinding(binding);
  const claimedLineage = claim === "absent" ? undefined : parseBinding(claim);
  if (
    binding !== "absent" &&
    (existingLineage === undefined || canonicalText(existingLineage) !== canonicalText(lineage))
  )
    return refused("store-collision");
  if (
    (claim !== "absent" &&
      (claimedLineage === undefined || canonicalText(claimedLineage) !== canonicalText(lineage))) ||
    (binding !== "absent" && claim === "absent")
  )
    return refused("store-collision");
  const priorHead = head === "absent" ? undefined : parseHead(head, lineage);
  if (head !== "absent" && priorHead === undefined) return refused("head-conflict");
  const sequence = (priorHead?.sequence ?? 0) + 1;
  const observationDigest = upstreamObservationReceiptDigestV1(receipt);
  const candidateRecord = {
    decision: receipt.decision,
    authorityReceiptDigest: handoff.authorityReceiptDigest,
    format: "aih-npm-package-lifecycle-record",
    lineage,
    observation: receipt,
    observationDigest,
    ...(priorHead === undefined ? {} : { previousRecordDigest: priorHead.recordDigest }),
    sequence,
    state: "observed-effective" as const,
    subjectDigest: receipt.subject.subjectDigest,
    version: 1,
  };
  const recordDigest = digestOf("aih-npm-package-lifecycle-record/v1", candidateRecord);
  if (!capacityAllowsCandidate(ctx.root, lineage, recordDigest)) return refused("head-conflict");
  if (priorHead !== undefined && !verifyHistory(ctx.root, priorHead, lineage))
    return refused("head-conflict");
  if (!hasOnlyExpectedSuccessor(ctx.root, priorHead, lineage, recordDigest))
    return refused("head-conflict");
  const recordParts = recordPath(lineage, recordDigest);
  const existingRecord = readCanonicalStoreFile(ctx.root, ...recordParts);
  if (existingRecord === "unsafe") return refused("store-unsafe");
  if (existingRecord === "corrupt") return refused("store-corrupt");
  const recordText = canonicalText(candidateRecord);
  if (existingRecord !== "absent" && existingRecord.text !== recordText)
    return refused("store-collision");
  const bindingText = canonicalText({
    format: "aih-npm-package-lifecycle-subject",
    lineage,
    version: 1,
  });
  const headText = canonicalText({
    format: "aih-npm-package-lifecycle-head",
    lineageDigest: lineage.digest,
    recordDigest,
    sequence,
    subjectDigest: receipt.subject.subjectDigest,
    version: 1,
  });
  const actions: WriteAction[] = [
    ...custody,
    claim === "absent"
      ? staged(
          claimParts.join("/"),
          bindingText,
          claim,
          "claim npm lifecycle subject lineage",
          true,
        )
      : pin(claimParts.join("/"), claim, "pin npm lifecycle subject lineage claim"),
    binding === "absent"
      ? staged(bindingParts.join("/"), bindingText, binding, "bind npm lifecycle subject lineage")
      : pin(bindingParts.join("/"), binding, "pin npm lifecycle subject lineage"),
    existingRecord === "absent"
      ? staged(
          recordParts.join("/"),
          recordText,
          existingRecord,
          "persist immutable npm lifecycle record",
          true,
        )
      : pin(recordParts.join("/"), existingRecord, "pin reusable immutable npm lifecycle record"),
    staged(headParts.join("/"), headText, head, "advance npm lifecycle subject head"),
  ];
  return {
    actions,
    commitNotAfter: receipt.validUntil,
    commitLock: subjectLockPath(lineage.subjectId, lineage.target),
    postcondition: {
      bindingPath: bindingParts.join("/"),
      bindingText,
      claimPath: claimParts.join("/"),
      claimText: bindingText,
      headPath: headParts.join("/"),
      headText,
      lineage,
      recordPath: recordParts.join("/"),
      recordText,
    },
    result: {
      applied: ctx.apply,
      outcome: ctx.apply ? "fulfilled" : "reported-only",
      recordDigest,
      state: "observed-effective",
    },
  };
}

function revocationActions(
  ctx: PlanContext,
  current: Extract<CurrentAuthorityRevocation, { kind: "revoked" }>,
  requested: { target: string },
): Prepared {
  const bindingParts = subjectBindingPath(current.decision.subject.id, requested.target);
  const claimParts = subjectClaimPath(current.decision.subject.id, requested.target);
  const binding = readCanonicalStoreFile(ctx.root, ...bindingParts);
  const claim = readCanonicalStoreFile(ctx.root, ...claimParts);
  if (binding === "unsafe" || claim === "unsafe") return refused("store-unsafe");
  if (binding === "corrupt" || claim === "corrupt") return refused("store-corrupt");
  // A revocation must never create a lineage from unobserved data. It only
  // closes a verified existing chain and makes no package-deletion claim.
  if (binding === "absent") {
    if (claim !== "absent") return refused("head-conflict");
    return {
      actions: [],
      result: {
        applied: false,
        outcome: "reported-only",
        reason: "decision-revoked",
        state: "decision-revoked",
      },
    };
  }
  const lineage = parseBinding(binding);
  const claimedLineage = claim === "absent" ? undefined : parseBinding(claim);
  const source = current.decision.subject.source;
  if (
    lineage === undefined ||
    claim === "absent" ||
    claimedLineage === undefined ||
    canonicalText(claimedLineage) !== canonicalText(lineage) ||
    source.type !== "npm" ||
    lineage.subjectId !== current.decision.subject.id ||
    lineage.target !== requested.target ||
    lineage.npm.registry !== source.registry ||
    lineage.npm.package !== source.package
  )
    return refused("head-conflict");
  const headParts = headPath(lineage.digest);
  const head = readCanonicalStoreFile(ctx.root, ...headParts);
  if (head === "unsafe") return refused("store-unsafe");
  if (head === "corrupt") return refused("store-corrupt");
  if (head === "absent") {
    return refused("head-conflict");
  }
  const priorHead = parseHead(head, lineage);
  if (priorHead === undefined || !verifyHistory(ctx.root, priorHead, lineage))
    return refused("head-conflict");
  // A terminal/reported-only revocation still reads untrusted durable state.
  // Validate that there is no forward fork before returning any semantic status.
  if (!hasOnlyExpectedSuccessor(ctx.root, priorHead, lineage)) return refused("head-conflict");
  const currentRecord = readCanonicalStoreFile(
    ctx.root,
    ...recordPath(lineage, priorHead.recordDigest),
  );
  const currentLink =
    typeof currentRecord === "string"
      ? undefined
      : recordLink(currentRecord, priorHead.recordDigest, lineage);
  const revokedDigest = governanceDecisionDigestV2(current.decision);
  // A historical revocation never rewinds a newer bump. The same revocation is
  // report-only after its first durable record, so it cannot grow history forever.
  if (
    currentLink === undefined ||
    currentLink.decisionDigest !== revokedDigest ||
    currentLink.subjectDigest !== current.decision.subject.subjectDigest ||
    currentLink.state === "decision-revoked"
  ) {
    return {
      actions: [],
      result: {
        applied: false,
        outcome: "reported-only",
        reason: "decision-revoked",
        state: "decision-revoked",
      },
    };
  }
  const record = {
    decision: { digest: revokedDigest, id: current.decision.id },
    authorityReceiptDigest: current.authorityReceiptDigest,
    format: "aih-npm-package-lifecycle-record",
    lineage,
    previousRecordDigest: priorHead.recordDigest,
    recordedAt: new Date().toISOString(),
    revocation: current.revocation,
    sequence: priorHead.sequence + 1,
    state: "decision-revoked" as const,
    subjectDigest: current.decision.subject.subjectDigest,
    version: 1,
  };
  const recordDigest = digestOf("aih-npm-package-lifecycle-record/v1", record);
  if (!capacityAllowsCandidate(ctx.root, lineage, recordDigest)) return refused("head-conflict");
  if (!hasOnlyExpectedSuccessor(ctx.root, priorHead, lineage, recordDigest))
    return refused("head-conflict");
  const recordParts = recordPath(lineage, recordDigest);
  const existingRecord = readCanonicalStoreFile(ctx.root, ...recordParts);
  if (existingRecord === "unsafe") return refused("store-unsafe");
  if (existingRecord === "corrupt") return refused("store-corrupt");
  const recordText = canonicalText(record);
  if (existingRecord !== "absent" && existingRecord.text !== recordText)
    return refused("store-collision");
  const headText = canonicalText({
    format: "aih-npm-package-lifecycle-head",
    lineageDigest: lineage.digest,
    recordDigest,
    sequence: priorHead.sequence + 1,
    subjectDigest: current.decision.subject.subjectDigest,
    version: 1,
  });
  const authorityPin = pinObservedCustody(ctx.root, {
    path: ".aih/policy-authority-receipt.json",
    sha256: current.authorityReceiptDigest,
  });
  if (authorityPin === undefined) return refused("authority-unverified");
  return {
    actions: [
      authorityPin,
      pin(claimParts.join("/"), claim, "pin npm lifecycle subject lineage claim"),
      pin(bindingParts.join("/"), binding, "pin npm lifecycle subject lineage"),
      existingRecord === "absent"
        ? staged(
            recordParts.join("/"),
            recordText,
            existingRecord,
            "persist npm lifecycle revocation record",
            true,
          )
        : pin(
            recordParts.join("/"),
            existingRecord,
            "pin reusable npm lifecycle revocation record",
          ),
      staged(headParts.join("/"), headText, head, "advance revoked npm lifecycle subject head"),
    ],
    commitNotAfter: new Date(
      Math.min(
        Date.parse(current.authorityExpiresAt),
        Date.parse(current.decision.expiresAt),
        current.decision.disposition === "accepted-with-conditions"
          ? Date.parse(current.decision.reviewBy)
          : Number.POSITIVE_INFINITY,
      ),
    ).toISOString(),
    commitLock: subjectLockPath(lineage.subjectId, lineage.target),
    postcondition: {
      bindingPath: bindingParts.join("/"),
      bindingText: binding.text,
      claimPath: claimParts.join("/"),
      claimText: claim.text,
      headPath: headParts.join("/"),
      headText,
      lineage,
      recordPath: recordParts.join("/"),
      recordText,
    },
    result: {
      applied: ctx.apply,
      outcome: ctx.apply ? "fulfilled" : "reported-only",
      reason: "decision-revoked",
      recordDigest,
      state: "decision-revoked",
    },
  };
}

async function prepare(ctx: PlanContext): Promise<Prepared> {
  const requested = input(ctx);
  if (requested === undefined) return refused("invalid-input");
  const observed = await observeNpmPackageV1(ctx);
  if (observed.outcome !== "observed-effective") {
    // A revocation can be durably reported only after a second exact current V3
    // authority verification; every other non-effective state remains read-only.
    if (observed.reason === "decision-revoked") {
      const revocation = await currentAuthorityRevocation(ctx, requested);
      if (revocation.kind === "revoked") return revocationActions(ctx, revocation, requested);
      return refused(revocation.kind);
    }
    return refused(
      lifecycleReason(observed),
      observed.outcome === "partial" ? "partial" : "refused",
    );
  }
  const handoff = npmPackageObservationHandoffForLifecycleV1(observed);
  if (handoff === undefined) return refused("observation-unverified");
  // Fresh current authority immediately before generating writes ensures a
  // prior receipt digest cannot authorize a version bump or an apply boundary.
  return lifecycleActions(ctx, handoff, requested);
}

function check(result: NpmPackageLifecycleResultV1): Check {
  if (result.outcome === "fulfilled" || result.outcome === "reported-only") {
    return {
      name: "policy lifecycle npm-package",
      verdict: "pass",
      detail: `policy lifecycle npm-package ${result.state}`,
    };
  }
  const code: Record<LifecycleReason, CheckCode> = {
    "invalid-input": "org-policy.lifecycle-input-invalid",
    "authority-unverified": "org-policy.lifecycle-authority-unverified",
    "authority-not-current": "org-policy.lifecycle-authority-unverified",
    "authority-drift": "org-policy.lifecycle-authority-unverified",
    "decision-revoked": "org-policy.lifecycle-decision-revoked",
    "observation-unverified": "org-policy.lifecycle-observation-invalid",
    "observation-partial": "org-policy.lifecycle-observation-invalid",
    "store-unsafe": "org-policy.lifecycle-store-invalid",
    "store-corrupt": "org-policy.lifecycle-store-invalid",
    "store-collision": "org-policy.lifecycle-store-conflict",
    "store-detached": "org-policy.lifecycle-store-invalid",
    "head-conflict": "org-policy.lifecycle-store-conflict",
  };
  return {
    name: "policy lifecycle npm-package",
    verdict: "fail",
    code: code[result.reason ?? "observation-unverified"],
    detail: `policy lifecycle npm-package ${result.reason ?? "observation-unverified"}`,
  };
}

function planFrom(prepared: Prepared): Plan {
  let applyResult: NpmPackageLifecycleResultV1 | undefined;
  const resultFor = (ctx: PlanContext): NpmPackageLifecycleResultV1 => {
    if (!ctx.apply) return prepared.result;
    applyResult ??= reportedResult(ctx, prepared);
    return applyResult;
  };
  const built = plan(
    "policy lifecycle npm-package",
    ...prepared.actions,
    dynamicDigest("policy lifecycle npm-package", (ctx) => {
      const result = resultFor(ctx);
      return { text: JSON.stringify(result), data: result };
    }),
    probe("policy lifecycle npm-package", (ctx) => check(resultFor(ctx))),
  );
  return {
    ...built,
    ...(prepared.commitNotAfter === undefined ? {} : { commitNotAfter: prepared.commitNotAfter }),
    ...(prepared.commitLock === undefined ? {} : { commitLock: prepared.commitLock }),
  };
}

export async function npmPackageLifecyclePlan(ctx: PlanContext): Promise<Plan> {
  return planFrom(await prepare(ctx));
}

/** @internal Read-only analysis seam; command writes stay in ordinary plan actions. */
export async function analyzeNpmPackageLifecycleV1(
  ctx: PlanContext,
): Promise<NpmPackageLifecycleResultV1> {
  return (await prepare({ ...ctx, apply: false })).result;
}

export const npmPackageLifecycleCommand: CommandSpec = {
  name: "npm-package",
  summary: "Preview or persist durable history for a current exact npm package observation",
  requireExplicitApply: true,
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
  plan: npmPackageLifecyclePlan,
};
