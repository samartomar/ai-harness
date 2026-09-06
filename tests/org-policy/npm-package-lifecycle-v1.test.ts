import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCapability } from "../../src/commands/run.js";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import { SUPPORTED_CLIS } from "../../src/internals/clis.js";
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
import { resolveNpmPackageEffectiveStateV1 } from "../../src/org-policy/npm-package-effective-state-v1.js";
import {
  __isNpmPackageLifecycleAssertionCurrentForInternalTestV1,
  __setNpmPackageLifecycleInternalTestHookV1,
  npmPackageLifecycleCommand,
  npmPackageLifecyclePlan,
  readNpmPackageLifecycleStoreV1,
} from "../../src/org-policy/npm-package-lifecycle-v1.js";
import { observeNpmPackageV1 } from "../../src/org-policy/npm-package-observer-v1.js";
import { verifiedOrgPolicyProjectionActions } from "../../src/org-policy/project.js";
import {
  canonicalOrganizationEvidenceEnvelopeV1,
  organizationEvidenceEnvelopeDigestV1,
} from "../../src/org-policy/qualification-v1.js";
import { readOrgPolicy } from "../../src/org-policy/schema.js";
import { supportedCustodyAcceptPlanV2 } from "../../src/org-policy/supported-admin-v2.js";
import { canonicalAihSupportedQualificationReceiptV2 } from "../../src/org-policy/supported-qualification-receipt-v2.js";
import { upstreamObservationReceiptDigestV1 } from "../../src/org-policy/upstream-observation-receipt-v1.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { buildProgram } from "../../src/program.js";

const fsEvents = vi.hoisted(() => ({
  directoryRead: undefined as ((path: string) => void) | undefined,
  failRecordRename: undefined as ((from: string, to: string) => boolean) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    renameSync: (from: string, to: string) => {
      if (fsEvents.failRecordRename?.(from, to)) throw new Error("injected record rename failure");
      return original.renameSync(from, to);
    },
    opendirSync: (path: string) => {
      const directory = original.opendirSync(path);
      return {
        closeSync: () => directory.closeSync(),
        readSync: () => {
          fsEvents.directoryRead?.(path);
          return directory.readSync();
        },
      } as ReturnType<typeof original.opendirSync>;
    },
  };
});

