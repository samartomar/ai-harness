import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkProjectPolicyNarrowsV1 } from "../../../src/org-policy/project-policy.js";
import { ProjectPolicyV1Schema } from "../../../src/org-policy/project-policy-schema.js";
import { type OrgPolicy, OrgPolicySchema } from "../../../src/org-policy/schema.js";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import {
  createAdminEngine,
  createUserEngine,
  DEFAULT_POLICY_FILENAME,
  type DiffLine,
  MAX_IMPORT_BYTES,
  PROJECT_POLICY_FILENAME,
  type TrimUseV1,
  userModelFromImportedPolicy,
} from "../../../src/org-policy/workbench/engine/index.js";
import { tinyStudioModel } from "../studio-test-fixture.js";
import { enterpriseManagedPolicy, managedMcpStudioModel } from "./policy-fixtures.js";

/**
 * The engine entry (Policy Workbench UI delivery, "Preview slice"): J1 and J2
 * through the entry alone, the two schema-version-3 byte anchors of
 * `ai-coding/rules/workbench-ui-acceptance.md` §5, the first slice's failure
 * cases at engine level, and the entry's purity.
 */

const ENGINE_DIR = join(process.cwd(), "src/org-policy/workbench/engine");
const GOLDENS = join(process.cwd(), "tests/org-policy/workbench/goldens");

const golden = (name: string): string => readFileSync(join(GOLDENS, name), "utf8");
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function withHosts(model: PolicyStudioModel = tinyStudioModel()): PolicyStudioModel {
  (model.catalog as unknown as { hosts: unknown[] }).hosts = [
    { id: "claude", label: "Claude Code", policyTarget: true, mcpSupport: "managed" },
    { id: "codex", label: "Codex", policyTarget: true, mcpSupport: "managed" },
  ];
  return model;
}

function admin(model: unknown = withHosts()) {
  const created = createAdminEngine(model);
  if (!created.ok) throw new Error(`engine unavailable: ${created.errors.join("; ")}`);
  return created.value;
}

function choices(entries: readonly [string, TrimUseV1][]): ReadonlyMap<string, TrimUseV1> {
  return new Map(entries);
}

/** The J1 admin engine after its three recorded steps. */
function journeyOneEngine() {
  const engine = admin();
  expect(engine.toggleAiTool("claude").ok).toBe(true);
  expect(engine.setPosture("enterprise").ok).toBe(true);
  expect(engine.setItemSelected("fixture:control", true).ok).toBe(true);
  return engine;
}

function userModelForJourneyTwo(orgText: string) {
  return {
    door: "user",
    policySource: {
      kind: "binding",
      path: "/tmp/p/.aih-config.json",
      valid: true,
      sha256: sha256(orgText),
    },
    initialPolicy: JSON.parse(orgText),
    workbenchBundle: tinyStudioModel().workbenchBundle,
  };
}

const JOURNEY_TWO_INPUT = {
  choices: choices([["fixture:control", "required"]]),
  forType: "project" as const,
  forName: "Payments API",
  aiTools: ["claude"],
};

