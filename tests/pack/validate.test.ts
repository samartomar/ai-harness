import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { packValidateCommand } from "../../src/pack/status.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const PIN = "a".repeat(40);
const CONTEXT_DIR = "ai-coding";

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-pack-validate-"));
  home = mkdtempSync(join(tmpdir(), "aih-pack-validate-home-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function ctx(options: Record<string, unknown> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: workspace,
    contextDir: CONTEXT_DIR,
    apply: false,
    verify: true, // the runner forces verify for readOnly/alwaysVerify commands
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { USERPROFILE: home, HOME: home } }),
    // USERPROFILE isolates the machine `~/.claude/skills` root to the temp home.
    env: { USERPROFILE: home, HOME: home },
    posture: "vibe",
    options,
  };
}

function write(rel: string, body: string): void {
  const path = join(workspace, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

/** Write a committed lockfile with the given approved skills (like remove.test.ts's). */
function writeLock(names: string[]): void {
  write(
    "aih-skills.lock.json",
    JSON.stringify({
      schemaVersion: 1,
      skills: names.map((name) => ({
        name,
        source: `owner/repo@${PIN}`,
        commit: PIN,
        verdict: "GREEN",
        scope: "repo",
        card: `${CONTEXT_DIR}/skill-cards/${name}.json`,
        evidenceSha256: "0".repeat(64),
        approvedBy: "docs-platform",
        approvedAt: "2026-01-01T00:00:00.000Z",
      })),
    }),
  );
}

/** A manifest ref that matches the writeLock defaults for `name`. */
function matchingRef(name: string): { name: string; source: string; commit: string } {
  return { name, source: `owner/repo@${PIN}`, commit: PIN };
}

function writePacks(packs: unknown[]): void {
  write("aih-packs.json", JSON.stringify({ schemaVersion: 1, packs }));
}

/** A promoted skill at `<ctx>/skills/<id>/<name>/SKILL.md`. */
function promoteSkill(id: string, name: string): void {
  write(join(CONTEXT_DIR, "skills", id, name, "SKILL.md"), `# ${name}\n`);
}

/** Execute the validate plan and return the verification checks. */
async function validate(c: PlanContext) {
  const result = await executePlan(await packValidateCommand.plan(c), c);
  if (result.report === undefined) throw new Error("expected a verification report");
  return result.report;
}

describe("packValidateCommand — the CI gate", () => {
  it("skips (never fails) when no aih-packs.json exists", async () => {
    const report = await validate(ctx());
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({
      name: "pack manifest",
      verdict: "skip",
      detail: "no aih-packs.json — no packs to validate",
    });
    expect(report.ok).toBe(true);
    expect(report.exitCode()).toBe(0);
  });

  it("passes each clean pack with a `pack <name> valid` check and exits 0", async () => {
    writeLock(["clean", "tidy"]);
    promoteSkill("owner-repo", "clean");
    writePacks([
      { name: "docs", skills: [matchingRef("clean")] },
      { name: "ops", skills: [matchingRef("tidy")] }, // approved, not installed — still valid
    ]);
    const report = await validate(ctx());
    expect(report.checks.map((c) => c.name).sort()).toEqual(["pack docs valid", "pack ops valid"]);
    expect(report.checks.every((c) => c.verdict === "pass")).toBe(true);
    expect(report.exitCode()).toBe(0);
  });

  it("fails with pack.missing-approval when a ref has no lock entry", async () => {
    writePacks([{ name: "docs", skills: [matchingRef("ghost")] }]);
    const report = await validate(ctx());
    const fail = report.checks.find((c) => c.verdict === "fail");
    expect(fail?.code).toBe("pack.missing-approval");
    expect(fail?.detail).toContain("ghost");
    // A blocked pack never earns a pass check.
    expect(report.checks.some((c) => c.name === "pack docs valid")).toBe(false);
    expect(report.exitCode()).toBe(1);
  });

  it("fails with pack.pin-mismatch when the manifest commit disagrees with the lock", async () => {
    writeLock(["clean"]);
    writePacks([
      {
        name: "docs",
        skills: [{ name: "clean", source: `owner/repo@${PIN}`, commit: "b".repeat(40) }],
      },
    ]);
    const report = await validate(ctx());
    const fail = report.checks.find((c) => c.verdict === "fail");
    expect(fail?.code).toBe("pack.pin-mismatch");
    expect(report.exitCode()).toBe(1);
  });

  it("fails BOTH packs with pack.duplicate-name for a cross-pack duplicate", async () => {
    writeLock(["clean"]);
    writePacks([
      { name: "a", skills: [matchingRef("clean")] },
      { name: "b", skills: [matchingRef("clean")] },
    ]);
    const report = await validate(ctx());
    const dups = report.checks.filter((c) => c.code === "pack.duplicate-name");
    expect(dups).toHaveLength(2);
    // Neither duplicated pack is "valid" even though both rollups are ready.
    expect(report.checks.some((c) => c.verdict === "pass")).toBe(false);
    expect(report.exitCode()).toBe(1);
  });

  it("fails a pack that lists the same skill twice with pack.duplicate-name", async () => {
    writeLock(["clean"]);
    writePacks([{ name: "a", skills: [matchingRef("clean"), matchingRef("clean")] }]);
    const report = await validate(ctx());
    const dups = report.checks.filter((c) => c.code === "pack.duplicate-name");
    expect(dups).toHaveLength(1);
    expect(report.exitCode()).toBe(1);
  });

  it("fails with pack.unknown-manifest when the file yields zero valid packs", async () => {
    writePacks([{ name: "broken" }]); // schema-invalid → dropped fail-soft
    const report = await validate(ctx());
    const fail = report.checks.find((c) => c.verdict === "fail");
    expect(fail?.code).toBe("pack.unknown-manifest");
    expect(report.exitCode()).toBe(1);
  });

  it("--pack narrows validation to the named pack", async () => {
    writeLock(["clean"]);
    writePacks([
      { name: "a", skills: [matchingRef("clean")] },
      { name: "b", skills: [matchingRef("ghost")] }, // would fail — out of view
    ]);
    const report = await validate(ctx({ pack: "a" }));
    expect(report.checks.map((c) => c.name)).toEqual(["pack a valid"]);
    expect(report.exitCode()).toBe(0);
  });

  it("declares the validate command shape (read-only, always-verify, options only)", () => {
    expect(packValidateCommand.readOnly).toBe(true);
    expect(packValidateCommand.alwaysVerify).toBe(true);
    expect(packValidateCommand.options?.map((o) => o.flags)).toEqual(["--pack <name>"]);
  });
});
