import { describe, expect, it } from "vitest";
import { compileOrganizationManifestAssemblyInputV1 } from "../../../../src/org-policy/workbench/catalog-bundle.js";
import { compileOrganizationManifestV1 } from "../../../../src/org-policy/workbench/compilers/organization-manifest.js";

function manifest(sourceId: string, assets: unknown[]) {
  return JSON.stringify({
    version: "organization-authoring-manifest/v1",
    source: { id: sourceId, revisionId: "acme-policy-2026-09", locator: "Acme policy" },
    assets,
  });
}

describe("organization manifest compiler", () => {
  it("compiles ordinary MCP, skill, and agent declarations without per-source UI rules", () => {
    const compiled = compileOrganizationManifestV1(
      manifest("source:acme", [
        { id: "mcp:reports", kind: "mcp", label: "Reports MCP", path: "mcp/reports.json" },
        { id: "skill:triage", kind: "skill", label: "Triage", path: "skills/triage/SKILL.md" },
        { id: "agent:reviewer", kind: "agent", label: "Reviewer", path: "agents/reviewer.md" },
      ]),
    );

    expect(compiled.declarations.map((asset) => [asset.declaration.id, asset.inputFormat])).toEqual(
      [
        [
          expect.stringMatching(/^organization\/[a-f0-9]{20}\/mcp:reports$/),
          "organization-authoring-manifest/v1",
        ],
        [
          expect.stringMatching(/^organization\/[a-f0-9]{20}\/skill:triage$/),
          "organization-authoring-manifest/v1",
        ],
        [
          expect.stringMatching(/^organization\/[a-f0-9]{20}\/agent:reviewer$/),
          "organization-authoring-manifest/v1",
        ],
      ],
    );
  });

  it("marks the exact organization descriptor as a portable policy input", () => {
    const bytes = manifest("source:acme", [
      { id: "skill:triage", kind: "skill", label: "Triage", path: "skills/triage/SKILL.md" },
    ]);
    const assembly = compileOrganizationManifestAssemblyInputV1(bytes);
    expect(Object.values(assembly.sources)).toEqual([
      expect.objectContaining({
        policyInputRequired: true,
        inputFormat: "organization-authoring-manifest/v1",
      }),
    ]);
  });
  it("rejects deceptive or non-canonical organization display text", () => {
    for (const value of ["Review\u202Epolicy", "Review\u200Bpolicy", "Cafe\u0301"]) {
      expect(() =>
        compileOrganizationManifestV1(
          manifest("source:acme", [
            { id: "skill:triage", kind: "skill", label: value, path: "skills/triage/SKILL.md" },
          ]),
        ),
      ).toThrow(/NFC visible text|must already be NFC/);
      const locatorManifest = JSON.parse(
        manifest("source:acme", [
          { id: "skill:triage", kind: "skill", label: "Triage", path: "skills/triage/SKILL.md" },
        ]),
      );
      locatorManifest.source.locator = value;
      expect(() => compileOrganizationManifestV1(JSON.stringify(locatorManifest))).toThrow(
        /NFC visible text|must already be NFC/,
      );
    }
  });
  it("binds an explicit intake scan subject into the declaration identity", () => {
    const first = compileOrganizationManifestV1(
      manifest("source:acme", [
        {
          id: "skill:triage",
          kind: "skill",
          label: "Triage",
          path: "skills/triage/SKILL.md",
          scanSubject: {
            intakeItemId: "triage-source",
            sourceDigest: `sha256:${"a".repeat(64)}`,
          },
        },
      ]),
    );
    const second = compileOrganizationManifestV1(
      manifest("source:acme", [
        {
          id: "skill:triage",
          kind: "skill",
          label: "Triage",
          path: "skills/triage/SKILL.md",
          scanSubject: {
            intakeItemId: "triage-source",
            sourceDigest: `sha256:${"b".repeat(64)}`,
          },
        },
      ]),
    );
    const assetId = first.declarations[0]?.declaration.id;
    if (assetId === undefined) throw new Error("expected compiled asset");
    expect(first.declarations[0]?.declaration.contentDigest).not.toBe(
      second.declarations[0]?.declaration.contentDigest,
    );
    expect(first.scanSubjects[assetId]).toEqual({
      rawAssetId: "skill:triage",
      kind: "skill",
      path: "skills/triage/SKILL.md",
      intakeItemId: "triage-source",
      sourceDigest: `sha256:${"a".repeat(64)}`,
    });
  });

  it("keeps source identities separate and rejects ambiguous relation declarations", () => {
    const first = compileOrganizationManifestV1(
      manifest("source:alpha", [
        { id: "skill:triage", kind: "skill", label: "Triage", path: "skills/triage/SKILL.md" },
      ]),
    );
    const second = compileOrganizationManifestV1(
      manifest("source:beta", [
        { id: "skill:triage", kind: "skill", label: "Triage", path: "skills/triage/SKILL.md" },
      ]),
    );
    expect(first.declarations[0]?.declaration.id).not.toBe(second.declarations[0]?.declaration.id);

    expect(() =>
      compileOrganizationManifestV1(
        manifest("source:acme", [
          {
            id: "skill:a",
            kind: "skill",
            label: "A",
            path: "skills/a.md",
            requires: ["skill:b", "skill:b"],
          },
          { id: "skill:b", kind: "skill", label: "B", path: "skills/b.md" },
        ]),
      ),
    ).toThrow(/repeats required target/);
    expect(() =>
      compileOrganizationManifestV1(
        manifest("source:acme", [
          {
            id: "skill:a",
            kind: "skill",
            label: "A",
            path: "skills/a.md",
            requires: ["skill:b"],
            members: ["skill:b"],
          },
          { id: "skill:b", kind: "skill", label: "B", path: "skills/b.md" },
        ]),
      ),
    ).toThrow(/contradictory required and optional/);
  });
});
