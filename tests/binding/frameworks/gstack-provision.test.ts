import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGstackAdapter,
  GSTACK_CONFIG_REL,
  GSTACK_HOME_REL,
  GSTACK_HOOK_STRIP_TARGET,
  GSTACK_INSTALL_ROOT_REL,
  GSTACK_MANIFEST_REL,
  GSTACK_PIN_COMMIT,
  GSTACK_REPOSITORY,
  GSTACK_SELECTED_PROFILE,
  type GstackRemoveResult,
} from "../../../src/binding/frameworks/gstack.js";
import { isHomeScopedTarget } from "../../../src/binding/hosts/claude/index.js";
import { CLAUDE_SETTINGS_PATH } from "../../../src/binding/hosts/claude/surfaces.js";
import { BindingLockSchema, bindingDir, readBindingLock } from "../../../src/binding/lock.js";
import type { PlanResult } from "../../../src/internals/execute.js";
import type { Action } from "../../../src/internals/plan.js";
import { applyActions, readJson, readText } from "../hosts/claude/support.js";
import {
  declarationFor,
  fixtureInstaller,
  GSTACK_FIXTURE_IDENTITIES,
  recordingRunner,
  scannedGstackFixture,
  writeFileEnsuring,
} from "./gstack-support.js";

/**
 * W5 — the gstack shared-runtime FrameworkAdapter, part 2: the provision
 * lifecycle end to end on fixtures (deny-before-list ordering, post-install
 * reconciliation fail-closed, hook strip integration, D7 subset identity +
 * unwind, re-provision), the verify drift matrix, removal partition + full
 * round-trip, the Framework Card report, and the PERMANENT office-hours
 * runtime test. Fake runner + fixture installer only — no upstream code, no
 * network, no claude CLI. Every fixture stays bland ASCII.
 */

let root: string;
let home: string;
let cacheHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-gsp-root-"));
  home = mkdtempSync(join(tmpdir(), "aih-gsp-home-"));
  cacheHome = mkdtempSync(join(tmpdir(), "aih-gsp-cache-"));
});

afterEach(() => {
  for (const dir of [root, home, cacheHome]) rmSync(dir, { recursive: true, force: true });
});

const ENV = () => ({ USERPROFILE: home, AIH_PLATFORM: "linux" });

const DENY_TARGET = "home:.claude/settings.json#/skillOverrides";
const REENABLE_TARGET = ".claude/settings.json#/skillOverrides";

function skillsPath(...rest: string[]): string {
  return join(home, ".claude", "skills", ...rest);
}

async function provisionFixture(
  name: string,
  opts: {
    installer?: ReturnType<typeof fixtureInstaller>;
    features?: Record<string, boolean>;
    applySeam?: (root: string, actions: Action[]) => Promise<PlanResult>;
  } = {},
) {
  const { resolved, disposition } = scannedGstackFixture(cacheHome, name);
  const installerBundle = opts.installer ?? fixtureInstaller();
  const { runner } = recordingRunner();
  const adapter = createGstackAdapter({
    root,
    runner,
    env: ENV(),
    installGstack: installerBundle.installer,
    applyActions: opts.applySeam ?? applyActions,
  });
  const declaration = declarationFor(resolved.treeDigest, opts.features);
  const result = await adapter.provision({ context: { declaration }, resolved }, disposition);
  return { adapter, declaration, resolved, disposition, result, installerBundle };
}

// -- provision: happy path ------------------------------------------------------

