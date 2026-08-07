import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import { parseJsoncText } from "../../src/internals/merge.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  HOOK_REGISTRAR_DESTINATION,
  HOOK_REGISTRAR_RECEIPT_PATH,
  hookRegistrarDrift,
  hookRegistrarState,
  readHookRegistrarReceipt,
} from "../../src/org-policy/hook-registrar.js";
import { verifiedOrgPolicyProjectionActions } from "../../src/org-policy/project.js";
import { parseOrgPolicy, readOrgPolicy } from "../../src/org-policy/schema.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command as uninstallCommand } from "../../src/uninstall/index.js";
import {
  aihDispatcher,
  eccStopRegistrations,
  repositoryStopHook,
} from "./hook-registrar-fixtures.js";

/**
 * The representative acceptance journey, runnable as one command against a
 * temporary fixture root:
 *
 *   npx vitest run tests/org-policy/acceptance-hook-registrar.test.ts
 *
 * Author a governed policy selecting one framework and hook registrations;
 * project it; see the registrar panel with sources, overlaps, and spawn
 * counts; mutate one destination entry and one launcher hash and see drift
 * named by owner and event; uninstall and see third-party entries gone with
 * operator content intact. Everything runs against the fixture root created
 * below — never against a real checkout.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-acceptance-hook-registrar-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

function ctx(apply: boolean): PlanContext {
  const run = fakeRunner(() => ({ code: 0, stdout: "" }));
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    targets: ["claude"],
  };
}

/**
 * The operator's own bytes, authored by hand rather than serialized: a comment
 * outside the `hooks` span, four-space indent, a key order that is deliberately
 * not alphabetical, and a non-ASCII value. A2 claims uninstall leaves operator
 * content byte-identical, and only raw bytes can witness that — routing the
 * fixture through a serializer, or the assertion through `JSON.parse`, discards
 * every property under test and the claim passes without being examined.
 */
const OPERATOR_SETTINGS = `{
    // operator: this order mirrors our runbook — keep it
    "zebra": "ünicode ✓ café",
    "permissions": {
        "allow": [
            "Bash(ls:*)"
        ]
    },
    "apple": 1
}
`;

/** The same operator bytes as the third party left them: its Stop entries added. */
const SEEDED_SETTINGS = `{
    // operator: this order mirrors our runbook — keep it
    "zebra": "ünicode ✓ café",
    "permissions": {
        "allow": [
            "Bash(ls:*)"
        ]
    },
    "apple": 1,
    "hooks": {
        "Stop": [
            {
                "hooks": [
${eccStopRegistrations()
  .map(
    (registration) =>
      `                    { "type": "command", "command": ${JSON.stringify(registration.command)} }`,
  )
  .join(",\n")}
                ]
            }
        ]
    }
}
`;

/** Minimal structural view of a rendered node; the DOM lib is not in scope here. */
interface PanelNode {
  textContent: string | null;
  querySelector(selector: string): { textContent: string | null } | null;
  querySelectorAll(selector: string): Iterable<PanelNode>;
}

interface RegistrarPanel {
  /** One entry per rendered row, so a source can be tied to the row it labels. */
  rows: { id: string; text: string }[];
  overlaps: string;
  spawns: string;
}

/**
 * Read the registrar panel the way an operator does. The panel's content is
 * written by the page's own script, so the served html carries empty containers
 * and every id appears in it whether or not anything renders into them.
 * Executing the script and reading the resulting text is what makes an
 * assertion about the panel bite.
 */
