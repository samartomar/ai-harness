import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCapability } from "../../src/commands/run.js";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import { readRegularFileWithStats } from "../../src/internals/fsxn.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  type GovernanceDecisionV2,
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../src/org-policy/governance-decision-v2.js";
import {
  __setNpmPackageObserverInternalTestHookV1,
  npmPackageObservationHandoffForLifecycleV1,
  npmPackageObserveCommand,
  npmPackageObservePlan,
  observeNpmPackageV1,
} from "../../src/org-policy/npm-package-observer-v1.js";
import {
  canonicalOrganizationEvidenceEnvelopeV1,
  organizationEvidenceEnvelopeDigestV1,
} from "../../src/org-policy/qualification-v1.js";
import { canonicalAihSupportedQualificationReceiptV2 } from "../../src/org-policy/supported-qualification-receipt-v2.js";
import { upstreamObservationReceiptDigestV1 } from "../../src/org-policy/upstream-observation-receipt-v1.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { toFinding } from "../../src/support/findings.js";

const INTEGRITY = `sha512-${Buffer.alloc(64, 3).toString("base64")}`;

let root: string;
let bin: string;
let gh: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-02T12:00:00+00:00"));
  root = mkdtempSync(join(tmpdir(), "aih-npm-observer-"));
  bin = mkdtempSync(join(tmpdir(), "aih-npm-observer-gh-"));
  const executable = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(executable, "trusted gh fixture\n", { mode: 0o755 });
  gh = realpathSync.native(executable);
});

afterEach(() => {
  __setNpmPackageObserverInternalTestHookV1(undefined);
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

function fixture() {
  const source = {
    type: "npm" as const,
    registry: "https://registry.npmjs.org/",
    package: "@acme/widget",
    version: "1.2.3",
    integrity: INTEGRITY,
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
      kind: "assessment",
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
  return {
    decision,
    evidence,
    evidenceBytes: Buffer.from(canonicalOrganizationEvidenceEnvelopeV1(evidence)),
  };
}

function supportedFixture() {
  const value = fixture();
  const catalogHeadDigest = `sha256:${"a".repeat(64)}`;
  const receipt = {
    format: "aih-supported-qualification-receipt" as const,
    version: 2 as const,
    organizationAdmission: "not-authoritative" as const,
    entryId: "recipe.acme-widget",
    subject: value.decision.subject,
    qualificationBasis: {
      kind: "aih-supported" as const,
      catalogSignerIdentity: "administrator:aih-supported",
      catalogDigest: `sha256:${"b".repeat(64)}`,
      catalogHeadDigest,
      catalogMemberDigest: `sha256:${"c".repeat(64)}`,
      subjectKind: value.decision.subject.kind,
      subjectDigest: value.decision.subject.subjectDigest,
    },
    catalogContinuity: {
      catalogHeadDigest,
      previousCatalogHeadDigest: `sha256:${"0".repeat(64)}`,
      sequence: 0,
      replayIdentity: `catalog-head:${"a".repeat(64)}:${"d".repeat(64)}`,
      signerKeyId: `ed25519:${"e".repeat(64)}`,
      headValidFrom: "2026-08-01T00:00:00Z",
      headValidUntil: "2026-08-05T00:00:00Z",
    },
    issuedAt: "2026-08-02T00:00:00Z",
    notBefore: "2026-08-02T00:00:00Z",
    expiresAt: "2026-08-05T00:00:00Z",
  };
  return {
    ...value,
    decision: {
      ...value.decision,
      qualificationBasis: receipt.qualificationBasis,
    },
    receipt,
  };
}

function writeAuthority(
  decision: GovernanceDecisionV2,
  overrides: Record<string, unknown> = {},
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
      decisionRevocations: [],
      ...overrides,
    }),
  );
}

function writeInstalledPackage(): void {
  mkdirSync(join(root, "node_modules", "@acme", "widget"), { recursive: true });
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture" },
        "node_modules/@acme/widget": { version: "1.2.3", integrity: INTEGRITY },
      },
    }),
  );
  writeFileSync(
    join(root, "node_modules", "@acme", "widget", "package.json"),
    JSON.stringify({ name: "@acme/widget", version: "1.2.3" }),
  );
}

function context(
  options: Record<string, unknown>,
  calls: string[][],
  extraEnv: Record<string, string> = {},
): PlanContext {
  const run = fakeRunner((argv) => {
    calls.push([...argv]);
    return argv[0] === gh ? { code: 0 } : { code: 1 };
  });
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: true,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin, ...extraEnv },
    options,
  };
}

function command(argv: string[]): Command {
  const value = new Command("npm-package");
  value.exitOverride();
  value.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  value
    .option("--apply")
    .option("--verify")
    .option("--json")
    .option("--root <dir>")
    .option("--context-dir <dir>", "", "ai-coding")
    .option("--decision <id>")
    .option("--decision-digest <sha256>")
    .option("--target <cli>")
    .option("--evidence <path>");
  value.parse(argv, { from: "user" });
  return value;
}