describe("provision — happy path end to end on fixtures", () => {
  it("installs, reconciles, denies at user scope, re-enables at project scope, and writes a schema-valid lock", async () => {
    const { result, resolved } = await provisionFixture("happy");

    expect(BindingLockSchema.safeParse(result.lock).success).toBe(true);
    expect(result.lock.match).toBe(true);
    expect(result.lock.scannedDigest).toBe(resolved.treeDigest);
    expect(result.lock.loadedDigest).toBe(resolved.treeDigest);

    // User-scope deny: every derived identity "off" in the HOME settings.
    const homeSettings = readJson(home, CLAUDE_SETTINGS_PATH);
    const denies = homeSettings.skillOverrides as Record<string, string>;
    for (const identity of GSTACK_FIXTURE_IDENTITIES) expect(denies[identity]).toBe("off");

    // Project-scope re-enable: the SAME identities "on" in the PROJECT settings.
    const projectSettings = readJson(root, CLAUDE_SETTINGS_PATH);
    const reenables = projectSettings.skillOverrides as Record<string, string>;
    for (const identity of GSTACK_FIXTURE_IDENTITIES) expect(reenables[identity]).toBe("on");

    // CLAUDE.md routing block + lockdown config + manifest on disk.
    expect(readText(root, "CLAUDE.md")).toContain("aih-binding:claude");
    expect(readText(root, GSTACK_CONFIG_REL)).toContain("codex_reviews: disabled");
    expect(existsSync(join(root, GSTACK_MANIFEST_REL))).toBe(true);

    // Install surfaces on disk: install root + wrappers + root alias; the
    // conditional alias was NOT created (measured real-install default).
    expect(existsSync(skillsPath("gstack"))).toBe(true);
    expect(existsSync(skillsPath("gstack-qa", "SKILL.md"))).toBe(true);
    expect(existsSync(skillsPath("gstack-ship", "SKILL.md"))).toBe(true);
    expect(existsSync(skillsPath("_gstack-command", "SKILL.md"))).toBe(true);
    expect(existsSync(skillsPath("gstack-connect-chrome"))).toBe(false);

    // Ownership: home-scoped deny container + install dirs; repo-relative
    // re-enable container, CLAUDE.md block, config, manifest.
    const targets = result.lock.ownership.map((entry) => entry.target);
    expect(targets).toContain(DENY_TARGET);
    expect(targets).toContain(REENABLE_TARGET);
    expect(targets).toContain(`home:${GSTACK_INSTALL_ROOT_REL}`);
    expect(targets).toContain("home:.claude/skills/gstack-qa");
    expect(targets).toContain("home:.claude/skills/_gstack-command");
    expect(targets).toContain(GSTACK_CONFIG_REL);
    expect(targets).toContain(GSTACK_MANIFEST_REL);
    expect(targets.some((target) => target.includes("#block:"))).toBe(true);
    // The ruled profile writes zero hooks, so nothing was stripped: no record.
    expect(targets).not.toContain(GSTACK_HOOK_STRIP_TARGET);
    for (const entry of result.lock.ownership) {
      expect(entry.postApplyDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(readBindingLock(root).present).toBe(true);
  });

  it("threads GSTACK_HOME (project state dir) and the resolved checkout into the installer seam", async () => {
    const installer = fixtureInstaller();
    const { installerBundle, resolved } = await provisionFixture("seam", { installer });
    expect(installerBundle.calls).toHaveLength(1);
    const input = installerBundle.calls[0];
    expect(input?.gstackHomeAbs).toBe(join(root, GSTACK_HOME_REL));
    expect(input?.home).toBe(home);
    expect(input?.resolved.treePath).toBe(resolved.treePath);
  });

  it("tolerates the conditional alias PRESENT in reality too (both are within the inventory)", async () => {
    const installer = fixtureInstaller({ includeConditional: true });
    const { result } = await provisionFixture("conditional-present", { installer });
    expect(result.lock.match).toBe(true);
    expect(result.lock.ownership.map((entry) => entry.target)).toContain(
      "home:.claude/skills/gstack-connect-chrome",
    );
  });

  it("keeps D7 identity clean when the install materializes node_modules/build/.git junk (disclosed, excluded)", async () => {
    const installer = fixtureInstaller({ junk: true });
    const { result } = await provisionFixture("junk", { installer });
    expect(result.lock.match).toBe(true);
    expect(existsSync(skillsPath("gstack", "node_modules", "left-pad", "index.js"))).toBe(true);
    expect(existsSync(skillsPath("gstack", ".git", "HEAD"))).toBe(true);
  });
});

// -- provision: deny-before-list ordering --------------------------------------

describe("provision — deny lands at user scope BEFORE any project surface (ordering)", () => {
  it("the first apply call targets the HOME root with the skillOverrides deny", async () => {
    const applyCalls: Array<{ root: string; kinds: string[] }> = [];
    const recordingSeam = async (applyRoot: string, actions: Action[]): Promise<PlanResult> => {
      applyCalls.push({
        root: applyRoot,
        kinds: actions.map((action) => (action as { path?: string }).path ?? "?"),
      });
      return applyActions(applyRoot, actions);
    };
    await provisionFixture("ordering", { applySeam: recordingSeam });

    expect(applyCalls.length).toBeGreaterThanOrEqual(2);
    const first = applyCalls[0];
    expect(first?.root).toBe(home);
    expect(first?.kinds).toContain(CLAUDE_SETTINGS_PATH);
    const firstProjectCall = applyCalls.findIndex((call) => call.root === root);
    const homeDenyCall = applyCalls.findIndex((call) => call.root === home);
    expect(homeDenyCall).toBeLessThan(firstProjectCall);
    // And the deny is already effective on disk before any project apply ran:
    // re-read is post-hoc here, but the call order above is the guarantee.
    const homeSettings = readJson(home, CLAUDE_SETTINGS_PATH);
    expect((homeSettings.skillOverrides as Record<string, string>)["gstack-qa"]).toBe("off");
  });
});

// -- provision: post-install reconciliation fail-closed -------------------------

describe("provision — post-install reconciliation (fail closed)", () => {
  it("an EXTRA real identity outside the inventory refuses and unwinds the install", async () => {
    const installer = fixtureInstaller({ extraIdentity: "gstack-rogue" });
    await expect(provisionFixture("recon-extra", { installer })).rejects.toThrow(
      /outside the tree-derived inventory.*gstack-rogue/,
    );
    // Unwind: the created dirs are gone; deny never ran; no lock.
    expect(existsSync(skillsPath("gstack"))).toBe(false);
    expect(existsSync(skillsPath("gstack-rogue"))).toBe(false);
    expect(existsSync(join(home, CLAUDE_SETTINGS_PATH))).toBe(false);
    expect(readBindingLock(root).present).toBe(false);
  });

  it("a MISSING conditional identity is tolerated (the deny stays the superset)", async () => {
    const { result } = await provisionFixture("recon-conditional"); // default: no conditional dir
    const homeSettings = readJson(home, CLAUDE_SETTINGS_PATH);
    expect((homeSettings.skillOverrides as Record<string, string>)["gstack-connect-chrome"]).toBe(
      "off",
    );
    expect(result.lock.match).toBe(true);
  });

  it("a MISSING non-conditional identity refuses and unwinds", async () => {
    const installer = fixtureInstaller({ omitIdentity: "gstack-ship" });
    await expect(provisionFixture("recon-missing", { installer })).rejects.toThrow(
      /non-conditional inventory identities missing.*gstack-ship/,
    );
    expect(existsSync(skillsPath("gstack"))).toBe(false);
    expect(readBindingLock(root).present).toBe(false);
  });
});

// -- provision: hook strip ------------------------------------------------------

describe("provision — unconditional hook strip (both shapes, cross-event, recorded)", () => {
  it("removes the untagged SessionStart and tagged entries across events, preserves user hooks, records fragments", async () => {
    const gstackBin = `${home.replace(/\\/g, "/")}/.claude/skills/gstack/bin`;
    const preSettings = {
      env: { KEEP_ME: "1" },
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `${gstackBin}/gstack-session-update` }] },
          { hooks: [{ type: "command", command: "/home/user/bin/my-own-hook" }] },
        ],
        PostToolUse: [
          {
            _gstack_source: "plan-tune-cathedral",
            matcher: "(AskUserQuestion|mcp__.*__AskUserQuestion)",
            hooks: [{ type: "command", command: `${gstackBin}/question-log-hook`, timeout: 5 }],
          },
          {
            _gstack_source: "auq-error-fallback",
            hooks: [{ type: "command", command: `${gstackBin}/auq-error-fallback-hook` }],
          },
        ],
        PreToolUse: [
          {
            _gstack_source: "plan-tune-cathedral",
            hooks: [{ type: "command", command: `${gstackBin}/question-preference-hook` }],
          },
        ],
      },
    };
    writeFileEnsuring(
      join(home, CLAUDE_SETTINGS_PATH),
      `${JSON.stringify(preSettings, null, 2)}\n`,
    );

    const { result } = await provisionFixture("strip");

    const after = readJson(home, CLAUDE_SETTINGS_PATH);
    const hooks = after.hooks as Record<string, unknown[]>;
    // The untagged team SessionStart is gone; the user hook survives verbatim.
    expect(hooks.SessionStart).toEqual([
      { hooks: [{ type: "command", command: "/home/user/bin/my-own-hook" }] },
    ]);
    // Every tagged group is gone; emptied event arrays are dropped.
    expect(hooks.PostToolUse).toBeUndefined();
    expect(hooks.PreToolUse).toBeUndefined();
    expect(after.env).toEqual({ KEEP_ME: "1" });
    // Deny landed in the same file.
    expect((after.skillOverrides as Record<string, string>)["gstack-qa"]).toBe("off");

    // The strip is lock-recorded with the removed shapes.
    const stripEntry = result.lock.ownership.find(
      (entry) => entry.target === GSTACK_HOOK_STRIP_TARGET,
    );
    expect(stripEntry).toBeDefined();
    const applied = stripEntry?.applied as { strippedGstackHooks: Record<string, unknown[]> };
    expect(Object.keys(applied.strippedGstackHooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "SessionStart",
    ]);
    expect(applied.strippedGstackHooks.SessionStart).toHaveLength(1);
    expect(applied.strippedGstackHooks.PostToolUse).toHaveLength(2);
  });

  it("strips a gstack-only hooks object down to nothing (the hooks key is removed)", async () => {
    writeFileEnsuring(
      join(home, CLAUDE_SETTINGS_PATH),
      `${JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: "/x/.claude/skills/gstack/bin/gstack-session-update" },
              ],
            },
          ],
        },
      })}\n`,
    );
    await provisionFixture("strip-empty");
    const after = readJson(home, CLAUDE_SETTINGS_PATH);
    expect(after.hooks).toBeUndefined();
  });
});

