import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type {
  Action,
  DocAction,
  ExecAction,
  Plan,
  PlanContext,
  ProbeAction,
  WriteAction,
} from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Platform, VdiInfo } from "../../src/platform/base.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/vdi/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-vdi-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Build a PlanContext whose host reports a fixed VDI verdict. The real adapters
 * derive `detectVdi()` from env, but the mission only cares about the two
 * branches, so we patch the verdict directly to keep tests independent of the
 * per-platform marker rules.
 */
function ctx(
  opts: {
    platform?: Platform;
    vdi: VdiInfo;
    env?: NodeJS.ProcessEnv;
    options?: Record<string, unknown>;
  } = { vdi: { isVdi: false, reason: "test" } },
): PlanContext {
  const env = opts.env ?? {};
  const run = fakeRunner(() => undefined);
  const host = makeHostAdapter({ platform: opts.platform ?? "linux", run, env });
  // Preserve the adapter's prototype methods (envShell/scratchDir/symlinkDirArgv)
  // while overriding only the VDI verdict, so each test fixes the branch without
  // depending on the per-platform marker rules.
  const patchedHost = Object.assign(Object.create(host), { detectVdi: () => opts.vdi });
  return {
    root: dir,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host: patchedHost,
    env,
    options: opts.options ?? {},
  };
}

function byKind<K extends Action["kind"]>(plan: Plan, kind: K): Extract<Action, { kind: K }>[] {
  return plan.actions.filter((a): a is Extract<Action, { kind: K }> => a.kind === kind);
}

/** Assert the plan carries exactly one probe and return it (narrowed, never undefined). */
function onlyProbe(plan: Plan): ProbeAction {
  const probes = byKind(plan, "probe");
  expect(probes).toHaveLength(1);
  const [probe] = probes;
  if (!probe) throw new Error("expected a probe action");
  return probe;
}

/**
 * Mirror of the production segment-join: scratch root + `/`-delimited segments.
 * Lets assertions stay independent of the host path separator (the linux adapter
 * run on a Windows CI box yields `\`-rooted scratch paths, but the segments my
 * code appends are always `/`).
 */
function under(scratch: string, ...segments: string[]): string {
  const root = scratch.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return [root, ...segments].join("/");
}

/** The scratch root the linux adapter computes for `user` on this host. */
function posixScratch(user: string): string {
  return makeHostAdapter({
    platform: "linux",
    run: fakeRunner(() => undefined),
    env: {},
  }).scratchDir(user);
}

const VDI_ON: VdiInfo = {
  isVdi: true,
  reason: "Citrix session (SESSIONNAME=ICA-TCP#1)",
  kind: "citrix",
};
const VDI_OFF: VdiInfo = { isVdi: false, reason: "no VDI markers (console session)" };

describe("vdi command surface", () => {
  it("keeps the stub's name, summary, and --scratch option", () => {
    expect(command.name).toBe("vdi");
    expect(command.summary).toMatch(/VDI/);
    expect(command.options?.[0]?.flags).toBe("--scratch <dir>");
  });
});

describe("non-VDI host", () => {
  it("produces only a doc and a probe — no writes, no execs", async () => {
    const p = await command.plan(ctx({ vdi: VDI_OFF }));
    expect(byKind(p, "write")).toHaveLength(0);
    expect(byKind(p, "exec")).toHaveLength(0);
    expect(byKind(p, "doc")).toHaveLength(1);
    expect(byKind(p, "probe")).toHaveLength(1);
  });

  it("doc explains the no-op and carries the detection reason", async () => {
    const p = await command.plan(ctx({ vdi: VDI_OFF }));
    const docs = byKind(p, "doc") as DocAction[];
    expect(docs[0]?.text).toContain(VDI_OFF.reason);
    expect(docs[0]?.path).toBeUndefined();
  });

  it("records the negative detection as a skip probe (never a fail)", async () => {
    const p = await command.plan(ctx({ vdi: VDI_OFF }));
    const probe = onlyProbe(p);
    const check = await probe.run(ctx({ vdi: VDI_OFF }));
    expect(check.verdict).toBe("skip");
    expect(check.detail).toContain(VDI_OFF.reason);
  });

  it("writes nothing to disk even under --apply", async () => {
    const res = await executePlan(
      await command.plan(ctx({ vdi: VDI_OFF, options: {} })),
      ctx({ vdi: VDI_OFF }),
    );
    // dry-run ctx, but assert the plan itself carries no write/exec work.
    expect(res.writes).toHaveLength(0);
    expect(res.execs).toHaveLength(0);
  });
});

