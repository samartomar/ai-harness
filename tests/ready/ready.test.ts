import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedBlock } from "../../src/bootstrap-ai/canon.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { Action, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type RunResult } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/ready/index.js";

const DIR_NAME = "ai-coding";

/** Which tools the fake runner should report as present on PATH / runnable. */
interface Tools {
  node?: boolean;
  npm?: boolean;
  git?: boolean;
  rg?: boolean;
  fd?: boolean;
  jq?: boolean;
  /** TLS handshake to the registry: "ok" (default) | "fail". */
  tls?: "ok" | "fail";
  /** Package-manager binaries to report on PATH (for the install path), e.g. ["brew"]. */
  pms?: string[];
}

let dir: string; // repo root
let home: string; // fake home for CLI config-dir detection

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-ready-"));
  home = mkdtempSync(join(tmpdir(), "aih-ready-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A runner that answers `which/where`, node/npm `--version`, `git --version`, and TLS. */
function toolRunner(t: Tools): PlanContext["run"] {
  const present = (name: string, on: boolean | undefined): Partial<RunResult> =>
    on
      ? { code: 0, stdout: `/usr/bin/${name}` }
      : { spawnError: true, code: 127, stderr: "not found" };
  return fakeRunner((argv) => {
    const cmd = argv[0] ?? "";
    if (cmd === "curl") {
      return (t.tls ?? "ok") === "ok"
        ? { code: 0 }
        : { code: 1, stderr: "SSL certificate problem" };
    }
    if (cmd === "which") {
      const bin = argv[1] ?? "";
      if (bin === "rg") return present(bin, t.rg);
      if (bin === "fd") return present(bin, t.fd);
      if (bin === "jq") return present(bin, t.jq);
      // Package managers probed by detectPms (only when the install path runs).
      if ((t.pms ?? []).includes(bin)) return present(bin, true);
      return { spawnError: true, code: 127 };
    }
    if (cmd === "node")
      return t.node === false ? { spawnError: true, code: 127 } : { code: 0, stdout: "v20.11.0" };
    if (cmd === "npm")
      return t.npm === false
        ? { code: 1, stderr: "Cannot find module" }
        : { code: 0, stdout: "10.9.2" };
    if (cmd === "git")
      return t.git === false
        ? { spawnError: true, code: 127 }
        : { code: 0, stdout: "git version 2.44" };
    return undefined;
  });
}

function ctx(tools: Tools = {}, over: Partial<PlanContext> = {}): PlanContext {
  const run = toolRunner({
    node: true,
    npm: true,
    git: true,
    rg: true,
    fd: true,
    jq: true,
    ...tools,
  });
  return {
    root: dir,
    contextDir: DIR_NAME,
    apply: false,
    verify: true, // alwaysVerify: aih ready always runs its probes
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { HOME: home } }),
    env: { HOME: home, USERPROFILE: home, PATH: "/usr/bin" },
    options: {},
    ...over,
  };
}