const INTEGRITY = `sha512-${Buffer.alloc(64, 3).toString("base64")}`;
type NpmFixture = {
  readonly decision: GovernanceDecisionV2 & {
    readonly subject: GovernanceDecisionV2["subject"] & {
      readonly source: Extract<GovernanceDecisionV2["subject"]["source"], { type: "npm" }>;
    };
  };
  readonly evidence: ReturnType<typeof fixture>["evidence"];
};
const HARD_LINKS_AVAILABLE = (() => {
  const probe = mkdtempSync(join(tmpdir(), "aih-npm-lifecycle-hard-link-"));
  try {
    const source = join(probe, "source");
    writeFileSync(source, "probe");
    linkSync(source, join(probe, "linked"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
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
  fsEvents.directoryRead = undefined;
  fsEvents.failRecordRename = undefined;
  __setNpmPackageLifecycleInternalTestHookV1(undefined);
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

function fixture(
  version = "1.2.3",
  integrity = INTEGRITY,
  registry = "https://registry.npmjs.org/",
) {
  const source = {
    type: "npm" as const,
    registry,
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
    issuedAt: "2026-08-01T00:00:00Z",
    notBefore: "2026-08-01T00:00:00Z",
    expiresAt: "2026-08-05T00:00:00Z",
  };
  return {
    ...value,
    decision: { ...value.decision, qualificationBasis: receipt.qualificationBasis },
    receipt,
  };
}

function writeAuthority(
  decision: GovernanceDecisionV2,
  decisionRevocations: readonly Record<string, unknown>[] = [],
  decisions: readonly GovernanceDecisionV2[] = [decision],
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
      targets: [...decision.targets],
      decisions: [...decisions].sort((left, right) => left.id.localeCompare(right.id)),
      decisionRevocations,
    }),
  );
}

function writeFixture(value: NpmFixture = fixture()): void {
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

function writeGovernedPolicy(): void {
  writeFileSync(
    join(root, "aih-org-policy.json"),
    JSON.stringify({
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026.08",
        supportedClis: ["claude"],
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
      },
    }),
  );
}

function context(
  apply = false,
  decision: GovernanceDecisionV2 = fixture().decision,
  options: Record<string, unknown> = {},
  env: Record<string, string> = {},
  calls?: string[][],
): PlanContext {
  const run = fakeRunner((argv) => {
    calls?.push([...argv]);
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
    env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin, ...env },
    options: {
      decision: decision.id,
      decisionDigest: governanceDecisionDigestV2(decision),
      target: "claude",
      evidence: "evidence.json",
      ...options,
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

function recordFile(base: string, digest: string): string {
  const name = `${digest.slice(7)}.json`;
  const relative = lifecycleFiles().find(
    (file) => file.startsWith("records/") && file.endsWith(name),
  );
  if (relative === undefined) throw new Error(`missing lifecycle record ${digest}`);
  return join(base, ...relative.split("/"));
}

function lifecycleRecordDigest(record: unknown): string {
  return `sha256:${createHash("sha256")
    .update("aih-npm-package-lifecycle-record/v1\0", "utf8")
    .update(canonicalStrictJsonBytesV1(record))
    .digest("hex")}`;
}

function lifecycleLineageDigest(lineage: Omit<Record<string, unknown>, "digest">): string {
  return `sha256:${createHash("sha256")
    .update("aih-npm-package-lifecycle-lineage/v1\0", "utf8")
    .update(canonicalStrictJsonBytesV1(lineage))
    .digest("hex")}`;
}

function subjectTargetKey(subjectId: string, target: string): string {
  return createHash("sha256").update(`${subjectId}\0${target}`, "utf8").digest("hex");
}

async function populateCompleteLifecycleHeads(count: number): Promise<void> {
  const value = fixture();
  writeFixture(value);
  await run(context(true, value.decision));
  const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
  const firstHeadName = readdirSync(join(base, "heads")).find((name) => name.endsWith(".json"));
  if (firstHeadName === undefined) throw new Error("expected lifecycle head");
  const firstHead = JSON.parse(readFileSync(join(base, "heads", firstHeadName), "utf8"));
  const firstRecord = JSON.parse(
    readFileSync(recordFile(base, firstHead.recordDigest), "utf8"),
  ) as Record<string, unknown>;
  for (let index = 1; index < count; index += 1) {
    const subjectId = `capacity-subject-${index}`;
    const { digest: _digest, ...baseLineage } = firstRecord.lineage as Record<string, unknown>;
    const target = baseLineage.target;
    if (typeof target !== "string") throw new Error("expected lifecycle target");
    const lineageBase = { ...baseLineage, subjectId };
    const lineage = {
      ...lineageBase,
      digest: lifecycleLineageDigest(lineageBase),
    };
    const record = structuredClone(firstRecord) as Record<string, unknown>;
    const observation = record.observation as Record<string, unknown>;
    record.lineage = lineage;
    record.observation = {
      ...observation,
      subject: { ...(observation.subject as Record<string, unknown>), id: subjectId },
    };
    record.observationDigest = upstreamObservationReceiptDigestV1(
      record.observation as Parameters<typeof upstreamObservationReceiptDigestV1>[0],
    );
    const recordDigest = lifecycleRecordDigest(record);
    const partition = lineage.digest.slice("sha256:".length);
    const key = subjectTargetKey(subjectId, target);
    const binding = canonicalStrictJsonBytesV1({
      format: "aih-npm-package-lifecycle-subject",
      lineage,
      version: 1,
    });
    mkdirSync(join(base, "records", partition), { recursive: true });
    writeFileSync(
      join(base, "records", partition, `${recordDigest.slice("sha256:".length)}.json`),
      canonicalStrictJsonBytesV1(record),
    );
    writeFileSync(
      join(base, "heads", `${partition}.json`),
      canonicalStrictJsonBytesV1({
        format: "aih-npm-package-lifecycle-head",
        lineageDigest: lineage.digest,
        recordDigest,
        sequence: 1,
        subjectDigest: record.subjectDigest,
        version: 1,
      }),
    );
    writeFileSync(join(base, "claims", `${key}.json`), binding);
    writeFileSync(join(base, "subjects", `${key}.json`), binding);
  }
  writeFileSync(
    join(base, "capacity.json"),
    canonicalStrictJsonBytesV1({
      format: "aih-npm-package-lifecycle-capacity",
      headCount: count,
      recordCount: count,
      version: 1,
    }),
  );
}

function writeAggregateHeadCapacity(headCount: number, sequence: number): void {
  const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
  mkdirSync(join(base, "heads"), { recursive: true });
  for (let index = 0; index < headCount; index += 1) {
    const digest = `${index.toString(16).padStart(63, "0")}f`;
    writeFileSync(
      join(base, "heads", `${digest}.json`),
      canonicalStrictJsonBytesV1({
        format: "aih-npm-package-lifecycle-head",
        lineageDigest: `sha256:${digest}`,
        recordDigest: `sha256:${"a".repeat(63)}${index.toString(16)}`,
        sequence,
        subjectDigest: `sha256:${"b".repeat(64)}`,
        version: 1,
      }),
    );
  }
  writeFileSync(
    join(base, "capacity.json"),
    canonicalStrictJsonBytesV1({
      format: "aih-npm-package-lifecycle-capacity",
      headCount,
      recordCount: headCount * sequence,
      version: 1,
    }),
  );
}

async function execute(ctx: PlanContext) {
  return executePlan(await npmPackageLifecyclePlan(ctx), ctx, {
    skipWorktreeGate: true,
  });
}

async function run(ctx: PlanContext) {
  const result = await execute(ctx);
  return result.digests[0]?.data as { applied: boolean; outcome: string };
}

function expectRevokedCheck(result: Awaited<ReturnType<typeof execute>>): void {
  expect(result.report?.exitCode()).toBe(1);
  expect(result.report?.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "org-policy.lifecycle-decision-revoked",
        verdict: "fail",
      }),
    ]),
  );
}

function immutableRecordAction(planned: Awaited<ReturnType<typeof npmPackageLifecyclePlan>>) {
  const action = planned.actions.find(
    (candidate) =>
      candidate.kind === "write" &&
      candidate.path.startsWith(".aih/governance/") &&
      candidate.path.includes("/records/"),
  );
  if (action?.kind !== "write" || action.contents === undefined) {
    throw new Error("expected immutable lifecycle record action");
  }
  return { contents: action.contents, durable: action.durable, path: action.path };
}

function preplace(action: { contents: string; path: string }): void {
  const path = join(root, ...action.path.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, action.contents);
}

function recordScratch(action: { path: string }): string {
  return `${join(root, ...action.path.split("/"))}.aih.tmp`;
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

describe("npm package lifecycle V1", () => {
  it("re-observes an enterprise-shaped external custody assertion inside its trusted base", () => {
    const externalBase = join(root, "enterprise-custody");
    mkdirSync(externalBase, { recursive: true });
    const path = join(externalBase, "heads", "current.json");
    mkdirSync(dirname(path), { recursive: true });
    const contents = '{"current":true}\n';
    writeFileSync(path, contents);
    const action = {
      kind: "write" as const,
      path,
      contents,
      exactContents: true as const,
      describe: "assert enterprise supported custody head unchanged",
      assertUnchanged: true as const,
      external: true as const,
      trustedBase: externalBase,
      expect: {
        sha256: createHash("sha256").update(contents, "utf8").digest("hex"),
      },
    };

    expect(__isNpmPackageLifecycleAssertionCurrentForInternalTestV1(root, action)).toBe(true);
    writeFileSync(path, "tampered\n");
    expect(__isNpmPackageLifecycleAssertionCurrentForInternalTestV1(root, action)).toBe(false);
  });

  it("delegates an evidence-free AIH-supported lifecycle request to the observer without preview or apply writes", async () => {
    const value = supportedFixture();
    writeFixture(value);
    writeFileSync(
      join(root, ".aih", "aih-supported-qualification-receipt.json"),
      canonicalAihSupportedQualificationReceiptV2(value.receipt),
    );
    const calls: string[][] = [];
    const ctx = context(
      false,
      value.decision,
      { evidence: undefined },
      {
        AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "aihq/supported-catalog",
        AIH_SUPPORTED_QUALIFICATION_WORKFLOW: "qualification.yml",
      },
      calls,
    );

    const result = await execute(ctx);

    expect(result.digests[0]?.data).toMatchObject({
      applied: false,
      outcome: "refused",
      reason: "observation-unverified",
    });
    expect(calls).toHaveLength(2);
    expect(lifecycleFiles()).toEqual([]);
  });

  it.each(["", " ", 7, null])(
    "rejects a supplied invalid evidence value for an AIH-supported lifecycle before observation (%j)",
    async (evidence) => {
      const value = supportedFixture();
      const calls: string[][] = [];

      const result = await execute(context(false, value.decision, { evidence }, {}, calls));

      expect(result.digests[0]?.data).toMatchObject({
        applied: false,
        outcome: "refused",
        reason: "invalid-input",
        state: "invalid-input",
      });
      expect(calls).toEqual([]);
      expect(lifecycleFiles()).toEqual([]);
    },
  );

  it("persists an evidence-free AIH-supported lifecycle only after the branded custody accept path", async () => {
    const value = supportedFixture();
    writeFixture(value);
    writeFileSync(
      join(root, ".aih", "aih-supported-qualification-receipt.json"),
      canonicalAihSupportedQualificationReceiptV2(value.receipt),
    );
    const env = {
      AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "aihq/supported-catalog",
      AIH_SUPPORTED_QUALIFICATION_WORKFLOW: "qualification.yml",
    };
    const accept = context(true, value.decision, { evidence: undefined }, env);
    await executePlan(await supportedCustodyAcceptPlanV2(accept), accept, {
      skipWorktreeGate: true,
    });

    const preview = await run(context(false, value.decision, { evidence: undefined }, env));
    expect(preview).toMatchObject({
      applied: false,
      outcome: "reported-only",
      state: "observed-effective",
    });
    expect(lifecycleFiles()).toEqual([]);

    const applied = await run(context(true, value.decision, { evidence: undefined }, env));
    expect(applied).toMatchObject({
      applied: true,
      outcome: "fulfilled",
      state: "observed-effective",
    });
    expect(readNpmPackageLifecycleStoreV1(root)).toMatchObject({ kind: "complete" });
  });

  it("refuses a supported lifecycle when its fixed receipt changes after transaction assertions", async () => {
    const value = supportedFixture();
    writeFixture(value);
    const receiptPath = join(root, ".aih", "aih-supported-qualification-receipt.json");
    writeFileSync(receiptPath, canonicalAihSupportedQualificationReceiptV2(value.receipt));
    const env = {
      AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "aihq/supported-catalog",
      AIH_SUPPORTED_QUALIFICATION_WORKFLOW: "qualification.yml",
    };
    const accept = context(true, value.decision, { evidence: undefined }, env);
    await executePlan(await supportedCustodyAcceptPlanV2(accept), accept, {
      skipWorktreeGate: true,
    });
    const ctx = context(true, value.decision, { evidence: undefined }, env);
    const planned = await npmPackageLifecyclePlan(ctx);
    __setNpmPackageLifecycleInternalTestHookV1(() => writeFileSync(receiptPath, "tampered\n"));

    const result = await executePlan(planned, ctx, { skipWorktreeGate: true });

    expect(result.digests[0]?.data).toMatchObject({
      applied: false,
      outcome: "refused",
      reason: "store-detached",
      state: "store-detached",
    });
  });

  it.each(["members", "signers"])(
    "refuses a supported lifecycle when a foreign %s custody entry appears after transaction assertions",
    async (directory) => {
      const value = supportedFixture();
      writeFixture(value);
      writeFileSync(
        join(root, ".aih", "aih-supported-qualification-receipt.json"),
        canonicalAihSupportedQualificationReceiptV2(value.receipt),
      );
      const env = {
        AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "aihq/supported-catalog",
        AIH_SUPPORTED_QUALIFICATION_WORKFLOW: "qualification.yml",
      };
      const accept = context(true, value.decision, { evidence: undefined }, env);
      await executePlan(await supportedCustodyAcceptPlanV2(accept), accept, {
        skipWorktreeGate: true,
      });
      const ctx = context(true, value.decision, { evidence: undefined }, env);
      const planned = await npmPackageLifecyclePlan(ctx);
      __setNpmPackageLifecycleInternalTestHookV1(() => {
        const foreign = join(
          root,
          ".aih",
          "supported-qualification",
          "v2",
          directory,
          "foreign.json",
        );
        writeFileSync(foreign, "{}\n");
      });

      const result = await executePlan(planned, ctx, { skipWorktreeGate: true });

      expect(result.digests[0]?.data).toMatchObject({
        applied: false,
        outcome: "refused",
        reason: "store-detached",
        state: "store-detached",
      });
      expect(readNpmPackageLifecycleStoreV1(root)).toMatchObject({ kind: "complete" });
    },
  );

  it("keeps preview zero-write, then appends immutable observation records before advancing a subject head", async () => {
    writeFixture();
    const planned = await npmPackageLifecyclePlan(context(true));
    expect(immutableRecordAction(planned).durable).toBe(true);
    expect(planned.commitLock).toBe(
      ".aih/governance/npm-package-lifecycle/v1/locks/lifecycle.lock",
    );
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

  it("exposes an intact current npm lifecycle chain as read-only observed effective state", async () => {
    writeFixture();
    await run(context(true));

    const resolved = await resolveNpmPackageEffectiveStateV1(context(false));

    expect(resolved).toEqual([
      expect.objectContaining({
        decision: {
          digest: governanceDecisionDigestV2(fixture().decision),
          id: "decision-acme-widget",
        },
        state: "observed-effective",
        target: "claude",
      }),
    ]);
  });

  it("feeds current observed lifecycle state into policy evaluate without package effects", async () => {
    writeFixture();
    writeGovernedPolicy();
    const before = lifecycleFiles();
    await run(context(true));
    const afterLifecycle = lifecycleFiles();

    const check = await orgPolicyEffectiveCheck(context(false));

    expect(check).toMatchObject({ verdict: "pass" });
    expect(lifecycleFiles()).toEqual(afterLifecycle);
    expect(afterLifecycle).not.toEqual(before);
    expect(existsSync(join(root, ".aih", "run-log.jsonl"))).toBe(false);
  });

  it("keeps expired observations distinct from a current authority", async () => {
    writeFixture();
    await run(context(true));
    vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000);

    const resolved = await resolveNpmPackageEffectiveStateV1(context(false));

    expect(resolved).toEqual([
      expect.objectContaining({ state: "stale", reason: "observation-stale" }),
    ]);
  });

  it("refuses a self-consistent future durable observation before it can become effective", async () => {
    const value = fixture();
    writeFixture(value);
    writeGovernedPolicy();
    await run(context(true, value.decision));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const headName = readdirSync(join(base, "heads")).find((name) => name.endsWith(".json"));
    if (headName === undefined) throw new Error("expected lifecycle head");
    const headPath = join(base, "heads", headName);
    const head = JSON.parse(readFileSync(headPath, "utf8"));
    const originalPath = recordFile(base, head.recordDigest);
    const record = JSON.parse(readFileSync(originalPath, "utf8")) as Record<string, unknown>;
    const observation = record.observation as Parameters<
      typeof upstreamObservationReceiptDigestV1
    >[0];
    const future = {
      ...observation,
      observedAt: "2026-08-02T12:01:00.000Z",
      validUntil: "2026-08-03T12:01:00.000Z",
    };
    record.observation = future;
    record.observationDigest = upstreamObservationReceiptDigestV1(future);
    const digest = lifecycleRecordDigest(record);
    const futurePath = join(dirname(originalPath), `${digest.slice("sha256:".length)}.json`);
    rmSync(originalPath);
    writeFileSync(futurePath, canonicalStrictJsonBytesV1(record));
    writeFileSync(headPath, canonicalStrictJsonBytesV1({ ...head, recordDigest: digest }));

    const resolved = await resolveNpmPackageEffectiveStateV1(context(false));
    expect(resolved).toEqual([
      expect.objectContaining({ state: "drifted", reason: "observation-drift" }),
    ]);
    expect(JSON.stringify(resolved)).not.toContain("observed-effective");
    await expect(orgPolicyEffectiveCheck(context(false))).resolves.toMatchObject({
      code: "org-policy.effective-blocked",
      verdict: "fail",
    });
  });

  it("keeps a 24-hour observation effective after 60 seconds, while stale history blocks evaluate but not projection", async () => {
    const value = fixture();
    writeFixture(value);
    writeGovernedPolicy();
    expect((await npmPackageLifecyclePlan(context(true, value.decision))).commitNotAfter).toBe(
      "2026-08-02T12:01:00.000Z",
    );
    await run(context(true, value.decision));
    const policy = readOrgPolicy(root, context(false).env);
    if (policy === undefined) throw new Error("expected governed policy");

    vi.advanceTimersByTime(61_000);
    await expect(resolveNpmPackageEffectiveStateV1(context(false))).resolves.toEqual([
      expect.objectContaining({ state: "observed-effective" }),
    ]);
    await expect(verifiedOrgPolicyProjectionActions(context(false), policy)).resolves.toBeDefined();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 61_000);
    await expect(resolveNpmPackageEffectiveStateV1(context(false))).resolves.toEqual([
      expect.objectContaining({ state: "stale", reason: "observation-stale" }),
    ]);
    await expect(orgPolicyEffectiveCheck(context(false))).resolves.toMatchObject({
      code: "org-policy.effective-blocked",
      verdict: "fail",
    });
    await expect(verifiedOrgPolicyProjectionActions(context(false), policy)).resolves.toBeDefined();
  });

  it("accepts a current multi-effect decision when its durable observation remains install-only", async () => {
    const value = fixture();
    const decision = {
      ...value.decision,
      allowedEffects: ["install", "use"],
    } as GovernanceDecisionV2;
    writeFixture({ ...value, decision: decision as typeof value.decision });
    await run(context(true, decision));

    await expect(resolveNpmPackageEffectiveStateV1(context(false))).resolves.toEqual([
      expect.objectContaining({ state: "observed-effective" }),
    ]);
  });

  it("refuses a live subject-wide rejection and reports a current revocation distinctly", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const revocation = {
      format: "aih-governance-decision-revocation",
      version: 2,
      decisionDigest: governanceDecisionDigestV2(value.decision),
      issuer: "platform-security",
      revokedAt: "2026-08-01T00:00:00+00:00",
      reason: "Critical upstream withdrawal.",
    };
    writeAuthority(value.decision, [revocation]);
    await run(context(true, value.decision));

    expect(readNpmPackageLifecycleStoreV1(root)).toMatchObject({ kind: "complete" });

    const resolved = await resolveNpmPackageEffectiveStateV1(context(false));

    expect(resolved).toEqual([
      expect.objectContaining({ state: "revoked", reason: "decision-revoked" }),
    ]);
  });

  it("bounds reporting lifecycle partition enumeration at the configured head cap", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const partitions = join(root, ".aih", "governance", "npm-package-lifecycle", "v1", "records");
    let added = 0;
    for (let value = 0; added < 256; value += 1) {
      const name = `${value.toString(16).padStart(63, "0")}f`;
      const candidate = join(partitions, name);
      if (existsSync(candidate)) continue;
      mkdirSync(candidate);
      added += 1;
    }
    let reads = 0;
    fsEvents.directoryRead = (path) => {
      if (path === partitions) reads += 1;
    };

    expect(readNpmPackageLifecycleStoreV1(root)).toEqual({ kind: "corrupt" });
    // The reader detects detached durable partitions without materializing a
    // hostile directory beyond the configured bounded read.
    expect(reads).toBe(257);
  });

  it("keeps a complete store at 256 heads readable and refuses an official 257th lineage without writes", async () => {
    await populateCompleteLifecycleHeads(256);
    expect(readNpmPackageLifecycleStoreV1(root)).toMatchObject({
      kind: "complete",
      records: expect.arrayContaining([expect.anything()]),
    });
    const codex = context(true);
    codex.options.target = "codex";
    const before = lifecycleFiles();

    expect(await run(codex)).toMatchObject({
      outcome: "refused",
      state: "store-over-capacity",
    });
    expect(lifecycleFiles()).toEqual(before);
  }, 30_000);

  it("refuses an aggregate 16,385th candidate from bounded canonical head metadata", async () => {
    writeFixture();
    writeAggregateHeadCapacity(4, 4_096);
    const codex = context(true);
    codex.options.target = "codex";
    const before = lifecycleFiles();

    expect(await run(codex)).toMatchObject({
      outcome: "refused",
      state: "store-over-capacity",
    });
    expect(lifecycleFiles()).toEqual(before);
  });

  it("refuses a stale cross-lineage last-slot plan before any losing lifecycle mutation", async () => {
    await populateCompleteLifecycleHeads(255);
    const value = fixture();
    const decision = { ...value.decision, targets: ["claude", "codex", "cursor"] };
    writeAuthority(decision);
    const codex = context(true, decision);
    codex.options.target = "codex";
    const cursor = context(true, decision);
    cursor.options.target = "cursor";
    const first = await npmPackageLifecyclePlan(codex);
    const stale = await npmPackageLifecyclePlan(cursor);
    expect(first.commitLock).toBe(".aih/governance/npm-package-lifecycle/v1/locks/lifecycle.lock");
    expect(stale.commitLock).toBe(first.commitLock);

    await executePlan(first, codex, { skipWorktreeGate: true });
    const afterWinner = lifecycleFiles();
    await expect(executePlan(stale, cursor, { skipWorktreeGate: true })).rejects.toThrow(
      "changed after the plan was computed",
    );
    expect(lifecycleFiles()).toEqual(afterWinner);
  }, 30_000);

  it("migrates an absent aggregate guard but refuses a substituted one without lifecycle writes", async () => {
    writeFixture();
    await run(context(true));
    const guard = join(root, ".aih", "governance", "npm-package-lifecycle", "v1", "capacity.json");
    rmSync(guard);
    vi.advanceTimersByTime(1_000);
    expect(await run(context(true))).toMatchObject({ outcome: "fulfilled" });
    const guardDescriptor = openSync(guard, "r+");
    try {
      expect(fstatSync(guardDescriptor).isFile()).toBe(true);
      ftruncateSync(guardDescriptor, 0);
      writeSync(guardDescriptor, "{}");
    } finally {
      closeSync(guardDescriptor);
    }
    const before = lifecycleFiles();
    vi.advanceTimersByTime(1_000);

    expect(await run(context(true))).toMatchObject({
      outcome: "refused",
      state: "store-corrupt",
    });
    expect(lifecycleFiles()).toEqual(before);
  });

  it("reports external over-capacity state distinctly and blocks evaluate and projection", async () => {
    await populateCompleteLifecycleHeads(257);
    writeGovernedPolicy();

    expect(readNpmPackageLifecycleStoreV1(root)).toEqual({ kind: "over-capacity" });
    await expect(resolveNpmPackageEffectiveStateV1(context(false))).resolves.toEqual([
      { state: "partial", reason: "lifecycle-store-over-capacity" },
    ]);
    await expect(orgPolicyEffectiveCheck(context(false))).resolves.toMatchObject({
      code: "org-policy.effective-blocked",
      verdict: "fail",
    });
    const policy = readOrgPolicy(root, context(false).env);
    if (policy === undefined) throw new Error("expected governed policy");
    await expect(verifiedOrgPolicyProjectionActions(context(false), policy)).rejects.toThrow(
      "policy project refuses blocked candidate activation",
    );
  });

  it("blocks policy evaluate when the durable lifecycle head is revoked", async () => {
    const value = fixture();
    writeFixture(value);
    writeGovernedPolicy();
    await run(context(true, value.decision));
    writeAuthority(value.decision, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: governanceDecisionDigestV2(value.decision),
        issuer: "platform-security",
        revokedAt: "2026-08-01T00:00:00+00:00",
        reason: "Critical upstream withdrawal.",
      },
    ]);
    await run(context(true, value.decision));

    const check = await orgPolicyEffectiveCheck(context(false));

    expect(check).toMatchObject({
      code: "org-policy.effective-blocked",
      verdict: "fail",
    });
    expect(check.detail).toContain("decision-revoked");
  });

  it("refuses hostile durable lineage and decision identifiers before they can render", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    writeAuthority(value.decision, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: governanceDecisionDigestV2(value.decision),
        issuer: "platform-security",
        revokedAt: "2026-08-01T00:00:00+00:00",
        reason: "Critical upstream withdrawal.",
      },
    ]);
    await run(context(true, value.decision));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const headName = readdirSync(join(base, "heads")).find((name) => name.endsWith(".json"));
    if (headName === undefined) throw new Error("expected lifecycle head");
    const headPath = join(base, "heads", headName);
    const head = JSON.parse(readFileSync(headPath, "utf8"));
    const recordPath = recordFile(base, head.recordDigest);
    const originalRecord = readFileSync(recordPath);
    const originalHead = readFileSync(headPath);
    const invalidLineage = [
      (record: Record<string, unknown>) => {
        (record.lineage as Record<string, unknown>).subjectId = "acme\n|forged";
      },
      (record: Record<string, unknown>) => {
        (record.lineage as Record<string, unknown>).target = "unrecognized-cli";
      },
    ];
    for (const mutate of invalidLineage) {
      const record = JSON.parse(originalRecord.toString("utf8")) as Record<string, unknown>;
      mutate(record);
      const digest = lifecycleRecordDigest(record);
      const substitutedPath = join(dirname(recordPath), `${digest.slice("sha256:".length)}.json`);
      rmSync(recordPath);
      writeFileSync(substitutedPath, canonicalStrictJsonBytesV1(record));
      writeFileSync(headPath, canonicalStrictJsonBytesV1({ ...head, recordDigest: digest }));
      const resolved = await resolveNpmPackageEffectiveStateV1(context(false));
      expect(resolved).toEqual([{ state: "partial", reason: "lifecycle-store-corrupt" }]);
      expect(JSON.stringify(resolved)).not.toContain("forged");
      rmSync(substitutedPath);
      writeFileSync(recordPath, originalRecord);
      writeFileSync(headPath, originalHead);
    }
    const hostile = JSON.parse(originalRecord.toString("utf8")) as Record<string, unknown>;
    (hostile.decision as Record<string, unknown>).id = `decision\n|${"x".repeat(80)}`;
    const hostileDigest = lifecycleRecordDigest(hostile);
    const hostilePath = join(dirname(recordPath), `${hostileDigest.slice("sha256:".length)}.json`);
    writeFileSync(hostilePath, canonicalStrictJsonBytesV1(hostile));
    rmSync(recordPath);
    writeFileSync(headPath, canonicalStrictJsonBytesV1({ ...head, recordDigest: hostileDigest }));

    const resolved = await resolveNpmPackageEffectiveStateV1(context(false));
    expect(resolved).toEqual([{ state: "partial", reason: "lifecycle-store-corrupt" }]);
    writeGovernedPolicy();
    const check = await orgPolicyEffectiveCheck(context(false));
    const report = await orgPolicyEffectiveDigest(context(false));
    expect(JSON.stringify(check)).not.toContain("forged");
    expect(JSON.stringify(resolved)).not.toContain("forged");
    expect(report?.text).not.toContain("forged");
    writeFileSync(headPath, originalHead);
  });

  it("refuses a current subject-wide rejection even when the recorded decision remains approved", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const rejection = {
      ...value.decision,
      id: "decision-acme-widget-rejected",
      disposition: "rejected" as const,
      reason: "The exact package is now rejected.",
    };
    writeAuthority(value.decision, [], [value.decision, rejection]);
    // The chain is still locally canonical; only current authority changes.
    await run(context(true, value.decision));

    const resolved = await resolveNpmPackageEffectiveStateV1(context(false));

    expect(resolved).toEqual([
      expect.objectContaining({ state: "refused", reason: "decision-rejected" }),
    ]);
  });

  it("keeps unavailable and expired authority distinct without lifecycle writes", async () => {
    writeFixture();
    await run(context(true));
    const before = lifecycleFiles();
    const unavailable = await resolveNpmPackageEffectiveStateV1({
      ...context(false),
      env: { PATH: bin },
    });
    vi.advanceTimersByTime(9 * 24 * 60 * 60 * 1000);
    const stale = await resolveNpmPackageEffectiveStateV1(context(false));

    expect(unavailable).toEqual([
      expect.objectContaining({ state: "withheld", reason: "authority-unverified" }),
    ]);
    expect(stale).toEqual([
      expect.objectContaining({ state: "stale", reason: "authority-not-current" }),
    ]);
    expect(lifecycleFiles()).toEqual(before);
  });

  it("refuses a renamed lifecycle head rather than accepting a detached record", async () => {
    writeFixture();
    await run(context(true));
    const head = lifecycleFiles().find(
      (file) => file.startsWith("heads/") && file.endsWith(".json"),
    );
    if (head === undefined) throw new Error("expected lifecycle head");
    const original = join(
      root,
      ".aih",
      "governance",
      "npm-package-lifecycle",
      "v1",
      ...head.split("/"),
    );
    const substituted = join(dirname(original), `${"0".repeat(64)}.json`);
    copyFileSync(original, substituted);
    rmSync(original);

    expect(await resolveNpmPackageEffectiveStateV1(context(false))).toEqual([
      { state: "partial", reason: "lifecycle-store-corrupt" },
    ]);
  });

  it("refuses a linked lifecycle-head parent without following it", async () => {
    writeFixture();
    await run(context(true));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const heads = join(base, "heads");
    const outside = join(root, "outside-heads");
    rmSync(heads, { recursive: true, force: true });
    mkdirSync(outside);
    symlinkSync(outside, heads, process.platform === "win32" ? "junction" : "dir");

    expect(await resolveNpmPackageEffectiveStateV1(context(false))).toEqual([
      { state: "partial", reason: "lifecycle-store-unsafe" },
    ]);
  });

  it.skipIf(!HARD_LINKS_AVAILABLE)("refuses hard-linked canonical lifecycle files", async () => {
    writeFixture();
    await run(context(true));
    vi.advanceTimersByTime(1_000);
    await run(context(true));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const headName = lifecycleFiles().find(
      (file) => file.startsWith("heads/") && file.endsWith(".json"),
    );
    const binding = lifecycleFiles().find((file) => file.startsWith("subjects/"));
    const claim = lifecycleFiles().find((file) => file.startsWith("claims/"));
    if (headName === undefined || binding === undefined || claim === undefined) {
      throw new Error("expected canonical lifecycle files");
    }
    const head = JSON.parse(readFileSync(join(base, ...headName.split("/")), "utf8"));
    const backup = JSON.parse(
      readFileSync(join(base, ...`${headName}.aih.bak`.split("/")), "utf8"),
    );
    const paths = [
      join(base, ...headName.split("/")),
      recordFile(base, head.recordDigest),
      recordFile(base, backup.recordDigest),
      join(base, ...binding.split("/")),
      join(base, ...claim.split("/")),
      join(base, ...`${headName}.aih.bak`.split("/")),
    ];
    for (const [index, path] of paths.entries()) {
      const outside = join(root, `outside-hard-linked-${index}.json`);
      linkSync(path, outside);
      try {
        expect(await resolveNpmPackageEffectiveStateV1(context(false))).toEqual([
          { state: "partial", reason: "lifecycle-store-corrupt" },
        ]);
      } finally {
        rmSync(outside, { force: true });
      }
    }
  });

  it.skipIf(!HARD_LINKS_AVAILABLE)(
    "reports a detached lifecycle result when the capacity guard is linked after apply",
    async () => {
      writeFixture();
      const ctx = context(true);
      const planned = await npmPackageLifecyclePlan(ctx);
      planned.actions.push({
        argv: ["link-capacity-guard"],
        describe: "link lifecycle capacity guard after apply",
        kind: "exec",
      });
      const originalRun = ctx.run;
      ctx.run = async (argv, options) => {
        if (argv[0] === "link-capacity-guard") {
          linkSync(
            join(root, ".aih", "governance", "npm-package-lifecycle", "v1", "capacity.json"),
            join(root, "linked-capacity-guard.json"),
          );
          return { code: 0, stderr: "", stdout: "" };
        }
        return originalRun(argv, options);
      };

      const result = await executePlan(planned, ctx, { skipWorktreeGate: true });
      expect(result.digests[0]?.data).toMatchObject({
        applied: false,
        outcome: "refused",
        state: "store-detached",
      });
      expect(result.report?.ok).toBe(false);
    },
  );

  it("treats a newly attested authority receipt as drift until lifecycle is re-observed", async () => {
    const current = fixture();
    writeFixture(current);
    await run(context(true, current.decision));
    const replacement = fixture("1.2.4", `sha512-${Buffer.alloc(64, 9).toString("base64")}`);
    writeAuthority(replacement.decision);

    const resolved = await resolveNpmPackageEffectiveStateV1(context(false));

    expect(resolved).toEqual([
      expect.objectContaining({ state: "drifted", reason: "decision-or-custody-drift" }),
    ]);
  });

  it("does not reuse an old authority receipt digest when the current decision is unchanged", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const authorityPath = join(root, ".aih", "policy-authority-receipt.json");
    const replacement = JSON.parse(readFileSync(authorityPath, "utf8")) as Record<string, unknown>;
    replacement.expiresAt = "2026-08-11T00:00:00+00:00";
    writeFileSync(authorityPath, JSON.stringify(replacement));

    const resolved = await resolveNpmPackageEffectiveStateV1(context(false));

    expect(resolved).toEqual([
      expect.objectContaining({ state: "drifted", reason: "authority-receipt-drift" }),
    ]);
  });

  it("refuses current authority substitutions of the recorded decision, source, subject, target, or effect", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const changedSource = fixture("1.2.4").decision;
    const changedSubject = {
      ...value.decision,
      subject: {
        ...value.decision.subject,
        id: "acme-widget-other",
        subjectDigest: governanceDecisionSubjectDigestV2({
          kind: "package",
          id: "acme-widget-other",
          sourceDigest: value.decision.subject.sourceDigest,
        }),
      },
    } as GovernanceDecisionV2;
    const changedTarget = {
      ...value.decision,
      targets: ["claude"],
    } as GovernanceDecisionV2;
    const changedEffect = {
      ...value.decision,
      allowedEffects: ["observe"],
    } as GovernanceDecisionV2;

    for (const replacement of [changedSource, changedSubject, changedTarget, changedEffect]) {
      writeAuthority(replacement);
      await expect(resolveNpmPackageEffectiveStateV1(context(false))).resolves.toEqual([
        expect.objectContaining({ state: "drifted", reason: "decision-or-custody-drift" }),
      ]);
    }
  });

  it("refuses an extra detached immutable record rather than selecting the head alone", async () => {
    writeFixture();
    await run(context(true));
    const record = lifecycleFiles().find((file) => file.startsWith("records/"));
    if (record === undefined) throw new Error("expected lifecycle record");
    const original = join(
      root,
      ".aih",
      "governance",
      "npm-package-lifecycle",
      "v1",
      ...record.split("/"),
    );
    copyFileSync(original, join(dirname(original), `${"f".repeat(64)}.json`));

    expect(await resolveNpmPackageEffectiveStateV1(context(false))).toEqual([
      { state: "partial", reason: "lifecycle-store-corrupt" },
    ]);
  });

  it("treats a removed head with durable records as partial and blocks policy evaluate", async () => {
    writeFixture();
    writeGovernedPolicy();
    await run(context(true));
    const head = lifecycleFiles().find(
      (file) => file.startsWith("heads/") && file.endsWith(".json"),
    );
    if (head === undefined) throw new Error("expected lifecycle head");
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    rmSync(join(base, ...head.split("/")));
    rmSync(join(base, ...`${head}.aih.bak`.split("/")), { force: true });

    await expect(resolveNpmPackageEffectiveStateV1(context(false))).resolves.toEqual([
      { state: "partial", reason: "lifecycle-store-corrupt" },
    ]);
    await expect(orgPolicyEffectiveCheck(context(false))).resolves.toMatchObject({
      code: "org-policy.effective-blocked",
      verdict: "fail",
    });
  });

  it("bounds aggregate effective-state history work before walking hostile chains", () => {
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const lineage = `sha256:${"a".repeat(64)}`;
    mkdirSync(join(base, "heads"), { recursive: true });
    mkdirSync(join(base, "records", lineage.slice("sha256:".length)), { recursive: true });
    writeFileSync(
      join(base, "heads", `${lineage.slice("sha256:".length)}.json`),
      canonicalStrictJsonBytesV1({
        format: "aih-npm-package-lifecycle-head",
        lineageDigest: lineage,
        recordDigest: `sha256:${"b".repeat(64)}`,
        sequence: 16_385,
        subjectDigest: `sha256:${"c".repeat(64)}`,
        version: 1,
      }),
    );

    expect(readNpmPackageLifecycleStoreV1(root)).toEqual({ kind: "over-capacity" });
  });

  it("is deterministic and leaves package, lifecycle, and run-ledger bytes untouched", async () => {
    writeFixture();
    await run(context(true));
    const lockBefore = readFileSync(join(root, "package-lock.json"));
    const manifestBefore = readFileSync(
      join(root, "node_modules", "@acme", "widget", "package.json"),
    );
    const lifecycleBefore = lifecycleFiles();
    const base = context(false);
    let processCalls = 0;
    const counted: PlanContext = {
      ...base,
      run: async (...args) => {
        processCalls += 1;
        return base.run(...args);
      },
    };

    const first = await resolveNpmPackageEffectiveStateV1(counted);
    const second = await resolveNpmPackageEffectiveStateV1(counted);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(processCalls).toBe(2);
    expect(readFileSync(join(root, "package-lock.json"))).toEqual(lockBefore);
    expect(readFileSync(join(root, "node_modules", "@acme", "widget", "package.json"))).toEqual(
      manifestBefore,
    );
    expect(lifecycleFiles()).toEqual(lifecycleBefore);
    expect(existsSync(join(root, ".aih", "run-log.jsonl"))).toBe(false);
  });

  it("fails closed as partial when a canonical lifecycle head loses its immutable record", async () => {
    writeFixture();
    await run(context(true));
    const record = lifecycleFiles().find((file) => file.startsWith("records/"));
    if (record === undefined) throw new Error("expected lifecycle record");
    rmSync(join(root, ".aih", "governance", "npm-package-lifecycle", "v1", ...record.split("/")));

    const resolved = await resolveNpmPackageEffectiveStateV1(context(false));

    expect(resolved).toEqual([{ state: "partial", reason: "lifecycle-store-corrupt" }]);
  });

  it("uses one stable store-wide lock across first-time lineage changes", async () => {
    const first = fixture();
    writeFixture(first);
    const firstPlan = await npmPackageLifecyclePlan(context(true, first.decision));

    const changed = fixture(
      "1.2.4",
      `sha512-${Buffer.alloc(64, 4).toString("base64")}`,
      "https://registry.example.com/",
    );
    writeFixture(changed);
    const changedPlan = await npmPackageLifecyclePlan(context(true, changed.decision));

    expect(firstPlan.commitLock).toBe(changedPlan.commitLock);
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
    const records = lifecycleFiles().filter(
      (file) => file.startsWith("records/") && file.endsWith(".json"),
    );
    expect(heads).toHaveLength(1);
    expect(records).toHaveLength(2);
    const head = JSON.parse(readFileSync(join(base, "heads", heads[0] as string), "utf8"));
    const newest = JSON.parse(readFileSync(recordFile(base, head.recordDigest), "utf8"));
    expect(newest.sequence).toBe(2);
    expect(newest.previousRecordDigest).toMatch(/^sha256:/);
    const prior = JSON.parse(readFileSync(recordFile(base, newest.previousRecordDigest), "utf8"));
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
    const revokedExecution = await execute(context(true, value.decision));
    const revoked = revokedExecution.digests[0]?.data as {
      applied: boolean;
      outcome: string;
      recordDigest?: string;
      state: string;
    };
    expect(revoked).toMatchObject({ outcome: "fulfilled", state: "decision-revoked" });
    expect(revoked.applied).toBe(true);
    expect(revoked.recordDigest).toMatch(/^sha256:/);
    expectRevokedCheck(revokedExecution);
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
    const record = JSON.parse(readFileSync(recordFile(base, head.recordDigest), "utf8"));
    expect(record.revocation).toEqual(revocation);
    expect(record.authorityReceiptDigest).toMatch(/^sha256:/);
    expect(record).not.toHaveProperty("removed");
    expect(record).not.toHaveProperty("terminated");
    const recordsBefore = lifecycleFiles().filter((file) => file.startsWith("records/"));
    const repeatedExecution = await execute(context(true, value.decision));
    const repeated = repeatedExecution.digests[0]?.data as { outcome: string; state: string };
    expect(repeated).toMatchObject({ outcome: "reported-only", state: "decision-revoked" });
    expectRevokedCheck(repeatedExecution);
    expect(lifecycleFiles().filter((file) => file.startsWith("records/"))).toEqual(recordsBefore);
  });

  it("reports a first-seen revoked decision as a failing, nonzero no-history status", async () => {
    const value = fixture();
    writeFixture(value);
    writeAuthority(value.decision, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: governanceDecisionDigestV2(value.decision),
        issuer: "platform-security",
        revokedAt: "2026-08-01T00:00:00+00:00",
        reason: "Critical upstream withdrawal.",
      },
    ]);

    const execution = await execute(context(true, value.decision));
    expect(execution.digests[0]?.data).toMatchObject({
      applied: false,
      outcome: "reported-only",
      state: "decision-revoked",
    });
    expectRevokedCheck(execution);
    expect(lifecycleFiles()).toEqual([]);
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
    const before = lifecycleFiles().filter((file) => file.startsWith("records/"));
    const execution = await execute(context(true, oldValue.decision));
    const result = execution.digests[0]?.data as { outcome: string; state: string };
    expect(result).toMatchObject({ outcome: "reported-only", state: "decision-revoked" });
    expectRevokedCheck(execution);
    expect(lifecycleFiles().filter((file) => file.startsWith("records/"))).toEqual(before);
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
    vi.advanceTimersByTime(1_000);
    const refused = await run(context(true, newer.decision));
    expect(refused).toMatchObject({ outcome: "refused", state: "store-corrupt" });
    expect(lifecycleFiles()).toEqual(before);
  });

  it("refuses a head whose referenced immutable record is missing or whose subject binding is substituted", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const headPath = join(
      base,
      "heads",
      readdirSync(join(base, "heads")).find((name) => name.endsWith(".json")) as string,
    );
    const head = JSON.parse(readFileSync(headPath, "utf8"));
    rmSync(recordFile(base, head.recordDigest));
    expect(await run(context(true, value.decision))).toMatchObject({
      outcome: "refused",
      state: "head-conflict",
    });

    rmSync(join(root, ".aih", "governance"), { recursive: true, force: true });
    await run(context(true, value.decision));
    const renewedHeadPath = join(
      base,
      "heads",
      readdirSync(join(base, "heads")).find((name) => name.endsWith(".json")) as string,
    );
    const renewed = JSON.parse(readFileSync(renewedHeadPath, "utf8"));
    renewed.subjectDigest = `sha256:${"f".repeat(64)}`;
    writeFileSync(renewedHeadPath, JSON.stringify(renewed));
    expect(await run(context(true, value.decision))).toMatchObject({
      outcome: "refused",
      state: "head-conflict",
    });
  });

  it("refuses a new registry lineage when a deleted binding still has canonical subject history", async () => {
    const original = fixture();
    writeFixture(original);
    await run(context(true, original.decision));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const binding = lifecycleFiles().find((file) => file.startsWith("subjects/"));
    if (binding === undefined) throw new Error("expected lifecycle subject binding");
    rmSync(join(base, ...binding.split("/")));

    const changed = fixture(
      "1.2.4",
      `sha512-${Buffer.alloc(64, 4).toString("base64")}`,
      "https://registry.example.com/",
    );
    writeFixture(changed);
    expect(await run(context(true, changed.decision))).toMatchObject({
      outcome: "refused",
      state: "store-collision",
    });
    expect(lifecycleFiles().filter((file) => file.startsWith("heads/"))).toHaveLength(1);
  });

  it("refuses a new registry lineage when deleted binding and head leave durable records", async () => {
    const original = fixture();
    writeFixture(original);
    await run(context(true, original.decision));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const binding = lifecycleFiles().find((file) => file.startsWith("subjects/"));
    const head = lifecycleFiles().find((file) => file.startsWith("heads/"));
    if (binding === undefined || head === undefined)
      throw new Error("expected lifecycle binding and head");
    rmSync(join(base, ...binding.split("/")));
    rmSync(join(base, ...head.split("/")));

    const changed = fixture(
      "1.2.4",
      `sha512-${Buffer.alloc(64, 4).toString("base64")}`,
      "https://registry.example.com/",
    );
    writeFixture(changed);
    expect(await run(context(true, changed.decision))).toMatchObject({
      outcome: "refused",
      state: "store-collision",
    });
    expect(lifecycleFiles().filter((file) => file.startsWith("heads/"))).toHaveLength(0);
  });

  it("does not inspect an unrelated malformed durable record partition on new-subject onboarding", async () => {
    const value = fixture();
    writeFixture(value);
    const records = join(root, ".aih", "governance", "npm-package-lifecycle", "v1", "records");
    mkdirSync(records, { recursive: true });
    mkdirSync(join(records, "f".repeat(64)));

    expect(await run(context(true, value.decision))).toMatchObject({
      outcome: "fulfilled",
      state: "observed-effective",
    });
    expect(lifecycleFiles().filter((file) => file.startsWith("subjects/"))).toHaveLength(1);
  });

  it("refuses revocation when a present binding has no canonical head", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const head = lifecycleFiles().find((file) => file.startsWith("heads/"));
    if (head === undefined) throw new Error("expected lifecycle head");
    rmSync(join(base, ...head.split("/")));
    writeAuthority(value.decision, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: governanceDecisionDigestV2(value.decision),
        issuer: "platform-security",
        revokedAt: "2026-08-01T00:00:00+00:00",
        reason: "Critical upstream withdrawal.",
      },
    ]);
    expect(await run(context(true, value.decision))).toMatchObject({
      outcome: "refused",
      state: "head-conflict",
    });
  });

  it("refuses revocation when a durable lineage claim survives a deleted binding", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const binding = lifecycleFiles().find((file) => file.startsWith("subjects/"));
    if (binding === undefined) throw new Error("expected lifecycle binding");
    rmSync(join(base, ...binding.split("/")));
    writeAuthority(value.decision, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: governanceDecisionDigestV2(value.decision),
        issuer: "platform-security",
        revokedAt: "2026-08-01T00:00:00+00:00",
        reason: "Critical upstream withdrawal.",
      },
    ]);

    expect(await run(context(true, value.decision))).toMatchObject({
      outcome: "refused",
      state: "head-conflict",
    });
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

  it("reuses only an identical staged orphan and refuses a distinct same-lineage fork", async () => {
    const first = fixture();
    writeFixture(first);
    await run(context(true, first.decision));
    const bumped = fixture("1.2.4", `sha512-${Buffer.alloc(64, 4).toString("base64")}`);
    writeFixture(bumped);
    vi.advanceTimersByTime(1_000);
    const exactPlan = await npmPackageLifecyclePlan(context(true, bumped.decision));
    const orphan = immutableRecordAction(exactPlan);
    preplace(orphan);
    const applied = await executePlan(
      await npmPackageLifecyclePlan(context(true, bumped.decision)),
      context(true, bumped.decision),
      {
        skipWorktreeGate: true,
      },
    );
    expect(applied.digests[0]?.data).toMatchObject({ outcome: "fulfilled" });

    const forked = fixture("1.2.5", `sha512-${Buffer.alloc(64, 5).toString("base64")}`);
    writeFixture(forked);
    vi.advanceTimersByTime(1_000);
    const expected = await npmPackageLifecyclePlan(context(true, forked.decision));
    vi.advanceTimersByTime(1_000);
    const other = await npmPackageLifecyclePlan(context(true, forked.decision));
    vi.advanceTimersByTime(1_000);
    const otherFork = await npmPackageLifecyclePlan(context(true, forked.decision));
    preplace(immutableRecordAction(other));
    preplace(immutableRecordAction(otherFork));
    vi.setSystemTime(new Date("2026-08-02T12:00:03+00:00"));
    expect(immutableRecordAction(expected).path).not.toBe(immutableRecordAction(other).path);
    const rejected = await npmPackageLifecyclePlan(context(true, forked.decision));
    const result = await executePlan(rejected, context(true, forked.decision), {
      skipWorktreeGate: true,
    });
    expect(result.digests[0]?.data).toMatchObject({ outcome: "refused", state: "head-conflict" });
  });

  it("recovers only an exact immutable-record scratch left by an interrupted rename", async () => {
    const value = fixture();
    writeFixture(value);
    const ctx = context(true, value.decision);
    const interruptedPlan = await npmPackageLifecyclePlan(ctx);
    const record = immutableRecordAction(interruptedPlan);
    const scratch = recordScratch(record);
    fsEvents.failRecordRename = (from, to) => from === scratch && to === scratch.slice(0, -8);

    await expect(executePlan(interruptedPlan, ctx, { skipWorktreeGate: true })).rejects.toThrow(
      /injected record rename failure/,
    );
    expect(readFileSync(scratch, "utf8")).toBe(record.contents);

    fsEvents.failRecordRename = undefined;
    const retry = await execute(context(true, value.decision));
    expect(retry.digests[0]?.data).toMatchObject({ applied: true, outcome: "fulfilled" });
    expect(existsSync(scratch)).toBe(false);
  });

  it("retries an interrupted authenticated revocation record without a timestamp-derived fork", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const revocation = {
      format: "aih-governance-decision-revocation",
      version: 2,
      decisionDigest: governanceDecisionDigestV2(value.decision),
      issuer: "platform-security",
      revokedAt: "2026-08-01T00:00:00+00:00",
      reason: "Critical upstream withdrawal.",
    };
    writeAuthority(value.decision, [revocation]);
    const ctx = context(true, value.decision);
    const interruptedPlan = await npmPackageLifecyclePlan(ctx);
    const record = immutableRecordAction(interruptedPlan);
    const scratch = recordScratch(record);
    fsEvents.failRecordRename = (from, to) => from === scratch && to === scratch.slice(0, -8);

    await expect(executePlan(interruptedPlan, ctx, { skipWorktreeGate: true })).rejects.toThrow(
      /injected record rename failure/,
    );
    expect(readFileSync(scratch, "utf8")).toBe(record.contents);

    fsEvents.failRecordRename = undefined;
    vi.advanceTimersByTime(1_000);
    const retry = await execute(context(true, value.decision));
    expect(retry.digests[0]?.data).toMatchObject({
      applied: true,
      outcome: "fulfilled",
      state: "decision-revoked",
    });
    expect(existsSync(scratch)).toBe(false);
  });

  it("refuses non-exact, linked, wrongly named, or colliding record scratch state", async () => {
    const value = fixture();
    const cases: Array<{
      expected: string;
      place: (record: ReturnType<typeof immutableRecordAction>) => boolean;
    }> = [
      {
        expected: "store-collision",
        place: (record) => {
          const scratch = recordScratch(record);
          mkdirSync(dirname(scratch), { recursive: true });
          writeFileSync(scratch, `${record.contents}\n`);
          return true;
        },
      },
      {
        expected: "store-unsafe",
        place: (record) => {
          const scratch = recordScratch(record);
          const source = join(root, "linked-record-source.json");
          mkdirSync(dirname(scratch), { recursive: true });
          writeFileSync(source, record.contents);
          try {
            linkSync(source, scratch);
            return true;
          } catch {
            // Some Windows policy configurations forbid test hard links.
            return false;
          }
        },
      },
      {
        expected: "store-collision",
        place: (record) => {
          const path = join(dirname(recordScratch(record)), `${"f".repeat(64)}.json.aih.tmp`);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, record.contents);
          return true;
        },
      },
      {
        expected: "store-collision",
        place: (record) => {
          preplace({ ...record, contents: "{}" });
          return true;
        },
      },
    ];
    for (const item of cases) {
      writeFixture(value);
      const planned = await npmPackageLifecyclePlan(context(true, value.decision));
      const record = immutableRecordAction(planned);
      const placed = item.place(record);
      try {
        // Link creation may be unavailable under a Windows filesystem policy.
        if (!placed) continue;
        const result = await run(context(true, value.decision));
        expect(result).toMatchObject({ outcome: "refused", state: item.expected });
      } finally {
        rmSync(join(root, ".aih", "governance"), { recursive: true, force: true });
      }
    }
  });

  it("fails closed on a fresh re-observation when a prior process left an orphan record", async () => {
    const first = fixture();
    writeFixture(first);
    await run(context(true, first.decision));
    const bumped = fixture("1.2.4", `sha512-${Buffer.alloc(64, 4).toString("base64")}`);
    writeFixture(bumped);
    vi.advanceTimersByTime(1_000);
    preplace(immutableRecordAction(await npmPackageLifecyclePlan(context(true, bumped.decision))));
    vi.advanceTimersByTime(1_000);
    expect(await run(context(true, bumped.decision))).toMatchObject({
      outcome: "refused",
      state: "head-conflict",
    });
  });

  // This deliberately drives observe, apply, update, and revocation through durable state; the
  // finite budget absorbs Windows filesystem scheduling and is not a runtime performance contract.
  it("runs the cold disposable sequence without touching package bytes, a run ledger, or offline state", async () => {
    const first = fixture();
    writeFixture(first);
    const lock = readFileSync(join(root, "package-lock.json"));
    const manifest = readFileSync(join(root, "node_modules", "@acme", "widget", "package.json"));
    expect(await observeNpmPackageV1(context(false, first.decision))).toMatchObject({
      outcome: "observed-effective",
    });
    expect(await run(context(false, first.decision))).toMatchObject({ outcome: "reported-only" });
    expect(await run(context(true, first.decision))).toMatchObject({ outcome: "fulfilled" });
    vi.advanceTimersByTime(1_000);
    expect(await run(context(true, first.decision))).toMatchObject({ outcome: "fulfilled" });
    const bumped = fixture("1.2.4", `sha512-${Buffer.alloc(64, 4).toString("base64")}`);
    writeFixture(bumped);
    const bumpedLock = readFileSync(join(root, "package-lock.json"));
    const bumpedManifest = readFileSync(
      join(root, "node_modules", "@acme", "widget", "package.json"),
    );
    vi.advanceTimersByTime(1_000);
    expect(await run(context(true, bumped.decision))).toMatchObject({ outcome: "fulfilled" });
    writeAuthority(bumped.decision, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: governanceDecisionDigestV2(bumped.decision),
        issuer: "platform-security",
        revokedAt: "2026-08-01T00:00:00+00:00",
        reason: "Critical upstream withdrawal.",
      },
    ]);
    expect(await run(context(true, bumped.decision))).toMatchObject({
      outcome: "fulfilled",
      state: "decision-revoked",
    });
    expect(readFileSync(join(root, "package-lock.json"))).not.toEqual(lock);
    expect(readFileSync(join(root, "node_modules", "@acme", "widget", "package.json"))).not.toEqual(
      manifest,
    );
    expect(readFileSync(join(root, "package-lock.json"))).toEqual(bumpedLock);
    expect(readFileSync(join(root, "node_modules", "@acme", "widget", "package.json"))).toEqual(
      bumpedManifest,
    );
    expect(existsSync(join(root, ".aih", "run-log.jsonl"))).toBe(false);
    expect(existsSync(join(root, ".aih", "offline-revocations"))).toBe(false);
  }, 15_000);

  it("requires explicit CLI apply, emits deterministic JSON, and never writes a run ledger or package files", async () => {
    const value = fixture();
    writeFixture(value);
    const args = [
      "--json",
      "--root",
      root,
      "--decision",
      value.decision.id,
      "--decision-digest",
      governanceDecisionDigestV2(value.decision),
      "--target",
      "claude",
      "--evidence",
      "evidence.json",
    ];
    const lockBefore = readFileSync(join(root, "package-lock.json"));
    const manifestBefore = readFileSync(
      join(root, "node_modules", "@acme", "widget", "package.json"),
    );
    const invoke = async (apply: boolean) => {
      let out = "";
      const code = await runCapability(
        npmPackageLifecycleCommand,
        command(apply ? [...args, "--apply"] : args),
        {
          env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
          run: fakeRunner((argv) => (argv[0] === gh ? { code: 0 } : { code: 1 })),
          write: (text) => {
            out += text;
          },
        },
      );
      return { code, payload: JSON.parse(out) as { applied: boolean; writes: unknown[] } };
    };
    const preview = await invoke(false);
    expect(preview.code).toBe(0);
    expect(preview.payload).toMatchObject({ applied: false });
    expect(lifecycleFiles()).toEqual([]);
    const applied = await invoke(true);
    expect(applied.code).toBe(0);
    expect(applied.payload).toMatchObject({ applied: true });
    expect(lifecycleFiles().some((file) => file.startsWith("heads/"))).toBe(true);
    expect(existsSync(join(root, ".aih", "run-log.jsonl"))).toBe(false);
    expect(readFileSync(join(root, "package-lock.json"))).toEqual(lockBefore);
    expect(readFileSync(join(root, "node_modules", "@acme", "widget", "package.json"))).toEqual(
      manifestBefore,
    );
  });

  it("reports invalid authority, unqualified evidence, and partial installed custody distinctly without lifecycle writes", async () => {
    const value = fixture();
    const cases: Array<{
      expected: { outcome: string; state: string };
      mutate: () => void;
    }> = [
      {
        expected: { outcome: "refused", state: "authority-unverified" },
        mutate: () => writeFileSync(join(root, ".aih", "policy-authority-receipt.json"), "{}"),
      },
      {
        expected: { outcome: "refused", state: "observation-unverified" },
        mutate: () => writeFileSync(join(root, "evidence.json"), "{}"),
      },
      {
        expected: { outcome: "partial", state: "observation-partial" },
        mutate: () => rmSync(join(root, "node_modules", "@acme", "widget"), { recursive: true }),
      },
    ];
    for (const item of cases) {
      writeFixture(value);
      item.mutate();
      expect(await run(context(true, value.decision))).toMatchObject(item.expected);
      expect(lifecycleFiles()).toEqual([]);
    }
  });

  it("refuses a valid-but-substituted authority during the mandatory second revocation verification", async () => {
    const value = fixture();
    writeFixture(value);
    writeAuthority(value.decision, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: governanceDecisionDigestV2(value.decision),
        issuer: "platform-security",
        revokedAt: "2026-08-01T00:00:00+00:00",
        reason: "Critical upstream withdrawal.",
      },
    ]);
    const ctx = context(true, value.decision);
    let attestations = 0;
    const originalRun = ctx.run;
    ctx.run = async (argv, options) => {
      const result = await originalRun(argv, options);
      if (argv[0] === gh && ++attestations === 2) writeAuthority(value.decision);
      return result;
    };

    expect(await run(ctx)).toMatchObject({
      outcome: "refused",
      state: "authority-drift",
    });
    expect(attestations).toBe(2);
    expect(lifecycleFiles()).toEqual([]);
  });

  it("distinguishes authority expiry at the second revocation verification without writing", async () => {
    const value = fixture();
    writeFixture(value);
    writeAuthority(value.decision, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: governanceDecisionDigestV2(value.decision),
        issuer: "platform-security",
        revokedAt: "2026-08-01T00:00:00+00:00",
        reason: "Critical upstream withdrawal.",
      },
    ]);
    const ctx = context(true, value.decision);
    let attestations = 0;
    const originalRun = ctx.run;
    ctx.run = async (argv, options) => {
      const result = await originalRun(argv, options);
      if (argv[0] === gh) attestations += 1;
      return result;
    };
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(() =>
        attestations === 0
          ? Date.parse("2026-08-02T12:00:00+00:00")
          : Date.parse("2026-08-11T12:00:00+00:00"),
      );
    try {
      expect(await run(ctx)).toMatchObject({
        outcome: "refused",
        state: "authority-not-current",
      });
      // The observer's first attested receipt completed at the original clock;
      // the second real verifier rejects the now-expired live receipt pre-spawn.
      expect(attestations).toBe(1);
      expect(lifecycleFiles()).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps a subject's target lineages independent for every observer-supported target", async () => {
    const value = fixture();
    value.decision.targets = [...SUPPORTED_CLIS].sort();
    writeFixture(value);
    for (const target of SUPPORTED_CLIS) {
      const ctx = context(true, value.decision);
      ctx.options.target = target;
      expect(await run(ctx)).toMatchObject({ outcome: "fulfilled" });
      vi.advanceTimersByTime(1_000);
    }
    expect(lifecycleFiles().filter((file) => file.startsWith("subjects/"))).toHaveLength(
      SUPPORTED_CLIS.length,
    );
    expect(lifecycleFiles().filter((file) => file.startsWith("heads/"))).toHaveLength(
      SUPPORTED_CLIS.length,
    );
    // Sequential target coverage rechecks durable custody and every accumulated lifecycle head.
  }, 20_000);

  it("refuses a valid record substituted into a different lineage partition", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const codex = context(true, value.decision);
    codex.options.target = "codex";
    await run(codex);
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const records = lifecycleFiles().filter((file) => file.startsWith("records/"));
    expect(records).toHaveLength(2);
    const first = join(base, ...(records[0] as string).split("/"));
    const second = join(base, ...(records[1] as string).split("/"));
    copyFileSync(second, join(dirname(first), basename(second)));
    vi.advanceTimersByTime(1_000);
    expect(await run(context(true, value.decision))).toMatchObject({
      outcome: "refused",
      state: "head-conflict",
    });
  });

  it("refuses an unexpected non-record entry in a lineage partition", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const headName = readdirSync(join(base, "heads")).find((name) => name.endsWith(".json"));
    if (headName === undefined) throw new Error("expected lifecycle head");
    const head = JSON.parse(readFileSync(join(base, "heads", headName), "utf8"));
    writeFileSync(join(dirname(recordFile(base, head.recordDigest)), "unexpected"), "not a record");
    expect(await run(context(true, value.decision))).toMatchObject({
      outcome: "refused",
      state: "head-conflict",
    });
  });

  it("accepts a valid staged record at capacity and refuses record 4,097", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const headName = readdirSync(join(base, "heads")).find((name) => name.endsWith(".json"));
    if (headName === undefined) throw new Error("expected lifecycle head");
    const headPath = join(base, "heads", headName);
    const head = JSON.parse(readFileSync(headPath, "utf8"));
    const first = JSON.parse(readFileSync(recordFile(base, head.recordDigest), "utf8"));
    const partition = dirname(recordFile(base, head.recordDigest));
    let previous = head.recordDigest as string;
    for (let sequence = 2; sequence <= 4_095; sequence += 1) {
      const record = { ...first, previousRecordDigest: previous, sequence };
      const digest = lifecycleRecordDigest(record);
      writeFileSync(join(partition, `${digest.slice(7)}.json`), canonicalStrictJsonBytesV1(record));
      previous = digest;
    }
    writeFileSync(
      headPath,
      canonicalStrictJsonBytesV1({ ...head, recordDigest: previous, sequence: 4_095 }),
    );
    writeFileSync(
      join(base, "capacity.json"),
      canonicalStrictJsonBytesV1({
        format: "aih-npm-package-lifecycle-capacity",
        headCount: 1,
        recordCount: 4_095,
        version: 1,
      }),
    );
    const staged = { ...first, previousRecordDigest: previous, sequence: 4_096 };
    const stagedDigest = lifecycleRecordDigest(staged);
    writeFileSync(
      join(partition, `${stagedDigest.slice(7)}.json`),
      canonicalStrictJsonBytesV1(staged),
    );
    // Planning validates the complete 4,096-record chain once and exposes the
    // ordinary head write that would publish the staged final record. Executing
    // it would re-read the whole chain for the postcondition, which adds no
    // capacity coverage and made this boundary regression timeout under load.
    const accepted = await npmPackageLifecyclePlan(context(true, value.decision));
    const acceptedHead = accepted.actions.find(
      (action) =>
        action.kind === "write" &&
        action.path === `.aih/governance/npm-package-lifecycle/v1/heads/${headName}`,
    );
    if (acceptedHead?.kind !== "write" || acceptedHead.contents === undefined) {
      throw new Error("expected accepted capacity head advance");
    }
    expect(JSON.parse(acceptedHead.contents)).toMatchObject({ sequence: 4_096 });
    writeFileSync(headPath, acceptedHead.contents);
    writeFileSync(
      join(base, "capacity.json"),
      canonicalStrictJsonBytesV1({
        format: "aih-npm-package-lifecycle-capacity",
        headCount: 1,
        recordCount: 4_096,
        version: 1,
      }),
    );
    const before = lifecycleFiles();
    vi.advanceTimersByTime(1_000);
    expect(await run(context(true, value.decision))).toMatchObject({
      outcome: "refused",
      state: "head-conflict",
    });
    expect(lifecycleFiles()).toEqual(before);
    writeFileSync(
      headPath,
      canonicalStrictJsonBytesV1({ ...head, recordDigest: stagedDigest, sequence: 4_097 }),
    );
    expect(readNpmPackageLifecycleStoreV1(root)).toEqual({ kind: "over-capacity" });
    writeFileSync(headPath, acceptedHead.contents);
    writeFileSync(join(partition, `${"e".repeat(64)}.json`), "{}");
    expect(readNpmPackageLifecycleStoreV1(root)).toEqual({ kind: "over-capacity" });
  }, 60_000);

  it("refuses a rolled-back head before replaying a revocation record", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    writeAuthority(value.decision, [
      {
        format: "aih-governance-decision-revocation",
        version: 2,
        decisionDigest: governanceDecisionDigestV2(value.decision),
        issuer: "platform-security",
        revokedAt: "2026-08-01T00:00:00+00:00",
        reason: "Critical upstream withdrawal.",
      },
    ]);
    await run(context(true, value.decision));
    const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
    const headName = readdirSync(join(base, "heads")).find((name) =>
      name.endsWith(".json"),
    ) as string;
    copyFileSync(join(base, "heads", `${headName}.aih.bak`), join(base, "heads", headName));
    const before = lifecycleFiles();
    vi.advanceTimersByTime(1_000);
    expect(await run(context(true, value.decision))).toMatchObject({
      outcome: "refused",
      state: "head-conflict",
    });
    expect(lifecycleFiles()).toEqual(before);
  });

  it("reports a detached store rather than claiming fulfilled after an apply-time postcondition failure", async () => {
    const value = fixture();
    writeFixture(value);
    const ctx = context(true, value.decision);
    const planned = await npmPackageLifecyclePlan(ctx);
    const head = planned.actions.find(
      (action) =>
        action.kind === "write" && action.describe === "advance npm lifecycle subject head",
    );
    if (head?.kind !== "write") throw new Error("expected lifecycle head action");
    planned.actions.push({
      kind: "exec",
      describe: "test postcondition race",
      argv: ["test-race"],
    });
    const originalRun = ctx.run;
    ctx.run = async (argv, options) => {
      if (argv[0] === "test-race") {
        writeFileSync(join(root, ...head.path.split("/")), "{}");
        return { code: 0, stderr: "", stdout: "" };
      }
      return originalRun(argv, options);
    };
    const result = await executePlan(planned, ctx, { skipWorktreeGate: true });
    expect(result.digests[0]?.data).toMatchObject({
      applied: false,
      outcome: "refused",
      state: "store-detached",
    });
    expect(result.report?.ok).toBe(false);
  });

  it("reports a detached store when a non-cooperative writer forks the committed lineage", async () => {
    const value = fixture();
    writeFixture(value);
    const ctx = context(true, value.decision);
    const planned = await npmPackageLifecyclePlan(ctx);
    planned.actions.push({
      kind: "exec",
      describe: "test postcommit lineage fork",
      argv: ["test-fork"],
    });
    const originalRun = ctx.run;
    ctx.run = async (argv, options) => {
      if (argv[0] === "test-fork") {
        const base = join(root, ".aih", "governance", "npm-package-lifecycle", "v1");
        const headName = readdirSync(join(base, "heads")).find((name) => name.endsWith(".json"));
        if (headName === undefined) throw new Error("expected committed lifecycle head");
        const head = JSON.parse(readFileSync(join(base, "heads", headName), "utf8"));
        const current = JSON.parse(readFileSync(recordFile(base, head.recordDigest), "utf8"));
        const fork = {
          ...current,
          previousRecordDigest: head.recordDigest,
          sequence: head.sequence + 1,
        };
        const digest = lifecycleRecordDigest(fork);
        writeFileSync(
          join(dirname(recordFile(base, head.recordDigest)), `${digest.slice(7)}.json`),
          canonicalStrictJsonBytesV1(fork),
        );
        return { code: 0, stderr: "", stdout: "" };
      }
      return originalRun(argv, options);
    };
    const result = await executePlan(planned, ctx, { skipWorktreeGate: true });
    expect(result.digests[0]?.data).toMatchObject({
      applied: false,
      outcome: "refused",
      state: "store-detached",
    });
    expect(result.report?.ok).toBe(false);
  });

  it("refuses a current revoked head with a distinct forward record fork instead of reporting it clean", async () => {
    const value = fixture();
    writeFixture(value);
    await run(context(true, value.decision));
    const revocation = {
      format: "aih-governance-decision-revocation",
      version: 2,
      decisionDigest: governanceDecisionDigestV2(value.decision),
      issuer: "platform-security",
      revokedAt: "2026-08-01T00:00:00+00:00",
      reason: "Critical upstream withdrawal.",
    };
    writeAuthority(value.decision, [revocation]);
    await run(context(true, value.decision));
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
    const current = JSON.parse(readFileSync(recordFile(base, head.recordDigest), "utf8"));
    const fork = {
      ...current,
      previousRecordDigest: head.recordDigest,
      revocation: { ...current.revocation, reason: "Competing revocation record." },
      sequence: head.sequence + 1,
    };
    const forkBytes = canonicalStrictJsonBytesV1(fork);
    const forkDigest = createHash("sha256")
      .update("aih-npm-package-lifecycle-record/v1\0", "utf8")
      .update(forkBytes)
      .digest("hex");
    writeFileSync(
      join(dirname(recordFile(base, head.recordDigest)), `${forkDigest}.json`),
      forkBytes,
    );
    expect(await run(context(true, value.decision))).toMatchObject({
      outcome: "refused",
      state: "head-conflict",
    });
  });
});
