/**
 * The organization feature of the engine entry (acceptance rule section 7,
 * rows 8, 9, 13 and 14): the readiness line, the adoption recipe rows, the
 * evidence and versions rows, the provenance lines, developer tool setup, and
 * the ECC hook controls. The behaviour source is `ui/shell/org-screen.ts`,
 * `ui/developer-tool-selection.ts` with `mountDeveloperTools` of `ui/main.ts`,
 * and `src/org-policy/provenance-lines.ts`.
 */
import { describe, expect, it } from "vitest";
import { ECC_HOOK_PROFILES } from "../../../src/org-policy/ecc-hook-controls.js";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import {
  type AdminEngine,
  createAdminEngine,
} from "../../../src/org-policy/workbench/engine/index.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

const sha = (letter: string) => `sha256:${letter.repeat(64)}`;

/** The tiny fixture declares no hosts; the AI tool allow-list needs two. */
function model(): PolicyStudioModel {
  const value = tinyStudioModel();
  (value.catalog as unknown as { hosts: unknown[] }).hosts = [
    { id: "claude", label: "Claude Code", policyTarget: true, mcpSupport: "managed" },
    { id: "codex", label: "Codex", policyTarget: true, mcpSupport: "managed" },
  ];
  return value;
}

function engineOf(value: PolicyStudioModel = model()): AdminEngine {
  const created = createAdminEngine(value);
  if (!created.ok) throw new Error(created.errors.join("; "));
  return created.value;
}

/** Two pinned hooks and their profiles, enough to exercise both groups. */
function withEccHooks(value: PolicyStudioModel = model()): PolicyStudioModel {
  const controls = (value.catalog as unknown as { eccHookControls: Record<string, unknown> })
    .eccHookControls;
  controls.hooks = [
    {
      id: "pre:bash:block-no-verify",
      event: "PreToolUse",
      profiles: ["minimal", "standard", "strict"],
      disableEligible: true,
    },
    {
      id: "pre:bash:dispatcher",
      event: "PreToolUse",
      profiles: ["minimal", "standard", "strict"],
      disableEligible: false,
    },
    {
      id: "stop:cost-tracker",
      event: "Stop",
      profiles: ["strict"],
      disableEligible: true,
    },
  ];
  (controls.disabledHooks as Record<string, unknown>).eligibleIds = [
    "pre:bash:block-no-verify",
    "stop:cost-tracker",
  ];
  return value;
}

