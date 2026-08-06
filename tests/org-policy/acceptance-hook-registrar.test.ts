import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
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

const OPERATOR_CONTENT = { permissions: { allow: ["Bash(ls:*)"] } };

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
    put(
      HOOK_REGISTRAR_DESTINATION,
      `${JSON.stringify(
        {
          ...OPERATOR_CONTENT,
          hooks: {
            Stop: [
              {
                hooks: eccStopRegistrations().map((registration) => ({
                  type: "command",
                  command: registration.command,
                })),
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    const policy = readOrgPolicy(root, {});
    if (policy === undefined) throw new Error("expected the authored policy to parse");

    // ── Project through the verified projector — the same path `aih policy
    // project` takes.
    const actions = await verifiedOrgPolicyProjectionActions(ctx(false), policy);
    await executePlan(plan("policy project", ...actions), ctx(true), { skipWorktreeGate: true });
    const projected = readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8");
    for (const registration of registrations) {
      expect(projected, `${registration.id} verbatim`).toContain(
        JSON.stringify(registration.command).slice(1, -1),
      );
    }
    const receipt = readHookRegistrarReceipt(root);
    expect(receipt?.policyVersion).toBe("2026-08-06.acceptance");
    expect(hookRegistrarState(root).state).toBe("active");

    // ── See the registrar panel: sources, overlaps, spawn counts.
    const html = policyStudioHtml(policyStudioModel());
    expect(html).toContain("hook-registry-rows");
    expect(html).toContain("hook-registry-overlaps");
    expect(html).toContain("hook-registry-spawns");
    expect(html.toLowerCase()).not.toContain("cost");

    // ── Mutate one destination entry: drift, named by owner and event.
    const tampered = JSON.parse(projected);
    tampered.hooks.Stop[0].hooks[0].command += " --tampered";
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
    const after = JSON.parse(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8"));
    expect(JSON.stringify(after)).not.toContain("run-with-flags.js");
    expect(after).toEqual(OPERATOR_CONTENT);
    expect(existsSync(join(root, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(false);
  });
});
