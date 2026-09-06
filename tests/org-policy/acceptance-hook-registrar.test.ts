import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
          schemaVersion: 2,
          minimumPosture: "enterprise",
          references: { repoContract: "ai-coding/project.json" },
          governance: {
            policyVersion: "2026-08-06.acceptance",
            supportedClis: ["claude"],
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
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          policyVersion: "2026-08-06.acceptance",
          supportedClis: ["claude"],
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