describe("workbench engine entry", () => {
  it("runs J1 through the engine and reproduces the schema-3 organization anchor", () => {
    const engine = admin();
    const untouched = engine.state().policyText;

    const refused = engine.setPosture("enterprise");
    expect(refused).toEqual({
      ok: false,
      message:
        "Enterprise posture was not applied. Select at least one Allowed CLI first, or choose the Enterprise preset to explicitly sanction every supported CLI and compose Core.",
    });
    expect(engine.state().policyText).toBe(untouched);
    expect(engine.state().posture).toBe("vibe");

    expect(engine.toggleAiTool("claude").ok).toBe(true);
    expect(engine.state().aiTools).toEqual([
      { id: "claude", label: "Claude Code", selected: true },
      { id: "codex", label: "Codex", selected: false },
    ]);
    expect(engine.setPosture("enterprise")).toEqual({
      ok: true,
      message: "Posture changed without modifying selections.",
    });
    expect(engine.state().posture).toBe("enterprise");
    expect(engine.setItemSelected("fixture:control", true).ok).toBe(true);
    expect(engine.state().selectedAssetIds).toContain("fixture:control");

    const file = engine.download();
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.value.name).toBe(DEFAULT_POLICY_FILENAME);
    expect(file.value.text).toBe(golden("aih-org-policy.v3-selection.json"));
    expect(file.value.text).toBe(engine.state().policyText);

    const parsed = OrgPolicySchema.parse(JSON.parse(file.value.text));
    expect(parsed.schemaVersion).toBe(3);
    expect(engine.state().schemaVersion).toBe(3);
    const selections = (parsed as unknown as Record<string, unknown>).authoringSelections as {
      roots: { assetId: string }[];
    };
    expect(selections.roots.map((root) => root.assetId)).toEqual(["fixture:control"]);
    expect(engine.check()).toEqual({ ok: true, errors: [], blockers: [] });
  });

  it("runs J2 through the engine and reproduces the project anchor, bound to J1's bytes", () => {
    const orgText = journeyOneEngine().download();
    expect(orgText.ok).toBe(true);
    if (!orgText.ok) return;
    const user = createUserEngine(userModelForJourneyTwo(orgText.value.text));
    const view = user.view();
    expect(view.saveBlocked).toBeUndefined();
    expect(view.items.map((item) => item.assetId)).toEqual(["fixture:control"]);

    const checked = user.check(JOURNEY_TWO_INPUT);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.file.name).toBe(PROJECT_POLICY_FILENAME);
    expect(checked.file.text).toBe(golden("aih-project-policy.v3-selection.json"));

    const project = ProjectPolicyV1Schema.parse(JSON.parse(checked.file.text));
    expect(project.cutFrom.sha256).toBe(sha256(orgText.value.text));
    expect(project.cutFrom.schemaVersion).toBe(3);
    const org = OrgPolicySchema.parse(JSON.parse(orgText.value.text)) as unknown as OrgPolicy;
    expect(checkProjectPolicyNarrowsV1(project, org, sha256(orgText.value.text))).toEqual({
      ok: true,
    });
  });

  it("serializes an untouched policy as it is, never compiled (byte rule 1)", () => {
    expect(admin().state().policyText).toBe(golden("aih-org-policy.vibe.json"));
    const file = admin().download();
    expect(file.ok && file.value.text).toBe(golden("aih-org-policy.vibe.json"));
  });

  describe("changes against the starting policy", () => {
    it("reports no changes for an untouched policy", () => {
      expect(admin().changes()).toEqual([]);
    });

    it("returns hunks that carry the added lines of a selection", () => {
      const engine = admin();
      expect(engine.setItemSelected("fixture:control", true).ok).toBe(true);
      const hunks = engine.changes();
      const added = hunks.filter((entry): entry is DiffLine => entry.kind === "+");
      expect(added.length).toBeGreaterThan(0);
      const text = engine.state().policyText;
      for (const line of added) expect(text).toContain(line.text);
      // Context lines and folded gaps, exactly as `changeHunks` produces them.
      expect(hunks.some((entry) => entry.kind === " " || entry.kind === "gap")).toBe(true);
    });

    it("keeps the page's starting policy as the baseline after an import", () => {
      const engine = admin();
      const imported = JSON.parse(golden("aih-org-policy.vibe.json")) as Record<string, unknown>;
      (imported.governance as Record<string, unknown>).policyVersion = "7";
      expect(engine.importPolicyText(JSON.stringify(imported)).ok).toBe(true);
      // The baseline is `serializePolicy(model.initialPolicy)`, fixed when the
      // page opened (`ui/shell/new-workbench.ts` line 84), so the import itself
      // shows as a change.
      const added = engine.changes().filter((entry): entry is DiffLine => entry.kind === "+");
      expect(added.map((entry) => entry.text)).toContain('    "policyVersion": "7",');
    });
  });

  it("refuses an import that is not strict JSON and keeps the policy (failure case 1)", () => {
    const engine = admin();
    const before = engine.state().policyText;
    for (const text of ['{"schemaVersion": 2,}', '{"a":1}{"b":2}', "[]", '{"a":1,"a":2}']) {
      const outcome = engine.importPolicyText(text);
      expect(outcome.ok).toBe(false);
      expect(outcome.message.startsWith("Policy import rejected: ")).toBe(true);
      expect(engine.state().policyText).toBe(before);
    }
    expect(engine.importPolicyText("x".repeat(MAX_IMPORT_BYTES + 1))).toEqual({
      ok: false,
      message: "Import rejected: file exceeds the 1 MiB limit.",
    });
    expect(engine.state().policyText).toBe(before);
  });

  it("rolls back a rejected import (failure case 3)", () => {
    const engine = admin();
    const before = engine.state().policyText;
    const rejected = engine.importPolicyText(
      JSON.stringify({ schemaVersion: 2, minimumPosture: "nonsense" }),
    );
    expect(rejected.ok).toBe(false);
    expect(engine.state().policyText).toBe(before);
    const accepted = engine.importPolicyText(golden("aih-org-policy.vibe.json"));
    expect(accepted.ok).toBe(true);
    expect(engine.state().policyText).toBe(before);
  });

  it("refuses an unsafe download file name and produces nothing (failure case 5)", () => {
    const engine = admin();
    for (const name of ["../evil.json", "policy", "a b.json", ".hidden.json", "p\u0000.json"]) {
      const file = engine.download(name);
      expect(file.ok).toBe(false);
      if (file.ok) continue;
      expect(file.errors).toEqual([
        "Download blocked: Use a JSON filename without folders, spaces, or hidden characters.",
      ]);
    }
    expect(engine.download("team-policy.json").ok).toBe(true);
  });

  it("disables checks and rejects imports on an invalid prepared catalog (failure case 6)", () => {
    const model = withHosts() as unknown as Record<string, unknown>;
    // The model must lack the binding entirely, not carry `undefined`.
    delete model.workbenchBindings;
    const engine = admin(model);
    expect(engine.state().catalogValid).toBe(false);
    expect(engine.check().ok).toBe(false);
    const imported = engine.importPolicyText(golden("aih-org-policy.vibe.json"));
    expect(imported.ok).toBe(false);
    const file = engine.download();
    expect(file.ok).toBe(false);
    expect(engine.setItemSelected("fixture:control", true).ok).toBe(false);
  });

  it("keeps hostile text and ids raw in the saved project file (failure case 7)", () => {
    const hostileId = '<script>alert("x")</script>';
    const orgPolicy = {
      schemaVersion: 3,
      minimumPosture: "vibe",
      authoringSelections: {
        selectionVersion: "workbench-selection/v1",
        roots: [
          {
            assetId: hostileId,
            origin: { kind: "administrator" },
            resolvedItems: [{ assetId: hostileId }],
          },
        ],
        exclusions: [],
        requests: [],
        drafts: [],
      },
    };
    const user = createUserEngine({
      door: "user",
      policySource: {
        kind: "binding",
        path: "/tmp/p/.aih-config.json",
        valid: true,
        sha256: "a".repeat(64),
      },
      initialPolicy: orgPolicy,
      workbenchBundle: { assets: {} },
    });
    expect(user.view().items.map((item) => item.assetId)).toEqual([hostileId]);
    const built = user.build({
      choices: choices([[hostileId, "required"]]),
      forType: "project",
      forName: '<img src=x onerror="alert(1)">',
      aiTools: ["claude"],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.policy.items[0]?.assetId).toBe(hostileId);
    expect(built.policy.for.name).toBe('<img src=x onerror="alert(1)">');
    const checked = user.check({
      choices: choices([[hostileId, "required"]]),
      forType: "project",
      forName: '<img src=x onerror="alert(1)">',
      aiTools: ["claude"],
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.file.text).toContain('<script>alert(\\"x\\")</script>');
    expect(checked.file.text).toContain('<img src=x onerror=\\"alert(1)\\">');
    expect(JSON.parse(checked.file.text).items[0].assetId).toBe(hostileId);
  });

  it("returns the user page's exact blocked sentences (failure case 8)", () => {
    const bound = {
      door: "user",
      policySource: {
        kind: "binding",
        path: "/p/.aih-config.json",
        valid: true,
        sha256: "b".repeat(64),
      },
      initialPolicy: { schemaVersion: 3, minimumPosture: "vibe" },
      workbenchBundle: { assets: {} },
    };
    const cases: [unknown, string][] = [
      [{ ...bound, policySource: undefined }, "No policy source was provided. Saving is disabled."],
      [
        { ...bound, policySource: { kind: "binding", valid: false, error: "unreadable" } },
        "The policy source is invalid: unreadable. Saving is disabled.",
      ],
      [
        { ...bound, policySource: { kind: "binding", valid: true } },
        "The policy digest is unavailable. Saving is disabled.",
      ],
      [
        { ...bound, initialPolicy: { schemaVersion: 9 } },
        "The org policy is unavailable. Saving is disabled.",
      ],
      [bound, "The org policy lists no items. Saving is disabled."],
    ];
    for (const [model, sentence] of cases) {
      const user = createUserEngine(model);
      expect(user.view().saveBlocked).toBe(sentence);
      expect(user.build(JOURNEY_TWO_INPUT)).toEqual({ ok: false, errors: [sentence] });
      expect(user.check(JOURNEY_TWO_INPUT)).toEqual({ ok: false, errors: [sentence] });
    }
  });

  it("refuses an empty project name (failure case 9)", () => {
    const orgText = journeyOneEngine().download();
    if (!orgText.ok) throw new Error("expected J1 bytes");
    const user = createUserEngine(userModelForJourneyTwo(orgText.value.text));
    for (const forName of ["", "   "]) {
      const checked = user.check({ ...JOURNEY_TWO_INPUT, forName });
      expect(checked.ok).toBe(false);
      if (checked.ok) continue;
      expect(checked.errors.join(" ")).toContain("name");
    }
  });

  it("fails the check and saves nothing when the org policy changed after the cut (case 10)", () => {
    const orgText = journeyOneEngine().download();
    if (!orgText.ok) throw new Error("expected J1 bytes");
    const user = createUserEngine(userModelForJourneyTwo(orgText.value.text));
    const changed = JSON.parse(orgText.value.text) as Record<string, unknown>;
    changed.minimumPosture = "vibe";
    const changedText = `${JSON.stringify(changed, null, 2)}\n`;
    const checked = user.check(JOURNEY_TWO_INPUT, {
      policy: changed,
      sha256: sha256(changedText),
    });
    expect(checked).toEqual({ ok: false, errors: ["org policy changed"] });
    expect("file" in checked).toBe(false);
  });

  it("returns an error result for malformed input, never a throw (failure case 12)", () => {
    const malformed: unknown[] = [null, 42, "x", [], {}, undefined, true];
    for (const value of malformed) {
      const created = createAdminEngine(value);
      expect(created.ok).toBe(false);
      if (created.ok) continue;
      expect(created.errors.length).toBeGreaterThan(0);

      const user = createUserEngine(value);
      expect(() => user.view()).not.toThrow();
      expect(user.view().saveBlocked).toBe("No policy source was provided. Saving is disabled.");
      expect(user.build(JOURNEY_TWO_INPUT).ok).toBe(false);
      expect(user.check(JOURNEY_TWO_INPUT).ok).toBe(false);
      expect(user.build(value as never).ok).toBe(false);
      expect(user.check(value as never).ok).toBe(false);

      const model = userModelFromImportedPolicy(
        value as { text: string; sha256: string; fileName: string },
      ) as Record<string, unknown>;
      expect((model.policySource as Record<string, unknown>).valid).toBe(false);
      expect(createUserEngine(model).view().saveBlocked).toContain("Saving is disabled.");
    }

    const engine = admin();
    const before = engine.state().policyText;
    expect(engine.setPosture(42 as unknown as string).ok).toBe(false);
    expect(engine.toggleAiTool(null as unknown as string).ok).toBe(false);
    expect(engine.setItemSelected(null as unknown as string, true).ok).toBe(false);
    expect(engine.setItemSelected("fixture:control", "yes" as unknown as boolean).ok).toBe(false);
    expect(engine.importPolicyText(42 as unknown as string).ok).toBe(false);
    expect(engine.download(42 as unknown as string).ok).toBe(false);
    expect(engine.check().ok).toBe(true);
    expect(engine.state().policyText).toBe(before);
  });

  it("imports a web-host policy without computing its digest", () => {
    const orgText = journeyOneEngine().download();
    if (!orgText.ok) throw new Error("expected J1 bytes");
    const model = userModelFromImportedPolicy({
      text: orgText.value.text,
      sha256: sha256(orgText.value.text),
      fileName: "aih-org-policy.json",
      bundle: tinyStudioModel().workbenchBundle,
    }) as Record<string, unknown>;
    expect(model.door).toBe("user");
    expect(model.policySource).toMatchObject({
      kind: "import",
      path: "aih-org-policy.json",
      valid: true,
    });
    const checked = createUserEngine(model).check(JOURNEY_TWO_INPUT);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.file.text).toBe(golden("aih-project-policy.v3-selection.json"));

    const bad = userModelFromImportedPolicy({
      text: "not json",
      sha256: "c".repeat(64),
      fileName: "x.json",
    }) as Record<string, unknown>;
    const source = bad.policySource as Record<string, unknown>;
    expect(source.valid).toBe(false);
    expect(typeof source.error).toBe("string");
    expect(bad.initialPolicy).toBeUndefined();
  });

  /**
   * The managed MCP projection opt-in, the hand-built page's rule
   * (`org-screen.ts` lines 724-742) reproduced through the entry. The tiny
   * fixture schema rejects `enterpriseManagedPolicy` (see the harness comment
   * on "managed-mcp-projectable-schema-rejected"), so the accepted path runs
   * on the packaged model in `studio-model-source-data.test.ts`: loading that
   * model is too slow for this pure lane. The refusal is pinned here.
   */
  describe("managed MCP projection", () => {
    it("refuses the same way on the fixture model, and never throws on a non-boolean", () => {
      const model = managedMcpStudioModel() as unknown as Record<string, unknown>;
      model.initialPolicy = enterpriseManagedPolicy(["claude", "codex"]);
      const engine = admin(model);
      expect(engine.state().managedMcpServers).toEqual(["github"]);
      expect(engine.setManagedMcpOptIn(false).message).toBe(
        "Managed MCP projection remains enabled because selected Core MCP controls need it. Remove those controls before disabling this setting.",
      );
      const refused = engine.setManagedMcpOptIn("yes" as unknown as boolean);
      expect(refused.ok).toBe(false);
      expect(refused.message).toContain("Unsupported managed MCP projection setting");
    });

    it("leaves the two fixture goldens byte-identical", () => {
      // The fixture journeys never reach this setting.
      expect(admin().state().policyText).toBe(golden("aih-org-policy.vibe.json"));
      const engine = admin();
      expect(engine.state().managedMcpOptIn).toBe(false);
      expect(engine.state().managedMcpServers).toEqual([]);
      expect(engine.state().policyText).toBe(golden("aih-org-policy.vibe.json"));
    });
  });

  it("keeps the engine free of DOM globals and Node built-ins", () => {
    const files = readdirSync(ENGINE_DIR, { recursive: true, encoding: "utf8" }).filter((name) =>
      name.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const text = readFileSync(join(ENGINE_DIR, name), "utf8");
      expect(text, `${name} touches a DOM global`).not.toMatch(/\b(document|window)\b\s*[.[]/);
      expect(text, `${name} imports a Node built-in`).not.toMatch(/["']node:/);
    }
  });
});
