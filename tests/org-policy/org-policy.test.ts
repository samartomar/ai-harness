import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entry, REGISTRY_IDS } from "../../src/internals/cli-registry.js";
import { executePlan, resolveContents } from "../../src/internals/execute.js";
import type { PlanContext, WriteAction } from "../../src/internals/plan.js";
import { plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { mcpManagedAllowlistCheck } from "../../src/mcp/allowlist.js";
import { composeOrgPolicy } from "../../src/org-policy/compose.js";
import {
  orgPolicyDriftProbes,
  orgPolicyIntegrityDigest,
  orgPolicyIntegrityProbes,
} from "../../src/org-policy/drift.js";
import { orgPolicyProjectionActions } from "../../src/org-policy/project.js";
import { parseOrgPolicy, readOrgPolicy } from "../../src/org-policy/schema.js";
import { policyProjectCommand } from "../../src/org-policy/validate.js";
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
    posture: "enterprise",
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
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    ...overrides,
  };
}

function writes(actions: ReturnType<typeof orgPolicyProjectionActions>): WriteAction[] {
  return actions.filter((a): a is WriteAction => a.kind === "write");
}

describe("policy project", () => {
  it("projects the committed policy without running init and preserves operator settings", async () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "managed-settings.json"),
      JSON.stringify({ operatorOnly: true }),
    );
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify(policy({ command: { deny: { add: [{ pattern: "terraform destroy*" }] } } })),
    );
    const applied: PlanContext = { ...ctx(), apply: true, targets: ["claude", "cursor"] };

    const planned = await policyProjectCommand.plan(applied);

    expect(planned.capability).toBe("policy project");
    expect(writes(planned.actions).map((action) => action.path)).toEqual([
      ".claude/managed-settings.json",
      "managed-settings.json.example",
      "managed-mcp.json.example",
    ]);

    await executePlan(planned, applied);

    const managed = JSON.parse(
      readFileSync(join(dir, ".claude", "managed-settings.json"), "utf8"),
    ) as {
      operatorOnly?: boolean;
      sandbox?: { commandPolicy?: { deny?: unknown[] } };
    };
    expect(managed.operatorOnly).toBe(true);
    expect(managed.sandbox?.commandPolicy?.deny).toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern: "terraform destroy*" })]),
    );
    expect(existsSync(join(dir, ".aih-config.json"))).toBe(false);
  });

  it("records managed-only MCP ownership for safe later deactivation", async () => {
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify(policy({ mcp: { allowedServers: [], allowManagedOnly: true } })),
    );
    const applied: PlanContext = { ...ctx(), apply: true, targets: ["claude", "cursor"] };

    const planned = await policyProjectCommand.plan(applied);

    expect(writes(planned.actions).map((action) => action.path)).toEqual([
      ".claude/managed-settings.json",
      ".aih-config.json",
      "managed-settings.json.example",
      "managed-mcp.json.example",
    ]);
    await executePlan(planned, applied);
    expect(JSON.parse(readFileSync(join(dir, ".aih-config.json"), "utf8"))).toMatchObject({
      targets: ["claude"],
      managedMcpProjection: { state: "active" },
    });
  });

  it("does not write Claude policy artifacts when Claude is not a selected target", async () => {
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(policy()));

    const planned = await policyProjectCommand.plan({
      ...ctx(),
      apply: true,
      targets: ["cursor"],
    });

    expect(planned.actions).toEqual([]);
    expect(existsSync(join(dir, ".claude", "managed-settings.json"))).toBe(false);
  });

  it("refuses an AIH_ORG_POLICY override before it can plan a configuration mutation", async () => {
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(policy()));
    writeFileSync(join(dir, "override.json"), JSON.stringify(policy()));
    const applied: PlanContext = {
      ...ctx(),
      apply: true,
      env: { AIH_ORG_POLICY: "override.json" },
    };

    await expect(policyProjectCommand.plan(applied)).rejects.toThrow(
      /configuration mutation requires the committed default policy/,
    );
  });

  it("requires a committed org policy instead of silently projecting nothing", async () => {
    await expect(policyProjectCommand.plan({ ...ctx(), apply: true })).rejects.toThrow(
      /policy project requires a committed aih-org-policy\.json/,
    );
  });

  it("migrates an older-generation managed allowlist and projection under --apply (#501)", async () => {
    // Fixture: managed artifacts written by a pre-2.9 aih — a bare (unhardened,
    // older-pinned) uvx allowlist entry and none of the newer projection keys.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "managed-settings.json"),
      JSON.stringify({
        allowManagedMcpServersOnly: true,
        allowedMcpServers: [{ serverCommand: ["uvx", "code-review-graph@2.1.0", "serve"] }],
      }),
    );
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify(
        policy({ mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true } }),
      ),
    );
    const applied: PlanContext = { ...ctx(), apply: true, targets: ["claude"] };

    await executePlan(await policyProjectCommand.plan(applied), applied);

    const managed = JSON.parse(
      readFileSync(join(dir, ".claude", "managed-settings.json"), "utf8"),
    ) as {
      organizationPolicy?: unknown;
      sandbox?: unknown;
      allowedMcpServers?: { serverCommand: string[] }[];
    };
    expect(managed.organizationPolicy).toBeDefined();
    expect(managed.sandbox).toBeDefined();
    const commands = (managed.allowedMcpServers ?? []).map((entry) => entry.serverCommand);
    expect(commands).toEqual([
      expect.arrayContaining(["uvx", "--offline", "--no-python-downloads", "--no-env-file"]),
    ]);
    expect(JSON.stringify(commands)).not.toContain("code-review-graph@2.1.0");

    const healed = ctx();
    const check = await orgPolicyDriftProbes(healed)
      .find((p) => p.describe.includes(".claude/managed-settings.json"))
      ?.run(healed);
    expect(check?.verdict).toBe("pass");
  });
});

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
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      command: { deny: { remove: ["printenv*"] } },
    });
  });

  it("accepts a fenced remote custom MCP record without claiming a content scan", () => {
    const parsed = parseOrgPolicy(
      policy({
        governance: {
          policyVersion: "2026.08.0",
          catalog: {
            reviewed: [],
            custom: [
              {
                id: "figma-remote",
                kind: "mcp",
                description: "Approved hosted design MCP",
                capabilities: [],
                risks: ["hosted endpoint"],
                source: {
                  type: "remote",
                  origin: "https://mcp.figma.com",
                  approval: {
                    approvedBy: "security-admin",
                    authenticationMode: "oauth",
                    allowedDataClasses: ["design-metadata"],
                  },
                  toolSurfaceDigest:
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  verdict: "approved",
                  contentScanned: false,
                },
                targets: ["claude"],
                projector: "mcp-managed-settings",
                lifecycle: "supported",
                evidence: { record: "figma-remote-approval" },
              },
            ],
          },
          activations: [],
          authority: { approvals: [] },
        },
      }),
    );

    expect(parsed.governance?.catalog.custom[0]?.source).toMatchObject({
      type: "remote",
      origin: "https://mcp.figma.com",
      verdict: "approved",
      contentScanned: false,
    });
  });

  it.each([
    ["a path-bearing endpoint", "https://mcp.figma.com/mcp"],
    ["an insecure endpoint", "http://mcp.figma.com"],
  ])("refuses remote custom MCP records with %s", (_label, origin) => {
    expect(() =>
      parseOrgPolicy(
        policy({
          governance: {
            policyVersion: "2026.08.0",
            catalog: {
              reviewed: [],
              custom: [
                {
                  id: "figma-remote",
                  kind: "mcp",
                  description: "Approved hosted design MCP",
                  capabilities: [],
                  risks: ["hosted endpoint"],
                  source: {
                    type: "remote",
                    origin,
                    approval: {
                      approvedBy: "security-admin",
                      authenticationMode: "oauth",
                      allowedDataClasses: ["design-metadata"],
                    },
                    toolSurfaceDigest:
                      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    verdict: "approved",
                    contentScanned: false,
                  },
                  targets: ["claude"],
                  projector: "mcp-managed-settings",
                  lifecycle: "supported",
                  evidence: { record: "figma-remote-approval" },
                },
              ],
            },
            activations: [],
            authority: { approvals: [] },
          },
        }),
      ),
    ).toThrow(/org-policy is invalid/);
  });

  it("rejects unsupported fields in command and risk-gate add items", () => {
    expect(() =>
      parseOrgPolicy(
        policy({
          command: { deny: { add: [{ pattern: "danger*", severity: "critical" }] } },
        }),
      ),
    ).toThrow(/org-policy is invalid/);
    expect(() =>
      parseOrgPolicy(
        policy({
          riskGates: {
            add: [
              {
                name: "critical_gate",
                description: "critical gate",
                behavior: "deny",
              },
            ],
          },
        }),
      ),
    ).toThrow(/org-policy is invalid/);
  });

  it("parses MCP host incumbency, GitHub host, and disabled server policy", () => {
    expect(
      parseOrgPolicy(
        policy({
          mcp: {
            allowedServers: ["code-review-graph", "github"],
            approvals: [
              {
                server: "context7",
                acceptEgress: true,
                reason: "vendor risk reviewed",
                reviewer: "security-platform",
                approvedAt: "2026-07-05T00:00:00.000Z",
              },
            ],
            allowManagedOnly: true,
            incumbentHosts: ["github.internal.example"],
            githubHost: "https://github.internal.example",
            disabledServers: ["context7"],
          },
        }),
      ).mcp,
    ).toMatchObject({
      allowedServers: ["code-review-graph", "github"],
      approvals: [
        {
          server: "context7",
          acceptEgress: true,
          reason: "vendor risk reviewed",
          reviewer: "security-platform",
          approvedAt: "2026-07-05T00:00:00.000Z",
        },
      ],
      allowManagedOnly: true,
      incumbentHosts: ["github.internal.example"],
      githubHost: "https://github.internal.example",
      disabledServers: ["context7"],
    });
  });

  it("normalizes MCP hosts the same way runtime URL matching does", () => {
    expect(
      parseOrgPolicy(
        policy({
          mcp: {
            incumbentHosts: ["API.GitHubCopilot.com:443"],
            githubHost: "https://GitHub.Internal.Example:443",
          },
        }),
      ).mcp,
    ).toMatchObject({
      incumbentHosts: ["api.githubcopilot.com"],
      githubHost: "https://github.internal.example",
    });
  });

  it("parses the optional trust policy block with defaults", () => {
    expect(
      parseOrgPolicy(
        policy({
          trust: {
            approvedSources: [
              {
                owner: "owner",
                repo: "repo",
                pinnedSha: "a".repeat(40),
                reason: "reviewed source override",
              },
            ],
            requiredDetectors: [
              "skillspector",
              "cisco",
              "mcp-scanner",
              "semgrep",
              "snyk-agent-scan",
            ],
          },
        }),
      ).trust,
    ).toEqual({
      approvedSources: [
        {
          owner: "owner",
          repo: "repo",
          pinnedSha: "a".repeat(40),
          reason: "reviewed source override",
        },
      ],
      requireSignedSource: false,
      requiredDetectors: ["skillspector", "cisco", "mcp-scanner", "semgrep", "snyk-agent-scan"],
      internalScopes: [],
    });
  });

  it("parses reviewed SkillSpector local digest approvals", () => {
    expect(
      parseOrgPolicy(
        policy({
          trust: {
            skillspector: {
              approvedDigests: [
                {
                  imageTag: "skillspector:aih-326a2b489411",
                  imageDigest:
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                  sourceRevision: "326a2b489411a20ed742ff13701be39ba00063c8",
                  reason: "reviewed local Docker build from pinned source",
                  reviewer: "security-platform",
                  approvedAt: "2026-07-08T00:00:00.000Z",
                },
              ],
            },
          },
        }),
      ).trust?.skillspector?.approvedDigests,
    ).toEqual([
      {
        imageTag: "skillspector:aih-326a2b489411",
        imageDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sourceRevision: "326a2b489411a20ed742ff13701be39ba00063c8",
        reason: "reviewed local Docker build from pinned source",
        reviewer: "security-platform",
        approvedAt: "2026-07-08T00:00:00.000Z",
      },
    ]);
  });

  it("rejects AgentShield as a governed detector while its advertised source is unavailable", () => {
    expect(() =>
      parseOrgPolicy(
        policy({
          trust: {
            requiredDetectors: ["agentshield"],
          },
        }),
      ),
    ).toThrow(/invalid option/i);
  });

  it("rejects redefinitions; command policy changes must be deltas", () => {
    expect(() => parseOrgPolicy(policy({ command: { deny: ["kubectl delete*"] } }))).toThrow(
      /org-policy/,
    );
  });

  it("rejects unknown trust policy fields", () => {
    expect(() => parseOrgPolicy(policy({ trust: { approveEverything: true } }))).toThrow(
      /org-policy/,
    );
  });

  it("rejects approved source hostPattern until multi-host fetch exists", () => {
    expect(() =>
      parseOrgPolicy(
        policy({
          trust: {
            approvedSources: [{ owner: "owner", repo: "repo", hostPattern: "github.internal" }],
          },
        }),
      ),
    ).toThrow(/org-policy/);
  });

  it("rejects detector names without a real scanner implementation", () => {
    expect(() => parseOrgPolicy(policy({ trust: { requiredDetectors: ["unknown"] } }))).toThrow(
      /org-policy/,
    );
  });

  it("rejects malformed SkillSpector local digest approvals", () => {
    expect(() =>
      parseOrgPolicy(
        policy({
          trust: {
            skillspector: {
              approvedDigests: [
                {
                  imageTag: "skillspector:aih-local",
                  imageDigest: "sha256:ABC",
                  sourceRevision: "326a2b489411a20ed742ff13701be39ba00063c8",
                  reason: "reviewed local Docker build",
                  approvedAt: "2026-07-08T00:00:00.000Z",
                },
              ],
            },
          },
        }),
      ),
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

  it("does not let org-policy downgrade hard-blocked license tiers", () => {
    const composed = composeOrgPolicy(
      parseOrgPolicy(
        policy({
          licenses: {
            disposition: {
              "network-copyleft": "auto-approve",
              "strong-copyleft": "alert",
            },
          },
        }),
      ),
    );

    const disposition = Object.fromEntries(
      composed.licenses.map((tier) => [tier.category, tier.disposition]),
    );
    // Only the literal hard-block tier is immutable. Strong copyleft remains
    // org-overridable so legal can choose an alert/fail posture per estate.
    expect(disposition["network-copyleft"]).toBe("block");
    expect(disposition["strong-copyleft"]).toBe("alert");
  });

  it("carries disabled MCP servers into the composed policy", () => {
    const composed = composeOrgPolicy(
      parseOrgPolicy(policy({ mcp: { disabledServers: ["code-review-graph"] } })),
    );

    expect(composed.mcp.disabledServers).toEqual(["code-review-graph"]);
  });
});

describe("orgPolicyProjectionActions", () => {
  it("projects enterprise policy into project managed-settings only", () => {
    const actions = orgPolicyProjectionActions(ctx(), parseOrgPolicy(policy()));
    const paths = writes(actions).map((w) => w.path.replace(/\\/g, "/"));
    expect(paths).toContain(".claude/managed-settings.json");
    expect(paths).toContain("managed-settings.json.example");
    expect(paths).toContain("managed-mcp.json.example");
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
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
      },
      allowManagedMcpServersOnly: true,
    });
    expect(JSON.stringify(managed?.json)).toContain("terraform destroy*");
  });

  it("filters disabled MCP servers out of managed projections", () => {
    const actions = orgPolicyProjectionActions(
      { ...ctx(), posture: "enterprise" },
      parseOrgPolicy(
        policy({
          minimumPosture: "enterprise",
          mcp: {
            allowedServers: ["code-review-graph", "sequential-thinking"],
            allowManagedOnly: true,
            disabledServers: ["code-review-graph"],
          },
        }),
      ),
    );
    const managedMcp = writes(actions).find((w) => w.path === "managed-mcp.json.example");
    const blob = JSON.stringify(managedMcp?.json);

    expect(blob).not.toContain("code-review-graph");
    expect(blob).toContain("server-sequential-thinking");
  });

  it("S1/S2 projects an empty managed allowlist as deny-all", () => {
    const actions = orgPolicyProjectionActions(
      { ...ctx(), posture: "enterprise" },
      parseOrgPolicy(
        policy({
          minimumPosture: "enterprise",
          mcp: { allowedServers: [], allowManagedOnly: true },
        }),
      ),
    );
    const out = Object.fromEntries(writes(actions).map((write) => [write.path, write]));

    expect(out[".claude/managed-settings.json"]?.json).toMatchObject({ allowedMcpServers: [] });
    expect(out["managed-mcp.json.example"]?.json).toMatchObject({ mcpServers: {} });
  });

  it("replaces stale managed MCP allowlist entries when projecting onto existing settings", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "managed-settings.json"),
      JSON.stringify({
        localOnly: true,
        allowManagedMcpServersOnly: true,
        allowedMcpServers: [{ serverCommand: ["uvx", "code-review-graph@2.3.6", "serve"] }],
      }),
    );
    const actions = orgPolicyProjectionActions(
      { ...ctx(), posture: "enterprise" },
      parseOrgPolicy(
        policy({
          minimumPosture: "enterprise",
          mcp: {
            allowedServers: ["code-review-graph", "sequential-thinking"],
            allowManagedOnly: true,
            disabledServers: ["code-review-graph"],
          },
        }),
      ),
    );
    const managed = writes(actions).find((w) => w.path === ".claude/managed-settings.json");
    if (managed === undefined) throw new Error("expected managed-settings write");
    const merged = JSON.parse(
      resolveContents(managed, join(dir, ".claude", "managed-settings.json")),
    ) as { localOnly?: boolean; allowedMcpServers?: unknown[] };
    const allowlist = JSON.stringify(merged.allowedMcpServers);

    expect(merged.localOnly).toBe(true);
    expect(allowlist).toContain("server-sequential-thinking");
    expect(allowlist).not.toContain("code-review-graph");
  });

  it("deactivates only an exact AIH-owned managed-MCP projection", async () => {
    const managedPath = join(dir, ".claude", "managed-settings.json");
    const markerPath = join(dir, ".aih-config.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(managedPath, JSON.stringify({ operatorOnly: true }));
    const activeCtx: PlanContext = { ...ctx(), posture: "enterprise", apply: true };
    const activePolicy = parseOrgPolicy(
      policy({
        minimumPosture: "enterprise",
        mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
      }),
    );

    await executePlan(
      plan("org-policy", ...orgPolicyProjectionActions(activeCtx, activePolicy)),
      activeCtx,
    );
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      managedMcpProjection: { state: "active" },
    });

    const inactivePolicy = parseOrgPolicy(
      policy({
        minimumPosture: "enterprise",
        mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: false },
      }),
    );
    await executePlan(
      plan("org-policy", ...orgPolicyProjectionActions(activeCtx, inactivePolicy)),
      activeCtx,
    );
    expect(JSON.parse(readFileSync(managedPath, "utf8"))).toEqual(
      expect.objectContaining({ operatorOnly: true }),
    );
    expect(JSON.parse(readFileSync(managedPath, "utf8"))).not.toHaveProperty(
      "allowManagedMcpServersOnly",
    );
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).not.toHaveProperty("managedMcpProjection");

    await executePlan(
      plan("org-policy", ...orgPolicyProjectionActions(activeCtx, activePolicy)),
      activeCtx,
    );
    const operatorProjection = {
      operatorOnly: true,
      allowManagedMcpServersOnly: true,
      allowedMcpServers: [{ serverCommand: ["operator-mcp", "serve"] }],
    };
    writeFileSync(managedPath, JSON.stringify(operatorProjection));
    await executePlan(
      plan("org-policy", ...orgPolicyProjectionActions(activeCtx, inactivePolicy)),
      activeCtx,
    );
    expect(JSON.parse(readFileSync(managedPath, "utf8"))).toMatchObject(operatorProjection);
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      managedMcpProjection: { state: "revoked" },
    });
  });

  it("refuses policy-projection deactivation when its owned settings change after planning", async () => {
    const managedPath = join(dir, ".claude", "managed-settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(managedPath, JSON.stringify({ operatorOnly: true }));
    const activeCtx: PlanContext = { ...ctx(), posture: "enterprise", apply: true };
    const activePolicy = parseOrgPolicy(
      policy({
        minimumPosture: "enterprise",
        mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
      }),
    );
    await executePlan(
      plan("org-policy", ...orgPolicyProjectionActions(activeCtx, activePolicy)),
      activeCtx,
    );

    const inactivePolicy = parseOrgPolicy(
      policy({
        minimumPosture: "enterprise",
        mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: false },
      }),
    );
    const planned = plan("org-policy", ...orgPolicyProjectionActions(activeCtx, inactivePolicy));
    const operatorProjection = JSON.stringify({
      operatorOnly: true,
      allowManagedMcpServersOnly: true,
      allowedMcpServers: [{ serverCommand: ["operator-mcp", "serve"] }],
    });
    writeFileSync(managedPath, operatorProjection);

    await expect(executePlan(planned, activeCtx)).rejects.toThrow(
      /changed after the plan was computed/,
    );
    expect(readFileSync(managedPath, "utf8")).toBe(operatorProjection);
  });

  it("refuses policy-projection deactivation when its ownership marker changes after planning", async () => {
    const managedPath = join(dir, ".claude", "managed-settings.json");
    const markerPath = join(dir, ".aih-config.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(managedPath, JSON.stringify({ operatorOnly: true }));
    const activeCtx: PlanContext = { ...ctx(), posture: "enterprise", apply: true };
    const activePolicy = parseOrgPolicy(
      policy({
        minimumPosture: "enterprise",
        mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
      }),
    );
    await executePlan(
      plan("org-policy", ...orgPolicyProjectionActions(activeCtx, activePolicy)),
      activeCtx,
    );

    const inactivePolicy = parseOrgPolicy(
      policy({
        minimumPosture: "enterprise",
        mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: false },
      }),
    );
    const planned = plan("org-policy", ...orgPolicyProjectionActions(activeCtx, inactivePolicy));
    const operatorMarker = {
      ...JSON.parse(readFileSync(markerPath, "utf8")),
      operatorRevision: 1,
    };
    writeFileSync(markerPath, JSON.stringify(operatorMarker));

    await expect(executePlan(planned, activeCtx)).rejects.toThrow(
      /changed after the plan was computed/,
    );
    expect(JSON.parse(readFileSync(managedPath, "utf8"))).toMatchObject({
      allowManagedMcpServersOnly: true,
    });
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({ operatorRevision: 1 });
  });
});

