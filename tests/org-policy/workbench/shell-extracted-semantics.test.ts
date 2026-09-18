/**
 * S0 unit tests for the semantics extracted from the legacy Workbench runtimes
 * (NEW-SHELL-PLAN.md §4). The legacy runtimes now call these modules; the DOM
 * characterization in `legacy-download-characterization.test.ts` pins the
 * end-to-end behaviour, these pin each extracted rule headlessly.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalGovernanceDecisionSourceV2,
  canonicalGovernanceDecisionSubjectV2,
  canonicalGovernanceDecisionV2,
  type GovernanceDecisionV2,
} from "../../../src/org-policy/governance-decision-v2.js";
import {
  base64ForBytes,
  bytesForBase64,
  opaqueEvidenceDraft,
  strictJson,
  validateIntake,
  validateOpaqueEvidenceDraft,
} from "../../../src/org-policy/workbench/ui/shell/artifact-intake-model.js";
import {
  activeManagedMcpServers,
  checkCommandArguments,
  deploymentReadinessBlockers,
  emptyGovernance,
  governanceGrammarErrors,
  governanceOrDefault,
  governanceTextErrors,
  kiroRemoteMcpErrors,
  managedMcpAuthorityErrors,
  migrateLegacyManagedMcp,
  narrowLegacyActivationTargets,
  type PolicyGrammarContext,
  type PolicyGrammarModel,
  preparePolicyImport,
  reconcileManagedMcpProjection,
  registryOriginErrors,
  sameCanonicalJson,
  serializePolicy,
  validatePolicy,
} from "../../../src/org-policy/workbench/ui/shell/policy-grammar.js";
import {
  protectedCanonicalTimestamp,
  protectedDigestPreimage,
  protectedEvidenceId,
  protectedStableJson,
  protectedStrictStrings,
} from "../../../src/org-policy/workbench/ui/shell/protected-digest.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

const githubControl = {
  id: "github",
  kind: "mcp",
  description: "AIH-provided governed control",
  capabilities: [],
  risks: [],
  source: { type: "mcp", server: "github" },
  targets: ["claude", "codex"],
  projector: "mcp-server",
  lifecycle: "supported",
  evidence: { record: "aih-github" },
  findings: [],
  autoExecute: false,
};

function model(overrides: Partial<PolicyGrammarModel> = {}): PolicyGrammarModel {
  const tiny = tinyStudioModel();
  return {
    schema: tiny.schema,
    catalog: { hosts: [{ id: "claude" }, { id: "codex" }] },
    workbenchBindings: { "mcp:github": { kind: "control", candidate: githubControl } },
    workbenchBundle: { assets: {} },
    ...overrides,
  };
}

function context(
  overrides: Partial<PolicyGrammarModel> = {},
  accepted = true,
): PolicyGrammarContext {
  return {
    model: model(overrides),
    selectionValidator: () => () => ({ accepted, diagnostics: accepted ? [] : ["blocked"] }),
  };
}

function managedPolicy(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minimumPosture: "enterprise",
    governance: {
      ...emptyGovernance(),
      supportedClis: ["claude", "codex"],
      catalog: { reviewed: [githubControl], custom: [] },
      activations: [
        {
          candidate: "github",
          state: "active",
          targets: ["claude", "codex"],
          clarification: "Requested by: enterprise profile",
        },
      ],
    },
    ...extra,
  };
}

describe("policy grammar (legacy nt/Pe/et/ot)", () => {
  it("serializes policy bytes as two-space JSON plus one newline", () => {
    expect(serializePolicy({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}\n');
  });

  it("returns governance as-is once it carries a version, else merges it over the empty block", () => {
    const versioned = { policyVersion: "7" };
    expect(governanceOrDefault(versioned)).toBe(versioned);
    expect(governanceOrDefault({ supportedClis: ["codex"] })).toEqual({
      ...emptyGovernance(),
      supportedClis: ["codex"],
    });
    expect(governanceOrDefault(undefined)).toEqual(emptyGovernance());
  });

  it("names the registry ids when enterprise posture has no CLI allow-list", () => {
    expect(
      governanceGrammarErrors({ minimumPosture: "enterprise", governance: {} }, model()),
    ).toEqual([
      "policy.governance.supportedClis: enterprise posture requires a non-empty explicit allow-list; current registry ids: claude, codex. Paste every id to sanction all supported CLIs; wildcard sentinels are not supported",
    ]);
  });

  it("requires activation targets to equal the sanctioned projector intersection", () => {
    const policy = managedPolicy();
    (policy.governance as { supportedClis: string[] }).supportedClis = ["codex"];
    expect(governanceGrammarErrors(policy, model())).toEqual([
      "policy.governance.activations[0].targets: activation targets for github must exactly match the organization-sanctioned projector targets: codex",
    ]);
  });

  it("treats external curation kind/id pairs as distinct only by the literal \\u0000 join", () => {
    const item = (kind: string, id: string) => ({
      kind,
      id,
      source: { path: "skills/a" },
      audit: { record: "audit-1" },
    });
    const errors = (items: unknown[]) =>
      governanceGrammarErrors(
        { governance: { externalCuration: [{ framework: "ecc", items }] } },
        model(),
      );
    expect(errors([item("skill", "a"), item("agent", "a")])).toEqual([]);
    expect(errors([item("skill", "a"), item("skill", "a")])).toEqual([
      "policy.governance.externalCuration[0].items: kind/id pairs must be unique",
    ]);
  });

  it("accepts exact registry-origin arguments and rejects unsafe command arguments", () => {
    const errors: string[] = [];
    checkCommandArguments(
      {
        type: "command",
        args: ["--registry=https://registry.npmjs.org", "../x", "--index-url=https://u:p@pypi.org"],
      },
      "source",
      errors,
    );
    expect(errors).toEqual([
      "source.args[1]: must be a safe relative argument",
      "source.args[2]: must be a safe relative argument",
    ]);
  });

  it("rejects remote MCP targeting Kiro, non-origin registries and hidden text", () => {
    const policy = {
      governance: {
        policyVersion: "1\u200b",
        catalog: {
          reviewed: [],
          custom: [
            {
              kind: "mcp",
              source: { type: "remote" },
              targets: ["kiro"],
            },
            { kind: "mcp", source: { type: "stdio", registry: "https://registry.npmjs.org/x" } },
          ],
        },
      },
    };
    expect(kiroRemoteMcpErrors(policy)).toEqual([
      "policy.governance.catalog.custom[0].targets: Kiro MCP projection supports stdio catalog entries only",
    ]);
    expect(registryOriginErrors(policy)).toEqual([
      "policy.governance.catalog.custom[1].source.registry: must be an exact HTTPS origin",
    ]);
    expect(governanceTextErrors(policy)).toEqual([
      "policy.governance.policyVersion: must be visible single-line text without hidden Unicode or surrounding whitespace",
    ]);
  });
});

describe("managed MCP semantics (legacy Ke/N/oe/ze/Ye/Qe)", () => {
  it("lists sorted unique servers of active reviewed built-in MCP controls", () => {
    expect(activeManagedMcpServers(managedPolicy())).toEqual(["github"]);
    expect(activeManagedMcpServers({ governance: { activations: [] } })).toEqual([]);
  });

  it("requires managed projection and an exact allow-list for selected MCP controls", () => {
    expect(managedMcpAuthorityErrors(managedPolicy(), model())).toEqual([
      "policy.mcp.allowManagedOnly: selected center-panel MCP controls require managed MCP projection",
      "policy.mcp.allowedServers: must exactly match selected center-panel MCP controls: github",
    ]);
    expect(
      managedMcpAuthorityErrors(
        managedPolicy({ mcp: { allowManagedOnly: true, allowedServers: ["github"] } }),
        model(),
      ),
    ).toEqual([]);
    expect(
      managedMcpAuthorityErrors(managedPolicy(), model({ workbenchBundle: undefined })),
    ).toEqual(["policy: Prepared Workbench catalog is unavailable."]);
  });

  it("migrates an enterprise-requested legacy policy to managed projection", () => {
    const migrated = migrateLegacyManagedMcp(managedPolicy(), model());
    expect(migrated?.policy.mcp).toEqual({ allowedServers: ["github"], allowManagedOnly: true });
    expect(migrated?.message).toBe(
      "Legacy Workbench policy migrated: managed MCP projection restored for github. Review and download this migrated policy.",
    );
    expect(migrateLegacyManagedMcp(managedPolicy({ mcp: {} }), model())).toBeNull();
  });

  it("narrows schema-2 activation targets to the sanctioned intersection", () => {
    const policy = managedPolicy();
    (policy.governance as { supportedClis: string[] }).supportedClis = ["codex"];
    const narrowed = narrowLegacyActivationTargets(policy, model());
    expect(narrowed?.policy.governance.activations[0].targets).toEqual(["codex"]);
    expect(narrowed?.message).toBe(
      "Legacy Workbench policy migrated: activation targets narrowed to the sanctioned projector intersection for github. Catalog support metadata and imported authority records were preserved; review and download the migrated policy.",
    );
  });

  it("imports a legacy managed policy through both migrations and the selection gate", () => {
    // An open schema isolates the grammar and migrations from the fixture schema.
    const open = { schema: {} };
    const imported = preparePolicyImport(managedPolicy(), () => [], context(open));
    expect(imported.policy.mcp).toEqual({ allowedServers: ["github"], allowManagedOnly: true });
    expect(imported.message).toBe(
      "Legacy Workbench policy migrated: managed MCP projection restored for github. Review and download this migrated policy.",
    );
    expect(() => preparePolicyImport(managedPolicy(), () => [], context(open, false))).toThrow(
      "blocked",
    );
    expect(() => preparePolicyImport(managedPolicy(), () => [], context())).toThrow(
      ": must match exactly one schema variant",
    );
    expect(
      validatePolicy(managedPolicy(), {
        model: model(open),
        selectionValidator: () => undefined,
      }),
    ).toEqual(["Workbench selection validation is unavailable."]);
  });

  it("reconciles policy.mcp with the managed opt-in in place", () => {
    const optedIn = managedPolicy();
    reconcileManagedMcpProjection(optedIn, true);
    expect(optedIn.mcp).toEqual({ allowedServers: ["github"], allowManagedOnly: true });
    const optedOut = managedPolicy();
    reconcileManagedMcpProjection(optedOut, false);
    expect(optedOut.mcp).toBeUndefined();
    const retained = {
      schemaVersion: 2,
      mcp: { githubHost: "github.com", allowManagedOnly: true },
    };
    reconcileManagedMcpProjection(retained, true);
    expect(retained.mcp).toEqual({
      githubHost: "github.com",
      allowedServers: [],
      allowManagedOnly: false,
    });
    const cleared = { schemaVersion: 3, mcp: { allowManagedOnly: true } };
    reconcileManagedMcpProjection(cleared, true);
    expect("mcp" in cleared).toBe(false);
  });

  it("owes managed projection before download only for active MCP controls without opt-in", () => {
    expect(deploymentReadinessBlockers(managedPolicy(), false)).toEqual([
      "enable managed MCP projection",
    ]);
    expect(deploymentReadinessBlockers(managedPolicy(), true)).toEqual([]);
    expect(deploymentReadinessBlockers({ governance: undefined }, false)).toEqual([]);
  });

  it("compares candidate records independent of key order", () => {
    expect(sameCanonicalJson({ a: 1, b: [{ c: 2, d: 3 }] }, { b: [{ d: 3, c: 2 }], a: 1 })).toBe(
      true,
    );
    expect(sameCanonicalJson([1, 2], [2, 1])).toBe(false);
  });
});

describe("protected digest semantics", () => {
  const bundle = JSON.parse(
    readFileSync(new URL("goldens/aih-policy-bundle.json", import.meta.url), "utf8"),
  ) as { authorityReceipt: { decisions: GovernanceDecisionV2[] } };
  const decision = bundle.authorityReceipt.decisions[0] as GovernanceDecisionV2;
  const sha = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

  it("hashes the same domain-separated preimages as Core", () => {
    expect(protectedDigestPreimage("decision", decision)).toBe(
      canonicalGovernanceDecisionV2(decision),
    );
    expect(protectedDigestPreimage("source", decision.subject.source)).toBe(
      canonicalGovernanceDecisionSourceV2(decision.subject.source),
    );
    const descriptor = {
      kind: decision.subject.kind,
      id: decision.subject.id,
      sourceDigest: decision.subject.sourceDigest,
    };
    expect(protectedDigestPreimage("subject", descriptor)).toBe(
      canonicalGovernanceDecisionSubjectV2(descriptor),
    );
    expect(sha(protectedDigestPreimage("source", decision.subject.source))).toBe(
      decision.subject.sourceDigest,
    );
    expect(sha(protectedDigestPreimage("subject", descriptor))).toBe(
      decision.subject.subjectDigest,
    );
    expect(protectedDigestPreimage("evidence", { b: 1, a: 2 })).toBe(
      'aih-organization-evidence/v1\u0000{"a":2,"b":1}',
    );
  });

  it("keeps stable JSON, timestamps, strict strings and evidence ids exact", () => {
    expect(protectedStableJson({ b: [true, null], a: "x" })).toBe('{"a":"x","b":[true,null]}');
    expect(protectedCanonicalTimestamp("2026-08-26T14:00:00+02:00")).toBe(
      "2026-08-26T12:00:00.000Z",
    );
    expect(() => protectedStrictStrings({ k: ["e\u0301"] }, "bundle")).toThrow(
      "bundle.k[0] must already be NFC",
    );
    expect(() => protectedStrictStrings({ "\ud800": 1 }, "bundle")).toThrow(
      "bundle key contains malformed Unicode",
    );
    expect(
      protectedEvidenceId({ itemId: "Acme Linter!", sourceDigest: `sha256:${"f".repeat(64)}` }),
    ).toBe("scan-acme-linter-ffffffffffff");
    expect(protectedEvidenceId({ itemId: "", sourceDigest: `sha256:${"0".repeat(64)}` })).toBe(
      "scan-artifact-000000000000",
    );
  });
});

describe("artifact intake validators", () => {
  it("parses strict JSON only", () => {
    expect(strictJson('{"a":[1,{"b":null}]}', "intake")).toEqual({ a: [1, { b: null }] });
    expect(() => strictJson('{"a":1,"a":2}', "intake")).toThrow("duplicate JSON object key: a");
    expect(() => strictJson("[]", "intake")).toThrow("intake root must be an object");
    expect(() => strictJson('{"a":1} x', "intake")).toThrow(
      "intake contains trailing JSON content",
    );
    expect(() => strictJson('{"a":"e\u0301"}', "intake")).toThrow("intake.a must already be NFC");
  });

  it("validates intake documents with exact messages", () => {
    const intake = (items: unknown[], version = 1) => ({
      format: "aih-artifact-intake",
      version,
      authority: { state: "not-authority" },
      defaults: { accountableOwner: "platform@acme.example" },
      items,
    });
    const npm = {
      type: "npm",
      registry: "https://registry.npmjs.org",
      package: "firecrawl-mcp",
      version: "3.24.0",
    };
    expect(validateIntake(intake([{ id: "a", kind: "mcp", source: npm }]))).toBeTruthy();
    expect(() =>
      validateIntake(intake([{ id: "a", kind: "mcp", source: { ...npm, version: "^3" } }])),
    ).toThrow("artifact intake item 0 source version must be exact semantic version");
    expect(() =>
      validateIntake(
        intake([
          {
            id: "d",
            kind: "mcp",
            source: {
              type: "directory",
              provider: "pulsemcp",
              url: "https://www.pulsemcp.com/servers/acme",
            },
          },
        ]),
      ),
    ).toThrow("artifact intake item 0 source must be an npm or GitHub source");
    expect(() => validateIntake({ ...intake([]), authority: { state: "authority" } })).toThrow(
      "artifact intake must declare itself non-authoritative",
    );
  });

  it("round-trips opaque evidence drafts and rejects non-canonical base64", async () => {
    const bytes = new TextEncoder().encode("scanner bytes");
    const draft = await opaqueEvidenceDraft(bytes);
    expect(draft.declaration.bytesBase64).toBe(base64ForBytes(bytes));
    expect(await validateOpaqueEvidenceDraft(structuredClone(draft))).toEqual(draft);
    expect(() => bytesForBase64("c2Nhbm5lcg")).toThrow(
      "evidence draft bytes must use canonical base64",
    );
    await expect(opaqueEvidenceDraft(new Uint8Array(0))).rejects.toThrow(
      "artifact evidence must contain 1 to 600000 exact bytes",
    );
  });
});
