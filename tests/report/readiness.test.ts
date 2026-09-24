import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sharedBlock } from "../../src/bootstrap-ai/canon.js";
import type { Posture } from "../../src/config/posture.js";
import type { RuntimeEvidenceResult } from "../../src/heal/opencode-runtime-evidence.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type RunResult } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command as reportCommand } from "../../src/report/index.js";
import {
  computeReadiness,
  readinessDigest,
  runtimeEvidenceDigest,
} from "../../src/report/readiness.js";
import { openCodeRuntimeFixture } from "../heal/opencode-runtime-evidence-fixture.js";

const DIR_NAME = "ai-coding";

it("keeps missing required policy content as a blocker beside host preflight", async () => {
  scaffoldReady();
  put(
    "aih-org-policy.json",
    JSON.stringify({
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "harbor-1",
        supportedClis: ["claude"],
        catalog: { reviewed: [], custom: [] },
        externalSelections: [
          {
            framework: "ecc",
            items: [
              {
                id: "skill:tdd-workflow",
                kind: "skill",
                source: {
                  repository: "affaan-m/ECC",
                  commit: "a".repeat(40),
                  path: "skills/tdd-workflow",
                },
              },
            ],
          },
        ],
      },
    }),
  );
  const result = await computeReadiness(ctx({ gitRepo: true }, { targets: ["claude"] }));
  expect(result.banner).toBe("NOT READY");
  expect(result.blockers).toContainEqual(expect.objectContaining({ id: "policy-delivery" }));
  expect(result.policyDelivery?.components[0]).toMatchObject({
    state: "missing-receipt",
    nativeLoading: "unverified",
  });
});

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
  runtimeEvidence?: RuntimeEvidenceResult;
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
  /** `git rev-parse --is-inside-work-tree` answers "true" (repo root is a work tree). */
  gitRepo?: boolean;
  /** rev-parse ERRORS (git present but failing, e.g. dubious ownership) instead of answering. */
  gitRevParseError?: boolean;
  /** Paths `git ls-files` reports as tracked (the committed-secret classifier input). */
  gitTracked?: string[];
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
    if (cmd === "git") {
      if (t.git === false) return { spawnError: true, code: 127 };
      if (argv.includes("rev-parse")) {
        if (t.gitRevParseError) {
          return { code: 128, stderr: "fatal: detected dubious ownership in repository" };
        }
        return t.gitRepo
          ? { code: 0, stdout: "true" }
          : { code: 128, stderr: "fatal: not a git repository" };
      }
      if (argv.includes("ls-files")) return { code: 0, stdout: (t.gitTracked ?? []).join("\0") };
      return { code: 0, stdout: "git version 2.44" };
    }
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

