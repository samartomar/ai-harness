import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex, verifyBundleChecksums } from "../../src/bundle/index.js";
import {
  evidenceBuildCommand,
  isSafeStrixSecurityEvidenceFilename,
  MAX_STRIX_SECURITY_EVIDENCE_BYTES,
} from "../../src/evidence/build.js";
import {
  EvidenceBundleSchema,
  EvidenceKindSchema,
  STRIX_SECURITY_EVIDENCE_DIR,
} from "../../src/evidence/manifest.js";
import { executePlan } from "../../src/internals/execute.js";
import type {
  DigestAction,
  ExecAction,
  PlanContext,
  WriteAction,
} from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { jsonFile } from "../../src/internals/render.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { PACKAGE_NAME, releaseTag, VERSION } from "../../src/version.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-evidence-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
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

function write(rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function strixEvidence(): Record<string, unknown> {
  return {
    format: "aih-strix-detector-evidence",
    schemaVersion: 1,
    detector: {
      name: "strix",
      repository: "usestrix/strix",
      version: "1.5.2",
      sourceRevision: "597aae67159636ee794a02a3cc1694138d619c44",
    },
    image: {
      repository: "ghcr.io/usestrix/strix-sandbox",
      tag: "1.3.0",
      indexDigest: "sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331",
      platform: "linux/amd64",
      manifestDigest: "sha256:e5e5d9927f15ca95ad49804ef7d22439771cd27378f400da6edd47556799baff",
    },
    subject: { kind: "local-fixture", treeSha256: "a".repeat(64) },
    invocation: {
      mode: "quick",
      maxBudgetCents: 100,
      maxTurns: 5,
      timeoutMs: 60_000,
      telemetry: "off",
    },
    result: { exitCode: 0, verdict: "no-findings", findings: [] },
  };
}

/** Seed one artifact of every indexed kind (all with trailing newlines, byte-stable). */
function seedAllKinds(): void {
  write("aih-skills.lock.json", '{"schemaVersion":1,"skills":[]}\n');
  write("aih-packs.json", '{"schemaVersion":1,"packs":[]}\n');
  write(".aih/trust-lock.json", '{"schemaVersion":1,"sources":[]}\n');
  write("ai-coding/skill-cards/alpha.json", '{"schemaVersion":1,"name":"alpha"}\n');
  write("ai-coding/skill-cards/beta.json", '{"schemaVersion":3,"name":"beta"}\n');
  write(".aih/skill-reports/local-src-vet.json", '{"schemaVersion":1,"verdict":"GREEN"}\n');
  write(".aih/baseline-reports/ecc-deadbeef.json", '{"schemaVersion":1,"sources":[]}\n');
  write(".aih/runs/2026-07.jsonl", '{"schemaVersion":1,"capability":"doctor"}\n');
  write(".aih/reports/repo-report.md", "# report\n");
  write(".aih/reports/local-report.html", "<html></html>\n");
  write("results.sarif", '{"version":"2.1.0","runs":[]}\n');
  write(".aih/drift.sarif", '{"version":"2.1.0","runs":[]}\n');
  write(`${STRIX_SECURITY_EVIDENCE_DIR}/run-001.json`, jsonFile(strixEvidence()));
}

type Actions = Awaited<ReturnType<typeof evidenceBuildCommand.plan>>["actions"];
function writesOf(actions: Actions): Record<string, WriteAction> {
  return Object.fromEntries(
    actions
      .filter((a): a is WriteAction => a.kind === "write")
      .map((w) => [w.path.replace(/\\/g, "/"), w]),
  );
}

describe("evidence build — kind index", () => {
  it("indexes every kind that exists, name-sorted, with packaged-byte hashes", async () => {
    seedAllKinds();
    const p = await evidenceBuildCommand.plan(ctx());
    const out = writesOf(p.actions);

    const indexWrite = out[".aih/evidence-bundle/evidence.json"];
    expect(indexWrite).toBeDefined();
    const index = EvidenceBundleSchema.parse(indexWrite?.json);
    expect(index.schemaVersion).toBe(1);
    expect(index.harness).toMatchObject({
      aihVersion: VERSION,
      releaseTag: `v-core-${VERSION}`,
      packageName: PACKAGE_NAME,
      tarballSha256: expect.stringContaining(`aihq-core-${VERSION}.tgz`),
      verificationCommand: `aih verify-release ${VERSION}`,
      npmProvenance: "not-checked",
    });

    const byPath = new Map(index.artifacts.map((a) => [a.path, a]));
    expect(byPath.get("aih-skills.lock.json")?.kind).toBe("skills-lock");
    expect(byPath.get("aih-packs.json")?.kind).toBe("packs");
    expect(byPath.get(".aih/trust-lock.json")?.kind).toBe("trust-lock");
    expect(byPath.get("ai-coding/skill-cards/alpha.json")?.kind).toBe("skill-card");
    expect(byPath.get(".aih/skill-reports/local-src-vet.json")?.kind).toBe("skill-evidence");
    expect(byPath.get(".aih/baseline-reports/ecc-deadbeef.json")?.kind).toBe("baseline-evidence");
    expect(byPath.get(".aih/runs/2026-07.jsonl")?.kind).toBe("run-log");
    expect(byPath.get(".aih/reports/repo-report.md")?.kind).toBe("report");
    expect(byPath.get(".aih/reports/local-report.html")?.kind).toBe("report");
    expect(byPath.get("results.sarif")?.kind).toBe("sarif");
    expect(byPath.get(".aih/drift.sarif")?.kind).toBe("sarif");
    expect(byPath.get(`${STRIX_SECURITY_EVIDENCE_DIR}/run-001.json`)?.kind).toBe(
      "strix-security-evidence",
    );
    expect(index.artifacts).toHaveLength(13);

    // name-sorted by path
    const paths = index.artifacts.map((a) => a.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));

    // hash of the exact packaged bytes (the same normalized string the copy writes)
    const lock = byPath.get("aih-skills.lock.json");
    expect(lock?.sha256).toBe(sha256Hex('{"schemaVersion":1,"skills":[]}\n'));
    expect(out[".aih/evidence-bundle/files/aih-skills.lock.json"]?.contents).toBe(
      '{"schemaVersion":1,"skills":[]}\n',
    );
  });

  it("reads each artifact's own schemaVersion when present, else 1", async () => {
    seedAllKinds();
    const p = await evidenceBuildCommand.plan(ctx());
    const index = EvidenceBundleSchema.parse(
      writesOf(p.actions)[".aih/evidence-bundle/evidence.json"]?.json,
    );
    const byPath = new Map(index.artifacts.map((a) => [a.path, a]));
    expect(byPath.get("ai-coding/skill-cards/alpha.json")?.schemaVersion).toBe(1);
    expect(byPath.get("ai-coding/skill-cards/beta.json")?.schemaVersion).toBe(3);
    // jsonl / md / sarif are not single JSON docs with schemaVersion → 1
    expect(byPath.get(".aih/runs/2026-07.jsonl")?.schemaVersion).toBe(1);
    expect(byPath.get(".aih/reports/repo-report.md")?.schemaVersion).toBe(1);
    expect(byPath.get("results.sarif")?.schemaVersion).toBe(1);
  });

  it("skips absent kinds silently — an empty repo yields an empty index", async () => {
    const p = await evidenceBuildCommand.plan(ctx());
    const out = writesOf(p.actions);
    expect(Object.keys(out)).toEqual([
      ".aih/evidence-bundle/manifest.json",
      ".aih/evidence-bundle/SHA256SUMS",
      ".aih/evidence-bundle/evidence.json",
    ]);
    const index = EvidenceBundleSchema.parse(out[".aih/evidence-bundle/evidence.json"]?.json);
    expect(index.artifacts).toEqual([]);
    expect(index.harness?.checksumFile).toContain(`${releaseTag(VERSION)}/SHA256SUMS.txt`);
  });

  it("keeps older evidence indexes without a harness block valid", () => {
    const old = EvidenceBundleSchema.parse({ schemaVersion: 1, artifacts: [] });
    expect(old.harness).toBeUndefined();
  });

  it("publishes Strix as its own versioned kind only after strict typed validation", async () => {
    expect(EvidenceKindSchema.parse("strix-security-evidence")).toBe("strix-security-evidence");
    const evidence = strixEvidence();
    const sourcePath = `${STRIX_SECURITY_EVIDENCE_DIR}/valid.json`;
    write(sourcePath, jsonFile(evidence));

    const p = await evidenceBuildCommand.plan(ctx());
    const out = writesOf(p.actions);
    const index = EvidenceBundleSchema.parse(out[".aih/evidence-bundle/evidence.json"]?.json);
    const artifact = index.artifacts.find((item) => item.path === sourcePath);
    expect(artifact).toEqual({
      kind: "strix-security-evidence",
      path: sourcePath,
      schemaVersion: 1,
      sha256: sha256Hex(jsonFile(evidence)),
    });
    expect(out[`.aih/evidence-bundle/files/${sourcePath}`]?.contents).toBe(jsonFile(evidence));
  });

  it("fails closed instead of publishing malformed or payload-bearing Strix evidence", async () => {
    const malformed = { ...strixEvidence(), rawPayload: "secret PoC" };
    write(`${STRIX_SECURITY_EVIDENCE_DIR}/malformed.json`, jsonFile(malformed));

    await expect(evidenceBuildCommand.plan(ctx())).rejects.toThrow(
      "invalid Strix security evidence",
    );
  });

  it("fails closed on non-UTF-8 Strix evidence bytes", async () => {
    const rel = `${STRIX_SECURITY_EVIDENCE_DIR}/invalid-utf8.json`;
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    const valid = Buffer.from(jsonFile(strixEvidence()), "utf8");
    const marker = valid.indexOf(Buffer.from("usestrix/strix", "utf8"));
    expect(marker).toBeGreaterThanOrEqual(0);
    valid[marker] = 0xff;
    writeFileSync(target, valid);

    await expect(evidenceBuildCommand.plan(ctx())).rejects.toThrow(
      "invalid Strix security evidence",
    );
  });

  it("rejects hostile Strix entry names without echoing control or format characters", async () => {
    expect(isSafeStrixSecurityEvidenceFilename("bad\u001b.json")).toBe(false);
    expect(isSafeStrixSecurityEvidenceFilename("bad\u200b.json")).toBe(false);

    const name = "bad\u200b.json";
    write(`${STRIX_SECURITY_EVIDENCE_DIR}/${name}`, jsonFile(strixEvidence()));
    const error = await Promise.resolve(evidenceBuildCommand.plan(ctx())).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(error?.message).toBe("invalid Strix security evidence entry name");
    expect(error?.message).not.toContain(name);
    rmSync(join(dir, STRIX_SECURITY_EVIDENCE_DIR, name));
  });

  it("bounds Strix evidence reads and fails closed when a discovered file is unreadable", async () => {
    expect(MAX_STRIX_SECURITY_EVIDENCE_BYTES).toBe(32 * 1024 * 1024);
    const rel = `${STRIX_SECURITY_EVIDENCE_DIR}/oversized.json`;
    write(rel, jsonFile(strixEvidence()));
    truncateSync(join(dir, rel), MAX_STRIX_SECURITY_EVIDENCE_BYTES + 1);

    await expect(evidenceBuildCommand.plan(ctx())).rejects.toThrow(
      "Strix security evidence could not be read",
    );
  });

  it("refuses hostile directory-entry names instead of composing paths from them", async () => {
    write("ai-coding/skill-cards/ok.json", '{"schemaVersion":1}\n');
    write("ai-coding/skill-cards/x..y.json", '{"schemaVersion":1}\n');
    const p = await evidenceBuildCommand.plan(ctx());
    const index = EvidenceBundleSchema.parse(
      writesOf(p.actions)[".aih/evidence-bundle/evidence.json"]?.json,
    );
    const paths = index.artifacts.map((a) => a.path);
    expect(paths).toContain("ai-coding/skill-cards/ok.json");
    expect(paths).not.toContain("ai-coding/skill-cards/x..y.json");
  });
});

