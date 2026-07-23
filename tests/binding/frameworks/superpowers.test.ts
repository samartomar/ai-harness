import { execFileSync } from "node:child_process";
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
import { hashComponentTree } from "../../../src/baseline-evidence/hash.js";
import { AdapterRegistry, type BindingContext } from "../../../src/binding/adapter.js";
import { assertNoMachineLocalPath, parseFrameworkCard } from "../../../src/binding/card.js";
import { BindingFeatureKeyError } from "../../../src/binding/features.js";
import { createBindingAdapterRegistry } from "../../../src/binding/frameworks/registry.js";
import {
  createSuperpowersAdapter,
  SUPERPOWERS_MARKETPLACE_NAME,
  SUPERPOWERS_PIN_COMMIT,
  SUPERPOWERS_PLUGIN_NAME,
  SUPERPOWERS_REPOSITORY,
  SuperpowersBindingError,
  type SuperpowersRemoveResult,
} from "../../../src/binding/frameworks/superpowers.js";
import { pluginEnableKey, removePlugin } from "../../../src/binding/hosts/claude/plugins.js";
import { CLAUDE_SETTINGS_PATH } from "../../../src/binding/hosts/claude/surfaces.js";
import {
  BindingLockSchema,
  bindingDir,
  bindingLockPath,
  readBindingLock,
} from "../../../src/binding/lock.js";
import {
  BindingScanError,
  type ResolvedGitSource,
  resolveGitSource,
  runFastScanGate,
  type ScanDisposition,
  type ScannableSource,
  W2_DEFAULT_INSPECTORS,
} from "../../../src/binding/scan-gate.js";
import {
  type BindingDeclaration,
  BindingFrameworkConflictError,
} from "../../../src/binding/schema.js";
import {
  defaultRunner,
  fakeRunner,
  type Runner,
  type RunResult,
} from "../../../src/internals/proc.js";
import { applyActions } from "../hosts/claude/support.js";

/**
 * W4a — the Superpowers FrameworkAdapter. Every disposition here is REAL
 * (minted by `runFastScanGate` with the actual `W2_DEFAULT_INSPECTORS`, never
 * a forged/hand-rolled brand); every host effect goes through `fakeRunner` —
 * no test here spawns the real `claude` binary or touches the real `~/.claude`.
 */

let root: string;
let home: string;
let cacheHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-sp-root-"));
  home = mkdtempSync(join(tmpdir(), "aih-sp-home-"));
  cacheHome = mkdtempSync(join(tmpdir(), "aih-sp-cache-"));
});

afterEach(() => {
  for (const dir of [root, home, cacheHome]) rmSync(dir, { recursive: true, force: true });
});

function tree(name: string, files: Record<string, string>): string {
  const dir = join(cacheHome, name);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return dir;
}

const SUPERPOWERS_FIXTURE_FILES = {
  "SKILL.md": "# Superpowers skill\n\nDoes a skill thing.\n",
  "skills/writing-plans/SKILL.md": "# Writing plans\n\nHow to write a plan.\n",
};

/**
 * The `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json` every
 * `provision()` fixture needs (empirically corrected: the D7 anchor is the
 * plugin's own SOURCE SUBTREE, resolved via these manifests — see
 * `pluginSourceSubtreeDigest`). `source: "./"` mirrors the real obra/superpowers
 * shape (single-plugin-at-root marketplace): the subtree IS the whole
 * checkout, so its digest equals `resolved.treeDigest` — every existing
 * digest assertion in this file stays valid unchanged.
 */
const SUPERPOWERS_MANIFEST_FILES = {
  ".claude-plugin/marketplace.json": JSON.stringify({
    name: SUPERPOWERS_MARKETPLACE_NAME,
    plugins: [{ name: SUPERPOWERS_PLUGIN_NAME, source: "./" }],
  }),
  ".claude-plugin/plugin.json": JSON.stringify({ name: SUPERPOWERS_PLUGIN_NAME, version: "1.0.0" }),
};

/**
 * A REAL, non-forged brand-protected disposition, minted by running the
 * actual W2 fast-scan gate (`W2_DEFAULT_INSPECTORS`, not a toy inspector)
 * over a small on-disk fixture tree — no git, no network.
 */
