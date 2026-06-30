import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirtyWorktreeError, PathContainmentError } from "../../src/errors.js";
import { executePlan, summarizeResult, writeArtifact } from "../../src/internals/execute.js";
import {
  digest,
  doc,
  envBlock,
  exec,
  type PlanContext,
  plan,
  probe,
  writeJson,
  writeText,
} from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-exec-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

describe("executePlan", () => {
  it("dry-run reports planned writes but writes nothing", async () => {
    const res = await executePlan(
      plan("t", writeText("a.txt", "hi", "write a")),
      ctx({ apply: false }),
    );
    expect(res.applied).toBe(false);
    expect(res.writes[0]?.effect).toBe("create");
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
  });

  it("apply writes files with a trailing newline", async () => {
    await executePlan(plan("t", writeText("a.txt", "hi", "write a")), ctx({ apply: true }));
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hi\n");
  });

  it("re-applying identical content is a no-op: unchanged effect, no backup", async () => {
    const p = plan("t", writeText("a.txt", "hi", "write a"));
    await executePlan(p, ctx({ apply: true }));
    const second = await executePlan(p, ctx({ apply: true }));
    expect(second.writes[0]?.effect).toBe("unchanged");
    expect(second.backups).toHaveLength(0);
    expect(existsSync(join(dir, "a.txt.aih.bak"))).toBe(false);
  });

  it("a real content change still overwrites and backs up", async () => {
    await executePlan(plan("t", writeText("a.txt", "one", "v1")), ctx({ apply: true }));
    const second = await executePlan(
      plan("t", writeText("a.txt", "two", "v2")),
      ctx({ apply: true }),
    );
    expect(second.writes[0]?.effect).toBe("overwrite");
    expect(second.backups).toHaveLength(1);
  });

  it("path containment: a repo-scoped write escaping the root fails closed", async () => {
    const outside = join(dirname(dir), "aih-escape-test.txt"); // sibling of the temp root
    await expect(
      executePlan(plan("t", writeText(outside, "x", "escape")), ctx({ apply: true })),
    ).rejects.toThrow(/outside the target root/);
    expect(existsSync(outside)).toBe(false);
  });

  it("path containment also covers doc-with-path writes (no out-of-repo read/write)", async () => {
    const outside = join(dirname(dir), "aih-doc-escape.md");
    await expect(
      executePlan(plan("t", doc("guidance", "x", outside)), ctx({ apply: true })),
    ).rejects.toThrow(/outside the target root/);
    expect(existsSync(outside)).toBe(false);
  });

  it("path containment: an external write is allowed outside the root (host files)", async () => {
    const ext = mkdtempSync(join(tmpdir(), "aih-ext-"));
    try {
      const target = join(ext, "host.txt");
      await executePlan(
        plan("t", writeText(target, "ok", "host file", { external: true })),
        ctx({ apply: true }),
      );
      expect(readFileSync(target, "utf8")).toBe("ok\n");
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });

  it("merge writes preserve existing user JSON keys", async () => {
    writeFileSync(join(dir, "c.json"), JSON.stringify({ user: 1 }));
    const res = await executePlan(
      plan("t", writeJson("c.json", { aih: 2 }, "merge", { merge: true })),
      ctx({ apply: true }),
    );
    expect(res.writes[0]?.effect).toBe("merge");
    expect(JSON.parse(readFileSync(join(dir, "c.json"), "utf8"))).toEqual({ user: 1, aih: 2 });
  });

  it("runs probe actions only under verify", async () => {
    const p = plan(
      "t",
      probe("check", () => ({ name: "x", verdict: "pass" })),
    );
    expect((await executePlan(p, ctx({ verify: false }))).report).toBeUndefined();
    expect((await executePlan(p, ctx({ verify: true }))).report?.ok).toBe(true);
  });

  it("writes doc actions that carry a path", async () => {
    await executePlan(plan("t", doc("guidance", "do X", "docs/guide.md")), ctx({ apply: true }));
    expect(readFileSync(join(dir, "docs/guide.md"), "utf8")).toBe("do X\n");
  });

  it("re-applying an identical doc-with-path is a no-op: no rewrite, no backup", async () => {
    const p = plan("t", doc("guidance", "do X", "docs/guide.md"));
    await executePlan(p, ctx({ apply: true }));
    const second = await executePlan(p, ctx({ apply: true }));
    // Doc-file writes now honor the same idempotency contract as write actions.
    expect(second.backups).toHaveLength(0);
    expect(existsSync(join(dir, "docs/guide.md.aih.bak"))).toBe(false);
  });

  it("runs exec actions only on apply and records the exit code", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return { code: 0 };
    });
    const p = plan("t", exec("noop", ["echo", "hi"]));

    const dry = await executePlan(p, ctx({ apply: false, run }));
    expect(dry.execs[0]?.ran).toBe(false);
    expect(calls).toHaveLength(0);

    const applied = await executePlan(p, ctx({ apply: true, run }));
    expect(applied.execs[0]).toMatchObject({ ran: true, code: 0, ok: true });
    expect(calls).toEqual([["echo", "hi"]]);
  });

  it("passes exec cwd, environment, and timeout through the runner seam", async () => {
    const calls: Array<{
      argv: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
    }> = [];
    const run = fakeRunner((argv, opts) => {
      calls.push({ argv, cwd: opts?.cwd, env: opts?.env, timeoutMs: opts?.timeoutMs });
      return { code: 0 };
    });

    await executePlan(
      plan(
        "t",
        exec("fetch", ["node", "fetch.mjs"], {
          cwd: dir,
          env: { PATH: "safe-bin" },
          timeoutMs: 1234,
        }),
      ),
      ctx({ apply: true, run }),
    );

    expect(calls).toEqual([
      { argv: ["node", "fetch.mjs"], cwd: dir, env: { PATH: "safe-bin" }, timeoutMs: 1234 },
    ]);
  });
});

