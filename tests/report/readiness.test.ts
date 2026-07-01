import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedBlock } from "../../src/bootstrap-ai/canon.js";
import type { Posture } from "../../src/config/posture.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type RunResult } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { readinessDigest } from "../../src/report/readiness.js";

const DIR_NAME = "ai-coding";

interface Row {
  id: string;
  title: string;
  cmd: string;
  dimension: string;
}
interface ReadinessData {
  banner: "NOT READY" | "READY" | "READY, WITH GAPS";
  blockers: Row[];
  score: number;
  rawScore: number;
  grade: string;
  warns: Row[];
  firstCommand: string | null;
}

/** Which tools the fake runner should report as present on PATH / runnable. */
interface Tools {
  node?: boolean;
  /** node --version stdout (default "v20.11.0"); set e.g. "v18.19.0" to test the >=20 gate. */
  nodeVersion?: string;
  /** node present but exits non-zero (a broken install). */
  nodeBroken?: boolean;
  npm?: boolean;
  git?: boolean;
  rg?: boolean;
  fd?: boolean;
  jq?: boolean;
  /** TLS handshake to the registry: "ok" (default) | "fail". */
  tls?: "ok" | "fail";
}

let dir: string; // repo root
let home: string; // fake home for CLI config-dir detection

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-readiness-"));
  home = mkdtempSync(join(tmpdir(), "aih-readiness-home-"));
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
    // TLS probe (curl -Iv … url).
    if (cmd === "curl") {
      return (t.tls ?? "ok") === "ok"
        ? { code: 0 }
        : { code: 1, stderr: "SSL certificate problem" };
    }
    // `which <bin>` PATH probe (linux).
    if (cmd === "which") {
      const bin = argv[1] ?? "";
      if (bin === "rg") return present(bin, t.rg);
      if (bin === "fd") return present(bin, t.fd);
      if (bin === "jq") return present(bin, t.jq);
      return { spawnError: true, code: 127 };
    }
    // node/npm `--version` run directly on POSIX.
    if (cmd === "node") {
      if (t.node === false) return { spawnError: true, code: 127 };
      if (t.nodeBroken) return { code: 1, stderr: "boom" };
      return { code: 0, stdout: t.nodeVersion ?? "v20.11.0" };
    }
    if (cmd === "npm")
      return t.npm === false
        ? { code: 1, stderr: "Cannot find module" }
        : { code: 0, stdout: "10.9.2" };
    // git.
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
    verify: false,
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
  // A declared start command so firstCommand is populated + the declared-commands warn passes.
  put(
    "package.json",
    JSON.stringify({ name: "demo", scripts: { start: "node index.js", test: "vitest" } }),
  );
}

async function digestData(c: PlanContext): Promise<{ data: ReadinessData; text: string }> {
  const d = readinessDigest(c);
  expect(d.run).toBeDefined();
  if (!d.run) throw new Error("expected a run() on the digest");
  const result = await d.run(c);
  if (typeof result === "string") throw new Error("expected structured digest result");
  return { data: result.data as ReadinessData, text: result.text };
}

describe("readinessDigest — always renders", () => {
  it("never returns undefined (a harness-less repo is the most important case)", async () => {
    const d = readinessDigest(ctx());
    expect(d).toBeDefined();
    expect(d.kind).toBe("digest");
    expect(d.describe).toBe("Developer readiness");
  });

  it("an off-canon / empty repo still renders, with warns and no crash", async () => {
    const { data, text } = await digestData(ctx());
    // Empty repo: no bootloader wired, no contract, no guardrails → warns present.
    expect(data.warns.length).toBeGreaterThan(0);
    expect(["READY", "READY, WITH GAPS", "NOT READY"]).toContain(data.banner);
    expect(text).toContain("/100");
    // firstCommand carries the declared command or null — here null (no package.json).
    expect(data.firstCommand).toBeNull();
  });
});

describe("readinessDigest — a ready repo", () => {
  it("has no blockers and a READY-ish banner on a clean machine + wired repo", async () => {
    scaffoldReady();
    const { data } = await digestData(ctx());
    expect(data.blockers).toEqual([]);
    expect(data.banner).not.toBe("NOT READY");
    expect(data.score).toBe(data.rawScore); // no cap without a blocker
    // The declared start command flows into firstCommand for the (later) handoff
    // renderer. scanRepo normalizes a declared `start` script to its canonical form.
    expect(data.firstCommand).toBe("npm start");
  });
});

