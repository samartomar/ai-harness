import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aihIgnoreWrite } from "../../src/internals/gitignore.js";

const TEST_PROCESS_TIMEOUT_MS = 10_000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-gi-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("aihIgnoreWrite", () => {
  it("creates .gitignore with the aih patterns when none exists", () => {
    const w = aihIgnoreWrite(root);
    expect(w.path).toBe(".gitignore");
    expect(w.contents).toContain("*.aih.bak");
    expect(w.contents).toContain("*.aih.tmp");
    expect(w.contents).toContain(".aih-truth.json");
  });

  it("appends the patterns while preserving existing content", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n");
    const w = aihIgnoreWrite(root);
    expect(w.contents).toContain("node_modules/");
    expect(w.contents).toContain("dist/");
    expect(w.contents).toContain("*.aih.bak");
    expect(w.contents).toContain(".aih-truth.json");
  });

  it("is a no-op when the current block is already present (byte-identical)", () => {
    const original =
      "node_modules/\n\n# aih-managed (backup, temp, and generated reports)\n" +
      "*.aih.bak\n*.aih.tmp\n.aih-truth.json\n!.aih/\n.aih/*\n!.aih/usage-record.mjs\n";
    writeFileSync(join(root, ".gitignore"), original);
    expect(aihIgnoreWrite(root).contents).toBe(original);
  });

  it("ignores .aih data but keeps the committed recorder tracked (negation)", () => {
    const c = aihIgnoreWrite(root).contents ?? "";
    const lines = c.split(/\r?\n/);
    expect(lines).toContain("!.aih/"); // re-include the dir past an earlier `.*/`-style exclude
    expect(c).toContain(".aih/*"); // ignore the data dir contents
    expect(c).toContain(".aih-truth.json"); // machine-local truth sidecar pointer
    expect(c).toContain("!.aih/usage-record.mjs"); // but re-include the recorder tool
    // The three ordered so later rules win: `!.aih/` (dir) → `.aih/*` (data) → recorder.
    expect(lines.indexOf("!.aih/")).toBeLessThan(lines.indexOf(".aih/*"));
    expect(lines.indexOf(".aih/*")).toBeLessThan(lines.indexOf("!.aih/usage-record.mjs"));
    // A bare `.aih/` would re-exclude the dir and neuter the negation — must be gone.
    expect(lines).not.toContain(".aih/");
  });

  it.each([
    ".aih/",
    "/.aih/",
    ".aih",
    "/.aih",
  ])("supersedes every `.aih`-dir exclude form (%s) so the negation actually re-includes the recorder", (excludeForm) => {
    // Any of these excludes the .aih DIRECTORY; git then can't re-include a child, so
    // leaving one would silently re-strand the recorder (the original bug). It MUST be
    // stripped — this is intentional, not a user-line loss, and is the only way the fix works.
    writeFileSync(join(root, ".gitignore"), `node_modules/\n${excludeForm}\n`);
    const lines = (aihIgnoreWrite(root).contents ?? "").split(/\r?\n/);
    expect(lines).not.toContain(excludeForm); // the dir-exclude is gone
    expect(lines).toContain(".aih/*"); // replaced by a contents-only ignore
    expect(lines).toContain("!.aih/usage-record.mjs"); // that the negation can pierce
    expect(lines).toContain("node_modules/"); // unrelated content preserved
  });

  it("does NOT touch `.aih/*` or `.aih/**` (they leave the dir traversable — negation works)", () => {
    // These ignore contents, not the directory, so they coexist with the negation and
    // are not `.aih`-dir excludes — a user's `.aih/**` must survive.
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.aih/**\n");
    const lines = (aihIgnoreWrite(root).contents ?? "").split(/\r?\n/);
    expect(lines).toContain(".aih/**"); // preserved (not a dir-exclude)
  });

  it("preserves CRLF EOL and stays byte-identical when the block is already correct", () => {
    const crlf =
      "node_modules/\r\n\r\n# aih-managed (backup, temp, and generated reports)\r\n" +
      "*.aih.bak\r\n*.aih.tmp\r\n.aih-truth.json\r\n!.aih/\r\n.aih/*\r\n!.aih/usage-record.mjs\r\n";
    writeFileSync(join(root, ".gitignore"), crlf);
    const out = aihIgnoreWrite(root).contents ?? "";
    expect(out).toBe(crlf); // no LF rewrite, no noisy diff on Windows
    expect(out).toContain("\r\n");
    expect(out).not.toMatch(/[^\r]\n/); // every LF is part of a CRLF
  });

  it("migrates a legacy bare `.aih/` block to `.aih/*` + negation without duplication", () => {
    // The exact block older aih versions wrote (wholesale-ignore, no recorder tracked).
    writeFileSync(
      join(root, ".gitignore"),
      "node_modules/\n# aih-managed (backup, temp, and generated reports)\n*.aih.bak\n*.aih.tmp\n.aih/\n",
    );
    const lines = (aihIgnoreWrite(root).contents ?? "").split(/\r?\n/);
    // Legacy line stripped; each managed pattern appears exactly once.
    expect(lines).not.toContain(".aih/");
    expect(lines.filter((l) => l === "*.aih.bak")).toHaveLength(1);
    expect(lines.filter((l) => l === ".aih-truth.json")).toHaveLength(1);
    expect(lines.filter((l) => l === ".aih/*")).toHaveLength(1);
    expect(lines.filter((l) => l === "!.aih/usage-record.mjs")).toHaveLength(1);
    // Only one managed header survives the migration.
    expect(
      lines.filter((l) => l === "# aih-managed (backup, temp, and generated reports)"),
    ).toHaveLength(1);
    expect(lines).toContain("node_modules/"); // unrelated content preserved
  });

  it("re-includes the recorder past an EARLIER `.*/` dir-exclude, verified by real git check-ignore", () => {
    // A repo whose .gitignore already hides every dotfile-dir with `.*/` excludes the
    // `.aih` PARENT — and git can't re-include a child of an excluded dir. Only the
    // leading `!.aih/` (appended after `.*/`, so it wins) makes `.aih/` traversable so
    // the `!.aih/usage-record.mjs` negation can actually re-include the recorder. This
    // is verified against the real git rule engine, not an approximate JS matcher.
    const git = (...args: string[]): string =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: TEST_PROCESS_TIMEOUT_MS,
      }).trim();
    // A real git repo with git-managed line endings deterministic across platforms.
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    // Prior rule that excludes the `.aih` directory itself (broad dotfile-dir hide).
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.*/\n");

    // Apply the aih block exactly as executePlan would: write .contents to .gitignore.
    const contents = aihIgnoreWrite(root).contents ?? "";
    writeFileSync(join(root, ".gitignore"), contents);

    // Materialize the recorder plus a piece of ignorable data so both paths resolve.
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(join(root, ".aih", "usage-record.mjs"), "// recorder\n");
    writeFileSync(join(root, ".aih", "report.html"), "<html></html>\n");

    // `git check-ignore -q <path>` exits 0 iff the path IS ignored, 1 if it is NOT.
    const isIgnored = (rel: string): boolean => {
      try {
        execFileSync("git", ["check-ignore", "-q", rel], {
          cwd: root,
          timeout: TEST_PROCESS_TIMEOUT_MS,
        });
        return true; // exit 0 → ignored
      } catch {
        return false; // exit 1 → not ignored
      }
    };

    // The committed recorder survives the `.*/` parent-exclude; the data does not.
    expect(isIgnored(".aih/usage-record.mjs")).toBe(false);
    expect(isIgnored(".aih/report.html")).toBe(true);
  }, 20000);
});