describe("executePlan — envblock folding", () => {
  const profile = "profile.ps1";

  it("renders a single managed block with markers (dry-run writes nothing)", async () => {
    const p = plan(
      "t",
      envBlock(profile, "certs", "posix", [{ key: "A", value: "1" }], "certs env"),
    );
    const dry = await executePlan(p, ctx({ apply: false }));
    expect(dry.writes[0]).toMatchObject({ path: profile, effect: "create", merged: true });
    expect(existsSync(join(dir, profile))).toBe(false);

    await executePlan(p, ctx({ apply: true }));
    const out = readFileSync(join(dir, profile), "utf8");
    expect(out).toContain("# >>> aih managed (certs) >>>");
    expect(out).toContain("export A=1");
    expect(out).toContain("# <<< aih managed (certs) <<<");
  });

  it("COMPOSES multiple scopes into one file instead of clobbering (the bootstrap bug)", async () => {
    const p = plan(
      "t",
      envBlock(profile, "hardware", "posix", [{ key: "OLLAMA_NUM_PARALLEL", value: "8" }], "hw"),
      envBlock(
        profile,
        "telemetry",
        "posix",
        [{ key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "x" }],
        "otel",
      ),
    );
    await executePlan(p, ctx({ apply: true }));
    const out = readFileSync(join(dir, profile), "utf8");
    // Both blocks survive — the second no longer overwrites the first.
    expect(out).toContain("aih managed (hardware)");
    expect(out).toContain("OLLAMA_NUM_PARALLEL=8");
    expect(out).toContain("aih managed (telemetry)");
    expect(out).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=x");
  });

  it("is idempotent and preserves user lines outside the managed block", async () => {
    writeFileSync(join(dir, profile), "export USER_VAR=keep\n");
    const p = plan(
      "t",
      envBlock(profile, "vdi", "posix", [{ key: "PIP_CACHE_DIR", value: "/s" }], "vdi"),
    );
    await executePlan(p, ctx({ apply: true }));
    const first = readFileSync(join(dir, profile), "utf8");
    await executePlan(p, ctx({ apply: true }));
    const second = readFileSync(join(dir, profile), "utf8");
    expect(second).toBe(first); // byte-identical re-apply
    expect(second).toContain("export USER_VAR=keep");
  });
});

