import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { SUPPORTED_CLIS } from "../../src/internals/clis.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import {
  exportStudioPolicy,
  parseStudioPolicyImport,
  policyStudioModel,
} from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const workbenchHtml = policyStudioHtml(model);
const workbenchScripts = [...workbenchHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(
  (match) => match[1],
);
const WORKBENCH_TEST_TIMEOUT_MS = 45_000;
const controls = [model.catalog.mcp[0]?.control, model.catalog.hooks[0]?.control].filter(
  (control): control is NonNullable<typeof control> => control !== undefined,
);

function subsets<T>(values: readonly T[]): T[][] {
  return Array.from({ length: 2 ** values.length - 1 }, (_, bits) =>
    values.filter((_value, index) => ((bits + 1) & (1 << index)) !== 0),
  );
}

function policyFor(
  control: (typeof controls)[number],
  supportedClis: readonly (typeof SUPPORTED_CLIS)[number][],
  targets: readonly ("claude" | "codex" | "kiro")[],
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
  window.document.write(workbenchHtml);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  if (workbenchScripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(workbenchScripts.join("\n"));
  return window;
}

function click(window: Window, selector: string): void {
  const node = window.document.querySelector(selector);
  if (node === null) throw new Error(`expected ${selector}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function selectPreset(window: Window, value: "vibe" | "enterprise" | "custom"): void {
  const node = window.document.getElementById("preset-select") as unknown as {
    value: string;
    dispatchEvent(event: unknown): boolean;
  } | null;
  if (node === null) throw new Error("expected preset selector");
  node.value = value;
  node.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function authored(window: Window) {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected authored policy preview");
  return JSON.parse(preview.value) as {
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
    value: [new window.File([JSON.stringify(value)], "policy.json", { type: "application/json" })],
  });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  const pending = window as unknown as { __aihPolicyWorkbenchPending?: Promise<void> };
  if (pending.__aihPolicyWorkbenchPending !== undefined) await pending.__aihPolicyWorkbenchPending;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((window.document.getElementById("announcement")?.textContent ?? "").length > 0) return;
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
}

describe("organization-selected CLI activation scope", () => {
  it("accepts only the exact supported-target intersection for every non-empty registry subset", () => {
    for (const supportedClis of subsets(SUPPORTED_CLIS)) {
      for (const control of controls) {
        const exact = control.targets.filter((target) => supportedClis.includes(target));
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
      const firstTargets = first.targets.filter((target) => supportedClis.includes(target));
      const secondTargets = second.targets.filter((target) => supportedClis.includes(target));
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
        { supported: ["claude"], control: "code-review-graph", targets: ["claude"] },
        { supported: ["claude", "codex"], control: "usage-metering", targets: ["claude", "codex"] },
        {
          supported: [...SUPPORTED_CLIS],
          control: "code-review-graph",
          targets: ["claude", "kiro"],
        },
      ] as const;

      for (const item of cases) {
        const window = studio();
        for (const cli of item.supported) click(window, `[data-sanctioned-cli="${cli}"]`);
        click(window, `[data-reviewed="${item.control}"]`);
        const policy = authored(window);
        expect(policy.governance.activations).toContainEqual({
          candidate: item.control,
          state: "active",
          targets: item.targets,
          clarification: "Requested by: administrator",
        });
        expect(
          window.document.querySelector(`[data-row="${item.control}"]`)?.textContent,
        ).toContain(`Requested targets: ${item.targets.join(", ")}`);
      }
    },
    WORKBENCH_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a reviewed control when none of its targets is sanctioned",
    () => {
      const window = studio();
      click(window, '[data-sanctioned-cli="cursor"]');
      click(window, '[data-reviewed="code-review-graph"]');

      expect(authored(window).governance.activations).toEqual([]);
      expect(window.document.getElementById("announcement")?.textContent).toContain(
        "code-review-graph has no projector for the organization-sanctioned CLI set cursor",
      );
    },
    WORKBENCH_TEST_TIMEOUT_MS,
  );

  it(
    "rejects Vibe composition atomically when a sanctioned CLI cannot host every profile control",
    () => {
      for (const supportedCli of ["kiro", "cursor"] as const) {
        const window = studio();
        click(window, `[data-sanctioned-cli="${supportedCli}"]`);
        const before = authored(window);

        selectPreset(window, "vibe");

        expect(authored(window)).toEqual(before);
        expect(window.document.getElementById("announcement")?.textContent).toContain(
          "Vibe composition blocked because",
        );
        expect(window.document.getElementById("announcement")?.textContent).toContain(
          supportedCli === "kiro" ? "usage-metering" : "code-review-graph",
        );
        expect(window.document.getElementById("announcement")?.textContent).toContain(
          "nothing changed",
        );
      }
    },
    WORKBENCH_TEST_TIMEOUT_MS,
  );

  it(
    "narrows existing reviewed activations when the sanctioned set narrows",
    () => {
      const window = studio();
      click(window, '[data-sanctioned-cli="claude"]');
      click(window, '[data-sanctioned-cli="kiro"]');
      click(window, '[data-reviewed="code-review-graph"]');
      expect(authored(window).governance.activations[0]?.targets).toEqual(["claude", "kiro"]);

      click(window, '[data-sanctioned-cli="kiro"]');
      expect(authored(window).governance.activations[0]?.targets).toEqual(["claude"]);
    },
    WORKBENCH_TEST_TIMEOUT_MS,
  );

  it(
    "deterministically narrows a legacy Workbench activation without changing support metadata",
    async () => {
      const control = model.catalog.mcp.find((item) => item.id === "code-review-graph")?.control;
      if (control === undefined) throw new Error("expected code-review-graph control");
      const source = studio();
      click(source, '[data-sanctioned-cli="claude"]');
      click(source, '[data-reviewed="code-review-graph"]');
      const legacy = authored(source);
      const legacyActivation = legacy.governance.activations[0];
      if (legacyActivation === undefined) throw new Error("expected authored activation");
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
