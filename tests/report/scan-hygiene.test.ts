import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootloadersFor, loadedDirsFor, REGISTRY_IDS } from "../../src/internals/cli-registry.js";
import type { DigestAction, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import type { ContextBloat } from "../../src/report/bloat.js";
import { command } from "../../src/report/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-scan-hygiene-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function put(rel: string, bytes: number): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "x".repeat(bytes), "utf8");
}

/** A report ctx whose Runner answers git argv via `git`. */
function ctx(
  options: Record<string, unknown>,
  git: (args: string[]) => string | null,
): PlanContext {
  const run = fakeRunner((argv) => {
    if (argv[0] !== "git") return { code: 1, spawnError: true };
    const out = git(argv.slice(3));
    return out === null ? { code: 1, spawnError: true } : { code: 0, stdout: out };
  });
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: dir, USERPROFILE: dir },
    options,
  };
}

/** The ContextBloat data from the lead "Context footprint" digest. */
async function bloatOf(c: PlanContext): Promise<ContextBloat> {
  const actions = (await command.plan(c)).actions;
  const d = actions.find(
    (a): a is DigestAction => a.kind === "digest" && a.describe.startsWith("Context footprint"),
  );
  return d?.data as ContextBloat;
}

describe("report — gitignore-honoring footprint", () => {
  it("excludes a file the git allowlist omits (the generated-copy double-count fix)", async () => {
    put("ai-coding/RULE_ROUTER.md", 400); // tracked source
    put("ai-coding/generated.md", 4000); // generated copy, NOT in the allowlist
    const tracked = (args: string[]) =>
      args[0] === "ls-files" ? "ai-coding/RULE_ROUTER.md\0" : "";
    const paths = (await bloatOf(ctx({}, tracked))).files.map((f) => f.path);
    expect(paths).toContain("ai-coding/RULE_ROUTER.md");
    expect(paths).not.toContain("ai-coding/generated.md");
  });

  it("--all-files skips the allowlist and counts everything on disk", async () => {
    put("ai-coding/RULE_ROUTER.md", 400);
    put("ai-coding/generated.md", 4000);
    const tracked = (args: string[]) =>
      args[0] === "ls-files" ? "ai-coding/RULE_ROUTER.md\0" : "";
    const paths = (await bloatOf(ctx({ allFiles: true }, tracked))).files.map((f) => f.path);
    expect(paths).toContain("ai-coding/generated.md");
  });

  it("not a git repo → full scan (allowlist unavailable, keep all)", async () => {
    put("ai-coding/RULE_ROUTER.md", 400);
    put("ai-coding/generated.md", 4000);
    const noGit = () => null; // every git call fails → gitTrackedSet undefined
    const paths = (await bloatOf(ctx({}, noGit))).files.map((f) => f.path);
    expect(paths).toContain("ai-coding/generated.md"); // not filtered
  });

  it("excludes tracked OS metadata from the default footprint (#553)", async () => {
    put("ai-coding/RULE_ROUTER.md", 8);
    put("ai-coding/.DS_Store", 6144); // Finder metadata, tracked — not agent context
    put("ai-coding/Thumbs.db", 4096);
    put("ai-coding/desktop.ini", 512);
    put("ai-coding/._RULE_ROUTER.md", 4096); // AppleDouble sidecar
    const tracked = (args: string[]) =>
      args[0] === "ls-files"
        ? "ai-coding/RULE_ROUTER.md\0ai-coding/.DS_Store\0ai-coding/Thumbs.db\0ai-coding/desktop.ini\0ai-coding/._RULE_ROUTER.md\0"
        : "";
    const bloat = await bloatOf(ctx({}, tracked));
    const paths = bloat.files.map((f) => f.path);
    expect(paths).toContain("ai-coding/RULE_ROUTER.md"); // real canon still counted
    expect(paths).not.toContain("ai-coding/.DS_Store");
    expect(paths).not.toContain("ai-coding/Thumbs.db");
    expect(paths).not.toContain("ai-coding/desktop.ini");
    expect(paths).not.toContain("ai-coding/._RULE_ROUTER.md");
    expect(bloat.totalBytes).toBe(8); // metadata contributed nothing to the corpus
  });

  it("--all-files still counts OS metadata (documented every-file-on-disk contract)", async () => {
    put("ai-coding/RULE_ROUTER.md", 8);
    put("ai-coding/.DS_Store", 6144);
    const tracked = () => "";
    const paths = (await bloatOf(ctx({ allFiles: true }, tracked))).files.map((f) => f.path);
    expect(paths).toContain("ai-coding/.DS_Store");
  });

  it("counts every registered CLI's bootloader as context (#553 — no hardcoded tool list)", async () => {
    const bootloaders = bootloadersFor(REGISTRY_IDS);
    // Guard the guard: a registry that stopped declaring bootloaders would make
    // the loop below vacuously pass.
    expect(bootloaders.length).toBeGreaterThan(1);
    for (const rel of bootloaders) put(rel, 100);
    const tracked = (args: string[]) =>
      args[0] === "ls-files" ? `${bootloaders.join("\0")}\0` : "";
    const paths = (await bloatOf(ctx({}, tracked))).files.map((f) => f.path);
    // Every target the registry knows about must be measurable. A CLI added to the
    // registry without context coverage fails here instead of going unmeasured.
    for (const rel of bootloaders) expect(paths).toContain(rel);
  });

  it("counts every registry-declared rule tree as context (no hardcoded dir list)", async () => {
    const dirs = loadedDirsFor(REGISTRY_IDS);
    // Guard the guard: a registry that stopped declaring rule trees would make the
    // loop below vacuously pass, exactly as the #553 bootloader guard protects itself.
    expect(dirs.length).toBeGreaterThan(1);
    const rels = dirs.map((d) => `${d}/team-local.md`);
    for (const rel of rels) put(rel, 100);
    const tracked = (args: string[]) => (args[0] === "ls-files" ? `${rels.join("\0")}\0` : "");
    const paths = (await bloatOf(ctx({}, tracked))).files.map((f) => f.path);
    // A target whose tree aih walks for one CLI but not another under-reports that
    // CLI's footprint. Declaring the dir in the registry makes coverage automatic.
    for (const rel of rels) expect(paths).toContain(rel);
  });

  it("--since narrows to files changed vs the ref", async () => {
    put("ai-coding/RULE_ROUTER.md", 400); // changed
    put("ai-coding/conventions.md", 800); // tracked but unchanged
    const git = (args: string[]) => {
      if (args[0] === "ls-files" && args.includes("--cached"))
        return "ai-coding/RULE_ROUTER.md\0ai-coding/conventions.md\0"; // both tracked
      if (args[0] === "ls-files" && args.includes("--others")) return "";
      if (args[0] === "rev-parse") return dir;
      if (args.includes("main...HEAD")) return "ai-coding/RULE_ROUTER.md\0"; // only this changed
      return "";
    };
    const paths = (await bloatOf(ctx({ since: "main" }, git))).files.map((f) => f.path);
    expect(paths).toContain("ai-coding/RULE_ROUTER.md");
    expect(paths).not.toContain("ai-coding/conventions.md");
  });
});
