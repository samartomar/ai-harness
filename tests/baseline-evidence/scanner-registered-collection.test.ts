import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  prepareRegisteredScannerCatalogV1,
  registeredCollectionInputV1,
} from "../../src/baseline-evidence/scanner-catalog-consumer.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "aih-registered-collection-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The installed Catalog registers Ponytail as a compiler template: bytes are checkout references. */
function registeredPonytailPaths(): string[] {
  const input = registeredCollectionInputV1("ponytail") as { files?: { path: string }[] };
  return (input.files ?? []).map((file) => file.path);
}

describe("registered collection route", () => {
  it("compares a Ponytail checkout against the registered byte references", () => {
    const paths = registeredPonytailPaths();
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "not the reviewed bytes\n");
    }
    expect(() => prepareRegisteredScannerCatalogV1(root, "ponytail")).toThrow(
      /^Scanner source differs from reviewed snapshot bytes \(/,
    );
  });

  it("refuses a Ponytail checkout that lacks a registered file", () => {
    expect(() => prepareRegisteredScannerCatalogV1(root, "ponytail")).toThrow(
      /^Scanner source differs from reviewed snapshot bytes \(/,
    );
  });
});
