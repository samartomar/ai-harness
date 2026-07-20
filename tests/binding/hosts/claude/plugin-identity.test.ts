import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_PLUGINS_CACHE_REL,
  CLAUDE_PLUGINS_CONFIG_REL,
  ClaudePluginCacheMissingError,
  ClaudePluginError,
  ClaudePluginIdentityError,
  claudeHomeDir,
  defaultPluginCacheLocator,
  HOME_OWNERSHIP_PREFIX,
  hashLoadedPluginTree,
  homeMarketplaceTarget,
  homePluginCacheTarget,
  isHomeScopedTarget,
  verifyPluginIdentity,
} from "../../../../src/binding/hosts/claude/plugin-identity.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "aih-claude-pid-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Materialize a tree of `{ relPath: contents }` under a fresh dir and return it. */
function tree(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return dir;
}

describe("claudeHomeDir", () => {
  it("prefers USERPROFILE, then HOME (mirrors homeDir())", () => {
    expect(claudeHomeDir({ USERPROFILE: "C:/u", HOME: "/h" })).toBe("C:/u");
    expect(claudeHomeDir({ HOME: "/h" })).toBe("/h");
  });
});

describe("home: ownership target convention", () => {
  it("encodes the documented marketplace + cache targets", () => {
    expect(homeMarketplaceTarget("ecc")).toBe(
      `${HOME_OWNERSHIP_PREFIX}${CLAUDE_PLUGINS_CONFIG_REL}#/marketplaces/ecc`,
    );
    expect(homeMarketplaceTarget("ecc")).toBe("home:.claude/plugins/config.json#/marketplaces/ecc");
    expect(homePluginCacheTarget("ecc@ecc-mkt")).toBe(
      `${HOME_OWNERSHIP_PREFIX}${CLAUDE_PLUGINS_CACHE_REL}/ecc@ecc-mkt`,
    );
    expect(homePluginCacheTarget("ecc@ecc-mkt")).toBe("home:.claude/plugins/cache/ecc@ecc-mkt");
  });

  it("recognizes home-scoped targets and rejects repo-relative ones", () => {
    expect(isHomeScopedTarget(homeMarketplaceTarget("ecc"))).toBe(true);
    expect(isHomeScopedTarget(homePluginCacheTarget("ecc@m"))).toBe(true);
    expect(isHomeScopedTarget(".claude/settings.json#/enabledPlugins/ecc@m")).toBe(false);
    expect(isHomeScopedTarget(".claude/skills/ecc/SKILL.md")).toBe(false);
  });
});

describe("defaultPluginCacheLocator (documented modeled layout)", () => {
  it("points at <home>/.claude/plugins/marketplaces/<marketplace>", () => {
    const path = defaultPluginCacheLocator({
      home: "/home/u",
      marketplace: "ecc-mkt",
      plugin: "ecc",
      pluginKey: "ecc@ecc-mkt",
      marketplaceSourcePath: "/cache/checkout",
    });
    expect(path).toBe(join("/home/u", ".claude", "plugins", "marketplaces", "ecc-mkt"));
  });
});

describe("hashLoadedPluginTree (reuses the canonical tree-digest routine)", () => {
  it("digests identical trees (across distinct paths) to the same sha256", () => {
    const a = tree("a", { "SKILL.md": "# skill\n", "src/index.ts": "export const x = 1;\n" });
    const b = tree("b", { "SKILL.md": "# skill\n", "src/index.ts": "export const x = 1;\n" });
    const da = hashLoadedPluginTree(a);
    expect(da).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLoadedPluginTree(b)).toBe(da);
  });

  it("digests differing trees differently (a single changed byte)", () => {
    const a = tree("a", { "SKILL.md": "# skill\n" });
    const b = tree("b", { "SKILL.md": "# SKILL\n" });
    expect(hashLoadedPluginTree(a)).not.toBe(hashLoadedPluginTree(b));
  });

  it("ignores a .git dir so a checkout and its copy digest equally", () => {
    const withGit = tree("g", { "SKILL.md": "# skill\n", ".git/HEAD": "ref: refs/heads/main\n" });
    const clean = tree("c", { "SKILL.md": "# skill\n" });
    expect(hashLoadedPluginTree(withGit)).toBe(hashLoadedPluginTree(clean));
  });

  it("throws the distinguishable missing-cache error for a missing tree", () => {
    // The ONE case removal may treat as "already gone" — a distinct subclass so
    // the reconciler can discriminate it from a present-but-unreadable tree.
    expect(() => hashLoadedPluginTree(join(scratch, "nope"))).toThrow(
      ClaudePluginCacheMissingError,
    );
  });

  it("throws a plain (NON-missing) plugin error for an empty tree", () => {
    // An existing-but-empty tree is fail-closed, NOT "missing": it must never read
    // as the idempotent already-gone case.
    const empty = join(scratch, "empty");
    mkdirSync(empty, { recursive: true });
    expect(() => hashLoadedPluginTree(empty)).toThrow(ClaudePluginError);
    expect(() => hashLoadedPluginTree(empty)).not.toThrow(ClaudePluginCacheMissingError);
  });
});

describe("verifyPluginIdentity (D7)", () => {
  it("returns match=true and equal digests when the loaded tree is the scanned bytes", () => {
    const loaded = tree("loaded", { "SKILL.md": "# skill\n" });
    const scannedDigest = hashLoadedPluginTree(loaded);
    const identity = verifyPluginIdentity(scannedDigest, loaded);
    expect(identity).toEqual({ scannedDigest, loadedDigest: scannedDigest, match: true });
  });

  it("returns match=false when the loaded tree differs from the scanned digest", () => {
    const loaded = tree("loaded", { "SKILL.md": "# tampered\n" });
    const identity = verifyPluginIdentity("a".repeat(64), loaded);
    expect(identity.match).toBe(false);
    expect(identity.scannedDigest).toBe("a".repeat(64));
    expect(identity.loadedDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ClaudePluginIdentityError", () => {
  it("is a ClaudePluginError carrying the identity fields", () => {
    const identity = { scannedDigest: "a".repeat(64), loadedDigest: "b".repeat(64), match: false };
    const err = new ClaudePluginIdentityError("mismatch", identity);
    expect(err).toBeInstanceOf(ClaudePluginError);
    expect(err.identity).toEqual(identity);
    expect(err.code).toBe("AIH_BINDING_CLAUDE_PLUGIN");
  });
});
