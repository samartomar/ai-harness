import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { parseBaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import { vendorBaselineLockBytes } from "../../src/baseline-evidence/vendor.js";
import {
  type BaselinePackageGraphAuthorityInput,
  projectBaselinePackageGraphAuthority,
} from "../../src/capability/package-graph/adapters/baseline.js";
import {
  type EccMaterializationAuthorityInput,
  projectEccMaterializationAuthority,
} from "../../src/capability/package-graph/adapters/ecc-materialization.js";
import { PackageGraphAuthorityDocumentSchema } from "../../src/capability/package-graph/build.js";
import {
  type EccMaterializationReceipt,
  serializeEccMaterializationReceipt,
} from "../../src/ecc/materialization-receipt.js";

const PIN = "a".repeat(40);
const SOURCE_TREE = "b".repeat(64);
const SKILL_TREE = "c".repeat(64);
const MODULE_TREE = "d".repeat(64);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function catalog() {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ecc",
    pinnedSha: PIN,
    components: [
      { id: "skill:alpha", paths: ["skills/alpha"], skillContent: true },
      {
        id: "module:agents-core:reviewer",
        paths: ["agents/reviewer.md", "agents/reviewer.yaml"],
      },
    ],
  });
}

function lockValue(overrides: Record<string, unknown> = {}) {
  return parseBaselineEvidenceLock({
    schemaVersion: 1,
    sources: [
      {
        id: "ecc",
        owner: "affaan-m",
        repo: "ecc",
        pinnedSha: PIN,
        sourceTreeSha256: SOURCE_TREE,
        components: [
          {
            id: "module:agents-core:reviewer",
            paths: ["agents/reviewer.yaml", "agents/reviewer.md"],
            treeSha256: MODULE_TREE,
            verdict: "pass",
            analyzers: [{ name: "scanner-z", version: "9" }],
            findings: [],
          },
          {
            id: "skill:alpha",
            paths: ["skills/alpha"],
            treeSha256: SKILL_TREE,
            verdict: "blocked",
            analyzers: [
              { name: "scanner-z", version: "9" },
              { name: "scanner-a", version: "1" },
            ],
            findings: [
              { code: "trust.zeta", detail: "one" },
              { code: "trust.alpha", detail: "two" },
              { code: "trust.zeta", count: 2, detail: "three" },
            ],
          },
        ],
        ...overrides,
      },
    ],
  });
}

function lockBytes(value = lockValue(), spacing?: number, eol = "\n"): Buffer {
  const text = JSON.stringify(value, null, spacing);
  return Buffer.from(spacing === undefined ? text : `${text}${eol}`, "utf8");
}

function baselineDocument(bytes = lockBytes()) {
  return projectBaselinePackageGraphAuthority({
    authorityId: "lock:baseline/ecc",
    catalog: catalog(),
    lockBytes: bytes,
  });
}

function receipt(
  overrides: {
    id?: string;
    authorization?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
  } = {},
): EccMaterializationReceipt {
  const id = overrides.id ?? "skill:alpha";
  return {
    format: "aih-ecc-materialization-receipt",
    schemaVersion: 1,
    components: [
      {
        id,
        authorization: {
          componentId: id,
          source: "affaan-m/ECC",
          pinnedSha: PIN,
          treeSha256: SKILL_TREE,
          tier: "vendor",
          issuer: "@aihq/core release",
          evidenceSha256: baselineDocument().authority.sourceDigest.value,
          ...overrides.authorization,
        },
        provenance: {
          repository: "affaan-m/ECC",
          commit: PIN,
          componentPath: "skills/alpha",
          ...overrides.provenance,
        },
        files: [
          {
            path: ".claude/skills/alpha/SKILL.md",
            operation: "copy-file",
            contentSha256: "1".repeat(64),
          },
        ],
      },
    ],
  } as EccMaterializationReceipt;
}

function receiptBytes(value = receipt()): Buffer {
  return Buffer.from(serializeEccMaterializationReceipt(value), "utf8");
}