function scannedFixture(
  name: string,
  files: Record<string, string> = SUPERPOWERS_FIXTURE_FILES,
): { resolved: ResolvedGitSource; disposition: ScanDisposition } {
  const dir = tree(name, { ...SUPERPOWERS_MANIFEST_FILES, ...files });
  const topLevel = readdirSync(dir)
    .filter((n) => n !== ".git")
    .sort();
  const hashed = hashComponentTree(dir, topLevel);
  const source: ScannableSource = {
    digest: hashed.treeSha256,
    treePath: dir,
    identityFiles: hashed.files.map((f) => f.path),
  };
  const disposition = runFastScanGate(
    source,
    { posture: "enterprise" },
    {
      cacheHome,
      inspectors: W2_DEFAULT_INSPECTORS,
    },
  );
  return {
    resolved: {
      kind: "git",
      repository: SUPERPOWERS_REPOSITORY,
      commitSha: SUPERPOWERS_PIN_COMMIT,
      treeDigest: hashed.treeSha256,
      treePath: dir,
      files: source.identityFiles,
    },
    disposition,
  };
}

function declarationFor(treeDigest: string): BindingDeclaration {
  return {
    schemaVersion: 1,
    framework: { id: "superpowers", host: "claude" },
    source: {
      kind: "git",
      repository: SUPERPOWERS_REPOSITORY,
      commitSha: SUPERPOWERS_PIN_COMMIT,
      treeDigest,
    },
  };
}

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

const KEY = pluginEnableKey(SUPERPOWERS_PLUGIN_NAME, SUPERPOWERS_MARKETPLACE_NAME);

// -- registry -----------------------------------------------------------------

describe("createSuperpowersAdapter — registers in AdapterRegistry (D6)", () => {
  it("registers as framework 'superpowers' with adapterType 'host-plugin'", () => {
    const registry = new AdapterRegistry();
    const adapter = createSuperpowersAdapter({ root, runner: recordingRunner().runner });
    registry.register(adapter);
    expect(registry.has("superpowers")).toBe(true);
    expect(registry.get("superpowers")?.adapterType).toBe("host-plugin");
    expect(registry.frameworks()).toEqual(["superpowers"]);
  });

  it("createBindingAdapterRegistry wires the same adapter", () => {
    const registry = createBindingAdapterRegistry({ root, runner: recordingRunner().runner });
    expect(registry.get("superpowers")?.adapterType).toBe("host-plugin");
  });
});

// -- plan ---------------------------------------------------------------------

describe("plan — D8 conflict + feature-key rejection (pure preview, no I/O)", () => {
  it("rejects planning when a different framework is already bound (D8)", () => {
    const adapter = createSuperpowersAdapter({ root, runner: recordingRunner().runner });
    const context: BindingContext = {
      declaration: declarationFor("d".repeat(64)),
      existingFramework: "ecc",
    };
    expect(() => adapter.plan(context)).toThrow(BindingFrameworkConflictError);
  });

  it("allows planning when re-binding the same framework", () => {
    const adapter = createSuperpowersAdapter({ root, runner: recordingRunner().runner });
    const context: BindingContext = {
      declaration: declarationFor("d".repeat(64)),
      existingFramework: "superpowers",
    };
    expect(() => adapter.plan(context)).not.toThrow();
  });

  it("rejects any declared feature key — superpowers accepts none", () => {
    const adapter = createSuperpowersAdapter({ root, runner: recordingRunner().runner });
    const declaration = declarationFor("d".repeat(64));
    const withFeature: BindingDeclaration = {
      ...declaration,
      framework: { ...declaration.framework, features: { anything: true } },
    };
    expect(() => adapter.plan({ declaration: withFeature })).toThrow(BindingFeatureKeyError);
  });

  it("rejects a declaration routed to the wrong framework", () => {
    const adapter = createSuperpowersAdapter({ root, runner: recordingRunner().runner });
    const eccDeclaration: BindingDeclaration = {
      schemaVersion: 1,
      framework: { id: "ecc", mode: "lean", host: "claude" },
      source: {
        kind: "git",
        repository: "affaan-m/ECC",
        commitSha: "c".repeat(40),
        treeDigest: "d".repeat(64),
      },
    };
    expect(() => adapter.plan({ declaration: eccDeclaration })).toThrow(SuperpowersBindingError);
  });

  it("produces a writes/ownership preview covering enabledPlugins, telemetry, and home: entries with no I/O", () => {
    const adapter = createSuperpowersAdapter({ root, runner: recordingRunner().runner });
    const result = adapter.plan({ declaration: declarationFor("d".repeat(64)) });

    expect(result.framework).toBe("superpowers");
    expect(result.writes).toHaveLength(2);

    const targets = result.ownership.map((entry) => entry.target);
    expect(targets.some((t) => t.includes("enabledPlugins"))).toBe(true);
    expect(targets.some((t) => t.includes("/env"))).toBe(true);
    expect(targets).toContain(
      `home:.claude/settings.json#/extraKnownMarketplaces/${SUPERPOWERS_MARKETPLACE_NAME}`,
    );
    expect(targets).toContain(
      `home:.claude/plugins/cache/${SUPERPOWERS_MARKETPLACE_NAME}/${SUPERPOWERS_PLUGIN_NAME}`,
    );

    // Pure preview: plan must not write anything to disk.
    expect(existsSync(join(root, CLAUDE_SETTINGS_PATH))).toBe(false);
  });
});

