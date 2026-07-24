import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command } from "../../src/init/index.js";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

/**
 * First-run consistency: a single `aih init` pass must never contradict itself.
 * The regression here was real: contract composed BEFORE mcp and read only the
 * disk, so the first `--apply` wrote five servers to `.mcp.json` while
 * project.json/project.md said "no servers detected" — self-healing only on a
 * second run. These tests pin the single-pass agreement and its idempotence.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-first-run-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...over,
  };
}

const byLocale = (a: string, b: string) => a.localeCompare(b);

function findWrite(actions: readonly Action[], path: string): WriteAction | undefined {
  return actions.find(
    (a): a is WriteAction => a.kind === "write" && a.path.replace(/\\/g, "/") === path,
  );
}

/** The mcpServers list synthesized into the planned project.json write. */
function contractServers(actions: readonly Action[]): string[] {
  const w = findWrite(actions, ".ai-context/project.json");
  return (w?.json as { mcpServers?: string[] } | undefined)?.mcpServers ?? [];
}

/** The server names the same plan stages for the root `.mcp.json`. */
function plannedServers(actions: readonly Action[]): string[] {
  const w = findWrite(actions, ".mcp.json");
  const servers = (w?.json as { mcpServers?: Record<string, unknown> } | undefined)?.mcpServers;
  return Object.keys(servers ?? {}).sort(byLocale);
}

describe("aih init — first-run contract/MCP consistency", () => {
  it("synthesizes project.json with the SAME servers the plan writes to .mcp.json (fresh repo, one pass)", async () => {
    const p = await command.plan(ctx());
    const planned = plannedServers(p.actions);

    // The assertion is meaningful only because init actually plans MCP servers.
    expect(planned.length).toBeGreaterThan(0);
    expect(contractServers(p.actions)).toEqual(planned);
  });

  it("renders project.md without the 'no servers detected' line on the first pass", async () => {
    const p = await command.plan(ctx());
    const md = findWrite(p.actions, ".ai-context/project.md");
    expect(md?.contents ?? "").not.toContain("No root `.mcp.json` servers detected");
  });

  it("--apply lands a consistent contract on the FIRST run and stays stable on the second", async () => {
    const applied = ctx({ apply: true });
    await executePlan(await command.plan(applied), applied);

    const readContractServers = () =>
      (
        JSON.parse(readFileSync(join(dir, ".ai-context", "project.json"), "utf8")) as {
          mcpServers: string[];
        }
      ).mcpServers;
    const onDisk = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    const first = readContractServers();

    // The first-run regression: before the fix this was [] until a second apply.
    expect(first.length).toBeGreaterThan(0);
    expect(first).toEqual(Object.keys(onDisk.mcpServers).sort(byLocale));

    // Second apply: disk state and planned state now agree — nothing may change.
    await executePlan(await command.plan(applied), applied);
    expect(readContractServers()).toEqual(first);
  });

  it("--mcp-mode none plans no .mcp.json and the contract honestly reports no servers", async () => {
    const p = await command.plan(ctx({ options: { mcpMode: "none" } }));
    expect(p.actions.some((a) => a.kind === "write" && a.path === ".mcp.json")).toBe(false);
    expect(contractServers(p.actions)).toEqual([]);
  });
});