describe("readinessDigest — a broken runtime", () => {
  it("npm broken → an npm blocker → NOT READY, displayed score capped ≤ 69", async () => {
    scaffoldReady();
    const { data } = await digestData(ctx({ npm: false }));
    expect(data.banner).toBe("NOT READY");
    expect(data.blockers.some((b) => b.id === "npm-runtime")).toBe(true);
    expect(data.score).toBeLessThanOrEqual(69);
    // The true score is preserved even when the display is capped.
    expect(data.rawScore).toBeGreaterThanOrEqual(data.score);
  });

  it("node absent → both node and npm surface (npm skipped, not a blocker itself)", async () => {
    const { data } = await digestData(ctx({ node: false }));
    expect(data.banner).toBe("NOT READY");
    expect(data.blockers.some((b) => b.id === "node-runtime")).toBe(true);
    // npm is blocked on node → skip → NOT its own blocker.
    expect(data.blockers.some((b) => b.id === "npm-runtime")).toBe(false);
  });

  it("core shell tools missing → a blocker", async () => {
    const { data } = await digestData(ctx({ rg: false, fd: false, jq: false }));
    expect(data.blockers.some((b) => b.id === "core-shell-tools")).toBe(true);
    expect(data.banner).toBe("NOT READY");
  });

  it("a runnable Node OLDER than 20 fails the gate the title promises (>= 20)", async () => {
    scaffoldReady();
    const { data } = await digestData(ctx({ nodeVersion: "v18.19.0" }));
    expect(data.blockers.some((b) => b.id === "node-runtime")).toBe(true);
    expect(data.banner).toBe("NOT READY");
  });

  it("a broken Node (present but non-zero exit) fails the gate, not passes", async () => {
    scaffoldReady();
    const { data } = await digestData(ctx({ nodeBroken: true }));
    expect(data.blockers.some((b) => b.id === "node-runtime")).toBe(true);
  });

  it("Node 20+ still passes (no false negative from the version parse)", async () => {
    scaffoldReady();
    const { data } = await digestData(ctx({ nodeVersion: "v22.3.0" }));
    expect(data.blockers.some((b) => b.id === "node-runtime")).toBe(false);
  });

  it("a repo with no declared build/test/start command dings repo-contract (warn, not skip)", async () => {
    // Fully wired EXCEPT there is no package.json script — the missing handoff command
    // must lower the score as a warn, not be silently dropped as a skip.
    scaffoldReady();
    rmSync(join(dir, "package.json"), { force: true });
    const { data } = await digestData(ctx());
    expect(data.warns.some((w) => w.id === "declared-commands")).toBe(true);
    expect(data.score).toBeLessThan(100);
  });
});

describe("readinessDigest — posture flips the amber gates", () => {
  it("a committed secret is a WARN at vibe but a GATE at enterprise", async () => {
    scaffoldReady();
    put(".env", "API_KEY=sk-live-abcdef0123456789\n");

    const vibe = await digestData(ctx({}, { posture: "vibe" as Posture }));
    expect(vibe.data.blockers.some((b) => b.id === "no-committed-secret")).toBe(false);
    expect(vibe.data.warns.some((w) => w.id === "no-committed-secret")).toBe(true);

    const ent = await digestData(ctx({}, { posture: "enterprise" as Posture }));
    expect(ent.data.blockers.some((b) => b.id === "no-committed-secret")).toBe(true);
    expect(ent.data.banner).toBe("NOT READY");
  });

  it("git-absent is a WARN at vibe but a GATE at enterprise", async () => {
    scaffoldReady();

    const vibe = await digestData(ctx({ git: false }, { posture: "vibe" as Posture }));
    expect(vibe.data.blockers.some((b) => b.id === "git-present")).toBe(false);
    expect(vibe.data.warns.some((w) => w.id === "git-present")).toBe(true);

    const ent = await digestData(ctx({ git: false }, { posture: "enterprise" as Posture }));
    expect(ent.data.blockers.some((b) => b.id === "git-present")).toBe(true);
  });
});

describe("readinessDigest — TLS gate + determinism", () => {
  it("a failing corporate TLS handshake is a machine blocker", async () => {
    scaffoldReady();
    const { data } = await digestData(ctx({ tls: "fail" }));
    expect(data.blockers.some((b) => b.id === "tls-ca-trust")).toBe(true);
    expect(data.banner).toBe("NOT READY");
  });

  it("is byte-stable across repeated runs (no dates/random)", async () => {
    scaffoldReady();
    const a = await digestData(ctx());
    const b = await digestData(ctx());
    expect(a.text).toBe(b.text);
  });
});
