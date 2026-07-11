import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import type { OrgBaselineEvidence } from "../../src/baseline-evidence/org.js";
import { parseBaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import { verifyBaselineComponents } from "../../src/baseline-evidence/verify.js";
import type { Posture } from "../../src/config/posture.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-baseline-verify-"));
  mkdirSync(join(root, "skills", "clean"), { recursive: true });
  writeFileSync(join(root, "skills", "clean", "SKILL.md"), "# Clean\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function catalog(pin = "a".repeat(40)) {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: pin,
    components: [{ id: "skill:clean", paths: ["skills/clean"] }],
  });
}

function lock(over: { hash?: string; verdict?: "pass" | "blocked"; pin?: string } = {}) {
  const verdict = over.verdict ?? "pass";
  return parseBaselineEvidenceLock({
    schemaVersion: 1,
    sources: [
      {
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: over.pin ?? "a".repeat(40),
        components: [
          {
            id: "skill:clean",
            paths: ["skills/clean"],
            treeSha256: over.hash ?? hashComponentTree(root, ["skills/clean"]).treeSha256,
            verdict,
            analyzers: [{ name: "aih-native", version: "2.7.0" }],
            findings:
              verdict === "blocked"
                ? [
                    {
                      code: "trust.hidden-unicode",
                      detail: "instruction surface contains non-ASCII typography",
                    },
                  ]
                : [],
          },
        ],
      },
    ],
  });
}

function verify(posture: Posture, vendorLock = lock()) {
  return verifyBaselineComponents({
    sourceRoot: root,
    catalog: catalog(),
    componentIds: ["skill:clean"],
    posture,
    vendorLock,
    vendorLockSha256: "f".repeat(64),
  });
}

