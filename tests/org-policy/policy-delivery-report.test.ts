import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEccMaterialization } from "../../src/ecc/materialization.js";
import { planGovernedCodexRoleRegistration } from "../../src/ecc-profile/governed-codex-roles.js";
import { eccPolicyDeliveryInspectorV1 } from "../../src/framework-plugin/ecc-read.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { policyRootSha256 } from "../../src/org-policy/binding.js";
import { orgPolicyEffectiveCheck } from "../../src/org-policy/evaluate.js";
import {
  inspectPolicyDelivery,
  type PolicyDeliveryEccV1,
  renderPolicyDelivery,
  summarizePolicyDelivery,
} from "../../src/org-policy/policy-delivery-report.js";
import { planPolicyRequiredGuidance } from "../../src/org-policy/required-guidance.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { loadEccFromSource } from "../framework-plugin/plugin-source.js";
import { eccDescriptorLoad } from "../framework-plugin/source-plugin-mocks.js";

// The report's ECC knowledge comes from @aihq/framework-ecc: read it from this repository's package source.
vi.mock("../../src/framework-plugin/load-framework-plugin.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/framework-plugin/load-framework-plugin.js")>();
  const { sourcePluginAccess } = await import("../framework-plugin/source-plugin-mocks.js");
  return {
    ...actual,
    loadFrameworkPluginV1: (
      id: Parameters<typeof actual.loadFrameworkPluginV1>[0],
      options: Parameters<typeof actual.loadFrameworkPluginV1>[1] = {},
    ) => actual.loadFrameworkPluginV1(id, { ...options, access: sourcePluginAccess(id) }),
  };
});
vi.mock("../../src/catalog-package/framework-descriptors.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/catalog-package/framework-descriptors.js")>();
  const { eccDescriptorLoad } = await import("../framework-plugin/source-plugin-mocks.js");
  return {
    ...actual,
    loadFrameworkDescriptorBytesV1: async (
      id: Parameters<typeof actual.loadFrameworkDescriptorBytesV1>[0],
    ) => (id === "ecc" ? eccDescriptorLoad() : actual.loadFrameworkDescriptorBytesV1(id)),
  };
});

let root: string;
const path = ".claude/skills/tdd-workflow/SKILL.md";
const body = "# TDD fixture\nTests before implementation.\n";
const pin = "a".repeat(40);
const source = { repository: "affaan-m/ECC", commit: pin, path: "skills/tdd-workflow" };
const policy = () =>
  parseOrgPolicy({
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "harbor-1",
      supportedClis: ["claude"],
      catalog: { reviewed: [], custom: [] },
      externalSelections: [
        { framework: "ecc", items: [{ id: "skill:tdd-workflow", kind: "skill", source }] },
      ],
    },
  });
