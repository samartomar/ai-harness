/**
 * S0 characterization of the legacy Workbench runtime (NEW-SHELL-PLAN.md §4).
 *
 * These tests pin what the legacy runtime does today, through its own DOM
 * hooks: the policy-grammar messages it announces on import and validate, and
 * the exact bytes of every file it downloads. The golden files under
 * `goldens/` were captured from the legacy runtime before any extraction and
 * are the byte-compatibility gate for the new shell (S2, S7, S8).
 */
import { TextEncoder } from "node:util";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../../src/org-policy/studio-template.js";
import {
  buildProjectPolicyV1,
  type TrimUseV1,
  userDoorViewModelV1,
} from "../../../src/org-policy/workbench/ui/user-door-model.js";
import { tinyEnterpriseStudioModel, tinyStudioModel } from "../studio-test-fixture.js";

const windows = new Set<Window>();
const sha = (character: string) => `sha256:${character.repeat(64)}`;

afterEach(async () => {
  await Promise.all([...windows].map((window) => window.happyDOM.close()));
  windows.clear();
});

interface Download {
  name: string;
  text: string;
}

interface Studio {
  window: Window;
  downloads: Download[];
}

function studio(model: PolicyStudioModel = tinyStudioModel()): Studio {
  const window = new Window({ url: "http://localhost/" });
  windows.add(window);
  const html = policyStudioHtml(model);
  window.document.write(html);
  Object.defineProperty(window, "crypto", { configurable: true, value: globalThis.crypto });
  Object.defineProperty(window, "TextEncoder", { configurable: true, value: TextEncoder });
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const downloads: Download[] = [];
  const blobs = new Map<string, Blob>();
  let next = 0;
  const url = window.URL as unknown as {
    createObjectURL(blob: Blob): string;
    revokeObjectURL(value: string): void;
  };
  url.createObjectURL = (blob: Blob) => {
    next += 1;
    const key = `blob:characterization-${next}`;
    blobs.set(key, blob);
    return key;
  };
  url.revokeObjectURL = () => undefined;
  const anchorPrototype = Object.getPrototypeOf(window.document.createElement("a")) as {
    click: () => void;
  };
  anchorPrototype.click = function (this: { download: string; href: string }): void {
    const blob = blobs.get(this.href);
    if (blob === undefined) return;
    const entry: Download = { name: this.download, text: "" };
    downloads.push(entry);
    pendingReads.push(
      blob.text().then((text) => {
        entry.text = text;
      }),
    );
  };
  const pendingReads: Promise<void>[] = [];
  (window as unknown as { __characterizationReads: Promise<void>[] }).__characterizationReads =
    pendingReads;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  return { window, downloads };
}

async function drained(studio: Studio): Promise<Download[]> {
  const reads = (studio.window as unknown as { __characterizationReads: Promise<void>[] })
    .__characterizationReads;
  await Promise.all(reads);
  return studio.downloads;
}

function announcement(window: Window): string {
  return window.document.getElementById("announcement")?.textContent ?? "";
}

function click(window: Window, id: string): void {
  const node = window.document.getElementById(id);
  if (node === null) throw new Error(`expected #${id}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function setValue(window: Window, id: string, entry: string): void {
  const node = window.document.getElementById(id) as unknown as {
    value: string;
    dispatchEvent(event: unknown): boolean;
  } | null;
  if (node === null) throw new Error(`expected #${id}`);
  node.value = entry;
  node.dispatchEvent(new window.Event("input", { bubbles: true }));
  node.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function preview(window: Window): string {
  const node = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (node === null) throw new Error("expected #config-preview");
  return node.value;
}

async function settle(window: Window, done: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the Workbench announcement");
}

async function importFile(window: Window, inputId: string, text: string): Promise<string> {
  const input = window.document.getElementById(inputId);
  if (input === null) throw new Error(`expected #${inputId}`);
  const live = window.document.getElementById("announcement");
  if (live !== null) live.textContent = "";
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new window.File([text], "import.json", { type: "application/json" })],
  });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle(window, () => announcement(window) !== "");
  return announcement(window);
}