/** Write a file, creating parent dirs. */
function put(rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/** An in-sync CLAUDE.md bootloader that routes to the router. */
function inSyncBootloader(): string {
  return mergeManagedBlock(undefined, sharedBlock(DIR_NAME), "# Repo — Claude Code");
}

/** Scaffold a clean, fully-wired repo whose targeted CLI (claude) loads. */
function scaffoldReady(): void {
  put(`${DIR_NAME}/RULE_ROUTER.md`, "Read RULE_ROUTER.md first — routing.\n");
  put(`${DIR_NAME}/rules/agent-behavior-core.md`, "# Agent behavior core\n");
  put(`${DIR_NAME}/adapters/_shared-canonical-block.md`, sharedBlock(DIR_NAME).body);
  put(`${DIR_NAME}/adapters/claude.md`, "# Claude adapter\n");
  put("CLAUDE.md", inSyncBootloader());
  put(".gitleaks.toml", "title = 'x'\n");
  put(".pre-commit-config.yaml", "repos: []\n");
  put(".git/hooks/pre-commit", "#!/bin/sh\n");
  put(
    "package.json",
    JSON.stringify({ name: "demo", scripts: { start: "node index.js", test: "vitest" } }),
  );
}

/** Pull the digest + gate probe out of a built plan for assertions. */
function actionsOf(actions: Action[]): {
  digest: Extract<Action, { kind: "digest" }>;
  gate: Extract<Action, { kind: "probe" }>;
} {
  const digest = actions.find((a) => a.kind === "digest");
  const gate = actions.find((a) => a.kind === "probe");
  if (digest?.kind !== "digest") throw new Error("expected a digest action");
  if (gate?.kind !== "probe") throw new Error("expected a gate probe action");
  return { digest, gate };
}

describe("aih ready — plan shape", () => {
  it("returns a digest + a single gate probe", async () => {
    const built = await command.plan(ctx());
    expect(built.capability).toBe("ready");
    const probes = built.actions.filter((a) => a.kind === "probe");
    const digests = built.actions.filter((a) => a.kind === "digest");
    expect(digests).toHaveLength(1);
    expect(probes).toHaveLength(1); // one readiness gate, not one probe per check
    const { digest, gate } = actionsOf(built.actions);
    expect(digest.describe).toBe("Developer readiness");
    expect(gate.describe).toBe("readiness — no blockers");
  });

  it("alwaysVerify is set so a bare `aih ready` diagnoses by default", () => {
    expect(command.alwaysVerify).toBe(true);
    expect(command.readOnly).toBeUndefined();
  });
});

describe("aih ready — the gate probe drives the exit code", () => {
  it("a broken runtime (npm fails) → gate probe run() returns fail + NOT READY banner", async () => {
    scaffoldReady();
    const c = ctx({ npm: false });
    const built = await command.plan(c);
    const { digest, gate } = actionsOf(built.actions);

    // The exit-code path: run() the gate probe → fail with a coded blocker roll-up.
    const check = await gate.run(c);
    expect(check.verdict).toBe("fail");
    expect(check.code).toBe("ready.blocked");
    expect(check.detail).toContain("npm-runtime");

    // The digest banner echoes the same NOT-READY verdict.
    expect((digest.data as { banner: string }).banner).toBe("NOT READY");
  });

  it("a clean, wired repo on a healthy machine → gate probe passes", async () => {
    scaffoldReady();
    const c = ctx();
    const built = await command.plan(c);
    const { digest, gate } = actionsOf(built.actions);

    const check = await gate.run(c);
    expect(check.verdict).toBe("pass");
    expect(check.detail).toContain("an agent can start here");
    expect((digest.data as { banner: string }).banner).not.toBe("NOT READY");
  });
});

describe("aih ready — the first-command handoff line", () => {
  it("names the declared command when the repo declares one (never runs it)", async () => {
    scaffoldReady();
    const built = await command.plan(ctx());
    const { digest } = actionsOf(built.actions);
    const text = digest.text ?? "";
    // scanRepo normalizes a declared `start` script to its canonical `npm start`.
    expect(text).toContain("Your first command:  npm start");
    expect(text).toContain("aih stops here");
  });

  it("points to setup.md when no runnable command is declared", async () => {
    // Empty repo: no package.json → no declared command.
    const built = await command.plan(ctx());
    const { digest } = actionsOf(built.actions);
    const text = digest.text ?? "";
    expect(text).toContain("No runnable command declared — see setup.md before starting.");
    expect((digest.data as { firstCommand: string | null }).firstCommand).toBeNull();
  });
});

/** Exec actions in a built plan (the install commands). */
const execsOf = (actions: Action[]): Extract<Action, { kind: "exec" }>[] =>
  actions.filter((a): a is Extract<Action, { kind: "exec" }> => a.kind === "exec");

describe("aih ready — confirmation-gated core-tool installs (slice 4)", () => {
  it("--apply with rg/fd/jq absent → the plan includes install ExecActions for the missing tools", async () => {
    scaffoldReady();
    // rg/fd/jq missing, brew available as the package manager.
    const c = ctx({ rg: false, fd: false, jq: false, pms: ["brew"] }, { apply: true });
    const built = await command.plan(c);

    // The digest + gate probe STILL print (installs are additive).
    const { digest, gate } = actionsOf(built.actions);
    expect(digest.describe).toBe("Developer readiness");
    expect(gate.describe).toBe("readiness — no blockers");

    // One install exec per missing core tool, reusing `aih tools`'s brew commands.
    const cmds = execsOf(built.actions).map((e) => e.argv);
    expect(cmds).toContainEqual(["brew", "install", "ripgrep"]);
    expect(cmds).toContainEqual(["brew", "install", "fd"]);
    expect(cmds).toContainEqual(["brew", "install", "jq"]);
    // Only the three core tools — no optional tools (ast-grep/gh/…) get installed here.
    expect(execsOf(built.actions)).toHaveLength(3);
    // The gate still reflects the pre-install diagnosis (NOT READY: core tools missing).
    expect((digest.data as { banner: string }).banner).toBe("NOT READY");
  });

  it("only the ABSENT core tools are installed (fd present → rg + jq only)", async () => {
    scaffoldReady();
    const c = ctx({ rg: false, fd: true, jq: false, pms: ["brew"] }, { apply: true });
    const cmds = execsOf((await command.plan(c)).actions).map((e) => e.argv);
    expect(cmds).toContainEqual(["brew", "install", "ripgrep"]);
    expect(cmds).toContainEqual(["brew", "install", "jq"]);
    expect(cmds).not.toContainEqual(["brew", "install", "fd"]);
    expect(cmds).toHaveLength(2);
  });

  it("no --apply, non-TTY (no prompter) → NO exec actions (diagnose only)", async () => {
    scaffoldReady();
    // Core tools missing but neither --apply nor a prompter → diagnose only.
    const c = ctx({ rg: false, fd: false, jq: false, pms: ["brew"] });
    const built = await command.plan(c);
    expect(execsOf(built.actions)).toHaveLength(0);
    // The gate still fails (the digest already carries the install command).
    const { gate } = actionsOf(built.actions);
    const check = await gate.run(c);
    expect(check.verdict).toBe("fail");
    expect(check.code).toBe("ready.blocked");
  });

  it("all core tools present → no install actions regardless of --apply", async () => {
    scaffoldReady();
    // Defaults have rg/fd/jq present; even with --apply there is nothing to install.
    const built = await command.plan(ctx({ pms: ["brew"] }, { apply: true }));
    expect(execsOf(built.actions)).toHaveLength(0);
  });

  it("interactive `y` at the prompt → installs; `n` → diagnose only", async () => {
    scaffoldReady();
    const asks: string[] = [];
    const yes = {
      ask: async (q: string): Promise<string> => {
        asks.push(q);
        return "y";
      },
    };
    const no = { ask: async (): Promise<string> => "n" };

    const cYes = ctx({ rg: false, fd: false, jq: false, pms: ["brew"] }, { prompter: yes });
    const builtYes = await command.plan(cYes);
    expect(execsOf(builtYes.actions).map((e) => e.argv)).toContainEqual([
      "brew",
      "install",
      "ripgrep",
    ]);
    // The prompt names the missing tools.
    expect(asks[0]).toContain("Install rg, fd, jq now?");

    const cNo = ctx({ rg: false, fd: false, jq: false, pms: ["brew"] }, { prompter: no });
    expect(execsOf((await command.plan(cNo)).actions)).toHaveLength(0);
  });

  it("a still-missing core tool after install escalates as env.tool-install-blocked", async () => {
    scaffoldReady();
    // No package manager at all → the install can't run; the verify probe fails coded.
    const c = ctx({ rg: false, fd: false, jq: false, pms: [] }, { apply: true });
    const built = await command.plan(c);
    const rgProbe = built.actions.find(
      (a): a is Extract<Action, { kind: "probe" }> =>
        a.kind === "probe" && a.describe.includes("ripgrep"),
    );
    const check = await rgProbe?.run(c);
    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("env.tool-install-blocked");
  });
});
