import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type PolicyWorkbenchUi, startPolicyWorkbenchUi } from "../../src/org-policy/ui-server.js";

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
});
