import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as supported from "../../src/org-policy/supported-admin-v2.js";
import { buildProgram } from "../../src/program.js";
import { executePlan } from "../../src/internals/execute.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

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
  const receipt = {
    entryId: "recipe.default",
    qualificationBasis: {
      catalogSignerIdentity: "catalog-signer",
      catalogDigest: `sha256:${"1".repeat(64)}`,
      catalogHeadDigest: `sha256:${"2".repeat(64)}`,
      catalogMemberDigest: `sha256:${"3".repeat(64)}`,
      subjectKind: "tool",
      subjectDigest: `sha256:${"4".repeat(64)}`,
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
    subject: { kind: "tool", subjectDigest: `sha256:${"4".repeat(64)}` },
    issuedAt: "2026-08-01T00:00:00Z",
    notBefore: "2026-08-01T00:00:00Z",
    expiresAt: "2026-08-10T00:00:00Z",
  };
  const input = {
    receipt,
    decision: { id: "allow-tool", digest: `sha256:${"7".repeat(64)}` },
    target: "claude",
    receiptDigest: `sha256:${"8".repeat(64)}`,
    receiptSha256: `sha256:${"9".repeat(64)}`,
    authorityReceiptDigest: `sha256:${"a".repeat(64)}`,
    repository: "aihq/aih-supported",
    workflow: ".github/workflows/qualification.yml",
    acceptedAt: "2026-08-02T00:00:00Z",
    decisionNotBefore: "2026-08-01T00:00:00Z",
    decisionExpiresAt: "2026-08-09T00:00:00Z",
  };

  it("plans immutable claim, replay and member slots before a guarded lineage head", () => {
    const plan = supported.planSupportedCustodyAcceptV2({
      posture: "vibe",
      root: "/disposable",
      ...input,
    });
    expect(plan.commitLock).toBe(".aih/supported-qualification/v2/locks/commit.lock");
    expect(plan.commitNotAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(plan.actions.map((action: { path?: string }) => action.path)).toEqual([
      expect.stringContaining("signers/catalog-signer/ed25519:"),
      expect.stringContaining("replays/catalog-head:"),
      expect.stringContaining("members/sha256:"),
      expect.stringContaining("heads/catalog-signer/ed25519:"),
    ]);
    for (const path of plan.actions.map((action: { path?: string }) => action.path ?? ""))
      expect(path.split("/").every((segment) => /^[A-Za-z0-9._-]+$/.test(segment))).toBe(true);
    for (const action of plan.actions.slice(0, -1)) {
      expect(action).toMatchObject({ durable: true, once: true, expect: { absent: true } });
    }
    expect(plan.actions.at(-1)).toMatchObject({ expect: { absent: true } });
  });

  it("reads immutable slots from disk, makes exact reacceptance write-free, and guards a raced successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-supported-custody-"));
    try {
      const base = join(root, ".aih", "supported-qualification", "v2");
      mkdirSync(join(base, "heads", "catalog-signer"), { recursive: true });
      const head = join(base, "heads", "catalog-signer", "ed25519:abc.json");
      writeFileSync(
        head,
        JSON.stringify({ sequence: 0, replayIdentity: receipt.catalogContinuity.replayIdentity }),
      );
      const prepared = await supported.prepareSupportedCustodyAcceptV2({
        root,
        posture: "vibe",
        candidate: input,
      });
      expect(prepared.plan.actions).toEqual([]);
      writeFileSync(head, "raced");
      const run = fakeRunner(() => undefined);
      await expect(
        executePlan(prepared.successorPlan, {
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
