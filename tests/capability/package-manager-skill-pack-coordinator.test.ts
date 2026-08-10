import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capabilityPackageCustodyReceiptPath } from "../../src/capability/package-manager/custody-receipt.js";
import { reconcileSkillPackCapabilityPackage } from "../../src/capability/package-manager/domains/skill-pack-coordinator.js";
import { CAPABILITY_PACKAGE_INTENT_PATH } from "../../src/capability/package-manager/intent.js";
import { CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH } from "../../src/capability/package-manager/receipt.js";

const SHA = "a".repeat(40);
const PACKAGE_ID = "package:skill-pack/docs-quality";
const SKILL_BYTES = Buffer.from("# Clean\n", "utf8");
const SECOND_SKILL_BYTES = Buffer.from("# Review\n", "utf8");
let root: string;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function put(path: string, value: unknown, mode = 0o600): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  writeFileSync(target, bytes, { mode });
}

function seed(): void {
  const evidencePath = ".aih/skill-reports/owner-repo-aaaaaaaa.json";
  const evidence = {
    schemaVersion: 1,
    source: `owner/repo@${SHA}`,
    pinnedSha: SHA,
    checks: [],
    analyzersRun: ["aih-native"],
    verdict: "GREEN",
    reasons: [],
  };
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  put(evidencePath, evidenceBytes);
  put("ai-coding/skill-cards/clean.json", {
    schemaVersion: 1,
    name: "clean",
    source: `owner/repo@${SHA}`,
    commit: SHA,
    license: "Apache-2.0",
    installScope: "repo",
    riskClass: "green",
    requiresMcp: false,
    requiresShell: false,
    scanEvidence: [evidencePath],
    approval: {
      verdict: "GREEN",
      approvedBy: "security",
      approvedAt: "2026-08-10T00:00:00.000Z",
    },
  });
  put("aih-org-policy.json", {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    capabilityPackages: {
      catalog: { provider: "github", repository: "host/capabilities" },
      roots: [PACKAGE_ID],
    },
  });
  put("aih-skills.lock.json", {
    schemaVersion: 1,
    skills: [
      {
        name: "clean",
        source: `owner/repo@${SHA}`,
        commit: SHA,
        verdict: "GREEN",
        scope: "repo",
        card: "ai-coding/skill-cards/clean.json",
        evidenceSha256: sha256(evidenceBytes),
        approvedBy: "security",
        approvedAt: "2026-08-10T00:00:00.000Z",
      },
    ],
  });
  put("aih-packs.json", {
    schemaVersion: 1,
    packs: [
      {
        name: "docs-quality",
        skills: [{ name: "clean", source: `owner/repo@${SHA}`, commit: SHA }],
      },
    ],
  });
  put(
    ".aih/trust-lock.json",
    {
      schemaVersion: 1,
      sources: [
        {
          id: "owner-repo",
          kind: "github",
          source: "owner/repo",
          ref: "main",
          pinnedSha: SHA,
          promotedAt: "2026-08-10T00:00:00.000Z",
          promotedSkills: ["clean"],
          analyzersRun: ["aih-native"],
          artifactHashes: [{ path: "skills/clean/SKILL.md", sha256: sha256(SKILL_BYTES) }],
          findings: [],
        },
      ],
    },
    0o600,
  );
  put("ai-coding/skills/owner-repo/clean/SKILL.md", SKILL_BYTES, 0o640);
}

function apply(operation: "add" | "update" | "remove") {
  return reconcileSkillPackCapabilityPackage({
    root,
    contextDir: "ai-coding",
    operation,
    packageId: PACKAGE_ID,
    apply: true,
  });
}

