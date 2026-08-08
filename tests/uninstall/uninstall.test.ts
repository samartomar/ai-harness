import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command as bootstrapAiCommand } from "../../src/bootstrap-ai/index.js";
import { command as contractCommand } from "../../src/contract/index.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { defaultRunner, fakeRunner, type Runner } from "../../src/internals/proc.js";
import { command as mcpCommand } from "../../src/mcp/index.js";
import { policyProjectCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command as profileCommand } from "../../src/profile/index.js";
import { command as uninstallCommand } from "../../src/uninstall/index.js";
import { hermeticGitEnv } from "../git-fixture-env.js";

const TEST_PROCESS_TIMEOUT_MS = 10_000;

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
  execFileSync("git", ["-C", tmp, ...args], {
    stdio: "ignore",
    timeout: TEST_PROCESS_TIMEOUT_MS,
    env: hermeticGitEnv(),
  });
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

/**
 * A repo whose `.claude/managed-settings.json` carries an EXACT aih-owned
 * managed-MCP pair, recorded in the `.aih-config.json` marker — the only state in
 * which those two keys are provably aih's. Built by the real projection command so
 * the fixture cannot drift from what production writes.
 */
async function managedMcpProjectionFixture(): Promise<void> {
  put("package.json", JSON.stringify({ name: "fixture" }));
  put(".claude/managed-settings.json", JSON.stringify({ operatorOnly: true }));
  put(
    "aih-org-policy.json",
    JSON.stringify({
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      governance: { supportedClis: ["claude"] },
      mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
    }),
  );
  const projectCtx = makeCtx({}, { apply: true });
  await executePlan(await policyProjectCommand.plan(projectCtx), projectCtx);
}

async function coOwnedClaudeContextFixture(): Promise<void> {
  const rootSkill = "# Reviewed root skill\n";
  const reviewerSkill = "# Reviewed promoted skill\n";
  put("package.json", JSON.stringify({ name: "fixture" }));
  const bootstrapCtx: PlanContext = {
    ...makeCtx({ cli: "claude", canon: "compact" }, { apply: true }),
    contextDir: ".claude",
  };
  await executePlan(await bootstrapAiCommand.plan(bootstrapCtx), bootstrapCtx);
  await executePlan(await contractCommand.plan(bootstrapCtx), bootstrapCtx);
  put(".claude/setup.md", "# Operator-edited setup checklist\n");
  put(".claude/INDEX.md", "# Operator context index\n");
  put(".claude/architecture.md", "# Operator architecture notes\n");
  put(".claude/conventions.md", "# Operator conventions\n");
  put(".claude/tasks.md", "# Operator task ledger\n");
  put(".claude/project-guardrails.md", "# Operator project guardrails\n");
  put(".claude/skills/example-skill/SKILL.md", "# Operator-edited example skill\n");
  put(".claude/skill-cards/reviewer.md", "# Operator-approved skill card\n");
  put(".claude/cross-repo-architecture.md", "# Operator cross-repo architecture\n");
  put(".claude/workspace-router.md", "# Generated workspace router\n");
  put(".claude/workspace-contracts.md", "# Generated workspace contracts\n");
  put(".claude/workspace-lock.json", JSON.stringify({ schemaVersion: 1 }));
  put(".claude/adapters/other-tools.md", "# Generated adapter guide\n");
  put(".claude/adapters/codex.md", "# Generated adapter from a prior target\n");
  put(".claude/REGENERATION.md", "# Generated regeneration guide\n");
  put(".claude/harness-update.md", "# Generated harness update guide\n");
  put(".claude/telemetry/collector.yaml", "# Generated collector\n");
  put(".claude/telemetry/fetch-analytics.mjs", "// Generated analytics fetcher\n");
  put(".claude/crispy/2-research.md", "## Working notes\n\nOperator research\n");
  put(".claude/skills/reviewed-source/source-root/SKILL.md", rootSkill);
  put(".claude/skills/reviewed-source/source-root/skills/reviewer/SKILL.md", reviewerSkill);
  put(".claude/skills/reviewed-source/reviewer/SKILL.md", reviewerSkill);
  put(".claude/skills/operator/SKILL.md", "# Operator skill\n");
  put(
    ".aih/trust-lock.json",
    JSON.stringify({
      schemaVersion: 1,
      sources: [
        {
          id: "reviewed-source",
          kind: "local",
          source: "../reviewed-source",
          promotedAt: "2026-08-01T00:00:00.000Z",
          promotedSkills: ["source-root", "reviewer"],
          analyzersRun: ["semgrep"],
          artifactHashes: [
            {
              path: "SKILL.md",
              sha256: createHash("sha256").update(rootSkill).digest("hex"),
            },
            {
              path: "skills/reviewer/SKILL.md",
              sha256: createHash("sha256").update(reviewerSkill).digest("hex"),
            },
          ],
          findings: [],
        },
      ],
    }),
  );
  put(".claude/settings.json", JSON.stringify({ hooks: { operator: true } }));
  put(".claude/agents/operator.md", "# Operator agent\n");
  put(".claude/commands/release.md", "# Operator command\n");
  put(".claude/managed-settings.json", JSON.stringify({ operatorOnly: true }));
  put(
    "aih-org-policy.json",
    JSON.stringify({
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: ".claude/project.json" },
      governance: { supportedClis: ["claude"] },
      mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
    }),
  );
  await executePlan(await policyProjectCommand.plan(bootstrapCtx), bootstrapCtx);
}

