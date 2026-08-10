import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { platform as hostPlatform } from "node:process";
import { isProxy } from "node:util/types";
import {
  type OwnedFilePolicy,
  type OwnedFileRead,
  type OwnedFileStep,
  OwnedFileTransaction,
} from "../../../internals/owned-file-transaction.js";
import { AIH_ORG_POLICY_FILE } from "../../../org-policy/constants.js";
import { resolveEffectiveOrgPolicy } from "../../../org-policy/effective.js";
import { parseOrgPolicy } from "../../../org-policy/schema.js";
import { AIH_PACKS_FILE } from "../../../pack/manifest.js";
import { readSkillsLockExact } from "../../../skill/lockfile.js";
import { projectPromotedSkillArtifacts } from "../../../skill/promoted-artifacts.js";
import { readTrustLockExact, TRUST_LOCK_FILE, type TrustLock } from "../../../trust/lock.js";
import { serializeTrustLockBytes } from "../../../workspace/promotion-snapshot.js";
import { adaptSkillPackageGraph } from "../../package-graph/adapters/skills.js";
import { buildPackageGraphIndex } from "../../package-graph/build.js";
import { codeUnitCompare } from "../../package-graph/canonical.js";
import {
  CAPABILITY_PACKAGE_CUSTODY_RECEIPT_DIRECTORY,
  CAPABILITY_PACKAGE_CUSTODY_RECEIPT_FORMAT,
  capabilityPackageCustodyReceiptPath,
  readCapabilityPackageCustodyReceipt,
  serializeCapabilityPackageCustodyReceipt,
} from "../custody-receipt.js";
import {
  CAPABILITY_PACKAGE_INTENT_PATH,
  parseCapabilityPackageIntentBytes,
  readCapabilityPackageIntent,
} from "../intent.js";
import type { CapabilityPackageLifecycleInput } from "../lifecycle.js";
import {
  type CapabilityPackageContextReport,
  capabilityPackageManifestBytes,
  capabilityPackageManifestFor,
  inspectCapabilityPackageContext,
  readCapabilityPackageExactFile,
} from "../live-context.js";
import { planCapabilityPackageOwnedFiles } from "../owned-files.js";
import {
  CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
  readCapabilityPackageOwnershipReceipt,
} from "../receipt.js";
import { resolveCapabilityPackages } from "../resolve.js";
import { planSkillPackCustody } from "./skill-pack-custody.js";
import { resolveInstalledSkillPackSnapshot } from "./skill-pack-installed.js";

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const STATE_PATHS = new Set([
  CAPABILITY_PACKAGE_INTENT_PATH,
  CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
  TRUST_LOCK_FILE,
]);

export type SkillPackPackageMutationResult =
  | {
      readonly schemaVersion: 1;
      readonly status: "preview" | "applied" | "unchanged" | "retained-drift";
      readonly operation: "add" | "update" | "remove";
      readonly packageId: string;
      readonly writes: readonly string[];
      readonly removes: readonly string[];
      readonly report: CapabilityPackageContextReport;
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "refused";
      readonly stage: "input" | "policy" | "authority" | "domain" | "ownership" | "custody";
      readonly reason: string;
      readonly operation?: "add" | "update" | "remove";
      readonly packageId?: string;
      readonly report?: CapabilityPackageContextReport;
    };

interface Input {
  root: string;
  contextDir: string;
  operation: "add" | "update" | "remove";
  packageId: string;
  apply: boolean;
}

interface AssembledReady {
  report: CapabilityPackageContextReport;
  index: ReturnType<typeof buildPackageGraphIndex>;
  diagnostics: ReturnType<typeof adaptSkillPackageGraph>["diagnostics"];
  roots: string[];
}

