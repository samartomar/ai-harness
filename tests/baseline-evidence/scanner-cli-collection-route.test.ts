import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review finding 4: the D79 bypass belongs to FRAMEWORK definition resolution only. A carried
 * COLLECTION keeps its registered route — snapshot-byte checks, coverage checks and coverage
 * output — so changing a covered file while HEAD stays the same must still refuse. This file
 * runs the real bridge, resolver and registered route (only the checkout's HEAD read is
 * mocked, so a changed file can be supplied at an unchanged pin) against the installed
 * Catalog's own registered mattpocock bytes.
 */
const MATTPOCOCK_PIN = "c55ee46073ed923f86ce59a5eb3b6d895095d1b7";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => `${MATTPOCOCK_PIN}\n`),
}));

import {
  type CollectionInput,
  collectionBaselineCatalogV1,
  collectionFilesV1,
  registeredCollectionInputV1,
} from "../../src/baseline-evidence/scanner-catalog-consumer.js";
import { runScannerBridge } from "../../src/baseline-evidence/scanner-cli.js";

let root: string;
let source: string;
let definition: string;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "aih-cli-collection-route-"));
  source = join(root, "mattpocock");
  mkdirSync(source);
  const input = registeredCollectionInputV1("mattpocock") as CollectionInput;
  expect(input.source.commit).toBe(MATTPOCOCK_PIN);
  // The installed Catalog carries this collection's reviewed bytes inline, so the checkout can
  // be the exact registered snapshot.
  for (const file of collectionFilesV1(input)) {
    const path = join(source, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(file.bytesBase64, "base64"));
  }
  definition = join(root, "mattpocock.definition.json");
  writeFileSync(definition, JSON.stringify(collectionBaselineCatalogV1(input)));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("carried collection definitions keep the registered route", () => {
  it("refuses a covered file that changed while HEAD stayed the same", async () => {
    const covered = (registeredCollectionInputV1("mattpocock") as CollectionInput).skills?.[0]
      ?.files[0];
    if (covered === undefined) throw new Error("fixture: mattpocock carries no skill files");
    // HEAD is the pin in both runs; only this covered file's bytes change.
    writeFileSync(join(source, covered.path), "changed after publication\n");

    await expect(
      runScannerBridge([
        "request",
        "--catalog",
        "mattpocock",
        "--source",
        source,
        "--definition",
        definition,
        "--output",
        join(root, "requests"),
      ]),
    ).rejects.toThrow(/^Scanner source differs from reviewed snapshot bytes/);
    expect(existsSync(join(root, "requests"))).toBe(false);
  });
});
