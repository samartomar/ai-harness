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

  it("preserves per-child remote and ref on object repo entries", () => {
    const m = parseWorkspaceManifest(
      {
        repos: [
          {
            id: "backend",
            path: "services/backend",
            remote: "https://github.com/acme/backend.git",
            ref: "release/v1.5.0",
          },
        ],
      },
      "ai-coding",
    );

    expect(m.status).toBe("OK");
    expect(m.repos).toEqual([
      {
        id: "backend",
        path: "services/backend",
        remote: "https://github.com/acme/backend.git",
        ref: "release/v1.5.0",
        router: "ai-coding/RULE_ROUTER.md",
      },
    ]);
  });

  it("accepts https, ssh, and scp-like child remotes with safe refs", () => {
    const m = parseWorkspaceManifest(
      {
        repos: [
          {
            id: "https",
            path: "https",
            remote: "https://github.com/acme/https.git",
            ref: "refs/heads/main",
          },
          {
            id: "ssh",
            path: "ssh",
            remote: "ssh://git@github.com/acme/ssh.git",
            ref: "a".repeat(40),
          },
          {
            id: "scp",
            path: "scp",
            remote: "git@github.com:acme/scp.git",
            ref: "release/v1.5.0",
          },
        ],
      },
      "ai-coding",
    );

    expect(m.status).toBe("OK");
    expect(m.repos.map((repo) => repo.remote)).toEqual([
      "https://github.com/acme/https.git",
      "ssh://git@github.com/acme/ssh.git",
      "git@github.com:acme/scp.git",
    ]);
  });

  it("rejects invalid per-child remote and ref metadata without throwing", () => {
    const m = parseWorkspaceManifest(
      {
        repos: [
          {
            id: "unsafe-remote",
            path: "services/api",
            remote: "https://github.com/acme/api.git\n--upload-pack=sh",
          },
          {
            id: "bad-ref",
            path: "services/ui",
            ref: 42,
          },
        ],
      },
      "ai-coding",
    );

    expect(m.status).toBe("ERROR");
    expect(m.repos).toEqual([]);
    expect(m.errors.join("\n")).toMatch(/workspace repo remote must be safe to print/);
    expect(m.errors.join("\n")).toMatch(/workspace repo ref must be a string/);
  });

  it("rejects option-like or boundary-whitespace child source metadata", () => {
    const m = parseWorkspaceManifest(
      {
        repos: [
          {
            id: "leading-space",
            path: "leading-space",
            remote: " https://github.com/acme/api.git",
          },
          {
            id: "option-remote",
            path: "option-remote",
            remote: "--upload-pack=evil",
          },
          {
            id: "noncanonical-remote",
            path: "noncanonical-remote",
            remote: "https:github.com/acme/api.git",
          },
          {
            id: "single-slash-remote",
            path: "single-slash-remote",
            remote: "https:/github.com/acme/api.git",
          },
          {
            id: "backslash-remote",
            path: "backslash-remote",
            remote: "https://github.com\\acme\\api.git",
          },
          {
            id: "credential-remote",
            path: "credential-remote",
            remote: "https://token@github.com/acme/api.git",
          },
          {
            id: "option-ref",
            path: "option-ref",
            remote: "https://github.com/acme/api.git",
            ref: "--upload-pack=evil",
          },
          {
            id: "dotdot-ref",
            path: "dotdot-ref",
            remote: "https://github.com/acme/api.git",
            ref: "main..evil",
          },
        ],
      },
      "ai-coding",
    );

    expect(m.status).toBe("ERROR");
    expect(m.repos).toEqual([]);
    const errors = m.errors.join("\n");
    expect(errors).toMatch(/workspace repo remote must not contain whitespace/);
    expect(errors).toMatch(/workspace repo remote must be an https or ssh Git remote URL/);
    expect(errors).toMatch(/workspace repo ref must be a safe Git ref/);
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

  it("rejects duplicate repo paths even when repo ids differ", () => {
    const m = parseWorkspaceManifest(
      {
        repos: [
          { id: "api-a", path: "api", kind: "backend" },
          { id: "api-b", path: "api", kind: "frontend" },
        ],
      },
      "ai-coding",
    );

    expect(m.status).toBe("ERROR");
    expect(m.errors.join("\n")).toMatch(/duplicate repo path/);
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
