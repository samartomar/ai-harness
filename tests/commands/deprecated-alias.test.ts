/**
 * Alias-before-removal deprecation machinery (v1.0.0 slice 2, issue #123).
 *
 * ZERO built-ins carry a deprecated alias today — these tests prove the
 * MECHANISM through the same registerSpec path built-ins use (specs injected
 * as `extra` flow through the identical registration), so the first real
 * rename only has to declare `deprecatedAliases: ["old-name"]`:
 *
 *  - the old name dispatches the SAME action (same plan, same flags);
 *  - invoking it emits exactly ONE stderr line naming the replacement;
 *  - invoking the canonical name emits nothing;
 *  - a spec without aliases registers exactly as before (no output change);
 *  - the alias is a visible commander alias (`name|alias` in help) — chosen
 *    over a hidden shadow command so the migration hint stays discoverable.
 *
 * Plugin specs can never reach this machinery: the registry strips
 * `deprecatedAliases` before registration (tests/plugins/registry.test.ts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CommandSpec, digest, plan } from "../../src/internals/plan.js";
import { buildProgram } from "../../src/program.js";

const WARNING =
  "aih: old-demo is deprecated — use renamed-demo (removal comes with the next major)\n";

/** A renamed capability still answering to its old name; `onPlan` observes dispatch. */
function renamedSpec(onPlan?: () => void): CommandSpec {
  return {
    name: "renamed-demo",
    summary: "deprecation-alias demo capability",
    deprecatedAliases: ["old-demo"],
    plan: () => {
      onPlan?.();
      return plan("renamed-demo", digest("demo", "alias demo plan ran"));
    },
  };
}

/** Build the program with `spec` on the standard registerSpec path, output suppressed. */
function programWith(spec: CommandSpec): Command {
  const program = buildProgram([spec]);
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  return program;
}

// The standard action path resolves posture from ambient env — scrub it around
// every test so an operator's environment can't flip outcomes, then restore.
let savedPosture: string | undefined;
let root: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  savedPosture = process.env.AIH_POSTURE;
  delete process.env.AIH_POSTURE;
  root = mkdtempSync(join(tmpdir(), "aih-alias-"));
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
  if (savedPosture === undefined) delete process.env.AIH_POSTURE;
  else process.env.AIH_POSTURE = savedPosture;
  process.exitCode = undefined;
});

/** Every stderr line the deprecation machinery wrote during the test. */
function deprecationLines(): string[] {
  return stderrSpy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((t: string) => t.includes("is deprecated"));
}

describe("deprecated alias — dispatch + one-line stderr warning", () => {
  it("the old name runs the SAME action and warns exactly once", async () => {
    let planRan = 0;
    const program = programWith(renamedSpec(() => planRan++));
    await program.parseAsync(["node", "aih", "old-demo", "--json", "--no-log", "--root", root]);

    expect(planRan).toBe(1); // the rename's plan executed through runCapability
    expect(deprecationLines()).toEqual([WARNING]); // exactly one line, exact text
    expect(process.exitCode ?? 0).toBe(0); // the warning never flips the exit code
  }, 20000); // full-program registration + parse can edge past 5s on slow Windows CI

  it("the canonical name emits no deprecation warning even though the alias exists", async () => {
    let planRan = 0;
    const program = programWith(renamedSpec(() => planRan++));
    await program.parseAsync(["node", "aih", "renamed-demo", "--json", "--no-log", "--root", root]);

    expect(planRan).toBe(1);
    expect(deprecationLines()).toEqual([]);
  }, 20000);

  it("a spec without deprecatedAliases registers alias-free with no output change", async () => {
    let planRan = 0;
    const spec: CommandSpec = {
      name: "plain-demo",
      summary: "no aliases declared",
      plan: () => {
        planRan++;
        return plan("plain-demo", digest("demo", "plain plan ran"));
      },
    };
    const program = programWith(spec);
    const cmd = program.commands.find((c) => c.name() === "plain-demo");
    expect(cmd?.aliases()).toEqual([]);

    await program.parseAsync(["node", "aih", "plain-demo", "--json", "--no-log", "--root", root]);
    expect(planRan).toBe(1);
    expect(deprecationLines()).toEqual([]);
  }, 20000);
});

describe("deprecated alias — the commander mechanism (visible by design)", () => {
  it("registers as a commander alias and help shows `name|alias` next to the replacement", () => {
    const program = programWith(renamedSpec());
    const cmd = program.commands.find((c) => c.name() === "renamed-demo");
    expect(cmd?.aliases()).toEqual(["old-demo"]);
    // NOT hidden: commander renders the first alias in the subcommand list, so a
    // pinned script's author finds the migration hint right where the old name was.
    expect(program.helpInformation()).toContain("renamed-demo|old-demo");
  });
});