type Assembled = { report: CapabilityPackageContextReport } | AssembledReady;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotInput(input: unknown): Input | undefined {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      isProxy(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null) ||
      Object.getOwnPropertySymbols(input).length !== 0
    ) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const names = Object.keys(descriptors);
    if (
      names.length !== 5 ||
      names.some(
        (name) => !["root", "contextDir", "operation", "packageId", "apply"].includes(name),
      ) ||
      Object.values(descriptors).some(
        (descriptor) => !descriptor.enumerable || !("value" in descriptor),
      )
    ) {
      return undefined;
    }
    const candidate = Object.fromEntries(
      Object.entries(descriptors).map(([name, descriptor]) => [name, descriptor.value]),
    );
    if (
      typeof candidate.root !== "string" ||
      !isAbsolute(candidate.root) ||
      typeof candidate.contextDir !== "string" ||
      candidate.contextDir.length === 0 ||
      !["add", "update", "remove"].includes(String(candidate.operation)) ||
      typeof candidate.packageId !== "string" ||
      !candidate.packageId.startsWith("package:skill-pack/") ||
      typeof candidate.apply !== "boolean"
    ) {
      return undefined;
    }
    return candidate as unknown as Input;
  } catch {
    return undefined;
  }
}

function refused(
  stage: Extract<SkillPackPackageMutationResult, { status: "refused" }>["stage"],
  reason: string,
  input?: Input,
  report?: CapabilityPackageContextReport,
): SkillPackPackageMutationResult {
  return Object.freeze({
    schemaVersion: 1 as const,
    status: "refused" as const,
    stage,
    reason,
    ...(input === undefined ? {} : { operation: input.operation, packageId: input.packageId }),
    ...(report === undefined ? {} : { report }),
  });
}

function result(
  status: "preview" | "applied" | "unchanged" | "retained-drift",
  input: Input,
  report: CapabilityPackageContextReport,
  writes: readonly string[] = [],
  removes: readonly string[] = [],
): SkillPackPackageMutationResult {
  return Object.freeze({
    schemaVersion: 1 as const,
    status,
    operation: input.operation,
    packageId: input.packageId,
    writes: Object.freeze([...writes]),
    removes: Object.freeze([...removes]),
    report,
  });
}

function authorityIdentity(report: CapabilityPackageContextReport): string {
  const sources = ["policy", "approval", "evidence", "catalog", "packageGraph"] as const;
  return [
    report.requestedRoots.join("\u0000"),
    ...sources.map(
      (name) => `${name}:${report.sources[name].state}:${report.sources[name].sha256 ?? ""}`,
    ),
  ].join("\u0001");
}

function assemble(input: Input): Assembled {
  const report = inspectCapabilityPackageContext({
    root: input.root,
    contextDir: input.contextDir,
    operation: input.operation,
    packageId: input.packageId,
  });
  if (report.refusals.length > 0) return { report } as const;
  if (report.preview?.policyChangeRequired === true) return { report } as const;

  const policyBytes = readCapabilityPackageExactFile(input.root, AIH_ORG_POLICY_FILE);
  const catalogBytes = readCapabilityPackageExactFile(input.root, AIH_PACKS_FILE);
  const approval = readSkillsLockExact(input.root);
  if (policyBytes === undefined || catalogBytes === undefined || approval.state !== "valid") {
    return { report } as const;
  }
  try {
    const policy = resolveEffectiveOrgPolicy(
      parseOrgPolicy(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(policyBytes.bytes)),
      ),
    );
    if (policy.capabilityPackages === undefined) return { report } as const;
    const adapted = adaptSkillPackageGraph({
      lockBytes: approval.sourceBytes,
      packsBytes: catalogBytes.bytes,
      lockAuthorityId: "lock:aih-skills",
      catalogAuthorityId: "catalog:aih-packs",
      hostSource: policy.capabilityPackages.catalog,
    });
    if (
      report.sources.policy.sha256 !== policyBytes.sha256 ||
      report.sources.approval.sha256 !== approval.sourceSha256 ||
      report.sources.catalog.sha256 !== catalogBytes.sha256
    ) {
      return { report };
    }
    const index = buildPackageGraphIndex(adapted.documents);
    if (adapted.diagnostics.length > 0) return { report } as const;
    return {
      report,
      index,
      diagnostics: adapted.diagnostics,
      roots: [...report.requestedRoots],
    };
  } catch {
    return { report } as const;
  }
}

type Live = Exclude<OwnedFileRead, { state: "unreadable" }>;

