import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeEccCommand } from "../../src/ecc/pipeline.js";
import {
  createPackagedEccProfileEvidence,
  executeEccProfileLifecycleCommand,
} from "../../src/ecc-profile/command.js";
import {
  ECC_PROFILE_OWNERSHIP_PATH,
  readEccProfileOwnership,
} from "../../src/ecc-profile/lifecycle.js";
import {
  buildNativeEccRegistration,
  NATIVE_ECC_REGISTRATION_RECEIPT,
} from "../../src/ecc-profile/native-registration.js";
import { renderEccProjectionWithTrust } from "../../src/ecc-profile/render.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { defaultRunner, fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { evidence, profile, projectionRoots } from "./render-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(root: string, operation: string, apply: boolean): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: { lifecycle: operation },
  };
}

function realGitContext(root: string, operation: string): PlanContext {
  const platform =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: true,
    verify: false,
    json: false,
    run: defaultRunner,
    host: makeHostAdapter({ platform, run: defaultRunner, env: {} }),
    env: {},
    options: { lifecycle: operation },
  };
}

describe("ECC profile lifecycle command", () => {
  it("materializes the package-bound review and projected-source receipts in a disposable root", () => {
    const packaged = createPackagedEccProfileEvidence();
    roots.push(packaged.evidenceRoot);

    expect(packaged.profile.source.reviewReceipt).toEqual(packaged.evidence.reviewReceipt);
    expect(
      existsSync(
        join(packaged.evidenceRoot, ...packaged.evidence.reviewReceipt.evidencePath.split("/")),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(packaged.evidenceRoot, "evidence", "ecc", "projected-source-closure-v1.json"),
      ),
    ).toBe(true);
  });

  it("previews without target writes, then installs and uninstalls through the authenticated lifecycle", async () => {
    const sources = await projectionRoots();
    const target = mkdtempSync(join(tmpdir(), "aih-ecc-profile-command-"));
    roots.push(target);
    try {
      const projection = await renderEccProjectionWithTrust(
        profile,
        evidence,
        sources,
        await sources.createTrust(),
      );
      const loadProjection = vi.fn(async () => projection);
      const stateRoot = mkdtempSync(join(tmpdir(), "aih-ecc-profile-command-state-"));
      roots.push(stateRoot);
      const executable = join(stateRoot, process.platform === "win32" ? "node.exe" : "node");
      const cliScript = join(stateRoot, "cli.js");
      writeFileSync(executable, "runtime", { mode: 0o755 });
      writeFileSync(cliScript, "cli\n");
      const loadNativeRegistration = () =>
        buildNativeEccRegistration({ root: target, stateRoot, executable, cliScript });

      const preview = await executeEccCommand(context(target, "install", false), {
        profileLifecycle: { loadProjection, loadNativeRegistration },
      });
      expect(preview.applied).toBe(false);
      expect(preview.writes.length).toBeGreaterThan(0);
      expect(existsSync(join(target, ECC_PROFILE_OWNERSHIP_PATH))).toBe(false);

      const installed = await executeEccProfileLifecycleCommand(context(target, "install", true), {
        loadProjection,
        loadNativeRegistration,
      });
      expect(installed.applied).toBe(true);
      expect(existsSync(join(target, NATIVE_ECC_REGISTRATION_RECEIPT))).toBe(true);
      const installedSource = readEccProfileOwnership(target)?.source;
      expect(installedSource).toBeDefined();

      await executeEccProfileLifecycleCommand(context(target, "uninstall", true), {
        loadProjection,
        loadNativeRegistration,
        installedSourceTrust: installedSource ? [installedSource] : [],
      });
      expect(existsSync(join(target, ECC_PROFILE_OWNERSHIP_PATH))).toBe(false);
      expect(existsSync(join(target, NATIVE_ECC_REGISTRATION_RECEIPT))).toBe(false);
      expect(loadProjection).toHaveBeenCalledTimes(2);
    } finally {
      await sources.cleanup();
    }
  }, 120_000);

  it("uses receipt-bound ownership for the compound lifecycle in a real Git worktree", async () => {
    const sources = await projectionRoots();
    const target = mkdtempSync(join(tmpdir(), "aih-ecc-profile-command-git-"));
    const stateRoot = mkdtempSync(join(tmpdir(), "aih-ecc-profile-command-git-state-"));
    roots.push(target, stateRoot);
    try {
      execFileSync("git", ["init"], { cwd: target, stdio: "ignore" });
      const projection = await renderEccProjectionWithTrust(
        profile,
        evidence,
        sources,
        await sources.createTrust(),
      );
      const executable = join(stateRoot, process.platform === "win32" ? "node.exe" : "node");
      const cliScript = join(stateRoot, "cli.js");
      writeFileSync(executable, "runtime", { mode: 0o755 });
      writeFileSync(cliScript, "cli\n");

      const installed = await executeEccProfileLifecycleCommand(realGitContext(target, "install"), {
        loadProjection: async () => projection,
        loadNativeRegistration: () =>
          buildNativeEccRegistration({ root: target, stateRoot, executable, cliScript }),
      });

      expect(installed.applied).toBe(true);
      expect(existsSync(join(target, NATIVE_ECC_REGISTRATION_RECEIPT))).toBe(true);

      const next = structuredClone(projection);
      next.source.commit = "b".repeat(40);
      next.source.reviewReceipt.sourceCommit = next.source.commit;
      next.sourceClosure.id = "next-closure";
      next.sourceClosure.aggregateSha256 = "b".repeat(64);
      for (const file of next.files) file.provenance.sourcePin = next.source.commit;
      await executeEccProfileLifecycleCommand(realGitContext(target, "update"), {
        loadProjection: async () => next,
        loadNativeRegistration: () =>
          buildNativeEccRegistration({ root: target, stateRoot, executable, cliScript }),
      });
      const nextSource = readEccProfileOwnership(target)?.source;
      expect(nextSource?.commit).toBe(next.source.commit);

      await executeEccProfileLifecycleCommand(realGitContext(target, "rollback"), {
        installedSourceTrust: nextSource ? [nextSource] : [],
      });
      const originalSource = readEccProfileOwnership(target)?.source;
      expect(originalSource?.commit).toBe(projection.source.commit);

      await executeEccProfileLifecycleCommand(realGitContext(target, "uninstall"), {
        installedSourceTrust: originalSource ? [originalSource] : [],
      });
      expect(existsSync(join(target, ECC_PROFILE_OWNERSHIP_PATH))).toBe(false);
      expect(existsSync(join(target, NATIVE_ECC_REGISTRATION_RECEIPT))).toBe(false);
    } finally {
      await sources.cleanup();
    }
  }, 120_000);

  it("keeps native registration installed when projection uninstall preflight fails", async () => {
    const sources = await projectionRoots();
    const target = mkdtempSync(join(tmpdir(), "aih-ecc-profile-command-atomic-uninstall-"));
    const stateRoot = mkdtempSync(join(tmpdir(), "aih-ecc-profile-command-atomic-state-"));
    roots.push(target, stateRoot);
    try {
      const projection = await renderEccProjectionWithTrust(
        profile,
        evidence,
        sources,
        await sources.createTrust(),
      );
      const executable = join(stateRoot, process.platform === "win32" ? "node.exe" : "node");
      const cliScript = join(stateRoot, "cli.js");
      writeFileSync(executable, "runtime", { mode: 0o755 });
      writeFileSync(cliScript, "cli\n");
      const loadNativeRegistration = () =>
        buildNativeEccRegistration({ root: target, stateRoot, executable, cliScript });
      await executeEccProfileLifecycleCommand(context(target, "install", true), {
        loadProjection: async () => projection,
        loadNativeRegistration,
      });
      const managed = projection.files.find((file) => file.mergeStrategy === "replace");
      if (!managed) throw new Error("fixture has no replace-owned projected file");
      writeFileSync(join(target, ...managed.destination.split("/")), "operator drift\n");
      const installedSource = readEccProfileOwnership(target)?.source;

      await expect(
        executeEccProfileLifecycleCommand(context(target, "uninstall", true), {
          loadProjection: async () => projection,
          loadNativeRegistration,
          installedSourceTrust: installedSource ? [installedSource] : [],
        }),
      ).rejects.toThrow(/modified|ownership|drift|hash/i);

      expect(existsSync(join(target, NATIVE_ECC_REGISTRATION_RECEIPT))).toBe(true);
      expect(readFileSync(join(target, ".mcp.json"), "utf8")).toContain("serena");
    } finally {
      await sources.cleanup();
    }
  }, 120_000);

  it.each(["repair", "rollback"] as const)(
    "preflights projection and native %s recovery before applying either plan",
    async (operation) => {
      const sources = await projectionRoots();
      const target = mkdtempSync(join(tmpdir(), `aih-ecc-profile-command-atomic-${operation}-`));
      const stateRoot = mkdtempSync(join(tmpdir(), `aih-ecc-profile-command-state-${operation}-`));
      roots.push(target, stateRoot);
      try {
        const projection = await renderEccProjectionWithTrust(
          profile,
          evidence,
          sources,
          await sources.createTrust(),
        );
        const executable = join(stateRoot, process.platform === "win32" ? "node.exe" : "node");
        const cliScript = join(stateRoot, "cli.js");
        writeFileSync(executable, "runtime", { mode: 0o755 });
        writeFileSync(cliScript, "cli\n");
        const loadNativeRegistration = () =>
          buildNativeEccRegistration({ root: target, stateRoot, executable, cliScript });
        await executeEccProfileLifecycleCommand(context(target, "install", true), {
          loadProjection: async () => projection,
          loadNativeRegistration,
        });
        const managed = projection.files.find((file) => file.mergeStrategy === "replace");
        if (!managed) throw new Error("fixture has no replace-owned projected file");
        const destination = join(target, ...managed.destination.split("/"));
        let expectedSourceCommit = projection.source.commit;
        if (operation === "repair") {
          rmSync(destination);
        } else {
          const next = structuredClone(projection);
          next.source.commit = "b".repeat(40);
          next.source.reviewReceipt.sourceCommit = next.source.commit;
          next.sourceClosure.id = "next-closure";
          next.sourceClosure.aggregateSha256 = "b".repeat(64);
          for (const file of next.files) file.provenance.sourcePin = next.source.commit;
          await executeEccProfileLifecycleCommand(context(target, "update", true), {
            loadProjection: async () => next,
            loadNativeRegistration,
          });
          expectedSourceCommit = next.source.commit;
        }
        writeFileSync(executable, "modified runtime", { mode: 0o755 });
        const installedSource = readEccProfileOwnership(target)?.source;

        await expect(
          executeEccProfileLifecycleCommand(context(target, operation, true), {
            loadProjection: async () => projection,
            loadNativeRegistration,
            installedSourceTrust: installedSource ? [installedSource] : [],
          }),
        ).rejects.toThrow(/runtime bytes|ownership receipt|run update/i);

        if (operation === "repair") expect(existsSync(destination)).toBe(false);
        else expect(readEccProfileOwnership(target)?.source.commit).toBe(expectedSourceCommit);
      } finally {
        await sources.cleanup();
      }
    },
    120_000,
  );

  it("compensates a completed projection install when native registration fails", async () => {
    const sources = await projectionRoots();
    const target = mkdtempSync(join(tmpdir(), "aih-ecc-profile-command-compensation-"));
    const stateRoot = mkdtempSync(join(tmpdir(), "aih-ecc-profile-command-compensation-state-"));
    roots.push(target, stateRoot);
    try {
      const projection = await renderEccProjectionWithTrust(
        profile,
        evidence,
        sources,
        await sources.createTrust(),
      );
      const executable = join(stateRoot, process.platform === "win32" ? "node.exe" : "node");
      const cliScript = join(stateRoot, "cli.js");
      writeFileSync(executable, "runtime", { mode: 0o755 });
      writeFileSync(cliScript, "cli\n");
      writeFileSync(
        join(target, ".mcp.json"),
        `${JSON.stringify({ mcpServers: { serena: { command: "operator-owned" } } })}\n`,
      );
      const projectedDestination = projection.files.find(
        (file) => file.mergeStrategy === "replace",
      );
      expect(projectedDestination).toBeDefined();

      await expect(
        executeEccProfileLifecycleCommand(context(target, "install", true), {
          loadProjection: async () => projection,
          loadNativeRegistration: () =>
            buildNativeEccRegistration({ root: target, stateRoot, executable, cliScript }),
        }),
      ).rejects.toThrow(/serena.*owned|ownership.*serena|conflict/i);

      expect(existsSync(join(target, ECC_PROFILE_OWNERSHIP_PATH))).toBe(false);
      expect(
        existsSync(join(target, ...(projectedDestination?.destination.split("/") ?? []))),
      ).toBe(false);
      expect(readFileSync(join(target, ".mcp.json"), "utf8")).toContain("operator-owned");
    } finally {
      await sources.cleanup();
    }
  }, 120_000);

  it("repairs, rolls back, and uninstalls from the authenticated installed receipt after a package pin changes", async () => {
    const sources = await projectionRoots();
    const target = mkdtempSync(join(tmpdir(), "aih-ecc-profile-command-upgrade-"));
    roots.push(target);
    try {
      const installed = await renderEccProjectionWithTrust(
        profile,
        evidence,
        sources,
        await sources.createTrust(),
      );
      await executeEccProfileLifecycleCommand(context(target, "install", true), {
        loadProjection: async () => installed,
      });
      const originalSource = readEccProfileOwnership(target)?.source;
      expect(originalSource).toBeDefined();
      const skill = installed.files.find((file) => file.mergeStrategy === "replace");
      expect(skill).toBeDefined();
      rmSync(join(target, ...(skill?.destination.split("/") ?? [])));

      const changedPackagePin = vi.fn(async () => {
        throw new Error(
          "the current package projection must not be used for installed-pin recovery",
        );
      });
      await executeEccProfileLifecycleCommand(context(target, "repair", true), {
        loadProjection: changedPackagePin,
        installedSourceTrust: originalSource ? [originalSource] : [],
      });
      expect(readFileSync(join(target, ...(skill?.destination.split("/") ?? [])), "utf8")).toBe(
        skill?.content,
      );

      const next = structuredClone(installed);
      next.source.commit = "b".repeat(40);
      next.source.reviewReceipt.sourceCommit = next.source.commit;
      next.sourceClosure.id = "next-closure";
      next.sourceClosure.aggregateSha256 = "b".repeat(64);
      for (const file of next.files) file.provenance.sourcePin = next.source.commit;
      await executeEccProfileLifecycleCommand(context(target, "update", true), {
        loadProjection: async () => next,
      });
      const nextSource = readEccProfileOwnership(target)?.source;
      expect(nextSource).toBeDefined();
      await executeEccProfileLifecycleCommand(context(target, "rollback", true), {
        loadProjection: changedPackagePin,
        installedSourceTrust: nextSource ? [nextSource] : [],
      });
      expect(readEccProfileOwnership(target)?.source.commit).toBe(installed.source.commit);

      await executeEccProfileLifecycleCommand(context(target, "uninstall", true), {
        loadProjection: changedPackagePin,
        installedSourceTrust: originalSource ? [originalSource] : [],
      });
      expect(existsSync(join(target, ECC_PROFILE_OWNERSHIP_PATH))).toBe(false);
      expect(changedPackagePin).not.toHaveBeenCalled();
    } finally {
      await sources.cleanup();
    }
  }, 120_000);

  it("fails closed on unknown operations and incompatible legacy selection flags", async () => {
    const target = mkdtempSync(join(tmpdir(), "aih-ecc-profile-command-invalid-"));
    roots.push(target);
    const loadProjection = vi.fn();

    await expect(
      executeEccProfileLifecycleCommand(context(target, "replace-everything", false), {
        loadProjection,
      }),
    ).rejects.toThrow(/lifecycle.*install.*update.*repair.*rollback.*uninstall/i);
    const conflicting = context(target, "install", false);
    conflicting.options.with = ["security-review"];
    await expect(
      executeEccProfileLifecycleCommand(conflicting, { loadProjection }),
    ).rejects.toThrow(/--with.*lifecycle/i);
    const profileConflict = context(target, "install", false);
    profileConflict.options.profile = "core";
    await expect(
      executeEccProfileLifecycleCommand(profileConflict, { loadProjection }),
    ).rejects.toThrow(/--profile.*lifecycle/i);
    expect(loadProjection).not.toHaveBeenCalled();
  });
});
