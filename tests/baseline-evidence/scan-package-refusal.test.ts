import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";

// ---------------------------------------------------------------------------
// The baseline routes need @aihq/scan's public API. Without it they refuse with
// the typed scan-package-unavailable result naming the install command: request
// authoring throws it, and publication consumption surfaces it as itself rather
// than folding it into an opaque "content or Scanner verification" failure.
// ---------------------------------------------------------------------------

vi.mock("../../src/scan-package/load-scan-package.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/scan-package/load-scan-package.js")>();
  return {
    ...original,
    loadScanPackageExportsV1: (names: readonly string[]) =>
      original.loadScanPackageExportsV1(names as never, () =>
        Promise.reject(
          Object.assign(new Error("Cannot find package '@aihq/scan' imported from core"), {
            code: "ERR_MODULE_NOT_FOUND",
          }),
        ),
      ),
  };
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-scan-package-refusal-"));
  mkdirSync(join(root, "rules"));
  writeFileSync(join(root, "rules", "a.md"), "# rule\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const catalog = () =>
  defineBaselineCatalog({
    id: "fixture",
    owner: "example",
    repo: "fixture",
    pinnedSha: "a".repeat(40),
    components: [{ id: "rules", paths: ["rules"] }],
  });

describe("baseline routes without @aihq/scan", () => {
  it("still imports the consumer, and request authoring throws the typed refusal", async () => {
    const { createCoreBaselineVetRequests } = await import(
      "../../src/baseline-evidence/scanner-consumer.js"
    );
    const { ScanPackageRefusalError } = await import("../../src/scan-package/load-scan-package.js");
    let thrown: unknown;
    try {
      createCoreBaselineVetRequests(root, catalog());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ScanPackageRefusalError);
    expect((thrown as { code?: string }).code).toBe("AIH_SCAN_PACKAGE");
    expect((thrown as Error).message).toBe(
      "scan-package-unavailable: @aihq/scan is not installed next to @aihq/core; this operation needs its public API. Install it with: npm install -g @aihq/core @aihq/scan (in a project: npm install @aihq/core @aihq/scan).",
    );
  });

  it("surfaces the refusal from publication consumption instead of an opaque failure", async () => {
    const { consumeScannerBaselinePublicationV1 } = await import(
      "../../src/baseline-evidence/scanner-publication.js"
    );
    await expect(
      consumeScannerBaselinePublicationV1({
        sourceRoot: root,
        catalog: catalog(),
        expectedRequestSha256: "d".repeat(64),
        discoveryBytes: Buffer.from("{}"),
        publicationBytes: Buffer.from("{}"),
        attestationResultBytes: Buffer.from("{}"),
        publisher: {
          repository: "samartomar/aih-scan",
          workflow: "samartomar/aih-scan/.github/workflows/baseline-publication.yml",
          ref: "refs/heads/main",
          commit: "f".repeat(40),
        },
        now: "2026-09-22T00:00:00.000Z",
        maxAgeSeconds: 60,
      }),
    ).rejects.toMatchObject({
      code: "AIH_SCAN_PACKAGE",
      refusal: { reason: "scan-package-unavailable" },
    });
  });
});
