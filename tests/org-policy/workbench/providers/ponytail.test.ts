import { describe, expect, it } from "vitest";
import { actionForCompilerDeclarationV1 } from "../../../../src/org-policy/workbench/compilers/formats.js";
import { compilePinnedComponentCollectionV1 } from "../../../../src/org-policy/workbench/compilers/pinned-component-collection.js";
import { compileCatalogProviderV1 } from "../../../../src/org-policy/workbench/providers/contracts.js";
import {
  compilePonytailComponentCollectionV1,
  ponytailCatalogProviderV1,
  ponytailComponentCollectionFixtureV1,
  ponytailPinnedComponentCollectionV1,
  preparePonytailCatalogProviderV1,
} from "../../../../src/org-policy/workbench/providers/ponytail.js";
import snapshot from "../../../../src/org-policy/workbench/providers/ponytail.snapshot.json";

describe("Ponytail catalog provider", () => {
  it("keeps the imported snapshot detached from the private sealed baseline", () => {
    expect(Object.isFrozen(snapshot)).toBe(false);
  });

  it("rejects an imported accessor before cloning the packaged snapshot", () => {
    const descriptor = Object.getOwnPropertyDescriptor(snapshot, "files");
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("expected snapshot files");
    }
    let reads = 0;
    Object.defineProperty(snapshot, "files", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return descriptor.value;
      },
    });
    try {
      expect(() => ponytailPinnedComponentCollectionV1()).toThrow(/own data property/u);
      expect(reads).toBe(0);
    } finally {
      Object.defineProperty(snapshot, "files", descriptor);
    }
  });

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

  it("returns clone-isolated cached baseline compilations while cloned inputs compile independently", () => {
    const first = preparePonytailCatalogProviderV1();
    const baseline = structuredClone(first);
    const detail = first.inputs[0]?.detailBytes;
    const detailId = detail === undefined ? undefined : Object.keys(detail)[0];
    if (detail === undefined || detailId === undefined) {
      throw new Error("expected cached Ponytail detail");
    }
    detail[detailId] = "corrupted caller output";

    const next = preparePonytailCatalogProviderV1();
    expect(next).toEqual(baseline);
    expect(next).not.toBe(first);
    expect(next.inputs).not.toBe(first.inputs);
    expect(next.inputs[0]?.detailBytes).not.toBe(detail);

    const explicit = structuredClone(ponytailPinnedComponentCollectionV1());
    const direct = compileCatalogProviderV1(ponytailCatalogProviderV1, explicit);
    expect(direct).toEqual(baseline);
    expect(direct).not.toBe(next);
    expect(direct.inputs).not.toBe(next.inputs);
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
