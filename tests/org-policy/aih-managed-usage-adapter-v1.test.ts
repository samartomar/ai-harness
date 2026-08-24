import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import { executePlan } from "../../src/internals/execute.js";
import { hermeticGitEnv } from "../../src/internals/git-env.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { defaultRunner, fakeRunner, type Runner } from "../../src/internals/proc.js";
import {
  AIH_MANAGED_USAGE_RECEIPT_V4_PATH,
  aihManagedUsageAdapterPlanV1,
  applyAihManagedUsageAdapterV1,
  describeAihManagedUsageAdapterV1,
  executeAihManagedUsageAdapterV1,
  inspectAihManagedUsageAdapterV1,
  resolveAihManagedUsageAdapterV1,
} from "../../src/org-policy/aih-managed-usage-adapter-v1.js";
import {
  canonicalDigest,
  configuredOutputsMatchV4,
  exactOutputTextsV4,
  outputDigestsV4,
  parseAihManagedUsageReceiptV4,
  resolveAihManagedUsageRevocationV1,
  sha256,
} from "../../src/org-policy/aih-managed-usage-audit-v1.js";
import { aihManagedUsagePlanResultV1 } from "../../src/org-policy/aih-managed-usage-result-v1.js";
import { revokeAihManagedUsageAdapterTransactionV1 } from "../../src/org-policy/aih-managed-usage-revocation-v1.js";
import { verifyPolicyAuthorityReceipt } from "../../src/org-policy/authority.js";
import {
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../src/org-policy/governance-decision-v2.js";
import { aihManagedUsageExpectedHostHookV4 } from "../../src/org-policy/project.js";
import {
  canonicalOrganizationEvidenceEnvelopeV1,
  organizationEvidenceEnvelopeDigestV1,
} from "../../src/org-policy/qualification-v1.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { usageRecorderScript } from "../../src/usage/capture.js";

let root: string;
let bin: string;
let gh: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
  root = mkdtempSync(join(tmpdir(), "aih-managed-usage-adapter-"));
  bin = mkdtempSync(join(tmpdir(), "aih-managed-usage-gh-"));
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
  const descriptor = describeAihManagedUsageAdapterV1();
  const evidence = {
    format: "aih-organization-evidence" as const,
    version: 1 as const,
    subjectDigest: descriptor.subject.subjectDigest,
    evidence: {
      kind: "assessment",
      id: "usage-review",
      summary: "The organization reviewed this exact AIH usage-metering artifact.",
      payloadDigest: `sha256:${"1".repeat(64)}`,
      artifactDigests: [`sha256:${"2".repeat(64)}`],
    },
    attestor: "scanner-service",
    issuedAt: "2026-08-24T00:00:00Z",
    notBefore: "2026-08-24T00:00:00Z",
    expiresAt: "2026-08-25T00:00:00Z",
  };
  const evidenceDigest = organizationEvidenceEnvelopeDigestV1(evidence);
  const decision = {
    format: "aih-governance-decision" as const,
    version: 2 as const,
    id: "decision-usage-metering",
    qualificationBasis: {
      kind: "organization-qualified" as const,
      evidenceDigest,
      attestor: "scanner-service",
    },
    subject: descriptor.subject,
    targets: ["claude", "codex"],
    allowedEffects: ["configure" as const],
    policy: { id: "platform-policy", version: "2026.08", digest: `sha256:${"a".repeat(64)}` },
    control: { id: "review-control", digest: `sha256:${"b".repeat(64)}` },
    evidence: { id: "usage-review", digest: evidenceDigest, attestor: "scanner-service" },
    issuer: "platform-security",
    actor: "security-admin",
    reason: "The exact fixed AIH hook is approved.",
    issuedAt: "2026-08-24T00:00:00Z",
    notBefore: "2026-08-24T00:00:00Z",
    expiresAt: "2026-08-25T00:00:00Z",
    disposition: "approved" as const,
    acceptedFindings: [],
    acceptedGaps: [],
    conditions: [],
  };
  const digest = governanceDecisionDigestV2(decision);
  return { decision, digest, evidence };
}

function writeAuthority(
  value: ReturnType<typeof fixture>,
  decisionRevocations: readonly Record<string, unknown>[] = [],
): void {
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
      issuedAt: "2026-08-24T00:00:00Z",
      expiresAt: "2026-08-25T00:00:00Z",
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
      targets: ["claude", "codex"],
      decisions: [value.decision],
      decisionRevocations,
    }),
  );
}

function context(apply = false): PlanContext {
  const run = fakeRunner((argv) => (argv[0] === gh ? { code: 0 } : { code: 1 }));
  return {
    root,
    contextDir: "ai-coding",
    apply,
    verify: false,
    json: true,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
    options: {},
  };
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: hermeticGitEnv(),
  }).trim();
}

function initializeGit(): void {
  git("init", "-q");
  git("config", "user.name", "AIH test");
  git("config", "user.email", "aih-test@example.invalid");
  git("add", "evidence.json", ".aih/policy-authority-receipt.json");
  git("commit", "-q", "-m", "fixture authority");
}

