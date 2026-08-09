import { createHash } from "node:crypto";
import type { BaselineCatalog } from "../../../baseline-evidence/catalog.js";
import { BaselineCatalogSchema } from "../../../baseline-evidence/catalog.js";
import type {
  BaselineComponentEvidence,
  BaselineEvidenceFinding,
  BaselineEvidenceLock,
} from "../../../baseline-evidence/schema.js";
import { BaselineEvidenceLockSchema } from "../../../baseline-evidence/schema.js";
import {
  type PackageGraphAuthorityDocument,
  PackageGraphAuthorityDocumentSchema,
} from "../build.js";
import { codeUnitCompare } from "../canonical.js";
import type { PackageGraphRiskFinding, PackageGraphSurface, SurfaceId } from "../schema.js";

export interface BaselinePackageGraphAuthorityInput {
  authorityId: string;
  catalog: BaselineCatalog;
  lockBytes: Buffer;
}

export function baselineComponentIdToSurfaceId(componentId: string): SurfaceId {
  const [namespace, ...segments] = componentId.split(":");
  if (namespace === undefined || segments.length === 0) {
    throw new Error("baseline component id cannot be represented as a Package Graph surface");
  }
  return `${namespace}:${segments.join("/")}` as SurfaceId;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort(codeUnitCompare);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = sorted(left);
  const normalizedRight = sorted(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function aggregateFindings(
  findings: readonly BaselineEvidenceFinding[],
): PackageGraphRiskFinding[] {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const next = (counts.get(finding.code) ?? 0) + (finding.count ?? 1);
    if (!Number.isSafeInteger(next)) {
      throw new Error("baseline finding count exceeds the safe integer boundary");
    }
    counts.set(finding.code, next);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => codeUnitCompare(left, right))
    .map(([code, count]) => (count === 1 ? { code } : { code, count }));
}

function surfaceFor(
  catalog: BaselineCatalog,
  component: BaselineComponentEvidence,
  lockSha256: string,
): PackageGraphSurface {
  const sourceDigest = { algorithm: "sha256" as const, value: component.treeSha256 };
  return {
    id: baselineComponentIdToSurfaceId(component.id),
    source: {
      provider: "github",
      repository: `${catalog.owner}/${catalog.repo}`,
    },
    sourceDigest,
    declaredRisk: [],
    observedRisk: [
      {
        detector: { name: "baseline-evidence-lock", version: "1" },
        evidence: {
          sha256: lockSha256,
          subjectDigest: { ...sourceDigest },
        },
        verdict: component.verdict,
        findings: aggregateFindings(component.findings),
      },
    ],
  };
}

function assertExactJoin(
  catalog: BaselineCatalog,
  lock: BaselineEvidenceLock,
): BaselineComponentEvidence[] {
  const source = lock.sources.find((candidate) => candidate.id === catalog.id);
  if (source === undefined) throw new Error("baseline lock is missing the catalog source");
  if (
    source.owner !== catalog.owner ||
    source.repo !== catalog.repo ||
    source.pinnedSha !== catalog.pinnedSha
  ) {
    throw new Error("baseline catalog and lock source identity do not match");
  }

  const catalogIds = catalog.components.map((component) => component.id);
  const evidenceIds = source.components.map((component) => component.id);
  if (!sameStringSet(catalogIds, evidenceIds)) {
    throw new Error("baseline catalog and lock component sets do not match");
  }

  const catalogById = new Map(
    catalog.components.map((component) => [component.id, component] as const),
  );
  for (const evidence of source.components) {
    const declared = catalogById.get(evidence.id);
    if (declared === undefined || !sameStringSet(declared.paths, evidence.paths)) {
      throw new Error("baseline catalog and lock component paths do not match");
    }
  }
  return [...source.components].sort((left, right) => codeUnitCompare(left.id, right.id));
}

function parseExactLockBytes(value: unknown): {
  lock: BaselineEvidenceLock;
  sha256: string;
} {
  if (!Buffer.isBuffer(value)) throw new Error("invalid baseline lock bytes");
  const bytes = Buffer.from(value);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const lock = BaselineEvidenceLockSchema.parse(JSON.parse(text));
    return {
      lock,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    throw new Error("invalid baseline lock bytes");
  }
}

export function projectBaselinePackageGraphAuthority(
  input: BaselinePackageGraphAuthorityInput,
): PackageGraphAuthorityDocument {
  const catalog = BaselineCatalogSchema.parse(input.catalog);
  const { lock, sha256: lockSha256 } = parseExactLockBytes(input.lockBytes);
  const components = assertExactJoin(catalog, lock);
  const source = lock.sources.find((candidate) => candidate.id === catalog.id);
  if (source === undefined) throw new Error("baseline lock is missing the catalog source");

  const packageDigest = { algorithm: "git-sha1" as const, value: source.pinnedSha };
  const surfaces = components.map((component) => surfaceFor(catalog, component, lockSha256));
  const document = {
    authority: {
      id: input.authorityId,
      kind: "lock" as const,
      sourceDigest: { algorithm: "sha256" as const, value: lockSha256 },
    },
    graph: {
      schemaVersion: 1 as const,
      surfaces,
      packages: [
        {
          id: `package:baseline/${catalog.id}`,
          source: {
            provider: "github",
            repository: `${catalog.owner}/${catalog.repo}`,
          },
          sourceDigest: packageDigest,
          members: surfaces.map((surface) => surface.id),
          declaredRisk: [],
          observedRisk: [],
        },
      ],
    },
  };
  return PackageGraphAuthorityDocumentSchema.parse(document);
}