function readRegistrarPanel(html: string): RegistrarPanel {
  const window = new Window({ url: "http://localhost/" });
  try {
    window.document.write(html);
    (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
      structuredClone;
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
    if (scripts.length === 0) throw new Error("expected generated workbench script");
    window.eval(scripts.join("\n"));
    const container = (id: string): PanelNode => {
      const node = window.document.getElementById(id);
      if (node === null) throw new Error(`workbench renders no #${id}`);
      return node as unknown as PanelNode;
    };
    return {
      rows: [...container("hook-registry-rows").querySelectorAll(".hookreg")].map((node) => ({
        id: node.querySelector("b")?.textContent ?? "",
        text: node.textContent ?? "",
      })),
      overlaps: container("hook-registry-overlaps").textContent ?? "",
      spawns: container("hook-registry-spawns").textContent ?? "",
    };
  } finally {
    // The evaluated script installs MutationObservers and document listeners.
    window.happyDOM.close();
  }
}

describe("acceptance — governed hook registrations on a temporary fixture root", () => {
  it("author → project → panel → mutate → drift by owner and event → uninstall", async () => {
    // ── Author. The measured multi-writer state, declared in the policy the
    // administrator owns: ECC's six Stop hooks, the repository's own Stop
    // hook, and AIH's dispatcher — one harness (ecc) selected.
    const registrations = [
      ...eccStopRegistrations(),
      repositoryStopHook(),
      aihDispatcher("Stop", ["continuity-checkpoint"]),
    ];
    put(
      "aih-org-policy.json",
      `${JSON.stringify(
        {
          schemaVersion: 1,
          minimumPosture: "enterprise",
          references: { repoContract: "ai-coding/project.json" },
          governance: {
            policyVersion: "2026-08-06.acceptance",
            catalog: { reviewed: [], custom: [] },
            externalSelections: [{ framework: "ecc", items: [] }],
            hookRegistrations: registrations,
          },
        },
        null,
        2,
      )}\n`,
    );
    // The destination the third party already wrote, beside operator content.
    put(HOOK_REGISTRAR_DESTINATION, SEEDED_SETTINGS);
    const policy = readOrgPolicy(root, {});
    if (policy === undefined) throw new Error("expected the authored policy to parse");

    // ── Project through the verified projector — the same path `aih policy
    // project` takes.
    const actions = await verifiedOrgPolicyProjectionActions(ctx(false), policy);
    await executePlan(plan("policy project", ...actions), ctx(true), { skipWorktreeGate: true });
    const projected = readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8");
    // Read it the way aih reads this destination. The operator's comment is
    // still in the file — preserving it is the point — so `JSON.parse` would
    // fail here on valid JSONC.
    const projectedHooks = (parseJsoncText(projected) as { hooks: Record<string, unknown[]> })
      .hooks;
    for (const registration of registrations) {
      // H2 is byte-for-byte, so the assertion is structural equality against the
      // destination's own entry. A substring test would also pass for a
      // projection that wrapped the launcher in a shell prefix or appended a
      // flag — the launcher would no longer be the source's own, which is
      // exactly what H2 forbids.
      expect(projectedHooks[registration.event], `${registration.id} verbatim`).toContainEqual({
        hooks: [{ type: "command", command: registration.command }],
      });
    }
    const receipt = readHookRegistrarReceipt(root);
    expect(receipt?.policyVersion).toBe("2026-08-06.acceptance");
    expect(hookRegistrarState(root).state).toBe("active");

    // ── See the registrar panel: sources, overlaps, spawn counts.
    //
    // SCOPE, stated so nothing here reads as more than it is. This step opens
    // the workbench an operator opens at this point in the journey, and that
    // page renders the SHIPPED catalog: `policyStudioModel()` takes no
    // arguments, so the eight registrations authored above cannot reach it and
    // nothing below observes them. Per-policy registration rendering does not
    // exist, deliberately — S1 rules the panel a read-only projection view over
    // rows authored elsewhere until registrations become authorable through the
    // grammar. So what this proves is that the panel is populated and
    // self-consistent with the catalog behind it, NOT that this journey's
    // registrations reach a surface. Per-assertion S1-S4 coverage lives in
    // tests/org-policy/studio-hook-registrar.test.ts; this step deliberately
    // keeps only what an operator would look at here.
    const model = policyStudioModel();
    const html = policyStudioHtml(model);
    const panel = readRegistrarPanel(html);
    const registry = model.catalog.hookRegistry;

    // Sources: each row read on its own, so a source cannot be credited to the
    // wrong row. A whole-container search would pass with the labels swapped —
    // and the AIH row's source is the bare string "AIH", which every
    // third-party row's body also contains.
    expect(panel.rows.map((row) => row.id)).toEqual(registry.entries.map((entry) => entry.id));
    for (const entry of registry.entries) {
      const row = panel.rows.find((candidate) => candidate.id === entry.id);
      expect(row, `${entry.id} row`).toBeDefined();
      expect(row?.text, `${entry.id} source`).toContain(`Source: ${entry.source}`);
    }

    // Overlaps: this model declares ONE registration, so it can carry no
    // overlap at all — `hookOverlaps` needs two sharing event-plus-tag. Assert
    // the branch that actually applies rather than looping over a collection
    // that is structurally always empty, which would assert nothing.
    expect(registry.overlaps).toHaveLength(0);
    expect(panel.overlaps).toContain("AIH never merges an overlap on your behalf");
    expect(panel.overlaps.toLowerCase()).not.toContain("automatically resolved");

    // Spawn counts: event and numbers asserted separately, so a copy fix (the
    // template currently renders the ungrammatical "1 entries") does not break
    // the test while a missing projection still does.
    expect(registry.spawnProjection.events.length).toBeGreaterThan(0);
    for (const event of registry.spawnProjection.events) {
      expect(panel.spawns, `${event.event} row`).toContain(event.event);
      expect(panel.spawns, `${event.event} spawns`).toContain(String(event.spawns));
    }
    expect(panel.spawns, "spawn total").toContain("Total:");
    expect(panel.spawns, "total entries").toContain(String(registry.spawnProjection.totalEntries));
    expect(panel.spawns, "total spawns").toContain(String(registry.spawnProjection.totalSpawns));
    expect(html.toLowerCase()).not.toContain("cost");

    // ── Mutate one destination entry: drift, named by owner and event.
    const tampered = parseJsoncText(projected) as {
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    const tamperedHook = tampered.hooks.Stop[0]?.hooks[0];
    if (tamperedHook === undefined) throw new Error("expected a projected Stop entry to tamper");
    tamperedHook.command += " --tampered";
    put(HOOK_REGISTRAR_DESTINATION, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(hookRegistrarState(root).state).toBe("drifted");
    const drift = hookRegistrarDrift({ destination: tampered, registrations });
    expect(drift.drifted.map((entry) => `${entry.id}/${entry.event}/${entry.reason}`)).toContain(
      "ecc-stop-session-summary/Stop/missing",
    );
    expect(drift.unowned.map((entry) => `${entry.owner}/${entry.event}`)).toContain("unknown/Stop");
    put(HOOK_REGISTRAR_DESTINATION, projected);
    expect(hookRegistrarState(root).state).toBe("active");

    // ── Mutate one launcher hash in the policy: refused at parse time as
    // drift, never a silent update.
    const [first, ...rest] = registrations;
    if (first === undefined || first.owner.kind !== "third-party") {
      throw new Error("expected a third-party registration");
    }
    expect(() =>
      parseOrgPolicy({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          policyVersion: "2026-08-06.acceptance",
          catalog: { reviewed: [], custom: [] },
          hookRegistrations: [{ ...first, command: `${first.command} --new-flag` }, ...rest],
        },
      }),
    ).toThrowError(/launcher hash .* no longer matches its pin .*drift, not a silent update/);

    // ── Uninstall: third-party entries gone, operator content intact,
    // adopted entries do not return.
    const uninstallCtx = ctx(true);
    await executePlan(await uninstallCommand.plan(uninstallCtx), uninstallCtx, {
      skipWorktreeGate: true,
    });
    // A2 on raw bytes: no parse between disk and assertion. The comment, the
    // four-space indent, the authored key order and the non-ASCII value are all
    // properties a parse would discard, so this equality is the only form of the
    // claim that can fail when the writer re-serializes.
    const after = readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8");
    expect(after).not.toContain("run-with-flags.js");
    expect(after).toBe(OPERATOR_SETTINGS);
    expect(existsSync(join(root, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(false);
  });
});
