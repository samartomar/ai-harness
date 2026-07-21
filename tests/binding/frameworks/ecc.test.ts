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
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashComponentTree } from "../../../src/baseline-evidence/hash.js";
import { AdapterRegistry, type BindingContext } from "../../../src/binding/adapter.js";
import { BindingFeatureKeyError } from "../../../src/binding/features.js";
import {
  computeEccFullLabel,
  computeEccLeanPreviewDiff,
  createEccAdapter,
  ECC_AGENT_DATA_HOME_DEFAULT,
  ECC_FULL_FEATURE_KEYS,
  ECC_FULL_MARKETPLACE_NAME,
  ECC_FULL_MCP_CONNECTORS,
  ECC_FULL_PLUGIN_NAME,
  ECC_HOMUNCULUS_DIR_DEFAULT,
  ECC_LEAN_ALLOWLIST,
  ECC_PIN_COMMIT,
  ECC_REPOSITORY,
  EccBindingError,
  type EccFullProvisionResult,
  type EccFullRemoveResult,
  EccLeanAllowlistError,
  type EccLeanInstaller,
  EccLeanInstallerUnavailableError,
  type EccLeanRemoveResult,
  EccModeConflictError,
  eccFullStateWriteInventory,
  eccRuntimeSurfaceHit,
} from "../../../src/binding/frameworks/ecc.js";
import { createBindingAdapterRegistry } from "../../../src/binding/frameworks/registry.js";
import { BindingLockSchema, bindingDir, readBindingLock } from "../../../src/binding/lock.js";
import {
  BindingScanError,
  type ResolvedGitSource,
  runFastScanGate,
  type ScanDisposition,
  type ScannableSource,
  W2_DEFAULT_INSPECTORS,
} from "../../../src/binding/scan-gate.js";
import {
  type BindingDeclaration,
  BindingFrameworkConflictError,
} from "../../../src/binding/schema.js";
import { readEccInstallPreview } from "../../../src/ecc/install-preview.js";
import { selectedEccMcpServers } from "../../../src/ecc/mcp.js";
import { defaultRunner, fakeRunner, type Runner } from "../../../src/internals/proc.js";

/**
 * W4b — the ECC Lean FrameworkAdapter (upstream-local-installer). Every
 * disposition here is REAL (minted by `runFastScanGate` with the actual
 * `W2_DEFAULT_INSPECTORS`); every install goes through an INJECTED fixture
 * installer writing into an mkdtemp home — NO test here spawns a real ECC
 * installer or touches the real `~/.claude`/`~/.aih` (HARD RULE). The one real
 * installer path is documented as an `it.skip` acceptance procedure.
 */

let root: string;
let home: string;
let cacheHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-root-"));
  home = mkdtempSync(join(tmpdir(), "aih-ecc-home-"));
  cacheHome = mkdtempSync(join(tmpdir(), "aih-ecc-cache-"));
});

afterEach(() => {
  for (const dir of [root, home, cacheHome]) rmSync(dir, { recursive: true, force: true });
});

// -- fixtures -----------------------------------------------------------------

const ECC_FIXTURE_FILES: Record<string, string> = {
  "scripts/install-apply.js": "// ecc installer\n",
  "rules/ecc/common/patterns.md": "# common rules\n",
  "agents/planner.md": "# planner\n",
};

/** A REAL, non-forged brand-protected disposition minted by the actual W2 gate. */
function scannedFixture(name: string): {
  resolved: ResolvedGitSource;
  disposition: ScanDisposition;
} {
  const dir = join(cacheHome, name);
  for (const [rel, contents] of Object.entries(ECC_FIXTURE_FILES)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
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
    { cacheHome, inspectors: W2_DEFAULT_INSPECTORS },
  );
  return {
    resolved: {
      kind: "git",
      repository: ECC_REPOSITORY,
      commitSha: ECC_PIN_COMMIT,
      treeDigest: hashed.treeSha256,
      treePath: dir,
      files: source.identityFiles,
    },
    disposition,
  };
}

function declarationFor(treeDigest: string, mode?: "lean" | "full"): BindingDeclaration {
  return {
    schemaVersion: 1,
    framework: { id: "ecc", host: "claude", ...(mode ? { mode } : {}) },
    source: {
      kind: "git",
      repository: ECC_REPOSITORY,
      commitSha: ECC_PIN_COMMIT,
      treeDigest,
    },
  };
}

interface Op {
  kind?: "copy-file" | "merge-json" | "managed-block" | "exec";
  destination: string;
  componentId: string;
  source?: string;
}

/** A minimal, pin-bound preview artifact (only what a test needs), schema-validated on use. */
// biome-ignore lint/suspicious/noExplicitAny: crafted fixture cast to the artifact type on use
function previewArtifact(ops: Op[]): any {
  return {
    schemaVersion: 1,
    source: { owner: "samartomar", repo: "ECC", pinnedSha: ECC_PIN_COMMIT },
    operations: ops.map((op) => ({
      target: "claude",
      kind: op.kind ?? "copy-file",
      ...(op.source ? { source: op.source } : {}),
      destination: op.destination,
      componentId: op.componentId,
      contingentOn: "evidence-authorization",
    })),
  };
}

/** One clean op per allowlist component — an exact-match Lean preview. */
const LEAN_ARTIFACT_OPS: Op[] = [
  { destination: "<home>/.claude/rules/ecc/common/patterns.md", componentId: "baseline:rules" },
  { destination: "<home>/.claude/agents/planner.md", componentId: "agent:planner" },
  {
    destination: "<home>/.claude/skills/ecc/tdd-workflow/SKILL.md",
    componentId: "skill:tdd-workflow",
  },
  { destination: "<home>/.claude/agents/tdd-guide.md", componentId: "agent:tdd-guide" },
  {
    destination: "<home>/.claude/agents/build-error-resolver.md",
    componentId: "agent:build-error-resolver",
  },
  { destination: "<home>/.claude/agents/code-reviewer.md", componentId: "agent:code-reviewer" },
  {
    destination: "<home>/.claude/agents/security-reviewer.md",
    componentId: "agent:security-reviewer",
  },
  {
    destination: "<home>/.claude/skills/ecc/security-review/SKILL.md",
    componentId: "skill:security-review",
  },
  {
    destination: "<home>/.claude/skills/ecc/verification-loop/SKILL.md",
    componentId: "skill:verification-loop",
  },
];

/**
 * A fixture installer: writes exactly the vetted selection into the fixture home
 * and returns the captured writes (fakeRunner-backed; no real ECC install). An
 * `extra` hook lets a test simulate a rogue installer that writes a runtime file.
 */
