import { createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { canonicalStrictJsonBytesV1, parseStrictJsonObjectV1 } from "../contract/strict-json-v1.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type {
  CommandSpec,
  FileAssertion,
  Plan,
  PlanContext,
  WriteAction,
} from "../internals/plan.js";
import { dynamicDigest, plan, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import {
  verifiedPolicyAuthorityReceiptAssertionV1,
  verifyPolicyAuthorityReceipt,
} from "./authority.js";
import {
  governanceDecisionDigestV2,
  parseGovernanceDecisionRevocationV2,
} from "./governance-decision-v2.js";
import {
  observeUpstreamArtifactV1,
  type UpstreamArtifactObservationResultV1,
  upstreamArtifactObservationHandoffForLifecycleV1,
} from "./upstream-artifact-observer-v1.js";
import {
  parseUpstreamObservationReceiptV1,
  type UpstreamObservationReceiptV1,
  upstreamObservationReceiptDigestV1,
} from "./upstream-observation-receipt-v1.js";

const STORE = [".aih", "governance", "upstream-artifact-lifecycle", "v1"] as const;
const COMMIT_LOCK = `${STORE.join("/")}/locks/lifecycle.lock`;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_STORE_FILE_BYTES = 1024 * 1024;
const MAX_HEADS = 256;
const MAX_RECORDS_PER_LINEAGE = 4_096;
const MAX_RECORDS = 16_384;
const COMMIT_WINDOW_MS = 60_000;

interface Lineage {
  readonly digest: string;
  readonly effect: UpstreamObservationReceiptV1["allowedEffects"][number];
  readonly integration: Pick<UpstreamObservationReceiptV1["integration"], "mode" | "owner">;
  readonly subject: { readonly kind: "tool" | "skill" | "mcp" | "package"; readonly id: string };
  readonly target: string;
}

interface Existing {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly text: string;
}

interface Head {
  readonly lineageDigest: string;
  readonly recordDigest: string;
  readonly sequence: number;
  readonly subjectDigest: string;
}

export interface UpstreamArtifactLifecycleStoredStateV1 {
  readonly authorityReceiptDigest: string;
  readonly decision: { readonly id: string; readonly digest: string };
  readonly lineage: Lineage;
  readonly manifestDigest?: string;
  readonly observation?: UpstreamObservationReceiptV1;
  readonly previousRecordDigest?: string;
  readonly recordDigest: string;
  readonly revocation?: ReturnType<typeof parseGovernanceDecisionRevocationV2>;
  readonly sequence: number;
  readonly state: "decision-revoked" | "observed-effective";
  readonly subject: { readonly kind: string; readonly id: string };
  readonly subjectDigest: string;
}

export type UpstreamArtifactLifecycleStoreReadV1 =
  | { readonly kind: "absent" }
  | {
      readonly kind: "complete";
      readonly records: readonly UpstreamArtifactLifecycleStoredStateV1[];
    }
  | { readonly kind: "unsafe" | "corrupt" | "over-capacity" };

export interface UpstreamArtifactLifecycleResultV1 {
  readonly applied: boolean;
  readonly outcome: "fulfilled" | "reported-only" | "refused";
  readonly reason?:
    | NonNullable<UpstreamArtifactObservationResultV1["reason"]>
    | "store-unsafe"
    | "store-corrupt"
    | "store-over-capacity"
    | "lineage-conflict"
    | "head-conflict";
  readonly state: "decision-revoked" | "observed-effective" | "refused";
  readonly recordDigest?: string;
}

function canonical(value: unknown): string {
  return canonicalStrictJsonBytesV1(value).toString("utf8");
}

function digestOf(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`${domain}\0`, "utf8")
    .update(canonicalStrictJsonBytesV1(value))
    .digest("hex")}`;
}

function rawSha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

interface BoundedDirectoryEntry {
  readonly directory: boolean;
  readonly file: boolean;
  readonly name: string;
}

function boundedDirectoryEntries(
  directory: string,
  limit: number,
): readonly BoundedDirectoryEntry[] | "unsafe" | "over-capacity" {
  let handle: ReturnType<typeof opendirSync> | undefined;
  let result: readonly BoundedDirectoryEntry[] | "unsafe" | "over-capacity" = "unsafe";
  try {
    handle = opendirSync(directory);
    const entries: BoundedDirectoryEntry[] = [];
    for (let count = 0; count <= limit; count += 1) {
      const entry = handle.readSync();
      if (entry === null) {
        result = entries;
        break;
      }
      if (count === limit) {
        result = "over-capacity";
        break;
      }
      entries.push({ directory: entry.isDirectory(), file: entry.isFile(), name: entry.name });
    }
  } catch {
    result = "unsafe";
  }
  if (handle !== undefined) {
    try {
      handle.closeSync();
    } catch {
      return "unsafe";
    }
  }
  return result;
}

function safeParent(root: string, absolute: string): boolean {
  const rootStat = safeLstat(root);
  if (rootStat === undefined || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || /^[A-Za-z]:/.test(rel)) return false;
  let cursor = root;
  for (const segment of rel.split(sep).slice(0, -1)) {
    cursor = join(cursor, segment);
    const stat = safeLstat(cursor);
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return true;
}

function readStoreFile(
  root: string,
  parts: readonly string[],
): Existing | "absent" | "unsafe" | "corrupt" {
  const absolute = resolve(root, ...parts);
  const stat = safeLstat(absolute);
  if (stat === undefined) return "absent";
  if (!safeParent(root, absolute) || stat.isSymbolicLink() || !stat.isFile()) return "unsafe";
  const opened = readRegularFileWithStats(absolute, { maxBytes: MAX_STORE_FILE_BYTES });
  if (opened === undefined || opened.identity.nlink !== 1n) return "unsafe";
  const bytes = Buffer.from(opened.contents);
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed = parseStrictJsonObjectV1(text, "upstream artifact lifecycle store");
    if (text !== canonical(parsed)) return "corrupt";
    return { bytes, sha256: rawSha256(bytes), text };
  } catch {
    return "corrupt";
  }
}

function parseObject(existing: Existing): Record<string, unknown> | undefined {
  try {
    return parseStrictJsonObjectV1(existing.text, "upstream artifact lifecycle store");
  } catch {
    return undefined;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function lineageFromReceipt(receipt: UpstreamObservationReceiptV1): Lineage | undefined {
  const effect = receipt.allowedEffects[0];
  const target = receipt.targets[0];
  if (
    effect === undefined ||
    target === undefined ||
    receipt.allowedEffects.length !== 1 ||
    receipt.targets.length !== 1 ||
    receipt.integration.mode !== "upstream-managed" ||
    !["tool", "skill", "mcp", "package"].includes(receipt.subject.kind)
  )
    return undefined;
  const base = {
    effect,
    integration: { mode: receipt.integration.mode, owner: receipt.integration.owner },
    subject: {
      kind: receipt.subject.kind as Lineage["subject"]["kind"],
      id: receipt.subject.id,
    },
    target,
  };
  return { ...base, digest: digestOf("aih-upstream-artifact-lineage/v1", base) };
}

function parseLineage(value: unknown): Lineage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const integration = item.integration;
  const subject = item.subject;
  if (
    !exactKeys(item, ["digest", "effect", "integration", "subject", "target"]) ||
    typeof item.digest !== "string" ||
    !SHA256.test(item.digest) ||
    !["configure", "install", "observe", "use"].includes(String(item.effect)) ||
    typeof item.target !== "string" ||
    !ID.test(item.target) ||
    integration === null ||
    typeof integration !== "object" ||
    Array.isArray(integration) ||
    subject === null ||
    typeof subject !== "object" ||
    Array.isArray(subject)
  )
    return undefined;
  const integrationObject = integration as Record<string, unknown>;
  const subjectObject = subject as Record<string, unknown>;
  if (
    !exactKeys(integrationObject, ["mode", "owner"]) ||
    integrationObject.mode !== "upstream-managed" ||
    typeof integrationObject.owner !== "string" ||
    !ID.test(integrationObject.owner) ||
    !exactKeys(subjectObject, ["id", "kind"]) ||
    typeof subjectObject.id !== "string" ||
    !ID.test(subjectObject.id) ||
    !["tool", "skill", "mcp", "package"].includes(String(subjectObject.kind))
  )
    return undefined;
  const base = {
    effect: item.effect as Lineage["effect"],
    integration: {
      mode: "upstream-managed" as const,
      owner: integrationObject.owner,
    },
    subject: {
      kind: subjectObject.kind as Lineage["subject"]["kind"],
      id: subjectObject.id,
    },
    target: item.target,
  };
  const lineage = { ...base, digest: digestOf("aih-upstream-artifact-lineage/v1", base) };
  return lineage.digest === item.digest ? lineage : undefined;
}

function claimKey(lineage: Lineage): string {
  return rawSha256(
    canonical({
      effect: lineage.effect,
      subject: lineage.subject,
      target: lineage.target,
    }),
  );
}

function claimPath(lineage: Lineage): readonly string[] {
  return [...STORE, "claims", `${claimKey(lineage)}.json`];
}

function headPath(lineage: Lineage): readonly string[] {
  return [...STORE, "heads", `${lineage.digest.slice("sha256:".length)}.json`];
}

function recordPath(lineage: Lineage, recordDigest: string): readonly string[] {
  return [
    ...STORE,
    "records",
    lineage.digest.slice("sha256:".length),
    `${recordDigest.slice("sha256:".length)}.json`,
  ];
}

function parseClaim(existing: Existing): Lineage | undefined {
  const item = parseObject(existing);
  return item !== undefined &&
    exactKeys(item, ["format", "lineage", "version"]) &&
    item.format === "aih-upstream-artifact-lifecycle-claim" &&
    item.version === 1
    ? parseLineage(item.lineage)
    : undefined;
}

function parseHead(existing: Existing, lineage: Lineage): Head | undefined {
  const item = parseObject(existing);
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
    item.format !== "aih-upstream-artifact-lifecycle-head" ||
    item.version !== 1 ||
    item.lineageDigest !== lineage.digest ||
    typeof item.recordDigest !== "string" ||
    !SHA256.test(item.recordDigest) ||
    typeof item.subjectDigest !== "string" ||
    !SHA256.test(item.subjectDigest) ||
    typeof item.sequence !== "number" ||
    !Number.isSafeInteger(item.sequence) ||
    item.sequence < 1
  )
    return undefined;
  return {
    lineageDigest: item.lineageDigest,
    recordDigest: item.recordDigest,
    sequence: item.sequence,
    subjectDigest: item.subjectDigest,
  };
}

function parseRecord(
  existing: Existing,
  lineage: Lineage,
  expectedDigest: string,
): UpstreamArtifactLifecycleStoredStateV1 | undefined {
  const item = parseObject(existing);
  if (
    item === undefined ||
    item.format !== "aih-upstream-artifact-lifecycle-record" ||
    item.version !== 1 ||
    (item.state !== "observed-effective" && item.state !== "decision-revoked") ||
    typeof item.sequence !== "number" ||
    !Number.isSafeInteger(item.sequence) ||
    item.sequence < 1 ||
    typeof item.authorityReceiptDigest !== "string" ||
    !SHA256.test(item.authorityReceiptDigest) ||
    typeof item.subjectDigest !== "string" ||
    !SHA256.test(item.subjectDigest) ||
    digestOf("aih-upstream-artifact-lifecycle-record/v1", item) !== expectedDigest
  )
    return undefined;
  const parsedLineage = parseLineage(item.lineage);
  const decision = item.decision as Record<string, unknown> | undefined;
  if (
    parsedLineage === undefined ||
    canonical(parsedLineage) !== canonical(lineage) ||
    decision === undefined ||
    typeof decision.id !== "string" ||
    !ID.test(decision.id) ||
    typeof decision.digest !== "string" ||
    !SHA256.test(decision.digest)
  )
    return undefined;
  const previous = item.previousRecordDigest;
  if (previous !== undefined && (typeof previous !== "string" || !SHA256.test(previous)))
    return undefined;
  if (item.state === "observed-effective") {
    if (
      !exactKeys(
        item,
        [
          "authorityReceiptDigest",
          "decision",
          "format",
          "lineage",
          "manifestDigest",
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
    if (
      typeof item.manifestDigest !== "string" ||
      !SHA256.test(item.manifestDigest) ||
      typeof item.observationDigest !== "string" ||
      !SHA256.test(item.observationDigest)
    )
      return undefined;
    try {
      const observation = parseUpstreamObservationReceiptV1(item.observation);
      if (
        upstreamObservationReceiptDigestV1(observation) !== item.observationDigest ||
        observation.decision.id !== decision.id ||
        observation.decision.digest !== decision.digest ||
        observation.subject.kind !== lineage.subject.kind ||
        observation.subject.id !== lineage.subject.id ||
        observation.subject.subjectDigest !== item.subjectDigest ||
        observation.targets.length !== 1 ||
        observation.targets[0] !== lineage.target ||
        observation.allowedEffects.length !== 1 ||
        observation.allowedEffects[0] !== lineage.effect ||
        observation.integration.mode !== lineage.integration.mode ||
        observation.integration.owner !== lineage.integration.owner
      )
        return undefined;
      return {
        authorityReceiptDigest: item.authorityReceiptDigest,
        decision: { id: decision.id, digest: decision.digest },
        lineage,
        manifestDigest: item.manifestDigest,
        observation,
        ...(previous === undefined ? {} : { previousRecordDigest: previous }),
        recordDigest: expectedDigest,
        sequence: item.sequence,
        state: "observed-effective",
        subject: observation.subject,
        subjectDigest: item.subjectDigest,
      };
    } catch {
      return undefined;
    }
  }
  if (
    !exactKeys(
      item,
      [
        "authorityReceiptDigest",
        "decision",
        "format",
        "lineage",
        "previousRecordDigest",
        "revocation",
        "sequence",
        "state",
        "subjectDigest",
        "version",
      ].filter((key) => key !== "previousRecordDigest" || previous !== undefined),
    )
  )
    return undefined;
  try {
    const revocation = parseGovernanceDecisionRevocationV2(item.revocation);
    if (revocation.decisionDigest !== decision.digest) return undefined;
    return {
      authorityReceiptDigest: item.authorityReceiptDigest,
      decision: { id: decision.id, digest: decision.digest },
      lineage,
      ...(previous === undefined ? {} : { previousRecordDigest: previous }),
      recordDigest: expectedDigest,
      revocation,
      sequence: item.sequence,
      state: "decision-revoked",
      subject: lineage.subject,
      subjectDigest: item.subjectDigest,
    };
  } catch {
    return undefined;
  }
}

function verifyHistory(
  root: string,
  head: Head,
  lineage: Lineage,
): UpstreamArtifactLifecycleStoredStateV1[] | undefined {
  const directory = resolve(root, ...STORE, "records", lineage.digest.slice("sha256:".length));
  const directoryStat = safeLstat(directory);
  if (
    directoryStat === undefined ||
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    !safeParent(root, join(directory, "entry"))
  )
    return undefined;
  const entries = boundedDirectoryEntries(directory, MAX_RECORDS_PER_LINEAGE);
  if (typeof entries === "string") return undefined;
  if (
    entries.length === 0 ||
    entries.some((entry) => !entry.file || !/^[0-9a-f]{64}\.json$/.test(entry.name))
  )
    return undefined;
  const expectedFiles = new Set(entries.map((entry) => entry.name));
  const newestFirst: UpstreamArtifactLifecycleStoredStateV1[] = [];
  let digest = head.recordDigest;
  let sequence = head.sequence;
  for (let count = 0; count < MAX_RECORDS_PER_LINEAGE; count += 1) {
    const existing = readStoreFile(root, recordPath(lineage, digest));
    if (typeof existing === "string") return undefined;
    const record = parseRecord(existing, lineage, digest);
    if (record === undefined || record.sequence !== sequence) return undefined;
    if (!expectedFiles.delete(`${digest.slice("sha256:".length)}.json`)) return undefined;
    newestFirst.push(record);
    if (record.previousRecordDigest === undefined)
      return sequence === 1 && expectedFiles.size === 0 ? newestFirst.reverse() : undefined;
    digest = record.previousRecordDigest;
    sequence -= 1;
  }
  return undefined;
}

function historyAssertions(
  root: string,
  lineage: Lineage,
  history: readonly UpstreamArtifactLifecycleStoredStateV1[],
): readonly FileAssertion[] | undefined {
  const assertions: FileAssertion[] = [];
  for (const record of history) {
    const existing = readStoreFile(root, recordPath(lineage, record.recordDigest));
    if (typeof existing === "string") return undefined;
    if (parseRecord(existing, lineage, record.recordDigest) === undefined) return undefined;
    assertions.push({
      path: recordPath(lineage, record.recordDigest).join("/"),
      sha256: existing.sha256,
      maxBytes: MAX_STORE_FILE_BYTES,
      describe: "assert prior upstream artifact lifecycle record remains exact",
    });
  }
  return assertions;
}

function listHeadFiles(root: string): readonly string[] | "absent" | "unsafe" | "over-capacity" {
  const directory = resolve(root, ...STORE, "heads");
  const stat = safeLstat(directory);
  if (stat === undefined) return "absent";
  if (!safeParent(root, join(directory, "entry")) || stat.isSymbolicLink() || !stat.isDirectory())
    return "unsafe";
  try {
    const entries = boundedDirectoryEntries(directory, MAX_HEADS * 2);
    if (typeof entries === "string") return entries;
    if (entries.some((entry) => !entry.file)) return "unsafe";
    const primary = entries
      .map((entry) => entry.name)
      .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
      .sort();
    const allowed = new Set(primary.flatMap((name) => [name, `${name}.aih.bak`]));
    if (entries.some((entry) => !allowed.has(entry.name))) return "unsafe";
    if (primary.length > MAX_HEADS) return "over-capacity";
    return primary;
  } catch {
    return "unsafe";
  }
}

function listClaimFiles(root: string): readonly string[] | "absent" | "unsafe" | "over-capacity" {
  const directory = resolve(root, ...STORE, "claims");
  const stat = safeLstat(directory);
  if (stat === undefined) return "absent";
  if (!safeParent(root, join(directory, "entry")) || stat.isSymbolicLink() || !stat.isDirectory())
    return "unsafe";
  try {
    const entries = boundedDirectoryEntries(directory, MAX_HEADS);
    if (typeof entries === "string") return entries;
    if (entries.some((entry) => !entry.file || !/^[0-9a-f]{64}\.json$/.test(entry.name)))
      return "unsafe";
    if (entries.length > MAX_HEADS) return "over-capacity";
    return entries.map((entry) => entry.name).sort();
  } catch {
    return "unsafe";
  }
}

function listRecordPartitions(
  root: string,
): readonly string[] | "absent" | "unsafe" | "over-capacity" {
  const directory = resolve(root, ...STORE, "records");
  const stat = safeLstat(directory);
  if (stat === undefined) return "absent";
  if (!safeParent(root, join(directory, "entry")) || stat.isSymbolicLink() || !stat.isDirectory())
    return "unsafe";
  try {
    const entries = boundedDirectoryEntries(directory, MAX_HEADS);
    if (typeof entries === "string") return entries;
    if (entries.some((entry) => !entry.directory || !/^[0-9a-f]{64}$/.test(entry.name)))
      return "unsafe";
    if (entries.length > MAX_HEADS) return "over-capacity";
    return entries.map((entry) => entry.name).sort();
  } catch {
    return "unsafe";
  }
}

function validHeadBackup(
  root: string,
  name: string,
  head: Head,
  lineage: Lineage,
  history: readonly UpstreamArtifactLifecycleStoredStateV1[],
): boolean {
  const backup = readStoreFile(root, [...STORE, "heads", `${name}.aih.bak`]);
  if (backup === "absent") return true;
  if (typeof backup === "string") return false;
  const prior = parseHead(backup, lineage);
  const expected = history.at(-2);
  return (
    prior !== undefined &&
    expected !== undefined &&
    prior.lineageDigest === head.lineageDigest &&
    prior.sequence + 1 === head.sequence &&
    prior.sequence === expected.sequence &&
    prior.recordDigest === expected.recordDigest &&
    prior.subjectDigest === expected.subjectDigest
  );
}

interface Capacity {
  readonly existing: Existing | "absent";
  readonly headCount: number;
  readonly recordCount: number;
}

function currentCapacity(root: string): Capacity | "unsafe" | "corrupt" | "over-capacity" {
  const heads = listHeadFiles(root);
  if (heads === "unsafe") return "unsafe";
  if (heads === "over-capacity") return "over-capacity";
  let recordCount = 0;
  for (const head of heads === "absent" ? [] : heads) {
    const lineageHex = head.slice(0, -".json".length);
    const directory = resolve(root, ...STORE, "records", lineageHex);
    const stat = safeLstat(directory);
    if (
      stat === undefined ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !safeParent(root, join(directory, "entry"))
    )
      return "unsafe";
    const entries = boundedDirectoryEntries(directory, MAX_RECORDS_PER_LINEAGE);
    if (entries === "unsafe") return "unsafe";
    if (entries === "over-capacity") return "over-capacity";
    if (
      entries.length === 0 ||
      entries.some((entry) => !entry.file || !/^[0-9a-f]{64}\.json$/.test(entry.name))
    )
      return "corrupt";
    recordCount += entries.length;
    if (recordCount > MAX_RECORDS) return "over-capacity";
  }
  const headCount = heads === "absent" ? 0 : heads.length;
  const capacity = readStoreFile(root, [...STORE, "capacity.json"]);
  if (capacity === "unsafe") return "unsafe";
  if (capacity === "corrupt") return "corrupt";
  if (capacity === "absent") {
    return headCount === 0 && recordCount === 0
      ? { existing: "absent", headCount, recordCount }
      : "corrupt";
  }
  const item = parseObject(capacity);
  if (
    item === undefined ||
    !exactKeys(item, ["format", "headCount", "recordCount", "version"]) ||
    item.format !== "aih-upstream-artifact-lifecycle-capacity" ||
    item.version !== 1 ||
    item.headCount !== headCount ||
    item.recordCount !== recordCount
  )
    return "corrupt";
  return { existing: capacity, headCount, recordCount };
}

export function readUpstreamArtifactLifecycleStoreV1(
  root: string,
): UpstreamArtifactLifecycleStoreReadV1 {
  const base = resolve(root, ...STORE);
  const baseStat = safeLstat(base);
  if (baseStat === undefined) return { kind: "absent" };
  if (
    baseStat.isSymbolicLink() ||
    !baseStat.isDirectory() ||
    !safeParent(root, join(base, "entry"))
  )
    return { kind: "unsafe" };
  const capacity = currentCapacity(root);
  if (capacity === "unsafe") return { kind: "unsafe" };
  if (capacity === "corrupt") return { kind: "corrupt" };
  if (capacity === "over-capacity") return { kind: "over-capacity" };
  const heads = listHeadFiles(root);
  if (heads === "unsafe") return { kind: "unsafe" };
  if (heads === "over-capacity") return { kind: "over-capacity" };
  const claims = listClaimFiles(root);
  if (claims === "unsafe") return { kind: "unsafe" };
  if (claims === "over-capacity") return { kind: "over-capacity" };
  const partitions = listRecordPartitions(root);
  if (partitions === "unsafe") return { kind: "unsafe" };
  if (partitions === "over-capacity") return { kind: "over-capacity" };
  if (heads === "absent") {
    return capacity.existing === "absent" &&
      (claims === "absent" || claims.length === 0) &&
      (partitions === "absent" || partitions.length === 0)
      ? { kind: "absent" }
      : { kind: "corrupt" };
  }
  if (claims === "absent" || partitions === "absent") return { kind: "corrupt" };
  const expectedPartitions = heads.map((name) => name.slice(0, -".json".length)).sort();
  if (canonical(partitions) !== canonical(expectedPartitions)) return { kind: "corrupt" };
  const records: UpstreamArtifactLifecycleStoredStateV1[] = [];
  for (const name of heads) {
    const existingHead = readStoreFile(root, [...STORE, "heads", name]);
    if (typeof existingHead === "string")
      return { kind: existingHead === "unsafe" ? "unsafe" : "corrupt" };
    const item = parseObject(existingHead);
    const lineageDigest = item?.lineageDigest;
    if (typeof lineageDigest !== "string" || !SHA256.test(lineageDigest))
      return { kind: "corrupt" };
    const recordDirectory = resolve(root, ...STORE, "records", lineageDigest.slice(7));
    const recordEntries = safeLstat(recordDirectory);
    if (
      recordEntries === undefined ||
      recordEntries.isSymbolicLink() ||
      !recordEntries.isDirectory()
    )
      return { kind: "unsafe" };
    const recordDirectoryEntries = boundedDirectoryEntries(
      recordDirectory,
      MAX_RECORDS_PER_LINEAGE,
    );
    if (recordDirectoryEntries === "unsafe") return { kind: "unsafe" };
    if (recordDirectoryEntries === "over-capacity") return { kind: "over-capacity" };
    const firstRecordFile = recordDirectoryEntries[0];
    if (firstRecordFile === undefined) return { kind: "corrupt" };
    const firstExisting = readStoreFile(root, [
      ...STORE,
      "records",
      lineageDigest.slice(7),
      firstRecordFile.name,
    ]);
    if (typeof firstExisting === "string")
      return { kind: firstExisting === "unsafe" ? "unsafe" : "corrupt" };
    const firstItem = parseObject(firstExisting);
    const lineage = parseLineage(firstItem?.lineage);
    if (lineage === undefined || lineage.digest !== lineageDigest) return { kind: "corrupt" };
    const head = parseHead(existingHead, lineage);
    if (head === undefined) return { kind: "corrupt" };
    const history = verifyHistory(root, head, lineage);
    if (history === undefined) return { kind: "corrupt" };
    if (!validHeadBackup(root, name, head, lineage, history)) return { kind: "corrupt" };
    const latest = history.at(-1);
    if (latest === undefined || latest.subjectDigest !== head.subjectDigest)
      return { kind: "corrupt" };
    records.push(latest);
  }
  records.sort((left, right) =>
    left.lineage.digest < right.lineage.digest
      ? -1
      : left.lineage.digest > right.lineage.digest
        ? 1
        : 0,
  );
  const expectedClaims = records.map((record) => `${claimKey(record.lineage)}.json`).sort();
  if (canonical(claims) !== canonical(expectedClaims)) return { kind: "corrupt" };
  for (const record of records) {
    const existing = readStoreFile(root, claimPath(record.lineage));
    if (typeof existing === "string") return { kind: existing === "unsafe" ? "unsafe" : "corrupt" };
    const claim = parseClaim(existing);
    if (claim === undefined || canonical(claim) !== canonical(record.lineage))
      return { kind: "corrupt" };
  }
  return records.length === 0 ? { kind: "absent" } : { kind: "complete", records };
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
    describe,
    ...(durable ? { durable: true as const } : {}),
    expect: existing === "absent" ? { absent: true as const } : { sha256: existing.sha256 },
  };
}

function refused(
  reason: UpstreamArtifactLifecycleResultV1["reason"],
): UpstreamArtifactLifecycleResultV1 {
  return { applied: false, outcome: "refused", reason, state: "refused" };
}

interface Prepared {
  readonly actions: readonly WriteAction[];
  readonly commitNotAfter?: string;
  readonly fileAssertions?: Plan["fileAssertions"];
  readonly expected?: {
    lineage: Lineage;
    recordDigest: string;
    headText: string;
    recordText: string;
    state: "decision-revoked" | "observed-effective";
  };
  readonly result: UpstreamArtifactLifecycleResultV1;
}

function requestedReference(
  ctx: PlanContext,
): { decision: string; digest: string; target: string } | undefined {
  const decision = ctx.options.decision;
  const digest = ctx.options.decisionDigest;
  const target = ctx.options.target;
  return typeof decision === "string" &&
    ID.test(decision) &&
    typeof digest === "string" &&
    SHA256.test(digest) &&
    typeof target === "string" &&
    ID.test(target)
    ? { decision, digest, target }
    : undefined;
}

async function prepareRevocation(ctx: PlanContext): Promise<Prepared> {
  const requested = requestedReference(ctx);
  if (requested === undefined) return { actions: [], result: refused("observation-unverified") };
  const verification = await verifyPolicyAuthorityReceipt(ctx);
  const authority = verification.authority;
  if (authority === undefined || authority.receipt.version !== 3)
    return { actions: [], result: refused("observation-unverified") };
  const now = Date.now();
  const decision = authority.receipt.decisions.find(
    (candidate) =>
      candidate.id === requested.decision &&
      governanceDecisionDigestV2(candidate) === requested.digest,
  );
  const revocation = authority.receipt.decisionRevocations.find(
    (candidate) =>
      candidate.decisionDigest === requested.digest && Date.parse(candidate.revokedAt) <= now,
  );
  if (
    decision === undefined ||
    revocation === undefined ||
    decision.issuer !== revocation.issuer ||
    now < Date.parse(decision.notBefore) ||
    now >= Date.parse(decision.expiresAt) ||
    (decision.disposition === "accepted-with-conditions" && now >= Date.parse(decision.reviewBy)) ||
    !decision.targets.includes(requested.target as never)
  )
    return { actions: [], result: refused("observation-unverified") };
  const store = readUpstreamArtifactLifecycleStoreV1(ctx.root);
  if (store.kind === "unsafe") return { actions: [], result: refused("store-unsafe") };
  if (store.kind === "corrupt") return { actions: [], result: refused("store-corrupt") };
  if (store.kind === "over-capacity")
    return { actions: [], result: refused("store-over-capacity") };
  if (store.kind === "absent") return { actions: [], result: refused("head-conflict") };
  if (store.kind !== "complete") return { actions: [], result: refused("store-corrupt") };
  const candidates = store.records.filter(
    (record) =>
      record.subject.kind === decision.subject.kind &&
      record.subject.id === decision.subject.id &&
      record.lineage.target === requested.target &&
      record.decision.digest === requested.digest &&
      decision.allowedEffects.includes(record.lineage.effect),
  );
  if (candidates.length !== 1) return { actions: [], result: refused("head-conflict") };
  const current = candidates[0];
  if (current === undefined) return { actions: [], result: refused("head-conflict") };
  if (current.state === "decision-revoked") {
    return {
      actions: [],
      result: {
        applied: false,
        outcome: "reported-only",
        state: "decision-revoked",
        recordDigest: current.recordDigest,
      },
    };
  }
  const lineage = current.lineage;
  const capacity = currentCapacity(ctx.root);
  if (capacity === "unsafe") return { actions: [], result: refused("store-unsafe") };
  if (capacity === "corrupt") return { actions: [], result: refused("store-corrupt") };
  if (capacity === "over-capacity" || capacity.recordCount >= MAX_RECORDS)
    return { actions: [], result: refused("store-over-capacity") };
  const claimParts = claimPath(lineage);
  const claim = readStoreFile(ctx.root, claimParts);
  if (typeof claim === "string")
    return { actions: [], result: refused(claim === "unsafe" ? "store-unsafe" : "store-corrupt") };
  const parsedClaim = parseClaim(claim);
  if (parsedClaim === undefined || canonical(parsedClaim) !== canonical(lineage))
    return { actions: [], result: refused("lineage-conflict") };
  const headParts = headPath(lineage);
  const existingHead = readStoreFile(ctx.root, headParts);
  if (typeof existingHead === "string")
    return {
      actions: [],
      result: refused(existingHead === "unsafe" ? "store-unsafe" : "head-conflict"),
    };
  const priorHead = parseHead(existingHead, lineage);
  const history = priorHead === undefined ? undefined : verifyHistory(ctx.root, priorHead, lineage);
  if (
    priorHead === undefined ||
    history === undefined ||
    history.at(-1)?.recordDigest !== current.recordDigest ||
    history.length >= MAX_RECORDS_PER_LINEAGE
  )
    return { actions: [], result: refused("head-conflict") };
  const priorRecordAssertions = historyAssertions(ctx.root, lineage, history);
  if (priorRecordAssertions === undefined) return { actions: [], result: refused("store-corrupt") };
  const sequence = priorHead.sequence + 1;
  const record = {
    authorityReceiptDigest: authority.receiptDigest,
    decision: { id: requested.decision, digest: requested.digest },
    format: "aih-upstream-artifact-lifecycle-record",
    lineage,
    previousRecordDigest: priorHead.recordDigest,
    revocation,
    sequence,
    state: "decision-revoked" as const,
    subjectDigest: decision.subject.subjectDigest,
    version: 1,
  };
  const recordDigest = digestOf("aih-upstream-artifact-lifecycle-record/v1", record);
  const recordParts = recordPath(lineage, recordDigest);
  const existingRecord = readStoreFile(ctx.root, recordParts);
  if (existingRecord !== "absent")
    return {
      actions: [],
      result: refused(existingRecord === "unsafe" ? "store-unsafe" : "head-conflict"),
    };
  const recordText = canonical(record);
  const headText = canonical({
    format: "aih-upstream-artifact-lifecycle-head",
    lineageDigest: lineage.digest,
    recordDigest,
    sequence,
    subjectDigest: decision.subject.subjectDigest,
    version: 1,
  });
  const capacityText = canonical({
    format: "aih-upstream-artifact-lifecycle-capacity",
    headCount: capacity.headCount,
    recordCount: capacity.recordCount + 1,
    version: 1,
  });
  const authorityAssertion = verifiedPolicyAuthorityReceiptAssertionV1(authority);
  if (authorityAssertion === undefined)
    return { actions: [], result: refused("observation-unverified") };
  const commitNotAfter = new Date(
    Math.min(
      Date.parse(authority.receipt.expiresAt),
      Date.parse(decision.expiresAt),
      now + COMMIT_WINDOW_MS,
    ),
  ).toISOString();
  return {
    actions: [
      {
        ...staged(
          recordParts.join("/"),
          recordText,
          "absent",
          "append immutable upstream artifact revocation record",
          true,
        ),
        once: true,
      },
      pin(claimParts.join("/"), claim, "assert upstream artifact lifecycle lineage unchanged"),
      staged(
        headParts.join("/"),
        headText,
        existingHead,
        "advance upstream artifact lifecycle head after revocation record",
        true,
      ),
      staged(
        [...STORE, "capacity.json"].join("/"),
        capacityText,
        capacity.existing,
        "advance upstream artifact lifecycle capacity guard",
        true,
      ),
    ],
    commitNotAfter,
    fileAssertions: [authorityAssertion, ...priorRecordAssertions],
    expected: { lineage, recordDigest, headText, recordText, state: "decision-revoked" },
    result: {
      applied: false,
      outcome: "reported-only",
      state: "decision-revoked",
      recordDigest,
    },
  };
}

function preparedResult(
  root: string,
  prepared: Prepared,
  apply: boolean,
): UpstreamArtifactLifecycleResultV1 {
  if (!apply || prepared.expected === undefined) return prepared.result;
  const expected = prepared.expected;
  const head = readStoreFile(root, headPath(expected.lineage));
  const record = readStoreFile(root, recordPath(expected.lineage, expected.recordDigest));
  const store = readUpstreamArtifactLifecycleStoreV1(root);
  if (store.kind !== "complete") {
    return refused(
      store.kind === "unsafe"
        ? "store-unsafe"
        : store.kind === "over-capacity"
          ? "store-over-capacity"
          : "store-corrupt",
    );
  }
  const current = store.records.find(
    (candidate) => candidate.lineage.digest === expected.lineage.digest,
  );
  return current !== undefined &&
    current.recordDigest === expected.recordDigest &&
    current.state === expected.state &&
    typeof head !== "string" &&
    typeof record !== "string" &&
    head.text === expected.headText &&
    record.text === expected.recordText
    ? {
        applied: true,
        outcome: expected.state === "decision-revoked" ? "reported-only" : "fulfilled",
        state: expected.state,
        recordDigest: expected.recordDigest,
      }
    : refused("head-conflict");
}

async function prepare(ctx: PlanContext): Promise<Prepared> {
  const observation = await observeUpstreamArtifactV1({ ...ctx, apply: false });
  if (observation.reason === "decision-revoked") return prepareRevocation(ctx);
  if (observation.outcome !== "observed-effective")
    return {
      actions: [],
      result: refused(observation.reason ?? "observation-unverified"),
    };
  const handoff = upstreamArtifactObservationHandoffForLifecycleV1(observation);
  if (handoff === undefined) return { actions: [], result: refused("observation-unverified") };
  const lineage = lineageFromReceipt(handoff.receipt);
  if (lineage === undefined) return { actions: [], result: refused("observation-unverified") };

  const capacity = currentCapacity(ctx.root);
  if (capacity === "unsafe") return { actions: [], result: refused("store-unsafe") };
  if (capacity === "corrupt") return { actions: [], result: refused("store-corrupt") };
  if (capacity === "over-capacity") return { actions: [], result: refused("store-over-capacity") };
  const currentStore = readUpstreamArtifactLifecycleStoreV1(ctx.root);
  if (
    (capacity.headCount === 0 && currentStore.kind !== "absent") ||
    (capacity.headCount > 0 && currentStore.kind !== "complete")
  ) {
    return {
      actions: [],
      result: refused(
        currentStore.kind === "unsafe"
          ? "store-unsafe"
          : currentStore.kind === "over-capacity"
            ? "store-over-capacity"
            : "store-corrupt",
      ),
    };
  }

  const claimParts = claimPath(lineage);
  const claim = readStoreFile(ctx.root, claimParts);
  if (claim === "unsafe") return { actions: [], result: refused("store-unsafe") };
  if (claim === "corrupt") return { actions: [], result: refused("store-corrupt") };
  if (claim !== "absent") {
    const current = parseClaim(claim);
    if (current === undefined || canonical(current) !== canonical(lineage))
      return { actions: [], result: refused("lineage-conflict") };
  }
  const headParts = headPath(lineage);
  const existingHead = readStoreFile(ctx.root, headParts);
  if (existingHead === "unsafe") return { actions: [], result: refused("store-unsafe") };
  if (existingHead === "corrupt") return { actions: [], result: refused("store-corrupt") };
  const priorHead = existingHead === "absent" ? undefined : parseHead(existingHead, lineage);
  if (existingHead !== "absent" && priorHead === undefined)
    return { actions: [], result: refused("head-conflict") };
  const history = priorHead === undefined ? [] : verifyHistory(ctx.root, priorHead, lineage);
  if (history === undefined) return { actions: [], result: refused("head-conflict") };
  const priorRecordAssertions = historyAssertions(ctx.root, lineage, history);
  if (priorRecordAssertions === undefined) return { actions: [], result: refused("store-corrupt") };
  if (history.length >= MAX_RECORDS_PER_LINEAGE)
    return { actions: [], result: refused("store-over-capacity") };

  const observationDigest = upstreamObservationReceiptDigestV1(handoff.receipt);
  const latest = history.at(-1);
  if (
    latest !== undefined &&
    latest.subjectDigest !== handoff.receipt.subject.subjectDigest &&
    history.some(
      (record) =>
        record.subjectDigest === handoff.receipt.subject.subjectDigest ||
        record.decision.digest === handoff.receipt.decision.digest,
    )
  )
    return { actions: [], result: refused("head-conflict") };
  if (
    latest?.state === "observed-effective" &&
    latest.observation !== undefined &&
    upstreamObservationReceiptDigestV1(latest.observation) === observationDigest
  ) {
    return {
      actions: [],
      result: {
        applied: false,
        outcome: "fulfilled",
        state: "observed-effective",
        recordDigest: latest.recordDigest,
      },
    };
  }

  const sequence = (priorHead?.sequence ?? 0) + 1;
  const record = {
    authorityReceiptDigest: handoff.authorityReceiptDigest,
    decision: handoff.receipt.decision,
    format: "aih-upstream-artifact-lifecycle-record",
    lineage,
    manifestDigest: handoff.manifestDigest,
    observation: handoff.receipt,
    observationDigest,
    ...(priorHead === undefined ? {} : { previousRecordDigest: priorHead.recordDigest }),
    sequence,
    state: "observed-effective" as const,
    subjectDigest: handoff.receipt.subject.subjectDigest,
    version: 1,
  };
  const recordDigest = digestOf("aih-upstream-artifact-lifecycle-record/v1", record);
  const recordParts = recordPath(lineage, recordDigest);
  const existingRecord = readStoreFile(ctx.root, recordParts);
  if (existingRecord === "unsafe") return { actions: [], result: refused("store-unsafe") };
  if (existingRecord === "corrupt") return { actions: [], result: refused("store-corrupt") };
  if (existingRecord !== "absent") return { actions: [], result: refused("head-conflict") };
  const recordText = canonical(record);
  const claimText = canonical({
    format: "aih-upstream-artifact-lifecycle-claim",
    lineage,
    version: 1,
  });
  const headText = canonical({
    format: "aih-upstream-artifact-lifecycle-head",
    lineageDigest: lineage.digest,
    recordDigest,
    sequence,
    subjectDigest: handoff.receipt.subject.subjectDigest,
    version: 1,
  });
  const nextHeadCount = capacity.headCount + (priorHead === undefined ? 1 : 0);
  const nextRecordCount = capacity.recordCount + 1;
  if (nextHeadCount > MAX_HEADS || nextRecordCount > MAX_RECORDS)
    return { actions: [], result: refused("store-over-capacity") };
  const capacityText = canonical({
    format: "aih-upstream-artifact-lifecycle-capacity",
    headCount: nextHeadCount,
    recordCount: nextRecordCount,
    version: 1,
  });
  const actions: WriteAction[] = [
    {
      ...staged(
        recordParts.join("/"),
        recordText,
        "absent",
        "append immutable upstream artifact lifecycle record",
        true,
      ),
      once: true,
    },
    claim === "absent"
      ? {
          ...staged(
            claimParts.join("/"),
            claimText,
            "absent",
            "claim upstream artifact lifecycle lineage",
            true,
          ),
          once: true,
        }
      : pin(claimParts.join("/"), claim, "assert upstream artifact lifecycle lineage unchanged"),
    staged(
      headParts.join("/"),
      headText,
      existingHead,
      "advance upstream artifact lifecycle head after immutable record",
      true,
    ),
    staged(
      [...STORE, "capacity.json"].join("/"),
      capacityText,
      capacity.existing,
      "advance upstream artifact lifecycle capacity guard",
      true,
    ),
  ];
  const commitNotAfter = new Date(
    Math.min(Date.parse(handoff.receipt.validUntil), Date.now() + COMMIT_WINDOW_MS),
  ).toISOString();
  return {
    actions,
    commitNotAfter,
    fileAssertions: [...handoff.fileAssertions, ...priorRecordAssertions],
    expected: { lineage, recordDigest, headText, recordText, state: "observed-effective" },
    result: { applied: false, outcome: "reported-only", state: "observed-effective", recordDigest },
  };
}

function check(result: UpstreamArtifactLifecycleResultV1): Check {
  // Revocation is durable lifecycle truth, never effective permission.
  if (result.state === "decision-revoked") {
    return {
      name: "policy lifecycle upstream-artifact",
      verdict: "fail",
      code: "org-policy.lifecycle-decision-revoked",
      detail: "policy lifecycle upstream-artifact decision-revoked",
    };
  }
  return result.outcome === "fulfilled" || result.outcome === "reported-only"
    ? {
        name: "policy lifecycle upstream-artifact",
        verdict: "pass",
        detail: `policy lifecycle upstream-artifact ${result.state}`,
      }
    : {
        name: "policy lifecycle upstream-artifact",
        verdict: "fail",
        code: "org-policy.lifecycle-observation-invalid",
        detail: `policy lifecycle upstream-artifact ${result.reason ?? "observation-unverified"}`,
      };
}

function planFrom(ctx: PlanContext, prepared: Prepared): Plan {
  let cached: UpstreamArtifactLifecycleResultV1 | undefined;
  const result = () => (cached ??= preparedResult(ctx.root, prepared, ctx.apply));
  const built = plan(
    "policy lifecycle upstream-artifact",
    ...prepared.actions,
    dynamicDigest("policy lifecycle upstream-artifact", () => {
      const value = result();
      return { text: JSON.stringify(value), data: value };
    }),
    probe("policy lifecycle upstream-artifact", () => check(result())),
  );
  return {
    ...built,
    ...(prepared.commitNotAfter === undefined ? {} : { commitNotAfter: prepared.commitNotAfter }),
    commitLock: COMMIT_LOCK,
    ...(prepared.fileAssertions === undefined ? {} : { fileAssertions: prepared.fileAssertions }),
  };
}

export async function upstreamArtifactLifecyclePlan(ctx: PlanContext): Promise<Plan> {
  return planFrom(ctx, await prepare(ctx));
}

export const upstreamArtifactLifecycleCommand: CommandSpec = {
  name: "upstream-artifact",
  summary:
    "Preview or persist durable history for exact organization-managed artifact observations",
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
    {
      flags: "--manifest <path>",
      description: "root-relative evidence-bound manifest path (required)",
    },
  ],
  plan: upstreamArtifactLifecyclePlan,
};