describe("engine organization feature", () => {
  it("says no Core controls are selected before anything is chosen", () => {
    expect(engineOf().org().readiness).toBe(
      "No Core controls selected. Choose controls after setting the hosts and posture you intend to use.",
    );
  });

  it("names the exact selected target intersections once a control is selected", () => {
    const engine = engineOf();
    expect(engine.toggleAiTool("claude").ok).toBe(true);
    expect(engine.setItemSelected("fixture:control", true).ok).toBe(true);
    const readiness = engine.org().readiness;
    expect(readiness).toContain("Exact selected target intersections: usage-metering → claude");
    expect(readiness).toContain("Governance MCP and hook projection remains disabled in Vibe");
  });

  it("carries the evidence and versions rows and the note, and nothing when there is no delivery", () => {
    expect(engineOf().org().evidenceDelivery).toBeUndefined();
    const value = model();
    value.evidenceDelivery = {
      coreVersion: "0.5.0",
      workbenchCatalogDigest: sha("c"),
      vendorLockDigest: sha("d"),
      scannerLibraryVersion: "0.3.0",
      expectedScannerPublisher: {
        repository: "fixture/scan",
        workflow: "fixture/scan/.github/workflows/publish.yml",
        ref: "refs/heads/main",
        commit: "a".repeat(40),
      },
      publicBaseline: {
        publisher: "fixture/core<script>",
        workflow: "fixture/core/.github/workflows/vendor.yml",
        artifactDigest: sha("b"),
        verifiedAt: "2026-09-06T00:00:00Z",
        validUntil: "2026-09-07T00:00:00Z",
      },
    };
    const delivery = engineOf(value).org().evidenceDelivery;
    expect(delivery?.coreVersion).toBe("0.5.0");
    expect(delivery?.rows).toContainEqual(["This Workbench catalog", sha("c")]);
    expect(delivery?.rows.some(([label]) => label === "Included evidence publisher")).toBe(true);
    expect(delivery?.note).toContain("A scan does not grant organization approval.");
  });

  it("invents no provenance line when the model carries none", () => {
    expect(engineOf().org().provenance).toEqual({});
  });

  it("prints the catalog and baseline provenance lines the model carries", () => {
    const value = model() as unknown as Record<string, unknown>;
    value.catalogProvenance = {
      tier: "publisher",
      sourceId: "source:fixture-core",
      channel: "stable",
      resolvedAt: "2026-09-06T00:00:00Z",
      ageSeconds: null,
      bootstrapProvenance: "packaged",
    };
    value.baselineEvidenceProvenance = {
      tier: "public",
      sourceIds: ["ecc"],
      schemaVersion: 1,
      digest: sha("e"),
      ageSeconds: 12,
      resolvedAt: "2026-09-06T00:00:00Z",
    };
    const provenance = engineOf(value as unknown as PolicyStudioModel).org().provenance;
    expect(provenance.catalog).toBe(
      "Supported catalog · verified publisher · source source:fixture-core (stable) · resolved 2026-09-06T00:00:00Z · packaged fallback (no download age) · bootstrap packaged",
    );
    expect(provenance.baselineEvidence).toBe(
      `Baseline evidence · public · sources ecc · schema 1 · digest ${sha("e")} · age 12s · resolved 2026-09-06T00:00:00Z`,
    );
  });

  it("lists the seven default developer tools and records an explicit choice", () => {
    const engine = engineOf();
    const before = engine.org().developerTools;
    expect(before.rows).toHaveLength(7);
    expect(before.summary).toBe("Developer tool setup: All default tools selected");
    expect(before.status).toBe("All default developer tools are selected.");

    const outcome = engine.setDeveloperTool("serena", "exclude");
    expect(outcome).toEqual({
      ok: true,
      message: "Saved as an explicit developer-tool policy choice.",
    });
    const after = engine.org().developerTools;
    expect(after.status).toBe("Explicit policy selection is shown below.");
    expect(after.summary).toBe("Developer tool setup: 6 selected · 1 excluded");
    const serena = after.rows.find((row) => row.id === "serena");
    expect(serena?.state).toBe("excluded");
    expect(serena?.stateText).toBe("Excluded by policy");
    expect(serena?.actions).toEqual(["include"]);
    expect(
      (JSON.parse(engine.state().policyText) as { developerTools?: { excluded?: string[] } })
        .developerTools?.excluded,
    ).toEqual(["serena"]);
  });

  it("refuses an unknown developer tool and an unknown action", () => {
    const engine = engineOf();
    expect(engine.setDeveloperTool("not-a-tool", "include")).toEqual({
      ok: false,
      message: "Unknown developer tool: not-a-tool",
    });
    expect(engine.setDeveloperTool("serena", "launch" as unknown as "include").ok).toBe(false);
  });

  it("records an ECC hook profile and drops ids the profile does not allow", () => {
    const engine = engineOf(withEccHooks());
    expect(engine.setEccHookProfile("strict")).toEqual({
      ok: true,
      message:
        "ECC hook profile set to strict. AIH records supported Claude environment intent; ECC executes the hooks.",
    });
    expect(engine.toggleEccHookDisabled("stop:cost-tracker")).toEqual({
      ok: true,
      message:
        "Disabled stop:cost-tracker for ECC's strict profile. ECC applies this after process spawn; it is not AIH enforcement.",
    });
    expect(engine.org().eccHooks.profile).toBe("strict");

    // "minimal" does not list stop:cost-tracker, so the recorded id is dropped.
    expect(engine.setEccHookProfile("minimal").ok).toBe(true);
    const hooks = engine.org().eccHooks;
    expect(hooks.profile).toBe("minimal");
    expect(
      hooks.groups.flatMap((group) => group.hooks).find((hook) => hook.id === "stop:cost-tracker")
        ?.disabled,
    ).toBe(false);
  });

  it("re-enables a disabled hook and refuses the ineligible and the wrapper", () => {
    const engine = engineOf(withEccHooks());
    expect(engine.setEccHookProfile("minimal").ok).toBe(true);
    expect(engine.toggleEccHookDisabled("pre:bash:block-no-verify").ok).toBe(true);
    expect(engine.toggleEccHookDisabled("pre:bash:block-no-verify").message).toContain(
      "Re-enabled pre:bash:block-no-verify",
    );
    expect(engine.toggleEccHookDisabled("pre:bash:dispatcher")).toEqual({
      ok: false,
      message: "pre:bash:dispatcher is a required wrapper; it has no individual disabled setting.",
    });
    expect(engine.toggleEccHookDisabled("stop:cost-tracker")).toEqual({
      ok: false,
      message: "stop:cost-tracker is not eligible under the minimal profile.",
    });
  });

  it("refuses a hook change before a profile is recorded, and an unknown profile", () => {
    const engine = engineOf(withEccHooks());
    expect(engine.toggleEccHookDisabled("pre:bash:block-no-verify")).toEqual({
      ok: false,
      message: "Choose an ECC hook profile before disabling a hook.",
    });
    expect(engine.setEccHookProfile("paranoid")).toEqual({
      ok: false,
      message: "Unknown ECC hook profile: paranoid",
    });
  });

  it("offers every pinned profile and groups each pinned hook exactly once", () => {
    const hooks = engineOf(withEccHooks()).org().eccHooks;
    expect(hooks.profiles.map((profile) => profile.id)).toEqual(
      ECC_HOOK_PROFILES.map((profile) => profile.id),
    );
    expect(hooks.groupingError).toBeUndefined();
    const ids = hooks.groups.flatMap((group) => group.hooks.map((hook) => hook.id));
    expect(ids.slice().sort()).toEqual(
      ["pre:bash:block-no-verify", "pre:bash:dispatcher", "stop:cost-tracker"].sort(),
    );
  });

  it("refuses to group a hook the pinned groups do not cover", () => {
    const value = withEccHooks();
    const controls = (value.catalog as unknown as { eccHookControls: Record<string, unknown> })
      .eccHookControls;
    (controls.hooks as unknown[]).push({
      id: "notification:desktop",
      event: "Notification",
      profiles: ["strict"],
      disableEligible: true,
    });
    expect(engineOf(value).org().eccHooks.groupingError).toBe(
      "ECC hook grouping must render every pinned hook exactly once",
    );
  });
});
