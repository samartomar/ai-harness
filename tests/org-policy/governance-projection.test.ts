import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  kiroMcpProjectionOwnership,
  managedMcpProjectionOwnership,
} from "../../src/config/marker.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext, WriteAction } from "../../src/internals/plan.js";
import { plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { command as mcpCommand } from "../../src/mcp/index.js";
import { managedMcpProjectionState } from "../../src/mcp/managed-projection.js";
import { mcpApprovalSubject } from "../../src/mcp/policy.js";
import { mcpServers } from "../../src/mcp/servers.js";
import {
  PolicyAuthorityReceiptSchema,
  verifyPolicyAuthorityReceipt,
} from "../../src/org-policy/authority.js";
import { aihPolicyControls } from "../../src/org-policy/catalog.js";
import {
  approvalAttestationDigest,
  candidateIdentityDigest,
  FENCED_POLICY_PREREQUISITE_CODES,
  resolveEffectiveOrgPolicy,
  reviewedControlDigest,
} from "../../src/org-policy/effective.js";
import {
  orgPolicyEffectiveCheck,
  orgPolicyEffectiveDigest,
} from "../../src/org-policy/evaluate.js";
import {
  authoritySuffix,
  orgPolicyHookReceiptState,
  orgPolicyKiroMcpReceiptState,
  orgPolicyMcpReceiptState,
  orgPolicyProjectionActions,
  verifiedOrgPolicyProjectionActions,
} from "../../src/org-policy/project.js";
import { resolveRuntimeOrgPolicy } from "../../src/org-policy/runtime.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { scanRepo } from "../../src/profile/scan.js";
import { usageRecorderScript } from "../../src/usage/capture.js";
import { usageHookActions } from "../../src/usage/hooks.js";
import { command as usageCommand } from "../../src/usage/index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
let dir: string;
let authorityBin: string;
let trustedGh: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-governance-projection-"));
  authorityBin = mkdtempSync(join(tmpdir(), "aih-authority-gh-"));
  const trustedGhFile = join(authorityBin, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(trustedGhFile, "trusted gh fixture\n", { mode: 0o755 });
  trustedGh = realpathSync.native(trustedGhFile);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(authorityBin, { recursive: true, force: true });
});

function ctx(overrides: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner((argv) =>
    argv[0] === trustedGh && argv[1] === "attestation" && argv[2] === "verify"
      ? { code: 0, stdout: "verified" }
      : { code: 1, stderr: "unexpected authority verifier executable" },
  );
  const { env: envOverrides, ...otherOverrides } = overrides;
  return {
    root: dir,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {
      AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance",
      PATH: authorityBin,
      ...envOverrides,
    },
    options: {},
    ...otherOverrides,
  };
}

function customSource() {
  return {
    type: "stdio" as const,
    resolver: "npx" as const,
    registry: "https://registry.npmjs.org",
    package: "custom-mcp",
    version: "1.2.3",
    integrity: DIGEST,
  };
}

function customPolicy(targets: string[] = ["claude"], approvals: unknown[] = []) {
  const source = customSource();
  return parseOrgPolicy({
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    mcp: { allowManagedOnly: true },
    governance: {
      policyVersion: "2026.08.0",
      supportedClis: ["claude"],
      catalog: {
        reviewed: [],
        custom: [
          {
            id: "custom-mcp",
            kind: "mcp",
            description: "Organization custom MCP",
            capabilities: ["internal search"],
            risks: ["local process"],
            source,
            targets: ["claude"],
            projector: "mcp-managed-settings",
            lifecycle: "supported",
            evidence: { record: "custom-evidence" },
            clarification: "Runs only against the approved internal package registry.",
            annotation: "Security exception ownership: platform-security.",
          },
        ],
      },
      activations: [{ candidate: "custom-mcp", state: "active", targets }],
      authority: { approvals },
    },
  });
}

function writeAuthorityReceipt({
  issuerRepository = "acme/governance",
  targets = ["claude"],
  evidence = {},
  approvals = [],
  trustedIssuers = [],
  revocations = [],
}: {
  issuerRepository?: string;
  targets?: string[];
  evidence?: Record<string, unknown>;
  approvals?: unknown[];
  trustedIssuers?: unknown[];
  revocations?: unknown[];
} = {}) {
  const source = customSource();
  const sourceDigest = candidateIdentityDigest({ source } as never);
  const now = Date.now();
  mkdirSync(join(dir, ".aih"), { recursive: true });
  writeFileSync(
    join(dir, ".aih", "policy-authority-receipt.json"),
    JSON.stringify({
      format: "aih-policy-authority-receipt",
      version: 1,
      issuerRepository,
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 86_400_000).toISOString(),
      targets,
      trustedIssuers,
      evidence: [
        {
          id: "custom-evidence",
          candidate: "custom-mcp",
          kind: "mcp",
          source,
          sourceDigest,
          identityDigest: sourceDigest,
          evidenceDigest: DIGEST,
          state: "verified",
          waivable: false,
          detectors: [{ id: "semgrep", required: true, status: "pass", reportDigest: DIGEST }],
          findings: [],
          ...evidence,
        },
      ],
      approvals,
      revocations,
    }),
  );
}

function writeDecisionAuthorityReceipt(
  decisions: readonly Record<string, unknown>[],
  decisionRevocations: readonly Record<string, unknown>[] = [],
  targets: readonly string[] = ["claude"],
) {
  const now = Date.now();
  mkdirSync(join(dir, ".aih"), { recursive: true });
  writeFileSync(
    join(dir, ".aih", "policy-authority-receipt.json"),
    JSON.stringify({
      format: "aih-policy-authority-receipt",
      version: 2,
      issuerRepository: "acme/governance",
      issuedAt: new Date(now - 30_000).toISOString(),
      expiresAt: new Date(now + 86_400_000).toISOString(),
      targets,
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
      evidence: [],
      approvals: [],
      revocations: [],
      decisions,
      decisionRevocations,
    }),
  );
}

function currentReviewedDecision(
  policy: ReturnType<typeof parseOrgPolicy>,
  overrides: Record<string, unknown> = {},
  candidateId?: string,
) {
  const candidate = policy.governance?.catalog.reviewed.find(
    (item) => candidateId === undefined || item.id === candidateId,
  );
  if (candidate?.source.type !== "mcp" || policy.governance === undefined) {
    throw new Error("expected reviewed MCP fixture");
  }
  const control = aihPolicyControls(
    mcpServers("project", scanRepo(dir, { maxDepth: 8, contextDir: "ai-coding" })),
  ).find((item) => item.id === candidate.id);
  if (control === undefined) throw new Error("expected AIH-owned reviewed control");
  const now = Date.now();
  return {
    format: "aih-governance-decision",
    version: 1,
    id: "decision-reviewed-risk",
    disposition: "accepted-with-conditions",
    candidate: candidate.id,
    kind: candidate.kind,
    targets: ["claude"],
    effects: ["managed-settings"],
    policyVersion: policy.governance.policyVersion,
    sourceDigest: candidateIdentityDigest(candidate),
    evidenceDigest: candidateIdentityDigest(candidate),
    reviewedControlDigest: reviewedControlDigest(control),
    issuer: "platform-security",
    actor: "security-admin",
    reason: "The bounded finding remains accepted pending review.",
    issuedAt: new Date(now - 60_000).toISOString(),
    notBefore: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    acceptedFindings: ["prompt-injection"],
    acceptedGaps: [],
    conditions: ["Review the finding before the decision expires."],
    reviewBy: new Date(now + 43_200_000).toISOString(),
    ...overrides,
  };
}

function governanceDecision(overrides: Record<string, unknown> = {}) {
  return {
    format: "aih-governance-decision",
    version: 1,
    id: "decision-2026-q3",
    disposition: "approved",
    candidate: "custom-mcp",
    kind: "mcp",
    targets: ["claude"],
    effects: ["managed-settings"],
    policyVersion: "2026.08.0",
    sourceDigest: DIGEST,
    evidenceDigest: DIGEST,
    reviewedControlDigest: DIGEST,
    issuer: "platform-security",
    actor: "security-admin",
    reason: "The reviewed control is clean.",
    issuedAt: "2026-08-01T00:00:00+00:00",
    notBefore: "2026-08-01T00:00:00+00:00",
    expiresAt: "2026-08-10T00:00:00+00:00",
    acceptedFindings: [],
    acceptedGaps: [],
    conditions: [],
    ...overrides,
  };
}

function authorityReceiptV2(overrides: Record<string, unknown> = {}) {
  return {
    format: "aih-policy-authority-receipt",
    version: 2,
    issuerRepository: "acme/governance",
    issuedAt: "2026-08-03T00:00:00+00:00",
    expiresAt: "2026-08-20T00:00:00+00:00",
    targets: ["claude"],
    trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
    evidence: [],
    approvals: [],
    revocations: [],
    decisions: [],
    decisionRevocations: [],
    ...overrides,
  };
}

function waivableApproval(overrides: Record<string, unknown> = {}) {
  const source = customSource();
  const now = Date.now();
  const unsigned = {
    id: "custom-waiver",
    candidate: "custom-mcp",
    kind: "mcp",
    source,
    issuer: "platform-security",
    sourceDigest: candidateIdentityDigest({ source } as never),
    evidenceDigest: DIGEST,
    projector: "mcp-managed-settings",
    policyVersion: "2026.08.0",
    reason: "The external authority approved this waivable evidence gap.",
    clarification: "The signed exception explains the required follow-up.",
    scope: ["claude"],
    notBefore: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    github: {
      repository: "acme/governance",
      attestationId: "receipt-transport-locator",
      subjectDigest: DIGEST,
    },
    ...overrides,
  };
  return {
    ...unsigned,
    github: {
      ...unsigned.github,
      subjectDigest: approvalAttestationDigest(unsigned as never),
    },
  };
}

async function verifiedAuthority(context: PlanContext) {
  const verification = await verifyPolicyAuthorityReceipt(context);
  if (verification.authority === undefined) {
    throw new Error(`expected verified authority: ${verification.problem ?? "unknown problem"}`);
  }
  return verification.authority;
}

function usageHookPolicy(state: "active" | "disabled", targets: string[] = ["claude"]) {
  const scriptDigest = `sha256:${createHash("sha256").update(usageRecorderScript(), "utf8").digest("hex")}`;
  const source = { type: "hook" as const, handler: "usage-metering" as const, scriptDigest };
  return parseOrgPolicy({
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "2026.08.0",
      supportedClis: ["claude"],
      catalog: {
        reviewed: [
          {
            id: "usage-metering",
            kind: "hook",
            description: "AIH owned hook",
            capabilities: [],
            risks: [],
            source,
            targets: ["claude", "codex"],
            projector: "usage-hook",
            lifecycle: "supported",
            evidence: { record: "ignored-self-assertion" },
          },
        ],
        custom: [],
      },
      activations: [{ candidate: "usage-metering", state, targets }],
      authority: { approvals: [] },
    },
  });
}

function reviewedMcpPolicy({
  allowManagedOnly = true,
  allowedServers = ["unrelated-legacy-server"],
  disabledServers = ["code-review-graph"],
  serverId = "code-review-graph",
  targets = ["claude"],
}: {
  allowManagedOnly?: boolean;
  allowedServers?: string[];
  disabledServers?: string[];
  serverId?: "code-review-graph" | "sequential-thinking";
  targets?: ("claude" | "kiro")[];
} = {}) {
  const server = mcpServers("project", scanRepo(dir, { maxDepth: 8, contextDir: "ai-coding" }))[
    serverId
  ];
  if (server === undefined) throw new Error(`expected ${serverId} catalog entry`);
  const source = {
    type: "mcp" as const,
    server: serverId,
    subject: mcpApprovalSubject(server),
  };
  return parseOrgPolicy({
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    mcp: { allowManagedOnly, allowedServers, disabledServers },
    governance: {
      policyVersion: "2026.08.0",
      supportedClis: targets,
      catalog: {
        reviewed: [
          {
            id: serverId,
            kind: "mcp",
            description: "AIH shipped catalog MCP",
            capabilities: [],
            risks: [],
            source,
            targets,
            projector: "mcp-managed-settings",
            lifecycle: "supported",
            evidence: { record: "ignored-self-assertion" },
          },
        ],
        custom: [],
      },
      activations: [{ candidate: serverId, state: "active", targets }],
      authority: { approvals: [] },
    },
  });
}

