import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { vendorBaselineLockBytes } from "../../src/baseline-evidence/vendor.js";
import { projectBaselinePackageGraphAuthority } from "../../src/capability/package-graph/adapters/baseline.js";
import { projectEccCapabilityPackageAuthority } from "../../src/capability/package-graph/adapters/ecc-domains.js";
import { reconcileMixedCapabilityPackages } from "../../src/capability/package-manager/domains/mixed-coordinator.js";
import { CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH } from "../../src/capability/package-manager/receipt.js";
import { serializeEccMaterializationReceipt } from "../../src/ecc/materialization-receipt.js";
import { planExplicitEccMcpAdd } from "../../src/ecc/mcp-explicit-add.js";
import { ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH } from "../../src/ecc/mcp-explicit-add-receipt.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { ECC_MCP_CATALOG_PROVENANCE } from "../../src/org-policy/ecc-mcp-catalog.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const SHA = "a".repeat(40);
const SKILL = Buffer.from("# Clean\n", "utf8");
const SECOND_SKILL = Buffer.from("# Review\n", "utf8");
const AGENT = Buffer.from("# code-reviewer\n", "utf8");
const SECURITY_AGENT = Buffer.from("# security-reviewer\n", "utf8");
let root = "";

afterEach(() => {
  if (root.length > 0) rmSync(root, { recursive: true, force: true });
});

