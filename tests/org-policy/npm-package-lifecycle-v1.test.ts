import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import {
  lifecycleNpmPackageV1,
  npmPackageLifecycleCommand,
} from "../../src/org-policy/npm-package-lifecycle-v1.js";
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
  root = mkdtempSync(join(tmpdir(), "aih-npm-lifecycle-"));
  bin = mkdtempSync(join(tmpdir(), "aih-npm-lifecycle-gh-"));
  gh = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(gh, "trusted gh fixture\n", { mode: 0o755 });
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

function writeFixture(value = fixture()): void {
  mkdirSync(join(root, ".aih"), { recursive: true });
  writeFileSync(
    join(root, "evidence.json"),
    canonicalOrganizationEvidenceEnvelopeV1(value.evidence),
  );
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
      decisions: [value.decision],
      decisionRevocations: [],
    }),
  );
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

function context(apply = false): PlanContext {
  const run = fakeRunner((argv) => (argv[0] === gh ? { code: 0 } : { code: 1 }));
  const value = fixture().decision;
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
      decision: value.id,
      decisionDigest: governanceDecisionDigestV2(value),
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

describe("npm package lifecycle V1", () => {
  it("keeps preview zero-write, then appends immutable observation records before advancing a subject head", async () => {
    writeFixture();
    const preview = await lifecycleNpmPackageV1(context(false));
    expect(preview).toMatchObject({ outcome: "fulfilled", applied: false });
    expect(lifecycleFiles()).toEqual([]);

    const first = await lifecycleNpmPackageV1(context(true));
    expect(first).toMatchObject({ outcome: "fulfilled", applied: true });
    const firstFiles = lifecycleFiles();
    expect(firstFiles.filter((file) => file.startsWith("records/"))).toHaveLength(1);
    expect(firstFiles.filter((file) => file.startsWith("heads/"))).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    const second = await lifecycleNpmPackageV1(context(true));
    expect(second).toMatchObject({ outcome: "fulfilled", applied: true });
    expect(lifecycleFiles().filter((file) => file.startsWith("records/"))).toHaveLength(2);
  });

  it("does not create lifecycle state for a refused write and exposes no package/effect override", async () => {
    writeFixture();
    const missing = await lifecycleNpmPackageV1({ ...context(true), options: {} });
    expect(missing).toMatchObject({ outcome: "refused", applied: false });
    expect(lifecycleFiles()).toEqual([]);
    expect(npmPackageLifecycleCommand.options?.map((item) => item.flags)).toEqual(
      expect.arrayContaining(["--apply"]),
    );
    expect(npmPackageLifecycleCommand.options?.map((item) => item.flags)).not.toEqual(
      expect.arrayContaining(["--package <name>", "--effect <effect>"]),
    );
  });
});
