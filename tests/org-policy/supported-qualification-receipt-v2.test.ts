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
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as packageApi from "../../src/index.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  PolicyAuthorityReceiptSchema,
  type VerifiedPolicyAuthority,
  verifyPolicyAuthorityReceipt,
} from "../../src/org-policy/authority.js";
import {
  GovernanceDecisionV2Schema,
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../src/org-policy/governance-decision-v2.js";
import * as supportedQualificationModule from "../../src/org-policy/supported-qualification-receipt-v2.js";
import {
  AihSupportedQualificationReceiptV2Schema,
  canonicalAihSupportedQualificationReceiptV2,
  MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2,
  parseAihSupportedQualificationReceiptV2Bytes,
  verifyAihSupportedQualificationReceiptV2,
} from "../../src/org-policy/supported-qualification-receipt-v2.js";
import {
  resolveObservedEffect,
  verifyUpstreamObservationV1,
} from "../../src/org-policy/upstream-observation-receipt-v1.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let dir: string;
let authorityBin: string;
let supportedBin: string;
let trustedAuthorityGh: string;
let trustedSupportedGh: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-02T12:00:00Z"));
  dir = mkdtempSync(join(tmpdir(), "aih-supported-qualification-"));
  authorityBin = mkdtempSync(join(tmpdir(), "aih-supported-authority-gh-"));
  supportedBin = mkdtempSync(join(tmpdir(), "aih-supported-receipt-gh-"));
  const filename = process.platform === "win32" ? "gh.exe" : "gh";
  const authorityGh = join(authorityBin, filename);
  const supportedGh = join(supportedBin, filename);
  writeFileSync(authorityGh, "trusted authority gh fixture\n", { mode: 0o755 });
  writeFileSync(supportedGh, "trusted supported gh fixture\n", { mode: 0o755 });
  trustedAuthorityGh = realpathSync.native(authorityGh);
  trustedSupportedGh = realpathSync.native(supportedGh);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
  rmSync(authorityBin, { recursive: true, force: true });
  rmSync(supportedBin, { recursive: true, force: true });
});

function decision(overrides: Record<string, unknown> = {}) {
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
  return {
    format: "aih-governance-decision",
    version: 2,
    id: "decision-platform-tool",
    qualificationBasis: {
      kind: "aih-supported" as const,
      catalogSignerIdentity: "aih-catalog-service",
      catalogDigest: `sha256:${"3".repeat(64)}`,
      catalogHeadDigest: `sha256:${"4".repeat(64)}`,
      catalogMemberDigest: `sha256:${"5".repeat(64)}`,
      subjectKind: subject.kind,
      subjectDigest: subject.subjectDigest,
    },
    subject,
    targets: ["claude"],
    allowedEffects: ["configure"],
    policy: {
      id: "platform-policy",
      version: "2026.08",
      digest: `sha256:${"c".repeat(64)}`,
    },
    control: { id: "review-control", digest: `sha256:${"d".repeat(64)}` },
    evidence: {
      id: "catalog-evidence",
      digest: `sha256:${"e".repeat(64)}`,
      attestor: "aih-catalog-service",
    },
    issuer: "platform-security",
    actor: "security-admin",
    reason: "The exact catalog member is supported for this governed subject.",
    issuedAt: "2026-08-01T00:00:00Z",
    notBefore: "2026-08-01T00:00:00Z",
    expiresAt: "2026-08-10T00:00:00Z",
    disposition: "approved" as const,
    acceptedFindings: [],
    acceptedGaps: [],
    conditions: [],
    ...overrides,
  };
}

function receipt(value: ReturnType<typeof decision>, overrides: Record<string, unknown> = {}) {
  const catalogHeadDigest =
    value.qualificationBasis.kind === "aih-supported"
      ? value.qualificationBasis.catalogHeadDigest
      : `sha256:${"4".repeat(64)}`;
  return {
    format: "aih-supported-qualification-receipt" as const,
    version: 2 as const,
    organizationAdmission: "not-authoritative" as const,
    entryId: "platform-review-tool",
    subject: value.subject,
    qualificationBasis: value.qualificationBasis,
    catalogContinuity: {
      catalogHeadDigest,
      previousCatalogHeadDigest: `sha256:${"0".repeat(64)}`,
      sequence: 0,
      replayIdentity: `catalog-head:${catalogHeadDigest.slice(7)}:${"6".repeat(64)}`,
      signerKeyId: `ed25519:${"7".repeat(64)}`,
      headValidFrom: "2026-08-01T00:00:00Z",
      headValidUntil: "2026-08-10T00:00:00Z",
    },
    issuedAt: "2026-08-01T00:00:00Z",
    notBefore: "2026-08-01T00:00:00Z",
    expiresAt: "2026-08-10T00:00:00Z",
    ...overrides,
  };
}

function canonicalBytes(value: ReturnType<typeof receipt>): Buffer {
  return Buffer.from(canonicalAihSupportedQualificationReceiptV2(value as never), "utf8");
}

/** The Supported producer's exact maximum: 4,096-byte remote source and 5,970-byte receipt. */
function maximumReceiptV2(sourceBytes = 4_096) {
  const digest = (character: string) => `sha256:${character.repeat(64)}`;
  const sourceBase = {
    type: "remote" as const,
    endpoint: "https://a/",
    contentDigest: digest("a"),
  };
  const endpoint = `https://a/${"x".repeat(sourceBytes - Buffer.byteLength(JSON.stringify(sourceBase)))}`;
  const source = { ...sourceBase, endpoint };
  const sourceDigest = governanceDecisionSourceDigestV2(source);
  const id = `a${"b".repeat(63)}`;
  const subject = {
    kind: "package" as const,
    id,
    source,
    sourceDigest,
    subjectDigest: governanceDecisionSubjectDigestV2({
      kind: "package",
      id,
      sourceDigest,
    }),
  };
  const catalogHeadDigest = digest("4");
  return {
    format: "aih-supported-qualification-receipt" as const,
    version: 2 as const,
    organizationAdmission: "not-authoritative" as const,
    entryId: id,
    subject,
    qualificationBasis: {
      kind: "aih-supported" as const,
      catalogSignerIdentity: `a${"b".repeat(255)}`,
      catalogDigest: digest("3"),
      catalogHeadDigest,
      catalogMemberDigest: digest("5"),
      subjectKind: "package" as const,
      subjectDigest: subject.subjectDigest,
    },
    catalogContinuity: {
      catalogHeadDigest,
      previousCatalogHeadDigest: digest("2"),
      sequence: Number.MAX_SAFE_INTEGER,
      replayIdentity: `catalog-head:${catalogHeadDigest.slice(7)}:${"6".repeat(64)}`,
      signerKeyId: `ed25519:${"7".repeat(64)}`,
      headValidFrom: "2026-08-01T00:00:00Z",
      headValidUntil: "2026-08-10T00:00:00Z",
    },
    issuedAt: "2026-08-01T00:00:00Z",
    notBefore: "2026-08-01T00:00:00Z",
    expiresAt: "2026-08-10T00:00:00Z",
  };
}

