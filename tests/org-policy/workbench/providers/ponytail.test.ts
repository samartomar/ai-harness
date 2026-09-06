import { describe, expect, it } from "vitest";
import { actionForCompilerDeclarationV1 } from "../../../../src/org-policy/workbench/compilers/formats.js";
import { compilePinnedComponentCollectionV1 } from "../../../../src/org-policy/workbench/compilers/pinned-component-collection.js";
import {
  compilePonytailComponentCollectionV1,
  ponytailCatalogProviderV1,
  ponytailComponentCollectionFixtureV1,
  ponytailPinnedComponentCollectionV1,
} from "../../../../src/org-policy/workbench/providers/ponytail.js";

describe("Ponytail catalog provider", () => {
  it("keeps its tiny synthetic fixture separate from the packaged pinned inventory", () => {
    const fixture = ponytailComponentCollectionFixtureV1();
    expect(fixture.files).toHaveLength(1);
    expect(fixture.components.map((component) => component.id)).toEqual(["skill:main"]);

    const output = ponytailCatalogProviderV1.compileFixture();
    expect(output.providerId).toBe("ponytail");
    expect(output.inputs[0]?.sources["source:ponytail"]?.revision.id).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("seals the packaged source bytes and reviewed hook/MCP metadata", () => {
    const first = ponytailPinnedComponentCollectionV1();
    const second = ponytailPinnedComponentCollectionV1();
    first.source.version = "changed";
    expect(second.source.version).toBe("4.9.0");
    expect(second.files).toHaveLength(56);
    expect(second.source.licenseFileRef).toBe("LICENSE");

    const session = second.components.find((component) => component.id === "hook:session-start");
    const mcp = second.components.find((component) => component.id === "mcp:ponytail");
    expect(session).toMatchObject({
      primaryPath: "hooks/ponytail-activate.js",
      metadata: {
        type: "command",
        declaredHosts: ["ClaudeCode", "Codex"],
        event: "SessionStart",
        command: ["node ", '"$', "{CLAUDE_PLUGIN_ROOT}", '/hooks/ponytail-activate.js"'].join(""),
        timeoutSeconds: 5,
        matcher: "startup|resume|clear|compact",
        statusMessage: "Loading ponytail mode...",
      },
    });
    expect(mcp).toMatchObject({
      primaryPath: "ponytail-mcp/index.js",
      metadata: {
        transport: "stdio",
        command: "node",
        args: ["ponytail-mcp/index.js"],
        declaredDependencyRanges: ["@modelcontextprotocol/sdk@^1.26.0", "zod@^3.23.0"],
      },
    });

    const input = compilePonytailComponentCollectionV1(second);
    expect(
      input.declarations
        .filter(({ declaration }) => ["hook", "mcp"].includes(declaration.kind))
        .map(({ inputFormat, declaration }) =>
          actionForCompilerDeclarationV1(inputFormat, declaration.kind),
        ),
    ).toEqual(["record-request", "record-request", "record-request", "record-request"]);
    expect(input.templates?.["template:ponytail/methodology"]?.roots).toEqual([
      { assetId: "ponytail/profile:methodology", mode: "select", includeOptionalMembers: false },
    ]);
  });

  it.each([
    [
      "command",
      (input: ReturnType<typeof ponytailPinnedComponentCollectionV1>) => {
        const hook = input.components.find(
          (component) => component.id === "hook:session-start",
        ) as { metadata: { command: string } };
        hook.metadata.command = "node changed.js";
      },
    ],
    [
      "matcher",
      (input: ReturnType<typeof ponytailPinnedComponentCollectionV1>) => {
        const hook = input.components.find(
          (component) => component.id === "hook:session-start",
        ) as { metadata: { matcher: string } };
        hook.metadata.matcher = "changed";
      },
    ],
    [
      "dependency range",
      (input: ReturnType<typeof ponytailPinnedComponentCollectionV1>) => {
        const mcp = input.components.find((component) => component.id === "mcp:ponytail") as {
          metadata: { declaredDependencyRanges: string[] };
        };
        mcp.metadata.declaredDependencyRanges[0] = "changed";
      },
    ],
    [
      "covered file reference",
      (input: ReturnType<typeof ponytailPinnedComponentCollectionV1>) => {
        input.components[0]?.fileRefs.push("LICENSE");
      },
    ],
  ])("rejects a mutated reviewed %s", (_label, mutate) => {
    const input = ponytailPinnedComponentCollectionV1();
    mutate(input);
    expect(() => compilePonytailComponentCollectionV1(input)).toThrow(/reviewed/u);
  });
  it("rejects structurally valid source-pin drift against the literal reviewed digest", () => {
    const changed = ponytailPinnedComponentCollectionV1();
    changed.source.version = "4.9.1";
    expect(() => compilePinnedComponentCollectionV1(changed)).not.toThrow();
    expect(() => compilePonytailComponentCollectionV1(changed)).toThrow(/reviewed/u);
  });
});