// -- resolve --------------------------------------------------------------------

describe("resolve — delegates to resolveGitSource with the declaration's source", () => {
  function initGitRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const g = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    g(["init", "-b", "main"]);
    g(["config", "user.email", "test@example.com"]);
    g(["config", "user.name", "Binding Test"]);
    g(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "SKILL.md"), "# skill\n");
    g(["add", "-A"]);
    g(["commit", "-m", "init"]);
  }

  it("resolves the exact declared commitSha without a ref round-trip", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "aih-sp-repo-"));
    try {
      initGitRepo(repoDir);
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
      const adapter = createSuperpowersAdapter({ root, runner: defaultRunner, cacheHome });
      const declaration: BindingDeclaration = {
        schemaVersion: 1,
        framework: { id: "superpowers", host: "claude" },
        source: { kind: "git", repository: repoDir, commitSha: head, treeDigest: "d".repeat(64) },
      };

      const resolved = await adapter.resolve({ declaration });

      expect(resolved.kind).toBe("git");
      if (resolved.kind === "git") {
        expect(resolved.commitSha).toBe(head);
        expect(resolved.treeDigest).toMatch(/^[0-9a-f]{64}$/);
      }
      // Independently confirm this matches resolveGitSource called directly.
      const direct = await resolveGitSource(
        { repository: repoDir, commitSha: head },
        { runner: defaultRunner, cacheHome },
      );
      expect(resolved).toEqual(direct);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("rejects a non-git declared source", async () => {
    const adapter = createSuperpowersAdapter({ root, runner: recordingRunner().runner });
    const declaration: BindingDeclaration = {
      schemaVersion: 1,
      framework: { id: "superpowers", host: "claude" },
      source: {
        kind: "npm",
        package: "@obra/superpowers",
        exactVersion: "1.0.0",
        integrity: `sha512-${"A".repeat(86)}==`,
      },
    };
    await expect(adapter.resolve({ declaration })).rejects.toBeInstanceOf(SuperpowersBindingError);
  });
});

// -- provision: happy path ------------------------------------------------------