describe("evidence build — bundle-standard layout", () => {
  it("emits files/<rel> copies, manifest.json, and SHA256SUMS in the fleet-bundle shape", async () => {
    seedAllKinds();
    const p = await evidenceBuildCommand.plan(ctx());
    const out = writesOf(p.actions);

    const manifest = out[".aih/evidence-bundle/manifest.json"]?.json as {
      schemaVersion: number;
      files: Array<{ path: string; bytes: number; sha256: string }>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.files).toHaveLength(13);
    const lockRow = manifest.files.find((f) => f.path === "aih-skills.lock.json");
    expect(lockRow?.sha256).toBe(sha256Hex('{"schemaVersion":1,"skills":[]}\n'));
    expect(lockRow?.bytes).toBe(Buffer.byteLength('{"schemaVersion":1,"skills":[]}\n', "utf8"));

    const sums = out[".aih/evidence-bundle/SHA256SUMS"]?.contents ?? "";
    expect(sums).toContain(
      `${sha256Hex('{"schemaVersion":1,"skills":[]}\n')}  files/aih-skills.lock.json`,
    );
    expect(sums).toContain(`${sha256Hex(jsonFile(manifest))}  manifest.json`);
    expect(sums).toContain(
      `${sha256Hex(jsonFile(out[".aih/evidence-bundle/evidence.json"]?.json))}  evidence.json`,
    );
    // every non-empty line is `<hex64>  files/<rel>` or generated bundle metadata
    for (const line of sums.split("\n").filter((l) => l.trim().length > 0)) {
      expect(line).toMatch(/^[0-9a-f]{64} {2}(files\/.+|manifest\.json|evidence\.json)$/);
    }
  });

  it("round-trips through aih verify-bundle (the layout is bundle-standard)", async () => {
    seedAllKinds();
    const p = await evidenceBuildCommand.plan(ctx());
    // Land the writes exactly as the engine would (writeJson renders via jsonFile).
    for (const a of p.actions) {
      if (a.kind !== "write") continue;
      const target = join(dir, a.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, a.contents ?? jsonFile(a.json));
    }
    const check = verifyBundleChecksums(join(dir, ".aih/evidence-bundle"));
    expect(check.verdict).toBe("pass");
  }, 30_000);

  it("is byte-identical across two builds over identical inputs", async () => {
    seedAllKinds();
    const first = await evidenceBuildCommand.plan(ctx());
    const second = await evidenceBuildCommand.plan(ctx());
    const shape = (p: typeof first) =>
      p.actions.map((a) =>
        a.kind === "write"
          ? { kind: a.kind, path: a.path, contents: a.contents ?? jsonFile(a.json) }
          : { kind: a.kind, describe: a.describe },
      );
    expect(JSON.stringify(shape(first))).toBe(JSON.stringify(shape(second)));
  });
});