function addSecondApprovedPromotion(): void {
  const evidencePath = ".aih/skill-reports/owner-repo-bbbbbbbb.json";
  const evidence = {
    schemaVersion: 1,
    source: `owner/repo@${SHA}`,
    pinnedSha: SHA,
    checks: [],
    analyzersRun: ["aih-native"],
    verdict: "GREEN",
    reasons: [],
  };
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  put(evidencePath, evidenceBytes);
  put("ai-coding/skill-cards/review.json", {
    schemaVersion: 1,
    name: "review",
    source: `owner/repo@${SHA}`,
    commit: SHA,
    license: "Apache-2.0",
    installScope: "repo",
    riskClass: "green",
    requiresMcp: false,
    requiresShell: false,
    scanEvidence: [evidencePath],
    approval: {
      verdict: "GREEN",
      approvedBy: "security",
      approvedAt: "2026-08-10T00:00:00.000Z",
    },
  });
  const approval = JSON.parse(readFileSync(join(root, "aih-skills.lock.json"), "utf8"));
  approval.skills.push({
    name: "review",
    source: `owner/repo@${SHA}`,
    commit: SHA,
    verdict: "GREEN",
    scope: "repo",
    card: "ai-coding/skill-cards/review.json",
    evidenceSha256: sha256(evidenceBytes),
    approvedBy: "security",
    approvedAt: "2026-08-10T00:00:00.000Z",
  });
  put("aih-skills.lock.json", approval);
  const catalog = JSON.parse(readFileSync(join(root, "aih-packs.json"), "utf8"));
  catalog.packs[0].skills.push({ name: "review", source: `owner/repo@${SHA}`, commit: SHA });
  put("aih-packs.json", catalog);
  const trust = JSON.parse(readFileSync(join(root, ".aih/trust-lock.json"), "utf8"));
  trust.sources[0].promotedSkills.push("review");
  trust.sources[0].artifactHashes.push({
    path: "skills/review/SKILL.md",
    sha256: sha256(SECOND_SKILL_BYTES),
  });
  put(".aih/trust-lock.json", trust, 0o600);
  put("ai-coding/skills/owner-repo/review/SKILL.md", SECOND_SKILL_BYTES, 0o640);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-package-coordinator-"));
  seed();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("GitHub skill-pack package reconciliation", () => {
  it("publishes exact ownership and custody from the existing promotion receipt", () => {
    const result = apply("add");

    expect(result.status, JSON.stringify(result)).toBe("applied");
    expect(result).toMatchObject({ operation: "add", packageId: PACKAGE_ID });
    expect(existsSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH))).toBe(true);
    expect(existsSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH))).toBe(true);
    const ownership = readFileSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH));
    const trust = readFileSync(join(root, ".aih/trust-lock.json"));
    expect(
      existsSync(join(root, capabilityPackageCustodyReceiptPath(sha256(ownership), sha256(trust)))),
    ).toBe(true);
    expect(readFileSync(join(root, "ai-coding/skills/owner-repo/clean/SKILL.md"))).toEqual(
      SKILL_BYTES,
    );

    expect(apply("update")).toMatchObject({ status: "unchanged" });
  });

  it("updates ownership and custody after an exact approved promotion adds a member", () => {
    expect(apply("add").status).toBe("applied");
    addSecondApprovedPromotion();

    const result = apply("update");

    expect(result.status, JSON.stringify(result)).toBe("applied");
    const ownership = JSON.parse(
      readFileSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH), "utf8"),
    );
    expect(ownership.packages[0].members.map(({ id }: { id: string }) => id)).toEqual([
      "skill:clean",
      "skill:review",
    ]);
    const ownershipBytes = readFileSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH));
    const trustBytes = readFileSync(join(root, ".aih/trust-lock.json"));
    const custody = JSON.parse(
      readFileSync(
        join(root, capabilityPackageCustodyReceiptPath(sha256(ownershipBytes), sha256(trustBytes))),
        "utf8",
      ),
    );
    expect(custody.files.map(({ memberId }: { memberId: string }) => memberId)).toEqual([
      "skill:clean",
      "skill:review",
    ]);
  });

  it("rejects hostile request accessors before observing repository state", () => {
    let calls = 0;
    const hostile = Object.defineProperty({}, "root", {
      enumerable: true,
      get() {
        calls += 1;
        return root;
      },
    });

    expect(reconcileSkillPackCapabilityPackage(hostile)).toMatchObject({
      status: "refused",
      stage: "input",
      reason: "invalid-input",
    });
    expect(calls).toBe(0);
    expect(existsSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH))).toBe(false);
  });

  it("refuses without exact promoted-domain proof and advances no package state", () => {
    rmSync(join(root, ".aih/trust-lock.json"));

    expect(apply("add")).toMatchObject({ status: "refused", stage: "domain" });
    expect(existsSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH))).toBe(false);
    expect(existsSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH))).toBe(false);
  });

  it("subtracts an unchanged final member only after policy deselection", () => {
    const added = apply("add");
    expect(added.status, JSON.stringify(added)).toBe("applied");
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = [];
    put("aih-org-policy.json", policy);

    const result = apply("remove");

    expect(result).toMatchObject({ status: "applied", operation: "remove" });
    expect(existsSync(join(root, "ai-coding/skills/owner-repo/clean/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH))).toBe(false);
    expect(existsSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH))).toBe(false);
  });

  it("preserves drifted member bytes and package ownership on removal", () => {
    expect(apply("add").status).toBe("applied");
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = [];
    put("aih-org-policy.json", policy);
    put("ai-coding/skills/owner-repo/clean/SKILL.md", Buffer.from("operator edit\n"), 0o640);

    const result = apply("remove");

    expect(result).toMatchObject({ status: "retained-drift" });
    expect(readFileSync(join(root, "ai-coding/skills/owner-repo/clean/SKILL.md"), "utf8")).toBe(
      "operator edit\n",
    );
    expect(existsSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH))).toBe(true);
  });

  it("normalizes an exact custody receipt mode on POSIX instead of reporting unchanged", () => {
    if (process.platform === "win32") return;
    expect(apply("add").status).toBe("applied");
    const ownership = readFileSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH));
    const trust = readFileSync(join(root, ".aih/trust-lock.json"));
    const custody = join(
      root,
      capabilityPackageCustodyReceiptPath(sha256(ownership), sha256(trust)),
    );
    chmodSync(custody, 0o644);

    expect(apply("update")).toMatchObject({ status: "applied" });
    expect(statSync(custody).mode & 0o777).toBe(0o600);
  });

  it("removes only the package source while preserving unrelated promoted state", () => {
    const trustPath = join(root, ".aih/trust-lock.json");
    const trust = JSON.parse(readFileSync(trustPath, "utf8"));
    const otherBytes = Buffer.from("# Other\n", "utf8");
    trust.sources.push({
      id: "other-repo",
      kind: "github",
      source: "other/repo",
      ref: "main",
      pinnedSha: "b".repeat(40),
      promotedAt: "2026-08-10T00:00:00.000Z",
      promotedSkills: ["other"],
      analyzersRun: ["aih-native"],
      artifactHashes: [{ path: "skills/other/SKILL.md", sha256: sha256(otherBytes) }],
      findings: [],
    });
    put(".aih/trust-lock.json", trust, 0o600);
    put("ai-coding/skills/other-repo/other/SKILL.md", otherBytes, 0o640);
    expect(apply("add").status).toBe("applied");
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = [];
    put("aih-org-policy.json", policy);

    expect(apply("remove")).toMatchObject({ status: "applied" });
    expect(readFileSync(join(root, "ai-coding/skills/other-repo/other/SKILL.md"))).toEqual(
      otherBytes,
    );
    expect(JSON.parse(readFileSync(trustPath, "utf8")).sources).toEqual([
      expect.objectContaining({ id: "other-repo", promotedSkills: ["other"] }),
    ]);
  });
});