describe("writeArtifact", () => {
  it("writes the artifact even in dry-run (apply: false) — it is an output, not a managed mutation", () => {
    // The CI drift gate runs `--verify` WITHOUT `--apply`, yet must still emit SARIF.
    const backups = writeArtifact(ctx({ apply: false }), "out.sarif", "{}");
    expect(backups).toEqual([]);
    expect(readFileSync(join(dir, "out.sarif"), "utf8")).toBe("{}\n");
  });

  it("contains the path: an escape attempt fails closed with PathContainmentError", () => {
    expect(() => writeArtifact(ctx(), "../escape.sarif", "{}")).toThrow(PathContainmentError);
    expect(existsSync(join(dirname(dir), "escape.sarif"))).toBe(false);
  });

  it("is idempotent: re-writing identical bytes makes no backup", () => {
    writeArtifact(ctx(), "out.sarif", "{}");
    const backups = writeArtifact(ctx(), "out.sarif", "{}");
    expect(backups).toEqual([]);
    expect(existsSync(join(dir, "out.sarif.aih.bak"))).toBe(false);
  });

  it("backs up a prior artifact to *.aih.bak when the content changes", () => {
    writeArtifact(ctx(), "out.sarif", '{"v":1}');
    const backups = writeArtifact(ctx(), "out.sarif", '{"v":2}');
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, "out.sarif.aih.bak"), "utf8")).toBe('{"v":1}\n');
    expect(readFileSync(join(dir, "out.sarif"), "utf8")).toBe('{"v":2}\n');
  });
});

