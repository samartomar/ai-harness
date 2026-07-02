import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
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

/** `git check-ignore -q <path>` exits 0 iff the path IS ignored, 1 if tracked/unignored. */
function gitIgnoreRunner(ignored: boolean): Runner {
  return fakeRunner((argv) =>
    argv[0] === "git" && argv[1] === "check-ignore"
      ? { code: ignored ? 0 : 1, stdout: "" }
      : undefined,
  );
}

const CLAUDE_HOOK = JSON.stringify({
  hooks: {
    PostToolUse: [{ hooks: [{ command: "node .aih/usage-record.mjs --from claude; exit 0" }] }],
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

  it("passes once the recorder is present AND tracked (not git-ignored)", async () => {
    write(
      ".kiro/hooks/aih-usage-metering.kiro.hook",
      '{"when":{"type":"agentStop"},"command":"node .aih/usage-record.mjs --from kiro"}',
    );
    write(".aih/usage-record.mjs", "// recorder\n");
    const c = await usageRecorderCheck(makeCtx(gitIgnoreRunner(false)));
    expect(c.verdict).toBe("pass");
    expect(c.detail).toContain("tracked");
  });

  it("fails when the recorder exists locally but is still git-ignored", async () => {
    // The false-pass trap: file on disk, but a stale `.aih/` exclude keeps it out of
    // the commit, so a fresh clone re-hits the missing-recorder failure.
    write(".claude/settings.json", CLAUDE_HOOK);
    write(".aih/usage-record.mjs", "// recorder\n");
    const c = await usageRecorderCheck(makeCtx(gitIgnoreRunner(true)));
    expect(c.verdict).toBe("fail");
    expect(c.code).toBe("usage.recorder-missing");
    expect(c.detail).toContain("git-ignored");
  });
});

// The metrics hook's file text always carries `aih track`; the probe keys off that.
const METRICS_HOOK_TEXT =
  '{"when":{"type":"agentStop"},"command":"node -e \\"...aih track --apply...\\""}';

describe("metricsToolCheck", () => {
  it("skips when there is no Kiro metrics-on-stop hook", async () => {
    const c = await metricsToolCheck(makeCtx());
    expect(c.verdict).toBe("skip");
    expect(c.code).toBeUndefined();
  });

  it("passes when the metrics hook exists and `aih` resolves on PATH", async () => {
    write(".kiro/hooks/aih-metrics-on-stop.kiro.hook", METRICS_HOOK_TEXT);
    const run = fakeRunner((argv) =>
      argv[0] === "which" && argv[1] === "aih" ? { code: 0, stdout: "/usr/bin/aih" } : undefined,
    );
    const c = await metricsToolCheck(makeCtx(run));
    expect(c.verdict).toBe("pass");
  });

  it("advises (usage.metrics-tool-missing, skip) when `aih` is not on PATH", async () => {
    write(".kiro/hooks/aih-metrics-on-stop.kiro.hook", METRICS_HOOK_TEXT);
    // `where aih` (Windows) returns non-zero when not found — the hook is fail-open, so
    // this must be an advisory skip, never a hard fail.
    const run = fakeRunner((argv) => (argv[0] === "where" ? { code: 1, stdout: "" } : undefined));
    const c = await metricsToolCheck(makeCtx(run, "windows"));
    expect(c.verdict).toBe("skip");
    expect(c.code).toBe("usage.metrics-tool-missing");
  });
});