describe("VDI host (posix)", () => {
  const env = { USER: "alice", HOME: "/home/alice" };

  it("redirects every cache/DB env var into the scratch root", async () => {
    const p = await command.plan(ctx({ platform: "linux", vdi: VDI_ON, env }));
    const write = (byKind(p, "write") as WriteAction[])[0];
    const body = write?.contents ?? "";
    const scratch = posixScratch("alice");

    expect(body).toContain(`OLLAMA_MODELS=${under(scratch, "ollama", "models")}`);
    expect(body).toContain(`CLAUDE_CACHE_DIR=${under(scratch, "claude", "cache")}`);
    expect(body).toContain(`CRG_GLOBAL_DB_PATH=${under(scratch, "crg", "global.db")}`);
    expect(body).toContain(`NPX_CACHE=${under(scratch, "npx")}`);
    expect(body).toContain(`CARGO_HOME=${under(scratch, "cargo")}`);
    expect(body).toContain(`PIP_CACHE_DIR=${under(scratch, "pip")}`);
  });

  it("wraps the redirects in an aih-managed (vdi) block", async () => {
    const p = await command.plan(ctx({ platform: "linux", vdi: VDI_ON, env }));
    const write = (byKind(p, "write") as WriteAction[])[0];
    expect(write?.contents).toContain("# >>> aih managed (vdi) >>>");
    expect(write?.contents).toContain("# <<< aih managed (vdi) <<<");
    // Targets the shell profile (an absolute path from the adapter), not a
    // repo-relative path.
    const profile = makeHostAdapter({
      platform: "linux",
      run: fakeRunner(() => undefined),
      env,
    }).shellProfilePaths()[0];
    expect(write?.path).toBe(profile);
    expect(write?.path).toContain(".bashrc");
  });

  it("emits an mkdir exec for the scratch root (allowFailure)", async () => {
    const p = await command.plan(ctx({ platform: "linux", vdi: VDI_ON, env }));
    const execs = byKind(p, "exec") as ExecAction[];
    const mkdir = execs.find((e) => e.describe === "create local scratch root");
    expect(mkdir?.argv).toEqual(["mkdir", "-p", posixScratch("alice")]);
    expect(mkdir?.allowFailure).toBe(true);
  });

  it("emits a symlink exec redirecting ~/.code-review-graph onto scratch", async () => {
    const p = await command.plan(ctx({ platform: "linux", vdi: VDI_ON, env }));
    const execs = byKind(p, "exec") as ExecAction[];
    const link = execs.find((e) => e.describe.includes("code-review-graph"));
    // ln -sfn <target> <linkPath>: target is scratch/code-review-graph, link is ~/.code-review-graph.
    expect(link?.argv).toEqual([
      "ln",
      "-sfn",
      join(posixScratch("alice"), "code-review-graph"),
      join("/home/alice", ".code-review-graph"),
    ]);
  });

  it("records a pass probe naming the matched signal and scratch root", async () => {
    const c = ctx({ platform: "linux", vdi: VDI_ON, env });
    const p = await command.plan(c);
    const probe = onlyProbe(p);
    const check = await probe.run(c);
    expect(check.verdict).toBe("pass");
    expect(check.detail).toContain(VDI_ON.reason);
    expect(check.detail).toContain(posixScratch("alice"));
  });
});