describe("executePlan — dirty-worktree --apply preflight", () => {
  // `a.txt` (the file the writes below target) has uncommitted changes.
  const dirtyRun = fakeRunner((argv) =>
    argv.includes("status") ? { stdout: " M a.txt\n" } : undefined,
  );

  it("refuses to overwrite a dirty file the write would CHANGE (nothing written, no backup)", async () => {
    writeFileSync(join(dir, "a.txt"), "uncommitted edits\n"); // exists, dirty, and would change
    await expect(
      executePlan(
        plan("t", writeText("a.txt", "hi", "write a")),
        ctx({ apply: true, run: dirtyRun }),
      ),
    ).rejects.toThrow(DirtyWorktreeError);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("uncommitted edits\n"); // untouched
    expect(existsSync(join(dir, "a.txt.aih.bak"))).toBe(false);
  });

  it("does NOT gate an idempotent re-apply over a dirty file (rendered bytes match disk)", async () => {
    // Re-running `aih mcp --apply` over a just-generated, still-uncommitted config that
    // hasn't changed is a no-op — the dirty file is identical to what aih would write,
    // so there's nothing to clobber and it must be allowed.
    writeFileSync(join(dir, "a.txt"), "hi\n"); // dirty, but the write renders the same bytes
    await executePlan(
      plan("t", writeText("a.txt", "hi", "write a")),
      ctx({ apply: true, run: dirtyRun }),
    );
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hi\n");
  });

  it("ALLOWS the write when only an UNRELATED file is dirty (the new-file-on-dirty-repo fix)", async () => {
    // `aih mcp --apply --cli opencode` creates opencode.json on a repo whose only dirty
    // file is an untracked `codex/` dir — nothing aih writes is dirty, so it's allowed.
    const unrelatedDirty = fakeRunner((argv) =>
      argv.includes("status") ? { stdout: "?? codex/\n M other.ts\n" } : undefined,
    );
    await executePlan(
      plan("t", writeText("a.txt", "hi", "write a")),
      ctx({ apply: true, run: unrelatedDirty }),
    );
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hi\n");
  });

  it("--force overrides the gate and applies the write", async () => {
    writeFileSync(join(dir, "a.txt"), "uncommitted\n"); // dirty + would change → gates without --force
    await executePlan(
      plan("t", writeText("a.txt", "hi", "write a")),
      ctx({ apply: true, run: dirtyRun, options: { force: true } }),
    );
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hi\n");
  });

  it("a clean worktree applies normally (git status → empty)", async () => {
    // The default fakeRunner returns empty stdout for git status → clean worktree.
    await executePlan(plan("t", writeText("a.txt", "hi", "write a")), ctx({ apply: true }));
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hi\n");
  });

  it("dry-run (apply:false) is never gated, even on a dirty worktree", async () => {
    const res = await executePlan(
      plan("t", writeText("a.txt", "hi", "write a")),
      ctx({ apply: false, run: dirtyRun }),
    );
    expect(res.applied).toBe(false);
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
  });

  it("a write-free plan (digest only) is not gated under --apply on a dirty worktree", async () => {
    // Mirrors a bare `aih report`: nothing to clobber, so the gate stays out of the way.
    const res = await executePlan(
      plan("t", digest("d", "body")),
      ctx({ apply: true, run: dirtyRun }),
    );
    expect(res.digests).toHaveLength(1);
  });

  it("skipWorktreeGate exempts a write plan from the gate (the `aih report` artifact)", async () => {
    // `aih report --open` writes a gitignored OUTPUT artifact (the .aih/ report) under
    // --apply. Its writes never clobber the user's uncommitted work, so the report must
    // not be blocked on a dirty tree — skipWorktreeGate lets the write through.
    writeFileSync(join(dir, "a.txt"), "uncommitted\n"); // dirty + would change → gates without skip
    await executePlan(
      plan("t", writeText("a.txt", "hi", "write a")),
      ctx({ apply: true, run: dirtyRun }),
      { skipWorktreeGate: true },
    );
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hi\n");
  });

  it("an external write (a ~/home/system file) is NOT gated on a dirty worktree", async () => {
    // `aih mcp --apply --cli codex` writes only the global ~/.codex/config.toml — an
    // external file outside the repo worktree, so it can't clobber uncommitted repo
    // work and a dirty repo must not block it. A repo-local write still gates (above).
    const extDir = mkdtempSync(join(tmpdir(), "aih-ext-"));
    const ext = join(extDir, "config.toml");
    try {
      await executePlan(
        plan("t", writeText(ext, "hi", "external write", { external: true })),
        ctx({ apply: true, run: dirtyRun }),
      );
      expect(readFileSync(ext, "utf8")).toBe("hi\n");
    } finally {
      rmSync(extDir, { recursive: true, force: true });
    }
  });
});

describe("executePlan — digest actions", () => {
  it("collects digest text + data and prints the body verbatim in the summary", async () => {
    const res = await executePlan(
      plan("t", digest("headline N", "  line one\n  line two", { totalTokens: 42 })),
      ctx({ apply: false }),
    );
    expect(res.digests).toHaveLength(1);
    expect(res.digests[0]?.describe).toBe("headline N");
    expect(res.digests[0]?.data).toEqual({ totalTokens: 42 });
    expect(res.digests[0]?.text).toContain("line one");

    const summary = summarizeResult(res);
    expect(summary).toContain("[digest] — headline N");
    expect(summary).toContain("line one");
    expect(summary).toContain("line two");
  });

  it("routes a digest to digests, never to probes (no run, no verification)", async () => {
    const res = await executePlan(plan("t", digest("d", "body")), ctx({ verify: true }));
    expect(res.digests).toHaveLength(1);
    expect(res.probes).toHaveLength(0);
  });
});
