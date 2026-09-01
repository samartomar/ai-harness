import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PolicyWorkbenchUi,
  runPolicyWorkbenchUi,
  startPolicyWorkbenchUi,
} from "../../src/org-policy/ui-server.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

describe("Policy Workbench UI server", () => {
  let running: PolicyWorkbenchUi | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("serves the packaged portable Workbench on an available loopback port", async () => {
    const opened: string[] = [];
    running = await startPolicyWorkbenchUi({
      openBrowser: async (url) => {
        opened.push(url);
      },
    });

    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/aih-policy-workbench\.html$/);
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

  it("does not inspect or write the current repository", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aih-ui-rootless-"));
    const priorCwd = process.cwd();
    try {
      process.chdir(cwd);
      running = await startPolicyWorkbenchUi({ openBrowser: async () => {} });
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
