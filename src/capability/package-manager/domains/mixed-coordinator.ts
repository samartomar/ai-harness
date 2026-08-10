import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { platform as hostPlatform } from "node:process";
import { isProxy } from "node:util/types";
import { baselineCatalogById } from "../../../baseline-evidence/catalogs.js";
import { vendorBaselineLockBytes } from "../../../baseline-evidence/vendor.js";
import { planEccComponentSubtraction } from "../../../ecc/materialization-plan.js";
import {
  ECC_MATERIALIZATION_RECEIPT_PATH,
  readEccMaterializationReceipt,
} from "../../../ecc/materialization-receipt.js";
import {
  explicitEccMcpRenderPlan,
  planExplicitEccMcpRemove,
  readExplicitEccMcpReceiptStates,
} from "../../../ecc/mcp-explicit-add.js";
import {
  ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
  parseExplicitAddReceipt,
} from "../../../ecc/mcp-explicit-add-receipt.js";
import { resolveContents } from "../../../internals/execute.js";
import {
  type OwnedFilePolicy,
  type OwnedFileRead,
  type OwnedFileStep,
  OwnedFileTransaction,
} from "../../../internals/owned-file-transaction.js";
import type { WriteAction } from "../../../internals/plan.js";
import { AIH_ORG_POLICY_FILE } from "../../../org-policy/constants.js";
import { resolveEffectiveOrgPolicy } from "../../../org-policy/effective.js";
import { parseOrgPolicy } from "../../../org-policy/schema.js";
import { AIH_PACKS_FILE } from "../../../pack/manifest.js";
import { readSkillsLockExact } from "../../../skill/lockfile.js";
import { projectPromotedSkillArtifacts } from "../../../skill/promoted-artifacts.js";
import { readTrustLockExact, TRUST_LOCK_FILE, type TrustLock } from "../../../trust/lock.js";
import { serializeTrustLockBytes } from "../../../workspace/promotion-snapshot.js";
import { projectBaselinePackageGraphAuthority } from "../../package-graph/adapters/baseline.js";
import {
  projectEccCapabilityPackageAuthority,
  projectEccMcpCapabilityPackageAuthority,
  projectEccMcpReceiptAuthority,
} from "../../package-graph/adapters/ecc-domains.js";
import { projectEccMaterializationAuthority } from "../../package-graph/adapters/ecc-materialization.js";
import { adaptSkillPackageGraph } from "../../package-graph/adapters/skills.js";
import {
  buildPackageGraphIndex,
  type PackageGraphAuthorityDocument,
} from "../../package-graph/build.js";
import { codeUnitCompare } from "../../package-graph/canonical.js";
import {
  CAPABILITY_PACKAGE_CUSTODY_RECEIPT_DIRECTORY,
  CAPABILITY_PACKAGE_CUSTODY_RECEIPT_FORMAT,
  capabilityPackageCustodyReceiptPath,
  readCapabilityPackageCustodyReceipt,
  serializeCapabilityPackageCustodyReceipt,
} from "../custody-receipt.js";
import { CAPABILITY_PACKAGE_INTENT_PATH, readCapabilityPackageIntent } from "../intent.js";
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
import { resolveInstalledSkillPackSnapshot } from "./skill-pack-installed.js";

const MAX_FILE_BYTES = 128 * 1024 * 1024;

interface Input {
  root: string;
  contextDir: string;
  operation: "add" | "update" | "remove";
  packageId: string;
  apply: boolean;
}

export type MixedCapabilityPackageMutationResult =
  | {
      readonly schemaVersion: 1;
      readonly status: "preview" | "applied" | "unchanged" | "retained-drift";
      readonly operation: Input["operation"];
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
      readonly report?: CapabilityPackageContextReport;
    };

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
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Object.keys(descriptors).length !== 5 ||
      Object.values(descriptors).some(
        (descriptor) => !descriptor.enumerable || !("value" in descriptor),
      )
    )
      return undefined;
    const value = Object.fromEntries(
      Object.entries(descriptors).map(([name, descriptor]) => [name, descriptor.value]),
    );
    if (
      typeof value.root !== "string" ||
      !isAbsolute(value.root) ||
      typeof value.contextDir !== "string" ||
      !["add", "update", "remove"].includes(String(value.operation)) ||
      typeof value.packageId !== "string" ||
      !value.packageId.startsWith("package:") ||
      typeof value.apply !== "boolean"
    )
      return undefined;
    return value as unknown as Input;
  } catch {
    return undefined;
  }
}

function refused(
  stage: Extract<MixedCapabilityPackageMutationResult, { status: "refused" }>["stage"],
  reason: string,
  report?: CapabilityPackageContextReport,
): MixedCapabilityPackageMutationResult {
  return Object.freeze({
    schemaVersion: 1 as const,
    status: "refused" as const,
    stage,
    reason,
    ...(report === undefined ? {} : { report }),
  });
}

