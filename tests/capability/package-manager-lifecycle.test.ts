import { describe, expect, it } from "vitest";
import { adaptSkillPackageGraph } from "../../src/capability/package-graph/adapters/skills.js";
import { buildPackageGraphIndex } from "../../src/capability/package-graph/build.js";
import {
  type CapabilityPackageLifecycleReady,
  planCapabilityPackageLifecycle,
} from "../../src/capability/package-manager/lifecycle.js";

const SHA_A = "a".repeat(40);

function bytes(value: unknown, spacing?: number): Buffer {
  return Buffer.from(JSON.stringify(value, null, spacing), "utf8");
}

function fixture(
  options: {
    lock?: unknown;
    packs?: unknown;
    spacing?: number;
    roots?: string[];
    dependencies?: Record<string, string[]>;
  } = {},
) {
  const adapted = adaptSkillPackageGraph({
    lockAuthorityId: "lock:aih-skills",
    catalogAuthorityId: "catalog:aih-packs",
    hostSource: { provider: "github", repository: "host/project" },
    lockBytes: bytes(
      options.lock ?? {
        schemaVersion: 1,
        skills: [
          {
            name: "clean",
            source: `owner/repo@${SHA_A}`,
            commit: SHA_A,
            verdict: "GREEN",
            scope: "repo",
            card: "ai-coding/skill-cards/clean.json",
            evidenceSha256: "e".repeat(64),
            approvedBy: "docs-platform",
            approvedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
      },
    ),
    packsBytes: bytes(
      options.packs ?? {
        schemaVersion: 1,
        packs: [
          {
            name: "docs-quality",
            skills: [{ name: "clean", source: `owner/repo@${SHA_A}`, commit: SHA_A }],
          },
        ],
      },
    ),
  });
  const index = buildPackageGraphIndex(adapted.documents);
  const authority = index.authorities.find(({ kind }) => kind === "catalog");
  const claims = index.claims.filter(
    (claim) => claim.entityKind === "package" && claim.authorityId === authority?.id,
  );
  if (authority === undefined || claims.length === 0) throw new Error("expected pack fixture");
  const manifest = {
    schemaVersion: 1 as const,
    authorities: [authority],
    roots: options.roots ?? claims.map(({ id }) => id),
    packages: claims.map((claim) => {
      if (claim.entityKind !== "package") throw new Error("expected package claim");
      return {
        kind: "package" as const,
        id: claim.id,
        authorityId: claim.authorityId,
        claimDigest: claim.claimDigest,
        sourceDigest: claim.entity.sourceDigest,
        dependencies: options.dependencies?.[claim.id] ?? [],
        members: claim.entity.members,
      };
    }),
  };
  return {
    intentBytes: bytes(manifest, options.spacing),
    index,
    diagnostics: adapted.diagnostics,
  };
}

function ready(value: ReturnType<typeof planCapabilityPackageLifecycle>) {
  expect(value.status).toBe("ready");
  return value as CapabilityPackageLifecycleReady & {
    desiredReceipt: NonNullable<CapabilityPackageLifecycleReady["desiredReceipt"]>;
  };
}

describe("Capability Package Manager pure lifecycle planning", () => {
  it("proposes additions and exact next ownership receipt material without execution claims", () => {
    const input = fixture();
    const result = ready(planCapabilityPackageLifecycle(input));

    expect(result.changes).toEqual({
      add: ["package:skill-pack/docs-quality"],
      update: [],
      remove: [],
      unchanged: [],
    });
    expect(result.refusals).toEqual([]);
    expect(result.desiredReceipt.receipt).toMatchObject({
      format: "aih-capability-package-ownership-receipt",
      schemaVersion: 1,
      roots: ["package:skill-pack/docs-quality"],
      packages: [
        {
          id: "package:skill-pack/docs-quality",
          authorityId: "catalog:aih-packs",
          members: [{ id: "skill:clean" }],
        },
      ],
    });
    expect(result.desiredReceipt.serialized.endsWith("\n")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/installed|configured/i);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.desiredReceipt.receipt.packages)).toBe(true);
  });

  it("reports unchanged, update, and removal metadata deterministically", () => {
    const input = fixture();
    const initial = ready(planCapabilityPackageLifecycle(input));
    const unchanged = ready(
      planCapabilityPackageLifecycle({ ...input, currentReceipt: initial.desiredReceipt.receipt }),
    );
    expect(unchanged.changes).toEqual({
      add: [],
      update: [],
      remove: [],
      unchanged: ["package:skill-pack/docs-quality"],
    });

    const stale = structuredClone(initial.desiredReceipt.receipt);
    const stalePackage = stale.packages[0];
    if (stalePackage === undefined) throw new Error("expected package fixture");
    stalePackage.claimDigest = "b".repeat(64);
    stale.packages.push({
      ...structuredClone(stalePackage),
      id: "package:skill-pack/removed",
      dependencies: [],
    });
    const changed = ready(planCapabilityPackageLifecycle({ ...input, currentReceipt: stale }));
    expect(changed.changes).toEqual({
      add: [],
      update: ["package:skill-pack/docs-quality"],
      remove: ["package:skill-pack/removed"],
      unchanged: [],
    });
  });

  it("treats lock authority reference changes as package updates", () => {
    const input = fixture();
    const initial = ready(planCapabilityPackageLifecycle(input));
    const stale = structuredClone(initial.desiredReceipt.receipt);
    const reference = stale.packages[0]?.members[0]?.authorityRefs[0];
    if (reference === undefined) throw new Error("expected authority ref fixture");
    reference.claimDigest = "b".repeat(64);

    const result = ready(planCapabilityPackageLifecycle({ ...input, currentReceipt: stale }));
    expect(result.changes).toEqual({
      add: [],
      update: ["package:skill-pack/docs-quality"],
      remove: [],
      unchanged: [],
    });
  });

  it("rejects accessor-backed receipts and indexes without invoking getters", () => {
    const input = fixture();
    const initial = ready(planCapabilityPackageLifecycle(input));
    let receiptCalls = 0;
    const hostileReceipt = structuredClone(initial.desiredReceipt.receipt);
    Object.defineProperty(hostileReceipt, "packages", {
      enumerable: true,
      get() {
        receiptCalls += 1;
        return [];
      },
    });
    const receiptResult = planCapabilityPackageLifecycle({
      ...input,
      currentReceipt: hostileReceipt,
    });
    expect(receiptResult).toMatchObject({
      status: "refused",
      refusals: [{ stage: "receipt", code: "invalid-current-receipt" }],
    });
    expect(receiptCalls).toBe(0);

    let indexCalls = 0;
    const hostileIndex = structuredClone(input.index);
    Object.defineProperty(hostileIndex, "claims", {
      enumerable: true,
      get() {
        indexCalls += 1;
        return [];
      },
    });
    const indexResult = planCapabilityPackageLifecycle({
      ...input,
      index: hostileIndex,
    });
    expect(indexResult.status).toBe("refused");
    expect(indexCalls).toBe(0);
  });

  it("rejects hostile outer lifecycle requests without invoking accessors", () => {
    const input = fixture();
    let operationCalls = 0;
    const hostileOperation = { ...input };
    Object.defineProperty(hostileOperation, "operation", {
      enumerable: true,
      get() {
        operationCalls += 1;
        return "reconcile";
      },
    });
    expect(planCapabilityPackageLifecycle(hostileOperation as never).status).toBe("refused");
    expect(operationCalls).toBe(0);

    let indexCalls = 0;
    const hostileIndex = { ...input };
    Object.defineProperty(hostileIndex, "index", {
      enumerable: true,
      get() {
        indexCalls += 1;
        return input.index;
      },
    });
    expect(planCapabilityPackageLifecycle(hostileIndex as never).status).toBe("refused");
    expect(indexCalls).toBe(0);

    expect(planCapabilityPackageLifecycle(new Proxy(input, {}) as never).status).toBe("refused");
  });

  it("keeps exact intent-byte identity separate from an unchanged semantic package", () => {
    const compactInput = fixture();
    const compact = ready(planCapabilityPackageLifecycle(compactInput));
    const pretty = ready(
      planCapabilityPackageLifecycle({
        ...fixture({ spacing: 2 }),
        currentReceipt: compact.desiredReceipt.receipt,
      }),
    );

    expect(pretty.changes.unchanged).toEqual(["package:skill-pack/docs-quality"]);
    expect(pretty.desiredReceipt.receipt.manifest.sha256).not.toBe(
      compact.desiredReceipt.receipt.manifest.sha256,
    );
  });

  it("removes explicit roots, retains shared reachable dependencies, and removes the final receipt", () => {
    const skill = (name: string, evidence: string) => ({
      name,
      source: `owner/repo@${SHA_A}`,
      commit: SHA_A,
      verdict: "GREEN",
      scope: "repo",
      card: `ai-coding/skill-cards/${name}.json`,
      evidenceSha256: evidence.repeat(64),
      approvedBy: "docs-platform",
      approvedAt: "2026-08-09T00:00:00.000Z",
    });
    const ref = (name: string) => ({
      name,
      source: `owner/repo@${SHA_A}`,
      commit: SHA_A,
    });
    const rootA = "package:skill-pack/alpha";
    const rootB = "package:skill-pack/beta";
    const shared = "package:skill-pack/shared";
    const input = fixture({
      lock: {
        schemaVersion: 1,
        skills: [skill("alpha", "a"), skill("beta", "b"), skill("shared", "c")],
      },
      packs: {
        schemaVersion: 1,
        packs: [
          { name: "shared", skills: [ref("shared")] },
          { name: "beta", skills: [ref("beta")] },
          { name: "alpha", skills: [ref("alpha")] },
        ],
      },
      roots: [rootB, rootA],
      dependencies: { [rootA]: [shared], [rootB]: [shared] },
    });
    const initial = ready(planCapabilityPackageLifecycle(input));
    const currentReceipt = initial.desiredReceipt.receipt;

    const retained = ready(
      planCapabilityPackageLifecycle({
        ...input,
        operation: "remove",
        removeRoots: [rootA],
        currentReceipt,
      }),
    );
    expect(retained.changes).toEqual({
      add: [],
      update: [],
      remove: [rootA],
      unchanged: [rootB, shared],
    });
    expect(retained.desiredReceipt.receipt.roots).toEqual([rootB]);
    expect(retained.desiredReceipt.receipt.packages.map(({ id }) => id)).toEqual([rootB, shared]);
    expect(retained.desiredIntent?.sha256).toBe(retained.desiredReceipt.receipt.manifest.sha256);
    expect(Buffer.from(retained.desiredIntent?.bytes ?? []).equals(input.intentBytes)).toBe(false);

    const shuffledManifest = JSON.parse(input.intentBytes.toString("utf8")) as {
      authorities: unknown[];
      roots: string[];
      packages: Array<{ dependencies: string[]; members: string[] }>;
    };
    shuffledManifest.authorities.reverse();
    shuffledManifest.roots.reverse();
    shuffledManifest.packages.reverse();
    for (const pkg of shuffledManifest.packages) {
      pkg.dependencies.reverse();
      pkg.members.reverse();
    }
    const shuffledInput = { ...input, intentBytes: bytes(shuffledManifest) };
    const shuffledInitial = ready(planCapabilityPackageLifecycle(shuffledInput));
    const shuffledRetained = ready(
      planCapabilityPackageLifecycle({
        ...shuffledInput,
        operation: "remove",
        removeRoots: [rootA],
        currentReceipt: shuffledInitial.desiredReceipt.receipt,
      }),
    );
    expect(shuffledRetained.desiredIntent?.bytes).toEqual(retained.desiredIntent?.bytes);
    expect(shuffledRetained.desiredIntent?.sha256).toBe(retained.desiredIntent?.sha256);

    const removed = ready(
      planCapabilityPackageLifecycle({
        ...input,
        operation: "remove",
        removeRoots: [rootB],
        intentBytes: Buffer.from(retained.desiredIntent?.bytes ?? []),
        currentReceipt: retained.desiredReceipt.receipt,
      }),
    );
    expect(removed.changes.remove).toEqual([rootB, shared]);
    expect(removed).not.toHaveProperty("desiredReceipt");

    const unknown = planCapabilityPackageLifecycle({
      ...input,
      operation: "remove",
      removeRoots: ["package:skill-pack/missing"],
      currentReceipt,
    });
    expect(unknown).toMatchObject({
      status: "refused",
      refusals: [{ stage: "operation", code: "unknown-root" }],
    });
  });

  it("does not execute inherited toJSON while serializing reduced intent", () => {
    const rootA = "package:skill-pack/alpha";
    const rootB = "package:skill-pack/beta";
    const skill = (name: string) => ({
      name,
      source: `owner/repo@${SHA_A}`,
      commit: SHA_A,
      verdict: "GREEN",
      scope: "repo",
      card: `ai-coding/skill-cards/${name}.json`,
      evidenceSha256: name === "alpha" ? "a".repeat(64) : "b".repeat(64),
      approvedBy: "docs-platform",
      approvedAt: "2026-08-09T00:00:00.000Z",
    });
    const input = fixture({
      lock: { schemaVersion: 1, skills: [skill("alpha"), skill("beta")] },
      packs: {
        schemaVersion: 1,
        packs: ["alpha", "beta"].map((name) => ({
          name,
          skills: [{ name, source: `owner/repo@${SHA_A}`, commit: SHA_A }],
        })),
      },
      roots: [rootA, rootB],
    });
    const currentReceipt = ready(planCapabilityPackageLifecycle(input)).desiredReceipt.receipt;
    const baseline = ready(
      planCapabilityPackageLifecycle({
        ...input,
        operation: "remove",
        removeRoots: [rootA],
        currentReceipt,
      }),
    );
    const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    let calls = 0;
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value() {
          calls += 1;
          return { attacker: "object" };
        },
      });
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value() {
          calls += 1;
          return ["attacker-array"];
        },
      });
      const polluted = ready(
        planCapabilityPackageLifecycle({
          ...input,
          operation: "remove",
          removeRoots: [rootA],
          currentReceipt,
        }),
      );
      expect(polluted.desiredIntent?.bytes).toEqual(baseline.desiredIntent?.bytes);
      expect(calls).toBe(0);
    } finally {
      if (objectDescriptor === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Object.prototype, "toJSON", objectDescriptor);
      if (arrayDescriptor === undefined) delete (Array.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Array.prototype, "toJSON", arrayDescriptor);
    }
  });

  it("returns refusal metadata when an authority-fatal requiredChecks diagnostic is omitted", () => {
    const input = fixture();
    const unsupported = adaptSkillPackageGraph({
      lockAuthorityId: "lock:aih-skills",
      catalogAuthorityId: "catalog:aih-packs",
      hostSource: { provider: "github", repository: "host/project" },
      lockBytes: bytes({
        schemaVersion: 1,
        skills: [
          {
            name: "clean",
            source: `owner/repo@${SHA_A}`,
            commit: SHA_A,
            verdict: "GREEN",
            scope: "repo",
            card: "ai-coding/skill-cards/clean.json",
            evidenceSha256: "e".repeat(64),
            approvedBy: "docs-platform",
            approvedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
      }),
      packsBytes: bytes({
        schemaVersion: 1,
        packs: [
          {
            name: "docs-quality",
            requiredChecks: ["no-exec"],
            skills: [{ name: "clean", source: `owner/repo@${SHA_A}`, commit: SHA_A }],
          },
        ],
      }),
    });
    const result = planCapabilityPackageLifecycle({
      ...input,
      index: buildPackageGraphIndex(unsupported.documents),
      diagnostics: [],
    });

    expect(result).toMatchObject({
      status: "refused",
      changes: { add: [], update: [], remove: [], unchanged: [] },
      refusals: [{ stage: "resolution", code: "missing-authority" }],
    });
    expect(result).not.toHaveProperty("desiredReceipt");
  });

  it("fails closed on malformed intent or current receipt without partial metadata", () => {
    const input = fixture();
    const malformedIntent = planCapabilityPackageLifecycle({
      ...input,
      intentBytes: Buffer.from("{broken", "utf8"),
    });
    expect(malformedIntent).toMatchObject({
      status: "refused",
      changes: { add: [], update: [], remove: [], unchanged: [] },
      refusals: [{ stage: "intent", code: "invalid-intent" }],
    });

    const malformedReceipt = planCapabilityPackageLifecycle({
      ...input,
      currentReceipt: { unknown: true },
    });
    expect(malformedReceipt).toMatchObject({
      status: "refused",
      changes: { add: [], update: [], remove: [], unchanged: [] },
      refusals: [{ stage: "receipt", code: "invalid-current-receipt" }],
    });
  });
});
