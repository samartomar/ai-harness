import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ECC_DISABLE_ELIGIBLE_HOOK_IDS,
  ECC_HOOK_CONTROL_PROVENANCE,
  ECC_HOOK_CONTROL_SOURCE_CONTENT_SHA256,
  eccHookControlCatalog,
} from "../../src/org-policy/ecc-hook-controls.js";
import { POLICY_ENGINE_FIELD_CONSUMERS } from "../../src/org-policy/effective.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";

function policy(eccHookControls?: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "2026.08",
      supportedClis: ["claude"],
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
      ...(eccHookControls === undefined ? {} : { eccHookControls }),
    },
  };
}

describe("source-locked ECC hook controls", () => {
  it("canonicalizes disable ids in pinned source order for the selected profile", () => {
    expect(
      parseOrgPolicy(
        policy({
          profile: "standard",
          disabledIds: ["post:quality-gate", "pre:observe"],
        }),
      ).governance?.eccHookControls,
    ).toEqual({
      profile: "standard",
      disabledIds: ["pre:observe", "post:quality-gate"],
    });
    expect(parseOrgPolicy(policy({ profile: "minimal" })).governance?.eccHookControls).toEqual({
      profile: "minimal",
    });
    expect(parseOrgPolicy(policy()).governance?.eccHookControls).toBeUndefined();
  });

  it("rejects duplicate, unknown, wrapper, and profile-ineligible disable ids", () => {
    expect(() =>
      parseOrgPolicy(policy({ profile: "standard", disabledIds: ["pre:observe", "pre:observe"] })),
    ).toThrowError(/unique/i);
    expect(() =>
      parseOrgPolicy(policy({ profile: "standard", disabledIds: ["unknown:hook"] })),
    ).toThrowError(/expected one of/i);
    expect(() =>
      parseOrgPolicy(policy({ profile: "standard", disabledIds: ["pre:bash:dispatcher"] })),
    ).toThrowError(/expected one of/i);
    expect(() =>
      parseOrgPolicy(policy({ profile: "standard", disabledIds: ["pre:bash:tmux-reminder"] })),
    ).toThrowError(/not eligible under the standard profile/i);
    expect(
      parseOrgPolicy(policy({ profile: "strict", disabledIds: ["pre:bash:tmux-reminder"] }))
        .governance?.eccHookControls,
    ).toEqual({
      profile: "strict",
      disabledIds: ["pre:bash:tmux-reminder"],
    });
  });

  it("binds all reviewed source files and the exact 43-row, 42-gated profile inventory", () => {
    expect(ECC_HOOK_CONTROL_PROVENANCE).toMatchObject({
      repository: "affaan-m/ECC",
      commit: "ce64e417fd420a0df98ed0aa00809eea5e74e127",
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
    ]);
    expect(eccHookControlCatalog).toHaveLength(43);
    expect(new Set(eccHookControlCatalog.map(({ id }) => id)).size).toBe(43);
    expect(ECC_DISABLE_ELIGIBLE_HOOK_IDS).toHaveLength(42);
    expect(
      eccHookControlCatalog.filter(
        ({ disableEligible, profiles }) => disableEligible && profiles.includes("minimal"),
      ),
    ).toHaveLength(11);
    expect(
      eccHookControlCatalog.filter(
        ({ disableEligible, profiles }) => disableEligible && profiles.includes("standard"),
      ),
    ).toHaveLength(39);
    expect(
      eccHookControlCatalog.filter(
        ({ disableEligible, profiles }) => disableEligible && profiles.includes("strict"),
      ),
    ).toHaveLength(42);
    expect(
      eccHookControlCatalog.find(({ id }) => id === "pre:bash:dispatcher")?.disableEligible,
    ).toBe(false);
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
    expect(policyStudioModel().catalog.eccHookControls).toMatchObject({
      sourceContentSha256: ECC_HOOK_CONTROL_SOURCE_CONTENT_SHA256,
      hooks: eccHookControlCatalog,
      disabledHooks: {
        availability: "supported",
        eligibleIds: ECC_DISABLE_ELIGIBLE_HOOK_IDS,
      },
    });
    expect(POLICY_ENGINE_FIELD_CONSUMERS["governance.eccHookControls.profile"]).toContain(
      "receipt-backed",
    );
    expect(POLICY_ENGINE_FIELD_CONSUMERS["governance.eccHookControls.disabledIds.*"]).toContain(
      "ECC_DISABLED_HOOKS",
    );
  });
});
