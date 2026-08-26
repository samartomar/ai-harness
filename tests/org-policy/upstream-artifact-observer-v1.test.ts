import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  orgPolicyEffectiveCheck,
  orgPolicyEffectiveDigest,
} from "../../src/org-policy/evaluate.js";
import {
  type GovernanceDecisionV2,
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../src/org-policy/governance-decision-v2.js";
import {
  canonicalOrganizationEvidenceEnvelopeV1,
  organizationEvidenceEnvelopeDigestV1,
} from "../../src/org-policy/qualification-v1.js";
import { resolveRuntimeOrgPolicy } from "../../src/org-policy/runtime.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { resolveUpstreamArtifactEffectiveStateV1 } from "../../src/org-policy/upstream-artifact-effective-state-v1.js";
import {
  readUpstreamArtifactLifecycleStoreV1,
  upstreamArtifactLifecycleCommand,
  upstreamArtifactLifecyclePlan,
} from "../../src/org-policy/upstream-artifact-lifecycle-v1.js";
import { canonicalUpstreamArtifactManifestV1 } from "../../src/org-policy/upstream-artifact-manifest-v1.js";
import {
  __setUpstreamArtifactObserverInternalTestHookV1,
  observeUpstreamArtifactV1,
  upstreamArtifactObservationHandoffForLifecycleV1,
  upstreamArtifactObserveCommand,
  upstreamArtifactObservePlan,
} from "../../src/org-policy/upstream-artifact-observer-v1.js";
import { upstreamObservationReceiptDigestV1 } from "../../src/org-policy/upstream-observation-receipt-v1.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const lifecycleFs = vi.hoisted(() => ({
  deniedLstatPath: undefined as string | undefined,
  denyAfterRename: undefined as
    | { readonly deniedPath: string; readonly renamedPath: string }
    | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    lstatSync: ((...args: unknown[]) => {
      if (String(args[0]) === lifecycleFs.deniedLstatPath) {
        const error = Object.assign(new Error("injected lifecycle lstat denial"), {
          code: "EACCES",
        });
        throw error;
      }
      return Reflect.apply(original.lstatSync, original, args);
    }) as typeof original.lstatSync,
    renameSync: ((from: string, to: string) => {
      const result = original.renameSync(from, to);
      const denial = lifecycleFs.denyAfterRename;
      if (denial !== undefined && to === denial.renamedPath) {
        lifecycleFs.deniedLstatPath = denial.deniedPath;
      }
      return result;
    }) as typeof original.renameSync,
  };
});

const sha = (bytes: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

let root: string;
let bin: string;
let gh: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
  root = mkdtempSync(join(tmpdir(), "aih-upstream-artifact-"));
  bin = mkdtempSync(join(tmpdir(), "aih-upstream-artifact-gh-"));
  const executable = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(executable, "trusted gh fixture\n", { mode: 0o755 });
  gh = realpathSync.native(executable);
});

afterEach(() => {
  lifecycleFs.deniedLstatPath = undefined;
  lifecycleFs.denyAfterRename = undefined;
  __setUpstreamArtifactObserverInternalTestHookV1(undefined);
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

function fixture(
  kind: "tool" | "skill" | "mcp" | "package" = "mcp",
  revision = "v1",
  effect: "configure" | "use" = "configure",
) {
  const files = [
    {
      path: ".codex/config.toml",
      bytes: Buffer.from(
        `[mcp_servers.custom]\nurl="https://mcp.acme.invalid/"\nrevision="${revision}"\n`,
      ),
    },
    { path: "vendor/custom/manifest.json", bytes: Buffer.from(`{"revision":"${revision}"}`) },
  ];
  const source = {
    type: "remote" as const,
    endpoint: "https://mcp.acme.invalid/",
    contentDigest: sha(`reviewed remote contract ${revision}`),
  };
  const sourceDigest = governanceDecisionSourceDigestV2(source);
  const subject = {
    kind,
    id: `custom-${kind}`,
    source,
    sourceDigest,
    subjectDigest: governanceDecisionSubjectDigestV2({ kind, id: `custom-${kind}`, sourceDigest }),
  };
  const manifest = {
    format: "aih-upstream-artifact-manifest" as const,
    version: 1 as const,
    decisionId: `decision-custom-${kind}-${revision}`,
    subject: {
      kind,
      id: subject.id,
      sourceDigest,
      subjectDigest: subject.subjectDigest,
    },
    target: "codex",
    effect,
    integration: {
      owner: "organization-platform",
      version: revision === "v1" ? "1.0.0" : "2.0.0",
    },
    files: files.map((file) => ({ path: file.path, sha256: sha(file.bytes) })),
  };
  const manifestBytes = Buffer.from(canonicalUpstreamArtifactManifestV1(manifest));
  const evidence = {
    format: "aih-organization-evidence" as const,
    version: 1 as const,
    subjectDigest: subject.subjectDigest,
    evidence: {
      kind: "assessment",
      id: `scan-record-${revision}`,
      summary: "The organization reviewed this exact upstream-managed artifact integration.",
      payloadDigest: sha(`assessment payload ${revision}`),
      artifactDigests: [sha(manifestBytes)],
    },
    attestor: "scanner-service",
    issuedAt: "2026-08-24T00:00:00Z",
    notBefore: "2026-08-24T00:00:00Z",
    expiresAt: "2026-08-25T00:00:00Z",
  };
  const evidenceDigest = organizationEvidenceEnvelopeDigestV1(evidence);
  const decision: GovernanceDecisionV2 = {
    format: "aih-governance-decision",
    version: 2,
    id: manifest.decisionId,
    qualificationBasis: {
      kind: "organization-qualified",
      evidenceDigest,
      attestor: evidence.attestor,
    },
    subject,
    targets: ["codex"],
    allowedEffects: [effect],
    policy: { id: "platform-policy", version: "2026.08", digest: sha("policy") },
    control: { id: "review-control", digest: sha("control") },
    evidence: { id: evidence.evidence.id, digest: evidenceDigest, attestor: evidence.attestor },
    issuer: "platform-security",
    actor: "security-admin",
    reason: "The exact integration passed organization review.",
    issuedAt: "2026-08-24T00:00:00Z",
    notBefore: "2026-08-24T00:00:00Z",
    expiresAt: "2026-08-25T00:00:00Z",
    disposition: "approved",
    acceptedFindings: [],
    acceptedGaps: [],
    conditions: [],
  };
  return { decision, evidence, files, manifest, manifestBytes };
}

function writeFixture(
  value: ReturnType<typeof fixture>,
  decisionRevocations: readonly Record<string, unknown>[] = [],
): void {
  for (const file of value.files) {
    mkdirSync(join(root, file.path, ".."), { recursive: true });
    writeFileSync(join(root, file.path), file.bytes);
  }
  writeFileSync(join(root, "manifest.json"), value.manifestBytes);
  writeFileSync(
    join(root, "evidence.json"),
    canonicalOrganizationEvidenceEnvelopeV1(value.evidence),
  );
  mkdirSync(join(root, ".aih"), { recursive: true });
  writeFileSync(
    join(root, ".aih", "policy-authority-receipt.json"),
    JSON.stringify({
      format: "aih-policy-authority-receipt",
      version: 3,
      issuerRepository: "acme/governance",
      issuedAt: "2026-08-24T00:00:00Z",
      expiresAt: "2026-08-25T00:00:00Z",
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
      targets: ["codex"],
      decisions: [value.decision],
      decisionRevocations,
    }),
  );
}

function rebindManifest(value: ReturnType<typeof fixture>): void {
  value.manifestBytes = Buffer.from(canonicalUpstreamArtifactManifestV1(value.manifest));
  value.evidence.evidence.artifactDigests = [sha(value.manifestBytes)];
  const evidenceDigest = organizationEvidenceEnvelopeDigestV1(value.evidence);
  value.decision = {
    ...value.decision,
    qualificationBasis: {
      kind: "organization-qualified",
      evidenceDigest,
      attestor: value.evidence.attestor,
    },
    evidence: { ...value.decision.evidence, digest: evidenceDigest },
  };
}

function resetRoot(prefix = "aih-upstream-artifact-case-"): void {
  rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), prefix));
}

function context(
  options: Record<string, unknown>,
  calls: string[][] = [],
  apply = false,
): PlanContext {
  const run = fakeRunner((argv) => {
    calls.push([...argv]);
    return argv[0] === gh ? { code: 0 } : { code: 1 };
  });
  return {
    root,
    contextDir: "ai-coding",
    apply,
    verify: true,
    json: true,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
    options,
  };
}

function options(value: ReturnType<typeof fixture>) {
  return {
    decision: value.decision.id,
    decisionDigest: governanceDecisionDigestV2(value.decision),
    target: "codex",
    evidence: "evidence.json",
    manifest: "manifest.json",
  };
}

