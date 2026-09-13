import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEccMaterialization } from "../../src/ecc/materialization.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { policyRootSha256 } from "../../src/org-policy/binding.js";
import { orgPolicyEffectiveCheck } from "../../src/org-policy/evaluate.js";
import {
  inspectPolicyDelivery,
  summarizePolicyDelivery,
} from "../../src/org-policy/policy-delivery-report.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

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
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-policy-report-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("policy delivery reporting", () => {
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
  it("keeps legacy target coverage unverified and blocks a receipt for the wrong selected client", () => {
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
    expect(
      summarizePolicyDelivery(root, ["cursor"], selected, false).components[0]?.targetCoverage
        ?.state,
    ).toBe("unverified");
    applyEccMaterialization({ root, components: [{ ...component, targets: ["claude"] }] });
    const report = summarizePolicyDelivery(root, ["cursor"], selected, false);
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
    expect(summarizePolicyDelivery(root, ["claude"], selected, false).binding?.state).toBe(
      "current",
    );
    expect(summarizePolicyDelivery(root, ["cursor"], selected, false)).toMatchObject({
      blocking: true,
      binding: { state: "blocked" },
    });
    writeFileSync(policyPath, `${bytes}\n`);
    expect(summarizePolicyDelivery(root, ["claude"], selected, false).binding?.state).toBe(
      "blocked",
    );
    writeFileSync(policyPath, bytes);
    writeFileSync(
      join(root, ".aih-config.json"),
      JSON.stringify({ policyBinding: { ...binding, rootSha256: "a".repeat(64) } }),
    );
    expect(summarizePolicyDelivery(root, ["claude"], selected, false).blocking).toBe(true);
  });

  it("shows absent required content and never treats unowned bytes as delivered", () => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
    const report = summarizePolicyDelivery(root, ["claude"], policy(), false);
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
    const report = summarizePolicyDelivery(root, ["claude"], policy(), false);
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
    expect(summarizePolicyDelivery(root, ["claude"], policy(), false).components[0]?.state).toBe(
      "drifted",
    );
    expect(readFileSync(join(root, path), "utf8")).toBe("operator customization\n");
    rmSync(join(root, path));
    expect(
      summarizePolicyDelivery(root, ["claude"], policy(), false).components[0]?.files[0]?.state,
    ).toBe("missing");
  });
  it("cannot use an old source receipt or unsupported host as current delivery", () => {
    install();
    const changed = policy();
    if (!changed.governance || !("externalSelections" in changed.governance))
      throw new Error("missing fixture governance");
    const selected = changed.governance.externalSelections[0]?.items[0];
    if (!selected) throw new Error("missing fixture selection");
    selected.source.commit = "d".repeat(40);
    expect(summarizePolicyDelivery(root, ["claude"], changed, false).components[0]?.state).toBe(
      "source-mismatch",
    );
    expect(summarizePolicyDelivery(root, ["copilot"], policy(), false)).toMatchObject({
      blocking: true,
      unsupportedTargets: ["copilot"],
    });
  });
  it("keeps authority blockers and reports orphaned governed content after policy loss", () => {
    install();
    expect(summarizePolicyDelivery(root, ["claude"], policy(), true).blocking).toBe(true);
    expect(summarizePolicyDelivery(root, ["claude"], undefined, false)).toMatchObject({
      blocking: true,
      unrequestedOwnedComponents: ["skill:tdd-workflow"],
    });
  });
});
