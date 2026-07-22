import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashComponentTree } from "../../../../src/baseline-evidence/hash.js";
import {
  CLAUDE_PLUGINS_CACHE_REL,
  ClaudePluginCacheMissingError,
  ClaudePluginError,
  ClaudePluginIdentityError,
  claudeHomeDir,
  defaultPluginCacheLocator,
  HOME_OWNERSHIP_PREFIX,
  hashLoadedPluginTree,
  homeMarketplaceTarget,
  homePluginCacheTarget,
  installPathFromPluginList,
  isHomeScopedTarget,
  pluginSourceSubtreeDigest,
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

describe("home: ownership target convention (empirically corrected: settings.json, not plugins/config.json)", () => {
  it("encodes the marketplace target under settings.json's extraKnownMarketplaces (real 2.1.214 behavior)", () => {
    expect(homeMarketplaceTarget("ecc")).toBe(
      `${HOME_OWNERSHIP_PREFIX}.claude/settings.json#/extraKnownMarketplaces/ecc`,
    );
  });

  it("encodes the cache target at the REAL layout: cache/<marketplace>/<plugin> (W4 live-run correction)", () => {
    expect(homePluginCacheTarget("ecc-mkt", "ecc")).toBe(
      `${HOME_OWNERSHIP_PREFIX}${CLAUDE_PLUGINS_CACHE_REL}/ecc-mkt/ecc`,
    );
    expect(homePluginCacheTarget("ecc-mkt", "ecc")).toBe("home:.claude/plugins/cache/ecc-mkt/ecc");
  });

  it("recognizes home-scoped targets and rejects repo-relative ones", () => {
    expect(isHomeScopedTarget(homeMarketplaceTarget("ecc"))).toBe(true);
    expect(isHomeScopedTarget(homePluginCacheTarget("m", "ecc"))).toBe(true);
    expect(isHomeScopedTarget(".claude/settings.json#/enabledPlugins/ecc@m")).toBe(false);
    expect(isHomeScopedTarget(".claude/skills/ecc/SKILL.md")).toBe(false);
  });
});

describe("defaultPluginCacheLocator (empirically corrected: cache/<marketplace>/<plugin>/<version>)", () => {
  it("points at <home>/.claude/plugins/cache/<marketplace>/<plugin>/<version> when version is known", () => {
    const path = defaultPluginCacheLocator({
      home: "/home/u",
      marketplace: "ecc-mkt",
      plugin: "ecc",
      pluginKey: "ecc@ecc-mkt",
      marketplaceSourcePath: "/cache/checkout",
      version: "1.2.3",
    });
    expect(path).toBe(join("/home/u", ".claude", "plugins", "cache", "ecc-mkt", "ecc", "1.2.3"));
  });

  it("falls back to the <marketplace>/<plugin> parent dir when version is unknown (documented, less precise)", () => {
    const path = defaultPluginCacheLocator({
      home: "/home/u",
      marketplace: "ecc-mkt",
      plugin: "ecc",
      pluginKey: "ecc@ecc-mkt",
      marketplaceSourcePath: "/cache/checkout",
    });
    expect(path).toBe(join("/home/u", ".claude", "plugins", "cache", "ecc-mkt", "ecc"));
  });
});

describe("installPathFromPluginList (authoritative — preferred over the locator guess)", () => {
  const LIST_PAYLOAD = {
    version: 2,
    plugins: {
      "ecc@ecc-mkt": [
        {
          scope: "project",
          installPath: "/home/u/.claude/plugins/cache/ecc-mkt/ecc/1.2.3",
          version: "1.2.3",
          installedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-01T00:00:00.000Z",
          projectPath: "/repo",
        },
      ],
    },
  };

  it("extracts installPath for the given plugin key", () => {
    expect(installPathFromPluginList(LIST_PAYLOAD, "ecc@ecc-mkt")).toBe(
      join("/home/u/.claude/plugins/cache/ecc-mkt/ecc/1.2.3"),
    );
  });

  it("returns undefined for an absent key (never throws — callers fall back to the locator)", () => {
    expect(installPathFromPluginList(LIST_PAYLOAD, "other@mkt")).toBeUndefined();
  });

  const malformedCases: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["a string", "garbage"],
    ["missing plugins key", { version: 2 }],
    ["plugins not an object", { plugins: "oops" }],
    ["entry not an array", { plugins: { "ecc@ecc-mkt": {} } }],
    ["empty entry array", { plugins: { "ecc@ecc-mkt": [] } }],
    ["entry missing installPath", { plugins: { "ecc@ecc-mkt": [{ scope: "project" }] } }],
    ["installPath not a string", { plugins: { "ecc@ecc-mkt": [{ installPath: 5 }] } }],
  ];
  it.each(malformedCases)("returns undefined (never throws) for %s", (_label, payload) => {
    expect(installPathFromPluginList(payload, "ecc@ecc-mkt")).toBeUndefined();
  });
});