function result(
  status: "preview" | "applied" | "unchanged" | "retained-drift",
  input: Input,
  report: CapabilityPackageContextReport,
  writes: readonly string[] = [],
  removes: readonly string[] = [],
): MixedCapabilityPackageMutationResult {
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

type Live = Exclude<OwnedFileRead, { state: "unreadable" }>;

function expectation(live: Live): OwnedFileStep["expect"] {
  return live.state === "absent"
    ? { absent: true }
    : hostPlatform === "win32"
      ? { sha256: sha256(live.bytes) }
      : { sha256: sha256(live.bytes), mode: live.mode };
}

function copyStep(step: {
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

function transactionPolicy(
  allowed: ReadonlySet<string>,
  mutable: ReadonlySet<string>,
): OwnedFilePolicy {
  const statePaths = new Set(
    [...allowed].filter(
      (path) =>
        path === CAPABILITY_PACKAGE_INTENT_PATH ||
        path === CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH ||
        path === TRUST_LOCK_FILE ||
        path === ECC_MATERIALIZATION_RECEIPT_PATH ||
        path === ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH ||
        path.startsWith(`${CAPABILITY_PACKAGE_CUSTODY_RECEIPT_DIRECTORY}/`),
    ),
  );
  const unsafe = (): never => {
    throw new Error("mixed capability package path is unsafe");
  };
  return {
    label: "mixed capability package reconciliation",
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

function observedFile(
  root: string,
  path: string,
  digest: string,
): { bytes: Buffer; mode: number } | undefined {
  try {
    const allowed = new Set([path]);
    const observer = new OwnedFileTransaction(root, transactionPolicy(allowed, new Set<string>()));
    const live = observer.inspect(path);
    return live.state === "present" && sha256(live.bytes) === digest
      ? { bytes: Buffer.from(live.bytes), mode: live.mode }
      : undefined;
  } catch {
    return undefined;
  }
}

interface Assembly {
  index: ReturnType<typeof buildPackageGraphIndex>;
  diagnostics: ReturnType<typeof adaptSkillPackageGraph>["diagnostics"];
  materialization?: Extract<ReturnType<typeof readEccMaterializationReceipt>, { state: "valid" }>;
  materialAuthority?: PackageGraphAuthorityDocument;
  mcpReceipt?: { bytes: Buffer; sha256: string };
  policy: ReturnType<typeof parseOrgPolicy>;
}

function assemble(input: Input): Assembly {
  const policySource = readCapabilityPackageExactFile(input.root, AIH_ORG_POLICY_FILE);
  if (policySource === undefined) throw new Error("policy");
  const policy = parseOrgPolicy(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(policySource.bytes)),
  );
  const effective = resolveEffectiveOrgPolicy(policy);
  if (effective.capabilityPackages === undefined) throw new Error("selection");
  const documents: PackageGraphAuthorityDocument[] = [];
  let diagnostics: ReturnType<typeof adaptSkillPackageGraph>["diagnostics"] = [];
  const skillRoots = [
    ...effective.capabilityPackages.roots,
    ...(input.packageId.startsWith("package:skill-pack/") ? [input.packageId] : []),
  ].filter((id) => id.startsWith("package:skill-pack/"));
  if (skillRoots.length > 0) {
    const lock = readSkillsLockExact(input.root);
    const packs = readCapabilityPackageExactFile(input.root, AIH_PACKS_FILE);
    if (lock.state !== "valid" || packs === undefined) throw new Error("skill authority");
    const adapted = adaptSkillPackageGraph({
      lockBytes: lock.sourceBytes,
      packsBytes: packs.bytes,
      lockAuthorityId: "lock:aih-skills",
      catalogAuthorityId: "catalog:aih-packs",
      hostSource: effective.capabilityPackages.catalog,
    });
    documents.push(...adapted.documents);
    diagnostics = adapted.diagnostics;
    if (diagnostics.length > 0) throw new Error("skill diagnostics");
  }
  const baseline = projectBaselinePackageGraphAuthority({
    authorityId: "lock:baseline-evidence",
    catalog: baselineCatalogById("ecc"),
    lockBytes: vendorBaselineLockBytes(),
  });
  const ecc = projectEccCapabilityPackageAuthority({
    authorityId: "lock:ecc-capability-packages",
    baseline,
  });
  const mcp = projectEccMcpCapabilityPackageAuthority({ authorityId: "catalog:ecc-mcp" });
  documents.push(ecc, mcp);
  const materialization = readEccMaterializationReceipt(input.root);
  let materialAuthority: PackageGraphAuthorityDocument | undefined;
  if (materialization.state === "valid") {
    const projected = projectEccMaterializationAuthority({
      authorityId: "receipt:ecc-materialization",
      receiptBytes: materialization.sourceBytes,
      baseline: ecc,
    });
    if (projected.state !== "ready") throw new Error("material authority");
    materialAuthority = projected.document;
    documents.push(projected.document);
  }
  const mcpReceiptSource = readCapabilityPackageExactFile(
    input.root,
    ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
  );
  let mcpReceipt: Assembly["mcpReceipt"];
  if (mcpReceiptSource !== undefined) {
    const projected = projectEccMcpReceiptAuthority({
      authorityId: "receipt:ecc-mcp",
      receiptBytes: mcpReceiptSource.bytes,
      catalog: mcp,
    });
    if (projected.state !== "ready") throw new Error("mcp receipt");
    documents.push(projected.document);
    mcpReceipt = { bytes: mcpReceiptSource.bytes, sha256: mcpReceiptSource.sha256 };
  }
  return {
    index: buildPackageGraphIndex(documents),
    diagnostics,
    ...(materialization.state === "valid" ? { materialization } : {}),
    ...(materialAuthority === undefined ? {} : { materialAuthority }),
    ...(mcpReceipt === undefined ? {} : { mcpReceipt }),
    policy,
  };
}

function filteredResolution(
  resolution: ReturnType<typeof resolveCapabilityPackages>,
  prefix: string,
) {
  const packages = resolution.packages.filter(({ id }) => id.startsWith(prefix));
  const packageIds = new Set(packages.map(({ id }) => id));
  const authorityIds = new Set(packages.map(({ authorityId }) => authorityId));
  return {
    schemaVersion: 1,
    roots: resolution.roots.filter((id) => packageIds.has(id)),
    authorities: resolution.authorities.filter(({ id }) => authorityIds.has(id)),
    packages,
    installOrder: resolution.installOrder.filter((id) => packageIds.has(id)),
  };
}

function custody(
  ownershipBytes: Buffer,
  domain: {
    kind: "skill-promotion-trust-lock" | "ecc-materialization" | "ecc-mcp-explicit-add";
    bytes: Buffer;
  },
  packages: readonly { id: string; members: readonly { id: string }[] }[],
  files: readonly { memberId: string; path: string; sha256: string; mode: number }[],
): { path: string; bytes: Buffer } {
  const ownershipSha = sha256(ownershipBytes);
  const domainSha = sha256(domain.bytes);
  const packageIds = new Map<string, string[]>();
  for (const pkg of packages) {
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
      domainReceipt: { kind: domain.kind, sha256: domainSha },
      members: [...packageIds]
        .map(([id, ids]) => ({ id, packageIds: ids.sort(codeUnitCompare) }))
        .sort((left, right) => codeUnitCompare(left.id, right.id)),
      files: files
        .map((file) => ({
          memberId: file.memberId,
          path: file.path,
          sha256: file.sha256,
          ...(hostPlatform === "win32" ? {} : { mode: file.mode }),
        }))
        .sort((left, right) => codeUnitCompare(left.path, right.path)),
    }),
    "utf8",
  );
  return { path: capabilityPackageCustodyReceiptPath(ownershipSha, domainSha), bytes };
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
    const promotedSkills = source.promotedSkills.filter(
      (skill) => !removedMembers.has(`skill:${skill}`),
    );
    if (promotedSkills.length === 0) continue;
    const artifactHashes = source.artifactHashes.filter((artifact) =>
      projected.targets.some(
        (target) =>
          target.artifactPath === artifact.path && !removedMembers.has(`skill:${target.skill}`),
      ),
    );
    sources.push({ ...source, promotedSkills, artifactHashes });
  }
  return {
    schemaVersion: 1,
    sources: sources.sort((left, right) => codeUnitCompare(left.id, right.id)),
  };
}

function currentSkillCustodyMatchesAuthority(
  custodyReceipt: Extract<
    ReturnType<typeof readCapabilityPackageCustodyReceipt>,
    { state: "valid" }
  >["receipt"],
  ownership: Extract<ReturnType<typeof readCapabilityPackageOwnershipReceipt>, { state: "valid" }>,
  trust: Extract<ReturnType<typeof readTrustLockExact>, { state: "valid" }>,
  contextDir: string,
): boolean {
  if (
    custodyReceipt.domainReceipt.kind !== "skill-promotion-trust-lock" ||
    custodyReceipt.ownershipReceipt.sha256 !== ownership.sourceSha256 ||
    custodyReceipt.domainReceipt.sha256 !== trust.sourceSha256
  ) {
    return false;
  }
  const packageIdsByMember = new Map<string, string[]>();
  for (const pkg of ownership.receipt.packages.filter(({ id }) =>
    id.startsWith("package:skill-pack/"),
  )) {
    for (const member of pkg.members) {
      const packageIds = packageIdsByMember.get(member.id) ?? [];
      packageIds.push(pkg.id);
      packageIdsByMember.set(member.id, packageIds);
    }
  }
  if (custodyReceipt.members.length !== packageIdsByMember.size) return false;
  for (const member of custodyReceipt.members) {
    const expected = packageIdsByMember.get(member.id)?.sort(codeUnitCompare);
    if (
      expected === undefined ||
      expected.length !== member.packageIds.length ||
      !expected.every((id, index) => id === member.packageIds[index])
    ) {
      return false;
    }
  }
  const expectedFiles: Array<{ memberId: string; path: string; sha256: string }> = [];
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
        .filter(({ memberId }) => packageIdsByMember.has(memberId)),
    );
  }
  const compareFile = (
    left: { memberId: string; path: string },
    right: { memberId: string; path: string },
  ): number =>
    codeUnitCompare(left.path, right.path) || codeUnitCompare(left.memberId, right.memberId);
  expectedFiles.sort(compareFile);
  const actualFiles = custodyReceipt.files
    .map(({ memberId, path, sha256: digest }) => ({ memberId, path, sha256: digest }))
    .sort(compareFile);
  return (
    expectedFiles.length === actualFiles.length &&
    expectedFiles.every((file, index) => {
      const actual = actualFiles[index];
      return (
        actual !== undefined &&
        actual.memberId === file.memberId &&
        actual.path === file.path &&
        actual.sha256 === file.sha256
      );
    })
  );
}

