import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
  type AihSupportedQualificationReceiptV2,
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
      subjectKind: "tool" as const,
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
  } satisfies AihSupportedQualificationReceiptV2;
  function rawReceiptSha256(value: typeof receipt): string {
    return `sha256:${createHash("sha256")
      .update(canonicalAihSupportedQualificationReceiptV2(value), "utf8")
      .digest("hex")}`;
  }
  function custodySlot(domain: string, value: unknown): string {
    return createHash("sha256")
      .update(`aih-supported-qualification-custody/v2/${domain}\0`, "utf8")
      .update(canonicalStrictJsonBytesV1(value))
      .digest("hex");
  }
  const input = {
    receipt,
    decision: { id: "decision-allow-tool", digest: `sha256:${"7".repeat(64)}` },
    target: "claude" as const,
    receiptDigest: receiptDigestV2(receipt),
    receiptSha256: rawReceiptSha256(receipt),
    authorityReceiptDigest: `sha256:${"a".repeat(64)}`,
    repository: "aihq/aih-supported",
    workflow: ".github/workflows/qualification.yml",
    acceptedAt: "2026-08-02T00:00:00Z",
    decisionNotBefore: "2026-08-01T00:00:00Z",
    decisionExpiresAt: "2026-08-09T00:00:00Z",
  };
  function candidateFor(
    candidateReceipt: typeof receipt,
    overrides: Partial<Omit<typeof input, "receipt" | "receiptDigest" | "receiptSha256">> = {},
  ) {
    return {
      ...input,
      ...overrides,
      receipt: candidateReceipt,
      receiptDigest: receiptDigestV2(candidateReceipt),
      receiptSha256: rawReceiptSha256(candidateReceipt),
    };
  }
  function alternativeSubject() {
    const alternativeSource = {
      type: "aih" as const,
      release: "1.0.1",
      revision: `sha256:${"d".repeat(64)}`,
    };
    const alternativeSourceDigest = governanceDecisionSourceDigestV2(alternativeSource);
    return {
      kind: "tool" as const,
      id: "other-tool",
      source: alternativeSource,
      sourceDigest: alternativeSourceDigest,
      subjectDigest: governanceDecisionSubjectDigestV2({
        kind: "tool",
        id: "other-tool",
        sourceDigest: alternativeSourceDigest,
      }),
    };
  }
  function memberReceipt() {
    const nextSubject = alternativeSubject();
    return {
      ...receipt,
      entryId: "recipe.other",
      subject: nextSubject,
      qualificationBasis: {
        ...receipt.qualificationBasis,
        catalogMemberDigest: `sha256:${"e".repeat(64)}`,
        subjectDigest: nextSubject.subjectDigest,
      },
    };
  }
  function successorReceipt() {
    const nextSubject = alternativeSubject();
    const head = `sha256:${"f".repeat(64)}`;
    return {
      ...receipt,
      entryId: "recipe.successor",
      subject: nextSubject,
      qualificationBasis: {
        ...receipt.qualificationBasis,
        catalogHeadDigest: head,
        catalogMemberDigest: `sha256:${"e".repeat(64)}`,
        subjectDigest: nextSubject.subjectDigest,
      },
      catalogContinuity: {
        ...receipt.catalogContinuity,
        catalogHeadDigest: head,
        previousCatalogHeadDigest: receipt.catalogContinuity.catalogHeadDigest,
        sequence: 1,
        replayIdentity: `catalog-head:${"f".repeat(64)}:${"1".repeat(64)}`,
      },
    };
  }
  function planContext(root: string, apply = true) {
    const run = fakeRunner(() => undefined);
    return {
      root,
      contextDir: "ai-coding",
      posture: "vibe" as const,
      apply,
      verify: false,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options: {},
    };
  }
  function writes(plan: { actions: readonly unknown[] }): WriteAction[] {
    return plan.actions.filter(
      (action): action is WriteAction =>
        typeof action === "object" &&
        action !== null &&
        (action as { kind?: string }).kind === "write",
    );
  }
  function mutatingWrites(plan: { actions: readonly unknown[] }): WriteAction[] {
    return writes(plan).filter((action) => !action.assertUnchanged);
  }
  async function prepare(root: string, candidate = input) {
    return supported.prepareSupportedCustodyAcceptV2({ root, posture: "vibe", candidate });
  }
  async function applyGenesis() {
    const root = mkdtempSync(join(tmpdir(), "aih-supported-custody-"));
    const context = planContext(root);
    const genesis = await prepare(root);
    await executePlan(genesis, context);
    return { root, context, genesis };
  }

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
        .filter((action): action is WriteAction => action.kind === "write")
        .map((action) => action.path),
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
      catalogSignerIdentity: receipt.qualificationBasis.catalogSignerIdentity,
      signerKeyId: receipt.catalogContinuity.signerKeyId,
      replayIdentity: receipt.catalogContinuity.replayIdentity,
      sequence: receipt.catalogContinuity.sequence,
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
    expect(changedDecisionMember?.path).not.toBe(writes[2]?.path);
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
        { describe: "verify supported custody state", text: "supported custody state pending" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the applied postcondition when custody changes after exact slot writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-supported-custody-postcondition-"));
    try {
      const context = planContext(root);
      const plan = supported.planSupportedCustodyAcceptV2({ posture: "vibe", root, ...input });
      const memberDirectory = dirname(join(root, writes(plan)[2]?.path ?? ""));
      supported.__setSupportedCustodyDirectoryScanHookV2(() => {
        writeFileSync(join(memberDirectory, "postcondition-race"), "raced\n", "utf8");
      });
      await expect(executePlan(plan, context)).rejects.toMatchObject({ code: "AIH_TRUST" });
    } finally {
      supported.__setSupportedCustodyDirectoryScanHookV2(undefined);
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

  it("makes exact reacceptance write-free and verifies its postcondition", async () => {
    const { root, context } = await applyGenesis();
    try {
      const repeat = await prepare(root);
      expect(writes(repeat)).toEqual([]);
      const result = await executePlan(repeat, context);
      expect(result.digests).toEqual([
        {
          describe: "verify supported custody state",
          text: "supported custody state verified",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds only an immutable member for another member at the same head and replay", async () => {
    const { root, context, genesis } = await applyGenesis();
    try {
      const original = writes(genesis);
      const before = original
        .slice(0, 2)
        .concat(original.slice(3))
        .map((action) => ({
          path: action.path,
          bytes: readFileSync(join(root, action.path)),
        }));
      const additionalMember = await prepare(
        root,
        candidateFor(memberReceipt(), {
          decision: { id: "decision-allow-other", digest: `sha256:${"8".repeat(64)}` },
        }),
      );
      const planned = writes(additionalMember);
      const mutations = mutatingWrites(additionalMember);
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.path).toMatch(/^\.aih\/supported-qualification\/v2\/members\//);
      const assertions = planned.filter((action) => action.assertUnchanged);
      expect(assertions.map((action) => action.path)).toEqual([
        original[0]?.path,
        original[1]?.path,
        original[3]?.path,
      ]);
      for (const action of assertions) {
        expect(action.expect).toEqual({
          sha256: createHash("sha256")
            .update(readFileSync(join(root, action.path)))
            .digest("hex"),
        });
      }
      await executePlan(additionalMember, context);
      for (const state of before) expect(readFileSync(join(root, state.path))).toEqual(state.bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends a renewed decision binding but refuses replay conflicts at the current head", async () => {
    const { root } = await applyGenesis();
    try {
      const renewedDecision = await prepare(
        root,
        candidateFor(receipt, {
          decision: { id: "decision-changed", digest: `sha256:${"8".repeat(64)}` },
        }),
      );
      expect(mutatingWrites(renewedDecision)).toHaveLength(1);
      expect(mutatingWrites(renewedDecision)[0]?.path).toMatch(
        /^\.aih\/supported-qualification\/v2\/members\//,
      );
      const replayConflict = {
        ...receipt,
        catalogContinuity: {
          ...receipt.catalogContinuity,
          replayIdentity: `catalog-head:${"2".repeat(64)}:${"8".repeat(64)}`,
        },
      };
      await expect(prepare(root, candidateFor(replayConflict))).rejects.toMatchObject({
        code: "AIH_TRUST",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects signer and head races before committing a member-only plan", async () => {
    for (const recordIndex of [0, 3]) {
      const { root, context, genesis } = await applyGenesis();
      try {
        const memberOnly = await prepare(root, candidateFor(memberReceipt()));
        const member = mutatingWrites(memberOnly)[0];
        writeFileSync(join(root, writes(genesis)[recordIndex]?.path ?? ""), "raced", "utf8");
        await expect(executePlan(memberOnly, context)).rejects.toMatchObject({ code: "AIH_TRUST" });
        expect(existsSync(join(root, member?.path ?? ""))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("commits a valid direct successor with immutable slots before the head CAS", async () => {
    const { root, context, genesis } = await applyGenesis();
    try {
      const original = writes(genesis);
      const successor = await prepare(
        root,
        candidateFor(successorReceipt(), {
          decision: { id: "decision-successor", digest: `sha256:${"8".repeat(64)}` },
        }),
      );
      const planned = writes(successor);
      const mutations = mutatingWrites(successor);
      expect(mutations).toHaveLength(3);
      const assertions = planned.filter((action) => action.assertUnchanged);
      expect(assertions.map((action) => action.path)).toEqual([
        original[0]?.path,
        original[1]?.path,
      ]);
      for (const action of assertions)
        expect(action).toMatchObject({
          assertUnchanged: true,
          expect: {
            sha256: createHash("sha256")
              .update(readFileSync(join(root, action.path)))
              .digest("hex"),
          },
        });
      const head = mutations.at(-1);
      expect(head).toMatchObject({ durable: true, assertUnchanged: undefined, once: undefined });
      expect(head?.expect).toEqual({
        sha256: createHash("sha256")
          .update(readFileSync(join(root, original[3]?.path ?? "")))
          .digest("hex"),
      });
      for (const action of mutations.slice(0, -1))
        expect(action).toMatchObject({ durable: true, once: true, expect: { absent: true } });
      expect(mutations.slice(0, -1).map((action) => action.path)).toEqual([
        expect.stringMatching(/^\.aih\/supported-qualification\/v2\/replays\//),
        expect.stringMatching(/^\.aih\/supported-qualification\/v2\/members\//),
      ]);
      await executePlan(successor, context);
      for (const action of original) expect(existsSync(join(root, action.path))).toBe(true);
      expect(
        (
          await executePlan(
            await prepare(
              root,
              candidateFor(successorReceipt(), {
                decision: { id: "decision-successor", digest: `sha256:${"8".repeat(64)}` },
              }),
            ),
            context,
          )
        ).digests.at(-1)?.text,
      ).toBe("supported custody state verified");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses gaps, wrong predecessors, key rotation, and replay reuse at genesis", async () => {
    const { root, context } = await applyGenesis();
    try {
      const successorReceiptData = successorReceipt();
      const variants = [
        {
          ...successorReceiptData,
          catalogContinuity: { ...successorReceiptData.catalogContinuity, sequence: 2 },
        },
        {
          ...successorReceiptData,
          catalogContinuity: {
            ...successorReceiptData.catalogContinuity,
            previousCatalogHeadDigest: `sha256:${"0".repeat(63)}1`,
          },
        },
        {
          ...successorReceiptData,
          catalogContinuity: {
            ...successorReceiptData.catalogContinuity,
            signerKeyId: `ed25519:${"9".repeat(64)}`,
          },
        },
        {
          ...successorReceiptData,
          catalogContinuity: {
            ...successorReceiptData.catalogContinuity,
            replayIdentity: receipt.catalogContinuity.replayIdentity,
          },
        },
      ];
      for (const candidateReceipt of variants)
        await expect(prepare(root, candidateFor(candidateReceipt))).rejects.toMatchObject({
          code: "AIH_TRUST",
        });
      const successor = await prepare(root, candidateFor(successorReceipt()));
      await executePlan(successor, context);
      await expect(prepare(root, candidateFor(receipt))).rejects.toMatchObject({
        code: "AIH_TRUST",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses malformed, detached, hardlinked, symlinked, and replay-misused custody state", async () => {
    const mutationCases = [
      "signer-malformed",
      "head-noncanonical",
      "replay-misused",
      "signer-detached",
      "replay-detached",
      "member-detached",
      "head-detached",
      "head-hardlinked",
      "signer-symlinked",
    ] as const;
    for (const mutation of mutationCases) {
      if (
        process.platform === "win32" &&
        (mutation === "head-hardlinked" || mutation === "signer-symlinked")
      )
        continue;
      const { root, genesis } = await applyGenesis();
      try {
        const records = writes(genesis);
        const signer = join(root, records[0]?.path ?? "");
        const replay = join(root, records[1]?.path ?? "");
        const member = join(root, records[2]?.path ?? "");
        const head = join(root, records[3]?.path ?? "");
        if (mutation === "signer-malformed") writeFileSync(signer, "{}", "utf8");
        if (mutation === "head-noncanonical")
          writeFileSync(
            head,
            `${JSON.stringify(JSON.parse(readFileSync(head, "utf8")), null, 2)}\n`,
            "utf8",
          );
        if (mutation === "replay-misused") {
          const value = JSON.parse(readFileSync(replay, "utf8"));
          writeFileSync(
            replay,
            JSON.stringify({ ...value, replayIdentity: "catalog-head:bad" }),
            "utf8",
          );
        }
        if (mutation === "signer-detached") rmSync(signer);
        if (mutation === "replay-detached") rmSync(replay);
        if (mutation === "member-detached") rmSync(member);
        if (mutation === "head-detached") rmSync(head);
        if (mutation === "head-hardlinked") linkSync(head, `${head}.link`);
        if (mutation === "signer-symlinked") {
          rmSync(signer);
          symlinkSync(head, signer);
        }
        await expect(prepare(root)).rejects.toMatchObject({ code: "AIH_TRUST" });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("refuses forged or wrongly named current-head member records", async () => {
    for (const mutation of ["forged", "wrong-slot"] as const) {
      const { root, genesis } = await applyGenesis();
      try {
        const original = writes(genesis)[2];
        const memberPath = join(root, original?.path ?? "");
        const displacedPath = join(dirname(memberPath), `${"f".repeat(64)}.json`);
        const originalBytes = readFileSync(memberPath);
        rmSync(memberPath);
        writeFileSync(
          displacedPath,
          mutation === "forged"
            ? canonicalStrictJsonBytesV1({
                format: "aih-supported-qualification-custody",
                version: 2,
                kind: "member-claim",
                catalogHeadDigest: receipt.catalogContinuity.catalogHeadDigest,
              })
            : originalBytes,
        );
        await expect(prepare(root, candidateFor(memberReceipt()))).rejects.toMatchObject({
          code: "AIH_TRUST",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("refuses members with forged subject, head-validity, or acceptance bindings", async () => {
    for (const mutation of ["subject", "head-validity", "accepted-at"] as const) {
      const { root, genesis } = await applyGenesis();
      try {
        const original = writes(genesis)[2];
        const originalPath = join(root, original?.path ?? "");
        const value = JSON.parse(readFileSync(originalPath, "utf8"));
        const mutated =
          mutation === "subject"
            ? {
                ...value,
                subject: { ...value.subject, subjectDigest: `sha256:${"b".repeat(64)}` },
              }
            : mutation === "head-validity"
              ? { ...value, headValidFrom: "2026-07-31T00:00:00Z" }
              : {
                  ...value,
                  receiptExpiresAt: "2026-08-08T00:00:00Z",
                  acceptedAt: "2026-08-08T12:00:00Z",
                };
        const path =
          mutation === "subject"
            ? join(
                dirname(originalPath),
                `${custodySlot("member", {
                  catalogHeadDigest: mutated.catalogHeadDigest,
                  catalogMemberDigest: mutated.catalogMemberDigest,
                  subject: mutated.subject,
                  target: mutated.target,
                })}.json`,
              )
            : originalPath;
        rmSync(originalPath);
        writeFileSync(path, canonicalStrictJsonBytesV1(mutated));
        await expect(prepare(root, candidateFor(memberReceipt()))).rejects.toMatchObject({
          code: "AIH_TRUST",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("refuses malformed stored head continuity before successor planning", async () => {
    for (const mutation of ["non-genesis-predecessor", "unordered-validity"] as const) {
      const { root, genesis } = await applyGenesis();
      try {
        const headPath = join(root, writes(genesis)[3]?.path ?? "");
        const head = JSON.parse(readFileSync(headPath, "utf8"));
        writeFileSync(
          headPath,
          canonicalStrictJsonBytesV1(
            mutation === "non-genesis-predecessor"
              ? { ...head, previousCatalogHeadDigest: `sha256:${"9".repeat(64)}` }
              : {
                  ...head,
                  headValidFrom: "2026-08-10T00:00:00Z",
                  headValidUntil: "2026-08-01T00:00:00Z",
                },
          ),
        );
        await expect(prepare(root, candidateFor(successorReceipt()))).rejects.toMatchObject({
          code: "AIH_TRUST",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("bounds current-head member enumeration before scanning a large custody directory", async () => {
    const { root, genesis } = await applyGenesis();
    try {
      const memberDirectory = dirname(join(root, writes(genesis)[2]?.path ?? ""));
      for (let index = 0; index < 4_096; index++) {
        const path = join(memberDirectory, `${index.toString(16).padStart(64, "0")}.json`);
        writeFileSync(
          path,
          canonicalStrictJsonBytesV1({
            format: "aih-supported-qualification-custody",
            version: 2,
            kind: "member-claim",
            catalogHeadDigest: `sha256:${"a".repeat(64)}`,
          }),
        );
      }
      await expect(prepare(root, candidateFor(memberReceipt()))).rejects.toMatchObject({
        code: "AIH_TRUST",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows an occupied exact member slot at capacity but refuses a new member", async () => {
    const { root } = await applyGenesis();
    try {
      const originalMember = writes(
        supported.planSupportedCustodyAcceptV2({ posture: "vibe", root, ...input }),
      )[2];
      const memberValue = JSON.parse(originalMember?.contents ?? "{}") as {
        catalogHeadDigest: unknown;
        catalogMemberDigest: unknown;
        subject: unknown;
        target: unknown;
        authorityReceiptDigest: unknown;
        receiptDigest: unknown;
        repository: unknown;
        workflow: unknown;
        [key: string]: unknown;
      };
      for (let index = 0; index < 4_095; index++) {
        const digest = `sha256:${index.toString(16).padStart(64, "0")}`;
        const value = {
          ...memberValue,
          decisionId: `capacity-${index}`,
          decisionDigest: digest,
        };
        const path = join(
          dirname(join(root, originalMember?.path ?? "")),
          `${custodySlot("member", {
            catalogHeadDigest: memberValue.catalogHeadDigest,
            catalogMemberDigest: memberValue.catalogMemberDigest,
            subject: memberValue.subject,
            target: memberValue.target,
            decision: { id: value.decisionId, digest: value.decisionDigest },
            authorityReceiptDigest: memberValue.authorityReceiptDigest,
            receiptDigest: memberValue.receiptDigest,
            repository: memberValue.repository,
            workflow: memberValue.workflow,
          })}.json`,
        );
        writeFileSync(path, canonicalStrictJsonBytesV1(value), "utf8");
      }
      expect(mutatingWrites(await prepare(root))).toHaveLength(0);
      await expect(
        prepare(
          root,
          candidateFor(receipt, {
            decision: { id: "capacity-new", digest: `sha256:${"b".repeat(64)}` },
          }),
        ),
      ).rejects.toMatchObject({ code: "AIH_TRUST" });
      expect(readFileSync(join(root, originalMember?.path ?? ""), "utf8")).toBe(
        originalMember?.contents,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails closed when inspect sees partial or foreign custody directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-supported-inspect-invalid-"));
    const completeRoot = mkdtempSync(join(tmpdir(), "aih-supported-inspect-foreign-"));
    try {
      const plan = supported.planSupportedCustodyAcceptV2({ posture: "vibe", root, ...input });
      const signer = writes(plan)[0];
      const signerPath = join(root, signer?.path ?? "");
      mkdirSync(dirname(signerPath), { recursive: true });
      writeFileSync(signerPath, signer?.contents ?? "", "utf8");
      expect(() => supported.inspectSupportedCustodyV2({ root, posture: "vibe" })).toThrow(
        expect.objectContaining({ code: "AIH_TRUST" }),
      );
      const genesis = await prepare(completeRoot);
      await executePlan(genesis, planContext(completeRoot));
      const foreign = join(
        completeRoot,
        ".aih",
        "supported-qualification",
        "v2",
        "signers",
        `${"a".repeat(64)}.json`,
      );
      writeFileSync(foreign, canonicalStrictJsonBytesV1({ kind: "foreign" }));
      expect(() =>
        supported.inspectSupportedCustodyV2({ root: completeRoot, posture: "vibe" }),
      ).toThrow(expect.objectContaining({ code: "AIH_TRUST" }));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(completeRoot, { recursive: true, force: true });
    }
  });

  it("rejects a store whose active head lost its current member", async () => {
    const { root, genesis } = await applyGenesis();
    try {
      rmSync(join(root, writes(genesis)[2]?.path ?? ""));
      expect(() => supported.inspectSupportedCustodyV2({ root, posture: "vibe" })).toThrow(
        expect.objectContaining({ code: "AIH_TRUST" }),
      );
      await expect(prepare(root)).rejects.toMatchObject({ code: "AIH_TRUST" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects schema-valid orphan signer and replay claims", async () => {
    const { root } = await applyGenesis();
    try {
      const identity = "orphan-signer";
      const key = `ed25519:${"c".repeat(64)}`;
      const headDigest = `sha256:${"d".repeat(64)}`;
      const replayIdentity = `catalog-head:${"d".repeat(64)}:${"e".repeat(64)}`;
      const custody = join(root, ".aih", "supported-qualification", "v2");
      writeFileSync(
        join(custody, "signers", `${custodySlot("signer", identity)}.json`),
        canonicalStrictJsonBytesV1({
          format: "aih-supported-qualification-custody",
          version: 2,
          kind: "signer-claim",
          catalogSignerIdentity: identity,
          signerKeyId: key,
        }),
      );
      writeFileSync(
        join(custody, "replays", `${custodySlot("replay", replayIdentity)}.json`),
        canonicalStrictJsonBytesV1({
          format: "aih-supported-qualification-custody",
          version: 2,
          kind: "replay-claim",
          replayIdentity,
          catalogSignerIdentity: identity,
          signerKeyId: key,
          catalogHeadDigest: headDigest,
          sequence: 0,
        }),
      );
      expect(() => supported.inspectSupportedCustodyV2({ root, posture: "vibe" })).toThrow(
        expect.objectContaining({ code: "AIH_TRUST" }),
      );
      await expect(prepare(root)).rejects.toMatchObject({ code: "AIH_TRUST" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an in-directory mutation after a bounded custody scan", async () => {
    const { root, genesis } = await applyGenesis();
    try {
      const memberDirectory = dirname(join(root, writes(genesis)[2]?.path ?? ""));
      supported.__setSupportedCustodyDirectoryScanHookV2(() => {
        writeFileSync(join(memberDirectory, "scan-race"), "raced\n", "utf8");
      });
      expect(() => supported.inspectSupportedCustodyV2({ root, posture: "vibe" })).toThrow(
        expect.objectContaining({ code: "AIH_TRUST" }),
      );
    } finally {
      supported.__setSupportedCustodyDirectoryScanHookV2(undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a raced current replay or predecessor head without successor effects", async () => {
    for (const recordIndex of [1, 3]) {
      const { root, context, genesis } = await applyGenesis();
      try {
        const successor = await prepare(root, candidateFor(successorReceipt()));
        const immutable = mutatingWrites(successor).slice(0, -1);
        writeFileSync(join(root, writes(genesis)[recordIndex]?.path ?? ""), "raced", "utf8");
        await expect(executePlan(successor, context)).rejects.toMatchObject({ code: "AIH_TRUST" });
        for (const action of immutable) expect(existsSync(join(root, action.path))).toBe(false);
        expect(readFileSync(join(root, writes(genesis)[recordIndex]?.path ?? ""), "utf8")).toBe(
          "raced",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("registers real supported accept and scrubbed read-only inspect commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-supported-inspect-"));
    const priorExitCode = process.exitCode;
    const output: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        output.push(String(chunk));
        return true;
      });
    const program = buildProgram();
    const policy = program.commands.find((command) => command.name() === "policy");
    const command = policy?.commands.find((candidate) => candidate.name() === "supported");
    expect(command?.commands.map((candidate) => candidate.name())).toEqual(["accept", "inspect"]);
    const accept = command?.commands.find((candidate) => candidate.name() === "accept");
    const acceptFlags = accept?.options.map((option) => option.long) ?? [];
    for (const flag of ["--decision", "--decision-digest", "--target", "--apply"])
      expect(acceptFlags).toContain(flag);
    for (const forbidden of ["--receipt", "--verifier", "--clock", "--continuity", "--store-root"])
      expect(acceptFlags).not.toContain(forbidden);
    expect(
      command?.commands.find((candidate) => candidate.name() === "inspect")?.options,
    ).not.toContain(expect.objectContaining({ long: "--apply" }));
    try {
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      await expect(
        program.parseAsync([
          "node",
          "aih",
          "policy",
          "supported",
          "inspect",
          "--root",
          root,
          "--json",
        ]),
      ).resolves.toBeDefined();
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({
        capability: "policy-supported-custody-inspect-v2",
        writes: [],
        digests: [
          {
            data: { deterministic: true, scrubbed: true, limit: 4096, members: [] },
          },
        ],
      });
      expect(output.join("")).not.toContain(root);
    } finally {
      write.mockRestore();
      process.exitCode = priorExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
