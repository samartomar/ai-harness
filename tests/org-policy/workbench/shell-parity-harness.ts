/**
 * Shared happy-dom harness for the Workbench shell parity tests: the legacy
 * characterization (legacy-download-characterization.test.ts) and the new
 * shell's byte-compatibility checks (new-shell-download-compat.test.ts) drive
 * the same page hooks with the same inputs.
 */
import { TextEncoder } from "node:util";
import { Window } from "happy-dom";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../../src/org-policy/studio-template.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

const windows = new Set<Window>();
export const sha = (character: string) => `sha256:${character.repeat(64)}`;

export async function closeStudios(): Promise<void> {
  await Promise.all([...windows].map((window) => window.happyDOM.close()));
  windows.clear();
}

export interface Download {
  name: string;
  text: string;
}

export interface Studio {
  window: Window;
  downloads: Download[];
}

export function studio(
  model: PolicyStudioModel = tinyStudioModel(),
  pageUrl = "http://localhost/",
): Studio {
  const window = new Window({ url: pageUrl });
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

export async function drained(studio: Studio): Promise<Download[]> {
  const reads = (studio.window as unknown as { __characterizationReads: Promise<void>[] })
    .__characterizationReads;
  await Promise.all(reads);
  return studio.downloads;
}

export function announcement(window: Window): string {
  return window.document.getElementById("announcement")?.textContent ?? "";
}

export function click(window: Window, id: string): void {
  const node = window.document.getElementById(id);
  if (node === null) throw new Error(`expected #${id}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

export function setValue(window: Window, id: string, entry: string): void {
  const node = window.document.getElementById(id) as unknown as {
    value: string;
    dispatchEvent(event: unknown): boolean;
  } | null;
  if (node === null) throw new Error(`expected #${id}`);
  node.value = entry;
  node.dispatchEvent(new window.Event("input", { bubbles: true }));
  node.dispatchEvent(new window.Event("change", { bubbles: true }));
}

export function preview(window: Window): string {
  const node = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (node === null) throw new Error("expected #config-preview");
  return node.value;
}

export async function settle(window: Window, done: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the Workbench announcement");
}

export async function importFile(window: Window, inputId: string, text: string): Promise<string> {
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
