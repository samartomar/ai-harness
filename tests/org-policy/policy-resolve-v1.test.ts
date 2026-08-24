import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { SUPPORTED_CLIS } from "../../src/internals/clis.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { isContainedEvidenceRelativePathV1 } from "../../src/org-policy/evidence-custody-v1.js";
import {
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../src/org-policy/governance-decision-v2.js";
import {
  policyResolveCommand,
  policyResolvePlan,
  resolvePolicyEvidenceV1,
} from "../../src/org-policy/policy-resolve-v1.js";
import {
  canonicalOrganizationEvidenceEnvelopeV1,
  organizationEvidenceEnvelopeDigestV1,
} from "../../src/org-policy/qualification-v1.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let root: string;
let bin: string;
let gh: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-02T12:00:00+00:00"));
  root = mkdtempSync(join(tmpdir(), "aih-policy-resolve-"));
  bin = mkdtempSync(join(tmpdir(), "aih-policy-resolve-gh-"));
  const executable = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(executable, "trusted gh fixture\n", { mode: 0o755 });
  gh = realpathSync.native(executable);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

function decision() {
  const source = {
    type: "github" as const,
    repository: "acme/review-tool",
    commit: "a".repeat(40),
    path: "tool.json",
  };
  const sourceDigest = governanceDecisionSourceDigestV2(source);
  const subject = {
    kind: "tool" as const,
    id: "platform-review-tool",
    source,
    sourceDigest,
    subjectDigest: governanceDecisionSubjectDigestV2({
      kind: "tool",
      id: "platform-review-tool",
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
      summary: "The named organization assessment approved this exact subject.",
      payloadDigest: `sha256:${"1".repeat(64)}`,
      artifactDigests: [`sha256:${"2".repeat(64)}`],
    },
    attestor: "scanner-service",
    issuedAt: "2026-08-01T00:00:00+00:00",
    notBefore: "2026-08-01T00:00:00+00:00",
    expiresAt: "2026-08-05T00:00:00+00:00",
  };
  const evidenceDigest = organizationEvidenceEnvelopeDigestV1(evidence);
  return {
    value: {
      format: "aih-governance-decision" as const,
      version: 2 as const,
      id: "decision-platform-tool",
      qualificationBasis: {
        kind: "organization-qualified" as const,
        evidenceDigest,
        attestor: "scanner-service",
      },
      subject,
      targets: ["claude"],
      allowedEffects: ["configure"],
      policy: { id: "platform-policy", version: "2026.08", digest: `sha256:${"c".repeat(64)}` },
      control: { id: "review-control", digest: `sha256:${"d".repeat(64)}` },
      evidence: { id: "scan-record", digest: evidenceDigest, attestor: "scanner-service" },
      issuer: "platform-security",
      actor: "security-admin",
      reason: "The exact pinned subject passed the reviewed control.",
      issuedAt: "2026-08-01T00:00:00+00:00",
      notBefore: "2026-08-01T00:00:00+00:00",
      expiresAt: "2026-08-10T00:00:00+00:00",
      disposition: "approved" as const,
      acceptedFindings: [],
      acceptedGaps: [],
      conditions: [],
    },
    evidence,
    bytes: Buffer.from(canonicalOrganizationEvidenceEnvelopeV1(evidence), "utf8"),
  };
}

function context(
  options: Record<string, unknown>,
  calls: string[][],
  duringAuthorityVerification?: () => void,
  authorityExitCode = 0,
): PlanContext {
  const run = fakeRunner((argv) => {
    calls.push(argv);
    duringAuthorityVerification?.();
    return argv[0] === gh ? { code: authorityExitCode } : { code: 1 };
  });
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: false,
    verify: true,
    json: true,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
    options,
  };
}

function writeAuthority(
  value: ReturnType<typeof decision>["value"],
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
      targets: ["claude"],
      decisions: [value],
      decisionRevocations: [],
      ...overrides,
    }),
  );
}