describe("evidence build — signing and digest", () => {
  it("emits no exec by default and a best-effort cosign exec under --sign", async () => {
    seedAllKinds();
    const bare = await evidenceBuildCommand.plan(ctx());
    expect(bare.actions.some((a) => a.kind === "exec")).toBe(false);

    const signed = await evidenceBuildCommand.plan(ctx({ options: { sign: "cosign" } }));
    const exec = signed.actions.find((a): a is ExecAction => a.kind === "exec");
    expect(exec?.argv[0]).toBe("cosign");
    expect(exec?.allowFailure).toBe(true);
    expect(exec?.argv).toContain(".aih/evidence-bundle/SHA256SUMS");
    const signedSums =
      signed.actions.find(
        (a): a is WriteAction => a.kind === "write" && a.path.endsWith("SHA256SUMS"),
      )?.contents ?? "";
    expect(exec?.expect).toEqual({
      path: ".aih/evidence-bundle/SHA256SUMS",
      sha256: sha256Hex(signedSums),
    });

    const gh = await evidenceBuildCommand.plan(ctx({ options: { sign: "gh" } }));
    const ghExec = gh.actions.find((a): a is ExecAction => a.kind === "exec");
    expect(ghExec?.argv.slice(0, 3)).toEqual(["gh", "attestation", "sign"]);
    expect(ghExec?.allowFailure).toBe(true);
  });

  it("makes signing strict under enterprise posture or --require-signature", async () => {
    seedAllKinds();
    const enterprise = await evidenceBuildCommand.plan(
      ctx({ posture: "enterprise", options: { sign: "cosign" } }),
    );
    const strictExec = enterprise.actions.find((a): a is ExecAction => a.kind === "exec");
    expect(strictExec?.argv[0]).toBe("cosign");
    expect(strictExec?.allowFailure).toBe(false);

    const required = await evidenceBuildCommand.plan(
      ctx({ options: { sign: "gh", requireSignature: true } }),
    );
    const ghExec = required.actions.find((a): a is ExecAction => a.kind === "exec");
    expect(ghExec?.argv.slice(0, 3)).toEqual(["gh", "attestation", "sign"]);
    expect(ghExec?.allowFailure).toBe(false);
  });

  it("emits a coded verification failure when strict signing is requested without a signer", async () => {
    const c = ctx({ options: { requireSignature: true }, verify: true });
    const result = await executePlan(await evidenceBuildCommand.plan(c), c);
    const check = result.report?.checks.find((item) => item.name === "evidence bundle signature");

    expect(result.report?.ok).toBe(false);
    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("bundle.signature");
  });

  it("records a coded failure when strict signing exec fails", async () => {
    seedAllKinds();
    const run = fakeRunner((argv) =>
      argv[0] === "cosign" ? { code: 1, stderr: "signing refused" } : undefined,
    );
    const c = ctx({
      apply: true,
      verify: true,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      posture: "enterprise",
      options: { sign: "cosign" },
    });
    const result = await executePlan(await evidenceBuildCommand.plan(c), c);
    const check = result.report?.checks.find((item) => item.name === "evidence bundle signature");

    expect(result.execs.find((item) => item.argv[0] === "cosign")?.ok).toBe(false);
    expect(result.report?.ok).toBe(false);
    expect(check?.code).toBe("bundle.signature");
    expect(check?.detail).toContain("signing refused");
  });

  it("summarizes per-kind counts and the verify-bundle hint in the digest", async () => {
    seedAllKinds();
    const p = await evidenceBuildCommand.plan(ctx());
    const d = p.actions.find((a): a is DigestAction => a.kind === "digest");
    expect(d?.text).toContain("13 artifact(s)");
    expect(d?.text).toContain("- strix-security-evidence  1 file(s)");
    expect(d?.text).toContain("- baseline-evidence  1 file(s)");
    expect(d?.text).toContain("- skill-card  2 file(s)");
    expect(d?.text).toContain("- report  2 file(s)");
    expect(d?.text).toContain("aih verify-bundle --bundle .aih/evidence-bundle");
    expect(d?.data).toMatchObject({ harness: { aihVersion: VERSION } });
  });
});
