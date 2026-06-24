import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/sandbox/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-sandbox-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A canned runner whose `docker info` result we control per test. */
function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...over,
  };
}

function findWrite(actions: Action[], path: string): WriteAction {
  const w = actions.find((a): a is WriteAction => a.kind === "write" && a.path === path);
  if (!w) throw new Error(`no write action for ${path}`);
  return w;
}

describe("sandbox command surface", () => {
  it("keeps the stub's name and a worktree option", () => {
    expect(command.name).toBe("sandbox");
    expect(command.options?.some((o) => o.flags.includes("--worktree"))).toBe(true);
  });
});

describe("sandbox plan shape", () => {
  it("emits exactly two writes, one doc, and one probe", async () => {
    const p = await command.plan(ctx());
    const kinds = p.actions.map((a) => a.kind).sort();
    expect(kinds).toEqual(["doc", "probe", "write", "write"]);
    expect(p.capability).toBe("sandbox");
  });

  it("writes devcontainer.json and managed-settings.json at the expected paths", async () => {
    const p = await command.plan(ctx());
    const paths = p.actions
      .filter((a): a is WriteAction => a.kind === "write")
      .map((a) => a.path)
      .sort();
    expect(paths).toEqual([".claude/managed-settings.json", ".devcontainer/devcontainer.json"]);
  });
});

describe("devcontainer.json content", () => {
  it("is valid JSON with image, features, postCreateCommand, and vscode customizations", async () => {
    const p = await command.plan(ctx());
    const dc = findWrite(p.actions, ".devcontainer/devcontainer.json").json as Record<
      string,
      unknown
    >;
    // round-trips through JSON without throwing — i.e. it is serializable/valid
    const reparsed = JSON.parse(JSON.stringify(dc)) as Record<string, unknown>;
    expect(reparsed.image).toBe("mcr.microsoft.com/devcontainers/base:ubuntu");
    expect(reparsed.features).toBeTypeOf("object");
    expect(reparsed.postCreateCommand).toBeTypeOf("string");
    const customizations = reparsed.customizations as { vscode?: { extensions?: unknown } };
    expect(Array.isArray(customizations.vscode?.extensions)).toBe(true);
  });

  it("pins devcontainer features by ghcr reference", async () => {
    const p = await command.plan(ctx());
    const dc = findWrite(p.actions, ".devcontainer/devcontainer.json").json as {
      features: Record<string, unknown>;
    };
    const featureKeys = Object.keys(dc.features);
    expect(featureKeys.length).toBeGreaterThanOrEqual(2);
    expect(featureKeys.every((k) => k.startsWith("ghcr.io/devcontainers/features/"))).toBe(true);
  });

  it("threads a custom contextDir into the vscode file excludes", async () => {
    const p = await command.plan(ctx({ contextDir: ".enterprise-ctx" }));
    const dc = findWrite(p.actions, ".devcontainer/devcontainer.json").json as {
      customizations: { vscode: { settings: { "files.exclude": Record<string, boolean> } } };
    };
    const excludeKeys = Object.keys(dc.customizations.vscode.settings["files.exclude"]);
    expect(excludeKeys).toContain(".enterprise-ctx/**");
  });
});

describe("managed-settings.json content", () => {
  it("fails closed and refuses unsandboxed commands", async () => {
    const p = await command.plan(ctx());
    const ms = findWrite(p.actions, ".claude/managed-settings.json").json as {
      sandbox: Record<string, unknown>;
    };
    expect(ms.sandbox.enabled).toBe(true);
    expect(ms.sandbox.failIfUnavailable).toBe(true);
    expect(ms.sandbox.allowUnsandboxedCommands).toBe(false);
  });

  it("carries the github/pypi/npm egress allowlist", async () => {
    const p = await command.plan(ctx());
    const ms = findWrite(p.actions, ".claude/managed-settings.json").json as {
      sandbox: { allowedDomains: string[] };
    };
    expect(ms.sandbox.allowedDomains).toEqual(["github.com", "pypi.org", "registry.npmjs.org"]);
  });

  it("is staged as a merge write so user keys survive", async () => {
    const p = await command.plan(ctx());
    expect(findWrite(p.actions, ".claude/managed-settings.json").merge).toBe(true);
    expect(findWrite(p.actions, ".devcontainer/devcontainer.json").merge).toBeFalsy();
  });
});