function gitAwareContext(apply = false): PlanContext {
  const run: Runner = (argv, options) =>
    argv[0] === gh
      ? Promise.resolve({ code: 0, stdout: "", stderr: "" })
      : defaultRunner(argv, options);
  const env = {
    ...process.env,
    AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance",
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
  return {
    root,
    contextDir: "ai-coding",
    apply,
    verify: false,
    json: true,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
    options: {},
  };
}

describe("AIH-managed usage adapter V1", () => {
  it("derives one fixed configure descriptor from packed Core code", async () => {
    const descriptor = describeAihManagedUsageAdapterV1();
    const sourceDigest = governanceDecisionSourceDigestV2(descriptor.subject.source);

    expect(descriptor).toEqual({
      adapter: {
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        id: "aih-usage-metering",
        version: "1.0.0",
      },
      effect: "configure",
      subject: {
        id: "usage-metering",
        kind: "tool",
        source: {
          release: "6.1.0",
          revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          type: "aih",
        },
        sourceDigest,
        subjectDigest: governanceDecisionSubjectDigestV2({
          id: "usage-metering",
          kind: "tool",
          sourceDigest,
        }),
      },
      targets: ["claude", "codex"],
    });
    expect(descriptor.subject.source.revision).toBe(
      canonicalDigest("aih-managed-usage-source/v1\0", {
        hooks: descriptor.targets.map((target) => ({
          target,
          ...aihManagedUsageExpectedHostHookV4(target),
        })),
        recorder: usageRecorderScript(),
      }),
    );
    expect(descriptor.adapter.digest).toBe(
      `sha256:${createHash("sha256")
        .update("aih-managed-usage-adapter/v1\0", "utf8")
        .update(
          canonicalStrictJsonBytesV1({
            effect: descriptor.effect,
            id: descriptor.adapter.id,
            source: descriptor.subject.source,
            targets: descriptor.targets,
            version: descriptor.adapter.version,
          }),
        )
        .digest("hex")}`,
    );
  });

  it("requires V3 organization authority and qualification before the fixed apply", async () => {
    const value = fixture();
    writeAuthority(value);
    const request = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude" as const,
    };

    await expect(verifyPolicyAuthorityReceipt(context())).resolves.toMatchObject({
      authority: expect.any(Object),
    });

    await expect(resolveAihManagedUsageAdapterV1(context(), request)).resolves.toMatchObject({
      authority: "verified",
      qualification: "organization-qualified",
      outcome: "reported-only",
    });
    await expect(executeAihManagedUsageAdapterV1(context(true), request)).resolves.toMatchObject({
      applied: true,
      writes: expect.arrayContaining([
        expect.objectContaining({ path: AIH_MANAGED_USAGE_RECEIPT_V4_PATH, effect: "create" }),
        expect.objectContaining({ path: AIH_MANAGED_USAGE_RECEIPT_V4_PATH, effect: "overwrite" }),
        expect.objectContaining({ path: ".aih/usage-record.mjs" }),
      ]),
      digests: expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            domain: expect.objectContaining({ outcome: "fulfilled" }),
          }),
        }),
      ]),
    });
    expect(readFileSync(join(root, ".aih", "usage-record.mjs"), "utf8")).toBe(
      usageRecorderScript(),
    );
    expect(
      JSON.parse(readFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), "utf8")),
    ).toMatchObject({
      state: "configured",
      target: "claude",
      outputs: expect.arrayContaining([
        { path: ".aih/usage-record.mjs", sha256: expect.any(String) },
      ]),
    });
    const configured = readFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), "utf8");
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "configured" });
    await expect(applyAihManagedUsageAdapterV1(context(true), request)).resolves.toMatchObject({
      outcome: "fulfilled",
    });
    expect(readFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), "utf8")).toBe(configured);
  });

  it("rejects untrusted request shape and a tampered V4 self-digest without effects", async () => {
    const value = fixture();
    writeAuthority(value);
    const valid = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude",
    };
    await expect(
      resolveAihManagedUsageAdapterV1(context(), {
        ...valid,
        path: ".claude/settings.json",
      } as never),
    ).resolves.toMatchObject({ outcome: "refused", reason: "invalid-input" });
    await expect(
      resolveAihManagedUsageAdapterV1(context(), { ...valid, effect: "execute" } as never),
    ).resolves.toMatchObject({ outcome: "refused", reason: "invalid-input" });
    await expect(
      resolveAihManagedUsageAdapterV1(context(), { ...valid, target: "cursor" }),
    ).resolves.toMatchObject({ outcome: "refused", reason: "invalid-input" });
    await expect(
      resolveAihManagedUsageAdapterV1(
        context(),
        Object.assign(Object.create(null), valid) as never,
      ),
    ).resolves.toMatchObject({ outcome: "refused", reason: "invalid-input" });
    await executeAihManagedUsageAdapterV1(context(true), valid);
    const receipt = JSON.parse(readFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), "utf8"));
    receipt.selfDigest = `sha256:${"0".repeat(64)}`;
    writeFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), JSON.stringify(receipt));
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "invalid" });
    for (const version of [1, 2, 3]) {
      writeFileSync(
        join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH),
        JSON.stringify({ format: "aih-org-policy-hook-receipt", version }),
      );
      expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "invalid" });
    }
  });

  it("refreshes only the self-digested custody record for a current qualified decision and rejects oversized or unbounded history receipts", async () => {
    const value = fixture();
    writeAuthority(value);
    const request = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude" as const,
    };
    await expect(applyAihManagedUsageAdapterV1(context(true), request)).resolves.toMatchObject({
      outcome: "fulfilled",
    });
    const recorder = readFileSync(join(root, ".aih", "usage-record.mjs"), "utf8");
    const originalReceipt = readFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), "utf8");

    const refreshed = fixture();
    refreshed.decision.actor = "security-admin-refresh";
    refreshed.digest = governanceDecisionDigestV2(refreshed.decision);
    writeAuthority(refreshed);
    const refreshedRequest = { ...request, digest: refreshed.digest };
    await expect(
      applyAihManagedUsageAdapterV1(context(true), refreshedRequest),
    ).resolves.toMatchObject({ outcome: "fulfilled" });
    const refreshedReceipt = readFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), "utf8");
    expect(refreshedReceipt).not.toBe(originalReceipt);
    expect(readFileSync(join(root, ".aih", "usage-record.mjs"), "utf8")).toBe(recorder);
    expect(JSON.parse(refreshedReceipt)).toMatchObject({
      state: "configured",
      history: expect.arrayContaining([expect.objectContaining({ state: "configured" })]),
    });

    const receipt = JSON.parse(refreshedReceipt) as Record<string, unknown>;
    const history = (receipt.history as readonly unknown[]).at(-1);
    receipt.history = Array.from({ length: 9 }, () => history);
    const { selfDigest: _ignored, ...unsigned } = receipt;
    receipt.selfDigest = `sha256:${createHash("sha256")
      .update("aih-org-policy-hook-receipt/v4\0", "utf8")
      .update(canonicalStrictJsonBytesV1(unsigned))
      .digest("hex")}`;
    writeFileSync(
      join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH),
      canonicalStrictJsonBytesV1(receipt),
    );
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "invalid" });

    writeFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), "x".repeat(65_537));
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "invalid" });
  });

  it("uses a current externally attested exact V3 revocation to claim, remove, and retain bounded revoked custody", async () => {
    const value = fixture();
    writeAuthority(value);
    const request = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude" as const,
    };
    await expect(applyAihManagedUsageAdapterV1(context(true), request)).resolves.toMatchObject({
      outcome: "fulfilled",
    });

    writeAuthority(value, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: value.digest,
        issuer: value.decision.issuer,
        revokedAt: "2026-08-24T00:00:00.000Z",
        reason: "The organization revoked this exact fixed adapter decision.",
      },
    ]);

    await expect(
      resolveAihManagedUsageAdapterV1(context(), { ...request, evidence: "" }),
    ).resolves.toMatchObject({ outcome: "reported-only", reason: "revoked" });
    await expect(
      applyAihManagedUsageAdapterV1(context(true), { ...request, evidence: "" }),
    ).resolves.toMatchObject({
      outcome: "fulfilled",
      reason: "revoked",
    });
    expect(existsSync(join(root, ".aih", "usage-record.mjs"))).toBe(false);
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "revoked" });
    expect(
      JSON.parse(readFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), "utf8")),
    ).toMatchObject({
      state: "revoked",
      history: expect.arrayContaining([
        expect.objectContaining({ state: "revoking" }),
        expect.objectContaining({ state: "revoked" }),
      ]),
    });
  });

  it("preserves an administrator-owned empty hooks object and rejects a hard-linked receipt", async () => {
    const value = fixture();
    writeAuthority(value);
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), '{"admin":"keep","hooks":{}}');
    const request = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude" as const,
    };
    await expect(applyAihManagedUsageAdapterV1(context(true), request)).resolves.toMatchObject({
      outcome: "fulfilled",
    });
    // The receipt is self-digested audit transport. Flipping its claimed
    // pre-existence must never authorize deletion of co-owned host/ignore files.
    const receiptPath = join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    const ownership = receipt.ownership as { entries: Array<Record<string, unknown>> };
    for (const entry of ownership.entries) {
      if (entry.kind === "json-hook") {
        entry.preExisting = "absent";
        entry.hooksPresent = false;
      }
      if (entry.path === ".gitignore") entry.preExisting = "absent";
    }
    const { selfDigest: _priorDigest, ...unsignedReceipt } = receipt;
    receipt.selfDigest = canonicalDigest("aih-org-policy-hook-receipt/v4\0", unsignedReceipt);
    writeFileSync(receiptPath, canonicalStrictJsonBytesV1(receipt));
    writeAuthority(value, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: value.digest,
        issuer: value.decision.issuer,
        revokedAt: "2026-08-24T00:00:00.000Z",
        reason: "The organization revoked this exact fixed adapter decision.",
      },
    ]);
    await expect(
      applyAihManagedUsageAdapterV1(context(true), { ...request, evidence: "" }),
    ).resolves.toMatchObject({
      outcome: "fulfilled",
      reason: "revoked",
    });
    expect(JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"))).toEqual({
      admin: "keep",
      hooks: {},
    });
    expect(existsSync(join(root, ".gitignore"))).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("");

    // The custody parser reads via a descriptor-bound regular-file open and
    // refuses multiple-link receipt transport rather than following it.
    const receiptHardlinkPath = join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH);
    linkSync(receiptHardlinkPath, join(root, ".aih", "receipt-hardlink-copy.json"));
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "invalid" });
  });

  it("rejects stale evidence and a self-digested forged ownership snapshot before effects", async () => {
    const value = fixture();
    const stale = fixture();
    stale.evidence.expiresAt = "2026-08-24T11:59:59Z";
    const staleEvidenceDigest = organizationEvidenceEnvelopeDigestV1(stale.evidence);
    stale.decision.qualificationBasis.evidenceDigest = staleEvidenceDigest;
    stale.decision.evidence.digest = staleEvidenceDigest;
    stale.digest = governanceDecisionDigestV2(stale.decision);
    writeAuthority(stale);
    await expect(
      resolveAihManagedUsageAdapterV1(context(), {
        decision: stale.decision.id,
        digest: stale.digest,
        evidence: "evidence.json",
        target: "claude",
      }),
    ).resolves.toMatchObject({ outcome: "refused", reason: "qualification-unverified" });
    writeAuthority(value);
    const request = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude" as const,
    };
    await expect(
      resolveAihManagedUsageAdapterV1(context(), {
        ...request,
        digest: `sha256:${"0".repeat(64)}`,
      }),
    ).resolves.toMatchObject({ outcome: "refused", reason: "descriptor-mismatch" });
    await expect(applyAihManagedUsageAdapterV1(context(true), request)).resolves.toMatchObject({
      outcome: "fulfilled",
    });
    const path = join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH);
    const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const ownership = receipt.ownership as { entries: Array<Record<string, unknown>> };
    const host = ownership.entries.find((entry) => entry.kind === "json-hook");
    if (host === undefined) throw new Error("fixture did not create a host ownership entry");
    host.expectedPostToolUse = [{ hooks: [{ command: "caller-controlled" }] }];
    const { selfDigest: _ignored, ...unsigned } = receipt;
    receipt.selfDigest = canonicalDigest("aih-org-policy-hook-receipt/v4\0", unsigned);
    writeFileSync(path, canonicalStrictJsonBytesV1(receipt));
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "invalid" });
    await expect(applyAihManagedUsageAdapterV1(context(true), request)).resolves.toMatchObject({
      outcome: "partial",
      reason: "recovery-required",
    });
    expect(readFileSync(join(root, ".aih", "usage-record.mjs"), "utf8")).toBe(
      usageRecorderScript(),
    );
  });

  it("records a reissued revoked authority without effects and marks recreated fixed output drifted", async () => {
    const value = fixture();
    writeAuthority(value);
    const request = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude" as const,
    };
    await applyAihManagedUsageAdapterV1(context(true), request);
    const revocation = {
      format: "aih-governance-decision-revocation",
      version: 2,
      decisionDigest: value.digest,
      issuer: value.decision.issuer,
      revokedAt: "2026-08-24T00:00:00.000Z",
      reason: "The organization revoked this exact fixed adapter decision.",
    };
    writeAuthority(value, [revocation]);
    await expect(
      applyAihManagedUsageAdapterV1(context(true), { ...request, evidence: "" }),
    ).resolves.toMatchObject({
      outcome: "fulfilled",
      reason: "revoked",
    });
    const first = readFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), "utf8");
    const authority = JSON.parse(
      readFileSync(join(root, ".aih", "policy-authority-receipt.json"), "utf8"),
    );
    authority.issuedAt = "2026-08-24T01:00:00Z";
    writeFileSync(join(root, ".aih", "policy-authority-receipt.json"), JSON.stringify(authority));
    await expect(
      applyAihManagedUsageAdapterV1(context(true), { ...request, evidence: "" }),
    ).resolves.toMatchObject({
      outcome: "fulfilled",
      reason: "revoked",
    });
    const refreshed = readFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), "utf8");
    expect(refreshed).not.toBe(first);
    await applyAihManagedUsageAdapterV1(context(true), { ...request, evidence: "" });
    expect(readFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), "utf8")).toBe(refreshed);
    writeFileSync(join(root, ".aih", "usage-record.mjs"), usageRecorderScript());
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "drifted" });
    await expect(
      applyAihManagedUsageAdapterV1(context(true), { ...request, evidence: "" }),
    ).resolves.toMatchObject({ outcome: "partial", reason: "post-effect-drift" });
    expect(readFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), "utf8")).toBe(refreshed);
  });

  it("rejects a hard-linked owned output and an audit event replayed beneath a new top-level receipt", async () => {
    const value = fixture();
    writeAuthority(value);
    const request = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude" as const,
    };
    await expect(applyAihManagedUsageAdapterV1(context(true), request)).resolves.toMatchObject({
      outcome: "fulfilled",
    });
    const recorder = join(root, ".aih", "usage-record.mjs");
    linkSync(recorder, join(root, ".aih", "usage-record-hardlink-copy.mjs"));
    await expect(applyAihManagedUsageAdapterV1(context(true), request)).resolves.toMatchObject({
      outcome: "partial",
      reason: "post-effect-drift",
    });
    rmSync(join(root, ".aih", "usage-record-hardlink-copy.mjs"));

    const path = join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH);
    const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const latest = (receipt.history as Array<Record<string, unknown>>).at(-1);
    if (latest === undefined) throw new Error("fixture did not create audit history");
    latest.authorityReceiptDigest = `sha256:${"e".repeat(64)}`;
    const { digest: _priorDigest, ...event } = latest;
    latest.digest = canonicalDigest("aih-org-policy-hook-receipt-history/v4\0", event);
    const { selfDigest: _priorSelfDigest, ...unsigned } = receipt;
    receipt.selfDigest = canonicalDigest("aih-org-policy-hook-receipt/v4\0", unsigned);
    writeFileSync(path, canonicalStrictJsonBytesV1(receipt));
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "invalid" });
  });

  it("does not let self-digested output hashes claim fixed configured semantics", async () => {
    const value = fixture();
    writeAuthority(value);
    const request = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude" as const,
    };
    await applyAihManagedUsageAdapterV1(context(true), request);
    const hostPath = join(root, ".claude", "settings.json");
    writeFileSync(hostPath, '{"hooks":{"PostToolUse":[{"hooks":[{"command":"forged"}]}]}}');
    const receiptPath = join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    const outputs = receipt.outputs as Array<{ path: string; sha256: string }>;
    const output = outputs.find((candidate) => candidate.path === ".claude/settings.json");
    if (output === undefined) throw new Error("fixture did not create host output identity");
    output.sha256 = sha256(readFileSync(hostPath));
    const latest = (receipt.history as Array<Record<string, unknown>>).at(-1);
    if (latest === undefined) throw new Error("fixture did not create audit history");
    latest.outputs = outputs;
    const { digest: _priorDigest, ...event } = latest;
    latest.digest = canonicalDigest("aih-org-policy-hook-receipt-history/v4\0", event);
    const { selfDigest: _priorSelfDigest, ...unsigned } = receipt;
    receipt.selfDigest = canonicalDigest("aih-org-policy-hook-receipt/v4\0", unsigned);
    writeFileSync(receiptPath, canonicalStrictJsonBytesV1(receipt));
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "drifted" });
  });

  it("reports only effective configured or revoked custody as successful", () => {
    expect(
      aihManagedUsagePlanResultV1(
        { outcome: "fulfilled", reason: "revoked" },
        { state: "revoked" },
        [],
      ).report?.exitCode(),
    ).toBe(0);
    expect(
      aihManagedUsagePlanResultV1(
        { outcome: "reported-only" },
        { state: "configured" },
        [],
      ).report?.exitCode(),
    ).toBe(0);
    expect(
      aihManagedUsagePlanResultV1(
        { outcome: "reported-only", reason: "revoked" },
        { state: "configured" },
        [],
      ).report?.exitCode(),
    ).toBe(1);
  });

  it("marks a symlinked/junction project root invalid even without a receipt", () => {
    const unsafeRoot = mkdtempSync(join(tmpdir(), "aih-managed-usage-unsafe-root-"));
    rmSync(unsafeRoot, { recursive: true, force: true });
    symlinkSync(root, unsafeRoot, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(inspectAihManagedUsageAdapterV1(unsafeRoot)).toMatchObject({ state: "invalid" });
    } finally {
      rmSync(unsafeRoot, { recursive: true, force: true });
    }
  });

  it("refuses an authority validity deadline without creating a custody claim", async () => {
    const value = fixture();
    writeAuthority(value);
    const authorityPath = join(root, ".aih", "policy-authority-receipt.json");
    const authority = JSON.parse(readFileSync(authorityPath, "utf8"));
    authority.expiresAt = "2026-08-24T12:00:00Z";
    writeFileSync(authorityPath, JSON.stringify(authority));
    await expect(
      applyAihManagedUsageAdapterV1(context(true), {
        decision: value.decision.id,
        digest: value.digest,
        evidence: "evidence.json",
        target: "claude",
      }),
    ).resolves.toMatchObject({ outcome: "refused" });
    expect(existsSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH))).toBe(false);
  });

  it("commits no custody claim after the authorized transaction window closes", async () => {
    const value = fixture();
    writeAuthority(value);
    let advanced = false;
    const run = fakeRunner((argv) => {
      if (argv[0] === gh) return { code: 0 };
      if (argv[0] === "git" && !advanced) {
        advanced = true;
        vi.advanceTimersByTime(60_001);
      }
      return { code: 1 };
    });
    const deadlineContext: PlanContext = {
      ...context(true),
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    };

    await expect(
      applyAihManagedUsageAdapterV1(deadlineContext, {
        decision: value.decision.id,
        digest: value.digest,
        evidence: "evidence.json",
        target: "claude",
      }),
    ).resolves.toMatchObject({ outcome: "partial", reason: "recovery-required" });
    expect(advanced).toBe(true);
    expect(existsSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH))).toBe(false);
  });

  it("does not begin authenticated revocation cleanup after the current authority deadline", async () => {
    const value = fixture();
    writeAuthority(value);
    const request = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude" as const,
    };
    await applyAihManagedUsageAdapterV1(context(true), request);
    writeAuthority(value, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: value.digest,
        issuer: value.decision.issuer,
        revokedAt: "2026-08-24T00:00:00.000Z",
        reason: "The organization revoked this exact fixed adapter decision.",
      },
    ]);
    const authorityPath = join(root, ".aih", "policy-authority-receipt.json");
    const authority = JSON.parse(readFileSync(authorityPath, "utf8"));
    authority.expiresAt = "2026-08-24T12:00:00Z";
    writeFileSync(authorityPath, JSON.stringify(authority));
    await expect(
      applyAihManagedUsageAdapterV1(context(true), { ...request, evidence: "" }),
    ).resolves.toMatchObject({ outcome: "refused" });
    expect(readFileSync(join(root, ".aih", "usage-record.mjs"), "utf8")).toBe(
      usageRecorderScript(),
    );
  });

  it("completes code-owned configure and revoke phases in a real Git worktree", async () => {
    const value = fixture();
    writeAuthority(value);
    initializeGit();
    const request = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude" as const,
    };

    await expect(
      applyAihManagedUsageAdapterV1(gitAwareContext(true), request),
    ).resolves.toMatchObject({ outcome: "fulfilled" });
    expect(git("status", "--porcelain", "-uall")).toContain(".aih/usage-record.mjs");

    writeAuthority(value, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: value.digest,
        issuer: value.decision.issuer,
        revokedAt: "2026-08-24T00:00:00.000Z",
        reason: "The organization revoked this exact fixed adapter decision.",
      },
    ]);
    await expect(
      applyAihManagedUsageAdapterV1(gitAwareContext(true), { ...request, evidence: "" }),
    ).resolves.toMatchObject({ outcome: "fulfilled", reason: "revoked" });
    expect(existsSync(join(root, ".aih", "usage-record.mjs"))).toBe(false);
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "revoked" });
  }, 60_000);

  it("keeps the ordinary worktree gate on pre-existing administrator output", async () => {
    const value = fixture();
    writeAuthority(value);
    writeFileSync(join(root, ".gitignore"), "committed-rule\n");
    initializeGit();
    git("add", ".gitignore");
    git("commit", "-q", "-m", "fixture ignore");
    writeFileSync(join(root, ".gitignore"), "administrator-uncommitted-rule\n");
    const request = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude" as const,
    };

    await expect(
      applyAihManagedUsageAdapterV1(gitAwareContext(true), request),
    ).rejects.toMatchObject({ code: "AIH_DIRTY_WORKTREE" });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("administrator-uncommitted-rule\n");
    expect(existsSync(join(root, ".aih", "usage-record.mjs"))).toBe(false);
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "claimed" });
    await expect(
      resolveAihManagedUsageAdapterV1(gitAwareContext(), request),
    ).resolves.toMatchObject({ outcome: "partial", reason: "recovery-required" });
  }, 60_000);

  it.each(["authority", "qualification evidence"] as const)(
    "does not commit fixed configuration when %s changes during the Git preflight",
    async (input) => {
      const value = fixture();
      writeAuthority(value);
      initializeGit();
      const ctx = gitAwareContext(true);
      const originalRun = ctx.run;
      let attestations = 0;
      let mutated = false;
      ctx.run = async (argv, options) => {
        if (argv[0] === "git" && argv.includes("status") && attestations === 2 && !mutated) {
          mutated = true;
          if (input === "authority") {
            const path = join(root, ".aih", "policy-authority-receipt.json");
            const authority = JSON.parse(readFileSync(path, "utf8"));
            authority.decisions = [];
            writeFileSync(path, JSON.stringify(authority));
          } else {
            writeFileSync(join(root, "evidence.json"), "{}\n");
          }
        }
        const result = await originalRun(argv, options);
        if (argv[0] === gh) attestations++;
        return result;
      };

      await expect(
        applyAihManagedUsageAdapterV1(ctx, {
          decision: value.decision.id,
          digest: value.digest,
          evidence: "evidence.json",
          target: "claude",
        }),
      ).resolves.toMatchObject({ outcome: "partial", reason: "recovery-required" });
      expect(mutated).toBe(true);
      expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "claimed" });
      expect(existsSync(join(root, ".aih", "usage-record.mjs"))).toBe(false);
    },
    60_000,
  );

  it("projects qualified and refused previews through the real plan boundary", async () => {
    const value = fixture();
    writeAuthority(value);
    const request = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude" as const,
    };
    const accepted = { ...context(), verify: true };
    const acceptedResult = await executePlan(
      aihManagedUsageAdapterPlanV1(accepted, request),
      accepted,
    );
    expect(acceptedResult.digests[0]?.data).toMatchObject({
      outcome: "reported-only",
      qualification: "organization-qualified",
    });
    expect(acceptedResult.report?.exitCode()).toBe(0);
    await expect(applyAihManagedUsageAdapterV1(context(), request)).resolves.toMatchObject({
      outcome: "reported-only",
      qualification: "organization-qualified",
    });

    const refused = { ...context(), verify: true };
    const refusedResult = await executePlan(
      aihManagedUsageAdapterPlanV1(refused, { ...request, evidence: "" }),
      refused,
    );
    expect(refusedResult.digests[0]?.data).toMatchObject({
      outcome: "refused",
      reason: "invalid-input",
    });
    expect(refusedResult.report?.exitCode()).toBe(1);

    const accessorRequest = {} as Record<string, unknown>;
    Object.defineProperties(accessorRequest, {
      decision: { value: value.decision.id, enumerable: true },
      digest: { value: value.digest, enumerable: true },
      evidence: { get: () => "evidence.json", enumerable: true },
      target: { value: "claude", enumerable: true },
    });
    await expect(
      resolveAihManagedUsageAdapterV1(context(), accessorRequest as never),
    ).resolves.toMatchObject({ outcome: "refused", reason: "invalid-input" });
  });

  it("fails closed across revocation recovery and malformed output custody branches", async () => {
    const value = fixture();
    writeAuthority(value);
    const request = {
      decision: value.decision.id,
      digest: value.digest,
      evidence: "evidence.json",
      target: "claude" as const,
    };
    await expect(applyAihManagedUsageAdapterV1(context(true), request)).resolves.toMatchObject({
      outcome: "fulfilled",
    });
    const descriptor = describeAihManagedUsageAdapterV1();
    const configured = parseAihManagedUsageReceiptV4(root, descriptor);
    if (configured === undefined) throw new Error("configured V4 receipt was not persisted");
    expect(exactOutputTextsV4(root, "claude")).toHaveLength(3);

    const invoke = (initial: typeof configured, ctx: PlanContext = context(true)) =>
      revokeAihManagedUsageAdapterTransactionV1({
        ctx,
        describe: describeAihManagedUsageAdapterV1,
        initial,
        phases: [],
      });
    await expect(
      invoke({
        ...configured,
        receipt: {
          ...configured.receipt,
          ownership: { entries: [] },
        } as typeof configured.receipt,
      }),
    ).resolves.toMatchObject({ outcome: "partial", reason: "recovery-required" });
    await expect(invoke(configured)).resolves.toMatchObject({
      outcome: "partial",
      reason: "recovery-required",
    });

    writeAuthority(value, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: value.digest,
        issuer: value.decision.issuer,
        revokedAt: "2026-08-24T00:00:00.000Z",
        reason: "The organization revoked this exact fixed adapter decision.",
      },
    ]);
    await expect(
      resolveAihManagedUsageAdapterV1(context(), { ...request, evidence: "" }),
    ).resolves.toMatchObject({ outcome: "reported-only", reason: "revoked" });
    await expect(
      applyAihManagedUsageAdapterV1(context(), { ...request, evidence: "" }),
    ).resolves.toMatchObject({ outcome: "reported-only", reason: "revoked" });
    const current = await resolveAihManagedUsageRevocationV1(context(), configured.receipt);
    if (current === undefined) throw new Error("current V3 revocation was not resolved");
    const revoking = {
      ...configured,
      receipt: {
        ...configured.receipt,
        authorityReceiptDigest: current.authorityReceiptDigest,
        state: "revoking" as const,
        revocation: current.revocation,
      },
    };
    await expect(
      invoke({
        ...revoking,
        receipt: { ...revoking.receipt, authorityReceiptDigest: sha256("stale authority") },
      }),
    ).resolves.toMatchObject({ outcome: "partial", reason: "recovery-required" });
    const driftContext = context(true);
    const driftRun = driftContext.run;
    let driftAttestations = 0;
    driftContext.run = async (argv, options) => {
      const result = await driftRun(argv, options);
      if (argv[0] === gh && ++driftAttestations === 2) {
        const path = join(root, ".aih", "policy-authority-receipt.json");
        const authority = JSON.parse(readFileSync(path, "utf8"));
        authority.decisions = [];
        writeFileSync(path, JSON.stringify(authority));
      }
      return result;
    };
    await expect(invoke(revoking, driftContext)).resolves.toMatchObject({
      outcome: "partial",
      reason: "recovery-required",
    });
    expect(driftAttestations).toBe(2);

    writeAuthority(value, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: value.digest,
        issuer: value.decision.issuer,
        revokedAt: "2026-08-24T00:00:00.000Z",
        reason: "The organization revoked this exact fixed adapter decision.",
      },
    ]);
    await expect(
      invoke({
        ...configured,
        receipt: {
          ...configured.receipt,
          state: "claimed",
          revocation: null,
        },
      }),
    ).resolves.toMatchObject({ outcome: "partial", reason: "recovery-required" });
    await expect(
      invoke({
        ...configured,
        receipt: {
          ...configured.receipt,
          state: "revoked",
          revocation: { ...current.revocation, digest: sha256("different revocation") },
        },
      }),
    ).resolves.toMatchObject({ outcome: "partial", reason: "recovery-required" });
    await expect(
      invoke({
        ...configured,
        receipt: {
          ...configured.receipt,
          state: "revoked",
          revocation: current.revocation,
        },
      }),
    ).resolves.toMatchObject({ outcome: "partial", reason: "post-effect-drift" });

    writeFileSync(join(root, ".aih", "usage-record.mjs"), "tampered recorder\n");
    await expect(invoke(configured)).resolves.toMatchObject({
      outcome: "partial",
      reason: "post-effect-drift",
    });
    writeFileSync(join(root, ".aih", "usage-record.mjs"), usageRecorderScript());

    writeFileSync(join(root, ".claude", "settings.json"), "{");
    const malformedOutputs = outputDigestsV4(root, "claude");
    if (malformedOutputs === undefined)
      throw new Error("malformed regular output was not observed");
    expect(
      configuredOutputsMatchV4(root, { ...configured.receipt, outputs: malformedOutputs }),
    ).toBe(false);
    rmSync(join(root, ".claude"), { recursive: true, force: true });
    expect(outputDigestsV4(root, "claude")).toBeUndefined();
    expect(inspectAihManagedUsageAdapterV1(join(root, "missing-root"))).toMatchObject({
      state: "invalid",
    });
    mkdirSync(join(root, "empty-root"));
    expect(inspectAihManagedUsageAdapterV1(join(root, "empty-root"))).toMatchObject({
      state: "absent",
    });
    writeFileSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH), "{");
    expect(parseAihManagedUsageReceiptV4(root, descriptor)).toBeUndefined();
  });

  it("refuses a hard-linked administrator output before claiming custody", async () => {
    const value = fixture();
    writeAuthority(value);
    writeFileSync(join(root, "administrator-ignore"), "administrator rule\n");
    linkSync(join(root, "administrator-ignore"), join(root, ".gitignore"));

    await expect(
      applyAihManagedUsageAdapterV1(context(true), {
        decision: value.decision.id,
        digest: value.digest,
        evidence: "evidence.json",
        target: "claude",
      }),
    ).resolves.toMatchObject({ outcome: "partial", reason: "ownership-conflict" });
    expect(existsSync(join(root, AIH_MANAGED_USAGE_RECEIPT_V4_PATH))).toBe(false);
  });

  it("retains a visible claim when a host ownership conflict appears after reauthorization", async () => {
    const value = fixture();
    writeAuthority(value);
    writeFileSync(join(root, "administrator-settings"), "{}\n");
    const ctx = context(true);
    const originalRun = ctx.run;
    let attestations = 0;
    ctx.run = async (argv, options) => {
      const result = await originalRun(argv, options);
      if (argv[0] === gh && ++attestations === 2) {
        mkdirSync(join(root, ".claude"));
        linkSync(join(root, "administrator-settings"), join(root, ".claude", "settings.json"));
      }
      return result;
    };

    await expect(
      applyAihManagedUsageAdapterV1(ctx, {
        decision: value.decision.id,
        digest: value.digest,
        evidence: "evidence.json",
        target: "claude",
      }),
    ).resolves.toMatchObject({ outcome: "partial", reason: "ownership-conflict" });
    expect(attestations).toBe(2);
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "claimed" });
    expect(existsSync(join(root, ".aih", "usage-record.mjs"))).toBe(false);
  });

  it("records post-effect drift when a fixed output disappears during final reauthorization", async () => {
    const value = fixture();
    writeAuthority(value);
    const ctx = context(true);
    const originalRun = ctx.run;
    let attestations = 0;
    ctx.run = async (argv, options) => {
      const result = await originalRun(argv, options);
      if (argv[0] === gh && ++attestations === 3)
        rmSync(join(root, ".aih", "usage-record.mjs"), { force: true });
      return result;
    };

    await expect(
      applyAihManagedUsageAdapterV1(ctx, {
        decision: value.decision.id,
        digest: value.digest,
        evidence: "evidence.json",
        target: "claude",
      }),
    ).resolves.toMatchObject({ outcome: "partial", reason: "post-effect-drift" });
    expect(attestations).toBe(3);
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "claimed" });
  });

  it("retains a visible claim when authority changes during mandatory reauthorization", async () => {
    const value = fixture();
    writeAuthority(value);
    const ctx = context(true);
    const originalRun = ctx.run;
    let attestations = 0;
    ctx.run = async (argv, options) => {
      const result = await originalRun(argv, options);
      if (argv[0] === gh && ++attestations === 2) {
        const path = join(root, ".aih", "policy-authority-receipt.json");
        const authority = JSON.parse(readFileSync(path, "utf8"));
        authority.decisions = [];
        writeFileSync(path, JSON.stringify(authority));
      }
      return result;
    };

    await expect(
      applyAihManagedUsageAdapterV1(ctx, {
        decision: value.decision.id,
        digest: value.digest,
        evidence: "evidence.json",
        target: "claude",
      }),
    ).resolves.toMatchObject({ outcome: "partial", reason: "recovery-required" });
    expect(attestations).toBe(2);
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "claimed" });
  });

  it("reports post-effect drift when authority changes before finalization", async () => {
    const value = fixture();
    writeAuthority(value);
    const ctx = context(true);
    const originalRun = ctx.run;
    let attestations = 0;
    ctx.run = async (argv, options) => {
      const result = await originalRun(argv, options);
      if (argv[0] === gh && ++attestations === 3) {
        const path = join(root, ".aih", "policy-authority-receipt.json");
        const authority = JSON.parse(readFileSync(path, "utf8"));
        authority.decisions = [];
        writeFileSync(path, JSON.stringify(authority));
      }
      return result;
    };

    await expect(
      applyAihManagedUsageAdapterV1(ctx, {
        decision: value.decision.id,
        digest: value.digest,
        evidence: "evidence.json",
        target: "claude",
      }),
    ).resolves.toMatchObject({ outcome: "partial", reason: "post-effect-drift" });
    expect(attestations).toBe(3);
    expect(inspectAihManagedUsageAdapterV1(root)).toMatchObject({ state: "claimed" });
  });
});
