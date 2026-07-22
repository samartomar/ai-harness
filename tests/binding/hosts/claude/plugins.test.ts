import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashComponentTree } from "../../../../src/baseline-evidence/hash.js";
import {
  ClaudePluginError,
  ClaudePluginIdentityError,
  homeMarketplaceTarget,
  homePluginCacheTarget,
} from "../../../../src/binding/hosts/claude/plugin-identity.js";
import {
  type BindPluginResult,
  bindPlugin,
  disablePlugin,
  enablePlugin,
  installPlugin,
  listPlugins,
  marketplaceAdd,
  pluginDetails,
  pluginEnableKey,
  removePlugin,
  uninstallPlugin,
} from "../../../../src/binding/hosts/claude/plugins.js";
import {
  type BindingLock,
  BindingLockSchema,
  BindingOwnershipEntrySchema,
  BindingWriteSchema,
} from "../../../../src/binding/lock.js";
import {
  BindingScanError,
  type DimensionInspector,
  type ResolvedGitSource,
  runFastScanGate,
  type ScanDisposition,
  type ScannableSource,
} from "../../../../src/binding/scan-gate.js";
import type { BindingDeclaration } from "../../../../src/binding/schema.js";
import { fakeRunner, type Runner, type RunResult } from "../../../../src/internals/proc.js";

const PLUGIN = "ecc";
const MARKETPLACE = "ecc-mkt";
const KEY = pluginEnableKey(PLUGIN, MARKETPLACE);

let cacheHome: string;
let root: string;
let home: string;

beforeEach(() => {
  cacheHome = mkdtempSync(join(tmpdir(), "aih-plugin-cache-"));
  root = mkdtempSync(join(tmpdir(), "aih-plugin-root-"));
  home = mkdtempSync(join(tmpdir(), "aih-plugin-home-"));
});

afterEach(() => {
  for (const dir of [cacheHome, root, home]) rmSync(dir, { recursive: true, force: true });
});

const producedClean: DimensionInspector = {
  dimension: "test-complete",
  run: () => ({ dimension: "test-complete", status: "produced", findings: [] }),
};
const producedCritical: DimensionInspector = {
  dimension: "test-critical",
  run: () => ({
    dimension: "test-critical",
    status: "produced",
    findings: [
      { code: "trust.malicious-code", severity: "critical", detail: "boom", coverage: "complete" },
    ],
  }),
};

describe("windows claude shim routing (cmd /c)", () => {
  function recording(): { runner: Runner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push([...argv]);
      return { code: 0, stdout: "", stderr: "" };
    };
    return { runner, calls };
  }

  // npm ships the claude CLI as a .cmd shim on Windows, which Node's execFile
  // cannot spawn directly (ENOENT / EINVAL) — the canon route is execArgv's
  // cmd /c wrap, the same fix the harness uses for npm/npx (W4 live-run
  // rehearsal regression).
  it("routes the claude argv through cmd /c on windows", async () => {
    const { runner, calls } = recording();
    await marketplaceAdd({ runner, env: { USERPROFILE: home, AIH_PLATFORM: "windows" } }, root);
    expect(calls[0]).toEqual(["cmd", "/c", "claude", "plugin", "marketplace", "add", root]);
  });

  it("keeps the raw claude argv on non-windows platforms", async () => {
    const { runner, calls } = recording();
    await marketplaceAdd({ runner, env: { USERPROFILE: home, AIH_PLATFORM: "linux" } }, root);
    expect(calls[0]).toEqual(["claude", "plugin", "marketplace", "add", root]);
  });
});

/** A tree of `{ relPath: contents }` under a fresh dir. */
function tree(name: string, files: Record<string, string>): string {
  const dir = join(cacheHome, name);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return dir;
}

/**
 * Mint a GENUINE brand-protected disposition + resolved source over an
 * ALREADY-BUILT on-disk tree (no git, no network): identityFiles are exactly
 * the digest's fileset so coverage is complete and the gate allows.
 */