function rawReceiptBytes(value: EccMaterializationReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

describe("Package Graph baseline authority adapter", () => {
  it("projects every shipped catalog from the exact committed vendor-lock bytes", () => {
    const bytes = vendorBaselineLockBytes();

    for (const id of ["ecc", "superpowers"]) {
      const shippedCatalog = baselineCatalogById(id);
      const document = projectBaselinePackageGraphAuthority({
        authorityId: `lock:baseline/${id}`,
        catalog: shippedCatalog,
        lockBytes: bytes,
      });
      expect(PackageGraphAuthorityDocumentSchema.parse(document)).toEqual(document);
      expect(document.authority.sourceDigest.value).toBe(sha256(bytes));
      expect(document.graph.surfaces).toHaveLength(shippedCatalog.components.length);
      expect(document.graph.packages[0]?.members).toHaveLength(shippedCatalog.components.length);
      expect(document.graph.packages[0]?.sourceDigest).toEqual({
        algorithm: "git-sha1",
        value: shippedCatalog.pinnedSha,
      });
    }
  });

  it("joins catalog intent to lock evidence without inventing risk attribution", () => {
    const bytes = lockBytes();
    const document = baselineDocument(bytes);

    expect(document.authority.sourceDigest.value).toBe(sha256(bytes));
    expect(document.graph.packages).toEqual([
      expect.objectContaining({
        id: "package:baseline/ecc",
        sourceDigest: { algorithm: "git-sha1", value: PIN },
        members: ["module:agents-core/reviewer", "skill:alpha"],
        declaredRisk: [],
        observedRisk: [],
      }),
    ]);
    expect(document.graph.surfaces.map((surface) => surface.id)).toEqual([
      "module:agents-core/reviewer",
      "skill:alpha",
    ]);
    expect(document.graph.surfaces[1]).toMatchObject({
      id: "skill:alpha",
      sourceDigest: { algorithm: "sha256", value: SKILL_TREE },
      declaredRisk: [],
      observedRisk: [
        {
          detector: { name: "baseline-evidence-lock", version: "1" },
          evidence: {
            sha256: sha256(bytes),
            subjectDigest: { algorithm: "sha256", value: SKILL_TREE },
          },
          verdict: "blocked",
          findings: [{ code: "trust.alpha" }, { code: "trust.zeta", count: 3 }],
        },
      ],
    });
  });

  it("makes exact lock formatting part of authority identity, not semantic projection", () => {
    const compact = lockBytes();
    const prettyCrLf = Buffer.from(
      `${JSON.stringify(lockValue(), null, 2).replace(/\n/g, "\r\n")}\r\n`,
      "utf8",
    );
    const compactDocument = baselineDocument(compact);
    const prettyDocument = baselineDocument(prettyCrLf);

    expect(
      compactDocument.graph.surfaces.map((surface) => ({
        ...surface,
        observedRisk: surface.observedRisk.map((risk) => ({
          ...risk,
          evidence: { ...risk.evidence, sha256: "<authority-digest>" },
        })),
      })),
    ).toEqual(
      prettyDocument.graph.surfaces.map((surface) => ({
        ...surface,
        observedRisk: surface.observedRisk.map((risk) => ({
          ...risk,
          evidence: { ...risk.evidence, sha256: "<authority-digest>" },
        })),
      })),
    );
    expect(compactDocument.graph.packages).toEqual(prettyDocument.graph.packages);
    expect(compactDocument.authority.sourceDigest.value).toBe(sha256(compact));
    expect(prettyDocument.authority.sourceDigest.value).toBe(sha256(prettyCrLf));
    expect(compactDocument.authority.sourceDigest).not.toEqual(
      prettyDocument.authority.sourceDigest,
    );
  });

  it("removes the parsed-lock plus independent-digest API", () => {
    const legacy = {
      authorityId: "lock:baseline/ecc",
      catalog: catalog(),
      lock: lockValue(),
      lockSha256: "0".repeat(64),
    } as unknown as BaselinePackageGraphAuthorityInput;

    expect(() => projectBaselinePackageGraphAuthority(legacy)).toThrow();
  });

  it("fails closed on every catalog-to-lock identity and membership mismatch", () => {
    const baseSource = lockValue().sources[0];
    const firstComponent = baseSource?.components[0];
    if (baseSource === undefined || firstComponent === undefined) {
      throw new Error("missing test source");
    }
    const mismatches = [
      { ...baseSource, owner: "Affaan-m" },
      { ...baseSource, repo: "ECC" },
      { ...baseSource, pinnedSha: "9".repeat(40) },
      { ...baseSource, components: baseSource.components.slice(1) },
      {
        ...baseSource,
        components: [...baseSource.components, { ...firstComponent, id: "skill:extra" }],
      },
      {
        ...baseSource,
        components: baseSource.components.map((component) =>
          component.id === "skill:alpha"
            ? { ...component, paths: ["skills/not-alpha"] }
            : component,
        ),
      },
    ];

    for (const source of mismatches) {
      const bytes = lockBytes({ schemaVersion: 1, sources: [source] } as ReturnType<
        typeof lockValue
      >);
      expect(() =>
        projectBaselinePackageGraphAuthority({
          authorityId: "lock:baseline/ecc",
          catalog: catalog(),
          lockBytes: bytes,
        }),
      ).toThrow(/baseline/i);
    }

    expect(() =>
      projectBaselinePackageGraphAuthority({
        authorityId: "lock:baseline/ecc",
        catalog: catalog(),
        lockBytes: Buffer.from([0x7b, 0xff, 0x7d]),
      }),
    ).toThrow(/baseline/i);
  });
});

describe("Package Graph ECC materialization receipt adapter", () => {
  it("copies complete baseline claims and hashes only the exact receipt bytes", () => {
    const baseline = baselineDocument();
    const bytes = receiptBytes();
    const outcome = projectEccMaterializationAuthority({
      authorityId: "receipt:workstation/codex",
      receiptBytes: bytes,
      baseline,
    });

    expect(outcome.state).toBe("ready");
    if (outcome.state !== "ready") throw new Error("expected ready projection");
    expect(outcome.document.authority).toEqual({
      id: "receipt:workstation/codex",
      kind: "receipt",
      sourceDigest: { algorithm: "sha256", value: sha256(bytes) },
    });
    expect(outcome.document.graph.packages).toEqual([]);
    expect(outcome.document.graph.surfaces).toEqual([
      baseline.graph.surfaces.find((surface) => surface.id === "skill:alpha"),
    ]);
  });

  it("changes receipt authority identity for CRLF without changing semantic claims", () => {
    const canonical = receiptBytes();
    const crlf = Buffer.from(canonical.toString("utf8").replace(/\n/g, "\r\n"), "utf8");
    const baseline = baselineDocument();
    const canonicalOutcome = projectEccMaterializationAuthority({
      authorityId: "receipt:canonical",
      receiptBytes: canonical,
      baseline,
    });
    const crlfOutcome = projectEccMaterializationAuthority({
      authorityId: "receipt:crlf",
      receiptBytes: crlf,
      baseline,
    });

    expect(canonicalOutcome.state).toBe("ready");
    expect(crlfOutcome.state).toBe("ready");
    if (canonicalOutcome.state !== "ready" || crlfOutcome.state !== "ready") {
      throw new Error("expected ready projections");
    }
    expect(canonicalOutcome.document.graph).toEqual(crlfOutcome.document.graph);
    expect(canonicalOutcome.document.authority.sourceDigest.value).toBe(sha256(canonical));
    expect(crlfOutcome.document.authority.sourceDigest.value).toBe(sha256(crlf));
    expect(canonicalOutcome.document.authority.sourceDigest).not.toEqual(
      crlfOutcome.document.authority.sourceDigest,
    );
  });

  it("returns no document for unsupported or contradictory receipt bytes", () => {
    const baseline = baselineDocument();
    const cases = [
      {
        state: "invalid",
        bytes: Buffer.from(JSON.stringify({ ...receipt(), components: [] }), "utf8"),
      },
      { state: "invalid", bytes: Buffer.from([0x7b, 0xff, 0x7d]) },
      { state: "unsupported", bytes: receiptBytes(receipt({ authorization: { tier: "org" } })) },
      { state: "unsupported", bytes: receiptBytes(receipt({ id: "skill:missing" })) },
      {
        state: "invalid",
        bytes: rawReceiptBytes(receipt({ authorization: { componentId: "skill:other" } })),
      },
      {
        state: "invalid",
        bytes: rawReceiptBytes(receipt({ provenance: { repository: "other/repo" } })),
      },
      {
        state: "invalid",
        bytes: rawReceiptBytes(receipt({ provenance: { commit: "2".repeat(40) } })),
      },
      {
        state: "invalid",
        bytes: receiptBytes(receipt({ authorization: { treeSha256: "2".repeat(64) } })),
      },
      {
        state: "invalid",
        bytes: receiptBytes(receipt({ authorization: { evidenceSha256: "2".repeat(64) } })),
      },
      {
        state: "invalid",
        bytes: rawReceiptBytes(receipt({ authorization: { source: "other/repo" } })),
      },
    ] as const;

    for (const candidate of cases) {
      const outcome = projectEccMaterializationAuthority({
        authorityId: "receipt:workstation/codex",
        receiptBytes: candidate.bytes,
        baseline,
      });
      expect(outcome.state).toBe(candidate.state);
      expect("document" in outcome).toBe(false);
    }
  });

  it("rejects a jointly forged authorization and provenance commit", () => {
    const forgedPin = "9".repeat(40);
    const outcome = projectEccMaterializationAuthority({
      authorityId: "receipt:workstation/codex",
      receiptBytes: receiptBytes(
        receipt({
          authorization: { pinnedSha: forgedPin },
          provenance: { commit: forgedPin },
        }),
      ),
      baseline: baselineDocument(),
    });

    expect(outcome).toEqual({ state: "invalid", code: "baseline-binding" });
  });

  it("removes the receipt-object plus independent-digest API", () => {
    const legacy = {
      authorityId: "receipt:workstation/codex",
      receipt: receipt(),
      sourceSha256: "0".repeat(64),
      baseline: baselineDocument(),
    } as unknown as EccMaterializationAuthorityInput;

    const outcome = projectEccMaterializationAuthority(legacy);
    expect(outcome).toEqual({ state: "invalid", code: "receipt-boundary" });
  });

  it("rejects an invalid authority boundary without a partial document", () => {
    const outcome = projectEccMaterializationAuthority({
      authorityId: "lock:not-a-receipt",
      receiptBytes: receiptBytes(),
      baseline: baselineDocument(),
    });

    expect(outcome.state).toBe("invalid");
    expect("document" in outcome).toBe(false);
  });
});
