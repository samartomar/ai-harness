import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adaptSkillPackageGraph } from "../../src/capability/package-graph/adapters/skills.js";
import { buildPackageGraphIndex } from "../../src/capability/package-graph/build.js";
import {
  CAPABILITY_PACKAGE_CUSTODY_RECEIPT_FORMAT,
  capabilityPackageCustodyReceiptPath,
  serializeCapabilityPackageCustodyReceipt,
} from "../../src/capability/package-manager/custody-receipt.js";
import { planSkillPackCustody } from "../../src/capability/package-manager/domains/skill-pack-custody.js";
import { CAPABILITY_PACKAGE_INTENT_PATH } from "../../src/capability/package-manager/intent.js";
import { planCapabilityPackageOwnedFiles } from "../../src/capability/package-manager/owned-files.js";
import {
  CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
  parseCapabilityPackageOwnershipReceipt,
  serializeCapabilityPackageOwnershipReceipt,
} from "../../src/capability/package-manager/receipt.js";

const SHA = "a".repeat(40);
const FILE_BYTES = Buffer.from("# Clean\n", "utf8");
let root: string;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function fixture() {
  const lockBytes = json({
    schemaVersion: 1,
    skills: [
      {
        name: "clean",
        source: `owner/repo@${SHA}`,
        commit: SHA,
        verdict: "GREEN",
        scope: "repo",
        card: "ai-coding/skill-cards/clean.json",
        evidenceSha256: "e".repeat(64),
        approvedBy: "docs-platform",
        approvedAt: "2026-08-09T00:00:00.000Z",
      },
    ],
  });
  const packsBytes = json({
    schemaVersion: 1,
    packs: [
      {
        name: "docs-quality",
        skills: [{ name: "clean", source: `owner/repo@${SHA}`, commit: SHA }],
      },
    ],
  });
  const adapted = adaptSkillPackageGraph({
    lockAuthorityId: "lock:aih-skills",
    catalogAuthorityId: "catalog:aih-packs",
    hostSource: { provider: "github", repository: "host/project" },
    lockBytes,
    packsBytes,
  });
  const index = buildPackageGraphIndex(adapted.documents);
  const authority = index.authorities.find(({ kind }) => kind === "catalog");
  const claim = index.claims.find(
    (candidate) => candidate.entityKind === "package" && candidate.authorityId === authority?.id,
  );
  if (authority === undefined || claim?.entityKind !== "package") {
    throw new Error("expected package fixture");
  }
  return {
    lifecycleInput: {
      intentBytes: json({
        schemaVersion: 1,
        authorities: [authority],
        roots: [claim.id],
        packages: [
          {
            kind: "package",
            id: claim.id,
            authorityId: claim.authorityId,
            claimDigest: claim.claimDigest,
            sourceDigest: claim.entity.sourceDigest,
            dependencies: [],
            members: claim.entity.members,
          },
        ],
      }),
      index,
      diagnostics: adapted.diagnostics,
    },
  };
}

function trustLock(): Buffer {
  return json({
    schemaVersion: 1,
    sources: [
      {
        id: "owner-repo",
        kind: "github",
        source: "owner/repo",
        ref: "main",
        pinnedSha: SHA,
        promotedAt: "2026-08-09T00:00:00.000Z",
        promotedSkills: ["clean"],
        analyzersRun: ["aih-native"],
        artifactHashes: [{ path: "skills/clean/SKILL.md", sha256: sha256(FILE_BYTES) }],
        findings: [],
      },
    ],
  });
}

function put(path: string, bytes: Buffer, mode = 0o600): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes, { mode });
}

function materializeOwnedState(): ReturnType<typeof planCapabilityPackageOwnedFiles> {
  const request = { root, ...fixture() };
  const plan = planCapabilityPackageOwnedFiles(request);
  for (const step of plan.steps) {
    if (step.action === "write" && step.contents !== undefined)
      put(step.path, step.contents, step.mode);
  }
  return plan;
}

function install(): void {
  put("ai-coding/skills/owner-repo/clean/SKILL.md", FILE_BYTES, 0o640);
  put(".aih/trust-lock.json", trustLock(), 0o600);
}

function request(overrides: Record<string, unknown> = {}) {
  return { root, contextDir: "ai-coding", ...fixture(), ...overrides };
}