function mintFixture(
  dir: string,
  inspectors: DimensionInspector[] = [producedClean],
): { resolved: ResolvedGitSource; disposition: ScanDisposition } {
  const topLevel = readdirSync(dir)
    .filter((n) => n !== ".git")
    .sort();
  const hashed = hashComponentTree(dir, topLevel);
  const source: ScannableSource = {
    digest: hashed.treeSha256,
    treePath: dir,
    identityFiles: hashed.files.map((f) => f.path),
  };
  const disposition = runFastScanGate(source, { posture: "enterprise" }, { cacheHome, inspectors });
  return {
    resolved: {
      kind: "git",
      repository: "owner/repo",
      commitSha: "c".repeat(40),
      treeDigest: hashed.treeSha256,
      treePath: dir,
      files: source.identityFiles,
    },
    disposition,
  };
}

/**
 * The default `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json`
 * every `bindPlugin` fixture needs (empirically corrected: the D7 anchor is
 * now the plugin's own SOURCE SUBTREE, resolved via these manifests — see
 * `pluginSourceSubtreeDigest`). `source: "./"` is the degenerate
 * single-plugin-at-root case (e.g. obra/superpowers): the subtree IS the
 * whole checkout, so its digest equals `resolved.treeDigest` — every EXISTING
 * digest assertion in this file stays valid unchanged.
 */
function pluginManifestFiles(
  plugin: string = PLUGIN,
  source = "./",
  version = "1.0.0",
): Record<string, string> {
  return {
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: MARKETPLACE,
      plugins: [{ name: plugin, source }],
    }),
    ".claude-plugin/plugin.json": JSON.stringify({ name: plugin, version }),
  };
}

/**
 * A scanned fixture with the default single-plugin-at-root manifests merged
 * in ahead of the caller's own `files`.
 */
function scannedFixture(
  name: string,
  files: Record<string, string>,
  inspectors: DimensionInspector[] = [producedClean],
): { resolved: ResolvedGitSource; disposition: ScanDisposition } {
  const dir = tree(name, { ...pluginManifestFiles(), ...files });
  return mintFixture(dir, inspectors);
}

/** A recording runner over the fake seam; `script` overrides specific commands. */
function recordingRunner(script?: (argv: string[]) => Partial<RunResult> | undefined): {
  runner: Runner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner = fakeRunner((argv) => {
    calls.push(argv);
    return script?.(argv);
  });
  return { runner, calls };
}

function declarationFor(treeDigest: string): BindingDeclaration {
  return {
    schemaVersion: 1,
    framework: { id: "ecc", mode: "lean", host: "claude" },
    source: { kind: "git", repository: "owner/repo", commitSha: "c".repeat(40), treeDigest },
  };
}

/** Assemble the lock W4 would build from a bind result and the committed declaration. */
function lockFrom(result: BindPluginResult): BindingLock {
  return {
    schemaVersion: 1,
    declaration: declarationFor(result.identity.scannedDigest),
    writes: result.writes,
    scannedDigest: result.identity.scannedDigest,
    loadedDigest: result.identity.loadedDigest,
    match: result.identity.match,
    ownership: result.ownership,
  };
}

