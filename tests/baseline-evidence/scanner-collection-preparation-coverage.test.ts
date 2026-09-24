import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admittedSourceFromCandidateBundleV1,
  collectionCoverageV1,
} from "../../src/baseline-evidence/scanner-catalog-consumer.js";
import { prepareScannerCollectionPublicationsV1 } from "../../src/baseline-evidence/scanner-collection-preparation.js";
import type { Runner } from "../../src/internals/proc.js";
import { sealedSingleSourceBundle } from "./candidate-bundle-fixture.js";

const PIN = "c".repeat(40);
const skill = "---\nname: tdd\n---\n# TDD\n";
const definition = {
  version: "pinned-skill-collection/v1" as const,
  source: { id: "mattpocock", repository: "https://github.com/mattpocock/skills", commit: PIN },
  skills: [
    {
      id: "tdd",
      files: [{ path: "skills/tdd/SKILL.md", bytesBase64: Buffer.from(skill).toString("base64") }],
    },
  ],
};
const head: Runner = async () => ({ code: 0, stdout: `${PIN}\n`, stderr: "" });
const batch = { discoveryBytes: Buffer.from("{}"), publicationBytes: Buffer.from("{}") };
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "aih-collection-coverage-"));
  mkdirSync(join(root, "skills", "tdd"), { recursive: true });
  writeFileSync(join(root, "skills", "tdd", "SKILL.md"), skill);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const coverage = () =>
  collectionCoverageV1(
    root,
    definition,
    admittedSourceFromCandidateBundleV1(
      sealedSingleSourceBundle("mattpocock", PIN, ["tdd"]),
      "source:mattpocock",
    ),
  );

describe("collection preparation with definition-route coverage", () => {
  it("uses the supplied coverage instead of the installed Catalog's registration", async () => {
    // One component means one Core request; two batches can only fail the batch count,
    // which proves the supplied catalog (not the installed 3cca18b3 one) drove the requests.
    await expect(
      prepareScannerCollectionPublicationsV1({
        sourceRoot: root,
        catalogId: "mattpocock",
        batches: [batch, batch],
        now: "2026-09-24T00:00:00.000Z",
        run: head,
        coverage: coverage(),
      }),
    ).rejects.toThrow("Scanner collection preparation: publication batch count");
  });

  it("refuses a deeply nested discovery document typed, before any recursive parse", async () => {
    // 8,000 opening brackets fit the discovery byte limit.
    const discoveryBytes = Buffer.from(`{"x":${"[".repeat(8_000)}`);
    let refusal: unknown;
    try {
      await prepareScannerCollectionPublicationsV1({
        sourceRoot: root,
        catalogId: "mattpocock",
        batches: [{ ...batch, discoveryBytes }],
        now: "2026-09-24T00:00:00.000Z",
        run: head,
        coverage: coverage(),
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(TypeError);
    expect((refusal as Error).message).toBe("publication discovery nests deeper than 32 levels");
  });

  it("refuses coverage prepared for another catalog", async () => {
    await expect(
      prepareScannerCollectionPublicationsV1({
        sourceRoot: root,
        catalogId: "ponytail",
        batches: [batch],
        now: "2026-09-24T00:00:00.000Z",
        run: head,
        coverage: coverage(),
      }),
    ).rejects.toThrow("Scanner collection preparation: collection coverage");
  });

  it("refuses coverage whose digest does not bind its content", async () => {
    const prepared = coverage();
    await expect(
      prepareScannerCollectionPublicationsV1({
        sourceRoot: root,
        catalogId: "mattpocock",
        batches: [batch],
        now: "2026-09-24T00:00:00.000Z",
        run: head,
        coverage: { ...prepared, coverageDigest: `sha256:${"0".repeat(64)}` },
      }),
    ).rejects.toThrow("Scanner collection preparation: collection coverage");
  });
});
