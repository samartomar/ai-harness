import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enterpriseBaselineAttestationCheck } from "../../src/baseline/attestation.js";
import { SUPPORTED_CLIS } from "../../src/internals/clis.js";
import { executePlan } from "../../src/internals/execute.js";
import type { DigestAction, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
import { policyInitCommand } from "../../src/org-policy/init.js";
import { type OrgPolicy, parseOrgPolicy } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { spanningMcp } from "../../src/workspace/templates.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-policy-init-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    posture: "enterprise",
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

function write(rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** Exact generated shapes the aih catalog produces (mirrors attestation tests). */
function writeGeneratedMcp(extra: Record<string, unknown> = {}): void {
  write(
    ".mcp.json",
    JSON.stringify({
      mcpServers: {
        github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
        context7: { type: "http", url: "https://mcp.context7.com/mcp" },
        ...extra,
      },
    }),
  );
}

async function planned(c: PlanContext): Promise<{
  write: WriteAction;
  starter: OrgPolicy;
  digest: DigestAction | undefined;
}> {
  const p = await policyInitCommand.plan(c);
  const writeAction = p.actions.find(
    (a): a is WriteAction => a.kind === "write" && a.path === "aih-org-policy.json",
  );
  if (writeAction === undefined) throw new Error("no aih-org-policy.json write planned");
  const digest = p.actions.find((a): a is DigestAction => a.kind === "digest");
  return { write: writeAction, starter: parseOrgPolicy(writeAction.json), digest };
}

describe("policy init — starter org policy from observed fleet state", () => {
  it("is a mutator spec that skips the org-policy posture floor", () => {
    expect(policyInitCommand.readOnly).toBeUndefined();
    expect(policyInitCommand.skipOrgPolicyFloor).toBe(true);
  });

  it("emits a schema-valid starter declaring observed catalog-bound MCP surfaces", async () => {
    writeGeneratedMcp();

    const { write: writeAction, starter } = await planned(ctx());

    // parseOrgPolicy in `planned` already proved schema validity (AC: valid starter).
    expect(starter.schemaVersion).toBe(2);
    expect(starter.minimumPosture).toBe("enterprise");
    expect(starter.references.repoContract).toBe("ai-coding/project.json");
    expect(starter.mcp?.allowedServers).toEqual(["context7", "github"]);
    expect(starter.governance?.supportedClis).toEqual(SUPPORTED_CLIS);
    // Never clobber a policy that appears between plan and apply.
    expect(writeAction.expect).toEqual({ absent: true });
    expect(writeAction.once).toBe(true);
  });

  it("records the resolved posture, not a hardcoded one", async () => {
    const { starter } = await planned(ctx({ posture: "enterprise" }));
    expect(starter.minimumPosture).toBe("enterprise");
  });

  it("leaves the allow-list absent for a vibe starter", async () => {
    const { starter } = await planned(ctx({ posture: "vibe" }));
    expect(starter.governance?.supportedClis).toBeUndefined();
  });

  it("lets a fresh enterprise setup pass attestation with no hand-editing (AC1)", async () => {
    writeGeneratedMcp();
    const before = enterpriseBaselineAttestationCheck(ctx());
    expect(before.verdict).toBe("fail");
    expect(before.code).toBe("baseline.registry-missing");

    const applyCtx = ctx({ apply: true });
    await executePlan(await policyInitCommand.plan(applyCtx), applyCtx);

    const after = enterpriseBaselineAttestationCheck(ctx());
    expect(after.verdict).toBe("pass");
    expect(after.detail).toContain("mcp:github");
    expect(after.detail).toContain("mcp:context7");
  });

  it("refuses to overwrite an existing org policy", async () => {
    write(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
      }),
    );

    await expect(async () => policyInitCommand.plan(ctx())).rejects.toThrow(/already/);
  });

  it("refuses when AIH_ORG_POLICY selects an override source", async () => {
    write(
      "policies/org.json",
      JSON.stringify({
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
      }),
    );

    await expect(async () =>
      policyInitCommand.plan(ctx({ env: { AIH_ORG_POLICY: "policies/org.json" } })),
    ).rejects.toThrow(/AIH_ORG_POLICY/);
  });

  it("keeps undeclarable surfaces out of the starter and names them for review", async () => {
    writeGeneratedMcp({
      rogue: { type: "http", url: "https://rogue.example/mcp/" },
    });

    const { starter, digest } = await planned(ctx());

    expect(starter.mcp?.allowedServers).toEqual(["context7", "github"]);
    expect(digest?.text).toContain("mcp:rogue");
    expect(digest?.text).toContain("cannot be auto-declared");
  });

  it("does not auto-seed trust.approvedSources from marketplace artifacts", async () => {
    const sha = "a".repeat(40);
    write(
      ".aih/marketplace/marketplace.json",
      JSON.stringify({
        schemaVersion: 1,
        name: "acme-skills",
        skills: [
          {
            name: "clean",
            source: `owner/repo@${sha}`,
            commit: sha,
            verdict: "GREEN",
            card: "cards/clean.json",
            evidence: "evidence/owner-repo-aaaaaaaa.json",
            files: [{ path: "skills/clean/SKILL.md", sha256: "b".repeat(64), bytes: 10 }],
          },
        ],
      }),
    );

    const { starter, digest } = await planned(ctx());

    expect(starter.trust).toBeUndefined();
    expect(digest?.text).toContain("marketplace:owner/repo@aaaaaaaaaaaa");
    expect(digest?.text).toContain("trust.approvedSources");
  });

  it("does not declare manifest-scoped workspace graph servers (already internal)", async () => {
    mkdirSync(join(dir, "ui"));
    write(
      ".aih-workspace.json",
      JSON.stringify({
        schemaVersion: 1,
        workspaceType: "multi-repo",
        graphScope: "combined-child-repos",
        contextDir: "ai-coding",
        repos: ["ui"],
        generatedBy: "aih workspace",
      }),
    );
    write(".mcp.json", JSON.stringify({ mcpServers: spanningMcp(dir, ["ui"]).mcpServers }));

    const { starter } = await planned(ctx());

    expect(starter.mcp?.allowedServers).toEqual([]);
  });

  it("fails closed when an MCP config cannot be read for observation", async () => {
    write(".mcp.json", "{not-json");

    await expect(async () => policyInitCommand.plan(ctx())).rejects.toThrow(/\.mcp\.json/);
  });

  it("verifies the written starter with the org policy schema gate", async () => {
    writeGeneratedMcp();
    const applyCtx = ctx({ apply: true, verify: true });
    const result = await executePlan(await policyInitCommand.plan(applyCtx), applyCtx);

    const schemaCheck = result.report?.checks.find(
      (check: Check) => check.name === "org policy schema",
    );
    expect(schemaCheck?.verdict).toBe("pass");
    expect(schemaCheck?.detail).toContain("minimumPosture enterprise");
  });
});