function fixtureInstaller(
  spy?: { calls: number },
  extra?: (home: string) => { rel: string; content: string; componentId: string },
): EccLeanInstaller {
  return async ({ diff, home: h, root: r }) => {
    if (spy) spy.calls += 1;
    const installed = [] as Awaited<ReturnType<EccLeanInstaller>>["installed"];
    const { createHash } = await import("node:crypto");
    const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    for (const op of diff.selectedOps) {
      const abs = op.scope === "home" ? join(h, op.rel) : join(r, op.rel);
      mkdirSync(dirname(abs), { recursive: true });
      const content = `# ${op.componentId} :: ${op.rel}\n`;
      writeFileSync(abs, content, "utf8");
      installed.push({
        scope: op.scope,
        rel: op.rel,
        contentDigest: digest(content),
        componentId: op.componentId,
      });
    }
    if (extra) {
      const e = extra(h);
      const abs = join(h, e.rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, e.content, "utf8");
      installed.push({
        scope: "home",
        rel: e.rel,
        contentDigest: digest(e.content),
        componentId: e.componentId,
      });
    }
    return { installed };
  };
}

function spyRunner(): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner = fakeRunner((argv) => {
    calls.push(argv);
    return undefined;
  });
  return { runner, calls };
}

// -- Full fixtures (W4c) ------------------------------------------------------

/**
 * The `.claude-plugin` manifests every Full `provision()` fixture needs: `bindPlugin`
 * digests the plugin's own SOURCE SUBTREE (see `pluginSourceSubtreeDigest`), resolved
 * via these. `source: "./"` (single-plugin-at-root marketplace) makes the subtree the
 * whole checkout, so its digest equals `resolved.treeDigest` — every digest assertion
 * below stays valid.
 */
const ECC_FULL_MANIFEST_FILES: Record<string, string> = {
  ".claude-plugin/marketplace.json": JSON.stringify({
    name: ECC_FULL_MARKETPLACE_NAME,
    plugins: [{ name: ECC_FULL_PLUGIN_NAME, source: "./" }],
  }),
  ".claude-plugin/plugin.json": JSON.stringify({ name: ECC_FULL_PLUGIN_NAME, version: "1.0.0" }),
};

/** The `<plugin>@<marketplace>` enable/cache key for the Full path. */
const ECC_FULL_KEY = `${ECC_FULL_PLUGIN_NAME}@${ECC_FULL_MARKETPLACE_NAME}`;

/** A REAL brand-protected disposition minted over an ECC plugin fixture (manifests + content). */
function scannedFullFixture(
  name: string,
  extra: Record<string, string> = {},
): { resolved: ResolvedGitSource; disposition: ScanDisposition } {
  const dir = join(cacheHome, name);
  for (const [rel, contents] of Object.entries({
    ...ECC_FIXTURE_FILES,
    ...ECC_FULL_MANIFEST_FILES,
    ...extra,
  })) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
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
    { cacheHome, inspectors: W2_DEFAULT_INSPECTORS },
  );
  return {
    resolved: {
      kind: "git",
      repository: ECC_REPOSITORY,
      commitSha: ECC_PIN_COMMIT,
      treeDigest: hashed.treeSha256,
      treePath: dir,
      files: source.identityFiles,
    },
    disposition,
  };
}

function fullDeclarationFor(
  treeDigest: string,
  features?: Record<string, boolean>,
): BindingDeclaration {
  return {
    schemaVersion: 1,
    framework: { id: "ecc", host: "claude", mode: "full", ...(features ? { features } : {}) },
    source: { kind: "git", repository: ECC_REPOSITORY, commitSha: ECC_PIN_COMMIT, treeDigest },
  };
}

// -- registry -----------------------------------------------------------------

describe("createEccAdapter — registers in AdapterRegistry (D6 upstream-local-installer)", () => {
  it("registers as framework 'ecc' with adapterType 'upstream-local-installer'", () => {
    const registry = new AdapterRegistry();
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    registry.register(adapter);
    expect(registry.has("ecc")).toBe(true);
    expect(registry.get("ecc")?.adapterType).toBe("upstream-local-installer");
  });

  it("createBindingAdapterRegistry wires both superpowers and ecc", () => {
    const registry = createBindingAdapterRegistry({ root, runner: spyRunner().runner });
    expect(registry.get("ecc")?.adapterType).toBe("upstream-local-installer");
    expect(registry.get("superpowers")?.adapterType).toBe("host-plugin");
    expect(registry.frameworks().sort()).toEqual(["ecc", "superpowers"]);
  });
});

// -- mode routing -------------------------------------------------------------

describe("mode routing — absent/lean -> Lean; full -> Full (W4c: full is implemented)", () => {
  it("plans lean when mode is absent", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    expect(() => adapter.plan({ declaration: declarationFor("d".repeat(64)) })).not.toThrow();
  });

  it("plans lean when mode is explicitly 'lean'", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    expect(() =>
      adapter.plan({ declaration: declarationFor("d".repeat(64), "lean") }),
    ).not.toThrow();
  });

  it("plans full when mode is 'full' (routing works — no more not-implemented)", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const plan = adapter.plan({ declaration: declarationFor("d".repeat(64), "full") });
    expect(plan.framework).toBe("ecc");
    // Full still produces a preview (enabledPlugins + the two env-root fields), unlike
    // the W4b stub which threw EccModeNotImplementedError here.
    expect(plan.writes.length).toBeGreaterThan(0);
  });

  it("routes full mode through resolve (rejects a non-git source, not the mode)", async () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const declaration: BindingDeclaration = {
      schemaVersion: 1,
      framework: { id: "ecc", host: "claude", mode: "full" },
      source: {
        kind: "npm",
        package: "ecc-universal",
        exactVersion: "1.0.0",
        integrity: `sha512-${"A".repeat(86)}==`,
      },
    };
    // Full is accepted by resolve (it reaches the git-source assertion) — the failure
    // is EccBindingError (non-git source), not a mode error.
    await expect(adapter.resolve({ declaration })).rejects.toBeInstanceOf(EccBindingError);
  });
});

// -- plan: D8 + feature-key + framework routing -------------------------------

describe("plan — D8 conflict + feature-key rejection (pure preview, no I/O)", () => {
  it("rejects planning when a different framework is already bound (D8)", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const context: BindingContext = {
      declaration: declarationFor("d".repeat(64)),
      existingFramework: "superpowers",
    };
    expect(() => adapter.plan(context)).toThrow(BindingFrameworkConflictError);
  });

  it("rejects any declared feature key — ecc lean accepts none", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const declaration = declarationFor("d".repeat(64));
    const withFeature: BindingDeclaration = {
      ...declaration,
      framework: { ...declaration.framework, features: { anything: true } },
    };
    expect(() => adapter.plan({ declaration: withFeature })).toThrow(BindingFeatureKeyError);
  });

  it("rejects a declaration routed to the wrong framework", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const spDeclaration: BindingDeclaration = {
      schemaVersion: 1,
      framework: { id: "superpowers", host: "claude" },
      source: {
        kind: "git",
        repository: "obra/superpowers",
        commitSha: "c".repeat(40),
        treeDigest: "d".repeat(64),
      },
    };
    expect(() => adapter.plan({ declaration: spDeclaration })).toThrow(EccBindingError);
  });

  it("produces an ownership preview covering the allowlist, with no repo-relative writes and no disk I/O", () => {
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      installPreview: previewArtifact(LEAN_ARTIFACT_OPS),
    });
    const plan = adapter.plan({ declaration: declarationFor("d".repeat(64)) });
    expect(plan.framework).toBe("ecc");
    expect(plan.writes).toEqual([]);
    const owned = plan.ownership.map((entry) => entry.target);
    // one bounded ownership intent per allowlisted component, all machine-scope
    expect(plan.ownership).toHaveLength(ECC_LEAN_ALLOWLIST.length);
    expect(owned.every((target) => target.startsWith("home:"))).toBe(true);
    expect(owned.some((target) => target.includes("planner"))).toBe(true);
    for (const entry of plan.ownership) {
      expect(entry.postApplyDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    // pure preview: nothing written to disk
    expect(existsSync(bindingDir(root))).toBe(false);
  });
});