type ValidCustody = Extract<
  ReturnType<typeof readCapabilityPackageCustodyReceipt>,
  { state: "valid" }
>["receipt"];
type ValidOwnership = Extract<
  ReturnType<typeof readCapabilityPackageOwnershipReceipt>,
  { state: "valid" }
>;

function packageIdsByMember(
  ownership: ValidOwnership,
  include: (packageId: string) => boolean,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const pkg of ownership.receipt.packages.filter(({ id }) => include(id))) {
    for (const member of pkg.members) {
      const packageIds = result.get(member.id) ?? [];
      packageIds.push(pkg.id);
      result.set(member.id, packageIds);
    }
  }
  return result;
}

function sameCustodyMembers(
  receipt: ValidCustody,
  expected: ReadonlyMap<string, string[]>,
): boolean {
  return (
    receipt.members.length === expected.size &&
    receipt.members.every((member) => {
      const packageIds = expected.get(member.id)?.sort(codeUnitCompare);
      return (
        packageIds !== undefined &&
        packageIds.length === member.packageIds.length &&
        packageIds.every((id, index) => id === member.packageIds[index])
      );
    })
  );
}

function sameCustodyFiles(
  receipt: ValidCustody,
  expected: readonly { memberId: string; path: string; sha256: string }[],
): boolean {
  const compare = (
    left: { memberId: string; path: string },
    right: { memberId: string; path: string },
  ): number =>
    codeUnitCompare(left.path, right.path) || codeUnitCompare(left.memberId, right.memberId);
  const wanted = [...expected].sort(compare);
  const actual = receipt.files
    .map(({ memberId, path, sha256: digest }) => ({ memberId, path, sha256: digest }))
    .sort(compare);
  return (
    wanted.length === actual.length &&
    wanted.every((file, index) => {
      const candidate = actual[index];
      return (
        candidate !== undefined &&
        candidate.memberId === file.memberId &&
        candidate.path === file.path &&
        candidate.sha256 === file.sha256
      );
    })
  );
}

