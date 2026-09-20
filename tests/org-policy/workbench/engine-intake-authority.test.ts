/**
 * Lane E of the editor port (acceptance rule section 7, rows 22, 18 and 23),
 * through the engine entry: the artifact intake queue, the offline half of the
 * GitHub Skill intake, and protected bundle authoring.
 *
 * The two byte anchors of section 5 are checked here against the same goldens
 * `new-shell-download-compat.test.ts` pins for the hand-built page.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type AdminEngine,
  createAdminEngine,
  type IntakeDraftV1,
  type ProtectedFieldsV1,
} from "../../../src/org-policy/workbench/engine/index.js";
import { tinyEnterpriseStudioModel, tinyStudioModel } from "../studio-test-fixture.js";

const golden = (name: string) => readFileSync(new URL(`goldens/${name}`, import.meta.url), "utf8");
const sha = (letter: string) => `sha256:${letter.repeat(64)}`;

/** The host's digest, exactly as `workbench-ui/hosts/shared.ts` computes it. */
const digest = async (preimage: string): Promise<string> =>
  `sha256:${createHash("sha256").update(preimage, "utf8").digest("hex")}`;

function engineFor(model: unknown): AdminEngine {
  const created = createAdminEngine(model);
  if (!created.ok) throw new Error(created.errors.join("; "));
  return created.value;
}

const admin = () => engineFor(tinyStudioModel());
const enterprise = () => engineFor(tinyEnterpriseStudioModel());

const draft = (overrides: Partial<IntakeDraftV1> = {}): IntakeDraftV1 => ({
  defaultOwner: "platform@acme.example",
  kind: "mcp",
  id: "firecrawl-mcp",
  discoveryUrl: "",
  sourceType: "npm",
  npmPackage: "firecrawl-mcp",
  npmVersion: "3.24.0",
  npmIntegrity: "",
  githubRepository: "",
  githubCommit: "",
  sourcePath: "",
  directoryUrl: "",
  ...overrides,
});

/** The S0 characterization's artifact intake, as the goldens carry it. */
const INTAKE_GOLDEN_INPUT = {
  format: "aih-artifact-intake",
  version: 2,
  authority: { state: "not-authority" },
  defaults: { accountableOwner: "platform@acme.example" },
  items: [
    {
      id: "firecrawl-mcp",
      kind: "mcp",
      source: {
        type: "npm",
        registry: "https://registry.npmjs.org",
        package: "firecrawl-mcp",
        version: "3.24.0",
      },
    },
    {
      id: "acme-skill",
      kind: "skill",
      accountableOwner: "skills@acme.example",
      clarification: "Pinned review skill",
      source: {
        type: "github",
        repository: "acme/skills",
        commit: "b".repeat(40),
        path: "skills/review",
      },
    },
    {
      id: "pulse-directory",
      kind: "mcp",
      source: {
        type: "directory",
        provider: "pulsemcp",
        url: "https://www.pulsemcp.com/servers/acme",
      },
    },
  ],
};

/** The S0 characterization's protected form values. */
const PROTECTED_GOLDEN_FIELDS: ProtectedFieldsV1 = {
  "protected-bundle-version": "acme-policy-1",
  "protected-issuer-repository": "acme/aih-policy",
  "protected-issuer": "acme-security",
  "protected-issued-at": "2026-08-26T12:00:00Z",
  "protected-expires-at": "2026-09-25T12:00:00Z",
  "protected-decision-id": "decision-acme-linter-1",
  "protected-kind": "tool",
  "protected-subject-id": "acme-linter",
  "protected-source-type": "github",
  "protected-source-repository": "acme/linter",
  "protected-source-commit": "a".repeat(40),
  "protected-source-path": "packages/cli",
  "protected-targets": "codex",
  "protected-effects": "observe,use",
  "protected-qualification-kind": "organization-qualified",
  "protected-evidence-id": "acme-scan-001",
  "protected-evidence-digest": sha("b"),
  "protected-attestor": "acme-scanner",
  "protected-policy-id": "enterprise-policy",
  "protected-policy-version": "1",
  "protected-policy-digest": sha("c"),
  "protected-control-id": "tool-admission",
  "protected-control-digest": sha("d"),
  "protected-actor": "ruchi.admin@acme.example",
  "protected-reason": "Approved after attributable scanner evidence review",
  "protected-disposition": "approved",
};

/** The enterprise fixture the bundle golden's `policy` member records. */
function enterpriseReady(): AdminEngine {
  const engine = enterprise();
  engine.setPosture("enterprise");
  return engine;
}