describe("bindPlugin — happy path (marketplace add -> install -> D7 match -> sealed ownership)", () => {
  it("registers the scanned checkout, installs, verifies identity, and seals every ownership slot", async () => {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" });
    const { runner, calls } = recordingRunner();

    const result = await bindPlugin(
      { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
      {
        root,
        runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => resolved.treePath,
      },
    );

    // Marketplace add of the scanned checkout, THEN install, in order.
    expect(calls[0]).toEqual(["claude", "plugin", "marketplace", "add", resolved.treePath]);
    expect(calls[1]).toEqual(["claude", "plugin", "install", KEY, "--scope", "project"]);
    // No teardown on the happy path.
    expect(calls.some((c) => c.includes("uninstall") || c.includes("disable"))).toBe(false);

    // D7 identity matched and mirrors the scanned digest.
    expect(result.identity).toEqual({
      scannedDigest: resolved.treeDigest,
      loadedDigest: resolved.treeDigest,
      match: true,
    });

    // The D18 enabledPlugins field was applied to project settings.
    expect(JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"))).toEqual({
      enabledPlugins: { [KEY]: true },
    });

    // Ownership: the settings field + the two machine-scope (home:) entries, all sealed.
    expect(result.ownership).toHaveLength(3);
    const [settings, marketplace, cache] = result.ownership;
    expect(settings?.kind).toBe("json-pointer");
    // Fresh bind into an absent container: AIH created `enabledPlugins`, so it
    // owns the CONTAINER (own what you created), not just the leaf.
    expect(settings?.target).toBe(".claude/settings.json#/enabledPlugins");
    expect(settings?.preExisting).toEqual({ absent: true });
    expect(settings?.applied).toEqual({ [KEY]: true });
    expect(marketplace?.target).toBe(homeMarketplaceTarget(MARKETPLACE));
    // Empirically corrected: mirrors the exact shape `claude plugin marketplace
    // add <dir>` writes at settings.json#/extraKnownMarketplaces/<name>.
    expect(marketplace?.applied).toEqual({
      source: { source: "directory", path: resolved.treePath },
    });
    expect(cache?.target).toBe(homePluginCacheTarget(MARKETPLACE, PLUGIN));
    expect(cache?.applied).toBe(resolved.treeDigest);
    expect(cache?.postApplyDigest).toBe(resolved.treeDigest);
    for (const entry of result.ownership) {
      expect(BindingOwnershipEntrySchema.safeParse(entry).success).toBe(true);
      expect(entry.postApplyDigest).toMatch(/^[0-9a-f]{64}$/);
    }

    // The single write validates against the lock schema.
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]).toMatchObject({
      path: ".claude/settings.json",
      mechanism: "json-pointer",
    });
    expect(BindingWriteSchema.safeParse(result.writes[0]).success).toBe(true);

    // The pieces assemble into a schema-valid lock (the D7 match fields "for the lock").
    expect(BindingLockSchema.safeParse(lockFrom(result)).success).toBe(true);
  });

  it("writes local-scope settings and passes --scope local when requested", async () => {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" });
    const { runner, calls } = recordingRunner();

    const result = await bindPlugin(
      { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE, scope: "local" },
      {
        root,
        runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => resolved.treePath,
      },
    );

    expect(calls[1]).toEqual(["claude", "plugin", "install", KEY, "--scope", "local"]);
    expect(result.settingsFile).toBe(".claude/settings.local.json");
    expect(existsSync(join(root, ".claude/settings.local.json"))).toBe(true);
    expect(existsSync(join(root, ".claude/settings.json"))).toBe(false);
  });
});

