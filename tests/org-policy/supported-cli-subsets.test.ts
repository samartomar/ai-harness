import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalStrictJsonSha256V1 } from "../../src/contract/strict-json-v1.js";
import { GOVERNED_MCP_TARGETS } from "../../src/internals/cli-registry.js";
import { SUPPORTED_CLIS } from "../../src/internals/clis.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import {
  defaultStudioPolicy,
  exportStudioPolicy,
  type PolicyStudioModel,
  parseStudioPolicyImport,
  policyStudioModel,
} from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "../../src/org-policy/workbench/catalog-bundle.js";
import { parseAuthoringCatalogBundleV1 } from "../../src/org-policy/workbench/contracts.js";

function compactCliControlsModel(): PolicyStudioModel {
  const model = policyStudioModel();
  const bundle = model.workbenchBundle;
  const retainedAssets = ["code-review-graph", "usage-metering"].map((candidateId) => {
    const asset = Object.values(bundle.assets).find(
      (candidate) =>
        candidate.authoring.action === "select-control" &&
        model.workbenchBindings[candidate.id]?.kind === "control" &&
        model.workbenchBindings[candidate.id]?.candidate?.id === candidateId,
    );
    if (asset === undefined) throw new Error(`missing compact real control: ${candidateId}`);
    return asset;
  });
  for (const asset of retainedAssets) {
    if (
      bundle.relations.some(
        (relation) =>
          relation.fromAssetId === asset.id &&
          (relation.kind === "requires" || relation.membership === "required"),
      )
    )
      throw new Error(`compact real control gained a required relation: ${asset.id}`);
  }
  const assets = Object.fromEntries(retainedAssets.map((asset) => [asset.id, asset]));
  const sourceIds = new Set(retainedAssets.map((asset) => asset.sourceId));
  const sources = Object.fromEntries(
    [...sourceIds].sort().map((sourceId) => {
      const source = bundle.sources[sourceId];
      if (source === undefined) throw new Error(`missing compact source: ${sourceId}`);
      return [sourceId, source];
    }),
  );
  const detailChunks = Object.fromEntries(
    retainedAssets.map((asset) => {
      const chunk = bundle.detailChunks[asset.detailChunkId];
      if (chunk === undefined)
        throw new Error(`missing compact detail chunk: ${asset.detailChunkId}`);
      return [asset.detailChunkId, chunk];
    }),
  );
  const groups = Object.fromEntries(
    Object.values(bundle.groups).flatMap((group) => {
      const assetIds = group.assetIds.filter((assetId) => assets[assetId] !== undefined);
      return assetIds.length === 0 ? [] : [[group.id, { ...group, assetIds }]];
    }),
  );
  const compactBundle = {
    version: bundle.version,
    sources,
    assets,
    groups,
    relations: bundle.relations.filter(
      (relation) =>
        assets[relation.fromAssetId] !== undefined && assets[relation.toAssetId] !== undefined,
    ),
    templates: {},
    evidence: {},
    provenance: { bundleDigest: "" },
    detailChunks,
  };
  compactBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({
    ...compactBundle,
    provenance: {},
  })}`;
  const parsedBundle = parseAuthoringCatalogBundleV1(compactBundle);
  verifyAuthoringCatalogBundleIntegrityV1(parsedBundle);
  model.workbenchBundle = parsedBundle;
  model.workbenchBindings = Object.fromEntries(
    retainedAssets.map((asset) => {
      const binding = model.workbenchBindings[asset.id];
      if (binding === undefined) throw new Error(`missing compact binding: ${asset.id}`);
      return [asset.id, binding];
    }),
  );
  model.workbenchSourceInputs = Object.fromEntries(
    [...sourceIds].sort().flatMap((sourceId) => {
      const sourceInput = model.workbenchSourceInputs[sourceId];
      return sourceInput === undefined ? [] : [[sourceId, sourceInput]];
    }),
  );
  return model;
}

const model = compactCliControlsModel();
const workbenchHtml = policyStudioHtml(model);
const workbenchScripts = [...workbenchHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(
  (match) => match[1],
);
const WORKBENCH_TEST_TIMEOUT_MS = 45_000;
const WORKBENCH_IMPORT_TIMEOUT_MS = 15_000;
const controls = ["code-review-graph", "usage-metering"].map((candidateId) => {
  const binding = Object.values(model.workbenchBindings).find(
    (candidate) => candidate.kind === "control" && candidate.candidate?.id === candidateId,
  );
  if (binding?.candidate === undefined)
    throw new Error(`missing compact real control binding: ${candidateId}`);
  return binding.candidate;
});
const openWindows = new Set<Window>();

function subsets<T>(values: readonly T[]): T[][] {
  return Array.from({ length: 2 ** values.length - 1 }, (_, bits) =>
    values.filter((_value, index) => ((bits + 1) & (1 << index)) !== 0),
  );
}

function policyFor(
  control: (typeof controls)[number],
  supportedClis: readonly (typeof SUPPORTED_CLIS)[number][],
  targets: readonly string[],
) {
  return {
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "1",
      supportedClis,
      catalog: {
        reviewed: [
          {
            id: control.id,
            kind: control.kind,
            description: "AIH-provided governed control",
            capabilities: [],
            risks: [],
            source: control.source,
            targets: control.targets,
            projector: control.projector,
            lifecycle: control.lifecycle,
            evidence: { record: `aih-${control.id}` },
          },
        ],
        custom: [],
      },
      activations: [{ candidate: control.id, state: "active", targets }],
      authority: { approvals: [] },
    },
  };
}

function studio(): Window {
  const window = new Window({ url: "http://localhost/" });
  openWindows.add(window);
  window.document.write(workbenchHtml);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  if (workbenchScripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(workbenchScripts.join("\n"));
  return window;
}

afterEach(async () => {
  await Promise.all(
    [...openWindows].map(async (window) => {
      await window.happyDOM.close();
    }),
  );
  openWindows.clear();
});

function click(window: Window, selector: string): void {
  const node = window.document.querySelector(selector);
  if (node === null) throw new Error(`expected ${selector}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function selectCatalogControl(window: Window, controlId: string): void {
  const search = window.document.querySelector('input[aria-label="Search catalog"]') as unknown as {
    value: string;
    dispatchEvent(event: unknown): boolean;
  } | null;
  if (search === null) throw new Error("expected generic catalog search");
  search.value = controlId;
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  click(window, `button[data-workbench-row-action][data-workbench-asset-id="aih/${controlId}"]`);
}
function selectPosture(window: Window, value: "vibe" | "enterprise"): void {
  const node = window.document.getElementById("posture") as unknown as {
    value: string;
    dispatchEvent(event: unknown): boolean;
  } | null;
  if (node === null) throw new Error("expected posture selector");
  node.value = value;
  node.dispatchEvent(new window.Event("change", { bubbles: true }));
}

