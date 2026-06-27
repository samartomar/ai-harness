import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command } from "../../src/adopt/index.js";
import { SHARED_MARKER, sharedCanonicalBlockBody } from "../../src/bootstrap-ai/canon.js";
import { beginLine, endLine } from "../../src/internals/markers.js";
import type { Action, DigestAction, PlanContext, ProbeAction } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
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

function makeCtx(flags: { apply?: boolean; verify?: boolean; run?: Runner } = {}): PlanContext {
  const run = flags.run ?? fakeRunner(() => undefined);
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
function probeNamed(actions: Action[], needle: string): ProbeAction | undefined {
  return actions.find((a): a is ProbeAction => a.kind === "probe" && a.describe.includes(needle));
}

function divergentBootloader(): string {
  const body = `${sharedCanonicalBlockBody("ai-coding").trim()}\n\n## EICP project extension\n\n- keep this line`;
  return `# Preamble\n\n${beginLine(SHARED_MARKER, "src")}\n\n${body}\n\n${endLine(SHARED_MARKER)}\n`;
}

describe("aih adopt — digest + routing", () => {
  it("emits a digest and probes; a brownfield canon yields convergence writes, greenfield none", async () => {
    put("CLAUDE.md", divergentBootloader());
    const actions = (await command.plan(makeCtx())).actions;
    expect(digestOf(actions)).toBeDefined();
    expect(probeOf(actions)).toBeDefined();
    // Brownfield: the carve + canon writes appear in the plan (dry-run shows them).
    const writes = actions.filter((a) => a.kind === "write").map((a) => a.path.replace(/\\/g, "/"));
    expect(writes).toContain("ai-coding/rules/project-canon-extension.md");
    expect(writes).toContain("CLAUDE.md");
    expect(writes).toContain(".aih-config.json");
  });

  it("greenfield writes nothing (init owns greenfield)", async () => {
    const actions = (await command.plan(makeCtx({ apply: true }))).actions;
    expect(actions.some((a) => a.kind === "write")).toBe(false);
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

  it("foreign-scheme lists legacy artifacts (report-only, never auto-deleted)", async () => {
    put("ai-coding/RULE_ROUTER.md", "# Router\n");
    put("CLAUDE.md", "# Bootloader\n");
    put("ai-coding/scripts/regenerate-adapters.ps1", "# ps\n");
    const d = digestOf((await command.plan(makeCtx())).actions);
    expect(d?.text).toContain("class: foreign-scheme");
    expect(d?.text).toContain("[legacy] ai-coding/scripts/regenerate-adapters.ps1");
  });

  it("surfaces a CLI-native footprint panel and flags import candidates", async () => {
    put("CLAUDE.md", divergentBootloader());
    put(".claude/agents/security-audit.md", "# security agent\n"); // tool-owned content
    put(".cursorrules", "Read `ai-coding/RULE_ROUTER.md`\n"); // pointer — left alone
    const actions = (await command.plan(makeCtx())).actions;
    const text = digestOf(actions)?.text ?? "";
    expect(text).toContain("CLI-native footprint (aih will NOT modify these)");
    expect(text).toContain("[import] .claude/agents");
    expect(text).toContain("[wired] .cursorrules");
    // The CLI-native advisory routes via canon.cli-native-unmigrated.
    const check = await probeNamed(actions, "cli-native")?.run(makeCtx({ verify: true }));
    expect(check?.verdict).toBe("skip");
    expect(check?.code).toBe("canon.cli-native-unmigrated");
  });

  it("git-committed signal: uncommitted tool content is [personal], no advisory (idempotent re-run)", async () => {
    put("CLAUDE.md", divergentBootloader());
    put(".claude/agents/local.md", "# a developer's own agent\n"); // present but NOT committed
    // git ls-files returns a populated set that excludes the agent → personal.
    const run = fakeRunner((argv) =>
      argv.includes("ls-files") ? { stdout: "CLAUDE.md\0README.md\0" } : undefined,
    );
    const actions = (await command.plan(makeCtx({ run }))).actions;
    expect(digestOf(actions)?.text).toContain("[personal] .claude/agents");
    // No import candidates → the advisory does NOT fire (no nag loop).
    const check = await probeNamed(actions, "cli-native")?.run(makeCtx({ run }));
    expect(check?.verdict).toBe("pass");
    expect(check?.code).toBeUndefined();
  });

  it("acknowledged committed content is [kept], not flagged", async () => {
    put("CLAUDE.md", divergentBootloader());
    put(".claude/agents/shared.md", "# a shared agent\n");
    put(
      ".aih-config.json",
      JSON.stringify({
        schemaVersion: 1,
        contextDir: "ai-coding",
        targets: ["claude"],
        adopt: { acknowledged: [".claude/agents"] },
      }),
    );
    const run = fakeRunner((argv) =>
      argv.includes("ls-files") ? { stdout: ".claude/agents/shared.md\0" } : undefined,
    );
    const actions = (await command.plan(makeCtx({ run }))).actions;
    expect(digestOf(actions)?.text).toContain("[kept] .claude/agents");
    const check = await probeNamed(actions, "cli-native")?.run(makeCtx({ run }));
    expect(check?.verdict).toBe("pass");
  });

  it("no CLI-native content → cli-native probe passes", async () => {
    put("CLAUDE.md", divergentBootloader());
    const actions = (await command.plan(makeCtx())).actions;
    const check = await probeNamed(actions, "cli-native")?.run(makeCtx());
    expect(check?.verdict).toBe("pass");
    expect(check?.code).toBeUndefined();
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
