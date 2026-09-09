import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreBaselineVetRequests } from "../../src/baseline-evidence/scanner-consumer.js";
import { prepareCollectionScannerCoverageV1 } from "../../src/baseline-evidence/scanner-provider-catalogs.js";
import { canonicalStrictJsonSha256V1 } from "../../src/contract/strict-json-v1.js";
import { pinnedSkillCollectionDigestV1 } from "../../src/org-policy/workbench/compilers/pinned-skill-collection.js";
import { mattPocockPinnedSkillCollectionFixtureV1 } from "../../src/org-policy/workbench/providers/mattpocock.js";
import { ponytailComponentCollectionFixtureV1 } from "../../src/org-policy/workbench/providers/ponytail.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("collection provider Scanner coverage", () => {
  it.each(["skills", "components"] as const)(
    "binds exact %s bytes without relabeling catalog digests as source trees",
    (kind) => {
      const input =
        kind === "skills"
          ? mattPocockPinnedSkillCollectionFixtureV1()
          : ponytailComponentCollectionFixtureV1();
      input.source.repository = "https://github.com/fixture/collection";
      if (input.version === "pinned-skill-collection/v1") {
        const { collectionDigest: _digest, ...body } = input;
        input.collectionDigest = pinnedSkillCollectionDigestV1(body);
      }
      const root = mkdtempSync(join(tmpdir(), "aih-provider-coverage-"));
      roots.push(root);
      const files =
        input.version === "pinned-skill-collection/v1"
          ? [input.license, ...input.skills.flatMap((skill) => skill.files)]
          : input.files;
      for (const file of files) {
        mkdirSync(dirname(join(root, file.path)), { recursive: true });
        writeFileSync(join(root, file.path), Buffer.from(file.bytesBase64, "base64"));
      }
      const prepared = prepareCollectionScannerCoverageV1(root, input);
      const requests = createCoreBaselineVetRequests(root, prepared.catalog);
      expect(prepared.coverageDigest).toBe(
        `sha256:${canonicalStrictJsonSha256V1(prepared.coverage)}`,
      );
      expect(prepared.coverageDigest).not.toBe(
        `sha256:${canonicalStrictJsonSha256V1({
          ...prepared.coverage,
          components: prepared.coverage.components.map(
            ({ primaryPath: _primaryPath, ...component }) => component,
          ),
        })}`,
      );
      expect(prepared.coverage.authority).toBe("none");
      expect(prepared.coverage.components).toHaveLength(prepared.catalog.components.length);
      for (const component of prepared.coverage.components) {
        expect(component.paths).toContain(component.primaryPath);
        const scanned = requests
          .flatMap((request) => request.components)
          .find((candidate) => candidate.id === component.componentId)!;
        expect(scanned.treeSha256).toBe(component.componentTreeSha256);
        expect(component.subject.contentDigest).not.toBe(`sha256:${component.componentTreeSha256}`);
        expect(component.componentId).not.toContain("/");
        expect(component.subject.assetId).toContain("/");
        expect(component.files).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: expect.any(String),
              digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            }),
          ]),
        );
      }
      expect(prepared.coverage.sourceTreeSha256).toBe(requests[0]!.source.treeSha256);
      writeFileSync(join(root, files[0]!.path), "changed source bytes");
      expect(() => prepareCollectionScannerCoverageV1(root, input)).toThrow(/snapshot bytes/);
    },
  );
});
