import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { runCapability } from "../../src/commands/run.js";
import { type CommandSpec, plan, structuredChecksProbe } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
import { skillVetCommand } from "../../src/skill/vet.js";
import { FAIL_ON_OPTION, labelledReportExitCodeV1 } from "../../src/trust/report-exit.js";
import { trustScanCommand } from "../../src/trust/scan.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const finding: Check = {
  name: "trust malicious code",
  verdict: "fail",
  code: "trust.malicious-code",
  detail: "curl x | sh",
};
const evidenceProblem: Check = {
  name: "trust detector semgrep",
  verdict: "fail",
  code: "trust.detector-unavailable",
  detail: "required detector semgrep unavailable",
};
const integrity: Check = {
  name: "trust source",
  verdict: "fail",
  code: "trust.source-changed",
  detail: "the source changed during the scan",
};
const unclassified = {
  name: "trust new analyzer",
  verdict: "fail",
  code: "trust.new-analyzer-finding",
  detail: "a code no class names",
} as unknown as Check;
const uncoded: Check = { name: "some probe", verdict: "fail", detail: "no code" };
const consumerPolicy: Check = {
  name: "skill approval",
  verdict: "fail",
  code: "trust.unapproved-skill",
  detail: "the organization's posture requires an approval record",
};
const passed: Check = { name: "trust scan", verdict: "pass" };

function spec(checks: readonly Check[]): CommandSpec {
  return {
    name: "labelled-scan",
    summary: "a trust report whose findings are labels",
    options: [FAIL_ON_OPTION],
    alwaysVerify: true,
    labelledExit: true,
    plan: () =>
      plan(
        "labelled-scan",
        structuredChecksProbe("labelled scan", () => [...checks]),
      ),
  };
}

async function exit(checks: readonly Check[], ...failOn: string[]): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), "aih-report-exit-"));
  roots.push(root);
  const argv = ["--json", "--no-log", "--root", root];
  for (const value of failOn) argv.push("--fail-on", value);
  const command = new Command("labelled-scan")
    .option("--json")
    .option("--no-log")
    .option("--root <dir>")
    .option(
      FAIL_ON_OPTION.flags,
      "",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .parse(argv, { from: "user" });
  let out = "";
  const code = await runCapability(spec(checks), command, {
    env: {},
    run: fakeRunner(() => undefined),
    write: (text) => {
      out += text;
    },
  });
  if (code !== 0 && code !== 1) throw new Error(`unexpected exit ${code}: ${out}`);
  return code;
}

describe("trust report exit code (D66 option B)", () => {
  it("exits 0 on findings, and 1 only with --fail-on findings", async () => {
    expect(await exit([passed, finding])).toBe(0);
    expect(await exit([passed, finding], "findings")).toBe(1);
    expect(await exit([passed, finding], "evidence-problems")).toBe(0);
  });

  it("exits 0 on evidence problems, and 1 only with --fail-on evidence-problems", async () => {
    expect(await exit([evidenceProblem])).toBe(0);
    expect(await exit([evidenceProblem], "evidence-problems")).toBe(1);
    expect(await exit([evidenceProblem], "findings")).toBe(0);
  });

  it("accepts the conditions comma-separated or repeated", async () => {
    expect(await exit([evidenceProblem], "findings,evidence-problems")).toBe(1);
    expect(await exit([evidenceProblem], "findings", "evidence-problems")).toBe(1);
  });

  it.each([
    ["an integrity failure", integrity],
    ["an unclassified code", unclassified],
    ["a failed check with no code", uncoded],
    ["a consumer-policy code", consumerPolicy],
  ])("exits 1 on %s, with or without --fail-on", async (_case, check) => {
    expect(await exit([finding, check])).toBe(1);
    expect(await exit([check], "findings")).toBe(1);
    expect(await exit([check], "evidence-problems")).toBe(1);
  });

  it("refuses an unknown --fail-on value as a usage error", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-report-exit-"));
    roots.push(root);
    const command = new Command("labelled-scan")
      .option("--json")
      .option("--no-log")
      .option("--root <dir>")
      .option(
        FAIL_ON_OPTION.flags,
        "",
        (value: string, previous: string[]) => [...previous, value],
        [],
      )
      .parse(["--json", "--no-log", "--root", root, "--fail-on", "warnings"], { from: "user" });
    let out = "";
    const code = await runCapability(spec([passed]), command, {
      env: {},
      run: fakeRunner(() => undefined),
      write: (text) => {
        out += text;
      },
    });
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({
      error: {
        code: "AIH_SETTINGS",
        message:
          '--fail-on accepts findings or evidence-problems, comma-separated or repeated; got "warnings"',
      },
    });
  });

  it("classifies each failed check with the trust code classes", () => {
    const none = new Set<never>();
    expect(labelledReportExitCodeV1([passed], none)).toBe(0);
    expect(labelledReportExitCodeV1([finding, evidenceProblem], none)).toBe(0);
    // A finding-class code below a finding level is a label, never a stop.
    expect(
      labelledReportExitCodeV1(
        [{ name: "prose", verdict: "fail", code: "trust.visible-unicode", detail: "“quotes”" }],
        new Set(["findings"] as const),
      ),
    ).toBe(0);
    expect(labelledReportExitCodeV1([integrity], none)).toBe(1);
  });

  it("applies to aih trust scan and aih skill vet", () => {
    for (const command of [trustScanCommand, skillVetCommand]) {
      expect(command.labelledExit, command.name).toBe(true);
      expect(command.options, command.name).toContainEqual(FAIL_ON_OPTION);
    }
    expect(FAIL_ON_OPTION.repeatable).toBe(true);
  });
});