describe("governed candidate projection", () => {
  it("keeps accepted findings visible while an exact current reviewed decision unlocks", async () => {
    const policy = reviewedMcpPolicy();
    const candidate = policy.governance?.catalog.reviewed[0];
    if (candidate?.source.type !== "mcp" || policy.governance === undefined) {
      throw new Error("expected reviewed MCP fixture");
    }
    candidate.findings.push("prompt-injection");
    policy.governance.authority.decisions = ["decision-reviewed-risk"];
    writeDecisionAuthorityReceipt([currentReviewedDecision(policy)]);

    const runtime = await resolveRuntimeOrgPolicy(ctx(), policy);
    expect(runtime.effective.candidates[0]).toMatchObject({
      requested: true,
      effective: true,
      dangerCodes: ["prompt-injection"],
      decision: {
        id: "decision-reviewed-risk",
        disposition: "accepted-with-conditions",
        riskState: "accepted",
        acceptedFindings: ["prompt-injection"],
      },
      decisionBlockers: [],
    });
    expect(runtime.effective.blocking).toBe(false);
    await expect(verifiedOrgPolicyProjectionActions(ctx(), policy)).resolves.toEqual(
      expect.any(Array),
    );
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(policy));
    const digest = await orgPolicyEffectiveDigest(ctx());
    expect(digest?.data).toMatchObject({
      blocking: false,
      candidates: [
        expect.objectContaining({
          dangerCodes: ["prompt-injection"],
          decision: expect.objectContaining({ riskState: "accepted" }),
        }),
      ],
    });
    expect(digest?.text).not.toContain("The bounded finding remains accepted pending review.");
  });

  it("writes strict v2 Claude ownership with only the current effective decision binding", async () => {
    const policy = reviewedMcpPolicy();
    if (policy.governance === undefined) throw new Error("expected governance fixture");
    const candidate = policy.governance.catalog.reviewed[0];
    if (candidate === undefined) throw new Error("expected reviewed MCP fixture");
    candidate.findings.push("prompt-injection");
    policy.governance.authority.decisions = ["decision-reviewed-risk"];
    const decision = currentReviewedDecision(policy);
    writeDecisionAuthorityReceipt([decision]);

    const actions = await verifiedOrgPolicyProjectionActions(ctx(), policy);
    const marker = actions.find(
      (action): action is WriteAction =>
        action.kind === "write" && action.path === ".aih-config.json",
    );
    expect(marker?.json).toMatchObject({
      managedMcpProjection: {
        schemaVersion: 2,
        decisions: [
          {
            candidate: "code-review-graph",
            id: "decision-reviewed-risk",
            issuer: "platform-security",
            digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            expiresAt: decision.reviewBy,
          },
        ],
      },
    });
    const managed = actions.find(
      (action): action is WriteAction =>
        action.kind === "write" && action.path === ".claude/managed-settings.json",
    );
    expect(JSON.stringify(managed?.json)).not.toContain(
      "Review the finding before the decision expires.",
    );
  });

  it("unlocks a clean reviewed control only with an exact approved decision", async () => {
    const policy = reviewedMcpPolicy();
    if (policy.governance === undefined) throw new Error("expected governance fixture");
    policy.governance.authority.decisions = ["decision-clean"];
    const approved = currentReviewedDecision(policy, {
      id: "decision-clean",
      disposition: "approved",
      acceptedFindings: [],
      acceptedGaps: [],
      conditions: [],
      reviewBy: undefined,
    });
    delete (approved as Record<string, unknown>).reviewBy;
    writeDecisionAuthorityReceipt([approved]);
    expect((await resolveRuntimeOrgPolicy(ctx(), policy)).effective.candidates[0]).toMatchObject({
      effective: true,
      dangerCodes: [],
      decision: {
        id: "decision-clean",
        disposition: "approved",
        riskState: "clean",
      },
    });
  });

  it("never lets accepted coverage waive a fenced prerequisite", async () => {
    for (const code of FENCED_POLICY_PREREQUISITE_CODES) {
      const policy = reviewedMcpPolicy();
      const candidate = policy.governance?.catalog.reviewed[0];
      if (candidate === undefined || policy.governance === undefined) {
        throw new Error("expected reviewed MCP fixture");
      }
      candidate.findings.push(code);
      policy.governance.authority.decisions = ["decision-fenced"];
      writeDecisionAuthorityReceipt([
        currentReviewedDecision(policy, {
          id: "decision-fenced",
          acceptedFindings: [code],
        }),
      ]);
      const resolved = (await resolveRuntimeOrgPolicy(ctx(), policy)).effective.candidates[0];
      expect(resolved).toMatchObject({
        effective: false,
        dangerCodes: expect.arrayContaining([code]),
      });
    }
  });

  it("fails closed for decision coverage, binding, time, revocation, and signed rejection", async () => {
    const cases = [
      {
        name: "under coverage",
        decision: { acceptedFindings: ["malicious-code"] },
        code: "decision-coverage-mismatch",
      },
      {
        name: "nonempty named gap",
        decision: { acceptedGaps: ["optional-detector"] },
        code: "decision-coverage-mismatch",
      },
      {
        name: "candidate kind drift",
        decision: { kind: "hook" },
        code: "decision-subject-mismatch",
      },
      {
        name: "source digest drift",
        decision: { sourceDigest: `sha256:${"c".repeat(64)}` },
        code: "decision-subject-mismatch",
      },
      {
        name: "evidence digest drift",
        decision: { evidenceDigest: `sha256:${"c".repeat(64)}` },
        code: "decision-subject-mismatch",
      },
      {
        name: "reviewed control drift",
        decision: { reviewedControlDigest: `sha256:${"c".repeat(64)}` },
        code: "decision-control-mismatch",
      },
      {
        name: "policy version drift",
        decision: { policyVersion: "2026.08.1" },
        code: "decision-subject-mismatch",
      },
      {
        name: "registered effect drift",
        decision: { effects: ["usage-hook"] },
        code: "decision-scope-mismatch",
      },
      {
        name: "review deadline",
        decision: { reviewBy: new Date(Date.now() - 30_000).toISOString() },
        code: "decision-review-overdue",
      },
      {
        name: "expiry",
        decision: {
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          reviewBy: new Date(Date.now() - 2_000).toISOString(),
        },
        code: "decision-expired",
      },
    ] as const;
    for (const item of cases) {
      const policy = reviewedMcpPolicy();
      const candidate = policy.governance?.catalog.reviewed[0];
      if (candidate === undefined || policy.governance === undefined) {
        throw new Error("expected reviewed MCP fixture");
      }
      candidate.findings.push("prompt-injection");
      policy.governance.authority.decisions = ["decision-reviewed-risk"];
      writeDecisionAuthorityReceipt([currentReviewedDecision(policy, item.decision)]);
      const runtime = await resolveRuntimeOrgPolicy(ctx(), policy);
      expect(runtime.effective.candidates[0]).toMatchObject({
        effective: false,
        decisionBlockers: [expect.objectContaining({ code: item.code })],
      });
    }

    const targetPolicy = reviewedMcpPolicy();
    const targetCandidate = targetPolicy.governance?.catalog.reviewed[0];
    if (targetCandidate === undefined || targetPolicy.governance === undefined) {
      throw new Error("expected reviewed MCP fixture");
    }
    targetCandidate.findings.push("prompt-injection");
    targetPolicy.governance.authority.decisions = ["decision-reviewed-risk"];
    writeDecisionAuthorityReceipt(
      [currentReviewedDecision(targetPolicy, { targets: ["kiro"] })],
      [],
      ["claude", "kiro"],
    );
    expect(
      (await resolveRuntimeOrgPolicy(ctx(), targetPolicy)).effective.candidates[0],
    ).toMatchObject({
      effective: false,
      decisionBlockers: [
        expect.objectContaining({ code: "decision-scope-mismatch", field: "targets" }),
      ],
    });

    const ambiguousPolicy = reviewedMcpPolicy();
    const ambiguousCandidate = ambiguousPolicy.governance?.catalog.reviewed[0];
    if (ambiguousCandidate === undefined || ambiguousPolicy.governance === undefined) {
      throw new Error("expected reviewed MCP fixture");
    }
    ambiguousCandidate.findings.push("prompt-injection");
    ambiguousPolicy.governance.authority.decisions = ["decision-reviewed-risk", "decision-second"];
    writeDecisionAuthorityReceipt([
      currentReviewedDecision(ambiguousPolicy),
      currentReviewedDecision(ambiguousPolicy, { id: "decision-second" }),
    ]);
    expect(
      (await resolveRuntimeOrgPolicy(ctx(), ambiguousPolicy)).effective.candidates[0],
    ).toMatchObject({
      effective: false,
      decisionBlockers: expect.arrayContaining([
        expect.objectContaining({ code: "decision-ambiguous" }),
      ]),
    });

    const revokedPolicy = reviewedMcpPolicy();
    const revokedCandidate = revokedPolicy.governance?.catalog.reviewed[0];
    if (revokedCandidate === undefined || revokedPolicy.governance === undefined) {
      throw new Error("expected reviewed MCP fixture");
    }
    revokedCandidate.findings.push("prompt-injection");
    revokedPolicy.governance.authority.decisions = ["decision-reviewed-risk"];
    const revoked = currentReviewedDecision(revokedPolicy);
    writeDecisionAuthorityReceipt(
      [revoked],
      [
        {
          format: "aih-governance-decision-revocation",
          version: 1,
          decision: revoked.id,
          issuer: revoked.issuer,
          revokedAt: new Date(Date.now() - 40_000).toISOString(),
          reason: "The decision was withdrawn.",
        },
      ],
    );
    expect(
      (await resolveRuntimeOrgPolicy(ctx(), revokedPolicy)).effective.candidates[0],
    ).toMatchObject({
      effective: false,
      decisionBlockers: [expect.objectContaining({ code: "decision-revoked" })],
    });

    const rejectedPolicy = reviewedMcpPolicy();
    const rejected = currentReviewedDecision(rejectedPolicy, {
      disposition: "rejected",
      acceptedFindings: [],
      acceptedGaps: [],
      conditions: [],
      reviewBy: undefined,
    });
    delete (rejected as Record<string, unknown>).reviewBy;
    writeDecisionAuthorityReceipt([rejected]);
    expect(
      (await resolveRuntimeOrgPolicy(ctx(), rejectedPolicy)).effective.candidates[0],
    ).toMatchObject({
      effective: false,
      decisionBlockers: [expect.objectContaining({ code: "decision-rejected" })],
    });
  });

  it("withholds all projections when a policy decision reference lacks a current receipt artifact", async () => {
    const policy = reviewedMcpPolicy();
    if (policy.governance === undefined) throw new Error("expected governance fixture");
    policy.governance.authority.decisions = ["decision-missing"];
    const runtime = await resolveRuntimeOrgPolicy(ctx(), policy);
    expect(runtime.effective).toMatchObject({
      blocking: true,
      decisionBlockers: [{ scope: "policy", code: "decision-receipt-missing" }],
    });
    expect(runtime.effective.candidates[0]?.effective).toBe(false);
  });

  it("keeps unrelated candidates on the legacy path while unreferenced rejection remains negative authority", async () => {
    const first = reviewedMcpPolicy({ allowedServers: [], disabledServers: [] });
    const second = reviewedMcpPolicy({
      allowedServers: [],
      disabledServers: [],
      serverId: "sequential-thinking",
    });
    const firstCandidate = first.governance?.catalog.reviewed[0];
    const secondCandidate = second.governance?.catalog.reviewed[0];
    if (
      first.governance === undefined ||
      firstCandidate === undefined ||
      secondCandidate === undefined
    ) {
      throw new Error("expected reviewed MCP fixtures");
    }
    const pair = parseOrgPolicy({
      ...JSON.parse(JSON.stringify(first)),
      governance: {
        ...JSON.parse(JSON.stringify(first)).governance,
        catalog: { reviewed: [firstCandidate, secondCandidate], custom: [] },
        activations: [
          { candidate: firstCandidate.id, state: "active", targets: ["claude"] },
          { candidate: secondCandidate.id, state: "active", targets: ["claude"] },
        ],
        authority: { approvals: [], decisions: ["decision-a"] },
      },
    });
    const approvedA = currentReviewedDecision(
      pair,
      {
        id: "decision-a",
        disposition: "approved",
        acceptedFindings: [],
        acceptedGaps: [],
        conditions: [],
        reviewBy: undefined,
      },
      firstCandidate.id,
    );
    delete (approvedA as Record<string, unknown>).reviewBy;
    const inertPositiveB = currentReviewedDecision(
      pair,
      {
        id: "decision-b-positive",
        disposition: "approved",
        acceptedFindings: [],
        acceptedGaps: [],
        conditions: [],
        reviewBy: undefined,
      },
      secondCandidate.id,
    );
    delete (inertPositiveB as Record<string, unknown>).reviewBy;
    writeDecisionAuthorityReceipt([approvedA, inertPositiveB]);
    const legacy = (await resolveRuntimeOrgPolicy(ctx(), pair)).effective.candidates.find(
      (candidate) => candidate.id === secondCandidate.id,
    );
    expect(legacy).toMatchObject({ effective: true, decisionBlockers: [] });
    expect(legacy).not.toHaveProperty("decision");

    const rejectedB = currentReviewedDecision(
      pair,
      {
        id: "decision-b-rejected",
        disposition: "rejected",
        acceptedFindings: [],
        acceptedGaps: [],
        conditions: [],
        reviewBy: undefined,
      },
      secondCandidate.id,
    );
    delete (rejectedB as Record<string, unknown>).reviewBy;
    writeDecisionAuthorityReceipt([approvedA, rejectedB]);
    const rejected = (await resolveRuntimeOrgPolicy(ctx(), pair)).effective.candidates.find(
      (candidate) => candidate.id === secondCandidate.id,
    );
    expect(rejected).toMatchObject({
      effective: false,
      decision: expect.objectContaining({ id: "decision-b-rejected", disposition: "rejected" }),
      decisionBlockers: [expect.objectContaining({ code: "decision-rejected" })],
    });
  });

  it("accepts only exact decision-bearing v2 authority receipts", () => {
    const v2 = authorityReceiptV2({ decisions: [governanceDecision()] });
    expect(PolicyAuthorityReceiptSchema.safeParse(v2).success).toBe(true);

    const v1 = { ...v2, version: 1 };
    delete (v1 as Record<string, unknown>).decisions;
    delete (v1 as Record<string, unknown>).decisionRevocations;
    expect(
      PolicyAuthorityReceiptSchema.safeParse({
        ...v1,
        issuedAt: "2026-08-03T00:00:00",
        expiresAt: "2026-08-20T00:00:00",
      }).success,
    ).toBe(true);
  });

  it("rejects malformed or non-authoritative v2 decision receipt relationships", () => {
    const decision = governanceDecision();
    const revocation = {
      format: "aih-governance-decision-revocation",
      version: 1,
      decision: decision.id,
      issuer: decision.issuer,
      revokedAt: "2026-08-02T00:00:00+00:00",
      reason: "The reviewed control was withdrawn.",
    };
    const approval = waivableApproval({
      candidate: "other-candidate",
      notBefore: "2026-08-01T00:00:00+00:00",
      expiresAt: "2026-08-10T00:00:00+00:00",
    });
    const legacyRevocation = {
      approval: approval.id,
      issuer: approval.issuer,
      revokedAt: "2026-08-02T00:00:00+00:00",
      reason: "The legacy approval was withdrawn.",
    };
    const base = authorityReceiptV2({
      decisions: [decision],
      decisionRevocations: [revocation],
      approvals: [approval],
      revocations: [legacyRevocation],
    });
    const hostAmbiguous = [
      ["issuedAt", { ...base, issuedAt: "2026-08-03T00:00:00" }],
      ["expiresAt", { ...base, expiresAt: "2026-08-20T00:00:00" }],
      [
        "approval notBefore",
        { ...base, approvals: [{ ...approval, notBefore: "2026-08-01T00:00:00" }] },
      ],
      [
        "approval expiresAt",
        { ...base, approvals: [{ ...approval, expiresAt: "2026-08-10T00:00:00" }] },
      ],
      [
        "legacy revocation revokedAt",
        {
          ...base,
          revocations: [{ ...legacyRevocation, revokedAt: "2026-08-02T00:00:00" }],
        },
      ],
    ] as const;
    for (const [_label, receipt] of hostAmbiguous) {
      expect(PolicyAuthorityReceiptSchema.safeParse(receipt).success).toBe(false);
    }
    const cases = [
      { ...base, decisions: undefined },
      { ...base, decisionRevocations: undefined },
      {
        ...base,
        decisions: [
          governanceDecision({ id: "decision-z" }),
          governanceDecision({ id: "decision-a" }),
        ],
      },
      { ...base, decisions: [decision, decision] },
      {
        ...base,
        decisionRevocations: [
          { ...revocation, decision: "decision-z" },
          { ...revocation, decision: "decision-a" },
        ],
      },
      { ...base, decisionRevocations: [revocation, revocation] },
      { ...base, decisionRevocations: [{ ...revocation, decision: "decision-missing" }] },
      { ...base, decisionRevocations: [{ ...revocation, issuer: "other-issuer" }] },
      {
        ...base,
        decisions: [
          governanceDecision({
            issuedAt: "2026-08-04T00:00:00+00:00",
            notBefore: "2026-08-04T00:00:00+00:00",
            expiresAt: "2026-08-10T00:00:00+00:00",
          }),
        ],
        decisionRevocations: [],
      },
      { ...base, decisionRevocations: [{ ...revocation, revokedAt: "2026-07-31T00:00:00+00:00" }] },
      { ...base, decisionRevocations: [{ ...revocation, revokedAt: "2026-08-04T00:00:00+00:00" }] },
      { ...base, decisions: [governanceDecision({ targets: ["codex"] })], decisionRevocations: [] },
      {
        ...base,
        decisions: [governanceDecision({ issuer: "other-issuer" })],
        decisionRevocations: [],
      },
      { ...base, approvals: [{ ...approval, candidate: decision.candidate }] },
      { ...base, approvals: [{ ...approval, id: "decision-legacy" }] },
      { ...base, revocations: [{ ...legacyRevocation, approval: "decision-legacy" }] },
    ];
    for (const receipt of cases) {
      expect(PolicyAuthorityReceiptSchema.safeParse(receipt).success).toBe(false);
    }
  });

  it("rejects invalid external authority receipt lifetimes, duplicate identities, and workflow controls", async () => {
    writeAuthorityReceipt({
      trustedIssuers: [
        { id: "platform-security", githubRepository: "acme/governance" },
        { id: "platform-security", githubRepository: "acme/governance" },
      ],
    });
    const receipt = JSON.parse(
      readFileSync(join(dir, ".aih", "policy-authority-receipt.json"), "utf8"),
    ) as Record<string, unknown>;
    const issuedAt = String(receipt.issuedAt);

    const sameTime = PolicyAuthorityReceiptSchema.safeParse({ ...receipt, expiresAt: issuedAt });
    expect(sameTime.success).toBe(false);
    if (sameTime.success) throw new Error("expected invalid authority receipt");
    expect(sameTime.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "receipt expiresAt must be after issuedAt",
        "duplicate trusted issuer platform-security",
      ]),
    );

    const tooLong = PolicyAuthorityReceiptSchema.safeParse({
      ...receipt,
      expiresAt: new Date(Date.parse(issuedAt) + 91 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(tooLong.success).toBe(false);
    if (tooLong.success) throw new Error("expected invalid authority receipt");
    expect(tooLong.error.issues.map((issue) => issue.message)).toContain(
      "receipt lifetime must not exceed 90 days",
    );

    await expect(
      verifyPolicyAuthorityReceipt(
        ctx({
          env: {
            AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance",
            AIH_POLICY_AUTHORITY_WORKFLOW: "policy-attest\u0000.yml",
            PATH: authorityBin,
          },
        }),
      ),
    ).resolves.toMatchObject({
      problem: expect.stringContaining("external organization authority registry is unavailable"),
    });
  });

  it("fails closed on malformed and noncurrent external authority receipts", async () => {
    mkdirSync(join(dir, ".aih"), { recursive: true });
    writeFileSync(join(dir, ".aih", "policy-authority-receipt.json"), "{not-json");
    await expect(verifyPolicyAuthorityReceipt(ctx())).resolves.toMatchObject({
      problem: expect.stringContaining("is malformed"),
    });

    writeAuthorityReceipt();
    const receipt = JSON.parse(
      readFileSync(join(dir, ".aih", "policy-authority-receipt.json"), "utf8"),
    ) as Record<string, unknown>;
    receipt.issuedAt = new Date(Date.now() + 60_000).toISOString();
    receipt.expiresAt = new Date(Date.now() + 120_000).toISOString();
    writeFileSync(join(dir, ".aih", "policy-authority-receipt.json"), JSON.stringify(receipt));
    await expect(verifyPolicyAuthorityReceipt(ctx())).resolves.toMatchObject({
      problem: "authority receipt is not currently valid",
    });
  });

  it("rejects signed approval subjects with tampered digest, signer, duration, or receipt target coverage", async () => {
    const base = waivableApproval();
    const signerMismatchUnsigned = {
      ...base,
      github: { ...base.github, repository: "other/signing-authority" },
    };
    const signerMismatch = {
      ...signerMismatchUnsigned,
      github: {
        ...signerMismatchUnsigned.github,
        subjectDigest: approvalAttestationDigest(signerMismatchUnsigned as never),
      },
    };
    const cases: Array<{
      approval: ReturnType<typeof waivableApproval>;
      targets?: string[];
      code: string;
    }> = [
      {
        approval: { ...base, github: { ...base.github, subjectDigest: DIGEST } },
        code: "approval-digest-mismatch",
      },
      { approval: signerMismatch, code: "approval-signer-untrusted" },
      {
        approval: waivableApproval({
          notBefore: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-05-01T00:00:00.000Z",
        }),
        code: "approval-duration-invalid",
      },
      { approval: base, targets: ["codex"], code: "approval-scope-mismatch" },
    ];

    for (const { approval, targets, code } of cases) {
      writeAuthorityReceipt({
        targets: targets ?? ["claude"],
        evidence: { state: "missing", waivable: true },
        approvals: [approval],
        trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
      });
      const authority = await verifiedAuthority(ctx());
      const effective = resolveEffectiveOrgPolicy(customPolicy(["claude"], [approval]), {
        authority,
        targets: ["claude"],
      });
      expect(effective.candidates[0]?.blockingCodes).toContain(code);
      expect(effective.candidates[0]?.effective).toBe(false);
    }
  });

  it("keeps an externally evidenced custom stdio MCP authorable but blocked without an integrity-enforcing projector", async () => {
    writeAuthorityReceipt();
    await expect(verifiedOrgPolicyProjectionActions(ctx(), customPolicy())).rejects.toThrow(
      /missing-projector.*custom-stdio-source-is-authorable-only/,
    );
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(customPolicy()));
    const report = await orgPolicyEffectiveDigest(ctx());
    expect(report?.text).toContain(candidateIdentityDigest({ source: customSource() } as never));
    expect(report?.text).toContain("missing-projector");
    expect(report?.text).toContain("custom-stdio-source-is-authorable-only");
    expect(report?.text).toContain("Runs only against the approved internal package registry.");
  });

  it("maps the resolved vibe posture to its actionable projector reason", async () => {
    const governed = reviewedMcpPolicy({
      allowedServers: [],
      disabledServers: [],
      targets: ["kiro"],
    });
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(governed));

    const report = await orgPolicyEffectiveDigest(ctx({ posture: "vibe", targets: ["kiro"] }));

    expect(report?.text).toContain("missing-projector");
    expect(report?.text).toContain("projector-disabled-at-vibe-posture");
    expect(report?.text).toContain(
      "kiro / workspace MCP distribution; supported=claude,kiro; selected=kiro (this invocation); blocked",
    );
  });

  it("reports external framework curation as pinned, audited, and non-enforcing guidance", async () => {
    const base = customPolicy();
    if (base.governance === undefined) throw new Error("expected governance");
    const policy = parseOrgPolicy({
      ...base,
      governance: {
        supportedClis: ["claude"],
        ...base.governance,
        externalCuration: [
          {
            framework: "ecc",
            items: [
              {
                kind: "agent",
                id: "security-review-agent",
                source: {
                  repository: "acme/ecc-catalog",
                  commit: "a".repeat(40),
                  path: "agents/security-review.md",
                },
                audit: { record: "audit-2026-08", digest: DIGEST },
                clarification: "Use as external curation guidance only.",
              },
            ],
          },
        ],
      },
    });
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(policy));
    const report = await orgPolicyEffectiveDigest(ctx());
    expect(report?.text).toContain(
      "External framework curation (report-only; never projected or enforced)",
    );
    expect(report?.text).toContain("ecc agent:security-review-agent");
    expect(report?.text).toContain("status=external-guidance");
    expect(
      (report?.data as { externalCuration?: unknown } | undefined)?.externalCuration,
    ).toMatchObject([
      { framework: "ecc", status: "external-guidance", items: [{ id: "security-review-agent" }] },
    ]);
  });

  it("accepts a receipt-backed approval only for a waivable evidence gap with a non-empty signed reason", async () => {
    const approval = waivableApproval();
    writeAuthorityReceipt({
      evidence: { state: "missing", waivable: true },
      approvals: [approval],
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
    });
    const governed = customPolicy(["claude"], [approval]);
    await expect(verifiedOrgPolicyProjectionActions(ctx(), governed)).rejects.toThrow(
      /missing-projector/,
    );
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(governed));
    const report = await orgPolicyEffectiveDigest(ctx());
    expect(report?.text).toContain(candidateIdentityDigest({ source: customSource() } as never));
    expect(report?.text).toContain(`evidence=${DIGEST}`);
    expect(report?.text).toContain("platform-security @ acme/governance");
    expect(report?.text).toContain("supported=none; selected=claude (this invocation); blocked");
    expect(report?.text).toContain("Security exception ownership: platform-security.");
  });

  it("preserves legacy approvals without clarification but never lets them waive an evidence gap", async () => {
    const legacyApproval = waivableApproval({ clarification: undefined });
    writeAuthorityReceipt({
      evidence: { state: "missing", waivable: true },
      approvals: [legacyApproval],
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
    });
    const authority = await verifiedAuthority(ctx());
    const effective = resolveEffectiveOrgPolicy(customPolicy(["claude"], [legacyApproval]), {
      authority,
      targets: ["claude"],
    });
    expect(effective.candidates[0]).toMatchObject({
      effective: false,
      blockingCodes: expect.arrayContaining(["approval-clarification-missing"]),
    });
  });

  it("never lets an approval waive a mandatory detector failure", async () => {
    const approval = waivableApproval();
    writeAuthorityReceipt({
      evidence: {
        state: "failed",
        waivable: true,
        detectors: [{ id: "semgrep", required: true, status: "fail", reportDigest: DIGEST }],
      },
      approvals: [approval],
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
    });
    await expect(
      verifiedOrgPolicyProjectionActions(ctx(), customPolicy(["claude"], [approval])),
    ).rejects.toThrow(/mandatory-detector-failed/);
  });

  it("keeps externally attested unwaivable and nonwaivable evidence outcomes blocking", async () => {
    for (const { evidence, dangerCode, blockingCode } of [
      {
        evidence: { findings: ["secrets"] },
        dangerCode: "secrets",
      },
      {
        evidence: { state: "failed", waivable: false },
        blockingCode: "evidence-failed",
      },
      {
        evidence: { state: "missing", waivable: false },
        blockingCode: "evidence-missing",
      },
    ]) {
      writeAuthorityReceipt({ evidence });
      const effective = resolveEffectiveOrgPolicy(customPolicy(), {
        authority: await verifiedAuthority(ctx()),
        targets: ["claude"],
      });
      const candidate = effective.candidates[0];
      if (candidate === undefined) throw new Error("missing custom MCP candidate");
      expect(effective.blocking).toBe(true);
      expect(candidate.effective).toBe(false);
      if (dangerCode !== undefined) expect(candidate.dangerCodes).toContain(dangerCode);
      if (blockingCode !== undefined) expect(candidate.blockingCodes).toContain(blockingCode);
    }
  });

  it("rejects catalog aliases, stale activation decisions, duplicate approvals, and conflicting framework intents", () => {
    const policy = JSON.parse(JSON.stringify(customPolicy())) as {
      governance: {
        supportedClis: ["claude"];
        catalog: {
          reviewed: Array<Record<string, unknown>>;
          custom: Array<Record<string, unknown>>;
        };
        activations: Array<Record<string, unknown>>;
        authority: { approvals: unknown[] };
      };
    };
    const custom = policy.governance.catalog.custom[0];
    if (custom === undefined) throw new Error("missing custom MCP candidate");
    const scriptDigest = `sha256:${createHash("sha256").update(usageRecorderScript(), "utf8").digest("hex")}`;
    policy.governance.catalog.reviewed.push({ ...custom, id: "reviewed-stdio" });
    policy.governance.catalog.custom.push(
      {
        ...custom,
        id: "custom-hook-alias",
        kind: "hook",
        source: { type: "hook", handler: "usage-metering", scriptDigest },
        projector: "usage-hook",
      },
      { ...custom },
      {
        ...custom,
        id: "ecc-framework",
        kind: "framework",
        framework: "ecc",
        projector: "framework-contract",
      },
      {
        ...custom,
        id: "superpowers-framework",
        kind: "framework",
        framework: "superpowers",
        projector: "framework-contract",
      },
    );
    policy.governance.activations.push(
      { candidate: "custom-mcp", state: "active", targets: ["claude"] },
      { candidate: "unknown-candidate", state: "active", targets: ["claude"] },
      { candidate: "custom-mcp", state: "active", targets: ["codex"] },
      { candidate: "ecc-framework", state: "active", targets: ["claude"] },
      { candidate: "superpowers-framework", state: "active", targets: ["claude"] },
    );
    const approval = waivableApproval();
    policy.governance.authority.approvals = [approval, approval];

    let error: unknown;
    try {
      parseOrgPolicy(policy);
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof Error)) throw new Error("expected malformed governance rejection");
    expect(error.message).toContain("reviewed catalog entries must reference an AIH-shipped MCP");
    expect(error.message).toContain("custom hook candidates are unsupported");
    expect(error.message).toContain("candidate id custom-mcp is duplicated");
    expect(error.message).toContain("custom-mcp has more than one activation decision");
    expect(error.message).toContain("activation references unknown candidate unknown-candidate");
    expect(error.message).toContain(
      "activation targets exceed candidate target support for custom-mcp",
    );
    expect(error.message).toContain("only one framework intent may be active at a time");
    expect(error.message).toContain("approval custom-waiver is duplicated");
  });

  it("rejects invalid source, identity, and framework candidate shapes before resolution", () => {
    const builtinPolicy = reviewedMcpPolicy();
    const builtin = builtinPolicy.governance?.catalog.reviewed[0];
    if (builtin?.source.type !== "mcp") throw new Error("missing reviewed MCP source");
    const scriptDigest = `sha256:${createHash("sha256").update(usageRecorderScript(), "utf8").digest("hex")}`;
    for (const { candidate, detail } of [
      {
        candidate: {
          ...JSON.parse(JSON.stringify(customPolicy())).governance.catalog.custom[0],
          source: { type: "hook", handler: "usage-metering", scriptDigest },
        },
        detail:
          "MCP candidates must use an exact catalog, fully pinned stdio package, or fenced remote endpoint identity",
      },
      {
        candidate: { ...builtin, id: "mcp-alias" },
        detail: "built-in MCP candidate id must exactly match source.server",
      },
      {
        candidate: {
          ...JSON.parse(JSON.stringify(customPolicy())).governance.catalog.custom[0],
          kind: "framework",
          framework: "ecc",
          projector: "mcp-managed-settings",
          targets: ["codex"],
          autoExecute: true,
        },
        detail: "framework intents are Claude-only, non-autoexecuting framework-contract records",
      },
      {
        candidate: {
          ...JSON.parse(JSON.stringify(customPolicy())).governance.catalog.custom[0],
          kind: "framework",
          projector: "framework-contract",
        },
        detail: "framework candidates must name ecc or superpowers",
      },
      {
        candidate: {
          ...JSON.parse(JSON.stringify(customPolicy())).governance.catalog.custom[0],
          framework: "ecc",
        },
        detail: "framework is only valid on framework candidates",
      },
    ]) {
      const policy = JSON.parse(JSON.stringify(customPolicy())) as {
        governance: { catalog: { custom: unknown[] } };
      };
      policy.governance.catalog.custom = [candidate];
      expect(() => parseOrgPolicy(policy)).toThrow(detail);
    }
  });

  it("keeps exact reviewed controls blocked when their runtime projector identities are unavailable", () => {
    const mcpPolicy = reviewedMcpPolicy();
    const mcp = mcpPolicy.governance?.catalog.reviewed[0];
    if (mcp?.source.type !== "mcp") throw new Error("missing reviewed MCP source");
    const mcpControl = {
      id: mcp.id,
      kind: "mcp" as const,
      source: mcp.source,
      targets: mcp.targets,
      projector: mcp.projector,
      lifecycle: mcp.lifecycle,
    };
    const mcpEffective = resolveEffectiveOrgPolicy(mcpPolicy, {
      targets: ["claude"],
      aihReviewedControls: {
        [mcp.id]: { control: mcpControl, controlDigest: reviewedControlDigest(mcpControl) },
      },
      mcpIdentities: { [mcp.source.server]: { subject: mcp.source.subject, projectable: false } },
    });
    expect(mcpEffective.candidates[0]?.dangerCodes).toContain("missing-projector");

    const hookPolicy = usageHookPolicy("active");
    const hook = hookPolicy.governance?.catalog.reviewed[0];
    if (hook?.source.type !== "hook") throw new Error("missing reviewed hook source");
    const hookControl = {
      id: hook.id,
      kind: "hook" as const,
      source: hook.source,
      targets: hook.targets,
      projector: hook.projector,
      lifecycle: hook.lifecycle,
    };
    const hookEffective = resolveEffectiveOrgPolicy(hookPolicy, {
      targets: ["claude"],
      aihReviewedControls: {
        [hook.id]: { control: hookControl, controlDigest: reviewedControlDigest(hookControl) },
      },
      hookIdentities: {
        "usage-metering": { scriptDigest: hook.source.scriptDigest, projectable: false },
      },
    });
    expect(hookEffective.candidates[0]?.dangerCodes).toContain("missing-projector");
  });

  it("resolves multiple exact reviewed MCP controls in deterministic active-server order", () => {
    const firstPolicy = reviewedMcpPolicy({ allowedServers: [], disabledServers: [] });
    const secondPolicy = reviewedMcpPolicy({
      allowedServers: [],
      disabledServers: [],
      serverId: "sequential-thinking",
    });
    const first = firstPolicy.governance?.catalog.reviewed[0];
    const second = secondPolicy.governance?.catalog.reviewed[0];
    if (first?.source.type !== "mcp" || second?.source.type !== "mcp") {
      throw new Error("missing reviewed MCP controls");
    }
    const policy = parseOrgPolicy({
      ...JSON.parse(JSON.stringify(firstPolicy)),
      governance: {
        supportedClis: ["claude"],
        ...JSON.parse(JSON.stringify(firstPolicy)).governance,
        catalog: { reviewed: [first, second], custom: [] },
        activations: [
          { candidate: first.id, state: "active", targets: ["claude"] },
          { candidate: second.id, state: "active", targets: ["claude"] },
        ],
      },
    });
    const control = (candidate: typeof first) => ({
      id: candidate.id,
      kind: "mcp" as const,
      source: candidate.source,
      targets: candidate.targets,
      projector: candidate.projector,
      lifecycle: candidate.lifecycle,
    });
    const firstControl = control(first);
    const secondControl = control(second);
    const effective = resolveEffectiveOrgPolicy(policy, {
      targets: ["claude"],
      aihReviewedControls: {
        [first.id]: {
          control: firstControl,
          controlDigest: reviewedControlDigest(firstControl),
        },
        [second.id]: {
          control: secondControl,
          controlDigest: reviewedControlDigest(secondControl),
        },
      },
      mcpIdentities: {
        [first.source.server]: { subject: first.source.subject, projectable: true },
        [second.source.server]: { subject: second.source.subject, projectable: true },
      },
    });
    expect(effective.activeMcpServerIds).toEqual([first.id, second.id].sort());
  });

  it("applies only matching effective approval revocations and reports their issuer, reason, and time", async () => {
    const signed = waivableApproval();
    const base = {
      evidence: { state: "missing", waivable: true },
      approvals: [signed],
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
    };
    for (const revocation of [
      {
        approval: signed.id,
        issuer: "another-issuer",
        revokedAt: "2026-01-01T00:00:00.000Z",
        reason: "Wrong issuer must not revoke.",
      },
      {
        approval: signed.id,
        issuer: "platform-security",
        revokedAt: "2099-01-01T00:00:00.000Z",
        reason: "Future revocation must not revoke.",
      },
    ]) {
      writeAuthorityReceipt({ ...base, revocations: [revocation] });
      await expect(
        verifiedOrgPolicyProjectionActions(ctx(), customPolicy(["claude"], [signed])),
      ).rejects.toThrow(/missing-projector/);
    }

    const revokedAt = "2026-01-01T00:00:00.000Z";
    const reason = "Compromised review evidence requires immediate withdrawal.";
    writeAuthorityReceipt({
      ...base,
      revocations: [{ approval: signed.id, issuer: "platform-security", revokedAt, reason }],
    });
    const governed = customPolicy(["claude"], [signed]);
    await expect(verifiedOrgPolicyProjectionActions(ctx(), governed)).rejects.toThrow(
      /approval-revoked/,
    );
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(governed));
    const report = await orgPolicyEffectiveDigest(ctx());
    expect(report?.text).toContain("approval-revoked");
    expect(report?.text).toContain("platform-security");
    expect(report?.text).toContain(revokedAt);
    expect(report?.text).toContain(reason);
  });

  it("blocks custom package projection when the receipt's package integrity identity differs", async () => {
    writeAuthorityReceipt({
      evidence: { source: { ...customSource(), integrity: `sha256:${"c".repeat(64)}` } },
    });
    await expect(verifiedOrgPolicyProjectionActions(ctx(), customPolicy())).rejects.toThrow(
      /authority-receipt-mismatch/,
    );
  });

  it("enforces receipt-wide target coverage even for externally verified evidence", async () => {
    writeAuthorityReceipt({ targets: ["codex"] });
    await expect(verifiedOrgPolicyProjectionActions(ctx(), customPolicy())).rejects.toThrow(
      /authority-target-coverage-mismatch/,
    );
  });

  it("does not brand parsed receipt bytes when the verifier only accepts a swapped live receipt", async () => {
    writeAuthorityReceipt();
    const liveReceipt = join(dir, ".aih", "policy-authority-receipt.json");
    const run = fakeRunner((argv) => {
      if (argv[0] !== trustedGh) return undefined;
      writeFileSync(liveReceipt, '{"swapped":true}');
      // This models the old vulnerable verification of the now-swapped live path.
      return argv[3] === liveReceipt ? { code: 0, stdout: "wrong bytes" } : { code: 1 };
    });
    await expect(verifiedOrgPolicyProjectionActions(ctx({ run }), customPolicy())).rejects.toThrow(
      /authority-receipt-unverified/,
    );
  });

  it("rejects an authority receipt reached through a symlinked parent", async () => {
    writeAuthorityReceipt();
    const external = mkdtempSync(join(tmpdir(), "aih-authority-external-"));
    const linked = join(dir, ".aih");
    copyFileSync(
      join(linked, "policy-authority-receipt.json"),
      join(external, "policy-authority-receipt.json"),
    );
    rmSync(linked, { recursive: true, force: true });
    symlinkSync(external, linked, "junction");

    await expect(verifiedOrgPolicyProjectionActions(ctx(), customPolicy())).rejects.toThrow(
      /unsafe symlinked parent/,
    );
  });

  it("rejects every replayed approval subject change, even when the policy recomputes its local digest", async () => {
    const approval = waivableApproval();
    writeAuthorityReceipt({
      evidence: { state: "missing", waivable: true },
      approvals: [approval],
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
    });
    for (const changed of [
      { candidate: "another-candidate" },
      { kind: "hook" },
      { source: { ...customSource(), integrity: `sha256:${"c".repeat(64)}` } },
      { evidenceDigest: `sha256:${"d".repeat(64)}` },
      { projector: "usage-hook" },
      { reason: "A different approval reason." },
      { scope: ["codex"] },
      { notBefore: "2026-02-01T00:00:00.000Z" },
      { expiresAt: "2026-11-30T00:00:00.000Z" },
      { policyVersion: "2026.09.0" },
    ]) {
      const replay = waivableApproval(changed);
      await expect(
        verifiedOrgPolicyProjectionActions(ctx(), customPolicy(["claude"], [replay])),
      ).rejects.toThrow(/policy project refuses blocked candidate activation/);
    }
  });

  it("rejects a receipt attested by the governed target repository even if gh reports the digest valid", async () => {
    writeAuthorityReceipt({ issuerRepository: "product/team-repo" });
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return argv[0] === trustedGh ? { code: 0, stdout: "target repo signed it" } : undefined;
    });
    const c = ctx({ run });

    await expect(verifiedOrgPolicyProjectionActions(c, customPolicy())).rejects.toThrow(
      /authority receipt issuer does not match the external organization authority registry/,
    );
    expect(calls.filter((argv) => argv[0] === trustedGh)).toEqual([]);
  });

  it("constrains gh verification to the configured organization repository and workflow", async () => {
    writeAuthorityReceipt();
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return argv[0] === trustedGh ? { code: 0, stdout: "verified" } : { code: 1 };
    });
    await expect(
      verifiedOrgPolicyProjectionActions(
        ctx({
          run,
          env: {
            AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance",
            PATH: authorityBin,
            AIH_POLICY_AUTHORITY_WORKFLOW:
              "https://github.com/acme/governance/.github/workflows/policy-attest.yml@refs/heads/main",
          },
        }),
        customPolicy(),
      ),
    ).rejects.toThrow(/missing-projector/);
    const verification = calls.find((argv) => argv[0] === trustedGh);
    expect(verification?.slice(0, 3)).toEqual([trustedGh, "attestation", "verify"]);
    expect(verification?.[3]).not.toBe(join(dir, ".aih", "policy-authority-receipt.json"));
    expect(verification?.slice(4)).toEqual([
      "--repo",
      "acme/governance",
      "--signer-workflow",
      "https://github.com/acme/governance/.github/workflows/policy-attest.yml@refs/heads/main",
    ]);
  });

  it("rejects repo-contained gh shims and uses the later external executable", async () => {
    writeAuthorityReceipt();
    const decoyBin = join(dir, "node_modules", ".bin");
    mkdirSync(decoyBin, { recursive: true });
    const decoy = join(decoyBin, process.platform === "win32" ? "gh.exe" : "gh");
    writeFileSync(decoy, "repo-local gh decoy\n", { mode: 0o755 });
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return argv[0] === trustedGh ? { code: 0, stdout: "verified" } : undefined;
    });

    await expect(
      verifiedOrgPolicyProjectionActions(
        ctx({
          run,
          env: {
            AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance",
            PATH: `${decoyBin}${process.platform === "win32" ? ";" : ":"}${authorityBin}`,
          },
        }),
        customPolicy(),
      ),
    ).rejects.toThrow(/missing-projector/);
    expect(calls.some((argv) => argv[0] === decoy)).toBe(false);
    expect(calls).toContainEqual(expect.arrayContaining([trustedGh, "attestation", "verify"]));
  });

  it("fails closed when absolute PATH contains only a repo-contained gh shim", async () => {
    writeAuthorityReceipt();
    const decoyBin = join(dir, "node_modules", ".bin");
    mkdirSync(decoyBin, { recursive: true });
    writeFileSync(
      join(decoyBin, process.platform === "win32" ? "gh.exe" : "gh"),
      "repo-local gh decoy\n",
      { mode: 0o755 },
    );
    await expect(
      verifiedOrgPolicyProjectionActions(
        ctx({ env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: decoyBin } }),
        customPolicy(),
      ),
    ).rejects.toThrow(/authority-receipt-unverified/);
  });

  it("allows an exact AIH-shipped reviewed MCP without accepting a self-declared custom review", async () => {
    const server = mcpServers("project", scanRepo(dir, { maxDepth: 8, contextDir: "ai-coding" }))[
      "code-review-graph"
    ];
    if (server === undefined) throw new Error("expected code-review-graph catalog entry");
    const source = {
      type: "mcp" as const,
      server: "code-review-graph",
      subject: mcpApprovalSubject(server),
    };
    const policy = parseOrgPolicy({
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      mcp: { allowManagedOnly: true },
      governance: {
        policyVersion: "2026.08.0",
        supportedClis: ["claude"],
        catalog: {
          reviewed: [
            {
              id: "code-review-graph",
              kind: "mcp",
              description: "AIH shipped catalog MCP",
              capabilities: [],
              risks: [],
              source,
              targets: ["claude"],
              projector: "mcp-managed-settings",
              lifecycle: "supported",
              evidence: { record: "ignored-self-assertion" },
            },
          ],
          custom: [],
        },
        activations: [{ candidate: "code-review-graph", state: "active", targets: ["claude"] }],
        authority: { approvals: [] },
      },
    });
    const write = (await verifiedOrgPolicyProjectionActions(ctx(), policy)).find(
      (action): action is WriteAction =>
        action.kind === "write" && action.path === ".claude/managed-settings.json",
    );
    expect(write?.json).toMatchObject({
      organizationPolicy: {
        effectiveCandidates: [expect.objectContaining({ effective: true, evidence: "verified" })],
      },
    });
  });

  it("projects only governance-selected MCP identity despite conflicting legacy allow/disable lists", async () => {
    const policy = reviewedMcpPolicy();
    const writes = (await verifiedOrgPolicyProjectionActions(ctx(), policy)).filter(
      (action): action is WriteAction => action.kind === "write",
    );
    const managed = writes.find((action) => action.path === ".claude/managed-settings.json");
    expect(managed?.json).toMatchObject({
      allowedMcpServers: [
        expect.objectContaining({
          serverCommand: expect.arrayContaining(["code-review-graph@2.3.7"]),
        }),
      ],
    });
    expect(JSON.stringify(managed?.json)).not.toContain("unrelated-legacy-server");
  });

  it("projects a Kiro-only reviewed MCP through its separate workspace receipt", async () => {
    const governed = reviewedMcpPolicy({
      allowedServers: [],
      disabledServers: [],
      targets: ["kiro"],
    });
    const applied = ctx({ apply: true, targets: ["kiro"] });
    await executePlan(
      plan("governed Kiro MCP", ...(await verifiedOrgPolicyProjectionActions(applied, governed))),
      applied,
    );

    const settings = JSON.parse(readFileSync(join(dir, ".kiro", "settings", "mcp.json"), "utf8"));
    expect(settings.mcpServers["code-review-graph"]).toMatchObject({
      type: "stdio",
      command: "uvx",
    });
    const marker = JSON.parse(readFileSync(join(dir, ".aih-config.json"), "utf8"));
    expect(marker.kiroMcpProjection).toMatchObject({ state: "active" });
    expect(marker.managedMcpProjection).toBeUndefined();
    expect(existsSync(join(dir, ".claude", "managed-settings.json"))).toBe(false);

    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(governed));
    const digest = await orgPolicyEffectiveDigest(applied);
    expect(digest?.text).toContain("kiro / workspace MCP distribution");
    expect(digest?.text).not.toContain("kiro / mcp-managed-settings");

    expect(await verifiedOrgPolicyProjectionActions(applied, governed)).toEqual([]);
  });

  it("keeps both Claude and Kiro ownership receipts through one activation and deactivation", async () => {
    const active = reviewedMcpPolicy({
      allowedServers: [],
      disabledServers: [],
      targets: ["claude", "kiro"],
    });
    const applied = ctx({ apply: true, targets: ["claude", "kiro"] });
    await executePlan(
      plan("governed dual MCP", ...(await verifiedOrgPolicyProjectionActions(applied, active))),
      applied,
    );
    let marker = JSON.parse(readFileSync(join(dir, ".aih-config.json"), "utf8"));
    expect(marker.managedMcpProjection).toMatchObject({ state: "active" });
    expect(marker.kiroMcpProjection).toMatchObject({ state: "active" });

    const disabled = JSON.parse(JSON.stringify(active)) as {
      governance: { activations: Array<{ state: string }> };
      mcp: { allowManagedOnly: boolean };
    };
    const [activation] = disabled.governance.activations;
    if (activation === undefined) throw new Error("expected governed MCP activation");
    activation.state = "disabled";
    disabled.mcp.allowManagedOnly = false;
    await executePlan(
      plan(
        "governed dual MCP deactivation",
        ...(await verifiedOrgPolicyProjectionActions(applied, disabled as typeof active)),
      ),
      applied,
    );
    marker = JSON.parse(readFileSync(join(dir, ".aih-config.json"), "utf8"));
    expect(marker.managedMcpProjection).toBeUndefined();
    expect(marker.kiroMcpProjection).toBeUndefined();
  });

  it("reports clean then altered managed-MCP receipt state from the live ownership pair", async () => {
    const governed = reviewedMcpPolicy({ allowedServers: [], disabledServers: [] });
    const applied = ctx({ apply: true });
    await executePlan(
      plan("governed MCP", ...(await verifiedOrgPolicyProjectionActions(applied, governed))),
      applied,
    );
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(governed));
    expect((await orgPolicyEffectiveDigest(applied))?.text).toContain(
      "clean: managed-MCP receipt and owned settings match",
    );

    const settingsPath = join(dir, ".claude", "managed-settings.json");
    const changed = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    changed.allowedMcpServers = [];
    writeFileSync(settingsPath, JSON.stringify(changed));
    expect((await orgPolicyEffectiveDigest(applied))?.text).toContain("altered:");
    const check = await orgPolicyEffectiveCheck(applied);
    expect(check).toMatchObject({ verdict: "fail", code: "org-policy.effective-blocked" });
  });

  it("keeps a prior governed MCP selection retained after active-to-disabled until policy project reconciles it", async () => {
    const active = reviewedMcpPolicy({ allowedServers: [], disabledServers: [] });
    const applied = ctx({ apply: true });
    await executePlan(
      plan("governed MCP", ...(await verifiedOrgPolicyProjectionActions(applied, active))),
      applied,
    );
    const disabled = JSON.parse(JSON.stringify(active)) as {
      governance: { activations: Array<{ state: string }> };
    };
    const [activation] = disabled.governance.activations;
    if (activation === undefined) throw new Error("expected active governed MCP fixture");
    activation.state = "disabled";
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(disabled));

    const digest = await orgPolicyEffectiveDigest(applied);
    expect(digest?.text).toContain(
      "retained: managed-MCP receipt and owned settings retain a prior governed selection",
    );
    const check = await orgPolicyEffectiveCheck(applied);
    expect(check).toMatchObject({ verdict: "fail", code: "org-policy.effective-blocked" });
    expect(check.detail).toContain("retain a prior governed selection");
  });

  it("classifies disabled exact legacy Claude and Kiro receipts as retained, not upgrade-required", async () => {
    for (const targets of [["claude"], ["kiro"]] as const) {
      const active = reviewedMcpPolicy({
        allowedServers: [],
        disabledServers: [],
        targets: [...targets],
      });
      const applied = ctx({ apply: true, targets: [...targets] });
      await executePlan(
        plan("governed MCP", ...(await verifiedOrgPolicyProjectionActions(applied, active))),
        applied,
      );
      const markerPath = join(dir, ".aih-config.json");
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
      if (targets[0] === "claude") {
        const ownership = marker.managedMcpProjection as {
          expected: Parameters<typeof managedMcpProjectionOwnership>[0];
        };
        marker.managedMcpProjection = managedMcpProjectionOwnership(ownership.expected);
      } else {
        const ownership = marker.kiroMcpProjection as {
          expected: Parameters<typeof kiroMcpProjectionOwnership>[0];
        };
        marker.kiroMcpProjection = kiroMcpProjectionOwnership(ownership.expected);
      }
      writeFileSync(markerPath, JSON.stringify(marker));
      const disabled = JSON.parse(JSON.stringify(active)) as typeof active;
      if (disabled.governance === undefined) throw new Error("expected governance fixture");
      const activation = disabled.governance.activations[0];
      if (activation === undefined || disabled.mcp === undefined) {
        throw new Error("expected managed activation fixture");
      }
      activation.state = "disabled";
      disabled.mcp.allowManagedOnly = false;
      const effective = (await resolveRuntimeOrgPolicy(applied, disabled)).effective;
      const state =
        targets[0] === "claude"
          ? orgPolicyMcpReceiptState(applied, effective)
          : orgPolicyKiroMcpReceiptState(applied, effective);
      expect(state.state).toBe("retained");
    }
  });

  it("keeps a changed governed MCP selected set retained until policy project reconciles it", async () => {
    const active = reviewedMcpPolicy({ allowedServers: [], disabledServers: [] });
    const applied = ctx({ apply: true });
    await executePlan(
      plan("governed MCP", ...(await verifiedOrgPolicyProjectionActions(applied, active))),
      applied,
    );
    const changedSelection = reviewedMcpPolicy({
      allowedServers: [],
      disabledServers: [],
      serverId: "sequential-thinking",
    });
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(changedSelection));

    const digest = await orgPolicyEffectiveDigest(applied);
    expect(digest?.text).toContain(
      "retained: managed-MCP receipt and owned settings retain a different governed selection",
    );
    const check = await orgPolicyEffectiveCheck(applied);
    expect(check).toMatchObject({ verdict: "fail", code: "org-policy.effective-blocked" });
    expect(check.detail).toContain("retain a different governed selection");
  });

  it("refuses a matching external managed-settings file behind a symlinked parent", async () => {
    const governed = reviewedMcpPolicy({ allowedServers: [], disabledServers: [] });
    const applied = ctx({ apply: true });
    await executePlan(
      plan("governed MCP", ...(await verifiedOrgPolicyProjectionActions(applied, governed))),
      applied,
    );
    const external = mkdtempSync(join(tmpdir(), "aih-managed-mcp-external-"));
    copyFileSync(
      join(dir, ".claude", "managed-settings.json"),
      join(external, "managed-settings.json"),
    );
    rmSync(join(dir, ".claude"), { recursive: true, force: true });
    symlinkSync(external, join(dir, ".claude"), "junction");

    await expect(verifiedOrgPolicyProjectionActions(applied, governed)).rejects.toThrow(
      /unsafe managed-MCP ownership path/,
    );
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(governed));
    const check = await orgPolicyEffectiveCheck(applied);
    expect(check).toMatchObject({ verdict: "fail", code: "org-policy.effective-blocked" });
  });

  it("rejects a Codex target on every MCP candidate before it can claim unsupported coverage", () => {
    expect(() => customPolicy(["codex"])).toThrow(
      /activation targets exceed candidate target support/,
    );
  });

  it("projects the supported AIH-owned hook through host hook generation", async () => {
    const scriptDigest = `sha256:${createHash("sha256").update(usageRecorderScript(), "utf8").digest("hex")}`;
    const source = { type: "hook" as const, handler: "usage-metering" as const, scriptDigest };
    const policy = parseOrgPolicy({
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026.08.0",
        supportedClis: ["claude"],
        catalog: {
          reviewed: [
            {
              id: "usage-metering",
              kind: "hook",
              description: "AIH owned hook",
              capabilities: [],
              risks: [],
              source,
              targets: ["claude", "codex"],
              projector: "usage-hook",
              lifecycle: "supported",
              evidence: { record: "ignored-self-assertion" },
            },
          ],
          custom: [],
        },
        activations: [{ candidate: "usage-metering", state: "active", targets: ["claude"] }],
        authority: { approvals: [] },
      },
    });
    const writes = (await verifiedOrgPolicyProjectionActions(ctx(), policy)).filter(
      (action): action is WriteAction => action.kind === "write",
    );
    expect(writes.map((write) => write.path)).toEqual(
      expect.arrayContaining([".aih/usage-record.mjs", ".gitignore", ".claude/settings.json"]),
    );
    expect(
      writes.find((write) => write.path === ".aih/org-policy-hook-receipt.json")?.json,
    ).toMatchObject({
      format: "aih-org-policy-hook-receipt",
      version: 3,
      decisions: [],
      selfDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it("projects the supported AIH-owned hook for a Codex-only invocation", async () => {
    const writes = (
      await verifiedOrgPolicyProjectionActions(
        ctx({ targets: ["codex"] }),
        usageHookPolicy("active", ["codex"]),
      )
    ).filter((action): action is WriteAction => action.kind === "write");
    expect(writes.map((write) => write.path)).toEqual(
      expect.arrayContaining([".aih/usage-record.mjs", ".gitignore", ".codex/hooks.json"]),
    );
  });

  it("upgrades an exact legacy usage receipt to v3 without rewriting owned hook artifacts", async () => {
    const applied = ctx({ apply: true });
    const policy = usageHookPolicy("active");
    await executePlan(
      plan("policy hooks", ...(await verifiedOrgPolicyProjectionActions(applied, policy))),
      applied,
    );
    const hostPath = join(dir, ".claude", "settings.json");
    const recorderPath = join(dir, ".aih", "usage-record.mjs");
    const hostBefore = readFileSync(hostPath, "utf8");
    const recorderBefore = readFileSync(recorderPath, "utf8");
    const receiptPath = join(dir, ".aih", "org-policy-hook-receipt.json");
    const legacy = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    legacy.version = 2;
    delete legacy.decisions;
    delete legacy.selfDigest;
    writeFileSync(receiptPath, JSON.stringify(legacy));

    const refresh = await verifiedOrgPolicyProjectionActions(applied, policy);
    const hookRefresh = refresh.filter(
      (action) =>
        "path" in action &&
        typeof action.path === "string" &&
        [
          ".aih/usage-record.mjs",
          ".gitignore",
          ".claude/settings.json",
          ".aih/org-policy-hook-receipt.json",
        ].includes(action.path),
    );
    expect(hookRefresh).toHaveLength(1);
    expect(hookRefresh[0]).toMatchObject({
      kind: "write",
      path: ".aih/org-policy-hook-receipt.json",
      json: { version: 3, decisions: [], selfDigest: expect.any(String) },
    });
    await executePlan(plan("upgrade policy hook receipt", ...refresh), applied);

    expect(readFileSync(hostPath, "utf8")).toBe(hostBefore);
    expect(readFileSync(recorderPath, "utf8")).toBe(recorderBefore);
  });

  it("reports retained-invalid-decision for exact owned MCP bytes after authority binding changes", async () => {
    const policy = reviewedMcpPolicy({ allowedServers: [], disabledServers: [] });
    if (policy.governance === undefined) throw new Error("expected governance fixture");
    policy.governance.authority.decisions = ["decision-clean"];
    const decision = currentReviewedDecision(policy, {
      id: "decision-clean",
      disposition: "approved",
      acceptedFindings: [],
      acceptedGaps: [],
      conditions: [],
      reviewBy: undefined,
    });
    delete (decision as Record<string, unknown>).reviewBy;
    writeDecisionAuthorityReceipt([decision]);
    const applied = ctx({ apply: true });
    await executePlan(
      plan("decision-bound MCP", ...(await verifiedOrgPolicyProjectionActions(applied, policy))),
      applied,
    );

    policy.governance.authority.decisions = [];
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(policy));
    const check = await orgPolicyEffectiveCheck(applied);
    expect(check).toMatchObject({
      verdict: "fail",
      detail: expect.stringContaining("retained-invalid-decision"),
    });
  });

  it("refuses malformed or non-object pre-existing hook settings without taking ownership", async () => {
    for (const { contents, detail } of [
      { contents: "{", detail: "is malformed" },
      { contents: "[]", detail: "is not a JSON object" },
      { contents: JSON.stringify({ hooks: [] }), detail: ".hooks is not an object" },
    ]) {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", "settings.json"), contents);

      await expect(
        verifiedOrgPolicyProjectionActions(ctx(), usageHookPolicy("active")),
      ).rejects.toThrow(detail);
      expect(existsSync(join(dir, ".aih", "org-policy-hook-receipt.json"))).toBe(false);
    }
  });

  it("rejects a parsable hook receipt that omits a required ownership entry", async () => {
    const applied = ctx({ apply: true });
    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active"))),
      ),
      applied,
    );
    const receiptPath = join(dir, ".aih", "org-policy-hook-receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      entries: Array<{ path: string }>;
    };
    receipt.entries = receipt.entries.filter((entry) => entry.path !== ".gitignore");
    writeFileSync(receiptPath, JSON.stringify(receipt));

    await expect(
      verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("disabled")),
    ).rejects.toThrow(/does not prove exactly one host entry per selected target/);
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
  });

  it("rejects malformed hook receipt identities and ownership entries before rollback", async () => {
    const applied = ctx({ apply: true });
    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active"))),
      ),
      applied,
    );
    const receiptPath = join(dir, ".aih", "org-policy-hook-receipt.json");
    const baseline = readFileSync(receiptPath, "utf8");
    type MutableHookReceipt = {
      format: string;
      hooks: Array<{ id: string; sourceDigest: string; targets: string[] }>;
      entries: Array<Record<string, unknown>>;
    };
    const cases: Array<{
      detail: RegExp;
      mutate: (receipt: MutableHookReceipt) => void;
    }> = [
      {
        detail: /not an AIH policy hook receipt/,
        mutate: (receipt) => {
          receipt.format = "untrusted-hook-receipt";
        },
      },
      {
        detail: /invalid hook identity entries/,
        mutate: (receipt) => {
          const hook = receipt.hooks[0];
          if (hook === undefined) throw new Error("missing hook identity");
          hook.id = "usage-metering-alias";
        },
      },
      {
        detail: /duplicate hook identities/,
        mutate: (receipt) => {
          const hook = receipt.hooks[0];
          if (hook === undefined) throw new Error("missing hook identity");
          receipt.hooks.push({ ...hook });
        },
      },
      {
        detail: /conflicting ownership entries/,
        mutate: (receipt) => {
          const entry = receipt.entries[0];
          if (entry === undefined) throw new Error("missing receipt entry");
          receipt.entries.push({ ...entry });
        },
      },
      {
        detail: /invalid ownership entries/,
        mutate: (receipt) => {
          const entry = receipt.entries[0];
          if (entry === undefined) throw new Error("missing receipt entry");
          entry.kind = "untrusted-write";
        },
      },
      {
        detail: /does not match the AIH hook generator/,
        mutate: (receipt) => {
          const entry = receipt.entries.find((item) => item.path === ".claude/settings.json");
          if (entry === undefined) throw new Error("missing Claude hook entry");
          entry.expectedPostToolUse = [];
        },
      },
      {
        detail: /unsafe hook ownership entries/,
        mutate: (receipt) => {
          const entry = receipt.entries.find((item) => item.path === ".claude/settings.json");
          if (entry === undefined) throw new Error("missing Claude hook entry");
          entry.path = ".claude/unmanaged-hooks.json";
        },
      },
      {
        detail: /unsafe text ownership entries/,
        mutate: (receipt) => {
          const entry = receipt.entries.find((item) => item.path === ".gitignore");
          if (entry === undefined) throw new Error("missing ignore entry");
          entry.path = ".aih/unmanaged-policy-marker";
        },
      },
    ];
    for (const { detail, mutate } of cases) {
      const receipt = JSON.parse(baseline) as MutableHookReceipt;
      mutate(receipt);
      writeFileSync(receiptPath, JSON.stringify(receipt));
      await expect(
        verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("disabled")),
      ).rejects.toThrow(detail);
      expect(existsSync(join(dir, ".aih", "usage-record.mjs"))).toBe(true);
    }
  });

  it("rejects malformed hook receipt bytes and incomplete receipt arrays before ownership reads", async () => {
    mkdirSync(join(dir, ".aih"), { recursive: true });
    const receiptPath = join(dir, ".aih", "org-policy-hook-receipt.json");
    for (const { contents, detail } of [
      { contents: "{malformed", detail: "is malformed; refusing hook ownership" },
      {
        contents: JSON.stringify({
          format: "aih-org-policy-hook-receipt",
          version: 2,
          hooks: {},
          entries: [],
        }),
        detail: "has incomplete ownership entries",
      },
    ]) {
      writeFileSync(receiptPath, contents);
      await expect(
        verifiedOrgPolicyProjectionActions(ctx(), usageHookPolicy("disabled")),
      ).rejects.toThrow(detail);
    }
  });

  it("rejects a non-regular host hook path instead of treating it as writable policy state", async () => {
    mkdirSync(join(dir, ".claude", "settings.json"), { recursive: true });

    await expect(
      verifiedOrgPolicyProjectionActions(ctx(), usageHookPolicy("active")),
    ).rejects.toThrow(/not a regular, AIH-safe policy hook path/);
    expect(existsSync(join(dir, ".aih", "org-policy-hook-receipt.json"))).toBe(false);
  });

  it("refuses to replace a receipt-owned hook selection without a conservative deactivation", async () => {
    const applied = ctx({ apply: true, targets: ["claude", "codex"] });
    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(
          applied,
          usageHookPolicy("active", ["claude"]),
        )),
      ),
      applied,
    );

    await expect(
      verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active", ["codex"])),
    ).rejects.toThrow(/owns a different hook selection; deactivate it first/);
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(dir, ".codex", "hooks.json"))).toBe(false);
  });

  it("reports clean active policy-hook receipt state and refuses the unverified projector entry point", async () => {
    const applied = ctx({ apply: true });
    const policy = usageHookPolicy("active");
    await executePlan(
      plan("policy hooks", ...(await verifiedOrgPolicyProjectionActions(applied, policy))),
      applied,
    );
    const hook = policy.governance?.catalog.reviewed[0];
    if (hook?.source.type !== "hook") throw new Error("missing reviewed hook control");
    const control = {
      id: hook.id,
      kind: "hook" as const,
      source: hook.source,
      targets: hook.targets,
      projector: hook.projector,
      lifecycle: hook.lifecycle,
    };
    const effective = resolveEffectiveOrgPolicy(policy, {
      targets: ["claude"],
      aihReviewedControls: {
        [hook.id]: { control, controlDigest: reviewedControlDigest(control) },
      },
      hookIdentities: {
        "usage-metering": { scriptDigest: hook.source.scriptDigest, projectable: true },
      },
    });
    expect(orgPolicyHookReceiptState(applied, effective)).toMatchObject({ state: "active" });
    expect(() => orgPolicyProjectionActions(applied, policy)).toThrow(
      /requires externally verified authority/,
    );
  });

  it("classifies malformed, invalid, unowned, and missing managed-MCP receipt states without projecting", async () => {
    const policy = reviewedMcpPolicy({ allowedServers: [], disabledServers: [] });
    const applied = ctx({ apply: true });
    await executePlan(
      plan("governed MCP", ...(await verifiedOrgPolicyProjectionActions(applied, policy))),
      applied,
    );
    const markerPath = join(dir, ".aih-config.json");
    const settingsPath = join(dir, ".claude", "managed-settings.json");
    const marker = readFileSync(markerPath, "utf8");
    const settings = readFileSync(settingsPath, "utf8");

    writeFileSync(markerPath, "{malformed");
    expect(managedMcpProjectionState(dir)).toMatchObject({ state: "malformed" });

    const unowned = JSON.parse(marker) as Record<string, unknown>;
    delete unowned.managedMcpProjection;
    writeFileSync(markerPath, JSON.stringify(unowned));
    expect(managedMcpProjectionState(dir)).toMatchObject({ state: "missing" });

    const invalid = JSON.parse(marker) as Record<string, unknown>;
    invalid.managedMcpProjection = { state: "untrusted" };
    writeFileSync(markerPath, JSON.stringify(invalid));
    expect(managedMcpProjectionState(dir)).toMatchObject({ state: "malformed" });

    writeFileSync(markerPath, marker);
    rmSync(settingsPath);
    expect(managedMcpProjectionState(dir)).toMatchObject({ state: "missing" });
    writeFileSync(settingsPath, settings);
  });

  it("refuses activation when an unreceipted legacy host hook already occupies the governed slot", async () => {
    const generated = usageHookActions(ctx(), ["claude"]).find(
      (action): action is WriteAction =>
        action.kind === "write" && action.path === ".claude/settings.json",
    );
    if (generated?.json === undefined) throw new Error("missing generated Claude hook");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(generated.json));

    await expect(
      verifiedOrgPolicyProjectionActions(ctx(), usageHookPolicy("active")),
    ).rejects.toThrow(/unreceipted matching PostToolUse/);
    expect(existsSync(join(dir, ".aih", "org-policy-hook-receipt.json"))).toBe(false);
  });

  it("refuses to append a policy marker over ambiguous AIH-shaped ignore rules", async () => {
    writeFileSync(join(dir, ".gitignore"), ".aih/*\n");

    await expect(
      verifiedOrgPolicyProjectionActions(ctx(), usageHookPolicy("active")),
    ).rejects.toThrow(/ambiguous policy-hook ownership/);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".aih/*\n");
  });

  it("removes an unchanged AIH-owned hook round trip using its receipt-proven state", async () => {
    const applied = ctx({ apply: true });
    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active"))),
      ),
      applied,
    );
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(dir, ".aih", "usage-record.mjs"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);

    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("disabled"))),
      ),
      applied,
    );
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(dir, ".aih", "usage-record.mjs"))).toBe(false);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    expect(existsSync(join(dir, ".aih", "org-policy-hook-receipt.json"))).toBe(false);
  });

  it("rejects a forged recorder receipt digest before it can claim ownership", async () => {
    const applied = ctx({ apply: true });
    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active"))),
      ),
      applied,
    );
    const receiptPath = join(dir, ".aih", "org-policy-hook-receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      entries: Array<{ path: string; expectedDigest?: string }>;
    };
    const recorder = receipt.entries.find((entry) => entry.path === ".aih/usage-record.mjs");
    if (recorder === undefined) throw new Error("missing recorder receipt entry");
    recorder.expectedDigest = "0".repeat(64);
    writeFileSync(receiptPath, JSON.stringify(receipt));

    await expect(
      verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("disabled")),
    ).rejects.toThrow(/unsafe text ownership entries/);
  });

  it("rejects a tampered v3 receipt before it can authorize an arbitrary .gitignore digest", async () => {
    const applied = ctx({ apply: true });
    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active"))),
      ),
      applied,
    );
    const arbitrary = "user-rule\n";
    writeFileSync(join(dir, ".gitignore"), arbitrary);
    const receiptPath = join(dir, ".aih", "org-policy-hook-receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      entries: Array<{ path: string; expectedDigest?: string }>;
    };
    const ignore = receipt.entries.find((entry) => entry.path === ".gitignore");
    if (ignore === undefined) throw new Error("missing .gitignore receipt entry");
    ignore.expectedDigest = createHash("sha256").update(arbitrary, "utf8").digest("hex");
    writeFileSync(receiptPath, JSON.stringify(receipt));

    await expect(
      verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("disabled")),
    ).rejects.toThrow(/invalid v3 self-digest/);
  });

  it("blocks inactive policy projection when matching legacy usage artifacts have no receipt", async () => {
    const codex = usageHookActions(ctx(), ["codex"]).find(
      (action): action is WriteAction =>
        action.kind === "write" && action.path === ".codex/hooks.json",
    );
    if (codex?.json === undefined) throw new Error("missing generated Codex hook");
    mkdirSync(join(dir, ".aih"), { recursive: true });
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".aih", "usage-record.mjs"), usageRecorderScript());
    writeFileSync(join(dir, ".codex", "hooks.json"), JSON.stringify(codex.json));

    await expect(
      verifiedOrgPolicyProjectionActions(ctx(), usageHookPolicy("disabled")),
    ).rejects.toThrow(/unreceipted matching usage recorder/);
  });

  it("refuses receipt drift during hook deactivation without emitting partial rollback actions", async () => {
    const applied = ctx({ apply: true });
    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active"))),
      ),
      applied,
    );
    writeFileSync(join(dir, ".aih", "usage-record.mjs"), "user-modified\n");

    await expect(
      verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("disabled")),
    ).rejects.toThrow(/recorder drifted from the exact AIH recorder/);
    expect(existsSync(join(dir, ".aih", "org-policy-hook-receipt.json"))).toBe(true);
  });

  it("detects an extra unreceipted Codex hook beside an otherwise active Claude-only receipt", async () => {
    const applied = ctx({ apply: true, targets: ["claude"] });
    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(
          applied,
          usageHookPolicy("active", ["claude"]),
        )),
      ),
      applied,
    );
    const codex = usageHookActions(ctx(), ["codex"]).find(
      (action): action is WriteAction =>
        action.kind === "write" && action.path === ".codex/hooks.json",
    );
    if (codex?.json === undefined) throw new Error("missing generated Codex hook");
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex", "hooks.json"), JSON.stringify(codex.json));

    await expect(
      verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active", ["claude"])),
    ).rejects.toThrow(/unreceipted matching PostToolUse/);
  });

  it("restores an unchanged pre-existing .gitignore exactly during hook rollback", async () => {
    const originalIgnore = "node_modules/\n# user-maintained rule\n";
    writeFileSync(join(dir, ".gitignore"), originalIgnore);
    const applied = ctx({ apply: true });
    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active"))),
      ),
      applied,
    );
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("# aih-managed");

    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("disabled"))),
      ),
      applied,
    );
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(originalIgnore);
    expect(existsSync(join(dir, ".aih", "org-policy-hook-receipt.json"))).toBe(false);
  });

  it("fails closed instead of partially deactivating a user-edited owned hook", async () => {
    const applied = ctx({ apply: true });
    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active"))),
      ),
      applied,
    );
    const hostPath = join(dir, ".claude", "settings.json");
    const changed = JSON.parse(readFileSync(hostPath, "utf8")) as {
      hooks: { PostToolUse: unknown[] };
    };
    changed.hooks.PostToolUse.push({
      matcher: "*",
      hooks: [{ type: "command", command: "user-owned-hook" }],
    });
    writeFileSync(hostPath, JSON.stringify(changed));

    await expect(
      verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("disabled")),
    ).rejects.toThrow(
      /refusing conservative policy-hook rollback.*receipt-owned PostToolUse hook changed/,
    );
    expect(readFileSync(hostPath, "utf8")).toContain("user-owned-hook");
    expect(existsSync(join(dir, ".aih", "org-policy-hook-receipt.json"))).toBe(true);
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(usageHookPolicy("disabled")));
    const check = await orgPolicyEffectiveCheck(applied);
    expect(check).toMatchObject({ verdict: "fail", code: "org-policy.effective-blocked" });
    expect(check.detail).toContain("conservative rollback");
  });

  it("rejects malformed empty hook receipts in policy evaluation and doctor", async () => {
    mkdirSync(join(dir, ".aih"), { recursive: true });
    writeFileSync(
      join(dir, ".aih", "org-policy-hook-receipt.json"),
      JSON.stringify({ format: "aih-org-policy-hook-receipt", version: 2, hooks: [], entries: [] }),
    );
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(usageHookPolicy("disabled")));
    const check = await orgPolicyEffectiveCheck(ctx());
    expect(check).toMatchObject({ verdict: "fail", code: "org-policy.effective-blocked" });
    expect(check.detail).toContain("no owned hook identity");
  });

  it("restores pre-existing Claude and Codex host configs without leaving an empty hooks object", async () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(join(dir, ".codex"), { recursive: true });
    const claude = { permissions: { allow: ["Read"] } };
    const codex = { approvalPolicy: "untrusted" };
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(claude));
    writeFileSync(join(dir, ".codex", "hooks.json"), JSON.stringify(codex));
    const applied = ctx({ apply: true, targets: ["claude", "codex"] });

    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(
          applied,
          usageHookPolicy("active", ["claude", "codex"]),
        )),
      ),
      applied,
    );
    expect(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"))).toHaveProperty(
      "hooks",
    );
    expect(JSON.parse(readFileSync(join(dir, ".codex", "hooks.json"), "utf8"))).toHaveProperty(
      "hooks",
    );

    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(
          applied,
          usageHookPolicy("disabled", ["claude", "codex"]),
        )),
      ),
      applied,
    );
    expect(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"))).toEqual(claude);
    expect(JSON.parse(readFileSync(join(dir, ".codex", "hooks.json"), "utf8"))).toEqual(codex);
  });

  it("refuses a matching hook receipt when a host artifact moves behind a symlinked parent", async () => {
    const applied = ctx({ apply: true });
    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active"))),
      ),
      applied,
    );
    const external = mkdtempSync(join(tmpdir(), "aih-hook-external-"));
    copyFileSync(join(dir, ".claude", "settings.json"), join(external, "settings.json"));
    rmSync(join(dir, ".claude"), { recursive: true, force: true });
    symlinkSync(external, join(dir, ".claude"), "junction");

    await expect(
      verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active")),
    ).rejects.toThrow(/unsafe symlinked parent/);
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(usageHookPolicy("active")));
    const check = await orgPolicyEffectiveCheck(applied);
    expect(check).toMatchObject({ verdict: "fail", code: "org-policy.effective-blocked" });
  });

  it("refuses a matching hook receipt reached through a symlinked .aih parent", async () => {
    const applied = ctx({ apply: true });
    await executePlan(
      plan(
        "policy hooks",
        ...(await verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active"))),
      ),
      applied,
    );
    const external = mkdtempSync(join(tmpdir(), "aih-receipt-external-"));
    const linked = join(dir, ".aih");
    copyFileSync(
      join(linked, "org-policy-hook-receipt.json"),
      join(external, "org-policy-hook-receipt.json"),
    );
    copyFileSync(join(linked, "usage-record.mjs"), join(external, "usage-record.mjs"));
    rmSync(linked, { recursive: true, force: true });
    symlinkSync(external, linked, "junction");

    await expect(
      verifiedOrgPolicyProjectionActions(applied, usageHookPolicy("active")),
    ).rejects.toThrow(/unsafe symlinked parent/);
  });

  it("blocks standalone generic usage and MCP mutation when governance exists", async () => {
    writeFileSync(join(dir, "aih-org-policy.json"), JSON.stringify(usageHookPolicy("disabled")));
    await expect(usageCommand.plan(ctx())).rejects.toThrow(
      /governance exclusively owns AIH usage projection/,
    );
    await expect(mcpCommand.plan(ctx())).rejects.toThrow(
      /governance exclusively owns AIH mcp projection/,
    );
  });
});