function write(path: string, value: unknown): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seed(options: { secondAgent?: boolean; secondSkill?: boolean; roots?: string[] } = {}): {
  materialReceipt: Buffer;
  trustLock: Buffer;
} {
  root = mkdtempSync(join(tmpdir(), "aih-mixed-package-"));
  const evidencePath = ".aih/skill-reports/owner-repo-aaaaaaaa.json";
  const evidence = {
    schemaVersion: 1,
    source: `owner/repo@${SHA}`,
    pinnedSha: SHA,
    checks: [],
    analyzersRun: ["aih-native"],
    verdict: "GREEN",
    reasons: [],
  };
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
  write(evidencePath, evidence);
  write("ai-coding/skill-cards/clean.json", {
    schemaVersion: 1,
    name: "clean",
    source: `owner/repo@${SHA}`,
    commit: SHA,
    license: "Apache-2.0",
    installScope: "repo",
    riskClass: "green",
    requiresMcp: false,
    requiresShell: false,
    scanEvidence: [evidencePath],
    approval: {
      verdict: "GREEN",
      approvedBy: "security",
      approvedAt: "2026-08-10T00:00:00.000Z",
    },
  });
  if (options.secondSkill) {
    write("ai-coding/skill-cards/review.json", {
      schemaVersion: 1,
      name: "review",
      source: `owner/repo@${SHA}`,
      commit: SHA,
      license: "Apache-2.0",
      installScope: "repo",
      riskClass: "green",
      requiresMcp: false,
      requiresShell: false,
      scanEvidence: [evidencePath],
      approval: {
        verdict: "GREEN",
        approvedBy: "security",
        approvedAt: "2026-08-10T00:00:00.000Z",
      },
    });
  }
  write("aih-org-policy.json", {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    capabilityPackages: {
      catalog: { provider: "github", repository: "host/capabilities" },
      roots: options.roots ?? [
        "package:skill-pack/docs-quality",
        ...(options.secondSkill ? ["package:skill-pack/review-quality"] : []),
        "package:ecc-agent/code-reviewer",
        ...(options.secondAgent ? ["package:ecc-agent/security-reviewer"] : []),
      ],
    },
  });
  write("aih-skills.lock.json", {
    schemaVersion: 1,
    skills: [
      {
        name: "clean",
        source: `owner/repo@${SHA}`,
        commit: SHA,
        verdict: "GREEN",
        scope: "repo",
        card: "ai-coding/skill-cards/clean.json",
        evidenceSha256: createHash("sha256").update(evidenceBytes).digest("hex"),
        approvedBy: "security",
        approvedAt: "2026-08-10T00:00:00.000Z",
      },
      ...(options.secondSkill
        ? [
            {
              name: "review",
              source: `owner/repo@${SHA}`,
              commit: SHA,
              verdict: "GREEN",
              scope: "repo",
              card: "ai-coding/skill-cards/review.json",
              evidenceSha256: createHash("sha256").update(evidenceBytes).digest("hex"),
              approvedBy: "security",
              approvedAt: "2026-08-10T00:00:00.000Z",
            },
          ]
        : []),
    ],
  });
  write("aih-packs.json", {
    schemaVersion: 1,
    packs: [
      {
        name: "docs-quality",
        skills: [{ name: "clean", source: `owner/repo@${SHA}`, commit: SHA }],
      },
      ...(options.secondSkill
        ? [
            {
              name: "review-quality",
              skills: [{ name: "review", source: `owner/repo@${SHA}`, commit: SHA }],
            },
          ]
        : []),
    ],
  });
  const trust = {
    schemaVersion: 1,
    sources: [
      {
        id: "owner-repo",
        kind: "github",
        source: "owner/repo",
        ref: "main",
        pinnedSha: SHA,
        promotedAt: "2026-08-10T00:00:00.000Z",
        promotedSkills: ["clean", ...(options.secondSkill ? ["review"] : [])],
        analyzersRun: ["aih-native"],
        artifactHashes: [
          {
            path: "skills/clean/SKILL.md",
            sha256: createHash("sha256").update(SKILL).digest("hex"),
          },
          ...(options.secondSkill
            ? [
                {
                  path: "skills/review/SKILL.md",
                  sha256: createHash("sha256").update(SECOND_SKILL).digest("hex"),
                },
              ]
            : []),
        ],
        findings: [],
      },
    ],
  };
  write(".aih/trust-lock.json", trust);
  const skillPath = join(root, "ai-coding/skills/owner-repo/clean/SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, SKILL, { mode: 0o640 });
  if (options.secondSkill) {
    const secondSkillPath = join(root, "ai-coding/skills/owner-repo/review/SKILL.md");
    mkdirSync(dirname(secondSkillPath), { recursive: true });
    writeFileSync(secondSkillPath, SECOND_SKILL, { mode: 0o640 });
  }

  const baseline = projectBaselinePackageGraphAuthority({
    authorityId: "lock:baseline-evidence",
    catalog: baselineCatalogById("ecc"),
    lockBytes: vendorBaselineLockBytes(),
  });
  const packages = projectEccCapabilityPackageAuthority({
    authorityId: "lock:ecc-capability-packages",
    baseline,
  });
  const selectedAgents = [
    { name: "code-reviewer", body: AGENT },
    ...(options.secondAgent ? [{ name: "security-reviewer", body: SECURITY_AGENT }] : []),
  ];
  const components = selectedAgents.map(({ name, body }) => {
    const surface = packages.graph.surfaces.find(({ id }) => id === `agent:${name}`);
    const pkg = packages.graph.packages.find(({ id }) => id === `package:ecc-agent/${name}`);
    if (surface === undefined || pkg === undefined) throw new Error("agent claim missing");
    const path = `.claude/agents/${name}.md`;
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, { mode: 0o640 });
    return {
      id: `agent:${name}`,
      authorization: {
        componentId: `agent:${name}`,
        source: pkg.source.repository,
        pinnedSha: pkg.sourceDigest.value,
        treeSha256: surface.sourceDigest.value,
        tier: "vendor" as const,
        issuer: "@aihq/harness release",
        evidenceSha256: baseline.authority.sourceDigest.value,
      },
      provenance: {
        repository: pkg.source.repository,
        commit: pkg.sourceDigest.value,
        componentPath: `agents/${name}.md`,
      },
      files: [
        {
          path,
          operation: "copy-file" as const,
          contentSha256: createHash("sha256").update(body).digest("hex"),
        },
      ],
    };
  });
  const material = Buffer.from(
    serializeEccMaterializationReceipt({
      format: "aih-ecc-materialization-receipt",
      schemaVersion: 1,
      components,
    }),
    "utf8",
  );
  const materialPath = join(root, ".aih/ecc/materialization-v1.json");
  mkdirSync(dirname(materialPath), { recursive: true });
  writeFileSync(materialPath, material, { mode: 0o600 });
  return {
    materialReceipt: material,
    trustLock: Buffer.from(`${JSON.stringify(trust, null, 2)}\n`, "utf8"),
  };
}

