import { createHash } from "node:crypto";
import type { BaselineEvidenceLock, BaselineSourceEvidence } from "../baseline-evidence/schema.js";
import { canonicalStrictJsonBytesV1 } from "../contract/strict-json-v1.js";

export const ECC_RUNTIME_DECLARED_EVALUATION_CONTRACT_V1 = {
  version: "ecc-runtime-declared-evaluation/v1",
  projection: "source-data-contained-projection/v1",
  verdict: "any-mapped-blocked-blocks",
  analyzers: "exact-union",
  findings: "exact-union",
  tree: "declared-component-identity-paths",
} as const;

export interface EccRuntimeDeclaredComponentV1 {
  readonly id: string;
  readonly paths: readonly string[];
  readonly identityTreeSha256: string;
}

export interface EccRuntimeRawMappingV1 {
  readonly componentId: string;
  readonly rawComponentIds: readonly string[];
}

function fail(): never {
  throw new TypeError(
    "ECC runtime declared evaluation is inconsistent with authenticated report scope",
  );
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalStrictJsonBytesV1(value)).digest("hex")}`;
}

function orderedUnique<T>(items: readonly T[], key: (item: T) => string): T[] {
  const values = new Map<string, T>();
  for (const item of items) {
    const itemKey = key(item);
    if (!values.has(itemKey)) values.set(itemKey, item);
  }
  return [...values.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, item]) => item);
}

/**
 * Forms an ephemeral verifier input after source-data containment has already
 * authenticated every raw report and checked analyzer coverage for each mapped
 * declared closure. It never edits or replaces the original report.
 */
export function deriveEccRuntimeDeclaredEvaluationV1(input: {
  readonly rawReport: BaselineSourceEvidence;
  readonly mappings: readonly EccRuntimeRawMappingV1[];
  readonly components: readonly EccRuntimeDeclaredComponentV1[];
}): Readonly<{
  vendorLock: BaselineEvidenceLock;
  coreDerivedEvaluationDigest: string;
  projectionContractDigest: string;
}> {
  const rawById = new Map(input.rawReport.components.map((component) => [component.id, component]));
  if (rawById.size !== input.rawReport.components.length) fail();
  const mappings = new Map(input.mappings.map((mapping) => [mapping.componentId, mapping]));
  if (mappings.size !== input.mappings.length || mappings.size !== input.components.length) fail();
  const ids = new Set<string>();
  const components = input.components.map((component) => {
    if (
      ids.has(component.id) ||
      !/^[a-z0-9][a-z0-9:._-]*$/.test(component.id) ||
      !/^[a-f0-9]{64}$/.test(component.identityTreeSha256) ||
      component.paths.length === 0 ||
      new Set(component.paths).size !== component.paths.length
    )
      fail();
    ids.add(component.id);
    const mapping = mappings.get(component.id);
    if (
      mapping === undefined ||
      mapping.rawComponentIds.length === 0 ||
      new Set(mapping.rawComponentIds).size !== mapping.rawComponentIds.length
    )
      fail();
    const facts = mapping.rawComponentIds.map((id) => rawById.get(id) ?? fail());
    return {
      id: component.id,
      paths: [...component.paths].sort(),
      treeSha256: component.identityTreeSha256,
      verdict: facts.some((fact) => fact.verdict === "blocked")
        ? ("blocked" as const)
        : ("pass" as const),
      analyzers: orderedUnique(
        facts.flatMap((fact) => fact.analyzers),
        (analyzer) => `${analyzer.name}\0${analyzer.version}`,
      ),
      findings: orderedUnique(
        facts.flatMap((fact) => fact.findings),
        (finding) => canonicalStrictJsonBytesV1(finding).toString("utf8"),
      ),
    };
  });
  if (new Set(components.map((component) => component.id)).size !== components.length) fail();
  const vendorLock: BaselineEvidenceLock = {
    schemaVersion: 1,
    sources: [
      {
        id: input.rawReport.id,
        owner: input.rawReport.owner,
        repo: input.rawReport.repo,
        pinnedSha: input.rawReport.pinnedSha,
        sourceTreeSha256: input.rawReport.sourceTreeSha256,
        components: components.sort((left, right) => (left.id < right.id ? -1 : 1)),
      },
    ],
  };
  return Object.freeze({
    vendorLock,
    coreDerivedEvaluationDigest: sha256(vendorLock),
    projectionContractDigest: sha256(ECC_RUNTIME_DECLARED_EVALUATION_CONTRACT_V1),
  });
}