describe("orgPolicyDriftProbes — target scope (#554)", () => {
  function writeScopePolicy(value: Record<string, unknown>): void {
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(value));
  }

  // Enterprise floor: the posture the defect was reported under, and the one where a
  // missing projection is a hard fail rather than a posture-downgraded warning.
  const denyPolicy = () =>
    policy({
      minimumPosture: "enterprise",
      command: { deny: { add: [{ pattern: "terraform destroy*" }] } },
    });

  function scopeCtx(targets: readonly string[]): PlanContext {
    return { ...ctx(), posture: "enterprise", targets: targets as PlanContext["targets"] };
  }

  /** Every registered CLI that does NOT own the projected `.claude/` artifacts. */
  const nonOwners = REGISTRY_IDS.filter((id) => !entry(id).configDirs.includes(".claude"));

  it.each(nonOwners)(
    "does not fail a %s-only repo for an artifact it never projects",
    async (cli) => {
      writeScopePolicy(denyPolicy());
      const c = scopeCtx([cli]);
      const checks = await Promise.all(orgPolicyDriftProbes(c).map((p) => p.run(c)));
      // `aih policy project` emits zero actions when the owning CLI is untargeted,
      // so a failing drift finding here would be unsatisfiable by construction.
      expect(checks.filter((k) => k?.verdict === "fail").map((k) => k?.detail ?? "")).toEqual([]);
    },
  );

  it("still fails a Claude-targeted repo when the projection is missing", async () => {
    writeScopePolicy(denyPolicy());
    const c = scopeCtx(["claude"]);
    const checks = await Promise.all(orgPolicyDriftProbes(c).map((p) => p.run(c)));
    expect(checks.some((k) => k?.verdict === "fail")).toBe(true);
  });

  // #566 — the agent-facing contract. These commands are invoked by agents, so a
  // repairable finding must name EXACTLY ONE runnable command, and a non-repairable
  // one must carry a DISTINCT code so an agent escalates instead of looping.
  it("names aih prune for a marker-proven dropped-target residue", async () => {
    const managedOnly = policy({
      minimumPosture: "enterprise",
      mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
    });
    writeScopePolicy(managedOnly);
    // Build the owned projection with the real projection path, then drop claude.
    const projectCtx: PlanContext = { ...ctx(), posture: "enterprise", apply: true };
    await executePlan(
      plan("org-policy", ...orgPolicyProjectionActions(projectCtx, parseOrgPolicy(managedOnly))),
      projectCtx,
    );

    const c = scopeCtx(["kiro"]);
    const checks = await Promise.all(orgPolicyDriftProbes(c).map((p) => p.run(c)));
    const residue = checks.find((k) => k?.code === "org-policy.dropped-target-residue");
    expect(residue?.verdict).toBe("fail");
    expect(residue?.detail ?? "").toMatch(/aih prune/);
    expect(residue?.location?.uri).toBe(".claude/managed-settings.json");
  });

  it("uses a distinct code when the dropped-target residue is not repairable", async () => {
    writeScopePolicy(denyPolicy());
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "managed-settings.json"), JSON.stringify({ stale: true }));
    const c = scopeCtx(["kiro"]);
    const checks = await Promise.all(orgPolicyDriftProbes(c).map((p) => p.run(c)));
    const unowned = checks.find((k) => k?.code === "org-policy.dropped-target-unowned");
    expect(unowned?.verdict).toBe("fail");
    expect(unowned?.detail ?? "").toMatch(/no active managed-MCP ownership/);
    expect(unowned?.detail ?? "").not.toMatch(/aih prune/);
    expect(checks.some((k) => k?.code === "org-policy.dropped-target-residue")).toBe(false);
  });

  it("reports dropped-target residue when an untargeted artifact is still on disk", async () => {
    writeScopePolicy(denyPolicy());
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "managed-settings.json"), JSON.stringify({ stale: true }));
    const c = scopeCtx(["kiro"]);
    const checks = await Promise.all(orgPolicyDriftProbes(c).map((p) => p.run(c)));
    const details = checks
      .filter((k) => k?.verdict === "fail")
      .map((k) => k?.detail ?? "")
      .join(" ");
    expect(details).not.toBe("");
    // Must name a repair the operator can actually perform, never a projection that
    // cannot run here. `aih prune` is NOT it: prune reconciles the registered per-CLI
    // settings path, not this projected managed-settings file (#564), so naming it
    // would repeat the unsatisfiable-remediation defect this gate exists to fix.
    expect(details).not.toMatch(/policy project --apply/);
    expect(details).not.toMatch(/aih prune/);
    expect(details).toMatch(/re-project/i);
    expect(details).toMatch(/targets in \.aih-config\.json|remove the file/i);
  });

  // Reproduction B of the same defect: the managed-allowlist probe is a SEPARATE
  // code path from the drift probes above, and #501's generation-delta migration
  // prescribes the same `aih policy project --apply` that emits zero actions here.
  it("does not prescribe policy projection for an untargeted managed allowlist", async () => {
    writeScopePolicy(
      policy({
        minimumPosture: "enterprise",
        mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
      }),
    );
    // Current .mcp.json: the hardened uvx launch shape this generation emits.
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "code-review-graph": {
            type: "stdio",
            command: "uvx",
            args: [
              "--offline",
              "--no-python-downloads",
              "--no-env-file",
              "code-review-graph@2.2.0",
              "serve",
            ],
          },
        },
      }),
    );
    // Residue: a Claude managed allowlist left by an earlier aih generation.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "managed-settings.json"),
      JSON.stringify({
        allowManagedMcpServersOnly: true,
        allowedMcpServers: [{ serverCommand: ["uvx", "code-review-graph@2.1.0", "serve"] }],
      }),
    );

    const check = mcpManagedAllowlistCheck(scopeCtx(["kiro"]));

    // `aih policy project --cli kiro` emits zero actions, so prescribing it is
    // unsatisfiable by construction — route to prune like the drift probes do.
    expect(check.detail ?? "").not.toMatch(/policy project --apply/);
  });
});

