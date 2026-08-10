import { createHash } from "node:crypto";
import { type BigIntStats, closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isProxy } from "node:util/types";
import { inspectContainedRelativePath } from "../../internals/contained-path.js";
import { readBoundedFileDescriptor } from "../../internals/fsxn.js";
import { AIH_ORG_POLICY_FILE } from "../../org-policy/constants.js";
import { resolveEffectiveOrgPolicy } from "../../org-policy/effective.js";
import { parseOrgPolicy } from "../../org-policy/schema.js";
import { AIH_PACKS_FILE, PacksFileSchema } from "../../pack/manifest.js";
import { SkillCardSchema } from "../../skill/card.js";
import { readSkillsLockExact } from "../../skill/lockfile.js";
import { readTrustLockExact } from "../../trust/lock.js";
import { adaptSkillPackageGraph } from "../package-graph/adapters/skills.js";
import {
  buildPackageGraphIndex,
  type PackageGraphIndex,
  type PackageGraphPackageClaim,
} from "../package-graph/build.js";
import { codeUnitCompare } from "../package-graph/canonical.js";
import { PackageIdSchema } from "../package-graph/schema.js";
import { planSkillPackCustody } from "./domains/skill-pack-custody.js";
import { readCapabilityPackageIntent } from "./intent.js";
import { planCapabilityPackageLifecycle } from "./lifecycle.js";
import { readCapabilityPackageOwnershipReceipt } from "./receipt.js";
import { type CapabilityPackageManifest, CapabilityPackageManifestSchema } from "./schema.js";

const MAX_AUTHORITY_BYTES = 8 * 1024 * 1024;
const OPERATIONS = new Set(["list", "show", "status", "doctor", "add", "update", "remove"]);

export type CapabilityPackageContextOperation =
  | "list"
  | "show"
  | "status"
  | "doctor"
  | "add"
  | "update"
  | "remove";

export interface CapabilityPackageContextInput {
  root: string;
  contextDir: string;
  operation: CapabilityPackageContextOperation;
  packageId?: string;
}

export interface CapabilityPackageRefusal {
  stage:
    | "input"
    | "policy"
    | "approval"
    | "evidence"
    | "catalog"
    | "package-graph"
    | "receipt"
    | "resolution"
    | "skill-pack"
    | "intent"
    | "ownership"
    | "custody"
    | "domain"
    | "operation";
  reason: string;
}

export interface CapabilityPackageSourceState {
  state: "absent" | "valid" | "malformed" | "unowned" | "verified-existing" | "not-applicable";
  sha256?: string;
}

export interface CapabilityPackageView {
  id: string;
  description?: string;
  authority: string;
  members: string[];
  requested: boolean;
  owned: boolean;
  lifecycle: "add" | "update" | "remove" | "unchanged" | "available";
}

export interface CapabilityPackagePreview {
  operation: "add" | "update" | "remove";
  packageId: string;
  writes: 0;
  acquisition: false;
  network: false;
  processExecution: false;
  componentLoading: false;
  policyChangeRequired: boolean;
  changes: { add: string[]; update: string[]; remove: string[]; unchanged: string[] };
}

export interface CapabilityPackageContextReport {
  schemaVersion: 1;
  operation: CapabilityPackageContextOperation;
  requestedRoots: string[];
  packages: CapabilityPackageView[];
  sources: {
    policy: CapabilityPackageSourceState;
    approval: CapabilityPackageSourceState;
    evidence: CapabilityPackageSourceState;
    catalog: CapabilityPackageSourceState;
    packageGraph: CapabilityPackageSourceState;
    intent: CapabilityPackageSourceState;
    resolution: CapabilityPackageSourceState;
    ownership: CapabilityPackageSourceState;
    custody: CapabilityPackageSourceState;
    domain: CapabilityPackageSourceState;
  };
  refusals: CapabilityPackageRefusal[];
  healthy: boolean;
  preview?: CapabilityPackagePreview;
}

export interface CapabilityPackageExactBytes {
  bytes: Buffer;
  sha256: string;
}

function digestBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeParents(root: string, path: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting authority path controls is the point
  const unsafePath = /[\\:\u0000-\u001f\u007f]/;
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    unsafePath.test(path) ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return false;
  }
  try {
    const rootStats = lstatSync(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return false;
    const segments = path.split("/");
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      const stats = lstatSync(parent);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

function currentFile(root: string, path: string, realPath: string, opened: BigIntStats): boolean {
  if (!safeParents(root, path)) return false;
  const current = inspectContainedRelativePath(root, path);
  if (current.state !== "present" || current.kind !== "file" || current.realPath !== realPath) {
    return false;
  }
  try {
    const stats = lstatSync(realPath, { bigint: true });
    return stats.isFile() && stats.nlink === 1n && sameFile(opened, stats);
  } catch {
    return false;
  }
}

export function readCapabilityPackageExactFile(
  root: string,
  path: string,
): CapabilityPackageExactBytes | undefined {
  if (!safeParents(root, path)) return undefined;
  const inspected = inspectContainedRelativePath(root, path);
  if (inspected.state !== "present" || inspected.kind !== "file") return undefined;
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const nonblock = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = openSync(inspected.realPath, constants.O_RDONLY | noFollow | nonblock);
  } catch {
    return undefined;
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.ino === 0n ||
      opened.nlink !== 1n ||
      opened.size > BigInt(MAX_AUTHORITY_BYTES) ||
      !currentFile(root, path, inspected.realPath, opened)
    ) {
      return undefined;
    }
    const contents = readBoundedFileDescriptor(descriptor, MAX_AUTHORITY_BYTES);
    if (contents === undefined) return undefined;
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !sameFile(opened, after) ||
      after.nlink !== opened.nlink ||
      after.mode !== opened.mode ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      !currentFile(root, path, inspected.realPath, opened)
    ) {
      return undefined;
    }
    const bytes = Buffer.from(contents);
    return { bytes, sha256: digestBytes(bytes) };
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // A close failure cannot turn unverified bytes into authority.
    }
  }
}

function fatalJson(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function snapshotInput(input: unknown): CapabilityPackageContextInput | undefined {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      isProxy(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null) ||
      Object.getOwnPropertySymbols(input).length > 0
    ) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const allowed = new Set(["root", "contextDir", "operation", "packageId"]);
    if (Object.keys(descriptors).some((name) => !allowed.has(name))) return undefined;
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) return undefined;
    }
    const root = descriptors.root?.value;
    const contextDir = descriptors.contextDir?.value;
    const operation = descriptors.operation?.value;
    const packageId = descriptors.packageId?.value;
    if (
      typeof root !== "string" ||
      !isAbsolute(root) ||
      typeof contextDir !== "string" ||
      contextDir.length === 0 ||
      typeof operation !== "string" ||
      !OPERATIONS.has(operation) ||
      (packageId !== undefined &&
        (typeof packageId !== "string" || !PackageIdSchema.safeParse(packageId).success))
    ) {
      return undefined;
    }
    return {
      root,
      contextDir,
      operation: operation as CapabilityPackageContextOperation,
      ...(packageId === undefined ? {} : { packageId }),
    };
  } catch {
    return undefined;
  }
}

function emptyReport(operation: CapabilityPackageContextOperation): CapabilityPackageContextReport {
  return {
    schemaVersion: 1,
    operation,
    requestedRoots: [],
    packages: [],
    sources: {
      policy: { state: "absent" },
      approval: { state: "absent" },
      evidence: { state: "absent" },
      catalog: { state: "absent" },
      packageGraph: { state: "absent" },
      intent: { state: "absent" },
      resolution: { state: "absent" },
      ownership: { state: "absent" },
      custody: { state: "unowned" },
      domain: { state: "absent" },
    },
    refusals: [],
    healthy: false,
  };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) freeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}

export function capabilityPackageManifestFor(
  index: PackageGraphIndex,
  roots: readonly string[],
): CapabilityPackageManifest {
  const rootSet = new Set(roots);
  const packageClaims = index.claims
    .filter(
      (claim): claim is PackageGraphPackageClaim =>
        claim.entityKind === "package" && rootSet.has(claim.id),
    )
    .sort((left, right) => codeUnitCompare(left.id, right.id));
  const authorityIds = new Set(packageClaims.map(({ authorityId }) => authorityId));
  return CapabilityPackageManifestSchema.parse({
    schemaVersion: 1,
    authorities: index.authorities
      .filter(({ id }) => authorityIds.has(id))
      .map((authority) => ({
        id: authority.id,
        kind: authority.kind,
        sourceDigest: { ...authority.sourceDigest },
        projectionDigest: authority.projectionDigest,
      })),
    roots: [...roots].sort(codeUnitCompare),
    packages: packageClaims.map((claim) => ({
      kind: "package",
      id: claim.id,
      authorityId: claim.authorityId,
      claimDigest: claim.claimDigest,
      sourceDigest: { ...claim.entity.sourceDigest },
      dependencies: [],
      members: [...claim.entity.members].sort(codeUnitCompare),
    })),
  });
}

