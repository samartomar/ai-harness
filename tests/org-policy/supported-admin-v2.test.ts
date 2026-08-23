import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import { executePlan } from "../../src/internals/execute.js";
import type { WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../src/org-policy/governance-decision-v2.js";
import * as supported from "../../src/org-policy/supported-admin-v2.js";
import {
  canonicalAihSupportedQualificationReceiptV2,
  receiptDigestV2,
} from "../../src/org-policy/supported-qualification-receipt-v2.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { buildProgram } from "../../src/program.js";

describe("SupportedQualificationCustodyV2 roots", () => {
  it("derives only the fixed OS-admin enterprise roots and a governed vibe subpath", () => {
    const root = "C:/disposable/governed";
    expect(
      supported.supportedCustodyRootV2({ posture: "enterprise", platform: "win32", root }),
    ).toBe("C:\\ProgramData\\aih\\supported-qualification\\v2");
    expect(
      supported.supportedCustodyRootV2({ posture: "enterprise", platform: "darwin", root }),
    ).toBe("/Library/Application Support/aih/supported-qualification/v2");
    expect(
      supported.supportedCustodyRootV2({ posture: "enterprise", platform: "linux", root }),
    ).toBe("/etc/aih/supported-qualification/v2");
    expect(supported.supportedCustodyRootV2({ posture: "vibe", platform: "linux", root })).toBe(
      "C:/disposable/governed/.aih/supported-qualification/v2",
    );
  });

  it("uses one external shared enterprise lock and a root-local vibe lock", () => {
    const first = supported.supportedCustodyLockV2({
      posture: "enterprise",
      platform: "linux",
      root: "/tmp/a",
    });
    const second = supported.supportedCustodyLockV2({
      posture: "enterprise",
      platform: "linux",
      root: "/tmp/b",
    });
    expect(first).toEqual({
      external: true,
      path: "/etc/aih/supported-qualification/v2/locks/commit.lock",
      trustedBase: "/etc",
    });
    expect(second).toEqual(first);
    expect(
      supported.supportedCustodyLockV2({ posture: "vibe", platform: "linux", root: "/tmp/a" }),
    ).toBe(".aih/supported-qualification/v2/locks/commit.lock");
  });

  it("permits first enterprise custody creation below the existing OS-admin base", () => {
    expect(
      supported.supportedCustodyLockV2({
        posture: "enterprise",
        platform: "darwin",
        root: "/disposable",
      }),
    ).toEqual({
      external: true,
      path: "/Library/Application Support/aih/supported-qualification/v2/locks/commit.lock",
      trustedBase: "/Library/Application Support",
    });
  });
});

describe("SupportedQualificationCustodyV2 durable acceptance", () => {
  const source = {
    type: "aih" as const,
    release: "1.0.0",
    revision: `sha256:${"4".repeat(64)}`,
  };
  const sourceDigest = governanceDecisionSourceDigestV2(source);
  const subject = {
    kind: "tool" as const,
    id: "test-tool",
    source,
    sourceDigest,
    subjectDigest: governanceDecisionSubjectDigestV2({
      kind: "tool",
      id: "test-tool",
      sourceDigest,
    }),
  };
  const receipt = {
    format: "aih-supported-qualification-receipt" as const,
    version: 2 as const,
    organizationAdmission: "not-authoritative" as const,
    entryId: "recipe.default",
    qualificationBasis: {
      kind: "aih-supported" as const,
      catalogSignerIdentity: "catalog-signer",
      catalogDigest: `sha256:${"1".repeat(64)}`,
      catalogHeadDigest: `sha256:${"2".repeat(64)}`,
      catalogMemberDigest: `sha256:${"3".repeat(64)}`,
      subjectKind: "tool",
      subjectDigest: subject.subjectDigest,
    },
    catalogContinuity: {
      catalogHeadDigest: `sha256:${"2".repeat(64)}`,
      previousCatalogHeadDigest: `sha256:${"0".repeat(64)}`,
      sequence: 0,
      replayIdentity: `catalog-head:${"2".repeat(64)}:${"5".repeat(64)}`,
      signerKeyId: `ed25519:${"6".repeat(64)}`,
      headValidFrom: "2026-08-01T00:00:00Z",
      headValidUntil: "2026-08-10T00:00:00Z",
    },
    subject,
    issuedAt: "2026-08-01T00:00:00Z",
    notBefore: "2026-08-01T00:00:00Z",
    expiresAt: "2026-08-10T00:00:00Z",
  };
  function rawReceiptSha256(value: typeof receipt): string {
    return `sha256:${createHash("sha256")
      .update(canonicalAihSupportedQualificationReceiptV2(value), "utf8")
      .digest("hex")}`;
  }
  const input = {
    receipt,
    decision: { id: "decision-allow-tool", digest: `sha256:${"7".repeat(64)}` },
    target: "claude",
    receiptDigest: receiptDigestV2(receipt),
    receiptSha256: rawReceiptSha256(receipt),
    authorityReceiptDigest: `sha256:${"a".repeat(64)}`,
    repository: "aihq/aih-supported",
    workflow: ".github/workflows/qualification.yml",
    acceptedAt: "2026-08-02T00:00:00Z",
    decisionNotBefore: "2026-08-01T00:00:00Z",
    decisionExpiresAt: "2026-08-09T00:00:00Z",
  };

  it("plans immutable claim, replay and member slots before a guarded lineage head", () => {
    expect(() =>
      supported.planSupportedCustodyAcceptV2({
        posture: "enterprise",
        root: "/disposable",
        ...input,
      }),
    ).toThrow(/supported custody candidate is invalid/);
    const plan = supported.planSupportedCustodyAcceptV2({
      posture: "vibe",
      root: "/disposable",
      ...input,
    });
    expect(plan.commitLock).toBe(".aih/supported-qualification/v2/locks/commit.lock");
    expect(plan.commitNotAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(
      plan.actions
        .filter((action: { kind: string }) => action.kind === "write")
        .map((action: { path?: string }) => action.path),
    ).toEqual([
      expect.stringMatching(/^\.aih\/supported-qualification\/v2\/signers\/[0-9a-f]{64}\.json$/),
      expect.stringMatching(/^\.aih\/supported-qualification\/v2\/replays\/[0-9a-f]{64}\.json$/),
      expect.stringMatching(/^\.aih\/supported-qualification\/v2\/members\/[0-9a-f]{64}\.json$/),
      expect.stringMatching(/^\.aih\/supported-qualification\/v2\/heads\/[0-9a-f]{64}\.json$/),
    ]);
    const writes = plan.actions.filter((action): action is WriteAction => action.kind === "write");
    expect(writes).toHaveLength(4);
    for (const action of writes) {
      const contents = action.contents ?? "";
      expect(Buffer.from(contents, "utf8")).toEqual(
        canonicalStrictJsonBytesV1(JSON.parse(contents)),
      );
      expect(action.sensitive).toEqual({ path: true });
    }
    expect(JSON.parse(writes[0]?.contents ?? "{} ")).toMatchObject({
      kind: "signer-claim",
      catalogSignerIdentity: receipt.qualificationBasis.catalogSignerIdentity,
      signerKeyId: receipt.catalogContinuity.signerKeyId,
    });
    expect(JSON.parse(writes[2]?.contents ?? "{} ")).toMatchObject({
      kind: "member-claim",
      entryId: receipt.entryId,
      catalogDigest: receipt.qualificationBasis.catalogDigest,
      catalogHeadDigest: receipt.qualificationBasis.catalogHeadDigest,
      catalogMemberDigest: receipt.qualificationBasis.catalogMemberDigest,
      subject,
      decisionId: input.decision.id,
      decisionDigest: input.decision.digest,
      target: input.target,
      receiptDigest: input.receiptDigest,
      receiptSha256: input.receiptSha256,
      authorityReceiptDigest: input.authorityReceiptDigest,
      decisionNotBefore: input.decisionNotBefore,
      decisionExpiresAt: input.decisionExpiresAt,
      headValidFrom: receipt.catalogContinuity.headValidFrom,
      headValidUntil: receipt.catalogContinuity.headValidUntil,
      repository: input.repository,
      workflow: input.workflow,
      acceptedAt: input.acceptedAt,
    });
    expect(JSON.parse(writes[1]?.contents ?? "{} ")).toMatchObject({
      kind: "replay-claim",
      replayIdentity: receipt.catalogContinuity.replayIdentity,
      catalogSignerIdentity: receipt.qualificationBasis.catalogSignerIdentity,
      signerKeyId: receipt.catalogContinuity.signerKeyId,
      catalogHeadDigest: receipt.catalogContinuity.catalogHeadDigest,
      sequence: receipt.catalogContinuity.sequence,
    });
    expect(JSON.parse(writes[3]?.contents ?? "{} ")).toMatchObject({
      kind: "catalog-head",
      catalogSignerIdentity: receipt.qualificationBasis.catalogSignerIdentity,
      signerKeyId: receipt.catalogContinuity.signerKeyId,
      catalogHeadDigest: receipt.catalogContinuity.catalogHeadDigest,
      previousCatalogHeadDigest: receipt.catalogContinuity.previousCatalogHeadDigest,
      sequence: receipt.catalogContinuity.sequence,
      replayIdentity: receipt.catalogContinuity.replayIdentity,
      headValidFrom: receipt.catalogContinuity.headValidFrom,
      headValidUntil: receipt.catalogContinuity.headValidUntil,
    });
    const changedDecision = supported.planSupportedCustodyAcceptV2({
      posture: "vibe",
      root: "/disposable",
      ...input,
      decision: { id: "decision-allow-other", digest: `sha256:${"b".repeat(64)}` },
    });
    const changedDecisionMember = changedDecision.actions.filter(
      (action): action is WriteAction => action.kind === "write",
    )[2];
    expect(changedDecisionMember?.path).toBe(writes[2]?.path);
    expect(changedDecisionMember?.contents).not.toBe(writes[2]?.contents);
    const rotatedReceipt = {
      ...receipt,
      catalogContinuity: {
        ...receipt.catalogContinuity,
        signerKeyId: `ed25519:${"c".repeat(64)}`,
      },
    };
    const rotatedKey = supported.planSupportedCustodyAcceptV2({
      posture: "vibe",
      root: "/disposable",
      ...input,
      receipt: rotatedReceipt,
      receiptDigest: receiptDigestV2(rotatedReceipt),
      receiptSha256: rawReceiptSha256(rotatedReceipt),
    });
    const rotatedSigner = rotatedKey.actions.filter(
      (action): action is WriteAction => action.kind === "write",
    )[0];
    expect(rotatedSigner?.path).toBe(writes[0]?.path);
    expect(rotatedSigner?.contents).not.toBe(writes[0]?.contents);
    for (const path of writes.map((action) => action.path))
      expect(path.split("/").every((segment) => /^[A-Za-z0-9._-]+$/.test(segment))).toBe(true);
    for (const action of plan.actions.slice(0, -1)) {
      expect(action).toMatchObject({ durable: true, once: true, expect: { absent: true } });
    }
    expect(
      plan.actions.filter((action: { kind: string }) => action.kind === "write").at(-1),
    ).toMatchObject({ expect: { absent: true } });
    expect(plan.actions.at(-1)).toMatchObject({ kind: "digest" });
  });

  it("keeps a dry-run phase-honest and writes no custody files", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-supported-custody-dry-"));
    try {
      const run = fakeRunner(() => undefined);
      const result = await executePlan(
        supported.planSupportedCustodyAcceptV2({ posture: "vibe", root, ...input }),
        {
          root,
          contextDir: "ai-coding",
          posture: "vibe",
          apply: false,
          verify: false,
          json: false,
          run,
          host: makeHostAdapter({ platform: "linux", run, env: {} }),
          env: {},
          options: {},
        },
      );
      expect(existsSync(join(root, ".aih", "supported-qualification", "v2"))).toBe(false);
      expect(result.digests).toEqual([
        { describe: "verify supported custody genesis", text: "supported custody genesis pending" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked custody parent before reading the committed records", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "aih-supported-custody-link-"));
    try {
      const plan = supported.planSupportedCustodyAcceptV2({ posture: "vibe", root, ...input });
      const target = join(root, "target");
      const writes = plan.actions.filter(
        (action): action is WriteAction => action.kind === "write",
      );
      for (const action of writes) {
        const relative = action.path.replace(".aih/supported-qualification/", "");
        const path = join(target, relative);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, action.contents ?? "", "utf8");
      }
      mkdirSync(join(root, ".aih"), { recursive: true });
      symlinkSync(target, join(root, ".aih", "supported-qualification"));
      const digest = plan.actions.at(-1);
      if (digest?.kind !== "digest" || digest.run === undefined) throw new Error("missing digest");
      const run = fakeRunner(() => undefined);
      await expect(
        digest.run({
          root,
          contextDir: "ai-coding",
          posture: "vibe",
          apply: true,
          verify: false,
          json: false,
          run,
          host: makeHostAdapter({ platform: "linux", run, env: {} }),
          env: {},
          options: {},
        }),
      ).rejects.toMatchObject({ code: "AIH_TRUST" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads immutable slots from disk, makes exact reacceptance write-free, and guards a raced successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-supported-custody-"));
    try {
      const run = fakeRunner(() => undefined);
      const context = {
        root,
        contextDir: "ai-coding",
        posture: "vibe" as const,
        apply: true,
        verify: false,
        json: false,
        run,
        host: makeHostAdapter({ platform: "linux", run, env: {} }),
        env: {},
        options: {},
      };
      const genesis = await supported.prepareSupportedCustodyAcceptV2({
        root,
        posture: "vibe",
        candidate: input,
      });
      await executePlan(genesis, context);
      const repeat = await supported.prepareSupportedCustodyAcceptV2({
        root,
        posture: "vibe",
        candidate: input,
      });
      expect(repeat.actions.filter((action: { kind: string }) => action.kind === "write")).toEqual(
        [],
      );
      const successor = {
        ...input,
        receipt: {
          ...receipt,
          qualificationBasis: {
            ...receipt.qualificationBasis,
            catalogHeadDigest: `sha256:${"b".repeat(64)}`,
          },
          catalogContinuity: {
            ...receipt.catalogContinuity,
            catalogHeadDigest: `sha256:${"b".repeat(64)}`,
            previousCatalogHeadDigest: receipt.catalogContinuity.catalogHeadDigest,
            sequence: 1,
            replayIdentity: `catalog-head:${"b".repeat(64)}:${"c".repeat(64)}`,
          },
        },
      };
      const successorPlan = await supported.prepareSupportedCustodyAcceptV2({
        root,
        posture: "vibe",
        candidate: successor,
      });
      const headAction = genesis.actions.at(-1) as { path: string };
      const head = join(root, headAction.path);
      writeFileSync(head, "raced");
      await expect(executePlan(successorPlan, context)).rejects.toMatchObject({
        code: "AIH_TRUST",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports bounded, scrubbed current-head members without write actions and never accepts caller receipt or verifier controls", () => {
    const program = buildProgram();
    const policy = program.commands.find((command) => command.name() === "policy");
    const command = policy?.commands.find((candidate) => candidate.name() === "supported");
    expect(command?.commands.map((candidate) => candidate.name())).toEqual(["accept", "inspect"]);
    expect(
      command?.commands
        .find((candidate) => candidate.name() === "accept")
        ?.options.map((option) => option.long),
    ).toEqual(["--decision", "--decision-digest", "--target"]);
    expect(command?.commands.find((candidate) => candidate.name() === "inspect")?.options).toEqual(
      [],
    );
    const report = supported.inspectSupportedCustodyV2({
      posture: "vibe",
      root: "/disposable",
      limit: 1,
    });
    expect(report).toMatchObject({ writes: [], deterministic: true, scrubbed: true, limit: 1 });
  });
});