function basePolicy(): Record<string, unknown> {
  return structuredClone(tinyStudioModel().initialPolicy) as Record<string, unknown>;
}

function governance(policy: Record<string, unknown>): Record<string, unknown> {
  return policy.governance as Record<string, unknown>;
}

const hookControl = {
  id: "usage-metering",
  kind: "hook",
  description: "Fixture governed hook control",
  capabilities: [],
  risks: [],
  source: {
    type: "hook",
    handler: "usage-metering",
    scriptDigest: "sha256:0d6da4f993901e57da5fadb281ec54ae6b9516797c014c974b65125e8114ae37",
  },
  targets: ["claude", "codex"],
  projector: "usage-hook",
  lifecycle: "supported",
  evidence: { record: "aih-usage-metering" },
  findings: [],
  autoExecute: false,
};

/** Policy mutations whose import outcome is pinned verbatim. */
const importCases: ReadonlyArray<readonly [string, () => unknown]> = [
  ["unchanged initial policy", () => basePolicy()],
  [
    "enterprise posture without supported CLIs",
    () => ({ ...basePolicy(), minimumPosture: "enterprise" }),
  ],
  [
    "duplicate supported CLI entries",
    () => {
      const policy = basePolicy();
      governance(policy).supportedClis = ["codex", "codex"];
      return policy;
    },
  ],
  [
    "hidden Unicode in the governance policy version",
    () => {
      const policy = basePolicy();
      governance(policy).policyVersion = " 1";
      return policy;
    },
  ],
  [
    "activation of an unknown candidate",
    () => {
      const policy = basePolicy();
      governance(policy).activations = [
        { candidate: "missing-control", state: "active", targets: ["claude"] },
      ];
      return policy;
    },
  ],
  [
    "reviewed hook control with a narrowed target list",
    () => {
      const policy = basePolicy();
      governance(policy).catalog = {
        reviewed: [{ ...hookControl, targets: ["claude"] }],
        custom: [],
      };
      return policy;
    },
  ],
  [
    "active reviewed hook control",
    () => {
      const policy = basePolicy();
      governance(policy).catalog = { reviewed: [hookControl], custom: [] };
      governance(policy).activations = [
        { candidate: "usage-metering", state: "active", targets: ["claude", "codex"] },
      ];
      return policy;
    },
  ],
  [
    "active reviewed hook control outside the sanctioned CLI set",
    () => {
      const policy = basePolicy();
      governance(policy).supportedClis = ["gemini"];
      governance(policy).catalog = { reviewed: [hookControl], custom: [] };
      governance(policy).activations = [
        { candidate: "usage-metering", state: "active", targets: ["claude", "codex"] },
      ];
      return policy;
    },
  ],
  [
    "custom remote MCP projected to Kiro",
    () => {
      const policy = basePolicy();
      governance(policy).catalog = {
        reviewed: [],
        custom: [
          {
            id: "acme-remote",
            kind: "mcp",
            description: "Acme remote MCP",
            capabilities: [],
            risks: [],
            source: { type: "remote", url: "https://mcp.acme.example/" },
            targets: ["kiro"],
            projector: "mcp-server",
            lifecycle: "supported",
            evidence: { record: "acme-remote" },
            findings: [],
            autoExecute: false,
          },
        ],
      };
      return policy;
    },
  ],
  [
    "unsafe baseline override bundle path",
    () => ({
      ...basePolicy(),
      trust: {
        baselineOverrides: [{ bundle: "../escape.json", approvedAt: "yesterday" }],
      },
    }),
  ],
  [
    "duplicate external curation framework records",
    () => {
      const policy = basePolicy();
      governance(policy).externalCuration = [
        { framework: "ecc", items: [] },
        { framework: "ecc", items: [] },
      ];
      return policy;
    },
  ],
  ["policy without governance", () => ({ schemaVersion: 2, minimumPosture: "vibe" })],
  ["schema version 1 policy", () => ({ ...basePolicy(), schemaVersion: 1 })],
];