describe("artifact intake (row 22)", () => {
  it("starts with an empty queue and refuses to download one", () => {
    const engine = admin();
    const view = engine.intake();
    expect(view.candidateCount).toBe("0 / 100 candidates");
    expect(view.summary).toBe(
      "0 / 100 candidates · no intake loaded. Add an item or import one file.",
    );
    expect(view.rows).toEqual([]);
    expect(view.downloadDisabled).toBe(true);
    expect(engine.downloadIntake().ok).toBe(false);
  });

  it("adds an exact npm source and names its accountable owner", () => {
    const engine = admin();
    const outcome = engine.addIntakeItem(draft());
    expect(outcome).toEqual({
      ok: true,
      message:
        "Non-authoritative candidate added to the shared review queue. Add another item or download one intake file.",
    });
    const view = engine.intake();
    expect(view.candidateCount).toBe("1 / 100 candidates");
    expect(view.rows[0]?.title).toBe("MCP · firecrawl-mcp");
    expect(view.rows[0]?.source).toBe("firecrawl-mcp@3.24.0");
    expect(view.rows[0]?.owner).toBe(
      "Accountable owner: platform@acme.example · Intake is not authority",
    );
    expect(view.rows[0]?.badge).toBe("No imported evidence draft · Authority absent");
  });

  it("refuses an item the intake schema rejects, and keeps the queue", () => {
    const engine = admin();
    engine.addIntakeItem(draft());
    const refused = engine.addIntakeItem(draft({ id: "Not A Valid Id" }));
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("Artifact was not added: ");
    expect(engine.intake().rows).toHaveLength(1);
    expect(engine.intakeDraftReady(draft({ id: "Not A Valid Id" }))).toBe(false);
    expect(engine.intakeDraftReady(draft({ id: "second-mcp" }))).toBe(true);
  });

  it("refuses a directory claim on a Skill: it is an MCP-only version 2 route", () => {
    const engine = admin();
    const refused = engine.addIntakeItem(
      draft({
        kind: "skill",
        id: "acme-skill",
        sourceType: "directory",
        directoryUrl: "https://www.pulsemcp.com/servers/acme",
      }),
    );
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("directory claims require intake version 2 and MCP kind");
  });

  it("refuses an import that is not strict JSON and keeps what was queued", () => {
    const engine = admin();
    engine.addIntakeItem(draft());
    const refused = engine.importIntakeText('{"a":1,"a":2}');
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("Artifact intake rejected: ");
    expect(engine.intake().rows).toHaveLength(1);
  });

  it("imports the characterization intake and counts its unique exact sources", () => {
    const engine = admin();
    const outcome = engine.importIntakeText(JSON.stringify(INTAKE_GOLDEN_INPUT));
    expect(outcome).toEqual({
      ok: true,
      message:
        "Non-authoritative artifact intake imported. Imported evidence drafts were preserved without verification.",
    });
    const view = engine.intake();
    expect(view.summary).toBe(
      "3 / 100 candidates · 3 unique exact sources. Imported scanner files remain opaque drafts until Core prepares evidence.",
    );
    // The item's own owner wins over the file's default.
    expect(view.rows[1]?.owner).toBe(
      "Accountable owner: skills@acme.example · Intake is not authority",
    );
    expect(view.rows[2]?.source).toBe("Directory claim · https://www.pulsemcp.com/servers/acme");
  });

  // Byte anchor: acceptance rule section 5, `aih-artifact-intake.json`.
  it("downloads the artifact intake byte-for-byte (aih-artifact-intake.json)", () => {
    const engine = admin();
    engine.importIntakeText(JSON.stringify(INTAKE_GOLDEN_INPUT));
    const file = engine.downloadIntake();
    if (!file.ok) throw new Error(file.errors.join("; "));
    expect(file.value.name).toBe("aih-artifact-intake.json");
    expect(file.value.text).toBe(golden("aih-artifact-intake.json"));
  });

  it("empties the queue when its last item is removed", () => {
    const engine = admin();
    engine.addIntakeItem(draft());
    expect(engine.removeIntakeItem(0).ok).toBe(true);
    expect(engine.intake().downloadDisabled).toBe(true);
    expect(engine.removeIntakeItem(7).ok).toBe(false);
  });
});

