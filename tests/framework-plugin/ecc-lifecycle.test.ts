import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  eccNativeStateRootCandidatesV1,
  resolveEccNativeStateRootV1,
} from "../../src/framework-host/index.js";
import {
  eccPrunePlanV1,
  eccStatePathsV1,
  prepareEccUninstallV1,
} from "../../src/framework-plugin/ecc-lifecycle.js";
import { eccDoctorChecksV1 } from "../../src/framework-plugin/ecc-read.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { loadEccFromSource } from "./plugin-source.js";
import { eccDescriptorLoad } from "./source-plugin-mocks.js";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-lifecycle-"));
  home = join(root, "home");
  mkdirSync(home);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(
  extraEnv: Record<string, string> = {},
  platform: "linux" | "windows" = "linux",
): PlanContext {
  const run = fakeRunner(() => undefined);
  const env = { HOME: home, USERPROFILE: home, ...extraEnv };
  return {
    root,
    contextDir: "ai-coding",
    posture: "vibe",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform, run, env }),
    env,
    options: {},
  };
}

const withPlugin = {
  loadPlugin: () => loadEccFromSource(),
  loadDescriptor: async () => eccDescriptorLoad(),
};

describe("ECC uninstall and prune without the plugin", () => {
  it("sees only the ECC state aih wrote, under the homes the invocation names", () => {
    expect(eccStatePathsV1(ctx())).toEqual([]);
    mkdirSync(join(home, ".aih", "ecc"), { recursive: true });
    mkdirSync(join(root, ".aih", "ecc"), { recursive: true });
    expect(eccStatePathsV1(ctx())).toEqual([join(root, ".aih", "ecc"), join(home, ".aih", "ecc")]);
  });

  it("prune adds nothing for ECC when no aih ECC state exists", async () => {
    await expect(eccPrunePlanV1(ctx(), ["codex"])).resolves.toEqual({
      actions: [],
      subtracted: 0,
    });
  });

  it("prune refuses by name, naming the state and the install command, when aih ECC state exists", async () => {
    mkdirSync(join(home, ".aih", "ecc"), { recursive: true });
    await expect(eccPrunePlanV1(ctx(), [])).rejects.toThrow(
      "framework-plugin-unavailable: @aihq/framework-ecc is not installed next to @aihq/core. Install it with: npm install",
    );
    await expect(eccPrunePlanV1(ctx(), [])).rejects.toThrow(
      `aih ECC state to reconcile: ${join(home, ".aih", "ecc")}`,
    );
  });

  it("doctor states that the ECC checks were not run, as a skip naming the install command", async () => {
    const checks = await eccDoctorChecksV1(ctx());
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "ECC checks", verdict: "skip" });
    expect(checks[0]?.detail).toContain(
      "ECC checks were not run: framework-plugin-unavailable: @aihq/framework-ecc is not installed",
    );
  });

  it("uninstall refuses the ECC removal by name before any cleanup", async () => {
    await expect(prepareEccUninstallV1(ctx(), true)).rejects.toThrow(
      /framework-plugin-unavailable: .*npm install/,
    );
  });
});