function context(
  handler: (argv: string[]) => {
    code?: number;
    spawnError?: boolean;
  } = () => ({ code: 0 }),
  env: NodeJS.ProcessEnv = {},
): PlanContext {
  const run = fakeRunner((argv) => handler(argv));
  return {
    root: dir,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {
      AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance",
      AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "aihq/supported-catalog",
      AIH_SUPPORTED_QUALIFICATION_WORKFLOW: "qualification.yml",
      PATH: supportedBin,
      ...env,
    },
    options: {},
  };
}

function writeAuthorityReceipt(
  value: ReturnType<typeof decision>,
  overrides: Record<string, unknown> = {},
): void {
  mkdirSync(join(dir, ".aih"), { recursive: true });
  writeFileSync(
    join(dir, ".aih", "policy-authority-receipt.json"),
    JSON.stringify({
      format: "aih-policy-authority-receipt",
      version: 3,
      issuerRepository: "acme/governance",
      issuedAt: "2026-08-01T00:00:00Z",
      expiresAt: "2026-08-10T00:00:00Z",
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
      targets: value.targets,
      decisions: [value],
      decisionRevocations: [],
      ...overrides,
    }),
  );
}

async function authority(
  value: ReturnType<typeof decision>,
  workflow?: string,
  receiptOverrides: Record<string, unknown> = {},
): Promise<VerifiedPolicyAuthority> {
  writeAuthorityReceipt(value, receiptOverrides);
  const authorityContext = context(
    (argv) => (argv[0] === trustedAuthorityGh ? { code: 0 } : { code: 1 }),
    {
      AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance",
      ...(workflow === undefined ? {} : { AIH_POLICY_AUTHORITY_WORKFLOW: workflow }),
      PATH: authorityBin,
    },
  );
  const result = await verifyPolicyAuthorityReceipt(authorityContext);
  if (result.authority === undefined) throw new Error(result.problem);
  return result.authority;
}

function writeReceipt(value: ReturnType<typeof receipt>): void {
  mkdirSync(join(dir, ".aih"), { recursive: true });
  writeFileSync(
    join(dir, ".aih", "aih-supported-qualification-receipt.json"),
    canonicalBytes(value),
  );
}

function observation(value: ReturnType<typeof decision>) {
  return {
    format: "aih-upstream-observation-receipt" as const,
    version: 1 as const,
    id: "observation-platform-tool",
    decision: {
      id: value.id,
      digest: governanceDecisionDigestV2(value as never),
    },
    subject: {
      kind: value.subject.kind,
      id: value.subject.id,
      sourceDigest: value.subject.sourceDigest,
      subjectDigest: value.subject.subjectDigest,
    },
    targets: ["claude"],
    allowedEffects: ["configure"],
    integration: {
      mode: "upstream-managed" as const,
      owner: "upstream-admin",
      version: "1.0.0",
    },
    installed: {
      id: "platform-review-tool",
      digest: `sha256:${"d".repeat(64)}`,
    },
    verifier: {
      id: "upstream-admin",
      version: "1.0.0",
      digest: `sha256:${"f".repeat(64)}`,
    },
    observedAt: "2026-08-02T00:00:00Z",
    validUntil: "2026-08-03T00:00:00Z",
    outcome: "observed-success" as const,
  };
}

