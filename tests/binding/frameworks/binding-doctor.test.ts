import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../../src/binding/adapter.js";
import {
  bindingContaminationCheck,
  bindingContextCostCheck,
  bindingDenyListFreshnessCheck,
  bindingFrameworkDriftCheck,
  bindingHookChainChecks,
  bindingHostTupleCheck,
  bindingMcpInventoryCheck,
  bindingSettingsDriftCheck,
  cardDoctorInputFromChecks,
  eccDoubleInstallCheck,
  eccModeExclusivityCheck,
} from "../../../src/binding/frameworks/binding-doctor.js";
import {
  GSTACK_PIN_TREE_DIGEST,
  GSTACK_PINNED_SKILL_INVENTORY,
} from "../../../src/binding/frameworks/gstack.js";
import { type HostTuple, SUPPORTED_HOST_TUPLE } from "../../../src/binding/host-tuple.js";
import { collectHookChain } from "../../../src/binding/hosts/claude/contamination.js";
import {
  planClaudeRemoval,
  readClaudeSettingsDrift,
} from "../../../src/binding/hosts/claude/removal.js";
import { CLAUDE_SETTINGS_PATH } from "../../../src/binding/hosts/claude/surfaces.js";
import {
  type BindingLock,
  type BindingOwnershipEntry,
  writeBindingLockAtomic,
} from "../../../src/binding/lock.js";
import type {
  BindingDeclaration,
  BindingSource,
  FrameworkId,
} from "../../../src/binding/schema.js";
import { command as doctorCommand } from "../../../src/doctor.js";
import type { Action, Plan, PlanContext } from "../../../src/internals/plan.js";
import { fakeRunner } from "../../../src/internals/proc.js";
import { type Check, VerificationReport } from "../../../src/internals/verify.js";
import { makeHostAdapter } from "../../../src/platform/detect.js";
import { createFakeAdapter } from "../fake-adapter.js";

/**
 * W4d — the two ECC doctor probes (`eccDoubleInstallCheck`,
 * `eccModeExclusivityCheck`). Both are pure read-only diagnostics over a
 * project root's `.claude/settings.json`, `.claude/rules/ecc/` (project and
 * home scope), and the binding lock — no Runner calls are ever made, so
 * `fakeRunner` here always reports a spawn error (unused by these checks).
 */