describe("legacy Workbench policy grammar characterization", () => {
  it.each(importCases)("pins the import outcome for %s", async (_label, build) => {
    const { window } = studio();
    const before = preview(window);
    const message = await importFile(window, "policy-file", JSON.stringify(build()));
    const after = preview(window);
    expect({ message, changed: after !== before }).toMatchSnapshot();
  });

  it("rejects a policy file that is not strict JSON", async () => {
    const { window } = studio();
    expect(
      await importFile(window, "policy-file", '{"schemaVersion":2,"schemaVersion":2}'),
    ).toMatchInlineSnapshot(`"Policy import rejected: duplicate JSON object key: schemaVersion"`);
    expect(await importFile(window, "policy-file", "[]")).toMatchInlineSnapshot(
      `"Policy import rejected: file import JSON root must be an object"`,
    );
  });

  it("pins the validate outcome for the initial policy in both postures", () => {
    const vibe = studio();
    click(vibe.window, "validate");
    const enterprise = studio(tinyEnterpriseStudioModel());
    click(enterprise.window, "validate");
    const enterpriseCleared = studio(tinyEnterpriseStudioModel());
    setValue(enterpriseCleared.window, "posture", "enterprise");
    click(enterpriseCleared.window, "validate");
    expect(
      [vibe, enterprise, enterpriseCleared].map(({ window }) => ({
        message: announcement(window),
        classes: window.document.getElementById("validate")?.className ?? "",
        title: window.document.getElementById("validate")?.getAttribute("title") ?? "",
        readiness: window.document.getElementById("deployment-readiness")?.textContent ?? "",
      })),
    ).toMatchSnapshot();
  });
});