describe("the BOUNDARY: docker is read-only", () => {
  it("checks docker via a probe, never an exec or write", async () => {
    const p = await command.plan(ctx());
    expect(p.actions.some((a) => a.kind === "exec")).toBe(false);
    const probes = p.actions.filter((a) => a.kind === "probe");
    expect(probes).toHaveLength(1);
    expect(probes[0]?.describe).toContain("docker");
  });

  it("never runs docker during dry-run plan computation", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return undefined;
    });
    await command.plan(ctx({ run }));
    // plan() must be pure: no subprocess until --verify executes the probe
    expect(calls).toHaveLength(0);
  });
});

describe("docker probe verdicts under --verify", () => {
  it("passes when docker info exits 0", async () => {
    const run = fakeRunner((argv) =>
      argv[0] === "docker" ? { code: 0, stdout: "Server: ..." } : undefined,
    );
    const res = await executePlan(
      await command.plan(ctx({ verify: true, run })),
      ctx({ verify: true, run }),
    );
    const check = res.report?.checks.find((c) => c.name === "docker available");
    expect(check?.verdict).toBe("pass");
  });

  it("skips (not fails) when docker is absent", async () => {
    const run = fakeRunner((argv) =>
      argv[0] === "docker" ? { code: 127, spawnError: true, stderr: "not found" } : undefined,
    );
    const res = await executePlan(
      await command.plan(ctx({ verify: true, run })),
      ctx({ verify: true, run }),
    );
    const check = res.report?.checks.find((c) => c.name === "docker available");
    expect(check?.verdict).toBe("skip");
    expect(res.report?.ok).toBe(true);
  });

  it("skips (not fails) when the docker daemon is down", async () => {
    const run = fakeRunner((argv) =>
      argv[0] === "docker" ? { code: 1, stderr: "Cannot connect to the Docker daemon" } : undefined,
    );
    const res = await executePlan(
      await command.plan(ctx({ verify: true, run })),
      ctx({ verify: true, run }),
    );
    const check = res.report?.checks.find((c) => c.name === "docker available");
    expect(check?.verdict).toBe("skip");
    expect(res.report?.ok).toBe(true);
  });
});

describe("worktree guidance doc", () => {
  it("documents the worktree path, the --worktree flag, and host projection", async () => {
    const p = await command.plan(ctx());
    const guidance = p.actions.find((a) => a.kind === "doc");
    if (guidance?.kind !== "doc") throw new Error("expected a doc action");
    expect(guidance.text).toContain(".claude/worktrees");
    expect(guidance.text).toContain("git worktree add");
    expect(guidance.text).toContain("--worktree");
    expect(guidance.text).toContain("devcontainer");
  });
});

describe("end-to-end execution", () => {
  it("dry-run writes nothing to disk", async () => {
    const res = await executePlan(await command.plan(ctx()), ctx({ apply: false }));
    expect(res.applied).toBe(false);
    expect(res.writes.map((w) => w.effect)).toEqual(["create", "create"]);
  });

  it("merge preserves a pre-existing managed-settings key on apply", async () => {
    const settingsDir = join(dir, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "managed-settings.json"),
      JSON.stringify({ telemetry: { enabled: false } }),
    );

    const applyCtx = ctx({ apply: true });
    await executePlan(await command.plan(applyCtx), applyCtx);

    const merged = JSON.parse(readFileSync(join(settingsDir, "managed-settings.json"), "utf8")) as {
      telemetry?: unknown;
      sandbox?: { failIfUnavailable?: boolean };
    };
    expect(merged.telemetry).toEqual({ enabled: false });
    expect(merged.sandbox?.failIfUnavailable).toBe(true);
  });

  it("is idempotent: re-applying yields byte-identical files", async () => {
    const first = ctx({ apply: true });
    await executePlan(await command.plan(first), first);
    const dcAfterFirst = readFileSync(join(dir, ".devcontainer/devcontainer.json"), "utf8");
    const msAfterFirst = readFileSync(join(dir, ".claude/managed-settings.json"), "utf8");

    const second = ctx({ apply: true });
    await executePlan(await command.plan(second), second);
    const dcAfterSecond = readFileSync(join(dir, ".devcontainer/devcontainer.json"), "utf8");
    const msAfterSecond = readFileSync(join(dir, ".claude/managed-settings.json"), "utf8");

    expect(dcAfterSecond).toBe(dcAfterFirst);
    expect(msAfterSecond).toBe(msAfterFirst);
  });
});
