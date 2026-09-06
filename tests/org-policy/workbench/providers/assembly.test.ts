import { describe, expect, it } from "vitest";
import {
  assembleAuthoringCatalogBundleFromCompilerOutputsV1,
  assembleCompilerOutputsV1,
} from "../../../../src/org-policy/workbench/assembly.js";
import {
  compileCatalogProviderV1,
  defineCatalogProviderV1,
} from "../../../../src/org-policy/workbench/providers/contracts.js";
import { eccCatalogProviderV1 } from "../../../../src/org-policy/workbench/providers/ecc.js";
import { organizationCatalogProviderV1 } from "../../../../src/org-policy/workbench/providers/organization.js";
import { pinnedProviderFixtureV1 } from "../../../../src/org-policy/workbench/providers/pinned.js";
import { registeredCatalogProvidersV1 } from "../../../../src/org-policy/workbench/providers/registry.js";
import { superpowersCatalogProviderV1 } from "../../../../src/org-policy/workbench/providers/superpowers.js";

describe("catalog provider assembly", () => {
  it("discovers every provider contract and composes their fixtures", () => {
    const outputs = registeredCatalogProvidersV1.map((provider) => provider.compileFixture());
    expect(new Set(outputs.map((output) => output.providerId)).size).toBe(outputs.length);
    const bundle = assembleAuthoringCatalogBundleFromCompilerOutputsV1(
      outputs.flatMap((output) => output.inputs),
    );
    expect(Object.keys(bundle.sources)).toHaveLength(outputs.length);
    expect(
      Object.values(bundle.assets).every((asset) => asset.authoring.action !== "select-control"),
    ).toBe(true);
  });
  it.each(["verified", "qualified"])("rejects provider-minted %s evidence", (claim) => {
    const input = organizationCatalogProviderV1.compileFixture().inputs[0];
    if (input === undefined) throw new Error("missing fixture input");
    const forged = structuredClone(input);
    forged.evidence = {
      forged: {
        verification: { state: claim === "verified" ? "verified" : "unverified" },
        qualification: { state: claim === "qualified" ? "qualified" : "unknown" },
      },
    } as never;
    expect(() => assembleAuthoringCatalogBundleFromCompilerOutputsV1([forged])).toThrow(
      /untrusted compiler evidence/,
    );
    expect(() => assembleCompilerOutputsV1([forged], [])).toThrow(/untrusted compiler evidence/);
    const provider = defineCatalogProviderV1({
      providerId: "forged",
      providerVersion: "1",
      fixture: () => forged,
      compile: (input) => [input],
    });
    expect(() => provider.compileFixture()).toThrow(/untrusted compiler evidence/);
  });
  it.each([
    { providerId: "Bad Provider", providerVersion: "1" },
    { providerId: "test", providerVersion: "latest" },
  ])("rejects invalid provider ownership identity %j", (identity) => {
    expect(() =>
      defineCatalogProviderV1({ ...identity, fixture: () => "", compile: () => [] }),
    ).toThrow(/invalid catalog provider identity/);
  });
  it("rejects an empty provider before combined assembly", () => {
    const empty = defineCatalogProviderV1({
      providerId: "empty",
      providerVersion: "1",
      fixture: () => "",
      compile: () => [],
    });
    expect(() => empty.compileFixture()).toThrow(/produced no assembly input/);
  });
  it("enrolls an additional data provider with the same generic contracts", () => {
    const extra = defineCatalogProviderV1({
      providerId: "additional",
      providerVersion: "1",
      fixture: () =>
        JSON.stringify({
          version: "organization-authoring-manifest/v1",
          source: { id: "source:additional", revisionId: "1", locator: "additional" },
          assets: [
            { id: "skill:test", kind: "skill", label: "Additional skill", path: "skills/test.md" },
          ],
        }),
      compile: organizationCatalogProviderV1.compile,
    });
    const output = extra.compileFixture();
    const bundle = assembleAuthoringCatalogBundleFromCompilerOutputsV1(output.inputs);
    expect(output.providerId).toBe("additional");
    expect(bundle.sources["source:additional"]?.compiler.id).toBe("organization-manifest");
  });
  it("rejects structural lookalikes of a Core custody token", () => {
    expect(() =>
      assembleCompilerOutputsV1([], [], [{ kind: "fresh-organization-preparation/v1" }]),
    ).toThrow(/custody is unavailable/);
  });
  it("rejects provider-supplied capability registries", () => {
    const provider = defineCatalogProviderV1({
      providerId: "forged",
      providerVersion: "1",
      fixture: () => "",
      compile: () =>
        organizationCatalogProviderV1
          .compileFixture()
          .inputs.map((input) => ({ ...input, coreCapabilities: [] })),
    });
    expect(() => provider.compileFixture()).toThrow(/unsupported assembly fields/);
  });
  it("isolates an ECC metadata or implementation-version change from Superpowers", () => {
    const eccInput = {
      ...pinnedProviderFixtureV1("ecc"),
      composition: { framework: "ecc" as const, parts: [] },
    };
    const superpowersInput = pinnedProviderFixtureV1("superpowers");
    const before = compileCatalogProviderV1(eccCatalogProviderV1, eccInput);
    const independent = compileCatalogProviderV1(superpowersCatalogProviderV1, superpowersInput);
    const metadata = eccInput.framework.assets[0]?.metadata;
    if (!metadata) throw new Error("missing fixture metadata");
    metadata.title = "Revised ECC fixture";
    const changed = compileCatalogProviderV1(eccCatalogProviderV1, eccInput);
    expect(changed.inputDigest).not.toBe(before.inputDigest);
    expect(changed.inputs).not.toEqual(before.inputs);
    const revised = defineCatalogProviderV1({
      providerId: "ecc",
      providerVersion: "2",
      compile: eccCatalogProviderV1.compile,
      fixture: () => eccInput,
    });
    expect(revised.compileFixture()).toMatchObject({
      providerVersion: "2",
      inputDigest: changed.inputDigest,
      inputs: changed.inputs,
    });
    expect(compileCatalogProviderV1(superpowersCatalogProviderV1, superpowersInput)).toEqual(
      independent,
    );
  });
  it("rejects duplicate sources when independently valid providers compose", () => {
    const input = organizationCatalogProviderV1.compileFixture().inputs;
    expect(() => assembleAuthoringCatalogBundleFromCompilerOutputsV1([...input, ...input])).toThrow(
      /duplicate/,
    );
  });
});
