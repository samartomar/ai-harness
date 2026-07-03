import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DigestAction, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/report/index.js";
import type { WorkspaceReportDigest } from "../../src/report/workspace.js";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-workspace-report-"));
  home = mkdtempSync(join(tmpdir(), "aih-workspace-report-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function defaultGitRunner(): Runner {
  return fakeRunner((argv) => {
    if (argv[0] !== "git") return undefined;
    const cwd = String(argv[2] ?? "");
    const repo = cwd.replace(/\\/g, "/").split("/").at(-1) ?? "";
    const tail = argv.slice(3).join(" ");
    if (tail === "rev-parse --is-inside-work-tree") return { stdout: "true\n" };
    if (tail === "rev-parse --abbrev-ref HEAD") return { stdout: "main\n" };
    if (tail === "rev-parse --short HEAD") return { stdout: `${repo.slice(0, 6) || "abc123"}\n` };
    if (tail === "status --porcelain") return { stdout: "" };
    if (tail === "rev-list --left-right --count HEAD...@{upstream}") {
      return { code: 1, stdout: "" };
    }
    return undefined;
  });
}

function ctx(options: Record<string, unknown> = {}, run: Runner = defaultGitRunner()): PlanContext {
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: home, USERPROFILE: home },
    options,
  };
}

function writeWorkspaceManifest(manifest: unknown): void {
  writeFileSync(join(root, ".aih-workspace.json"), json(manifest));
}