describe("pluginSourceSubtreeDigest (D7 anchor: the plugin SOURCE SUBTREE, not the whole checkout)", () => {
  it("digests only the subtree marketplace.json's plugins[].source points at, and reads its version", () => {
    const checkout = tree("checkout-subtree", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        plugins: [{ name: "widget", source: "./plugin" }],
      }),
      "plugin/.claude-plugin/plugin.json": JSON.stringify({ name: "widget", version: "2.3.1" }),
      "plugin/SKILL.md": "# widget\n",
      "unrelated-top-level-file.md": "# not part of the plugin subtree\n",
    });

    const result = pluginSourceSubtreeDigest(checkout, "widget");

    expect(result.version).toBe("2.3.1");
    expect(result.subtreePath).toBe(join(checkout, "plugin"));
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);

    // Independently verify: the digest covers ONLY plugin/, not the unrelated file.
    const subtreeTopLevel = readdirSync(result.subtreePath)
      .filter((n) => n !== ".git")
      .sort();
    const expected = hashComponentTree(result.subtreePath, subtreeTopLevel);
    expect(result.digest).toBe(expected.treeSha256);
  });

  it("a plugin source of './' degenerates to the whole checkout (digest equals the checkout's own treeDigest)", () => {
    const checkout = tree("checkout-root-plugin", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        plugins: [{ name: "superpowers", source: "./" }],
      }),
      ".claude-plugin/plugin.json": JSON.stringify({ name: "superpowers", version: "1.0.0" }),
      "SKILL.md": "# skill\n",
    });

    const result = pluginSourceSubtreeDigest(checkout, "superpowers");
    expect(result.subtreePath).toBe(checkout);
    expect(result.version).toBe("1.0.0");

    // The SAME routine scan-gate.ts's resolveGitSource uses to compute the
    // checkout's own treeDigest (every non-.git top-level entry, sorted).
    const checkoutTopLevel = readdirSync(checkout)
      .filter((n) => n !== ".git")
      .sort();
    const wholeTreeDigest = hashComponentTree(checkout, checkoutTopLevel).treeSha256;
    expect(result.digest).toBe(wholeTreeDigest);
  });

  it("also treats a bare '.' source as the whole-checkout degenerate case", () => {
    const checkout = tree("checkout-dot-source", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        plugins: [{ name: "superpowers", source: "." }],
      }),
      ".claude-plugin/plugin.json": JSON.stringify({ name: "superpowers", version: "1.0.0" }),
      "SKILL.md": "# skill\n",
    });
    const result = pluginSourceSubtreeDigest(checkout, "superpowers");
    expect(result.subtreePath).toBe(checkout);
  });

  it("fails closed when marketplace.json is absent", () => {
    const checkout = tree("no-manifest", { "SKILL.md": "# skill\n" });
    expect(() => pluginSourceSubtreeDigest(checkout, "widget")).toThrow(ClaudePluginError);
  });

  it("fails closed when marketplace.json is unparseable", () => {
    const checkout = tree("bad-manifest", {
      ".claude-plugin/marketplace.json": "{ not valid json",
    });
    expect(() => pluginSourceSubtreeDigest(checkout, "widget")).toThrow(ClaudePluginError);
  });

  it("fails closed when the named plugin is not listed in marketplace.json", () => {
    const checkout = tree("wrong-name", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        plugins: [{ name: "other-plugin", source: "./" }],
      }),
    });
    expect(() => pluginSourceSubtreeDigest(checkout, "widget")).toThrow(ClaudePluginError);
  });

  it.each([
    ["parent traversal", "../escape"],
    ["absolute posix path", "/etc/passwd"],
    ["nested traversal", "./plugin/../../escape"],
  ])("fails closed on a %s source (%j) — never reads outside the checkout", (_label, source) => {
    const checkout = tree(`escape-${_label.replace(/\s+/g, "-")}`, {
      ".claude-plugin/marketplace.json": JSON.stringify({ plugins: [{ name: "widget", source }] }),
    });
    expect(() => pluginSourceSubtreeDigest(checkout, "widget")).toThrow(ClaudePluginError);
  });

  it("fails closed when the plugin's own plugin.json is missing or has no version", () => {
    const noPluginJson = tree("no-plugin-json", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        plugins: [{ name: "widget", source: "./plugin" }],
      }),
      "plugin/SKILL.md": "# widget\n",
    });
    expect(() => pluginSourceSubtreeDigest(noPluginJson, "widget")).toThrow(ClaudePluginError);

    const noVersion = tree("no-version", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        plugins: [{ name: "widget", source: "./plugin" }],
      }),
      "plugin/.claude-plugin/plugin.json": JSON.stringify({ name: "widget" }),
    });
    expect(() => pluginSourceSubtreeDigest(noVersion, "widget")).toThrow(ClaudePluginError);
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