const SHA_A = "a".repeat(64);

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-doctor-root-"));
  home = mkdtempSync(join(tmpdir(), "aih-ecc-doctor-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => ({ code: 1, spawnError: true }));
  // Both USERPROFILE and HOME so claudeHomeDir resolves to the injected temp home on
  // every platform (never the real `~`), keeping contamination/hook/MCP scans hermetic.
  const env = over.env ?? { HOME: home, USERPROFILE: home };
  const base: PlanContext = {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: over.host ?? makeHostAdapter({ platform: "linux", run, env }),
    env,
    options: {},
  };
  return { ...base, ...over };
}

// -- shared binding/home fixture helpers (for the B1–B8 probes) --------------

const SHA_B = "b".repeat(64);
const ECC_SOURCE: BindingSource = {
  kind: "git",
  repository: "affaan-m/ECC",
  commitSha: "c".repeat(40),
  treeDigest: SHA_A,
};

/** Write an applied binding lock so the probes see a bound project; returns the lock. */
function bind(
  framework: FrameworkId,
  source: BindingSource,
  opts: { mode?: "lean" | "full"; ownership?: BindingOwnershipEntry[] } = {},
): BindingLock {
  const declaration: BindingDeclaration = {
    schemaVersion: 1,
    framework: { id: framework, host: "claude", ...(opts.mode ? { mode: opts.mode } : {}) },
    source,
  };
  const lock: BindingLock = {
    schemaVersion: 1,
    declaration,
    writes: [],
    scannedDigest: SHA_A,
    loadedDigest: SHA_A,
    match: true,
    ownership: opts.ownership ?? [],
  };
  writeBindingLockAtomic(root, lock);
  return lock;
}

/**
 * Seed a user-scope (home) skill — a contamination surface. Content-bearing:
 * the scanner counts an immediate skills/ subdirectory only when it has
 * content (a bare empty directory is host scaffolding, e.g. skills/learned).
 */
function seedHomeSkill(name: string): void {
  const dir = join(home, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`, "utf8");
}

/** Seed a project-scope surface file under `<root>/.claude`. */
function writeProjectFile(rel: string, contents: string): void {
  const full = join(root, ".claude", rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function writeProjectSettings(body: unknown | string): void {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    typeof body === "string" ? body : JSON.stringify(body),
    "utf8",
  );
}

function writeManualEccCopy(base: string): void {
  mkdirSync(join(base, ".claude", "rules", "ecc"), { recursive: true });
  writeFileSync(join(base, ".claude", "rules", "ecc", "patterns.md"), "# ecc rules\n", "utf8");
}

describe("eccDoubleInstallCheck", () => {
  it("passes with a clean detail when neither surface is present", () => {
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toBe("no ECC plugin enable and no manual ECC rules copy found");
  });

  it("passes when only the plugin is enabled", () => {
    writeProjectSettings({ enabledPlugins: { "ecc@ecc": true } });
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("ECC plugin enabled (ecc@ecc)");
    expect(res.detail).toContain("no manual ECC rules copy found");
  });

  it("passes when only a manual project-scope copy exists", () => {
    writeManualEccCopy(root);
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("manual ECC rules copy present (project:.claude/rules/ecc)");
    expect(res.detail).toContain("no ECC plugin enabled");
  });

  it("passes when only a manual home-scope copy exists", () => {
    writeManualEccCopy(home);
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("manual ECC rules copy present (home:.claude/rules/ecc)");
  });

  it("fails when both the plugin and a project-scope manual copy are present", () => {
    writeProjectSettings({ enabledPlugins: { "ecc@ecc": true } });
    writeManualEccCopy(root);
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("fail");
    expect(res.detail).toContain("ECC plugin enabled (ecc@ecc)");
    expect(res.detail).toContain("project:.claude/rules/ecc");
    expect(res.detail).toContain("stacks duplicates");
  });

  it("fails when both the plugin and a home-scope manual copy are present", () => {
    writeProjectSettings({ enabledPlugins: { "ecc@ecc": true } });
    writeManualEccCopy(home);
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("fail");
    expect(res.detail).toContain("home:.claude/rules/ecc");
  });

  it("tolerates malformed settings.json — treated as no plugin signal, never throws", () => {
    writeProjectSettings("{ not valid json");
    writeManualEccCopy(root);
    expect(() => eccDoubleInstallCheck(ctx())).not.toThrow();
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("manual ECC rules copy present");
  });

  it("ignores a non-ecc-prefixed enabledPlugins key", () => {
    writeProjectSettings({ enabledPlugins: { "superpowers@superpowers-dev": true } });
    const res = eccDoubleInstallCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toBe("no ECC plugin enable and no manual ECC rules copy found");
  });
});

describe("eccModeExclusivityCheck", () => {
  function eccDeclaration(mode?: "lean" | "full"): BindingDeclaration {
    return {
      schemaVersion: 1,
      framework: { id: "ecc", host: "claude", ...(mode ? { mode } : {}) },
      source: {
        kind: "git",
        repository: "samartomar/ECC",
        commitSha: "c".repeat(40),
        treeDigest: SHA_A,
      },
    };
  }

  function eccLock(overrides: Partial<BindingLock> = {}): BindingLock {
    return {
      schemaVersion: 1,
      declaration: eccDeclaration("lean"),
      writes: [],
      scannedDigest: SHA_A,
      loadedDigest: SHA_A,
      match: true,
      ownership: [],
      ...overrides,
    };
  }

  function homeOwnershipEntry(target: string): BindingOwnershipEntry {
    return {
      kind: "file",
      target,
      preExisting: { absent: true },
      applied: SHA_A,
      postApplyDigest: SHA_A,
    };
  }

  it("passes when no binding lock is present", () => {
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toBe("no binding lock present — nothing to enforce");
  });

  it("passes when the bound framework is not ecc", () => {
    writeBindingLockAtomic(
      root,
      eccLock({
        declaration: {
          schemaVersion: 1,
          framework: { id: "superpowers", host: "claude" },
          source: {
            kind: "git",
            repository: "obra/superpowers",
            commitSha: "d".repeat(40),
            treeDigest: SHA_A,
          },
        },
      }),
    );
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("not ecc");
  });

  it("passes for a lean lock with no ecc@ plugin entry (matching state)", () => {
    writeBindingLockAtomic(
      root,
      eccLock({ ownership: [homeOwnershipEntry("home:.claude/rules/common")] }),
    );
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("lean mode lock with no ecc@ plugin entry");
  });

  it("fails for a lean lock when an ecc@ plugin entry is enabled", () => {
    writeBindingLockAtomic(
      root,
      eccLock({ ownership: [homeOwnershipEntry("home:.claude/rules/common")] }),
    );
    writeProjectSettings({ enabledPlugins: { "ecc@ecc": true } });
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("fail");
    expect(res.detail).toContain("lean mode lock");
    expect(res.detail).toContain("ecc@ecc");
  });

  it("passes for a full lock with an ecc@ plugin entry enabled (matching state)", () => {
    writeBindingLockAtomic(
      root,
      eccLock({
        declaration: eccDeclaration("full"),
        ownership: [homeOwnershipEntry("home:.claude/plugins/cache/ecc/ecc")],
      }),
    );
    writeProjectSettings({ enabledPlugins: { "ecc@ecc": true } });
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("full mode lock with an ecc@ plugin entry");
  });

  it("fails for a full lock with no plugin entry while lean home-scoped ownership exists", () => {
    writeBindingLockAtomic(
      root,
      eccLock({
        declaration: eccDeclaration("full"),
        ownership: [homeOwnershipEntry("home:.claude/rules/common")],
      }),
    );
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("fail");
    expect(res.detail).toContain("full mode lock");
    expect(res.detail).toContain("home:.claude/rules/common");
  });

  it("passes for a full lock with no plugin entry and no home-scoped ownership either", () => {
    writeBindingLockAtomic(root, eccLock({ declaration: eccDeclaration("full"), ownership: [] }));
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain(
      "full mode lock with no ecc@ plugin entry and no lean home-scoped ownership",
    );
  });

  it("fails with the lock's error message (not a crash) on a corrupt lock", () => {
    mkdirSync(join(root, ".aih", "binding"), { recursive: true });
    writeFileSync(join(root, ".aih", "binding", "lock.json"), "{ not valid json", "utf8");
    expect(() => eccModeExclusivityCheck(ctx())).not.toThrow();
    const res = eccModeExclusivityCheck(ctx());
    expect(res.verdict).toBe("fail");
    expect(res.detail).toContain("not valid JSON");
  });
});

describe("ECC doctor probes — determinism", () => {
  it("produce identical Check output across two consecutive runs on the same state", () => {
    writeProjectSettings({ enabledPlugins: { "ecc@ecc": true } });
    writeManualEccCopy(root);
    writeBindingLockAtomic(root, {
      schemaVersion: 1,
      declaration: {
        schemaVersion: 1,
        framework: { id: "ecc", host: "claude", mode: "lean" },
        source: {
          kind: "git",
          repository: "samartomar/ECC",
          commitSha: "c".repeat(40),
          treeDigest: SHA_A,
        },
      },
      writes: [],
      scannedDigest: SHA_A,
      loadedDigest: SHA_A,
      match: true,
      ownership: [],
    } satisfies BindingLock);

    const c = ctx();
    expect(eccDoubleInstallCheck(c)).toEqual(eccDoubleInstallCheck(c));
    expect(eccModeExclusivityCheck(c)).toEqual(eccModeExclusivityCheck(c));
  });
});

// ===========================================================================
// W7 §B — the eight binding doctor probes (B1–B8)
// ===========================================================================

const OFF_TUPLE: HostTuple = { ...SUPPORTED_HOST_TUPLE, bun: "0.0.1" };
function pinnedClone(over: Partial<HostTuple> = {}): HostTuple {
  return {
    ...SUPPORTED_HOST_TUPLE,
    ...over,
    claudeCode: { ...SUPPORTED_HOST_TUPLE.claudeCode, ...(over.claudeCode ?? {}) },
  };
}

describe("B1 — bindingContaminationCheck (posture-graded, O4)", () => {
  it("self-skips (no code) when the project is not bound", () => {
    const res = bindingContaminationCheck(ctx());
    expect(res.verdict).toBe("skip");
    expect(res.code).toBeUndefined();
  });

  it("passes on a clean home when bound", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    const res = bindingContaminationCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("no user-scope framework contamination");
  });

  it("advises (skip + code) with a countable leakage summary at vibe/team", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    seedHomeSkill("some-global-skill");
    const res = bindingContaminationCheck(ctx());
    expect(res.verdict).toBe("skip");
    expect(res.code).toBe("binding.contaminated");
    expect(res.detail).toContain("1 skills, 0 agents, 0 hooks, 0 rules, 0 plugins, 0 mcpServers");
  });

  it("fails at enterprise (posture-graded)", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    seedHomeSkill("some-global-skill");
    const res = bindingContaminationCheck(ctx({ posture: "enterprise" }));
    expect(res.verdict).toBe("fail");
    expect(res.code).toBe("binding.contaminated");
  });

  it("is deterministic across two consecutive runs", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    seedHomeSkill("skill-a");
    const c = ctx();
    expect(bindingContaminationCheck(c)).toEqual(bindingContaminationCheck(c));
  });
});

describe("B2 — bindingContextCostCheck", () => {
  it("self-skips when not bound", () => {
    expect(bindingContextCostCheck(ctx()).verdict).toBe("skip");
  });

  it("skips (no code) when bound but no .claude surface tree exists", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    const res = bindingContextCostCheck(ctx());
    expect(res.verdict).toBe("skip");
    expect(res.code).toBeUndefined();
    expect(res.detail).toContain("no project .claude surface tree");
  });

  it("passes with the evidence source + counts when a .claude tree exists", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    writeProjectFile("skills/demo/SKILL.md", "# demo skill\n");
    writeProjectFile("agents/reviewer.md", "# reviewer\n");
    const res = bindingContextCostCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("evidence source aih-estimate");
    expect(res.detail).toContain("skills 1");
    expect(res.detail).toContain("agents 1");
  });
});

describe("B3 — bindingHostTupleCheck (O5)", () => {
  it("self-skips when not bound", async () => {
    expect((await bindingHostTupleCheck(ctx(), pinnedClone())).verdict).toBe("skip");
  });

  it("passes in-tuple", async () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    const res = await bindingHostTupleCheck(ctx(), pinnedClone());
    expect(res.verdict).toBe("pass");
    expect(res.code).toBeUndefined();
    expect(res.detail).toContain("in-tuple");
  });

  it("advises version-drift (skip + code) when only the Claude Code version advanced", async () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    const res = await bindingHostTupleCheck(
      ctx(),
      pinnedClone({ claudeCode: { measuredOn: "9.9.9" } }),
    );
    expect(res.verdict).toBe("skip");
    expect(res.code).toBe("binding.host-version-drift");
  });

  it("advises off-tuple (skip + code) at vibe/team, naming mismatched facts (no raw values)", async () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    const res = await bindingHostTupleCheck(ctx(), OFF_TUPLE);
    expect(res.verdict).toBe("skip");
    expect(res.code).toBe("binding.host-off-tuple");
    expect(res.detail).toContain("bun");
    expect(res.detail).not.toContain("0.0.1"); // the raw measured value never leaks
  });

  it("fails off-tuple at enterprise (posture-graded)", async () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    const res = await bindingHostTupleCheck(ctx({ posture: "enterprise" }), OFF_TUPLE);
    expect(res.verdict).toBe("fail");
    expect(res.code).toBe("binding.host-off-tuple");
  });

  it("is deterministic across two runs (injected measurement)", async () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    const c = ctx();
    expect(await bindingHostTupleCheck(c, OFF_TUPLE)).toEqual(
      await bindingHostTupleCheck(c, OFF_TUPLE),
    );
  });
});

describe("B4 — bindingFrameworkDriftCheck (D8)", () => {
  it("self-skips when not bound", () => {
    expect(bindingFrameworkDriftCheck(ctx()).verdict).toBe("skip");
  });

  it("passes with exactly one methodology framework live", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    const res = bindingFrameworkDriftCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("ecc");
  });

  it("fails when a competing framework surface is live (>1 framework)", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    seedHomeSkill("superpowers-helper"); // substring-attributed to superpowers
    const res = bindingFrameworkDriftCheck(ctx());
    expect(res.verdict).toBe("fail");
    expect(res.code).toBe("binding.framework-drift");
    expect(res.detail).toContain("ecc");
    expect(res.detail).toContain("superpowers");
  });

  it("reports a diagnosable no-adapter finding (never throws) for a framework absent from the registry", () => {
    // A registry constructed WITHOUT the ecc adapter — robust to gsd-core leaving FRAMEWORK_IDS (#491).
    const registry = new AdapterRegistry();
    registry.register(
      createFakeAdapter({
        framework: "superpowers",
        adapterType: "host-plugin",
        resolved: {
          kind: "git",
          repository: "obra/superpowers",
          commitSha: "d".repeat(40),
          treeDigest: SHA_B,
          treePath: root,
        },
      }),
    );
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    let res: Check | undefined;
    expect(() => {
      res = bindingFrameworkDriftCheck(ctx(), { adapterFrameworks: registry.frameworks() });
    }).not.toThrow();
    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBe("binding.no-adapter");
    expect(res?.detail).toContain("ecc");
  });
});

describe("B5 — bindingDenyListFreshnessCheck (self-skips off-gstack)", () => {
  const GSTACK_SOURCE: BindingSource = {
    kind: "git",
    repository: "aih/gstack",
    commitSha: "e".repeat(40),
    treeDigest: GSTACK_PIN_TREE_DIGEST,
  };

  it("self-skips when not bound", () => {
    expect(bindingDenyListFreshnessCheck(ctx()).verdict).toBe("skip");
  });

  it("self-skips cleanly (no code) when the bound framework is not gstack", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    const res = bindingDenyListFreshnessCheck(ctx());
    expect(res.verdict).toBe("skip");
    expect(res.code).toBeUndefined();
    expect(res.detail).toContain("not gstack");
  });

  it("fails when a pinned skill is no longer denied (stale deny list)", () => {
    bind("gstack", GSTACK_SOURCE);
    const res = bindingDenyListFreshnessCheck(ctx());
    expect(res.verdict).toBe("fail");
    expect(res.code).toBe("binding.deny-stale");
  });

  it("passes with a fresh compare when every pinned skill is denied", () => {
    bind("gstack", GSTACK_SOURCE);
    const overrides = Object.fromEntries(
      GSTACK_PINNED_SKILL_INVENTORY.names.map((n) => [n, "off"]),
    );
    writeProjectFile(
      "settings.json",
      `${JSON.stringify({ skillOverrides: overrides }, null, 2)}\n`,
    );
    const res = bindingDenyListFreshnessCheck(ctx());
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("all");
    expect(res.detail).toContain("fresh: true"); // lock treeDigest === pinned inventory sourceDigest
  });
});

describe("B6 — bindingHookChainChecks", () => {
  it("self-skips (single skip check) when not bound", () => {
    const checks = bindingHookChainChecks(ctx());
    expect(checks).toHaveLength(1);
    expect(checks[0]?.verdict).toBe("skip");
  });

  it("returns a single pass when there are no hooks", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    const checks = bindingHookChainChecks(ctx());
    expect(checks).toHaveLength(1);
    expect(checks[0]?.verdict).toBe("pass");
  });

  it("lists per-event entries (skip + code) with PATH-FREE origins across home + project", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    writeProjectFile(
      "settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "node C:\\tools\\hook.mjs" }] },
          ],
        },
      }),
    );
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "ecc-init" }] }] } }),
      "utf8",
    );
    const checks = bindingHookChainChecks(ctx());
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.verdict === "skip" && c.code === "binding.hook-chain")).toBe(true);
    const detailAll = checks.map((c) => c.detail).join("\n");
    expect(detailAll).not.toContain("C:\\"); // the raw absolute command path never leaks
    expect(detailAll).toContain("origin=node"); // "node C:\\tools\\hook.mjs" -> argv0 basename "node"
    expect(detailAll).toContain("scope=project");
    expect(detailAll).toContain("scope=home");
  });

  it("is deterministic across two runs (sorted)", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    writeProjectFile(
      "settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ command: "b-cmd" }, { command: "a-cmd" }] }],
        },
      }),
    );
    const c = ctx();
    expect(bindingHookChainChecks(c)).toEqual(bindingHookChainChecks(c));
  });
});

describe("B7 — bindingSettingsDriftCheck + readClaudeSettingsDrift purity (D18)", () => {
  const OWNED: BindingOwnershipEntry = {
    kind: "json-pointer",
    target: `${CLAUDE_SETTINGS_PATH}#/model`,
    preExisting: { absent: true },
    applied: "aih-value",
    postApplyDigest: "b".repeat(64),
  };

  it("self-skips when no binding lock present", () => {
    expect(bindingSettingsDriftCheck(ctx()).verdict).toBe("skip");
  });

  it("passes when no owned value drifted", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean", ownership: [OWNED] });
    writeProjectFile("settings.json", JSON.stringify({ model: "aih-value" }));
    expect(bindingSettingsDriftCheck(ctx()).verdict).toBe("pass");
  });

  it("advises (skip + code) when an owned value drifted, preserving it", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean", ownership: [OWNED] });
    writeProjectFile("settings.json", JSON.stringify({ model: "user-edited" }));
    const res = bindingSettingsDriftCheck(ctx());
    expect(res.verdict).toBe("skip");
    expect(res.code).toBe("binding.settings-drift");
    expect(res.detail).toContain(".claude/settings.json#/model");
  });

  it("pure readClaudeSettingsDrift output equals planClaudeRemoval drift (§D.2)", () => {
    const lock = bind("ecc", ECC_SOURCE, { mode: "lean", ownership: [OWNED] });
    writeProjectFile("settings.json", JSON.stringify({ model: "user-edited" }));
    const pure = readClaudeSettingsDrift(root, lock);
    expect(pure).toHaveLength(1);
    expect(pure).toEqual(planClaudeRemoval(root, lock).drift);
  });
});

