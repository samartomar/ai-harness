import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedCanonicalBlockBody } from "../../src/bootstrap-ai/canon.js";
import { NATIVE_MCP_TARGETS, type NativeMcpTarget } from "../../src/config/marker.js";
import { entry } from "../../src/internals/cli-registry.js";
import type { Cli } from "../../src/internals/clis.js";
import { executePlan } from "../../src/internals/execute.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { command as mcpCommand } from "../../src/mcp/index.js";
import {
  nativeMcpProjectionActions,
  nativeMcpProjectionState,
} from "../../src/mcp/native-managed-projection.js";
import { coalesceMcpProjectionMarkerActions } from "../../src/mcp/projection-marker.js";
import type { McpServer } from "../../src/mcp/servers.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command as pruneCommand } from "../../src/prune/index.js";
import { command as uninstallCommand } from "../../src/uninstall/index.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-native-mcp-entrypoints-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(targets: Cli[] = [...NATIVE_MCP_TARGETS]): PlanContext {
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
  return {
    root,
    contextDir: "ai-coding",
    posture: "vibe",
    apply: true,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: join(root, "fixture-home"), USERPROFILE: join(root, "fixture-home") },
    options: {},
    targets,
  };
}

const server = {
  type: "stdio",
  command: "node",
  args: ["approved-server.js"],
  description: "Approved server",
  classification: "local",
  egress: "none",
  credentials: "none",
  supplyChain: "pinned",
} as const satisfies McpServer;
const decision = {
  candidate: "approved",
  id: "decision-approved",
  issuer: "security-admin",
  digest: `sha256:${"a".repeat(64)}`,
  expiresAt: "2027-09-01T00:00:00Z",
} as const;

function configPath(target: NativeMcpTarget): string {
  const profile = entry(target).mcp.governed;
  if (profile === undefined) throw new Error(`missing governed contract for ${target}`);
  return profile.configPath;
}

