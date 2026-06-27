import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command } from "../../src/adopt/index.js";
import { SHARED_MARKER, sharedCanonicalBlockBody } from "../../src/bootstrap-ai/canon.js";
import { beginLine, endLine } from "../../src/internals/markers.js";
import type { Action, DigestAction, PlanContext, ProbeAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-adopt-cmd-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function put(rel: string, contents: string): void {
  const full = join(tmp, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function makeCtx(flags: { apply?: boolean; verify?: boolean } = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: tmp,
    contextDir: "ai-coding",
    apply: flags.apply ?? false,
    verify: flags.verify ?? false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: tmp },
    options: {},
  };
}

function digestOf(actions: Action[]): DigestAction | undefined {
  return actions.find((a): a is DigestAction => a.kind === "digest");
}
function probeOf(actions: Action[]): ProbeAction | undefined {
  return actions.find((a): a is ProbeAction => a.kind === "probe");
}

function divergentBootloader(): string {
  const body = `${sharedCanonicalBlockBody("ai-coding").trim()}\n\n## EICP project extension\n\n- keep this line`;
  return `# Preamble\n\n${beginLine(SHARED_MARKER, "src")}\n\n${body}\n\n${endLine(SHARED_MARKER)}\n`;
}

describe("aih adopt — Phase 1 (read-only)", () => {
  it("emits a digest and a probe, and writes nothing", async () => {
    put("CLAUDE.md", divergentBootloader());
    const actions = (await command.plan(makeCtx())).actions;
    expect(digestOf(actions)).toBeDefined();
    expect(probeOf(actions)).toBeDefined();
    // Phase 1 is analysis-only: no write actions, even when --apply is passed.
    const applyActions = (await command.plan(makeCtx({ apply: true }))).actions;
    expect(applyActions.some((a) => a.kind === "write")).toBe(false);
  });

  it("reports a marker-divergent canon with [adopt] and a preserved project line", async () => {
    put("CLAUDE.md", divergentBootloader());
    const d = digestOf((await command.plan(makeCtx())).actions);
    expect(d?.text).toContain("class: marker-divergent");
    expect(d?.text).toContain("[adopt]  CLAUDE.md");
    expect(d?.text).toMatch(/project line\(s\) preserved/);
  });

  it("flags a brownfield canon as canon.adoptable under --verify", async () => {
    put("CLAUDE.md", divergentBootloader());
    const actions = (await command.plan(makeCtx({ verify: true }))).actions;
    const check = await probeOf(actions)?.run(makeCtx({ verify: true }));
    expect(check?.verdict).toBe("skip");
    expect(check?.code).toBe("canon.adoptable");
  });

  it("greenfield → recommends init, no adoptable code", async () => {
    const actions = (await command.plan(makeCtx())).actions;
    expect(digestOf(actions)?.text).toContain("class: greenfield");
    expect(digestOf(actions)?.text).toContain("aih init");
    const check = await probeOf(actions)?.run(makeCtx());
    expect(check?.verdict).toBe("pass");
    expect(check?.code).toBeUndefined();
  });

  it("foreign-scheme lists legacy artifacts to retire", async () => {
    put("ai-coding/RULE_ROUTER.md", "# Router\n");
    put("CLAUDE.md", "# Bootloader\n");
    put("ai-coding/scripts/regenerate-adapters.ps1", "# ps\n");
    const d = digestOf((await command.plan(makeCtx())).actions);
    expect(d?.text).toContain("class: foreign-scheme");
    expect(d?.text).toContain("[retire] ai-coding/scripts/regenerate-adapters.ps1");
  });

  it("already-adopted → pass, nothing to do", async () => {
    const body = sharedCanonicalBlockBody("ai-coding").trim();
    put(
      "CLAUDE.md",
      `# Preamble\n\n${beginLine(SHARED_MARKER, "s")}\n\n${body}\n\n${endLine(SHARED_MARKER)}\n`,
    );
    const actions = (await command.plan(makeCtx())).actions;
    expect(digestOf(actions)?.text).toContain("class: already-adopted");
    const check = await probeOf(actions)?.run(makeCtx());
    expect(check?.verdict).toBe("pass");
  });
});