function expectation(live: Live): OwnedFileStep["expect"] {
  return live.state === "absent"
    ? { absent: true }
    : hostPlatform === "win32"
      ? { sha256: sha256(live.bytes) }
      : { sha256: sha256(live.bytes), mode: live.mode };
}

function inspect(transaction: OwnedFileTransaction, path: string): Live | undefined {
  const live = transaction.inspect(path);
  return live.state === "unreadable" ? undefined : live;
}

function copyOwnedStep(step: {
  action: "assert" | "write" | "remove";
  path: string;
  mode: number;
  expect: OwnedFileStep["expect"];
  contents?: Buffer;
  prior?: Buffer;
  priorMode?: number;
}): OwnedFileStep {
  return {
    action: step.action,
    path: step.path,
    mode: step.mode,
    expect: { ...step.expect },
    ...(step.action === "write" && step.contents !== undefined
      ? { contents: Buffer.from(step.contents) }
      : {}),
    ...(step.action !== "assert" && step.prior !== undefined
      ? {
          prior: Buffer.from(step.prior),
          ...(step.priorMode === undefined ? {} : { priorMode: step.priorMode }),
        }
      : {}),
  };
}

function policy(allowed: ReadonlySet<string>, mutable: ReadonlySet<string>): OwnedFilePolicy {
  const statePaths = new Set(
    [...allowed].filter(
      (path) =>
        STATE_PATHS.has(path) ||
        path.startsWith(`${CAPABILITY_PACKAGE_CUSTODY_RECEIPT_DIRECTORY}/`),
    ),
  );
  const unsafe = (): never => {
    throw new Error("capability package reconciliation path is unsafe");
  };
  return {
    label: "capability package reconciliation",
    maxFileBytes: MAX_FILE_BYTES,
    contentDirectoryMode: 0o755,
    stateDirectoryMode: 0o700,
    statePaths,
    assertOwnedPath(path) {
      if (!allowed.has(path)) unsafe();
    },
    assertResolvedSegments(segments, requested) {
      const expected = requested.split("/");
      if (segments.length > expected.length) unsafe();
      for (const [index, segment] of segments.entries()) if (segment !== expected[index]) unsafe();
    },
    assertAction(path, action) {
      if (!allowed.has(path) || (action !== "assert" && !mutable.has(path))) unsafe();
    },
  };
}

function custodyBytes(
  ownershipBytes: Buffer,
  trustBytes: Buffer,
  receipt: NonNullable<
    Extract<
      ReturnType<typeof planCapabilityPackageOwnedFiles>["lifecycle"],
      { status: "ready" }
    >["desiredReceipt"]
  >["receipt"],
  files: readonly { memberId: string; path: string; sha256: string; mode: number }[],
): { path: string; bytes: Buffer } {
  const ownershipSha = sha256(ownershipBytes);
  const trustSha = sha256(trustBytes);
  const packageIds = new Map<string, string[]>();
  for (const pkg of receipt.packages) {
    for (const member of pkg.members) {
      const ids = packageIds.get(member.id) ?? [];
      ids.push(pkg.id);
      packageIds.set(member.id, ids);
    }
  }
  const bytes = Buffer.from(
    serializeCapabilityPackageCustodyReceipt({
      format: CAPABILITY_PACKAGE_CUSTODY_RECEIPT_FORMAT,
      schemaVersion: 1,
      ownershipReceipt: { sha256: ownershipSha },
      domainReceipt: { kind: "skill-promotion-trust-lock", sha256: trustSha },
      members: [...packageIds]
        .map(([id, ids]) => ({ id, packageIds: ids.sort(codeUnitCompare) }))
        .sort((a, b) => codeUnitCompare(a.id, b.id)),
      files: files.map((file) => ({
        memberId: file.memberId,
        path: file.path,
        sha256: file.sha256,
        ...(hostPlatform === "win32" ? {} : { mode: file.mode }),
      })),
    }),
    "utf8",
  );
  return { path: capabilityPackageCustodyReceiptPath(ownershipSha, trustSha), bytes };
}