function write(relative: string, contents: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function read(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

function targets(kept: Cli[]): void {
  const marker = JSON.parse(read(".aih-config.json"));
  write(".aih-config.json", JSON.stringify({ ...marker, targets: kept }));
}

async function project(selected: NativeMcpTarget[]): Promise<void> {
  for (const target of selected) {
    write(
      configPath(target),
      target === "codex"
        ? '# operator comment\nmodel = "operator-model"\n[mcp_servers.team]\ncommand = "team"\nargs = []\n'
        : JSON.stringify({
            operator: true,
            [entry(target).mcp.configKey ?? "mcpServers"]: { team: { command: "team" } },
          }),
    );
  }
  const actions = selected.flatMap((target) =>
    nativeMcpProjectionActions(ctx(selected), target, { approved: server }, [decision]),
  );
  await executePlan(
    plan("native MCP fixture", ...coalesceMcpProjectionMarkerActions(actions)),
    ctx(selected),
  );
}

describe.each(NATIVE_MCP_TARGETS)("%s governed MCP command boundaries", (target) => {
  it.each(["prune", "uninstall"] as const)(
    "%s subtracts only unchanged receipt-owned entries",
    async (lifecycle) => {
      await project([target]);
      if (lifecycle === "prune") targets(["claude"]);
      const context = ctx(lifecycle === "prune" ? ["claude"] : [target]);
      const command = lifecycle === "prune" ? pruneCommand : uninstallCommand;
      const planned = await command.plan(context);
      const configWrite = planned.actions.find(
        (action) => action.kind === "write" && action.path === configPath(target),
      );
      expect(configWrite).toBeDefined();
      expect(configWrite).toHaveProperty("expect.sha256");
      expect(read(configPath(target))).toContain("approved-server.js");
      await executePlan(planned, context);

      const contents = read(configPath(target));
      expect(contents).not.toContain("approved-server.js");
      expect(contents).toContain("team");
      if (target === "codex") expect(contents).toContain("operator-model");
      else expect(JSON.parse(contents).operator).toBe(true);
      expect(nativeMcpProjectionState(root, target).state).toBe("absent");
      if (lifecycle === "prune") {
        expect(JSON.parse(read(".aih-config.json")).targets).toEqual(["claude"]);
        expect(
          (await command.plan(context)).actions.filter((action) => action.kind === "write"),
        ).toEqual([]);
      } else {
        expect(existsSync(join(root, ".aih-config.json"))).toBe(false);
        expect(read(".aih-config.json.aih.bak")).toContain("nativeMcpProjections");
      }
    },
  );

  it.each(["prune", "uninstall"] as const)(
    "%s preserves operator changes to an owned entry",
    async (lifecycle) => {
      await project([target]);
      const changed = read(configPath(target)).replace("approved-server.js", "operator-server.js");
      write(configPath(target), changed);
      if (lifecycle === "prune") targets(["claude"]);
      const context = ctx(lifecycle === "prune" ? ["claude"] : [target]);
      const command = lifecycle === "prune" ? pruneCommand : uninstallCommand;
      const planned = await command.plan(context);
      expect(
        planned.actions.some(
          (action) => action.kind === "write" && action.path === configPath(target),
        ),
      ).toBe(false);
      const digest = planned.actions.find((action) => action.kind === "digest");
      expect(digest).toHaveProperty(
        "data.artifacts",
        expect.arrayContaining([
          expect.objectContaining({ path: configPath(target), disposition: "advisory" }),
        ]),
      );
      await executePlan(planned, context);
      expect(read(configPath(target))).toBe(changed);
      expect(nativeMcpProjectionState(root, target).state).toBe(
        lifecycle === "prune" ? "revoked" : "absent",
      );
    },
  );

  it("prune keeps committed targets despite selection flags or an unavailable binary", async () => {
    await project([target]);
    write(`ai-coding/adapters/${target}.md`, "fixture adapter");
    const context = ctx(["claude"]);
    context.options = { cli: "claude", unrunnable: true };
    const contents = read(configPath(target));
    const planned = await pruneCommand.plan(context);
    expect(
      planned.actions.some(
        (action) => action.kind === "write" && action.path === configPath(target),
      ),
    ).toBe(false);
    expect(read(configPath(target))).toBe(contents);
    expect(nativeMcpProjectionState(root, target).state).toBe("clean");
  });

  it.each(["clean", "altered", "revoked", "malformed"] as const)(
    "generic mcp refuses a %s governed receipt without a policy file",
    async (state) => {
      await project([target]);
      if (state === "altered" || state === "revoked") {
        write(
          configPath(target),
          read(configPath(target)).replace("approved-server.js", "operator-server.js"),
        );
      }
      if (state === "revoked") {
        await executePlan(
          plan("revoke fixture", ...nativeMcpProjectionActions(ctx([target]), target, {})),
          ctx([target]),
        );
      }
      if (state === "malformed") {
        const marker = JSON.parse(read(".aih-config.json"));
        marker.nativeMcpProjections[target].sha256 = "0".repeat(64);
        write(".aih-config.json", JSON.stringify(marker));
      }
      const contents = read(configPath(target));
      await expect(mcpCommand.plan(ctx([target]))).rejects.toThrow(
        /governed.*receipt|receipt.*governed/i,
      );
      expect(read(configPath(target))).toBe(contents);
      expect(existsSync(join(root, "fixture-home"))).toBe(false);
    },
  );
});

it("prune coalesces several native receipt removals and preserves the retained target", async () => {
  await project([...NATIVE_MCP_TARGETS]);
  targets(["kimi"]);
  const kept = read(configPath("kimi"));
  const context = ctx(["kimi"]);
  const planned = await pruneCommand.plan(context);
  expect(
    planned.actions.filter(
      (action) => action.kind === "write" && action.path === ".aih-config.json",
    ),
  ).toHaveLength(1);
  await executePlan(planned, context);
  expect(read(configPath("kimi"))).toBe(kept);
  expect(Object.keys(JSON.parse(read(".aih-config.json")).nativeMcpProjections)).toEqual(["kimi"]);
  for (const target of NATIVE_MCP_TARGETS.filter((candidate) => candidate !== "kimi")) {
    expect(read(configPath(target))).not.toContain("approved-server.js");
    expect(nativeMcpProjectionState(root, target).state).toBe("absent");
  }
});

it("uninstall preserves a co-owned native MCP directory used as the context directory", async () => {
  await project(["copilot"]);
  const marker = JSON.parse(read(".aih-config.json"));
  write(".aih-config.json", JSON.stringify({ ...marker, contextDir: ".github" }));
  write(".github/RULE_ROUTER.md", "fixture canon");
  write(".github/rules/agent-behavior-core.md", "fixture behavior");
  write(".github/adapters/_shared-canonical-block.md", sharedCanonicalBlockBody(".github"));
  const context = { ...ctx(["copilot"]), contextDir: ".github" };
  const planned = await uninstallCommand.plan(context);
  expect(
    planned.actions.some((action) => action.kind === "remove" && action.path === ".github"),
  ).toBe(false);
  await executePlan(planned, context);
  expect(read(configPath("copilot"))).toContain("team");
  expect(read(configPath("copilot"))).not.toContain("approved-server.js");
  expect(read(".github/RULE_ROUTER.md")).toBe("fixture canon");
});
