import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createGstackAdapter,
  defaultGstackInstaller,
  GSTACK_SETUP_COMMAND,
  type GstackInstaller,
} from "../../../src/binding/index.js";
import type { RunResult } from "../../../src/internals/proc.js";
import {
  declarationFor,
  fixtureInstaller,
  GSTACK_FIXTURE_FILES,
  recordingRunner,
  scannedGstackFixture,
  writeFileEnsuring,
} from "./gstack-support.js";

describe("defaultGstackInstaller — pristine work-copy staging (spike cache-hygiene lesson)", () => {
  let cacheHome: string;

  beforeEach(() => {
    cacheHome = mkdtempSync(join(tmpdir(), "aih-gstack-installer-test-"));
  });

  afterEach(() => {
    rmSync(cacheHome, { recursive: true, force: true });
  });

  it("spawns setup from a scratch copy, never the resolved cache checkout, and cleans the stage", async () => {
    const { resolved } = scannedGstackFixture(cacheHome, "pinned-tree");
    const seen: { argv: string[]; cwd: string | undefined }[] = [];
    const runner = (argv: string[], opts?: { cwd?: string }): Promise<RunResult> => {
      seen.push({ argv, cwd: opts?.cwd });
      // Prove the stage carries the checkout's own bytes at spawn time: the
      // setup entry point copied from the fixture tree must be present.
      const cwd = opts?.cwd;
      expect(cwd).toBeDefined();
      expect(existsSync(join(cwd as string, "setup"))).toBe(true);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" } as RunResult);
    };

    const result = await defaultGstackInstaller({
      resolved,
      root: cacheHome,
      home: cacheHome,
      gstackHomeAbs: join(cacheHome, "gstack-home"),
      runner,
      env: {},
    });

    expect(result.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    const call = seen[0] as { argv: string[]; cwd: string | undefined };
    expect(call.argv).toEqual([...GSTACK_SETUP_COMMAND]);
    // The load-bearing property: cwd is a scratch stage, NOT the pinned cache
    // checkout (bun install/build in the cache would dirty the next resolve).
    expect(call.cwd).not.toBe(resolved.treePath);
    expect(call.cwd?.includes("aih-gstack-setup-")).toBe(true);
    // The stage is removed after the run (success path).
    expect(existsSync(call.cwd as string)).toBe(false);
    // The pinned checkout itself is untouched by the run: same file set as the
    // fixture definition, no node_modules-style additions.
    for (const rel of Object.keys(GSTACK_FIXTURE_FILES)) {
      expect(existsSync(join(resolved.treePath, ...rel.split("/")))).toBe(true);
    }
    expect(existsSync(join(resolved.treePath, "node_modules"))).toBe(false);
  });

  it("cleans the scratch stage and rethrows when staging the checkout fails", async () => {
    const { resolved } = scannedGstackFixture(cacheHome, "stage-fail");
    // A resolved treePath that does not exist makes cpSync throw; the installer
    // must still clean its scratch stage (best-effort) and rethrow.
    const broken = { ...resolved, treePath: join(cacheHome, "no-such-checkout") };
    await expect(
      defaultGstackInstaller({
        resolved: broken,
        root: cacheHome,
        home: cacheHome,
        gstackHomeAbs: join(cacheHome, "gstack-home"),
        runner: recordingRunner().runner,
        env: {},
      }),
    ).rejects.toThrow();
    // No leftover scratch stages under tmp for this run.
    const strays = readdirSync(tmpdir()).filter((d) => d.startsWith("aih-gstack-setup-"));
    expect(strays).toEqual([]);
  });

  it("provision unwinds skills dirs created before a THROWN installer seam (live-acceptance regression)", async () => {
    const home = mkdtempSync(join(tmpdir(), "aih-gstack-home-"));
    const project = mkdtempSync(join(tmpdir(), "aih-gstack-proj-"));
    try {
      const { resolved, disposition } = scannedGstackFixture(cacheHome, "thrown-tree");
      const declaration = declarationFor(resolved.treeDigest);
      const wrapper = join(home, ".claude", "skills", "gstack-autoplan");
      const installer: GstackInstaller = () => {
        writeFileEnsuring(
          join(wrapper, "SKILL.md"),
          "---\nname: gstack-autoplan\ndescription: partial install\n---\n\nPartial.\n",
        );
        return Promise.reject(new Error("simulated mid-install crash"));
      };
      const adapter = createGstackAdapter({
        root: project,
        runner: recordingRunner().runner,
        env: { USERPROFILE: home },
        installGstack: installer,
      });
      await expect(
        adapter.provision({ context: { declaration }, resolved }, disposition),
      ).rejects.toThrow(/installer threw[\s\S]*unwound/);
      // The dir the failed install materialized is gone — nothing undenied remains.
      expect(existsSync(wrapper)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("unwind PRESERVES a gstack skills dir that pre-existed the bind", async () => {
    const home = mkdtempSync(join(tmpdir(), "aih-gstack-home-"));
    const project = mkdtempSync(join(tmpdir(), "aih-gstack-proj-"));
    try {
      const { resolved, disposition } = scannedGstackFixture(cacheHome, "preexist-tree");
      const declaration = declarationFor(resolved.treeDigest);
      // A gstack-shaped dir already on the machine before this bind.
      const preExisting = join(home, ".claude", "skills", "gstack-preexisting");
      writeFileEnsuring(join(preExisting, "SKILL.md"), "---\nname: gstack-preexisting\n---\nold\n");
      const installer: GstackInstaller = () => {
        writeFileEnsuring(
          join(home, ".claude", "skills", "gstack-autoplan", "SKILL.md"),
          "---\nname: gstack-autoplan\n---\npartial\n",
        );
        return Promise.reject(new Error("crash after partial install"));
      };
      const adapter = createGstackAdapter({
        root: project,
        runner: recordingRunner().runner,
        env: { USERPROFILE: home },
        installGstack: installer,
      });
      await expect(
        adapter.provision({ context: { declaration }, resolved }, disposition),
      ).rejects.toThrow(/unwound/);
      // The bind-created dir is removed; the PRE-EXISTING one is preserved.
      expect(existsSync(join(home, ".claude", "skills", "gstack-autoplan"))).toBe(false);
      expect(existsSync(preExisting)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("provision unwinds the install when a post-install APPLY fails (mid-apply saga; live-acceptance regression)", async () => {
    const home = mkdtempSync(join(tmpdir(), "aih-gstack-home-"));
    const project = mkdtempSync(join(tmpdir(), "aih-gstack-proj-"));
    try {
      const { resolved, disposition } = scannedGstackFixture(cacheHome, "midapply-tree");
      const declaration = declarationFor(resolved.treeDigest);
      const { installer } = fixtureInstaller();
      const adapter = createGstackAdapter({
        root: project,
        runner: recordingRunner().runner,
        env: { USERPROFILE: home },
        installGstack: installer,
        // The deny write fails (e.g. an executor path-containment refusal);
        // empty-action applies (the unwind's no-op removals) still succeed.
        applyActions: (root, actions) => {
          if (root === home && actions.length > 0) {
            return Promise.reject(new Error("refusing to write outside the target root"));
          }
          return Promise.resolve({ ok: true, results: [] } as never);
        },
      });
      await expect(
        adapter.provision({ context: { declaration }, resolved }, disposition),
      ).rejects.toThrow(/mid-apply[\s\S]*unwound/);
      // Everything the install materialized is gone — installed-but-undenied
      // skills must never survive a failed bind.
      expect(existsSync(join(home, ".claude", "skills", "gstack"))).toBe(false);
      const skillsDir = join(home, ".claude", "skills");
      const leftover = existsSync(skillsDir)
        ? readdirSync(skillsDir).filter(
            (d) => d === "gstack" || d.startsWith("gstack-") || d === "_gstack-command",
          )
        : [];
      expect(leftover).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});