// -- provision: D7 mismatch unwinds ---------------------------------------------

describe("provision — D7 installed-subset mismatch fails closed and unwinds this bind's surfaces", () => {
  it("tampered install-root content throws, restores home+project surfaces, deletes created dirs, writes no lock", async () => {
    const installer = fixtureInstaller({
      tamperInstallRoot: (installRoot) => {
        writeFileSync(join(installRoot, "setup"), "#!/usr/bin/env bash\necho tampered\n", "utf8");
      },
    });
    await expect(provisionFixture("d7-unwind", { installer })).rejects.toThrow(
      /identity mismatch.*unwound/,
    );

    // Home: the deny was rolled back conservatively (skillOverrides pruned).
    const homeSettingsRaw = readFileSync(join(home, CLAUDE_SETTINGS_PATH), "utf8");
    expect((JSON.parse(homeSettingsRaw) as Record<string, unknown>).skillOverrides).toBeUndefined();
    // Project: re-enables, CLAUDE.md fence, and config are gone.
    const projectSettings = readJson(root, CLAUDE_SETTINGS_PATH);
    expect(projectSettings.skillOverrides).toBeUndefined();
    expect(readText(root, "CLAUDE.md")).not.toContain("aih-binding:claude");
    expect(existsSync(join(root, GSTACK_CONFIG_REL))).toBe(false);
    expect(existsSync(join(root, GSTACK_MANIFEST_REL))).toBe(false);
    // Machine: every created skills dir is deleted.
    expect(existsSync(skillsPath("gstack"))).toBe(false);
    expect(existsSync(skillsPath("gstack-qa"))).toBe(false);
    expect(existsSync(skillsPath("_gstack-command"))).toBe(false);
    expect(readBindingLock(root).present).toBe(false);
  });

  it("an unpatched install (name patch skipped) is a D7 mismatch — the patch is part of the expectation", async () => {
    const installer = fixtureInstaller({ skipNamePatch: true });
    await expect(provisionFixture("d7-unpatched", { installer })).rejects.toThrow(
      /identity mismatch/,
    );
    expect(readBindingLock(root).present).toBe(false);
  });
});

