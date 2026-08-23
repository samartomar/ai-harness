import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../src/org-policy/governance-decision-v2.js";
import {
  npmPackageLifecycleCommand,
  npmPackageLifecyclePlan,
} from "../../src/org-policy/npm-package-lifecycle-v1.js";
import {
  canonicalOrganizationEvidenceEnvelopeV1,
  organizationEvidenceEnvelopeDigestV1,
} from "../../src/org-policy/qualification-v1.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { buildProgram } from "../../src/program.js";

const INTEGRITY = `sha512-${Buffer.alloc(64, 3).toString("base64")}`;
let root: string;
let bin: string;
let gh: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-02T12:00:00+00:00"));
  root = mkdtempSync(join(tmpdir(), "aih-npm-lifecycle-"));
  bin = mkdtempSync(join(tmpdir(), "aih-npm-lifecycle-gh-"));
  gh = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(gh, "trusted gh fixture\n", { mode: 0o755 });
  gh = realpathSync.native(gh);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

function fixture(version = "1.2.3", integrity = INTEGRITY) {
  const source = {
    type: "npm" as const,
    registry: "https://registry.npmjs.org/",
    package: "@acme/widget",
    version,
    integrity,
  };
  const sourceDigest = governanceDecisionSourceDigestV2(source);
  const subject = {
    kind: "package" as const,
    id: "acme-widget",
    source,
    sourceDigest,
    subjectDigest: governanceDecisionSubjectDigestV2({
      kind: "package",
      id: "acme-widget",
      sourceDigest,
    }),
  };
  const evidence = {
    format: "aih-organization-evidence" as const,
    version: 1 as const,
    subjectDigest: subject.subjectDigest,
    evidence: {
      kind: "assessment" as const,
      id: "scan-record",
      summary: "The named organization assessment approved this exact package.",
      payloadDigest: `sha256:${"1".repeat(64)}`,
      artifactDigests: [`sha256:${"2".repeat(64)}`],
    },
    attestor: "scanner-service",
    issuedAt: "2026-08-01T00:00:00+00:00",
    notBefore: "2026-08-01T00:00:00+00:00",
    expiresAt: "2026-08-05T00:00:00+00:00",
  };
  const evidenceDigest = organizationEvidenceEnvelopeDigestV1(evidence);
  const decision = {
    format: "aih-governance-decision" as const,
    version: 2 as const,
    id: "decision-acme-widget",
    qualificationBasis: {
      kind: "organization-qualified" as const,
      evidenceDigest,
      attestor: "scanner-service",
    },
    subject,
    targets: ["claude", "codex"],
    allowedEffects: ["install" as const],
    policy: { id: "platform-policy", version: "2026.08", digest: `sha256:${"c".repeat(64)}` },
    control: { id: "review-control", digest: `sha256:${"d".repeat(64)}` },
    evidence: { id: "scan-record", digest: evidenceDigest, attestor: "scanner-service" },
    issuer: "platform-security",
    actor: "security-admin",
    reason: "The exact package passed the reviewed control.",
    issuedAt: "2026-08-01T00:00:00+00:00",
    notBefore: "2026-08-01T00:00:00+00:00",
    expiresAt: "2026-08-10T00:00:00+00:00",
    disposition: "approved" as const,
    acceptedFindings: [],
    acceptedGaps: [],
    conditions: [],
  };
  return { decision, evidence };
}

function writeAuthority(
  decision: ReturnType<typeof fixture>["decision"],
  decisionRevocations: readonly Record<string, unknown>[] = [],
): void {
  mkdirSync(join(root, ".aih"), { recursive: true });
  writeFileSync(
    join(root, ".aih", "policy-authority-receipt.json"),
    JSON.stringify({
      format: "aih-policy-authority-receipt",
      version: 3,
      issuerRepository: "acme/governance",
      issuedAt: "2026-08-01T00:00:00+00:00",
      expiresAt: "2026-08-10T00:00:00+00:00",
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
      targets: ["claude", "codex"],
      decisions: [decision],
      decisionRevocations,
    }),
  );
}

