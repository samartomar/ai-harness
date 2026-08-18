import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsHooks = vi.hoisted(() => ({
  afterFsync: undefined as undefined | ((fd: number) => void),
  afterRename: undefined as undefined | ((from: string, to: string) => void),
  afterRemove: undefined as undefined | ((path: string) => void),
  beforeLink: undefined as undefined | ((from: string, to: string) => void),
  beforeRename: undefined as undefined | ((from: string, to: string) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => {
      actual.fsyncSync(...args);
      fsHooks.afterFsync?.(args[0]);
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      fsHooks.beforeLink?.(String(args[0]), String(args[1]));
      return actual.linkSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      fsHooks.beforeRename?.(String(args[0]), String(args[1]));
      const result = actual.renameSync(...args);
      fsHooks.afterRename?.(String(args[0]), String(args[1]));
      return result;
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      actual.rmSync(...args);
      fsHooks.afterRemove?.(String(args[0]));
    },
  };
});

import {
  canonicalAdminSeatDistributionV1Bytes,
  createAdminSeatDistributionV1,
  createResolvedCatalogBindingV1,
} from "../../src/org-policy/catalog-binding-v1.js";
import { resolveOperationalDeveloperSeatCatalogV1 } from "../../src/org-policy/developer-seat-catalog-operations-v1.js";

/**
 * Fixed custody slot names under the authority-controlled root. They are part of
 * the contract precisely BECAUSE the caller cannot choose them: no relative
 * path, digest, channel, or identity ever reaches a path segment here.
 */
const CURRENT_SLOT = "current.json";
const LAST_GOOD_SLOT = "last-good.json";
const LOCK_SLOT = ".promote.lock";
const MAX_TRANSPORT_BYTES = 96 * 1024;

const ADAPTER_ERROR = /developer seat catalog:/;
const CORE_ERROR = "DEVELOPER_SEAT_CATALOG_CONSUMPTION_V1";
/**
 * Core emits its own diagnostics, but delegates codec and signature judgment to
 * the shipped binding module, which speaks its own fixed vocabulary. Both are
 * DELEGATED failures. What custody must guarantee is only this: the rejection is
 * never the adapter's own, and nothing was written.
 */
const DELEGATED_ERROR = /^(?:DEVELOPER_SEAT_CATALOG_CONSUMPTION_V1|invalid )/;

/** Assert the rejection came from the shipped foundation, never from custody. */
function expectDelegatedFailure(run: () => unknown): void {
  let message: string | undefined;
  try {
    run();
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message, "expected a delegated failure").toBeTypeOf("string");
  expect(message ?? "").not.toMatch(ADAPTER_ERROR);
  expect(message ?? "").toMatch(DELEGATED_ERROR);
}

function expectAdapterFailure(run: () => unknown): void {
  let message: string | undefined;
  try {
    run();
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message, "expected an adapter failure").toBeTypeOf("string");
  expect(message ?? "").toMatch(ADAPTER_ERROR);
  expect(message ?? "").not.toContain(workspace);
  expect(message ?? "").not.toContain(seatRoot);
}

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const headRoot = sha("developer-seat head signer root");
const adminRoot = sha("developer-seat admin signer root");
const identity = "signer:developer-seat-admin-v1";

let workspace: string;
let seatRoot: string;

function member(overrides: Record<string, unknown> = {}) {
  return {
    candidateIdentitySha256: sha("candidate identity"),
    candidateSha256: sha("candidate"),
    componentId: "skill:catalog-example",
    evidenceSha256: sha("evidence"),
    gitCommitSha256: sha("commit"),
    pinSha256: sha("pin"),
    policyRevisionSha256: sha("policy"),
    profileSha256: sha("profile"),
    promotionDecisionSha256: sha("promotion"),
    qualificationBundleSha256: sha("qualification"),
    recipeSha256: sha("recipe"),
    repository: "github.com/example/catalog-example",
    sourceId: "catalog-example",
    sourceSha256: sha("source"),
    ...overrides,
  };
}

function bindingInput(overrides: Record<string, unknown> = {}) {
  return {
    adminSignerRootSha256: adminRoot,
    catalogHeadSha256: sha("catalog head"),
    catalogSha256: sha("catalog snapshot"),
    compatibleEffectVersion: "1",
    compatibleSchemaVersion: "1",
    headSignerRootSha256: headRoot,
    members: [member()],
    protocol: "ResolvedCatalogBindingV1" as const,
    resolvedAt: "2026-08-17T12:00:00Z",
    sequence: 42,
    tier: "fresh" as const,
    ...overrides,
  };
}

function distributionBytes(overrides: Record<string, unknown> = {}, keyid = "seat-key-1"): Buffer {
  return canonicalAdminSeatDistributionV1Bytes(
    createAdminSeatDistributionV1({
      binding: createResolvedCatalogBindingV1(bindingInput(overrides)),
      signatures: [{ keyid, sig: Buffer.from(keyid, "utf8").toString("base64") }],
      signerIdentity: identity,
    }),
  );
}

function operationalInput(overrides: Record<string, unknown> = {}) {
  return {
    expectedAdminSignerIdentity: identity,
    expectedAdminSignerRootSha256: adminRoot,
    expectedEffectVersion: "1",
    expectedHeadSignerRootSha256: headRoot,
    expectedSchemaVersion: "1",
    maxAgeSeconds: 3600,
    now: "2026-08-17T12:00:00Z",
    seatRoot,
    verifyCanonicalPae: () => true,
    ...overrides,
  };
}

const currentPath = (root: string = seatRoot): string => join(root, CURRENT_SLOT);
const lastGoodPath = (root: string = seatRoot): string => join(root, LAST_GOOD_SLOT);
const lockPath = (root: string = seatRoot): string => join(root, LOCK_SLOT);

function seedCurrent(bytes: Buffer = distributionBytes()): Buffer {
  writeFileSync(currentPath(), bytes);
  return bytes;
}

function seedLastGood(bytes: Buffer): Buffer {
  writeFileSync(lastGoodPath(), bytes);
  return bytes;
}

/** Every entry the adapter could leave behind, so scratch and lock leaks are visible. */
function rootEntries(root: string = seatRoot): string[] {
  return readdirSync(root).sort();
}

function resetFsHooks(): void {
  fsHooks.afterFsync = undefined;
  fsHooks.afterRename = undefined;
  fsHooks.afterRemove = undefined;
  fsHooks.beforeLink = undefined;
  fsHooks.beforeRename = undefined;
}

beforeEach(() => {
  resetFsHooks();
  workspace = mkdtempSync(join(tmpdir(), "aih-seat-catalog-ops-"));
  seatRoot = join(workspace, "seat");
  mkdirSync(seatRoot, { recursive: true });
});

afterEach(() => {
  resetFsHooks();
  rmSync(workspace, { force: true, recursive: true });
});

describe("operational developer-seat catalog custody V1", () => {
  it("resolves current from the fixed slot and returns the Core result verbatim with no added authority fields", () => {
    const bytes = seedCurrent();
    const verifyCanonicalPae = vi.fn(() => true);

    const result = resolveOperationalDeveloperSeatCatalogV1(
      operationalInput({ verifyCanonicalPae }),
    ) as unknown as Record<string, unknown>;

    expect(Object.keys(result).sort()).toEqual([
      "ageSeconds",
      "binding",
      "distribution",
      "kind",
      "protocol",
      "resolvedAt",
      "sequence",
      "source",
    ]);
    expect(result.kind).toBe("resolved");
    expect(result.protocol).toBe("DeveloperSeatCatalogConsumptionV1");
    expect(result.source).toBe("current");
    expect(result.sequence).toBe(42);
    expect(result.ageSeconds).toBe(0);
    // No custody, path, root, slot, lock, promotion, or authority fact is added.
    for (const forbidden of [
      "seatRoot",
      "root",
      "path",
      "slot",
      "promoted",
      "lastGood",
      "current",
      "authority",
      "custody",
    ])
      expect(result).not.toHaveProperty(forbidden);
    expect(verifyCanonicalPae).toHaveBeenCalledOnce();
    expect(readFileSync(currentPath()).equals(bytes)).toBe(true);
  });

  it("promotes the exact verified current bytes to last-good, preserves current, and leaves no lock or scratch behind", () => {
    const bytes = seedCurrent();

    const result = resolveOperationalDeveloperSeatCatalogV1(operationalInput()) as {
      kind: string;
      source: string;
    };

    expect(result.kind).toBe("resolved");
    expect(result.source).toBe("current");
    expect(readFileSync(lastGoodPath()).equals(bytes)).toBe(true);
    expect(readFileSync(currentPath()).equals(bytes)).toBe(true);
    expect(rootEntries()).toEqual([CURRENT_SLOT, LAST_GOOD_SLOT]);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("overwrites a stale last-good with the newer verified current bytes without touching current", () => {
    const stale = seedLastGood(
      distributionBytes({ resolvedAt: "2026-08-17T10:00:00Z", sequence: 41 }),
    );
    const bytes = seedCurrent(distributionBytes({ sequence: 42 }));

    const result = resolveOperationalDeveloperSeatCatalogV1(operationalInput()) as {
      sequence: number;
      source: string;
    };

    expect(result.source).toBe("current");
    expect(result.sequence).toBe(42);
    expect(readFileSync(lastGoodPath()).equals(bytes)).toBe(true);
    expect(readFileSync(lastGoodPath()).equals(stale)).toBe(false);
    expect(readFileSync(currentPath()).equals(bytes)).toBe(true);
    expect(rootEntries()).toEqual([CURRENT_SLOT, LAST_GOOD_SLOT]);
  });

  it("writes nothing when the resolution came from last-good, when it is compatibility-required, or when Core fails", () => {
    // 1. resolved / last-good: current absent, prior present.
    const prior = seedLastGood(distributionBytes({ sequence: 41 }));
    const fromPrior = resolveOperationalDeveloperSeatCatalogV1(operationalInput()) as {
      kind: string;
      source: string;
    };
    expect(fromPrior.kind).toBe("resolved");
    expect(fromPrior.source).toBe("last-good");
    expect(readFileSync(lastGoodPath()).equals(prior)).toBe(true);
    expect(existsSync(currentPath())).toBe(false);
    expect(rootEntries()).toEqual([LAST_GOOD_SLOT]);

    // 2. A closed non-materializable verdict is never promoted, even from current.
    rmSync(lastGoodPath(), { force: true });
    const incompatible = seedCurrent(distributionBytes({ compatibleEffectVersion: "2" }));
    const closed = resolveOperationalDeveloperSeatCatalogV1(operationalInput()) as {
      kind: string;
      materializable: boolean;
    };
    expect(closed.kind).toBe("compatibility-required");
    expect(closed.materializable).toBe(false);
    expect(existsSync(lastGoodPath())).toBe(false);
    expect(readFileSync(currentPath()).equals(incompatible)).toBe(true);
    expect(rootEntries()).toEqual([CURRENT_SLOT]);

    // 3. Core failure: a rejecting verifier mutates nothing.
    seedCurrent();
    expectDelegatedFailure(() =>
      resolveOperationalDeveloperSeatCatalogV1(
        operationalInput({ verifyCanonicalPae: () => false }),
      ),
    );
    expect(existsSync(lastGoodPath())).toBe(false);
    expect(rootEntries()).toEqual([CURRENT_SLOT]);
  });

  it("fails closed when verification races non-promoting last-good or compatibility results", () => {
    const prior = seedLastGood(distributionBytes({ sequence: 41 }));
    const replacement = distributionBytes({ sequence: 42 });
    const replaceLastGood = (): boolean => {
      writeFileSync(lastGoodPath(), replacement);
      return true;
    };

    expectAdapterFailure(() =>
      resolveOperationalDeveloperSeatCatalogV1(
        operationalInput({ verifyCanonicalPae: replaceLastGood }),
      ),
    );
    expect(existsSync(currentPath())).toBe(false);
    expect(readFileSync(lastGoodPath()).equals(replacement)).toBe(true);
    expect(readFileSync(lastGoodPath()).equals(prior)).toBe(false);
    expect(rootEntries()).toEqual([LAST_GOOD_SLOT]);

    rmSync(lastGoodPath(), { force: true });
    seedCurrent(distributionBytes({ compatibleEffectVersion: "2" }));
    const moved = join(workspace, "compatibility-race-root");
    const replaceRoot = (): boolean => {
      renameSync(seatRoot, moved);
      mkdirSync(seatRoot, { recursive: true });
      return true;
    };

    expectAdapterFailure(() =>
      resolveOperationalDeveloperSeatCatalogV1(
        operationalInput({ verifyCanonicalPae: replaceRoot }),
      ),
    );
    expect(rootEntries()).toEqual([]);
    expect(readdirSync(moved).sort()).toEqual([CURRENT_SLOT]);
  });

  it("calls Core with both slots explicitly unavailable when neither exists and surfaces Core's own failure", () => {
    const verifyCanonicalPae = vi.fn(() => true);

    expect(() =>
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ verifyCanonicalPae })),
    ).toThrow(CORE_ERROR);
    // Core reached its own diagnostic; the adapter neither shortcut it nor invented
    // material, and nothing was verified because nothing was present.
    expect(verifyCanonicalPae).not.toHaveBeenCalled();
    expect(rootEntries()).toEqual([]);
  });

  it("forwards the exact trusted Core inputs verbatim, with no environment, cwd, or wall-clock default", () => {
    seedCurrent();
    const seen: unknown[] = [];
    const verifyCanonicalPae = (request: unknown): boolean => {
      seen.push(request);
      const item = request as Record<string, unknown>;
      // Trust facts arrive exactly as supplied; the adapter substitutes none of its own.
      expect(item.expectedAdminSignerIdentity).toBe(identity);
      expect(item.expectedAdminSignerRootSha256).toBe(adminRoot);
      expect(Buffer.isBuffer(item.paeBytes)).toBe(true);
      return true;
    };

    const result = resolveOperationalDeveloperSeatCatalogV1(
      operationalInput({ verifyCanonicalPae }),
    ) as { resolvedAt: string };
    expect(seen).toHaveLength(1);
    expect(result.resolvedAt).toBe("2026-08-17T12:00:00Z");

    // That resolution came from current, so custody promoted it. Every rejection
    // below must leave that promoted state exactly as it stands.
    const promoted = readFileSync(lastGoodPath());
    expect(promoted.equals(readFileSync(currentPath()))).toBe(true);

    // A mismatched or malformed trusted fact is a delegated rejection, reached unchanged.
    for (const override of [
      { expectedAdminSignerRootSha256: sha("other admin root") },
      { expectedHeadSignerRootSha256: sha("other head root") },
      { expectedAdminSignerIdentity: "signer:someone-else" },
      { expectedSchemaVersion: "  " },
      { maxAgeSeconds: 59 },
      { now: "2026-08-17T12:00:00" },
    ])
      expectDelegatedFailure(() =>
        resolveOperationalDeveloperSeatCatalogV1(operationalInput(override)),
      );
    expect(readFileSync(lastGoodPath()).equals(promoted)).toBe(true);
    expect(rootEntries()).toEqual([CURRENT_SLOT, LAST_GOOD_SLOT]);
  });

  it("delegates rollback, equal-sequence replay, and expiry entirely to Core and never promotes on a delegated failure", () => {
    // Rollback: current older than last-good is fatal in Core, and nothing is written.
    const prior = seedLastGood(distributionBytes({ sequence: 43 }));
    seedCurrent(distributionBytes({ sequence: 42 }));
    expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(CORE_ERROR);
    expect(readFileSync(lastGoodPath()).equals(prior)).toBe(true);

    // Equal-sequence identical replay is idempotent and still promotes the exact bytes.
    const replay = distributionBytes({ sequence: 42 });
    seedLastGood(replay);
    seedCurrent(replay);
    const idempotent = resolveOperationalDeveloperSeatCatalogV1(operationalInput()) as {
      sequence: number;
      source: string;
    };
    expect(idempotent.source).toBe("current");
    expect(idempotent.sequence).toBe(42);
    expect(readFileSync(lastGoodPath()).equals(replay)).toBe(true);

    // Equal sequence with a conflicting digest is a Core continuity failure.
    seedCurrent(distributionBytes({ catalogSha256: sha("conflicting catalog"), sequence: 42 }));
    expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(CORE_ERROR);
    expect(readFileSync(lastGoodPath()).equals(replay)).toBe(true);

    // Expiry and future dating are Core's bounded-age semantics, not the adapter's.
    rmSync(lastGoodPath(), { force: true });
    seedCurrent(distributionBytes({ resolvedAt: "2026-08-17T10:00:00Z" }));
    expect(() =>
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ maxAgeSeconds: 60 })),
    ).toThrow(CORE_ERROR);
    seedCurrent(distributionBytes({ resolvedAt: "2026-08-17T13:00:00Z" }));
    expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(CORE_ERROR);
    expect(existsSync(lastGoodPath())).toBe(false);
  });

  it("rejects padded, relative, unnormalized, NUL-bearing, and control-bearing roots before touching the filesystem", () => {
    seedCurrent();
    const verifyCanonicalPae = vi.fn(() => true);
    for (const hostileRoot of [
      "",
      "   ",
      ` ${seatRoot}`,
      `${seatRoot} `,
      `${seatRoot}\t`,
      `${seatRoot}\n`,
      "relative/seat-root",
      "./seat",
      // Literally unnormalized. Concatenated on purpose: `join` collapses the
      // `..` and hands back a perfectly valid root, which would resolve, not throw.
      `${seatRoot}${sep}..${sep}${basename(seatRoot)}`,
      `${seatRoot}${sep}.`,
      // Escaped, not raw. A literal control byte in this file does not survive
      // formatting, and a silently mangled fixture stops testing anything.
      `${seatRoot}\u0000`,
      `${seatRoot}\u0001`,
      `${seatRoot}\u001f`,
      `${seatRoot}\u007f`,
      42,
      null,
      undefined,
      Buffer.from(seatRoot, "utf8"),
      [seatRoot],
    ])
      expect(
        () =>
          resolveOperationalDeveloperSeatCatalogV1(
            operationalInput({ seatRoot: hostileRoot, verifyCanonicalPae }),
          ),
        JSON.stringify(hostileRoot),
      ).toThrow(ADAPTER_ERROR);
    expect(verifyCanonicalPae).not.toHaveBeenCalled();
    expect(rootEntries()).toEqual([CURRENT_SLOT]);
  });

  it("rejects a root that is missing, a regular file, or otherwise not a directory", () => {
    const missing = join(workspace, "absent-root");
    expect(() =>
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ seatRoot: missing })),
    ).toThrow(ADAPTER_ERROR);
    expect(existsSync(missing)).toBe(false);

    const fileRoot = join(workspace, "file-root");
    writeFileSync(fileRoot, distributionBytes());
    expect(() =>
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ seatRoot: fileRoot })),
    ).toThrow(ADAPTER_ERROR);
  });

  it("refuses a symlinked or junctioned authority root instead of following it to an outside directory", () => {
    const outside = join(workspace, "outside-root");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, CURRENT_SLOT), distributionBytes());
    const linked = join(workspace, "linked-root");
    try {
      symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // unprivileged Windows sessions cannot create directory links
    }

    expect(() =>
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ seatRoot: linked })),
    ).toThrow(ADAPTER_ERROR);
    // The link target was neither read nor promoted into.
    expect(readdirSync(outside)).toEqual([CURRENT_SLOT]);
  });

  it("refuses a symlinked slot rather than laundering the link target's bytes", () => {
    const outside = join(workspace, "outside-current.json");
    writeFileSync(outside, distributionBytes());
    try {
      symlinkSync(outside, currentPath(), "file");
    } catch {
      return; // unprivileged Windows sessions cannot create file links
    }

    expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(
      ADAPTER_ERROR,
    );
    expect(existsSync(lastGoodPath())).toBe(false);

    // The same refusal applies to a linked last-good, even with a clean current.
    rmSync(currentPath(), { force: true });
    seedCurrent();
    const outsidePrior = join(workspace, "outside-last-good.json");
    const priorBytes = distributionBytes({ sequence: 41 });
    writeFileSync(outsidePrior, priorBytes);
    symlinkSync(outsidePrior, lastGoodPath(), "file");
    expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(
      ADAPTER_ERROR,
    );
    expect(readFileSync(outsidePrior).equals(priorBytes)).toBe(true);
  });

  it("refuses a directory or FIFO slot rather than treating it as transported material", () => {
    mkdirSync(currentPath(), { recursive: true });
    expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(
      ADAPTER_ERROR,
    );
    rmSync(currentPath(), { force: true, recursive: true });

    seedCurrent();
    mkdirSync(lastGoodPath(), { recursive: true });
    expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(
      ADAPTER_ERROR,
    );
    rmSync(lastGoodPath(), { force: true, recursive: true });

    if (process.platform === "win32") return; // no FIFO or device node to bind here
    rmSync(currentPath(), { force: true });
    try {
      execFileSync("mkfifo", [currentPath()]);
    } catch {
      return; // mkfifo unavailable on this runner
    }
    expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(
      ADAPTER_ERROR,
    );
  });

  it("refuses a hard-linked slot so material cannot be aliased into or out of the authority root", () => {
    const outside = join(workspace, "outside-hardlink.json");
    writeFileSync(outside, distributionBytes());
    try {
      linkSync(outside, currentPath());
    } catch {
      return; // filesystem does not support hard links
    }
    if (lstatSync(currentPath()).nlink <= 1) return; // link count not reported here

    expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(
      ADAPTER_ERROR,
    );
    expect(existsSync(lastGoodPath())).toBe(false);
  });

  it("refuses an empty slot and enforces the exact 96 KiB ceiling before Core ever parses", () => {
    writeFileSync(currentPath(), Buffer.alloc(0));
    expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(
      ADAPTER_ERROR,
    );

    writeFileSync(currentPath(), Buffer.alloc(MAX_TRANSPORT_BYTES + 1, 0x61));
    expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(
      ADAPTER_ERROR,
    );

    // Exactly at the ceiling custody admits the bytes; only the shipped codec rejects them.
    writeFileSync(currentPath(), Buffer.alloc(MAX_TRANSPORT_BYTES, 0x61));
    expectDelegatedFailure(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput()));
    expect(existsSync(lastGoodPath())).toBe(false);

    // The same ceiling and emptiness rule bind last-good.
    seedCurrent();
    writeFileSync(lastGoodPath(), Buffer.alloc(MAX_TRANSPORT_BYTES + 1, 0x61));
    expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(
      ADAPTER_ERROR,
    );
    writeFileSync(lastGoodPath(), Buffer.alloc(0));
    expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(
      ADAPTER_ERROR,
    );
  });

  it("refuses an unreadable slot instead of degrading it to unavailable", () => {
    if (process.platform === "win32") return; // POSIX mode bits do not gate reads here
    seedCurrent();
    chmodSync(currentPath(), 0o000);
    let denied = false;
    try {
      readFileSync(currentPath());
    } catch {
      denied = true;
    }
    try {
      if (!denied) return; // a privileged runner is not denied by mode bits
      expect(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput())).toThrow(
        ADAPTER_ERROR,
      );
      expect(existsSync(lastGoodPath())).toBe(false);
    } finally {
      chmodSync(currentPath(), 0o600);
    }
  });

  it("reads exact bytes with no UTF-8, BOM, or newline normalization", () => {
    const canonical = distributionBytes();

    // A trailing newline is not trimmed off on the way in, so the shipped codec
    // sees noncanonical bytes and rejects them.
    for (const suffix of ["\n", "\r\n"]) {
      writeFileSync(currentPath(), Buffer.concat([canonical, Buffer.from(suffix, "utf8")]));
      expectDelegatedFailure(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput()));
      expect(existsSync(lastGoodPath())).toBe(false);
    }

    // A BOM is a different transport representation, not canonical bytes.
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]);
    writeFileSync(currentPath(), withBom);
    expectDelegatedFailure(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput()));
    expect(readFileSync(currentPath()).equals(withBom)).toBe(true);
    expect(existsSync(lastGoodPath())).toBe(false);
    rmSync(lastGoodPath(), { force: true });

    // The byte-exact canonical form resolves and is promoted byte-for-byte.
    seedCurrent(canonical);
    expect(
      (resolveOperationalDeveloperSeatCatalogV1(operationalInput()) as { kind: string }).kind,
    ).toBe("resolved");
    expect(readFileSync(lastGoodPath()).equals(canonical)).toBe(true);
    expect(readFileSync(lastGoodPath()).length).toBe(canonical.length);
  });

  it("does not promote when current is replaced with different bytes while the verifier runs", () => {
    const original = seedCurrent();
    const racer = distributionBytes({ sequence: 43 });
    const verifyCanonicalPae = (): boolean => {
      writeFileSync(currentPath(), racer);
      return true;
    };

    expectAdapterFailure(() =>
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ verifyCanonicalPae })),
    );
    expect(readFileSync(currentPath()).equals(racer)).toBe(true);
    expect(readFileSync(currentPath()).equals(original)).toBe(false);
    expect(existsSync(lastGoodPath())).toBe(false);
    expect(rootEntries()).toEqual([CURRENT_SLOT]);
  });

  it("does not promote when current is removed while the verifier runs", () => {
    seedCurrent();
    const verifyCanonicalPae = (): boolean => {
      rmSync(currentPath(), { force: true });
      return true;
    };

    expectAdapterFailure(() =>
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ verifyCanonicalPae })),
    );
    expect(existsSync(lastGoodPath())).toBe(false);
    expect(rootEntries()).toEqual([]);
  });

  it("does not promote when a concurrent writer creates or replaces last-good while the verifier runs", () => {
    seedCurrent();
    const newer = distributionBytes({ sequence: 43 });
    let calls = 0;
    const appearing = (): boolean => {
      calls += 1;
      writeFileSync(lastGoodPath(), newer);
      return true;
    };

    expectAdapterFailure(() =>
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ verifyCanonicalPae: appearing })),
    );
    expect(calls).toBe(1);
    // A last-good that appeared after the snapshot is newer state, not ours to clobber.
    expect(readFileSync(lastGoodPath()).equals(newer)).toBe(true);

    // The same holds when last-good existed and was then replaced mid-verification.
    const prior = seedLastGood(distributionBytes({ sequence: 41 }));
    const replacement = distributionBytes({ sequence: 43 });
    const replacing = (): boolean => {
      writeFileSync(lastGoodPath(), replacement);
      return true;
    };
    expectAdapterFailure(() =>
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ verifyCanonicalPae: replacing })),
    );
    expect(readFileSync(lastGoodPath()).equals(replacement)).toBe(true);
    expect(readFileSync(lastGoodPath()).equals(prior)).toBe(false);
    expect(rootEntries()).toEqual([CURRENT_SLOT, LAST_GOOD_SLOT]);
  });

  it("does not promote when the authority root itself is replaced while the verifier runs", () => {
    seedCurrent();
    const moved = join(workspace, "moved-root");
    const verifyCanonicalPae = (): boolean => {
      renameSync(seatRoot, moved);
      mkdirSync(seatRoot, { recursive: true });
      return true;
    };

    expectAdapterFailure(() =>
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ verifyCanonicalPae })),
    );
    expect(rootEntries()).toEqual([]);
    expect(existsSync(lastGoodPath())).toBe(false);
    expect(readdirSync(moved).sort()).toEqual([CURRENT_SLOT]);
  });

  it("fails promotion closed against a held lock and never breaks or steals it", () => {
    const bytes = seedCurrent();
    writeFileSync(lockPath(), Buffer.from("held-by-another-writer", "utf8"), { flag: "wx" });
    const holder = readFileSync(lockPath());

    expectAdapterFailure(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput()));
    expect(existsSync(lastGoodPath())).toBe(false);
    // The foreign lock survives byte-for-byte: a stale lock is never broken.
    expect(existsSync(lockPath())).toBe(true);
    expect(readFileSync(lockPath()).equals(holder)).toBe(true);
    expect(readFileSync(currentPath()).equals(bytes)).toBe(true);
    expect(rootEntries()).toEqual([LOCK_SLOT, CURRENT_SLOT].sort());

    // Once the holder releases, the very same call promotes.
    rmSync(lockPath(), { force: true });
    resolveOperationalDeveloperSeatCatalogV1(operationalInput());
    expect(readFileSync(lastGoodPath()).equals(bytes)).toBe(true);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("preserves a concurrent last-good installation instead of clobbering it during publication", () => {
    const current = seedCurrent();
    const concurrent = distributionBytes({ sequence: 43 });
    let installed = false;
    fsHooks.beforeLink = (_from, to) => {
      if (to !== lastGoodPath() || installed) return;
      writeFileSync(lastGoodPath(), concurrent, { flag: "wx" });
      installed = true;
    };

    try {
      expectAdapterFailure(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput()));
    } finally {
      resetFsHooks();
    }

    expect(installed).toBe(true);
    expect(readFileSync(currentPath()).equals(current)).toBe(true);
    expect(readFileSync(lastGoodPath()).equals(concurrent)).toBe(true);
    expect(rootEntries()).toEqual([CURRENT_SLOT, LAST_GOOD_SLOT]);
  });

  it("preserves a concurrent replacement of an existing last-good and retires the displaced prior", () => {
    const current = seedCurrent();
    const prior = seedLastGood(distributionBytes({ sequence: 41 }));
    const concurrent = distributionBytes({ sequence: 43 });
    let replaced = false;
    fsHooks.afterRename = (from) => {
      if (from !== lastGoodPath() || replaced) return;
      writeFileSync(lastGoodPath(), concurrent, { flag: "wx" });
      replaced = true;
    };

    try {
      expectAdapterFailure(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput()));
    } finally {
      resetFsHooks();
    }

    expect(replaced).toBe(true);
    expect(readFileSync(currentPath()).equals(current)).toBe(true);
    expect(readFileSync(lastGoodPath()).equals(concurrent)).toBe(true);
    expect(readFileSync(lastGoodPath()).equals(prior)).toBe(false);
    expect(rootEntries()).toEqual([CURRENT_SLOT, LAST_GOOD_SLOT]);
  });

  it("restores a fixed target replaced before target-to-displaced retirement", () => {
    const current = seedCurrent();
    seedLastGood(distributionBytes({ sequence: 41 }));
    const foreign = distributionBytes({ sequence: 43 });
    const outside = join(workspace, "pre-rename-last-good.json");
    writeFileSync(outside, foreign);
    let replaced = false;
    fsHooks.beforeRename = (from) => {
      if (from !== lastGoodPath() || replaced) return;
      renameSync(outside, lastGoodPath());
      replaced = true;
    };

    try {
      expectAdapterFailure(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput()));
    } finally {
      resetFsHooks();
    }

    expect(replaced).toBe(true);
    expect(readFileSync(currentPath()).equals(current)).toBe(true);
    expect(readFileSync(lastGoodPath()).equals(foreign)).toBe(true);
    expect(rootEntries()).toEqual([CURRENT_SLOT, LAST_GOOD_SLOT]);
  });

  it("never deletes a replacement lock and durably records owned-lock removal before success", () => {
    const current = seedCurrent();
    const foreignLock = Buffer.from("foreign replacement lock", "utf8");
    let replacementInstalled = false;
    fsHooks.afterRename = (from) => {
      if (from !== lockPath() || replacementInstalled) return;
      writeFileSync(lockPath(), foreignLock, { flag: "wx" });
      replacementInstalled = true;
    };

    try {
      expectAdapterFailure(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput()));
    } finally {
      resetFsHooks();
    }

    expect(replacementInstalled).toBe(true);
    expect(readFileSync(currentPath()).equals(current)).toBe(true);
    expect(readFileSync(lockPath()).equals(foreignLock)).toBe(true);
    expect(existsSync(lastGoodPath())).toBe(true);

    rmSync(lockPath(), { force: true });
    let retiredLockPath: string | undefined;
    let ownedLockRemoved = false;
    let directoryFsyncAfterRemoval = 0;
    fsHooks.afterRename = (from, to) => {
      if (from === lockPath()) retiredLockPath = to;
    };
    fsHooks.afterRemove = (path) => {
      if (path === retiredLockPath) ownedLockRemoved = true;
    };
    fsHooks.afterFsync = (fd) => {
      if (ownedLockRemoved && fstatSync(fd).isDirectory()) directoryFsyncAfterRemoval += 1;
    };
    try {
      const result = resolveOperationalDeveloperSeatCatalogV1(operationalInput());
      expect(result.kind).toBe("resolved");
    } finally {
      resetFsHooks();
    }
    expect(ownedLockRemoved).toBe(true);
    if (process.platform !== "win32") expect(directoryFsyncAfterRemoval).toBeGreaterThan(0);
  });

  it("restores a fixed lock replaced before lock-to-tombstone retirement", () => {
    const current = seedCurrent();
    const foreignLock = Buffer.from("foreign pre-rename lock", "utf8");
    const outside = join(workspace, "pre-rename-lock");
    writeFileSync(outside, foreignLock);
    let replaced = false;
    fsHooks.beforeRename = (from) => {
      if (from !== lockPath() || replaced) return;
      renameSync(outside, lockPath());
      replaced = true;
    };

    try {
      expectAdapterFailure(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput()));
    } finally {
      resetFsHooks();
    }

    expect(replaced).toBe(true);
    expect(readFileSync(currentPath()).equals(current)).toBe(true);
    expect(readFileSync(lockPath()).equals(foreignLock)).toBe(true);
    expect(existsSync(lastGoodPath())).toBe(true);
    expect(rootEntries()).toEqual([CURRENT_SLOT, LAST_GOOD_SLOT, LOCK_SLOT].sort());
  });

  it("leaves no scratch file or lock behind on successful promotion and fails closed on custody failure", () => {
    // Aborted by a held lock.
    seedCurrent();
    writeFileSync(lockPath(), Buffer.alloc(0), { flag: "wx" });
    expectAdapterFailure(() => resolveOperationalDeveloperSeatCatalogV1(operationalInput()));
    expect(rootEntries().filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    rmSync(lockPath(), { force: true });

    // Aborted by a mid-verification race.
    const racing = (): boolean => {
      writeFileSync(currentPath(), distributionBytes({ sequence: 43 }));
      return true;
    };
    expectAdapterFailure(() =>
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ verifyCanonicalPae: racing })),
    );
    expect(rootEntries()).toEqual([CURRENT_SLOT]);

    // Completed promotion.
    const bytes = seedCurrent();
    resolveOperationalDeveloperSeatCatalogV1(operationalInput());
    expect(rootEntries()).toEqual([CURRENT_SLOT, LAST_GOOD_SLOT]);
    expect(readFileSync(lastGoodPath()).equals(bytes)).toBe(true);
  });

  it("fails closed when the verified current cannot be durably promoted", () => {
    if (process.platform === "win32") return;
    const current = seedCurrent();
    let denied = false;
    const verifyCanonicalPae = (): boolean => {
      chmodSync(seatRoot, 0o500);
      try {
        writeFileSync(join(seatRoot, ".permission-probe"), Buffer.alloc(0), { flag: "wx" });
      } catch {
        denied = true;
      }
      return true;
    };
    try {
      let message: string | undefined;
      try {
        resolveOperationalDeveloperSeatCatalogV1(operationalInput({ verifyCanonicalPae }));
      } catch (error) {
        message = (error as Error).message;
      }
      if (!denied) return; // A privileged runner cannot exercise this POSIX permission boundary.
      expect(message).toMatch(ADAPTER_ERROR);
      expect(message ?? "").not.toContain(workspace);
      expect(readFileSync(currentPath()).equals(current)).toBe(true);
      expect(existsSync(lastGoodPath())).toBe(false);
    } finally {
      chmodSync(seatRoot, 0o700);
    }
  });

  it("writes the promoted slot as an owner-only regular file, never a link or a shared-mode file", () => {
    seedCurrent();
    resolveOperationalDeveloperSeatCatalogV1(operationalInput());

    const promoted = lstatSync(lastGoodPath());
    expect(promoted.isFile()).toBe(true);
    expect(promoted.isSymbolicLink()).toBe(false);
    expect(promoted.nlink).toBe(1);
    if (process.platform !== "win32") expect(statSync(lastGoodPath()).mode & 0o777).toBe(0o600);
  });

  it("is repeatable: a second resolution over promoted state stays stable and idempotent", () => {
    const bytes = seedCurrent();
    const first = resolveOperationalDeveloperSeatCatalogV1(operationalInput()) as {
      sequence: number;
      source: string;
    };
    const second = resolveOperationalDeveloperSeatCatalogV1(operationalInput()) as {
      sequence: number;
      source: string;
    };

    expect(first.source).toBe("current");
    expect(second.source).toBe("current");
    expect(second.sequence).toBe(first.sequence);
    expect(readFileSync(lastGoodPath()).equals(bytes)).toBe(true);
    expect(readFileSync(currentPath()).equals(bytes)).toBe(true);
    expect(rootEntries()).toEqual([CURRENT_SLOT, LAST_GOOD_SLOT]);
  });

  it("returns a deeply frozen result that cannot be mutated after custody completes", () => {
    seedCurrent();
    const result = resolveOperationalDeveloperSeatCatalogV1(
      operationalInput(),
    ) as unknown as Record<string, unknown>;

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.binding)).toBe(true);
    expect(Object.isFrozen((result.binding as { members: unknown[] }).members)).toBe(true);
    expect(
      Object.getOwnPropertyNames(result).every((key) => typeof result[key] !== "function"),
    ).toBe(true);
    expect(() => {
      (result as { sequence: number }).sequence = 1;
    }).toThrow();
    expect(() => {
      delete (result as { kind?: unknown }).kind;
    }).toThrow();
  });

  it("rejects a non-closed caller input: extra keys, missing keys, wrong prototype, and inherited fields", () => {
    seedCurrent();
    const base = operationalInput();

    for (const hostile of [
      { ...base, extra: "not allowed" },
      { ...base, adminRoot: seatRoot },
      { ...base, current: distributionBytes() },
      { ...base, lastGood: { kind: "unavailable" } },
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== "now")),
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== "seatRoot")),
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== "verifyCanonicalPae")),
      Object.assign(Object.create({ inherited: true }), base),
      Object.assign(new Map(), base),
      [base],
      "seat",
      42,
      null,
      undefined,
    ])
      expect(() => resolveOperationalDeveloperSeatCatalogV1(hostile)).toThrow(ADAPTER_ERROR);
    expect(rootEntries()).toEqual([CURRENT_SLOT]);
  });

  it("rejects accessor and non-data properties without ever invoking a getter, and performs no filesystem effect", () => {
    seedCurrent();
    let rootGetterCalls = 0;
    const withRootGetter = Object.defineProperties(
      { ...operationalInput() },
      {
        seatRoot: {
          configurable: true,
          enumerable: true,
          get: () => {
            rootGetterCalls += 1;
            return seatRoot;
          },
        },
      },
    );
    expect(() => resolveOperationalDeveloperSeatCatalogV1(withRootGetter)).toThrow(ADAPTER_ERROR);
    expect(rootGetterCalls).toBe(0);

    let nowGetterCalls = 0;
    const withNowGetter = Object.defineProperties(
      { ...operationalInput() },
      {
        now: {
          configurable: true,
          enumerable: true,
          get: () => {
            nowGetterCalls += 1;
            return "2026-08-17T12:00:00Z";
          },
        },
      },
    );
    expect(() => resolveOperationalDeveloperSeatCatalogV1(withNowGetter)).toThrow(ADAPTER_ERROR);
    expect(nowGetterCalls).toBe(0);

    const withSymbol = { ...operationalInput(), [Symbol("hidden")]: true };
    expect(() => resolveOperationalDeveloperSeatCatalogV1(withSymbol)).toThrow(ADAPTER_ERROR);

    expect(rootEntries()).toEqual([CURRENT_SLOT]);
  });

  it("rejects transparent and hostile proxies at every boundary, running zero traps and causing zero effects", () => {
    seedCurrent();

    const transparentInput = new Proxy(operationalInput(), {});
    const transparentVerifier = new Proxy(() => true, {});
    for (const value of [
      transparentInput,
      operationalInput({ verifyCanonicalPae: transparentVerifier }),
    ])
      expect(() => resolveOperationalDeveloperSeatCatalogV1(value)).toThrow(ADAPTER_ERROR);

    const hostileProxy = <T extends object>(
      target: T,
    ): { readonly proxy: T; traps: () => number } => {
      let trapCalls = 0;
      const proxy = new Proxy(target, {
        apply() {
          trapCalls += 1;
          throw new Error("unexpected apply trap");
        },
        get() {
          trapCalls += 1;
          throw new Error("unexpected get trap");
        },
        getPrototypeOf() {
          trapCalls += 1;
          throw new Error("unexpected prototype trap");
        },
        ownKeys() {
          trapCalls += 1;
          throw new Error("unexpected ownKeys trap");
        },
      });
      return { proxy, traps: () => trapCalls };
    };

    const hostileInput = hostileProxy(operationalInput());
    expect(() => resolveOperationalDeveloperSeatCatalogV1(hostileInput.proxy)).toThrow(
      ADAPTER_ERROR,
    );
    expect(hostileInput.traps()).toBe(0);

    const hostileVerifier = hostileProxy(() => true);
    expect(() =>
      resolveOperationalDeveloperSeatCatalogV1(
        operationalInput({ verifyCanonicalPae: hostileVerifier.proxy }),
      ),
    ).toThrow(ADAPTER_ERROR);
    expect(hostileVerifier.traps()).toBe(0);

    const hostileRoot = hostileProxy({ toString: () => seatRoot });
    expect(() =>
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ seatRoot: hostileRoot.proxy })),
    ).toThrow(ADAPTER_ERROR);
    expect(hostileRoot.traps()).toBe(0);

    // Not one hostile call read, wrote, locked, or promoted anything.
    expect(rootEntries()).toEqual([CURRENT_SLOT]);
  });

  it("rejects a non-function verifier before any slot is read", () => {
    seedCurrent();
    for (const verifyCanonicalPae of [undefined, null, "verify", 1, {}, []])
      expect(() =>
        resolveOperationalDeveloperSeatCatalogV1(operationalInput({ verifyCanonicalPae })),
      ).toThrow(ADAPTER_ERROR);
    expect(rootEntries()).toEqual([CURRENT_SLOT]);
  });

  it("treats a verifier exception as fatal, mutating nothing on disk", () => {
    seedCurrent();
    const verifyCanonicalPae = (): boolean => {
      throw new Error("verifier blew up with s3cr3t material");
    };

    let message = "";
    try {
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ verifyCanonicalPae }));
      throw new Error("expected the verifier exception to be fatal");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(CORE_ERROR);
    expect(message).not.toContain("s3cr3t");
    expect(message).not.toContain(seatRoot);
    expect(existsSync(lastGoodPath())).toBe(false);
    expect(rootEntries()).toEqual([CURRENT_SLOT]);
  });

  it("never leaks a filesystem path, root, or slot name into an adapter diagnostic", () => {
    const secretRoot = join(workspace, "s3cr3t-seat-root");
    mkdirSync(secretRoot, { recursive: true });
    writeFileSync(join(secretRoot, CURRENT_SLOT), Buffer.alloc(0));

    let message = "";
    try {
      resolveOperationalDeveloperSeatCatalogV1(operationalInput({ seatRoot: secretRoot }));
      throw new Error("expected an empty slot to be fatal");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(ADAPTER_ERROR);
    expect(message).not.toContain(secretRoot);
    expect(message).not.toContain("s3cr3t");
    expect(message).not.toContain(workspace);
  });

  it("stays an internal custody adapter: no network, process, provider, scanner, signer, CLI, Workbench, or public export", () => {
    const source = resolve("src/org-policy/developer-seat-catalog-operations-v1.ts");
    expect(existsSync(source)).toBe(true);
    const text = readFileSync(source, "utf8");

    expect(text).not.toMatch(
      /node:(child_process|https|http|net|tls|dgram|worker_threads|vm)|\b(fetch|spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/,
    );
    expect(text).not.toMatch(
      /from\s+["'][^"']*(?:admin-catalog-operations-v1|\/commands\/|\/cli|trust\/scan|guardrails\/|workspace\/|capability\/index|internals\/proc|live\/runner)[^"']*["']/,
    );
    expect(text).not.toMatch(
      /signCanonicalPae|Workbench|policyGenerate|runtime-policy|acknowledg/i,
    );
    expect(text).not.toMatch(/process\.(env|cwd|argv)/);

    // A direct consumer of the shipped pure foundation, reimplementing none of it.
    expect(text).toMatch(/from\s+["']\.\/developer-seat-catalog-consumption-v1\.js["']/);
    expect(text).toMatch(/resolveDeveloperSeatCatalogConsumptionV1\s*\(/);
    expect(text).not.toMatch(
      /from\s+["']\.\/(catalog-binding-v1|admin-distribution-v1|catalog-resolution-v1)\.js["']/,
    );
    expect(text).not.toMatch(
      /parseAdminSeatDistributionV1Json|verifyAdminSeatDistributionV1|compatibleSchemaVersion|compatibleEffectVersion|\.binding\b/,
    );

    for (const surface of ["src/index.ts", "src/commands/index.ts"])
      expect(readFileSync(resolve(surface), "utf8")).not.toContain(
        "developer-seat-catalog-operations",
      );
    // The admin operational route must not gain a seat dependency either.
    expect(
      readFileSync(resolve("src/org-policy/admin-catalog-operations-v1.ts"), "utf8"),
    ).not.toContain("developer-seat-catalog");
  });
});