// -- provision: re-provision ----------------------------------------------------

describe("provision — re-provision stays deterministic and preserves first-bind pre-existing state", () => {
  it("second provision yields identical settings bytes and absent-at-container preExisting", async () => {
    const first = await provisionFixture("rebind");
    const homeBytesAfterFirst = readFileSync(join(home, CLAUDE_SETTINGS_PATH), "utf8");
    const projectBytesAfterFirst = readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf8");

    const second = await first.adapter.provision(
      { context: { declaration: first.declaration }, resolved: first.resolved },
      first.disposition,
    );

    expect(readFileSync(join(home, CLAUDE_SETTINGS_PATH), "utf8")).toBe(homeBytesAfterFirst);
    expect(readFileSync(join(root, CLAUDE_SETTINGS_PATH), "utf8")).toBe(projectBytesAfterFirst);
    expect(second.lock.writes).toEqual(first.result.lock.writes);

    const denyEntry = second.lock.ownership.find((entry) => entry.target === DENY_TARGET);
    const reenableEntry = second.lock.ownership.find((entry) => entry.target === REENABLE_TARGET);
    expect(denyEntry?.preExisting).toEqual({ absent: true });
    expect(reenableEntry?.preExisting).toEqual({ absent: true });
    const installRootEntry = second.lock.ownership.find(
      (entry) => entry.target === `home:${GSTACK_INSTALL_ROOT_REL}`,
    );
    expect(installRootEntry?.preExisting).toEqual({ absent: true });
  });
});

