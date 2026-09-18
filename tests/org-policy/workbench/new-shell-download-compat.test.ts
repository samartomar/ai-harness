/**
 * S2 (NEW-SHELL-PLAN.md §4): the new shell's policy session and file
 * transfer against the S0 characterization. Every import outcome must match
 * the legacy shell's, and every S0 golden file must come out of the new
 * shell's download path byte-for-byte.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../../src/org-policy/studio-template.js";
import {
  strictJson,
  validateIntake,
} from "../../../src/org-policy/workbench/ui/shell/artifact-intake-model.js";
import {
  ARTIFACT_INTAKE_FILENAME,
  jsonFileText,
  PROJECT_POLICY_FILENAME,
  PROTECTED_BUNDLE_FILENAME,
} from "../../../src/org-policy/workbench/ui/shell/download-format.js";
import {
  buildProjectPolicyV1,
  type TrimUseV1,
  userDoorViewModelV1,
} from "../../../src/org-policy/workbench/ui/user-door-model.js";
import { tinyEnterpriseStudioModel, tinyStudioModel } from "../studio-test-fixture.js";
import {
  announcement,
  basePolicy,
  click,
  closeStudios,
  drained,
  governance,
  hookControl,
  importCases,
  importFile,
  importMigrationCases,
  preview,
  setValue,
  sha,
  studio,
} from "./shell-parity-harness.js";

afterEach(closeStudios);

const golden = (name: string) => readFileSync(new URL(`goldens/${name}`, import.meta.url), "utf8");

function newShell(model: PolicyStudioModel = tinyStudioModel()) {
  return studio({ ...model, shell: "new" });
}

describe("new shell imports match the legacy shell", () => {
  it("renders the page from the new shell", () => {
    const { window } = newShell();
    expect(window.document.getElementById("wb-root")?.getAttribute("data-wb-shell")).toBe("new");
    expect(window.document.getElementById("framework-rows")).toBeNull();
    expect(preview(window)).toBe(golden("aih-org-policy.vibe.json"));
  });

  it.each(importCases)(
    "announces and previews %s exactly as the legacy shell",
    async (_label, build) => {
      const outcomes = [];
      for (const current of [studio(), newShell()]) {
        const before = preview(current.window);
        const message = await importFile(current.window, "policy-file", JSON.stringify(build()));
        outcomes.push({
          message,
          changed: preview(current.window) !== before,
          preview: preview(current.window),
        });
      }
      expect(outcomes[1]).toEqual(outcomes[0]);
    },
  );

  it("rejects a policy file that is not strict JSON with the legacy messages", async () => {
    const { window } = newShell();
    expect(await importFile(window, "policy-file", '{"schemaVersion":2,"schemaVersion":2}')).toBe(
      "Policy import rejected: duplicate JSON object key: schemaVersion",
    );
    expect(await importFile(window, "policy-file", "[]")).toBe(
      "Policy import rejected: file import JSON root must be an object",
    );
  });

  it("reproduces the legacy migration messages and preview bytes (goldens)", async () => {
    const messages = JSON.parse(golden("import-migration-messages.json")) as Record<string, string>;
    for (const [name, makeModel, build] of importMigrationCases) {
      const { window } = newShell(makeModel());
      expect(await importFile(window, "policy-file", JSON.stringify(build()))).toBe(messages[name]);
      expect(preview(window)).toBe(golden(`import-migration.${name}.json`));
    }
  });

  it("writes hostile text from an import as text, never as markup", async () => {
    const { window } = newShell();
    const hostile = '<img src=x onerror="globalThis.__pwned=1">';
    const key = JSON.stringify(hostile);
    const message = await importFile(window, "policy-file", `{${key}:1,${key}:1}`);
    expect(message).toBe(`Policy import rejected: duplicate JSON object key: ${hostile}`);
    expect(window.document.querySelectorAll("#wb-root img")).toHaveLength(0);
    expect(window.document.getElementById("status")?.textContent).toBe(message);
  });

  it("preserves imported evidence with the legacy message", async () => {
    const { window } = newShell();
    expect(await importFile(window, "evidence-file", '{"approvals":[]}')).toBe(
      "Authority/audit data preserved for preflight only; it is not verified and does not create effective approval.",
    );
    expect(await importFile(window, "evidence-file", "[]")).toBe(
      "Evidence import failed: valid JSON object required.",
    );
  });

  it("validates in both postures exactly as the legacy shell announces", () => {
    const results = [];
    for (const open of [
      studio,
      (model?: PolicyStudioModel) => studio({ ...(model ?? tinyStudioModel()), shell: "new" }),
    ]) {
      for (const model of [tinyStudioModel(), tinyEnterpriseStudioModel()]) {
        const { window } = open(model);
        click(window, "validate");
        const validate = window.document.getElementById("validate");
        results.push({
          message: announcement(window),
          failed: validate?.classList.contains("check-failed"),
          attention: validate?.classList.contains("check-attention"),
        });
      }
    }
    expect(results.slice(2)).toEqual(results.slice(0, 2));
  });

  it("clears back to the initial policy", async () => {
    const { window } = newShell();
    const initial = preview(window);
    const policy = basePolicy();
    governance(policy).catalog = { reviewed: [hookControl], custom: [] };
    governance(policy).activations = [
      { candidate: "usage-metering", state: "active", targets: ["claude", "codex"] },
    ];
    await importFile(window, "policy-file", JSON.stringify(policy));
    expect(preview(window)).not.toBe(initial);
    click(window, "clear-policy");
    expect(preview(window)).toBe(initial);
    expect(announcement(window)).toBe(
      "Policy cleared. All selections, requests and curation records were removed from this draft. You can start again with any source.",
    );
  });
});

describe("S0 golden files through the new shell's download path", () => {
  it("downloads the organization policy byte-for-byte (aih-org-policy.json)", async () => {
    const vibe = newShell();
    click(vibe.window, "download");
    const enterprise = newShell(tinyEnterpriseStudioModel());
    setValue(enterprise.window, "policy-download-name", "payments-team-policy.json");
    click(enterprise.window, "download");
    const [vibeFile] = await drained(vibe);
    const [enterpriseFile] = await drained(enterprise);
    expect(vibeFile?.name).toBe("aih-org-policy.json");
    expect(enterpriseFile?.name).toBe("payments-team-policy.json");
    expect(vibeFile?.text).toBe(preview(vibe.window));
    expect(vibeFile?.text).toBe(golden("aih-org-policy.vibe.json"));
    expect(enterpriseFile?.text).toBe(golden("aih-org-policy.enterprise.json"));
    expect(announcement(enterprise.window)).toBe(
      "Policy download started. Validate this file with: aih policy validate <target-root> --policy payments-team-policy.json",
    );
  });

  it("downloads the organization policy after an imported transformation", async () => {
    const current = newShell();
    const policy = basePolicy();
    governance(policy).catalog = { reviewed: [hookControl], custom: [] };
    governance(policy).activations = [
      { candidate: "usage-metering", state: "active", targets: ["claude", "codex"] },
    ];
    await importFile(current.window, "policy-file", JSON.stringify(policy));
    click(current.window, "download");
    const files = await drained(current);
    expect(files.map((file) => file.name)).toEqual(["aih-org-policy.json"]);
    expect(announcement(current.window)).toBe(
      "Policy download started. Validate this file with: aih policy validate <target-root> --policy aih-org-policy.json",
    );
    expect(files[0]?.text).toBe(golden("aih-org-policy.hook-control.json"));
  });

  it("refuses unsafe policy filenames without downloading", () => {
    const { window, downloads } = newShell();
    setValue(window, "policy-download-name", "../policy.json");
    click(window, "download");
    expect(downloads).toEqual([]);
    expect(announcement(window)).toBe(
      "Download blocked: Use a JSON filename without folders, spaces, or hidden characters.",
    );
    expect(window.document.getElementById("policy-file-command")?.textContent).toBe(
      "aih policy validate <target-root> --policy <safe-policy-file.json>",
    );
  });

  it("downloads an imported decision byte-for-byte (aih-governance-decision.json)", async () => {
    const current = newShell();
    expect(
      (
        current.window.document.getElementById("download-decision") as unknown as {
          disabled: boolean;
        }
      ).disabled,
    ).toBe(true);
    const decision = {
      format: "aih-governance-decision",
      version: 1,
      id: "decision-workbench",
      disposition: "accepted-with-conditions",
      candidate: "code-review-graph",
      kind: "mcp",
      targets: ["claude"],
      effects: ["managed-settings"],
      policyVersion: "2026.08",
      sourceDigest: sha("a"),
      evidenceDigest: sha("b"),
      reviewedControlDigest: sha("c"),
      issuer: "platform-security",
      actor: "security-admin",
      reason: "Decision reason",
      issuedAt: "2026-08-01T00:00:00+00:00",
      notBefore: "2026-08-01T00:00:00+00:00",
      expiresAt: "2026-08-10T00:00:00+00:00",
      reviewBy: "2026-08-05T00:00:00+00:00",
      acceptedFindings: ["prompt-injection"],
      acceptedGaps: [],
      conditions: ["Review before expiry"],
    };
    expect(await importFile(current.window, "decision-file", JSON.stringify(decision))).toBe(
      "Decision imported for inspection only: unverified and not effective.",
    );
    click(current.window, "download-decision");
    const [file] = await drained(current);
    expect(file?.name).toBe("aih-governance-decision.json");
    expect(file?.text).toBe(golden("aih-governance-decision.json"));
    expect(announcement(current.window)).toBe(
      "Canonical decision download started; it remains unverified and not effective.",
    );
  });

  // The protected form (S7) and artifact intake (S7) have no screen in the new
  // shell yet; their bytes come from the same serializer file-transfer hands
  // to downloadBlob, fed the legacy runtime's values.
  it("serializes the protected policy bundle byte-for-byte (aih-policy-bundle.json)", () => {
    const bytes = golden("aih-policy-bundle.json");
    expect(PROTECTED_BUNDLE_FILENAME).toBe("aih-policy-bundle.json");
    expect(jsonFileText(JSON.parse(bytes))).toBe(bytes);
  });

  it("serializes the artifact intake byte-for-byte (aih-artifact-intake.json)", () => {
    const intake = validateIntake(
      strictJson(
        JSON.stringify({
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
        }),
        "artifact intake",
      ),
    );
    expect(ARTIFACT_INTAKE_FILENAME).toBe("aih-artifact-intake.json");
    expect(jsonFileText(structuredClone(intake))).toBe(golden("aih-artifact-intake.json"));
  });

  it("serializes the project policy byte-for-byte (aih-project-policy.json)", () => {
    const admin = { kind: "administrator" } as const;
    const pin = { sourceId: "source:ecc", sourceRevisionId: "rev-1", contentDigest: sha("b") };
    const view = userDoorViewModelV1({
      door: "user",
      policySource: {
        kind: "binding",
        path: "/tmp/p/.aih-config.json",
        sha256: "a".repeat(64),
        valid: true,
      },
      initialPolicy: {
        schemaVersion: 3,
        governance: { supportedClis: ["claude", "codex"] },
        authoringSelections: {
          selectionVersion: "workbench-selection/v1",
          roots: [
            {
              assetId: "ecc/pack",
              origin: admin,
              resolvedItems: [
                { assetId: "ecc/pack", ...pin },
                { assetId: "ecc/skill-a", ...pin },
              ],
            },
          ],
          requests: [{ assetId: "mcp/github", origin: admin }],
          exclusions: [],
          drafts: [],
        },
      },
      workbenchBundle: { assets: {} },
    });
    const result = buildProjectPolicyV1(view, {
      choices: new Map<string, TrimUseV1>([
        ["ecc/pack", "required"],
        ["mcp/github", "skip"],
      ]),
      forType: "project",
      forName: " Payments API ",
      aiTools: ["codex", "claude"],
    });
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(PROJECT_POLICY_FILENAME).toBe("aih-project-policy.json");
    expect(jsonFileText(result.policy)).toBe(golden("aih-project-policy.json"));
  });
});

describe("new shell with an invalid prepared catalog", () => {
  it("disables Check Policy and Publish and rejects imports", async () => {
    const model = { ...tinyStudioModel(), shell: "new" } as PolicyStudioModel;
    Reflect.deleteProperty(model, "workbenchBindings");
    expect(policyStudioHtml(model)).toContain('data-wb-shell="new"');
    const { window } = studio(model);
    const disabled = (id: string) =>
      (window.document.getElementById(id) as unknown as { disabled: boolean }).disabled;
    expect(disabled("validate")).toBe(true);
    expect(disabled("download")).toBe(true);
    const before = preview(window);
    const message = await importFile(window, "policy-file", before);
    expect(message).toContain("Prepared catalog is invalid");
    expect(preview(window)).toBe(before);
  });
});
