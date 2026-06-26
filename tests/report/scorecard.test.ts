import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHARED_MARKER, sharedBlock } from "../../src/bootstrap-ai/canon.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { localPanels } from "../../src/report/local.js";
import { gradeOf, scorecardDigest } from "../../src/report/scorecard.js";

const DIR_NAME = "ai-coding";

interface CheckData {
  id: string;
  passed: boolean;
  source: string;
}
interface DimData {
  name: string;
  score: number;
  grade: string;
  weight: number;
  checks: CheckData[];
}
interface ScoreData {
  overall: number;
  grade: string;
  dimensions: DimData[];
}

let dir: string; // repo root
let home: string; // fake home for CLI config-dir detection
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-scorecard-"));
  home = mkdtempSync(join(tmpdir(), "aih-scorecard-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: DIR_NAME,
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: home, USERPROFILE: home },
    options: {},
    ...over,
  };
}

/** Write a file, creating parent dirs. */
function put(rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/** An in-sync CLAUDE.md bootloader (managed block matches the freshly generated body). */
function inSyncBootloader(): string {
  return mergeManagedBlock(undefined, sharedBlock(DIR_NAME), "# Repo — Claude Code");
}

/** A fully-wired canon: every maturity check passes (overall should be 100). */
function scaffoldFull(): void {
  put(`${DIR_NAME}/RULE_ROUTER.md`, "Read RULE_ROUTER.md first — routing.\n");
  put(`${DIR_NAME}/rules/agent-behavior-core.md`, "# Agent behavior core\n");
  put(`${DIR_NAME}/adapters/_shared-canonical-block.md`, sharedBlock(DIR_NAME).body);
  put(`${DIR_NAME}/REGENERATION.md`, "# Regeneration\n");
  put("CLAUDE.md", inSyncBootloader());
  put(".mcp.json", "{}");
  put(".claude/settings.json", "{}");
  put(".gitleaks.toml", "title = 'x'\n");
  put(".pre-commit-config.yaml", "repos: []\n");
  put(".git/hooks/pre-commit", "#!/bin/sh\n");
}

describe("scorecardDigest — off-canon", () => {
  it("returns undefined when there is no RULE_ROUTER.md (omitted like quality/repoinfo)", () => {
    expect(scorecardDigest(ctx())).toBeUndefined();
  });

  it("is absent from localPanels on a bare repo (no maturity panel emitted)", async () => {
    const panels = await localPanels(ctx());
    expect(panels.some((p) => p.describe.startsWith("Harness maturity"))).toBe(false);
  });
});

describe("scorecardDigest — fully wired", () => {
  it("scores 100/100 (mature) and flows into localPanels", async () => {
    scaffoldFull();
    const d = scorecardDigest(ctx());
    expect(d).toBeDefined();
    if (!d) throw new Error("expected a digest");
    expect(d.describe).toMatch(/Harness maturity — \d+\/100 \((mature|solid|emerging|nascent)\)/);
    const data = d.data as ScoreData;
    expect(data.overall).toBe(100);
    expect(data.grade).toBe("mature");
    expect(d.text).toContain("All maturity checks pass");

    const panels = await localPanels(ctx());
    expect(panels.some((p) => p.describe.startsWith("Harness maturity"))).toBe(true);
  });
});

describe("scorecardDigest — dimension math", () => {
  it("scores a half-passing dimension at 50 (round(1/2*100))", () => {
    // Router present, but rules/agent-behavior-core.md absent → layering 1 of 2.
    put(`${DIR_NAME}/RULE_ROUTER.md`, "Read RULE_ROUTER.md first.\n");
    const d = scorecardDigest(ctx());
    if (!d) throw new Error("expected a digest");
    const data = d.data as ScoreData;
    const layering = data.dimensions.find((dim) => dim.name === "layering");
    expect(layering?.score).toBe(50);
    expect(layering?.grade).toBe("emerging");
  });
});

describe("scorecardDigest — determinism", () => {
  it("is byte-stable across repeated runs (no dates/random)", () => {
    scaffoldFull();
    const a = scorecardDigest(ctx());
    const b = scorecardDigest(ctx());
    if (!a || !b) throw new Error("expected digests");
    expect(a.text).toBe(b.text);
    expect(a.describe).toBe(b.describe);
  });
});

describe("scorecardDigest — drift detection reuses the canon block logic", () => {
  it("fails bootloaders-in-sync when a bootloader's managed block is mutated", () => {
    put(`${DIR_NAME}/RULE_ROUTER.md`, "Read RULE_ROUTER.md first.\n");
    // A bootloader whose managed block does NOT match sharedCanonicalBlockBody.
    const drifted = mergeManagedBlock(
      undefined,
      { marker: SHARED_MARKER, note: "drift", body: "drifted body — still cites RULE_ROUTER.md" },
      "# Repo — Claude Code",
    );
    put("CLAUDE.md", drifted);

    const d = scorecardDigest(ctx());
    if (!d) throw new Error("expected a digest");
    const data = d.data as ScoreData;
    const sharing = data.dimensions.find((dim) => dim.name === "sharing");
    const inSync = sharing?.checks.find((c) => c.id === "bootloaders-in-sync");
    expect(inSync?.passed).toBe(false);
    expect(d.text).toContain("bootloaders-in-sync");
  });
});

describe("gradeOf — lifted band boundaries (85/70/50/0)", () => {
  it("maps the boundary scores to the correct grade", () => {
    expect(gradeOf(100)).toBe("mature");
    expect(gradeOf(85)).toBe("mature");
    expect(gradeOf(84)).toBe("solid");
    expect(gradeOf(70)).toBe("solid");
    expect(gradeOf(69)).toBe("emerging");
    expect(gradeOf(50)).toBe("emerging");
    expect(gradeOf(49)).toBe("nascent");
    expect(gradeOf(0)).toBe("nascent");
  });
});