function currentEccCustodyMatchesAuthority(
  receipt: ValidCustody,
  ownership: ValidOwnership,
  materialization: Extract<ReturnType<typeof readEccMaterializationReceipt>, { state: "valid" }>,
): boolean {
  if (
    receipt.domainReceipt.kind !== "ecc-materialization" ||
    receipt.ownershipReceipt.sha256 !== ownership.sourceSha256 ||
    receipt.domainReceipt.sha256 !== materialization.sourceSha256
  ) {
    return false;
  }
  const members = packageIdsByMember(ownership, (id) => /^package:ecc-(?:agent|rule)\//.test(id));
  if (!sameCustodyMembers(receipt, members)) return false;
  const components = new Map(
    materialization.receipt.components.map((component) => [
      component.id === "baseline:rules" ? "rule:ecc/rules" : component.id,
      component,
    ]),
  );
  const files = [];
  for (const memberId of members.keys()) {
    const component = components.get(memberId);
    if (
      component === undefined ||
      component.files.some(({ operation }) => operation !== "copy-file")
    ) {
      return false;
    }
    files.push(
      ...component.files.map((file) => ({
        memberId,
        path: file.path,
        sha256: file.contentSha256,
      })),
    );
  }
  return sameCustodyFiles(receipt, files);
}

function currentMcpCustodyMatchesAuthority(
  receipt: ValidCustody,
  ownership: ValidOwnership,
  domainSha256: string,
): boolean {
  if (
    receipt.domainReceipt.kind !== "ecc-mcp-explicit-add" ||
    receipt.ownershipReceipt.sha256 !== ownership.sourceSha256 ||
    receipt.domainReceipt.sha256 !== domainSha256
  ) {
    return false;
  }
  const members = packageIdsByMember(ownership, (id) => id.startsWith("package:ecc-mcp/"));
  return (
    sameCustodyMembers(receipt, members) &&
    sameCustodyFiles(
      receipt,
      [...members.keys()].map((memberId) => ({
        memberId,
        path: ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
        sha256: domainSha256,
      })),
    )
  );
}

/** Reconcile a policy closure spanning more than one package domain in one ordered transaction. */
export function reconcileMixedCapabilityPackages(
  input: unknown,
): MixedCapabilityPackageMutationResult {
  const snapshot = snapshotInput(input);
  if (snapshot === undefined) return refused("input", "invalid-input");
  const report = inspectCapabilityPackageContext({
    root: snapshot.root,
    contextDir: snapshot.contextDir,
    operation: snapshot.operation,
    packageId: snapshot.packageId,
  });
  if (report.refusals.length > 0 || report.preview?.policyChangeRequired === true) {
    const first = report.refusals[0];
    return refused(
      first?.stage === "policy" ? "policy" : "authority",
      first?.reason ?? "invalid-live-context",
      report,
    );
  }
  const currentAuthorityIdentity = authorityIdentity(report);
  if (!snapshot.apply) return result("preview", snapshot, report);

  let assembled: Assembly;
  try {
    assembled = assemble(snapshot);
  } catch {
    return refused("authority", "invalid-live-authority", report);
  }
  const intentRead = readCapabilityPackageIntent(snapshot.root);
  const ownershipRead = readCapabilityPackageOwnershipReceipt(snapshot.root);
  let manifest: ReturnType<typeof capabilityPackageManifestFor> | undefined;
  if (snapshot.operation !== "remove" || report.requestedRoots.length > 0) {
    try {
      manifest = capabilityPackageManifestFor(assembled.index, report.requestedRoots);
    } catch {
      return refused("authority", "unresolvable-package-selection", report);
    }
  }
  const lifecycleInput =
    snapshot.operation === "remove"
      ? {
          operation: "remove" as const,
          removeRoots: [snapshot.packageId],
          intentBytes: intentRead.state === "valid" ? intentRead.sourceBytes : Buffer.alloc(0),
          index: assembled.index,
          currentReceipt: ownershipRead.state === "valid" ? ownershipRead.receipt : undefined,
          diagnostics: assembled.diagnostics,
        }
      : manifest === undefined
        ? undefined
        : {
            intentBytes: capabilityPackageManifestBytes(manifest),
            index: assembled.index,
            currentReceipt: ownershipRead.state === "valid" ? ownershipRead.receipt : undefined,
            diagnostics: assembled.diagnostics,
          };
  if (lifecycleInput === undefined) {
    return refused("authority", "unresolvable-package-selection", report);
  }
  const owned = planCapabilityPackageOwnedFiles({ root: snapshot.root, lifecycleInput });
  if (
    owned.lifecycle.status !== "ready" ||
    (snapshot.operation !== "remove" && owned.lifecycle.desiredReceipt === undefined)
  ) {
    return refused("ownership", "lifecycle-refused", report);
  }
  const ownershipBytes =
    owned.lifecycle.desiredReceipt === undefined
      ? undefined
      : Buffer.from(owned.lifecycle.desiredReceipt.serialized, "utf8");
  const resolution =
    manifest === undefined
      ? undefined
      : resolveCapabilityPackages({ manifest, index: assembled.index });
  const desiredPackages = owned.lifecycle.desiredReceipt?.receipt.packages ?? [];
  const custodies: Array<{ path: string; bytes: Buffer }> = [];
  const assertions: Array<{ path: string; sha256: string; mode: number }> = [];
  let removedPackage:
    | Extract<typeof ownershipRead, { state: "valid" }>["receipt"]["packages"][number]
    | undefined;
  let subtraction: ReturnType<typeof planEccComponentSubtraction> | undefined;
  let skillSubtraction:
    | {
        files: Array<{ path: string; sha256: string; mode?: number }>;
        trustBytes: Buffer;
        nextTrustBytes: Buffer;
      }
    | undefined;
  let retainedSkillFiles:
    | Array<{ memberId: string; path: string; sha256: string; mode: number }>
    | undefined;
  let mcpSubtraction: WriteAction[] | undefined;
  if (snapshot.operation === "remove") {
    if (ownershipRead.state !== "valid")
      return refused("ownership", "missing-current-ownership", report);
    removedPackage = ownershipRead.receipt.packages.find(({ id }) => id === snapshot.packageId);
    if (removedPackage === undefined)
      return refused("ownership", "missing-current-package", report);
    if (/^package:ecc-(?:agent|rule)\//.test(removedPackage.id)) {
      if (assembled.materialization === undefined) {
        return refused("domain", "missing-materialization-receipt", report);
      }
      const currentCustody = readCapabilityPackageCustodyReceipt(
        snapshot.root,
        ownershipRead.sourceSha256,
        assembled.materialization.sourceSha256,
      );
      if (
        currentCustody.state !== "valid" ||
        !currentEccCustodyMatchesAuthority(
          currentCustody.receipt,
          ownershipRead,
          assembled.materialization,
        )
      ) {
        return refused("custody", "invalid-current-ecc-custody", report);
      }
      try {
        subtraction = planEccComponentSubtraction(
          snapshot.root,
          removedPackage.members.map(({ id }) => (id === "rule:ecc/rules" ? "baseline:rules" : id)),
        );
      } catch {
        return refused("domain", "domain-subtraction-refused", report);
      }
      if (subtraction.advisories.length > 0) return result("retained-drift", snapshot, report);
    } else if (removedPackage.id.startsWith("package:skill-pack/")) {
      const trust = readTrustLockExact(snapshot.root);
      if (trust.state !== "valid") return refused("domain", "invalid-skill-trust", report);
      const currentCustody = readCapabilityPackageCustodyReceipt(
        snapshot.root,
        ownershipRead.sourceSha256,
        trust.sourceSha256,
      );
      if (
        currentCustody.state !== "valid" ||
        !currentSkillCustodyMatchesAuthority(
          currentCustody.receipt,
          ownershipRead,
          trust,
          snapshot.contextDir,
        )
      ) {
        return refused("custody", "invalid-current-skill-custody", report);
      }
      const desiredMemberIds = new Set(
        desiredPackages
          .filter(({ id }) => id.startsWith("package:skill-pack/"))
          .flatMap((pkg) => pkg.members.map(({ id }) => id)),
      );
      const removedMembers = new Set(
        removedPackage.members.map(({ id }) => id).filter((id) => !desiredMemberIds.has(id)),
      );
      const removalFiles = currentCustody.receipt.files.filter(({ memberId }) =>
        removedMembers.has(memberId),
      );
      if (
        [...removedMembers].some(
          (memberId) => !removalFiles.some((file) => file.memberId === memberId),
        )
      ) {
        return refused("custody", "incomplete-current-skill-custody", report);
      }
      const retained = currentCustody.receipt.files.filter(({ memberId }) =>
        desiredMemberIds.has(memberId),
      );
      if (
        [...desiredMemberIds].some(
          (memberId) => !retained.some((file) => file.memberId === memberId),
        )
      ) {
        return refused("custody", "incomplete-successor-skill-custody", report);
      }
      retainedSkillFiles = [];
      for (const file of retained) {
        const exact = observedFile(snapshot.root, file.path, file.sha256);
        if (
          exact === undefined ||
          (hostPlatform !== "win32" && file.mode !== undefined && file.mode !== exact.mode)
        ) {
          return refused("domain", "retained-skill-content-drifted", report);
        }
        retainedSkillFiles.push({ ...file, mode: exact.mode });
      }
      const reduced = reducedTrustLock(trust.lock, snapshot.contextDir, removedMembers);
      if (reduced === undefined) return refused("domain", "invalid-promotion-routes", report);
      skillSubtraction = {
        files: removalFiles.map(({ path, sha256: digest, mode }) => ({
          path,
          sha256: digest,
          ...(mode === undefined ? {} : { mode }),
        })),
        trustBytes: Buffer.from(trust.sourceBytes),
        nextTrustBytes: serializeTrustLockBytes(reduced),
      };
    } else if (removedPackage.id.startsWith("package:ecc-mcp/")) {
      if (assembled.mcpReceipt === undefined) {
        return refused("domain", "missing-explicit-mcp-receipt", report);
      }
      const currentCustody = readCapabilityPackageCustodyReceipt(
        snapshot.root,
        ownershipRead.sourceSha256,
        assembled.mcpReceipt.sha256,
      );
      if (
        currentCustody.state !== "valid" ||
        !currentMcpCustodyMatchesAuthority(
          currentCustody.receipt,
          ownershipRead,
          assembled.mcpReceipt.sha256,
        )
      ) {
        return refused("custody", "invalid-current-mcp-custody", report);
      }
      let receipt: ReturnType<typeof parseExplicitAddReceipt>;
      try {
        receipt = parseExplicitAddReceipt(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(assembled.mcpReceipt.bytes)),
        );
      } catch {
        return refused("domain", "invalid-explicit-mcp-receipt", report);
      }
      const id = removedPackage.id.slice("package:ecc-mcp/".length);
      const records = receipt.records.filter((record) => record.id === id);
      if (records.length !== 1) return refused("domain", "missing-explicit-mcp-record", report);
      const planned = planExplicitEccMcpRemove({
        root: snapshot.root,
        id,
        target: records[0]?.target ?? "",
      });
      const actions = planned.actions.filter(
        (action): action is WriteAction => action.kind === "write",
      );
      if (actions.length !== 2 || actions.length !== planned.actions.length) {
        return result("retained-drift", snapshot, report);
      }
      mcpSubtraction = actions;
    }
  }

  const skillPackages = desiredPackages.filter(({ id }) => id.startsWith("package:skill-pack/"));
  if (skillPackages.length > 0) {
    if (ownershipBytes === undefined)
      return refused("ownership", "missing-desired-ownership", report);
    if (skillSubtraction !== undefined && retainedSkillFiles !== undefined) {
      custodies.push(
        custody(
          ownershipBytes,
          { kind: "skill-promotion-trust-lock", bytes: skillSubtraction.nextTrustBytes },
          skillPackages,
          retainedSkillFiles,
        ),
      );
      assertions.push(
        ...retainedSkillFiles.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          mode: file.mode,
        })),
      );
    } else {
      if (resolution === undefined) {
        return refused("authority", "unresolvable-package-selection", report);
      }
      const trust = readTrustLockExact(snapshot.root);
      if (trust.state !== "valid") return refused("domain", "invalid-skill-trust", report);
      let installed: ReturnType<typeof resolveInstalledSkillPackSnapshot>;
      try {
        installed = resolveInstalledSkillPackSnapshot({
          root: snapshot.root,
          contextDir: snapshot.contextDir,
          resolution: filteredResolution(resolution, "package:skill-pack/"),
          index: assembled.index,
          diagnostics: assembled.diagnostics,
          trustLockBytes: trust.sourceBytes,
        });
      } catch {
        return refused("domain", "installed-skill-snapshot-refused", report);
      }
      custodies.push(
        custody(
          ownershipBytes,
          { kind: "skill-promotion-trust-lock", bytes: trust.sourceBytes },
          skillPackages,
          installed.files,
        ),
      );
      assertions.push({ path: TRUST_LOCK_FILE, sha256: trust.sourceSha256, mode: 0o600 });
      assertions.push(
        ...installed.files.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          mode: file.mode,
        })),
      );
    }
  }

  const eccPackages = desiredPackages.filter(({ id }) => /^package:ecc-(?:agent|rule)\//.test(id));
  if (eccPackages.length > 0) {
    if (ownershipBytes === undefined)
      return refused("ownership", "missing-desired-ownership", report);
    if (assembled.materialization === undefined)
      return refused("domain", "missing-materialization-receipt", report);
    const components = new Map(
      assembled.materialization.receipt.components.map((component) => [component.id, component]),
    );
    const files: Array<{ memberId: string; path: string; sha256: string; mode: number }> = [];
    for (const pkg of eccPackages) {
      for (const member of pkg.members) {
        const id = member.id === "rule:ecc/rules" ? "baseline:rules" : member.id;
        const component = components.get(id);
        if (
          component === undefined ||
          component.files.some(({ operation }) => operation !== "copy-file")
        ) {
          return refused("domain", "materialization-receipt-does-not-cover-package", report);
        }
        for (const file of component.files) {
          const exact = observedFile(snapshot.root, file.path, file.contentSha256);
          if (exact === undefined) {
            return refused("domain", "materialized-content-drifted", report);
          }
          files.push({
            memberId: member.id,
            path: file.path,
            sha256: file.contentSha256,
            mode: exact.mode,
          });
        }
      }
    }
    let domainBytes = assembled.materialization.sourceBytes;
    if (subtraction !== undefined) {
      const receiptStep = subtraction.steps.findLast(
        ({ path }) => path === ECC_MATERIALIZATION_RECEIPT_PATH,
      );
      if (receiptStep?.kind !== "write" || receiptStep.contents === undefined) {
        return refused("domain", "missing-successor-materialization-receipt", report);
      }
      domainBytes = Buffer.from(receiptStep.contents);
    }
    custodies.push(
      custody(
        ownershipBytes,
        { kind: "ecc-materialization", bytes: domainBytes },
        eccPackages,
        files,
      ),
    );
    if (subtraction === undefined) {
      assertions.push({
        path: ECC_MATERIALIZATION_RECEIPT_PATH,
        sha256: assembled.materialization.sourceSha256,
        mode: 0o600,
      });
    }
    assertions.push(
      ...files.map(({ path, sha256: digest, mode }) => ({ path, sha256: digest, mode })),
    );
  }

  const mcpPackages = desiredPackages.filter(({ id }) => id.startsWith("package:ecc-mcp/"));
  if (mcpPackages.length > 0) {
    if (ownershipBytes === undefined)
      return refused("ownership", "missing-desired-ownership", report);
    if (assembled.mcpReceipt === undefined)
      return refused("domain", "missing-explicit-mcp-receipt", report);
    let receipt: ReturnType<typeof parseExplicitAddReceipt>;
    const observedReceipt = observedFile(
      snapshot.root,
      ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
      assembled.mcpReceipt.sha256,
    );
    if (observedReceipt === undefined)
      return refused("domain", "explicit-mcp-receipt-changed", report);
    try {
      receipt = parseExplicitAddReceipt(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(assembled.mcpReceipt.bytes)),
      );
    } catch {
      return refused("domain", "invalid-explicit-mcp-receipt", report);
    }
    let domainBytes = assembled.mcpReceipt.bytes;
    if (mcpSubtraction !== undefined) {
      const receiptAction = mcpSubtraction.find(
        ({ path }) => path === ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
      );
      if (receiptAction === undefined) {
        return refused("domain", "missing-successor-mcp-receipt", report);
      }
      domainBytes = Buffer.from(
        resolveContents(receiptAction, join(snapshot.root, receiptAction.path)),
        "utf8",
      );
    }
    const domainSha = sha256(domainBytes);
    const files = [];
    for (const pkg of mcpPackages) {
      const id = pkg.id.slice("package:ecc-mcp/".length);
      const matches = receipt.records.filter((record) => record.id === id);
      if (matches.length !== 1) return refused("domain", "missing-explicit-mcp-record", report);
      const target = matches[0]?.target ?? "";
      try {
        explicitEccMcpRenderPlan(assembled.policy, id, target);
      } catch {
        return refused("policy", "mcp-approval-refused", report);
      }
      const states = readExplicitEccMcpReceiptStates({ root: snapshot.root }).filter(
        (state) => state.id === id && state.target === target,
      );
      if (states.length !== 1 || states[0]?.state !== "clean") {
        return refused("domain", "explicit-mcp-state-is-not-clean", report);
      }
      const member = pkg.members[0];
      if (member === undefined) return refused("domain", "missing-mcp-member", report);
      files.push({
        memberId: member.id,
        path: ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
        sha256: domainSha,
        mode: observedReceipt.mode,
      });
    }
    custodies.push(
      custody(
        ownershipBytes,
        { kind: "ecc-mcp-explicit-add", bytes: domainBytes },
        mcpPackages,
        files,
      ),
    );
    if (mcpSubtraction === undefined) {
      assertions.push({
        path: ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
        sha256: assembled.mcpReceipt.sha256,
        mode: observedReceipt.mode,
      });
    }
  }

  if (snapshot.operation === "remove") {
    if (ownershipRead.state !== "valid" || removedPackage === undefined) {
      return refused("ownership", "missing-current-ownership", report);
    }
    if (
      !removedPackage.id.startsWith("package:skill-pack/") &&
      !/^package:ecc-(?:agent|rule)\//.test(removedPackage.id) &&
      !removedPackage.id.startsWith("package:ecc-mcp/")
    ) {
      return refused("domain", "mixed-removal-domain-not-supported", report);
    }
  }

  const allowed = new Set([
    ...assertions.map(({ path }) => path),
    ...custodies.map(({ path }) => path),
    ...(subtraction?.steps.map(({ path }) => path) ?? []),
    ...(skillSubtraction?.files.map(({ path }) => path) ?? []),
    ...(skillSubtraction === undefined ? [] : [TRUST_LOCK_FILE]),
    ...(mcpSubtraction?.map(({ path }) => path) ?? []),
    CAPABILITY_PACKAGE_INTENT_PATH,
    CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
  ]);
  const mutable = new Set([
    ...custodies.map(({ path }) => path),
    ...(subtraction?.steps.map(({ path }) => path) ?? []),
    ...(skillSubtraction?.files.map(({ path }) => path) ?? []),
    ...(skillSubtraction === undefined ? [] : [TRUST_LOCK_FILE]),
    ...(mcpSubtraction?.map(({ path }) => path) ?? []),
    CAPABILITY_PACKAGE_INTENT_PATH,
    CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
  ]);
  const expectedIntent = owned.steps.find(({ path }) => path === CAPABILITY_PACKAGE_INTENT_PATH);
  const expectedOwnership = owned.steps.find(
    ({ path }) => path === CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
  );
  const finalDomainState: Array<{ path: string; bytes?: Buffer }> = [];
  let transaction: OwnedFileTransaction;
  try {
    transaction = new OwnedFileTransaction(snapshot.root, transactionPolicy(allowed, mutable), {
      beforeEffects() {
        const current = inspectCapabilityPackageContext({
          root: snapshot.root,
          contextDir: snapshot.contextDir,
          operation: snapshot.operation,
          packageId: snapshot.packageId,
        });
        if (
          current.refusals.length > 0 ||
          authorityIdentity(current) !== currentAuthorityIdentity
        ) {
          throw new Error("mixed capability package authority changed before commit");
        }
      },
      afterEffects() {
        const currentReport = inspectCapabilityPackageContext({
          root: snapshot.root,
          contextDir: snapshot.contextDir,
          operation: snapshot.operation,
          packageId: snapshot.packageId,
        });
        if (
          currentReport.refusals.length > 0 ||
          authorityIdentity(currentReport) !== currentAuthorityIdentity
        ) {
          throw new Error("mixed capability package authority changed during commit");
        }
        for (const assertion of assertions) {
          const current = transaction.inspect(assertion.path);
          if (
            current.state !== "present" ||
            sha256(current.bytes) !== assertion.sha256 ||
            (hostPlatform !== "win32" && current.mode !== assertion.mode)
          ) {
            throw new Error("mixed capability package domain changed during commit");
          }
        }
        for (const candidate of custodies) {
          const current = readCapabilityPackageExactFile(snapshot.root, candidate.path);
          if (current === undefined || !current.bytes.equals(candidate.bytes)) {
            throw new Error("mixed capability package custody verification failed");
          }
        }
        for (const expected of [expectedIntent, expectedOwnership]) {
          if (expected === undefined) continue;
          const current = readCapabilityPackageExactFile(snapshot.root, expected.path);
          if (
            expected.action === "remove"
              ? current !== undefined
              : current === undefined ||
                expected.contents === undefined ||
                !current.bytes.equals(expected.contents)
          ) {
            throw new Error("mixed capability package state verification failed");
          }
        }
        for (const expected of finalDomainState) {
          const current = readCapabilityPackageExactFile(snapshot.root, expected.path);
          if (
            expected.bytes === undefined
              ? current !== undefined
              : current === undefined || !current.bytes.equals(expected.bytes)
          ) {
            throw new Error("mixed capability package domain subtraction verification failed");
          }
        }
      },
    });
  } catch {
    return refused("ownership", "invalid-transaction-root", report);
  }
  const steps: OwnedFileStep[] = [];
  if (subtraction !== undefined) {
    steps.push(
      ...subtraction.steps.map((step) =>
        copyStep({
          action: step.kind,
          path: step.path,
          mode: step.mode,
          expect: step.expect,
          ...(step.contents === undefined ? {} : { contents: step.contents }),
          ...(step.prior === undefined ? {} : { prior: step.prior }),
          ...(step.priorMode === undefined ? {} : { priorMode: step.priorMode }),
        }),
      ),
    );
    for (const step of subtraction.steps) {
      finalDomainState.push({
        path: step.path,
        ...(step.kind === "write" && step.contents !== undefined
          ? { bytes: Buffer.from(step.contents) }
          : {}),
      });
    }
  }
  if (skillSubtraction !== undefined) {
    for (const file of skillSubtraction.files) {
      const live = transaction.inspect(file.path);
      if (
        live.state !== "present" ||
        sha256(live.bytes) !== file.sha256 ||
        (hostPlatform !== "win32" && file.mode !== undefined && file.mode !== live.mode)
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
      finalDomainState.push({ path: file.path });
    }
    const trustLive = transaction.inspect(TRUST_LOCK_FILE);
    if (trustLive.state !== "present" || !trustLive.bytes.equals(skillSubtraction.trustBytes)) {
      return refused("domain", "trust-lock-changed", report);
    }
    steps.push({
      action: "write",
      path: TRUST_LOCK_FILE,
      mode: 0o600,
      expect: expectation(trustLive),
      contents: skillSubtraction.nextTrustBytes,
      prior: Buffer.from(trustLive.bytes),
      ...(hostPlatform === "win32" ? {} : { priorMode: trustLive.mode }),
    });
    finalDomainState.push({ path: TRUST_LOCK_FILE, bytes: skillSubtraction.nextTrustBytes });
  }
  if (mcpSubtraction !== undefined) {
    for (const action of mcpSubtraction) {
      const live = transaction.inspect(action.path);
      if (live.state !== "present") {
        return refused("domain", "domain-removal-preimage-missing", report);
      }
      if (
        action.expect !== undefined &&
        "sha256" in action.expect &&
        sha256(live.bytes) !== action.expect.sha256
      ) {
        return refused("domain", "domain-removal-preimage-changed", report);
      }
      const next = Buffer.from(resolveContents(action, join(snapshot.root, action.path)), "utf8");
      steps.push({
        action: "write",
        path: action.path,
        mode: action.path === ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH ? 0o600 : live.mode,
        expect: expectation(live),
        contents: next,
        prior: Buffer.from(live.bytes),
        ...(hostPlatform === "win32" ? {} : { priorMode: live.mode }),
      });
      finalDomainState.push({ path: action.path, bytes: next });
    }
  }
  for (const assertion of assertions) {
    const live = transaction.inspect(assertion.path);
    if (live.state !== "present" || sha256(live.bytes) !== assertion.sha256) {
      return refused("domain", "domain-state-changed", report);
    }
    steps.push({
      action: "assert",
      path: assertion.path,
      mode: assertion.mode,
      expect:
        hostPlatform === "win32"
          ? { sha256: assertion.sha256 }
          : { sha256: assertion.sha256, mode: live.mode },
    });
    assertion.mode = live.mode;
  }
  const stateSteps = owned.steps.map(copyStep);
  const intentStep = stateSteps.find(({ path }) => path === CAPABILITY_PACKAGE_INTENT_PATH);
  const ownershipStep = stateSteps.find(
    ({ path }) => path === CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
  );
  if (intentStep !== undefined) steps.push(intentStep);
  for (const candidate of custodies.sort((left, right) => codeUnitCompare(left.path, right.path))) {
    const live = transaction.inspect(candidate.path);
    if (live.state === "unreadable") return refused("custody", "unsafe-custody-target", report);
    if (live.state === "present" && !live.bytes.equals(candidate.bytes)) {
      return refused("custody", "custody-target-collision", report);
    }
    steps.push(
      live.state === "present"
        ? { action: "assert", path: candidate.path, mode: live.mode, expect: expectation(live) }
        : {
            action: "write",
            path: candidate.path,
            mode: 0o600,
            expect: { absent: true },
            contents: candidate.bytes,
          },
    );
  }
  if (ownershipStep !== undefined) steps.push(ownershipStep);
  if (steps.every(({ action }) => action === "assert"))
    return result("unchanged", snapshot, report);
  try {
    transaction.commit(steps);
  } catch (error) {
    return refused(
      "ownership",
      error instanceof Error && error.message.includes("rollback did not restore")
        ? "rollback-incomplete"
        : "transaction-refused",
      report,
    );
  }
  return result(
    "applied",
    snapshot,
    report,
    steps.filter(({ action }) => action === "write").map(({ path }) => path),
    steps.filter(({ action }) => action === "remove").map(({ path }) => path),
  );
}