function reducedTrustLock(
  trust: TrustLock,
  contextDir: string,
  removedMembers: ReadonlySet<string>,
): TrustLock | undefined {
  const sources = [];
  for (const source of trust.sources) {
    const projected = projectPromotedSkillArtifacts(contextDir, source);
    if (projected.status === "refused") return undefined;
    const keptSkills = source.promotedSkills.filter(
      (skill) => !removedMembers.has(`skill:${skill}`),
    );
    if (keptSkills.length === 0) continue;
    const keptArtifacts = source.artifactHashes.filter((artifact) => {
      const targets = projected.targets.filter((target) => target.artifactPath === artifact.path);
      return targets.some((target) => !removedMembers.has(`skill:${target.skill}`));
    });
    sources.push({ ...source, promotedSkills: keptSkills, artifactHashes: keptArtifacts });
  }
  return { schemaVersion: 1, sources: sources.sort((a, b) => codeUnitCompare(a.id, b.id)) };
}

function currentCustodyMatchesAuthority(
  custody: Extract<
    ReturnType<typeof readCapabilityPackageCustodyReceipt>,
    { state: "valid" }
  >["receipt"],
  ownership: Extract<ReturnType<typeof readCapabilityPackageOwnershipReceipt>, { state: "valid" }>,
  trust: Extract<ReturnType<typeof readTrustLockExact>, { state: "valid" }>,
  contextDir: string,
): boolean {
  if (
    custody.ownershipReceipt.sha256 !== ownership.sourceSha256 ||
    custody.domainReceipt.sha256 !== trust.sourceSha256
  ) {
    return false;
  }
  const packagesByMember = new Map<string, string[]>();
  for (const pkg of ownership.receipt.packages) {
    for (const member of pkg.members) {
      const packages = packagesByMember.get(member.id) ?? [];
      packages.push(pkg.id);
      packagesByMember.set(member.id, packages);
    }
  }
  if (custody.members.length !== packagesByMember.size) return false;
  for (const member of custody.members) {
    const expected = packagesByMember.get(member.id)?.sort(codeUnitCompare);
    if (
      expected === undefined ||
      expected.length !== member.packageIds.length ||
      !expected.every((id, index) => id === member.packageIds[index])
    ) {
      return false;
    }
  }
  const expectedFiles = [];
  const ownedMembers = new Set(packagesByMember.keys());
  for (const source of trust.lock.sources) {
    const projected = projectPromotedSkillArtifacts(contextDir, source);
    if (projected.status === "refused") return false;
    expectedFiles.push(
      ...projected.targets
        .map((target) => ({
          memberId: `skill:${target.skill}`,
          path: target.targetPath,
          sha256: target.sha256,
        }))
        .filter(({ memberId }) => ownedMembers.has(memberId)),
    );
  }
  expectedFiles.sort((a, b) => codeUnitCompare(a.path, b.path));
  const actualFiles = custody.files
    .map(({ memberId, path, sha256: digest }) => ({ memberId, path, sha256: digest }))
    .sort((a, b) => codeUnitCompare(a.path, b.path));
  return (
    expectedFiles.length === actualFiles.length &&
    expectedFiles.every((file, index) => {
      const actual = actualFiles[index];
      return (
        actual !== undefined &&
        file.memberId === actual.memberId &&
        file.path === actual.path &&
        file.sha256 === actual.sha256
      );
    })
  );
}

/**
 * Explicitly reconcile one policy-selected GitHub skill pack against exact local promotion state.
 * This never acquires content or executes a process; existing trust-lock bytes are the domain proof.
 */
