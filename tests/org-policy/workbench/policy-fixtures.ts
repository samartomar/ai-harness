/**
 * The policy fixtures of the Workbench shell parity tests: plain policy data
 * with no DOM. They live apart from `shell-parity-harness.ts`, which loads
 * happy-dom and the hand-built page, so pure tests can use them without
 * paying for a browser.
 */
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

export function basePolicy(): Record<string, unknown> {
  return structuredClone(tinyStudioModel().initialPolicy) as Record<string, unknown>;
}

export function governance(policy: Record<string, unknown>): Record<string, unknown> {
  return policy.governance as Record<string, unknown>;
}

export const hookControl = {
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
export const importCases: ReadonlyArray<readonly [string, () => unknown]> = [
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
  // An imported schema-3 policy is re-projected through the prepared catalog
  // (main.ts, shared by both shells): the stale reviewed hook activation is
  // dropped by the projection, so the preview differs from the imported bytes.
  [
    "schema version 3 policy re-projected through the prepared catalog",
    () => {
      const policy = {
        ...basePolicy(),
        schemaVersion: 3,
        minimumCoreVersion: "0.6.0",
        authoringSelections: {
          selectionVersion: "workbench-selection/v1",
          roots: [],
          exclusions: [],
          requests: [],
          drafts: [],
        },
      };
      governance(policy).catalog = { reviewed: [hookControl], custom: [] };
      governance(policy).activations = [
        { candidate: "usage-metering", state: "active", targets: ["claude", "codex"] },
      ];
      return policy;
    },
  ],
];

export const githubControl = {
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

/** A studio model whose prepared bindings also carry the built-in GitHub MCP control. */
export function managedMcpStudioModel(): PolicyStudioModel {
  const model = tinyStudioModel();
  (model.workbenchBindings as Record<string, unknown>)["fixture:github"] = {
    kind: "control",
    candidate: githubControl,
  };
  return model;
}

export function enterpriseManagedPolicy(supportedClis: string[]): Record<string, unknown> {
  const policy = { ...basePolicy(), minimumPosture: "enterprise" };
  governance(policy).supportedClis = supportedClis;
  governance(policy).catalog = { reviewed: [githubControl], custom: [] };
  governance(policy).activations = [
    {
      candidate: "github",
      state: "active",
      targets: ["claude", "codex"],
      clarification: "Requested by: enterprise profile",
    },
  ];
  return policy;
}

/**
 * The schema-2 import migrations (legacy `oe` managed MCP projection and `ze`
 * activation-target narrowing): the announced message and the exact preview
 * bytes after import. Captured from the legacy shell; the new shell must
 * reproduce both (new-shell-download-compat.test.ts).
 */
export const importMigrationCases: ReadonlyArray<
  readonly [string, () => PolicyStudioModel, () => unknown]
> = [
  [
    "narrowed-activation-targets",
    tinyStudioModel,
    () => {
      const policy = basePolicy();
      governance(policy).supportedClis = ["codex"];
      governance(policy).catalog = { reviewed: [hookControl], custom: [] };
      governance(policy).activations = [
        { candidate: "usage-metering", state: "active", targets: ["claude", "codex"] },
      ];
      return policy;
    },
  ],
  [
    "managed-mcp-non-projectable-removed",
    tinyStudioModel,
    () => enterpriseManagedPolicy(["claude", "codex"]),
  ],
  // With a projectable binding the migrated policy reaches the fixture schema,
  // which rejects it; pinned as current behaviour (the successful restoration
  // is pinned headlessly in shell-extracted-semantics.test.ts).
  [
    "managed-mcp-projectable-schema-rejected",
    managedMcpStudioModel,
    () => enterpriseManagedPolicy(["codex"]),
  ],
];
