import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { policyAuthoringCatalog } from "../../src/org-policy/catalog.js";
import { ECC_CONTENT_METADATA_PROVENANCE } from "../../src/org-policy/ecc-content-metadata.js";
import {
  ECC_DISABLE_ELIGIBLE_HOOK_IDS,
  ECC_HOOK_CONTROL_PROVENANCE,
  ECC_HOOK_CONTROL_SOURCE_CONTENT_SHA256,
  eccHookControlCatalog,
} from "../../src/org-policy/ecc-hook-controls.js";
import { ECC_SKILL_CATALOG_PROVENANCE } from "../../src/org-policy/ecc-skill-catalog.js";
import { POLICY_ENGINE_FIELD_CONSUMERS } from "../../src/org-policy/effective.js";

describe("source-locked ECC hook controls", () => {
  it("binds all reviewed source files and the exact 44-row, 43-gated active-pin inventory", () => {
    for (const provenance of [
      ECC_CONTENT_METADATA_PROVENANCE,
      ECC_SKILL_CATALOG_PROVENANCE,
      ECC_HOOK_CONTROL_PROVENANCE,
    ]) {
      expect(provenance).toMatchObject({
        repository: "affaan-m/ECC",
        commit: "5064474d4d762dc9640234a41617cccb79185cec",
      });
    }
    expect(ECC_HOOK_CONTROL_PROVENANCE).toMatchObject({
      repository: "affaan-m/ECC",
      commit: "5064474d4d762dc9640234a41617cccb79185cec",
    });
    const sourcePairs = ECC_HOOK_CONTROL_PROVENANCE.sources.map(({ path, sha256 }) => [
      path,
      sha256,
    ]);
    expect(createHash("sha256").update(JSON.stringify(sourcePairs)).digest("hex")).toBe(
      ECC_HOOK_CONTROL_SOURCE_CONTENT_SHA256,
    );
    expect(ECC_HOOK_CONTROL_PROVENANCE.sources.map(({ path }) => path)).toEqual([
      "hooks/hooks.json",
      "scripts/hooks/session-start-bootstrap.js",
      "scripts/hooks/bash-hook-dispatcher.js",
      "scripts/hooks/posttooluse-dispatcher.js",
      "scripts/hooks/run-with-flags.js",
      "scripts/lib/hook-flags.js",
      ".opencode/plugins/ecc-hooks.ts",
    ]);
    expect(eccHookControlCatalog).toHaveLength(44);
    expect(new Set(eccHookControlCatalog.map(({ id }) => id)).size).toBe(44);
    expect(ECC_DISABLE_ELIGIBLE_HOOK_IDS).toHaveLength(43);
    expect(
      eccHookControlCatalog.filter(
        ({ disableEligible, profiles }) => disableEligible && profiles.includes("minimal"),
      ),
    ).toHaveLength(11);
    expect(
      eccHookControlCatalog.filter(
        ({ disableEligible, profiles }) => disableEligible && profiles.includes("standard"),
      ),
    ).toHaveLength(40);
    expect(
      eccHookControlCatalog.filter(
        ({ disableEligible, profiles }) => disableEligible && profiles.includes("strict"),
      ),
    ).toHaveLength(43);
    expect(
      eccHookControlCatalog.find(({ id }) => id === "pre:bash:dispatcher")?.disableEligible,
    ).toBe(false);
    // New at v2.2.1: the PowerShell fact-forcing gate, a run-with-flags hook of its own.
    expect(
      eccHookControlCatalog.find(({ id }) => id === "pre:powershell:gateguard-fact-force"),
    ).toMatchObject({
      event: "PreToolUse",
      profiles: ["standard", "strict"],
      disableEligible: true,
    });
    expect(eccHookControlCatalog.find(({ id }) => id === "session:start")?.profiles).toEqual([
      "minimal",
      "standard",
      "strict",
    ]);
    expect(eccHookControlCatalog.find(({ id }) => id === "post:skill:track")).toMatchObject({
      event: "PostToolUseFailure",
      profiles: ["standard", "strict"],
      disableEligible: true,
    });
    expect(eccHookControlCatalog.find(({ id }) => id === "stop:plan-canvas-pending")).toMatchObject(
      {
        event: "Stop",
        profiles: ["minimal", "standard", "strict"],
        disableEligible: true,
      },
    );
  });

  it("publishes one browser seam and enrolls both governance leaves", () => {
    expect(policyAuthoringCatalog().eccHookControls).toMatchObject({
      sourceContentSha256: ECC_HOOK_CONTROL_SOURCE_CONTENT_SHA256,
      hooks: eccHookControlCatalog,
      disabledHooks: {
        availability: "supported",
        eligibleIds: ECC_DISABLE_ELIGIBLE_HOOK_IDS,
      },
    });
    expect(POLICY_ENGINE_FIELD_CONSUMERS["governance.frameworkHookControls.ecc.profile"]).toContain(
      "receipt-backed",
    );
    expect(
      POLICY_ENGINE_FIELD_CONSUMERS["governance.frameworkHookControls.ecc.disabledHookIds.*"],
    ).toContain("hook-control plan");
  });
});