describe("bindPlugin — D7 digest mismatch fails closed", () => {
  it("disables + uninstalls, throws a typed identity error, and writes no lock/ownership", async () => {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" });
    // The host would load a DIFFERENT tree than the one AIH scanned.
    const tamperedCache = tree("tampered", { "SKILL.md": "# tampered\n" });
    const { runner, calls } = recordingRunner();

    await expect(
      bindPlugin(
        { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
        {
          root,
          runner,
          env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
          locateCache: () => tamperedCache,
        },
      ),
    ).rejects.toBeInstanceOf(ClaudePluginIdentityError);

    // Teardown was scheduled (disable + uninstall), fail closed.
    expect(calls).toContainEqual(["claude", "plugin", "disable", KEY]);
    expect(calls).toContainEqual(["claude", "plugin", "uninstall", KEY, "--scope", "project"]);
    // No partial project state.
    expect(existsSync(join(root, ".claude/settings.json"))).toBe(false);
  });

  it("carries both digests on the thrown identity error", async () => {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" });
    const tamperedCache = tree("tampered", { "SKILL.md": "# tampered\n" });
    const { runner } = recordingRunner();

    const err = await bindPlugin(
      { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
      {
        root,
        runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => tamperedCache,
      },
    ).catch((e) => e as ClaudePluginIdentityError);

    expect(err.identity.match).toBe(false);
    expect(err.identity.scannedDigest).toBe(resolved.treeDigest);
    expect(err.identity.loadedDigest).not.toBe(resolved.treeDigest);
  });
});

describe("bindPlugin — disposition authorization (D12) refused before any upstream code", () => {
  it("rejects a forged (unbranded) disposition and runs no CLI", async () => {
    const { resolved } = scannedFixture("src", { "SKILL.md": "# skill\n" });
    const forged = {
      digest: resolved.treeDigest,
      verdict: "allow",
      findings: [],
      posture: "enterprise",
      producedAt: new Date().toISOString(),
    } as unknown as ScanDisposition;
    const { runner, calls } = recordingRunner();

    await expect(
      bindPlugin(
        { disposition: forged, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
        {
          root,
          runner,
          env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
          locateCache: () => resolved.treePath,
        },
      ),
    ).rejects.toBeInstanceOf(BindingScanError);
    expect(calls).toHaveLength(0);
  });

  it("rejects a disposition whose digest does not match the resolved source", async () => {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" });
    const { runner, calls } = recordingRunner();

    await expect(
      bindPlugin(
        {
          disposition,
          resolved: { ...resolved, treeDigest: "f".repeat(64) },
          plugin: PLUGIN,
          marketplace: MARKETPLACE,
        },
        {
          root,
          runner,
          env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
          locateCache: () => resolved.treePath,
        },
      ),
    ).rejects.toBeInstanceOf(BindingScanError);
    expect(calls).toHaveLength(0);
  });

  it("rejects a blocked-verdict disposition (danger floor) and runs no CLI", async () => {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" }, [
      producedCritical,
    ]);
    const { runner, calls } = recordingRunner();

    await expect(
      bindPlugin(
        { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
        {
          root,
          runner,
          env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
          locateCache: () => resolved.treePath,
        },
      ),
    ).rejects.toBeInstanceOf(BindingScanError);
    expect(calls).toHaveLength(0);
  });
});

describe("lifecycle CLI wrappers surface failures fail-closed", () => {
  it("marketplaceAdd refuses a non-absolute source path (option-injection guard)", async () => {
    const { runner } = recordingRunner();
    await expect(marketplaceAdd({ runner }, "owner/repo")).rejects.toBeInstanceOf(
      ClaudePluginError,
    );
  });

  it("enablePlugin throws on a non-zero exit", async () => {
    const { runner } = recordingRunner((argv) =>
      argv.includes("enable") ? { code: 1, stderr: "no such plugin" } : undefined,
    );
    await expect(enablePlugin({ runner }, PLUGIN, MARKETPLACE)).rejects.toBeInstanceOf(
      ClaudePluginError,
    );
  });

  it("disablePlugin throws on a spawn failure", async () => {
    const { runner } = recordingRunner((argv) =>
      argv.includes("disable") ? { code: 127, spawnError: true, stderr: "not found" } : undefined,
    );
    await expect(disablePlugin({ runner }, PLUGIN, MARKETPLACE)).rejects.toBeInstanceOf(
      ClaudePluginError,
    );
  });

  it("uninstallPlugin succeeds on exit 0 and passes the plugin key", async () => {
    const { runner, calls } = recordingRunner();
    await expect(
      uninstallPlugin({ runner, env: { AIH_PLATFORM: "linux" } }, PLUGIN, MARKETPLACE, "project"),
    ).resolves.toBeUndefined();
    expect(calls[0]).toEqual(["claude", "plugin", "uninstall", KEY, "--scope", "project"]);
  });

  it("listPlugins fails closed on unparseable CLI output", async () => {
    const { runner } = recordingRunner((argv) =>
      argv.includes("list") ? { code: 0, stdout: "{ not json" } : undefined,
    );
    await expect(listPlugins({ runner })).rejects.toBeInstanceOf(ClaudePluginError);
  });

  it("pluginDetails returns raw stdout TEXT and passes no --json flag (empirically corrected: no such flag exists)", async () => {
    const detailsText = "Skills (1)\n  - test-skill\n\nAlways-on:   ~27 tok\n";
    const { runner, calls } = recordingRunner((argv) =>
      argv.includes("details") ? { code: 0, stdout: detailsText } : undefined,
    );
    await expect(
      pluginDetails({ runner, env: { AIH_PLATFORM: "linux" } }, PLUGIN, MARKETPLACE),
    ).resolves.toBe(detailsText);
    expect(calls[0]).toEqual(["claude", "plugin", "details", KEY]);
  });

  it("pluginDetails fails closed on a non-zero exit only (no JSON to fail to parse)", async () => {
    const { runner } = recordingRunner((argv) =>
      argv.includes("details") ? { code: 1, stderr: "no such plugin" } : undefined,
    );
    await expect(pluginDetails({ runner }, PLUGIN, MARKETPLACE)).rejects.toBeInstanceOf(
      ClaudePluginError,
    );
  });
});

describe("bindPlugin — D7 anchor is the plugin's SOURCE SUBTREE, not the whole checkout (empirically corrected)", () => {
  it("scannedDigest is the subtree digest (differs from resolved.treeDigest) when the plugin source is a subdirectory", async () => {
    const dir = tree("subtree-anchor", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: MARKETPLACE,
        plugins: [{ name: PLUGIN, source: "./plugin" }],
      }),
      "plugin/.claude-plugin/plugin.json": JSON.stringify({ name: PLUGIN, version: "3.0.0" }),
      "plugin/SKILL.md": "# skill\n",
      "unrelated-sibling.md": "# not part of the plugin subtree at all\n",
    });
    const { resolved, disposition } = mintFixture(dir);
    // The host materializes ONLY the subtree bytes — a distinct, real tree.
    const subtreeCache = tree("subtree-anchor-cache", {
      "SKILL.md": "# skill\n",
      ".claude-plugin/plugin.json": JSON.stringify({ name: PLUGIN, version: "3.0.0" }),
    });
    const { runner } = recordingRunner();

    const result = await bindPlugin(
      { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
      {
        root,
        runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => subtreeCache,
      },
    );

    expect(result.identity.match).toBe(true);
    expect(result.identity.scannedDigest).not.toBe(resolved.treeDigest);
  });

  it("fails closed with ZERO CLI calls when the checkout has no marketplace.json", async () => {
    const dir = tree("no-manifest-bind", { "SKILL.md": "# skill\n" });
    const { resolved, disposition } = mintFixture(dir);
    const { runner, calls } = recordingRunner();

    await expect(
      bindPlugin(
        { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
        { root, runner, env: { USERPROFILE: home, AIH_PLATFORM: "linux" }, locateCache: () => dir },
      ),
    ).rejects.toBeInstanceOf(ClaudePluginError);
    expect(calls).toHaveLength(0);
  });

  it("fails closed with ZERO CLI calls when the checkout's marketplace.json has no entry for the plugin", async () => {
    const dir = tree("wrong-plugin-name-bind", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        plugins: [{ name: "some-other-plugin", source: "./" }],
      }),
    });
    const { resolved, disposition } = mintFixture(dir);
    const { runner, calls } = recordingRunner();

    await expect(
      bindPlugin(
        { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
        { root, runner, env: { USERPROFILE: home, AIH_PLATFORM: "linux" }, locateCache: () => dir },
      ),
    ).rejects.toBeInstanceOf(ClaudePluginError);
    expect(calls).toHaveLength(0);
  });
});

