import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  expectedPolicyRequiredGuidance,
  inspectPolicyRequiredGuidance,
  planPolicyRequiredGuidance,
  policyRequiredGuidancePath,
} from "../../src/org-policy/required-guidance.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-required-guidance-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const identity = {
  policyVersion: "2026.09",
  source: {
    repository: "everything-claude-code/everything-claude-code",
    commit: "5caf398a91599029a176ca6d806409b00d1052c4",
  },
  targets: ["codex", "opencode"] as const,
};

function context(apply = true): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

const components = [
  { id: "skill:security-review", files: [{ path: ".codex/skills/security-review/SKILL.md" }] },
  {
    id: "agent:reviewer",
    files: [{ path: ".codex/agents/reviewer.md" }, { path: ".kiro/agents/reviewer.json" }],
  },
  { id: "baseline:commands", files: [{ path: ".claude/commands/review.md" }] },
  { id: "module:core", files: [{ path: ".codex/rules/review.md" }] },
  { id: "skill:tdd-workflow", files: [{ path: ".codex/skills/tdd-workflow/SKILL.md" }] },
] as const;

describe("required policy guidance bridge", () => {
  it("writes a deterministic committed bridge with policy, source and target identity", () => {
    const action = planPolicyRequiredGuidance(root, "ai-coding", components, identity);
    expect(action.actions[0]).toMatchObject({
      kind: "write",
      path: "ai-coding/policy-required-guidance.md",
    });
    const contents = action.actions[0]?.kind === "write" ? action.actions[0].contents : "";
    expect(contents).toContain("Policy version: 2026.09");
    expect(contents).toContain(
      `Verified ECC source: ${identity.source.repository}@${identity.source.commit}`,
    );
    expect(contents).toContain("Governed targets: codex, opencode");
    expect(contents).toContain(".codex/skills/security-review/SKILL.md");
    expect(contents).toContain(".codex/agents/reviewer.md");
    expect(contents).toContain(".claude/commands/review.md");
    expect(contents).toContain(".codex/rules/review.md");
    expect(contents).not.toContain("reviewer.json");
    expect(contents).toContain("read every selected guidance file listed below in full");
  });

  it("subtracts no bridge when no evidence-passed required guidance was owned", () => {
    expect(planPolicyRequiredGuidance(root, "ai-coding", []).actions).toEqual([]);
  });

  it("detects stale selection identity even while receipt-owned bytes are current", async () => {
    const planned = planPolicyRequiredGuidance(root, "ai-coding", components, identity);
    await executePlan({ capability: "guidance", actions: planned.actions }, context());
    const expected = expectedPolicyRequiredGuidance("ai-coding", components, identity);
    expect(inspectPolicyRequiredGuidance(root, "ai-coding", expected)).toMatchObject({
      state: "current",
      receipt: { policyVersion: "2026.09", targets: ["codex", "opencode"] },
    });
    const stale = expectedPolicyRequiredGuidance("ai-coding", components, {
      ...identity,
      policyVersion: "2026.10",
    });
    expect(inspectPolicyRequiredGuidance(root, "ai-coding", stale)).toMatchObject({
      state: "stale",
    });
  });

  it("preserves operator drift during withdrawal", async () => {
    const planned = planPolicyRequiredGuidance(root, "ai-coding", components, identity);
    await executePlan({ capability: "guidance", actions: planned.actions }, context());
    const guidance = join(root, policyRequiredGuidancePath("ai-coding"));
    writeFileSync(guidance, "operator content\n");

    const withdrawal = planPolicyRequiredGuidance(root, "ai-coding", []);
    expect(withdrawal.actions).toEqual([]);
    expect(withdrawal.advisories).toHaveLength(1);
    expect(readFileSync(guidance, "utf8")).toBe("operator content\n");
  });

  it("refuses to overwrite an unowned bridge", () => {
    const guidance = join(root, policyRequiredGuidancePath("ai-coding"));
    mkdirSync(join(root, "ai-coding"));
    writeFileSync(guidance, "operator content\n", { flag: "wx" });
    expect(() => planPolicyRequiredGuidance(root, "ai-coding", components, identity)).toThrow(
      /unowned required guidance/,
    );
    expect(existsSync(guidance)).toBe(true);
  });

  it("rejects unsafe context roots", () => {
    expect(() => policyRequiredGuidancePath("../outside")).toThrow(/context directory/);
  });
});
