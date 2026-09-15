import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  PolicyAuthorityReceiptSchema,
  verifyPolicyAuthorityReceipt,
} from "../../src/org-policy/authority.js";
import { aihPolicyControls, policyAuthoringHosts } from "../../src/org-policy/catalog.js";
import {
  type AiReviewedControl,
  candidateIdentityDigest,
  resolveEffectiveOrgPolicy,
  reviewedControlDigest,
} from "../../src/org-policy/effective.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const TARGETS = ["claude", "codex", "cursor", "copilot", "opencode", "kimi", "kiro"] as const;
const SUBJECT = `mcp-server-sha256:${"a".repeat(64)}`;
const LEGACY_DIGEST = "sha256:de871d928296194e8d259f7d7642cfd638e4c24186bdaf34d1190c0fea90df6f";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected test fixture value");
  return value;
}

function control(targets: readonly string[]) {
  return {
    id: "catalog-mcp",
    kind: "mcp" as const,
    source: { type: "mcp" as const, server: "catalog-mcp", subject: SUBJECT },
    targets: [...targets],
    projector: "mcp-managed-settings" as const,
    lifecycle: "supported" as const,
  };
}

function policy(targets: readonly string[], selected = targets, overrides = {}) {
  const parsed = parseOrgPolicy({
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    mcp: { allowManagedOnly: true },
    governance: {
      policyVersion: "2026.08.0",
      supportedClis: [...selected],
      catalog: {
        reviewed: [
          {
            ...control(targets),
            description: "A reviewed MCP",
            evidence: { record: "aih-catalog-mcp" },
            ...overrides,
          },
        ],
        custom: [],
      },
      activations: [{ candidate: "catalog-mcp", state: "active", targets: [...selected] }],
      authority: { approvals: [] },
    },
  });
  return { ...parsed, governance: required(parsed.governance) };
}

function context(targets: readonly string[] = TARGETS) {
  const shipped = control(TARGETS) as AiReviewedControl;
  return {
    targets,
    aihReviewedControls: {
      "catalog-mcp": { control: shipped, controlDigest: reviewedControlDigest(shipped) },
    },
    mcpIdentities: {
      "catalog-mcp": { subject: SUBJECT, projectable: true, kiroProjectable: true },
    },
  };
}

