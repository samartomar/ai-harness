import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultStudioPolicy } from "../../src/org-policy/studio-model.js";
import {
  type PolicyWorkbenchUi,
  runPolicyWorkbenchUi,
  startPolicyWorkbenchUi,
} from "../../src/org-policy/ui-server.js";

const { resolveGithubSkillMock, spawnMock } = vi.hoisted(() => ({
  resolveGithubSkillMock: vi.fn(),
  spawnMock: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../../src/org-policy/workbench/core/bounded-github-skill-resolver.js", () => ({
  resolveConnectedGithubSkillV1: resolveGithubSkillMock,
}));

async function withTinyPreparedCatalog<T>(
  action: (ui: typeof import("../../src/org-policy/ui-server.js")) => Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doMock("../../src/org-policy/workbench/prepared-catalog.js", async () => {
    const fixture = await import("./studio-test-fixture.js");
    return {
      defaultPreparedWorkbenchCatalog: fixture.prepareTinyWorkbenchCatalogV1,
      packagedPreparedWorkbenchCatalogV1: fixture.prepareTinyWorkbenchCatalogV1,
      prepareWorkbenchCatalog: fixture.prepareTinyWorkbenchCatalogV1,
    };
  });
  vi.doMock("../../src/org-policy/workbench/default-catalog-preassembly.js", async (original) => ({
    ...(await original<
      typeof import("../../src/org-policy/workbench/default-catalog-preassembly.js")
    >()),
    packagedDefaultCatalogPreassemblyCompanionV1: () => undefined,
  }));
  try {
    return await action(await import("../../src/org-policy/ui-server.js"));
  } finally {
    vi.doUnmock("../../src/org-policy/workbench/prepared-catalog.js");
    vi.doUnmock("../../src/org-policy/workbench/default-catalog-preassembly.js");
    vi.resetModules();
  }
}

