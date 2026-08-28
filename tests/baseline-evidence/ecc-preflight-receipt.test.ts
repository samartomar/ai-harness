import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BaselineCatalog,
  defineBaselineCatalog,
} from "../../src/baseline-evidence/catalog.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import {
  assertEccPreflightReceipt,
  buildEccPreflightReceipt,
  type EccPreflightReceipt,
} from "../../src/baseline-evidence/ecc-preflight-receipt.js";
import {
  assertEccPreflightReceiptPathOutsideSource,
  generateBaselineArtifacts,
  readVerifiedEccPreflightReceipt,
} from "../../src/baseline-evidence/generate.js";
import { hashSourceTree } from "../../src/baseline-evidence/hash.js";
import type { BaselineSourceEvidence } from "../../src/baseline-evidence/schema.js";
import { shardCatalog } from "../../src/baseline-evidence/shard.js";

const PIN = "a".repeat(40);
const RUNTIME_PATHS = [
  "package.json",
  "scripts/lib/install/plan.js",
  "scripts/lib/install-manifests.js",
  "scripts/lib/install-targets/registry.js",
] as const;
const SECRET_SNIPPET = "fixture-upstream-secret-do-not-leak";

function catalog(): BaselineCatalog {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: PIN,
    components: [
      { id: "runtime:ecc-installer", paths: [...RUNTIME_PATHS] },
      { id: "module:fixture", paths: ["module"] },
    ],
  });
}

