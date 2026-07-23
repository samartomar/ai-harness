import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyCanon } from "../../src/adopt/classify.js";
import { command } from "../../src/adopt/index.js";
import { SHARED_MARKER, sharedCanonicalBlockBody } from "../../src/bootstrap-ai/canon.js";
import { executePlan } from "../../src/internals/execute.js";
import {
  beginLine,
  endLine,
  extractManagedBlock,
  splitManagedBody,
} from "../../src/internals/markers.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const DIR = "ai-coding";
const EXT_LINE = "- Honor the gateway enforcement contract.";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-adopt-apply-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function put(rel: string, contents: string): void {
  const full = join(tmp, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}
function read(rel: string): string {
  return readFileSync(join(tmp, rel), "utf8");
}
function makeCtx(flags: { apply?: boolean } = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: tmp,
    contextDir: DIR,
    apply: flags.apply ?? false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { HOME: tmp } }),
    env: { HOME: tmp },
    options: {},
  };
}

/** A divergent bootloader: the canonical block PLUS a folded-in project extension. */
function divergentBootloader(): string {
  const body = `${sharedCanonicalBlockBody(DIR).trim()}\n\n## Project extension\n\n${EXT_LINE}`;
  return `# CLAUDE.md preamble (hand-written)\n\n${beginLine(SHARED_MARKER, "src")}\n\n${body}\n\n${endLine(SHARED_MARKER)}\n`;
}

describe("aih adopt --apply — marker-divergent carve + regenerate", () => {
  it("preserves the human extension, cleans the block, and converges", async () => {
    put("CLAUDE.md", divergentBootloader());
    expect(classifyCanon(tmp, DIR).kind).toBe("marker-divergent");

    const ctx = makeCtx({ apply: true });
    await executePlan(await command.plan(ctx), ctx);

    // 1. The carved human content lives in a preserved, user-owned file.
    expect(existsSync(join(tmp, DIR, "rules/project-canon-extension.md"))).toBe(true);
    expect(read(`${DIR}/rules/project-canon-extension.md`)).toContain(EXT_LINE);

    // 2. The bootloader's managed block is now CLEAN (canonical) — the extension is
    //    no longer inside it (so a future regenerate can't lose it), and the
    //    hand-written preamble survived.
    const claude = read("CLAUDE.md");
    const block = extractManagedBlock(claude, SHARED_MARKER) ?? "";
    expect(splitManagedBody(block, sharedCanonicalBlockBody(DIR).trim())).toBe("");
    expect(block).not.toContain(EXT_LINE);
    expect(claude).toContain("# CLAUDE.md preamble (hand-written)");

    // 3. The router points at the carved extension so it stays loaded.
    expect(read(`${DIR}/RULE_ROUTER.md`)).toContain("project-canon-extension.md");

    // 4. The marker is persisted → a re-classify reads already-adopted.
    expect(existsSync(join(tmp, ".aih-config.json"))).toBe(true);
    expect(classifyCanon(tmp, DIR).kind).toBe("already-adopted");
  });

  it("fails closed on a persisted removed baseline (gstack) rather than carving a stale router", async () => {
    put("CLAUDE.md", divergentBootloader());
    put(
      ".aih-config.json",
      JSON.stringify({
        schemaVersion: 1,
        contextDir: DIR,
        targets: ["claude"],
        baseline: "gstack",
      }),
    );

    // gstack was removed as a CLI-surfaced baseline (2026-07-23); a persisted
    // gstack marker is a now-invalid governance value and fails closed rather
    // than silently falling back to the default.
    const ctx = makeCtx({ apply: true });
    await expect(command.plan(ctx)).rejects.toThrow(/invalid baseline/);
  });

  it("is idempotent: a second adopt run after convergence writes nothing", async () => {
    put("CLAUDE.md", divergentBootloader());
    const ctx = makeCtx({ apply: true });
    await executePlan(await command.plan(ctx), ctx);

    // Already-adopted now → the plan carries no write actions.
    const second = (await command.plan(makeCtx())).actions;
    expect(second.some((a) => a.kind === "write")).toBe(false);
  });

  it("backs up the original bootloader to *.aih.bak", async () => {
    put("CLAUDE.md", divergentBootloader());
    const ctx = makeCtx({ apply: true });
    await executePlan(await command.plan(ctx), ctx);
    expect(existsSync(join(tmp, "CLAUDE.md.aih.bak"))).toBe(true);
    expect(readFileSync(join(tmp, "CLAUDE.md.aih.bak"), "utf8")).toContain(EXT_LINE);
  });
});

describe("aih adopt --apply — foreign-scheme insert", () => {
  it("inserts the managed block into a markerless bootloader, preserving its content", async () => {
    // syntegris shape: a router exists, the bootloader has no aih marker.
    put(`${DIR}/RULE_ROUTER.md`, "# Hand router\n");
    put("CLAUDE.md", "# Hand bootloader\n\nload the router.\n");
    expect(classifyCanon(tmp, DIR).kind).toBe("foreign-scheme");

    const ctx = makeCtx({ apply: true });
    await executePlan(await command.plan(ctx), ctx);

    const claude = read("CLAUDE.md");
    // The marker block was inserted, and the original hand content is kept as preamble.
    expect(extractManagedBlock(claude, SHARED_MARKER)).toBeDefined();
    expect(claude).toContain("# Hand bootloader");
    expect(classifyCanon(tmp, DIR).kind).toBe("already-adopted");
  });
});
