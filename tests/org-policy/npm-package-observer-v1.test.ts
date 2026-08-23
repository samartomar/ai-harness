import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../src/org-policy/governance-decision-v2.js";
import { observeNpmPackageV1 } from "../../src/org-policy/npm-package-observer-v1.js";
import {
  canonicalOrganizationEvidenceEnvelopeV1,
  organizationEvidenceEnvelopeDigestV1,
} from "../../src/org-policy/qualification-v1.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

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

function writeAuthority(decision: ReturnType<typeof fixture>["decision"]): void {
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
      decisions: [decision],
      decisionRevocations: [],
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

function context(options: Record<string, unknown>, calls: string[][]): PlanContext {
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
    env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
    options,
  };
}

describe("npm package upstream observer V1", () => {
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
    expect(result.observationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
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
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(1, 3)).toEqual(["attestation", "verify"]);
    expect(readFileSync(join(root, "package-lock.json"))).toEqual(before.get("lock"));
    expect(readFileSync(join(root, "node_modules", "@acme", "widget", "package.json"))).toEqual(
      before.get("manifest"),
    );
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
});