const managedSettings = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(tmp, ".claude", "managed-settings.json"), "utf8")) as Record<
    string,
    unknown
  >;

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

  it("keeps Kiro extras inside a co-owned .kiro context in preview and apply", async () => {
    put("package.json", JSON.stringify({ name: "fixture" }));
    const bootstrapCtx: PlanContext = {
      ...makeCtx({ cli: "kiro", canon: "compact" }, { apply: true }),
      contextDir: ".kiro",
    };
    await executePlan(await bootstrapAiCommand.plan(bootstrapCtx), bootstrapCtx);
    put(".kiro/hooks/team-custom.kiro.hook", "{}\n");

    const previewCtx: PlanContext = { ...bootstrapCtx, apply: false };
    const preview = await executePlan(await uninstallCommand.plan(previewCtx), previewCtx);
    expect(preview.removed.map((entry) => entry.path)).not.toContain(
      ".kiro/steering/agent-tools.md",
    );
    expect(preview.removed.map((entry) => entry.path)).not.toContain(
      ".kiro/hooks/aih-secret-scan-on-create.kiro.hook",
    );

    const applied = await executePlan(await uninstallCommand.plan(bootstrapCtx), bootstrapCtx);
    expect(applied.removed.map((entry) => entry.path)).not.toContain(
      ".kiro/steering/agent-tools.md",
    );
    expect(applied.removed.map((entry) => entry.path)).not.toContain(
      ".kiro/hooks/aih-secret-scan-on-create.kiro.hook",
    );
    expect(existsSync(join(tmp, ".kiro", "steering", "agent-tools.md"))).toBe(true);
    expect(existsSync(join(tmp, ".kiro", "hooks", "aih-secret-scan-on-create.kiro.hook"))).toBe(
      true,
    );
    expect(existsSync(join(tmp, ".kiro", "hooks", "team-custom.kiro.hook"))).toBe(true);
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

  it("subtracts the marker-proven managed-MCP keys before removing the marker", async () => {
    await managedMcpProjectionFixture();
    expect(managedSettings()).toHaveProperty("allowManagedMcpServersOnly");

    const ctx = makeCtx({}, { apply: true });
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const after = managedSettings();

    expect(existsSync(join(tmp, ".aih-config.json"))).toBe(false);
    expect(after).not.toHaveProperty("allowManagedMcpServersOnly");
    expect(after).not.toHaveProperty("allowedMcpServers");
    // Only the two marker-proven keys go: operator content and the projection keys
    // aih records no provenance for are never subtracted.
    expect(after.operatorOnly).toBe(true);
    expect(after).toHaveProperty("organizationPolicy");
    expect(after).toHaveProperty("sandbox");
    expect(result.writes.map((w) => w.path)).toContain(".claude/managed-settings.json");
  });

  it("names the managed-MCP keys it will subtract in a dry run without touching disk", async () => {
    await managedMcpProjectionFixture();

    const ctx = makeCtx();
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const digest = result.digests.find((d) => d.describe.includes("core install footprint"));

    expect(digest?.text).toContain(".claude/managed-settings.json");
    expect(digest?.text).toContain("allowManagedMcpServersOnly");
    expect(managedSettings()).toHaveProperty("allowManagedMcpServersOnly");
    expect(existsSync(join(tmp, ".aih-config.json"))).toBe(true);
  });

  it("reports an unprovable managed-MCP projection instead of subtracting it", async () => {
    await managedMcpProjectionFixture();
    const managedPath = join(tmp, ".claude", "managed-settings.json");
    const operatorPair = { serverCommand: ["operator-mcp", "serve"] };
    writeFileSync(
      managedPath,
      JSON.stringify({ ...managedSettings(), allowedMcpServers: [operatorPair] }),
      "utf8",
    );

    const ctx = makeCtx({}, { apply: true });
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const digest = result.digests.find((d) => d.describe.includes("core install footprint"));

    expect(digest?.text).toContain("unattributable");
    expect(digest?.text).toContain(".claude/managed-settings.json");
    expect(managedSettings().allowedMcpServers).toEqual([operatorPair]);
    expect(result.writes.map((w) => w.path)).not.toContain(".claude/managed-settings.json");
  });

  it("previews a co-owned .claude context as advisory and names both sides of the boundary", async () => {
    await coOwnedClaudeContextFixture();
    const ctx: PlanContext = { ...makeCtx(), contextDir: ".claude" };
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const digest = result.digests.find((d) => d.describe.includes("core install footprint"));
    const artifacts = (
      digest?.data as
        | {
            artifacts?: Array<{
              path: string;
              kind: string;
              disposition: string;
              reason: string;
            }>;
          }
        | undefined
    )?.artifacts;

    expect(result.removed.map((r) => r.path)).not.toContain(".claude");
    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".claude",
          kind: "context-dir",
          disposition: "advisory",
        }),
      ]),
    );
    expect(digest?.text).toContain(".claude/RULE_ROUTER.md");
    expect(digest?.text).toContain(".claude/adapters/_shared-canonical-block.md");
    expect(digest?.text).toContain(".claude/rules/agent-behavior-core.md");
    expect(digest?.text).toContain(".claude/project.json");
    expect(digest?.text).toContain(".claude/project.md");
    expect(digest?.text).toContain(".claude/setup.md");
    expect(digest?.text).toContain(".claude/workspace-router.md");
    expect(digest?.text).toContain(".claude/workspace-contracts.md");
    expect(digest?.text).toContain(".claude/workspace-lock.json");
    expect(digest?.text).toContain(".claude/adapters/other-tools.md");
    expect(digest?.text).toContain(".claude/adapters/codex.md");
    expect(digest?.text).toContain(".claude/REGENERATION.md");
    expect(digest?.text).toContain(".claude/harness-update.md");
    expect(digest?.text).toContain(".claude/telemetry/collector.yaml");
    expect(digest?.text).toContain(".claude/telemetry/fetch-analytics.mjs");
    expect(digest?.text).toContain(".claude/skills/reviewed-source/source-root/SKILL.md");
    expect(digest?.text).toContain(
      ".claude/skills/reviewed-source/source-root/skills/reviewer/SKILL.md",
    );
    expect(digest?.text).toContain(".claude/skills/reviewed-source/reviewer/SKILL.md");
    expect(digest?.text).not.toContain(".claude/skills/operator/SKILL.md");
    expect(digest?.text).toContain(".claude/settings.json");
    expect(digest?.text).toContain(".claude/agents/");
    expect(digest?.text).toContain(".claude/commands/");
    expect(digest?.text).toContain("operator-owned content in .claude/managed-settings.json");
    expect(digest?.text).toContain("[subtract] .claude/managed-settings.json");
    const contextReason = artifacts?.find((artifact) => artifact.path === ".claude")?.reason;
    const [generatedReason, operatorReason] = contextReason?.split(
      "; operator-owned siblings left untouched: ",
    ) ?? ["", ""];
    expect(generatedReason).not.toContain(".claude/crispy/");
    expect(operatorReason).toContain(".claude/crispy/");
    expect(operatorReason).toContain("CRISPY working notes");
    for (const operatorOwned of [
      ".claude/project.json",
      ".claude/setup.md",
      ".claude/INDEX.md",
      ".claude/architecture.md",
      ".claude/conventions.md",
      ".claude/tasks.md",
      ".claude/project-guardrails.md",
      ".claude/skills/example-skill/SKILL.md",
      ".claude/skill-cards/",
      ".claude/cross-repo-architecture.md",
    ]) {
      expect(generatedReason).not.toContain(operatorOwned);
      expect(operatorReason).toContain(operatorOwned);
    }
  });

  it("leaves a co-owned .claude context in place under --apply", async () => {
    await coOwnedClaudeContextFixture();
    const settings = readFileSync(join(tmp, ".claude", "settings.json"), "utf8");
    const agent = readFileSync(join(tmp, ".claude", "agents", "operator.md"), "utf8");
    const command = readFileSync(join(tmp, ".claude", "commands", "release.md"), "utf8");

    const ctx: PlanContext = { ...makeCtx({}, { apply: true }), contextDir: ".claude" };
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);

    expect(result.removed.map((r) => r.path)).not.toContain(".claude");
    expect(existsSync(join(tmp, ".claude"))).toBe(true);
    expect(existsSync(join(tmp, ".claude.aih.bak"))).toBe(false);
    expect(existsSync(join(tmp, ".claude", "RULE_ROUTER.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "project.json"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "project.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "setup.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "workspace-router.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "workspace-contracts.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "workspace-lock.json"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "adapters", "other-tools.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "adapters", "codex.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "REGENERATION.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "harness-update.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "telemetry", "collector.yaml"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "telemetry", "fetch-analytics.mjs"))).toBe(true);
    expect(readFileSync(join(tmp, ".claude", "settings.json"), "utf8")).toBe(settings);
    expect(readFileSync(join(tmp, ".claude", "agents", "operator.md"), "utf8")).toBe(agent);
    expect(readFileSync(join(tmp, ".claude", "commands", "release.md"), "utf8")).toBe(command);
    expect(managedSettings()).toMatchObject({ operatorOnly: true });
    expect(managedSettings()).not.toHaveProperty("allowManagedMcpServersOnly");
    expect(managedSettings()).not.toHaveProperty("allowedMcpServers");
  });

  it("does not claim an operator-modified promoted skill as AIH-generated", async () => {
    await coOwnedClaudeContextFixture();
    put(".claude/skills/reviewed-source/reviewer/SKILL.md", "# Operator-modified skill\n");

    const ctx: PlanContext = { ...makeCtx(), contextDir: ".claude" };
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const digest = result.digests.find((entry) =>
      entry.describe.includes("core install footprint"),
    );

    expect(digest?.text).not.toContain(".claude/skills/reviewed-source/reviewer/SKILL.md");
    expect(digest?.text).toContain(
      ".claude/skills/reviewed-source/source-root/skills/reviewer/SKILL.md",
    );
    expect(digest?.text).toContain("all other content under .claude/ not listed as aih-generated");
  });

  it("maps a source-root skill whose name collides with a top-level artifact directory", async () => {
    await coOwnedClaudeContextFixture();
    const rootSkill = "# Colliding source-root skill\n";
    const guide = "# Generated guide\n";
    put(".claude/skills/collision/docs/SKILL.md", rootSkill);
    put(".claude/skills/collision/docs/docs/guide.md", guide);
    put(".claude/skills/collision/docs/guide.md", guide);
    put(
      ".aih/trust-lock.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "collision",
            kind: "local",
            source: "../docs",
            promotedAt: "2026-08-01T00:00:00.000Z",
            promotedSkills: ["docs"],
            analyzersRun: ["semgrep"],
            artifactHashes: [
              { path: "SKILL.md", sha256: createHash("sha256").update(rootSkill).digest("hex") },
              {
                path: "docs/guide.md",
                sha256: createHash("sha256").update(guide).digest("hex"),
              },
            ],
            findings: [],
          },
        ],
      }),
    );

    const ctx: PlanContext = { ...makeCtx(), contextDir: ".claude" };
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const digest = result.digests.find((entry) =>
      entry.describe.includes("core install footprint"),
    );

    expect(digest?.text).toContain(".claude/skills/collision/docs/SKILL.md");
    expect(digest?.text).toContain(".claude/skills/collision/docs/docs/guide.md");
    expect(digest?.text).not.toContain(".claude/skills/collision/docs/guide.md");
  });

  it("maps a GitHub source-root skill named for the quarantine tree", async () => {
    await coOwnedClaudeContextFixture();
    const rootSkill = "# GitHub source-root skill\n";
    const guide = "# Generated GitHub guide\n";
    put(".claude/skills/github-collision/tree/SKILL.md", rootSkill);
    put(".claude/skills/github-collision/tree/tree/guide.md", guide);
    put(".claude/skills/github-collision/tree/guide.md", guide);
    put(
      ".aih/trust-lock.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "github-collision",
            kind: "github",
            source: "owner/repo",
            ref: "main",
            pinnedSha: "a".repeat(40),
            promotedAt: "2026-08-01T00:00:00.000Z",
            promotedSkills: ["tree"],
            analyzersRun: ["semgrep"],
            artifactHashes: [
              { path: "SKILL.md", sha256: createHash("sha256").update(rootSkill).digest("hex") },
              {
                path: "tree/guide.md",
                sha256: createHash("sha256").update(guide).digest("hex"),
              },
            ],
            findings: [],
          },
        ],
      }),
    );

    const ctx: PlanContext = { ...makeCtx(), contextDir: ".claude" };
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const digest = result.digests.find((entry) =>
      entry.describe.includes("core install footprint"),
    );

    expect(digest?.text).toContain(".claude/skills/github-collision/tree/SKILL.md");
    expect(digest?.text).toContain(".claude/skills/github-collision/tree/tree/guide.md");
    expect(digest?.text).not.toContain(".claude/skills/github-collision/tree/guide.md");
  });

  it("refuses an oversized promoted artifact before reading its contents", async () => {
    await coOwnedClaudeContextFixture();
    truncateSync(
      join(tmp, ".claude", "skills", "reviewed-source", "reviewer", "SKILL.md"),
      2 * 1024 * 1024 * 1024 + 1,
    );

    const ctx: PlanContext = { ...makeCtx(), contextDir: ".claude" };
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
    const digest = result.digests.find((entry) =>
      entry.describe.includes("core install footprint"),
    );

    expect(digest?.text).not.toContain(".claude/skills/reviewed-source/reviewer/SKILL.md");
  });

  it("does not claim promoted artifacts reached through a symlinked parent", async () => {
    await coOwnedClaudeContextFixture();
    const redirected = mkdtempSync(join(tmpdir(), "aih-uninstall-redirect-"));
    try {
      put(".claude/skills/operator/SKILL.md", "# Operator skill still local\n");
      mkdirSync(join(redirected, "reviewer"), { recursive: true });
      writeFileSync(
        join(redirected, "reviewer", "SKILL.md"),
        "# Reviewed promoted skill\n",
        "utf8",
      );
      writeFileSync(join(redirected, "collector.yaml"), "# Redirected collector\n", "utf8");
      const sourceDir = join(tmp, ".claude", "skills", "reviewed-source");
      rmSync(sourceDir, { recursive: true });
      symlinkSync(redirected, sourceDir, process.platform === "win32" ? "junction" : "dir");
      const telemetryDir = join(tmp, ".claude", "telemetry");
      rmSync(telemetryDir, { recursive: true });
      symlinkSync(redirected, telemetryDir, process.platform === "win32" ? "junction" : "dir");

      const ctx: PlanContext = { ...makeCtx(), contextDir: ".claude" };
      const result = await executePlan(await uninstallCommand.plan(ctx), ctx);
      const digest = result.digests.find((entry) =>
        entry.describe.includes("core install footprint"),
      );

      expect(digest?.text).not.toContain(".claude/skills/reviewed-source/reviewer/SKILL.md");
      expect(digest?.text).not.toContain(".claude/telemetry/collector.yaml");
    } finally {
      rmSync(redirected, { recursive: true, force: true });
    }
  });

  it.each(["ai-coding", ".ai-context"])(
    "keeps the existing wholesale-backup behavior for distinct context dir %s",
    async (contextDir) => {
      put("package.json", JSON.stringify({ name: "fixture" }));
      const bootstrapCtx: PlanContext = {
        ...makeCtx({ cli: "claude", canon: "compact" }, { apply: true }),
        contextDir,
      };
      await executePlan(await bootstrapAiCommand.plan(bootstrapCtx), bootstrapCtx);

      const ctx: PlanContext = {
        ...makeCtx({}, { apply: true }),
        contextDir,
      };
      await executePlan(await uninstallCommand.plan(ctx), ctx);

      expect(existsSync(join(tmp, contextDir))).toBe(false);
      expect(existsSync(join(tmp, `${contextDir}.aih.bak`))).toBe(true);
    },
  );

  it("inventories fixed Cursor profile outputs inside a co-owned .cursor context", async () => {
    put(
      "package.json",
      JSON.stringify({ name: "fixture", dependencies: { typescript: "latest" } }),
    );
    const bootstrapCtx: PlanContext = {
      ...makeCtx({ cli: "cursor", canon: "compact" }, { apply: true }),
      contextDir: ".cursor",
    };
    await executePlan(await bootstrapAiCommand.plan(bootstrapCtx), bootstrapCtx);
    const profileCtx: PlanContext = { ...bootstrapCtx, targets: ["cursor"] };
    await executePlan(await profileCommand.plan(profileCtx), profileCtx);

    const previewCtx: PlanContext = { ...bootstrapCtx, apply: false };
    const result = await executePlan(await uninstallCommand.plan(previewCtx), previewCtx);
    const digest = result.digests.find((entry) =>
      entry.describe.includes("core install footprint"),
    );

    expect(result.removed.map((entry) => entry.path)).not.toContain(".cursor");
    expect(digest?.text).toContain(".cursor/rules/01-stack.mdc");
    expect(digest?.text).toContain(".cursor/rules/02-node.mdc");
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

  it.skipIf(process.platform !== "darwin")(
    "treats a case-variant live config directory as co-owned on case-insensitive macOS",
    async () => {
      put("package.json", JSON.stringify({ name: "fixture" }));
      const bootstrapCtx: PlanContext = {
        ...makeCtx({ cli: "claude", canon: "compact" }, { apply: true }),
        contextDir: ".Claude",
        host: makeHostAdapter({ platform: "darwin", run: fakeRunner(() => undefined), env: {} }),
      };
      await executePlan(await bootstrapAiCommand.plan(bootstrapCtx), bootstrapCtx);
      put(
        ".aih-config.json",
        JSON.stringify({ schemaVersion: 1, contextDir: ".claude", targets: ["claude"] }),
      );

      const result = await executePlan(await uninstallCommand.plan(bootstrapCtx), bootstrapCtx);
      const digest = result.digests.find((entry) =>
        entry.describe.includes("core install footprint"),
      );

      expect(result.removed.map((entry) => entry.path)).not.toContain(".Claude");
      expect(digest?.text).toContain("[advisory] .Claude");
      expect(digest?.text).toContain("co-owned Claude Code config directory");
    },
  );
});