// -- preview-diff ALLOWLIST GATE ----------------------------------------------

describe("preview-diff allowlist gate — the pinned artifact + fail-closed cases", () => {
  it("the real pinned preview delivers the entire allowlist with no runtime escapes", () => {
    const diff = computeEccLeanPreviewDiff(readEccInstallPreview(), ECC_LEAN_ALLOWLIST);
    expect(diff.missing).toEqual([]);
    expect(diff.runtimeEscapes).toEqual([]);
    expect(diff.ok).toBe(true);
    for (const id of ECC_LEAN_ALLOWLIST) expect(diff.deliverable).toContain(id);
  });

  it("flags an extra runtime surface an allowlisted component would drag in", () => {
    const artifact = previewArtifact([
      ...LEAN_ARTIFACT_OPS,
      { destination: "<home>/.claude/hooks/rogue.json", componentId: "agent:code-reviewer" },
    ]);
    const diff = computeEccLeanPreviewDiff(artifact, ECC_LEAN_ALLOWLIST);
    expect(diff.ok).toBe(false);
    expect(diff.runtimeEscapes.join(" ")).toContain("hooks-runtime");
  });

  it("flags an allowlisted component the preview cannot deliver", () => {
    const artifact = previewArtifact(
      LEAN_ARTIFACT_OPS.filter((op) => op.componentId !== "skill:verification-loop"),
    );
    const diff = computeEccLeanPreviewDiff(artifact, ECC_LEAN_ALLOWLIST);
    expect(diff.ok).toBe(false);
    expect(diff.missing).toEqual(["skill:verification-loop"]);
  });

  it("provision fails closed on the extra-surface preview with ZERO install calls and no lock", async () => {
    const { resolved, disposition } = scannedFixture("extra");
    const spy = { calls: 0 };
    const artifact = previewArtifact([
      ...LEAN_ARTIFACT_OPS,
      { destination: "<home>/.claude/hooks/rogue.json", componentId: "agent:code-reviewer" },
    ]);
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: artifact,
      installer: fixtureInstaller(spy),
    });
    const declaration = declarationFor(resolved.treeDigest);
    await expect(
      adapter.provision({ context: { declaration }, resolved }, disposition),
    ).rejects.toBeInstanceOf(EccLeanAllowlistError);
    expect(spy.calls).toBe(0);
    expect(readBindingLock(root).present).toBe(false);
  });

  it("provision fails closed when the preview cannot deliver an allowlisted component (no install, no lock)", async () => {
    const { resolved, disposition } = scannedFixture("missing");
    const spy = { calls: 0 };
    const artifact = previewArtifact(
      LEAN_ARTIFACT_OPS.filter((op) => op.componentId !== "skill:tdd-workflow"),
    );
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: artifact,
      installer: fixtureInstaller(spy),
    });
    const declaration = declarationFor(resolved.treeDigest);
    await expect(
      adapter.provision({ context: { declaration }, resolved }, disposition),
    ).rejects.toBeInstanceOf(EccLeanAllowlistError);
    expect(spy.calls).toBe(0);
    expect(readBindingLock(root).present).toBe(false);
  });

  it("the default installer fails closed (real ECC install is acceptance-phase only)", async () => {
    const { resolved, disposition } = scannedFixture("noinstaller");
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: previewArtifact(LEAN_ARTIFACT_OPS),
    });
    const declaration = declarationFor(resolved.treeDigest);
    await expect(
      adapter.provision({ context: { declaration }, resolved }, disposition),
    ).rejects.toBeInstanceOf(EccLeanInstallerUnavailableError);
    expect(readBindingLock(root).present).toBe(false);
  });
});

// -- settings-file surface (hardening) ----------------------------------------

describe("settings-file runtime surface — hook entries / enabledPlugins / env / skillOverrides", () => {
  it("eccRuntimeSurfaceHit flags .claude/settings(.local).json in BOTH scopes", () => {
    for (const scope of ["home", "project"] as const) {
      expect(eccRuntimeSurfaceHit(scope, ".claude/settings.json")).toMatch(/settings file/i);
      expect(eccRuntimeSurfaceHit(scope, ".claude/settings.local.json")).toMatch(/settings file/i);
      // nested under a .claude/ dir at any depth
      expect(eccRuntimeSurfaceHit(scope, "sub/.claude/settings.local.json")).toMatch(
        /settings file/i,
      );
    }
    // a settings.json NOT under .claude/, and ordinary Lean content, are not flagged
    expect(eccRuntimeSurfaceHit("home", "settings.json")).toBeUndefined();
    expect(eccRuntimeSurfaceHit("home", ".claude/agents/planner.md")).toBeUndefined();
  });

  it("computeEccLeanPreviewDiff flags a preview op that writes home .claude/settings.json", () => {
    const artifact = previewArtifact([
      ...LEAN_ARTIFACT_OPS,
      {
        kind: "merge-json",
        destination: "<home>/.claude/settings.json",
        componentId: "agent:code-reviewer",
      },
    ]);
    const diff = computeEccLeanPreviewDiff(artifact, ECC_LEAN_ALLOWLIST);
    expect(diff.ok).toBe(false);
    expect(diff.runtimeEscapes.join(" ").toLowerCase()).toContain("settings file");
  });

  it("provision fails closed (no lock) when the installer writes a project-scope settings file", async () => {
    const { resolved, disposition } = scannedFixture("rogue-settings");
    const rogue: EccLeanInstaller = async ({ diff, home: h, root: r }) => {
      const { createHash } = await import("node:crypto");
      const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
      const installed = [] as Awaited<ReturnType<EccLeanInstaller>>["installed"];
      for (const op of diff.selectedOps) {
        const abs = op.scope === "home" ? join(h, op.rel) : join(r, op.rel);
        mkdirSync(dirname(abs), { recursive: true });
        const content = `# ${op.componentId}\n`;
        writeFileSync(abs, content, "utf8");
        installed.push({
          scope: op.scope,
          rel: op.rel,
          contentDigest: digest(content),
          componentId: op.componentId,
        });
      }
      const abs = join(r, ".claude", "settings.local.json");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, "{}\n", "utf8");
      installed.push({
        scope: "project",
        rel: ".claude/settings.local.json",
        contentDigest: digest("{}\n"),
        componentId: "agent:code-reviewer",
      });
      return { installed };
    };
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: previewArtifact(LEAN_ARTIFACT_OPS),
      installer: rogue,
    });
    const declaration = declarationFor(resolved.treeDigest);
    await expect(
      adapter.provision({ context: { declaration }, resolved }, disposition),
    ).rejects.toBeInstanceOf(EccLeanAllowlistError);
    expect(readBindingLock(root).present).toBe(false);
  });
});

