import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adaptSkillPackageGraph } from "../../src/capability/package-graph/adapters/skills.js";
import { buildPackageGraphIndex } from "../../src/capability/package-graph/build.js";
import { CAPABILITY_PACKAGE_INTENT_PATH } from "../../src/capability/package-manager/intent.js";
import { planCapabilityPackageOwnedFiles } from "../../src/capability/package-manager/owned-files.js";
import {
  CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
  parseCapabilityPackageOwnershipReceipt,
  serializeCapabilityPackageOwnershipReceipt,
} from "../../src/capability/package-manager/receipt.js";

const SHA = "a".repeat(40);
const RECEIPT_PATH = CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH;
let root: string;

function json(value: unknown, spacing?: number): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, spacing)}\n`, "utf8");
}

function skill(name: string) {
  return {
    name,
    source: `owner/repo@${SHA}`,
    commit: SHA,
    verdict: "GREEN",
    scope: "repo",
    card: `ai-coding/skill-cards/${name}.json`,
    evidenceSha256: (name === "alpha" ? "a" : "b").repeat(64),
    approvedBy: "docs-platform",
    approvedAt: "2026-08-09T00:00:00.000Z",
  };
}

function fixture(names = ["alpha"]) {
  const adapted = adaptSkillPackageGraph({
    lockAuthorityId: "lock:aih-skills",
    catalogAuthorityId: "catalog:aih-packs",
    hostSource: { provider: "github", repository: "host/project" },
    lockBytes: json({ schemaVersion: 1, skills: names.map(skill) }),
    packsBytes: json({
      schemaVersion: 1,
      packs: names.map((name) => ({
        name,
        skills: [{ name, source: `owner/repo@${SHA}`, commit: SHA }],
      })),
    }),
  });
  const index = buildPackageGraphIndex(adapted.documents);
  const authority = index.authorities.find(({ kind }) => kind === "catalog");
  if (authority === undefined) throw new Error("expected catalog fixture");
  const packages = index.claims.flatMap((claim) => {
    if (claim.entityKind !== "package" || claim.authorityId !== authority.id) return [];
    return [
      {
        kind: "package" as const,
        id: claim.id,
        authorityId: claim.authorityId,
        claimDigest: claim.claimDigest,
        sourceDigest: claim.entity.sourceDigest,
        dependencies: [],
        members: claim.entity.members,
      },
    ];
  });
  return {
    intentBytes: json({
      schemaVersion: 1,
      authorities: [authority],
      roots: packages.map(({ id }) => id),
      packages,
    }),
    index,
    diagnostics: adapted.diagnostics,
  };
}

function request(names = ["alpha"], overrides: Record<string, unknown> = {}) {
  return {
    root,
    lifecycleInput: { ...fixture(names), ...overrides },
  };
}

function put(path: string, bytes: Buffer, mode: number): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes, { mode });
  chmodSync(absolute, mode);
}

function bytesAt(path: string): Buffer {
  return readFileSync(join(root, path));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-package-owned-files-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function materialize(plan: ReturnType<typeof planCapabilityPackageOwnedFiles>): void {
  for (const step of plan.steps) {
    if (step.action === "assert") continue;
    if (step.action === "remove") rmSync(join(root, step.path), { force: true });
    else {
      if (step.contents === undefined) throw new Error("expected planned contents");
      put(step.path, Buffer.from(step.contents), step.mode);
    }
  }
}

describe("Capability Package Manager owned state planning", () => {
  it("plans add in intent-first receipt-last order and then emits zero unchanged steps", () => {
    const input = request();
    const plan = planCapabilityPackageOwnedFiles(input);
    expect(plan.lifecycle.status).toBe("ready");
    expect(plan.steps.map(({ path }) => path)).toEqual([
      CAPABILITY_PACKAGE_INTENT_PATH,
      RECEIPT_PATH,
    ]);
    expect(plan.steps.map(({ expect: expectation }) => expectation)).toEqual([
      { absent: true },
      { absent: true },
    ]);
    expect(plan.steps.every((step) => step.prior === undefined)).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.steps)).toBe(true);

    const desiredIntent = Buffer.from(plan.steps[0]?.contents ?? []);
    const desiredReceipt = Buffer.from(plan.steps[1]?.contents ?? []);
    input.lifecycleInput.intentBytes.fill(0);
    plan.steps[0]?.contents?.fill(0);
    expect(plan.steps[0]?.contents).toEqual(desiredIntent);
    expect(plan.steps[1]?.contents).toEqual(desiredReceipt);
    materialize(plan);

    const unchanged = planCapabilityPackageOwnedFiles(request());
    expect(unchanged.lifecycle.status).toBe("ready");
    expect(unchanged.steps).toEqual([]);
  });

  it("uses exact live receipt authority for updates and copies preimages and modes", () => {
    const initial = planCapabilityPackageOwnedFiles(request());
    materialize(initial);
    const originalIntent = bytesAt(CAPABILITY_PACKAGE_INTENT_PATH);
    const stale = parseCapabilityPackageOwnershipReceipt(bytesAt(RECEIPT_PATH).toString("utf8"));
    const stalePackage = stale.packages[0];
    if (stalePackage === undefined) throw new Error("expected receipt fixture");
    stalePackage.claimDigest = "b".repeat(64);
    const staleBytes = Buffer.from(serializeCapabilityPackageOwnershipReceipt(stale), "utf8");
    put(RECEIPT_PATH, staleBytes, 0o640);

    const callerForgedCurrent = initial.lifecycle.status === "ready" ? initial.lifecycle : {};
    const plan = planCapabilityPackageOwnedFiles(
      request(["alpha"], { currentReceipt: callerForgedCurrent }),
    );
    expect(plan.lifecycle).toMatchObject({
      status: "ready",
      changes: { update: ["package:skill-pack/alpha"] },
    });
    expect(plan.steps.map(({ path }) => path)).toEqual([
      CAPABILITY_PACKAGE_INTENT_PATH,
      RECEIPT_PATH,
    ]);
    expect(plan.steps[0]).toMatchObject({
      action: "assert",
      expect: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/), mode: 0o644 },
    });
    expect(plan.steps[1]?.expect).toEqual({
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      mode: 0o640,
    });
    expect(plan.steps[1]?.prior).toEqual(staleBytes);
    expect(plan.steps[1]?.prior).not.toBe(staleBytes);
    expect(plan.steps[1]?.priorMode).toBe(0o640);
    expect(bytesAt(CAPABILITY_PACKAGE_INTENT_PATH)).toEqual(originalIntent);
  });

  it("plans mode-only normalization and binds unchanged partner bytes against later drift", () => {
    const initial = planCapabilityPackageOwnedFiles(request());
    materialize(initial);
    chmodSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH), 0o600);
    const plan = planCapabilityPackageOwnedFiles(request());
    expect(plan.steps.map(({ path }) => path)).toEqual([
      CAPABILITY_PACKAGE_INTENT_PATH,
      RECEIPT_PATH,
    ]);
    expect(plan.steps[0]).toMatchObject({
      action: "write",
      mode: 0o644,
      expect: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/), mode: 0o600 },
    });
    expect(plan.steps[1]).toMatchObject({
      action: "assert",
      expect: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/), mode: 0o600 },
    });
    const pinnedIntent = structuredClone(plan.steps[0]?.expect);
    writeFileSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH), "changed after planning\n");
    expect(plan.steps[0]?.expect).toEqual(pinnedIntent);
  });

  it("plans partial removal with reduced intent first and receipt last", () => {
    const initial = planCapabilityPackageOwnedFiles(request(["alpha", "beta"]));
    materialize(initial);
    const lifecycleInput = fixture(["alpha", "beta"]);
    const plan = planCapabilityPackageOwnedFiles({
      root,
      lifecycleInput: {
        ...lifecycleInput,
        operation: "remove",
        removeRoots: ["package:skill-pack/alpha"],
        currentReceipt: { forged: true },
      },
    });
    expect(plan.steps.map(({ path }) => path)).toEqual([
      CAPABILITY_PACKAGE_INTENT_PATH,
      RECEIPT_PATH,
    ]);
    expect(plan.lifecycle).toMatchObject({
      status: "ready",
      changes: { remove: ["package:skill-pack/alpha"] },
    });
    materialize(plan);
    expect(
      parseCapabilityPackageOwnershipReceipt(bytesAt(RECEIPT_PATH).toString("utf8")).roots,
    ).toEqual(["package:skill-pack/beta"]);
  });

  it("plans final removal as receipt removal then intent removal", () => {
    materialize(planCapabilityPackageOwnedFiles(request()));
    const plan = planCapabilityPackageOwnedFiles({
      root,
      lifecycleInput: {
        ...fixture(),
        operation: "remove",
        removeRoots: ["package:skill-pack/alpha"],
        currentReceipt: { forged: true },
      },
    });
    expect(plan.lifecycle.status).toBe("ready");
    expect(plan.steps.map(({ path }) => path)).toEqual([
      RECEIPT_PATH,
      CAPABILITY_PACKAGE_INTENT_PATH,
    ]);
    expect(plan.steps.every((step) => step.action === "remove")).toBe(true);
    materialize(plan);
    expect(existsSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH))).toBe(false);
    expect(existsSync(join(root, RECEIPT_PATH))).toBe(false);
  });

  it("lets malformed live state override forged caller receipt and refuses without mutation", () => {
    const valid = planCapabilityPackageOwnedFiles(request());
    put(CAPABILITY_PACKAGE_INTENT_PATH, fixture().intentBytes, 0o644);
    put(RECEIPT_PATH, Buffer.from("{broken", "utf8"), 0o600);
    const beforeIntent = bytesAt(CAPABILITY_PACKAGE_INTENT_PATH);
    const beforeReceipt = bytesAt(RECEIPT_PATH);
    const plan = planCapabilityPackageOwnedFiles(
      request(["alpha"], { currentReceipt: valid.lifecycle }),
    );
    expect(plan.lifecycle).toMatchObject({
      status: "refused",
      refusals: [{ stage: "receipt", code: "invalid-current-receipt" }],
    });
    expect(plan.steps).toEqual([]);
    expect(bytesAt(CAPABILITY_PACKAGE_INTENT_PATH)).toEqual(beforeIntent);
    expect(bytesAt(RECEIPT_PATH)).toEqual(beforeReceipt);
  });

  it("rejects hostile input before filesystem access with fixed value-free errors", () => {
    let calls = 0;
    const hostile = {
      root: join(root, "missing"),
      lifecycleInput: request().lifecycleInput,
    };
    Object.defineProperty(hostile, "lifecycleInput", {
      enumerable: true,
      get() {
        calls += 1;
        return request().lifecycleInput;
      },
    });
    expect(() => planCapabilityPackageOwnedFiles(hostile)).toThrow(
      "capability package owned-files input is invalid",
    );
    expect(calls).toBe(0);
    expect(() => planCapabilityPackageOwnedFiles(new Proxy(request(), {}))).toThrow(
      "capability package owned-files input is invalid",
    );
    const cyclic = request();
    (cyclic.lifecycleInput as Record<string, unknown>).currentReceipt = cyclic.lifecycleInput;
    expect(() => planCapabilityPackageOwnedFiles(cyclic)).toThrow(
      "capability package owned-files input is invalid",
    );

    const oversized = request();
    oversized.lifecycleInput.intentBytes = Buffer.alloc(8 * 1024 * 1024 + 1);
    expect(() => planCapabilityPackageOwnedFiles(oversized)).toThrow(
      "capability package owned-files input is invalid",
    );
  });

  it("refuses malformed live intent with no state steps", () => {
    put(CAPABILITY_PACKAGE_INTENT_PATH, Buffer.from("{broken", "utf8"), 0o644);
    const plan = planCapabilityPackageOwnedFiles(request());
    expect(plan.lifecycle).toMatchObject({
      status: "refused",
      refusals: [{ stage: "intent", code: "invalid-intent" }],
    });
    expect(plan.steps).toEqual([]);
  });

  it("refuses unsafe intent or receipt state and never plans paths beyond the two package files", () => {
    const outside = join(root, "outside");
    writeFileSync(outside, fixture().intentBytes);
    symlinkSync(outside, join(root, CAPABILITY_PACKAGE_INTENT_PATH));
    expect(() => planCapabilityPackageOwnedFiles(request())).toThrow(
      "capability package state is unsafe",
    );
    rmSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH));
    linkSync(outside, join(root, CAPABILITY_PACKAGE_INTENT_PATH));
    expect(() => planCapabilityPackageOwnedFiles(request())).toThrow(
      "capability package state is unsafe",
    );
    rmSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH));
    mkdirSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH));
    expect(() => planCapabilityPackageOwnedFiles(request())).toThrow(
      "capability package state is unsafe",
    );
    rmSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH), { recursive: true });
    writeFileSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH), Buffer.alloc(8 * 1024 * 1024));
    truncateSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH), 8 * 1024 * 1024 + 1);
    expect(() => planCapabilityPackageOwnedFiles(request())).toThrow(
      "capability package state is unsafe",
    );

    rmSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH));
    for (const path of [RECEIPT_PATH]) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      symlinkSync(outside, absolute);
      expect(() => planCapabilityPackageOwnedFiles(request())).toThrow(
        "capability package state is unsafe",
      );
      rmSync(absolute);
      linkSync(outside, absolute);
      expect(() => planCapabilityPackageOwnedFiles(request())).toThrow(
        "capability package state is unsafe",
      );
      rmSync(absolute);
      mkdirSync(absolute);
      expect(() => planCapabilityPackageOwnedFiles(request())).toThrow(
        "capability package state is unsafe",
      );
      rmSync(absolute, { recursive: true });
      writeFileSync(absolute, Buffer.alloc(8 * 1024 * 1024));
      truncateSync(absolute, 8 * 1024 * 1024 + 1);
      expect(() => planCapabilityPackageOwnedFiles(request())).toThrow(
        "capability package state is unsafe",
      );
    }
  });
});