/**
 * `verifyPolicyAuthorityReceipt` runs on every invocation, so its "registry unavailable"
 * problem used to be appended to EVERY blocked-candidate refusal regardless of why the
 * candidate blocked. An operator whose candidates were merely target-unselected got sent
 * chasing AIH_POLICY_AUTHORITY_REPOSITORY, then watched the note vanish once the selection
 * was fixed — not because the registry became reachable, but because nothing threw.
 */
describe("policy project — authority note is not a cascade", () => {
  /** Minimal blocked-candidate shape; only the code arrays drive the suffix. */
  const blockedWith = (codes: string[]) =>
    ({
      authorityProblem: "external organization authority registry is unavailable",
      effective: {
        candidates: [{ requested: true, effective: false, dangerCodes: codes, blockingCodes: [] }],
      },
    }) as never;

  it("omits the note when the block has nothing to do with authority", () => {
    // The reporter's exact case: candidates blocked purely on target coverage.
    expect(authoritySuffix(blockedWith(["missing-projector", "unsupported-target"]))).toBe("");
  });

  it("reports the note when the block itself depends on the registry", () => {
    expect(authoritySuffix(blockedWith(["evidence-missing"]))).toContain("authority:");
    expect(authoritySuffix(blockedWith(["authority-receipt-unverified"]))).toContain("authority:");
    expect(authoritySuffix(blockedWith(["approval-expired"]))).toContain("authority:");
  });

  it("omits the note when the registry is available, whatever the block", () => {
    expect(authoritySuffix({ effective: { candidates: [] } } as never)).toBe("");
  });

  /** End-to-end: a real authority-dependent block still surfaces the note. */
  it("still surfaces the note through the real projection path", async () => {
    await expect(
      verifiedOrgPolicyProjectionActions(
        ctx({ env: { AIH_POLICY_AUTHORITY_REPOSITORY: "" }, targets: ["claude"] }),
        customPolicy(["claude"]),
      ),
    ).rejects.toThrow(/authority: external organization authority registry is unavailable/);
  });
});
