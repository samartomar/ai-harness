import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCapability } from "../../src/commands/run.js";
import { type CommandSpec, plan, probe } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-run-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal verify-gate capability: one passing probe + one FAILING drift probe. */
const gateSpec: CommandSpec = {
  name: "gate",
  summary: "test gate",
  alwaysVerify: true,
  options: [{ flags: "--sarif <file>", description: "emit SARIF" }],
  plan: () =>
    plan(
      "gate",
      probe("ok", () => ({ name: "ok", verdict: "pass" })),
      probe("drift", () => ({ name: "drift", verdict: "fail", detail: "drifted" })),
    ),
};

/** A capability that does NOT alwaysVerify — its probe only runs when verify is on. */
const plainSpec: CommandSpec = {
  name: "plain",
  summary: "test plain",
  options: [{ flags: "--sarif <file>", description: "emit SARIF" }],
  plan: () =>
    plan(
      "plain",
      probe("ok", () => ({ name: "ok", verdict: "pass" })),
    ),
};

/** Build a standalone commander Command for a spec, populated from `argv`. */
function command(argv: string[]): Command {
  const cmd = new Command("gate");
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  cmd.argument("[root]");
  cmd
    .option("--apply")
    .option("--verify")
    .option("--json")
    .option("--root <dir>")
    .option("--context-dir <dir>", "", "ai-coding")
    .option("--sarif <file>");
  cmd.parse(argv, { from: "user" });
  return cmd;
}

/** Run a spec (default `gateSpec`) with the given user args, capturing stdout. */
async function run(
  argv: string[],
  spec: CommandSpec = gateSpec,
): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runCapability(spec, command(argv), {
    run: fakeRunner(() => undefined),
    env: {},
    write: (t) => {
      out += t;
    },
  });
  return { code, out };
}

describe("runCapability — --sarif wiring", () => {
  it("writes the SARIF report to a file WITHOUT --apply (drift gate runs verify-only)", async () => {
    const { code, out } = await run(["--verify", "--sarif", "aih.sarif", "--root", dir]);
    // The failing probe still drives the exit code — SARIF emission is orthogonal.
    expect(code).toBe(1);
    expect(out).toContain("[sarif] aih.sarif");
    const sarif = JSON.parse(readFileSync(join(dir, "aih.sarif"), "utf8"));
    expect(sarif.version).toBe("2.1.0");
    const byRule = Object.fromEntries(
      sarif.runs[0].results.map((r: { ruleId: string; level: string }) => [r.ruleId, r.level]),
    );
    expect(byRule.drift).toBe("error");
    expect(byRule.ok).toBe("note");
  });

  it("streams a CLEAN SARIF document to stdout when the path is `-` (summary suppressed)", async () => {
    const { out } = await run(["--verify", "--sarif", "-", "--root", dir]);
    // stdout is pure SARIF so `… --sarif - > out.sarif` pipes a valid artifact.
    expect(out.trim().startsWith("{")).toBe(true);
    const sarif = JSON.parse(out);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results.map((r: { ruleId: string }) => r.ruleId)).toContain("drift");
    expect(out).not.toContain("[sarif]"); // the `-` path is the content, not a confirmation line
    expect(out).not.toContain("passed"); // the human summary is suppressed
  });

  it("emits no SARIF and no confirmation line when --sarif is absent", async () => {
    const { out } = await run(["--verify", "--root", dir]);
    expect(out).not.toContain("[sarif]");
    expect(existsSync(join(dir, "aih.sarif"))).toBe(false);
  });

  it("skips the confirmation line in --json mode but still writes the file", async () => {
    const { out } = await run(["--verify", "--json", "--sarif", "aih.sarif", "--root", dir]);
    expect(out).not.toContain("[sarif]"); // would corrupt the JSON stream
    expect(existsSync(join(dir, "aih.sarif"))).toBe(true);
  });

  it("implies --verify: a non-alwaysVerify capability emits SARIF from --sarif alone", async () => {
    // No `--verify` flag — naming the SARIF output is enough to run the probes.
    const { out } = await run(["--sarif", "out.sarif", "--root", dir], plainSpec);
    const sarif = JSON.parse(readFileSync(join(dir, "out.sarif"), "utf8"));
    expect(sarif.runs[0].results.map((r: { ruleId: string }) => r.ruleId)).toContain("ok");
    expect(out).toContain("[sarif] out.sarif");
  });
});
