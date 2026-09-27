import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as core from "../../src/index.js";

const PROTECTED_HELPER = resolve("tools/lib/build-protected-policy-fixture.mjs");
const MCP_HELPER = resolve("tools/lib/build-mcp-policy-fixture.mjs");
const ZERO = `sha256:${"0".repeat(64)}`;

type Helper = (input: Record<string, unknown>) => unknown;
let buildProtectedPolicyFixture: Helper;
let buildMcpPolicyFixture: Helper;
const run = async (helper: Helper, input: Record<string, unknown>) => helper(input);

beforeAll(async () => {
  ({ buildProtectedPolicyFixture } = await import(pathToFileURL(PROTECTED_HELPER).href));
  ({ buildMcpPolicyFixture } = await import(pathToFileURL(MCP_HELPER).href));
});

let fixtureRoot: string | undefined;
function tempDir(): string {
  fixtureRoot = mkdtempSync(join(tmpdir(), "aih-headless-fixture-"));
  return fixtureRoot;
}
afterEach(() => {
  if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

// Decision V2 and receipt V3 fixtures from tests/config/policy-authority-receipt-v3-public-api.test.ts.
const source = {
  type: "aih" as const,
  release: "0.6.0",
  revision: "sha256:32ce6e9dea74ba84fe56b71ba6516e032f18aa4132e6ef7ebca507512d8735f7",
};
const sourceDigest = core.governanceDecisionSourceDigestV2(source);
const evidenceDigest = `sha256:${"d".repeat(64)}`;
const attestor = "test-organization";
const decision = core.parseGovernanceDecisionV2({
  format: "aih-governance-decision",
  version: 2,
  id: "decision-observe-governance-quality",
  disposition: "approved",
  qualificationBasis: { kind: "organization-qualified", evidenceDigest, attestor },
  subject: {
    kind: "agent",
    id: "governance-quality",
    source,
    sourceDigest,
    subjectDigest: core.governanceDecisionSubjectDigestV2({
      kind: "agent",
      id: "governance-quality",
      sourceDigest,
    }),
  },
  targets: ["claude"],
  allowedEffects: ["observe"],
  policy: { id: "test-policy", version: "1", digest: `sha256:${"e".repeat(64)}` },
  control: { id: "test-control", digest: `sha256:${"f".repeat(64)}` },
  evidence: { id: "scanner-evidence-v2", digest: evidenceDigest, attestor },
  issuer: "test-issuer",
  actor: "test-operator",
  reason: "Validation example only; operator-provided authority, not production approval.",
  issuedAt: "2026-09-20T00:00:00.000Z",
  notBefore: "2026-09-20T00:00:00.000Z",
  expiresAt: "2026-09-27T00:00:00.000Z",
  acceptedFindings: [],
  acceptedGaps: [],
  conditions: [],
});
function receiptFor(targets: string[]) {
  return core.PolicyAuthorityReceiptV3Schema.parse({
    format: "aih-policy-authority-receipt",
    version: 3,
    issuerRepository: "example-org/policy-authority",
    issuedAt: "2026-09-20T00:00:00.000Z",
    expiresAt: "2026-09-27T00:00:00.000Z",
    trustedIssuers: [{ id: "test-issuer", githubRepository: "example-org/policy-authority" }],
    targets,
    decisions: [decision],
    decisionRevocations: [],
  });
}
const receipt = receiptFor(["claude"]);

// Enterprise policy shape from tests/org-policy/bundle.test.ts.
const protectedPolicy = {
  schemaVersion: 2,
  minimumPosture: "enterprise",
  references: { repoContract: "ai-coding/project.json" },
  governance: {
    policyVersion: "2026.08",
    catalog: { reviewed: [], custom: [] },
    supportedClis: ["claude"],
  },
};

// Governed MCP shape from tests/org-policy/governed-mcp-targets.test.ts.
const MCP_TARGETS = ["claude", "codex"];
const mcpPolicy = {
  schemaVersion: 2,
  minimumPosture: "enterprise",
  references: { repoContract: "ai-coding/project.json" },
  mcp: { allowManagedOnly: true },
  governance: {
    policyVersion: "2026.08.0",
    supportedClis: MCP_TARGETS,
    catalog: {
      reviewed: [
        {
          id: "catalog-mcp",
          kind: "mcp",
          source: {
            type: "mcp",
            server: "catalog-mcp",
            subject: `mcp-server-sha256:${"a".repeat(64)}`,
          },
          targets: MCP_TARGETS,
          projector: "mcp-managed-settings",
          lifecycle: "supported",
          description: "A reviewed MCP",
          evidence: { record: "aih-catalog-mcp" },
        },
      ],
      custom: [],
    },
    activations: [{ candidate: "catalog-mcp", state: "active", targets: MCP_TARGETS }],
    authority: { approvals: [] },
  },
};
const mcpReceipt = receiptFor(MCP_TARGETS);

const malformedDecision = { ...decision, subject: { ...decision.subject, subjectDigest: ZERO } };

describe("buildProtectedPolicyFixture", () => {
  const input = (outputPath: string) => ({
    core,
    basePolicy: protectedPolicy,
    outputPath,
    bundleVersion: "fixture-1",
    issuer: "platform-security",
    authorityReceipt: receipt,
  });

  it("writes the exact Core-valid protected bundle deterministically", async () => {
    const dir = tempDir();
    const outputPath = join(dir, "policy-bundle.json");
    const expected = {
      schemaVersion: 2,
      bundleVersion: "fixture-1",
      issuer: "platform-security",
      issuedAt: receipt.issuedAt,
      policy: protectedPolicy,
      authorityReceipt: receipt,
    };
    const bundle = (await run(buildProtectedPolicyFixture, input(outputPath))) as typeof expected;
    expect(bundle).toStrictEqual(expected);
    expect(core.parsePolicyBundle(bundle)).toMatchObject({ ok: true });
    const written = readFileSync(outputPath);
    expect(JSON.parse(written.toString("utf8"))).toStrictEqual(expected);
    expect(core.governanceDecisionDigestV2(bundle.authorityReceipt.decisions[0] ?? decision)).toBe(
      core.governanceDecisionDigestV2(decision),
    );
    const againPath = join(dir, "again.json");
    await run(buildProtectedPolicyFixture, input(againPath));
    expect(readFileSync(againPath).equals(written)).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a malformed receipt", { authorityReceipt: { ...receipt, version: 4 } }],
    [
      "a malformed Decision V2",
      { authorityReceipt: { ...receipt, decisions: [malformedDecision] } },
    ],
    [
      "a decision outside the receipt targets",
      { authorityReceipt: { ...receipt, decisions: [{ ...decision, targets: ["codex"] }] } },
    ],
    [
      "a non-enterprise base policy",
      { basePolicy: { ...protectedPolicy, minimumPosture: "vibe" } },
    ],
    ["a core without public validators", { core: {} }],
  ])("refuses %s without writing output", async (_name, overrides) => {
    const outputPath = join(tempDir(), "policy-bundle.json");
    await expect(
      run(buildProtectedPolicyFixture, { ...input(outputPath), ...overrides }),
    ).rejects.toThrow();
    expect(existsSync(outputPath)).toBe(false);
  });
});

describe("buildMcpPolicyFixture", () => {
  const input = {
    core,
    basePolicy: mcpPolicy,
    targets: ["codex", "claude"],
    servers: ["catalog-mcp"],
  };

  it("returns the exact validated policy when no authority receipt is supplied", async () => {
    expect(await run(buildMcpPolicyFixture, input)).toStrictEqual(mcpPolicy);
  });

  it("embeds the exact receipt in a Core-valid protected bundle", async () => {
    const bundle = (await run(buildMcpPolicyFixture, {
      ...input,
      authorityReceipt: mcpReceipt,
    })) as Record<string, unknown>;
    // Only Core validity and the exact policy/receipt are pinned; envelope naming is the helper's.
    expect(core.parsePolicyBundle(bundle)).toMatchObject({ ok: true });
    expect(bundle).toMatchObject({ schemaVersion: 2, issuedAt: mcpReceipt.issuedAt });
    expect(bundle.policy).toStrictEqual(mcpPolicy);
    expect(bundle.authorityReceipt).toStrictEqual(mcpReceipt);
  });

  it.each<[string, Record<string, unknown>]>([
    ["an unknown server", { servers: ["unknown-mcp"] }],
    ["an extra server", { servers: ["catalog-mcp", "unknown-mcp"] }],
    ["a narrower target set", { targets: ["claude"] }],
    ["a wider target set", { targets: ["claude", "codex", "cursor"] }],
    ["a receipt with mismatched targets", { authorityReceipt: receiptFor(["claude"]) }],
    ["a malformed receipt", { authorityReceipt: { ...mcpReceipt, version: 4 } }],
    [
      "a malformed Decision V2",
      { authorityReceipt: { ...mcpReceipt, decisions: [malformedDecision] } },
    ],
    ["a core without public validators", { core: {} }],
  ])("refuses %s", async (_name, overrides) => {
    await expect(run(buildMcpPolicyFixture, { ...input, ...overrides })).rejects.toThrow();
  });

  // Custom stdio MCP shape from tests/org-policy/governed-mcp-targets.test.ts.
  it.each([
    ["with", true],
    ["without", false],
  ])("refuses a surplus Core-valid custom MCP candidate %s activation", async (_name, active) => {
    const surplus = {
      ...mcpPolicy.governance.catalog.reviewed[0],
      id: "custom-mcp",
      source: {
        type: "stdio",
        resolver: "npx",
        registry: "https://registry.npmjs.org",
        package: "example-mcp",
        version: "1.2.3",
        integrity: `sha256:${"b".repeat(64)}`,
      },
    };
    const expanded = {
      ...mcpPolicy,
      governance: {
        ...mcpPolicy.governance,
        catalog: { reviewed: mcpPolicy.governance.catalog.reviewed, custom: [surplus] },
        activations: [
          ...mcpPolicy.governance.activations,
          ...(active ? [{ candidate: "custom-mcp", state: "active", targets: MCP_TARGETS }] : []),
        ],
      },
    };
    expect(
      core.parsePolicyBundle({
        schemaVersion: 1,
        bundleVersion: "validation-only",
        issuer: "validation-only",
        issuedAt: "1970-01-01T00:00:00Z",
        policy: expanded,
      }),
    ).toMatchObject({ ok: true });
    await expect(run(buildMcpPolicyFixture, { ...input, basePolicy: expanded })).rejects.toThrow();
  });
});

describe("headless fixture helper boundary", () => {
  it.each([PROTECTED_HELPER, MCP_HELPER])(
    "%s imports only Node builtins and has no browser or private Core route",
    (path) => {
      const text = readFileSync(path, "utf8");
      const specifiers = [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/gu)].map(
        (match) => match[1] ?? "",
      );
      expect(specifiers.filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
      expect(text).not.toMatch(
        /happy-dom|jsdom|<script|<html|\bwindow\b|document\.|getElementById|createRequire|policy generate|@aihq\/core|\/src\/|\/dist\//u,
      );
    },
  );
});