// -- provision: happy path ----------------------------------------------------

describe("provision — happy path on fixtures", () => {
  it("installs the vetted allowlist, writes a schema-valid lock, records ownership, attests runtime-surface absence", async () => {
    const { resolved, disposition } = scannedFixture("happy");
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: previewArtifact(LEAN_ARTIFACT_OPS),
      installer: fixtureInstaller(),
    });
    const declaration = declarationFor(resolved.treeDigest);

    const result = await adapter.provision({ context: { declaration }, resolved }, disposition);

    expect(BindingLockSchema.safeParse(result.lock).success).toBe(true);
    expect(result.lock.match).toBe(true);
    expect(result.lock.scannedDigest).toBe(result.lock.loadedDigest);
    expect(result.lock.writes).toEqual([]);

    // one bounded ownership entry per allowlisted component, all home-scoped
    expect(result.lock.ownership).toHaveLength(ECC_LEAN_ALLOWLIST.length);
    for (const entry of result.lock.ownership) {
      expect(entry.target.startsWith("home:")).toBe(true);
      expect(entry.postApplyDigest).toMatch(/^[0-9a-f]{64}$/);
    }

    // the vetted files landed in the fixture home
    expect(existsSync(join(home, ".claude", "agents", "planner.md"))).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "ecc", "tdd-workflow", "SKILL.md"))).toBe(
      true,
    );

    // runtime-surface ABSENCE: no hooks, no MCP servers, no learned skills
    expect(existsSync(join(home, ".claude", "hooks"))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", "learned"))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", "ecc", "continuous-learning"))).toBe(false);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);

    expect(readBindingLock(root).present).toBe(true);
  });

  it("fails closed (no lock) when the installer writes a forbidden runtime surface", async () => {
    const { resolved, disposition } = scannedFixture("rogue");
    const rogue = fixtureInstaller(undefined, () => ({
      rel: ".claude/hooks/hooks.json",
      content: "{}\n",
      componentId: "agent:code-reviewer",
    }));
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: previewArtifact(LEAN_ARTIFACT_OPS),
      installer: rogue,
    });
    const declaration = declarationFor(resolved.treeDigest);
    await expect(
      adapter.provision({ context: { declaration }, resolved }, disposition),
    ).rejects.toBeInstanceOf(EccLeanAllowlistError);
    expect(readBindingLock(root).present).toBe(false);
  });
});

// -- provision: D12 disposition authorization ---------------------------------

describe("provision — forged/mismatched disposition rejected before any install (D12)", () => {
  it("rejects a forged (unbranded) disposition and runs no installer", async () => {
    const { resolved } = scannedFixture("forged");
    const spy = { calls: 0 };
    const forged = {
      digest: resolved.treeDigest,
      verdict: "allow",
      findings: [],
      posture: "enterprise",
      producedAt: new Date().toISOString(),
    } as unknown as ScanDisposition;
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: previewArtifact(LEAN_ARTIFACT_OPS),
      installer: fixtureInstaller(spy),
    });
    const declaration = declarationFor(resolved.treeDigest);
    await expect(
      adapter.provision({ context: { declaration }, resolved }, forged),
    ).rejects.toBeInstanceOf(BindingScanError);
    expect(spy.calls).toBe(0);
    expect(readBindingLock(root).present).toBe(false);
  });

  it("rejects a disposition whose digest does not match the resolved source", async () => {
    const { resolved, disposition } = scannedFixture("mismatch");
    const spy = { calls: 0 };
    const mismatched: ResolvedGitSource = { ...resolved, treeDigest: "f".repeat(64) };
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: previewArtifact(LEAN_ARTIFACT_OPS),
      installer: fixtureInstaller(spy),
    });
    const declaration = declarationFor(mismatched.treeDigest);
    await expect(
      adapter.provision({ context: { declaration }, resolved: mismatched }, disposition),
    ).rejects.toBeInstanceOf(BindingScanError);
    expect(spy.calls).toBe(0);
  });

  it("re-rejects a second framework (D8 layer 3) even with a valid allow disposition", async () => {
    const { resolved, disposition } = scannedFixture("d8");
    const spy = { calls: 0 };
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: previewArtifact(LEAN_ARTIFACT_OPS),
      installer: fixtureInstaller(spy),
    });
    const declaration = declarationFor(resolved.treeDigest);
    await expect(
      adapter.provision(
        { context: { declaration, existingFramework: "superpowers" }, resolved },
        disposition,
      ),
    ).rejects.toBeInstanceOf(BindingFrameworkConflictError);
    expect(spy.calls).toBe(0);
  });
});

// -- verify -------------------------------------------------------------------

describe("verify — clean after bind, drift on edit / runtime-surface appearance / absent lock", () => {
  function boundAdapter(name: string) {
    const { resolved, disposition } = scannedFixture(name);
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: previewArtifact(LEAN_ARTIFACT_OPS),
      installer: fixtureInstaller(),
    });
    const declaration = declarationFor(resolved.treeDigest);
    return { adapter, declaration, resolved, disposition };
  }

  it("reports absent-lock drift on a fresh root", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const result = adapter.verify({ declaration: declarationFor("0".repeat(64)) });
    expect(result).toEqual({ ok: false, drift: ["no binding lock"] });
  });

  it("reports ok:true with no drift right after a clean bind", async () => {
    const { adapter, declaration, resolved, disposition } = boundAdapter("verify-clean");
    await adapter.provision({ context: { declaration }, resolved }, disposition);
    const result = adapter.verify({ declaration });
    expect(result.drift).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports content drift when an installed file is edited after bind", async () => {
    const { adapter, declaration, resolved, disposition } = boundAdapter("verify-edit");
    await adapter.provision({ context: { declaration }, resolved }, disposition);
    writeFileSync(join(home, ".claude", "agents", "planner.md"), "# tampered\n", "utf8");
    const result = adapter.verify({ declaration });
    expect(result.ok).toBe(false);
    expect(result.drift.some((line) => line.toLowerCase().includes("drift"))).toBe(true);
  });

  it("reports drift when a runtime surface appears after a Lean bind", async () => {
    const { adapter, declaration, resolved, disposition } = boundAdapter("verify-runtime");
    await adapter.provision({ context: { declaration }, resolved }, disposition);
    mkdirSync(join(home, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(home, ".claude", "hooks", "hooks.json"), "{}\n", "utf8");
    const result = adapter.verify({ declaration });
    expect(result.ok).toBe(false);
    expect(result.drift.some((line) => line.includes("runtime surface"))).toBe(true);
  });
});