function putExactCustody(owned: ReturnType<typeof planCapabilityPackageOwnedFiles>): string {
  if (owned.lifecycle.status !== "ready" || owned.lifecycle.desiredReceipt === undefined) {
    throw new Error("expected ownership receipt fixture");
  }
  const ownershipSha = sha256(Buffer.from(owned.lifecycle.desiredReceipt.serialized));
  const trustSha = sha256(trustLock());
  const path = capabilityPackageCustodyReceiptPath(ownershipSha, trustSha);
  put(
    path,
    Buffer.from(
      serializeCapabilityPackageCustodyReceipt({
        format: CAPABILITY_PACKAGE_CUSTODY_RECEIPT_FORMAT,
        schemaVersion: 1,
        ownershipReceipt: { sha256: ownershipSha },
        domainReceipt: { kind: "skill-promotion-trust-lock", sha256: trustSha },
        members: [{ id: "skill:clean", packageIds: ["package:skill-pack/docs-quality"] }],
        files: [
          {
            memberId: "skill:clean",
            path: "ai-coding/skills/owner-repo/clean/SKILL.md",
            sha256: sha256(FILE_BYTES),
            ...(process.platform === "win32" ? {} : { mode: 0o640 }),
          },
        ],
      }),
    ),
  );
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-package-custody-plan-"));
});

afterEach(() => {
  vi.doUnmock("node:process");
  vi.doUnmock("node:fs");
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

async function custodyWithReaddir(onRead: (path: string) => void) {
  vi.resetModules();
  vi.doMock("node:fs", async (importOriginal) => {
    const original = await importOriginal<typeof import("node:fs")>();
    const readdirSync = ((...args: unknown[]) => {
      onRead(String(args[0]));
      return Reflect.apply(original.readdirSync, original, args);
    }) as typeof original.readdirSync;
    return { ...original, readdirSync };
  });
  return import("../../src/capability/package-manager/domains/skill-pack-custody.js");
}

async function custodyForPlatform(platform: NodeJS.Platform) {
  vi.resetModules();
  vi.doMock("node:process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:process")>()),
    platform,
  }));
  return import("../../src/capability/package-manager/domains/skill-pack-custody.js");
}

