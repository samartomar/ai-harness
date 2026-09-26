import "../core-invocation.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../../../src/internals/execute.js";
import type { PlanContext } from "../../../../src/internals/plan.js";
import { fakeRunner } from "../../../../src/internals/proc.js";
import { makeHostAdapter } from "../../../../src/platform/detect.js";
import {
  GOVERNED_CODEX_ROLE_RECEIPT,
  inspectGovernedCodexRoleRegistration,
  planGovernedCodexRoleRegistration,
} from "../../src/profile/governed-codex-roles.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-governed-codex-role-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function context(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: true,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

const reviewer = {
  id: "code-reviewer",
  description: "Reviews code for correctness.",
  configFile: ".codex/agents/code-reviewer.toml",
} as const;

describe("governed selected Codex role registration", () => {
  it("reports missing, current, and conflicting native registration without mutation", async () => {
    expect(inspectGovernedCodexRoleRegistration(root, [reviewer]).state).toBe("missing");
    await executePlan(planGovernedCodexRoleRegistration(root, [reviewer]), context());
    expect(inspectGovernedCodexRoleRegistration(root, [reviewer])).toMatchObject({
      state: "current",
      expectedRoleIds: ["code-reviewer"],
      receiptRoleIds: ["code-reviewer"],
    });
    rmSync(join(root, GOVERNED_CODEX_ROLE_RECEIPT));
    expect(inspectGovernedCodexRoleRegistration(root, [reviewer]).state).toBe("drifted");
    writeFileSync(
      join(root, ".codex", "config.toml"),
      '[agents.code-reviewer]\ndescription = "operator"\nconfig_file = "mine.toml"\n',
    );
    expect(inspectGovernedCodexRoleRegistration(root, [reviewer]).state).toBe("conflict");
  });

  it("preserves unrelated config, converges, and withdraws only its owned block", async () => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex", "config.toml"), 'model = "gpt-5.5"\n');

    await executePlan(planGovernedCodexRoleRegistration(root, [reviewer]), context());
    const installed = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect(installed).toContain('model = "gpt-5.5"');
    expect(installed).toContain("[agents.code-reviewer]");
    expect(installed).toContain('config_file = "agents/code-reviewer.toml"');
    expect(planGovernedCodexRoleRegistration(root, [reviewer]).actions[0]).toMatchObject({
      kind: "write",
      contents: installed,
    });

    await executePlan(planGovernedCodexRoleRegistration(root, []), context());
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toBe('model = "gpt-5.5"\n');
    expect(() => readFileSync(join(root, GOVERNED_CODEX_ROLE_RECEIPT))).toThrow();
  });

  it("rejects semantic same-name tables including inline TOML and preserves drift", async () => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(
      join(root, ".codex", "config.toml"),
      '[agents.code-reviewer]\ndescription = "operator"\nconfig_file = "mine.toml"\n',
    );
    expect(() => planGovernedCodexRoleRegistration(root, [reviewer])).toThrow(
      /conflicts.*code-reviewer/i,
    );

    writeFileSync(
      join(root, ".codex", "config.toml"),
      'agents = { code-reviewer = { description = "operator", config_file = "mine.toml" } }\n',
    );
    expect(() => planGovernedCodexRoleRegistration(root, [reviewer])).toThrow(
      /conflicts.*code-reviewer/i,
    );

    writeFileSync(join(root, ".codex", "config.toml"), 'model = "gpt-5.5"\n');
    await executePlan(planGovernedCodexRoleRegistration(root, [reviewer]), context());
    writeFileSync(join(root, ".codex", "config.toml"), "# operator edit\n");
    expect(() => planGovernedCodexRoleRegistration(root, [])).toThrow(/drifted/i);
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toBe("# operator edit\n");
  });

  it("rejects inline-table extension and suffixes with ambiguous TOML scope", async () => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex", "config.toml"), "agents = {}\n");
    expect(() => planGovernedCodexRoleRegistration(root, [reviewer])).toThrow(/TOML is invalid/i);

    writeFileSync(join(root, ".codex", "config.toml"), 'model = "gpt-5.5"\n');
    await executePlan(planGovernedCodexRoleRegistration(root, [reviewer]), context());
    writeFileSync(
      join(root, ".codex", "config.toml"),
      `${readFileSync(join(root, ".codex", "config.toml"), "utf8")}sandbox_mode = "workspace-write"\n`,
    );
    expect(() => planGovernedCodexRoleRegistration(root, [reviewer])).toThrow(
      /ambiguous TOML table scope/i,
    );
  });

  it("ignores malformed unrelated Codex config when no governed roles are selected", () => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex", "config.toml"), "invalid = [\n");
    expect(planGovernedCodexRoleRegistration(root, []).actions).toEqual([]);
  });

  it("keeps registration current across CRLF and independent table suffixes", async () => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex", "config.toml"), 'model = "gpt-5.5"\r\n');
    await executePlan(planGovernedCodexRoleRegistration(root, [reviewer]), context());
    expect(inspectGovernedCodexRoleRegistration(root, [reviewer]).state).toBe("current");
    writeFileSync(
      join(root, ".codex", "config.toml"),
      `${readFileSync(join(root, ".codex", "config.toml"), "utf8")}\r\n[mcp_servers.github]\r\ncommand = "node"\r\n`,
    );
    expect(planGovernedCodexRoleRegistration(root, [reviewer]).actions).toHaveLength(2);
  });
});