describe("provision — happy path end to end on fixtures", () => {
  it("binds the plugin, writes a schema-valid lock, and owns enabledPlugins/telemetry/home entries", async () => {
    const { resolved, disposition } = scannedFixture("src");
    const { runner, calls } = recordingRunner();
    const adapter = createSuperpowersAdapter({
      root,
      runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    const declaration = declarationFor(resolved.treeDigest);

    const result = await adapter.provision({ context: { declaration }, resolved }, disposition);

    // marketplace add -> install, in order; no teardown on the happy path.
    expect(calls[0]).toEqual(["claude", "plugin", "marketplace", "add", resolved.treePath]);
    expect(calls[1]).toEqual(["claude", "plugin", "install", KEY, "--scope", "project"]);
    expect(calls.some((c) => c.includes("uninstall") || c.includes("disable"))).toBe(false);

    expect(BindingLockSchema.safeParse(result.lock).success).toBe(true);
    expect(result.lock.match).toBe(true);
    expect(result.lock.scannedDigest).toBe(resolved.treeDigest);
    expect(result.lock.loadedDigest).toBe(resolved.treeDigest);

    const settings = JSON.parse(readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf8"));
    expect(settings.enabledPlugins).toEqual({ [KEY]: true });
    expect(settings.env).toEqual({ SUPERPOWERS_DISABLE_TELEMETRY: "1" });

    const targets = result.lock.ownership.map((entry) => entry.target);
    expect(targets).toContain(
      `home:.claude/settings.json#/extraKnownMarketplaces/${SUPERPOWERS_MARKETPLACE_NAME}`,
    );
    expect(targets).toContain(
      `home:.claude/plugins/cache/${SUPERPOWERS_MARKETPLACE_NAME}/${SUPERPOWERS_PLUGIN_NAME}`,
    );
    expect(targets.some((t) => t.includes("/enabledPlugins"))).toBe(true);
    expect(targets.some((t) => t.includes("/env"))).toBe(true);
    for (const entry of result.lock.ownership) {
      expect(entry.postApplyDigest).toMatch(/^[0-9a-f]{64}$/);
    }

    expect(readBindingLock(root).present).toBe(true);
  });
});

// -- provision: D12 disposition authorization -----------------------------------

describe("provision — forged/mismatched disposition rejected before any upstream code (D12)", () => {
  it("rejects a forged (unbranded) disposition and runs no CLI", async () => {
    const { resolved } = scannedFixture("src");
    const forged = {
      digest: resolved.treeDigest,
      verdict: "allow",
      findings: [],
      posture: "enterprise",
      producedAt: new Date().toISOString(),
    } as unknown as ScanDisposition;
    const { runner, calls } = recordingRunner();
    const adapter = createSuperpowersAdapter({
      root,
      runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
    });
    const declaration = declarationFor(resolved.treeDigest);

    await expect(
      adapter.provision({ context: { declaration }, resolved }, forged),
    ).rejects.toBeInstanceOf(BindingScanError);
    expect(calls).toHaveLength(0);
  });

  it("rejects a disposition whose digest does not match the resolved source", async () => {
    const { resolved, disposition } = scannedFixture("src");
    const { runner, calls } = recordingRunner();
    const adapter = createSuperpowersAdapter({
      root,
      runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
    });
    const mismatched: ResolvedGitSource = { ...resolved, treeDigest: "f".repeat(64) };
    const declaration = declarationFor(mismatched.treeDigest);

    await expect(
      adapter.provision({ context: { declaration }, resolved: mismatched }, disposition),
    ).rejects.toBeInstanceOf(BindingScanError);
    expect(calls).toHaveLength(0);
  });

  it("re-rejects a second framework (D8 layer 3) even with a valid allow disposition", async () => {
    const { resolved, disposition } = scannedFixture("src");
    const { runner, calls } = recordingRunner();
    const adapter = createSuperpowersAdapter({
      root,
      runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
    });
    const declaration = declarationFor(resolved.treeDigest);

    await expect(
      adapter.provision(
        { context: { declaration, existingFramework: "ecc" }, resolved },
        disposition,
      ),
    ).rejects.toBeInstanceOf(BindingFrameworkConflictError);
    expect(calls).toHaveLength(0);
  });
});

// -- provision: D7 fail closed ---------------------------------------------------

describe("provision — D7 loaded-tree mismatch fails closed", () => {
  it("throws, tears down the install attempt, and writes no lock or settings", async () => {
    const { resolved, disposition } = scannedFixture("src");
    const tamperedCache = tree("tampered", { "SKILL.md": "# tampered\n" });
    const { runner, calls } = recordingRunner();
    const adapter = createSuperpowersAdapter({
      root,
      runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => tamperedCache,
    });
    const declaration = declarationFor(resolved.treeDigest);

    await expect(
      adapter.provision({ context: { declaration }, resolved }, disposition),
    ).rejects.toThrow();

    expect(calls).toContainEqual(["claude", "plugin", "disable", KEY]);
    expect(calls).toContainEqual(["claude", "plugin", "uninstall", KEY, "--scope", "project"]);
    expect(existsSync(join(root, CLAUDE_SETTINGS_PATH))).toBe(false);
    expect(readBindingLock(root).present).toBe(false);
  });
});

// -- provision: re-provision threads previousLock --------------------------------

describe("provision — re-provision threads previousLock (parent-container ownership carried)", () => {
  it("re-binds to identical settings bytes and preserves absent pre-existing state at the container level", async () => {
    const { resolved, disposition } = scannedFixture("src");
    const { runner } = recordingRunner();
    const adapter = createSuperpowersAdapter({
      root,
      runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    const declaration = declarationFor(resolved.treeDigest);

    const first = await adapter.provision({ context: { declaration }, resolved }, disposition);
    const bytesAfterFirst = readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf8");

    const second = await adapter.provision({ context: { declaration }, resolved }, disposition);
    const bytesAfterSecond = readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf8");

    expect(bytesAfterSecond).toBe(bytesAfterFirst);
    expect(second.lock.writes).toEqual(first.lock.writes);

    const enabledPluginsEntry = second.lock.ownership.find((entry) =>
      entry.target.endsWith("#/enabledPlugins"),
    );
    const envEntry = second.lock.ownership.find((entry) => entry.target.endsWith("#/env"));
    expect(enabledPluginsEntry?.preExisting).toEqual({ absent: true });
    expect(envEntry?.preExisting).toEqual({ absent: true });
    expect(enabledPluginsEntry?.applied).toEqual({ [KEY]: true });
    expect(envEntry?.applied).toEqual({ SUPERPOWERS_DISABLE_TELEMETRY: "1" });
  });
});

// -- verify -----------------------------------------------------------------------

describe("verify — clean after bind, drift reported after user edit or cache tamper", () => {
  it("reports absent-lock drift on a fresh root", () => {
    const adapter = createSuperpowersAdapter({ root, runner: recordingRunner().runner });
    const result = adapter.verify({ declaration: declarationFor("0".repeat(64)) });
    expect(result).toEqual({ ok: false, drift: ["no binding lock"] });
  });

  it("reports ok:true with no drift right after a clean bind", async () => {
    const { resolved, disposition } = scannedFixture("src");
    const adapter = createSuperpowersAdapter({
      root,
      runner: recordingRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    const declaration = declarationFor(resolved.treeDigest);
    await adapter.provision({ context: { declaration }, resolved }, disposition);

    const result = adapter.verify({ declaration });
    expect(result.drift).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports drift when the owned telemetry field is edited by hand after bind", async () => {
    const { resolved, disposition } = scannedFixture("src");
    const adapter = createSuperpowersAdapter({
      root,
      runner: recordingRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    const declaration = declarationFor(resolved.treeDigest);
    await adapter.provision({ context: { declaration }, resolved }, disposition);

    const settingsPath = join(root, CLAUDE_SETTINGS_PATH);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.env.SUPERPOWERS_DISABLE_TELEMETRY = "0"; // user re-enabled telemetry by hand
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    const result = adapter.verify({ declaration });
    expect(result.ok).toBe(false);
    expect(result.drift.some((line) => line.includes("env"))).toBe(true);
  });

  it("reports drift when the loaded plugin cache tree is tampered after bind (D7 re-check)", async () => {
    const { resolved, disposition } = scannedFixture("src");
    let locatedPath = resolved.treePath;
    const adapter = createSuperpowersAdapter({
      root,
      runner: recordingRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => locatedPath,
    });
    const declaration = declarationFor(resolved.treeDigest);
    await adapter.provision({ context: { declaration }, resolved }, disposition);

    // The materialized cache tree changes after bind (a different tree entirely).
    locatedPath = tree("tampered-verify", { "SKILL.md": "# tampered\n" });

    const result = adapter.verify({ declaration });
    expect(result.ok).toBe(false);
    expect(result.drift.some((line) => line.toLowerCase().includes("identity"))).toBe(true);
  });
});

// -- remove -----------------------------------------------------------------------

describe("remove — plan/apply separation, round-trip, and missing-lock mode", () => {
  it("returns drift-report-only with a reason when no lock is present", () => {
    const adapter = createSuperpowersAdapter({ root, runner: recordingRunner().runner });
    const result = adapter.remove({
      declaration: declarationFor("0".repeat(64)),
    }) as SuperpowersRemoveResult;
    expect(result.mode).toBe("drift-report-only");
    if (result.mode === "drift-report-only") {
      expect(result.reason).toContain("no binding lock");
    }
  });

  it("round-trips clean: repo-relative restore + home: teardown, no drift", async () => {
    const { resolved, disposition } = scannedFixture("src");
    const bindDeps = {
      runner: recordingRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
    };
    const adapter = createSuperpowersAdapter({
      root,
      runner: bindDeps.runner,
      env: bindDeps.env,
      locateCache: () => resolved.treePath,
    });
    const declaration = declarationFor(resolved.treeDigest);
    await adapter.provision({ context: { declaration }, resolved }, disposition);

    const removalPlanResult = adapter.remove({ declaration }) as SuperpowersRemoveResult;
    expect(removalPlanResult.mode).toBe("apply");
    if (removalPlanResult.mode !== "apply") throw new Error("expected apply mode");
    expect(removalPlanResult.repoRelativeDrift).toEqual([]);
    expect(removalPlanResult.plugin).toBe(SUPERPOWERS_PLUGIN_NAME);
    expect(removalPlanResult.marketplace).toBe(SUPERPOWERS_MARKETPLACE_NAME);

    // Caller applies: repo-relative restore FIRST, then machine-scope teardown.
    // This order is a HARD HOST CONSTRAINT (empirically verified on 2.1.214):
    // `claude plugin uninstall` REFUSES while the plugin is still enabled at
    // project scope, so the enabledPlugins restore must land before removePlugin
    // ever runs `uninstall` — reversing these two calls fails on a real host.
    await applyActions(root, removalPlanResult.repoRelativeActions);
    const { runner: removeRunner, calls } = recordingRunner();
    const removal = await removePlugin(
      {
        ownership: removalPlanResult.homeOwnership,
        plugin: removalPlanResult.plugin,
        marketplace: removalPlanResult.marketplace,
        scope: removalPlanResult.scope,
      },
      {
        runner: removeRunner,
        env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
        locateCache: () => resolved.treePath,
      },
    );
    expect(removal.drift).toEqual([]);
    expect(calls).toContainEqual(["claude", "plugin", "uninstall", KEY, "--scope", "project"]);
    expect(calls).toContainEqual([
      "claude",
      "plugin",
      "marketplace",
      "remove",
      SUPERPOWERS_MARKETPLACE_NAME,
    ]);

    // Caller's final step: drop the lock itself (mirrors the W3 roundtrip precedent).
    rmSync(bindingDir(root), { recursive: true, force: true });

    const settings = JSON.parse(readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf8"));
    expect(settings.enabledPlugins).toBeUndefined();
    expect(settings.env).toBeUndefined();
    expect(existsSync(bindingLockPath(root))).toBe(false);
  });
});

// -- report -----------------------------------------------------------------------

describe("report — Framework Card input lines", () => {
  it("includes framework, pin, D7 identity, owned surfaces, a labeled context-cost estimate, and telemetry status", async () => {
    const { resolved, disposition } = scannedFixture("src");
    const adapter = createSuperpowersAdapter({
      root,
      runner: recordingRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    const declaration = declarationFor(resolved.treeDigest);
    await adapter.provision({ context: { declaration }, resolved }, disposition);

    const report = adapter.report({ declaration });
    expect(report.framework).toBe("superpowers");
    // §D.2 row A: the migrated report yields a parseable, machine-path-free card.
    expect(report.card).toBeDefined();
    assertNoMachineLocalPath(parseFrameworkCard(report.card));
    const text = report.lines.join("\n");
    expect(text).toContain(SUPERPOWERS_REPOSITORY);
    expect(text).toContain(SUPERPOWERS_PIN_COMMIT);
    expect(text).toContain(resolved.treeDigest);
    expect(text).toMatch(/match: true/);
    expect(text.toLowerCase()).toContain("estimate");
    expect(text).toContain("telemetry: disabled");
  });

  it("reports lock-absent state before any provision", () => {
    const adapter = createSuperpowersAdapter({ root, runner: recordingRunner().runner });
    const report = adapter.report({ declaration: declarationFor("0".repeat(64)) });
    expect(report.card).toBeDefined();
    assertNoMachineLocalPath(parseFrameworkCard(report.card));
    expect(report.lines.join("\n")).toContain("absent");
  });
});

// -- inspect ----------------------------------------------------------------------

describe("inspect — cheap static notes over a tree path", () => {
  it("notes the plugin manifest and skill count for a superpowers-shaped tree", async () => {
    const dir = tree("inspect-src", {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "superpowers" }),
      "skills/writing-plans/SKILL.md": "# writing plans\n",
      "skills/systematic-debugging/SKILL.md": "# systematic debugging\n",
    });
    const adapter = createSuperpowersAdapter({ root, runner: recordingRunner().runner });
    const report = await adapter.inspect({ treePath: dir });
    expect(report.framework).toBe("superpowers");
    expect(report.notes.some((n) => n.includes("manifest present"))).toBe(true);
    expect(report.notes.some((n) => n.includes("2 skill"))).toBe(true);
  });

  it("notes absence for an unrelated tree", async () => {
    const dir = tree("inspect-empty", { "README.md": "# nothing here\n" });
    const adapter = createSuperpowersAdapter({ root, runner: recordingRunner().runner });
    const report = await adapter.inspect({ treePath: dir });
    expect(report.notes.some((n) => n.toLowerCase().includes("no plugin manifest"))).toBe(true);
    expect(report.notes.some((n) => n.toLowerCase().includes("no skills"))).toBe(true);
  });
});