describe("Policy Workbench UI server", () => {
  let running: PolicyWorkbenchUi | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
    resolveGithubSkillMock.mockReset();
  });

  it("serves the packaged portable Workbench on an available loopback port", async () => {
    const opened: string[] = [];
    running = await startPolicyWorkbenchUi({
      openBrowser: async (url) => {
        opened.push(url);
      },
    });

    expect(running.url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/aih-policy-workbench\.html#[a-f0-9]{64}$/,
    );
    expect(opened).toEqual([running.url]);

    const response = await fetch(running.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.text()).resolves.toContain("Policy Workbench");

    const missing = await fetch(new URL("/not-a-workbench", running.url));
    expect(missing.status).toBe(404);
  });

  it("keeps the one-route server explicit for redirects, HEAD, and unsupported methods", async () => {
    running = await startPolicyWorkbenchUi({ openBrowser: async () => {} });

    const root = await fetch(new URL("/", running.url), { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/aih-policy-workbench.html");
    expect(root.headers.get("cache-control")).toBe("no-store");

    const head = await fetch(running.url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toMatch(/^\d+$/);
    await expect(head.text()).resolves.toBe("");

    const unsupported = await fetch(running.url, { method: "POST" });
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("allow")).toBe("GET, HEAD");
  });

  it("resolves only a same-origin, token-bound Skill request without accepting a URL proxy", async () => {
    resolveGithubSkillMock.mockResolvedValue({
      version: "aih-connected-github-skill/v1" as const,
      state: "resolved-not-scanned" as const,
      skill: "frontend-design" as const,
      source: {
        type: "github" as const,
        repository: "anthropics/skills" as const,
        commit: "41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f",
        path: "skills/frontend-design/SKILL.md" as const,
      },
    });
    running = await startPolicyWorkbenchUi({ openBrowser: async () => {} });
    const launcher = new URL(running.url);
    const endpoint = new URL("/api/artifact-intake/github-skill/resolve", running.url);
    const headers = {
      Origin: launcher.origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    };

    const rejected = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: launcher.hash.slice(1),
        repository: "anthropics/skills",
        skill: "frontend-design",
        url: "https://example.invalid/never-fetched",
      }),
    });
    expect(rejected.status).toBe(403);
    expect(resolveGithubSkillMock).not.toHaveBeenCalled();

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: launcher.hash.slice(1),
        repository: "anthropics/skills",
        skill: "frontend-design",
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "resolved-not-scanned",
      source: { commit: "41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f" },
    });
    expect(resolveGithubSkillMock).toHaveBeenCalledWith({
      repository: "anthropics/skills",
      skill: "frontend-design",
    });
  });

  it("rejects API requests that lack the loopback origin or launcher token", async () => {
    running = await startPolicyWorkbenchUi({ openBrowser: async () => {} });
    const launcher = new URL(running.url);
    const endpoint = new URL("/api/artifact-intake/github-skill/resolve", running.url);

    const missingOrigin = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(missingOrigin.status).toBe(403);

    const badToken = await fetch(endpoint, {
      method: "POST",
      headers: {
        Origin: launcher.origin,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token: "0".repeat(64),
        repository: "anthropics/skills",
        skill: "frontend-design",
      }),
    });
    expect(badToken.status).toBe(403);
    expect(resolveGithubSkillMock).not.toHaveBeenCalled();
  });

  it("rebuilds the connected Workbench with a Core-prepared pending Skill policy", async () => {
    const resolved = {
      version: "aih-connected-github-skill/v1" as const,
      state: "resolved-not-scanned" as const,
      skill: "frontend-design",
      source: {
        type: "github" as const,
        repository: "anthropics/skills",
        commit: "41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f",
        path: "skills/frontend-design/SKILL.md",
      },
    };
    resolveGithubSkillMock.mockResolvedValue(resolved);
    await withTinyPreparedCatalog(async ({ startPolicyWorkbenchUi: start }) => {
      running = await start({ openBrowser: async () => {} });
      const launcher = new URL(running.url);
      const headers = {
        Origin: launcher.origin,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      };
      const resolve = await fetch(
        new URL("/api/artifact-intake/github-skill/resolve", running.url),
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            token: launcher.hash.slice(1),
            repository: resolved.source.repository,
            skill: resolved.skill,
          }),
        },
      );
      expect(resolve.status).toBe(200);

      const prepared = await fetch(
        new URL("/api/artifact-intake/github-skill/prepare", running.url),
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            token: launcher.hash.slice(1),
            policy: defaultStudioPolicy(),
            source: {
              repository: resolved.source.repository,
              skill: resolved.skill,
              commit: resolved.source.commit,
              path: resolved.source.path,
            },
          }),
        },
      );
      await expect(prepared.json()).resolves.toEqual({
        version: "aih-connected-github-skill-bridge/v1",
        state: "prepared-pending-evidence",
        reload: true,
      });
      const refreshed = await (await fetch(running.url)).text();
      expect(refreshed).toContain("Pending security review: frontend-design");
      expect(refreshed).toContain(resolved.source.commit);
      expect(refreshed).not.toContain('"approvals":[{"');
    });
  });

  it("rejects a stale or substituted resolved Skill before rebuilding the Workbench", async () => {
    const resolved = {
      version: "aih-connected-github-skill/v1" as const,
      state: "resolved-not-scanned" as const,
      skill: "frontend-design",
      source: {
        type: "github" as const,
        repository: "anthropics/skills",
        commit: "41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f",
        path: "skills/frontend-design/SKILL.md",
      },
    };
    resolveGithubSkillMock.mockResolvedValue(resolved);
    running = await startPolicyWorkbenchUi({ openBrowser: async () => {} });
    const launcher = new URL(running.url);
    const headers = {
      Origin: launcher.origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    };
    await fetch(new URL("/api/artifact-intake/github-skill/resolve", running.url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: launcher.hash.slice(1),
        repository: resolved.source.repository,
        skill: resolved.skill,
      }),
    });

    const before = await (await fetch(running.url)).text();
    const prepared = await fetch(
      new URL("/api/artifact-intake/github-skill/prepare", running.url),
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          token: launcher.hash.slice(1),
          policy: defaultStudioPolicy(),
          source: {
            repository: resolved.source.repository,
            skill: resolved.skill,
            commit: "a".repeat(40),
            path: resolved.source.path,
          },
        }),
      },
    );
    expect(prepared.status).toBe(409);
    expect(await (await fetch(running.url)).text()).toBe(before);
  });

  it("does not inspect or write the current repository", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aih-ui-rootless-"));
    const priorCwd = process.cwd();
    try {
      process.chdir(cwd);
      await withTinyPreparedCatalog(async ({ startPolicyWorkbenchUi: start }) => {
        running = await start({ openBrowser: async () => {} });
        expect(running.url).toMatch(
          /^http:\/\/127\.0\.0\.1:\d+\/aih-policy-workbench\.html#[a-f0-9]{64}$/,
        );
      });
      expect(existsSync(join(cwd, "aih-policy-workbench.html"))).toBe(false);
      expect(existsSync(join(cwd, ".aih"))).toBe(false);
    } finally {
      process.chdir(priorCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps serving and reports a browser-launch failure with the usable URL", async () => {
    const messages: string[] = [];
    running = await startPolicyWorkbenchUi({
      openBrowser: async () => {
        throw new Error("browser unavailable");
      },
      writeError: (message) => messages.push(message),
    });

    expect(messages.join("\n")).toContain("browser unavailable");
    expect(messages.join("\n")).toContain(running.url);
    await expect(fetch(running.url)).resolves.toMatchObject({ status: 200 });
  });

  it("uses the platform browser launcher without a shell when no override is supplied", async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawnMock.mockReturnValueOnce(child);

    const starting = startPolicyWorkbenchUi();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    child.emit("spawn");
    running = await starting;

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([expect.stringContaining(running.url)]),
      expect.objectContaining({ detached: true, shell: false, windowsHide: true }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("prints the usable URL and closes through its registered termination handler", async () => {
    const opened: string[] = [];
    const messages: string[] = [];
    const priorHandlers = new Set(process.listeners("SIGTERM"));
    const completion = runPolicyWorkbenchUi({
      openBrowser: async (url) => {
        opened.push(url);
      },
      write: (message) => messages.push(message),
    });

    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const stop = process.listeners("SIGTERM").find((handler) => !priorHandlers.has(handler));
    if (stop === undefined) throw new Error("expected Workbench termination handler");
    stop("SIGTERM");
    await completion;

    expect(messages.join("\n")).toContain(`AIH Policy Workbench: ${opened[0]}`);
    expect(messages.join("\n")).toContain("Press Ctrl+C to stop.");
    await expect(fetch(opened[0] ?? "")).rejects.toThrow();
  });
});