describe("governed MCP target contracts", () => {
  it("authors all seven native MCP hosts while preserving hook capabilities", () => {
    expect(
      policyAuthoringHosts()
        .filter((host) => host.policyTarget)
        .map((host) => host.id)
        .sort(),
    ).toEqual([...TARGETS].sort());
    for (const item of aihPolicyControls()) {
      expect([...item.targets].sort()).toEqual(
        item.kind === "mcp" ? [...TARGETS].sort() : ["claude", "codex"],
      );
    }
  });

  it.each(TARGETS)("resolves an exactly reviewed MCP for %s", (target) => {
    const value = policy(TARGETS, [target]);
    const effective = resolveEffectiveOrgPolicy(value, context([target]));
    expect(effective.candidates[0]).toMatchObject({
      effective: true,
      evidence: "verified",
      projection: { requestedTargets: [target], coverage: "complete" },
    });
  });

  it.each(TARGETS)("keeps custom stdio declarations authorable only for %s", (target) => {
    const value = policy(TARGETS, [target]);
    const custom = {
      ...required(value.governance.catalog.reviewed[0]),
      source: {
        type: "stdio",
        resolver: "npx",
        registry: "https://registry.npmjs.org",
        package: "example-mcp",
        version: "1.2.3",
        integrity: `sha256:${"b".repeat(64)}`,
      },
    };
    const customPolicy = parseOrgPolicy({
      ...value,
      governance: { ...value.governance, catalog: { reviewed: [], custom: [custom] } },
    });
    expect(resolveEffectiveOrgPolicy(customPolicy, context([target])).candidates[0]).toMatchObject({
      effective: false,
      projection: { supportedTargets: [], ownership: "unavailable" },
      resolutionReasons: ["custom-stdio-source-is-authorable-only"],
    });
  });

  it.each(TARGETS.filter((target) => target !== "kiro"))(
    "keeps remote declarations authorable only for %s",
    (target) => {
      const value = policy([target]);
      const custom = {
        ...required(value.governance.catalog.reviewed[0]),
        source: {
          type: "remote",
          origin: "https://mcp.figma.com",
          approval: {
            approvedBy: "security-admin",
            authenticationMode: "oauth",
            allowedDataClasses: ["design-metadata"],
          },
          administrativeStatus: "approved",
          contentScanned: false,
        },
      };
      const customPolicy = parseOrgPolicy({
        ...value,
        governance: { ...value.governance, catalog: { reviewed: [], custom: [custom] } },
      });
      expect(
        resolveEffectiveOrgPolicy(customPolicy, context([target])).candidates[0],
      ).toMatchObject({
        effective: false,
        projection: { supportedTargets: [], ownership: "unavailable" },
      });
    },
  );

  it.each(TARGETS.filter((target) => target !== "claude" && target !== "codex"))(
    "does not widen usage hook support to %s",
    (target) => {
      const value = policy([target]);
      const hook = required(aihPolicyControls().find((item) => item.kind === "hook"));
      expect(() =>
        parseOrgPolicy({
          ...value,
          governance: {
            ...value.governance,
            catalog: {
              reviewed: [
                { ...required(value.governance.catalog.reviewed[0]), ...hook, targets: [target] },
              ],
              custom: [],
            },
            activations: [{ candidate: hook.id, state: "active", targets: [target] }],
          },
        }),
      ).toThrow(/reviewed control targets must exactly match/);
    },
  );

  it("preserves the exact old digest and old target scope after the catalog expands", () => {
    const old = policy(["claude", "kiro"]);
    const candidate = required(old.governance.catalog.reviewed[0]);
    expect(reviewedControlDigest(candidate)).toBe(LEGACY_DIGEST);
    const effective = resolveEffectiveOrgPolicy(old, context());
    expect(effective.candidates[0]).toMatchObject({
      effective: true,
      evidence: "verified",
      projection: { requestedTargets: ["claude", "kiro"] },
    });
    expect(reviewedControlDigest(candidate)).toBe(LEGACY_DIGEST);
    expect(() => policy(["claude", "kiro"], ["codex"])).toThrow(/activation targets/);
  });

  it("does not treat arbitrary target subsets or altered old identities as shipped controls", () => {
    for (const targets of [["claude"], ["claude", "codex"], ["kiro"]]) {
      expect(resolveEffectiveOrgPolicy(policy(targets), context()).candidates[0]).toMatchObject({
        effective: false,
        evidence: "missing",
      });
    }
    for (const change of [
      { lifecycle: "deprecated" },
      { projector: "usage-hook" },
      {
        source: {
          type: "mcp",
          server: "catalog-mcp",
          subject: `mcp-server-sha256:${"b".repeat(64)}`,
        },
      },
    ]) {
      expect(
        resolveEffectiveOrgPolicy(policy(["claude", "kiro"], ["claude"], change), context())
          .candidates[0],
      ).toMatchObject({ effective: false, evidence: "missing" });
    }
    const invalid = context();
    invalid.aihReviewedControls["catalog-mcp"].controlDigest = LEGACY_DIGEST;
    expect(
      resolveEffectiveOrgPolicy(policy(["claude", "kiro"]), invalid).candidates[0]?.effective,
    ).toBe(false);
  });

  it.each([1, 2])(
    "parses expanded receipt targets without changing legacy receipt version %i",
    (version) => {
      const receipt = {
        format: "aih-policy-authority-receipt",
        version,
        issuerRepository: "acme/governance",
        issuedAt: "2026-08-01T00:00:00Z",
        expiresAt: "2026-08-31T00:00:00Z",
        trustedIssuers: [],
        evidence: [],
        approvals: [],
        revocations: [],
        targets: [...TARGETS].sort(),
        ...(version === 2 ? { decisions: [], decisionRevocations: [] } : {}),
      };
      expect(PolicyAuthorityReceiptSchema.parse(receipt).targets).toEqual([...TARGETS].sort());
    },
  );

  it("uses updated protected policy scope for clean built-ins without broadening receipt decisions", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-mcp-target-boundary-"));
    const admin = realpathSync.native(
      mkdtempSync(join(realpathSync.native(tmpdir()), "aih-mcp-target-authority-")),
    );
    try {
      const policyPath = join(admin, "policy-bundle.json");
      const permitted = TARGETS.filter((target) => target !== "copilot");
      const sixTargetPolicy = policy(TARGETS, permitted);
      const expandedPolicy = policy(TARGETS);
      const issuedAt = new Date(Date.now() - 60_000).toISOString();
      const receipt = {
        format: "aih-policy-authority-receipt",
        version: 3,
        issuerRepository: "acme/governance",
        issuedAt,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        targets: [...permitted].sort(),
        trustedIssuers: [{ id: "security", githubRepository: "acme/governance" }],
        decisions: [],
        decisionRevocations: [],
      };
      const run = fakeRunner(() => ({ code: 1, stderr: "unexpected external invocation" }));
      const verify = async (
        requested: ReturnType<typeof policy>,
        targets: readonly (typeof TARGETS)[number][] = receipt.targets,
      ) => {
        writeFileSync(
          policyPath,
          JSON.stringify({
            schemaVersion: 2,
            bundleVersion: "1",
            issuer: "Platform security",
            issuedAt,
            policy: requested,
            authorityReceipt: { ...receipt, targets },
          }),
        );
        const verified = await verifyPolicyAuthorityReceipt({
          root,
          contextDir: "ai-coding",
          posture: "enterprise",
          apply: false,
          verify: false,
          json: false,
          run,
          host: makeHostAdapter({ platform: "linux", run, env: {} }),
          env: { AIH_ORG_POLICY: policyPath },
          options: {},
        });
        expect(verified.problem).toBeUndefined();
        return required(verified.authority);
      };
      const originalAuthority = await verify(sixTargetPolicy);
      expect(
        resolveEffectiveOrgPolicy(sixTargetPolicy, {
          ...context(permitted),
          authority: originalAuthority,
        }).candidates[0]?.effective,
      ).toBe(true);

      // Replacing administrator-protected policy bytes is a new policy authorization.
      // Its clean built-ins do not borrow authority from unrelated receipt decisions.
      const unchangedScope = await verify(expandedPolicy);
      const expanded = resolveEffectiveOrgPolicy(expandedPolicy, {
        ...context(),
        authority: unchangedScope,
      });
      expect(expanded.candidates[0]).toMatchObject({
        effective: true,
        evidence: "verified",
        blockingCodes: [],
      });
      expect(expanded.activeMcpServerIds).toEqual(["catalog-mcp"]);
      expect(unchangedScope.receipt.targets).toEqual([...permitted].sort());
      expect(unchangedScope.receipt).toMatchObject({ version: 3, decisions: [] });

      const legacy = policy(["claude", "kiro"]);
      expect(
        resolveEffectiveOrgPolicy(legacy, { ...context(), authority: unchangedScope }).candidates[0]
          ?.effective,
      ).toBe(true);
      const expandedAuthority = await verify(expandedPolicy, [...TARGETS].sort());
      expect(
        resolveEffectiveOrgPolicy(expandedPolicy, { ...context(), authority: expandedAuthority })
          .candidates[0]?.effective,
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(admin, { recursive: true, force: true });
    }
  });

  it("honors the exact old signed control digest without extending the decision to new hosts", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-mcp-decision-targets-"));
    const bin = mkdtempSync(join(tmpdir(), "aih-mcp-decision-verifier-"));
    try {
      const ghFile = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
      writeFileSync(ghFile, "trusted verifier fixture", { mode: 0o755 });
      const trustedGh = realpathSync.native(ghFile);
      const run = fakeRunner((argv) =>
        argv[0] === trustedGh && argv[1] === "attestation" && argv[2] === "verify"
          ? { code: 0, stdout: "verified" }
          : { code: 1 },
      );
      const now = Date.now();
      const old = policy(["claude", "kiro"], ["claude"], { findings: ["prompt-injection"] });
      const candidate = required(old.governance.catalog.reviewed[0]);
      const decision = {
        format: "aih-governance-decision",
        version: 1,
        id: "decision-mcp-risk",
        disposition: "accepted-with-conditions",
        candidate: candidate.id,
        kind: "mcp",
        targets: ["claude"],
        effects: ["managed-settings"],
        policyVersion: old.governance.policyVersion,
        sourceDigest: candidateIdentityDigest(candidate),
        evidenceDigest: candidateIdentityDigest(candidate),
        reviewedControlDigest: LEGACY_DIGEST,
        issuer: "security",
        actor: "administrator",
        reason: "Accepted bounded finding.",
        acceptedFindings: ["prompt-injection"],
        acceptedGaps: [],
        conditions: ["Review before expiry."],
        issuedAt: new Date(now - 60_000).toISOString(),
        notBefore: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 86_400_000).toISOString(),
        reviewBy: new Date(now + 43_200_000).toISOString(),
      };
      mkdirSync(join(root, ".aih"));
      const verify = async (value: typeof decision) => {
        writeFileSync(
          join(root, ".aih/policy-authority-receipt.json"),
          JSON.stringify({
            format: "aih-policy-authority-receipt",
            version: 2,
            issuerRepository: "acme/governance",
            issuedAt: new Date(now - 30_000).toISOString(),
            expiresAt: new Date(now + 86_400_000).toISOString(),
            targets: [...TARGETS].sort(),
            trustedIssuers: [{ id: "security", githubRepository: "acme/governance" }],
            evidence: [],
            approvals: [],
            revocations: [],
            decisions: [value],
            decisionRevocations: [],
          }),
        );
        const verified = await verifyPolicyAuthorityReceipt({
          root,
          contextDir: "ai-coding",
          posture: "enterprise",
          apply: false,
          verify: false,
          json: false,
          run,
          host: makeHostAdapter({ platform: "linux", run, env: {} }),
          env: { PATH: bin, AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance" },
          options: {},
        });
        expect(verified.problem).toBeUndefined();
        expect(verified.authority).toBeDefined();
        return required(verified.authority);
      };
      old.governance.authority.decisions = [decision.id];
      const authority = await verify(decision);
      expect(
        resolveEffectiveOrgPolicy(old, { ...context(["claude"]), authority }).candidates[0]
          ?.effective,
      ).toBe(true);
      expect(reviewedControlDigest(candidate)).toBe(LEGACY_DIGEST);

      const expanded = policy(TARGETS, ["claude"], { findings: ["prompt-injection"] });
      expanded.governance.authority.decisions = [decision.id];
      const mismatch = resolveEffectiveOrgPolicy(expanded, { ...context(["claude"]), authority });
      expect(mismatch.candidates[0]?.effective).toBe(false);
      expect(mismatch.candidates[0]?.decisionBlockers).toContainEqual(
        expect.objectContaining({ code: "decision-control-mismatch" }),
      );

      const codex = policy(TARGETS, ["codex"], { findings: ["prompt-injection"] });
      codex.governance.authority.decisions = [decision.id];
      const newControlDigest = reviewedControlDigest(
        required(codex.governance.catalog.reviewed[0]),
      );
      const oldScopeAuthority = await verify({
        ...decision,
        reviewedControlDigest: newControlDigest,
      });
      expect(
        resolveEffectiveOrgPolicy(old, { ...context(["claude"]), authority: oldScopeAuthority })
          .candidates[0]?.effective,
      ).toBe(true);
      const scoped = resolveEffectiveOrgPolicy(codex, {
        ...context(["codex"]),
        authority: oldScopeAuthority,
      });
      expect(scoped.candidates[0]?.effective).toBe(false);
      expect(scoped.candidates[0]?.decisionBlockers).toContainEqual(
        expect.objectContaining({ code: "decision-scope-mismatch", field: "targets" }),
      );
      const newAuthority = await verify({
        ...decision,
        targets: ["codex"],
        reviewedControlDigest: newControlDigest,
      });
      expect(
        resolveEffectiveOrgPolicy(codex, { ...context(["codex"]), authority: newAuthority })
          .candidates[0]?.effective,
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