// -- remove -------------------------------------------------------------------

describe("remove — plan/apply separation and missing-lock mode", () => {
  it("returns drift-report-only with a reason when no lock is present", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const result = adapter.remove({
      declaration: declarationFor("0".repeat(64)),
    }) as EccLeanRemoveResult;
    expect(result.mode).toBe("drift-report-only");
    if (result.mode === "drift-report-only") {
      expect(result.reason).toContain("no binding lock");
    }
  });

  it("partitions home-scoped install roots into the apply plan after a bind", async () => {
    const { resolved, disposition } = scannedFixture("remove");
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: previewArtifact(LEAN_ARTIFACT_OPS),
      installer: fixtureInstaller(),
    });
    const declaration = declarationFor(resolved.treeDigest);
    await adapter.provision({ context: { declaration }, resolved }, disposition);

    const result = adapter.remove({ declaration }) as EccLeanRemoveResult;
    expect(result.mode).toBe("apply");
    if (result.mode !== "apply") throw new Error("expected apply mode");
    // every ECC install root is machine-scope, so nothing repo-relative to restore
    expect(result.repoRelativeDrift).toEqual([]);
    expect(result.homeOwnership).toHaveLength(ECC_LEAN_ALLOWLIST.length);
    expect(result.homeOwnership.every((entry) => entry.target.startsWith("home:"))).toBe(true);
  });
});

// -- report -------------------------------------------------------------------

describe("report — Framework Card input lines", () => {
  it("includes framework, mode, pin, allowlist, exclusions, absence attestation, and a labeled estimate", async () => {
    const { resolved, disposition } = scannedFixture("report");
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: previewArtifact(LEAN_ARTIFACT_OPS),
      installer: fixtureInstaller(),
    });
    const declaration = declarationFor(resolved.treeDigest);
    await adapter.provision({ context: { declaration }, resolved }, disposition);

    const report = adapter.report({ declaration });
    expect(report.framework).toBe("ecc");
    const text = report.lines.join("\n");
    expect(text).toContain("mode: lean");
    expect(text).toContain(ECC_REPOSITORY);
    expect(text).toContain(ECC_PIN_COMMIT);
    // allowlist components present
    expect(text).toContain("skill:verification-loop");
    expect(text).toContain("agent:planner");
    // exclusions named
    expect(text).toContain("continuous-learning-v2");
    expect(text).toContain("MCP servers");
    // runtime-surface absence attestation + labeled estimate
    expect(text.toLowerCase()).toContain("runtime-surface absence: attested");
    expect(text.toLowerCase()).toContain("estimate");
  });

  it("reports lock-absent state (with allowlist + exclusions) before any provision", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const report = adapter.report({ declaration: declarationFor("0".repeat(64)) });
    const text = report.lines.join("\n");
    expect(text).toContain("binding lock: absent");
    expect(text).toContain("baseline:rules");
    expect(text).toContain("hooks-runtime");
  });

  it("discloses raw vet outcome AND the signed acceptance side by side, never claiming a vet pass (W4 ruling (e))", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const report = adapter.report({ declaration: declarationFor("0".repeat(64)) });
    const text = report.lines.join("\n");
    expect(text).toContain("raw vet outcome:");
    expect(text).toContain("BLOCKED");
    expect(text).toContain("verdicts preserved in vendor-lock.json; not reclassified");
    expect(text).toContain("policy decision: accepted-with-conditions — ecc-lean-v1-20260720");
    expect(text).toContain("accepted finding codes:");
    expect(text).toContain("trust.hidden-unicode");
    expect(text).toContain("residual risk:");
    expect(text).toContain("effective install decision: allowed for ecc-lean-v1");
    expect(text).not.toMatch(/vet passed|no danger findings|fast scan passed/i);
  });
});

// -- inspect ------------------------------------------------------------------

describe("inspect — cheap static notes over a tree path", () => {
  it("notes the ECC installer and rules/agents/skills for an ECC-shaped tree", async () => {
    const dir = join(cacheHome, "inspect-ecc");
    for (const [rel, contents] of Object.entries({
      "scripts/install-apply.js": "// installer\n",
      "rules/a.md": "# rule\n",
      "agents/planner.md": "# planner\n",
    })) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const report = await adapter.inspect({ treePath: dir });
    expect(report.framework).toBe("ecc");
    expect(report.notes.some((n) => n.includes("installer present"))).toBe(true);
    expect(report.notes.some((n) => n.includes("rules/"))).toBe(true);
  });

  it("notes absence for an unrelated tree", async () => {
    const dir = join(cacheHome, "inspect-empty");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# nothing\n", "utf8");
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const report = await adapter.inspect({ treePath: dir });
    expect(report.notes.some((n) => n.toLowerCase().includes("no ecc installer"))).toBe(true);
  });
});

// -- resolve ------------------------------------------------------------------

describe("resolve — delegates to resolveGitSource with the declaration's source", () => {
  function initGitRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const g = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    g(["init", "-b", "main"]);
    g(["config", "user.email", "test@example.com"]);
    g(["config", "user.name", "Binding Test"]);
    g(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "rules.md"), "# rule\n");
    g(["add", "-A"]);
    g(["commit", "-m", "init"]);
  }

  it("resolves the exact declared commitSha without a ref round-trip", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "aih-ecc-repo-"));
    try {
      initGitRepo(repoDir);
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
      const adapter = createEccAdapter({ root, runner: defaultRunner, cacheHome });
      const declaration: BindingDeclaration = {
        schemaVersion: 1,
        framework: { id: "ecc", mode: "lean", host: "claude" },
        source: { kind: "git", repository: repoDir, commitSha: head, treeDigest: "d".repeat(64) },
      };
      const resolved = await adapter.resolve({ declaration });
      expect(resolved.kind).toBe("git");
      if (resolved.kind === "git") {
        expect(resolved.commitSha).toBe(head);
        expect(resolved.treeDigest).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("rejects a non-git declared source", async () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const declaration: BindingDeclaration = {
      schemaVersion: 1,
      framework: { id: "ecc", host: "claude" },
      source: {
        kind: "npm",
        package: "ecc-universal",
        exactVersion: "1.0.0",
        integrity: `sha512-${"A".repeat(86)}==`,
      },
    };
    await expect(adapter.resolve({ declaration })).rejects.toBeInstanceOf(EccBindingError);
  });
});

// == ECC Full (W4c) ===========================================================

// -- Full: mutual exclusivity with Lean ---------------------------------------

