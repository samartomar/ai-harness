import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan, resolveContents } from "../../src/internals/execute.js";
import type { PlanContext, WriteAction } from "../../src/internals/plan.js";
import { plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { composeOrgPolicy } from "../../src/org-policy/compose.js";
import {
  orgPolicyDriftProbes,
  orgPolicyIntegrityDigest,
  orgPolicyIntegrityProbes,
} from "../../src/org-policy/drift.js";
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
              "agentshield",
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
      requiredDetectors: [
        "skillspector",
        "cisco",
        "mcp-scanner",
        "semgrep",
        "snyk-agent-scan",
        "agentshield",
      ],
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
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).not.toHaveProperty(
      "managedMcpProjection",
    );

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
    expect(JSON.parse(readFileSync(managedPath, "utf8"))).toEqual(operatorProjection);
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      managedMcpProjection: { state: "revoked" },
    });
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

  it("downgrades drift to warning-only in vibe posture", async () => {
    writePolicy(policy({ command: { deny: { add: [{ pattern: "terraform destroy*" }] } } }));
    const c: PlanContext = { ...ctx(), posture: "vibe", postureSource: "flag" };
    const probes = orgPolicyDriftProbes(c);
    const check = await probes
      .find((p) => p.describe.includes(".claude/managed-settings.json"))
      ?.run(c);

    expect(check?.verdict).toBe("pass");
    expect(check?.code).toBeUndefined();
    expect(check?.detail).toContain("warning-only (vibe posture)");
    expect(check?.detail).toContain("missing");
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
    writePolicy(policy({ minimumPosture: "team" }));
    const c: PlanContext = { ...ctx(), posture: "enterprise", postureSource: "flag" };
    const probes = orgPolicyDriftProbes(c);

    expect(probes.map((p) => p.describe)).toContain(
      "org-policy drift: managed-settings.json.example",
    );
    expect(probes.map((p) => p.describe)).toContain("org-policy drift: managed-mcp.json.example");
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

  it("downgrades env override visibility to warning-only at team posture", async () => {
    writeFileSync(join(dir, "override.json"), JSON.stringify(policy()));
    const c: PlanContext = { ...ctx(), posture: "team", env: { AIH_ORG_POLICY: "override.json" } };
    const check = await orgPolicyIntegrityProbes(c)
      .find((p) => p.describe === "org-policy source")
      ?.run(c);

    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("warning-only (team posture)");
  });

  it("flags working-tree policy drift from HEAD", async () => {
    const head = JSON.stringify(policy({ minimumPosture: "team" }));
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
