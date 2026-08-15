import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { kiroHooks } from "../../src/kiro/content.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { scanRepo } from "../../src/profile/scan.js";
import { metricsToolCheck, usageRecorderCheck } from "../../src/usage/hook-health.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-hookhealth-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeCtx(
  run: Runner = fakeRunner(() => undefined),
  platform: "linux" | "windows" = "linux",
): PlanContext {
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform, run, env: {} }),
    env: {},
    options: {},
  };
}

function write(rel: string, content: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/**
 * Models the two git probes `usageRecorderCheck` runs:
 * - `git check-ignore -q` exits 0 iff the path IS ignored (1 otherwise).
 * - `git ls-files --error-unmatch` exits 0 iff the path is TRACKED (1 if untracked).
 * `git` absent → every git call is a spawnError (ENOENT).
 */
function gitRunner(opts: { ignored?: boolean; tracked?: boolean; gitAbsent?: boolean }): Runner {
  return fakeRunner((argv) => {
    if (argv[0] !== "git") return undefined;
    if (opts.gitAbsent) return { code: 127, stdout: "", spawnError: true };
    if (argv[1] === "check-ignore") return { code: opts.ignored ? 0 : 1, stdout: "" };
    if (argv[1] === "ls-files") return { code: opts.tracked ? 0 : 1, stdout: "" };
    return undefined;
  });
}

const CLAUDE_HOOK = JSON.stringify({
  hooks: {
    PostToolUse: [{ hooks: [{ command: "node .aih/usage-record.mjs --from claude; exit 0" }] }],
  },
});

/**
 * Governance ownership of the AIH usage/MCP surfaces keys off `governance.policyVersion`
 * (see `governanceOwnsAihSurfaces`), NOT the mere presence of an org policy — so these
 * two fixtures differ only by the governed `governance` block.
 */
const UNGOVERNED_POLICY = JSON.stringify({
  schemaVersion: 2,
  minimumPosture: "vibe",
  references: { repoContract: "ai-coding/project.json" },
});

const GOVERNED_POLICY = JSON.stringify({
  schemaVersion: 2,
  minimumPosture: "enterprise",
  references: { repoContract: "ai-coding/project.json" },
  mcp: { allowManagedOnly: true },
  governance: {
    policyVersion: "2026.08.0",
    supportedClis: ["claude"],
    catalog: { reviewed: [], custom: [] },
  },
});

describe("usageRecorderCheck", () => {
  it("skips when no committed hook references the recorder", async () => {
    const c = await usageRecorderCheck(makeCtx());
    expect(c.verdict).toBe("skip");
    expect(c.code).toBeUndefined();
  });

  it("fails (usage.recorder-missing) when a hook references an absent recorder", async () => {
    // The buggy fresh-clone state: hook committed, recorder gitignored away.
    write(".claude/settings.json", CLAUDE_HOOK);
    const c = await usageRecorderCheck(makeCtx());
    expect(c.verdict).toBe("fail");
    expect(c.code).toBe("usage.recorder-missing");
    expect(c.detail).toContain(".aih/usage-record.mjs");
  });

  it("checks the current Copilot and Antigravity hook hosts", async () => {
    write(
      ".github/hooks/aih-usage-metering.json",
      '{"hooks":{"postToolUse":[{"command":"node .aih/usage-record.mjs --from copilot"}]}}',
    );
    write(
      ".agents/hooks.json",
      '{"aih-usage-metering":{"PostToolUse":[{"hooks":[{"command":"node .aih/usage-record.mjs --from antigravity; exit 0"}]}]}}',
    );
    const c = await usageRecorderCheck(makeCtx());
    expect(c.verdict).toBe("fail");
    expect(c.code).toBe("usage.recorder-missing");
    expect(c.detail).toContain(".github/hooks/aih-usage-metering.json");
    expect(c.detail).toContain(".agents/hooks.json");
  });

  it("passes once the recorder is present, not ignored, AND git-tracked", async () => {
    write(
      ".kiro/hooks/aih-usage-metering.json",
      '{"version":"v1","hooks":[{"trigger":"Stop","action":{"command":"node .aih/usage-record.mjs --from kiro"}}]}',
    );
    write(".aih/usage-record.mjs", "// recorder\n");
    const c = await usageRecorderCheck(makeCtx(gitRunner({ ignored: false, tracked: true })));
    expect(c.verdict).toBe("pass");
    expect(c.detail).toContain("tracked");
  });

  it("fails when the recorder exists locally but is still git-ignored", async () => {
    // The false-pass trap: file on disk, but a stale `.aih/` exclude keeps it out of
    // the commit, so a fresh clone re-hits the missing-recorder failure.
    write(".claude/settings.json", CLAUDE_HOOK);
    write(".aih/usage-record.mjs", "// recorder\n");
    const c = await usageRecorderCheck(makeCtx(gitRunner({ ignored: true })));
    expect(c.verdict).toBe("fail");
    expect(c.code).toBe("usage.recorder-missing");
    expect(c.detail).toContain("git-ignored");
  });

  it("fails when the recorder is present and un-ignored but never git-added (untracked)", async () => {
    // The subtler false-pass: `check-ignore` exits non-zero for an untracked file just
    // as it does for a tracked one, so "not ignored" alone would wrongly pass. A fresh
    // clone still won't have an uncommitted recorder.
    write(".claude/settings.json", CLAUDE_HOOK);
    write(".aih/usage-record.mjs", "// recorder\n");
    const c = await usageRecorderCheck(makeCtx(gitRunner({ ignored: false, tracked: false })));
    expect(c.verdict).toBe("fail");
    expect(c.code).toBe("usage.recorder-missing");
    expect(c.detail).toContain("untracked");
  });

  /**
   * A governed policy refuses `aih usage` (`assertGovernanceOwnsSurface`), so the
   * remediation must not name it — that is the doctor deadlock: a permanent red whose
   * only advice is a command governance rejects. Governed repos reach the recorder
   * through `aih policy project`.
   */
  it("advises policy projection, not `aih usage`, when governance owns the usage surface", async () => {
    write(".claude/settings.json", CLAUDE_HOOK);
    write("aih-org-policy.json", GOVERNED_POLICY);
    const c = await usageRecorderCheck(makeCtx());
    expect(c.verdict).toBe("fail");
    expect(c.code).toBe("usage.recorder-missing");
    expect(c.detail).toContain("aih policy project --apply");
    expect(c.detail).not.toContain("aih usage --apply");
    // Both escapes must be named: projection is a silent no-op when the policy activates
    // no usage-metering candidate, and it refuses to adopt an unreceipted legacy hook.
    expect(c.detail).toContain("usage-metering");
    expect(c.detail).toContain("unreceipted");
  });

  it("advises policy projection for the git-ignored and untracked recorder states too", async () => {
    write(".claude/settings.json", CLAUDE_HOOK);
    write("aih-org-policy.json", GOVERNED_POLICY);
    write(".aih/usage-record.mjs", "// recorder\n");
    const ignored = await usageRecorderCheck(makeCtx(gitRunner({ ignored: true })));
    expect(ignored.detail).toContain("aih policy project --apply");
    expect(ignored.detail).not.toContain("aih usage --apply");
    const untracked = await usageRecorderCheck(
      makeCtx(gitRunner({ ignored: false, tracked: false })),
    );
    expect(untracked.detail).toContain("aih policy project --apply");
    expect(untracked.detail).not.toContain("aih usage --apply");
  });

  /**
   * An ungoverned policy (a supported-CLI allow-list without governed inventory) does
   * NOT take over the usage surface, so `aih usage --apply` still runs and stays the
   * correct advice. Governance ownership keys off `governance.policyVersion`, not the
   * mere presence of an org policy.
   */
  it("keeps advising `aih usage` when an org policy does not govern the usage surface", async () => {
    write(".claude/settings.json", CLAUDE_HOOK);
    write("aih-org-policy.json", UNGOVERNED_POLICY);
    const c = await usageRecorderCheck(makeCtx());
    expect(c.detail).toContain("aih usage --apply");
    expect(c.detail).not.toContain("aih policy project");
  });

  /** A malformed policy is another check's finding; this probe must not crash on it. */
  it("falls back to the ungoverned wording when the org policy cannot be parsed", async () => {
    write(".claude/settings.json", CLAUDE_HOOK);
    write("aih-org-policy.json", "{ not json");
    const c = await usageRecorderCheck(makeCtx());
    expect(c.verdict).toBe("fail");
    expect(c.detail).toContain("aih usage --apply");
  });

  it("skips (can't determine) when the recorder is present but git is unavailable", async () => {
    // Best-effort/fail-open: a git-absent environment can't confirm the recorder is
    // committed, so it must skip — never a hard fail and never a false pass.
    write(".claude/settings.json", CLAUDE_HOOK);
    write(".aih/usage-record.mjs", "// recorder\n");
    const c = await usageRecorderCheck(makeCtx(gitRunner({ gitAbsent: true })));
    expect(c.verdict).toBe("skip");
    expect(c.code).toBeUndefined();
  });
});

// The LEGACY hook command carried a literal `aih track`; the current writer emits an
// `execFileSync('aih',['track','--apply'])` one-shot. The probe recognizes both.
const METRICS_HOOK_TEXT =
  '{"version":"v1","hooks":[{"trigger":"Stop","action":{"command":"node -e \\"...aih track --apply...\\""}}]}';

describe("metricsToolCheck", () => {
  it("skips when there is no Kiro metrics-on-stop hook", async () => {
    const c = await metricsToolCheck(makeCtx());
    expect(c.verdict).toBe("skip");
    expect(c.code).toBeUndefined();
  });

  it("passes when the metrics hook exists and `aih` resolves on PATH", async () => {
    write(".kiro/hooks/aih-metrics-on-stop.json", METRICS_HOOK_TEXT);
    write(
      ".aih-config.json",
      JSON.stringify({
        schemaVersion: 1,
        contextDir: "ai-coding",
        targets: ["kiro"],
        kiroHookRuntime: "ide1-cli3",
      }),
    );
    const run = fakeRunner((argv) =>
      argv[0] === "which" && argv[1] === "aih" ? { code: 0, stdout: "/usr/bin/aih" } : undefined,
    );
    const ctx = makeCtx(run);
    const c = await metricsToolCheck(ctx);
    expect(c.verdict).toBe("pass");
  });

  it("advises (usage.metrics-tool-missing, skip) when `aih` is not on PATH", async () => {
    write(".kiro/hooks/aih-metrics-on-stop.json", METRICS_HOOK_TEXT);
    // `where aih` (Windows) returns non-zero when not found — the hook is fail-open, so
    // this must be an advisory skip, never a hard fail.
    const run = fakeRunner((argv) => (argv[0] === "where" ? { code: 1, stdout: "" } : undefined));
    const ctx = makeCtx(run, "windows");
    ctx.options.kiroHookRuntime = "ide1-cli3";
    const c = await metricsToolCheck(ctx);
    expect(c.verdict).toBe("skip");
    expect(c.code).toBe("usage.metrics-tool-missing");
  });

  it("does not report a standalone Kiro hook healthy when CLI 3 capability is unverified", async () => {
    write(".kiro/hooks/aih-metrics-on-stop.json", METRICS_HOOK_TEXT);
    const c = await metricsToolCheck(makeCtx());
    expect(c.verdict).toBe("skip");
    expect(c.code).toBe("usage.kiro-hook-runtime-unverified");
    expect(c.detail).toContain("CLI 2.x ignores");
  });

  it("recognizes the execFileSync one-shot hook bootstrap-ai actually writes", async () => {
    // 6.0.1 field report (New 2): doctor said "no Kiro metrics-on-stop hook to
    // verify" for the very hook `aih bootstrap-ai --kiro-hook-runtime ide1-cli3`
    // had just written — the probe matched only the legacy `aih track` text. The
    // fixture comes from the real writer so it can never drift from it again.
    const metrics = kiroHooks(scanRepo(root, { maxDepth: 2, contextDir: "ai-coding" })).find(
      (h) => h.path === ".kiro/hooks/aih-metrics-on-stop.json",
    );
    if (metrics === undefined) throw new Error("metrics hook missing from kiroHooks output");
    write(".kiro/hooks/aih-metrics-on-stop.json", JSON.stringify(metrics.hook, null, 2));
    write(
      ".aih-config.json",
      JSON.stringify({
        schemaVersion: 1,
        contextDir: "ai-coding",
        targets: ["kiro"],
        kiroHookRuntime: "ide1-cli3",
      }),
    );
    const run = fakeRunner((argv) =>
      argv[0] === "which" && argv[1] === "aih" ? { code: 0, stdout: "/usr/bin/aih" } : undefined,
    );
    const c = await metricsToolCheck(makeCtx(run));
    expect(c.verdict).toBe("pass");
  });
});