describe("orgPolicyDriftProbes", () => {
  function writePolicy(value: Record<string, unknown>): void {
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(value));
  }

  function writeManagedSettings(value: unknown): void {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "managed-settings.json"), JSON.stringify(value));
  }

  it("passes when local managed settings contain the org-policy projection", async () => {
    const value = policy({
      command: { deny: { add: [{ pattern: "terraform destroy*" }] } },
      mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
    });
    const parsed = parseOrgPolicy(value);
    writePolicy(value);

    const c = ctx();
    const projected = writes(orgPolicyProjectionActions(c, parsed)).find(
      (w) => w.path === ".claude/managed-settings.json",
    );
    writeManagedSettings({ ...(projected?.json as Record<string, unknown>), localOnly: true });

    const probes = orgPolicyDriftProbes(c);
    const check = await probes
      .find((p) => p.describe.includes(".claude/managed-settings.json"))
      ?.run(c);

    expect(check?.verdict).toBe("pass");
  });

  it("does not generate managed-settings drift probes at vibe posture", () => {
    writePolicy(
      policy({
        minimumPosture: "vibe",
        command: { deny: { add: [{ pattern: "terraform destroy*" }] } },
      }),
    );
    const c: PlanContext = { ...ctx(), posture: "vibe", postureSource: "flag" };
    const probes = orgPolicyDriftProbes(c);

    expect(probes.map((probe) => probe.describe)).not.toContain(
      "org-policy drift: .claude/managed-settings.json",
    );
  });

  it("fails closed at enterprise when local settings drift from org policy", async () => {
    writePolicy(policy({ minimumPosture: "enterprise" }));
    writeManagedSettings({ organizationPolicy: { minimumPosture: "enterprise" } });
    const c: PlanContext = { ...ctx(), posture: "enterprise" };
    const probes = orgPolicyDriftProbes(c);
    const check = await probes
      .find((p) => p.describe.includes(".claude/managed-settings.json"))
      ?.run(c);

    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.drift");
    expect(check?.location?.uri).toBe(".claude/managed-settings.json");
    expect(check?.detail).toContain("org-policy drift");
  });

  it("fails when managed settings contain extra stale MCP allowlist entries", async () => {
    const value = policy({
      mcp: {
        allowedServers: ["sequential-thinking"],
        allowManagedOnly: true,
        disabledServers: ["code-review-graph"],
      },
    });
    const parsed = parseOrgPolicy(value);
    writePolicy(value);
    const c = ctx();
    const projected = writes(orgPolicyProjectionActions(c, parsed)).find(
      (w) => w.path === ".claude/managed-settings.json",
    );
    writeManagedSettings({
      ...(projected?.json as Record<string, unknown>),
      allowedMcpServers: [
        ...((projected?.json as { allowedMcpServers?: unknown[] })?.allowedMcpServers ?? []),
        { serverCommand: ["uvx", "code-review-graph@2.3.6", "serve"] },
      ],
    });

    const check = await orgPolicyDriftProbes(c)
      .find((p) => p.describe.includes(".claude/managed-settings.json"))
      ?.run(c);

    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.drift");
    expect(check?.detail).toContain("allowedMcpServers");
  });

  it("projects drift expectations at the resolved posture, not only the policy floor", () => {
    writePolicy(policy({ minimumPosture: "enterprise" }));
    const c: PlanContext = { ...ctx(), posture: "enterprise", postureSource: "flag" };
    const probes = orgPolicyDriftProbes(c);

    expect(probes.map((p) => p.describe)).toContain(
      "org-policy drift: managed-settings.json.example",
    );
    expect(probes.map((p) => p.describe)).toContain("org-policy drift: managed-mcp.json.example");
  });

  // #501 — an in-place upgrade leaves managed artifacts aih itself generated
  // under an older shape. That is a generation delta (aih's generated output
  // evolved), not user drift, and the message must name the re-projection command.
  function writeOldGenerationFixture(minimumPosture: "vibe" | "enterprise" = "enterprise"): void {
    writePolicy(
      policy({
        minimumPosture,
        mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
      }),
    );
    writeManagedSettings({
      allowManagedMcpServersOnly: true,
      // bare pre-hardening launch shape with an older pin; the newer
      // organizationPolicy/sandbox projection keys are absent entirely.
      allowedMcpServers: [{ serverCommand: ["uvx", "code-review-graph@2.1.0", "serve"] }],
    });
  }

  it("reports a generation delta naming the re-projection command, not user drift (#501)", async () => {
    writeOldGenerationFixture();
    const c = ctx();

    const check = await orgPolicyDriftProbes(c)
      .find((p) => p.describe.includes(".claude/managed-settings.json"))
      ?.run(c);

    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.generation-delta");
    expect(check?.detail).toContain("generation delta");
    expect(check?.detail).toContain("aih policy project --apply");
    expect(check?.detail).not.toMatch(/drift/i);
    expect(check?.name).not.toMatch(/drift/i);
    expect(check?.location?.uri).toBe(".claude/managed-settings.json");
  });

  it("does not generate a generation-delta probe at vibe posture", () => {
    writeOldGenerationFixture("vibe");
    const c: PlanContext = { ...ctx(), posture: "vibe", postureSource: "flag" };

    expect(orgPolicyDriftProbes(c).map((probe) => probe.describe)).not.toContain(
      "org-policy drift: .claude/managed-settings.json",
    );
  });

  it("fails closed as drift when an allowlist entry matches no aih generation", async () => {
    writePolicy(policy({ mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true } }));
    writeManagedSettings({
      allowManagedMcpServersOnly: true,
      allowedMcpServers: [{ serverCommand: ["uvx", "operator-tool", "serve"] }],
    });
    const c = ctx();

    const check = await orgPolicyDriftProbes(c)
      .find((p) => p.describe.includes(".claude/managed-settings.json"))
      ?.run(c);

    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.drift");
    expect(check?.detail).toContain("org-policy drift");
  });

  it("fails closed as drift when a generation-shaped delta is mixed with a real edit", async () => {
    const value = policy({
      mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
    });
    const parsed = parseOrgPolicy(value);
    writePolicy(value);
    const c: PlanContext = { ...ctx(), posture: "enterprise" };
    const projected = writes(orgPolicyProjectionActions(c, parsed)).find(
      (w) => w.path === ".claude/managed-settings.json",
    );
    const expected = projected?.json as { organizationPolicy?: Record<string, unknown> };
    writeManagedSettings({
      allowManagedMcpServersOnly: true,
      allowedMcpServers: [{ serverCommand: ["uvx", "code-review-graph@2.1.0", "serve"] }],
      // a value both sides carry but with different content: a real local edit
      organizationPolicy: { ...expected.organizationPolicy, minimumPosture: "vibe" },
    });

    const check = await orgPolicyDriftProbes(c)
      .find((p) => p.describe.includes(".claude/managed-settings.json"))
      ?.run(c);

    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.drift");
  });
});