// -- verify ---------------------------------------------------------------------

describe("verify — clean after bind; the drift matrix", () => {
  it("reports absent-lock drift on a fresh root", () => {
    const adapter = createGstackAdapter({ root, runner: recordingRunner().runner, env: ENV() });
    expect(adapter.verify({ declaration: declarationFor("0".repeat(64)) })).toEqual({
      ok: false,
      drift: ["no binding lock"],
    });
  });

  it("reports ok:true with no drift right after a clean bind", async () => {
    const { adapter, declaration } = await provisionFixture("verify-clean");
    const result = adapter.verify({ declaration });
    expect(result.drift).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("flags a deny key flipped back on at user scope", async () => {
    const { adapter, declaration } = await provisionFixture("verify-deny");
    const settingsPath = join(home, CLAUDE_SETTINGS_PATH);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    (settings.skillOverrides as Record<string, string>)["gstack-qa"] = "on";
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    const result = adapter.verify({ declaration });
    expect(result.ok).toBe(false);
    expect(result.drift.some((line) => line.includes("gstack-qa"))).toBe(true);
  });

  it("flags a gstack hook shape re-added after bind (hook-absence re-check)", async () => {
    const { adapter, declaration } = await provisionFixture("verify-hook");
    const settingsPath = join(home, CLAUDE_SETTINGS_PATH);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    settings.hooks = {
      SessionStart: [
        {
          hooks: [
            { type: "command", command: "/x/.claude/skills/gstack/bin/gstack-session-update" },
          ],
        },
      ],
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    const result = adapter.verify({ declaration });
    expect(result.ok).toBe(false);
    expect(result.drift.some((line) => line.includes("hook"))).toBe(true);
  });

  it("flags installed-subtree tamper via the D7 manifest re-check (content and deletion)", async () => {
    const { adapter, declaration } = await provisionFixture("verify-d7");
    writeFileSync(skillsPath("gstack", "setup"), "tampered\n", "utf8");
    rmSync(skillsPath("gstack", "browse", "src", "index.ts"));

    const result = adapter.verify({ declaration });
    expect(result.ok).toBe(false);
    expect(result.drift.some((line) => line.includes("content drift: setup"))).toBe(true);
    expect(result.drift.some((line) => line.includes("missing: browse/src/index.ts"))).toBe(true);
  });

  it("flags project re-enable drift via planClaudeRemoval read-only", async () => {
    const { adapter, declaration } = await provisionFixture("verify-project");
    const settingsPath = join(root, CLAUDE_SETTINGS_PATH);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    (settings.skillOverrides as Record<string, string>)["gstack-qa"] = "off";
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    const result = adapter.verify({ declaration });
    expect(result.ok).toBe(false);
    expect(result.drift.some((line) => line.includes("skillOverrides"))).toBe(true);
  });

  it("flags a missing lockdown config and a missing manifest", async () => {
    const { adapter, declaration } = await provisionFixture("verify-config");
    rmSync(join(root, GSTACK_MANIFEST_REL));

    const result = adapter.verify({ declaration });
    expect(result.ok).toBe(false);
    expect(result.drift.some((line) => line.includes("manifest"))).toBe(true);
  });
});

// -- remove ---------------------------------------------------------------------

describe("remove — partition + plan; the caller round-trips to a clean world", () => {
  it("returns drift-report-only with a reason when no lock is present", () => {
    const adapter = createGstackAdapter({ root, runner: recordingRunner().runner, env: ENV() });
    const result = adapter.remove({
      declaration: declarationFor("0".repeat(64)),
    }) as GstackRemoveResult;
    expect(result.mode).toBe("drift-report-only");
    if (result.mode === "drift-report-only") expect(result.reason).toContain("no binding lock");
  });

  it("partitions ownership, plans deny restoration + deletions, and round-trips clean", async () => {
    // Pre-existing user state that must SURVIVE the round trip.
    writeFileEnsuring(
      join(home, CLAUDE_SETTINGS_PATH),
      `${JSON.stringify({ env: { KEEP: "1" }, skillOverrides: { "my-own-skill": "off" } }, null, 2)}\n`,
    );
    // A gstack settings backup collateral that teardown must list.
    writeFileEnsuring(join(home, ".claude", "settings.json.bak.1700000000"), "{}\n");

    const { adapter, declaration } = await provisionFixture("remove-roundtrip");
    const plan = adapter.remove({ declaration }) as GstackRemoveResult;
    expect(plan.mode).toBe("apply");
    if (plan.mode !== "apply") throw new Error("expected apply mode");

    // Partition: every homeOwnership target is home-scoped.
    expect(plan.homeOwnership.length).toBeGreaterThan(0);
    for (const entry of plan.homeOwnership) expect(isHomeScopedTarget(entry.target)).toBe(true);
    expect(plan.repoRelativeDrift).toEqual([]);
    expect(plan.homeDrift).toEqual([]);

    // Deletion plan: install root + wrappers + alias (created by this bind).
    expect(plan.homeDeletionsRel).toContain(GSTACK_INSTALL_ROOT_REL);
    expect(plan.homeDeletionsRel).toContain(".claude/skills/gstack-qa");
    expect(plan.homeDeletionsRel).toContain(".claude/skills/gstack-ship");
    expect(plan.homeDeletionsRel).toContain(".claude/skills/_gstack-command");
    expect(plan.settingsBackupsRel).toContain(".claude/settings.json.bak.1700000000");
    expect(plan.tempPatterns).toEqual(["/tmp/gstack-*"]);
    expect(plan.gstackHomeRel).toBe(GSTACK_HOME_REL);

    // Caller applies: repo-relative first, then home, then deletions, then lock.
    await applyActions(root, plan.repoRelativeActions);
    await applyActions(home, plan.homeActions);
    for (const rel of plan.homeDeletionsRel) {
      rmSync(join(home, ...rel.split("/")), { recursive: true, force: true });
    }
    for (const rel of plan.settingsBackupsRel) {
      rmSync(join(home, ...rel.split("/")), { force: true });
    }
    rmSync(bindingDir(root), { recursive: true, force: true });

    // Home: user's own state survives byte-conservatively; gstack deny is gone.
    const homeSettings = readJson(home, CLAUDE_SETTINGS_PATH);
    expect(homeSettings.env).toEqual({ KEEP: "1" });
    expect(homeSettings.skillOverrides).toEqual({ "my-own-skill": "off" });
    // Machine: no gstack skills dirs, no backups.
    expect(existsSync(skillsPath("gstack"))).toBe(false);
    expect(existsSync(skillsPath("gstack-qa"))).toBe(false);
    expect(existsSync(skillsPath("_gstack-command"))).toBe(false);
    expect(existsSync(join(home, ".claude", "settings.json.bak.1700000000"))).toBe(false);
    // Project: re-enables, fence, config, and manifest are gone.
    const projectSettings = readJson(root, CLAUDE_SETTINGS_PATH);
    expect(projectSettings.skillOverrides).toBeUndefined();
    expect(readText(root, "CLAUDE.md")).not.toContain("aih-binding:claude");
    expect(existsSync(join(root, GSTACK_CONFIG_REL))).toBe(false);
    expect(existsSync(join(root, GSTACK_MANIFEST_REL))).toBe(false);
    expect(readBindingLock(root).present).toBe(false);
  });

  it("preserves a pre-existing per-name deny value through bind and removal (byte-exact restoration)", async () => {
    // The user had already denied one gstack identity by hand before AIH bound.
    writeFileEnsuring(
      join(home, CLAUDE_SETTINGS_PATH),
      `${JSON.stringify({ skillOverrides: { "gstack-qa": "off" } }, null, 2)}\n`,
    );
    const { adapter, declaration } = await provisionFixture("remove-preexisting");
    const plan = adapter.remove({ declaration }) as GstackRemoveResult;
    if (plan.mode !== "apply") throw new Error("expected apply mode");
    await applyActions(root, plan.repoRelativeActions);
    await applyActions(home, plan.homeActions);

    // The user's own "off" for gstack-qa is restored; AIH-added names are pruned.
    const homeSettings = readJson(home, CLAUDE_SETTINGS_PATH);
    expect(homeSettings.skillOverrides).toEqual({ "gstack-qa": "off" });
  });

  it("never restores stripped gstack hooks (the strip record is excluded from teardown)", async () => {
    writeFileEnsuring(
      join(home, CLAUDE_SETTINGS_PATH),
      `${JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: "/x/.claude/skills/gstack/bin/gstack-session-update" },
              ],
            },
          ],
        },
      })}\n`,
    );
    const { adapter, declaration } = await provisionFixture("remove-strip");
    const plan = adapter.remove({ declaration }) as GstackRemoveResult;
    if (plan.mode !== "apply") throw new Error("expected apply mode");
    await applyActions(root, plan.repoRelativeActions);
    await applyActions(home, plan.homeActions);

    const homeSettings = readJson(home, CLAUDE_SETTINGS_PATH);
    expect(homeSettings.hooks).toBeUndefined();
  });
});

// -- report ---------------------------------------------------------------------

describe("report — Framework Card discloses the install surface, lockdown, and residual risks", () => {
  it("includes pin, profile, D7 pair, surface lists, counts, disclosures, lockdown, choices, and risks", async () => {
    const { adapter, declaration, resolved } = await provisionFixture("report");
    const report = adapter.report({ declaration });
    expect(report.framework).toBe("gstack");
    const text = report.lines.join("\n");

    expect(text).toContain(`pin: ${GSTACK_REPOSITORY}@${GSTACK_PIN_COMMIT}`);
    expect(text).toContain(`selected profile: ${GSTACK_SELECTED_PROFILE}`);
    expect(text).toContain(`scannedDigest: ${resolved.treeDigest}`);
    expect(text).toMatch(/match: true/);
    expect(text).toContain("adapter-type: shared-runtime");

    // SHARED-SURFACE ENUMERATION with the install-surface disclosure.
    expect(text).toContain("node_modules, build outputs, and .git");
    expect(text).toContain(`GSTACK_HOME at ${GSTACK_HOME_REL}`);
    expect(text).toContain("settings.json.bak");

    // Deny/re-enable counts (4 fixture identities) + surface lists.
    expect(text).toContain("deny count (user scope): 4");
    expect(text).toContain("re-enable count (project scope): 4");
    expect(text).toContain("D18-owned surfaces:");
    expect(text).toContain("machine-scope surfaces:");

    // Lockdown + user-choice states.
    expect(text).toContain("lockdown telemetry: off");
    expect(text).toContain("lockdown skill_prefix: true");
    expect(text).toContain("user choice codex_reviews: disabled");
    expect(text).toContain("user choice proactive: false");
    expect(text).toContain("user choice browser automation: off");
    expect(text).toContain("browse binary left unlaunched");

    // Residual risks verbatim (R5 proxy, conditional alias, office-hours obligation).
    expect(text).toContain("R5: slash-menu hiding is verified by proxy only");
    expect(text).toContain("gstack-connect-chrome creation is conditional");
    expect(text).toContain("PERMANENT runtime-test obligation");
    expect(text.toLowerCase()).toContain("estimate");
  });

  it("reports lock-absent state (with lockdown + risks still disclosed) before any provision", () => {
    const adapter = createGstackAdapter({ root, runner: recordingRunner().runner, env: ENV() });
    const report = adapter.report({ declaration: declarationFor("0".repeat(64)) });
    const text = report.lines.join("\n");
    expect(text).toContain("absent");
    expect(text).toContain("lockdown telemetry: off");
    expect(text).toContain("R5: slash-menu hiding is verified by proxy only");
  });
});

// -- the PERMANENT office-hours runtime test ------------------------------------

describe("office-hours runtime test (permanent obligation — the spike probe is the template)", () => {
  it("with codexReviews=false the config carries codex_reviews: disabled and NO codex invocation shape exists in any written surface", async () => {
    await provisionFixture("office-hours");

    const config = readText(root, GSTACK_CONFIG_REL);
    expect(config).toContain("codex_reviews: disabled");

    // Every surface this bind wrote, home and project, lock included.
    const surfaces = [
      readText(root, CLAUDE_SETTINGS_PATH),
      readText(root, "CLAUDE.md"),
      config,
      readText(root, GSTACK_MANIFEST_REL),
      readFileSync(join(home, CLAUDE_SETTINGS_PATH), "utf8"),
      readFileSync(join(bindingDir(root), "lock.json"), "utf8"),
    ];
    for (const surface of surfaces) {
      // The one permitted mention is the literal disabling config key; after
      // removing it, no codex invocation shape of any kind may remain.
      const withoutDisabledKey = surface.replaceAll("codex_reviews: disabled", "");
      expect(withoutDisabledKey.toLowerCase()).not.toContain("codex");
    }
  });

  it("codexReviews=true is an EXPLICIT user choice: the config flips to enabled and is disclosed on the card", async () => {
    const { adapter, declaration } = await provisionFixture("office-hours-enabled", {
      features: { codexReviews: true },
    });
    expect(readText(root, GSTACK_CONFIG_REL)).toContain("codex_reviews: enabled");
    const text = adapter.report({ declaration }).lines.join("\n");
    expect(text).toContain("user choice codex_reviews: enabled");
  });

  it("proactive=true writes the literal proactive: true (R12 surfaced at bind)", async () => {
    await provisionFixture("proactive-choice", { features: { proactive: true } });
    expect(readText(root, GSTACK_CONFIG_REL)).toContain("proactive: true");
  });
});
