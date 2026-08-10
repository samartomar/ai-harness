import { createHash } from "node:crypto";
import {
  type EccMaterializationReceipt,
  parseEccMaterializationReceipt,
} from "../../../ecc/materialization-receipt.js";
import {
  type PackageGraphAuthorityDocument,
  PackageGraphAuthorityDocumentSchema,
} from "../build.js";
import { codeUnitCompare } from "../canonical.js";
import type { PackageGraphSurface } from "../schema.js";
import { baselineComponentIdToSurfaceId } from "./baseline.js";

export type EccMaterializationAuthorityOutcome =
  | { state: "ready"; document: PackageGraphAuthorityDocument }
  | {
      state: "invalid";
      code:
        | "authority-boundary"
        | "receipt-boundary"
        | "baseline-document"
        | "component-authorization"
        | "provenance-authorization"
        | "baseline-binding";
    }
  | { state: "unsupported"; code: "org-authorization" | "baseline-surface-missing" };

export interface EccMaterializationAuthorityInput {
  authorityId: string;
  receiptBytes: Buffer;
  baseline: PackageGraphAuthorityDocument;
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseExactReceiptBytes(
  value: unknown,
): { receipt: EccMaterializationReceipt; sourceSha256: string } | undefined {
  if (!Buffer.isBuffer(value)) return undefined;
  const bytes = Buffer.from(value);
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      receipt: parseEccMaterializationReceipt(raw),
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return undefined;
  }
}

function baselineSurfaceIsBound(
  surface: PackageGraphSurface,
  evidenceSha256: string,
  treeSha256: string,
): boolean {
  if (surface.sourceDigest.algorithm !== "sha256" || surface.sourceDigest.value !== treeSha256) {
    return false;
  }
  if (surface.observedRisk.length !== 1) return false;
  const observed = surface.observedRisk[0];
  return (
    observed !== undefined &&
    observed.detector.name === "baseline-evidence-lock" &&
    observed.evidence.sha256 === evidenceSha256 &&
    observed.evidence.subjectDigest.algorithm === "sha256" &&
    observed.evidence.subjectDigest.value === treeSha256
  );
}

export function projectEccMaterializationAuthority(
  input: EccMaterializationAuthorityInput,
): EccMaterializationAuthorityOutcome {
  const parsedReceipt = parseExactReceiptBytes(input.receiptBytes);
  if (parsedReceipt === undefined) {
    return { state: "invalid", code: "receipt-boundary" };
  }
  const { receipt, sourceSha256 } = parsedReceipt;

  const parsedBaseline = PackageGraphAuthorityDocumentSchema.safeParse(input.baseline);
  if (!parsedBaseline.success || parsedBaseline.data.authority.kind !== "lock") {
    return { state: "invalid", code: "baseline-document" };
  }

  const authority = {
    id: input.authorityId,
    kind: "receipt" as const,
    sourceDigest: { algorithm: "sha256" as const, value: sourceSha256 },
  };
  const emptyBoundary = PackageGraphAuthorityDocumentSchema.safeParse({
    authority,
    graph: { schemaVersion: 1, surfaces: [], packages: [] },
  });
  if (!emptyBoundary.success) return { state: "invalid", code: "authority-boundary" };

  const surfacesById = new Map(
    parsedBaseline.data.graph.surfaces.map((surface) => [surface.id, surface] as const),
  );
  const surfaces: PackageGraphSurface[] = [];
  const seen = new Set<string>();

  for (const component of receipt.components) {
    if (seen.has(component.id)) {
      return { state: "invalid", code: "component-authorization" };
    }
    seen.add(component.id);
    const authorization = component.authorization;
    if (authorization.tier === "org") {
      return { state: "unsupported", code: "org-authorization" };
    }
    if (component.id !== authorization.componentId) {
      return { state: "invalid", code: "component-authorization" };
    }
    if (
      !sameRepository(component.provenance.repository, authorization.source) ||
      component.provenance.commit !== authorization.pinnedSha
    ) {
      return { state: "invalid", code: "provenance-authorization" };
    }

    let surfaceId: string;
    try {
      const direct = baselineComponentIdToSurfaceId(component.id);
      surfaceId =
        component.id === "baseline:rules" && surfacesById.has("rule:ecc/rules")
          ? "rule:ecc/rules"
          : direct;
    } catch {
      return { state: "invalid", code: "component-authorization" };
    }
    const surface = surfacesById.get(surfaceId);
    if (surface === undefined) {
      return { state: "unsupported", code: "baseline-surface-missing" };
    }

    const containingPackages = parsedBaseline.data.graph.packages.filter((candidate) =>
      candidate.members.includes(surface.id),
    );
    if (containingPackages.length !== 1) {
      return { state: "invalid", code: "baseline-binding" };
    }
    const containingPackage = containingPackages[0];
    if (
      containingPackage === undefined ||
      containingPackage.source.provider !== "github" ||
      !sameRepository(containingPackage.source.repository, authorization.source) ||
      !sameRepository(containingPackage.source.repository, component.provenance.repository) ||
      containingPackage.sourceDigest.algorithm !== "git-sha1" ||
      containingPackage.sourceDigest.value !== authorization.pinnedSha ||
      containingPackage.sourceDigest.value !== component.provenance.commit ||
      surface.source.provider !== "github" ||
      !sameRepository(surface.source.repository, authorization.source) ||
      !sameRepository(surface.source.repository, component.provenance.repository) ||
      authorization.evidenceSha256 !== parsedBaseline.data.authority.sourceDigest.value ||
      !baselineSurfaceIsBound(surface, authorization.evidenceSha256, authorization.treeSha256)
    ) {
      return { state: "invalid", code: "baseline-binding" };
    }
    surfaces.push(structuredClone(surface));
  }

  surfaces.sort((left, right) => codeUnitCompare(left.id, right.id));
  const document = PackageGraphAuthorityDocumentSchema.safeParse({
    authority,
    graph: { schemaVersion: 1, surfaces, packages: [] },
  });
  if (!document.success) return { state: "invalid", code: "authority-boundary" };
  return { state: "ready", document: document.data };
}