function treeSnapshot(path: string, relative = ""): string[] {
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .flatMap((entry) => {
      const child = join(path, entry.name);
      const rel = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) return [`link:${rel}:${readlinkSync(child)}`];
      if (entry.isDirectory()) return [`dir:${rel}`, ...treeSnapshot(child, rel)];
      const file = readRegularFileWithStats(child);
      if (file === undefined) throw new Error(`snapshot cannot read regular file: ${rel}`);
      return [`file:${rel}:${createHash("sha256").update(file.contents).digest("hex")}`];
    });
}

describe("npm package upstream observer V1", () => {
  it.each([
    [{}, "invalid-input"],
    [
      {
        decision: "bad!",
        decisionDigest: `sha256:${"0".repeat(64)}`,
        target: "claude",
        evidence: "x",
      },
      "invalid-input",
    ],
    [
      {
        decision: "decision-acme-widget",
        decisionDigest: "sha256:not-a-digest",
        target: "claude",
        evidence: "x",
      },
      "invalid-input",
    ],
    [
      {
        decision: "decision-acme-widget",
        decisionDigest: `sha256:${"0".repeat(64)}`,
        target: "not-a-cli",
        evidence: "x",
      },
      "invalid-input",
    ],
  ])("rejects invalid observer input before any attestation process", async (options, reason) => {
    const calls: string[][] = [];
    const result = await observeNpmPackageV1(context(options, calls));
    expect(result).toMatchObject({ outcome: "refused", reason });
    expect(calls).toEqual([]);
  });

  it("closes well-formed decision, evidence, subject, source, and install-scope mismatches", async () => {
    const value = fixture();
    const cases: Array<{
      label: string;
      decision?: GovernanceDecisionV2;
      evidence?: typeof value.evidence;
      digest?: string;
      reason: string;
      qualification: "qualified" | "unqualified";
    }> = [];
    cases.push({
      label: "wrong decision digest",
      digest: `sha256:${"0".repeat(64)}`,
      reason: "decision-missing-or-mismatch",
      qualification: "unqualified",
    });
    for (const [label, evidence] of [
      [
        "evidence digest",
        {
          ...value.evidence,
          evidence: { ...value.evidence.evidence, payloadDigest: `sha256:${"9".repeat(64)}` },
        },
      ],
      ["evidence attestor", { ...value.evidence, attestor: "other-scanner" }],
      ["evidence subject", { ...value.evidence, subjectDigest: `sha256:${"8".repeat(64)}` }],
    ] as const) {
      cases.push({
        label,
        evidence,
        reason: "qualification-unverified",
        qualification: "unqualified",
      });
    }
    const toolSubject = {
      ...value.decision.subject,
      kind: "tool" as const,
      id: "acme-widget-tool",
      subjectDigest: governanceDecisionSubjectDigestV2({
        kind: "tool",
        id: "acme-widget-tool",
        sourceDigest: value.decision.subject.sourceDigest,
      }),
    };
    cases.push({
      label: "non-package subject",
      decision: { ...value.decision, subject: toolSubject },
      reason: "installed-identity-mismatch",
      qualification: "unqualified",
    });
    const githubSource = {
      type: "github" as const,
      repository: "acme/widget",
      commit: "a".repeat(40),
      path: "package.json",
    };
    const githubSourceDigest = governanceDecisionSourceDigestV2(githubSource);
    cases.push({
      label: "non-npm source",
      decision: {
        ...value.decision,
        subject: {
          ...value.decision.subject,
          source: githubSource,
          sourceDigest: githubSourceDigest,
          subjectDigest: governanceDecisionSubjectDigestV2({
            kind: "package",
            id: value.decision.subject.id,
            sourceDigest: githubSourceDigest,
          }),
        },
      },
      reason: "installed-identity-mismatch",
      qualification: "unqualified",
    });
    cases.push({
      label: "missing install effect",
      decision: { ...value.decision, allowedEffects: ["use"] },
      reason: "decision-scope-mismatch",
      qualification: "unqualified",
    });

    for (const item of cases) {
      const decision = item.decision ?? value.decision;
      writeAuthority(decision);
      writeFileSync(
        join(root, "evidence.json"),
        Buffer.from(canonicalOrganizationEvidenceEnvelopeV1(item.evidence ?? value.evidence)),
      );
      const calls: string[][] = [];
      const result = await observeNpmPackageV1(
        context(
          {
            decision: decision.id,
            decisionDigest: item.digest ?? governanceDecisionDigestV2(decision as never),
            target: "claude",
            evidence: "evidence.json",
          },
          calls,
        ),
      );
      expect(result, item.label).toMatchObject({
        authority: "verified",
        qualification: item.qualification,
        outcome: "refused",
        reason: item.reason,
      });
      expect(calls, item.label).toHaveLength(1);
    }
  });

  it("emits sealed observe-specific codes with the required remediation owners", async () => {
    const value = fixture();
    writeAuthority(value.decision);
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    const calls: string[][] = [];
    const ctx = context(
      {
        decision: value.decision.id,
        decisionDigest: governanceDecisionDigestV2(value.decision as never),
        target: "claude",
        evidence: "evidence.json",
      },
      calls,
    );
    const probe = npmPackageObservePlan(ctx).actions.find((action) => action.kind === "probe");
    if (probe?.kind !== "probe") throw new Error("expected observer probe");
    const check = await probe.run(ctx);

    expect(check.code).toBe("org-policy.observe-installed-evidence-unavailable");
    expect(toFinding(check, "policy observe npm-package")).toMatchObject({
      audience: "developer",
      kind: "self-fix",
      severity: "blocking",
    });
    expect(
      toFinding(
        {
          name: "policy observe npm-package",
          verdict: "fail",
          detail: "policy observe npm-package decision-revoked",
          code: "org-policy.observe-decision-revoked" as never,
        },
        "policy observe npm-package",
      ),
    ).toMatchObject({ audience: "dev-platform", kind: "escalation", severity: "blocking" });
    expect(
      toFinding(
        {
          name: "policy observe npm-package",
          verdict: "fail",
          detail: "policy observe npm-package observation-unverified",
          code: "org-policy.observe-invariant-violation" as never,
        },
        "policy observe npm-package",
      ),
    ).toMatchObject({ audience: "dev-platform", kind: "escalation", severity: "blocking" });
  });

  it("hardcodes install and derives the npm identity instead of accepting caller overrides", () => {
    expect(npmPackageObserveCommand.readOnly).toBe(true);
    expect(npmPackageObserveCommand.zeroWrite).toBe(true);
    expect(npmPackageObserveCommand.options?.map((item) => item.flags)).toEqual([
      "--decision <id>",
      "--decision-digest <sha256>",
      "--target <cli>",
      "--evidence <path>",
    ]);
    expect(npmPackageObserveCommand.plan.toString()).not.toContain('"0".repeat(64)');
  });

  it("routes an AIH-supported npm decision without organization evidence, then refuses absent durable custody", async () => {
    const value = supportedFixture();
    writeAuthority(value.decision);
    writeInstalledPackage();
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(
      join(root, ".aih", "aih-supported-qualification-receipt.json"),
      canonicalAihSupportedQualificationReceiptV2(value.receipt),
    );
    const calls: string[][] = [];

    const result = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
        },
        calls,
        {
          AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "aihq/supported-catalog",
          AIH_SUPPORTED_QUALIFICATION_WORKFLOW: "qualification.yml",
        },
      ),
    );

    expect(result).toMatchObject({
      authority: "verified",
      qualification: "unqualified",
      outcome: "refused",
      reason: "qualification-unverified",
    });
    expect(calls).toHaveLength(2);
  });

  it("rejects a caller evidence path for an AIH-supported decision before it can select a weaker branch", async () => {
    const value = supportedFixture();
    writeAuthority(value.decision);
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    const calls: string[][] = [];

    const result = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
          evidence: "evidence.json",
        },
        calls,
      ),
    );

    expect(result).toMatchObject({
      authority: "verified",
      qualification: "unqualified",
      outcome: "refused",
      reason: "invalid-input",
    });
    expect(calls).toHaveLength(1);
  });

  it("observes only the signed exact installed package without executing it", async () => {
    const value = fixture();
    writeAuthority(value.decision);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    const before = new Map([
      ["lock", Buffer.from(readFileSync(join(root, "package-lock.json")))],
      [
        "manifest",
        Buffer.from(readFileSync(join(root, "node_modules", "@acme", "widget", "package.json"))),
      ],
    ]);
    const calls: string[][] = [];

    const result = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
          evidence: "evidence.json",
        },
        calls,
      ),
    );

    expect(result).toMatchObject({
      outcome: "observed-effective",
      effective: "observed-effective",
    });
    const verifierDigest = `sha256:${createHash("sha256")
      .update("aih-npm-package-observer/v1\0", "utf8")
      .update(
        canonicalStrictJsonBytesV1({
          format: "aih-npm-package-observer",
          version: 1,
          effect: "install",
          lockfileVersion: 3,
        }),
      )
      .digest("hex")}`;
    const installedDigest = `sha256:${createHash("sha256")
      .update(
        canonicalStrictJsonBytesV1({
          integrity: INTEGRITY,
          name: "@acme/widget",
          version: "1.2.3",
        }),
      )
      .digest("hex")}`;
    expect(result.observationDigest).toBe(
      upstreamObservationReceiptDigestV1({
        format: "aih-upstream-observation-receipt",
        version: 1,
        id: "observation-npm-package",
        decision: {
          id: value.decision.id,
          digest: governanceDecisionDigestV2(value.decision as never),
        },
        subject: {
          kind: value.decision.subject.kind,
          id: value.decision.subject.id,
          sourceDigest: value.decision.subject.sourceDigest,
          subjectDigest: value.decision.subject.subjectDigest,
        },
        targets: ["claude"],
        allowedEffects: ["install"],
        integration: { mode: "upstream-managed", owner: "npm-package-observer", version: "1.0.0" },
        installed: { id: "npm-package", digest: installedDigest },
        verifier: { id: "npm-package-observer", version: "1.0.0", digest: verifierDigest },
        observedAt: "2026-08-02T12:00:00.000Z",
        validUntil: "2026-08-03T12:00:00.000Z",
        outcome: "observed-success",
      }),
    );
    const later = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "codex",
          evidence: "evidence.json",
        },
        calls,
      ),
    );
    expect(later).toMatchObject({ outcome: "observed-effective" });
    expect(later.observationDigest).not.toBe(result.observationDigest);
    vi.setSystemTime(new Date("2026-08-02T12:01:00+00:00"));
    const observedLater = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
          evidence: "evidence.json",
        },
        calls,
      ),
    );
    expect(observedLater).toMatchObject({ outcome: "observed-effective" });
    expect(observedLater.observationDigest).not.toBe(result.observationDigest);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.slice(1, 3)).toEqual(["attestation", "verify"]);
    expect(readFileSync(join(root, "package-lock.json"))).toEqual(before.get("lock"));
    expect(readFileSync(join(root, "node_modules", "@acme", "widget", "package.json"))).toEqual(
      before.get("manifest"),
    );
  });

  it("caps the sealed observation validity at the organization evidence expiry", async () => {
    const value = fixture();
    value.evidence.expiresAt = "2026-08-02T12:00:30+00:00";
    value.evidenceBytes = Buffer.from(canonicalOrganizationEvidenceEnvelopeV1(value.evidence));
    const evidenceDigest = organizationEvidenceEnvelopeDigestV1(value.evidence);
    value.decision = {
      ...value.decision,
      qualificationBasis: {
        kind: "organization-qualified",
        evidenceDigest,
        attestor: value.evidence.attestor,
      },
      evidence: {
        id: value.evidence.evidence.id,
        digest: evidenceDigest,
        attestor: value.evidence.attestor,
      },
    };
    writeAuthority(value.decision);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    const result = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision),
          target: "claude",
          evidence: "evidence.json",
        },
        [],
      ),
    );
    expect(result).toMatchObject({ outcome: "observed-effective" });
    expect(npmPackageObservationHandoffForLifecycleV1(result)?.receipt.validUntil).toBe(
      "2026-08-02T12:00:30.000Z",
    );
  });

  it("runs through runCapability as a zero-write JSON observation with exactly one attestation process", async () => {
    const value = fixture();
    writeAuthority(value.decision);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    const beforeLock = readFileSync(join(root, "package-lock.json"));
    const beforeManifest = readFileSync(
      join(root, "node_modules", "@acme", "widget", "package.json"),
    );
    const calls: string[][] = [];
    let out = "";
    const beforeTree = treeSnapshot(root);

    const code = await runCapability(
      npmPackageObserveCommand,
      command([
        "--json",
        "--root",
        root,
        "--decision",
        value.decision.id,
        "--decision-digest",
        governanceDecisionDigestV2(value.decision as never),
        "--target",
        "claude",
        "--evidence",
        "evidence.json",
      ]),
      {
        env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
        run: fakeRunner((argv) => {
          calls.push([...argv]);
          return argv[0] === gh ? { code: 0 } : { code: 1 };
        }),
        write: (text) => {
          out += text;
        },
      },
    );

    const payload = JSON.parse(out) as {
      applied: boolean;
      execs: unknown[];
      writes: unknown[];
      digests: Array<{ data?: { outcome?: string } }>;
    };
    expect(code).toBe(0);
    expect(payload).toMatchObject({ applied: false, execs: [], writes: [] });
    expect(payload.digests[0]?.data).toMatchObject({ outcome: "observed-effective" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual([gh, "attestation", "verify"]);
    expect(calls[0]?.slice(-2)).toEqual(["--repo", "acme/governance"]);
    expect(readFileSync(join(root, "package-lock.json"))).toEqual(beforeLock);
    expect(readFileSync(join(root, "node_modules", "@acme", "widget", "package.json"))).toEqual(
      beforeManifest,
    );
    expect(existsSync(join(root, ".aih", "run-log.jsonl"))).toBe(false);
    expect(treeSnapshot(root)).toEqual(beforeTree);
  });

  it("emits a deterministic scrubbed zero-write partial JSON result", async () => {
    const value = fixture();
    writeAuthority(value.decision);
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    const argv = [
      "--json",
      "--root",
      root,
      "--decision",
      value.decision.id,
      "--decision-digest",
      governanceDecisionDigestV2(value.decision as never),
      "--target",
      "claude",
      "--evidence",
      "evidence.json",
    ];
    const beforeTree = treeSnapshot(root);
    const invoke = async () => {
      let out = "";
      const code = await runCapability(npmPackageObserveCommand, command(argv), {
        env: {
          AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance",
          PATH: bin,
          SECRET: "do-not-leak",
        },
        run: fakeRunner((child) => (child[0] === gh ? { code: 0 } : { code: 1 })),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
        newRunId: () => "run_observer",
        write: (text) => {
          out += text;
        },
      });
      return { code, out };
    };
    const first = await invoke();
    const second = await invoke();
    expect(first.code).toBe(1);
    expect(second).toEqual(first);
    expect(first.out).not.toContain(root);
    expect(first.out).not.toContain(gh);
    expect(first.out).not.toContain("do-not-leak");
    expect(JSON.parse(first.out)).toMatchObject({ writes: [], execs: [] });
    expect(existsSync(join(root, ".aih", "run-log.jsonl"))).toBe(false);
    expect(treeSnapshot(root)).toEqual(beforeTree);
  });

  it("scrubs hostile attestation stderr from a zero-write refusal JSON result", async () => {
    const value = fixture();
    writeAuthority(value.decision);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    const beforeTree = treeSnapshot(root);
    let out = "";
    const code = await runCapability(
      npmPackageObserveCommand,
      command([
        "--json",
        "--root",
        root,
        "--decision",
        value.decision.id,
        "--decision-digest",
        governanceDecisionDigestV2(value.decision as never),
        "--target",
        "claude",
        "--evidence",
        "evidence.json",
      ]),
      {
        env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
        run: fakeRunner((child) =>
          child[0] === gh ? { code: 1, stderr: `${root} token=do-not-leak` } : { code: 1 },
        ),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
        newRunId: () => "run_observer",
        write: (text) => {
          out += text;
        },
      },
    );
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ writes: [], execs: [] });
    expect(out).not.toContain(root);
    expect(out).not.toContain("do-not-leak");
    expect(treeSnapshot(root)).toEqual(beforeTree);
  });

  it("evaluates the observer plan once when its digest and probe are both consumed", async () => {
    const value = fixture();
    writeAuthority(value.decision);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    const calls: string[][] = [];
    const ctx = context(
      {
        decision: value.decision.id,
        decisionDigest: governanceDecisionDigestV2(value.decision as never),
        target: "claude",
        evidence: "evidence.json",
      },
      calls,
    );
    const actions = npmPackageObservePlan(ctx).actions;
    const digest = actions.find((action) => action.kind === "digest");
    const probe = actions.find((action) => action.kind === "probe");
    if (digest?.kind !== "digest" || probe?.kind !== "probe")
      throw new Error("expected observer digest and probe");

    await digest.run?.(ctx);
    await probe.run(ctx);

    expect(calls).toHaveLength(1);
  });

  it("keeps observer authority out of the public package and CLI option surface", () => {
    const publicIndex = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    const packageExports = JSON.stringify(
      JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).exports,
    );
    for (const forbidden of ["npm-package-observer", "observeNpmPackage", "InternalTestHook"]) {
      expect(publicIndex).not.toContain(forbidden);
      expect(packageExports).not.toContain(forbidden);
    }
    const flags = npmPackageObserveCommand.options?.map((option) => option.flags).join(" ") ?? "";
    for (const forbidden of [
      "package",
      "effect",
      "observer",
      "verifier",
      "config",
      "runner",
      "clock",
      "receipt",
      "callback",
    ]) {
      expect(flags).not.toContain(`--${forbidden}`);
    }
  });

  it("refuses lock or manifest identity disagreement without another process", async () => {
    const value = fixture();
    writeAuthority(value.decision);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    writeFileSync(
      join(root, "node_modules", "@acme", "widget", "package.json"),
      JSON.stringify({ name: "@acme/widget", version: "9.9.9" }),
    );
    const calls: string[][] = [];

    const result = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
          evidence: "evidence.json",
        },
        calls,
      ),
    );

    expect(result).toMatchObject({ outcome: "refused", reason: "installed-identity-mismatch" });
    expect(calls).toHaveLength(1);
  });

  it("closes future or stale authority and future, rejected, revoked, scoped, or review-expired decisions", async () => {
    const value = fixture();
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    const options = {
      decision: value.decision.id,
      decisionDigest: governanceDecisionDigestV2(value.decision as never),
      target: "claude",
      evidence: "evidence.json",
    };

    writeAuthority(value.decision, { issuedAt: "2026-08-02T12:00:01+00:00" });
    expect(await observeNpmPackageV1(context(options, []))).toMatchObject({
      outcome: "refused",
      reason: "authority-unverified",
    });

    writeAuthority(value.decision, { expiresAt: "2026-08-02T12:00:00+00:00" });
    expect(await observeNpmPackageV1(context(options, []))).toMatchObject({
      outcome: "refused",
      reason: "authority-unverified",
    });

    const future = { ...value.decision, notBefore: "2026-08-02T12:00:01+00:00" };
    writeAuthority(future);
    expect(
      await observeNpmPackageV1(
        context({ ...options, decisionDigest: governanceDecisionDigestV2(future as never) }, []),
      ),
    ).toMatchObject({ outcome: "refused", reason: "decision-not-current" });

    const rejected = { ...value.decision, disposition: "rejected" as const };
    writeAuthority(rejected as never);
    expect(
      await observeNpmPackageV1(
        context({ ...options, decisionDigest: governanceDecisionDigestV2(rejected as never) }, []),
      ),
    ).toMatchObject({ outcome: "refused", reason: "decision-rejected" });

    writeAuthority(value.decision, {
      issuedAt: "2026-08-02T12:00:00+00:00",
      decisionRevocations: [
        {
          format: "aih-governance-decision-revocation",
          version: 2,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          issuer: "platform-security",
          revokedAt: "2026-08-02T12:00:00+00:00",
          reason: "The decision was revoked after review.",
        },
      ],
    });
    expect(await observeNpmPackageV1(context(options, []))).toMatchObject({
      outcome: "refused",
      reason: "decision-revoked",
    });

    const scoped = { ...value.decision, targets: ["codex"] };
    writeAuthority(scoped, { targets: ["codex"] });
    expect(
      await observeNpmPackageV1(
        context({ ...options, decisionDigest: governanceDecisionDigestV2(scoped as never) }, []),
      ),
    ).toMatchObject({ outcome: "refused", reason: "decision-scope-mismatch" });

    const reviewExpired = {
      ...value.decision,
      disposition: "accepted-with-conditions" as const,
      acceptedFindings: ["residual-risk"],
      conditions: ["Re-review before the stated deadline."],
      reviewBy: "2026-08-02T11:59:59+00:00",
    };
    writeAuthority(reviewExpired as never);
    expect(
      await observeNpmPackageV1(
        context(
          { ...options, decisionDigest: governanceDecisionDigestV2(reviewExpired as never) },
          [],
        ),
      ),
    ).toMatchObject({ outcome: "refused", reason: "decision-not-current" });
  });

  it("keeps a proven qualification truthful when fixed installed evidence is absent", async () => {
    const value = fixture();
    writeAuthority(value.decision);
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    const calls: string[][] = [];
    const result = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
          evidence: "evidence.json",
        },
        calls,
      ),
    );
    expect(result).toMatchObject({
      authority: "verified",
      qualification: "qualified",
      effective: "observation-missing",
      outcome: "partial",
      reason: "installed-evidence-unavailable",
    });
    expect(calls).toHaveLength(1);
  });

  it("does not report a qualified partial after the unavailable observation crosses a decision window", async () => {
    const value = fixture();
    value.decision.expiresAt = "2026-08-03T00:00:00+00:00";
    writeAuthority(value.decision);
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    __setNpmPackageObserverInternalTestHookV1(() => {
      vi.setSystemTime(new Date("2026-08-03T00:00:00+00:00"));
    });

    const result = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
          evidence: "evidence.json",
        },
        [],
      ),
    );

    expect(result).toMatchObject({
      authority: "verified",
      qualification: "unqualified",
      outcome: "refused",
      reason: "decision-not-current",
    });
  });

  it("rechecks organization evidence after installed observation before minting a receipt", async () => {
    const value = fixture();
    writeAuthority(value.decision);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    __setNpmPackageObserverInternalTestHookV1(() => {
      writeFileSync(
        join(root, "evidence.json"),
        Buffer.concat([value.evidenceBytes, Buffer.from("\n")]),
      );
    });

    const result = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
          evidence: "evidence.json",
        },
        [],
      ),
    );

    expect(result).toMatchObject({
      authority: "verified",
      qualification: "qualified",
      outcome: "refused",
      reason: "evidence-changed",
    });
  });

  it("refuses a lock-or-manifest swap after qualification without erasing the qualified phase", async () => {
    const value = fixture();
    writeAuthority(value.decision);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    __setNpmPackageObserverInternalTestHookV1(() => {
      writeFileSync(
        join(root, "node_modules", "@acme", "widget", "package.json"),
        JSON.stringify({ name: "@acme/widget", version: "9.9.9" }),
      );
    });

    const result = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
          evidence: "evidence.json",
        },
        [],
      ),
    );

    expect(result).toMatchObject({
      authority: "verified",
      qualification: "qualified",
      outcome: "refused",
      reason: "installed-evidence-changed",
    });
  });

  it("takes a fresh time after installed observation and refuses an expired decision", async () => {
    const value = fixture();
    value.decision.expiresAt = "2026-08-03T00:00:00+00:00";
    writeAuthority(value.decision);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    __setNpmPackageObserverInternalTestHookV1(() => {
      vi.setSystemTime(new Date("2026-08-03T00:00:00+00:00"));
    });

    const result = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
          evidence: "evidence.json",
        },
        [],
      ),
    );

    expect(result).toMatchObject({ outcome: "refused", reason: "decision-not-current" });
  });

  it.each(["installed-present", "installed-unavailable"])(
    "refuses when authority expires during %s observation",
    async (mode) => {
      const value = fixture();
      // A receipt may not outlive any embedded decision; matching expiry keeps
      // the fixture schema-valid while the resolver still reports authority first.
      value.decision.expiresAt = "2026-08-02T12:00:30.000Z";
      writeAuthority(value.decision, { expiresAt: "2026-08-02T12:00:30.000Z" });
      if (mode === "installed-present") writeInstalledPackage();
      writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
      __setNpmPackageObserverInternalTestHookV1(() => {
        vi.setSystemTime(new Date("2026-08-02T12:00:30.000Z"));
      });

      const result = await observeNpmPackageV1(
        context(
          {
            decision: value.decision.id,
            decisionDigest: governanceDecisionDigestV2(value.decision as never),
            target: "claude",
            evidence: "evidence.json",
          },
          [],
        ),
      );

      expect(result).toMatchObject({
        authority: "verified",
        qualification: "unqualified",
        outcome: "refused",
        effective: "authority-not-current",
        reason: "authority-not-current",
      });
    },
  );

  it("caps an accepted-with-conditions observation at reviewBy", async () => {
    const value = fixture();
    const conditional = {
      ...value.decision,
      disposition: "accepted-with-conditions" as const,
      acceptedFindings: ["residual-risk"],
      conditions: ["Re-review before the stated deadline."],
      reviewBy: "2026-08-02T12:00:30.000Z",
    };
    writeAuthority(conditional as never);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    const result = await observeNpmPackageV1(
      context(
        {
          decision: conditional.id,
          decisionDigest: governanceDecisionDigestV2(conditional as never),
          target: "claude",
          evidence: "evidence.json",
        },
        [],
      ),
    );
    const digest = (value: unknown) =>
      `sha256:${createHash("sha256").update(canonicalStrictJsonBytesV1(value)).digest("hex")}`;
    const verifier = `sha256:${createHash("sha256")
      .update("aih-npm-package-observer/v1\0", "utf8")
      .update(
        canonicalStrictJsonBytesV1({
          format: "aih-npm-package-observer",
          version: 1,
          effect: "install",
          lockfileVersion: 3,
        }),
      )
      .digest("hex")}`;
    expect(result.observationDigest).toBe(
      upstreamObservationReceiptDigestV1({
        format: "aih-upstream-observation-receipt",
        version: 1,
        id: "observation-npm-package",
        decision: { id: conditional.id, digest: governanceDecisionDigestV2(conditional as never) },
        subject: {
          kind: conditional.subject.kind,
          id: conditional.subject.id,
          sourceDigest: conditional.subject.sourceDigest,
          subjectDigest: conditional.subject.subjectDigest,
        },
        targets: ["claude"],
        allowedEffects: ["install"],
        integration: { mode: "upstream-managed", owner: "npm-package-observer", version: "1.0.0" },
        installed: {
          id: "npm-package",
          digest: digest({ integrity: INTEGRITY, name: "@acme/widget", version: "1.2.3" }),
        },
        verifier: { id: "npm-package-observer", version: "1.0.0", digest: verifier },
        observedAt: "2026-08-02T12:00:00.000Z",
        validUntil: conditional.reviewBy,
        outcome: "observed-success",
      }),
    );
  });

  it("rejects a duplicate lock key before it can provide an installed identity", async () => {
    const value = fixture();
    writeAuthority(value.decision);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    writeFileSync(
      join(root, "package-lock.json"),
      `{"lockfileVersion":3,"packages":{"node_modules/@acme/widget":{"version":"1.2.3","integrity":"${INTEGRITY}"},"node_modules/@acme/widget":{"version":"1.2.3","integrity":"${INTEGRITY}"}}}`,
    );
    const calls: string[][] = [];
    const result = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
          evidence: "evidence.json",
        },
        calls,
      ),
    );
    expect(result).toMatchObject({ outcome: "refused", reason: "installed-identity-mismatch" });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["a malformed lock", "package-lock.json", "{not-json"],
    ["a malformed installed manifest", "node_modules/@acme/widget/package.json", "{not-json"],
    [
      "a duplicate installed manifest key",
      "node_modules/@acme/widget/package.json",
      '{"name":"@acme/widget","name":"@acme/widget","version":"1.2.3"}',
    ],
    [
      "a non-NFC exact package name",
      "node_modules/@acme/widget/package.json",
      JSON.stringify({ name: "@acme/widge\u0301t", version: "1.2.3" }),
    ],
    [
      "a non-NFC lock package key",
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/@acme/widge\u0301t": { version: "1.2.3", integrity: INTEGRITY },
        },
      }),
    ],
  ])("refuses %s", async (_label, path, contents) => {
    const value = fixture();
    writeAuthority(value.decision);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    writeFileSync(join(root, path), contents);

    const result = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
          evidence: "evidence.json",
        },
        [],
      ),
    );

    expect(result).toMatchObject({ outcome: "refused", reason: "installed-identity-mismatch" });
  });

  it.each([
    ["the package lock file", "package-lock.json", "file" as const],
    ["the installed manifest file", "node_modules/@acme/widget/package.json", "file" as const],
    ["the node_modules parent", "node_modules", "dir" as const],
    ["the scoped-package parent", "node_modules/@acme", "dir" as const],
  ])("refuses linked custody through %s after qualification", async (_label, linked, kind) => {
    if (process.platform === "win32" && kind === "file") return;
    const value = fixture();
    writeAuthority(value.decision);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    const target = mkdtempSync(join(tmpdir(), "aih-npm-observer-linked-"));
    const linkedPath = join(root, linked);
    try {
      if (kind === "file") {
        writeFileSync(join(target, "artifact.json"), readFileSync(linkedPath));
        rmSync(linkedPath);
        symlinkSync(join(target, "artifact.json"), linkedPath, "file");
      } else {
        const source =
          linked === "node_modules"
            ? join(root, "node_modules")
            : join(root, "node_modules", "@acme");
        const destination = join(target, "linked");
        mkdirSync(destination, { recursive: true });
        if (linked === "node_modules") {
          mkdirSync(join(destination, "@acme", "widget"), { recursive: true });
          writeFileSync(
            join(destination, "@acme", "widget", "package.json"),
            readFileSync(join(source, "@acme", "widget", "package.json")),
          );
        } else {
          mkdirSync(join(destination, "widget"), { recursive: true });
          writeFileSync(
            join(destination, "widget", "package.json"),
            readFileSync(join(source, "widget", "package.json")),
          );
        }
        rmSync(source, { recursive: true });
        symlinkSync(destination, source, process.platform === "win32" ? "junction" : "dir");
      }
      const calls: string[][] = [];
      const result = await observeNpmPackageV1(
        context(
          {
            decision: value.decision.id,
            decisionDigest: governanceDecisionDigestV2(value.decision as never),
            target: "claude",
            evidence: "evidence.json",
          },
          calls,
        ),
      );
      expect(result).toMatchObject({
        authority: "verified",
        qualification: "qualified",
        outcome: "refused",
        reason: "installed-evidence-unsafe",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.slice(1, 3)).toEqual(["attestation", "verify"]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  // This intentionally reads and parses the real maximum twice; slow CI disks need more than Vitest's 5s default.
  it("accepts the exact 16 MiB lock boundary and treats one extra byte as unavailable", async () => {
    const value = fixture();
    writeAuthority(value.decision);
    writeInstalledPackage();
    writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
    const lockPath = join(root, "package-lock.json");
    const compact = readFileSync(lockPath);
    const exact = Buffer.concat([compact, Buffer.alloc(16 * 1024 * 1024 - compact.length, 0x20)]);
    writeFileSync(lockPath, exact);

    const exactResult = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
          evidence: "evidence.json",
        },
        [],
      ),
    );
    expect(exactResult.outcome).toBe("observed-effective");

    writeFileSync(lockPath, Buffer.concat([exact, Buffer.from(" ")]));
    const oversizeResult = await observeNpmPackageV1(
      context(
        {
          decision: value.decision.id,
          decisionDigest: governanceDecisionDigestV2(value.decision as never),
          target: "claude",
          evidence: "evidence.json",
        },
        [],
      ),
    );
    expect(oversizeResult).toMatchObject({
      authority: "verified",
      qualification: "qualified",
      outcome: "partial",
      reason: "installed-evidence-unavailable",
    });
  }, 20_000);

  it.each([true, false, "true"])(
    "rejects a lock link marker (%j) rather than treating it as installed package evidence",
    async (link) => {
      const value = fixture();
      writeAuthority(value.decision);
      writeInstalledPackage();
      writeFileSync(join(root, "evidence.json"), value.evidenceBytes);
      writeFileSync(
        join(root, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/@acme/widget": { version: "1.2.3", integrity: INTEGRITY, link },
          },
        }),
      );

      const result = await observeNpmPackageV1(
        context(
          {
            decision: value.decision.id,
            decisionDigest: governanceDecisionDigestV2(value.decision as never),
            target: "claude",
            evidence: "evidence.json",
          },
          [],
        ),
      );

      expect(result).toMatchObject({ outcome: "refused", reason: "installed-identity-mismatch" });
    },
  );
});