describe("orgPolicyIntegrityProbes", () => {
  function writePolicy(value: Record<string, unknown>): string {
    const raw = JSON.stringify(value);
    writeFileSync(join(dir, "aih-org-policy.json"), raw);
    return raw;
  }

  it("flags AIH_ORG_POLICY env overrides prominently at enterprise posture", async () => {
    writeFileSync(join(dir, "override.json"), JSON.stringify(policy()));
    const c: PlanContext = {
      ...ctx(),
      posture: "enterprise",
      env: { AIH_ORG_POLICY: "override.json" },
    };
    const check = await orgPolicyIntegrityProbes(c)
      .find((p) => p.describe === "org-policy source")
      ?.run(c);

    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.drift");
    expect(check?.detail).toContain("AIH_ORG_POLICY env override");
  });

  it("downgrades env override visibility to warning-only at vibe posture", async () => {
    writeFileSync(join(dir, "override.json"), JSON.stringify(policy()));
    const c: PlanContext = {
      ...ctx(),
      posture: "vibe",
      env: { AIH_ORG_POLICY: "override.json" },
    };
    const check = await orgPolicyIntegrityProbes(c)
      .find((p) => p.describe === "org-policy source")
      ?.run(c);

    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("warning-only (vibe posture)");
  });

  it("flags working-tree policy drift from HEAD", async () => {
    const head = JSON.stringify(policy({ minimumPosture: "enterprise" }));
    writePolicy(policy({ minimumPosture: "enterprise" }));
    const run = fakeRunner((argv) => {
      if (argv[0] === "git" && argv.includes(`HEAD:aih-org-policy.json`)) {
        return { code: 0, stdout: head };
      }
      return undefined;
    });
    const c: PlanContext = {
      ...ctx(),
      posture: "enterprise",
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    };
    const check = await orgPolicyIntegrityProbes(c)
      .find((p) => p.describe === "org-policy HEAD drift")
      ?.run(c);

    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.drift");
    expect(check?.detail).toContain("differs from HEAD");
  });

  it("emits a report digest when policy integrity has a visible signal", async () => {
    writePolicy(policy());
    const run = fakeRunner((argv) => {
      if (argv[0] === "git" && argv.includes(`HEAD:aih-org-policy.json`)) {
        return { code: 0, stdout: JSON.stringify(policy()) };
      }
      return undefined;
    });
    const c: PlanContext = {
      ...ctx(),
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    };
    const digest = await orgPolicyIntegrityDigest(c);

    expect(digest?.describe).toContain("Org policy integrity");
    expect(digest?.text).toContain("org-policy source");
    expect(digest?.text).toContain("org-policy HEAD drift");
  });
});