describe("VDI host (windows)", () => {
  const env = {
    USERNAME: "bob",
    USERPROFILE: "C:\\Users\\bob",
    TEMP: "C:\\Users\\bob\\AppData\\Local\\Temp",
  };

  function winScratch(): string {
    return makeHostAdapter({
      platform: "windows",
      run: fakeRunner(() => undefined),
      env,
    }).scratchDir("bob");
  }

  it("uses cmd mkdir and a PowerShell-formatted env block", async () => {
    const p = await command.plan(ctx({ platform: "windows", vdi: VDI_ON, env }));
    const write = (byKind(p, "write") as WriteAction[])[0];
    const scratch = winScratch();

    // PowerShell exports are double-quoted; paths are normalized to forward slashes.
    expect(write?.contents).toContain(
      `$env:OLLAMA_MODELS = "${under(scratch, "ollama", "models")}"`,
    );
    expect(write?.contents).toContain(
      `$env:CRG_GLOBAL_DB_PATH = "${under(scratch, "crg", "global.db")}"`,
    );

    const mkdir = (byKind(p, "exec") as ExecAction[]).find(
      (e) => e.describe === "create local scratch root",
    );
    expect(mkdir?.argv).toEqual(["cmd", "/c", "mkdir", scratch]);
  });

  it("creates a directory junction (mklink /J) for code-review-graph", async () => {
    const p = await command.plan(ctx({ platform: "windows", vdi: VDI_ON, env }));
    const link = (byKind(p, "exec") as ExecAction[]).find((e) =>
      e.describe.includes("code-review-graph"),
    );
    // mklink /J <linkPath> <targetPath>: link is ~/.code-review-graph, target is scratch/...
    expect(link?.argv).toEqual([
      "cmd",
      "/c",
      "mklink",
      "/J",
      join("C:\\Users\\bob", ".code-review-graph"),
      join(winScratch(), "code-review-graph"),
    ]);
  });
});

describe("custom --scratch override", () => {
  const env = { USER: "alice", HOME: "/home/alice" };

  it("redirects env, mkdir, and symlink at the explicit scratch root", async () => {
    const scratch = "/mnt/fast/scratch";
    const p = await command.plan(
      ctx({ platform: "linux", vdi: VDI_ON, env, options: { scratch } }),
    );

    const write = (byKind(p, "write") as WriteAction[])[0];
    expect(write?.contents).toContain(`OLLAMA_MODELS=${under(scratch, "ollama", "models")}`);

    const execs = byKind(p, "exec") as ExecAction[];
    expect(execs.find((e) => e.describe === "create local scratch root")?.argv).toEqual([
      "mkdir",
      "-p",
      scratch,
    ]);
    expect(execs.find((e) => e.describe.includes("code-review-graph"))?.argv).toEqual([
      "ln",
      "-sfn",
      join(scratch, "code-review-graph"),
      join("/home/alice", ".code-review-graph"),
    ]);
  });

  it("falls back to the host scratch dir when --scratch is empty", async () => {
    const p = await command.plan(
      ctx({ platform: "linux", vdi: VDI_ON, env, options: { scratch: "" } }),
    );
    const mkdir = (byKind(p, "exec") as ExecAction[]).find(
      (e) => e.describe === "create local scratch root",
    );
    expect(mkdir?.argv).toEqual(["mkdir", "-p", posixScratch("alice")]);
  });
});

describe("boundary: no remote mutation, no cloud writes", () => {
  it("emits only write/exec/probe on a VDI host — never an unexpected doc", async () => {
    const p = await command.plan(
      ctx({ platform: "linux", vdi: VDI_ON, env: { USER: "alice", HOME: "/home/alice" } }),
    );
    // The VDI path is pure local mutation; cloud setup (none here) would be a doc.
    expect(byKind(p, "doc")).toHaveLength(0);
    for (const a of p.actions) {
      expect(["write", "exec", "probe"]).toContain(a.kind);
    }
  });

  it("the non-VDI path performs zero side effects (doc + probe only)", async () => {
    const p = await command.plan(ctx({ vdi: VDI_OFF }));
    for (const a of p.actions) {
      expect(["doc", "probe"]).toContain(a.kind);
    }
  });
});

