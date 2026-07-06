import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command as bootstrapAiCommand } from "../../src/bootstrap-ai/index.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { defaultRunner, fakeRunner, type Runner } from "../../src/internals/proc.js";
import { command as mcpCommand } from "../../src/mcp/index.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command as uninstallCommand } from "../../src/uninstall/index.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-uninstall-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function put(relPath: string, contents: string): void {
  const full = join(tmp, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function makeCtx(
  options: Record<string, unknown> = {},
  flags: { apply?: boolean; verify?: boolean } = {},
  run: Runner = fakeRunner(() => undefined),
): PlanContext {
  return {
    root: tmp,
    contextDir: "ai-coding",
    apply: flags.apply ?? false,
    verify: flags.verify ?? false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: tmp },
    options,
  };
}

const git = (...args: string[]): void => {
  execFileSync("git", ["-C", tmp, ...args], { stdio: "ignore" });
};

function gitCtx(options: Record<string, unknown> = {}): PlanContext {
  return makeCtx(options, { apply: true }, defaultRunner);
}

function commitFixture(): void {
  git("init", "-q");
  git("config", "user.email", "t@t.com");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "base");
}

async function bootstrapFixture(cli = "claude"): Promise<void> {
  put("package.json", JSON.stringify({ name: "fixture" }));
  const bootstrapCtx = makeCtx({ cli, canon: "compact" }, { apply: true });
  await executePlan(await bootstrapAiCommand.plan(bootstrapCtx), bootstrapCtx);
  const mcpCtx = makeCtx({ cli, scope: "project" }, { apply: true });
  await executePlan(await mcpCommand.plan(mcpCtx), mcpCtx);
  put(".aih/runs/one.jsonl", "{}\n");
}

