import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry, type BindingContext } from "../../../src/binding/adapter.js";
import { fullTreeClosureSpec } from "../../../src/binding/closure/profile-closure.js";
import { BindingFeatureKeyError } from "../../../src/binding/features.js";
import {
  applyGstackNamePatch,
  createGstackAdapter,
  deriveGstackSkillInventory,
  GSTACK_CONDITIONAL_IDENTITIES,
  GSTACK_CONFIG_REL,
  GSTACK_FEATURE_KEYS,
  GSTACK_HOOK_STRIP_TARGET,
  GSTACK_INSTALL_ROOT_REL,
  GSTACK_PIN_COMMIT,
  GSTACK_PIN_TREE_DIGEST,
  GSTACK_PINNED_SKILL_INVENTORY,
  GSTACK_REPOSITORY,
  GSTACK_SELECTED_PROFILE,
  GSTACK_SETUP_COMMAND,
  GstackBindingError,
  gstackInstalledSubsetIdentity,
  gstackLockdownConfigYaml,
  isGstackInstallGenerated,
  stripGstackHooks,
} from "../../../src/binding/frameworks/gstack.js";
import { createBindingAdapterRegistry } from "../../../src/binding/frameworks/registry.js";
import { CLAUDE_SETTINGS_PATH } from "../../../src/binding/hosts/claude/surfaces.js";
import { readBindingLock } from "../../../src/binding/lock.js";
import {
  BindingScanError,
  type ResolvedGitSource,
  resolveGitSource,
  type ScanDisposition,
} from "../../../src/binding/scan-gate.js";
import {
  type BindingDeclaration,
  BindingFrameworkConflictError,
} from "../../../src/binding/schema.js";
import { defaultRunner } from "../../../src/internals/proc.js";
import {
  declarationFor,
  fixtureInstaller,
  fixtureTree,
  GSTACK_FIXTURE_FILES,
  recordingRunner,
  scannedGstackFixture,
  writeFileEnsuring,
} from "./gstack-support.js";

/**
 * W5 — the gstack shared-runtime FrameworkAdapter, part 1: pinned constants,
 * pure helpers (name patch, inventory derivation, lockdown config, hook strip,
 * D7 subset identity), declaration/source guards, plan purity, registry wiring,
 * and the D12 + selected-profile provision gates. Every disposition is REAL
 * (minted by `runFastScanGate`); no test executes upstream code, hits the
 * network, or invokes the claude CLI. Every fixture stays bland ASCII.
 */

let root: string;
let home: string;
let cacheHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-gs-root-"));
  home = mkdtempSync(join(tmpdir(), "aih-gs-home-"));
  cacheHome = mkdtempSync(join(tmpdir(), "aih-gs-cache-"));
});

afterEach(() => {
  for (const dir of [root, home, cacheHome]) rmSync(dir, { recursive: true, force: true });
});

const ENV = () => ({ USERPROFILE: home, AIH_PLATFORM: "linux" });

// -- pinned constants ----------------------------------------------------------