function writeFixture(value = fixture()): void {
  mkdirSync(join(root, ".aih"), { recursive: true });
  writeFileSync(
    join(root, "evidence.json"),
    canonicalOrganizationEvidenceEnvelopeV1(value.evidence),
  );
  writeAuthority(value.decision);
  mkdirSync(join(root, "node_modules", "@acme", "widget"), { recursive: true });
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture" },
        "node_modules/@acme/widget": {
          version: value.decision.subject.source.version,
          integrity: value.decision.subject.source.integrity,
        },
      },
    }),
  );
  writeFileSync(
    join(root, "node_modules", "@acme", "widget", "package.json"),
    JSON.stringify({ name: "@acme/widget", version: value.decision.subject.source.version }),
  );
}

function context(apply = false, decision = fixture().decision): PlanContext {
  const run = fakeRunner((argv) => (argv[0] === gh ? { code: 0 } : { code: 1 }));
  return {
    root,
    contextDir: "ai-coding",
    apply,
    verify: true,
    json: true,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
    options: {
      decision: decision.id,
      decisionDigest: governanceDecisionDigestV2(decision),
      target: "claude",
      evidence: "evidence.json",
    },
  };
}

function lifecycleFiles(): string[] {
  const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
  if (!existsSync(base)) return [];
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const child = join(path, entry.name);
      return entry.isDirectory()
        ? walk(child)
        : [child.slice(base.length + 1).replaceAll("\\", "/")];
    });
  return walk(base).sort();
}

async function run(ctx: PlanContext) {
  const result = await executePlan(await npmPackageLifecyclePlan(ctx), ctx, {
    skipWorktreeGate: true,
  });
  return result.digests[0]?.data as { applied: boolean; outcome: string };
}