describe("legacy Workbench download golden files", () => {
  it("downloads the organization policy byte-for-byte (aih-org-policy.json)", async () => {
    const vibe = studio();
    click(vibe.window, "download");
    const enterprise = studio(tinyEnterpriseStudioModel());
    setValue(enterprise.window, "policy-download-name", "payments-team-policy.json");
    click(enterprise.window, "download");
    const [vibeFile] = await drained(vibe);
    const [enterpriseFile] = await drained(enterprise);
    expect(vibeFile?.name).toBe("aih-org-policy.json");
    expect(enterpriseFile?.name).toBe("payments-team-policy.json");
    expect(vibeFile?.text).toBe(preview(vibe.window));
    await expect(vibeFile?.text).toMatchFileSnapshot("goldens/aih-org-policy.vibe.json");
    await expect(enterpriseFile?.text).toMatchFileSnapshot(
      "goldens/aih-org-policy.enterprise.json",
    );
    expect(announcement(enterprise.window)).toMatchInlineSnapshot(
      `"Policy download started. Validate this file with: aih policy validate <target-root> --policy payments-team-policy.json"`,
    );
  });

  it("downloads the organization policy after an imported transformation", async () => {
    const vibe = studio();
    const policy = basePolicy();
    governance(policy).catalog = { reviewed: [hookControl], custom: [] };
    governance(policy).activations = [
      { candidate: "usage-metering", state: "active", targets: ["claude", "codex"] },
    ];
    await importFile(vibe.window, "policy-file", JSON.stringify(policy));
    click(vibe.window, "download");
    const files = await drained(vibe);
    expect({
      files: files.map((file) => file.name),
      message: announcement(vibe.window),
    }).toMatchSnapshot();
    if (files[0] !== undefined)
      await expect(files[0].text).toMatchFileSnapshot("goldens/aih-org-policy.hook-control.json");
  });

  it("refuses unsafe policy filenames without downloading", async () => {
    const { window, downloads } = studio();
    setValue(window, "policy-download-name", "../policy.json");
    click(window, "download");
    expect(downloads).toEqual([]);
    expect(announcement(window)).toMatchInlineSnapshot(
      `"Download blocked: Use a JSON filename without folders, spaces, or hidden characters."`,
    );
  });

  it("downloads an imported decision byte-for-byte (aih-governance-decision.json)", async () => {
    const current = studio();
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
    await expect(file?.text).toMatchFileSnapshot("goldens/aih-governance-decision.json");
  });

  it("downloads the protected policy bundle byte-for-byte (aih-policy-bundle.json)", async () => {
    const current = studio(tinyEnterpriseStudioModel());
    setValue(current.window, "posture", "enterprise");
    for (const [id, entry] of Object.entries({
      "protected-bundle-version": "acme-policy-1",
      "protected-issuer-repository": "acme/aih-policy",
      "protected-issuer": "acme-security",
      "protected-issued-at": "2026-08-26T12:00:00Z",
      "protected-expires-at": "2026-09-25T12:00:00Z",
      "protected-decision-id": "decision-acme-linter-1",
      "protected-kind": "tool",
      "protected-subject-id": "acme-linter",
      "protected-source-repository": "acme/linter",
      "protected-source-commit": "a".repeat(40),
      "protected-source-path": "packages/cli",
      "protected-targets": "codex",
      "protected-effects": "observe,use",
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
    }))
      setValue(current.window, id, entry);
    const pending = current.window as unknown as { __aihPolicyWorkbenchPending?: Promise<void> };
    current.window.document
      .getElementById("protected-form")
      ?.dispatchEvent(new current.window.Event("submit", { bubbles: true, cancelable: true }));
    await pending.__aihPolicyWorkbenchPending;
    pending.__aihPolicyWorkbenchPending = undefined;
    click(current.window, "download-protected-bundle");
    await pending.__aihPolicyWorkbenchPending;
    click(current.window, "download-protected-evidence");
    const files = await drained(current);
    expect(files.map((file) => file.name)).toEqual(["aih-policy-bundle.json"]);
    await expect(files[0]?.text).toMatchFileSnapshot("goldens/aih-policy-bundle.json");
    // The legacy runtime never builds an organization evidence envelope
    // (protectedBuildDecision returns evidenceEnvelope: null), so the evidence
    // download control stays disabled and nothing downloads. Pinned as current
    // behaviour, not endorsed.
    const evidenceButton = current.window.document.getElementById(
      "download-protected-evidence",
    ) as unknown as { disabled: boolean } | null;
    expect(evidenceButton?.disabled).toBe(true);
    expect(
      (
        current.window.document.getElementById("protected-evidence-preview") as unknown as {
          value: string;
        } | null
      )?.value,
    ).toBe("");
  });

  it("downloads the artifact intake byte-for-byte (aih-artifact-intake.json)", async () => {
    const current = studio();
    const intakeApi = (
      current.window as unknown as {
        __aihArtifactIntake: { importIntakeText(text: string): Promise<void> };
      }
    ).__aihArtifactIntake;
    await intakeApi.importIntakeText(
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
    );
    click(current.window, "download-artifact-intake");
    const [file] = await drained(current);
    expect(file?.name).toBe("aih-artifact-intake.json");
    await expect(file?.text).toMatchFileSnapshot("goldens/aih-artifact-intake.json");
  });

  it("serializes the project policy byte-for-byte (aih-project-policy.json)", async () => {
    const admin = { kind: "administrator" } as const;
    const pin = {
      sourceId: "source:ecc",
      sourceRevisionId: "rev-1",
      contentDigest: sha("b"),
    };
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
    // Mirrors the user-door download serialization (user-door.ts).
    await expect(`${JSON.stringify(result.policy, null, 2)}\n`).toMatchFileSnapshot(
      "goldens/aih-project-policy.json",
    );
  });
});