describe("skill-pack custody planning", () => {
  it("classifies verified installed bytes as unowned when no custody receipt exists", () => {
    const owned = materializeOwnedState();
    install();
    const result = planSkillPackCustody(request());
    expect(result).toMatchObject({
      schemaVersion: 1,
      status: "unowned",
      code: "missing-custody-receipt",
    });
    if (result.status !== "unowned") throw new Error("expected unowned custody plan");
    expect(result).not.toHaveProperty("receipt");
    if (owned.lifecycle.status !== "ready" || owned.lifecycle.desiredReceipt === undefined) {
      throw new Error("expected ownership receipt fixture");
    }
    expect(result.candidate.path).toBe(
      capabilityPackageCustodyReceiptPath(
        sha256(Buffer.from(owned.lifecycle.desiredReceipt.serialized)),
        sha256(trustLock()),
      ),
    );
  });

  it("classifies missing custody before inspecting absent or unsafe member files", () => {
    materializeOwnedState();
    put(".aih/trust-lock.json", trustLock(), 0o600);
    expect(planSkillPackCustody(request())).toMatchObject({
      status: "unowned",
      code: "missing-custody-receipt",
    });

    const outside = join(root, "outside-skill.md");
    writeFileSync(outside, FILE_BYTES);
    const memberPath = join(root, "ai-coding/skills/owner-repo/clean/SKILL.md");
    mkdirSync(dirname(memberPath), { recursive: true });
    symlinkSync(outside, memberPath);
    expect(planSkillPackCustody(request())).toMatchObject({
      status: "unowned",
      code: "missing-custody-receipt",
    });
  });

  it("verifies an existing exact receipt without minting a new receipt", () => {
    const owned = materializeOwnedState();
    install();
    if (owned.lifecycle.status !== "ready" || owned.lifecycle.desiredReceipt === undefined) {
      throw new Error("expected ownership receipt fixture");
    }
    const ownershipSha = sha256(Buffer.from(owned.lifecycle.desiredReceipt.serialized));
    const trustSha = sha256(trustLock());
    const path = capabilityPackageCustodyReceiptPath(ownershipSha, trustSha);
    put(
      path,
      Buffer.from(
        serializeCapabilityPackageCustodyReceipt({
          format: CAPABILITY_PACKAGE_CUSTODY_RECEIPT_FORMAT,
          schemaVersion: 1,
          ownershipReceipt: { sha256: ownershipSha },
          domainReceipt: { kind: "skill-promotion-trust-lock", sha256: trustSha },
          members: [{ id: "skill:clean", packageIds: ["package:skill-pack/docs-quality"] }],
          files: [
            {
              memberId: "skill:clean",
              path: "ai-coding/skills/owner-repo/clean/SKILL.md",
              sha256: sha256(FILE_BYTES),
              ...(process.platform === "win32" ? {} : { mode: 0o640 }),
            },
          ],
        }),
      ),
    );

    const result = planSkillPackCustody(request());
    expect(result).toMatchObject({ status: "verified-existing", candidate: { path } });
    if (result.status !== "verified-existing") throw new Error("expected verified custody");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidate)).toBe(true);
  });

  it("never verifies orphan or stale desired custody without exact live ownership state", () => {
    const desired = planCapabilityPackageOwnedFiles({ root, ...fixture() });
    install();
    putExactCustody(desired);
    expect(planSkillPackCustody(request())).toMatchObject({
      status: "unowned",
      code: "ownership-state-pending",
    });

    for (const step of desired.steps) {
      if (step.action === "write" && step.contents !== undefined)
        put(step.path, step.contents, step.mode);
    }
    const live = parseCapabilityPackageOwnershipReceipt(
      readFileSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH), "utf8"),
    );
    const pkg = live.packages[0];
    if (pkg === undefined) throw new Error("expected package fixture");
    pkg.claimDigest = "f".repeat(64);
    put(
      CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
      Buffer.from(serializeCapabilityPackageOwnershipReceipt(live)),
      0o600,
    );
    expect(planSkillPackCustody(request())).toMatchObject({
      status: "unowned",
      code: "ownership-state-pending",
    });
  });

  it("treats ownership receipt mode drift as pending on POSIX", () => {
    if (process.platform === "win32") return;
    const owned = materializeOwnedState();
    install();
    putExactCustody(owned);
    const receiptPath = join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH);
    const bytes = readFileSync(receiptPath);
    put(CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH, bytes, 0o640);
    chmodSync(receiptPath, 0o640);
    expect(planSkillPackCustody(request())).toMatchObject({
      status: "unowned",
      code: "ownership-state-pending",
    });

    chmodSync(receiptPath, 0o600);
    chmodSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH), 0o600);
    expect(planSkillPackCustody(request())).toMatchObject({
      status: "unowned",
      code: "ownership-state-pending",
    });
  });

  it.each(["ownership", "trust", "custody"] as const)(
    "re-pins %s bytes after the final installed snapshot",
    async (target) => {
      const owned = materializeOwnedState();
      install();
      const custodyPath = putExactCustody(owned);
      let memberReads = 0;
      const dynamic = await custodyWithReaddir((path) => {
        if (!path.endsWith("owner-repo/clean")) return;
        memberReads += 1;
        if (memberReads !== 3) return;
        const changedPath =
          target === "ownership"
            ? CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH
            : target === "trust"
              ? ".aih/trust-lock.json"
              : custodyPath;
        const absolute = join(root, changedPath);
        writeFileSync(absolute, Buffer.concat([readFileSync(absolute), Buffer.from(" ")]));
      });
      expect(dynamic.planSkillPackCustody(request())).toMatchObject({
        status: "refused",
        code: "authority-state-changed",
      });
    },
  );

  it("returns not-applicable for final-root removal and no deletion authority", () => {
    materializeOwnedState();
    install();
    const value = fixture();
    const result = planSkillPackCustody({
      root,
      contextDir: "ai-coding",
      lifecycleInput: {
        ...value.lifecycleInput,
        operation: "remove",
        removeRoots: ["package:skill-pack/docs-quality"],
        currentReceipt: {},
      },
    });
    expect(result).toEqual({
      schemaVersion: 1,
      status: "not-applicable",
      code: "no-desired-custody",
    });
  });

  it("omits mode on win32 while POSIX verification requires the exact observed mode", async () => {
    const owned = materializeOwnedState();
    install();
    if (owned.lifecycle.status !== "ready" || owned.lifecycle.desiredReceipt === undefined) {
      throw new Error("expected ownership receipt fixture");
    }
    const ownershipSha = sha256(Buffer.from(owned.lifecycle.desiredReceipt.serialized));
    const trustSha = sha256(trustLock());
    const path = capabilityPackageCustodyReceiptPath(ownershipSha, trustSha);
    const withoutMode = {
      format: CAPABILITY_PACKAGE_CUSTODY_RECEIPT_FORMAT,
      schemaVersion: 1,
      ownershipReceipt: { sha256: ownershipSha },
      domainReceipt: { kind: "skill-promotion-trust-lock", sha256: trustSha },
      members: [{ id: "skill:clean", packageIds: ["package:skill-pack/docs-quality"] }],
      files: [
        {
          memberId: "skill:clean",
          path: "ai-coding/skills/owner-repo/clean/SKILL.md",
          sha256: sha256(FILE_BYTES),
        },
      ],
    };
    put(path, Buffer.from(serializeCapabilityPackageCustodyReceipt(withoutMode)));
    const windows = await custodyForPlatform("win32");
    expect(windows.planSkillPackCustody(request())).toMatchObject({ status: "verified-existing" });

    if (process.platform !== "win32") {
      vi.doUnmock("node:process");
      vi.resetModules();
      const posix = await import(
        "../../src/capability/package-manager/domains/skill-pack-custody.js"
      );
      expect(posix.planSkillPackCustody(request())).toMatchObject({
        status: "refused",
        code: "custody-mismatch",
      });
    }
  });

  it("refuses malformed or drifted receipts with fixed value-free codes", () => {
    const owned = materializeOwnedState();
    install();
    if (owned.lifecycle.status !== "ready" || owned.lifecycle.desiredReceipt === undefined) {
      throw new Error("expected ownership receipt fixture");
    }
    const ownershipSha = sha256(Buffer.from(owned.lifecycle.desiredReceipt.serialized));
    const trustSha = sha256(trustLock());
    const path = capabilityPackageCustodyReceiptPath(ownershipSha, trustSha);
    put(path, Buffer.from("not json\n"));
    expect(planSkillPackCustody(request())).toMatchObject({
      status: "refused",
      code: "invalid-custody-receipt",
    });

    rmSync(join(root, path));
    put(
      path,
      Buffer.from(
        serializeCapabilityPackageCustodyReceipt({
          format: CAPABILITY_PACKAGE_CUSTODY_RECEIPT_FORMAT,
          schemaVersion: 1,
          ownershipReceipt: { sha256: ownershipSha },
          domainReceipt: { kind: "skill-promotion-trust-lock", sha256: trustSha },
          members: [{ id: "skill:clean", packageIds: ["package:skill-pack/docs-quality"] }],
          files: [
            {
              memberId: "skill:clean",
              path: "ai-coding/skills/owner-repo/clean/SKILL.md",
              sha256: "f".repeat(64),
            },
          ],
        }),
      ),
    );
    expect(planSkillPackCustody(request())).toMatchObject({
      status: "refused",
      code: "custody-mismatch",
    });
  });

  it("refuses unsafe live trust-lock files before custody classification", () => {
    materializeOwnedState();
    install();
    const trustPath = join(root, ".aih/trust-lock.json");
    const outside = join(root, "outside-trust.json");
    writeFileSync(outside, trustLock());

    rmSync(trustPath);
    symlinkSync(outside, trustPath);
    expect(planSkillPackCustody(request())).toMatchObject({
      status: "refused",
      code: "invalid-trust-lock",
    });

    rmSync(trustPath);
    linkSync(outside, trustPath);
    expect(planSkillPackCustody(request())).toMatchObject({
      status: "refused",
      code: "invalid-trust-lock",
    });

    rmSync(trustPath);
    writeFileSync(trustPath, Buffer.from([0xff]));
    expect(planSkillPackCustody(request())).toMatchObject({
      status: "refused",
      code: "invalid-trust-lock",
    });
  });

  it("uses exact live ownership and trust-lock bytes instead of caller-forged state", () => {
    materializeOwnedState();
    install();
    const forged = fixture();
    const callerReceipt = { format: "forged" };
    const result = planSkillPackCustody({
      root,
      contextDir: "ai-coding",
      lifecycleInput: { ...forged.lifecycleInput, currentReceipt: callerReceipt },
      trustLockBytes: trustLock(),
      resolution: {},
    });
    expect(result).toMatchObject({ status: "refused", code: "invalid-input" });
    expect(readFileSync(join(root, ".aih/trust-lock.json"))).toEqual(trustLock());
  });

  it("rejects hostile input before getters or filesystem access", () => {
    let calls = 0;
    const hostile = request();
    Object.defineProperty(hostile, "root", {
      enumerable: true,
      get() {
        calls += 1;
        return root;
      },
    });
    expect(planSkillPackCustody(hostile)).toMatchObject({
      status: "refused",
      code: "invalid-input",
    });
    expect(calls).toBe(0);
  });

  it("content-addresses changed trust locks separately and never overwrites prior proof", () => {
    const owned = materializeOwnedState();
    install();
    if (owned.lifecycle.status !== "ready" || owned.lifecycle.desiredReceipt === undefined) {
      throw new Error("expected ownership receipt fixture");
    }
    const ownershipSha = sha256(Buffer.from(owned.lifecycle.desiredReceipt.serialized));
    const priorTrust = trustLock();
    const prior = capabilityPackageCustodyReceiptPath(ownershipSha, sha256(priorTrust));
    const changedTrust = Buffer.from(
      priorTrust
        .toString("utf8")
        .replace('"findings":[]', '"findings": [{"name":"note","verdict":"warn"}]'),
    );
    put(".aih/trust-lock.json", changedTrust);
    const result = planSkillPackCustody(request());
    expect(result).toMatchObject({ status: "unowned" });
    if (result.status !== "unowned") throw new Error("expected unowned custody plan");
    expect(result.candidate.path).toBe(
      capabilityPackageCustodyReceiptPath(ownershipSha, sha256(changedTrust)),
    );
    expect(result.candidate.path).not.toBe(prior);
  });
});