type ManagedMcpControl = {
  id: string;
  source: { type: "mcp"; server: string };
  targets: string[];
};

function isManagedMcpControl(value: unknown): value is ManagedMcpControl {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const source = candidate.source;
  return (
    typeof candidate.id === "string" &&
    Array.isArray(candidate.targets) &&
    candidate.targets.every((target) => typeof target === "string") &&
    source !== null &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    (source as Record<string, unknown>).type === "mcp" &&
    typeof (source as Record<string, unknown>).server === "string"
  );
}

function setManagedMcpProjection(window: Window, checked: boolean): void {
  const node = window.document.getElementById("managed-mcp-projection") as unknown as {
    checked: boolean;
    dispatchEvent(event: unknown): boolean;
  } | null;
  if (node === null) throw new Error("expected managed MCP projection checkbox");
  node.checked = checked;
  node.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function authored(window: Window) {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected authored policy preview");
  return JSON.parse(preview.value) as {
    minimumPosture?: string;
    governance: {
      supportedClis?: string[];
      catalog: { reviewed: Array<Record<string, unknown>> };
      activations: Array<{ candidate: string; targets: string[] }>;
    };
  };
}

async function importPolicy(window: Window, value: unknown): Promise<void> {
  const input = window.document.getElementById("policy-file");
  if (input === null) throw new Error("expected policy file input");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [
      new window.File([JSON.stringify(value)], "policy.json", {
        type: "application/json",
      }),
    ],
  });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  const pending = window as unknown as {
    __aihPolicyWorkbenchPending?: Promise<void>;
  };
  if (pending.__aihPolicyWorkbenchPending !== undefined) await pending.__aihPolicyWorkbenchPending;
  const deadline = Date.now() + WORKBENCH_IMPORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((window.document.getElementById("announcement")?.textContent ?? "").length > 0) return;
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the policy import announcement");
}

