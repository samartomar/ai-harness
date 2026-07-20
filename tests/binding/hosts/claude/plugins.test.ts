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
 * A scanned source with a GENUINE brand-protected disposition minted by the real
 * gate over an on-disk tree (no git, no network): identityFiles are exactly the
 * digest's fileset so coverage is complete and the gate allows.
 */
function scannedFixture(
  name: string,
  files: Record<string, string>,
  inspectors: DimensionInspector[] = [producedClean],
): {
  resolved: import("../../../../src/binding/scan-gate.js").ResolvedGitSource;
  disposition: ScanDisposition;
} {
  const dir = tree(name, files);
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
      { root, runner, env: { USERPROFILE: home }, locateCache: () => resolved.treePath },
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
    expect(settings?.target).toBe(`.claude/settings.json#/enabledPlugins/${KEY}`);
    expect(settings?.preExisting).toEqual({ absent: true });
    expect(settings?.applied).toBe(true);
    expect(marketplace?.target).toBe(homeMarketplaceTarget(MARKETPLACE));
    expect(marketplace?.applied).toEqual({ source: resolved.treePath });
    expect(cache?.target).toBe(homePluginCacheTarget(KEY));
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
      { root, runner, env: { USERPROFILE: home }, locateCache: () => resolved.treePath },
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
        { root, runner, env: { USERPROFILE: home }, locateCache: () => tamperedCache },
      ),
    ).rejects.toBeInstanceOf(ClaudePluginIdentityError);

    // Teardown was scheduled (disable + uninstall), fail closed.
    expect(calls).toContainEqual(["claude", "plugin", "disable", KEY]);
    expect(calls).toContainEqual(["claude", "plugin", "uninstall", KEY]);
    // No partial project state.
    expect(existsSync(join(root, ".claude/settings.json"))).toBe(false);
  });

  it("carries both digests on the thrown identity error", async () => {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" });
    const tamperedCache = tree("tampered", { "SKILL.md": "# tampered\n" });
    const { runner } = recordingRunner();

    const err = await bindPlugin(
      { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
      { root, runner, env: { USERPROFILE: home }, locateCache: () => tamperedCache },
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
        { root, runner, env: { USERPROFILE: home }, locateCache: () => resolved.treePath },
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
        { root, runner, env: { USERPROFILE: home }, locateCache: () => resolved.treePath },
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
        { root, runner, env: { USERPROFILE: home }, locateCache: () => resolved.treePath },
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
    await expect(uninstallPlugin({ runner }, PLUGIN, MARKETPLACE)).resolves.toBeUndefined();
    expect(calls[0]).toEqual(["claude", "plugin", "uninstall", KEY]);
  });

  it("listPlugins fails closed on unparseable CLI output", async () => {
    const { runner } = recordingRunner((argv) =>
      argv.includes("list") ? { code: 0, stdout: "{ not json" } : undefined,
    );
    await expect(listPlugins({ runner })).rejects.toBeInstanceOf(ClaudePluginError);
  });

  it("pluginDetails parses JSON output", async () => {
    const { runner } = recordingRunner((argv) =>
      argv.includes("details") ? { code: 0, stdout: JSON.stringify({ name: KEY }) } : undefined,
    );
    await expect(pluginDetails({ runner }, PLUGIN, MARKETPLACE)).resolves.toEqual({ name: KEY });
  });
});

describe("removePlugin — conservative machine-scope reconciliation", () => {
  async function bindForRemoval(): Promise<BindPluginResult> {
    const { resolved, disposition } = scannedFixture("src", { "SKILL.md": "# skill\n" });
    const { runner } = recordingRunner();
    return bindPlugin(
      { disposition, resolved, plugin: PLUGIN, marketplace: MARKETPLACE },
      { root, runner, env: { USERPROFILE: home }, locateCache: () => resolved.treePath },
    );
  }

  it("tears down plugin + marketplace when the cache still equals the recorded digest", async () => {
    const bound = await bindForRemoval();
    const { runner, calls } = recordingRunner();

    const removal = await removePlugin(
      { ownership: bound.ownership, plugin: PLUGIN, marketplace: MARKETPLACE },
      { runner, env: { USERPROFILE: home }, locateCache: () => bound.loadedTreePath },
    );

    expect(removal.drift).toHaveLength(0);
    expect(removal.removed).toContain(homePluginCacheTarget(KEY));
    expect(removal.removed).toContain(homeMarketplaceTarget(MARKETPLACE));
    expect(calls).toContainEqual(["claude", "plugin", "uninstall", KEY]);
    expect(calls).toContainEqual(["claude", "plugin", "marketplace", "remove", MARKETPLACE]);
  });

  it("preserves + reports drift when the materialized cache was modified since bind", async () => {
    const bound = await bindForRemoval();
    // User modifies the materialized cache after bind.
    writeFileSync(join(bound.loadedTreePath, "EXTRA.md"), "# user edit\n", "utf8");
    const { runner, calls } = recordingRunner();

    const removal = await removePlugin(
      { ownership: bound.ownership, plugin: PLUGIN, marketplace: MARKETPLACE },
      { runner, env: { USERPROFILE: home }, locateCache: () => bound.loadedTreePath },
    );

    expect(removal.removed).toHaveLength(0);
    expect(removal.drift.map((d) => d.target)).toContain(homePluginCacheTarget(KEY));
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
      { ownership: bound.ownership, plugin: PLUGIN, marketplace: MARKETPLACE },
      { runner, env: { USERPROFILE: home }, locateCache: () => emptyCache },
    );

    expect(removal.removed).toHaveLength(0);
    expect(removal.drift.map((d) => d.target)).toContain(homePluginCacheTarget(KEY));
    expect(removal.drift.map((d) => d.target)).toContain(homeMarketplaceTarget(MARKETPLACE));
    const cacheDrift = removal.drift.find((d) => d.target === homePluginCacheTarget(KEY));
    expect(cacheDrift?.reason).toContain("unreadable");
    // No teardown — nothing was torn down for a tree we cannot verify is gone.
    expect(calls).toHaveLength(0);
  });

  it("is an idempotent no-op when the cache is already gone (missing tree)", async () => {
    const bound = await bindForRemoval();
    const { runner, calls } = recordingRunner();

    const removal = await removePlugin(
      { ownership: bound.ownership, plugin: PLUGIN, marketplace: MARKETPLACE },
      { runner, env: { USERPROFILE: home }, locateCache: () => join(home, "absent-cache") },
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
        env: { USERPROFILE: home },
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
        env: { USERPROFILE: home },
        locateCache: () => resolved.treePath,
      },
    );

    // Byte-identical settings on re-bind (no churn).
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toBe(settingsAfterFirst);
    // The original pre-AIH state (absent) is preserved, not the first bind's own value.
    expect(second.ownership[0]?.preExisting).toEqual({ absent: true });
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
        { root, runner, env: { USERPROFILE: home }, locateCache: () => resolved.treePath },
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