describe("Full — mutual exclusivity with Lean (D10 point 5, BOTH directions)", () => {
  async function bindLean(name: string): Promise<void> {
    const { resolved, disposition } = scannedFixture(name);
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: previewArtifact(LEAN_ARTIFACT_OPS),
      installer: fixtureInstaller(),
    });
    await adapter.provision(
      { context: { declaration: declarationFor(resolved.treeDigest) }, resolved },
      disposition,
    );
  }

  async function bindFull(name: string): Promise<void> {
    const { resolved, disposition } = scannedFullFixture(name);
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    await adapter.provision(
      { context: { declaration: fullDeclarationFor(resolved.treeDigest) }, resolved },
      disposition,
    );
  }

  it("full plan fails closed over a lean lock", async () => {
    await bindLean("mx1-lean");
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
    });
    expect(() => adapter.plan({ declaration: fullDeclarationFor("d".repeat(64)) })).toThrow(
      EccModeConflictError,
    );
  });

  it("full provision fails closed over a lean lock (no CLI, lock stays lean)", async () => {
    await bindLean("mx2-lean");
    const { resolved, disposition } = scannedFullFixture("mx2-full");
    const { runner, calls } = spyRunner();
    const adapter = createEccAdapter({
      root,
      runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    await expect(
      adapter.provision(
        { context: { declaration: fullDeclarationFor(resolved.treeDigest) }, resolved },
        disposition,
      ),
    ).rejects.toBeInstanceOf(EccModeConflictError);
    expect(calls).toHaveLength(0);
    const read = readBindingLock(root);
    expect(read.present).toBe(true);
    if (read.present) expect(read.lock.declaration.framework.mode).toBeUndefined();
  });

  it("lean plan fails closed over a full lock", async () => {
    await bindFull("mx3-full");
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
    });
    expect(() => adapter.plan({ declaration: declarationFor("d".repeat(64)) })).toThrow(
      EccModeConflictError,
    );
  });

  it("lean provision fails closed over a full lock (no installer, lock stays full)", async () => {
    await bindFull("mx4-full");
    const { resolved, disposition } = scannedFixture("mx4-lean");
    const spy = { calls: 0 };
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      installPreview: previewArtifact(LEAN_ARTIFACT_OPS),
      installer: fixtureInstaller(spy),
    });
    await expect(
      adapter.provision(
        { context: { declaration: declarationFor(resolved.treeDigest) }, resolved },
        disposition,
      ),
    ).rejects.toBeInstanceOf(EccModeConflictError);
    expect(spy.calls).toBe(0);
    const read = readBindingLock(root);
    expect(read.present).toBe(true);
    if (read.present) expect(read.lock.declaration.framework.mode).toBe("full");
  });

  it("allows a matching-mode re-bind (full plan over a full lock)", async () => {
    await bindFull("mx5-full");
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
    });
    expect(() => adapter.plan({ declaration: fullDeclarationFor("d".repeat(64)) })).not.toThrow();
  });
});

// -- Full: feature-key gate ---------------------------------------------------

describe("Full — feature-key gate (mcp:<connector> allowlist, D10 point 3)", () => {
  it("accepts a known mcp:<connector> feature key", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    expect(() =>
      adapter.plan({ declaration: fullDeclarationFor("d".repeat(64), { "mcp:github": true }) }),
    ).not.toThrow();
  });

  it("rejects an unknown non-mcp feature key for full", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    expect(() =>
      adapter.plan({ declaration: fullDeclarationFor("d".repeat(64), { anything: true }) }),
    ).toThrow(BindingFeatureKeyError);
  });

  it("rejects an unknown mcp connector for full", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    expect(() =>
      adapter.plan({ declaration: fullDeclarationFor("d".repeat(64), { "mcp:not-real": true }) }),
    ).toThrow(BindingFeatureKeyError);
  });

  it("every allowlisted connector resolves to a validated MCP config (the mirror stays valid)", () => {
    for (const id of ECC_FULL_MCP_CONNECTORS) {
      const servers = selectedEccMcpServers([`mcp:${id}`]);
      expect(Object.keys(servers)).toEqual([id]);
    }
  });

  it("ECC_FULL_FEATURE_KEYS is exactly mcp:<connector> per allowlisted connector", () => {
    expect(ECC_FULL_FEATURE_KEYS).toEqual(ECC_FULL_MCP_CONNECTORS.map((id) => `mcp:${id}`));
  });
});

// -- Full: plan preview -------------------------------------------------------

describe("Full — plan preview (connector count + env-root fields, D10 point 6)", () => {
  it("previews enabledPlugins + env roots + one mcp entry per selected connector, no disk I/O", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const plan = adapter.plan({
      declaration: fullDeclarationFor("d".repeat(64), { "mcp:github": true, "mcp:context7": true }),
    });
    expect(plan.framework).toBe("ecc");
    // one mcp-server write per selected connector — the connector COUNT the CLI renders.
    expect(plan.writes.filter((w) => w.mechanism === "mcp-server")).toHaveLength(2);
    const targets = plan.ownership.map((entry) => entry.target);
    expect(targets.some((t) => t.includes("/enabledPlugins"))).toBe(true);
    expect(targets.some((t) => t.includes("/env"))).toBe(true);
    expect(targets.some((t) => t.includes("mcpServers"))).toBe(true);
    expect(targets).toContain(
      `home:.claude/settings.json#/extraKnownMarketplaces/${ECC_FULL_MARKETPLACE_NAME}`,
    );
    for (const entry of plan.ownership) expect(entry.postApplyDigest).toMatch(/^[0-9a-f]{64}$/);
    // pure preview: nothing on disk.
    expect(existsSync(bindingDir(root))).toBe(false);
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });
});

// -- Full: provision happy path -----------------------------------------------