describe("B8 — bindingMcpInventoryCheck", () => {
  it("self-skips when not bound", () => {
    expect(bindingMcpInventoryCheck(ctx()).verdict).toBe("skip");
  });

  it("passes when no MCP servers are declared", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    expect(bindingMcpInventoryCheck(ctx()).verdict).toBe("pass");
  });

  it("lists sorted, deduped server ids across project + home (skip + code)", () => {
    bind("ecc", ECC_SOURCE, { mode: "lean" });
    writeProjectFile("settings.json", JSON.stringify({ mcpServers: { zeta: {}, alpha: {} } }));
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, ".mcp.json"),
      JSON.stringify({ mcpServers: { alpha: {}, mid: {} } }),
      "utf8",
    );
    const res = bindingMcpInventoryCheck(ctx());
    expect(res.verdict).toBe("skip");
    expect(res.code).toBe("binding.mcp-inventory");
    expect(res.detail).toContain("alpha, mid, zeta"); // sorted union, alpha deduped
  });
});

describe("collectHookChain (B6 primitive)", () => {
  it("captures matcher + scope across home/project/local layers; tolerates malformed layers", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "home-hook" }] }] } }),
      "utf8",
    );
    writeProjectFile(
      "settings.json",
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "proj-hook" }] }] },
      }),
    );
    writeProjectFile("settings.local.json", "{ not valid json"); // malformed local layer is skipped
    const chain = collectHookChain({ home, projectRoot: root });
    expect(chain).toHaveLength(2);
    const proj = chain.find((e) => e.scope === "project");
    expect(proj?.matcher).toBe("Bash");
    expect(proj?.origin).toBe("proj-hook");
    expect(chain.find((e) => e.scope === "home")?.matcher).toBeUndefined();
  });
});

