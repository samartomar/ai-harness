import { describe, expect, it } from "vitest";
import { parseWorkspaceManifest, workspaceReposFromPaths } from "../../src/workspace/manifest.js";

describe("workspace manifest parser", () => {
  it("normalizes the current repos:string[] shape", () => {
    const m = parseWorkspaceManifest(
      {
        workspaceType: "multi-repo",
        contextDir: "ai-coding",
        repos: ["ui"],
        git: true,
        generatedBy: "aih workspace",
      },
      "ai-coding",
    );

    expect(m.status).toBe("OK");
    expect(m.git).toBe(true);
    expect(m.repos).toEqual([{ id: "ui", path: "ui", router: "ai-coding/RULE_ROUTER.md" }]);
  });

  it("normalizes the future object repo shape and preserves unknown fields", () => {
    const m = parseWorkspaceManifest(
      {
        schemaVersion: 1,
        contextDir: "canon",
        repos: [{ id: "backend", path: "services/backend", kind: "api", extra: "kept" }],
        edges: [
          {
            id: "ui-api",
            from: "ui",
            to: "backend",
            kind: "api-contract",
            contractPath: "services/backend/openapi.yaml",
            consumerPath: "ui/src/api",
          },
        ],
        unknownFutureField: { ok: true },
      },
      "ai-coding",
    );

    expect(m.status).toBe("OK");
    expect(m.contextDir).toBe("canon");
    expect(m.raw).toMatchObject({ unknownFutureField: { ok: true } });
    expect(m.repos).toEqual([
      {
        id: "backend",
        path: "services/backend",
        kind: "api",
        router: "ai-coding/RULE_ROUTER.md",
      },
    ]);
    expect(m.edges).toEqual([
      {
        id: "ui-api",
        from: "ui",
        to: "backend",
        kind: "api-contract",
        contractPath: "services/backend/openapi.yaml",
        consumerPath: "ui/src/api",
      },
    ]);
  });

  it("degrades invalid repo entries to ERROR without throwing", () => {
    const m = parseWorkspaceManifest(
      {
        repos: [
          "ui",
          "../escape",
          { id: "bad/id", path: "backend" },
          { id: "ui", path: "duplicate" },
        ],
      },
      "ai-coding",
    );

    expect(m.status).toBe("ERROR");
    expect(m.repos).toEqual([{ id: "ui", path: "ui", router: "ai-coding/RULE_ROUTER.md" }]);
    expect(m.errors.join("\n")).toMatch(/traverse parents/);
    expect(m.errors.join("\n")).toMatch(/path-safe/);
    expect(m.errors.join("\n")).toMatch(/duplicate repo id/);
  });

  it("rejects inline Markdown and HTML syntax in printable manifest fields", () => {
    const m = parseWorkspaceManifest(
      {
        repos: [
          { id: "ok", path: "ok", kind: "[link](javascript:alert(1))" },
          "<img src=x onerror=alert(1)>",
        ],
        edges: [
          {
            id: "edge",
            from: "ok",
            to: "ok",
            kind: "<b>api</b>",
          },
        ],
      },
      "ai-coding",
    );

    expect(m.status).toBe("ERROR");
    expect(m.errors.join("\n")).toMatch(/safe to print/);
  });

  it("builds normalized repo objects for generated workspace docs", () => {
    expect(workspaceReposFromPaths(["services/api", "ui"])).toEqual([
      {
        id: "services-api",
        path: "services/api",
        router: "ai-coding/RULE_ROUTER.md",
      },
      { id: "ui", path: "ui", router: "ai-coding/RULE_ROUTER.md" },
    ]);
  });

  it("rejects generated workspace router paths that escape the child repo", () => {
    expect(() => workspaceReposFromPaths(["ui"], "../escape.md")).toThrow(/must not traverse/);
  });
});