function context(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: { force: true },
  };
}

describe("mixed capability package coordinator", () => {
  it("publishes one ownership receipt and both domain custodies in one transaction", () => {
    const original = seed();
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:skill-pack/docs-quality",
        apply: false,
      }),
    ).toMatchObject({ status: "preview", writes: [], removes: [] });
    expect(existsSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH))).toBe(false);

    const result = reconcileMixedCapabilityPackages({
      root,
      contextDir: "ai-coding",
      operation: "add",
      packageId: "package:skill-pack/docs-quality",
      apply: true,
    });

    expect(result.status).toBe("applied");
    const ownership = JSON.parse(
      readFileSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH), "utf8"),
    );
    expect(ownership.packages.map(({ id }: { id: string }) => id)).toEqual([
      "package:ecc-agent/code-reviewer",
      "package:skill-pack/docs-quality",
    ]);
    expect(readdirSync(join(root, ".aih/capability-packages/custody-v1"))).toHaveLength(2);
    expect(readFileSync(join(root, ".aih/trust-lock.json"))).toEqual(original.trustLock);
    expect(readFileSync(join(root, ".aih/ecc/materialization-v1.json"))).toEqual(
      original.materialReceipt,
    );
    expect(readFileSync(join(root, "ai-coding/skills/owner-repo/clean/SKILL.md"))).toEqual(SKILL);
    expect(readFileSync(join(root, ".claude/agents/code-reviewer.md"))).toEqual(AGENT);
    expect(existsSync(join(root, "aih-capability-packages.json"))).toBe(true);
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:skill-pack/docs-quality",
        apply: true,
      }).status,
    ).toBe("unchanged");
  });

  it("rejects malformed coordinator input before repository inspection", () => {
    expect(reconcileMixedCapabilityPackages({})).toEqual({
      schemaVersion: 1,
      status: "refused",
      stage: "input",
      reason: "invalid-input",
    });
  });

  it("refuses subtraction while policy still requests the package", () => {
    seed({ roots: ["package:ecc-agent/code-reviewer"] });
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "remove",
        packageId: "package:ecc-agent/code-reviewer",
        apply: true,
      }),
    ).toMatchObject({ status: "refused", stage: "policy" });
  });

  it("refuses an ECC projection without its receipt authority", () => {
    seed({ roots: ["package:ecc-agent/code-reviewer"] });
    rmSync(join(root, ".aih/ecc/materialization-v1.json"));
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:ecc-agent/code-reviewer",
        apply: true,
      }),
    ).toMatchObject({
      status: "refused",
      stage: "authority",
      reason: "missing-receipt-claim",
    });
  });

  it("refuses drifted ECC materialized content", () => {
    seed({ roots: ["package:ecc-agent/code-reviewer"] });
    writeFileSync(join(root, ".claude/agents/code-reviewer.md"), "# changed\n", "utf8");
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:ecc-agent/code-reviewer",
        apply: true,
      }),
    ).toMatchObject({
      status: "refused",
      stage: "domain",
      reason: "materialized-content-drifted",
    });
  });

  it("reconciles a sole ECC package through add and final removal", () => {
    seed({ roots: ["package:ecc-agent/code-reviewer"] });
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:ecc-agent/code-reviewer",
        apply: true,
      }),
    ).toMatchObject({ status: "applied" });
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = [];
    write("aih-org-policy.json", policy);

    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "remove",
        packageId: "package:ecc-agent/code-reviewer",
        apply: true,
      }),
    ).toMatchObject({ status: "applied" });
    expect(existsSync(join(root, ".claude/agents/code-reviewer.md"))).toBe(false);
    expect(existsSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH))).toBe(false);
  });

  it("reconciles a sole rules package through add and final removal", () => {
    seed({ roots: ["package:ecc-rule/rules"] });
    const baseline = projectBaselinePackageGraphAuthority({
      authorityId: "lock:baseline-evidence",
      catalog: baselineCatalogById("ecc"),
      lockBytes: vendorBaselineLockBytes(),
    });
    const packages = projectEccCapabilityPackageAuthority({
      authorityId: "lock:ecc-capability-packages",
      baseline,
    });
    const surface = packages.graph.surfaces.find(({ id }) => id === "rule:ecc/rules");
    const pkg = packages.graph.packages.find(({ id }) => id === "package:ecc-rule/rules");
    if (surface === undefined || pkg === undefined) throw new Error("rules claim missing");
    const rulePath = ".claude/rules/ecc-rules.md";
    const ruleBody = Buffer.from("# ECC rules\n", "utf8");
    mkdirSync(dirname(join(root, rulePath)), { recursive: true });
    writeFileSync(join(root, rulePath), ruleBody, { mode: 0o640 });
    writeFileSync(
      join(root, ".aih/ecc/materialization-v1.json"),
      serializeEccMaterializationReceipt({
        format: "aih-ecc-materialization-receipt",
        schemaVersion: 1,
        components: [
          {
            id: "baseline:rules",
            authorization: {
              componentId: "baseline:rules",
              source: pkg.source.repository,
              pinnedSha: pkg.sourceDigest.value,
              treeSha256: surface.sourceDigest.value,
              tier: "vendor",
              issuer: "@aihq/harness release",
              evidenceSha256: baseline.authority.sourceDigest.value,
            },
            provenance: {
              repository: pkg.source.repository,
              commit: pkg.sourceDigest.value,
              componentPath: "rules",
            },
            files: [
              {
                path: rulePath,
                operation: "copy-file",
                contentSha256: createHash("sha256").update(ruleBody).digest("hex"),
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    );

    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:ecc-rule/rules",
        apply: true,
      }).status,
    ).toBe("applied");
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = [];
    write("aih-org-policy.json", policy);
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "remove",
        packageId: "package:ecc-rule/rules",
        apply: true,
      }).status,
    ).toBe("applied");
    expect(existsSync(join(root, rulePath))).toBe(false);
  });

  it("reconciles a sole MCP package through add and final removal", async () => {
    seed({ roots: [] });
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = ["package:ecc-mcp/memxus"];
    policy.governance = {
      policyVersion: "2026.08",
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
      supportedClis: ["claude"],
      eccMcpApprovals: [
        {
          id: "memxus",
          sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
          state: "approved",
          approvedBy: "security-admin",
          authenticationMode: "api-key",
          allowedDataClasses: ["non-sensitive-context"],
        },
      ],
    };
    write("aih-org-policy.json", policy);
    await executePlan(
      planExplicitEccMcpAdd({ root, policy, id: "memxus", target: "claude" }),
      context(),
    );
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:ecc-mcp/memxus",
        apply: true,
      }).status,
    ).toBe("applied");
    policy.capabilityPackages.roots = [];
    write("aih-org-policy.json", policy);
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "remove",
        packageId: "package:ecc-mcp/memxus",
        apply: true,
      }).status,
    ).toBe("applied");
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.memxus).toBe(
      undefined,
    );
    expect(existsSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH))).toBe(false);
  });

  it("requires current ownership before mixed-domain subtraction", () => {
    seed();
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = ["package:skill-pack/docs-quality"];
    write("aih-org-policy.json", policy);

    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "remove",
        packageId: "package:ecc-agent/code-reviewer",
        apply: true,
      }),
    ).toMatchObject({ status: "refused", stage: "ownership", reason: "lifecycle-refused" });
    expect(readFileSync(join(root, ".claude/agents/code-reviewer.md"))).toEqual(AGENT);
  });

  it("subtracts one ECC package while retaining the skill package and its exact bytes", () => {
    seed();
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:skill-pack/docs-quality",
        apply: true,
      }).status,
    ).toBe("applied");
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = ["package:skill-pack/docs-quality"];
    write("aih-org-policy.json", policy);

    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "remove",
        packageId: "package:ecc-agent/code-reviewer",
        apply: true,
      }).status,
    ).toBe("applied");
    const ownership = JSON.parse(
      readFileSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH), "utf8"),
    );
    expect(ownership.packages.map(({ id }: { id: string }) => id)).toEqual([
      "package:skill-pack/docs-quality",
    ]);
    expect(existsSync(join(root, ".claude/agents/code-reviewer.md"))).toBe(false);
    expect(readFileSync(join(root, "ai-coding/skills/owner-repo/clean/SKILL.md"))).toEqual(SKILL);
    expect(existsSync(join(root, ".aih/ecc/materialization-v1.json"))).toBe(false);
  });

  it("issues successor ECC custody when removing one agent while retaining another", () => {
    seed({ secondAgent: true });
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:ecc-agent/code-reviewer",
        apply: true,
      }).status,
    ).toBe("applied");
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = [
      "package:skill-pack/docs-quality",
      "package:ecc-agent/security-reviewer",
    ];
    write("aih-org-policy.json", policy);

    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "remove",
        packageId: "package:ecc-agent/code-reviewer",
        apply: true,
      }).status,
    ).toBe("applied");
    const ownership = JSON.parse(
      readFileSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH), "utf8"),
    );
    expect(ownership.packages.map(({ id }: { id: string }) => id)).toEqual([
      "package:ecc-agent/security-reviewer",
      "package:skill-pack/docs-quality",
    ]);
    const material = JSON.parse(
      readFileSync(join(root, ".aih/ecc/materialization-v1.json"), "utf8"),
    );
    expect(material.components.map(({ id }: { id: string }) => id)).toEqual([
      "agent:security-reviewer",
    ]);
    expect(existsSync(join(root, ".claude/agents/code-reviewer.md"))).toBe(false);
    expect(readFileSync(join(root, ".claude/agents/security-reviewer.md"))).toEqual(SECURITY_AGENT);
    expect(readdirSync(join(root, ".aih/capability-packages/custody-v1"))).toHaveLength(4);
  });

  it("refuses an ECC custody receipt with an extra member file", () => {
    seed();
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:ecc-agent/code-reviewer",
        apply: true,
      }).status,
    ).toBe("applied");
    const custodyDirectory = join(root, ".aih/capability-packages/custody-v1");
    const name = readdirSync(custodyDirectory).find((entry) => {
      const parsed = JSON.parse(readFileSync(join(custodyDirectory, entry), "utf8"));
      return parsed.domainReceipt?.kind === "ecc-materialization";
    });
    if (name === undefined) throw new Error("ECC custody missing");
    const custody = JSON.parse(readFileSync(join(custodyDirectory, name), "utf8"));
    custody.files.push({
      memberId: "agent:code-reviewer",
      path: "unowned.md",
      sha256: "0".repeat(64),
      mode: 0o640,
    });
    writeFileSync(join(custodyDirectory, name), `${JSON.stringify(custody, null, 2)}\n`, {
      mode: 0o600,
    });
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = ["package:skill-pack/docs-quality"];
    write("aih-org-policy.json", policy);

    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "remove",
        packageId: "package:ecc-agent/code-reviewer",
        apply: true,
      }),
    ).toMatchObject({ status: "refused", stage: "custody" });
    expect(readFileSync(join(root, ".claude/agents/code-reviewer.md"))).toEqual(AGENT);
  });

  it("subtracts one skill package while retaining the ECC package and its exact bytes", () => {
    seed();
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:skill-pack/docs-quality",
        apply: true,
      }).status,
    ).toBe("applied");
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = ["package:ecc-agent/code-reviewer"];
    write("aih-org-policy.json", policy);

    const removed = reconcileMixedCapabilityPackages({
      root,
      contextDir: "ai-coding",
      operation: "remove",
      packageId: "package:skill-pack/docs-quality",
      apply: true,
    });
    expect(removed).toMatchObject({ status: "applied" });
    const ownership = JSON.parse(
      readFileSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH), "utf8"),
    );
    expect(ownership.packages.map(({ id }: { id: string }) => id)).toEqual([
      "package:ecc-agent/code-reviewer",
    ]);
    expect(existsSync(join(root, "ai-coding/skills/owner-repo/clean/SKILL.md"))).toBe(false);
    expect(readFileSync(join(root, ".claude/agents/code-reviewer.md"))).toEqual(AGENT);
    expect(existsSync(join(root, ".aih/ecc/materialization-v1.json"))).toBe(true);
  });

  it("refuses a skill custody receipt with an extra deletion path", () => {
    seed();
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:skill-pack/docs-quality",
        apply: true,
      }).status,
    ).toBe("applied");
    const victim = Buffer.from("operator content\n", "utf8");
    writeFileSync(join(root, "victim.txt"), victim, { mode: 0o640 });
    const custodyDirectory = join(root, ".aih/capability-packages/custody-v1");
    const skillCustodyName = readdirSync(custodyDirectory).find((name) => {
      const parsed = JSON.parse(readFileSync(join(custodyDirectory, name), "utf8"));
      return parsed.domainReceipt?.kind === "skill-promotion-trust-lock";
    });
    if (skillCustodyName === undefined) throw new Error("skill custody missing");
    const custody = JSON.parse(readFileSync(join(custodyDirectory, skillCustodyName), "utf8"));
    custody.files.push({
      memberId: "skill:clean",
      path: "victim.txt",
      sha256: createHash("sha256").update(victim).digest("hex"),
      mode: 0o640,
    });
    writeFileSync(
      join(custodyDirectory, skillCustodyName),
      `${JSON.stringify(custody, null, 2)}\n`,
      { mode: 0o600 },
    );
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = ["package:ecc-agent/code-reviewer"];
    write("aih-org-policy.json", policy);

    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "remove",
        packageId: "package:skill-pack/docs-quality",
        apply: true,
      }),
    ).toMatchObject({ status: "refused", stage: "custody" });
    expect(readFileSync(join(root, "victim.txt"))).toEqual(victim);
    expect(readFileSync(join(root, "ai-coding/skills/owner-repo/clean/SKILL.md"))).toEqual(SKILL);
  });

  it("issues successor skill custody when removing one skill pack while retaining another", () => {
    seed({ secondSkill: true });
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:skill-pack/docs-quality",
        apply: true,
      }).status,
    ).toBe("applied");
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = [
      "package:skill-pack/review-quality",
      "package:ecc-agent/code-reviewer",
    ];
    write("aih-org-policy.json", policy);

    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "remove",
        packageId: "package:skill-pack/docs-quality",
        apply: true,
      }).status,
    ).toBe("applied");
    expect(existsSync(join(root, "ai-coding/skills/owner-repo/clean/SKILL.md"))).toBe(false);
    expect(readFileSync(join(root, "ai-coding/skills/owner-repo/review/SKILL.md"))).toEqual(
      SECOND_SKILL,
    );
    const trust = JSON.parse(readFileSync(join(root, ".aih/trust-lock.json"), "utf8"));
    expect(trust.sources[0]?.promotedSkills).toEqual(["review"]);
    const ownership = JSON.parse(
      readFileSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH), "utf8"),
    );
    expect(ownership.packages.map(({ id }: { id: string }) => id)).toEqual([
      "package:ecc-agent/code-reviewer",
      "package:skill-pack/review-quality",
    ]);
  });

  it("subtracts one MCP package while retaining skill and ECC packages", async () => {
    seed();
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots.push("package:ecc-mcp/memxus");
    policy.governance = {
      policyVersion: "2026.08",
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
      supportedClis: ["claude"],
      eccMcpApprovals: [
        {
          id: "memxus",
          sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
          state: "approved",
          approvedBy: "security-admin",
          authenticationMode: "api-key",
          allowedDataClasses: ["non-sensitive-context"],
        },
      ],
    };
    write("aih-org-policy.json", policy);
    await executePlan(
      planExplicitEccMcpAdd({ root, policy, id: "memxus", target: "claude" }),
      context(),
    );
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:ecc-mcp/memxus",
        apply: true,
      }).status,
    ).toBe("applied");

    policy.capabilityPackages.roots = policy.capabilityPackages.roots.filter(
      (id: string) => id !== "package:ecc-mcp/memxus",
    );
    write("aih-org-policy.json", policy);
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "remove",
        packageId: "package:ecc-mcp/memxus",
        apply: true,
      }).status,
    ).toBe("applied");
    const config = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(config.mcpServers?.memxus).toBeUndefined();
    const ownership = JSON.parse(
      readFileSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH), "utf8"),
    );
    expect(ownership.packages.map(({ id }: { id: string }) => id)).toEqual([
      "package:ecc-agent/code-reviewer",
      "package:skill-pack/docs-quality",
    ]);
  });

  it("issues successor MCP custody when removing one MCP while retaining another", async () => {
    seed();
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots.push("package:ecc-mcp/memxus", "package:ecc-mcp/vercel");
    policy.governance = {
      policyVersion: "2026.08",
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
      supportedClis: ["claude"],
      eccMcpApprovals: ["memxus", "vercel"].map((id) => ({
        id,
        sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
        state: "approved",
        approvedBy: "security-admin",
        authenticationMode: id === "memxus" ? "api-key" : "oauth",
        allowedDataClasses: ["non-sensitive-context"],
      })),
    };
    write("aih-org-policy.json", policy);
    await executePlan(
      planExplicitEccMcpAdd({ root, policy, id: "memxus", target: "claude" }),
      context(),
    );
    await executePlan(
      planExplicitEccMcpAdd({ root, policy, id: "vercel", target: "claude" }),
      context(),
    );
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:ecc-mcp/memxus",
        apply: true,
      }).status,
    ).toBe("applied");

    policy.capabilityPackages.roots = policy.capabilityPackages.roots.filter(
      (id: string) => id !== "package:ecc-mcp/memxus",
    );
    write("aih-org-policy.json", policy);
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "remove",
        packageId: "package:ecc-mcp/memxus",
        apply: true,
      }).status,
    ).toBe("applied");
    const config = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(config.mcpServers?.memxus).toBeUndefined();
    expect(config.mcpServers?.vercel).toBeDefined();
    const explicitReceipt = JSON.parse(
      readFileSync(join(root, ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH), "utf8"),
    );
    expect(explicitReceipt.records.map(({ id }: { id: string }) => id)).toEqual(["vercel"]);
    const ownership = JSON.parse(
      readFileSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH), "utf8"),
    );
    expect(ownership.packages.map(({ id }: { id: string }) => id)).toEqual([
      "package:ecc-agent/code-reviewer",
      "package:ecc-mcp/vercel",
      "package:skill-pack/docs-quality",
    ]);
  });

  it("refuses an MCP custody receipt with an extra member file", async () => {
    seed();
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots.push("package:ecc-mcp/memxus");
    policy.governance = {
      policyVersion: "2026.08",
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
      supportedClis: ["claude"],
      eccMcpApprovals: [
        {
          id: "memxus",
          sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
          state: "approved",
          approvedBy: "security-admin",
          authenticationMode: "api-key",
          allowedDataClasses: ["non-sensitive-context"],
        },
      ],
    };
    write("aih-org-policy.json", policy);
    await executePlan(
      planExplicitEccMcpAdd({ root, policy, id: "memxus", target: "claude" }),
      context(),
    );
    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "add",
        packageId: "package:ecc-mcp/memxus",
        apply: true,
      }).status,
    ).toBe("applied");
    const custodyDirectory = join(root, ".aih/capability-packages/custody-v1");
    const name = readdirSync(custodyDirectory).find((entry) => {
      const parsed = JSON.parse(readFileSync(join(custodyDirectory, entry), "utf8"));
      return parsed.domainReceipt?.kind === "ecc-mcp-explicit-add";
    });
    if (name === undefined) throw new Error("MCP custody missing");
    const custody = JSON.parse(readFileSync(join(custodyDirectory, name), "utf8"));
    custody.files.push({
      memberId: "mcp:memxus",
      path: "unowned.json",
      sha256: "0".repeat(64),
      mode: 0o600,
    });
    writeFileSync(join(custodyDirectory, name), `${JSON.stringify(custody, null, 2)}\n`, {
      mode: 0o600,
    });
    policy.capabilityPackages.roots = policy.capabilityPackages.roots.filter(
      (id: string) => id !== "package:ecc-mcp/memxus",
    );
    write("aih-org-policy.json", policy);

    expect(
      reconcileMixedCapabilityPackages({
        root,
        contextDir: "ai-coding",
        operation: "remove",
        packageId: "package:ecc-mcp/memxus",
        apply: true,
      }),
    ).toMatchObject({ status: "refused", stage: "custody" });
    const config = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(config.mcpServers?.memxus).toBeDefined();
  });
});