describe("organization-selected CLI activation scope", () => {
  it("accepts only the exact supported-target intersection for every non-empty registry subset", () => {
    for (const supportedClis of subsets(SUPPORTED_CLIS)) {
      for (const control of controls) {
        const exact = control.targets.filter((target) =>
          supportedClis.some((cli) => cli === target),
        );
        if (exact.length === 0) {
          expect(
            () => parseOrgPolicy(policyFor(control, supportedClis, control.targets)),
            `${control.id}: ${supportedClis.join(",")}`,
          ).toThrow(/has no projector for the organization-sanctioned CLI set/);
          continue;
        }

        expect(
          parseOrgPolicy(policyFor(control, supportedClis, exact)).governance?.activations[0]
            ?.targets,
          `${control.id}: ${supportedClis.join(",")}`,
        ).toEqual(exact);
        if (exact.length > 1) {
          expect(
            parseOrgPolicy(policyFor(control, supportedClis, [...exact].reverse())).governance
              ?.activations[0]?.targets,
            `${control.id}: reversed ${supportedClis.join(",")}`,
          ).toEqual([...exact].reverse());
        }
        if (exact.length !== control.targets.length) {
          expect(
            () => parseOrgPolicy(policyFor(control, supportedClis, control.targets)),
            `${control.id}: ${supportedClis.join(",")}`,
          ).toThrow(/must exactly match the organization-sanctioned projector targets/);
        }
      }
    }
  });

  it("keeps representative multi-control policies bound to each control's exact intersection", () => {
    const cases: ReadonlyArray<readonly (typeof SUPPORTED_CLIS)[number][]> = [
      ["claude"],
      ["codex", "kiro"],
      [...SUPPORTED_CLIS],
    ];
    for (const supportedClis of cases) {
      const [first, second] = controls;
      if (first === undefined || second === undefined)
        throw new Error("expected MCP and hook controls");
      const firstTargets = first.targets.filter((target) =>
        supportedClis.some((cli) => cli === target),
      );
      const secondTargets = second.targets.filter((target) =>
        supportedClis.some((cli) => cli === target),
      );
      const policy = policyFor(first, supportedClis, firstTargets);
      const secondPolicy = policyFor(second, supportedClis, secondTargets);
      policy.governance.catalog.reviewed.push(...secondPolicy.governance.catalog.reviewed);
      policy.governance.activations.push(...secondPolicy.governance.activations);

      expect(parseOrgPolicy(policy).governance?.activations).toEqual([
        { candidate: first.id, state: "active", targets: firstTargets },
        { candidate: second.id, state: "active", targets: secondTargets },
      ]);
    }
  });

  it(
    "rejects reviewed support metadata narrowed to match a narrowed activation",
    async () => {
      const control = controls.find((item) => item.id === "usage-metering");
      if (control === undefined) throw new Error("expected usage-metering control");
      const policy = policyFor(control, ["claude", "codex"], ["claude"]);
      const candidate = policy.governance.catalog.reviewed[0];
      if (candidate === undefined) throw new Error("expected reviewed candidate");
      candidate.targets = ["claude"];

      expect(() => parseOrgPolicy(policy)).toThrow(
        /reviewed control targets must exactly match AIH's shipped projector targets: claude, codex/,
      );

      const window = studio();
      await importPolicy(window, policy);
      expect(window.document.getElementById("announcement")?.textContent).toContain(
        "Policy import rejected",
      );
      expect(authored(window).governance.catalog.reviewed).toEqual([]);
    },
    WORKBENCH_TEST_TIMEOUT_MS,
  );

  it(
    "authors single-, two-, and all-CLI policies with exact per-control targets",
    () => {
      const cases = [
        {
          supported: ["claude"],
          control: "code-review-graph",
          targets: ["claude"],
        },
        {
          supported: ["cursor"],
          control: "code-review-graph",
          targets: ["cursor"],
        },
        {
          supported: ["kimi", "opencode"],
          control: "code-review-graph",
          targets: ["kimi", "opencode"],
        },
        {
          supported: ["claude", "codex"],
          control: "usage-metering",
          targets: ["claude", "codex"],
        },
        {
          supported: [...SUPPORTED_CLIS],
          control: "code-review-graph",
          targets: [...GOVERNED_MCP_TARGETS].sort(),
        },
      ] as const;

      for (const item of cases) {
        const window = studio();
        for (const cli of item.supported) click(window, `[data-sanctioned-cli="${cli}"]`);
        selectCatalogControl(window, item.control);
        const policy = authored(window);
        expect(policy.governance.activations).toContainEqual({
          candidate: item.control,
          state: "active",
          targets: item.targets,
          clarification: "Requested by: administrator",
        });
      }
    },
    WORKBENCH_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a reviewed hook when only an unsupported host is sanctioned",
    () => {
      const window = studio();
      click(window, '[data-sanctioned-cli="cursor"]');
      selectCatalogControl(window, "usage-metering");

      expect(authored(window).governance.activations).toEqual([]);
      expect(window.document.querySelector("#framework-rows .error")?.textContent).not.toBe("");
    },
    WORKBENCH_TEST_TIMEOUT_MS,
  );

  it(
    "keeps supported CLI choices independent from an ordinary posture change",
    () => {
      for (const supportedCli of ["kiro", "cursor"] as const) {
        const window = studio();
        click(window, `[data-sanctioned-cli="${supportedCli}"]`);
        selectCatalogControl(window, "code-review-graph");
        const before = authored(window);
        selectPosture(window, "vibe");

        const after = authored(window);
        expect(after.minimumPosture).toBe("vibe");
        expect(after.governance.supportedClis).toEqual(before.governance.supportedClis);
        expect(after.governance.activations).toEqual(before.governance.activations);
      }
    },
    WORKBENCH_TEST_TIMEOUT_MS,
  );
  it(
    "requires explicit managed MCP opt-in and every selected control host before export",
    async () => {
      const window = studio();
      expect(window.document.body.dataset.view).toBe("compose");
      const settings = window.document.getElementById("policy-settings");
      expect(settings?.closest("#workbench")).not.toBeNull();
      expect(
        window.document.getElementById("open-ecc-mcp")?.closest("#panel-author"),
      ).not.toBeNull();
      click(window, '[data-sanctioned-cli="claude"]');
      selectPosture(window, "enterprise");
      selectCatalogControl(window, "code-review-graph");

      const readiness = window.document.getElementById("deployment-readiness")?.textContent;
      expect(readiness).toContain(
        "Exact selected target intersections: code-review-graph → claude",
      );
      expect(readiness).toContain("enable managed MCP projection");
      window.document
        .getElementById("export")
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      expect(window.document.getElementById("announcement")?.textContent).toContain(
        "Export blocked",
      );

      setManagedMcpProjection(window, true);
      const policy = authored(window) as ReturnType<typeof authored> & {
        mcp?: { allowManagedOnly?: boolean; allowedServers?: string[] };
      };
      const control = controls.find(
        (candidate): candidate is ManagedMcpControl =>
          candidate.id === "code-review-graph" && isManagedMcpControl(candidate),
      );
      if (control === undefined) throw new Error("expected managed MCP control");
      expect(policy.minimumPosture).toBe("enterprise");
      expect(policy.governance.supportedClis).toEqual(["claude"]);
      expect(policy.governance.activations).toContainEqual({
        candidate: control.id,
        state: "active",
        targets: ["claude"],
        clarification: "Requested by: administrator",
      });
      expect(policy.mcp).toEqual({
        allowManagedOnly: true,
        allowedServers: [control.source.server],
      });
      expect(window.document.getElementById("deployment-readiness")?.textContent).toContain(
        "ready for the selected Core controls",
      );
      window.document
        .getElementById("export")
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      expect(window.document.getElementById("announcement")?.textContent).toContain(
        "preview refreshed",
      );

      selectCatalogControl(window, "code-review-graph");
      expect(authored(window).governance.activations).toEqual([]);
      setManagedMcpProjection(window, false);
      expect((authored(window) as { mcp?: unknown }).mcp).toBeUndefined();
      expect(
        (
          window.document.getElementById("managed-mcp-projection") as unknown as {
            checked: boolean;
          } | null
        )?.checked,
      ).toBe(false);

      await importPolicy(window, defaultStudioPolicy());
      expect((authored(window) as { mcp?: unknown }).mcp).toBeUndefined();
      expect(
        (
          window.document.getElementById("managed-mcp-projection") as unknown as {
            checked: boolean;
          } | null
        )?.checked,
      ).toBe(false);
    },
    WORKBENCH_TEST_TIMEOUT_MS,
  );
  it(
    "narrows existing reviewed activations when the sanctioned set narrows",
    () => {
      const window = studio();
      click(window, '[data-sanctioned-cli="claude"]');
      click(window, '[data-sanctioned-cli="kiro"]');
      selectCatalogControl(window, "code-review-graph");
      expect(authored(window).governance.activations[0]?.targets).toEqual(["claude", "kiro"]);

      click(window, '[data-sanctioned-cli="kiro"]');
      expect(authored(window).governance.activations[0]?.targets).toEqual(["claude"]);
    },
    WORKBENCH_TEST_TIMEOUT_MS,
  );

  it(
    "deterministically narrows a legacy Workbench activation without changing support metadata",
    async () => {
      const control = controls.find((item) => item.id === "code-review-graph");
      if (control === undefined) throw new Error("expected code-review-graph control");
      const source = studio();
      click(source, '[data-sanctioned-cli="claude"]');
      selectCatalogControl(source, "code-review-graph");
      const legacy = authored(source);
      const invalidV3 = structuredClone(legacy);
      const invalidV3Activation = invalidV3.governance.activations[0];
      if (invalidV3Activation === undefined) throw new Error("expected authored V3 activation");
      invalidV3Activation.targets = [...control.targets];
      expect(() => parseStudioPolicyImport(JSON.stringify(invalidV3))).toThrow(
        "must exactly match the organization-sanctioned projector targets",
      );
      const versionedLegacy = legacy as typeof legacy & {
        schemaVersion?: number;
        authoringSelections?: unknown;
        minimumCoreVersion?: string;
        authoringSources?: unknown;
      };
      versionedLegacy.schemaVersion = 2;
      delete versionedLegacy.authoringSelections;
      delete versionedLegacy.minimumCoreVersion;
      delete versionedLegacy.authoringSources;
      const legacyActivation = legacy.governance.activations[0];
      const legacyCandidate = legacy.governance.catalog.reviewed[0];
      if (legacyActivation === undefined || legacyCandidate === undefined)
        throw new Error("expected authored legacy control");
      // Earlier V2 Workbench exports omitted schema-defaulted candidate fields.
      delete (legacyCandidate as Record<string, unknown>).findings;
      delete (legacyCandidate as Record<string, unknown>).autoExecute;
      const managedServer = (legacyCandidate as { source?: { server?: unknown } }).source?.server;
      if (typeof managedServer !== "string") throw new Error("expected managed MCP server");
      (legacy as Record<string, unknown>).mcp = {
        allowManagedOnly: true,
        allowedServers: [managedServer],
      };
      legacyActivation.targets = [...control.targets];
      const headless = parseStudioPolicyImport(JSON.stringify(legacy));
      expect(headless.governance?.catalog.reviewed[0]?.targets).toEqual(control.targets);
      expect(headless.governance?.activations[0]?.targets).toEqual(["claude"]);
      expect(
        parseStudioPolicyImport(exportStudioPolicy(headless)).governance?.activations[0]?.targets,
      ).toEqual(["claude"]);
      const window = studio();

      await importPolicy(window, legacy);

      const policy = authored(window);
      expect(window.document.getElementById("announcement")?.textContent).toContain(
        "activation targets narrowed to the sanctioned projector intersection",
      );
      expect(policy.governance.catalog.reviewed[0]?.targets).toEqual(control.targets);
      expect(policy.governance.activations[0]?.targets).toEqual(["claude"]);

      const exported = JSON.stringify(policy);
      const reimported = studio();
      await importPolicy(reimported, JSON.parse(exported));
      expect(authored(reimported).governance.activations[0]?.targets).toEqual(["claude"]);
      expect(reimported.document.getElementById("announcement")?.textContent).toContain(
        "without transformation",
      );
    },
    WORKBENCH_TEST_TIMEOUT_MS,
  );
});
