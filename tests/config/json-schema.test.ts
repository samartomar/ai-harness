import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { generatedConfigSchemas } from "../../src/config/json-schema.js";

const root = process.cwd();

describe("committed JSON Schemas", () => {
  function validateCommittedSchema(path: string, value: unknown): void {
    const schema = JSON.parse(readFileSync(join(root, path), "utf8"));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate(value), JSON.stringify(validate.errors, null, 2)).toBe(true);
  }

  function rejectCommittedSchema(path: string, value: unknown): void {
    const schema = JSON.parse(readFileSync(join(root, path), "utf8"));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate(value)).toBe(false);
  }

  it("emits editor schemas for config, governed policy, authority receipt, and package graph", () => {
    const schemas = generatedConfigSchemas();

    expect(schemas.map((schema) => schema.path)).toEqual([
      "schemas/aih-config.schema.json",
      "schemas/aih-org-policy.schema.json",
      "schemas/aih-policy-authority-receipt.schema.json",
      "schemas/aih-package-graph.schema.json",
      "schemas/aih-capability-package-manifest.schema.json",
    ]);
    expect(schemas[0]?.schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: ".aih-config.json",
      type: "object",
    });
    expect(schemas[1]?.schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "aih-org-policy.json",
      type: "object",
    });
    expect(schemas[2]?.schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: ".aih/policy-authority-receipt.json",
      type: "object",
    });
    expect(schemas[3]?.schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $comment: expect.stringContaining("PackageGraphSchema.parse"),
      title: "aih-package-graph.schema.json",
      type: "object",
    });
    expect(schemas[4]?.schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $comment: expect.stringContaining("CapabilityPackageManifestSchema.parse"),
      title: "aih-capability-package-manifest.schema.json",
      type: "object",
    });
  });

  it("keeps the committed schema files in sync with zod", () => {
    for (const schema of generatedConfigSchemas()) {
      const committed = JSON.parse(readFileSync(join(root, schema.path), "utf8"));
      expect(committed).toEqual(schema.schema);
    }
  });

  it("treats runtime-defaulted fields as optional editor inputs", () => {
    validateCommittedSchema("schemas/aih-config.schema.json", {
      schemaVersion: 1,
      contextDir: "ai-coding",
      baseline: "ecc",
    });
    validateCommittedSchema("schemas/aih-org-policy.schema.json", {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      command: { deny: {} },
      trust: {},
    });
  });

  it("publishes strict v1 or decision-bound v2 MCP ownership receipts", () => {
    const base = { schemaVersion: 1, contextDir: "ai-coding" };
    const binding = {
      candidate: "code-review-graph",
      id: "decision-graph",
      issuer: "security-admin",
      digest: `sha256:${"a".repeat(64)}`,
      expiresAt: "2026-09-01T00:00:00.000+00:00",
    };
    const v2 = {
      schemaVersion: 2,
      state: "active",
      expected: {
        allowManagedMcpServersOnly: true,
        allowedMcpServers: [{ serverCommand: ["aih-mcp", "serve"] }],
      },
      decisions: [binding],
      sha256: "b".repeat(64),
    };

    validateCommittedSchema("schemas/aih-config.schema.json", {
      ...base,
      managedMcpProjection: v2,
    });
    for (const invalid of [
      { ...v2, schemaVersion: 1 },
      { ...v2, schemaVersion: "2" },
      { ...v2, decisions: undefined },
      { ...v2, decisions: [{ ...binding, expiresAt: "2026-09-01T00:00:00" }] },
      { ...v2, unexpected: true },
    ]) {
      rejectCommittedSchema("schemas/aih-config.schema.json", {
        ...base,
        managedMcpProjection: invalid,
      });
    }
  });

  it("publishes package-root-only policy selection without authority fields", () => {
    const base = {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      capabilityPackages: {
        catalog: { provider: "github", repository: "Owner/Capabilities" },
        roots: ["package:skill-pack/docs-quality"],
      },
    };
    validateCommittedSchema("schemas/aih-org-policy.schema.json", base);
    rejectCommittedSchema("schemas/aih-org-policy.schema.json", {
      ...base,
      capabilityPackages: { ...base.capabilityPackages, authorities: [] },
    });
  });

  it("publishes strict Package Graph v1 editor validation", () => {
    const valid = {
      schemaVersion: 1,
      surfaces: [
        {
          id: "skill:security-review",
          source: { provider: "github", repository: "acme/security-skills" },
          sourceDigest: { algorithm: "git-sha1", value: "a".repeat(40) },
          declaredRisk: [{ axis: "egress", value: "none" }],
          observedRisk: [
            {
              detector: { name: "aih-native", version: "5.0.0" },
              evidence: {
                sha256: "b".repeat(64),
                subjectDigest: { algorithm: "git-sha1", value: "a".repeat(40) },
              },
              verdict: "pass",
              findings: [],
            },
          ],
        },
      ],
      packages: [
        {
          id: "package:baseline/ecc",
          source: { provider: "github", repository: "affaan-m/ecc" },
          sourceDigest: { algorithm: "sha256", value: "c".repeat(64) },
          members: ["skill:security-review"],
          declaredRisk: [],
          observedRisk: [],
        },
      ],
    };

    validateCommittedSchema("schemas/aih-package-graph.schema.json", valid);
    rejectCommittedSchema("schemas/aih-package-graph.schema.json", {
      ...valid,
      surfaces: [{ ...valid.surfaces[0], extra: true }],
    });
    rejectCommittedSchema("schemas/aih-package-graph.schema.json", {
      ...valid,
      packages: [{ ...valid.packages[0], members: ["package:baseline/other"] }],
    });
  });

  it("publishes strict Capability Package Manifest v1 editor validation", () => {
    const valid = {
      schemaVersion: 1,
      authorities: [
        {
          id: "catalog:public",
          kind: "catalog",
          sourceDigest: { algorithm: "sha256", value: "a".repeat(64) },
          projectionDigest: "b".repeat(64),
        },
      ],
      roots: ["package:baseline/ecc"],
      packages: [
        {
          kind: "package",
          id: "package:baseline/ecc",
          authorityId: "catalog:public",
          claimDigest: "c".repeat(64),
          sourceDigest: { algorithm: "git-sha1", value: "d".repeat(40) },
          dependencies: [],
          members: ["skill:security-review"],
        },
      ],
    };

    validateCommittedSchema("schemas/aih-capability-package-manifest.schema.json", valid);
    rejectCommittedSchema("schemas/aih-capability-package-manifest.schema.json", {
      ...valid,
      packages: [{ ...valid.packages[0], kind: "surface" }],
    });
    rejectCommittedSchema("schemas/aih-capability-package-manifest.schema.json", {
      ...valid,
      packages: [{ ...valid.packages[0], members: ["hook:pre-commit"] }],
    });
    rejectCommittedSchema("schemas/aih-capability-package-manifest.schema.json", {
      ...valid,
      authorities: [{ ...valid.authorities[0], id: "receipt:wrong-kind" }],
    });
  });

  it("requires an explicit non-empty registry allow-list at enterprise posture", () => {
    const base = {
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
    };
    rejectCommittedSchema("schemas/aih-org-policy.schema.json", base);
    rejectCommittedSchema("schemas/aih-org-policy.schema.json", {
      ...base,
      governance: {
        policyVersion: "1",
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
        supportedClis: [],
      },
    });
    rejectCommittedSchema("schemas/aih-org-policy.schema.json", {
      ...base,
      governance: {
        policyVersion: "1",
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
        supportedClis: ["*"],
      },
    });
    validateCommittedSchema("schemas/aih-org-policy.schema.json", {
      ...base,
      governance: {
        policyVersion: "1",
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
        supportedClis: ["claude"],
      },
    });
  });

  it("publishes strict bounded local-only Strix policy inputs", () => {
    const base = {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
    };
    const strix = {
      enabled: true,
      required: true,
      targetKind: "local-fixture",
      mode: "standard",
      maxBudgetCents: 500,
      maxTurns: 10,
      timeoutMs: 120_000,
      telemetry: "off",
      imageDigest: `sha256:${"a".repeat(64)}`,
    };

    validateCommittedSchema("schemas/aih-org-policy.schema.json", {
      ...base,
      security: { strix },
    });
    for (const invalid of [
      { ...strix, imageDigest: "ghcr.io/usesecurity/strix:latest" },
      { ...strix, targetKind: "live" },
      { ...strix, allowLiveTargets: true },
      { ...strix, allowMounts: true },
      { ...strix, enabled: false, required: true },
      { ...strix, maxBudgetCents: 0 },
      { ...strix, maxTurns: 0 },
      { ...strix, timeoutMs: 0 },
      { ...strix, maxBudgetCents: 1_001 },
      { ...strix, maxTurns: 21 },
      { ...strix, timeoutMs: 300_001 },
      { ...strix, roe: { approved: true } },
    ]) {
      rejectCommittedSchema("schemas/aih-org-policy.schema.json", {
        ...base,
        security: { strix: invalid },
      });
    }
  });

  it("models source-locked ECC external MCP approvals as declarative records", () => {
    const base = {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
    };
    const governance = (eccMcpApprovals: unknown[]) => ({
      ...base,
      governance: {
        policyVersion: "2026.08",
        supportedClis: ["claude"],
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
        eccMcpApprovals,
      },
    });
    const approval = {
      id: "vercel",
      sourceContentSha256: "a4426254c55a5352db2672bc86a87f10b0029f5e4ae1b74817841e87d9ab1e57",
      state: "approved",
      approvedBy: "security-admin",
      authenticationMode: "oauth",
      allowedDataClasses: ["deployment-metadata"],
    };

    validateCommittedSchema("schemas/aih-org-policy.schema.json", governance([approval]));
    for (const invalid of [
      { ...approval, id: "github" },
      { ...approval, sourceContentSha256: "0".repeat(64) },
      { ...approval, allowedDataClasses: [] },
      { ...approval, unexpected: true },
    ]) {
      rejectCommittedSchema("schemas/aih-org-policy.schema.json", governance([invalid]));
    }
  });

  it("models source-locked ECC hook controls in the committed editor schema", () => {
    const base = {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026.08",
        supportedClis: ["claude"],
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
      },
    };
    const policy = (eccHookControls: unknown) => ({
      ...base,
      governance: { ...base.governance, eccHookControls },
    });

    validateCommittedSchema(
      "schemas/aih-org-policy.schema.json",
      policy({ profile: "standard", disabledIds: ["pre:observe", "post:quality-gate"] }),
    );
    for (const invalid of [
      { profile: "standard", disabledIds: ["unknown:hook"] },
      { profile: "standard", disabledIds: ["pre:bash:dispatcher"] },
      { profile: "standard", extra: true },
      { disabledIds: ["pre:observe"] },
    ]) {
      rejectCommittedSchema("schemas/aih-org-policy.schema.json", policy(invalid));
    }
  });

  it("rejects unknown baseline ids in .aih-config.json", () => {
    rejectCommittedSchema("schemas/aih-config.schema.json", {
      schemaVersion: 1,
      contextDir: "ai-coding",
      baseline: "missing",
    });
  });

  it("rejects contextDir values that runtime settings reject", () => {
    for (const contextDir of ["../escape", "docs/../ai-coding", "/abs"]) {
      rejectCommittedSchema("schemas/aih-config.schema.json", {
        schemaVersion: 1,
        contextDir,
      });
    }
  });

  it("rejects unsupported fields in org-policy add-item schemas", () => {
    const base = {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
    };
    rejectCommittedSchema("schemas/aih-org-policy.schema.json", {
      ...base,
      command: { deny: { add: [{ pattern: "danger*", severity: "critical" }] } },
    });
    rejectCommittedSchema("schemas/aih-org-policy.schema.json", {
      ...base,
      riskGates: {
        add: [
          {
            name: "critical_gate",
            description: "critical gate",
            behavior: "deny",
          },
        ],
      },
    });
  });

  it("accepts governed hook registrations in the org policy editor schema", () => {
    validateCommittedSchema("schemas/aih-org-policy.schema.json", {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026-08-06.1",
        supportedClis: ["claude"],
        catalog: { reviewed: [], custom: [] },
        hookRegistrations: [
          {
            id: "ecc-stop-session-summary",
            event: "Stop",
            command:
              "node -e \"require('~/.claude/scripts/hooks/run-with-flags.js').run('session-summary.js')\"",
            functionTags: ["session-summary"],
            spawns: 3,
            owner: {
              kind: "third-party",
              framework: "ecc",
              declaredControls: ["ECC_HOOK_PROFILE"],
              pin: {
                repository: "affaan-m/ECC",
                commit: "623f2c020f052319657674e4e6c29ab5d0ad566b",
                path: "scripts/hooks/session-summary.js",
                launcherSha256: `sha256:${"b".repeat(64)}`,
                runtimeVersion: "3.7.1",
              },
            },
          },
        ],
      },
    });
  });

  it("rejects githubHost values that are not bare https origins", () => {
    const base = {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
    };
    validateCommittedSchema("schemas/aih-org-policy.schema.json", {
      ...base,
      mcp: { githubHost: "https://github.internal.example" },
    });
    for (const githubHost of [
      "http://github.internal.example",
      "https://github.internal.example/",
      "https://github.internal.example/path",
      "https://github.internal.example?x=1",
      "https://user:pass@github.internal.example",
      "https://github.internal.example#fragment",
    ]) {
      rejectCommittedSchema("schemas/aih-org-policy.schema.json", {
        ...base,
        mcp: { githubHost },
      });
    }
  });

  it("validates MCP approval evidence in the org policy editor schema", () => {
    const base = {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
    };
    validateCommittedSchema("schemas/aih-org-policy.schema.json", {
      ...base,
      mcp: {
        allowedServers: ["context7"],
        approvals: [
          {
            server: "context7",
            acceptEgress: true,
            reason: "Approved docs lookup endpoint.",
            reviewer: "security-platform",
            approvedAt: "2026-07-05T00:00:00.000Z",
          },
        ],
      },
    });
    rejectCommittedSchema("schemas/aih-org-policy.schema.json", {
      ...base,
      mcp: {
        allowedServers: ["context7"],
        approvals: [
          {
            server: "context7",
            acceptEgress: false,
            reason: "This must be explicit acceptance.",
            approvedAt: "2026-07-05T00:00:00.000Z",
          },
        ],
      },
    });
    for (const approval of [
      {
        server: "   ",
        acceptEgress: true,
        reason: "Approved docs lookup endpoint.",
        approvedAt: "2026-07-05T00:00:00.000Z",
      },
      {
        server: "context7",
        acceptEgress: true,
        reason: "Approved docs lookup endpoint.\nSecond line.",
        approvedAt: "2026-07-05T00:00:00.000Z",
      },
    ]) {
      rejectCommittedSchema("schemas/aih-org-policy.schema.json", {
        ...base,
        mcp: {
          allowedServers: ["context7"],
          approvals: [approval],
        },
      });
    }
  });

  it("models declarative remote MCP status without requiring a live tool-surface digest", () => {
    const base = {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
    };
    const remotePolicy = (source: Record<string, unknown>) => ({
      ...base,
      governance: {
        policyVersion: "2026.08",
        supportedClis: ["claude"],
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
                contentScanned: false,
                ...source,
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
    });
    const legacy = {
      toolSurfaceDigest: `sha256:${"a".repeat(64)}`,
      verdict: "drifted",
    };

    validateCommittedSchema(
      "schemas/aih-org-policy.schema.json",
      remotePolicy({ administrativeStatus: "approved" }),
    );
    validateCommittedSchema("schemas/aih-org-policy.schema.json", remotePolicy(legacy));
    for (const invalid of [
      {},
      { toolSurfaceDigest: legacy.toolSurfaceDigest },
      { verdict: legacy.verdict },
      { administrativeStatus: "approved", ...legacy },
    ]) {
      rejectCommittedSchema("schemas/aih-org-policy.schema.json", remotePolicy(invalid));
    }
  });

  it("preserves signed approval clarifications and report-only external curation intent", () => {
    const base = {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
    };
    validateCommittedSchema("schemas/aih-org-policy.schema.json", {
      ...base,
      governance: {
        policyVersion: "2026.08",
        supportedClis: ["claude"],
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
        externalCuration: [
          {
            framework: "ecc",
            items: [
              {
                kind: "agent",
                id: "external-review-agent",
                source: {
                  repository: "acme/ecc-catalog",
                  commit: "a".repeat(40),
                  path: "agents/review.md",
                },
                audit: { record: "audit-2026-08", digest: `sha256:${"b".repeat(64)}` },
                clarification: "External guidance only.",
              },
            ],
          },
        ],
      },
    });
  });

  it("validates attributable baseline override evidence in the org policy editor schema", () => {
    validateCommittedSchema("schemas/aih-org-policy.schema.json", {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      trust: {
        baselineOverrides: [
          {
            catalog: "ecc",
            owner: "affaan-m",
            repo: "ECC",
            pinnedSha: "a".repeat(40),
            bundle: ".aih/org-evidence/ecc",
            signingRepository: "acme/engineering-governance",
            reason: "Reviewed newer ECC baseline",
            reviewer: "security@example.com",
            approvedAt: "2026-07-10T12:00:00.000Z",
          },
        ],
      },
    });
  });
});
