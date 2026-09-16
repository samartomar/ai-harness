import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVELOPER_TOOL_IDS,
  isDeveloperToolId,
  resolveDefaultToolSelection,
} from "../../src/tools/default-tool-selection.js";

describe("default developer tool selection", () => {
  it("keeps Playwright as the seventh ordinary setup default", () => {
    expect(DEFAULT_DEVELOPER_TOOL_IDS).toEqual([
      "code-review-graph",
      "codebase-memory-mcp",
      "serena",
      "token-optimizer",
      "context7",
      "markitdown",
      "playwright",
    ]);
  });

  it("includes MarkItDown CLI by default while keeping GitHub and MarkItDown MCP optional", () => {
    const result = resolveDefaultToolSelection({ policy: { kind: "none" } });
    expect(result.selected).toContain("markitdown");
    expect(result.selected).not.toContain("github");
    expect(result.selected).not.toContain("markitdown-mcp");
  });

  it("preserves a MarkItDown CLI opt-out when a saved policy is reloaded", () => {
    const policy = JSON.parse(
      JSON.stringify({
        kind: "bound",
        binding: "valid",
        excluded: ["markitdown"],
      }),
    );
    const result = resolveDefaultToolSelection({ policy });
    expect(result.accepted).toBe(true);
    expect(result.selected).not.toContain("markitdown");
    expect(result.excluded).toEqual(["markitdown"]);
  });

  it("selects the default developer tools when no policy is supplied", () => {
    expect(resolveDefaultToolSelection({ policy: { kind: "none" } })).toEqual({
      accepted: true,
      source: "default",
      selected: [...DEFAULT_DEVELOPER_TOOL_IDS],
      excluded: [],
      diagnostics: [],
    });
  });

  it("preserves an explicit subset and canonicalizes its order", () => {
    expect(
      resolveDefaultToolSelection({
        policy: {
          kind: "bound",
          binding: "valid",
          selected: ["context7", "serena"],
        },
      }),
    ).toEqual({
      accepted: true,
      source: "explicit",
      selected: ["serena", "context7"],
      excluded: [],
      diagnostics: [],
    });
  });

  it("keeps an explicit empty selection empty", () => {
    expect(
      resolveDefaultToolSelection({
        policy: { kind: "bound", binding: "valid", selected: [] },
      }),
    ).toMatchObject({ accepted: true, source: "explicit", selected: [] });
  });

  it("applies defaults to legacy unspecified selection while honoring exclusions", () => {
    expect(
      resolveDefaultToolSelection({
        policy: {
          kind: "bound",
          binding: "valid",
          excluded: ["context7", "token-optimizer"],
        },
      }),
    ).toEqual({
      accepted: true,
      source: "legacy-unspecified",
      selected: ["code-review-graph", "codebase-memory-mcp", "serena", "markitdown", "playwright"],
      excluded: ["token-optimizer", "context7"],
      diagnostics: [],
    });
  });

  it.each(["invalid", "missing", "revoked", "changed", "conflicting"] as const)(
    "fails closed for a %s bound policy without restoring defaults",
    (binding) => {
      const result = resolveDefaultToolSelection({ policy: { kind: "bound", binding } });
      expect(result.accepted).toBe(false);
      expect(result.source).toBe("fail-closed");
      expect(result.selected).toEqual([]);
      expect(result.diagnostics).toEqual([expect.objectContaining({ code: "unusable-binding" })]);
    },
  );

  it.each([
    {
      label: "unknown selected id",
      policy: { selected: ["unknown-tool"] },
      code: "unknown-tool",
    },
    {
      label: "duplicate selected id",
      policy: { selected: ["serena", "serena"] },
      code: "duplicate-tool",
    },
    {
      label: "unknown excluded id",
      policy: { excluded: ["unknown-tool"] },
      code: "unknown-tool",
    },
    {
      label: "duplicate excluded id",
      policy: { excluded: ["context7", "context7"] },
      code: "duplicate-tool",
    },
    {
      label: "selected and excluded conflict",
      policy: { selected: ["context7"], excluded: ["context7"] },
      code: "selection-conflict",
    },
  ])("rejects $label", ({ policy, code }) => {
    const result = resolveDefaultToolSelection({
      policy: { kind: "bound", binding: "valid", ...policy },
    });
    expect(result).toMatchObject({ accepted: false, source: "fail-closed", selected: [] });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code })]);
  });

  it("recognizes only supported developer tool ids", () => {
    expect(isDeveloperToolId("code-review-graph")).toBe(true);
    expect(isDeveloperToolId("token-optimizer")).toBe(true);
    expect(isDeveloperToolId("playwright")).toBe(true);
    expect(isDeveloperToolId("github")).toBe(false);
    expect(isDeveloperToolId(42)).toBe(false);
  });
});