describe("AihSupportedQualificationReceiptV2", () => {
  it("publishes only an inert supported qualification artifact verifier", async () => {
    const publicApi = packageApi as Record<string, unknown>;
    expect(publicApi.verifyAihSupportedQualificationReceiptV2).toBeUndefined();
    expect(publicApi.verifyAihSupportedQualificationArtifactV1).toBeUndefined();
    const verifier = publicApi.verifyAihSupportedQualificationArtifactV2;
    expect(verifier).toEqual(expect.any(Function));
    if (typeof verifier !== "function") return;
    const value = decision();
    const result = await (
      verifier as (input: {
        root: string;
        decisionReference: { id: string; digest: string };
        subject: typeof value.subject;
      }) => Promise<Record<string, unknown>>
    )({
      root: dir,
      decisionReference: {
        id: value.id,
        digest: governanceDecisionDigestV2(value as never),
      },
      subject: value.subject,
    });
    expect(result).toEqual({
      state: "unverified",
      problem: "AIH-supported qualification artifact could not be verified",
    });
    const forged = await (
      verifier as (input: Record<string, unknown>) => Promise<Record<string, unknown>>
    )({
      root: dir,
      decisionReference: {
        id: value.id,
        digest: governanceDecisionDigestV2(value as never),
      },
      subject: value.subject,
      run: () => ({ code: 0 }),
      env: { AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "forged/registry" },
      now: "2099-01-01T00:00:00Z",
      supportedTargets: ["forged-target"],
    });
    expect(forged).toEqual({
      state: "unverified",
      problem: "AIH-supported qualification artifact could not be verified",
    });
  });

  it("uses an internal-only seam to verify the artifact without minting a capability", async () => {
    const internalApi = supportedQualificationModule as Record<string, unknown>;
    const verifier = internalApi.verifyAihSupportedQualificationArtifactV2WithContext;
    expect(verifier).toEqual(expect.any(Function));
    if (typeof verifier !== "function") return;
    const value = decision();
    await authority(value);
    writeReceipt(receipt(value));
    const calls: string[][] = [];
    const result = await (
      verifier as (
        ctx: PlanContext,
        input: {
          root: string;
          decisionReference: { id: string; digest: string };
          subject: typeof value.subject;
        },
      ) => Promise<Record<string, unknown>>
    )(
      context((argv) => {
        calls.push(argv);
        return { code: 0 };
      }),
      {
        root: dir,
        decisionReference: {
          id: value.id,
          digest: governanceDecisionDigestV2(value as never),
        },
        subject: value.subject,
      },
    );
    expect(result).toEqual({ state: "verified" });
    expect(calls).toHaveLength(2);
    expect(calls.flat().join(" ")).not.toContain("configure");
    expect(result.qualification).toBeUndefined();
    expect(result.authority).toBeUndefined();
  });

  it("fails closed in the artifact seam for roots, attestations, and exact bindings", async () => {
    const internalApi = supportedQualificationModule as Record<string, unknown>;
    const verifier = internalApi.verifyAihSupportedQualificationArtifactV2WithContext;
    expect(verifier).toEqual(expect.any(Function));
    if (typeof verifier !== "function") return;
    const value = decision();
    await authority(value);
    const input = {
      root: dir,
      decisionReference: {
        id: value.id,
        digest: governanceDecisionDigestV2(value as never),
      },
      subject: value.subject,
    };
    for (const receiptValue of [
      receipt(value, {
        qualificationBasis: {
          ...value.qualificationBasis,
          catalogDigest: `sha256:${"0".repeat(64)}`,
        },
      }),
      receipt(value, { expiresAt: "2026-08-02T11:59:59Z" }),
      receipt(value, {
        notBefore: "2026-08-02T12:00:01Z",
        expiresAt: "2026-08-03T00:00:00Z",
      }),
      receipt(value, { expiresAt: "2026-08-10T00:00:01Z" }),
    ]) {
      writeReceipt(receiptValue);
      await expect(
        (verifier as (ctx: PlanContext, value: typeof input) => Promise<Record<string, unknown>>)(
          context(() => ({ code: 0 })),
          input,
        ),
      ).resolves.toMatchObject({ state: "unverified" });
    }
    writeReceipt(receipt(value));
    await expect(
      (verifier as (ctx: PlanContext, value: typeof input) => Promise<Record<string, unknown>>)(
        context(() => ({ code: 0 })),
        {
          ...input,
          decisionReference: {
            ...input.decisionReference,
            id: "other-decision",
          },
        },
      ),
    ).resolves.toMatchObject({ state: "unverified" });
    const differentSource = {
      ...value.subject.source,
      repository: "acme/other-review-tool",
    };
    const differentSourceDigest = governanceDecisionSourceDigestV2(differentSource);
    await expect(
      (verifier as (ctx: PlanContext, value: typeof input) => Promise<Record<string, unknown>>)(
        context(() => ({ code: 0 })),
        {
          ...input,
          subject: {
            ...value.subject,
            source: differentSource,
            sourceDigest: differentSourceDigest,
            subjectDigest: governanceDecisionSubjectDigestV2({
              kind: value.subject.kind,
              id: value.subject.id,
              sourceDigest: differentSourceDigest,
            }),
          },
        },
      ),
    ).resolves.toMatchObject({ state: "unverified" });
    await expect(
      (verifier as (ctx: PlanContext, value: typeof input) => Promise<Record<string, unknown>>)(
        context(() => ({ code: 1 })),
        input,
      ),
    ).resolves.toMatchObject({ state: "unverified" });
    let attestations = 0;
    await expect(
      (verifier as (ctx: PlanContext, value: typeof input) => Promise<Record<string, unknown>>)(
        context(() => ({ code: attestations++ === 0 ? 0 : 1 })),
        input,
      ),
    ).resolves.toMatchObject({ state: "unverified" });
    const reuseCalls: string[][] = [];
    await expect(
      (verifier as (ctx: PlanContext, value: typeof input) => Promise<Record<string, unknown>>)(
        context(
          (argv) => {
            reuseCalls.push(argv);
            return { code: 0 };
          },
          { AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "acme/governance" },
        ),
        input,
      ),
    ).resolves.toMatchObject({ state: "unverified" });
    expect(reuseCalls).toHaveLength(1);
  });

  it("fails closed for future authority issuance and referenced-decision currency boundaries", async () => {
    const internalApi = supportedQualificationModule as Record<string, unknown>;
    const verifier = internalApi.verifyAihSupportedQualificationArtifactV2WithContext;
    expect(verifier).toEqual(expect.any(Function));
    if (typeof verifier !== "function") return;
    const verify = async (
      value: ReturnType<typeof decision>,
      authorityOverrides: Record<string, unknown> = {},
    ) => {
      await authority(value, undefined, authorityOverrides);
      writeReceipt(receipt(value));
      return (
        verifier as (
          ctx: PlanContext,
          input: {
            root: string;
            decisionReference: { id: string; digest: string };
            subject: typeof value.subject;
          },
        ) => Promise<Record<string, unknown>>
      )(
        context(() => ({ code: 0 })),
        {
          root: dir,
          decisionReference: {
            id: value.id,
            digest: governanceDecisionDigestV2(value as never),
          },
          subject: value.subject,
        },
      );
    };
    const futureAuthority = decision();
    writeAuthorityReceipt(futureAuthority, {
      issuedAt: "2026-08-02T12:00:01Z",
    });
    expect(
      PolicyAuthorityReceiptSchema.safeParse(
        JSON.parse(readFileSync(join(dir, ".aih", "policy-authority-receipt.json"), "utf8")),
      ).success,
    ).toBe(true);
    writeReceipt(receipt(futureAuthority));
    await expect(
      (
        verifier as (
          ctx: PlanContext,
          input: {
            root: string;
            decisionReference: { id: string; digest: string };
            subject: typeof futureAuthority.subject;
          },
        ) => Promise<Record<string, unknown>>
      )(
        context(() => ({ code: 0 })),
        {
          root: dir,
          decisionReference: {
            id: futureAuthority.id,
            digest: governanceDecisionDigestV2(futureAuthority as never),
          },
          subject: futureAuthority.subject,
        },
      ),
    ).resolves.toMatchObject({ state: "unverified" });
    const invalidDecisions: Array<ReturnType<typeof decision>> = [
      decision({ notBefore: "2026-08-02T12:00:01Z" }),
      decision({ expiresAt: "2026-08-02T12:00:00Z" }),
      decision({ disposition: "rejected" }),
      decision({
        disposition: "accepted-with-conditions",
        acceptedFindings: ["finding-1"],
        acceptedGaps: [],
        conditions: ["review-required"],
        reviewBy: "2026-08-02T12:00:00Z",
      }),
    ];
    for (const value of invalidDecisions) {
      expect(GovernanceDecisionV2Schema.safeParse(value).success).toBe(true);
      await expect(verify(value)).resolves.toMatchObject({
        state: "unverified",
      });
    }
    const revoked = decision();
    await expect(
      verify(revoked, {
        decisionRevocations: [
          {
            format: "aih-governance-decision-revocation",
            version: 2,
            decisionDigest: governanceDecisionDigestV2(revoked as never),
            issuer: revoked.issuer,
            revokedAt: "2026-08-01T00:00:00Z",
            reason: "Withdrawn at the exact validity boundary.",
          },
        ],
      }),
    ).resolves.toMatchObject({ state: "unverified" });
  });

  it("refuses a subject-wide current rejected decision even for an approved reference", async () => {
    const internalApi = supportedQualificationModule as Record<string, unknown>;
    const verifier = internalApi.verifyAihSupportedQualificationArtifactV2WithContext;
    expect(verifier).toEqual(expect.any(Function));
    if (typeof verifier !== "function") return;
    const approved = decision();
    const rejected = decision({
      id: "decision-rejected-tool",
      disposition: "rejected",
    });
    writeAuthorityReceipt(approved, { decisions: [approved, rejected] });
    writeReceipt(receipt(approved));
    await expect(
      (
        verifier as (
          ctx: PlanContext,
          input: {
            root: string;
            decisionReference: { id: string; digest: string };
            subject: typeof approved.subject;
          },
        ) => Promise<Record<string, unknown>>
      )(
        context(() => ({ code: 0 })),
        {
          root: dir,
          decisionReference: {
            id: approved.id,
            digest: governanceDecisionDigestV2(approved as never),
          },
          subject: approved.subject,
        },
      ),
    ).resolves.toMatchObject({ state: "unverified" });
    const subjectRejection = internalApi.isCurrentUnrevokedSubjectRejectionV2;
    expect(subjectRejection).toEqual(expect.any(Function));
    if (typeof subjectRejection !== "function") return;
    const base = {
      decisions: [approved, rejected],
      subjectDigest: approved.subject.subjectDigest,
      now: "2026-08-02T12:00:00Z",
    };
    expect(
      (subjectRejection as (input: Record<string, unknown>) => boolean)({
        ...base,
        decisionRevocations: [
          {
            decisionDigest: governanceDecisionDigestV2(rejected as never),
            revokedAt: "2026-08-02T12:00:01Z",
          },
        ],
      }),
    ).toBe(true);
    expect(
      (subjectRejection as (input: Record<string, unknown>) => boolean)({
        ...base,
        decisionRevocations: [
          {
            decisionDigest: governanceDecisionDigestV2(rejected as never),
            revokedAt: "2026-08-02T12:00:00Z",
          },
        ],
      }),
    ).toBe(false);
  });

  it("returns the fixed inert failure for nonexistent and regular-file public roots", async () => {
    const publicApi = packageApi as Record<string, unknown>;
    const verifier = publicApi.verifyAihSupportedQualificationArtifactV2;
    expect(verifier).toEqual(expect.any(Function));
    if (typeof verifier !== "function") return;
    const value = decision();
    const rootFile = join(dir, "not-a-directory");
    writeFileSync(rootFile, "not a root\n");
    for (const root of [join(dir, "missing-root"), rootFile]) {
      await expect(
        (
          verifier as (input: {
            root: string;
            decisionReference: { id: string; digest: string };
            subject: typeof value.subject;
          }) => Promise<unknown>
        )({
          root,
          decisionReference: {
            id: value.id,
            digest: governanceDecisionDigestV2(value as never),
          },
          subject: value.subject,
        }),
      ).resolves.toEqual({
        state: "unverified",
        problem: "AIH-supported qualification artifact could not be verified",
      });
    }
  });

  it("POSIX simulation: package root uses only its own default-runner attestation path", async () => {
    if (process.platform === "win32") return;
    const publicApi = packageApi as Record<string, unknown>;
    const verifier = publicApi.verifyAihSupportedQualificationArtifactV2;
    expect(verifier).toEqual(expect.any(Function));
    if (typeof verifier !== "function") return;
    const value = decision();
    await authority(value);
    writeReceipt(receipt(value));
    const externalBin = mkdtempSync(join(tmpdir(), "aih-supported-public-gh-"));
    const fakeGh = join(externalBin, "gh");
    writeFileSync(fakeGh, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const prior = {
      authorityRepository: process.env.AIH_POLICY_AUTHORITY_REPOSITORY,
      supportedRepository: process.env.AIH_SUPPORTED_QUALIFICATION_REPOSITORY,
      supportedWorkflow: process.env.AIH_SUPPORTED_QUALIFICATION_WORKFLOW,
      path: process.env.PATH,
    };
    try {
      process.env.AIH_POLICY_AUTHORITY_REPOSITORY = "acme/governance";
      process.env.AIH_SUPPORTED_QUALIFICATION_REPOSITORY = "aihq/supported-catalog";
      process.env.AIH_SUPPORTED_QUALIFICATION_WORKFLOW = "qualification.yml";
      process.env.PATH = externalBin;
      await expect(
        (
          verifier as (input: {
            root: string;
            decisionReference: { id: string; digest: string };
            subject: typeof value.subject;
          }) => Promise<unknown>
        )({
          root: dir,
          decisionReference: {
            id: value.id,
            digest: governanceDecisionDigestV2(value as never),
          },
          subject: value.subject,
        }),
      ).resolves.toEqual({ state: "verified" });
    } finally {
      for (const [key, previous] of Object.entries(prior)) {
        const envKey =
          key === "authorityRepository"
            ? "AIH_POLICY_AUTHORITY_REPOSITORY"
            : key === "supportedRepository"
              ? "AIH_SUPPORTED_QUALIFICATION_REPOSITORY"
              : key === "supportedWorkflow"
                ? "AIH_SUPPORTED_QUALIFICATION_WORKFLOW"
                : "PATH";
        if (previous === undefined) delete process.env[envKey];
        else process.env[envKey] = previous;
      }
      rmSync(externalBin, { recursive: true, force: true });
    }
  });

  it("accepts only exact canonical UTF-8 receipt bytes and rejects malformed transport", () => {
    const value = receipt(decision());
    const bytes = canonicalBytes(value);
    expect(parseAihSupportedQualificationReceiptV2Bytes(bytes)).toEqual(value);
    for (const invalid of [
      Buffer.from(JSON.stringify(value)),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
      Buffer.concat([bytes, Buffer.from("\n")]),
      Buffer.from(
        bytes
          .toString("utf8")
          .replace(
            '"format":"aih-supported-qualification-receipt"',
            '"format":"aih-supported-qualification-receipt","format":"aih-supported-qualification-receipt"',
          ),
      ),
      canonicalBytes({ ...value, extra: true } as never),
      canonicalBytes({ ...value, version: 1 } as never),
      canonicalBytes({
        ...value,
        organizationAdmission: "authoritative",
      } as never),
      canonicalBytes({
        ...value,
        catalogContinuity: { ...value.catalogContinuity, unknown: true },
      } as never),
      canonicalBytes({
        ...value,
        subject: { ...value.subject, sourceDigest: `sha256:${"0".repeat(64)}` },
      }),
      canonicalBytes({
        ...value,
        subject: {
          ...value.subject,
          subjectDigest: `sha256:${"0".repeat(64)}`,
        },
        qualificationBasis: {
          ...value.qualificationBasis,
          subjectDigest: `sha256:${"0".repeat(64)}`,
        },
      }),
      canonicalBytes({ ...value, expiresAt: value.notBefore } as never),
      canonicalBytes({ ...value, expiresAt: "2026-12-01T00:00:00Z" } as never),
      canonicalBytes({
        ...value,
        catalogContinuity: {
          ...value.catalogContinuity,
          replayIdentity: `catalog-head:${"0".repeat(64)}:${"6".repeat(64)}`,
        },
      } as never),
      canonicalBytes({
        ...value,
        catalogContinuity: {
          ...value.catalogContinuity,
          previousCatalogHeadDigest: value.catalogContinuity.catalogHeadDigest,
        },
      } as never),
      canonicalBytes({
        ...value,
        catalogContinuity: { ...value.catalogContinuity, sequence: 1 },
      } as never),
      canonicalBytes({
        ...value,
        catalogContinuity: {
          ...value.catalogContinuity,
          headValidFrom: value.catalogContinuity.headValidUntil,
        },
      } as never),
      Buffer.from(bytes.toString("utf8").replace('"sequence":0', '"sequence":-0')),
      Buffer.from(bytes.toString("utf8").replace('"sequence":0', '"sequence":9007199254740992')),
      ...(["issuedAt", "notBefore", "expiresAt"] as const).map((field) =>
        canonicalBytes({ ...value, [field]: "2026-02-30T00:00:00Z" } as never),
      ),
      ...(["headValidFrom", "headValidUntil"] as const).map((field) =>
        canonicalBytes({
          ...value,
          catalogContinuity: {
            ...value.catalogContinuity,
            [field]: "2026-02-30T00:00:00Z",
          },
        } as never),
      ),
    ]) {
      expect(parseAihSupportedQualificationReceiptV2Bytes(invalid)).toBeUndefined();
    }
  });

  it("accepts producer-canonical proleptic Gregorian years across receipt and head timestamps", () => {
    for (const year of ["0000", "0099", "0100"]) {
      const value = receipt(decision(), {
        catalogContinuity: {
          ...receipt(decision()).catalogContinuity,
          headValidFrom: `${year}-01-01T00:00:00Z`,
          headValidUntil: `${year}-01-02T00:00:00Z`,
        },
        issuedAt: `${year}-01-01T00:00:00Z`,
        notBefore: `${year}-01-01T00:00:00Z`,
        expiresAt: `${year}-01-02T00:00:00Z`,
      });
      expect(parseAihSupportedQualificationReceiptV2Bytes(canonicalBytes(value))).toEqual(value);
    }
  });

  it("accepts the producer's exact 4,096-byte source and 5,970-byte receipt ceilings", () => {
    const exact = maximumReceiptV2();
    const exactBytes = Buffer.from(canonicalAihSupportedQualificationReceiptV2(exact), "utf8");
    expect(Buffer.byteLength(JSON.stringify(exact.subject.source), "utf8")).toBe(4_096);
    expect(exactBytes.byteLength).toBe(MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2);
    expect(parseAihSupportedQualificationReceiptV2Bytes(exactBytes)).toEqual(exact);

    const over = maximumReceiptV2(4_097);
    const overBytes = Buffer.from(canonicalAihSupportedQualificationReceiptV2(over), "utf8");
    expect(Buffer.byteLength(JSON.stringify(over.subject.source), "utf8")).toBe(4_097);
    expect(overBytes.byteLength).toBe(MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2 + 1);
    expect(parseAihSupportedQualificationReceiptV2Bytes(overBytes)).toBeUndefined();
  });

  it("ships a strict schema", () => {
    const schema = JSON.parse(
      // The committed schema test pins byte-for-byte generated output; this checks consumer validity.
      readFileSync(
        join(process.cwd(), "schemas/aih-supported-qualification-receipt-v2.schema.json"),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const value = receipt(decision());
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...value, unexpected: true })).toBe(false);
    expect(AihSupportedQualificationReceiptV2Schema.safeParse(value).success).toBe(true);
  });

  it("requires dedicated roots, verifies an exact private copy, and mints no execution authority", async () => {
    const value = decision();
    const verifiedAuthority = await authority(value);
    writeReceipt(receipt(value));
    const argv: string[][] = [];
    const result = await verifyAihSupportedQualificationReceiptV2(
      context((actual) => {
        argv.push(actual);
        return actual[0] === trustedSupportedGh ? { code: 0 } : { code: 1 };
      }),
      {
        authority: verifiedAuthority,
        decisionReference: {
          id: value.id,
          digest: governanceDecisionDigestV2(value as never),
        },
        subject: value.subject,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        now: "2026-08-02T12:00:00Z",
      },
    );
    expect(result.problem).toBeUndefined();
    expect(result.qualification).toBeDefined();
    expect(argv).toHaveLength(1);
    expect(argv[0]).toEqual([
      trustedSupportedGh,
      "attestation",
      "verify",
      expect.not.stringContaining(dir),
      "--repo",
      "aihq/supported-catalog",
      "--signer-workflow",
      "qualification.yml",
    ]);
  });

  it("selects only an external native gh and never the governed checkout binary", async () => {
    const value = decision();
    const verifiedAuthority = await authority(value);
    writeReceipt(receipt(value));
    const localGh = join(dir, process.platform === "win32" ? "gh.exe" : "gh");
    writeFileSync(localGh, "untrusted local gh fixture\n", { mode: 0o755 });
    const calls: string[][] = [];
    const result = await verifyAihSupportedQualificationReceiptV2(
      context(
        (argv) => {
          calls.push(argv);
          return { code: argv[0] === trustedSupportedGh ? 0 : 1 };
        },
        {
          PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${supportedBin}`,
        },
      ),
      {
        authority: verifiedAuthority,
        decisionReference: {
          id: value.id,
          digest: governanceDecisionDigestV2(value as never),
        },
        subject: value.subject,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        now: "2026-08-02T12:00:00Z",
      },
    );
    expect(result.qualification).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(trustedSupportedGh);
  });

  it("binds root separation to the previously verified authority rather than mutable caller env", async () => {
    const value = decision();
    const verifiedAuthority = await authority(value, "policy.yml");
    writeReceipt(receipt(value));
    const calls: string[][] = [];
    const result = await verifyAihSupportedQualificationReceiptV2(
      context(
        (argv) => {
          calls.push(argv);
          return { code: 0 };
        },
        {
          AIH_POLICY_AUTHORITY_REPOSITORY: undefined,
          AIH_POLICY_AUTHORITY_WORKFLOW: undefined,
          AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "acme/governance",
          AIH_SUPPORTED_QUALIFICATION_WORKFLOW: "policy.yml",
        },
      ),
      {
        authority: verifiedAuthority,
        decisionReference: {
          id: value.id,
          digest: governanceDecisionDigestV2(value as never),
        },
        subject: value.subject,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        now: "2026-08-02T12:00:00Z",
      },
    );
    expect(result.problem).toMatch(/reuses the organization authority root/);
    expect(calls).toEqual([]);
  });

  it("rejects case-variant reuse of the verified authority repository before gh", async () => {
    const value = decision();
    const verifiedAuthority = await authority(value);
    writeReceipt(receipt(value));
    const calls: string[][] = [];
    const result = await verifyAihSupportedQualificationReceiptV2(
      context(
        (argv) => {
          calls.push(argv);
          return { code: 0 };
        },
        { AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "Acme/Governance" },
      ),
      {
        authority: verifiedAuthority,
        decisionReference: {
          id: value.id,
          digest: governanceDecisionDigestV2(value as never),
        },
        subject: value.subject,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        now: "2026-08-02T12:00:00Z",
      },
    );
    expect(result.problem).toMatch(/reuses the organization authority root/);
    expect(calls).toEqual([]);
  });

  it("allows support provenance to predate a current decision while capping the token at receipt expiry", async () => {
    const value = decision();
    const verifiedAuthority = await authority(value);
    writeReceipt(
      receipt(value, {
        issuedAt: "2026-07-25T00:00:00Z",
        notBefore: "2026-08-01T00:00:00Z",
        expiresAt: "2026-08-02T13:00:00Z",
        catalogContinuity: {
          ...receipt(value).catalogContinuity,
          headValidFrom: "2026-07-25T00:00:00Z",
          headValidUntil: "2026-08-02T13:00:00Z",
        },
      }),
    );
    const input = {
      authority: verifiedAuthority,
      decisionReference: {
        id: value.id,
        digest: governanceDecisionDigestV2(value as never),
      },
      subject: value.subject,
      target: "claude" as const,
      effect: "configure" as const,
      supportedTargets: ["claude"],
      now: "2026-08-02T12:00:00Z",
    };
    const result = await verifyAihSupportedQualificationReceiptV2(
      context((argv) => ({ code: argv[0] === trustedSupportedGh ? 0 : 1 })),
      input,
    );
    expect(result.qualification).toBeDefined();
    const currentObservation = observation(value);
    const verifiedObservation = verifyUpstreamObservationV1({
      receipt: currentObservation,
      expectedVerifier: currentObservation.verifier,
      expectedInstalled: currentObservation.installed,
      expectedIntegration: currentObservation.integration,
      subject: value.subject,
      target: "claude",
      effect: "configure",
      supportedTargets: ["claude"],
      now: input.now,
      verify: () => true,
    });
    expect(
      resolveObservedEffect({
        ...input,
        qualification: result.qualification,
        observation: verifiedObservation,
        expectedVerifier: currentObservation.verifier,
        expectedInstalled: currentObservation.installed,
        expectedIntegration: currentObservation.integration,
        now: "2026-08-02T13:00:00Z",
      }),
    ).toMatchObject({ state: "qualification-mismatch" });
  });

  it("refuses supported receipts expired before now or not yet valid", async () => {
    const value = decision();
    const verifiedAuthority = await authority(value);
    const input = {
      authority: verifiedAuthority,
      decisionReference: {
        id: value.id,
        digest: governanceDecisionDigestV2(value as never),
      },
      subject: value.subject,
      target: "claude" as const,
      effect: "configure" as const,
      supportedTargets: ["claude"],
      now: "2026-08-02T12:00:00Z",
    };
    const invalidReceipts: Array<[string, ReturnType<typeof receipt>]> = [
      ["expires before now", receipt(value, { expiresAt: "2026-08-02T11:59:59Z" })],
      [
        "notBefore is after now",
        receipt(value, {
          notBefore: "2026-08-02T12:00:01Z",
          expiresAt: "2026-08-03T00:00:00Z",
        }),
      ],
      [
        "expired window precedes the current decision",
        receipt(value, {
          issuedAt: "2026-07-20T00:00:00Z",
          notBefore: "2026-07-20T00:00:00Z",
          expiresAt: "2026-07-21T00:00:00Z",
        }),
      ],
    ];
    for (const [condition, invalidReceipt] of invalidReceipts) {
      writeReceipt(invalidReceipt);
      const result = await verifyAihSupportedQualificationReceiptV2(
        context((argv) => ({ code: argv[0] === trustedSupportedGh ? 0 : 1 })),
        input,
      );
      expect(result.problem, condition).toBeDefined();
      expect(result.qualification, condition).toBeUndefined();
    }
  });

  it("requires the supported receipt validity window to stay within the current decision", async () => {
    const value = decision();
    const verifiedAuthority = await authority(value);
    const input = {
      authority: verifiedAuthority,
      decisionReference: {
        id: value.id,
        digest: governanceDecisionDigestV2(value as never),
      },
      subject: value.subject,
      target: "claude" as const,
      effect: "configure" as const,
      supportedTargets: ["claude"],
      now: "2026-08-02T12:00:00Z",
    };
    const outsideDecisionWindows: Array<[string, ReturnType<typeof receipt>]> = [
      ["expires after the current decision", receipt(value, { expiresAt: "2026-08-10T00:00:01Z" })],
      [
        "starts before the current decision",
        receipt(value, {
          issuedAt: "2026-07-31T00:00:00Z",
          notBefore: "2026-07-31T00:00:00Z",
        }),
      ],
    ];
    for (const [condition, outsideDecisionWindow] of outsideDecisionWindows) {
      writeReceipt(outsideDecisionWindow);
      const result = await verifyAihSupportedQualificationReceiptV2(
        context((argv) => ({ code: argv[0] === trustedSupportedGh ? 0 : 1 })),
        input,
      );
      expect(result.problem, condition).toBeDefined();
      expect(result.qualification, condition).toBeUndefined();
    }
  });

  it("fails closed for roots, custody, attestation, receipt, and binding substitutions", async () => {
    const value = decision();
    const verifiedAuthority = await authority(value);
    const workflowAuthority = await authority(value, "policy.yml");
    writeReceipt(receipt(value));
    const input = {
      authority: verifiedAuthority,
      decisionReference: {
        id: value.id,
        digest: governanceDecisionDigestV2(value as never),
      },
      subject: value.subject,
      target: "claude" as const,
      effect: "configure" as const,
      supportedTargets: ["claude"],
      now: "2026-08-02T12:00:00Z",
    };
    for (const { authority: rootAuthority, env } of [
      {
        authority: verifiedAuthority,
        env: { AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "" },
      },
      {
        authority: verifiedAuthority,
        env: { AIH_SUPPORTED_QUALIFICATION_WORKFLOW: "" },
      },
      {
        authority: verifiedAuthority,
        env: { AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "acme/governance" },
      },
      {
        authority: workflowAuthority,
        env: { AIH_SUPPORTED_QUALIFICATION_WORKFLOW: "policy.yml" },
      },
    ]) {
      await expect(
        verifyAihSupportedQualificationReceiptV2(
          context(() => ({ code: 0 }), env),
          { ...input, authority: rootAuthority },
        ),
      ).resolves.toMatchObject({
        problem: expect.any(String),
      });
    }
    const rootCalls: string[][] = [];
    await expect(
      verifyAihSupportedQualificationReceiptV2(
        context(
          (argv) => {
            rootCalls.push(argv);
            return { code: 0 };
          },
          { AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "" },
        ),
        input,
      ),
    ).resolves.toMatchObject({ problem: expect.any(String) });
    expect(rootCalls).toEqual([]);
    writeFileSync(join(dir, ".aih", "aih-supported-qualification-receipt.json"), "{not-json");
    const malformedCalls: string[][] = [];
    await expect(
      verifyAihSupportedQualificationReceiptV2(
        context((argv) => {
          malformedCalls.push(argv);
          return { code: 0 };
        }),
        input,
      ),
    ).resolves.toMatchObject({ problem: expect.any(String) });
    expect(malformedCalls).toHaveLength(1);
    for (const changed of [
      receipt(value, { subject: { ...value.subject, id: "other-tool" } }),
      receipt(value, {
        subject: {
          ...value.subject,
          source: { ...value.subject.source, path: "other.json" },
        },
      }),
      receipt(value, {
        qualificationBasis: {
          ...value.qualificationBasis,
          catalogSignerIdentity: "other",
        },
      }),
      receipt(value, {
        qualificationBasis: {
          ...value.qualificationBasis,
          catalogDigest: `sha256:${"0".repeat(64)}`,
        },
      }),
      receipt(value, {
        qualificationBasis: {
          ...value.qualificationBasis,
          catalogHeadDigest: `sha256:${"0".repeat(64)}`,
        },
      }),
      receipt(value, {
        qualificationBasis: {
          ...value.qualificationBasis,
          catalogMemberDigest: `sha256:${"0".repeat(64)}`,
        },
      }),
      receipt(value, {
        qualificationBasis: {
          ...value.qualificationBasis,
          subjectKind: "skill",
        },
      }),
      receipt(value, {
        qualificationBasis: {
          ...value.qualificationBasis,
          subjectDigest: `sha256:${"0".repeat(64)}`,
        },
      }),
    ]) {
      writeReceipt(changed);
      await expect(
        verifyAihSupportedQualificationReceiptV2(
          context((argv) => ({ code: argv[0] === trustedSupportedGh ? 0 : 1 })),
          input,
        ),
      ).resolves.toMatchObject({
        problem: expect.any(String),
      });
    }
    writeReceipt(receipt(value));
    await expect(
      verifyAihSupportedQualificationReceiptV2(
        context(() => ({ code: 1 })),
        input,
      ),
    ).resolves.toMatchObject({ problem: expect.any(String) });
    await expect(
      verifyAihSupportedQualificationReceiptV2(
        context(() => ({ code: 0, spawnError: true })),
        input,
      ),
    ).resolves.toMatchObject({ problem: expect.any(String) });
    const organizationDecision = decision({
      qualificationBasis: {
        kind: "organization-qualified",
        evidenceDigest: `sha256:${"e".repeat(64)}`,
        attestor: "aih-catalog-service",
      },
    });
    const organizationAuthority = await authority(organizationDecision);
    writeReceipt(
      receipt(organizationDecision, {
        qualificationBasis: value.qualificationBasis,
      }),
    );
    await expect(
      verifyAihSupportedQualificationReceiptV2(
        context((argv) => ({ code: argv[0] === trustedSupportedGh ? 0 : 1 })),
        {
          ...input,
          authority: organizationAuthority,
          decisionReference: {
            id: organizationDecision.id,
            digest: governanceDecisionDigestV2(organizationDecision as never),
          },
        },
      ),
    ).resolves.toMatchObject({ problem: expect.any(String) });
  });

  it("fails if the externally invoked verifier mutates its exact private receipt copy", async () => {
    const value = decision();
    const verifiedAuthority = await authority(value);
    writeReceipt(receipt(value));
    const result = await verifyAihSupportedQualificationReceiptV2(
      context((argv) => {
        if (argv[0] === trustedSupportedGh) {
          writeFileSync(argv[3] ?? "", "mutated");
          return { code: 0 };
        }
        return { code: 1 };
      }),
      {
        authority: verifiedAuthority,
        decisionReference: {
          id: value.id,
          digest: governanceDecisionDigestV2(value as never),
        },
        subject: value.subject,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        now: "2026-08-02T12:00:00Z",
      },
    );
    expect(result).toMatchObject({
      problem: "supported qualification receipt changed during verification",
    });
  });

  it("re-reads the original fixed receipt after verification and rejects substitution", async () => {
    const value = decision();
    const verifiedAuthority = await authority(value);
    writeReceipt(receipt(value));
    const result = await verifyAihSupportedQualificationReceiptV2(
      context((argv) => {
        if (argv[0] === trustedSupportedGh) {
          writeReceipt(receipt(value, { entryId: "substituted-entry" }));
          return { code: 0 };
        }
        return { code: 1 };
      }),
      {
        authority: verifiedAuthority,
        decisionReference: {
          id: value.id,
          digest: governanceDecisionDigestV2(value as never),
        },
        subject: value.subject,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        now: "2026-08-02T12:00:00Z",
      },
    );
    expect(result).toEqual({
      problem: "supported qualification receipt changed during verification",
    });
  });

  it("resists source swaps and only admits the opaque supported capability to the resolver", async () => {
    const value = decision();
    const verifiedAuthority = await authority(value);
    writeReceipt(receipt(value));
    const input = {
      authority: verifiedAuthority,
      decisionReference: {
        id: value.id,
        digest: governanceDecisionDigestV2(value as never),
      },
      subject: value.subject,
      target: "claude" as const,
      effect: "configure" as const,
      supportedTargets: ["claude"],
      now: "2026-08-02T12:00:00Z",
    };
    const minted = await verifyAihSupportedQualificationReceiptV2(
      context((argv) => ({ code: argv[0] === trustedSupportedGh ? 0 : 1 })),
      input,
    );
    if (minted.qualification === undefined) throw new Error(minted.problem);
    const currentObservation = observation(value);
    const verifiedObservation = verifyUpstreamObservationV1({
      receipt: currentObservation,
      expectedVerifier: currentObservation.verifier,
      expectedInstalled: currentObservation.installed,
      expectedIntegration: currentObservation.integration,
      subject: value.subject,
      target: "claude",
      effect: "configure",
      supportedTargets: ["claude"],
      now: input.now,
      verify: () => true,
    });
    expect(verifiedObservation).toBeDefined();
    const resolverInput = {
      ...input,
      observation: verifiedObservation,
      expectedVerifier: currentObservation.verifier,
      expectedInstalled: currentObservation.installed,
      expectedIntegration: currentObservation.integration,
    };
    expect(
      resolveObservedEffect({
        ...resolverInput,
        qualification: minted.qualification,
      }),
    ).toMatchObject({
      state: "observed-effective",
    });
    for (const forged of [{ ...minted.qualification }, structuredClone(minted.qualification)]) {
      expect(resolveObservedEffect({ ...resolverInput, qualification: forged })).toMatchObject({
        state: "qualification-unverified",
      });
    }
  });

  it("rejects symlinked receipt parents and leaves candidate execution absent", async () => {
    const value = decision();
    const verifiedAuthority = await authority(value);
    const outside = mkdtempSync(join(tmpdir(), "aih-supported-receipt-outside-"));
    writeFileSync(
      join(outside, "aih-supported-qualification-receipt.json"),
      canonicalBytes(receipt(value)),
    );
    rmSync(join(dir, ".aih"), { recursive: true, force: true });
    symlinkSync(outside, join(dir, ".aih"), process.platform === "win32" ? "junction" : "dir");
    const calls: string[][] = [];
    const result = await verifyAihSupportedQualificationReceiptV2(
      context((argv) => {
        calls.push(argv);
        return { code: 0 };
      }),
      {
        authority: verifiedAuthority,
        decisionReference: {
          id: value.id,
          digest: governanceDecisionDigestV2(value as never),
        },
        subject: value.subject,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        now: "2026-08-02T12:00:00Z",
      },
    );
    expect(result.problem).toMatch(/symlinked parent/);
    expect(calls).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects a symlinked receipt file before it can reach the verifier", async () => {
    const value = decision();
    const verifiedAuthority = await authority(value);
    const outside = mkdtempSync(join(tmpdir(), "aih-supported-receipt-file-"));
    const outsideReceipt = join(outside, "receipt.json");
    writeFileSync(outsideReceipt, canonicalBytes(receipt(value)));
    symlinkSync(outsideReceipt, join(dir, ".aih", "aih-supported-qualification-receipt.json"));
    const calls: string[][] = [];
    const result = await verifyAihSupportedQualificationReceiptV2(
      context((argv) => {
        calls.push(argv);
        return { code: 0 };
      }),
      {
        authority: verifiedAuthority,
        decisionReference: {
          id: value.id,
          digest: governanceDecisionDigestV2(value as never),
        },
        subject: value.subject,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        now: "2026-08-02T12:00:00Z",
      },
    );
    expect(result.problem).toMatch(/unsafe symlink/);
    expect(calls).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });
});
