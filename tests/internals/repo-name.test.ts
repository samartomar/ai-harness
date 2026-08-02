import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoDisplayName } from "../../src/internals/repo-name.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-reponame-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A repo root under `tmp` with the given folder name. */
function root(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function put(dir: string, relPath: string, contents: string): void {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function originConfig(url: string): string {
  return `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
}

describe("repoDisplayName — git origin remote (stable across checkout location)", () => {
  it("uses the https origin URL's repo segment, not the checkout folder name", () => {
    const r = root("renamed-checkout");
    put(r, ".git/config", originConfig("https://github.com/acme/stable-name.git"));
    expect(repoDisplayName(r)).toBe("stable-name");
  });

  it("parses scp-style and ssh origin URLs", () => {
    const scp = root("scp-checkout");
    put(scp, ".git/config", originConfig("git@github.com:acme/scp-repo.git"));
    expect(repoDisplayName(scp)).toBe("scp-repo");

    const ssh = root("ssh-checkout");
    put(ssh, ".git/config", originConfig("ssh://git@github.com/acme/ssh-repo"));
    expect(repoDisplayName(ssh)).toBe("ssh-repo");
  });

  it("strips a trailing slash before the repo segment", () => {
    const r = root("slash-checkout");
    put(r, ".git/config", originConfig("https://github.com/acme/slashed/"));
    expect(repoDisplayName(r)).toBe("slashed");
  });

  it("resolves a worktree .git pointer file through gitdir + commondir to the main config", () => {
    // Layout mirrors `git worktree add`: the worktree's `.git` is a FILE pointing at
    // `<main>/.git/worktrees/<name>`, whose `commondir` walks back to `<main>/.git`.
    const main = root("main-checkout");
    put(main, ".git/config", originConfig("https://github.com/acme/from-worktree.git"));
    put(main, ".git/worktrees/wt/commondir", "../..\n");
    const wt = root("wt-folder-name");
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`, "utf8");
    expect(repoDisplayName(wt)).toBe("from-worktree");
  });

  it("un-quotes a quoted url value and drops inline comments", () => {
    const quoted = root("quoted-url");
    put(quoted, ".git/config", originConfig('"https://github.com/acme/quoted-repo.git"'));
    expect(repoDisplayName(quoted)).toBe("quoted-repo");

    const commented = root("commented-url");
    put(commented, ".git/config", originConfig("https://github.com/acme/live-repo.git ; mirror"));
    expect(repoDisplayName(commented)).toBe("live-repo");
  });

  it("starts an inline comment at any unquoted #, matching git's own parser", () => {
    // Verified against real git: `git config -f` on this value yields
    // `https://github.com/acme/re` — no preceding whitespace is required.
    const r = root("embedded-hash");
    put(r, ".git/config", originConfig("https://github.com/acme/re#po.git"));
    expect(repoDisplayName(r)).toBe("re");
  });

  it('matches the section keyword case-insensitively but the "origin" subsection exactly', () => {
    const upperKeyword = root("upper-keyword");
    put(
      upperKeyword,
      ".git/config",
      `[REMOTE "origin"]\n\turl = https://github.com/acme/keyword-ok.git\n`,
    );
    expect(repoDisplayName(upperKeyword)).toBe("keyword-ok");

    const upperSubsection = root("upper-subsection");
    put(
      upperSubsection,
      ".git/config",
      `[remote "ORIGIN"]\n\turl = https://github.com/acme/not-origin.git\n`,
    );
    expect(repoDisplayName(upperSubsection)).toBe("upper-subsection");
  });

  it("ignores a non-origin remote and falls through", () => {
    const r = root("upstream-only");
    put(r, ".git/config", `[remote "upstream"]\n\turl = https://github.com/acme/not-mine.git\n`);
    expect(repoDisplayName(r)).toBe("upstream-only");
  });

  it("fails soft on a dangling .git pointer file", () => {
    const r = root("dangling-pointer");
    writeFileSync(join(r, ".git"), "gitdir: /nowhere/at/all\n", "utf8");
    expect(repoDisplayName(r)).toBe("dangling-pointer");
  });
});

describe("repoDisplayName — package.json fallback", () => {
  it("uses the package name when there is no git origin", () => {
    const r = root("folder-not-pkg");
    put(r, "package.json", JSON.stringify({ name: "svc" }));
    expect(repoDisplayName(r)).toBe("svc");
  });

  it("strips an npm scope", () => {
    const r = root("scoped-checkout");
    put(r, "package.json", JSON.stringify({ name: "@acme/harness" }));
    expect(repoDisplayName(r)).toBe("harness");
  });

  it("prefers the git origin over the package name", () => {
    const r = root("both-sources");
    put(r, ".git/config", originConfig("https://github.com/acme/repo-name.git"));
    put(r, "package.json", JSON.stringify({ name: "@acme/pkg-name" }));
    expect(repoDisplayName(r)).toBe("repo-name");
  });

  it("fails soft on malformed package.json", () => {
    const r = root("broken-pkg");
    put(r, "package.json", "{not json");
    expect(repoDisplayName(r)).toBe("broken-pkg");
  });

  it("fails soft when package.json exists but is a directory", () => {
    const r = root("dir-not-file");
    mkdirSync(join(r, "package.json"), { recursive: true });
    expect(repoDisplayName(r)).toBe("dir-not-file");
  });

  it("fails soft on a non-string or empty package name", () => {
    const num = root("numeric-name");
    put(num, "package.json", JSON.stringify({ name: 7 }));
    expect(repoDisplayName(num)).toBe("numeric-name");

    const scopeOnly = root("scope-only");
    put(scopeOnly, "package.json", JSON.stringify({ name: "@acme/" }));
    expect(repoDisplayName(scopeOnly)).toBe("scope-only");
  });
});

describe("repoDisplayName — basename last resort", () => {
  it("falls back to the folder name with no git and no package.json", () => {
    const r = root("plain-folder");
    expect(repoDisplayName(r)).toBe("plain-folder");
  });

  it('resolves "." to the cwd folder name, never an empty heading', () => {
    // basename(".") is "." — the pre-existing resolve-first guard must survive.
    const r = root("dot-guard");
    const prev = process.cwd();
    process.chdir(r);
    try {
      expect(repoDisplayName(".")).toBe(basename(r));
    } finally {
      process.chdir(prev);
    }
  });
});