function install() {
  applyEccMaterialization({
    root,
    components: [
      {
        id: "skill:tdd-workflow",
        provenance: { repository: source.repository, commit: pin, componentPath: source.path },
        authorization: {
          componentId: "skill:tdd-workflow",
          source: source.repository,
          pinnedSha: pin,
          treeSha256: "b".repeat(64),
          tier: "org",
          issuer: "fictional-adopter/governance",
          evidenceSha256: "c".repeat(64),
        },
        files: [{ path, kind: "copy-file", contents: body }],
      },
    ],
  });
}
let ecc: PolicyDeliveryEccV1;
function planContext(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}
function summarize(
  at: string,
  targets: readonly string[],
  selected: ReturnType<typeof policy> | undefined,
  policyBlocked: boolean,
) {
  return summarizePolicyDelivery(at, targets, selected, policyBlocked, {}, "ai-coding", ecc);
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "aih-policy-report-"));
  ecc = await eccPolicyDeliveryInspectorV1(planContext(), {
    loadPlugin: () => loadEccFromSource(),
    loadDescriptor: async () => eccDescriptorLoad(),
  });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("policy delivery reporting", () => {
  it("blocks and says the ECC checks were not run when the ECC plugin is not installed", async () => {
    install();
    const missing = await eccPolicyDeliveryInspectorV1(planContext(), {
      loadPlugin: async () => ({
        ok: false,
        refusal: {
          reason: "framework-plugin-unavailable",
          frameworkId: "ecc",
          packageName: "@aihq/framework-ecc",
          detail: "not installed",
        },
      }),
    });
    const report = summarizePolicyDelivery(
      root,
      ["claude"],
      policy(),
      false,
      {},
      "ai-coding",
      missing,
    );
    expect(report.blocking).toBe(true);
    expect(report.eccChecks?.state).toBe("not-run");
    expect(report.eccChecks?.detail).toBe("framework-plugin-unavailable: not installed");
    expect(report.selection).toBeUndefined();
    expect(report.components[0]?.state).toBe("receipt-current");
    expect(renderPolicyDelivery(report)).toContain("ECC checks were not run:");
  });

  it("does not consult ECC when the policy selects none and aih wrote no ECC state", () => {
    const report = summarizePolicyDelivery(root, ["codex"], undefined, false);
    expect(report.eccChecks).toBeUndefined();
    expect(report.codexRoles).toBeUndefined();
  });

  it("blocks missing native Codex role registration independently of current role files", async () => {
    const selected = parseOrgPolicy({
      ...policy(),
      governance: {
        ...policy().governance,
        supportedClis: ["codex"],
        externalSelections: [
          {
            framework: "ecc",
            items: [
              {
                id: "agent:planner",
                kind: "agent",
                source: { ...source, path: "agents/planner.md" },
              },
            ],
          },
        ],
      },
    });
    const rolePath = ".codex/agents/planner.toml";
    applyEccMaterialization({
      root,
      components: [
        {
          id: "agent:planner",
          provenance: {
            repository: source.repository,
            commit: pin,
            componentPath: "agents/planner.md",
          },
          targets: ["codex"],
          authorization: {
            componentId: "agent:planner",
            source: source.repository,
            pinnedSha: pin,
            treeSha256: "b".repeat(64),
            tier: "org",
            issuer: "fictional-adopter/governance",
            evidenceSha256: "c".repeat(64),
          },
          files: [
            {
              path: rolePath,
              kind: "copy-file",
              contents: 'developer_instructions = "Plan from evidence."\n',
            },
          ],
        },
      ],
    });
    expect(summarize(root, ["codex"], selected, false)).toMatchObject({
      blocking: true,
      components: [{ state: "receipt-current" }],
      codexRoles: { state: "missing", expectedRoleIds: ["planner"] },
    });
    const run = fakeRunner(() => undefined);
    await executePlan(
      planGovernedCodexRoleRegistration(root, [
        { id: "planner", configFile: rolePath, description: "Plan from evidence." },
      ]),
      {
        root,
        contextDir: "ai-coding",
        apply: true,
        verify: false,
        json: true,
        options: {},
        env: {},
        run,
        host: makeHostAdapter({ platform: "linux", run, env: {} }),
      },
    );
    const current = summarize(root, ["codex"], selected, false);
    expect(current).toMatchObject({
      blocking: false,
      codexRoles: { state: "current" },
      nativeLoading: "unverified",
    });
    expect(renderPolicyDelivery(current)).toContain("Codex role registration: current");
    rmSync(join(root, ".codex/config.toml"));
    rmSync(join(root, ".aih/ecc/codex-role-registration-v1.json"));
    expect(summarize(root, ["codex"], selected, false)).toMatchObject({
      blocking: true,
      codexRoles: { state: "missing" },
    });
  });
  it("joins selected source and receipt ownership without treating installed files as native discovery", () => {
    install();
    const selected = policy();
    const receiptPath = join(root, ".aih/ecc/materialization-v1.json");
    const receiptBefore = readFileSync(receiptPath);
    const report = summarize(root, ["claude"], selected, false);
    expect(report.selection).toMatchObject({
      targets: ["claude"],
      dependencyAuthority: "unverified",
      components: [
        {
          id: "skill:tdd-workflow",
          requirement: "required",
          selectionReason: "legacy-unattributed",
          source: { repository: source.repository, commit: pin, componentPath: source.path },
          owner: "aih-materialization",
          ownership: "receipt-recorded",
          destinations: [{ path, discovery: "project-skill-entry" }],
        },
      ],
    });
    expect(report.nativeLoading).toBe("unverified");
    expect(renderPolicyDelivery(report)).toContain("project-skill-entry");
    expect(renderPolicyDelivery(report)).toContain("native-plugin");
    expect(readFileSync(receiptPath)).toEqual(receiptBefore);
    expect(readFileSync(join(root, path), "utf8")).toBe(body);
  });

  it("keeps missing and mismatched installation provenance separate from the requested source", () => {
    const selected = policy();
    expect(summarize(root, ["claude"], selected, false).selection?.components[0]).toMatchObject({
      ownership: "missing-receipt",
      destinations: [],
    });
    install();
    const changed = parseOrgPolicy({
      ...selected,
      governance: {
        ...selected.governance,
        externalSelections: [
          {
            framework: "ecc",
            roots: ["skill:tdd-workflow"],
            items: [
              {
                id: "skill:tdd-workflow",
                kind: "skill",
                source: { ...source, commit: "d".repeat(40) },
              },
            ],
          },
        ],
      },
    });
    const report = summarize(root, ["claude", "copilot"], changed, false);
    expect(report.selection?.targets).toEqual(["claude"]);
    expect(report.unsupportedTargets).toEqual(["copilot"]);
    expect(report.selection?.components[0]).toMatchObject({
      ownership: "source-mismatch",
      selectionReason: "selected-root",
      source: { commit: "d".repeat(40) },
      destinations: [],
    });
    expect(report.components[0]?.state).toBe("source-mismatch");
    expect(report.blocking).toBe(true);
  });

  it("reports orphan required-guidance receipts even when no policy or component receipt remains", async () => {
    mkdirSync(join(root, "ai-coding"));
    writeFileSync(join(root, "ai-coding/policy-required-guidance.receipt.json"), "{malformed");
    const run = fakeRunner(() => undefined);
    const report = await inspectPolicyDelivery({
      root,
      contextDir: "ai-coding",
      apply: false,
      verify: false,
      json: true,
      targets: ["claude"],
      options: {},
      env: {},
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    });
    expect(report?.blocking).toBe(true);
    expect(report?.startupGuidance?.state).toBe("malformed");
  });
  it("makes the explicit evaluation check fail when requested required content is undelivered", async () => {
    writeFileSync(join(root, "aih-org-policy.json"), JSON.stringify(policy()));
    const run = fakeRunner(() => undefined);
    const check = await orgPolicyEffectiveCheck(
      {
        root,
        contextDir: "ai-coding",
        apply: false,
        verify: false,
        json: true,
        posture: "enterprise",
        targets: ["claude"],
        options: {},
        env: {},
        run,
        host: makeHostAdapter({ platform: "linux", run, env: {} }),
      },
      { includeDelivery: true },
    );
    expect(check.verdict).toBe("fail");
    expect(check.code).toBe("org-policy.effective-blocked");
  });
  it("keeps legacy target coverage unverified and checks required agent guidance for the selected client", async () => {
    const agentSource = { ...source, path: "agents/planner.md" };
    const selected = parseOrgPolicy({
      ...policy(),
      governance: {
        ...policy().governance,
        supportedClis: ["claude", "cursor"],
        externalSelections: [
          {
            framework: "ecc",
            items: [{ id: "agent:planner", kind: "agent", source: agentSource }],
          },
        ],
      },
    });
    const component = {
      id: "agent:planner" as const,
      authorization: {
        componentId: "agent:planner",
        source: source.repository,
        pinnedSha: pin,
        treeSha256: "b".repeat(64),
        tier: "org" as const,
        issuer: "fictional-adopter/governance",
        evidenceSha256: "c".repeat(64),
      },
      provenance: { repository: source.repository, commit: pin, componentPath: agentSource.path },
      files: [
        {
          path: ".claude/agents/planner.md",
          kind: "copy-file" as const,
          contents: "# Planner fixture\n",
        },
      ],
    };
    applyEccMaterialization({ root, components: [component] });
    expect(summarize(root, ["cursor"], selected, false).components[0]?.targetCoverage?.state).toBe(
      "unverified",
    );
    applyEccMaterialization({ root, components: [{ ...component, targets: ["claude"] }] });
    const report = summarize(root, ["cursor"], selected, false);
    expect(report.blocking).toBe(true);
    expect(report.components[0]).toMatchObject({
      state: "receipt-current",
      targetCoverage: {
        state: "mismatch",
        recordedTargets: ["claude"],
        missingTargets: ["cursor"],
        unselectedTargets: ["claude"],
      },
    });
    const run = fakeRunner(() => undefined);
    const guidance = planPolicyRequiredGuidance(root, "ai-coding", [component], {
      policyVersion: "harbor-1",
      source: { repository: source.repository, commit: pin },
      targets: ["claude"],
    });
    await executePlan(
      { capability: "guidance", actions: guidance.actions },
      {
        root,
        contextDir: "ai-coding",
        apply: true,
        verify: false,
        json: true,
        options: {},
        env: {},
        run,
        host: makeHostAdapter({ platform: "linux", run, env: {} }),
      },
    );
    expect(summarize(root, ["claude"], selected, false)).toMatchObject({
      blocking: false,
      startupGuidance: { state: "current" },
      nativeLoading: "unverified",
    });
    rmSync(join(root, "ai-coding/policy-required-guidance.md"));
    expect(summarize(root, ["claude"], selected, false).blocking).toBe(true);
  });
  it("blocks a target override, copied binding and changed policy bytes even when owned bytes are current", () => {
    install();
    const selected = policy();
    const bytes = JSON.stringify(selected);
    const policyPath = join(root, "aih-org-policy.json");
    writeFileSync(policyPath, bytes);
    const binding = {
      schemaVersion: 1,
      state: "active",
      projectId: "harbor-api",
      rootSha256: policyRootSha256(realpathSync.native(root)),
      source: {
        path: realpathSync.native(policyPath),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      targets: ["claude"],
    };
    writeFileSync(join(root, ".aih-config.json"), JSON.stringify({ policyBinding: binding }));
    expect(summarize(root, ["claude"], selected, false).binding?.state).toBe("current");
    expect(summarize(root, ["cursor"], selected, false)).toMatchObject({
      blocking: true,
      binding: { state: "blocked" },
    });
    writeFileSync(policyPath, `${bytes}\n`);
    expect(summarize(root, ["claude"], selected, false).binding?.state).toBe("blocked");
    writeFileSync(policyPath, bytes);
    writeFileSync(
      join(root, ".aih-config.json"),
      JSON.stringify({ policyBinding: { ...binding, rootSha256: "a".repeat(64) } }),
    );
    expect(summarize(root, ["claude"], selected, false).blocking).toBe(true);
  });

  it("shows absent required content and never treats unowned bytes as delivered", () => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
    const report = summarize(root, ["claude"], policy(), false);
    expect(report.blocking).toBe(true);
    expect(report.components[0]).toMatchObject({
      id: "skill:tdd-workflow",
      state: "missing-receipt",
      nativeLoading: "unverified",
      practiceEffect: "guidance",
    });
  });
  it("separates current installed bytes from native loading and actual enforcement", () => {
    install();
    const report = summarize(root, ["claude"], policy(), false);
    expect(report.components[0]).toMatchObject({
      state: "receipt-current",
      nativeLoading: "unverified",
      practiceEffect: "guidance",
    });
    expect(report.components[0]?.files).toEqual([{ path, state: "current" }]);
    expect(report.nativeLoading).toBe("unverified");
  });
  it("invalidates edited and missing owned bytes without overwriting them", () => {
    install();
    writeFileSync(join(root, path), "operator customization\n");
    expect(summarize(root, ["claude"], policy(), false).components[0]?.state).toBe("drifted");
    expect(readFileSync(join(root, path), "utf8")).toBe("operator customization\n");
    rmSync(join(root, path));
    expect(summarize(root, ["claude"], policy(), false).components[0]?.files[0]?.state).toBe(
      "missing",
    );
  });
  it("cannot use an old source receipt or unsupported host as current delivery", () => {
    install();
    const changed = policy();
    if (!changed.governance || !("externalSelections" in changed.governance))
      throw new Error("missing fixture governance");
    const selected = changed.governance.externalSelections[0]?.items[0];
    if (!selected) throw new Error("missing fixture selection");
    selected.source.commit = "d".repeat(40);
    expect(summarize(root, ["claude"], changed, false).components[0]?.state).toBe(
      "source-mismatch",
    );
    expect(summarize(root, ["copilot"], policy(), false)).toMatchObject({
      blocking: true,
      unsupportedTargets: ["copilot"],
    });
  });
  it("keeps authority blockers and reports orphaned governed content after policy loss", () => {
    install();
    expect(summarize(root, ["claude"], policy(), true).blocking).toBe(true);
    expect(summarize(root, ["claude"], undefined, false)).toMatchObject({
      blocking: true,
      unrequestedOwnedComponents: ["skill:tdd-workflow"],
    });
  });
});