export function capabilityPackageManifestBytes(manifest: CapabilityPackageManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function exactEvidence(
  root: string,
  contextDir: string,
  lock: Extract<ReturnType<typeof readSkillsLockExact>, { state: "valid" }>["lock"],
  memberIds: readonly string[],
): { state: "valid"; sha256: string } | { state: "malformed"; reason: string } {
  const evidenceDigests: string[] = [];
  for (const memberId of memberIds) {
    if (!memberId.startsWith("skill:")) {
      return { state: "malformed", reason: "unsupported-evidence-member" };
    }
    const name = memberId.slice("skill:".length);
    const matches = lock.skills.filter((entry) => entry.name === name);
    if (matches.length !== 1) return { state: "malformed", reason: "missing-skill-approval" };
    const entry = matches[0];
    if (entry === undefined || entry.card !== `${contextDir}/skill-cards/${name}.json`) {
      return { state: "malformed", reason: "invalid-skill-card-binding" };
    }
    const cardSource = readCapabilityPackageExactFile(root, entry.card);
    if (cardSource === undefined)
      return { state: "malformed", reason: "missing-or-unsafe-skill-card" };
    let card: ReturnType<typeof SkillCardSchema.parse>;
    try {
      card = SkillCardSchema.strict().parse(fatalJson(cardSource.bytes));
    } catch {
      return { state: "malformed", reason: "invalid-skill-card" };
    }
    if (
      card.name !== entry.name ||
      card.source !== entry.source ||
      card.commit !== entry.commit ||
      card.approval?.verdict !== entry.verdict ||
      card.approval.approvedBy !== entry.approvedBy ||
      card.approval.approvedAt !== entry.approvedAt ||
      card.scanEvidence.length !== 1
    ) {
      return { state: "malformed", reason: "skill-card-approval-mismatch" };
    }
    const evidenceSource = readCapabilityPackageExactFile(root, card.scanEvidence[0] ?? "");
    if (evidenceSource === undefined)
      return { state: "malformed", reason: "missing-or-unsafe-evidence" };
    if (evidenceSource.sha256 !== entry.evidenceSha256) {
      return { state: "malformed", reason: "evidence-digest-mismatch" };
    }
    let evidence: unknown;
    try {
      evidence = fatalJson(evidenceSource.bytes);
    } catch {
      return { state: "malformed", reason: "invalid-evidence" };
    }
    if (
      evidence === null ||
      typeof evidence !== "object" ||
      Array.isArray(evidence) ||
      (evidence as Record<string, unknown>).schemaVersion !== 1 ||
      (evidence as Record<string, unknown>).source !== entry.source ||
      (evidence as Record<string, unknown>).verdict !== entry.verdict
    ) {
      return { state: "malformed", reason: "evidence-approval-mismatch" };
    }
    evidenceDigests.push(evidenceSource.sha256);
  }
  return {
    state: "valid",
    sha256: digestBytes(Buffer.from(evidenceDigests.sort(codeUnitCompare).join("\n"), "utf8")),
  };
}

function changeFor(
  lifecycle: ReturnType<typeof planCapabilityPackageLifecycle> | undefined,
  id: string,
): CapabilityPackageView["lifecycle"] {
  if (lifecycle === undefined || lifecycle.status === "refused") return "available";
  for (const key of ["add", "update", "remove", "unchanged"] as const) {
    if (lifecycle.changes[key].includes(id)) return key;
  }
  return "available";
}

function refusal(
  report: CapabilityPackageContextReport,
  stage: CapabilityPackageRefusal["stage"],
  reason: string,
): CapabilityPackageContextReport {
  report.refusals.push({ stage, reason });
  return freeze(report);
}

/** Assemble one exact, local, read-only view of policy-selected packages and their current state. */
export function inspectCapabilityPackageContext(input: unknown): CapabilityPackageContextReport {
  const snapshot = snapshotInput(input);
  const fallbackOperation = "doctor" as const;
  if (snapshot === undefined)
    return refusal(emptyReport(fallbackOperation), "input", "invalid-input");
  const report = emptyReport(snapshot.operation);

  const policySource = readCapabilityPackageExactFile(snapshot.root, AIH_ORG_POLICY_FILE);
  if (policySource === undefined) return refusal(report, "policy", "missing-or-unsafe-policy");
  let policy: ReturnType<typeof parseOrgPolicy>;
  try {
    policy = parseOrgPolicy(fatalJson(policySource.bytes));
  } catch {
    report.sources.policy = { state: "malformed" };
    return refusal(report, "policy", "invalid-policy");
  }
  report.sources.policy = { state: "valid", sha256: policySource.sha256 };
  const effective = resolveEffectiveOrgPolicy(policy);
  const selection = effective.capabilityPackages;
  if (selection === undefined) return refusal(report, "policy", "missing-package-selection");
  report.requestedRoots = [...selection.roots];
  report.sources.intent = { state: "valid", sha256: policySource.sha256 };

  const approval = readSkillsLockExact(snapshot.root);
  if (approval.state !== "valid") {
    report.sources.approval = { state: approval.state === "absent" ? "absent" : "malformed" };
    return refusal(
      report,
      "approval",
      approval.state === "absent" ? "missing-skills-lock" : "invalid-skills-lock",
    );
  }
  report.sources.approval = { state: "valid", sha256: approval.sourceSha256 };

  const catalogSource = readCapabilityPackageExactFile(snapshot.root, AIH_PACKS_FILE);
  if (catalogSource === undefined)
    return refusal(report, "catalog", "missing-or-unsafe-pack-catalog");
  let packs: ReturnType<typeof PacksFileSchema.parse>;
  try {
    packs = PacksFileSchema.parse(fatalJson(catalogSource.bytes));
  } catch {
    report.sources.catalog = { state: "malformed" };
    return refusal(report, "catalog", "invalid-pack-catalog");
  }
  report.sources.catalog = { state: "valid", sha256: catalogSource.sha256 };

  const projected = adaptSkillPackageGraph({
    lockBytes: approval.sourceBytes,
    packsBytes: catalogSource.bytes,
    lockAuthorityId: "lock:aih-skills",
    catalogAuthorityId: "catalog:aih-packs",
    hostSource: selection.catalog,
  });
  let index: PackageGraphIndex;
  try {
    index = buildPackageGraphIndex(projected.documents);
  } catch {
    report.sources.packageGraph = { state: "malformed" };
    return refusal(report, "package-graph", "invalid-authority-projection");
  }
  report.sources.packageGraph = { state: "valid" };
  if (projected.diagnostics.length > 0) {
    return refusal(
      report,
      "package-graph",
      projected.diagnostics[0]?.code ?? "invalid-authority-projection",
    );
  }

  const availableClaims = index.claims
    .filter((claim) => claim.entityKind === "package")
    .sort((left, right) => codeUnitCompare(left.id, right.id));
  const available = new Set(availableClaims.map(({ id }) => id));
  const evidence = exactEvidence(
    snapshot.root,
    snapshot.contextDir,
    approval.lock,
    [...new Set(availableClaims.flatMap((claim) => claim.entity.members))].sort(codeUnitCompare),
  );
  if (evidence.state === "malformed") {
    report.sources.evidence = { state: "malformed" };
    return refusal(report, "evidence", evidence.reason);
  }
  report.sources.evidence = { state: "valid", sha256: evidence.sha256 };
  const packageId = snapshot.packageId;
  if (
    (snapshot.operation === "show" ||
      snapshot.operation === "add" ||
      snapshot.operation === "update" ||
      snapshot.operation === "remove") &&
    packageId === undefined
  ) {
    return refusal(report, "operation", "missing-package-id");
  }
  if (packageId !== undefined && !available.has(packageId)) {
    return refusal(report, "operation", "unknown-package-id");
  }

  const desiredRoots = new Set(selection.roots);
  let policyChangeRequired = false;
  if (snapshot.operation === "add" && packageId !== undefined) {
    policyChangeRequired = !desiredRoots.has(packageId);
    desiredRoots.add(packageId);
  } else if (snapshot.operation === "remove" && packageId !== undefined) {
    policyChangeRequired = desiredRoots.has(packageId);
    desiredRoots.delete(packageId);
  } else if (
    snapshot.operation === "update" &&
    packageId !== undefined &&
    !desiredRoots.has(packageId)
  ) {
    return refusal(report, "policy", "package-not-requested");
  }
  if (policyChangeRequired)
    report.refusals.push({ stage: "policy", reason: "selection-change-required" });

  const unknownRoot = [...desiredRoots].find((root) => !available.has(root));
  if (unknownRoot !== undefined) return refusal(report, "policy", "unknown-requested-package");

  const intentRead = readCapabilityPackageIntent(snapshot.root);
  report.sources.resolution = {
    state: intentRead.state === "valid" ? "valid" : intentRead.state,
    ...(intentRead.state === "valid" ? { sha256: intentRead.sourceSha256 } : {}),
  };
  const ownershipRead = readCapabilityPackageOwnershipReceipt(snapshot.root);
  report.sources.ownership = {
    state: ownershipRead.state === "valid" ? "valid" : ownershipRead.state,
    ...(ownershipRead.state === "valid" ? { sha256: ownershipRead.sourceSha256 } : {}),
  };
  if (intentRead.state === "malformed") {
    return refusal(report, "resolution", "invalid-resolution-manifest");
  }
  if (ownershipRead.state === "malformed")
    return refusal(report, "ownership", "invalid-ownership-receipt");

  const trust = readTrustLockExact(snapshot.root);
  report.sources.domain = {
    state: trust.state === "valid" ? "valid" : trust.state,
    ...(trust.state === "valid" ? { sha256: trust.sourceSha256 } : {}),
  };

  let lifecycle: ReturnType<typeof planCapabilityPackageLifecycle> | undefined;
  let intentBytes: Buffer | undefined;
  const roots = [...desiredRoots].sort(codeUnitCompare);
  if (roots.length > 0) {
    let manifest: CapabilityPackageManifest;
    try {
      manifest = capabilityPackageManifestFor(index, roots);
    } catch {
      return refusal(report, "package-graph", "unresolvable-package-selection");
    }
    intentBytes = capabilityPackageManifestBytes(manifest);
    const planned = planCapabilityPackageLifecycle({
      intentBytes,
      index,
      currentReceipt: ownershipRead.state === "valid" ? ownershipRead.receipt : undefined,
      diagnostics: projected.diagnostics,
    });
    lifecycle = planned;
    if (planned.status === "refused") {
      const first = planned.refusals[0];
      return refusal(report, first?.stage ?? "operation", first?.code ?? "lifecycle-refused");
    }
  }

  const descriptions = new Map(
    packs.packs.map((pack) => [`package:skill-pack/${pack.name}`, pack.description]),
  );
  const ownedIds = new Set(
    ownershipRead.state === "valid" ? ownershipRead.receipt.packages.map(({ id }) => id) : [],
  );
  report.packages = availableClaims.map((claim) => ({
    id: claim.id,
    ...(descriptions.get(claim.id) === undefined
      ? {}
      : { description: descriptions.get(claim.id) }),
    authority: claim.authorityId,
    members: [...claim.entity.members].sort(codeUnitCompare),
    requested: selection.roots.includes(claim.id),
    owned: ownedIds.has(claim.id),
    lifecycle: changeFor(lifecycle, claim.id),
  }));
  if (
    packageId !== undefined &&
    (snapshot.operation === "show" || snapshot.operation === "status")
  ) {
    report.packages = report.packages.filter(({ id }) => id === packageId);
  }

  if (ownershipRead.state === "valid" && intentBytes !== undefined) {
    const custody = planSkillPackCustody({
      root: snapshot.root,
      contextDir: snapshot.contextDir,
      lifecycleInput: {
        intentBytes,
        index,
        currentReceipt: ownershipRead.receipt,
        diagnostics: projected.diagnostics,
      },
    });
    report.sources.custody = {
      state:
        custody.status === "verified-existing"
          ? "verified-existing"
          : custody.status === "not-applicable"
            ? "not-applicable"
            : custody.status === "unowned"
              ? "unowned"
              : "malformed",
    };
    if (custody.status === "refused")
      report.refusals.push({ stage: "custody", reason: custody.code });
  }

  if (
    snapshot.operation === "add" ||
    snapshot.operation === "update" ||
    snapshot.operation === "remove"
  ) {
    if (packageId === undefined) return refusal(report, "operation", "missing-package-id");
    const changes =
      lifecycle?.status === "ready"
        ? {
            add: [...lifecycle.changes.add],
            update: [...lifecycle.changes.update],
            remove: [...lifecycle.changes.remove],
            unchanged: [...lifecycle.changes.unchanged],
          }
        : {
            add: [],
            update: [],
            remove: packageId === undefined ? [] : [packageId],
            unchanged: [],
          };
    report.preview = {
      operation: snapshot.operation,
      packageId,
      writes: 0,
      acquisition: false,
      network: false,
      processExecution: false,
      componentLoading: false,
      policyChangeRequired,
      changes,
    };
  }
  report.healthy = report.refusals.length === 0;
  return freeze(report);
}
