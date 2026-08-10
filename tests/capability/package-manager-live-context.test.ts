import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectCapabilityPackageContext } from "../../src/capability/package-manager/live-context.js";

const SHA = "a".repeat(40);
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-package-live-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, value: unknown): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seed(): void {
  const evidencePath = ".aih/skill-reports/owner-repo-aaaaaaaa.json";
  const evidence = {
    schemaVersion: 1,
    source: `Owner/Repo@${SHA}`,
    pinnedSha: SHA,
    checks: [],
    analyzersRun: ["aih-native"],
    verdict: "GREEN",
    reasons: [],
  };
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
  write(evidencePath, evidence);
  write("ai-coding/skill-cards/clean.json", {
    schemaVersion: 1,
    name: "clean",
    source: `Owner/Repo@${SHA}`,
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
  write("aih-org-policy.json", {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    capabilityPackages: {
      catalog: { provider: "github", repository: "Host/Capabilities" },
      roots: ["package:skill-pack/docs-quality"],
    },
  });
  write("aih-skills.lock.json", {
    schemaVersion: 1,
    skills: [
      {
        name: "clean",
        source: `Owner/Repo@${SHA}`,
        commit: SHA,
        verdict: "GREEN",
        scope: "repo",
        card: "ai-coding/skill-cards/clean.json",
        evidenceSha256,
        approvedBy: "security",
        approvedAt: "2026-08-10T00:00:00.000Z",
      },
    ],
  });
  write("aih-packs.json", {
    schemaVersion: 1,
    packs: [
      {
        name: "docs-quality",
        description: "Documentation quality skills",
        skills: [{ name: "clean", source: `Owner/Repo@${SHA}`, commit: SHA }],
      },
    ],
  });
}

describe("capability package live context", () => {
  it("derives requested package closure from policy and exact live authorities", () => {
    seed();

    const report = inspectCapabilityPackageContext({
      root,
      contextDir: "ai-coding",
      operation: "list",
    });

    expect(report.refusals).toEqual([]);
    expect(report.requestedRoots).toEqual(["package:skill-pack/docs-quality"]);
    expect(report.packages).toEqual([
      expect.objectContaining({
        id: "package:skill-pack/docs-quality",
        requested: true,
        members: ["skill:clean"],
        authority: "catalog:aih-packs",
        lifecycle: "add",
      }),
    ]);
    expect(report.sources).toMatchObject({
      policy: { state: "valid" },
      approval: { state: "valid" },
      evidence: { state: "valid" },
      catalog: { state: "valid" },
      packageGraph: { state: "valid" },
      intent: { state: "valid" },
      resolution: { state: "absent" },
      ownership: { state: "absent" },
      custody: { state: "unowned" },
      domain: { state: "absent" },
    });
  });

  it("refuses when exact evidence bytes drift from the approval digest", () => {
    seed();
    write(".aih/skill-reports/owner-repo-aaaaaaaa.json", {
      schemaVersion: 1,
      source: `Owner/Repo@${SHA}`,
      pinnedSha: SHA,
      checks: [],
      analyzersRun: [],
      verdict: "RED",
      reasons: ["changed"],
    });

    const report = inspectCapabilityPackageContext({
      root,
      contextDir: "ai-coding",
      operation: "status",
    });

    expect(report.refusals).toEqual([{ stage: "evidence", reason: "evidence-digest-mismatch" }]);
  });

  it("rejects a symlinked evidence parent and hostile request proxy without invoking traps", () => {
    seed();
    renameSync(join(root, ".aih"), join(root, "state"));
    symlinkSync("state", join(root, ".aih"), "dir");

    const report = inspectCapabilityPackageContext({
      root,
      contextDir: "ai-coding",
      operation: "list",
    });
    expect(report.refusals).toEqual([{ stage: "evidence", reason: "missing-or-unsafe-evidence" }]);

    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps += 1;
          return Object.prototype;
        },
      },
    );
    expect(inspectCapabilityPackageContext(hostile).refusals).toEqual([
      { stage: "input", reason: "invalid-input" },
    ]);
    expect(traps).toBe(0);
  });

  it("fails closed with stable stage reasons for malformed live authority", () => {
    seed();
    writeFileSync(join(root, "aih-skills.lock.json"), "{", "utf8");

    const report = inspectCapabilityPackageContext({
      root,
      contextDir: "ai-coding",
      operation: "doctor",
    });

    expect(report.packages).toEqual([]);
    expect(report.refusals).toEqual([{ stage: "approval", reason: "invalid-skills-lock" }]);
    expect(JSON.stringify(report.refusals)).not.toContain(root);
  });

  it("previews a policy-root addition without writing or elevating it to current policy", () => {
    seed();
    const policy = JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8"));
    policy.capabilityPackages.roots = [];
    write("aih-org-policy.json", policy);

    const report = inspectCapabilityPackageContext({
      root,
      contextDir: "ai-coding",
      operation: "add",
      packageId: "package:skill-pack/docs-quality",
    });

    expect(report.preview).toMatchObject({
      operation: "add",
      packageId: "package:skill-pack/docs-quality",
      writes: 0,
      acquisition: false,
      network: false,
      processExecution: false,
      componentLoading: false,
      policyChangeRequired: true,
    });
    expect(report.refusals).toContainEqual({
      stage: "policy",
      reason: "selection-change-required",
    });
  });
});