describe("Full — provision happy path (bindPlugin-driven)", () => {
  it("owns env roots + selected connectors, writes a schema-valid lock with D7 subtree identity", async () => {
    const { resolved, disposition } = scannedFullFixture("full-happy");
    const { runner, calls } = spyRunner();
    const adapter = createEccAdapter({
      root,
      runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    const declaration = fullDeclarationFor(resolved.treeDigest, {
      "mcp:github": true,
      "mcp:sequential-thinking": true,
    });

    const result = (await adapter.provision(
      { context: { declaration }, resolved },
      disposition,
    )) as EccFullProvisionResult;

    // marketplace add -> install, in order; no teardown on the happy path.
    expect(calls[0]).toEqual(["claude", "plugin", "marketplace", "add", resolved.treePath]);
    expect(calls[1]).toEqual(["claude", "plugin", "install", ECC_FULL_KEY, "--scope", "project"]);
    expect(calls.some((c) => c.includes("uninstall") || c.includes("disable"))).toBe(false);

    // schema-valid lock + D7 subtree identity fields (scanned == loaded == treeDigest).
    expect(BindingLockSchema.safeParse(result.lock).success).toBe(true);
    expect(result.lock.match).toBe(true);
    expect(result.lock.scannedDigest).toBe(resolved.treeDigest);
    expect(result.lock.loadedDigest).toBe(resolved.treeDigest);

    // D18 env-root fields owned with PROJECT-LOCAL values.
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    expect(settings.enabledPlugins).toEqual({ [ECC_FULL_KEY]: true });
    expect(settings.env.ECC_AGENT_DATA_HOME).toBe(ECC_AGENT_DATA_HOME_DEFAULT);
    expect(settings.env.CLV2_HOMUNCULUS_DIR).toBe(ECC_HOMUNCULUS_DIR_DEFAULT);

    // selected connectors owned in .mcp.json.
    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["github", "sequential-thinking"]);

    const targets = result.lock.ownership.map((entry) => entry.target);
    expect(targets).toContain(
      `home:.claude/settings.json#/extraKnownMarketplaces/${ECC_FULL_MARKETPLACE_NAME}`,
    );
    expect(targets).toContain(
      `home:.claude/plugins/cache/${ECC_FULL_MARKETPLACE_NAME}/${ECC_FULL_PLUGIN_NAME}`,
    );
    expect(targets.some((t) => t.includes("/enabledPlugins"))).toBe(true);
    expect(targets.some((t) => t.includes("/env"))).toBe(true);
    expect(targets.some((t) => t.includes("mcpServers"))).toBe(true);
    for (const entry of result.lock.ownership) {
      expect(entry.postApplyDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    // one mcp-server write per selected connector.
    expect(result.lock.writes.filter((w) => w.mechanism === "mcp-server")).toHaveLength(2);

    // clean fixture -> strict label, no shared writes.
    expect(result.labelInput).toEqual({ strict: true, sharedWrites: [] });
    expect(readBindingLock(root).present).toBe(true);
  });

  it("no connectors selected -> zero .mcp.json writes (env roots still owned)", async () => {
    const { resolved, disposition } = scannedFullFixture("full-nomcp");
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    const declaration = fullDeclarationFor(resolved.treeDigest);

    const result = (await adapter.provision(
      { context: { declaration }, resolved },
      disposition,
    )) as EccFullProvisionResult;

    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    const targets = result.lock.ownership.map((entry) => entry.target);
    expect(targets.some((t) => t.includes("mcpServers"))).toBe(false);
    expect(targets.some((t) => t.includes("/env"))).toBe(true);
    expect(result.lock.writes.filter((w) => w.mechanism === "mcp-server")).toHaveLength(0);
    expect(result.labelInput.strict).toBe(true);
  });
});

// -- Full: forged/mismatched disposition --------------------------------------

describe("Full — forged/mismatched disposition rejected before any CLI (D12)", () => {
  it("rejects a forged (unbranded) disposition and runs no CLI", async () => {
    const { resolved } = scannedFullFixture("full-forged");
    const { runner, calls } = spyRunner();
    const forged = {
      digest: resolved.treeDigest,
      verdict: "allow",
      findings: [],
      posture: "enterprise",
      producedAt: new Date().toISOString(),
    } as unknown as ScanDisposition;
    const adapter = createEccAdapter({
      root,
      runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    const declaration = fullDeclarationFor(resolved.treeDigest, { "mcp:github": true });
    await expect(
      adapter.provision({ context: { declaration }, resolved }, forged),
    ).rejects.toBeInstanceOf(BindingScanError);
    expect(calls).toHaveLength(0);
    expect(readBindingLock(root).present).toBe(false);
  });

  it("rejects a disposition whose digest does not match the resolved source", async () => {
    const { resolved, disposition } = scannedFullFixture("full-mismatch");
    const { runner, calls } = spyRunner();
    const mismatched: ResolvedGitSource = { ...resolved, treeDigest: "f".repeat(64) };
    const adapter = createEccAdapter({
      root,
      runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    const declaration = fullDeclarationFor(mismatched.treeDigest);
    await expect(
      adapter.provision({ context: { declaration }, resolved: mismatched }, disposition),
    ).rejects.toBeInstanceOf(BindingScanError);
    expect(calls).toHaveLength(0);
  });
});

// -- Full: state-write inventory + label decision -----------------------------

describe("Full — state-write inventory + label decision (D10 point 4)", () => {
  function inventoryTree(name: string, files: Record<string, string>): string {
    const dir = join(cacheHome, name);
    for (const [rel, contents] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    return dir;
  }

  it("flags a continuous-learning skill + a learned-skills write; strict:false, shared writes enumerated", () => {
    const dir = inventoryTree("inv-dirty", {
      "skills/continuous-learning/SKILL.md": "# continuous learning\n",
      "scripts/learn.sh":
        '#!/usr/bin/env bash\nmkdir -p "$HOME/.claude/skills/learned"\necho note >> "$HOME/.claude/skills/learned/log.md"\n',
      "rules/a.md": "# rule\n",
    });
    const findings = eccFullStateWriteInventory(dir);
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("continuous-learning-skill");
    expect(kinds).toContain("learned-skills-write");

    const label = computeEccFullLabel(findings);
    expect(label.strict).toBe(false);
    expect(label.sharedWrites.length).toBeGreaterThan(0);
    // the enumerated shared writes are exactly the found surfaces.
    expect(label.sharedWrites).toEqual([...new Set(findings.map((f) => f.surface))].sort());
  });

  it("flags hook definitions carried by the plugin manifest", () => {
    const dir = inventoryTree("inv-hooks", {
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "ecc",
        version: "1.0.0",
        hooks: { PostToolUse: "hooks/post.js" },
      }),
    });
    const findings = eccFullStateWriteInventory(dir);
    expect(findings.some((f) => f.kind === "hook-definition")).toBe(true);
  });

  it("clean tree -> strict:true, no shared writes", () => {
    const dir = inventoryTree("inv-clean", {
      "rules/a.md": "# rule\n",
      "agents/planner.md": "# planner\n",
      "skills/tdd/SKILL.md": "# tdd\n",
      ".claude-plugin/plugin.json": JSON.stringify({ name: "ecc", version: "1.0.0" }),
    });
    expect(eccFullStateWriteInventory(dir)).toEqual([]);
    expect(computeEccFullLabel(eccFullStateWriteInventory(dir))).toEqual({
      strict: true,
      sharedWrites: [],
    });
  });

  it("excludedSurfaces covering all findings -> strict:true, exclusions removed", () => {
    const dir = inventoryTree("inv-excluded", {
      "skills/continuous-learning-v2/SKILL.md": "# cl v2\n",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell ${HOME} in fixture script content, not a JS template
      "scripts/learn.sh": 'echo x >> "${HOME}/.claude/skills/learned/log"\n',
    });
    const findings = eccFullStateWriteInventory(dir);
    expect(findings.length).toBeGreaterThan(0);
    const excluded = findings.map((f) => f.surface);
    const label = computeEccFullLabel(findings, excluded);
    expect(label.strict).toBe(true);
    expect(label.sharedWrites).toEqual([]);
  });
});

// -- Full: verify parity ------------------------------------------------------

describe("Full — verify parity (clean / env-edit / cache-tamper / absent lock)", () => {
  it("reports absent-lock drift on a fresh root", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    expect(adapter.verify({ declaration: fullDeclarationFor("0".repeat(64)) })).toEqual({
      ok: false,
      drift: ["no binding lock"],
    });
  });

  it("reports ok:true with no drift right after a clean full bind", async () => {
    const { resolved, disposition } = scannedFullFixture("full-verify-clean");
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    const declaration = fullDeclarationFor(resolved.treeDigest, { "mcp:context7": true });
    await adapter.provision({ context: { declaration }, resolved }, disposition);

    const result = adapter.verify({ declaration });
    expect(result.drift).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports drift when an owned env-root field is edited by hand after bind", async () => {
    const { resolved, disposition } = scannedFullFixture("full-verify-env");
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    const declaration = fullDeclarationFor(resolved.treeDigest);
    await adapter.provision({ context: { declaration }, resolved }, disposition);

    const settingsPath = join(root, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.env.ECC_AGENT_DATA_HOME = "/tmp/hijacked"; // user redirected the state root by hand
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    const result = adapter.verify({ declaration });
    expect(result.ok).toBe(false);
    expect(result.drift.some((line) => line.includes("env"))).toBe(true);
  });

  it("reports drift when the loaded plugin cache tree is tampered after bind (D7 re-check)", async () => {
    const { resolved, disposition } = scannedFullFixture("full-verify-cache");
    let located = resolved.treePath;
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => located,
    });
    const declaration = fullDeclarationFor(resolved.treeDigest);
    await adapter.provision({ context: { declaration }, resolved }, disposition);

    const tampered = join(cacheHome, "full-verify-cache-tampered");
    mkdirSync(tampered, { recursive: true });
    writeFileSync(join(tampered, "README.md"), "# tampered\n", "utf8");
    located = tampered;

    const result = adapter.verify({ declaration });
    expect(result.ok).toBe(false);
    expect(result.drift.some((line) => line.toLowerCase().includes("identity"))).toBe(true);
  });
});

// -- Full: remove parity ------------------------------------------------------

describe("Full — remove parity (partition + plugin/marketplace / missing lock)", () => {
  it("returns drift-report-only with a reason when no lock is present", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const result = adapter.remove({
      declaration: fullDeclarationFor("0".repeat(64)),
    }) as EccFullRemoveResult;
    expect(result.mode).toBe("drift-report-only");
    if (result.mode === "drift-report-only") expect(result.reason).toContain("no binding lock");
  });

  it("partitions home-scoped ownership and carries plugin/marketplace after a full bind", async () => {
    const { resolved, disposition } = scannedFullFixture("full-remove");
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    const declaration = fullDeclarationFor(resolved.treeDigest, { "mcp:github": true });
    await adapter.provision({ context: { declaration }, resolved }, disposition);

    const result = adapter.remove({ declaration }) as EccFullRemoveResult;
    expect(result.mode).toBe("apply");
    if (result.mode !== "apply") throw new Error("expected apply mode");
    expect(result.plugin).toBe(ECC_FULL_PLUGIN_NAME);
    expect(result.marketplace).toBe(ECC_FULL_MARKETPLACE_NAME);
    // the two machine-scope entries (marketplace + cache) partition out.
    expect(result.homeOwnership).toHaveLength(2);
    expect(result.homeOwnership.every((entry) => entry.target.startsWith("home:"))).toBe(true);
    // clean right after bind — no repo-relative drift.
    expect(result.repoRelativeDrift).toEqual([]);
  });
});

// -- Full: report -------------------------------------------------------------

describe("Full — report (Framework Card input lines)", () => {
  it("includes mode:full, pin, connectors, env roots, label decision, and a labeled estimate", async () => {
    const { resolved, disposition } = scannedFullFixture("full-report");
    const adapter = createEccAdapter({
      root,
      runner: spyRunner().runner,
      env: { USERPROFILE: home, AIH_PLATFORM: "linux" },
      locateCache: () => resolved.treePath,
    });
    const declaration = fullDeclarationFor(resolved.treeDigest, {
      "mcp:github": true,
      "mcp:context7": true,
    });
    await adapter.provision({ context: { declaration }, resolved }, disposition);

    const report = adapter.report({ declaration });
    expect(report.framework).toBe("ecc");
    const text = report.lines.join("\n");
    expect(text).toContain("mode: full");
    expect(text).toContain(ECC_REPOSITORY);
    expect(text).toContain(ECC_PIN_COMMIT);
    expect(text).toContain("match: true");
    expect(text).toContain("mcp connectors selected (2)");
    expect(text).toContain("github");
    expect(text).toContain(ECC_AGENT_DATA_HOME_DEFAULT);
    expect(text).toContain(ECC_HOMUNCULUS_DIR_DEFAULT);
    expect(text).toContain("label decision: strict");
    expect(text.toLowerCase()).toContain("estimate");
  });

  it("reports lock-absent state (mode:full, connectors, env roots) before any provision", () => {
    const adapter = createEccAdapter({ root, runner: spyRunner().runner });
    const report = adapter.report({
      declaration: fullDeclarationFor("0".repeat(64), { "mcp:github": true }),
    });
    const text = report.lines.join("\n");
    expect(text).toContain("mode: full");
    expect(text).toContain("binding lock: absent");
    expect(text).toContain("mcp connectors selected (1)");
    expect(text).toContain(ECC_AGENT_DATA_HOME_DEFAULT);
  });
});

// -- acceptance (real installer; orchestrator-triggered only) ------------------

describe("acceptance — real evidence-gated ECC selective install", () => {
  it.skip("installs ECC Lean against the pinned checkout and verifies runtime-surface absence (MANUAL)", () => {
    /**
     * The HARD RULE forbids a real ECC install in unit tests. Run this only in the
     * orchestrator-triggered acceptance phase, on a throwaway machine seat:
     *
     *  1. Resolve the pinned source: `resolveGitSource({ repository: "samartomar/ECC",
     *     commitSha: ECC_PIN_COMMIT }, { runner: defaultRunner, cacheHome: <tmp> })`.
     *  2. Run the W2 fast-scan gate over the checkout to mint a real disposition.
     *  3. Build a real EccLeanInstaller that composes ECC's `executeEccEvidencePipeline`
     *     (src/ecc/pipeline.ts) with the shipped vendor lock as `deps.vendorLock`, the
     *     resolved checkout as `deps.source`, `clis: ["claude"]`, and the vetted Lean
     *     selection — capturing the files written under a fixture HOME by diffing the
     *     HOME tree before/after. NOTE: this requires `npm ci` inside the checkout and
     *     executes upstream installer JS, so it is a REAL host mutation.
     *  4. `createEccAdapter({ root, runner: defaultRunner, env: { USERPROFILE: <fixtureHome> },
     *     installer }).provision(...)` and assert: lock.match === true; no `<home>/.claude/hooks`,
     *     no `<home>/.claude/skills/learned`, no `.mcp.json` servers.
     */
  });
});