describe("GitHub Skill intake (row 18)", () => {
  it("reads an exact SKILL.md permalink locally, with its commit and path", () => {
    const parsed = admin().parseSkillDiscovery(
      `https://github.com/acme/skills/blob/${"b".repeat(40)}/skills/review/SKILL.md`,
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.value).toEqual({
      repository: "acme/skills",
      skill: "review",
      commit: "b".repeat(40),
      path: "skills/review/SKILL.md",
      discoveryUrl: `https://github.com/acme/skills/blob/${"b".repeat(40)}/skills/review/SKILL.md`,
      exact: true,
    });
  });

  it("reads the supported command but leaves it unpinned", () => {
    const parsed = admin().parseSkillDiscovery(
      "npx skills add https://github.com/acme/skills --skill review",
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.value.exact).toBe(false);
    expect(parsed.value.commit).toBe("");
  });

  it("refuses command syntax and an unsupported host", () => {
    const engine = admin();
    expect(engine.parseSkillDiscovery("npx skills add acme/skills; rm -rf /")).toEqual({
      ok: false,
      errors: ["command syntax is not accepted"],
    });
    expect(engine.parseSkillDiscovery("https://example.test/acme/skills")).toEqual({
      ok: false,
      errors: ["Skill discovery supports only GitHub and skills.sh sources"],
    });
  });

  it("judges the connected resolver's answer instead of trusting it", () => {
    const engine = admin();
    const parsed = engine.parseSkillDiscovery("acme/skills");
    expect(parsed.ok).toBe(false); // a bare repository names no Skill
    const discovery = engine.parseSkillDiscovery("https://skills.sh/acme/skills/review");
    if (!discovery.ok) throw new Error(discovery.errors.join("; "));
    const good = {
      version: "aih-connected-github-skill/v1",
      state: "resolved-not-scanned",
      skill: "review",
      source: {
        type: "github",
        repository: "acme/skills",
        commit: "c".repeat(40),
        path: "skills/review/SKILL.md",
      },
    };
    expect(engine.checkConnectedSkillPin(good, discovery.value)).toEqual({
      ok: true,
      value: { commit: "c".repeat(40), path: "skills/review/SKILL.md" },
    });
    // A pin for another repository, or one that is not a SKILL.md, is refused.
    const wrong = { ...good, source: { ...good.source, repository: "other/skills" } };
    expect(engine.checkConnectedSkillPin(wrong, discovery.value).ok).toBe(false);
    const notSkill = { ...good, source: { ...good.source, path: "skills/review/README.md" } };
    expect(engine.checkConnectedSkillPin(notSkill, discovery.value).ok).toBe(false);
    expect(engine.checkConnectedSkillPin(null, discovery.value).ok).toBe(false);
  });
});

