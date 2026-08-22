import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import {
  type AdminBaselineEvidenceBootstrapV1,
  adminBaselineEvidenceBootstrapPathV1,
  parseAdminBaselineEvidenceBootstrapV1Json,
  resolveAdminBaselineEvidenceBootstrapV1,
  vibeAdminBaselineEvidenceRootV1,
} from "../../src/org-policy/admin-baseline-evidence-bootstrap-v1.js";

const record: AdminBaselineEvidenceBootstrapV1 = {
  artifactUrl: "https://artifacts.example.test/vendor-evidence/",
  attestationUrl: "https://artifacts.example.test/vendor-evidence/attestation.json",
  cacheMaxAgeSeconds: 3600,
  expectedEnvironment: "baseline-evidence-publish",
  expectedIssuer: "https://token.actions.githubusercontent.com",
  expectedRef: "refs/heads/main",
  expectedRepository: "samartomar/ai-harness",
  expectedWorkflow: "samartomar/ai-harness/.github/workflows/vendor-baseline-evidence.yml",
  maxSchemaVersion: 1,
  minSchemaVersion: 1,
  protocol: "AdminBaselineEvidenceBootstrapV1",
  sources: [
    {
      id: "ecc",
      owner: "affaan-m",
      pinnedSha: "623f2c020f052319657674e4e6c29ab5d0ad566b",
      repo: "ecc",
    },
    {
      id: "superpowers",
      owner: "obra",
      pinnedSha: "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9",
      repo: "Superpowers",
    },
  ],
};

describe("admin baseline evidence bootstrap V1", () => {
  it("accepts only canonical credential-free HTTPS authority bound to exact #815 identity", () => {
    const parsed = parseAdminBaselineEvidenceBootstrapV1Json(canonicalStrictJsonBytesV1(record));
    expect(parsed).toEqual(record);
  });

  it.each([
    ["credential locator", { ...record, artifactUrl: "https://token@artifacts.example.test/a" }],
    [
      "artifact locator without trailing slash",
      { ...record, artifactUrl: "https://artifacts.example.test/vendor-evidence" },
    ],
    [
      "trailing attestation locator",
      { ...record, attestationUrl: "https://artifacts.example.test/attestation/" },
    ],
    ["schema range", { ...record, maxSchemaVersion: 0 }],
    ["untrusted ref", { ...record, expectedRef: "refs/heads/feature..unsafe" }],
    [
      "wrong source pin",
      {
        ...record,
        sources: [{ ...record.sources[0], pinnedSha: "A".repeat(40) }, record.sources[1]],
      },
    ],
    ["incomplete sources", { ...record, sources: [record.sources[0]] }],
    ["unordered sources", { ...record, sources: [record.sources[1], record.sources[0]] }],
  ])("fails closed on %s", (_label, value) => {
    expect(() =>
      parseAdminBaselineEvidenceBootstrapV1Json(canonicalStrictJsonBytesV1(value)),
    ).toThrow(/admin baseline evidence bootstrap/);
  });

  it("rejects proxy and revoked-proxy byte inputs with the fixed parser error", () => {
    let traps = 0;
    const proxied = new Proxy(canonicalStrictJsonBytesV1(record), {
      get() {
        traps += 1;
        throw new Error("trap");
      },
    });
    const revoked = Proxy.revocable(canonicalStrictJsonBytesV1(record), {});
    revoked.revoke();
    for (const value of [proxied, revoked.proxy]) {
      expect(() => parseAdminBaselineEvidenceBootstrapV1Json(value)).toThrow(
        /admin baseline evidence bootstrap: bytes/,
      );
    }
    expect(traps).toBe(0);
  });

  it("uses one bounded regular bootstrap file per posture and rejects linked custody", () => {
    const workspace = mkdtempSync(join(tmpdir(), "aih-baseline-bootstrap-"));
    const adminRoot = join(workspace, "admin");
    const platformRoot = join(workspace, "platform");
    const write = (root: string) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(adminBaselineEvidenceBootstrapPathV1(root), canonicalStrictJsonBytesV1(record));
    };
    const mustLink = (target: string, path: string, type?: "dir" | "file" | "junction") => {
      try {
        symlinkSync(target, path, type);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") return false;
        throw error;
      }
      return true;
    };
    try {
      write(vibeAdminBaselineEvidenceRootV1(adminRoot));
      expect(() =>
        resolveAdminBaselineEvidenceBootstrapV1({
          adminRoot,
          platformAdminRoot: platformRoot,
          posture: "enterprise",
        }),
      ).toThrow(/enterprise posture requires the OS\/admin-managed canonical bootstrap file/);
      write(platformRoot);
      expect(
        resolveAdminBaselineEvidenceBootstrapV1({
          adminRoot,
          platformAdminRoot: platformRoot,
          posture: "enterprise",
        }),
      ).toMatchObject({ provenance: "os-admin-managed", root: platformRoot });
      expect(() =>
        resolveAdminBaselineEvidenceBootstrapV1({
          adminRoot: join(workspace, "missing"),
          platformAdminRoot: platformRoot,
          posture: "vibe",
        }),
      ).toThrow(/vibe posture requires the canonical bootstrap file under the admin root/);

      const linkedFileAdmin = join(workspace, "linked-file-admin");
      const linkedFileRoot = vibeAdminBaselineEvidenceRootV1(linkedFileAdmin);
      mkdirSync(linkedFileRoot, { recursive: true });
      const outsideFile = join(workspace, "outside-bootstrap.json");
      writeFileSync(outsideFile, canonicalStrictJsonBytesV1(record));
      if (mustLink(outsideFile, adminBaselineEvidenceBootstrapPathV1(linkedFileRoot), "file")) {
        expect(() =>
          resolveAdminBaselineEvidenceBootstrapV1({
            adminRoot: linkedFileAdmin,
            platformAdminRoot: platformRoot,
            posture: "vibe",
          }),
        ).toThrow(/vibe posture requires the canonical bootstrap file under the admin root/);
      }

      const linkedParentAdmin = join(workspace, "linked-parent-admin");
      const outsideParent = join(workspace, "outside-parent");
      write(join(outsideParent, "admin-baseline-evidence"));
      mkdirSync(linkedParentAdmin, { recursive: true });
      if (
        mustLink(
          outsideParent,
          join(linkedParentAdmin, ".aih"),
          process.platform === "win32" ? "junction" : "dir",
        )
      ) {
        expect(() =>
          resolveAdminBaselineEvidenceBootstrapV1({
            adminRoot: linkedParentAdmin,
            platformAdminRoot: platformRoot,
            posture: "vibe",
          }),
        ).toThrow(/baseline root links/);
      }

      const linkedRootAdmin = join(workspace, "linked-root-admin");
      const outsideRoot = join(workspace, "outside-root");
      write(outsideRoot);
      mkdirSync(join(linkedRootAdmin, ".aih"), { recursive: true });
      if (
        mustLink(
          outsideRoot,
          vibeAdminBaselineEvidenceRootV1(linkedRootAdmin),
          process.platform === "win32" ? "junction" : "dir",
        )
      ) {
        expect(() =>
          resolveAdminBaselineEvidenceBootstrapV1({
            adminRoot: linkedRootAdmin,
            platformAdminRoot: platformRoot,
            posture: "vibe",
          }),
        ).toThrow(/baseline root links/);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
