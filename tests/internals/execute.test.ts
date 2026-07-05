import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AihError, DirtyWorktreeError, PathContainmentError } from "../../src/errors.js";
import { executePlan, summarizeResult, writeArtifact } from "../../src/internals/execute.js";
import {
  digest,
  doc,
  envBlock,
  exec,
  type PlanContext,
  plan,
  probe,
  probeMany,
  remove,
  structuredProbe,
  writeJson,
  writeText,
} from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { MAX_VERIFICATION_STRING_FIELD_LENGTH } from "../../src/verification/constants.js";
import {
  buildEvidenceGraph,
  mergeVerificationResults,
  type VerificationPipelineRun,
  type VerificationResult,
} from "../../src/verification/index.js";
import { isWellFormedUtf16 } from "../../src/verification/validation.js";

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

function treeSnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = rel.length === 0 ? entry.name : join(rel, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile()) {
        out.set(child.replace(/\\/g, "/"), readFileSync(join(root, child), "utf8"));
      }
    }
  };
  visit("");
  return out;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function structuredRun(results: VerificationResult[]): VerificationPipelineRun {
  return {
    results,
    summary: mergeVerificationResults(results),
    evidenceGraph: buildEvidenceGraph(results),
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

  it("seeded random write plans are idempotent on the second apply", async () => {
    for (const seed of [11, 23, 37, 51]) {
      const rand = seeded(seed);
      const actions = Array.from({ length: 8 }, (_, i) =>
        writeText(
          `plans/${Math.floor(rand() * 3)}/file-${i}.txt`,
          `seed=${seed};slot=${i};value=${Math.floor(rand() * 1000)}`,
          `seeded write ${i}`,
        ),
      );
      const p = plan(`seed-${seed}`, ...actions);
      await executePlan(p, ctx({ apply: true }));

      const before = treeSnapshot(dir);
      const second = await executePlan(p, ctx({ apply: true }));

      expect(second.writes.every((write) => write.effect === "unchanged")).toBe(true);
      expect(second.backups).toEqual([]);
      expect(treeSnapshot(dir)).toEqual(before);
    }
  });

  it("fault injection during a transaction restores every touched path byte-for-byte", async () => {
    writeFileSync(join(dir, "a.txt"), "original a\n");
    writeFileSync(join(dir, "b.txt"), "original b\n");
    const before = treeSnapshot(dir);

    await expect(
      executePlan(
        plan(
          "fault-injection",
          writeText("a.txt", "next a", "overwrite a"),
          writeText("b.txt", "next b", "overwrite b"),
          writeText("b.txt/nested.txt", "boom", "force ENOTDIR during commit"),
        ),
        ctx({ apply: true }),
      ),
    ).rejects.toThrow(/rolled back/);

    expect(treeSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "a.txt.aih.bak"))).toBe(false);
    expect(existsSync(join(dir, "b.txt.aih.bak"))).toBe(false);
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

  it("adapts structured probe runs into legacy verification report checks", async () => {
    const p = plan(
      "t",
      structuredProbe(
        "structured gate",
        () =>
          structuredRun([
            {
              passName: "policy.check",
              verdict: "warn",
              severity: "medium",
              confidence: "high",
              evidence: [],
              message: "org policy warning",
              category: "policy",
            },
          ]),
        { warnAs: "skip", passDetail: "all clear", includeMetadata: false },
      ),
    );

    expect(p.actions[0]?.kind).toBe("probe");
    expect((await executePlan(p, ctx({ verify: false }))).report).toBeUndefined();

    const result = await executePlan(p, ctx({ verify: true }));

    expect(result.report?.checks).toEqual([
      {
        name: "structured gate",
        verdict: "skip",
        detail: "policy.check: org policy warning",
      },
    ]);
    expect(result.report?.exitCode()).toBe(0);
  });

  it("returns a structured verification run for legacy probes without changing the legacy report", async () => {
    const p = plan(
      "t",
      probe("legacy gate", () => ({
        name: "legacy gate",
        verdict: "fail",
        detail: "legacy failure",
        code: "ready.blocked",
      })),
    );

    const result = await executePlan(p, ctx({ verify: true }));

    expect(result.report?.checks).toEqual([
      {
        name: "legacy gate",
        verdict: "fail",
        detail: "legacy failure",
        code: "ready.blocked",
      },
    ]);
    expect(result.report?.exitCode()).toBe(1);
    expect(result.verification?.summary.finalVerdict).toBe("fail");
    expect(result.verification?.results).toEqual([
      expect.objectContaining({
        passName: "legacy gate",
        verdict: "fail",
        severity: "high",
        confidence: "high",
        message: "legacy failure",
        category: "other",
      }),
    ]);
    expect(result.verification?.evidenceGraph.nodes).toEqual([
      expect.objectContaining({ kind: "finding", passName: "legacy gate", verdict: "fail" }),
    ]);
  });

  it("bounds malformed legacy probe text in the structured sidecar without changing the legacy report", async () => {
    const malformedName = `legacy ${String.fromCharCode(0xd800)} gate`;
    const longDetail = "x".repeat(MAX_VERIFICATION_STRING_FIELD_LENGTH + 20);
    const p = plan(
      "t",
      probe(malformedName, () => ({
        name: malformedName,
        verdict: "pass",
        detail: longDetail,
      })),
    );

    const result = await executePlan(p, ctx({ verify: true }));
    const entry = result.verification?.results[0];
    const message = entry?.message ?? "";

    expect(result.report?.checks).toEqual([
      {
        name: malformedName,
        verdict: "pass",
        detail: longDetail,
      },
    ]);
    expect(result.report?.exitCode()).toBe(0);
    expect(entry?.passName).toContain(String.fromCharCode(0xfffd));
    expect(isWellFormedUtf16(entry?.passName ?? "")).toBe(true);
    expect(message).toHaveLength(MAX_VERIFICATION_STRING_FIELD_LENGTH);
    expect(message.endsWith("[truncated]")).toBe(true);
    expect(result.verification?.evidenceGraph.nodes).toEqual([
      expect.objectContaining({ kind: "finding", passName: entry?.passName, verdict: "pass" }),
    ]);
  });

  it("preserves structured probe results in the executor verification run without double execution", async () => {
    let calls = 0;
    const p = plan(
      "t",
      structuredProbe(
        "structured gate",
        () => {
          calls += 1;
          return structuredRun([
            {
              passName: "structured.pass",
              verdict: "pass",
              severity: "info",
              confidence: "high",
              evidence: [],
              message: "ok",
              category: "policy",
            },
            {
              passName: "structured.fail",
              verdict: "fail",
              severity: "high",
              confidence: "high",
              evidence: [],
              message: "blocked",
              category: "policy",
            },
          ]);
        },
        { includeMetadata: false },
      ),
    );

    const result = await executePlan(p, ctx({ verify: true }));

    expect(calls).toBe(1);
    expect(result.report?.checks).toEqual([
      {
        name: "structured gate",
        verdict: "fail",
        detail: "structured.fail: blocked",
      },
    ]);
    expect(result.verification?.results.map((entry) => entry.passName)).toEqual([
      "structured.pass",
      "structured.fail",
    ]);
    expect(result.verification?.summary.finalVerdict).toBe("fail");
  });

  it("keeps generated structured sidecar pass names unique when legacy names already include suffixes", async () => {
    const p = plan(
      "t",
      probeMany("duplicate legacy gates", () => [
        { name: "dup", verdict: "pass" },
        { name: "dup", verdict: "pass" },
        { name: "dup#2", verdict: "pass" },
      ]),
    );

    const result = await executePlan(p, ctx({ verify: true }));
    const passNames = result.verification?.results.map((entry) => entry.passName) ?? [];

    expect(result.report?.checks.map((check) => check.name)).toEqual(["dup", "dup", "dup#2"]);
    expect(new Set(passNames).size).toBe(passNames.length);
    expect(result.verification?.evidenceGraph.nodes).toHaveLength(3);
  });

  it("does not cap the structured sidecar graph below legacy probeMany result count", async () => {
    const p = plan(
      "t",
      probeMany("many legacy gates", () =>
        Array.from({ length: 129 }, (_, index) => ({
          name: `legacy.${index}`,
          verdict: "pass",
        })),
      ),
    );

    const result = await executePlan(p, ctx({ verify: true }));

    expect(result.report?.checks).toHaveLength(129);
    expect(result.verification?.results).toHaveLength(129);
    expect(result.verification?.evidenceGraph.nodes).toHaveLength(129);
  });

  it("does not cap the structured sidecar graph below structured evidence count", async () => {
    const evidence = Array.from({ length: 1001 }, (_, index) => ({
      id: `evidence.${index}`,
      type: "log",
      source: `logs/${index}.txt`,
    }));
    const p = plan(
      "t",
      structuredProbe("many evidence gate", () => ({
        results: [
          {
            passName: "structured.many-evidence",
            verdict: "pass",
            severity: "info",
            confidence: "high",
            evidence,
            message: "ok",
            category: "other",
          },
        ],
        summary: {
          finalVerdict: "pass",
          trustScore: 100,
          aggregatedEvidence: evidence,
          failedPasses: [],
          warnings: [],
        },
        evidenceGraph: { nodes: [], edges: [] },
      })),
    );

    const result = await executePlan(p, ctx({ verify: true }));

    expect(result.report?.checks).toEqual([
      { name: "many evidence gate", verdict: "pass", detail: undefined },
    ]);
    expect(result.verification?.results[0]?.evidence).toHaveLength(1001);
    expect(result.verification?.evidenceGraph.edges).toHaveLength(1001);
  });

  it("redacts structured probe sidecar text before JSON serialization", async () => {
    const secret = "SECRET_TOKEN=supersecretvalue123";
    const p = plan(
      "t",
      structuredProbe("structured secret gate", () =>
        structuredRun([
          {
            passName: "structured.secret",
            verdict: "warn",
            severity: "medium",
            confidence: "high",
            evidence: [
              {
                id: `evidence-${secret}`,
                type: "log",
                source: `logs/${secret}.txt`,
                snippet: `raw ${secret}`,
              },
            ],
            message: `message ${secret}`,
            category: "security",
          },
        ]),
      ),
    );

    const result = await executePlan(p, ctx({ verify: true }));
    const payload = JSON.stringify(result.verification);

    expect(payload).not.toContain(secret);
    expect(result.verification?.results[0]?.message).toContain("[REDACTED]");
    expect(result.verification?.summary.aggregatedEvidence[0]?.snippet).toContain("[REDACTED]");
    expect(result.verification?.evidenceGraph.nodes).toContainEqual(
      expect.objectContaining({ kind: "source", source: "logs/[REDACTED]" }),
    );
  });

  it("drops unknown structured sidecar fields before JSON serialization", async () => {
    const secret = "SECRET_TOKEN=rawsidecarvalue123";
    const structuredWithExtra = {
      passName: "structured.extra",
      verdict: "warn",
      severity: "medium",
      confidence: "high",
      evidence: [],
      message: "known fields are clean",
      category: "security",
      rawLog: `raw ${secret}`,
    } as VerificationResult & { rawLog: string };
    const p = plan(
      "t",
      structuredProbe("structured extra gate", () => structuredRun([structuredWithExtra])),
    );

    const result = await executePlan(p, ctx({ verify: true }));
    const payload = JSON.stringify(result.verification);

    expect(payload).not.toContain("rawLog");
    expect(payload).not.toContain(secret);
    expect(result.verification?.results[0]).toEqual({
      passName: "structured.extra",
      verdict: "warn",
      severity: "medium",
      confidence: "high",
      evidence: [],
      message: "known fields are clean",
      category: "security",
    });
  });

  it("rejects malformed structured sidecar enum fields without echoing raw values", async () => {
    const secret = "SECRET_TOKEN=badverdictvalue123";
    const p = plan(
      "t",
      structuredProbe("structured malformed gate", () => ({
        results: [
          {
            passName: "structured.malformed",
            verdict: secret,
            severity: "medium",
            confidence: "high",
            evidence: [],
            message: "malformed enum",
            category: "security",
          } as unknown as VerificationResult,
        ],
        summary: {
          finalVerdict: "pass",
          trustScore: 100,
          aggregatedEvidence: [],
          failedPasses: [],
          warnings: [],
        },
        evidenceGraph: { nodes: [], edges: [] },
      })),
    );

    let error: unknown;
    try {
      await executePlan(p, ctx({ verify: true }));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AihError);
    expect((error as AihError).message).toBe(
      "structured verification result at index 0 has invalid verdict",
    );
    expect((error as AihError).code).toBe("AIH_CONFIG");
    expect((error as AihError).message).not.toContain(secret);
  });

  it("truncates structured sidecar text without splitting surrogate pairs", async () => {
    const splitBoundaryDetail = `${"x".repeat(MAX_VERIFICATION_STRING_FIELD_LENGTH - 16)}😀${"y".repeat(20)}`;
    const p = plan(
      "t",
      structuredProbe("emoji detail", () => ({
        results: [
          {
            passName: "structured.emoji",
            verdict: "pass",
            severity: "info",
            confidence: "high",
            evidence: [],
            message: splitBoundaryDetail,
            category: "other",
          },
        ],
        summary: {
          finalVerdict: "pass",
          trustScore: 100,
          aggregatedEvidence: [],
          failedPasses: [],
          warnings: [],
        },
        evidenceGraph: { nodes: [], edges: [] },
      })),
    );

    const result = await executePlan(p, ctx({ verify: true }));
    const message = result.verification?.results[0]?.message ?? "";

    expect(message).toHaveLength(MAX_VERIFICATION_STRING_FIELD_LENGTH);
    expect(isWellFormedUtf16(message)).toBe(true);
    expect(message.endsWith("[truncated]")).toBe(true);
  });

  it("suffixes long duplicate sidecar pass names without splitting surrogate pairs", async () => {
    const boundaryName = `${"x".repeat(MAX_VERIFICATION_STRING_FIELD_LENGTH - 3)}😀y`;
    const p = plan(
      "t",
      probeMany("duplicate long gates", () => [
        { name: boundaryName, verdict: "pass" },
        { name: boundaryName, verdict: "pass" },
      ]),
    );

    const result = await executePlan(p, ctx({ verify: true }));
    const passNames = result.verification?.results.map((entry) => entry.passName) ?? [];

    expect(passNames).toHaveLength(2);
    expect(new Set(passNames).size).toBe(2);
    expect(
      passNames.every((passName) => passName.length <= MAX_VERIFICATION_STRING_FIELD_LENGTH),
    ).toBe(true);
    expect(passNames.every(isWellFormedUtf16)).toBe(true);
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

  it("emits a configured exec failure check and blocks follow-on probes", async () => {
    const run = fakeRunner(() => ({ code: 1, stderr: "network down" }));
    const p = plan(
      "t",
      exec("fetch", ["node", "fetch.mjs"], {
        failureCheck: {
          name: "trust.fetch-blocked",
          verdict: "fail",
          code: "trust.fetch-blocked",
          detail: "network down",
        },
        blockProbesOnFailure: true,
      }),
      probe("should not run", () => {
        throw new Error("probe should have been blocked");
      }),
    );

    const result = await executePlan(p, ctx({ apply: true, verify: true, run }));

    expect(result.report?.checks).toEqual([
      expect.objectContaining({ verdict: "fail", code: "trust.fetch-blocked" }),
    ]);
  });
});

describe("executePlan — exec apply-time content pins (expect)", () => {
  const pinOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

  it("refuses (AIH_TRUST) and never runs the command when the pinned file changed after planning", async () => {
    const target = join(dir, "SHA256SUMS");
    writeFileSync(target, "graded content\n");
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return { code: 0 };
    });
    const p = plan(
      "t",
      exec("sign the sums", ["cosign", "sign-blob", target], {
        expect: { path: target, sha256: pinOf("graded content\n") },
      }),
    );
    writeFileSync(target, "swapped after the plan\n"); // the TOCTOU write
    const err = await executePlan(p, ctx({ apply: true, run })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AihError);
    expect((err as AihError).code).toBe("AIH_TRUST");
    expect((err as AihError).message).toContain("changed after the plan was computed");
    expect((err as AihError).message).toContain("re-run the command");
    expect(calls).toEqual([]); // the command never ran
  });

  it("runs the pinned exec normally when the file still hashes to the pin", async () => {
    const target = join(dir, "SHA256SUMS");
    writeFileSync(target, "graded content\n");
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return { code: 0 };
    });
    const res = await executePlan(
      plan(
        "t",
        exec("sign the sums", ["cosign", "sign-blob", target], {
          expect: { path: target, sha256: pinOf("graded content\n") },
        }),
      ),
      ctx({ apply: true, run }),
    );
    expect(res.execs[0]).toMatchObject({ ran: true, code: 0, ok: true });
    expect(calls).toEqual([["cosign", "sign-blob", target]]);
  });

  it("a pinned file that is missing at apply time refuses as 'missing' without running", async () => {
    const target = join(dir, "SHA256SUMS");
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return { code: 0 };
    });
    const err = await executePlan(
      plan(
        "t",
        exec("sign the sums", ["cosign", "sign-blob", target], {
          expect: { path: target, sha256: pinOf("never written\n") },
        }),
      ),
      ctx({ apply: true, run }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AihError);
    expect((err as AihError).code).toBe("AIH_TRUST");
    expect((err as AihError).message).toContain("found missing");
    expect(calls).toEqual([]);
  });

  it("dry-run never evaluates the pin — a stale pin only bites under --apply", async () => {
    const target = join(dir, "SHA256SUMS");
    writeFileSync(target, "current content\n");
    const res = await executePlan(
      plan(
        "t",
        exec("sign the sums", ["cosign", "sign-blob", target], {
          expect: { path: target, sha256: pinOf("some other content\n") },
        }),
      ),
      ctx({ apply: false }),
    );
    expect(res.execs[0]?.ran).toBe(false);
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

  it("does not claim 'Applied' when an --apply run commits no writes or execs", async () => {
    // A digest-only plan under --apply mutates nothing — the header must say so
    // rather than falsely reporting "Applied" (the prune preview slice relies on this).
    const res = await executePlan(plan("prune", digest("d", "body")), ctx({ apply: true }));
    const summary = summarizeResult(res);
    expect(res.applied).toBe(true);
    expect(summary).not.toContain("Applied prune");
    expect(summary).toContain("prune: nothing to apply");
  });

  it("still reports 'Applied' when an --apply run actually writes a file", async () => {
    const res = await executePlan(
      plan("scaffold", writeText("out.txt", "hi", "a file")),
      ctx({ apply: true }),
    );
    expect(summarizeResult(res)).toContain("Applied scaffold");
  });
});