describe("pinned constants — the 55-identity inventory and the ruled profile", () => {
  it("carries exactly 55 unique identities: 53 prefixed + gstack + the conditional alias", () => {
    const names = GSTACK_PINNED_SKILL_INVENTORY.names;
    expect(names).toHaveLength(55);
    expect(new Set(names).size).toBe(55);
    expect(names).toContain("gstack");
    expect(names).toContain("gstack-connect-chrome");
    expect(names.filter((name) => name.startsWith("gstack-"))).toHaveLength(54);
    for (const name of names) expect(name === "gstack" || name.startsWith("gstack-")).toBe(true);
    // Spot-check identities named by the harness design 1.5.
    for (const expected of ["gstack-qa", "gstack-ship", "gstack-upgrade", "gstack-office-hours"]) {
      expect(names).toContain(expected);
    }
  });

  it("binds the inventory to the pinned tree digest and keeps the conditional set inside it", () => {
    expect(GSTACK_PINNED_SKILL_INVENTORY.sourceDigest).toBe(GSTACK_PIN_TREE_DIGEST);
    expect(GSTACK_PIN_TREE_DIGEST).toMatch(/^[0-9a-f]{64}$/);
    expect(GSTACK_PIN_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(GSTACK_REPOSITORY).toBe("garrytan/gstack");
    for (const conditional of GSTACK_CONDITIONAL_IDENTITIES) {
      expect(GSTACK_PINNED_SKILL_INVENTORY.names).toContain(conditional);
    }
  });

  it("pins the exact selected profile and setup invocation", () => {
    expect(GSTACK_SELECTED_PROFILE).toBe("claude:prefix:quiet:no-plan-tune-hooks");
    expect(GSTACK_SETUP_COMMAND).toEqual([
      "bash",
      "./setup",
      "--host",
      "claude",
      "--prefix",
      "--quiet",
      "--no-plan-tune-hooks",
    ]);
  });
});

// -- name patch ----------------------------------------------------------------

describe("applyGstackNamePatch — the deterministic --prefix frontmatter rewrite", () => {
  it("prefixes a plain frontmatter name", () => {
    expect(applyGstackNamePatch("---\nname: qa\ndescription: x\n---\nbody\n")).toBe(
      "---\nname: gstack-qa\ndescription: x\n---\nbody\n",
    );
  });

  it("skips `name: gstack` and already-prefixed names", () => {
    const gstack = "---\nname: gstack\n---\n";
    const prefixed = "---\nname: gstack-upgrade\n---\n";
    expect(applyGstackNamePatch(gstack)).toBe(gstack);
    expect(applyGstackNamePatch(prefixed)).toBe(prefixed);
  });

  it("rewrites only the first name line (body mentions survive)", () => {
    const content = "---\nname: qa\n---\n\nname: not-frontmatter\n";
    expect(applyGstackNamePatch(content)).toBe(
      "---\nname: gstack-qa\n---\n\nname: not-frontmatter\n",
    );
  });
});

// -- inventory derivation ------------------------------------------------------

describe("deriveGstackSkillInventory — tree-derived, patched, superset-safe", () => {
  function resolvedOver(dir: string): ResolvedGitSource {
    return {
      kind: "git",
      repository: GSTACK_REPOSITORY,
      commitSha: GSTACK_PIN_COMMIT,
      treeDigest: "a".repeat(64),
      treePath: dir,
      files: [],
    };
  }

  it("derives one patched identity per top-level SKILL.md plus gstack and the conditional alias", () => {
    const dir = fixtureTree(cacheHome, "derive-src");
    const inventory = deriveGstackSkillInventory(resolvedOver(dir));
    expect(inventory.names).toEqual([
      "gstack-qa",
      "gstack-ship",
      "gstack",
      "gstack-connect-chrome",
    ]);
    expect(inventory.sourceDigest).toBe("a".repeat(64));
  });

  it("keys identity on the frontmatter name (dir-name fallback) and keeps pre-prefixed names", () => {
    const dir = fixtureTree(cacheHome, "derive-names", {
      "weird/SKILL.md": "---\nname: qa-extra\n---\nbody\n",
      "upgrade/SKILL.md": "---\nname: gstack-upgrade\n---\nbody\n",
      "noname/SKILL.md": "---\ndescription: no name here\n---\nbody\n",
    });
    const inventory = deriveGstackSkillInventory(resolvedOver(dir));
    expect(inventory.names).toContain("gstack-qa-extra");
    expect(inventory.names).toContain("gstack-upgrade");
    expect(inventory.names).toContain("gstack-noname");
  });

  it("fails closed on a derived identity carrying a JSON-pointer metacharacter", () => {
    const dir = fixtureTree(cacheHome, "derive-hostile", {
      "evil/SKILL.md": "---\nname: evil/injection\n---\nbody\n",
    });
    expect(() => deriveGstackSkillInventory(resolvedOver(dir))).toThrow(GstackBindingError);
  });

  it("fails closed when the resolved tree is unreadable", () => {
    const missing = join(cacheHome, "does-not-exist-tree");
    expect(() => deriveGstackSkillInventory(resolvedOver(missing))).toThrow(
      /resolved tree unreadable/,
    );
  });

  it("fails closed on a derived identity carrying a space (control/space character)", () => {
    const dir = fixtureTree(cacheHome, "derive-space", {
      "spacey/SKILL.md": "---\nname: qa foo\n---\nbody\n",
    });
    expect(() => deriveGstackSkillInventory(resolvedOver(dir))).toThrow(/control\/space character/);
  });

  it("skips a top-level SKILL.md whose frontmatter carries no name", () => {
    const dir = fixtureTree(cacheHome, "derive-noname-skip", {
      "qa/SKILL.md": "---\nname: qa\n---\nbody\n",
      "nameless/SKILL.md": "---\ndescription: only a description\n---\nbody\n",
    });
    const inventory = deriveGstackSkillInventory(resolvedOver(dir));
    // The nameless dir derives its identity from the DIR name (gstack-nameless);
    // the loop never crashes on the missing frontmatter name.
    expect(inventory.names).toContain("gstack-qa");
    expect(inventory.names).toContain("gstack-nameless");
  });
});

// -- lockdown config -----------------------------------------------------------

describe("gstackLockdownConfigYaml — every key written literally", () => {
  it("renders the nine lockdown keys plus the two defaulted user choices", () => {
    const text = gstackLockdownConfigYaml({
      codexReviews: false,
      proactive: false,
      browserAutomation: false,
    });
    expect(text).toBe(
      [
        "telemetry: off",
        "auto_upgrade: false",
        "update_check: false",
        "cross_project_learnings: false",
        "artifacts_sync_mode: off",
        "plan_tune_hooks: no",
        "checkpoint_mode: explicit",
        "checkpoint_push: false",
        "skill_prefix: true",
        "codex_reviews: disabled",
        "proactive: false",
        "",
      ].join("\n"),
    );
  });

  it("surfaces explicit user choices (codex enabled, proactive true); browserAutomation writes no key", () => {
    const text = gstackLockdownConfigYaml({
      codexReviews: true,
      proactive: true,
      browserAutomation: true,
    });
    expect(text).toContain("codex_reviews: enabled");
    expect(text).toContain("proactive: true");
    expect(text.toLowerCase()).not.toContain("browser");
  });
});

// -- hook strip (pure) ---------------------------------------------------------

describe("stripGstackHooks — path/substring across ALL events + tags, never tag-only", () => {
  const untaggedSessionStart = {
    hooks: [
      {
        type: "command",
        command: "/home/user/.claude/skills/gstack/bin/gstack-session-update",
      },
    ],
  };
  const taggedPostToolUse = {
    _gstack_source: "plan-tune-cathedral",
    matcher: "(AskUserQuestion|mcp__.*__AskUserQuestion)",
    hooks: [{ type: "command", command: "/anywhere/question-log-hook", timeout: 5 }],
  };
  const userHook = {
    hooks: [{ type: "command", command: "/home/user/bin/my-linter --fix" }],
  };

  it("removes the UNTAGGED team SessionStart by command substring (a tag-only strip would miss it)", () => {
    const result = stripGstackHooks({ hooks: { SessionStart: [untaggedSessionStart] } });
    expect(result.changed).toBe(true);
    expect(result.removedCount).toBe(1);
    expect(result.nextHooks).toBeUndefined();
    expect(result.fragments.SessionStart).toEqual([untaggedSessionStart]);
  });

  it("removes tagged groups on any event and preserves user hooks verbatim", () => {
    const result = stripGstackHooks({
      hooks: {
        PostToolUse: [taggedPostToolUse, userHook],
        PreToolUse: [{ _gstack_source: "auq-error-fallback", hooks: [] }],
      },
    });
    expect(result.changed).toBe(true);
    expect(result.removedCount).toBe(2);
    expect(result.nextHooks).toEqual({ PostToolUse: [userHook] });
    expect(result.fragments.PostToolUse).toEqual([taggedPostToolUse]);
  });

  it("strips only the matching items out of a mixed group (the group survives)", () => {
    const mixed = {
      hooks: [
        { type: "command", command: "C:\\Users\\u\\.claude\\skills\\gstack\\bin\\thing" },
        { type: "command", command: "/home/user/bin/keep-me" },
      ],
    };
    const result = stripGstackHooks({ hooks: { Stop: [mixed] } });
    expect(result.changed).toBe(true);
    expect(result.nextHooks).toEqual({
      Stop: [{ hooks: [{ type: "command", command: "/home/user/bin/keep-me" }] }],
    });
    expect(result.fragments.Stop).toHaveLength(1);
  });

  it("reports no change when nothing gstack-shaped is present", () => {
    const result = stripGstackHooks({ hooks: { SessionStart: [userHook] } });
    expect(result.changed).toBe(false);
    expect(result.removedCount).toBe(0);
  });

  it("preserves a non-array event value and a non-object group verbatim", () => {
    const result = stripGstackHooks({
      hooks: {
        // A malformed (non-array) event value survives untouched...
        Weird: { not: "an array" },
        // ...and a non-object group inside a real event is kept as-is, alongside
        // a stripped gstack group so a change is still recorded.
        SessionStart: [
          "not-an-object",
          { hooks: [{ type: "command", command: ".claude/skills/gstack/bin/x" }] },
        ],
      },
    });
    expect(result.changed).toBe(true);
    const next = result.nextHooks ?? {};
    expect((next.Weird as Record<string, unknown>).not).toBe("an array");
    expect(next.SessionStart).toEqual(["not-an-object"]);
  });

  it("returns no-change on a non-object settings value", () => {
    expect(stripGstackHooks(42).changed).toBe(false);
    expect(stripGstackHooks({ hooks: "not-an-object" }).changed).toBe(false);
  });
});

// -- D7 subset identity (pure over fixtures) -----------------------------------

describe("gstackInstalledSubsetIdentity — inventory-restricted, exact-byte", () => {
  function faithfulCopy(treePath: string, files: readonly string[], installRoot: string): void {
    // The real install-root copy is a verbatim cp -R (RAW bytes) — patch-names
    // runs on the source afterward and only the separate wrapper dirs are
    // patched, so a faithful install-root copy is exact scanned bytes.
    for (const rel of files) {
      const raw = readFileSync(join(treePath, ...rel.split("/")));
      writeFileEnsuring(join(installRoot, ...rel.split("/")), raw.toString("utf8"));
    }
  }

  function resolvedFixture(name: string): ResolvedGitSource {
    const { resolved } = scannedGstackFixture(cacheHome, name);
    return resolved;
  }

  it("a faithful raw install digests to the resolved tree digest (match honest)", () => {
    const resolved = resolvedFixture("d7-faithful");
    const installRoot = join(home, GSTACK_INSTALL_ROOT_REL);
    faithfulCopy(resolved.treePath, resolved.files ?? [], installRoot);
    const identity = gstackInstalledSubsetIdentity(resolved, installRoot);
    expect(identity.mismatches).toEqual([]);
    expect(identity.loadedDigest).toBe(resolved.treeDigest);
    expect(identity.manifest.length).toBe((resolved.files ?? []).length);
  });

  it("excludes node_modules/build outputs/.git junk from identity (disclosed, not gating)", () => {
    const resolved = resolvedFixture("d7-junk");
    const installRoot = join(home, GSTACK_INSTALL_ROOT_REL);
    faithfulCopy(resolved.treePath, resolved.files ?? [], installRoot);
    writeFileEnsuring(join(installRoot, "node_modules", "x", "index.js"), "junk\n");
    writeFileEnsuring(join(installRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    const identity = gstackInstalledSubsetIdentity(resolved, installRoot);
    expect(identity.mismatches).toEqual([]);
    expect(identity.loadedDigest).toBe(resolved.treeDigest);
  });

  it("a WRONGLY name-patched top-level SKILL.md is a content mismatch (reality leaves the install root raw)", () => {
    const resolved = resolvedFixture("d7-wrongpatch");
    const installRoot = join(home, GSTACK_INSTALL_ROOT_REL);
    for (const rel of resolved.files ?? []) {
      const raw = readFileSync(join(resolved.treePath, ...rel.split("/")), "utf8");
      const segments = rel.split("/");
      const eligible = segments.length === 2 && segments[1] === "SKILL.md";
      writeFileEnsuring(join(installRoot, ...segments), eligible ? applyGstackNamePatch(raw) : raw);
    }
    const identity = gstackInstalledSubsetIdentity(resolved, installRoot);
    expect(identity.mismatches).toContain("content:qa/SKILL.md");
    expect(identity.loadedDigest).not.toBe(resolved.treeDigest);
  });

  it("a missing inventory file and a tampered file both break the identity", () => {
    const resolved = resolvedFixture("d7-tampered");
    const installRoot = join(home, GSTACK_INSTALL_ROOT_REL);
    faithfulCopy(resolved.treePath, resolved.files ?? [], installRoot);
    rmSync(join(installRoot, "setup"));
    writeFileEnsuring(join(installRoot, "bin", "gstack-settings-hook"), "tampered\n");
    const identity = gstackInstalledSubsetIdentity(resolved, installRoot);
    expect(identity.mismatches).toContain("missing:setup");
    expect(identity.mismatches).toContain("content:bin/gstack-settings-hook");
    expect(identity.loadedDigest).not.toBe(resolved.treeDigest);
  });

  it("fails closed when the resolved source carries no file inventory", () => {
    const resolved = { ...resolvedFixture("d7-nofiles"), files: undefined };
    expect(() =>
      gstackInstalledSubsetIdentity(resolved, join(home, GSTACK_INSTALL_ROOT_REL)),
    ).toThrow(GstackBindingError);
  });

  it("excludes build-regenerated committed files from byte-identity but present-checks them", () => {
    const files = {
      ...GSTACK_FIXTURE_FILES,
      "gstack/llms.txt": "# gstack index (committed)\nqa: run qa\n",
      "agents/openai.yaml": "name: qa\nallow_implicit_invocation: true\n",
      "openclaw/gstack-full-CLAUDE.md": "# openclaw full (committed)\n",
      "scripts/proactive-suggestions.json": '{"suggest":[]}\n',
    };
    const { resolved } = scannedGstackFixture(cacheHome, "d7-generated", { files });
    const installRoot = join(home, GSTACK_INSTALL_ROOT_REL);
    // Faithful install: static files verbatim, generated files REGENERATED to
    // different bytes (what the real build does from the patched source).
    for (const rel of resolved.files ?? []) {
      const raw = readFileSync(join(resolved.treePath, ...rel.split("/")), "utf8");
      const out = isGstackInstallGenerated(rel) ? `${raw}# regenerated by build\n` : raw;
      writeFileEnsuring(join(installRoot, ...rel.split("/")), out);
    }
    const identity = gstackInstalledSubsetIdentity(resolved, installRoot);
    // Generated files differ in bytes yet the install is a faithful match.
    expect(identity.mismatches).toEqual([]);
    expect(identity.loadedDigest).toBe(resolved.treeDigest);
    const llms = identity.manifest.find((e) => e.path === "gstack/llms.txt");
    expect(llms?.generated).toBe(true);
    // A DELETED generated file is still a mismatch (presence is enforced).
    rmSync(join(installRoot, "gstack", "llms.txt"));
    const afterDelete = gstackInstalledSubsetIdentity(resolved, installRoot);
    expect(afterDelete.mismatches).toContain("missing:gstack/llms.txt");
  });

  it("classifies the generated exclusion set (non-Claude-loaded) and nothing else", () => {
    expect(isGstackInstallGenerated("gstack/llms.txt")).toBe(true);
    expect(isGstackInstallGenerated("agents/openai.yaml")).toBe(true);
    expect(isGstackInstallGenerated("openclaw/gstack-full-CLAUDE.md")).toBe(true);
    expect(isGstackInstallGenerated("scripts/proactive-suggestions.json")).toBe(true);
    // Loaded/static surfaces are NEVER excluded.
    expect(isGstackInstallGenerated("qa/SKILL.md")).toBe(false);
    expect(isGstackInstallGenerated("setup")).toBe(false);
    expect(isGstackInstallGenerated("bin/gstack-settings-hook")).toBe(false);
    expect(isGstackInstallGenerated("scripts/build.sh")).toBe(false);
  });
});

// -- registry ------------------------------------------------------------------

describe("createGstackAdapter — registers in AdapterRegistry (D6, shared-runtime)", () => {
  it("registers as framework 'gstack' with adapterType 'shared-runtime'", () => {
    const registry = new AdapterRegistry();
    registry.register(createGstackAdapter({ root, runner: recordingRunner().runner }));
    expect(registry.has("gstack")).toBe(true);
    expect(registry.get("gstack")?.adapterType).toBe("shared-runtime");
  });

  it("createBindingAdapterRegistry wires the same adapter beside superpowers and ecc", () => {
    const registry = createBindingAdapterRegistry({ root, runner: recordingRunner().runner });
    expect(registry.get("gstack")?.adapterType).toBe("shared-runtime");
    expect(registry.frameworks()).toEqual(["superpowers", "ecc", "gstack"]);
  });
});

// -- declaration/source guards -------------------------------------------------

describe("declaration and source guards — wrong routing fails closed", () => {
  it("rejects a declaration routed to the wrong framework", () => {
    const adapter = createGstackAdapter({ root, runner: recordingRunner().runner });
    const eccDeclaration: BindingDeclaration = {
      schemaVersion: 1,
      framework: { id: "ecc", mode: "lean", host: "claude" },
      source: {
        kind: "git",
        repository: "samartomar/ECC",
        commitSha: "c".repeat(40),
        treeDigest: "d".repeat(64),
      },
    };
    expect(() => adapter.plan({ declaration: eccDeclaration })).toThrow(GstackBindingError);
  });

  it("rejects a non-git declared source at resolve time", async () => {
    const adapter = createGstackAdapter({ root, runner: recordingRunner().runner });
    const declaration: BindingDeclaration = {
      schemaVersion: 1,
      framework: { id: "gstack", host: "claude" },
      source: {
        kind: "npm",
        package: "gstack",
        exactVersion: "1.0.0",
        integrity: `sha512-${"A".repeat(86)}==`,
      },
    };
    await expect(adapter.resolve({ declaration })).rejects.toBeInstanceOf(GstackBindingError);
  });

  it("rejects planning when a different framework is already bound (D8) and allows a same-framework re-plan", () => {
    const adapter = createGstackAdapter({ root, runner: recordingRunner().runner, env: ENV() });
    const conflicted: BindingContext = {
      declaration: declarationFor("d".repeat(64)),
      existingFramework: "ecc",
    };
    expect(() => adapter.plan(conflicted)).toThrow(BindingFrameworkConflictError);
    expect(() =>
      adapter.plan({ declaration: declarationFor("d".repeat(64)), existingFramework: "gstack" }),
    ).not.toThrow();
  });
});

// -- feature keys --------------------------------------------------------------

describe("feature keys — the three explicit user choices; anything else fails closed", () => {
  it("accepts exactly codexReviews, proactive, browserAutomation", () => {
    expect(GSTACK_FEATURE_KEYS).toEqual(["codexReviews", "proactive", "browserAutomation"]);
    const adapter = createGstackAdapter({ root, runner: recordingRunner().runner, env: ENV() });
    expect(() =>
      adapter.plan({
        declaration: declarationFor("d".repeat(64), {
          codexReviews: false,
          proactive: false,
          browserAutomation: false,
        }),
      }),
    ).not.toThrow();
  });

  it("rejects an unknown feature key at plan time", () => {
    const adapter = createGstackAdapter({ root, runner: recordingRunner().runner, env: ENV() });
    expect(() =>
      adapter.plan({ declaration: declarationFor("d".repeat(64), { autoUpgrade: true }) }),
    ).toThrow(BindingFeatureKeyError);
  });

  it("rejects an unknown feature key at provision time before any runner call", async () => {
    const { resolved, disposition } = scannedGstackFixture(cacheHome, "feat-src");
    const { runner, calls } = recordingRunner();
    const adapter = createGstackAdapter({ root, runner, env: ENV() });
    const declaration = declarationFor(resolved.treeDigest, { evil: true });
    await expect(
      adapter.provision({ context: { declaration }, resolved }, disposition),
    ).rejects.toBeInstanceOf(BindingFeatureKeyError);
    expect(calls).toHaveLength(0);
  });
});

// -- plan (pure preview) -------------------------------------------------------

describe("plan — pure preview of every owned surface (no write ever lands)", () => {
  it("previews deny (home:), re-enables, CLAUDE.md block, config, hook-strip intent, and install surfaces", () => {
    const adapter = createGstackAdapter({ root, runner: recordingRunner().runner, env: ENV() });
    const result = adapter.plan({ declaration: declarationFor("d".repeat(64)) });

    expect(result.framework).toBe("gstack");
    // 55 project re-enables + the CLAUDE.md block + the lockdown config.
    expect(result.writes).toHaveLength(GSTACK_PINNED_SKILL_INVENTORY.names.length + 2);
    expect(result.writes.some((write) => write.path === GSTACK_CONFIG_REL)).toBe(true);

    const targets = result.ownership.map((entry) => entry.target);
    expect(targets).toContain("home:.claude/settings.json#/skillOverrides");
    expect(targets).toContain(GSTACK_HOOK_STRIP_TARGET);
    expect(targets).toContain(`home:${GSTACK_INSTALL_ROOT_REL}`);
    expect(targets).toContain("home:.claude/skills/_gstack-command");
    expect(targets).toContain("home:.claude/skills/gstack-connect-chrome");
    expect(targets.some((target) => target.includes("#block:"))).toBe(true);
    expect(targets).toContain(GSTACK_CONFIG_REL);
    for (const entry of result.ownership) {
      expect(entry.postApplyDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("plan is pure: no project settings, no home settings, no config on disk afterwards", () => {
    const adapter = createGstackAdapter({ root, runner: recordingRunner().runner, env: ENV() });
    adapter.plan({ declaration: declarationFor("d".repeat(64)) });
    expect(existsSync(join(root, CLAUDE_SETTINGS_PATH))).toBe(false);
    expect(existsSync(join(home, CLAUDE_SETTINGS_PATH))).toBe(false);
    expect(existsSync(join(root, GSTACK_CONFIG_REL))).toBe(false);
  });
});

// -- resolve -------------------------------------------------------------------

describe("resolve — delegates to resolveGitSource with the declaration's source", () => {
  function initGitRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Binding Test"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "SKILL.md"), "# skill\n");
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);
  }

  it("resolves the exact declared commitSha without a ref round-trip", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "aih-gs-repo-"));
    try {
      initGitRepo(repoDir);
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
      const adapter = createGstackAdapter({ root, runner: defaultRunner, cacheHome });
      const declaration: BindingDeclaration = {
        schemaVersion: 1,
        framework: { id: "gstack", host: "claude" },
        source: { kind: "git", repository: repoDir, commitSha: head, treeDigest: "d".repeat(64) },
      };

      const resolved = await adapter.resolve({ declaration });

      expect(resolved.kind).toBe("git");
      if (resolved.kind === "git") {
        expect(resolved.commitSha).toBe(head);
        expect(resolved.treeDigest).toMatch(/^[0-9a-f]{64}$/);
      }
      const direct = await resolveGitSource(
        { repository: repoDir, commitSha: head },
        { runner: defaultRunner, cacheHome },
      );
      expect(resolved).toEqual(direct);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// -- inspect -------------------------------------------------------------------

describe("inspect — cheap static notes over a tree path", () => {
  it("notes skill count, setup script, settings hook, and browse subtree for a gstack-shaped tree", async () => {
    const dir = fixtureTree(cacheHome, "inspect-src", GSTACK_FIXTURE_FILES);
    const adapter = createGstackAdapter({ root, runner: recordingRunner().runner });
    const report = await adapter.inspect({ treePath: dir });
    expect(report.framework).toBe("gstack");
    const text = report.notes.join("\n");
    expect(text).toContain("2 top-level SKILL.md skill dir(s) found");
    expect(text).toContain("setup script present");
    expect(text).toContain("bin/gstack-settings-hook present");
    expect(text).toContain("browse/ subtree present");
  });

  it("notes absences for an unrelated tree", async () => {
    const dir = fixtureTree(cacheHome, "inspect-empty", { "README.md": "# nothing here\n" });
    const adapter = createGstackAdapter({ root, runner: recordingRunner().runner });
    const report = await adapter.inspect({ treePath: dir });
    const text = report.notes.join("\n").toLowerCase();
    expect(text).toContain("no top-level skill.md skill dirs found");
    expect(text).toContain("no setup script found");
    expect(text).toContain("no browse/ subtree found");
  });
});

// -- provision: blocked paths (D12 + the NEW selected-profile gate) ------------

describe("provision — blocked before any upstream code (forged/mismatched/profile)", () => {
  it("rejects a forged (unbranded) disposition and runs nothing", async () => {
    const { resolved } = scannedGstackFixture(cacheHome, "blocked-forged");
    const forged = {
      digest: resolved.treeDigest,
      verdict: "allow",
      findings: [],
      posture: "enterprise",
      producedAt: new Date().toISOString(),
      rawSourceScan: "CLEAN",
      selectedProfileGate: "ALLOW",
      closure: { profile: GSTACK_SELECTED_PROFILE },
    } as unknown as ScanDisposition;
    const { runner, calls } = recordingRunner();
    const { installer, calls: installs } = fixtureInstaller();
    const adapter = createGstackAdapter({ root, runner, env: ENV(), installGstack: installer });
    const declaration = declarationFor(resolved.treeDigest);

    await expect(
      adapter.provision({ context: { declaration }, resolved }, forged),
    ).rejects.toBeInstanceOf(BindingScanError);
    expect(calls).toHaveLength(0);
    expect(installs).toHaveLength(0);
    expect(readBindingLock(root).present).toBe(false);
  });

  it("rejects a disposition whose digest does not match the resolved source", async () => {
    const { resolved, disposition } = scannedGstackFixture(cacheHome, "blocked-digest");
    const { runner, calls } = recordingRunner();
    const adapter = createGstackAdapter({ root, runner, env: ENV() });
    const mismatched: ResolvedGitSource = { ...resolved, treeDigest: "f".repeat(64) };
    const declaration = declarationFor(mismatched.treeDigest);

    await expect(
      adapter.provision({ context: { declaration }, resolved: mismatched }, disposition),
    ).rejects.toBeInstanceOf(BindingScanError);
    expect(calls).toHaveLength(0);
  });

  it("re-rejects a second framework (D8 layer 3) even with a valid allow disposition", async () => {
    const { resolved, disposition } = scannedGstackFixture(cacheHome, "blocked-d8");
    const { runner, calls } = recordingRunner();
    const adapter = createGstackAdapter({ root, runner, env: ENV() });
    const declaration = declarationFor(resolved.treeDigest);

    await expect(
      adapter.provision(
        { context: { declaration, existingFramework: "superpowers" }, resolved },
        disposition,
      ),
    ).rejects.toBeInstanceOf(BindingFrameworkConflictError);
    expect(calls).toHaveLength(0);
  });

  it("NEW: rejects a legacy full-tree disposition (no closure profile) before any side effect", async () => {
    const { resolved, disposition } = scannedGstackFixture(cacheHome, "blocked-noclosure", {
      closureSpec: null,
    });
    expect(disposition.closure).toBeUndefined();
    const { runner, calls } = recordingRunner();
    const { installer, calls: installs } = fixtureInstaller();
    const adapter = createGstackAdapter({ root, runner, env: ENV(), installGstack: installer });
    const declaration = declarationFor(resolved.treeDigest);

    await expect(
      adapter.provision({ context: { declaration }, resolved }, disposition),
    ).rejects.toThrow(GstackBindingError);
    expect(calls).toHaveLength(0);
    expect(installs).toHaveLength(0);
    expect(existsSync(join(home, CLAUDE_SETTINGS_PATH))).toBe(false);
    expect(readBindingLock(root).present).toBe(false);
  });

  it("NEW: rejects a branded disposition scanned under a DIFFERENT profile", async () => {
    const { resolved, disposition } = scannedGstackFixture(cacheHome, "blocked-profile", {
      closureSpec: fullTreeClosureSpec(),
    });
    expect(disposition.closure?.profile).toBe("full-tree");
    const { runner, calls } = recordingRunner();
    const { installer, calls: installs } = fixtureInstaller();
    const adapter = createGstackAdapter({ root, runner, env: ENV(), installGstack: installer });
    const declaration = declarationFor(resolved.treeDigest);

    await expect(
      adapter.provision({ context: { declaration }, resolved }, disposition),
    ).rejects.toThrow(/selected profile/);
    expect(calls).toHaveLength(0);
    expect(installs).toHaveLength(0);
  });

  it("refuses when bun is not on PATH (readiness) without invoking the installer", async () => {
    const { resolved, disposition } = scannedGstackFixture(cacheHome, "blocked-bun");
    const { runner } = recordingRunner((argv) =>
      argv[0] === "bun"
        ? { code: 127, stdout: "", stderr: "not found", spawnError: true }
        : undefined,
    );
    const { installer, calls: installs } = fixtureInstaller();
    const adapter = createGstackAdapter({ root, runner, env: ENV(), installGstack: installer });
    const declaration = declarationFor(resolved.treeDigest);

    await expect(
      adapter.provision({ context: { declaration }, resolved }, disposition),
    ).rejects.toThrow(/bun/);
    expect(installs).toHaveLength(0);
    expect(readBindingLock(root).present).toBe(false);
  });

  it("refuses on installer failure and removes the dirs the attempt created", async () => {
    const { resolved, disposition } = scannedGstackFixture(cacheHome, "blocked-installer");
    const { runner } = recordingRunner();
    const failing = fixtureInstaller();
    const adapter = createGstackAdapter({
      root,
      runner,
      env: ENV(),
      installGstack: async (input) => {
        await failing.installer(input); // materialize dirs, then fail
        return { exitCode: 2, stdout: "", stderr: "boom" };
      },
    });
    const declaration = declarationFor(resolved.treeDigest);

    await expect(
      adapter.provision({ context: { declaration }, resolved }, disposition),
    ).rejects.toThrow(/exit 2/);
    expect(existsSync(join(home, GSTACK_INSTALL_ROOT_REL))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", "gstack-qa"))).toBe(false);
    expect(readBindingLock(root).present).toBe(false);
  });
});