describe("verifyBaselineComponents", () => {
  it("authorizes an exact covered component without running an analyzer", () => {
    const result = verify("enterprise");
    expect(result.checks).toEqual([
      expect.objectContaining({ name: "baseline evidence skill:clean", verdict: "pass" }),
    ]);
    expect(result.authorizations).toEqual([
      {
        componentId: "skill:clean",
        source: "affaan-m/ECC",
        pinnedSha: "a".repeat(40),
        treeSha256: hashComponentTree(root, ["skills/clean"]).treeSha256,
        tier: "vendor",
        issuer: "@aihq/harness release",
        evidenceSha256: "f".repeat(64),
      },
    ]);
  });

  it("partitions mixed signed verdicts into authorized and held components", () => {
    mkdirSync(join(root, "skills", "held"), { recursive: true });
    writeFileSync(join(root, "skills", "held", "SKILL.md"), "# Held\n");
    const mixedCatalog = defineBaselineCatalog({
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: "a".repeat(40),
      components: [
        { id: "skill:clean", paths: ["skills/clean"] },
        { id: "skill:held", paths: ["skills/held"] },
      ],
    });
    const mixedLock = parseBaselineEvidenceLock({
      schemaVersion: 1,
      sources: [
        {
          id: "ecc",
          owner: "affaan-m",
          repo: "ECC",
          pinnedSha: "a".repeat(40),
          components: [
            {
              id: "skill:clean",
              paths: ["skills/clean"],
              treeSha256: hashComponentTree(root, ["skills/clean"]).treeSha256,
              verdict: "pass",
              analyzers: [{ name: "aih-native", version: "2.8.0" }],
              findings: [],
            },
            {
              id: "skill:held",
              paths: ["skills/held"],
              treeSha256: hashComponentTree(root, ["skills/held"]).treeSha256,
              verdict: "blocked",
              analyzers: [{ name: "aih-native", version: "2.8.0" }],
              findings: [
                {
                  code: "trust.auto-exec-hook",
                  detail: "SKILL body contains a leading ! auto-run line",
                },
              ],
            },
          ],
        },
      ],
    });

    const result = verifyBaselineComponents({
      sourceRoot: root,
      catalog: mixedCatalog,
      componentIds: ["skill:clean", "skill:held"],
      posture: "enterprise",
      vendorLock: mixedLock,
      vendorLockSha256: "f".repeat(64),
    });

    expect(result.authorizations).toEqual([
      expect.objectContaining({ componentId: "skill:clean", tier: "vendor" }),
    ]);
    expect(result.held).toEqual([
      {
        componentId: "skill:held",
        routeCode: "baseline.evidence-blocked",
        codes: ["trust.auto-exec-hook"],
        details: [expect.stringContaining("trust.auto-exec-hook")],
      },
    ]);
  });

  it.each([
    "team",
    "enterprise",
  ] as const)("fails closed on uncovered evidence at %s posture", (posture) => {
    const empty = parseBaselineEvidenceLock({
      schemaVersion: 1,
      sources: [
        {
          id: "other",
          owner: "other",
          repo: "source",
          pinnedSha: "b".repeat(40),
          components: [
            {
              id: "skill:other",
              paths: ["skills/other"],
              treeSha256: "c".repeat(64),
              verdict: "pass",
              analyzers: [{ name: "aih-native", version: "2.7.0" }],
              findings: [],
            },
          ],
        },
      ],
    });
    const result = verify(posture, empty);
    expect(result.checks).toEqual([
      expect.objectContaining({ verdict: "fail", code: "baseline.evidence-missing" }),
    ]);
    expect(result.authorizations).toEqual([]);
  });

  it("warns but does not invent an authorization for uncovered vibe installs", () => {
    const empty = parseBaselineEvidenceLock({
      schemaVersion: 1,
      sources: [
        {
          id: "other",
          owner: "other",
          repo: "source",
          pinnedSha: "b".repeat(40),
          components: [
            {
              id: "skill:other",
              paths: ["skills/other"],
              treeSha256: "c".repeat(64),
              verdict: "pass",
              analyzers: [{ name: "aih-native", version: "2.7.0" }],
              findings: [],
            },
          ],
        },
      ],
    });
    const result = verify("vibe", empty);
    expect(result.checks).toEqual([
      expect.objectContaining({ verdict: "pass", detail: expect.stringContaining("warning-only") }),
    ]);
    expect(result.authorizations).toEqual([]);
  });

  it.each([
    "vibe",
    "team",
    "enterprise",
  ] as const)("never permits an exact component whose signed verdict is blocked at %s", (posture) => {
    const result = verify(posture, lock({ verdict: "blocked" }));
    expect(result.checks).toEqual([
      expect.objectContaining({ verdict: "fail", code: "baseline.evidence-blocked" }),
    ]);
    expect(result.authorizations).toEqual([]);
  });

  it.each([
    ["vibe", "pass"],
    ["team", "fail"],
    ["enterprise", "fail"],
  ] as const)("grades content hash mismatch at %s as %s", (posture, verdict) => {
    const result = verify(posture, lock({ hash: "0".repeat(64) }));
    expect(result.checks).toEqual([
      expect.objectContaining({
        verdict,
        ...(verdict === "fail" ? { code: "baseline.evidence-mismatch" } : {}),
      }),
    ]);
    expect(result.authorizations).toEqual([]);
  });

  it("does not let evidence for another source pin cover the requested checkout", () => {
    const result = verify("enterprise", lock({ pin: "b".repeat(40) }));
    expect(result.checks[0]).toMatchObject({
      verdict: "fail",
      code: "baseline.evidence-missing",
    });
  });

  it("authorizes a newer pin through matching signed org evidence", () => {
    const newerPin = "b".repeat(40);
    const orgEvidence: OrgBaselineEvidence = {
      tier: "org",
      issuer: "github:acme/engineering-governance",
      evidenceSha256: "e".repeat(64),
      lock: lock({ pin: newerPin }),
    };
    const result = verifyBaselineComponents({
      sourceRoot: root,
      catalog: catalog(newerPin),
      componentIds: ["skill:clean"],
      posture: "enterprise",
      vendorLock: lock(),
      vendorLockSha256: "f".repeat(64),
      orgEvidence,
    });
    expect(result.checks).toEqual([
      expect.objectContaining({ verdict: "pass", detail: expect.stringContaining("org evidence") }),
    ]);
    expect(result.authorizations[0]).toMatchObject({
      componentId: "skill:clean",
      pinnedSha: newerPin,
      tier: "org",
      issuer: "github:acme/engineering-governance",
      evidenceSha256: "e".repeat(64),
    });
  });

  it.each([
    "vibe",
    "team",
    "enterprise",
  ] as const)("never permits a component whose org evidence is blocked at %s", (posture) => {
    const newerPin = "b".repeat(40);
    const result = verifyBaselineComponents({
      sourceRoot: root,
      catalog: catalog(newerPin),
      componentIds: ["skill:clean"],
      posture,
      vendorLock: lock(),
      vendorLockSha256: "f".repeat(64),
      orgEvidence: {
        tier: "org",
        issuer: "github:acme/engineering-governance",
        evidenceSha256: "e".repeat(64),
        lock: lock({ pin: newerPin, verdict: "blocked" }),
      },
    });
    expect(result.checks).toEqual([
      expect.objectContaining({ verdict: "fail", code: "baseline.evidence-blocked" }),
    ]);
    expect(result.authorizations).toEqual([]);
  });

  it("does not let org evidence replace an exact vendor-blocked verdict for the same bytes", () => {
    const result = verifyBaselineComponents({
      sourceRoot: root,
      catalog: catalog(),
      componentIds: ["skill:clean"],
      posture: "enterprise",
      vendorLock: lock({ verdict: "blocked" }),
      vendorLockSha256: "f".repeat(64),
      orgEvidence: {
        tier: "org",
        issuer: "github:acme/engineering-governance",
        evidenceSha256: "e".repeat(64),
        lock: lock(),
      },
    });
    expect(result.checks[0]).toMatchObject({
      verdict: "fail",
      code: "baseline.evidence-blocked",
    });
    expect(result.authorizations).toEqual([]);
  });
});