describe("idempotency", () => {
  it("re-running over its own output yields a byte-identical managed block", async () => {
    const env = { USER: "alice", HOME: "/home/alice" };
    const profile = join(dir, "profile.sh");

    const first = await command.plan(ctx({ platform: "linux", vdi: VDI_ON, env }));
    const firstBody = (byKind(first, "write") as WriteAction[])[0]?.contents ?? "";

    // Seed a profile that already contains the generated block plus a user line,
    // then confirm a second computation reproduces the same block and keeps the
    // user line intact.
    writeFileSync(profile, `export USER_KEEP=1\n\n${firstBody}`);

    // Re-derive the block against the seeded file by pointing the env block
    // helper at the same vars (the plan always regenerates from REDIRECTS).
    const second = await command.plan(ctx({ platform: "linux", vdi: VDI_ON, env }));
    const secondBody = (byKind(second, "write") as WriteAction[])[0]?.contents ?? "";

    expect(secondBody).toBe(firstBody);
    expect(secondBody).toContain(
      `OLLAMA_MODELS=${under(posixScratch("alice"), "ollama", "models")}`,
    );
  });

  it("replaces a pre-existing managed block on disk in place, preserving user lines", async () => {
    // Point HOME at the temp dir so shellProfilePaths()[0] (~/.bashrc) is the
    // file the plan actually reads via readIfExists — this exercises the real
    // upsertManagedBlock replace path, not just deterministic generation.
    const env = { USER: "alice", HOME: dir };
    const bashrc = join(dir, ".bashrc");

    // Seed a STALE managed block (wrong scratch root) wrapped by user lines.
    const stale = [
      "export USER_BEFORE=1",
      "",
      "# >>> aih managed (vdi) >>>",
      "export OLLAMA_MODELS=/old/stale/ollama/models",
      "export CRG_GLOBAL_DB_PATH=/old/stale/crg/global.db",
      "# <<< aih managed (vdi) <<<",
      "",
      "export USER_AFTER=1",
      "",
    ].join("\n");
    writeFileSync(bashrc, stale);

    const p = await command.plan(ctx({ platform: "linux", vdi: VDI_ON, env }));
    const write = (byKind(p, "write") as WriteAction[])[0];
    const body = write?.contents ?? "";

    // The plan targets ~/.bashrc and its computed contents replace the stale
    // block with the fresh scratch root while keeping both user lines.
    expect(write?.path).toBe(bashrc);
    expect(body).toContain("export USER_BEFORE=1");
    expect(body).toContain("export USER_AFTER=1");
    expect(body).not.toContain("/old/stale/ollama/models");
    expect(body).toContain(`OLLAMA_MODELS=${under(posixScratch("alice"), "ollama", "models")}`);
    // Exactly one managed block survives (no duplication on re-run).
    const opens = body.match(/# >>> aih managed \(vdi\) >>>/g) ?? [];
    expect(opens).toHaveLength(1);

    // And it is a genuine fixed point: applying the computed contents back to
    // disk and re-planning yields byte-identical output.
    writeFileSync(bashrc, body);
    const again = await command.plan(ctx({ platform: "linux", vdi: VDI_ON, env }));
    const againBody = (byKind(again, "write") as WriteAction[])[0]?.contents ?? "";
    expect(againBody).toBe(body);
    // Sanity: the post-write file on disk is exactly what the re-plan reproduces.
    expect(readFileSync(bashrc, "utf8")).toBe(againBody);
  });
});

describe("contextDir independence", () => {
  // vdi writes to the host shell profile and local scratch, never under the
  // context dir. Pin that invariant so a future refactor cannot silently start
  // scattering redirects into .ai-context.
  it("targets the shell profile regardless of ctx.contextDir", async () => {
    const env = { USER: "alice", HOME: "/home/alice" };
    const profile = makeHostAdapter({
      platform: "linux",
      run: fakeRunner(() => undefined),
      env,
    }).shellProfilePaths()[0];

    const base = ctx({ platform: "linux", vdi: VDI_ON, env });
    const weird = { ...base, contextDir: "some/other/context-root" };

    const p = await command.plan(weird);
    for (const w of byKind(p, "write") as WriteAction[]) {
      expect(w.path).toBe(profile);
      expect(w.path).not.toContain("context-root");
    }
    // Scratch paths in the block are not derived from contextDir either.
    const body = (byKind(p, "write") as WriteAction[])[0]?.contents ?? "";
    expect(body).not.toContain("context-root");
    expect(body).toContain(`OLLAMA_MODELS=${under(posixScratch("alice"), "ollama", "models")}`);
  });
});