describe("executePlan — remove actions", () => {
  const put = (rel: string, body = "x"): string => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    return abs;
  };

  it("dry-run records the removal effect + destination but touches nothing", async () => {
    const abs = put("ai-coding/adapters/codex.md");
    const res = await executePlan(
      plan("prune", remove("ai-coding/adapters/codex.md", "stale adapter")),
      ctx({ apply: false }),
    );
    expect(existsSync(abs)).toBe(true); // untouched
    expect(res.removed).toEqual([
      {
        path: "ai-coding/adapters/codex.md",
        describe: "stale adapter",
        effect: "remove",
        to: ".aih/legacy/ai-coding/adapters/codex.md",
      },
    ]);
  });

  it("--apply MOVES the file to .aih/legacy/ (reversible), leaving nothing at the source", async () => {
    const abs = put("ai-coding/adapters/codex.md", "# codex\n");
    const res = await executePlan(
      plan("prune", remove("ai-coding/adapters/codex.md", "stale adapter")),
      ctx({ apply: true }),
    );
    expect(existsSync(abs)).toBe(false);
    const legacy = join(dir, ".aih", "legacy", "ai-coding", "adapters", "codex.md");
    expect(existsSync(legacy)).toBe(true);
    expect(readFileSync(legacy, "utf8")).toBe("# codex\n"); // content preserved = the backup
    expect(res.removed[0]?.effect).toBe("remove");
  });

  it("records `absent` (no move) when the target does not exist", async () => {
    const res = await executePlan(
      plan("prune", remove("ai-coding/adapters/gone.md", "stale")),
      ctx({ apply: true }),
    );
    expect(res.removed).toEqual([
      { path: "ai-coding/adapters/gone.md", describe: "stale", effect: "absent" },
    ]);
  });

  it("refuses to remove a path that escapes the root (containment)", async () => {
    await expect(
      executePlan(plan("prune", remove("../outside.md", "escape")), ctx({ apply: true })),
    ).rejects.toBeInstanceOf(PathContainmentError);
  });

  it("refuses the move when `.aih` is a symlink escaping the repo (destination containment)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "aih-legacy-escape-"));
    try {
      symlinkSync(outside, join(dir, ".aih"), "dir"); // .aih → outside dir
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return; // symlink creation not permitted (e.g. Windows) — skip
    }
    try {
      put("ai-coding/adapters/codex.md", "# codex\n");
      await expect(
        executePlan(
          plan("prune", remove("ai-coding/adapters/codex.md", "stale")),
          ctx({ apply: true }),
        ),
      ).rejects.toBeInstanceOf(PathContainmentError);
      // The escaping symlink target received nothing.
      expect(existsSync(join(outside, "legacy", "ai-coding", "adapters", "codex.md"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to remove through a symlinked parent even when it resolves inside the repo", async () => {
    const real = put("real-adapters/codex.md", "# codex\n");
    mkdirSync(join(dir, "ai-coding"), { recursive: true });
    try {
      symlinkSync(join(dir, "real-adapters"), join(dir, "ai-coding", "adapters"), "dir");
    } catch {
      return; // symlink creation not permitted (e.g. Windows) — skip
    }

    await expect(
      executePlan(
        plan("prune", remove("ai-coding/adapters/codex.md", "stale")),
        ctx({ apply: true }),
      ),
    ).rejects.toBeInstanceOf(PathContainmentError);
    expect(readFileSync(real, "utf8")).toBe("# codex\n");
  });

  it("aborts before removing any file when a write in the same plan fails (atomicity)", async () => {
    const abs = put("ai-coding/adapters/codex.md", "# codex\n");
    // Writes commit before removals, so a failing write (here: writing THROUGH an
    // existing file as if it were a directory) aborts the whole plan — the removal
    // never runs and the file is left exactly as it was.
    await expect(
      executePlan(
        plan(
          "prune",
          remove("ai-coding/adapters/codex.md", "stale"),
          writeText("ai-coding/adapters/codex.md/nested.txt", "boom", "invalid nested write"),
        ),
        ctx({ apply: true }),
      ),
    ).rejects.toBeTruthy();
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf8")).toBe("# codex\n");
    // Nothing leaked into the legacy dir either.
    expect(existsSync(join(dir, ".aih", "legacy", "ai-coding", "adapters", "codex.md"))).toBe(
      false,
    );
  });
});

describe("executePlan — archiveRoot removals (the quarantine root)", () => {
  const put = (rel: string, body = "x"): string => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    return abs;
  };

  it("archiveRoot .aih/quarantine moves the file under the quarantine root, not legacy", async () => {
    const abs = put("ai-coding/skills/owner/foo/SKILL.md", "# foo\n");
    const res = await executePlan(
      plan(
        "skill quarantine",
        remove("ai-coding/skills/owner/foo/SKILL.md", "quarantine foo", {
          archiveRoot: ".aih/quarantine",
        }),
      ),
      ctx({ apply: true }),
    );
    expect(existsSync(abs)).toBe(false);
    const parked = join(dir, ".aih", "quarantine", "ai-coding", "skills", "owner", "foo");
    expect(readFileSync(join(parked, "SKILL.md"), "utf8")).toBe("# foo\n");
    expect(res.removed).toEqual([
      {
        path: "ai-coding/skills/owner/foo/SKILL.md",
        describe: "quarantine foo",
        effect: "remove",
        to: ".aih/quarantine/ai-coding/skills/owner/foo/SKILL.md",
      },
    ]);
    // Nothing leaked into the default legacy archive.
    expect(existsSync(join(dir, ".aih", "legacy"))).toBe(false);
  });

  it("never overwrites an occupied quarantine slot — the second rescue lands at a .1 sibling", async () => {
    const p = plan(
      "skill quarantine",
      remove("notes.md", "quarantine notes", { archiveRoot: ".aih/quarantine" }),
    );
    put("notes.md", "first\n");
    await executePlan(p, ctx({ apply: true }));
    put("notes.md", "second\n"); // the path was re-populated by hand
    const res = await executePlan(p, ctx({ apply: true }));
    // Both copies survive: the first at the base slot, the second at the .1 sibling —
    // and the reported `to` reflects the ACTUAL fallback destination.
    expect(readFileSync(join(dir, ".aih", "quarantine", "notes.md"), "utf8")).toBe("first\n");
    expect(readFileSync(join(dir, ".aih", "quarantine", "notes.md.1"), "utf8")).toBe("second\n");
    expect(res.removed[0]?.to).toBe(".aih/quarantine/notes.md.1");
  });

  it("containment still fires for an escaping path with archiveRoot set", async () => {
    await expect(
      executePlan(
        plan(
          "skill quarantine",
          remove("../outside.md", "escape", { archiveRoot: ".aih/quarantine" }),
        ),
        ctx({ apply: true }),
      ),
    ).rejects.toBeInstanceOf(PathContainmentError);
    expect(existsSync(join(dirname(dir), "outside.md"))).toBe(false);
  });
});

describe("executePlan — hard-delete removals", () => {
  const put = (rel: string, body = "x"): string => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    return abs;
  };

  it("--apply hard-delete renames to the sibling .aih.bak and reports effect delete", async () => {
    const abs = put("ai-coding/adapters/codex.md", "# codex\n");
    const res = await executePlan(
      plan("prune", remove("ai-coding/adapters/codex.md", "stale adapter", { hardDelete: true })),
      ctx({ apply: true }),
    );
    expect(existsSync(abs)).toBe(false);
    expect(readFileSync(`${abs}.aih.bak`, "utf8")).toBe("# codex\n");
    expect(res.removed).toEqual([
      {
        path: "ai-coding/adapters/codex.md",
        describe: "stale adapter",
        effect: "delete",
        to: "ai-coding/adapters/codex.md.aih.bak",
      },
    ]);
    // Nothing leaked into the legacy archive on the hard-delete path.
    expect(existsSync(join(dir, ".aih", "legacy"))).toBe(false);
    // A hard-delete counts as a mutation ("Applied", never "nothing to apply").
    expect(summarizeResult(res)).toContain("Applied prune");
    expect(summarizeResult(res)).toContain("[delete] ai-coding/adapters/codex.md");
  });

  it("reports the ACTUAL fallback destination when .aih.bak is already occupied", async () => {
    // An existing `.aih.bak` is never overwritten — the hard-delete lands at
    // `.1.aih.bak`. The summary must point the user's restore at the real slot,
    // not the planned `.aih.bak` (the finding-2 reporting fix).
    const abs = put("ai-coding/adapters/codex.md", "# codex v2\n");
    writeFileSync(`${abs}.aih.bak`, "# codex v1 (never-committed backup)\n");
    const res = await executePlan(
      plan("prune", remove("ai-coding/adapters/codex.md", "stale adapter", { hardDelete: true })),
      ctx({ apply: true }),
    );
    // The prior backup survives untouched; the new content lands at the .1 slot.
    expect(readFileSync(`${abs}.aih.bak`, "utf8")).toBe("# codex v1 (never-committed backup)\n");
    expect(readFileSync(`${abs}.1.aih.bak`, "utf8")).toBe("# codex v2\n");
    // And the reported `to` reflects that actual destination, not the planned one.
    expect(res.removed[0]?.to).toBe("ai-coding/adapters/codex.md.1.aih.bak");
    expect(summarizeResult(res)).toContain("ai-coding/adapters/codex.md.1.aih.bak");
  });

  it("dry-run hard-delete touches nothing but reports the plan", async () => {
    const abs = put("ai-coding/adapters/codex.md");
    const res = await executePlan(
      plan("prune", remove("ai-coding/adapters/codex.md", "stale", { hardDelete: true })),
      ctx({ apply: false }),
    );
    expect(existsSync(abs)).toBe(true);
    expect(existsSync(`${abs}.aih.bak`)).toBe(false);
    expect(res.removed[0]?.effect).toBe("delete");
  });

  it("hard-delete destination is still contained (a `..` path is refused)", async () => {
    await expect(
      executePlan(
        plan("prune", remove("../outside.md", "escape", { hardDelete: true })),
        ctx({ apply: true }),
      ),
    ).rejects.toBeInstanceOf(PathContainmentError);
  });
});