function writeV2Authority(): void {
  mkdirSync(join(root, ".aih"), { recursive: true });
  writeFileSync(
    join(root, ".aih", "policy-authority-receipt.json"),
    JSON.stringify({
      format: "aih-policy-authority-receipt",
      version: 2,
      issuerRepository: "acme/governance",
      issuedAt: "2026-08-01T00:00:00+00:00",
      expiresAt: "2026-08-10T00:00:00+00:00",
      trustedIssuers: [],
      evidence: [],
      approvals: [],
      revocations: [],
      targets: ["claude"],
      decisions: [],
      decisionRevocations: [],
    }),
  );
}

function command(argv: string[]): Command {
  const value = new Command("resolve");
  value.argument("[root]").option("--json").option("--root <dir>").option("--context-dir <dir>");
  for (const option of policyResolveCommand.options ?? []) value.option(option.flags);
  value.parse(argv, { from: "user" });
  return value;
}

describe("policy resolve V1", () => {
  it("constructs only read-only digest and verification actions", () => {
    const calls: string[][] = [];
    expect(policyResolveCommand.readOnly).toBe(true);
    expect(policyResolveCommand.zeroWrite).toBe(true);
    expect(policyResolvePlan(context({}, calls)).actions.map((action) => action.kind)).toEqual([
      "digest",
      "probe",
    ]);
    expect(calls).toEqual([]);
  });

  it("uses V3 authority plus canonical custodied organization evidence and reports observation-missing as a non-effective partial", async () => {
    const fixture = decision();
    writeAuthority(fixture.value);
    writeFileSync(join(root, "evidence.json"), fixture.bytes);
    const calls: string[][] = [];

    const result = await resolvePolicyEvidenceV1(
      context(
        {
          decision: fixture.value.id,
          decisionDigest: governanceDecisionDigestV2(fixture.value as never),
          target: "claude",
          effect: "configure",
          evidence: "evidence.json",
        },
        calls,
      ),
    );

    expect(result).toMatchObject({
      authority: "verified",
      qualification: "organization-qualified",
      observation: "missing",
      effective: "observation-missing",
      outcome: "partial",
      reason: "observation-missing",
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses an externally verified V2 authority receipt with the closed V3-only reason", async () => {
    const fixture = decision();
    writeV2Authority();
    writeFileSync(join(root, "evidence.json"), fixture.bytes);
    const calls: string[][] = [];

    const result = await resolvePolicyEvidenceV1(
      context(
        {
          decision: fixture.value.id,
          decisionDigest: governanceDecisionDigestV2(fixture.value as never),
          target: "claude",
          effect: "configure",
          evidence: "evidence.json",
        },
        calls,
      ),
    );

    expect(result).toMatchObject({
      authority: "unverified",
      qualification: "unqualified",
      effective: "authority-version",
      outcome: "refused",
      reason: "authority-version",
    });
    expect(calls).toHaveLength(1);
  });

  it("runs through the actual command runner as JSON with a nonzero partial outcome and no writes", async () => {
    const fixture = decision();
    writeAuthority(fixture.value);
    writeFileSync(join(root, "evidence.json"), fixture.bytes);
    const before = new Map([
      ["authority", Buffer.from(readFileSync(join(root, ".aih", "policy-authority-receipt.json")))],
      ["evidence", Buffer.from(readFileSync(join(root, "evidence.json")))],
    ]);
    let output = "";
    const run = fakeRunner((argv) => (argv[0] === gh ? { code: 0 } : { code: 1 }));
    const code = await runCapability(
      policyResolveCommand,
      command([
        root,
        "--json",
        "--decision",
        fixture.value.id,
        "--decision-digest",
        governanceDecisionDigestV2(fixture.value as never),
        "--target",
        "claude",
        "--effect",
        "configure",
        "--evidence",
        "evidence.json",
      ]),
      {
        env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
        run,
        write: (text) => {
          output += text;
        },
      },
    );
    const payload = JSON.parse(output) as {
      digests: Array<{ data: { qualification: string; reason: string; outcome: string } }>;
      report: { checks: Array<{ detail?: string }> };
      support: { findings: Array<{ code: string; recommendedAction: string }> };
    };
    expect(code).toBe(1);
    expect(payload.digests[0]?.data).toMatchObject({
      qualification: "organization-qualified",
      reason: "observation-missing",
      outcome: "partial",
    });
    expect(payload.report.checks[0]?.detail).toBe(
      "policy resolve observation-missing (observation-missing)",
    );
    expect(payload.support.findings[0]).toMatchObject({
      code: "org-policy.resolve-observation-missing",
      audience: "dev-platform",
      kind: "escalation",
      recommendedAction:
        "Please arrange for the upstream-managed observer to publish a current observation bound to the referenced V3 decision, subject, target, and effect, then ask the operator to rerun the verification.",
    });
    expect(payload.support.findings[0]?.recommendedAction).not.toContain("policy evaluate");
    expect(payload.support.findings[0]?.recommendedAction).not.toContain("policy project");
    expect(readFileSync(join(root, ".aih", "policy-authority-receipt.json"))).toEqual(
      before.get("authority"),
    );
    expect(readFileSync(join(root, "evidence.json"))).toEqual(before.get("evidence"));
  });

  it("routes invalid command inputs and local evidence custody to their own actual JSON support actions", async () => {
    const validOptions = [
      "--decision",
      "decision-platform-tool",
      "--decision-digest",
      `sha256:${"0".repeat(64)}`,
      "--target",
      "claude",
      "--effect",
      "configure",
    ];
    const cases = [
      {
        name: "invalid-input",
        args: [root, "--json"],
        reason: "invalid-input",
        code: "org-policy.resolve-input-invalid",
        action:
          "Correct the required `aih policy resolve` command option(s): decision id/digest, supported target, effect, and bounded root-relative evidence path. Rerun only after supplying valid values.",
      },
      {
        name: "invalid-evidence-path",
        args: [...validOptions, "--evidence", "../escape.json", root, "--json"],
        reason: "invalid-evidence-path",
        code: "org-policy.resolve-input-invalid",
        action:
          "Correct the required `aih policy resolve` command option(s): decision id/digest, supported target, effect, and bounded root-relative evidence path. Rerun only after supplying valid values.",
      },
      {
        name: "evidence-unavailable",
        args: [...validOptions, "--evidence", "missing.json", root, "--json"],
        reason: "evidence-unavailable",
        code: "org-policy.resolve-evidence-invalid",
        action:
          "Fix or select a bounded, regular, non-linked root-relative local evidence file under the target root, then rerun `aih policy resolve` with that file.",
      },
    ];

    for (const testCase of cases) {
      let output = "";
      const calls: string[][] = [];
      const code = await runCapability(policyResolveCommand, command(testCase.args), {
        env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
        run: fakeRunner((argv) => {
          calls.push(argv);
          return { code: 1 };
        }),
        write: (text) => {
          output += text;
        },
      });
      const payload = JSON.parse(output) as {
        digests: Array<{ data: { reason: string } }>;
        support: {
          findings: Array<{
            code: string;
            audience: string;
            kind: string;
            recommendedAction: string;
          }>;
        };
      };

      expect(code, testCase.name).toBe(1);
      expect(payload.digests[0]?.data.reason, testCase.name).toBe(testCase.reason);
      expect(payload.support.findings[0]?.code, testCase.name).toBe(testCase.code);
      expect(payload.support.findings[0]?.audience, testCase.name).toBe("developer");
      expect(payload.support.findings[0]?.kind, testCase.name).toBe("self-fix");
      expect(payload.support.findings[0]?.recommendedAction, testCase.name).toBe(testCase.action);
      expect(calls, testCase.name).toEqual([]);
    }

    const outside = mkdtempSync(join(tmpdir(), "aih-policy-resolve-support-outside-"));
    try {
      writeFileSync(join(outside, "evidence.json"), "{}");
      symlinkSync(outside, join(root, "sub"), "junction");
      let output = "";
      const calls: string[][] = [];
      const code = await runCapability(
        policyResolveCommand,
        command([...validOptions, "--evidence", "sub/evidence.json", root, "--json"]),
        {
          env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
          run: fakeRunner((argv) => {
            calls.push(argv);
            return { code: 1 };
          }),
          write: (text) => {
            output += text;
          },
        },
      );
      const payload = JSON.parse(output) as {
        digests: Array<{ data: { reason: string } }>;
        support: { findings: Array<{ code: string; recommendedAction: string }> };
      };

      expect(code).toBe(1);
      expect(payload.digests[0]?.data.reason).toBe("unsafe-evidence-custody");
      expect(payload.support.findings[0]).toMatchObject({
        code: "org-policy.resolve-evidence-invalid",
        recommendedAction:
          "Fix or select a bounded, regular, non-linked root-relative local evidence file under the target root, then rerun `aih policy resolve` with that file.",
      });
      expect(calls).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("scrubs a failed GitHub verifier from command JSON while returning a closed authority reason", async () => {
    const fixture = decision();
    writeAuthority(fixture.value);
    writeFileSync(join(root, "evidence.json"), fixture.bytes);
    let output = "";
    const code = await runCapability(
      policyResolveCommand,
      command([
        root,
        "--json",
        "--decision",
        fixture.value.id,
        "--decision-digest",
        governanceDecisionDigestV2(fixture.value as never),
        "--target",
        "claude",
        "--effect",
        "configure",
        "--evidence",
        "evidence.json",
      ]),
      {
        env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
        run: fakeRunner((argv) =>
          argv[0] === gh ? { code: 1, stderr: "verifier-private-detail" } : { code: 1 },
        ),
        write: (text) => {
          output += text;
        },
      },
    );
    expect(code).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      digests: [{ data: { reason: "authority-unverified", outcome: "refused" } }],
      support: {
        findings: [
          {
            code: "org-policy.resolve-authority-blocked",
            audience: "dev-platform",
            kind: "escalation",
          },
        ],
      },
    });
    expect(
      (JSON.parse(output) as { support: { findings: Array<{ recommendedAction: string }> } })
        .support.findings[0]?.recommendedAction,
    ).toContain("Correct malformed, stale, or mismatched artifacts only.");
    expect(output).not.toContain("verifier-private-detail");
    expect(output).not.toContain(root);
  });

  it("escalates a verified rejected decision without suggesting governance be changed merely to pass", async () => {
    const fixture = decision();
    const rejected = { ...fixture.value, disposition: "rejected" as const };
    writeAuthority(rejected as never);
    writeFileSync(join(root, "evidence.json"), fixture.bytes);
    let output = "";
    const code = await runCapability(
      policyResolveCommand,
      command([
        root,
        "--json",
        "--decision",
        rejected.id,
        "--decision-digest",
        governanceDecisionDigestV2(rejected as never),
        "--target",
        "claude",
        "--effect",
        "configure",
        "--evidence",
        "evidence.json",
      ]),
      {
        env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
        run: fakeRunner((argv) => (argv[0] === gh ? { code: 0 } : { code: 1 })),
        write: (text) => {
          output += text;
        },
      },
    );
    const payload = JSON.parse(output) as {
      digests: Array<{ data: { reason: string } }>;
      support: {
        findings: Array<{
          code: string;
          audience: string;
          kind: string;
          recommendedAction: string;
        }>;
      };
    };

    expect(code).toBe(1);
    expect(payload.digests[0]?.data.reason).toBe("decision-rejected");
    expect(payload.support.findings[0]).toMatchObject({
      code: "org-policy.resolve-authority-blocked",
      audience: "dev-platform",
      kind: "escalation",
    });
    expect(payload.support.findings[0]?.recommendedAction).toContain(
      "Rejected or revoked decisions must remain closed and must not be altered merely to clear this check",
    );
  });

  it("refuses invalid root-relative evidence before calling the authority verifier", async () => {
    const calls: string[][] = [];
    const result = await resolvePolicyEvidenceV1(
      context(
        {
          decision: "decision-platform-tool",
          decisionDigest: `sha256:${"0".repeat(64)}`,
          target: "claude",
          effect: "configure",
          evidence: "../escape.json",
        },
        calls,
      ),
    );

    expect(result).toMatchObject({
      authority: "unverified",
      qualification: "unqualified",
      outcome: "refused",
      reason: "invalid-evidence-path",
    });
    expect(calls).toEqual([]);
  });

  it.each(["C:evidence.json", "D:evidence.json", "/evidence.json", "//server/share/evidence.json"])(
    "refuses hostile platform path %s before calling the authority verifier",
    async (evidence) => {
      const calls: string[][] = [];
      const result = await resolvePolicyEvidenceV1(
        context(
          {
            decision: "decision-platform-tool",
            decisionDigest: `sha256:${"0".repeat(64)}`,
            target: "claude",
            effect: "configure",
            evidence,
          },
          calls,
        ),
      );

      expect(result).toMatchObject({
        authority: "unverified",
        qualification: "unqualified",
        outcome: "refused",
        reason: "invalid-evidence-path",
      });
      expect(calls).toEqual([]);
    },
  );

  it("refuses an absolute cross-device result from the custody containment guard", () => {
    expect(isContainedEvidenceRelativePathV1("D:\\evidence.json")).toBe(false);
  });

  it("refuses an exact-decision-digest substitution after only the existing authority attestation", async () => {
    const fixture = decision();
    writeAuthority(fixture.value);
    writeFileSync(join(root, "evidence.json"), fixture.bytes);
    const calls: string[][] = [];

    const result = await resolvePolicyEvidenceV1(
      context(
        {
          decision: fixture.value.id,
          decisionDigest: `sha256:${"0".repeat(64)}`,
          target: "claude",
          effect: "configure",
          evidence: "evidence.json",
        },
        calls,
      ),
    );

    expect(result).toMatchObject({
      authority: "verified",
      qualification: "unqualified",
      effective: "decision-missing-or-mismatch",
      outcome: "refused",
      reason: "decision-missing-or-mismatch",
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses evidence swapped while the external authority attestation is in flight", async () => {
    const fixture = decision();
    writeAuthority(fixture.value);
    writeFileSync(join(root, "evidence.json"), fixture.bytes);
    const calls: string[][] = [];
    const result = await resolvePolicyEvidenceV1(
      context(
        {
          decision: fixture.value.id,
          decisionDigest: governanceDecisionDigestV2(fixture.value as never),
          target: "claude",
          effect: "configure",
          evidence: "evidence.json",
        },
        calls,
        () => writeFileSync(join(root, "evidence.json"), "swapped"),
      ),
    );

    expect(result).toMatchObject({
      authority: "verified",
      qualification: "unqualified",
      effective: "qualification-unverified",
      outcome: "refused",
      reason: "evidence-changed",
    });
    expect(calls).toHaveLength(1);
  });

  it("preserves authority-not-current when the authority expires after attestation", async () => {
    const fixture = decision();
    const expiringDecision = { ...fixture.value, expiresAt: "2026-08-02T12:00:01+00:00" };
    writeAuthority(expiringDecision, { expiresAt: "2026-08-02T12:00:01+00:00" });
    writeFileSync(join(root, "evidence.json"), fixture.bytes);
    const calls: string[][] = [];
    const result = await resolvePolicyEvidenceV1(
      context(
        {
          decision: expiringDecision.id,
          decisionDigest: governanceDecisionDigestV2(expiringDecision as never),
          target: "claude",
          effect: "configure",
          evidence: "evidence.json",
        },
        calls,
        () => vi.setSystemTime(new Date("2026-08-02T12:00:01+00:00")),
      ),
    );

    expect(result).toMatchObject({
      authority: "verified",
      qualification: "unqualified",
      effective: "authority-not-current",
      reason: "authority-not-current",
      outcome: "refused",
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses noncanonical evidence and symlink custody without widening the authority boundary", async () => {
    const fixture = decision();
    writeAuthority(fixture.value);
    const cases: Array<{ path: string; setup: () => void }> = [
      {
        path: "noncanonical.json",
        setup: () =>
          writeFileSync(join(root, "noncanonical.json"), JSON.stringify(fixture.evidence)),
      },
      {
        path: "linked.json",
        setup: () => {
          writeFileSync(join(root, "outside.json"), fixture.bytes);
          symlinkSync(join(root, "outside.json"), join(root, "linked.json"));
        },
      },
    ];
    for (const testCase of cases) {
      if (process.platform === "win32" && testCase.path === "linked.json") continue;
      testCase.setup();
      const calls: string[][] = [];
      const result = await resolvePolicyEvidenceV1(
        context(
          {
            decision: fixture.value.id,
            decisionDigest: governanceDecisionDigestV2(fixture.value as never),
            target: "claude",
            effect: "configure",
            evidence: testCase.path,
          },
          calls,
        ),
      );
      expect(result.outcome).toBe("refused");
      expect(result.qualification).toBe("unqualified");
      expect(result.reason).toBe(
        testCase.path === "linked.json" ? "unsafe-evidence-custody" : "qualification-unverified",
      );
      expect(calls).toHaveLength(testCase.path === "linked.json" ? 0 : 1);
    }
  });

  it("refuses evidence beneath a symlinked parent before calling the authority verifier", async () => {
    const fixture = decision();
    writeAuthority(fixture.value);
    const outside = mkdtempSync(join(tmpdir(), "aih-policy-resolve-outside-"));
    try {
      writeFileSync(join(outside, "evidence.json"), fixture.bytes);
      symlinkSync(outside, join(root, "sub"), "junction");
      const calls: string[][] = [];
      const result = await resolvePolicyEvidenceV1(
        context(
          {
            decision: fixture.value.id,
            decisionDigest: governanceDecisionDigestV2(fixture.value as never),
            target: "claude",
            effect: "configure",
            evidence: "sub/evidence.json",
          },
          calls,
        ),
      );

      expect(result).toMatchObject({
        authority: "unverified",
        qualification: "unqualified",
        outcome: "refused",
        reason: "unsafe-evidence-custody",
      });
      expect(calls).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("accepts every canonical CLI target at input validation while refusing unknown targets", async () => {
    const fixture = decision();
    writeFileSync(join(root, "evidence.json"), fixture.bytes);
    for (const target of SUPPORTED_CLIS) {
      const scopedDecision = { ...fixture.value, targets: [target] };
      writeAuthority(scopedDecision, { targets: [target] });
      const calls: string[][] = [];
      const registered = await resolvePolicyEvidenceV1(
        context(
          {
            decision: scopedDecision.id,
            decisionDigest: governanceDecisionDigestV2(scopedDecision as never),
            target,
            effect: "configure",
            evidence: "evidence.json",
          },
          calls,
        ),
      );
      expect(registered).toMatchObject({ reason: "observation-missing", outcome: "partial" });
      expect(calls).toHaveLength(1);
    }

    const unknownCalls: string[][] = [];
    const unknown = await resolvePolicyEvidenceV1(
      context(
        {
          decision: fixture.value.id,
          decisionDigest: governanceDecisionDigestV2(fixture.value as never),
          target: "not-a-cli",
          effect: "configure",
          evidence: "evidence.json",
        },
        unknownCalls,
      ),
    );
    expect(unknown).toMatchObject({ reason: "invalid-input", effective: "input-invalid" });
    expect(unknownCalls).toEqual([]);
  });

  it("refuses a referenced accepted-with-conditions decision whose review window is no longer current", async () => {
    const fixture = decision();
    const expiredReview = {
      ...fixture.value,
      disposition: "accepted-with-conditions" as const,
      acceptedFindings: ["residual-risk"],
      conditions: ["Re-review the residual risk before the stated deadline."],
      reviewBy: "2026-08-02T11:59:59+00:00",
    };
    writeAuthority(expiredReview as never);
    writeFileSync(join(root, "evidence.json"), fixture.bytes);
    const calls: string[][] = [];

    const result = await resolvePolicyEvidenceV1(
      context(
        {
          decision: expiredReview.id,
          decisionDigest: governanceDecisionDigestV2(expiredReview as never),
          target: "claude",
          effect: "configure",
          evidence: "evidence.json",
        },
        calls,
      ),
    );

    expect(result).toMatchObject({
      authority: "verified",
      qualification: "unqualified",
      effective: "decision-not-current",
      outcome: "refused",
      reason: "decision-not-current",
    });
    expect(calls).toHaveLength(1);
  });

  it("returns scrubbed closed reasons for authority, decision scope, and evidence refusal boundaries", async () => {
    const fixture = decision();
    const options = {
      decision: fixture.value.id,
      decisionDigest: governanceDecisionDigestV2(fixture.value as never),
      target: "claude",
      effect: "configure",
      evidence: "evidence.json",
    };
    writeFileSync(join(root, "evidence.json"), fixture.bytes);

    writeAuthority(fixture.value);
    const ghFailure = await resolvePolicyEvidenceV1(context(options, [], undefined, 1));
    expect(ghFailure).toMatchObject({ reason: "authority-unverified", outcome: "refused" });

    writeFileSync(join(root, ".aih", "policy-authority-receipt.json"), "not-json");
    const malformed = await resolvePolicyEvidenceV1(context(options, []));
    expect(malformed).toMatchObject({ reason: "authority-unverified", outcome: "refused" });

    writeAuthority(fixture.value, { expiresAt: "2026-08-02T12:00:00+00:00" });
    const stale = await resolvePolicyEvidenceV1(context(options, []));
    expect(stale).toMatchObject({ reason: "authority-unverified", outcome: "refused" });

    const rejected = { ...fixture.value, disposition: "rejected" as const };
    writeAuthority(rejected as never);
    const rejectedResult = await resolvePolicyEvidenceV1(
      context({ ...options, decisionDigest: governanceDecisionDigestV2(rejected as never) }, []),
    );
    expect(rejectedResult).toMatchObject({ reason: "decision-rejected", outcome: "refused" });

    writeAuthority(fixture.value, {
      issuedAt: "2026-08-02T12:00:00+00:00",
      decisionRevocations: [
        {
          format: "aih-governance-decision-revocation",
          version: 2,
          decisionDigest: governanceDecisionDigestV2(fixture.value as never),
          issuer: "platform-security",
          revokedAt: "2026-08-02T12:00:00+00:00",
          reason: "The decision was revoked after review.",
        },
      ],
    });
    const revokedResult = await resolvePolicyEvidenceV1(context(options, []));
    expect(revokedResult).toMatchObject({ reason: "decision-revoked", outcome: "refused" });

    const scope = { ...fixture.value, targets: ["codex"] };
    writeAuthority(scope, { targets: ["codex"] });
    const scopeResult = await resolvePolicyEvidenceV1(
      context({ ...options, decisionDigest: governanceDecisionDigestV2(scope as never) }, []),
    );
    expect(scopeResult).toMatchObject({ reason: "decision-scope-mismatch", outcome: "refused" });

    const effectScope = { ...fixture.value, allowedEffects: ["use"] };
    writeAuthority(effectScope);
    const effectResult = await resolvePolicyEvidenceV1(
      context({ ...options, decisionDigest: governanceDecisionDigestV2(effectScope as never) }, []),
    );
    expect(effectResult).toMatchObject({ reason: "decision-scope-mismatch", outcome: "refused" });

    rmSync(join(root, "evidence.json"));
    const missingEvidence = await resolvePolicyEvidenceV1(context(options, []));
    expect(missingEvidence).toMatchObject({ reason: "evidence-unavailable", outcome: "refused" });
    writeFileSync(join(root, "evidence.json"), Buffer.alloc(4_097));
    const oversizedEvidence = await resolvePolicyEvidenceV1(context(options, []));
    expect(oversizedEvidence).toMatchObject({ reason: "evidence-unavailable", outcome: "refused" });
  });
});