function fixtureFile(value: ReturnType<typeof fixture>, index: number) {
  const file = value.files[index];
  if (file === undefined) throw new Error(`missing fixture file ${String(index)}`);
  return file;
}

describe("upstream artifact observer V1", () => {
  it.each(["tool", "skill", "mcp", "package"] as const)(
    "observes an organization-qualified catalog-absent %s without writing or executing it",
    async (kind) => {
      const value = fixture(kind);
      writeFixture(value);
      const calls: string[][] = [];
      const result = await observeUpstreamArtifactV1(context(options(value), calls));

      expect(result).toMatchObject({
        authority: "verified",
        qualification: "organization-qualified",
        effective: "observed-effective",
        outcome: "observed-effective",
      });
      expect(calls).toHaveLength(1);
      expect(upstreamArtifactObservationHandoffForLifecycleV1(result)).toMatchObject({
        decision: { id: value.decision.id },
        receipt: {
          subject: { kind, id: value.decision.subject.id },
          allowedEffects: ["configure"],
          integration: { mode: "upstream-managed", owner: "organization-platform" },
          verifier: { id: "upstream-artifact-observer", version: "1.0.0" },
        },
      });
    },
  );

  it("governs one catalog-absent organization tool with a protected PolicyBundle and no authority workflow", async () => {
    const value = fixture("tool");
    writeFixture(value);
    rmSync(join(root, ".aih", "policy-authority-receipt.json"));
    const adminRoot = mkdtempSync(join(tmpdir(), "aih-upstream-artifact-policy-"));
    const policyPath = join(adminRoot, "policy-bundle.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        schemaVersion: 2,
        bundleVersion: "2026.08.1",
        issuer: "Acme platform security",
        issuedAt: "2026-08-24T00:00:00Z",
        policy: {
          schemaVersion: 2,
          minimumPosture: "enterprise",
          references: { repoContract: "ai-coding/project.json" },
          governance: {
            policyVersion: "2026.08",
            catalog: { reviewed: [], custom: [] },
            supportedClis: ["codex"],
          },
        },
        authorityReceipt: {
          format: "aih-policy-authority-receipt",
          version: 3,
          issuerRepository: "acme/governance",
          issuedAt: "2026-08-24T00:00:00Z",
          expiresAt: "2026-08-25T00:00:00Z",
          trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
          targets: ["codex"],
          decisions: [value.decision],
          decisionRevocations: [],
        },
      }),
    );
    try {
      const calls: string[][] = [];
      const base = context(options(value), calls, true);
      const ctx = { ...base, env: { AIH_ORG_POLICY: policyPath } };
      await expect(observeUpstreamArtifactV1(ctx)).resolves.toMatchObject({
        authority: "verified",
        qualification: "organization-qualified",
        outcome: "observed-effective",
      });
      const lifecycle = await upstreamArtifactLifecyclePlan(ctx);
      await expect(executePlan(lifecycle, ctx)).resolves.toMatchObject({ applied: true });
      expect(calls.some((argv) => argv[0] === gh)).toBe(false);
      expect(readUpstreamArtifactLifecycleStoreV1(root)).toMatchObject({ kind: "complete" });
    } finally {
      rmSync(adminRoot, { recursive: true, force: true });
    }
  });

  it("exposes no observer, verifier, effect, file, command, callback, or network override", () => {
    expect(upstreamArtifactObserveCommand.readOnly).toBe(true);
    expect(upstreamArtifactObserveCommand.zeroWrite).toBe(true);
    expect(upstreamArtifactObserveCommand.options?.map((option) => option.flags)).toEqual([
      "--decision <id>",
      "--decision-digest <sha256>",
      "--target <cli>",
      "--evidence <path>",
      "--manifest <path>",
    ]);
  });

  it("rejects a manifest that is not one of the authorized evidence artifacts", async () => {
    const value = fixture();
    value.evidence.evidence.artifactDigests = [sha("different manifest")];
    const digest = organizationEvidenceEnvelopeDigestV1(value.evidence);
    value.decision = {
      ...value.decision,
      qualificationBasis: {
        kind: "organization-qualified",
        evidenceDigest: digest,
        attestor: value.evidence.attestor,
      },
      evidence: { ...value.decision.evidence, digest },
    };
    writeFixture(value);
    await expect(observeUpstreamArtifactV1(context(options(value)))).resolves.toMatchObject({
      outcome: "refused",
      reason: "manifest-unverified",
    });
  });

  it("fails closed when an observed file is linked or changes after validation", async () => {
    const linked = fixture();
    writeFixture(linked);
    const linkedSource = fixtureFile(linked, 0);
    const linkedTarget = fixtureFile(linked, 1);
    rmSync(join(root, linkedTarget.path));
    symlinkSync(
      join(root, linkedSource.path),
      join(root, linkedTarget.path),
      process.platform === "win32" ? "file" : undefined,
    );
    await expect(observeUpstreamArtifactV1(context(options(linked)))).resolves.toMatchObject({
      outcome: "refused",
      reason: "observed-file-unsafe",
    });

    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "aih-upstream-artifact-race-"));
    const raced = fixture();
    writeFixture(raced);
    const racedFile = fixtureFile(raced, 0);
    __setUpstreamArtifactObserverInternalTestHookV1(() => {
      writeFileSync(join(root, racedFile.path), "substituted");
    });
    await expect(observeUpstreamArtifactV1(context(options(raced)))).resolves.toMatchObject({
      outcome: "refused",
      reason: "observed-file-changed",
    });

    const authorityChanged = fixture();
    writeFixture(authorityChanged);
    __setUpstreamArtifactObserverInternalTestHookV1(() => {
      writeFileSync(join(root, ".aih", "policy-authority-receipt.json"), "{}\n");
    });
    await expect(
      observeUpstreamArtifactV1(context(options(authorityChanged))),
    ).resolves.toMatchObject({
      outcome: "refused",
      reason: "authority-unverified",
    });

    resetRoot();
    const evidenceLinkedDuringObservation = fixture();
    writeFixture(evidenceLinkedDuringObservation);
    __setUpstreamArtifactObserverInternalTestHookV1(() => {
      linkSync(join(root, "evidence.json"), join(root, "evidence-linked.json"));
    });
    await expect(
      observeUpstreamArtifactV1(context(options(evidenceLinkedDuringObservation))),
    ).resolves.toMatchObject({
      outcome: "refused",
      reason: "evidence-changed",
    });
  });

  it("rejects two manifest rows that resolve to one hard-linked file identity", async () => {
    const aliases = fixture();
    const source = fixtureFile(aliases, 0);
    const target = fixtureFile(aliases, 1);
    const manifestTarget = aliases.manifest.files[1];
    if (manifestTarget === undefined) throw new Error("missing manifest target");
    aliases.files[1] = { ...target, bytes: Buffer.from(source.bytes) };
    aliases.manifest.files[1] = { ...manifestTarget, sha256: sha(source.bytes) };
    rebindManifest(aliases);
    writeFixture(aliases);
    rmSync(join(root, target.path));
    linkSync(join(root, source.path), join(root, target.path));

    await expect(observeUpstreamArtifactV1(context(options(aliases)))).resolves.toMatchObject({
      outcome: "refused",
      reason: "observed-file-unsafe",
    });
  });

  it("distinguishes malformed manifests, scope mismatch, unavailable files, and byte mismatch", async () => {
    const malformed = fixture();
    writeFixture(malformed);
    writeFileSync(join(root, "manifest.json"), "{}\n");
    await expect(observeUpstreamArtifactV1(context(options(malformed)))).resolves.toMatchObject({
      outcome: "refused",
      reason: "manifest-unverified",
    });

    resetRoot();
    const wrongScope = fixture();
    wrongScope.manifest.target = "claude";
    rebindManifest(wrongScope);
    writeFixture(wrongScope);
    await expect(observeUpstreamArtifactV1(context(options(wrongScope)))).resolves.toMatchObject({
      outcome: "refused",
      reason: "manifest-mismatch",
    });

    resetRoot();
    const selfCustody = fixture();
    selfCustody.manifest.files = [
      { path: "manifest.json", sha256: sha("self-referential placeholder") },
    ];
    rebindManifest(selfCustody);
    writeFixture(selfCustody);
    await expect(observeUpstreamArtifactV1(context(options(selfCustody)))).resolves.toMatchObject({
      outcome: "refused",
      reason: "manifest-mismatch",
    });

    resetRoot();
    const unavailable = fixture();
    writeFixture(unavailable);
    rmSync(join(root, fixtureFile(unavailable, 0).path));
    await expect(observeUpstreamArtifactV1(context(options(unavailable)))).resolves.toMatchObject({
      outcome: "refused",
      reason: "observed-file-unavailable",
    });

    resetRoot();
    const mismatched = fixture();
    writeFixture(mismatched);
    writeFileSync(join(root, fixtureFile(mismatched, 0).path), "different bytes");
    await expect(observeUpstreamArtifactV1(context(options(mismatched)))).resolves.toMatchObject({
      outcome: "refused",
      reason: "observed-file-mismatch",
    });

    const invalid = context({});
    const execution = await executePlan(upstreamArtifactObservePlan(invalid), invalid, {
      skipWorktreeGate: true,
    });
    expect(execution.digests[0]?.data).toMatchObject({
      outcome: "refused",
      reason: "invalid-input",
    });
    expect(execution.report?.ok).toBe(false);
  });

  it("rejects missing, legacy, malformed, and unsafe custody inputs", async () => {
    const expectReason = async (
      mutate: (value: ReturnType<typeof fixture>) => void,
      reason: string,
      optionOverrides: Record<string, unknown> = {},
    ) => {
      resetRoot();
      const value = fixture();
      writeFixture(value);
      mutate(value);
      await expect(
        observeUpstreamArtifactV1(context({ ...options(value), ...optionOverrides })),
      ).resolves.toMatchObject({ outcome: "refused", reason });
    };

    await expectReason(
      () => rmSync(join(root, ".aih", "policy-authority-receipt.json")),
      "authority-unverified",
    );
    await expectReason(() => undefined, "decision-missing-or-mismatch", {
      decision: "decision-not-present",
      decisionDigest: sha("not present"),
    });
    await expectReason(() => rmSync(join(root, "evidence.json")), "evidence-unavailable");
    await expectReason(
      () => writeFileSync(join(root, "evidence.json"), "{}\n"),
      "qualification-unverified",
    );
    await expectReason(() => rmSync(join(root, "manifest.json")), "manifest-unavailable");
    await expectReason(() => {
      rmSync(join(root, "manifest.json"));
      mkdirSync(join(root, "manifest.json"));
    }, "manifest-unsafe");
    await expectReason(() => undefined, "invalid-input", { manifest: "../manifest.json" });
    await expectReason(() => undefined, "invalid-input", { manifest: "a".repeat(501) });
    await expectReason(
      () => {
        linkSync(join(root, "manifest.json"), join(root, "manifest-hardlink.json"));
      },
      "manifest-unsafe",
      { manifest: "manifest-hardlink.json" },
    );
    await expectReason(
      () => {
        linkSync(join(root, "evidence.json"), join(root, "evidence-hardlink.json"));
      },
      "unsafe-evidence-custody",
      { evidence: "evidence-hardlink.json" },
    );
    await expectReason(
      () => {
        mkdirSync(join(root, "manifest-real"));
        writeFileSync(
          join(root, "manifest-real", "manifest.json"),
          readFileSync(join(root, "manifest.json")),
        );
        symlinkSync(
          join(root, "manifest-real"),
          join(root, "manifest-linked"),
          process.platform === "win32" ? "junction" : "dir",
        );
      },
      "manifest-unsafe",
      { manifest: "manifest-linked/manifest.json" },
    );

    resetRoot();
    const expiresDuringObservation = fixture();
    writeFixture(expiresDuringObservation);
    __setUpstreamArtifactObserverInternalTestHookV1(() => {
      vi.setSystemTime(new Date("2026-08-26T00:00:00Z"));
    });
    await expect(
      observeUpstreamArtifactV1(context(options(expiresDuringObservation))),
    ).resolves.toMatchObject({ outcome: "refused", reason: "authority-not-current" });

    resetRoot();
    await expect(resolveUpstreamArtifactEffectiveStateV1(context({}))).resolves.toEqual([]);
  });

  it.each([
    { evidence: "evidence%2ejson" },
    { manifest: "manifest:alternate.json" },
    { evidence: ".aih/custody.json" },
    { manifest: ".aih/custody.json" },
    { evidence: "aih~1/custody.json" },
    { manifest: "aih~1/custody.json" },
    { evidence: "CON/custody.json" },
    { manifest: "CON/custody.json" },
    { evidence: "COM¹/custody.json" },
    { manifest: "LPT³/custody.json" },
    { evidence: "evidence./custody.json" },
    { manifest: "manifest /custody.json" },
  ])(
    "rejects non-canonical request paths before verification or lifecycle writes",
    async (override) => {
      const value = fixture();
      writeFixture(value);
      const calls: string[][] = [];
      const requested = { ...options(value), ...override };
      await expect(observeUpstreamArtifactV1(context(requested, calls))).resolves.toMatchObject({
        outcome: "refused",
        reason: "invalid-input",
      });
      expect(calls).toEqual([]);

      const applied = context(requested, [], true);
      const lifecycle = await upstreamArtifactLifecyclePlan(applied);
      expect(lifecycle.actions.filter((action) => action.kind === "write")).toEqual([]);
      const execution = await executePlan(lifecycle, applied, { skipWorktreeGate: true });
      expect(execution.digests[0]?.data).toMatchObject({
        applied: false,
        outcome: "refused",
        reason: "invalid-input",
      });
      expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "absent" });
    },
  );

  it("keeps preview zero-write, then records immutable lifecycle history without changing observed files", async () => {
    const value = fixture("skill");
    writeFixture(value);
    const observedBefore = value.files.map((file) => Buffer.from(file.bytes));

    const preview = context(options(value));
    const previewResult = await executePlan(await upstreamArtifactLifecyclePlan(preview), preview, {
      skipWorktreeGate: true,
    });
    expect(previewResult.digests[0]?.data).toMatchObject({
      applied: false,
      outcome: "reported-only",
      state: "observed-effective",
    });
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "absent" });

    const apply = context(options(value), [], true);
    const planned = await upstreamArtifactLifecyclePlan(apply);
    expect(planned.commitLock).toBe(
      ".aih/governance/upstream-artifact-lifecycle/v1/locks/lifecycle.lock",
    );
    const recordIndex = planned.actions.findIndex(
      (action) => action.kind === "write" && action.path.includes("/records/"),
    );
    const headIndex = planned.actions.findIndex(
      (action) => action.kind === "write" && action.path.includes("/heads/"),
    );
    expect(recordIndex).toBeGreaterThanOrEqual(0);
    expect(headIndex).toBeGreaterThan(recordIndex);

    const applied = await executePlan(planned, apply, { skipWorktreeGate: true });
    expect(applied.digests[0]?.data).toMatchObject({
      applied: true,
      outcome: "fulfilled",
      state: "observed-effective",
    });
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toMatchObject({
      kind: "complete",
      records: [
        {
          state: "observed-effective",
          subject: { kind: "skill", id: "custom-skill" },
        },
      ],
    });
    const repeatedContext = context(options(value), [], true);
    const repeated = await executePlan(
      await upstreamArtifactLifecyclePlan(repeatedContext),
      repeatedContext,
      { skipWorktreeGate: true },
    );
    expect(repeated.digests[0]?.data).toMatchObject({
      applied: false,
      outcome: "fulfilled",
      state: "observed-effective",
    });
    await expect(resolveUpstreamArtifactEffectiveStateV1(context(options(value)))).resolves.toEqual(
      [
        expect.objectContaining({
          effect: "configure",
          reason: "current-exact-recorded-observation",
          state: "observed-effective",
          subject: { id: "custom-skill", kind: "skill" },
          target: "codex",
        }),
      ],
    );
    const policy = parseOrgPolicy({
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      command: { deny: {} },
      trust: {},
    });
    writeFileSync(join(root, "aih-org-policy.json"), JSON.stringify(policy));
    await expect(resolveRuntimeOrgPolicy(context(options(value)), policy)).resolves.toMatchObject({
      effective: {
        blocking: false,
        upstreamArtifactLifecycle: [
          { reason: "current-exact-recorded-observation", state: "observed-effective" },
        ],
      },
    });
    await expect(orgPolicyEffectiveCheck(context(options(value)))).resolves.toMatchObject({
      verdict: "pass",
    });
    await expect(orgPolicyEffectiveDigest(context(options(value)))).resolves.toMatchObject({
      data: {
        upstreamArtifactLifecycle: [
          { reason: "current-exact-recorded-observation", state: "observed-effective" },
        ],
      },
    });
    for (const [index, file] of value.files.entries()) {
      expect(readFileSync(join(root, file.path))).toEqual(observedBefore[index]);
    }
    expect(upstreamArtifactLifecycleCommand.requireExplicitApply).toBe(true);
  });

  it("does not promote a lifecycle record after its live inputs disappear", async () => {
    const value = fixture("mcp");
    writeFixture(value);
    const applied = context(options(value), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(applied), applied, {
      skipWorktreeGate: true,
    });

    const base = join(root, ".aih", "governance", "upstream-artifact-lifecycle", "v1");
    const headName = readdirSync(join(base, "heads")).find((name) =>
      /^[0-9a-f]{64}\.json$/.test(name),
    );
    if (headName === undefined) throw new Error("expected lifecycle head");
    const partition = headName.slice(0, -".json".length);
    const recordName = readdirSync(join(base, "records", partition))[0];
    if (recordName === undefined) throw new Error("expected lifecycle record");
    const record = JSON.parse(
      readFileSync(join(base, "records", partition, recordName), "utf8"),
    ) as Record<string, unknown>;
    const recordBytes = canonicalStrictJsonBytesV1(record);
    const recordDigest = sha(
      Buffer.concat([Buffer.from("aih-upstream-artifact-lifecycle-record/v1\0"), recordBytes]),
    );
    const lineage = record.lineage as Record<string, unknown>;
    const claimKey = createHash("sha256")
      .update(
        canonicalStrictJsonBytesV1({
          effect: lineage.effect,
          subject: lineage.subject,
          target: lineage.target,
        }),
      )
      .digest("hex");

    rmSync(base, { recursive: true, force: true });
    mkdirSync(join(base, "claims"), { recursive: true });
    mkdirSync(join(base, "heads"), { recursive: true });
    mkdirSync(join(base, "records", `${lineage.digest as string}`.slice("sha256:".length)), {
      recursive: true,
    });
    writeFileSync(
      join(base, "claims", `${claimKey}.json`),
      canonicalStrictJsonBytesV1({
        format: "aih-upstream-artifact-lifecycle-claim",
        lineage,
        version: 1,
      }),
    );
    writeFileSync(
      join(
        base,
        "records",
        `${lineage.digest as string}`.slice("sha256:".length),
        `${recordDigest.slice("sha256:".length)}.json`,
      ),
      recordBytes,
    );
    writeFileSync(
      join(base, "heads", `${`${lineage.digest as string}`.slice("sha256:".length)}.json`),
      canonicalStrictJsonBytesV1({
        format: "aih-upstream-artifact-lifecycle-head",
        lineageDigest: lineage.digest,
        recordDigest,
        sequence: record.sequence,
        subjectDigest: record.subjectDigest,
        version: 1,
      }),
    );
    writeFileSync(
      join(base, "capacity.json"),
      canonicalStrictJsonBytesV1({
        format: "aih-upstream-artifact-lifecycle-capacity",
        headCount: 1,
        recordCount: 1,
        version: 1,
      }),
    );
    rmSync(join(root, "evidence.json"));
    rmSync(join(root, "manifest.json"));
    for (const file of value.files) rmSync(join(root, file.path));

    expect(readUpstreamArtifactLifecycleStoreV1(root)).toMatchObject({ kind: "complete" });
    await expect(
      resolveUpstreamArtifactEffectiveStateV1(context(options(value))),
    ).resolves.not.toEqual([expect.objectContaining({ state: "observed-effective" })]);
  });

  it("re-observes persisted paths live and withholds effective state after artifact drift", async () => {
    const value = fixture("mcp");
    writeFixture(value);
    const applied = context(options(value), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(applied), applied, {
      skipWorktreeGate: true,
    });

    const currentCalls: string[][] = [];
    await expect(
      resolveUpstreamArtifactEffectiveStateV1(context(options(value), currentCalls)),
    ).resolves.toEqual([expect.objectContaining({ state: "observed-effective" })]);
    expect(currentCalls).toHaveLength(1);

    writeFileSync(join(root, fixtureFile(value, 0).path), "drifted");
    await expect(
      resolveUpstreamArtifactEffectiveStateV1(context(options(value))),
    ).resolves.not.toEqual([expect.objectContaining({ state: "observed-effective" })]);
  });

  it("revalidates every live handoff after parallel observations", async () => {
    const first = fixture("tool");
    const second = fixture("skill");
    second.files = second.files.map((file, index) => ({
      ...file,
      path: `vendor/second/${String(index)}.json`,
    }));
    second.manifest.files = second.manifest.files.map((file, index) => ({
      ...file,
      path: second.files[index]?.path ?? file.path,
    }));
    rebindManifest(second);
    writeFixture(first);
    for (const file of second.files) {
      mkdirSync(join(root, file.path, ".."), { recursive: true });
      writeFileSync(join(root, file.path), file.bytes);
    }
    writeFileSync(join(root, "manifest-second.json"), second.manifestBytes);
    writeFileSync(
      join(root, "evidence-second.json"),
      canonicalOrganizationEvidenceEnvelopeV1(second.evidence),
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
        targets: ["codex"],
        decisions: [first.decision, second.decision].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
        decisionRevocations: [],
      }),
    );
    const firstContext = context(options(first), [], true);
    const secondContext = context(
      { ...options(second), evidence: "evidence-second.json", manifest: "manifest-second.json" },
      [],
      true,
    );
    await executePlan(await upstreamArtifactLifecyclePlan(firstContext), firstContext, {
      skipWorktreeGate: true,
    });
    await executePlan(await upstreamArtifactLifecyclePlan(secondContext), secondContext, {
      skipWorktreeGate: true,
    });
    const store = readUpstreamArtifactLifecycleStoreV1(root);
    expect(store.kind).toBe("complete");
    if (store.kind !== "complete") throw new Error("expected two lifecycle records");
    expect(store.records).toHaveLength(2);
    const firstRecord = store.records[0];
    const secondRecord = store.records[1];
    if (firstRecord === undefined || secondRecord === undefined)
      throw new Error("expected ordered lifecycle records");
    const firstValue = firstRecord.decision.id === first.decision.id ? first : second;
    let firstObserved = false;
    let raced = false;
    __setUpstreamArtifactObserverInternalTestHookV1((requested) => {
      if (requested.decision === firstRecord.decision.id) firstObserved = true;
      if (requested.decision === secondRecord.decision.id && firstObserved && !raced) {
        raced = true;
        writeFileSync(join(root, fixtureFile(firstValue, 0).path), "drifted during sibling read");
      }
    });

    const calls: string[][] = [];
    const states = await resolveUpstreamArtifactEffectiveStateV1(context(options(first), calls));

    expect(raced).toBe(true);
    expect(calls).toHaveLength(1);
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: firstRecord.decision,
          reason: "live-observation-drift",
          state: "drifted",
        }),
        expect.objectContaining({
          decision: secondRecord.decision,
          state: "observed-effective",
        }),
      ]),
    );
  });

  it("withholds effective state after organization evidence gains a hard link", async () => {
    const value = fixture("mcp");
    writeFixture(value);
    const applied = context(options(value), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(applied), applied, {
      skipWorktreeGate: true,
    });

    linkSync(join(root, "evidence.json"), join(root, "evidence-linked.json"));
    await expect(resolveUpstreamArtifactEffectiveStateV1(context(options(value)))).resolves.toEqual(
      [
        expect.objectContaining({
          reason: "live-observation-unsafe-evidence-custody",
          state: "partial",
        }),
      ],
    );
  });

  it.each(["delete", "corrupt", "substitute"] as const)(
    "does not promote stale lifecycle state when the store is %s during live observation",
    async (mutation) => {
      const value = fixture("mcp");
      writeFixture(value);
      const applied = context(options(value), [], true);
      await executePlan(await upstreamArtifactLifecyclePlan(applied), applied, {
        skipWorktreeGate: true,
      });
      const lifecycleBase = join(root, ".aih", "governance", "upstream-artifact-lifecycle", "v1");
      let donorRoot: string | undefined;
      let donorStore: string | undefined;
      if (mutation === "substitute") {
        const originalRoot = root;
        donorRoot = mkdtempSync(join(tmpdir(), "aih-upstream-artifact-donor-"));
        root = donorRoot;
        const donor = fixture("skill");
        writeFixture(donor);
        const donorContext = context(options(donor), [], true);
        await executePlan(await upstreamArtifactLifecyclePlan(donorContext), donorContext, {
          skipWorktreeGate: true,
        });
        donorStore = join(donorRoot, ".aih", "governance", "upstream-artifact-lifecycle", "v1");
        root = originalRoot;
      }
      try {
        __setUpstreamArtifactObserverInternalTestHookV1(() => {
          if (mutation === "delete") {
            rmSync(lifecycleBase, { recursive: true, force: true });
          } else if (mutation === "corrupt") {
            writeFileSync(join(lifecycleBase, "capacity.json"), "{}\n");
          } else if (donorStore !== undefined) {
            rmSync(lifecycleBase, { recursive: true, force: true });
            cpSync(donorStore, lifecycleBase, { recursive: true });
          }
        });
        await expect(
          resolveUpstreamArtifactEffectiveStateV1(context(options(value))),
        ).resolves.toEqual([
          { reason: "lifecycle-store-changed-during-live-observation", state: "partial" },
        ]);
      } finally {
        if (donorRoot !== undefined) rmSync(donorRoot, { recursive: true, force: true });
      }
    },
  );

  it("drifts a self-consistent stored verifier or installed identity from the fresh receipt", async () => {
    const value = fixture("mcp");
    writeFixture(value);
    const applied = context(options(value), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(applied), applied, {
      skipWorktreeGate: true,
    });

    const base = join(root, ".aih", "governance", "upstream-artifact-lifecycle", "v1");
    const headName = readdirSync(join(base, "heads")).find((name) =>
      /^[0-9a-f]{64}\.json$/.test(name),
    );
    if (headName === undefined) throw new Error("expected lifecycle head");
    const partition = headName.slice(0, -".json".length);
    const recordName = readdirSync(join(base, "records", partition))[0];
    if (recordName === undefined) throw new Error("expected lifecycle record");
    const recordPath = join(base, "records", partition, recordName);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    const observation = record.observation as Record<string, unknown>;
    observation.installed = { digest: sha("forged installed"), id: "forged-installed" };
    observation.verifier = {
      digest: sha("forged verifier"),
      id: "forged-verifier",
      version: "1.0.0",
    };
    record.observationDigest = upstreamObservationReceiptDigestV1(observation as never);
    const recordBytes = canonicalStrictJsonBytesV1(record);
    const recordDigest = sha(
      Buffer.concat([Buffer.from("aih-upstream-artifact-lifecycle-record/v1\0"), recordBytes]),
    );
    const headPath = join(base, "heads", headName);
    const head = JSON.parse(readFileSync(headPath, "utf8")) as Record<string, unknown>;
    head.recordDigest = recordDigest;
    rmSync(recordPath);
    writeFileSync(
      join(base, "records", partition, `${recordDigest.slice("sha256:".length)}.json`),
      recordBytes,
    );
    writeFileSync(headPath, canonicalStrictJsonBytesV1(head));

    expect(readUpstreamArtifactLifecycleStoreV1(root)).toMatchObject({ kind: "complete" });
    await expect(
      resolveUpstreamArtifactEffectiveStateV1(context(options(value))),
    ).resolves.not.toEqual([expect.objectContaining({ state: "observed-effective" })]);
  });

  it.each([
    "lifecycle base",
    "lifecycle ancestor",
    "heads directory",
    "capacity file",
    "head file",
    "stored record",
    "head backup",
  ] as const)("fails closed on an injected non-ENOENT stat error at the %s", async (location) => {
    const value = fixture("skill");
    writeFixture(value);
    const applied = context(options(value), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(applied), applied, {
      skipWorktreeGate: true,
    });
    const base = join(root, ".aih", "governance", "upstream-artifact-lifecycle", "v1");
    const headName = readdirSync(join(base, "heads")).find((name) =>
      /^[0-9a-f]{64}\.json$/.test(name),
    );
    if (headName === undefined) throw new Error("expected lifecycle head");
    const partition = headName.slice(0, -".json".length);
    const recordName = readdirSync(join(base, "records", partition))[0];
    if (recordName === undefined) throw new Error("expected lifecycle record");
    const head = join(base, "heads", headName);
    const denied = {
      "lifecycle base": base,
      "lifecycle ancestor": root,
      "heads directory": join(base, "heads"),
      "capacity file": join(base, "capacity.json"),
      "head file": head,
      "stored record": join(base, "records", partition, recordName),
      "head backup": `${head}.aih.bak`,
    }[location];

    lifecycleFs.deniedLstatPath = denied;
    try {
      expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "unsafe" });
      await expect(
        resolveUpstreamArtifactEffectiveStateV1(context(options(value))),
      ).resolves.toEqual([{ reason: "lifecycle-store-unsafe", state: "partial" }]);
    } finally {
      lifecycleFs.deniedLstatPath = undefined;
    }
  });

  it("refuses an update when lstat denies the next immutable lifecycle record", async () => {
    const first = fixture("skill", "v1");
    writeFixture(first);
    const initial = context(options(first), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(initial), initial, {
      skipWorktreeGate: true,
    });

    const next = fixture("skill", "v2");
    writeFixture(next);
    const preview = await upstreamArtifactLifecyclePlan(context(options(next), [], true));
    const record = preview.actions.find(
      (action) => action.kind === "write" && action.path.includes("/records/"),
    );
    if (record === undefined || record.kind !== "write")
      throw new Error("expected next lifecycle record");
    lifecycleFs.deniedLstatPath = join(root, ...record.path.split("/"));
    try {
      const refused = context(options(next), [], true);
      const result = await executePlan(await upstreamArtifactLifecyclePlan(refused), refused, {
        skipWorktreeGate: true,
      });
      expect(result.digests[0]?.data).toMatchObject({
        applied: false,
        outcome: "refused",
        reason: "store-unsafe",
      });
    } finally {
      lifecycleFs.deniedLstatPath = undefined;
    }
  });

  it("refuses a revocation when lstat denies its next immutable lifecycle record", async () => {
    const value = fixture("mcp");
    writeFixture(value);
    const initial = context(options(value), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(initial), initial, {
      skipWorktreeGate: true,
    });
    const revocation = {
      format: "aih-governance-decision-revocation",
      version: 2,
      decisionDigest: governanceDecisionDigestV2(value.decision),
      issuer: value.decision.issuer,
      revokedAt: "2026-08-24T00:00:00Z",
      reason: "The organization revoked this exact integration.",
    };
    writeFixture(value, [revocation]);
    const preview = await upstreamArtifactLifecyclePlan(context(options(value), [], true));
    const record = preview.actions.find(
      (action) => action.kind === "write" && action.path.includes("/records/"),
    );
    if (record === undefined || record.kind !== "write")
      throw new Error("expected revocation lifecycle record");
    lifecycleFs.deniedLstatPath = join(root, ...record.path.split("/"));
    try {
      const refused = context(options(value), [], true);
      const result = await executePlan(await upstreamArtifactLifecyclePlan(refused), refused, {
        skipWorktreeGate: true,
      });
      expect(result.digests[0]?.data).toMatchObject({
        applied: false,
        outcome: "refused",
        reason: "store-unsafe",
      });
    } finally {
      lifecycleFs.deniedLstatPath = undefined;
    }
  });

  it("fails closed when lstat denies a lifecycle read after its writes commit", async () => {
    const value = fixture("package");
    writeFixture(value);
    const applied = context(options(value), [], true);
    const planned = await upstreamArtifactLifecyclePlan(applied);
    const head = planned.actions.find(
      (action) => action.kind === "write" && action.path.includes("/heads/"),
    );
    const capacity = planned.actions.find(
      (action) => action.kind === "write" && action.path.endsWith("/capacity.json"),
    );
    if (
      head === undefined ||
      head.kind !== "write" ||
      capacity === undefined ||
      capacity.kind !== "write"
    )
      throw new Error("expected lifecycle head and capacity writes");
    lifecycleFs.denyAfterRename = {
      deniedPath: join(root, ...head.path.split("/")),
      renamedPath: join(root, ...capacity.path.split("/")),
    };
    const result = await executePlan(planned, applied, { skipWorktreeGate: true });
    expect(result.digests[0]?.data).toMatchObject({
      applied: false,
      outcome: "refused",
      reason: "store-unsafe",
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails closed when POSIX permissions deny an existing lifecycle store",
    async () => {
      const value = fixture("skill");
      writeFixture(value);
      const applied = context(options(value), [], true);
      await executePlan(await upstreamArtifactLifecyclePlan(applied), applied, {
        skipWorktreeGate: true,
      });
      const base = join(root, ".aih", "governance", "upstream-artifact-lifecycle", "v1");
      const mode = statSync(base).mode;
      chmodSync(base, 0);
      try {
        expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "unsafe" });
        await expect(
          resolveUpstreamArtifactEffectiveStateV1(context(options(value))),
        ).resolves.toEqual([{ reason: "lifecycle-store-unsafe", state: "partial" }]);
      } finally {
        chmodSync(base, mode);
      }
    },
  );

  it("appends an exact version and source update and rejects a rollback", async () => {
    const first = fixture("tool", "v1");
    writeFixture(first);
    const firstContext = context(options(first), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(firstContext), firstContext, {
      skipWorktreeGate: true,
    });

    const second = fixture("tool", "v2");
    writeFixture(second);
    const secondContext = context(options(second), [], true);
    const bumped = await executePlan(
      await upstreamArtifactLifecyclePlan(secondContext),
      secondContext,
      {
        skipWorktreeGate: true,
      },
    );
    expect(bumped.digests[0]?.data).toMatchObject({
      applied: true,
      outcome: "fulfilled",
      state: "observed-effective",
    });
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toMatchObject({
      kind: "complete",
      records: [
        {
          decision: { id: second.decision.id },
          observation: { integration: { version: "2.0.0" } },
          sequence: 2,
          subjectDigest: second.decision.subject.subjectDigest,
        },
      ],
    });

    writeFixture(first);
    const rollbackContext = context(options(first), [], true);
    const rollback = await executePlan(
      await upstreamArtifactLifecyclePlan(rollbackContext),
      rollbackContext,
      { skipWorktreeGate: true },
    );
    expect(rollback.digests[0]?.data).toMatchObject({
      applied: false,
      outcome: "refused",
      reason: "head-conflict",
    });

    const heads = join(root, ".aih", "governance", "upstream-artifact-lifecycle", "v1", "heads");
    const headName = readdirSync(heads).find((name) => /^[0-9a-f]{64}\.json$/.test(name));
    if (headName === undefined) throw new Error("expected lifecycle head");
    writeFileSync(join(heads, `${headName}.aih.bak`), readFileSync(join(heads, headName)));
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
  });

  it("rejects orphan claims and record partitions instead of ignoring unowned history", async () => {
    const value = fixture("package");
    writeFixture(value);
    const applied = context(options(value), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(applied), applied, {
      skipWorktreeGate: true,
    });
    const base = join(root, ".aih", "governance", "upstream-artifact-lifecycle", "v1");
    writeFileSync(join(base, "claims", `${"a".repeat(64)}.json`), "{}\n");
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
    const refusedContext = context(options(value), [], true);
    const refused = await upstreamArtifactLifecyclePlan(refusedContext);
    expect(refused.actions.some((action) => action.kind === "write")).toBe(false);
    await expect(
      executePlan(refused, refusedContext, { skipWorktreeGate: true }),
    ).resolves.toMatchObject({
      digests: [
        expect.objectContaining({ data: expect.objectContaining({ reason: "store-corrupt" }) }),
      ],
    });

    rmSync(join(base, "claims", `${"a".repeat(64)}.json`));
    mkdirSync(join(base, "records", "b".repeat(64)));
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
  });

  it("bounds lifecycle directory enumeration before parsing attacker-controlled entries", () => {
    const claims = join(root, ".aih", "governance", "upstream-artifact-lifecycle", "v1", "claims");
    mkdirSync(claims, { recursive: true });
    for (let index = 0; index <= 256; index += 1) {
      writeFileSync(join(claims, `${index.toString(16).padStart(64, "0")}.json`), "{}\n");
    }
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "over-capacity" });
  });

  it("rejects hostile lifecycle store surfaces and orders multiple exact lineages", async () => {
    const store = (...parts: string[]) =>
      join(root, ".aih", "governance", "upstream-artifact-lifecycle", "v1", ...parts);
    const resetStore = () => {
      resetRoot();
      mkdirSync(store(), { recursive: true });
    };

    resetStore();
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "absent" });

    resetRoot();
    mkdirSync(join(root, ".aih", "governance", "upstream-artifact-lifecycle"), {
      recursive: true,
    });
    writeFileSync(store(), "not a directory");
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "unsafe" });

    resetStore();
    mkdirSync(store("capacity.json"));
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "unsafe" });

    resetStore();
    writeFileSync(store("capacity.json"), "{");
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });

    resetStore();
    mkdirSync(store("heads"));
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });

    resetStore();
    mkdirSync(store("heads"));
    writeFileSync(store("claims"), "not a directory");
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "unsafe" });

    resetStore();
    mkdirSync(store("heads"));
    mkdirSync(store("claims"));
    writeFileSync(store("claims", "foreign"), "{}\n");
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "unsafe" });

    resetStore();
    mkdirSync(store("heads"));
    mkdirSync(store("claims"));
    writeFileSync(store("records"), "not a directory");
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "unsafe" });

    resetStore();
    mkdirSync(store("heads"));
    mkdirSync(store("claims"));
    mkdirSync(store("records"));
    writeFileSync(store("records", "foreign"), "{}\n");
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "unsafe" });

    resetStore();
    mkdirSync(store("heads"));
    mkdirSync(store("claims"));
    mkdirSync(store("records"));
    for (let index = 0; index <= 256; index += 1) {
      mkdirSync(store("records", index.toString(16).padStart(64, "0")));
    }
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "over-capacity" });

    resetStore();
    mkdirSync(store("heads"));
    for (let index = 0; index <= 512; index += 1) {
      writeFileSync(store("heads", `${index.toString(16).padStart(64, "0")}.json`), "{}\n");
    }
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "over-capacity" });

    resetStore();
    mkdirSync(store("heads"));
    for (let index = 0; index <= 256; index += 1) {
      writeFileSync(store("heads", `${index.toString(16).padStart(64, "0")}.json`), "{}\n");
    }
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "over-capacity" });

    resetStore();
    writeFileSync(store("heads"), "not a directory");
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "unsafe" });

    resetRoot();
    const malformedRecord = fixture("package");
    writeFixture(malformedRecord);
    const malformedContext = context(options(malformedRecord), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(malformedContext), malformedContext, {
      skipWorktreeGate: true,
    });
    const base = store();
    const headName = readdirSync(join(base, "heads")).find((name) =>
      /^[0-9a-f]{64}\.json$/.test(name),
    );
    if (headName === undefined) throw new Error("expected lifecycle head");
    const partition = headName.slice(0, -".json".length);
    const recordName = readdirSync(join(base, "records", partition))[0];
    if (recordName === undefined) throw new Error("expected lifecycle record");
    const headPath = join(base, "heads", headName);
    const recordPath = join(base, "records", partition, recordName);
    const originalHead = readFileSync(headPath);
    const originalRecord = readFileSync(recordPath);
    const claimName = readdirSync(join(base, "claims"))[0];
    if (claimName === undefined) throw new Error("expected lifecycle claim");
    const claimPath = join(base, "claims", claimName);
    const originalClaim = readFileSync(claimPath);

    rmSync(join(base, "records", partition), { recursive: true });
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "unsafe" });
    mkdirSync(join(base, "records", partition));
    writeFileSync(recordPath, originalRecord);

    const invalidHead = JSON.parse(originalHead.toString("utf8")) as Record<string, unknown>;
    invalidHead.lineageDigest = "invalid";
    writeFileSync(headPath, canonicalStrictJsonBytesV1(invalidHead));
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
    writeFileSync(headPath, originalHead);

    writeFileSync(recordPath, "{");
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
    writeFileSync(recordPath, originalRecord);

    const unsafeBackupSource = join(root, "unsafe-head-backup.json");
    writeFileSync(unsafeBackupSource, originalHead);
    linkSync(unsafeBackupSource, `${headPath}.aih.bak`);
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
    rmSync(`${headPath}.aih.bak`);
    rmSync(unsafeBackupSource);

    writeFileSync(headPath, "{");
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
    writeFileSync(headPath, originalHead);

    const mismatchedHead = JSON.parse(originalHead.toString("utf8")) as Record<string, unknown>;
    mismatchedHead.subjectDigest = sha("different subject");
    writeFileSync(headPath, canonicalStrictJsonBytesV1(mismatchedHead));
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
    writeFileSync(headPath, originalHead);

    writeFileSync(claimPath, "{");
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
    writeFileSync(claimPath, originalClaim);

    resetRoot();
    const first = fixture("tool");
    writeFixture(first);
    const firstContext = context(options(first), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(firstContext), firstContext, {
      skipWorktreeGate: true,
    });
    const second = fixture("skill");
    writeFixture(second);
    const secondContext = context(options(second), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(secondContext), secondContext, {
      skipWorktreeGate: true,
    });
    const multiple = readUpstreamArtifactLifecycleStoreV1(root);
    expect(multiple).toMatchObject({ kind: "complete" });
    if (multiple.kind !== "complete") throw new Error("expected complete lifecycle store");
    expect(multiple.records.map((record) => record.lineage.digest)).toEqual(
      multiple.records.map((record) => record.lineage.digest).sort(),
    );
    expect(multiple.records.map((record) => record.subject.id).sort()).toEqual([
      "custom-skill",
      "custom-tool",
    ]);
  }, 20_000);

  it("rejects malformed canonical lifecycle records and detached store structure", async () => {
    const value = fixture("package");
    writeFixture(value);
    const applied = context(options(value), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(applied), applied, {
      skipWorktreeGate: true,
    });
    const base = join(root, ".aih", "governance", "upstream-artifact-lifecycle", "v1");
    const headName = readdirSync(join(base, "heads")).find((name) =>
      /^[0-9a-f]{64}\.json$/.test(name),
    );
    if (headName === undefined) throw new Error("expected lifecycle head");
    const partition = headName.slice(0, -".json".length);
    const recordName = readdirSync(join(base, "records", partition))[0];
    const claimName = readdirSync(join(base, "claims"))[0];
    if (recordName === undefined || claimName === undefined)
      throw new Error("expected lifecycle custody files");
    const headPath = join(base, "heads", headName);
    const recordPath = join(base, "records", partition, recordName);
    const claimPath = join(base, "claims", claimName);
    const capacityPath = join(base, "capacity.json");
    const originalHead = readFileSync(headPath);
    const originalRecord = readFileSync(recordPath);
    const originalClaim = readFileSync(claimPath);
    const originalCapacity = readFileSync(capacityPath);

    const expectCanonicalCorruption = (
      path: string,
      original: Buffer,
      mutate: (value: Record<string, unknown>) => void,
    ) => {
      const changed = JSON.parse(original.toString("utf8")) as Record<string, unknown>;
      mutate(changed);
      writeFileSync(path, canonicalStrictJsonBytesV1(changed));
      expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
      writeFileSync(path, original);
    };

    writeFileSync(capacityPath, Buffer.concat([originalCapacity, Buffer.from("\n")]));
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
    writeFileSync(capacityPath, originalCapacity);
    expectCanonicalCorruption(capacityPath, originalCapacity, (item) => {
      item.recordCount = 2;
    });
    expectCanonicalCorruption(headPath, originalHead, (item) => {
      item.sequence = 0;
    });
    expectCanonicalCorruption(claimPath, originalClaim, (item) => {
      item.version = 2;
    });

    writeFileSync(join(base, "heads", "foreign"), "{}\n");
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "unsafe" });
    rmSync(join(base, "heads", "foreign"));
    writeFileSync(join(base, "records", partition, "foreign"), "{}\n");
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
    rmSync(join(base, "records", partition, "foreign"));
    rmSync(recordPath);
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
    writeFileSync(recordPath, originalRecord);

    const mutateRecord = (mutate: (value: Record<string, unknown>) => void) => {
      const record = JSON.parse(originalRecord.toString("utf8")) as Record<string, unknown>;
      mutate(record);
      const bytes = canonicalStrictJsonBytesV1(record);
      const digest = `sha256:${createHash("sha256")
        .update("aih-upstream-artifact-lifecycle-record/v1\0", "utf8")
        .update(bytes)
        .digest("hex")}`;
      const changedPath = join(base, "records", partition, `${digest.slice(7)}.json`);
      const head = JSON.parse(originalHead.toString("utf8")) as Record<string, unknown>;
      head.recordDigest = digest;
      rmSync(recordPath);
      writeFileSync(changedPath, bytes);
      writeFileSync(headPath, canonicalStrictJsonBytesV1(head));
      expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
      rmSync(changedPath);
      writeFileSync(recordPath, originalRecord);
      writeFileSync(headPath, originalHead);
    };
    mutateRecord((item) => {
      (item.lineage as { integration: Record<string, unknown> }).integration.version = "1.0.0";
    });
    mutateRecord((item) => {
      (item.decision as Record<string, unknown>).id = "INVALID";
    });
    mutateRecord((item) => {
      (item.decision as Record<string, unknown>).extra = true;
    });
    mutateRecord((item) => {
      item.decision = null;
    });
    mutateRecord((item) => {
      item.decision = [];
    });
    mutateRecord((item) => {
      item.previousRecordDigest = "invalid";
    });
    mutateRecord((item) => {
      item.extra = true;
    });
    mutateRecord((item) => {
      item.manifestDigest = "invalid";
    });
    mutateRecord((item) => {
      item.request = null;
    });
    mutateRecord((item) => {
      (item.request as Record<string, unknown>).evidence = "../outside";
    });
    mutateRecord((item) => {
      (item.observation as { decision: Record<string, unknown> }).decision.id = "different";
    });
    mutateRecord((item) => {
      item.observation = null;
    });
    mutateRecord((item) => {
      item.authorityReceiptDigest = "invalid";
    });
    mutateRecord((item) => {
      item.lineage = null;
    });
    mutateRecord((item) => {
      (item.lineage as Record<string, unknown>).effect = "execute";
    });
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toMatchObject({ kind: "complete" });
  });

  it("pins prior immutable history before an update can append or advance its head", async () => {
    const first = fixture("tool", "v1");
    writeFixture(first);
    const firstContext = context(options(first), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(firstContext), firstContext, {
      skipWorktreeGate: true,
    });

    const second = fixture("tool", "v2");
    writeFixture(second);
    const secondContext = context(options(second), [], true);
    const planned = await upstreamArtifactLifecyclePlan(secondContext);
    const base = join(root, ".aih", "governance", "upstream-artifact-lifecycle", "v1");
    const headName = readdirSync(join(base, "heads")).find((name) =>
      /^[0-9a-f]{64}\.json$/.test(name),
    );
    if (headName === undefined) throw new Error("expected lifecycle head");
    const partition = headName.slice(0, -".json".length);
    const priorName = readdirSync(join(base, "records", partition))[0];
    if (priorName === undefined) throw new Error("expected prior lifecycle record");
    const priorPath = join(base, "records", partition, priorName);
    const headBefore = readFileSync(join(base, "heads", headName));
    writeFileSync(priorPath, "{}\n");

    await expect(executePlan(planned, secondContext, { skipWorktreeGate: true })).rejects.toThrow(
      "prior upstream artifact lifecycle record remains exact changed before commit",
    );
    expect(readFileSync(join(base, "heads", headName))).toEqual(headBefore);
    expect(readdirSync(join(base, "records", partition))).toEqual([priorName]);
  });

  it("refuses a stale cross-lineage plan without retaining any losing writes", async () => {
    const first = fixture("tool");
    const second = fixture("skill");
    writeFixture(first);
    const firstContext = context(options(first), [], true);
    const firstPlan = await upstreamArtifactLifecyclePlan(firstContext);
    writeFixture(second);
    const secondContext = context(options(second), [], true);
    const stalePlan = await upstreamArtifactLifecyclePlan(secondContext);

    writeFixture(first);
    await executePlan(firstPlan, firstContext, { skipWorktreeGate: true });
    writeFixture(second);
    await expect(executePlan(stalePlan, secondContext, { skipWorktreeGate: true })).rejects.toThrow(
      "changed after the plan was computed",
    );
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toMatchObject({
      kind: "complete",
      records: [{ subject: { id: "custom-tool", kind: "tool" } }],
    });
  });

  it("records a current authenticated revocation as non-effective without changing artifact files", async () => {
    const value = fixture("mcp");
    writeFixture(value);
    const first = context(options(value), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(first), first, {
      skipWorktreeGate: true,
    });
    const before = value.files.map((file) => readFileSync(join(root, file.path)));
    const revocation = {
      format: "aih-governance-decision-revocation",
      version: 2,
      decisionDigest: governanceDecisionDigestV2(value.decision),
      issuer: value.decision.issuer,
      revokedAt: "2026-08-24T00:00:00Z",
      reason: "The organization revoked this exact integration.",
    };
    writeFixture(value, [revocation]);

    const revokedContext = context(options(value), [], true);
    await expect(resolveUpstreamArtifactEffectiveStateV1(revokedContext)).resolves.toEqual([
      expect.objectContaining({ reason: "decision-revoked", state: "revoked" }),
    ]);
    const revoked = await executePlan(
      await upstreamArtifactLifecyclePlan(revokedContext),
      revokedContext,
      { skipWorktreeGate: true },
    );
    expect(revoked.digests[0]?.data).toMatchObject({
      applied: true,
      outcome: "reported-only",
      state: "decision-revoked",
    });
    expect(readUpstreamArtifactLifecycleStoreV1(root)).toMatchObject({
      kind: "complete",
      records: [
        {
          decision: { id: value.decision.id },
          sequence: 2,
          state: "decision-revoked",
        },
      ],
    });
    const repeated = await executePlan(
      await upstreamArtifactLifecyclePlan(revokedContext),
      revokedContext,
      { skipWorktreeGate: true },
    );
    expect(repeated.digests[0]?.data).toMatchObject({
      applied: false,
      outcome: "reported-only",
      state: "decision-revoked",
    });

    const base = join(root, ".aih", "governance", "upstream-artifact-lifecycle", "v1");
    const headName = readdirSync(join(base, "heads")).find((name) =>
      /^[0-9a-f]{64}\.json$/.test(name),
    );
    if (headName === undefined) throw new Error("expected lifecycle head");
    const headPath = join(base, "heads", headName);
    const originalHead = readFileSync(headPath);
    const head = JSON.parse(originalHead.toString("utf8")) as Record<string, unknown>;
    const originalDigest = String(head.recordDigest);
    const partition = headName.slice(0, -".json".length);
    const originalRecordPath = join(base, "records", partition, `${originalDigest.slice(7)}.json`);
    const originalRecord = readFileSync(originalRecordPath);
    const mutateRevocation = (mutate: (item: Record<string, unknown>) => void) => {
      const item = JSON.parse(originalRecord.toString("utf8")) as Record<string, unknown>;
      mutate(item);
      const bytes = canonicalStrictJsonBytesV1(item);
      const digest = `sha256:${createHash("sha256")
        .update("aih-upstream-artifact-lifecycle-record/v1\0", "utf8")
        .update(bytes)
        .digest("hex")}`;
      const changedPath = join(base, "records", partition, `${digest.slice(7)}.json`);
      const changedHead = { ...head, recordDigest: digest };
      rmSync(originalRecordPath);
      writeFileSync(changedPath, bytes);
      writeFileSync(headPath, canonicalStrictJsonBytesV1(changedHead));
      expect(readUpstreamArtifactLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
      rmSync(changedPath);
      writeFileSync(originalRecordPath, originalRecord);
      writeFileSync(headPath, originalHead);
    };
    mutateRevocation((item) => {
      item.extra = true;
    });
    mutateRevocation((item) => {
      (item.decision as Record<string, unknown>).extra = true;
    });
    mutateRevocation((item) => {
      item.decision = null;
    });
    mutateRevocation((item) => {
      item.decision = [];
    });
    mutateRevocation((item) => {
      (item.revocation as Record<string, unknown>).decisionDigest = sha("different decision");
    });
    mutateRevocation((item) => {
      item.revocation = null;
    });
    for (const [index, file] of value.files.entries()) {
      expect(readFileSync(join(root, file.path))).toEqual(before[index]);
    }
  });

  it("revokes only the validated manifest effect when one decision has multiple lifecycle lineages", async () => {
    const configure = fixture("mcp", "v1", "configure");
    const use = fixture("mcp", "v1", "use");
    const evidence = {
      ...configure.evidence,
      evidence: {
        ...configure.evidence.evidence,
        artifactDigests: [sha(configure.manifestBytes), sha(use.manifestBytes)],
      },
    };
    const evidenceDigest = organizationEvidenceEnvelopeDigestV1(evidence);
    const decision = {
      ...configure.decision,
      allowedEffects: ["configure", "use"] as Array<"configure" | "use">,
      qualificationBasis: {
        kind: "organization-qualified" as const,
        evidenceDigest,
        attestor: evidence.attestor,
      },
      evidence: { ...configure.decision.evidence, digest: evidenceDigest },
    };
    configure.decision = decision;
    configure.evidence = evidence;
    use.decision = decision;
    use.evidence = evidence;
    writeFixture(configure);
    writeFileSync(join(root, "manifest-use.json"), use.manifestBytes);
    const useOptions = { ...options(use), manifest: "manifest-use.json" };

    const configured = context(options(configure), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(configured), configured, {
      skipWorktreeGate: true,
    });
    const used = context(useOptions, [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(used), used, {
      skipWorktreeGate: true,
    });
    const initialStore = readUpstreamArtifactLifecycleStoreV1(root);
    expect(initialStore.kind).toBe("complete");
    if (initialStore.kind === "complete") {
      expect(initialStore.records.map((record) => record.lineage.effect).sort()).toEqual([
        "configure",
        "use",
      ]);
    }

    const revocation = {
      format: "aih-governance-decision-revocation",
      version: 2,
      decisionDigest: governanceDecisionDigestV2(decision),
      issuer: decision.issuer,
      revokedAt: "2026-08-24T00:00:00Z",
      reason: "The organization revoked this exact integration.",
    };
    writeFixture(configure, [revocation]);
    await expect(observeUpstreamArtifactV1(context(options(configure)))).resolves.toMatchObject({
      effect: "configure",
      reason: "decision-revoked",
    });
    const revokeConfigure = context(options(configure), [], true);
    await expect(resolveUpstreamArtifactEffectiveStateV1(revokeConfigure)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "decision-revoked", state: "revoked" }),
      ]),
    );
    const configuredRevocation = await executePlan(
      await upstreamArtifactLifecyclePlan(revokeConfigure),
      revokeConfigure,
      { skipWorktreeGate: true },
    );
    expect(configuredRevocation.digests[0]?.data).toMatchObject({
      applied: true,
      outcome: "reported-only",
      state: "decision-revoked",
    });
    const afterConfigure = readUpstreamArtifactLifecycleStoreV1(root);
    expect(afterConfigure.kind).toBe("complete");
    if (afterConfigure.kind === "complete") {
      expect(
        afterConfigure.records
          .map((record) => ({ effect: record.lineage.effect, state: record.state }))
          .sort((left, right) => left.effect.localeCompare(right.effect)),
      ).toEqual([
        { effect: "configure", state: "decision-revoked" },
        { effect: "use", state: "observed-effective" },
      ]);
    }

    await expect(observeUpstreamArtifactV1(context(useOptions))).resolves.toMatchObject({
      effect: "use",
      reason: "decision-revoked",
    });
    const revokeUse = context(useOptions, [], true);
    const usedRevocation = await executePlan(
      await upstreamArtifactLifecyclePlan(revokeUse),
      revokeUse,
      { skipWorktreeGate: true },
    );
    expect(usedRevocation.digests[0]?.data).toMatchObject({
      applied: true,
      outcome: "reported-only",
      state: "decision-revoked",
    });
    await expect(resolveUpstreamArtifactEffectiveStateV1(context(useOptions))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "decision-revoked", state: "revoked" }),
      ]),
    );
    const finalStore = readUpstreamArtifactLifecycleStoreV1(root);
    expect(finalStore.kind).toBe("complete");
    if (finalStore.kind === "complete") {
      expect(
        finalStore.records
          .map((record) => ({ effect: record.lineage.effect, state: record.state }))
          .sort((left, right) => left.effect.localeCompare(right.effect)),
      ).toEqual([
        { effect: "configure", state: "decision-revoked" },
        { effect: "use", state: "decision-revoked" },
      ]);
    }
  });

  it("refuses an authenticated revocation that has no prior lifecycle custody", async () => {
    const value = fixture("mcp");
    const revocation = {
      format: "aih-governance-decision-revocation",
      version: 2,
      decisionDigest: governanceDecisionDigestV2(value.decision),
      issuer: value.decision.issuer,
      revokedAt: "2026-08-24T00:00:00Z",
      reason: "The organization revoked this exact integration.",
    };
    writeFixture(value, [revocation]);
    const revokedContext = context(options(value), [], true);
    const refused = await executePlan(
      await upstreamArtifactLifecyclePlan(revokedContext),
      revokedContext,
      { skipWorktreeGate: true },
    );
    expect(refused.digests[0]?.data).toMatchObject({
      applied: false,
      outcome: "refused",
      reason: "head-conflict",
    });
  });

  it("keeps authority loss, authority drift, rejection, decision drift, and store corruption distinct", async () => {
    const value = fixture("skill");
    writeFixture(value);
    const applied = context(options(value), [], true);
    await executePlan(await upstreamArtifactLifecyclePlan(applied), applied, {
      skipWorktreeGate: true,
    });
    const authorityPath = join(root, ".aih", "policy-authority-receipt.json");
    const originalAuthority = readFileSync(authorityPath);
    const receipt = JSON.parse(originalAuthority.toString("utf8")) as Record<string, unknown>;

    rmSync(authorityPath);
    await expect(resolveUpstreamArtifactEffectiveStateV1(context(options(value)))).resolves.toEqual(
      [expect.objectContaining({ reason: "authority-unverified", state: "withheld" })],
    );
    writeFileSync(authorityPath, originalAuthority);

    vi.setSystemTime(new Date("2026-08-26T00:00:00Z"));
    await expect(resolveUpstreamArtifactEffectiveStateV1(context(options(value)))).resolves.toEqual(
      [expect.objectContaining({ reason: "authority-not-current", state: "stale" })],
    );
    vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));

    writeFileSync(
      authorityPath,
      JSON.stringify({
        ...receipt,
        trustedIssuers: [
          ...(receipt.trustedIssuers as readonly unknown[]),
          { id: "secondary-security", githubRepository: "acme/secondary" },
        ],
      }),
    );
    await expect(resolveUpstreamArtifactEffectiveStateV1(context(options(value)))).resolves.toEqual(
      [expect.objectContaining({ reason: "authority-receipt-drift", state: "drifted" })],
    );

    writeFileSync(authorityPath, JSON.stringify({ ...receipt, decisions: [] }));
    await expect(resolveUpstreamArtifactEffectiveStateV1(context(options(value)))).resolves.toEqual(
      [expect.objectContaining({ reason: "decision-or-custody-drift", state: "drifted" })],
    );

    const rejection = {
      ...value.decision,
      id: "decision-reject-custom-skill",
      disposition: "rejected" as const,
      reason: "The organization rejected this exact subject.",
    };
    writeFileSync(
      authorityPath,
      JSON.stringify({ ...receipt, decisions: [value.decision, rejection] }),
    );
    await expect(resolveUpstreamArtifactEffectiveStateV1(context(options(value)))).resolves.toEqual(
      [expect.objectContaining({ reason: "decision-rejected", state: "refused" })],
    );

    writeFileSync(authorityPath, originalAuthority);
    const claims = join(root, ".aih", "governance", "upstream-artifact-lifecycle", "v1", "claims");
    writeFileSync(join(claims, `${"f".repeat(64)}.json`), "{}\n");
    await expect(resolveUpstreamArtifactEffectiveStateV1(context(options(value)))).resolves.toEqual(
      [{ reason: "lifecycle-store-corrupt", state: "partial" }],
    );
  });
});