// -- W7 exit criterion: the FULL doctor plan is byte-identical across two runs --

describe("W7 exit criterion — doctor determinism over the committed fixture pair", () => {
  async function collectChecks(builtPlan: Plan, planCtx: PlanContext): Promise<Check[]> {
    const out: Check[] = [];
    for (const action of builtPlan.actions as Action[]) {
      if (action.kind !== "probe") continue;
      if (action.runMany) out.push(...(await action.runMany(planCtx)));
      else out.push(await action.run(planCtx));
    }
    return out;
  }

  async function serializeDoctorTwice(fixtureRoot: string): Promise<void> {
    const emptyHome = mkdtempSync(join(tmpdir(), "aih-doctor-home-"));
    try {
      const run = fakeRunner(() => undefined);
      const env = { HOME: emptyHome, USERPROFILE: emptyHome };
      const planCtx: PlanContext = {
        root: fixtureRoot,
        contextDir: "ai-coding",
        apply: false,
        verify: true,
        json: false,
        run,
        host: makeHostAdapter({ platform: "linux", run, env }),
        env,
        options: {},
      };
      const first = new VerificationReport();
      for (const c of await collectChecks(await doctorCommand.plan(planCtx), planCtx)) first.add(c);
      const second = new VerificationReport();
      for (const c of await collectChecks(await doctorCommand.plan(planCtx), planCtx))
        second.add(c);
      // The whole report, serialized, must be byte-for-byte identical.
      expect(JSON.stringify(first.toJSON())).toBe(JSON.stringify(second.toJSON()));
      // And a binding probe must actually have run against the bound fixture.
      expect(first.checks.some((c) => c.name.startsWith("binding "))).toBe(true);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  }

  const fixtures = join(process.cwd(), "tests", "fixtures", "binding", "doctor");

  it("project-a (ECC-bound) serializes byte-identically across two consecutive runs", async () => {
    await serializeDoctorTwice(join(fixtures, "project-a"));
  });

  it("project-b (Superpowers-bound) serializes byte-identically across two consecutive runs", async () => {
    await serializeDoctorTwice(join(fixtures, "project-b"));
  });
});

// ===========================================================================
// DoctorCardInput wiring (design §A.3.3) — cardDoctorInputFromChecks
// ===========================================================================

describe("cardDoctorInputFromChecks (§A.3.3)", () => {
  it("derives {contaminationClean, inTuple} from the B1/B3 stable codes, never from detail", () => {
    const clean: Check[] = [
      {
        name: "binding contamination",
        verdict: "pass",
        detail: "no user-scope framework contamination",
      },
      {
        name: "binding host tuple",
        verdict: "pass",
        detail: "host in-tuple — all hard facts match",
      },
    ];
    expect(cardDoctorInputFromChecks(clean)).toEqual({ contaminationClean: true, inTuple: true });

    // B1 contamination (advisory skip at vibe/team OR fail at enterprise) both carry the code.
    const contaminated: Check[] = [
      {
        name: "binding contamination",
        verdict: "skip",
        code: "binding.contaminated",
        detail: "1 skills, 0 agents, 0 hooks, 0 rules, 0 plugins, 0 mcpServers (advisory)",
      },
    ];
    expect(cardDoctorInputFromChecks(contaminated)).toEqual({
      contaminationClean: false,
      inTuple: true,
    });

    // B3 off-tuple downgrades inTuple.
    const offTuple: Check[] = [
      {
        name: "binding host tuple",
        verdict: "fail",
        code: "binding.host-off-tuple",
        detail: "host off-tuple — hard facts differ: ram-class",
      },
    ];
    expect(cardDoctorInputFromChecks(offTuple)).toEqual({
      contaminationClean: true,
      inTuple: false,
    });
  });

  it("treats B3 version-drift as still in-tuple for the card (facts held; only provenance advanced)", () => {
    const drift: Check[] = [
      {
        name: "binding host tuple",
        verdict: "skip",
        code: "binding.host-version-drift",
        detail: "Claude Code version advanced; hard facts re-measured and held",
      },
    ];
    expect(cardDoctorInputFromChecks(drift)).toEqual({ contaminationClean: true, inTuple: true });
  });

  it("an empty check set is clean+in-tuple (a clean doctor is necessary, not sufficient, for STRICT)", () => {
    expect(cardDoctorInputFromChecks([])).toEqual({ contaminationClean: true, inTuple: true });
  });
});
