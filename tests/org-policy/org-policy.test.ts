import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { composeOrgPolicy } from "../../src/org-policy/compose.js";
import { orgPolicyProjectionActions } from "../../src/org-policy/project.js";
import { parseOrgPolicy, readOrgPolicy } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-org-policy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    posture: "team",
    postureSource: "org-floor",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    minimumPosture: "team",
    references: { repoContract: "ai-coding/project.json" },
    ...overrides,
  };
}

function writes(actions: ReturnType<typeof orgPolicyProjectionActions>): WriteAction[] {
  return actions.filter((a): a is WriteAction => a.kind === "write");
}

describe("OrgPolicySchema", () => {
  it("parses the separate org-owned policy shape", () => {
    expect(
      parseOrgPolicy(
        policy({
          command: { deny: { add: [{ pattern: "kubectl delete*" }], remove: ["printenv*"] } },
          mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
        }),
      ),
    ).toMatchObject({
      minimumPosture: "team",
      references: { repoContract: "ai-coding/project.json" },
      command: { deny: { remove: ["printenv*"] } },
    });
  });

  it("rejects redefinitions; command policy changes must be deltas", () => {
    expect(() =>
      parseOrgPolicy(policy({ command: { deny: ["kubectl delete*"] } })),
    ).toThrow(/org-policy/);
  });

  it("readOrgPolicy fails closed on malformed committed policy JSON", () => {
    writeFileSync(join(dir, "aih-org-policy.json"), "{ broken");
    expect(() => readOrgPolicy(dir, {})).toThrow(/aih-org-policy/);
  });
});

describe("composeOrgPolicy", () => {
  it("applies org command deltas over the baseline lexicon deterministically", () => {
    const composed = composeOrgPolicy(
      parseOrgPolicy(
        policy({
          command: {
            deny: {
              add: [{ pattern: "kubectl delete*", reason: "Cluster deletion requires review." }],
              remove: ["printenv*"],
            },
          },
        }),
      ),
    );

    expect(composed.command.deny.map((r) => r.pattern)).toContain("kubectl delete*");
    expect(composed.command.deny.map((r) => r.pattern)).not.toContain("printenv*");
    expect(composed.command.ask.every((r) => typeof r.pattern === "string")).toBe(true);
  });

  it("adds and overrides risk gates while preserving the ask-not-deny invariant", () => {
    const composed = composeOrgPolicy(
      parseOrgPolicy(
        policy({
          riskGates: {
            add: [
              {
                name: "ai_model_change",
                description: "Changing model/provider routing.",
                pathPatterns: ["**/ai/**"],
                commandPatterns: [],
              },
            ],
            override: {
              public_api_break: { pathPatterns: ["src/api/**"] },
            },
          },
        }),
      ),
    );

    const added = composed.riskGates.find((g) => g.name === "ai_model_change");
    const overridden = composed.riskGates.find((g) => g.name === "public_api_break");
    expect(added).toMatchObject({ behavior: "ask" });
    expect(overridden?.pathPatterns).toEqual(["src/api/**"]);
    expect(composed.riskGates.every((g) => g.behavior === "ask")).toBe(true);
  });
});

describe("orgPolicyProjectionActions", () => {
  it("projects team policy into project managed-settings only", () => {
    const actions = orgPolicyProjectionActions(ctx(), parseOrgPolicy(policy()));
    const paths = writes(actions).map((w) => w.path.replace(/\\/g, "/"));
    expect(paths).toContain(".claude/managed-settings.json");
    expect(paths).not.toContain("managed-settings.json.example");
    expect(paths).not.toContain("managed-mcp.json.example");
  });

  it("at enterprise also emits system-path examples for admin deployment", () => {
    const actions = orgPolicyProjectionActions(
      { ...ctx(), posture: "enterprise" },
      parseOrgPolicy(
        policy({
          minimumPosture: "enterprise",
          mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
        }),
      ),
    );
    const out = Object.fromEntries(writes(actions).map((w) => [w.path.replace(/\\/g, "/"), w]));
    expect(out[".claude/managed-settings.json"]?.merge).toBe(true);
    expect(out["managed-settings.json.example"]).toBeDefined();
    expect(out["managed-mcp.json.example"]).toBeDefined();
    expect(JSON.stringify(out["managed-settings.json.example"]?.json)).toContain(
      "allowManagedMcpServersOnly",
    );
    expect(JSON.stringify(out["managed-mcp.json.example"]?.json)).toContain("code-review-graph");
  });

  it("includes contractRef and command-policy deltas in the compiled managed-settings payload", () => {
    const actions = orgPolicyProjectionActions(
      ctx(),
      parseOrgPolicy(
        policy({
          command: { deny: { add: [{ pattern: "terraform destroy*" }] } },
          mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
        }),
      ),
    );
    const managed = writes(actions).find((w) => w.path === ".claude/managed-settings.json");
    expect(managed?.json).toMatchObject({
      organizationPolicy: {
        minimumPosture: "team",
        references: { repoContract: "ai-coding/project.json" },
      },
      allowManagedMcpServersOnly: true,
    });
    expect(JSON.stringify(managed?.json)).toContain("terraform destroy*");
  });
});