function writeFixture(root: string): void {
  mkdirSync(join(root, "scripts/lib/install-targets"), { recursive: true });
  mkdirSync(join(root, "scripts/lib/install"), { recursive: true });
  mkdirSync(join(root, "module"));
  writeFileSync(
    join(root, "package.json"),
    `{"name":"ecc-fixture","secret":"${SECRET_SNIPPET}"}\n`,
  );
  writeFileSync(
    join(root, "scripts/lib/install/plan.js"),
    [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(join(root, "executed.txt"))}, "executed");`,
      "module.exports = {};",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "scripts/lib/install-manifests.js"), "module.exports = {};\n");
  writeFileSync(join(root, "scripts/lib/install-targets/registry.js"), "module.exports = {};\n");
  writeFileSync(join(root, "module/README.md"), "fixture module\n");
}

function receipt(root: string): EccPreflightReceipt {
  return buildEccPreflightReceipt({ eccRoot: root, catalog: catalog() });
}

function evidenceFor(catalog: BaselineCatalog): BaselineSourceEvidence {
  return {
    id: catalog.id,
    owner: catalog.owner,
    repo: catalog.repo,
    pinnedSha: catalog.pinnedSha,
    sourceTreeSha256: "a".repeat(64),
    components: catalog.components.map((component) => ({
      id: component.id,
      paths: [...component.paths],
      treeSha256: "b".repeat(64),
      verdict: "blocked" as const,
      analyzers: [{ name: "fixture", version: "1" }],
      findings: [{ code: "fixture.blocked", detail: "fixture evidence" }],
    })),
  };
}

describe("ECC static preflight receipt", () => {
  let root: string;
  let receiptRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aih-ecc-preflight-receipt-"));
    receiptRoot = mkdtempSync(join(tmpdir(), "aih-ecc-preflight-files-"));
    writeFixture(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(receiptRoot, { recursive: true, force: true });
  });

  it("runs structural checks without executing upstream and binds the complete source identity", () => {
    const result = receipt(root);

    expect(result.source).toEqual({
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: PIN,
      sourceTreeSha256: hashSourceTree(root).treeSha256,
    });
    expect(result.runtime).toEqual({
      componentId: "runtime:ecc-installer",
      paths: [...RUNTIME_PATHS],
    });
    expect(result.checks).toEqual([
      {
        id: "preview-generator-dependency-closure",
        version: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(result.checks.map((check) => check.id)).toEqual([
      "preview-generator-dependency-closure",
    ]);
    expect(result.checks.map((check) => check.version)).toEqual(
      receipt(root).checks.map((check) => check.version),
    );
    expect(result).not.toHaveProperty("eccRoot");
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain(SECRET_SNIPPET);
    // The fixture would create this file if the upstream entry were imported.
    // Static lexical preflight must not execute that entry.
    expect(existsSync(join(root, "executed.txt"))).toBe(false);
  });

  it.each([
    [
      "stale source pin",
      (value: EccPreflightReceipt) => ({
        ...value,
        source: { ...value.source, pinnedSha: "b".repeat(40) },
      }),
    ],
    [
      "missing whole-source hash",
      (value: EccPreflightReceipt) => ({
        ...value,
        source: { ...value.source, sourceTreeSha256: undefined },
      }),
    ],
    [
      "reordered runtime paths",
      (value: EccPreflightReceipt) => ({
        ...value,
        runtime: { ...value.runtime, paths: [...value.runtime.paths].reverse() },
      }),
    ],
    [
      "unknown check version",
      (value: EccPreflightReceipt) => ({
        ...value,
        checks: value.checks.map((check) => ({ ...check, version: "0".repeat(64) })),
      }),
    ],
    ["extra receipt key", (value: EccPreflightReceipt) => ({ ...value, forged: true })],
  ])("refuses %s before a receipt can authorize assembly", (_label, mutate) => {
    const forged = mutate(receipt(root));

    expect(() =>
      assertEccPreflightReceipt({ eccRoot: root, catalog: catalog(), receipt: forged }),
    ).toThrow();
  });

  it("refuses cross-source and sharded receipts without exposing absolute paths or source text", () => {
    const base = receipt(root);
    const crossSource = {
      ...base,
      source: { ...base.source, owner: "other-owner", repo: "other-repo" },
    };
    const sharded = shardCatalog(catalog(), { index: 1, total: 2 });

    for (const candidate of [crossSource, base]) {
      expect(() =>
        assertEccPreflightReceipt({
          eccRoot: root,
          catalog: sharded,
          receipt: candidate,
        }),
      ).toThrow();
    }

    writeFileSync(join(root, "module/README.md"), `${SECRET_SNIPPET}\nchanged\n`);
    expect(() =>
      assertEccPreflightReceipt({ eccRoot: root, catalog: catalog(), receipt: base }),
    ).toThrow();
    try {
      assertEccPreflightReceipt({ eccRoot: root, catalog: catalog(), receipt: base });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(root);
      expect(message).not.toContain(SECRET_SNIPPET);
    }
  });

  it("refuses a new source file after preflight rather than treating the old receipt as current", () => {
    const base = receipt(root);
    writeFileSync(join(root, "new-file-after-preflight.txt"), "new source content\n");

    expect(() =>
      assertEccPreflightReceipt({ eccRoot: root, catalog: catalog(), receipt: base }),
    ).toThrow();
  });

  it("refuses linked and oversized receipt files before parsing them", () => {
    const oversized = join(receiptRoot, "oversized-preflight.json");
    const oversizedJson = JSON.stringify({ padding: "x".repeat(66_000) });
    expect(Buffer.byteLength(oversizedJson, "utf8")).toBeGreaterThan(65_536);
    writeFileSync(oversized, oversizedJson);
    expect(() => readVerifiedEccPreflightReceipt(oversized, root, catalog())).toThrow(
      "unusable ECC preflight receipt",
    );

    const target = join(receiptRoot, "preflight.json");
    const link = join(receiptRoot, "preflight-link.json");
    writeFileSync(target, JSON.stringify(receipt(root)));
    let symlinkSupported = true;
    try {
      symlinkSync(target, link);
    } catch {
      symlinkSupported = false;
    }
    if (symlinkSupported) {
      expect(() => readVerifiedEccPreflightReceipt(link, root, catalog())).toThrow(
        "unusable ECC preflight receipt",
      );
    } else {
      expect(existsSync(link)).toBe(false);
    }
  });

  it("reads a valid receipt from a regular file outside the ECC source root", () => {
    const path = join(receiptRoot, "preflight.json");
    const expected = receipt(root);
    writeFileSync(path, JSON.stringify(expected));

    expect(readVerifiedEccPreflightReceipt(path, root, catalog())).toEqual(expected);
  });

  it("keeps stale source mismatch diagnostics specific while malformed input stays generic", () => {
    const stalePath = join(receiptRoot, "stale-preflight.json");
    writeFileSync(stalePath, JSON.stringify(receipt(root)));
    writeFileSync(join(root, "new-file-after-preflight.txt"), "changed after receipt\n");

    expect(() => readVerifiedEccPreflightReceipt(stalePath, root, catalog())).toThrow(
      "ECC preflight receipt source tree does not match the pinned checkout",
    );

    const malformedPath = join(receiptRoot, "malformed-preflight.json");
    writeFileSync(malformedPath, "not json");
    expect(() => readVerifiedEccPreflightReceipt(malformedPath, root, catalog())).toThrow(
      "unusable ECC preflight receipt",
    );
  });

  it("keeps receipt paths outside the source root and refuses linked parents into it", () => {
    const outsidePath = join(receiptRoot, "preflight.json");
    expect(() => assertEccPreflightReceiptPathOutsideSource(root, outsidePath)).not.toThrow();
    expect(() =>
      assertEccPreflightReceiptPathOutsideSource(root, join(root, "preflight.json")),
    ).toThrow("ECC preflight receipt path must be outside the ECC source root");

    const linkedParent = join(receiptRoot, "linked-parent");
    let symlinkSupported = true;
    try {
      symlinkSync(root, linkedParent, "junction");
    } catch {
      symlinkSupported = false;
    }
    if (symlinkSupported) {
      expect(() =>
        assertEccPreflightReceiptPathOutsideSource(root, join(linkedParent, "receipt.json")),
      ).toThrow("ECC preflight receipt path must be outside the ECC source root");
    } else {
      expect(existsSync(linkedParent)).toBe(false);
    }
  });

  it("joins completed ECC evidence back to the preflight source digest", async () => {
    const preflightReceipt = buildEccPreflightReceipt({
      eccRoot: root,
      catalog: baselineCatalogById("ecc"),
    });
    const generatePreview = vi.fn(() => ({ schemaVersion: 1, operations: [] }));
    const vetCatalog = vi.fn(async (_sourceRoot: string, active: BaselineCatalog) => {
      const evidence: BaselineSourceEvidence = {
        id: active.id,
        owner: active.owner,
        repo: active.repo,
        pinnedSha: active.pinnedSha,
        sourceTreeSha256: "f".repeat(64),
        components: [],
      };
      return evidence;
    });

    await expect(
      generateBaselineArtifacts(
        { eccRoot: root, superpowersRoot: root },
        {
          platform: "linux",
          env: {},
          checkoutHead: (_sourceRoot, active) => active.pinnedSha,
          preflight: async () => {},
          vetCatalog,
          generatePreview,
          eccPreflightReceipt: preflightReceipt,
        },
      ),
    ).rejects.toThrow("does not cover the completed baseline evidence");
    expect(vetCatalog).toHaveBeenCalledTimes(1);
    expect(generatePreview).not.toHaveBeenCalled();
  });

  it("accepts matching completed evidence and reaches the authorized preview step", async () => {
    const preflightReceipt = buildEccPreflightReceipt({
      eccRoot: root,
      catalog: baselineCatalogById("ecc"),
    });
    const generatePreview = vi.fn(() => ({ schemaVersion: 1, operations: [] }));
    const vetCatalog = vi.fn(async (_sourceRoot: string, active: BaselineCatalog) => {
      const result = evidenceFor(active);
      if (active.id === "ecc") result.sourceTreeSha256 = preflightReceipt.source.sourceTreeSha256;
      return result;
    });

    await generateBaselineArtifacts(
      { eccRoot: root, superpowersRoot: root },
      {
        platform: "linux",
        env: {},
        checkoutHead: (_sourceRoot, active) => active.pinnedSha,
        preflight: async () => {},
        vetCatalog,
        generatePreview,
        eccPreflightReceipt: preflightReceipt,
      },
    );

    expect(vetCatalog).toHaveBeenCalledTimes(2);
    expect(generatePreview).toHaveBeenCalledOnce();
  });
});