describe("aih uninstall", () => {
  it("previews the core install footprint without mutating disk in dry-run", async () => {
    await bootstrapFixture();

    const ctx = makeCtx();
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const removed = new Map(result.removed.map((r) => [r.path, r]));
    const digest = result.digests.find((d) => d.describe.includes("core install footprint"));
    const artifacts = digest?.data as
      | { artifacts?: Array<{ path: string; disposition: string }> }
      | undefined;

    expect(removed.get("ai-coding")?.effect).toBe("delete");
    expect(removed.get(".aih-config.json")?.effect).toBe("delete");
    expect(removed.get(".aih")?.effect).toBe("delete");
    expect(removed.has(".mcp.json")).toBe(false);

    expect(artifacts?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "ai-coding", disposition: "backup" }),
        expect.objectContaining({ path: ".aih-config.json", disposition: "backup" }),
        expect.objectContaining({ path: ".mcp.json", disposition: "advisory" }),
        expect.objectContaining({ path: ".aih", disposition: "backup" }),
      ]),
    );

    expect(existsSync(join(tmp, "ai-coding"))).toBe(true);
    expect(existsSync(join(tmp, ".aih-config.json"))).toBe(true);
    expect(existsSync(join(tmp, ".mcp.json"))).toBe(true);
    expect(existsSync(join(tmp, ".aih"))).toBe(true);
  });

  it("applies owned removals and surfaces co-owned bootloaders for manual cleanup", async () => {
    await bootstrapFixture();

    const ctx = makeCtx({}, { apply: true });
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const removed = new Map(result.removed.map((r) => [r.path, r]));
    const digest = result.digests.find((d) => d.describe.includes("core install footprint"));
    const artifacts = digest?.data as
      | { artifacts?: Array<{ path: string; disposition: string; kind: string }> }
      | undefined;

    expect(removed.get("ai-coding")?.effect).toBe("delete");
    expect(removed.get(".aih-config.json")?.effect).toBe("delete");
    expect(removed.get(".aih")?.effect).toBe("delete");

    expect(existsSync(join(tmp, "ai-coding"))).toBe(false);
    expect(existsSync(join(tmp, "ai-coding.aih.bak"))).toBe(true);
    expect(existsSync(join(tmp, ".aih-config.json"))).toBe(false);
    expect(existsSync(join(tmp, ".mcp.json"))).toBe(true);
    expect(existsSync(join(tmp, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(tmp, "CLAUDE.md"), "utf8")).toContain(
      "<!-- BEGIN ai-canonical:shared",
    );
    expect(artifacts?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "CLAUDE.md",
          kind: "bootloader",
          disposition: "advisory",
        }),
      ]),
    );
  });

  it("surfaces repo-scoped MCP configs outside the root .mcp.json path", async () => {
    await bootstrapFixture("cursor");

    const ctx = makeCtx();
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const digest = result.digests.find((d) => d.describe.includes("core install footprint"));
    const artifacts = digest?.data as
      | { artifacts?: Array<{ path: string; disposition: string; kind: string }> }
      | undefined;

    expect(result.removed.map((r) => r.path)).not.toContain(".cursor/mcp.json");
    expect(artifacts?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".cursor/mcp.json",
          kind: "mcp",
          disposition: "advisory",
        }),
      ]),
    );
  });

  it("backs up Kiro-owned steering and hook extras without touching team hooks", async () => {
    await bootstrapFixture("kiro");
    put(".kiro/hooks/team-custom.kiro.hook", "{}\n");

    const ctx = makeCtx();
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const removed = new Map(result.removed.map((r) => [r.path, r]));

    expect(removed.get(".kiro/steering/agent-tools.md")?.effect).toBe("delete");
    expect(removed.get(".kiro/hooks/aih-secret-scan-on-create.kiro.hook")?.effect).toBe("delete");
    expect(removed.get(".kiro/hooks/aih-tests-on-edit.kiro.hook")?.effect).toBe("delete");
    expect(removed.get(".kiro/hooks/aih-metrics-on-stop.kiro.hook")?.effect).toBe("delete");
    expect(removed.has(".kiro/hooks/team-custom.kiro.hook")).toBe(false);
  });

  it("does not back up Kiro-looking extras without generated Kiro ownership evidence", async () => {
    put(
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["kiro"] }),
    );
    put(".kiro/steering/agent-tools.md", "# Team-owned tools\n");
    put(".kiro/hooks/aih-team.kiro.hook", "{}\n");

    const ctx = makeCtx();
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const digest = result.digests.find((d) => d.describe.includes("core install footprint"));
    const artifacts = digest?.data as
      | { artifacts?: Array<{ path: string; disposition: string; kind: string }> }
      | undefined;

    expect(result.removed.map((r) => r.path)).not.toContain(".kiro/steering/agent-tools.md");
    expect(result.removed.map((r) => r.path)).not.toContain(".kiro/hooks/aih-team.kiro.hook");
    expect(artifacts?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".kiro/steering/agent-tools.md",
          kind: "kiro-steering",
          disposition: "advisory",
        }),
        expect.objectContaining({
          path: ".kiro/hooks/aih-team.kiro.hook",
          kind: "kiro-hook",
          disposition: "advisory",
        }),
      ]),
    );
  });

  it("refuses to remove dirty install targets without --force", async () => {
    await bootstrapFixture();
    commitFixture();
    writeFileSync(join(tmp, "ai-coding", "RULE_ROUTER.md"), "# dirty edit\n", "utf8");

    const ctx = gitCtx();
    await expect(executePlan(await uninstallCommand.plan(ctx), ctx)).rejects.toMatchObject({
      code: "AIH_DIRTY_WORKTREE",
    });
    expect(existsSync(join(tmp, "ai-coding"))).toBe(true);

    const forced = gitCtx({ force: true });
    await executePlan(await uninstallCommand.plan(forced), forced);
    expect(existsSync(join(tmp, "ai-coding"))).toBe(false);
    expect(readFileSync(join(tmp, "ai-coding.aih.bak", "RULE_ROUTER.md"), "utf8")).toBe(
      "# dirty edit\n",
    );
  }, 60000);

  it("never treats the repo root as the removable context directory", async () => {
    put(
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: ".", targets: ["claude"] }),
    );

    const ctx = makeCtx();
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);

    expect(result.removed.map((r) => r.path)).not.toContain(".");
    expect(result.removed.map((r) => r.path)).toContain(".aih-config.json");
  });

  it("does not remove an unmarked user-owned directory named like the default context dir", async () => {
    put("ai-coding/notes.md", "user-owned notes\n");

    const ctx = makeCtx();
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);

    expect(result.removed.map((r) => r.path)).not.toContain("ai-coding");
    expect(existsSync(join(tmp, "ai-coding"))).toBe(true);
  });

  it("does not remove a marker target that lacks generated canon ownership evidence", async () => {
    put(
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: "docs", targets: ["claude"] }),
    );
    put("docs/guide.md", "# User docs\n");
    put(".aih/user-cache.jsonl", "{}\n");

    const ctx = makeCtx();
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const digest = result.digests.find((d) => d.describe.includes("core install footprint"));
    const artifacts = digest?.data as
      | { artifacts?: Array<{ path: string; disposition: string }> }
      | undefined;

    expect(result.removed.map((r) => r.path)).not.toContain("docs");
    expect(result.removed.map((r) => r.path)).not.toContain(".aih");
    expect(result.removed.map((r) => r.path)).toContain(".aih-config.json");
    expect(artifacts?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "docs", disposition: "advisory" }),
        expect.objectContaining({ path: ".aih", disposition: "advisory" }),
      ]),
    );
  });

  it("uses the on-disk casing for removable context dirs", async () => {
    await bootstrapFixture();
    put(
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: "AI-CODING", targets: ["claude"] }),
    );

    const ctx = makeCtx();
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);

    expect(result.removed.map((r) => r.path)).toContain("ai-coding");
    expect(result.removed.map((r) => r.path)).not.toContain("AI-CODING");
  });
});
