import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("refuses without exact promoted-domain proof and advances no package state", () => {
    rmSync(join(root, ".aih/trust-lock.json"));

    expect(apply("add")).toMatchObject({ status: "refused", stage: "domain" });
    expect(existsSync(join(root, CAPABILITY_PACKAGE_INTENT_PATH))).toBe(false);
    expect(existsSync(join(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH))).toBe(false);
  });

  it("subtracts an unchanged final member only after policy deselection", () => {
    expect(apply("add").status).toBe("applied");
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
});
