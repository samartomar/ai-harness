import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compilePinnedComponentCollectionV1,
  pinnedComponentCollectionDigestV1,
} from "../../../../src/org-policy/workbench/compilers/pinned-component-collection.js";
import {
  ponytailComponentCollectionFixtureV1,
  ponytailPinnedComponentCollectionV1,
} from "../../../../src/org-policy/workbench/providers/ponytail.js";

describe("pinned component collection compiler", () => {
  it("preserves bounded large inventories and zero-byte ordinary resources", () => {
    const input = ponytailComponentCollectionFixtureV1();
    const main = input.components[0]!;
    const files = Array.from({ length: 413 }, (_, index) => ({
      path: `resources/file-${index}.txt`,
      bytesBase64: "",
      size: 0,
      sha256: `sha256:${createHash("sha256").update("").digest("hex")}`,
    }));
    input.files.push(...files);
    for (let start = 0; start < files.length; start += 100)
      input.components.push({
        id: `skill:resources-${String.fromCharCode(97 + start / 100)}`,
        kind: "skill",
        label: "Resource closure",
        description: "Exact empty source resources",
        primaryPath: main.primaryPath,
        fileRefs: [main.primaryPath, ...files.slice(start, start + 100).map((file) => file.path)],
      });
    expect(() => compilePinnedComponentCollectionV1(input)).not.toThrow();
    input.files[1]!.sha256 = `sha256:${"f".repeat(64)}`;
    expect(() => compilePinnedComponentCollectionV1(input)).toThrow(/digest mismatch/);
  });
  function fixtureWithMinimalRelations() {
    const input = ponytailComponentCollectionFixtureV1();
    const main = input.components[0];
    if (main === undefined || main.kind !== "skill") throw new Error("expected fixture skill");
    const shared = { primaryPath: main.primaryPath, fileRefs: [...main.fileRefs] };
    input.components.push(
      {
        id: "skill:optional",
        kind: "skill",
        label: "Fixture optional skill",
        description: "Minimal optional skill for relation validation.",
        ...shared,
      },
      {
        id: "hook:request",
        kind: "hook",
        label: "Fixture request hook",
        description: "Minimal request component for relation validation.",
        ...shared,
        metadata: {
          type: "command",
          declaredHosts: ["fixture"],
          event: "FixtureEvent",
          command: "node fixture.js",
          timeoutSeconds: 1,
        },
      },
    );
    return input;
  }
  it("compiles Ponytail's pinned component inventory without runtime authority", () => {
    const input = ponytailPinnedComponentCollectionV1();
    expect(input.files).toHaveLength(56);
    const result = compilePinnedComponentCollectionV1(input);

    expect(result.source).toMatchObject({
      id: "source:ponytail",
      revisionId: "974d940a1c5344210874150b98ff0d2c861fab6a",
      inputFormat: "pinned-component-collection/v1",
    });
    expect(result.declarations.map(({ declaration }) => declaration.id)).toEqual(
      expect.arrayContaining([
        "ponytail/skill:ponytail",
        "ponytail/hook:session-start",
        "ponytail/hook:subagent-start",
        "ponytail/hook:user-prompt-submit",
        "ponytail/mcp:ponytail",
        "ponytail/profile:methodology",
      ]),
    );
    expect(result.relations).toEqual([
      {
        fromAssetId: "ponytail/profile:methodology",
        toAssetId: "ponytail/skill:ponytail",
        kind: "requires",
      },
    ]);
    expect(result.templates["template:ponytail/methodology"]?.roots).toEqual([
      { assetId: "ponytail/profile:methodology", mode: "select", includeOptionalMembers: false },
    ]);
  });

  it("binds source and asset digests to complete normalized bytes and component metadata", () => {
    const input = ponytailComponentCollectionFixtureV1();
    const changed = structuredClone(input);
    (changed.components[0] as { label: string }).label = "Changed label";

    expect(pinnedComponentCollectionDigestV1(changed)).not.toBe(
      pinnedComponentCollectionDigestV1(input),
    );
    expect(compilePinnedComponentCollectionV1(changed).source.contentDigest).not.toBe(
      compilePinnedComponentCollectionV1(input).source.contentDigest,
    );
  });

  it("binds the methodology declaration to its main skill digest", () => {
    const input = ponytailComponentCollectionFixtureV1();
    const changed = structuredClone(input);
    if (changed.profile === undefined) throw new Error("expected methodology profile");
    changed.profile.methodologyKey = "changed";
    const original = compilePinnedComponentCollectionV1(input);
    const amended = compilePinnedComponentCollectionV1(changed);
    const originalMain = original.declarations.find(
      ({ declaration }) => declaration.id === "ponytail/skill:main",
    );
    const amendedMain = amended.declarations.find(
      ({ declaration }) => declaration.id === "ponytail/skill:main",
    );
    expect(amendedMain?.declaration.contentDigest).not.toBe(
      originalMain?.declaration.contentDigest,
    );
  });
  it.each([
    ["actions", []],
    ["projectors", []],
    ["evidence", {}],
  ])("rejects compiler-authority field %s", (field, value) => {
    const input = ponytailComponentCollectionFixtureV1() as Record<string, unknown>;
    input[field] = value;
    expect(() => compilePinnedComponentCollectionV1(input)).toThrow(/unrecognized|invalid/u);
  });

  it("rejects unknown file references and request components with catalog relations", () => {
    const unknownFile = ponytailComponentCollectionFixtureV1();
    (unknownFile.components[0] as { fileRefs: string[] }).fileRefs = ["missing.txt"];
    expect(() => compilePinnedComponentCollectionV1(unknownFile)).toThrow(/file reference/u);

    const requestRelation = fixtureWithMinimalRelations();
    const hook = requestRelation.components.find((component) => component.kind === "hook");
    if (hook === undefined) throw new Error("expected hook component");
    hook.requires = ["skill:main"];
    expect(() => compilePinnedComponentCollectionV1(requestRelation)).toThrow(/request component/u);
  });
  it.each([
    ["a request asset", ["hook:request"], []],
    ["itself", ["skill:main"], []],
    ["a duplicated required/member target", ["skill:optional"], ["skill:optional"]],
  ])("rejects a skill relation to %s", (_label, requires, members) => {
    const input = fixtureWithMinimalRelations();
    const skill = input.components.find((component) => component.id === "skill:main");
    if (skill === undefined || skill.kind !== "skill") throw new Error("expected main skill");
    skill.requires = requires;
    skill.members = members;
    expect(() => compilePinnedComponentCollectionV1(input)).toThrow(/skill component/u);
  });
  it("uses code-unit ordering for normalized Unicode file references", () => {
    const input = ponytailComponentCollectionFixtureV1();
    const skill = input.components[0];
    if (skill === undefined || skill.kind !== "skill") throw new Error("expected fixture skill");
    const xFile = input.files[0];
    if (xFile === undefined) throw new Error("expected fixture file");
    input.files.push(
      { ...xFile, path: "skills/z/SKILL.md" },
      { ...xFile, path: "skills/ä/SKILL.md" },
    );
    skill.fileRefs = ["skills/ä/SKILL.md", "skills/z/SKILL.md", skill.primaryPath];

    const result = compilePinnedComponentCollectionV1(input);
    const detail = JSON.parse(result.detailBytes["detail:ponytail/skill:main"] ?? "") as {
      component: { files: Array<{ path: string }> };
    };
    expect(detail.component.files.map((file) => file.path)).toEqual([
      "skills/main/SKILL.md",
      "skills/z/SKILL.md",
      "skills/ä/SKILL.md",
    ]);
  });
  it("bounds encoded bytes before decoding a declared one-byte file", () => {
    const input = ponytailComponentCollectionFixtureV1();
    const file = input.files[0];
    if (file === undefined) throw new Error("expected fixture file");
    file.bytesBase64 = "e".repeat(1_333_337);
    expect(() => compilePinnedComponentCollectionV1(input)).toThrow(/Too big/u);
  });
});