describe("bindPlugin — prefers listPlugins' authoritative installPath over the locator guess", () => {
  it("uses the installPath reported by `claude plugin list --json` when present", async () => {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" });
    // The injected locator deliberately points at the WRONG tree — proves the
    // authoritative list path is preferred over the locator's guess.
    const wrongLocatorPath = tree("wrong-locator-guess", { "SKILL.md": "# WRONG\n" });
    const { runner } = recordingRunner((argv) =>
      argv.includes("list")
        ? {
            code: 0,
            stdout: JSON.stringify({
              version: 2,
              plugins: { [KEY]: [{ scope: "project", installPath: resolved.treePath }] },
            }),
          }
        : undefined,
    );

    const result = await bindPlugin(
      { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
      {
        root,
        runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => wrongLocatorPath,
      },
    );

    expect(result.identity.match).toBe(true);
    expect(result.loadedTreePath).toBe(resolved.treePath);
  });

  it("falls back to the locator when listPlugins has no entry for the plugin key (parse succeeds, entry absent)", async () => {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" });
    const { runner } = recordingRunner((argv) =>
      argv.includes("list")
        ? { code: 0, stdout: JSON.stringify({ version: 2, plugins: {} }) }
        : undefined,
    );

    const result = await bindPlugin(
      { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
      {
        root,
        runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => resolved.treePath,
      },
    );

    expect(result.identity.match).toBe(true);
    expect(result.loadedTreePath).toBe(resolved.treePath);
  });

  it("falls back to the locator when listPlugins itself fails (non-zero exit)", async () => {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" });
    const { runner } = recordingRunner((argv) =>
      argv.includes("list") ? { code: 1, stderr: "boom" } : undefined,
    );

    const result = await bindPlugin(
      { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
      {
        root,
        runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => resolved.treePath,
      },
    );

    expect(result.identity.match).toBe(true);
    expect(result.loadedTreePath).toBe(resolved.treePath);
  });
});

describe("removePlugin — conservative machine-scope reconciliation", () => {
  async function bindForRemoval(): Promise<BindPluginResult> {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" });
    const { runner } = recordingRunner();
    return bindPlugin(
      { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
      {
        root,
        runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => resolved.treePath,
      },
    );
  }

  it("tears down plugin + marketplace when the cache still equals the recorded digest", async () => {
    const bound = await bindForRemoval();
    const { runner, calls } = recordingRunner();

    const removal = await removePlugin(
      { ownership: bound.ownership, plugin: PLUGIN, marketplace: MARKETPLACE, scope: "project" },
      {
        runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => bound.loadedTreePath,
      },
    );

    expect(removal.drift).toHaveLength(0);
    expect(removal.removed).toContain(homePluginCacheTarget(MARKETPLACE, PLUGIN));
    expect(removal.removed).toContain(homeMarketplaceTarget(MARKETPLACE));
    expect(calls).toContainEqual(["claude", "plugin", "uninstall", KEY, "--scope", "project"]);
    expect(calls).toContainEqual(["claude", "plugin", "marketplace", "remove", MARKETPLACE]);
  });

  it("preserves + reports drift when the materialized cache was modified since bind", async () => {
    const bound = await bindForRemoval();
    // User modifies the materialized cache after bind.
    writeFileSync(join(bound.loadedTreePath, "EXTRA.md"), "# user edit\n", "utf8");
    const { runner, calls } = recordingRunner();

    const removal = await removePlugin(
      { ownership: bound.ownership, plugin: PLUGIN, marketplace: MARKETPLACE, scope: "project" },
      {
        runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => bound.loadedTreePath,
      },
    );

    expect(removal.removed).toHaveLength(0);
    expect(removal.drift.map((d) => d.target)).toContain(
      homePluginCacheTarget(MARKETPLACE, PLUGIN),
    );
    expect(removal.drift.map((d) => d.target)).toContain(homeMarketplaceTarget(MARKETPLACE));
    // Nothing torn down — the user's drift is never silently removed.
    expect(calls).toHaveLength(0);
  });

  it("preserves + reports drift when the cache tree is present but unreadable (empty)", async () => {
    // Fail-closed: a present-but-unreadable/empty tree is NOT "already gone". It
    // may still be loadable, so removal must PRESERVE it + report drift, never
    // silently drop the lock entry (the fail-open bug this guards against).
    const bound = await bindForRemoval();
    const emptyCache = join(home, "empty-cache");
    mkdirSync(emptyCache, { recursive: true });
    const { runner, calls } = recordingRunner();

    const removal = await removePlugin(
      { ownership: bound.ownership, plugin: PLUGIN, marketplace: MARKETPLACE, scope: "project" },
      { runner, env: { USERPROFILE: home, AIH_PLATFORM: "linux" }, locateCache: () => emptyCache },
    );

    expect(removal.removed).toHaveLength(0);
    expect(removal.drift.map((d) => d.target)).toContain(
      homePluginCacheTarget(MARKETPLACE, PLUGIN),
    );
    expect(removal.drift.map((d) => d.target)).toContain(homeMarketplaceTarget(MARKETPLACE));
    const cacheDrift = removal.drift.find(
      (d) => d.target === homePluginCacheTarget(MARKETPLACE, PLUGIN),
    );
    expect(cacheDrift?.reason).toContain("unreadable");
    // No teardown — nothing was torn down for a tree we cannot verify is gone.
    expect(calls).toHaveLength(0);
  });

  it("is an idempotent no-op when the cache is already gone (missing tree)", async () => {
    const bound = await bindForRemoval();
    const { runner, calls } = recordingRunner();

    const removal = await removePlugin(
      { ownership: bound.ownership, plugin: PLUGIN, marketplace: MARKETPLACE, scope: "project" },
      {
        runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => join(home, "absent-cache"),
      },
    );

    expect(removal.removed).toHaveLength(0);
    expect(removal.drift).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("bindPlugin — re-bind idempotency", () => {
  it("re-binds to identical settings bytes and preserves the original pre-existing state", async () => {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" });

    const first = await bindPlugin(
      { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
      {
        root,
        runner: recordingRunner().runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => resolved.treePath,
      },
    );
    const settingsAfterFirst = readFileSync(join(root, ".claude/settings.json"), "utf8");

    const second = await bindPlugin(
      {
        disposition,
        resolved,
        plugin: PLUGIN,
        marketplace: MARKETPLACE,
        previousLock: lockFrom(first),
      },
      {
        root,
        runner: recordingRunner().runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => resolved.treePath,
      },
    );

    // Byte-identical settings on re-bind (no churn).
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toBe(settingsAfterFirst);
    // The original pre-AIH state (absent) is preserved, not the first bind's own
    // value — and PARENT ownership is re-asserted, so removal from the re-bind
    // lock still takes the whole container AIH created.
    expect(second.ownership[0]?.target).toBe(".claude/settings.json#/enabledPlugins");
    expect(second.ownership[0]?.preExisting).toEqual({ absent: true });
    expect(second.ownership[0]?.applied).toEqual({ [KEY]: true });
    expect(second.identity).toEqual(first.identity);
    expect(second.writes).toEqual(first.writes);
  });
});

describe("bindPlugin / wrappers — safe-key refusal of hostile plugin/marketplace names", () => {
  it.each([
    ["a space", "plugin name with space"],
    ["--scope=evil", "option-injection shape"],
    ["../../etc", "path traversal"],
    ["a/b", "path separator"],
    ["ecc@x", "@ composes the enable key"],
    ["with\tcontrol", "control character"],
    ["", "empty"],
    ["constructor", "prototype-pollution key"],
  ])("refuses %j (%s) as a plugin name", async (bad) => {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" });
    const { runner, calls } = recordingRunner();
    await expect(
      bindPlugin(
        { disposition, resolved, plugin: bad, marketplace: MARKETPLACE },
        {
          root,
          runner,
          env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
          locateCache: () => resolved.treePath,
        },
      ),
    ).rejects.toThrow();
    // Refused at the boundary — before any CLI ran.
    expect(calls).toHaveLength(0);
  });

  it("refuses a hostile marketplace name in the install wrapper", async () => {
    const { runner } = recordingRunner();
    await expect(installPlugin({ runner }, PLUGIN, "--evil", "project")).rejects.toThrow();
  });
});

describe("marketplace manifest-name contract (W4 live-run correction)", () => {
  // `claude plugin marketplace add <dir>` registers the marketplace under the
  // NAME THE MANIFEST DECLARES — never a registrar-chosen one. A mismatched
  // expectation must fail closed before any host mutation, and a failed bind
  // must unwind the registration it just made.
  const MARKETPLACE_REMOVE = ["claude", "plugin", "marketplace", "remove", MARKETPLACE];

  function bindDeps(runner: Runner, locate?: () => string) {
    return {
      root,
      runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      ...(locate === undefined ? {} : { locateCache: locate }),
    };
  }

  it("refuses before any CLI call when the manifest declares a different marketplace name", async () => {
    const { resolved, disposition } = scannedFixture("name-mismatch", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: "other-mkt",
        plugins: [{ name: PLUGIN, source: "./" }],
      }),
    });
    const { runner, calls } = recordingRunner();
    await expect(
      bindPlugin(
        { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
        bindDeps(runner, () => resolved.treePath),
      ),
    ).rejects.toThrow(ClaudePluginError);
    expect(calls).toHaveLength(0);
  });

  it("removes the just-registered marketplace when the install step fails", async () => {
    const { resolved, disposition } = scannedFixture("install-fails", {});
    const { runner, calls } = recordingRunner((argv) =>
      argv.includes("install") ? { code: 1, stderr: "install exploded" } : undefined,
    );
    await expect(
      bindPlugin(
        { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
        bindDeps(runner, () => resolved.treePath),
      ),
    ).rejects.toThrow(ClaudePluginError);
    expect(calls).toContainEqual(MARKETPLACE_REMOVE);
  });

  it("removes the just-registered marketplace on a D7 identity mismatch", async () => {
    const { resolved, disposition } = scannedFixture("d7-unwind", {});
    const tamperedCache = tree("d7-unwind-tampered", { "SKILL.md": "tampered bytes\n" });
    const { runner, calls } = recordingRunner();
    await expect(
      bindPlugin(
        { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
        bindDeps(runner, () => tamperedCache),
      ),
    ).rejects.toThrow(ClaudePluginIdentityError);
    expect(calls).toContainEqual(MARKETPLACE_REMOVE);
  });

  it("deletes the owned cache root on clean removal even when the host CLI leaves bytes behind", async () => {
    // 2.1.214 empirical: project-scope uninstall deregisters but leaves the
    // cache bytes — removal must tear down the owned root itself.
    const { resolved, disposition } = scannedFixture("cli-leaves-bytes", {});
    const { runner } = recordingRunner();
    const bound = await bindPlugin(
      { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
      bindDeps(runner, () => resolved.treePath),
    );
    const ownedRoot = join(home, ".claude", "plugins", "cache", MARKETPLACE, PLUGIN);
    mkdirSync(join(ownedRoot, "1.0.0"), { recursive: true });
    writeFileSync(join(ownedRoot, "1.0.0", "SKILL.md"), "# left behind\n", "utf8");

    const removal = await removePlugin(
      { ownership: bound.ownership, plugin: PLUGIN, marketplace: MARKETPLACE, scope: "project" },
      {
        runner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => bound.loadedTreePath,
      },
    );
    expect(removal.removed).toContain(homePluginCacheTarget(MARKETPLACE, PLUGIN));
    expect(existsSync(ownedRoot)).toBe(false);
  });

  it("never removes a marketplace that was registered before the bind", async () => {
    const { resolved, disposition } = scannedFixture("pre-registered", {});
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        extraKnownMarketplaces: {
          [MARKETPLACE]: { source: { source: "directory", path: resolved.treePath } },
        },
      }),
      "utf8",
    );
    const { runner, calls } = recordingRunner((argv) =>
      argv.includes("install") ? { code: 1, stderr: "install exploded" } : undefined,
    );
    await expect(
      bindPlugin(
        { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
        bindDeps(runner, () => resolved.treePath),
      ),
    ).rejects.toThrow(ClaudePluginError);
    expect(calls).not.toContainEqual(MARKETPLACE_REMOVE);
  });
});
