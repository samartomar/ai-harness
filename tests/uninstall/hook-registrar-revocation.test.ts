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
  hookRegistrarProjectionActions,
} from "../../src/org-policy/hook-registrar.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command as uninstallCommand } from "../../src/uninstall/index.js";
import { eccStopRegistrations } from "../org-policy/hook-registrar-fixtures.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-uninstall-hook-registrar-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

function context(apply: boolean): PlanContext {
  const run = fakeRunner(() => ({ code: 0, stdout: "" }));
  return {
    root,
    contextDir: "ai-coding",
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

const OPERATOR_CONTENT = { permissions: { allow: ["Bash(ls:*)"] }, model: "operator-choice" };

/**
 * The measured defect, reproduced: a third party wrote Stop entries into the
 * client settings and ships no removal path; the operator owns other keys in
 * the same file.
 */
function seedThirdPartyDestination(): void {
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
}

async function projectOwnership(): Promise<void> {
  await executePlan(
    plan(
      "hook registrar",
      ...hookRegistrarProjectionActions(context(false), eccStopRegistrations()),
    ),
    context(true),
    { skipWorktreeGate: true },
  );
}

async function uninstall(): Promise<Awaited<ReturnType<typeof executePlan>>> {
  const ctx = context(true);
  return executePlan(await uninstallCommand.plan(ctx), ctx, { skipWorktreeGate: true });
}

describe("A2 — uninstall subtracts receipt-owned hook registrations, never replays", () => {
  it("removes third-party entries the third party cannot remove, operator content intact", async () => {
    seedThirdPartyDestination();
    await projectOwnership();
    expect(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8")).toContain(
      "run-with-flags.js",
    );

    await uninstall();

    const after = JSON.parse(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8"));
    // Third-party entries the source ships no removal for: gone.
    expect(JSON.stringify(after)).not.toContain("run-with-flags.js");
    expect(after.hooks).toBeUndefined();
    // Adopted entries do not return: the recorded prior bytes carried these
    // exact launchers and nothing replayed them.
    // Operator content: byte-identical values, no keys added or removed.
    expect(after).toEqual(OPERATOR_CONTENT);
    expect(existsSync(join(root, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(false);
  });

  it("names the receipt-owned destination in the dry-run preview", async () => {
    seedThirdPartyDestination();
    await projectOwnership();
    const ctx = context(false);
    const result = await executePlan(await uninstallCommand.plan(ctx), ctx, {
      skipWorktreeGate: true,
    });
    const digest = result.digests.find((entry) =>
      entry.describe.includes("core install footprint"),
    );
    expect(digest?.text).toContain(HOOK_REGISTRAR_DESTINATION);
    expect(digest?.text).toContain("hook registration");
  });

  it("leaves a drifted destination alone and says why", async () => {
    seedThirdPartyDestination();
    await projectOwnership();
    // The operator (or a third party) edits the owned hooks after projection.
    const drifted = JSON.parse(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8"));
    drifted.hooks.Stop = [];
    put(HOOK_REGISTRAR_DESTINATION, `${JSON.stringify(drifted, null, 2)}\n`);

    const result = await uninstall();
    const digest = result.digests.find((entry) =>
      entry.describe.includes("core install footprint"),
    );
    expect(digest?.text).toContain("advisory");
    expect(digest?.text.toLowerCase()).toContain("hook");
    // Nothing rewrote the drifted destination and the receipt survives for
    // manual remediation.
    expect(JSON.parse(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8"))).toEqual(
      drifted,
    );
    expect(existsSync(join(root, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(true);
  });

  it("never deletes unowned entries AIH did not emit", async () => {
    seedThirdPartyDestination();
    const before = readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8");
    await uninstall();
    // No receipt: the entries are not AIH's to remove (single-registrar rule),
    // so uninstall leaves every byte alone.
    expect(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8")).toBe(before);
  });
});