describe("ECC state preflight inspects every path and ancestor", () => {
  const unavailable = /framework-plugin-unavailable: .*npm install/;

  it.each(["ownership-v1.json", "native-registration-v1.json"])(
    "sees a lone .aih/ecc-profile/%s and refuses uninstall without the plugin",
    async (name) => {
      mkdirSync(join(root, ".aih", "ecc-profile"), { recursive: true });
      writeFileSync(join(root, ".aih", "ecc-profile", name), "{}\n");
      expect(eccStatePathsV1(ctx())).toEqual([
        join(root, ".aih", "ecc-profile"),
        join(root, ".aih", "ecc-profile", name),
      ]);
      const refused = prepareEccUninstallV1(ctx(), false);
      await expect(refused).rejects.toThrow(unavailable);
      await expect(prepareEccUninstallV1(ctx(), false)).rejects.toThrow(
        join(root, ".aih", "ecc-profile", name),
      );
    },
  );

  it("names a dangling symlink at an enumerated path as state, never as absent", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    const state = join(home, ".codex", "ecc-aih-install-state.json");
    symlinkSync(join(root, "missing-target.json"), state);
    expect(eccStatePathsV1(ctx())).toEqual([`${state} (dangling symbolic link)`]);
    await expect(prepareEccUninstallV1(ctx(), false)).rejects.toThrow(unavailable);
    await expect(eccPrunePlanV1(ctx(), [])).rejects.toThrow(`${state} (dangling symbolic link)`);
  });

  it("names a dangling symlinked ancestor as state", async () => {
    const ancestor = join(home, ".aih");
    symlinkSync(join(root, "missing-dir"), ancestor, "dir");
    expect(eccStatePathsV1(ctx())).toEqual([`${ancestor} (dangling symbolic link)`]);
    await expect(prepareEccUninstallV1(ctx(), false)).rejects.toThrow(
      `${ancestor} (dangling symbolic link)`,
    );
  });

  it("names an ancestor that is not a directory as state", async () => {
    writeFileSync(join(root, ".aih"), "not a directory\n");
    expect(eccStatePathsV1(ctx())).toEqual([`${join(root, ".aih")} (not a directory)`]);
    await expect(prepareEccUninstallV1(ctx(), false)).rejects.toThrow(
      `${join(root, ".aih")} (not a directory)`,
    );
  });

  it("follows a resolving symlink at an enumerated path and loads the plugin", async () => {
    const target = join(root, "real-ledger");
    mkdirSync(target);
    mkdirSync(join(home, ".aih"));
    symlinkSync(target, join(home, ".aih", "ecc"), "dir");
    expect(eccStatePathsV1(ctx())).toEqual([join(home, ".aih", "ecc")]);
    await expect(prepareEccUninstallV1(ctx(), false)).rejects.toThrow(unavailable);
    await expect(prepareEccUninstallV1(ctx(), false, withPlugin)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "names an inaccessible ancestor as state",
    async () => {
      const locked = join(home, ".codex");
      mkdirSync(locked);
      const { chmodSync } = await import("node:fs");
      chmodSync(locked, 0o000);
      try {
        expect(eccStatePathsV1(ctx())).toEqual([
          `${join(locked, "ecc-aih-install-state.json")} (inaccessible)`,
        ]);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

describe("ECC uninstall and prune with the plugin", () => {
  it("plans prune with Core's runtime bound to the invocation", async () => {
    const planned = await eccPrunePlanV1(ctx(), ["claude"], withPlugin);
    expect(planned.subtracted).toBe(0);
    expect(planned.actions.map((action) => action.describe)).toContain(
      "Preserve unreceipted ECC claude footprint",
    );
  });

  it("removes nothing when no receipt proves ownership", async () => {
    const remove = await prepareEccUninstallV1(ctx(), true, withPlugin);
    await expect(remove?.()).resolves.toEqual({ removed: [], advisories: [] });
  });
});

describe("ECC native machine state root", () => {
  const unavailable = /framework-plugin-unavailable: .*npm install/;

  it("sees a lone AIH_ECC_STATE_ROOT and refuses uninstall and prune without the plugin", async () => {
    const stateRoot = join(root, "machine-state");
    mkdirSync(stateRoot);
    const context = ctx({ AIH_ECC_STATE_ROOT: stateRoot });
    expect(eccStatePathsV1(context)).toEqual([stateRoot]);
    await expect(prepareEccUninstallV1(context, false)).rejects.toThrow(unavailable);
    await expect(prepareEccUninstallV1(context, false)).rejects.toThrow(stateRoot);
    await expect(eccPrunePlanV1(context, [])).rejects.toThrow(stateRoot);
  });

  it("sees the POSIX platform-default state root under XDG_STATE_HOME or HOME", () => {
    const fromHome = join(home, ".local", "state", "aih", "ecc-profile");
    mkdirSync(fromHome, { recursive: true });
    expect(eccStatePathsV1(ctx())).toEqual([fromHome]);
    const xdg = join(root, "xdg");
    mkdirSync(join(xdg, "aih", "ecc-profile"), { recursive: true });
    expect(eccStatePathsV1(ctx({ XDG_STATE_HOME: xdg }))).toEqual([
      join(xdg, "aih", "ecc-profile"),
    ]);
  });

  it("sees the Windows platform-default state root under LOCALAPPDATA", async () => {
    const local = join(root, "local-app-data");
    mkdirSync(join(local, "aih", "ecc-profile"), { recursive: true });
    const context = ctx({ LOCALAPPDATA: local }, "windows");
    expect(eccStatePathsV1(context)).toEqual([join(local, "aih", "ecc-profile")]);
    await expect(prepareEccUninstallV1(context, false)).rejects.toThrow(unavailable);
  });

  it("inspects the platform default as well as an explicit state root", () => {
    const explicit = join(root, "machine-state");
    const fallback = join(home, ".local", "state", "aih", "ecc-profile");
    mkdirSync(explicit);
    mkdirSync(fallback, { recursive: true });
    expect(eccStatePathsV1(ctx({ AIH_ECC_STATE_ROOT: explicit }))).toEqual([explicit, fallback]);
  });

  it("names a dangling symbolic link at the state root as state", async () => {
    const stateRoot = join(root, "machine-state");
    symlinkSync(join(root, "missing-state"), stateRoot, "dir");
    const context = ctx({ AIH_ECC_STATE_ROOT: stateRoot });
    expect(eccStatePathsV1(context)).toEqual([`${stateRoot} (dangling symbolic link)`]);
    await expect(prepareEccUninstallV1(context, false)).rejects.toThrow(unavailable);
  });

  it("fails closed on a relative AIH_ECC_STATE_ROOT instead of treating machine state as absent", async () => {
    const context = ctx({ AIH_ECC_STATE_ROOT: "relative/state" });
    expect(eccStatePathsV1(context)).toEqual([
      "AIH_ECC_STATE_ROOT=relative/state (not an absolute path)",
    ]);
    await expect(prepareEccUninstallV1(context, false)).rejects.toThrow(unavailable);
  });

  it("resolves the state root the native registration uses from one Core function", () => {
    const explicit = join(root, "machine-state");
    expect(resolveEccNativeStateRootV1({ AIH_ECC_STATE_ROOT: explicit }, "linux")).toBe(explicit);
    expect(resolveEccNativeStateRootV1({ HOME: home }, "linux")).toBe(
      join(home, ".local", "state", "aih", "ecc-profile"),
    );
    expect(resolveEccNativeStateRootV1({ USERPROFILE: home }, "windows")).toBe(
      join(home, "aih", "ecc-profile"),
    );
    expect(
      eccNativeStateRootCandidatesV1({ AIH_ECC_STATE_ROOT: explicit, HOME: home }, "linux"),
    ).toHaveLength(2);
    expect(() => resolveEccNativeStateRootV1({}, "linux")).toThrow(/AIH_ECC_STATE_ROOT/);
    expect(() => resolveEccNativeStateRootV1({ AIH_ECC_STATE_ROOT: "rel" }, "linux")).toThrow(
      "AIH_ECC_STATE_ROOT must be absolute",
    );
  });
});

describe("ECC native machine state root: every component from the file-system root", () => {
  const unavailable = /framework-plugin-unavailable: .*npm install/;

  /** A link or junction at `path` whose target no longer exists. */
  function dangling(path: string, type: "dir" | "junction" = "dir"): string {
    const target = join(root, `gone-${Math.random().toString(16).slice(2)}`);
    mkdirSync(target);
    symlinkSync(target, path, type);
    rmSync(target, { recursive: true });
    return path;
  }

  it("names a dangling link above an explicit AIH_ECC_STATE_ROOT and refuses without the plugin", async () => {
    const link = dangling(join(root, "dangling"));
    const context = ctx({ AIH_ECC_STATE_ROOT: join(link, "child") });
    expect(eccStatePathsV1(context)).toEqual([`${link} (dangling symbolic link)`]);
    await expect(prepareEccUninstallV1(context, false)).rejects.toThrow(unavailable);
    await expect(prepareEccUninstallV1(context, false)).rejects.toThrow(
      `${link} (dangling symbolic link)`,
    );
    await expect(eccPrunePlanV1(context, [])).rejects.toThrow(`${link} (dangling symbolic link)`);
  });

  it("names a dangling link above the POSIX default's supplied base", async () => {
    const link = dangling(join(root, "dangling-xdg"));
    const context = ctx({ XDG_STATE_HOME: join(link, "state") });
    expect(eccStatePathsV1(context)).toEqual([`${link} (dangling symbolic link)`]);
    await expect(prepareEccUninstallV1(context, false)).rejects.toThrow(unavailable);
  });

  it("names a dangling link above HOME for every home-based candidate", () => {
    const link = dangling(join(root, "dangling-home"));
    const away = join(link, "home");
    expect(eccStatePathsV1(ctx({ HOME: away, USERPROFILE: away }))).toEqual([
      `${link} (dangling symbolic link)`,
    ]);
  });

  it("names a dangling link above the Windows default's supplied base", async () => {
    const link = dangling(join(root, "dangling-local"));
    const context = ctx({ LOCALAPPDATA: join(link, "Local") }, "windows");
    expect(eccStatePathsV1(context)).toEqual([`${link} (dangling symbolic link)`]);
    await expect(prepareEccUninstallV1(context, false)).rejects.toThrow(unavailable);
  });

  it.runIf(process.platform === "win32")(
    "names a dangling junction above an explicit root and above the Windows default",
    async () => {
      const junction = dangling(join(root, "dangling-junction"), "junction");
      const explicit = ctx({ AIH_ECC_STATE_ROOT: join(junction, "child") });
      expect(eccStatePathsV1(explicit)).toEqual([`${junction} (dangling symbolic link)`]);
      await expect(prepareEccUninstallV1(explicit, false)).rejects.toThrow(unavailable);
      const fallback = ctx({ LOCALAPPDATA: join(junction, "Local") }, "windows");
      expect(eccStatePathsV1(fallback)).toEqual([`${junction} (dangling symbolic link)`]);
    },
  );

  it("names the non-directory component above an explicit root", () => {
    const file = join(root, "not-a-dir");
    writeFileSync(file, "file\n");
    expect(eccStatePathsV1(ctx({ AIH_ECC_STATE_ROOT: join(file, "state", "child") }))).toEqual([
      `${file} (not a directory)`,
    ]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "names an inaccessible component above an explicit root",
    async () => {
      const locked = join(root, "locked");
      mkdirSync(join(locked, "inner"), { recursive: true });
      const { chmodSync } = await import("node:fs");
      chmodSync(locked, 0o000);
      try {
        expect(
          eccStatePathsV1(ctx({ AIH_ECC_STATE_ROOT: join(locked, "inner", "state") })),
        ).toEqual([`${join(locked, "inner")} (inaccessible)`]);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  it("follows a resolving link above the state root and reports absence below real directories", () => {
    const target = join(root, "real-state-parent");
    mkdirSync(target);
    symlinkSync(target, join(root, "linked"), "dir");
    expect(eccStatePathsV1(ctx({ AIH_ECC_STATE_ROOT: join(root, "linked", "state") }))).toEqual([]);
    mkdirSync(join(target, "state"));
    expect(eccStatePathsV1(ctx({ AIH_ECC_STATE_ROOT: join(root, "linked", "state") }))).toEqual([
      join(root, "linked", "state"),
    ]);
  });
});

describe("ECC native machine state root refusal names the manual route", () => {
  const route = (stateRoot: string) =>
    `install @aihq/framework-ecc, or, once no project on this machine uses the ECC native registration, remove ${stateRoot} by hand`;

  /** An unavailable plugin whose own detail nearly fills the refusal's bound. */
  const verboseUnavailable = {
    loadPlugin: async () => ({
      ok: false as const,
      refusal: {
        reason: "framework-plugin-unavailable" as const,
        frameworkId: "ecc" as const,
        packageName: "@aihq/framework-ecc" as const,
        detail: `@aihq/framework-ecc is not installed; ${"x".repeat(1_990)}`,
      },
    }),
  };

  it("gives uninstall and prune the install-or-remove-by-hand route for an explicit root", async () => {
    const stateRoot = join(root, "machine-state");
    mkdirSync(stateRoot);
    const context = ctx({ AIH_ECC_STATE_ROOT: stateRoot });
    await expect(prepareEccUninstallV1(context, false)).rejects.toThrow(route(stateRoot));
    await expect(eccPrunePlanV1(context, [])).rejects.toThrow(route(stateRoot));
  });

  it("names the platform-default root in the route", async () => {
    const local = join(root, "local-app-data");
    const stateRoot = join(local, "aih", "ecc-profile");
    mkdirSync(stateRoot, { recursive: true });
    const context = ctx({ LOCALAPPDATA: local }, "windows");
    await expect(prepareEccUninstallV1(context, false)).rejects.toThrow(route(stateRoot));
  });

  it("names the state root in full even when the plugin's own detail fills the bound", async () => {
    const stateRoot = join(root, "machine-state");
    mkdirSync(stateRoot);
    const context = ctx({ AIH_ECC_STATE_ROOT: stateRoot });
    await expect(prepareEccUninstallV1(context, false, verboseUnavailable)).rejects.toThrow(
      route(stateRoot),
    );
    await expect(eccPrunePlanV1(context, [], verboseUnavailable)).rejects.toThrow(route(stateRoot));
  });

  it("gives the route for the root below a dangling ancestor", async () => {
    const target = join(root, "gone");
    mkdirSync(target);
    const link = join(root, "dangling");
    symlinkSync(target, link, "dir");
    rmSync(target, { recursive: true });
    const stateRoot = join(link, "child");
    const context = ctx({ AIH_ECC_STATE_ROOT: stateRoot });
    await expect(prepareEccUninstallV1(context, false)).rejects.toThrow(route(stateRoot));
  });

  it("does not add the route when only project state is found", async () => {
    mkdirSync(join(root, ".aih", "ecc"), { recursive: true });
    await expect(prepareEccUninstallV1(ctx(), false)).rejects.toThrow(
      /framework-plugin-unavailable/,
    );
    await expect(prepareEccUninstallV1(ctx(), false)).rejects.not.toThrow(/remove .* by hand/);
  });
});