describe("npm package lifecycle V1", () => {
  it("keeps preview zero-write, then appends immutable observation records before advancing a subject head", async () => {
    writeFixture();
    const preview = await run(context(false));
    expect(preview).toMatchObject({ outcome: "reported-only", applied: false });
    expect(lifecycleFiles()).toEqual([]);

    const first = await run(context(true));
    expect(first).toMatchObject({ outcome: "fulfilled", applied: true });
    const firstFiles = lifecycleFiles();
    expect(firstFiles.filter((file) => file.startsWith("records/"))).toHaveLength(1);
    expect(firstFiles.filter((file) => file.startsWith("heads/"))).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    const second = await run(context(true));
    expect(second).toMatchObject({ outcome: "fulfilled", applied: true });
    expect(lifecycleFiles().filter((file) => file.startsWith("records/"))).toHaveLength(2);
  });

  it("does not create lifecycle state for a refused write and exposes no package/effect override", async () => {
    writeFixture();
    const missing = await run({ ...context(true), options: {} });
    expect(missing).toMatchObject({ outcome: "refused", applied: false });
    expect(lifecycleFiles()).toEqual([]);
    const policy = buildProgram().commands.find((command) => command.name() === "policy");
    const lifecycle = policy?.commands.find((command) => command.name() === "lifecycle");
    const npmPackage = lifecycle?.commands.find((command) => command.name() === "npm-package");
    expect(npmPackage?.options.map((item) => item.flags)).toEqual(
      expect.arrayContaining(["--apply"]),
    );
    expect(npmPackageLifecycleCommand.options?.map((item) => item.flags)).not.toEqual(
      expect.arrayContaining(["--package <name>", "--effect <effect>"]),
    );
  });

  it("uses one stable lineage across an exact npm version bump and chains the new record", async () => {
    const first = fixture("1.2.3");
    writeFixture(first);
    await run(context(true, first.decision));
    const secondIntegrity = `sha512-${Buffer.alloc(64, 4).toString("base64")}`;
    const second = fixture("1.2.4", secondIntegrity);
    writeFixture(second);
    vi.advanceTimersByTime(1_000);
    await run(context(true, second.decision));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const heads = readdirSync(join(base, "heads")).filter((name) => name.endsWith(".json"));
    const records = readdirSync(join(base, "records")).filter((name) => name.endsWith(".json"));
    expect(heads).toHaveLength(1);
    expect(records).toHaveLength(2);
    const head = JSON.parse(readFileSync(join(base, "heads", heads[0] as string), "utf8"));
    const newest = JSON.parse(
      readFileSync(join(base, "records", `${head.recordDigest.slice(7)}.json`), "utf8"),
    );
    expect(newest.sequence).toBe(2);
    expect(newest.previousRecordDigest).toMatch(/^sha256:/);
    const prior = JSON.parse(
      readFileSync(join(base, "records", `${newest.previousRecordDigest.slice(7)}.json`), "utf8"),
    );
    expect(newest.observation.installed).not.toEqual(prior.observation.installed);
    expect(newest.observation.subject.sourceDigest).toBe(second.decision.subject.sourceDigest);
    expect(newest.observation.subject.subjectDigest).toBe(second.decision.subject.subjectDigest);
    expect(prior.observation.subject.sourceDigest).toBe(first.decision.subject.sourceDigest);
    expect(prior.observation.subject.subjectDigest).toBe(first.decision.subject.subjectDigest);
  });

  it("persists the full authenticated V3 revocation once, without claiming package removal", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const digest = governanceDecisionDigestV2(value.decision);
    const revocation = {
      format: "aih-governance-decision-revocation",
      version: 2,
      decisionDigest: digest,
      issuer: "platform-security",
      revokedAt: "2026-08-01T00:00:00+00:00",
      reason: "Critical upstream withdrawal.",
    };
    writeAuthority(value.decision, [revocation]);
    const revoked = await run(context(true, value.decision));
    expect(revoked).toMatchObject({ outcome: "fulfilled", state: "decision-revoked" });
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const head = JSON.parse(
      readFileSync(
        join(
          base,
          "heads",
          readdirSync(join(base, "heads")).find((name) => name.endsWith(".json")) as string,
        ),
        "utf8",
      ),
    );
    const record = JSON.parse(
      readFileSync(join(base, "records", `${head.recordDigest.slice(7)}.json`), "utf8"),
    );
    expect(record.revocation).toEqual(revocation);
    expect(record.authorityReceiptDigest).toMatch(/^sha256:/);
    expect(record).not.toHaveProperty("removed");
    expect(record).not.toHaveProperty("terminated");
    const recordsBefore = readdirSync(join(base, "records"));
    const repeated = await run(context(true, value.decision));
    expect(repeated).toMatchObject({ outcome: "reported-only", state: "decision-revoked" });
    expect(readdirSync(join(base, "records"))).toEqual(recordsBefore);
  });

  it("does not let revocation of an older decision supersede the latest exact bump", async () => {
    const oldValue = fixture("1.2.3");
    writeFixture(oldValue);
    await run(context(true, oldValue.decision));
    const newer = fixture("1.2.4");
    writeFixture(newer);
    vi.advanceTimersByTime(1_000);
    await run(context(true, newer.decision));
    const oldDigest = governanceDecisionDigestV2(oldValue.decision);
    writeAuthority(oldValue.decision, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: oldDigest,
        issuer: "platform-security",
        revokedAt: "2026-08-01T00:00:00+00:00",
        reason: "Old package version withdrawn.",
      },
    ]);
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const before = readdirSync(join(base, "records")).sort();
    const result = await run(context(true, oldValue.decision));
    expect(result).toMatchObject({ outcome: "reported-only", state: "decision-revoked" });
    expect(readdirSync(join(base, "records")).sort()).toEqual(before);
  });

  it("refuses a stale rolled-back head when the canonical successor record remains", async () => {
    const oldValue = fixture("1.2.3");
    writeFixture(oldValue);
    await run(context(true, oldValue.decision));
    const newer = fixture("1.2.4", `sha512-${Buffer.alloc(64, 4).toString("base64")}`);
    writeFixture(newer);
    vi.advanceTimersByTime(1_000);
    await run(context(true, newer.decision));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const headName = readdirSync(join(base, "heads")).find((name) =>
      name.endsWith(".json"),
    ) as string;
    copyFileSync(join(base, "heads", `${headName}.aih.bak`), join(base, "heads", headName));
    const before = lifecycleFiles();
    const refused = await run(context(true, newer.decision));
    expect(refused).toMatchObject({ outcome: "refused", state: "head-conflict" });
    expect(lifecycleFiles()).toEqual(before);
  });

  it("refuses an apply after the sealed observation deadline without creating lifecycle state", async () => {
    const value = fixture();
    value.evidence.expiresAt = "2026-08-02T12:00:30+00:00";
    const evidenceDigest = organizationEvidenceEnvelopeDigestV1(value.evidence);
    value.decision.qualificationBasis = {
      kind: "organization-qualified",
      evidenceDigest,
      attestor: value.evidence.attestor,
    };
    value.decision.evidence = {
      id: value.evidence.evidence.id,
      digest: evidenceDigest,
      attestor: value.evidence.attestor,
    };
    writeFixture(value);
    const ctx = context(true, value.decision);
    const planned = await npmPackageLifecyclePlan(ctx);
    expect(planned.commitNotAfter).toBe("2026-08-02T12:00:30.000Z");
    vi.advanceTimersByTime(30_000);
    await expect(executePlan(planned, ctx, { skipWorktreeGate: true })).rejects.toThrow(
      /deadline expired/i,
    );
    expect(lifecycleFiles()).toEqual([]);
  });

  it("pins the exact authority, evidence, lockfile, and installed manifest used by observation", async () => {
    const value = fixture();
    const paths = [
      join(root, ".aih", "policy-authority-receipt.json"),
      join(root, "evidence.json"),
      join(root, "package-lock.json"),
      join(root, "node_modules", "@acme", "widget", "package.json"),
    ];
    for (const path of paths) {
      writeFixture(value);
      const ctx = context(true, value.decision);
      const planned = await npmPackageLifecyclePlan(ctx);
      writeFileSync(path, `swapped:${path}\n`);
      await expect(executePlan(planned, ctx, { skipWorktreeGate: true })).rejects.toThrow(
        /changed after the plan|unchanged|transaction failed/i,
      );
      expect(lifecycleFiles()).toEqual([]);
    }
  });

  it("is deterministic and invokes only the fixed authority attestation boundary once per plan", async () => {
    const value = fixture();
    writeFixture(value);
    const calls: string[][] = [];
    const ctx = context(false, value.decision);
    const originalRun = ctx.run;
    ctx.run = async (argv, options) => {
      calls.push(argv);
      return originalRun(argv, options);
    };
    const first = await npmPackageLifecyclePlan(ctx);
    const second = await npmPackageLifecyclePlan(ctx);
    expect(first.actions.map((action) => action.kind)).toEqual(
      second.actions.map((action) => action.kind),
    );
    expect(calls).toHaveLength(2);
    expect(calls.every((argv) => argv[0] === gh && argv[1] === "attestation")).toBe(true);
    expect((await executePlan(first, ctx, { skipWorktreeGate: true })).digests[0]?.data).toEqual(
      (await executePlan(second, ctx, { skipWorktreeGate: true })).digests[0]?.data,
    );
    expect(lifecycleFiles()).toEqual([]);
  });

  it("refuses a linked governance-store parent without writing through it", async () => {
    const value = fixture();
    writeFixture(value);
    const outside = mkdtempSync(join(tmpdir(), "aih-npm-lifecycle-outside-"));
    try {
      symlinkSync(
        outside,
        join(root, ".aih", "governance"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const result = await run(context(true, value.decision));
      expect(result).toMatchObject({ outcome: "refused", state: "store-unsafe" });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
