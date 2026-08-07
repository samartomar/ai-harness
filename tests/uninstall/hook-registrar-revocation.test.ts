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
 * The ONE digest line that names `path`. Substring checks against the whole
 * digest text pass on a row that belongs to some other artifact entirely.
 */
function digestRowFor(result: Awaited<ReturnType<typeof executePlan>>, path: string): string {
  const digest = result.digests.find((entry) => entry.describe.includes("core install footprint"));
  const rows = (digest?.text ?? "").split("\n").filter((line) => line.includes(path));
  expect(rows, `expected exactly one digest row naming ${path}`).toHaveLength(1);
  return rows[0] ?? "";
}

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

  /**
   * H6/A2: the projection commits the destination write and the receipt write
   * in that order, so a crash between them leaves projected launchers on disk
   * with nothing to attribute them. Uninstall used to say nothing at all about
   * that state — no artifact, no advisory, no digest line — silently leaving
   * behind exactly the entries that have no other removal path. It must name
   * them. It must still not delete them: with no receipt aih cannot prove it
   * emitted them, and proving ownership is the whole authority to remove.
   */
  it("names entries left with no receipt, and still removes nothing", async () => {
    seedThirdPartyDestination();
    await projectOwnership();
    const projected = readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8");
    rmSync(join(root, HOOK_REGISTRAR_RECEIPT_PATH));

    const result = await uninstall();
    // Bind the assertions to ONE row: the fixture emits other advisory rows, so
    // three substrings matched anywhere in the digest would pass on a digest
    // that never mentions the destination at all.
    const row = digestRowFor(result, HOOK_REGISTRAR_DESTINATION);
    expect(row).toMatch(/\[advisory\]/);
    expect(row.toLowerCase()).toContain("hook");
    expect(row).toMatch(/receipt/);
    expect(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8")).toBe(projected);
  });

  it("stays silent about a destination with no hook entries at all", async () => {
    put(HOOK_REGISTRAR_DESTINATION, `${JSON.stringify(OPERATOR_CONTENT, null, 2)}\n`);
    const result = await uninstall();
    const digest = result.digests.find((entry) =>
      entry.describe.includes("core install footprint"),
    );
    expect(digest?.text).not.toContain(HOOK_REGISTRAR_DESTINATION);
  });
});

/** A hook group the operator wrote themselves. AIH never emitted it and never adopted it. */
const OPERATOR_GROUP = {
  matcher: "Edit|Write",
  hooks: [{ type: "command", command: "node ./tools/operator-guard.mjs" }],
};

/** An `Object.prototype` member name, typed as the plain event name it is on disk. */
const PROTOTYPE_EVENT: string = "constructor";

/**
 * Put an operator's own comment in the destination, the way a JSONC file carries
 * one: spliced in directly after the opening brace.
 *
 * Written as an explicit splice rather than a first-occurrence `.replace("{",
 * …)`. Replacing every `{` would corrupt the JSON, so the single replace was
 * deliberate — but a single-occurrence replace is the shape static analysis
 * reads as incomplete sanitization, and this helper is not sanitizing anything.
 * The position is asserted instead of pattern-matched, so a destination that is
 * not an object fails the test loudly rather than being silently mis-commented.
 */
function addOperatorComment(): string {
  const text = readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8");
  expect(text.startsWith("{"), "expected a JSON object destination to comment").toBe(true);
  const contents = `{\n  // operator note: keep this file${text.slice(1)}`;
  put(HOOK_REGISTRAR_DESTINATION, contents);
  return contents;
}

