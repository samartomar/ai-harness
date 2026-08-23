import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../src/org-policy/governance-decision-v2.js";
import { resolvePolicyEvidenceV1 } from "../../src/org-policy/policy-resolve-v1.js";
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
    bytes: Buffer.from(canonicalOrganizationEvidenceEnvelopeV1(evidence), "utf8"),
  };
}

function context(options: Record<string, unknown>, calls: string[][]): PlanContext {
  const run = fakeRunner((argv) => {
    calls.push(argv);
    return argv[0] === gh ? { code: 0 } : { code: 1 };
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

function writeAuthority(value: ReturnType<typeof decision>["value"]): void {
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
    }),
  );
}

describe("policy resolve V1", () => {
  it("uses V3 authority plus canonical custodied organization evidence and reports observation-missing as a non-effective partial", async () => {
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
      qualification: "qualified",
      observation: "missing",
      effective: "observation-missing",
      outcome: "partial",
    });
    expect(calls).toHaveLength(1);
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
    });
    expect(calls).toEqual([]);
  });
});
