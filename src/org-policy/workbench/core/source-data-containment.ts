import { z } from "zod";
import { hashComponentTree } from "../../../baseline-evidence/hash.js";
import type { ScannerDefinitionOverlapModeV1 } from "../../../baseline-evidence/scanner-definition.js";
import { BaselineComponentPathSchema } from "../../../baseline-evidence/schema.js";
import { canonicalStrictJsonSha256V1 } from "../../../contract/strict-json-v1.js";

const path = BaselineComponentPathSchema;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(240);
const DeclaredSchema = z
  .array(
    z.object({
      componentId: id,
      paths: z.array(path).min(1).max(10_000),
      files: z
        .array(z.object({ path, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict())
        .min(1)
        .max(20_000),
    }),
  )
  .min(1)
  .max(1_000);
const PublishedSchema = z
  .array(z.object({ id, paths: z.array(path).min(1).max(10_000), treeSha256: sha }))
  .min(1)
  .max(4_096);
function fail(): never {
  throw new TypeError("Scanner component containment rejected");
}

/**
 * Pure material-consistency check, NOT cryptographic custody. The caller must
 * authenticate every original publication and reconstruct its requests first.
 * No report is rewritten and path intersection alone never establishes coverage.
 */
export function verifyScannerComponentContainmentV1(
  sourceRoot: string,
  declaredInput: unknown,
  publishedInput: unknown,
  overlap: ScannerDefinitionOverlapModeV1 = "disjoint",
) {
  try {
    if (overlap !== "disjoint" && overlap !== "compiler-catalog") fail();
    const declared = DeclaredSchema.parse(declaredInput);
    const published = PublishedSchema.parse(publishedInput);
    if (
      new Set(declared.map((item) => item.componentId)).size !== declared.length ||
      new Set(published.map((item) => item.id)).size !== published.length
    )
      fail();
    const declaredDigestByFile = new Map<string, string>();
    for (const component of declared) {
      for (const file of component.files) {
        const prior = declaredDigestByFile.get(file.path);
        if (prior && prior !== file.digest) fail();
        declaredDigestByFile.set(file.path, file.digest);
      }
    }
    const ownersByFile = new Map<string, { id: string; digest: string }[]>();
    for (const component of published) {
      if (new Set(component.paths).size !== component.paths.length) fail();
      const material = hashComponentTree(sourceRoot, component.paths);
      if (material.treeSha256 !== component.treeSha256 || material.files.length === 0) fail();
      for (const file of material.files) {
        const owners = ownersByFile.get(file.path);
        const digest = `sha256:${file.sha256}`;
        if (!owners && ownersByFile.size >= 200_000) fail();
        if (owners) {
          const declaredDigest = declaredDigestByFile.get(file.path);
          if (
            overlap === "disjoint" ||
            !declaredDigest ||
            digest !== declaredDigest ||
            owners.some((owner) => owner.digest !== declaredDigest)
          )
            fail();
          owners.push({ id: component.id, digest });
        } else ownersByFile.set(file.path, [{ id: component.id, digest }]);
      }
    }
    return declared.map((component) => {
      if (
        new Set(component.paths).size !== component.paths.length ||
        new Set(component.files.map((file) => file.path)).size !== component.files.length
      )
        fail();
      const actual = hashComponentTree(sourceRoot, component.paths).files;
      const expected = new Map(component.files.map((file) => [file.path, file.digest]));
      if (
        actual.length !== expected.size ||
        actual.some((file) => expected.get(file.path) !== `sha256:${file.sha256}`)
      )
        fail();
      const publishedComponentIds = new Set<string>();
      for (const file of component.files) {
        const owners = ownersByFile.get(file.path);
        if (!owners || owners.some((owner) => owner.digest !== file.digest)) fail();
        for (const owner of owners) publishedComponentIds.add(owner.id);
      }
      return {
        componentId: component.componentId,
        publishedComponentIds: [...publishedComponentIds].sort(),
        closureDigest: `sha256:${canonicalStrictJsonSha256V1({ paths: [...component.paths].sort(), files: [...component.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) })}`,
      };
    });
  } catch {
    fail();
  }
}
