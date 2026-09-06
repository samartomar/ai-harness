import { describe, expect, it } from "vitest";
import { assemblyRegistryForCompiledDeclarationsV1 } from "../../../../src/org-policy/workbench/compilers/registry.js";
import { assembleAuthoringAssetV1 } from "../../../../src/org-policy/workbench/contracts.js";
import type { CatalogProviderV1 } from "../../../../src/org-policy/workbench/providers/contracts.js";
export function providerContract<Input>(provider: CatalogProviderV1<Input>) {
  describe(`${provider.providerId} provider contract`, () => {
    it("compiles a deterministic, independently usable offline fixture", () => {
      const first = provider.compileFixture();
      expect(first).toEqual(provider.compileFixture());
      expect(first.providerId).toBe(provider.providerId);
      expect(first.inputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(first.inputs.length).toBeGreaterThan(0);
      for (const input of first.inputs) {
        expect(input.declarations.length).toBeGreaterThan(0);
        const registry = assemblyRegistryForCompiledDeclarationsV1(input.declarations, []);
        for (const { declaration } of input.declarations) {
          expect(input.sources[declaration.sourceId]?.revision.id).toBe(
            declaration.sourceRevisionId,
          );
          const asset = assembleAuthoringAssetV1(declaration, registry);
          expect(asset.authoring.action).not.toBe("select-control");
          expect(input.detailBytes[declaration.detailChunkId]).toBeDefined();
        }
      }
    });
  });
}