/** Rewrite the destination's `hooks` key through `mutate`, leaving every other key alone. */
function rewriteHooks(mutate: (hooks: Record<string, unknown>) => void): string {
  const current = JSON.parse(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8"));
  mutate(current.hooks);
  const contents = `${JSON.stringify(current, null, 2)}\n`;
  put(HOOK_REGISTRAR_DESTINATION, contents);
  return contents;
}

/**
 * The measured baseline of the destination this projector owns: the repository,
 * ECC and AIH all write one `.claude/settings.json`. Before delegated ruling 6
 * one operator hook group anywhere under `hooks` read as drift, and uninstall
 * answered "cannot prove clean ownership — remediate manually" — stranding every
 * projected third-party entry, which is the one thing H6 forbids.
 */
describe("H6 — uninstall subtracts owned hook groups out of a cohabited destination", () => {
  it("removes the owned groups when an operator group cohabits another event", async () => {
    seedThirdPartyDestination();
    await projectOwnership();
    rewriteHooks((hooks) => {
      hooks.PreToolUse = [OPERATOR_GROUP];
    });

    const result = await uninstall();

    const after = JSON.parse(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8"));
    expect(JSON.stringify(after)).not.toContain("run-with-flags.js");
    // The parsed structure whole: a subtraction that also dropped, reordered or
    // rewrote the operator's group fails here.
    expect(after.hooks).toEqual({ PreToolUse: [OPERATOR_GROUP] });
    expect(after.permissions).toEqual(OPERATOR_CONTENT.permissions);
    expect(after.model).toBe(OPERATOR_CONTENT.model);
    expect(existsSync(join(root, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(false);

    const row = digestRowFor(result, HOOK_REGISTRAR_DESTINATION);
    expect(row).toMatch(/\[subtract\]/);
    expect(row).not.toMatch(/remediate manually/);
    // The reason names what survives, and the count has to be the real one.
    expect(row).toContain("1 hook entry");
  });

  it("removes the owned groups when an operator group cohabits the same event", async () => {
    seedThirdPartyDestination();
    await projectOwnership();
    rewriteHooks((hooks) => {
      (hooks.Stop as unknown[]).push(OPERATOR_GROUP);
    });

    const result = await uninstall();

    const after = JSON.parse(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8"));
    expect(JSON.stringify(after)).not.toContain("run-with-flags.js");
    expect(after.hooks).toEqual({ Stop: [OPERATOR_GROUP] });
    expect(existsSync(join(root, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(false);
    expect(digestRowFor(result, HOOK_REGISTRAR_DESTINATION)).toMatch(/\[subtract\]/);
  });

  /**
   * Event names come from the destination. A bare lookup of the owned groups by
   * an event named after an `Object.prototype` member resolves to a function
   * through the prototype chain and throws an untyped TypeError. The call in
   * `coreUninstallSet` is bare, so that took the WHOLE uninstall plan down — it
   * could not even emit its advisory row, stranding exactly the third-party
   * launchers this row exists to free.
   */
  it("plans and subtracts around an operator group under a prototype-named event", async () => {
    seedThirdPartyDestination();
    await projectOwnership();
    rewriteHooks((hooks) => {
      hooks[PROTOTYPE_EVENT] = [OPERATOR_GROUP];
    });

    const result = await uninstall();

    const after = JSON.parse(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8"));
    expect(JSON.stringify(after)).not.toContain("run-with-flags.js");
    expect(Object.getOwnPropertyNames(after.hooks)).toEqual(["constructor"]);
    expect(after.hooks.constructor).toEqual([OPERATOR_GROUP]);
    expect(after.permissions).toEqual(OPERATOR_CONTENT.permissions);
    expect(digestRowFor(result, HOOK_REGISTRAR_DESTINATION)).toMatch(/\[subtract\]/);
  });

  /**
   * The subtraction write is a parse-and-re-serialize, so it drops every
   * comment in the file. Refusing a commented destination beats silently
   * stripping it, and the advisory has to say comments are why — otherwise the
   * operator cannot tell this apart from ordinary drift.
   */
  it("refuses a commented cohabited destination and names comments as the reason", async () => {
    seedThirdPartyDestination();
    await projectOwnership();
    rewriteHooks((hooks) => {
      hooks.PreToolUse = [OPERATOR_GROUP];
    });
    const commented = addOperatorComment();

    const result = await uninstall();

    const row = digestRowFor(result, HOOK_REGISTRAR_DESTINATION);
    expect(row).toMatch(/\[advisory\]/);
    expect(row).toMatch(/comment/i);
    expect(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8")).toBe(commented);
    expect(existsSync(join(root, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(true);
  });

  /**
   * The footer promised "their file is never deleted" whenever ANY artifact was
   * subtract — printed directly under a hook-registrar row whose own reason says
   * the destination AIH created is removed. Both cannot be true, and the row is
   * the one describing what the plan actually does.
   */
  it("never promises a subtracted file survives while a row says it is deleted", async () => {
    // No seeded destination: AIH creates it, so revocation removes it outright.
    await projectOwnership();

    const result = await uninstall();

    const row = digestRowFor(result, HOOK_REGISTRAR_DESTINATION);
    expect(row).toMatch(/\[subtract\]/);
    expect(row).toContain("removed with them");
    const digest = result.digests.find((entry) =>
      entry.describe.includes("core install footprint"),
    );
    expect(digest?.text).not.toContain("their file is never deleted");
    expect(existsSync(join(root, HOOK_REGISTRAR_DESTINATION))).toBe(false);
  });

  it("still promises subtracted files survive when the plan deletes none", async () => {
    seedThirdPartyDestination();
    await projectOwnership();

    const result = await uninstall();

    const digest = result.digests.find((entry) =>
      entry.describe.includes("core install footprint"),
    );
    expect(digest?.text).toContain("their file is never deleted");
    expect(existsSync(join(root, HOOK_REGISTRAR_DESTINATION))).toBe(true);
  });

  /**
   * The receipt-side sibling of the case above. There the prototype-named event
   * came from the DESTINATION; here it comes from the RECEIPT, which the one
   * composer keys the owned groups by. Hand-authored bytes on purpose: the
   * grammar now refuses to write such a receipt, and the threat is a corrupt or
   * attacker-influenced receipt file — strictly more load-bearing since per-group
   * subtraction removed the whole-key corroboration. It must degrade to the
   * advisory this projector already has, not take the whole uninstall plan down.
   */
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "plans an advisory around a receipt entry on the event %s",
    async (event) => {
      seedThirdPartyDestination();
      await projectOwnership();
      const projected = readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8");
      const receiptPath = join(root, HOOK_REGISTRAR_RECEIPT_PATH);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        entries: { event: string }[];
      };
      for (const entry of receipt.entries) entry.event = event;
      put(HOOK_REGISTRAR_RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);

      const result = await uninstall();

      const row = digestRowFor(result, HOOK_REGISTRAR_DESTINATION);
      expect(row).toMatch(/\[advisory\]/);
      expect(row).toMatch(/receipt/);
      // Nothing removed and nothing rewritten: aih cannot prove ownership from a
      // receipt it refuses to read, and the launchers stay for remediation.
      expect(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8")).toBe(projected);
      expect(existsSync(receiptPath)).toBe(true);
    },
  );

  it("leaves everything alone when an operator entry sits inside a group AIH owns", async () => {
    seedThirdPartyDestination();
    await projectOwnership();
    const tampered = rewriteHooks((hooks) => {
      const stop = hooks.Stop as { hooks: unknown[] }[];
      stop[0]?.hooks.push({ type: "command", command: "node ./tools/operator-guard.mjs" });
    });

    const result = await uninstall();

    // Subtracting from inside a group AIH wrote would delete content AIH cannot
    // prove it emitted, so this stays the advisory it always was.
    const row = digestRowFor(result, HOOK_REGISTRAR_DESTINATION);
    expect(row).toMatch(/\[advisory\]/);
    expect(row).toMatch(/remediate manually/);
    expect(readFileSync(join(root, HOOK_REGISTRAR_DESTINATION), "utf8")).toBe(tampered);
    expect(existsSync(join(root, HOOK_REGISTRAR_RECEIPT_PATH))).toBe(true);
  });
});