describe("readinessDigest — explicit runtime observation", () => {
  it("keeps default data byte-compatible and emits a separate report digest only on request", async () => {
    scaffoldReady();
    const baseline = await digestData(ctx());
    expect(baseline.data.runtimeEvidence).toBeUndefined();
    expect(runtimeEvidenceDigest(ctx())).toBeUndefined();
    expect(reportCommand.options).toContainEqual({
      flags: "--runtime-evidence <absolute-file>",
      description: expect.stringContaining("OpenCode"),
    });
  });

  it("rejects runtime evidence outside the bounded local v9 report", async () => {
    await expect(
      reportCommand.plan(ctx({}, { options: { runtimeEvidence: "/tmp/observation.json" } })),
    ).rejects.toMatchObject({ code: "AIH_REPORT" });
    await expect(
      reportCommand.plan(
        ctx(
          {},
          { options: { v9: true, org: "org.json", runtimeEvidence: "/tmp/observation.json" } },
        ),
      ),
    ).rejects.toMatchObject({ code: "AIH_REPORT" });
  });

  it("shares one current evaluation across ready data and report JSON/terminal digest", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-13T12:10:00.000Z");
    const native = openCodeRuntimeFixture();
    rmSync(dir, { recursive: true, force: true });
    dir = native.root;
    try {
      scaffoldReady();
      const c = ctx({}, { options: { cli: "opencode", runtimeEvidence: native.evidencePath } });
      const readinessRun = c.run;
      c.run = async (argv, options) =>
        argv[0] === native.paths.opencode
          ? { code: 0, stdout: "opencode version 1.18.11\n", stderr: "" }
          : readinessRun(argv, options);
      const readiness = await digestData(c);
      const runtime = runtimeEvidenceDigest(c);
      const runtimeResult = runtime?.run ? await runtime.run(c) : undefined;
      if (!runtimeResult || typeof runtimeResult === "string") {
        throw new Error("expected structured runtime digest result");
      }
      expect(runtimeResult.data).toEqual(readiness.data.runtimeEvidence);
      expect(runtime?.describe).toBe("OpenCode runtime observation");
      expect(runtimeResult.text).toContain("current");
      expect(runtimeResult.text).toContain("expires 2026-09-13T13:00:00.000Z");
    } finally {
      native.cleanup();
      vi.useRealTimers();
    }
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

  it("a runnable Node OLDER than 20.6 fails the gate the title promises (>= 20.6)", async () => {
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

  it("Node 20.6+ still passes (no false negative from the version parse)", async () => {
    scaffoldReady();
    const { data } = await digestData(ctx({ nodeVersion: "v22.3.0" }));
    expect(data.blockers.some((b) => b.id === "node-runtime")).toBe(false);
  });

  it("Node 20.5 fails and 20.6 passes: the floor is import.meta.resolve, not the major version", async () => {
    scaffoldReady();
    const below = await digestData(ctx({ nodeVersion: "v20.5.1" }));
    expect(below.data.blockers.some((b) => b.id === "node-runtime")).toBe(true);
    const at = await digestData(ctx({ nodeVersion: "v20.6.0" }));
    expect(at.data.blockers.some((b) => b.id === "node-runtime")).toBe(false);
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
  it("a plaintext secret (on-disk class here) is a WARN at vibe but a GATE at enterprise", async () => {
    scaffoldReady();
    // The fixture dir is NOT a git work tree, so nothing can be committed: the
    // finding must carry the on-disk class, with the same posture split.
    put(".env", "API_KEY=sk-live-abcdef0123456789\n");

    const vibe = await digestData(ctx({}, { posture: "vibe" as Posture }));
    expect(vibe.data.blockers.some((b) => b.id === "no-plaintext-secret-on-disk")).toBe(false);
    expect(vibe.data.warns.some((w) => w.id === "no-plaintext-secret-on-disk")).toBe(true);

    const ent = await digestData(ctx({}, { posture: "enterprise" as Posture }));
    expect(ent.data.blockers.some((b) => b.id === "no-plaintext-secret-on-disk")).toBe(true);
    expect(ent.data.banner).toBe("NOT READY");
  });

  it("an UNTRACKED .env in a git repo reports the on-disk class + vault remediation (issue #502)", async () => {
    scaffoldReady();
    put(".env", "API_KEY=sk-live-abcdef0123456789\n");
    const { data } = await digestData(
      ctx({ gitRepo: true, gitTracked: [] }, { posture: "enterprise" as Posture }),
    );
    const onDisk = data.blockers.find((b) => b.id === "no-plaintext-secret-on-disk");
    expect(onDisk).toBeDefined();
    expect(onDisk?.cmd).toContain("vault");
    // Relabelled, never dropped — and never misfiled as the committed class.
    expect(data.blockers.some((b) => b.id === "no-committed-secret")).toBe(false);
    expect(data.banner).toBe("NOT READY");
  });

  it("a TRACKED .env reports the committed class + history-rewrite remediation", async () => {
    scaffoldReady();
    put(".env", "API_KEY=sk-live-abcdef0123456789\n");
    const { data } = await digestData(
      ctx({ gitRepo: true, gitTracked: [".env"] }, { posture: "enterprise" as Posture }),
    );
    const committed = data.blockers.find((b) => b.id === "no-committed-secret");
    expect(committed).toBeDefined();
    expect(committed?.cmd).toContain("history");
    expect(committed?.cmd).toContain("rotate");
    expect(data.blockers.some((b) => b.id === "no-plaintext-secret-on-disk")).toBe(false);
  });

  it("git unavailable → the finding stays under the committed gate (fail closed, never dropped)", async () => {
    scaffoldReady();
    put(".env", "API_KEY=sk-live-abcdef0123456789\n");
    const { data } = await digestData(ctx({ git: false }, { posture: "enterprise" as Posture }));
    expect(data.blockers.some((b) => b.id === "no-committed-secret")).toBe(true);
  });

  it("a rev-parse ERROR (git present but failing) fails closed to the committed class (review F3)", async () => {
    // Dubious-ownership and similar failures are NOT "not a work tree": the
    // truth is unknown, so the finding keeps the strongest (committed) gate.
    scaffoldReady();
    put(".env", "API_KEY=sk-live-abcdef0123456789\n");
    const { data } = await digestData(
      ctx({ gitRevParseError: true }, { posture: "enterprise" as Posture }),
    );
    expect(data.blockers.some((b) => b.id === "no-committed-secret")).toBe(true);
    expect(data.blockers.some((b) => b.id === "no-plaintext-secret-on-disk")).toBe(false);
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