function child(
  name: string,
  opts: {
    canon?: boolean;
    history?: "fresh" | "stale" | false;
    usage?: boolean;
    report?: boolean;
  } = {},
): void {
  const canon = opts.canon ?? true;
  const history = opts.history ?? "fresh";
  const usage = opts.usage ?? true;
  const report = opts.report ?? true;
  const dir = join(root, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  if (canon) {
    mkdirSync(join(dir, "ai-coding"), { recursive: true });
    writeFileSync(join(dir, "ai-coding", "RULE_ROUTER.md"), "# Router\n");
    writeFileSync(
      join(dir, ".aih-config.json"),
      json({ schemaVersion: 1, contextDir: "ai-coding", targets: ["codex"] }),
    );
  }
  mkdirSync(join(dir, ".aih"), { recursive: true });
  if (history) {
    const ts = history === "fresh" ? new Date().toISOString() : "2020-01-01T00:00:00.000Z";
    writeFileSync(
      join(dir, ".aih", "history.jsonl"),
      `${JSON.stringify({ ts, sha: name.slice(0, 6), branch: "main", driftCount: 1 })}\n`,
    );
  }
  if (usage) writeFileSync(join(dir, ".aih", "usage.jsonl"), '{"event":"run"}\n');
  if (report) {
    mkdirSync(join(dir, ".aih", "reports"), { recursive: true });
    const reportPath = join(dir, ".aih", "reports", "local-report.html");
    writeFileSync(reportPath, "<!doctype html>\n");
    const now = new Date();
    utimesSync(reportPath, now, now);
  }
}

async function workspaceDigest(options: Record<string, unknown> = {}): Promise<DigestAction> {
  const digest = (await command.plan(ctx(options))).actions.find(
    (a): a is DigestAction => a.kind === "digest" && a.describe.startsWith("Workspace rollup"),
  );
  if (!digest) throw new Error("expected workspace rollup digest");
  return digest;
}

describe("report workspace rollup", () => {
  it("auto-detects a workspace manifest and emits child health rows", async () => {
    writeWorkspaceManifest({ repos: ["ui", "backend"], contextDir: "ai-coding", git: true });
    writeFileSync(join(root, ".gitignore"), "ui/\nbackend/\n.aih/\n");
    child("ui");
    child("backend");

    const d = await workspaceDigest();
    const data = d.data as WorkspaceReportDigest;

    expect(d.describe).toContain("2 repos");
    expect(d.text).toContain("| ui | ui/ | OK | OK | OK | OK | OK | 1 |");
    expect(data.rows.map((r) => r.status)).toEqual(["OK", "OK"]);
    expect(data.rows[0]).toMatchObject({
      id: "ui",
      path: "ui",
      canon: { status: "OK" },
      usage: { status: "OK", events: 1 },
      drift: { count: 1 },
    });
  });

  it("labels missing child canon as NOT_ONBOARDED", async () => {
    writeWorkspaceManifest({ repos: ["infra"], contextDir: "ai-coding" });
    child("infra", { canon: false, history: false, usage: false, report: false });

    const data = (await workspaceDigest()).data as WorkspaceReportDigest;

    expect(data.rows[0]).toMatchObject({
      id: "infra",
      canon: { status: "NOT_ONBOARDED" },
      status: "NOT_ONBOARDED",
    });
  });

  it("labels missing local telemetry as NOT_COLLECTED instead of failed", async () => {
    writeWorkspaceManifest({ repos: ["backend"], contextDir: "ai-coding" });
    child("backend", { history: false, usage: false, report: false });

    const d = await workspaceDigest();
    const row = (d.data as WorkspaceReportDigest).rows[0];
    if (!row) throw new Error("expected backend row");

    expect(d.text).toContain("NOT_COLLECTED");
    expect(row).toMatchObject({
      history: { status: "NOT_COLLECTED" },
      usage: { status: "NOT_COLLECTED" },
      status: "WARN",
    });
  });

  it("marks stale history samples with the workspace status vocabulary", async () => {
    writeWorkspaceManifest({ repos: ["ui"], contextDir: "ai-coding" });
    child("ui", { history: "stale" });

    const row = ((await workspaceDigest()).data as WorkspaceReportDigest).rows[0];
    if (!row) throw new Error("expected ui row");

    expect(row.history.status).toBe("STALE");
    expect(row.status).toBe("STALE");
  });

  it("supports object-shaped repos and explicit contract edges", async () => {
    writeWorkspaceManifest({
      schemaVersion: 1,
      contextDir: "ai-coding",
      repos: [
        { id: "ui", path: "ui", kind: "frontend" },
        { id: "backend", path: "backend", kind: "api" },
      ],
      edges: [
        {
          id: "ui-backend-api",
          from: "ui",
          to: "backend",
          kind: "api-contract",
          contractPath: "backend/openapi.yaml",
          consumerPath: "ui/src/api",
        },
        {
          id: "missing-contract",
          from: "ui",
          to: "backend",
          kind: "api-contract",
          contractPath: "backend/missing.yaml",
        },
      ],
    });
    child("ui");
    mkdirSync(join(root, "ui", "src", "api"), { recursive: true });
    child("backend");
    writeFileSync(join(root, "backend", "openapi.yaml"), "openapi: 3.1.0\n");

    const data = (await workspaceDigest()).data as WorkspaceReportDigest;

    expect(data.rows.map((r) => r.id)).toEqual(["ui", "backend"]);
    expect(data.contracts).toEqual([
      expect.objectContaining({ id: "ui-backend-api", status: "OK" }),
      expect.objectContaining({ id: "missing-contract", status: "MISSING" }),
    ]);
  });

  it("degrades malformed manifests into an ERROR digest without crashing report", async () => {
    writeFileSync(join(root, ".aih-workspace.json"), "{ nope");

    const d = await workspaceDigest();
    const data = d.data as WorkspaceReportDigest;

    expect(d.describe).toContain("ERROR");
    expect(data.manifest.status).toBe("ERROR");
    expect(data.rows).toEqual([]);
  });

  it("fails closed when a manifest repo path points through a link outside the workspace", async () => {
    const external = mkdtempSync(join(tmpdir(), "aih-workspace-report-external-"));
    try {
      mkdirSync(join(external, ".git"), { recursive: true });
      symlinkSync(external, join(root, "linked"), "junction");
      writeWorkspaceManifest({ repos: ["linked"], contextDir: "ai-coding" });

      await expect(command.plan(ctx())).rejects.toThrow(/real directory/);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("writes workspace report artifacts under .aih/workspace-report.*", async () => {
    writeWorkspaceManifest({ repos: ["ui"], contextDir: "ai-coding" });
    child("ui");

    const actions = (await command.plan(ctx({ workspace: true, format: "html" }))).actions;
    const write = actions.find((a) => a.kind === "write");

    expect(write?.kind === "write" && write.path.replace(/\\/g, "/")).toBe(
      ".aih/workspace-report.html",
    );
    expect(write?.kind === "write" && write.contents).toContain("Workspace rollup");
  });

  it("shows child repo changes since the latest workspace snapshot", async () => {
    writeWorkspaceManifest({ repos: ["ui"], contextDir: "ai-coding" });
    child("ui");
    mkdirSync(join(root, ".aih", "workspace-snapshots"), { recursive: true });
    writeFileSync(
      join(root, ".aih", "workspace-snapshots", "20260630T000000Z-known-good.json"),
      json({
        schemaVersion: 1,
        createdAt: "2026-06-30T00:00:00.000Z",
        label: "known-good",
        repos: [{ id: "ui", path: "ui", branch: "main", sha: "old123", dirty: false }],
      }),
    );

    const d = await workspaceDigest();
    const data = d.data as WorkspaceReportDigest;

    expect(d.text).toContain("Changed since snapshot");
    expect(data.snapshot?.changes).toEqual([
      expect.objectContaining({ id: "ui", status: "CHANGED", before: "old123", after: "ui" }),
    ]);
  });

  it("warns when the workspace filesystem MCP package is unpinned", async () => {
    writeWorkspaceManifest({ repos: ["ui"], contextDir: "ai-coding" });
    writeFileSync(
      join(root, ".mcp.json"),
      json({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "ui"],
          },
        },
      }),
    );
    child("ui");

    const d = await workspaceDigest();
    const data = d.data as WorkspaceReportDigest;

    expect(d.text).toContain("Workspace MCP filesystem server is unpinned.");
    expect(data.mcp.status).toBe("WARN");
  });

  it("warns when the workspace filesystem MCP package uses a floating tag", async () => {
    writeWorkspaceManifest({ repos: ["ui"], contextDir: "ai-coding" });
    writeFileSync(
      join(root, ".mcp.json"),
      json({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem@latest", "ui"],
          },
        },
      }),
    );
    child("ui");

    const data = (await workspaceDigest()).data as WorkspaceReportDigest;

    expect(data.mcp).toMatchObject({
      status: "WARN",
      packageSpec: "@modelcontextprotocol/server-filesystem@latest",
    });
  });

  it("warns when the workspace filesystem MCP package uses a version range", async () => {
    writeWorkspaceManifest({ repos: ["ui"], contextDir: "ai-coding" });
    writeFileSync(
      join(root, ".mcp.json"),
      json({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem@^2026.1.14", "ui"],
          },
        },
      }),
    );
    child("ui");

    const data = (await workspaceDigest()).data as WorkspaceReportDigest;

    expect(data.mcp).toMatchObject({
      status: "WARN",
      packageSpec: "@modelcontextprotocol/server-filesystem@^2026.1.14",
    });
  });

  it("builds independent child evidence rows concurrently", async () => {
    writeWorkspaceManifest({ repos: ["ui", "backend"], contextDir: "ai-coding" });
    child("ui");
    child("backend");
    let activeInsideChecks = 0;
    let maxInsideChecks = 0;
    const run: Runner = async (argv) => {
      if (argv[0] !== "git") return { code: 0, stdout: "", stderr: "" };
      const tail = argv.slice(3).join(" ");
      const repo = String(argv[2] ?? "")
        .replace(/\\/g, "/")
        .split("/")
        .at(-1);
      if (tail === "rev-parse --is-inside-work-tree") {
        activeInsideChecks++;
        maxInsideChecks = Math.max(maxInsideChecks, activeInsideChecks);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeInsideChecks--;
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (tail === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
      if (tail === "rev-parse --short HEAD") {
        return { code: 0, stdout: `${repo ?? "abc123"}\n`, stderr: "" };
      }
      if (tail === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };

    await command.plan(ctx({}, run));

    expect(maxInsideChecks).toBeGreaterThan(1);
  });

  it("caps concurrent child evidence git probes for larger workspaces", async () => {
    const repos = ["api", "docs", "infra", "shared", "ui", "web", "worker", "jobs"];
    writeWorkspaceManifest({ repos, contextDir: "ai-coding" });
    for (const name of repos) child(name);
    let activeInsideChecks = 0;
    let maxInsideChecks = 0;
    const run: Runner = async (argv) => {
      if (argv[0] !== "git") return { code: 0, stdout: "", stderr: "" };
      const tail = argv.slice(3).join(" ");
      const repo = String(argv[2] ?? "")
        .replace(/\\/g, "/")
        .split("/")
        .at(-1);
      if (tail === "rev-parse --is-inside-work-tree") {
        activeInsideChecks++;
        maxInsideChecks = Math.max(maxInsideChecks, activeInsideChecks);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeInsideChecks--;
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (tail === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
      if (tail === "rev-parse --short HEAD") {
        return { code: 0, stdout: `${repo ?? "abc123"}\n`, stderr: "" };
      }
      if (tail === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };

    await command.plan(ctx({}, run));

    expect(maxInsideChecks).toBeGreaterThan(1);
    expect(maxInsideChecks).toBeLessThanOrEqual(4);
  });
});