describe("protected bundle authoring (row 23)", () => {
  it("refuses every field before Enterprise posture is chosen", async () => {
    // The default fixture opens on the vibe posture; authority needs Enterprise.
    const engine = admin();
    const outcome = await engine.addProtectedDecision(PROTECTED_GOLDEN_FIELDS, digest);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("Correct the highlighted protected policy fields.");
    expect(outcome.issues["protected-bundle-version"]).toBe(
      "Choose Enterprise posture before creating authority.",
    );
  });

  it("names each refused field with the hand-built form's own sentence", async () => {
    const engine = enterpriseReady();
    const outcome = await engine.addProtectedDecision(
      {
        ...PROTECTED_GOLDEN_FIELDS,
        "protected-decision-id": "acme-linter-1",
        "protected-source-commit": "not-a-commit",
        "protected-actor": "not-an-email",
        "protected-effects": "delete",
      },
      digest,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.issues).toMatchObject({
      "protected-decision-id": "Use a decision- prefixed stable identifier.",
      "protected-source-commit": "Use an exact lowercase 40 or 64 character commit.",
      "protected-actor": "Use a valid accountable owner email address.",
      "protected-effects": "Use configure, install, observe, and/or use.",
    });
    expect(engine.protectedAuthoring().rows).toEqual([]);
    expect(engine.protectedAuthoring().downloadDisabled).toBe(true);
  });

  it("refuses an authority window longer than 90 days", async () => {
    const engine = enterpriseReady();
    const outcome = await engine.addProtectedDecision(
      { ...PROTECTED_GOLDEN_FIELDS, "protected-expires-at": "2027-08-26T12:00:00Z" },
      digest,
    );
    expect(outcome.issues["protected-expires-at"]).toBe(
      "Authority must expire after issue and within 90 days.",
    );
  });

  // Byte anchor: acceptance rule section 5, `aih-policy-bundle.json`.
  it("downloads the protected policy bundle byte-for-byte (aih-policy-bundle.json)", async () => {
    const engine = enterpriseReady();
    const added = await engine.addProtectedDecision(PROTECTED_GOLDEN_FIELDS, digest);
    expect(added).toEqual({
      ok: true,
      message:
        "The protected policy file is ready. Any generated organization evidence envelope is separate; Core must still verify both exact byte streams and current authority before effects.",
      issues: {},
    });
    const view = engine.protectedAuthoring();
    expect(view.rows).toEqual([
      {
        id: "decision-acme-linter-1",
        summary: `tool acme-linter at acme/linter@${"a".repeat(40)} · approved`,
      },
    ]);
    // The preview is exactly the bytes that download.
    expect(view.bundlePreview).toBe(golden("aih-policy-bundle.json"));
    const file = await engine.downloadProtectedBundle(PROTECTED_GOLDEN_FIELDS);
    if (!file.ok) throw new Error(file.errors.join("; "));
    expect(file.value.name).toBe("aih-policy-bundle.json");
    expect(file.value.text).toBe(golden("aih-policy-bundle.json"));
    // Pinned as the hand-built runtime behaves: no evidence envelope exists.
    expect(view.evidencePreview).toBe("");
    expect(view.evidenceDownloadDisabled).toBe(true);
  });

  it("refuses a second decision with an identifier already in the file", async () => {
    const engine = enterpriseReady();
    await engine.addProtectedDecision(PROTECTED_GOLDEN_FIELDS, digest);
    const again = await engine.addProtectedDecision(PROTECTED_GOLDEN_FIELDS, digest);
    expect(again.issues["protected-decision-id"]).toBe(
      "That decision identifier is already in this file.",
    );
    expect(engine.protectedAuthoring().rows).toHaveLength(1);
  });

  it("records a revocation, then drops it with the decision it named", async () => {
    const engine = enterpriseReady();
    await engine.addProtectedDecision(PROTECTED_GOLDEN_FIELDS, digest);
    const revoked = await engine.revokeProtectedDecision(0, PROTECTED_GOLDEN_FIELDS, digest);
    expect(revoked).toEqual({
      ok: true,
      message: "The decision revocation is included in the protected policy file.",
      issues: {},
    });
    expect(engine.protectedAuthoring().revocationCount).toBe(1);
    const removed = await engine.removeProtectedDecision(0, PROTECTED_GOLDEN_FIELDS, digest);
    expect(removed.message).toBe("Exact artifact approval removed from the generated file.");
    const view = engine.protectedAuthoring();
    expect(view.rows).toEqual([]);
    expect(view.revocationCount).toBe(0);
    expect(view.downloadDisabled).toBe(true);
  });

  it("refuses a download before any approval exists", async () => {
    const engine = enterpriseReady();
    const refused = await engine.downloadProtectedBundle(PROTECTED_GOLDEN_FIELDS);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.errors).toEqual(["Add at least one exact artifact approval before download."]);
  });

  it("carries an accepted-with-conditions decision's findings, gaps and review time", async () => {
    const engine = enterpriseReady();
    const outcome = await engine.addProtectedDecision(
      {
        ...PROTECTED_GOLDEN_FIELDS,
        "protected-disposition": "accepted-with-conditions",
        "protected-accepted-findings": "finding-b,finding-a",
        "protected-accepted-gaps": "gap-a",
        "protected-conditions": "Review before expiry",
        "protected-review-by": "2026-09-01T12:00:00Z",
      },
      digest,
    );
    expect(outcome.ok).toBe(true);
    expect(engine.protectedAuthoring().rows[0]?.summary).toContain(
      "accepted with conditions through 2026-09-01T12:00:00.000Z · findings: finding-a, finding-b · gaps: gap-a · conditions: Review before expiry",
    );
  });

  it("refuses a review time outside the authority window", async () => {
    const engine = enterpriseReady();
    const outcome = await engine.addProtectedDecision(
      {
        ...PROTECTED_GOLDEN_FIELDS,
        "protected-disposition": "accepted-with-conditions",
        "protected-accepted-findings": "finding-a",
        "protected-accepted-gaps": "",
        "protected-conditions": "Review before expiry",
        "protected-review-by": "2027-01-01T12:00:00Z",
      },
      digest,
    );
    expect(outcome.issues["protected-review-by"]).toBe(
      "Review time must fall inside the authority validity window.",
    );
  });

  it("never throws on malformed input: a refusal is always a result", async () => {
    const engine = enterpriseReady();
    await expect(engine.addProtectedDecision({}, digest)).resolves.toMatchObject({ ok: false });
    await expect(
      engine.removeProtectedDecision(99, PROTECTED_GOLDEN_FIELDS, digest),
    ).resolves.toMatchObject({ ok: false });
    expect(engine.protectedFieldIds().length).toBeGreaterThan(40);
  });
});