export function reconcileSkillPackCapabilityPackage(
  input: unknown,
): SkillPackPackageMutationResult {
  const snapshot = snapshotInput(input);
  if (snapshot === undefined) return refused("input", "invalid-input");
  const assembled = assemble(snapshot);
  const report = assembled.report;
  if (report.refusals.length > 0 || report.preview?.policyChangeRequired === true) {
    const first = report.refusals[0];
    return refused(
      first?.stage === "policy" ? "policy" : "authority",
      first?.reason ?? "invalid-live-context",
      snapshot,
      report,
    );
  }
  if (!("index" in assembled))
    return refused("authority", "invalid-live-context", snapshot, report);
  if (!snapshot.apply) return result("preview", snapshot, report);

  const intentRead = readCapabilityPackageIntent(snapshot.root);
  const ownershipRead = readCapabilityPackageOwnershipReceipt(snapshot.root);
  const trust = readTrustLockExact(snapshot.root);
  if (trust.state !== "valid")
    return refused("domain", "missing-or-invalid-trust-lock", snapshot, report);

  let lifecycleInput: CapabilityPackageLifecycleInput;
  if (snapshot.operation === "remove") {
    if (intentRead.state !== "valid" || ownershipRead.state !== "valid") {
      return refused("ownership", "missing-current-ownership", snapshot, report);
    }
    lifecycleInput = {
      operation: "remove" as const,
      removeRoots: [snapshot.packageId],
      intentBytes: intentRead.sourceBytes,
      index: assembled.index,
      currentReceipt: ownershipRead.receipt,
      diagnostics: assembled.diagnostics,
    };
  } else {
    try {
      const manifest = capabilityPackageManifestFor(assembled.index, assembled.roots);
      lifecycleInput = {
        intentBytes: capabilityPackageManifestBytes(manifest),
        index: assembled.index,
        currentReceipt: ownershipRead.state === "valid" ? ownershipRead.receipt : undefined,
        diagnostics: assembled.diagnostics,
      };
    } catch {
      return refused("authority", "unresolvable-package-selection", snapshot, report);
    }
  }

  const owned = planCapabilityPackageOwnedFiles({ root: snapshot.root, lifecycleInput });
  if (owned.lifecycle.status !== "ready") {
    return refused(
      "ownership",
      owned.lifecycle.refusals[0]?.code ?? "lifecycle-refused",
      snapshot,
      report,
    );
  }
  const readyLifecycle = owned.lifecycle;
  if (snapshot.operation === "remove") {
    const desiredRoots =
      readyLifecycle.desiredIntent === undefined
        ? []
        : parseCapabilityPackageIntentBytes(Buffer.from(readyLifecycle.desiredIntent.bytes))
            .manifest.roots;
    if (
      desiredRoots.length !== assembled.roots.length ||
      ![...desiredRoots]
        .sort(codeUnitCompare)
        .every((root, index) => root === [...assembled.roots].sort(codeUnitCompare)[index])
    ) {
      return refused("policy", "desired-roots-do-not-match-policy", snapshot, report);
    }
  }

  let desiredCustody: { path: string; bytes: Buffer } | undefined;
  let verifiedFiles: Array<{ memberId: string; path: string; sha256: string; mode: number }> = [];
  let removalFiles: Array<{ memberId: string; path: string; sha256: string; mode?: number }> = [];
  let nextTrustBytes: Buffer<ArrayBufferLike> = Buffer.from(trust.sourceBytes);
  const currentIdentity = authorityIdentity(report);

  if (snapshot.operation === "remove") {
    if (intentRead.state !== "valid" || ownershipRead.state !== "valid") {
      return refused("ownership", "missing-current-ownership", snapshot, report);
    }
    const currentRead = readCapabilityPackageCustodyReceipt(
      snapshot.root,
      ownershipRead.sourceSha256,
      trust.sourceSha256,
    );
    if (
      currentRead.state !== "valid" ||
      !currentCustodyMatchesAuthority(
        currentRead.receipt,
        ownershipRead,
        trust,
        snapshot.contextDir,
      )
    ) {
      return refused("custody", "invalid-current-custody", snapshot, report);
    }
    const desiredMembers = new Set(
      readyLifecycle.desiredReceipt?.receipt.packages.flatMap((pkg) =>
        pkg.members.map((member) => member.id),
      ) ?? [],
    );
    const removedMembers = new Set(
      currentRead.receipt.members.map(({ id }) => id).filter((id) => !desiredMembers.has(id)),
    );
    removalFiles = currentRead.receipt.files.filter(({ memberId }) => removedMembers.has(memberId));
    const reduced = reducedTrustLock(trust.lock, snapshot.contextDir, removedMembers);
    if (reduced === undefined)
      return refused("domain", "invalid-promotion-routes", snapshot, report);
    nextTrustBytes = serializeTrustLockBytes(reduced);
    if (readyLifecycle.desiredReceipt !== undefined) {
      const retainedFiles = currentRead.receipt.files.filter(({ memberId }) =>
        desiredMembers.has(memberId),
      );
      desiredCustody = custodyBytes(
        Buffer.from(readyLifecycle.desiredReceipt.serialized, "utf8"),
        nextTrustBytes,
        readyLifecycle.desiredReceipt.receipt,
        retainedFiles.map((file) => ({ ...file, mode: file.mode ?? 0o644 })),
      );
    }
  } else {
    if (readyLifecycle.desiredReceipt === undefined) {
      return refused("ownership", "missing-desired-ownership", snapshot, report);
    }
    let installed: ReturnType<typeof resolveInstalledSkillPackSnapshot>;
    try {
      const resolution = resolveCapabilityPackages({
        manifest: parseCapabilityPackageIntentBytes(lifecycleInput.intentBytes).manifest,
        index: assembled.index,
      });
      installed = resolveInstalledSkillPackSnapshot({
        root: snapshot.root,
        contextDir: snapshot.contextDir,
        resolution,
        index: assembled.index,
        diagnostics: assembled.diagnostics,
        trustLockBytes: trust.sourceBytes,
      });
    } catch {
      return refused("domain", "installed-snapshot-refused", snapshot, report);
    }
    desiredCustody = custodyBytes(
      Buffer.from(readyLifecycle.desiredReceipt.serialized, "utf8"),
      trust.sourceBytes,
      readyLifecycle.desiredReceipt.receipt,
      installed.files,
    );
    verifiedFiles = installed.files.map((file) => ({
      memberId: file.memberId,
      path: file.path,
      sha256: file.sha256,
      mode: file.mode,
    }));
  }

  const allowed = new Set<string>([
    TRUST_LOCK_FILE,
    CAPABILITY_PACKAGE_INTENT_PATH,
    CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
    ...removalFiles.map(({ path }) => path),
    ...verifiedFiles.map(({ path }) => path),
    ...(desiredCustody === undefined ? [] : [desiredCustody.path]),
  ]);
  const mutable = new Set<string>([
    CAPABILITY_PACKAGE_INTENT_PATH,
    CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
    ...removalFiles.map(({ path }) => path),
    ...(desiredCustody === undefined ? [] : [desiredCustody.path]),
    ...(nextTrustBytes.equals(trust.sourceBytes) ? [] : [TRUST_LOCK_FILE]),
  ]);

  let transaction: OwnedFileTransaction;
  try {
    transaction = new OwnedFileTransaction(snapshot.root, policy(allowed, mutable), {
      beforeEffects() {
        const current = assemble(snapshot);
        if (!("index" in current) || authorityIdentity(current.report) !== currentIdentity) {
          throw new Error("capability package authority changed before commit");
        }
      },
      afterEffects() {
        const current = assemble(snapshot);
        if (!("index" in current) || authorityIdentity(current.report) !== currentIdentity) {
          throw new Error("capability package authority changed during commit");
        }
        if (readyLifecycle.desiredReceipt !== undefined) {
          const verified = planSkillPackCustody({
            root: snapshot.root,
            contextDir: snapshot.contextDir,
            lifecycleInput,
          });
          if (verified.status !== "verified-existing") {
            throw new Error("capability package custody verification failed after commit");
          }
        } else {
          const finalIntent = readCapabilityPackageIntent(snapshot.root);
          const finalOwnership = readCapabilityPackageOwnershipReceipt(snapshot.root);
          const finalTrust = readTrustLockExact(snapshot.root);
          if (
            finalIntent.state !== "absent" ||
            finalOwnership.state !== "absent" ||
            finalTrust.state !== "valid" ||
            !finalTrust.sourceBytes.equals(nextTrustBytes) ||
            removalFiles.some(({ path }) => transaction.inspect(path).state !== "absent")
          ) {
            throw new Error("capability package subtraction verification failed after commit");
          }
        }
      },
    });
  } catch {
    return refused("ownership", "invalid-transaction-root", snapshot, report);
  }

  const steps: OwnedFileStep[] = [];
  const trustLive = inspect(transaction, TRUST_LOCK_FILE);
  if (
    trustLive === undefined ||
    trustLive.state !== "present" ||
    !trustLive.bytes.equals(trust.sourceBytes)
  ) {
    return refused("domain", "trust-lock-changed", snapshot, report);
  }
  if (nextTrustBytes.equals(trust.sourceBytes)) {
    steps.push({
      action: "assert",
      path: TRUST_LOCK_FILE,
      mode: 0o600,
      expect: expectation(trustLive),
    });
  }

  for (const file of verifiedFiles) {
    steps.push({
      action: "assert",
      path: file.path,
      mode: file.mode,
      expect:
        hostPlatform === "win32"
          ? { sha256: file.sha256 }
          : { sha256: file.sha256, mode: file.mode },
    });
  }

  for (const file of removalFiles) {
    const live = inspect(transaction, file.path);
    if (
      live === undefined ||
      live.state !== "present" ||
      sha256(live.bytes) !== file.sha256 ||
      (hostPlatform !== "win32" && file.mode !== live.mode)
    ) {
      return result("retained-drift", snapshot, report);
    }
    steps.push({
      action: "remove",
      path: file.path,
      mode: live.mode,
      expect: expectation(live),
      prior: Buffer.from(live.bytes),
      ...(hostPlatform === "win32" ? {} : { priorMode: live.mode }),
    });
  }
  if (!nextTrustBytes.equals(trust.sourceBytes)) {
    steps.push({
      action: "write",
      path: TRUST_LOCK_FILE,
      mode: 0o600,
      expect: expectation(trustLive),
      contents: nextTrustBytes,
      prior: Buffer.from(trustLive.bytes),
      ...(hostPlatform === "win32" ? {} : { priorMode: trustLive.mode }),
    });
  }

  const stateSteps = owned.steps.map(copyOwnedStep);
  const intentStep = stateSteps.find(({ path }) => path === CAPABILITY_PACKAGE_INTENT_PATH);
  const receiptStep = stateSteps.find(
    ({ path }) => path === CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
  );
  const finalRemoval = readyLifecycle.desiredReceipt === undefined;
  if (finalRemoval && receiptStep !== undefined) steps.push(receiptStep);
  if (intentStep !== undefined) steps.push(intentStep);

  if (desiredCustody !== undefined) {
    const live = inspect(transaction, desiredCustody.path);
    if (live === undefined) return refused("custody", "unsafe-custody-target", snapshot, report);
    if (live.state === "present" && !live.bytes.equals(desiredCustody.bytes)) {
      return refused("custody", "custody-target-collision", snapshot, report);
    }
    steps.push(
      live.state === "present" && (hostPlatform === "win32" || live.mode === 0o600)
        ? { action: "assert", path: desiredCustody.path, mode: 0o600, expect: expectation(live) }
        : live.state === "present"
          ? {
              action: "write",
              path: desiredCustody.path,
              mode: 0o600,
              expect: expectation(live),
              contents: desiredCustody.bytes,
              prior: Buffer.from(live.bytes),
              priorMode: live.mode,
            }
          : {
              action: "write",
              path: desiredCustody.path,
              mode: 0o600,
              expect: { absent: true },
              contents: desiredCustody.bytes,
            },
    );
  }
  if (!finalRemoval && receiptStep !== undefined) steps.push(receiptStep);

  if (steps.every(({ action }) => action === "assert")) {
    const custody = planSkillPackCustody({
      root: snapshot.root,
      contextDir: snapshot.contextDir,
      lifecycleInput,
    });
    return custody.status === "verified-existing"
      ? result("unchanged", snapshot, report)
      : refused("custody", "custody-not-verified", snapshot, report);
  }

  try {
    transaction.commit(steps);
  } catch (error) {
    return refused(
      "ownership",
      error instanceof Error && error.message.includes("rollback did not restore")
        ? "rollback-incomplete"
        : "transaction-refused",
      snapshot,
      report,
    );
  }
  return result(
    "applied",
    snapshot,
    inspectCapabilityPackageContext({
      root: snapshot.root,
      contextDir: snapshot.contextDir,
      operation: "status",
      packageId: snapshot.packageId,
    }),
    steps.filter(({ action }) => action === "write").map(({ path }) => path),
    steps.filter(({ action }) => action === "remove").map(({ path }) => path),
  );
}
