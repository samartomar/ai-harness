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

  it("refuses deeply nested supplied coverage typed, before any recursive walk goes deep", async () => {
    let deep: unknown = 0;
    for (let level = 0; level < 100_000; level += 1) deep = [deep];
    let refusal: unknown;
    try {
      await prepareScannerCollectionPublicationsV1({
        sourceRoot: root,
        catalogId: "mattpocock",
        batches: [batch],
        now: "2026-09-24T00:00:00.000Z",
        run: head,
        coverage: { ...coverage(), coverage: deep } as never,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(TypeError);
    expect((refusal as Error).message).toMatch(/nests deeper than 32 levels$/);
  });

  describe("reads caller input through descriptors, never invoking a getter", () => {
    let invoked: string[];
    beforeEach(() => {
      invoked = [];
    });
    const trap = <T extends object>(target: T, key: string, enumerable = true): T =>
      Object.defineProperty(target, key, {
        enumerable,
        configurable: true,
        get() {
          invoked.push(key);
          throw new Error(`getter ${key} invoked`);
        },
      });
    const refusal = async (
      overrides: Record<string, unknown>,
      trapped?: string,
    ): Promise<unknown> => {
      const input = {
        sourceRoot: root,
        catalogId: "mattpocock",
        batches: [batch],
        now: "2026-09-24T00:00:00.000Z",
        run: head,
        ...overrides,
      };
      try {
        await prepareScannerCollectionPublicationsV1(
          (trapped === undefined ? input : trap(input, trapped)) as never,
        );
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const expectTyped = (error: unknown, reason: RegExp) => {
      expect(invoked).toEqual([]);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toMatch(reason);
    };

    it("refuses a throwing index getter on batches typed", async () => {
      expectTyped(
        await refusal({ batches: trap([batch], "0") }),
        /^Scanner collection preparation: batches field 0 must be an enumerable data property$/,
      );
    });

    it("refuses a throwing coverage getter typed, on the input and on the supplied coverage", async () => {
      expectTyped(
        await refusal({ coverage: coverage() }, "coverage"),
        /^Scanner collection preparation: input$/,
      );
      expectTyped(
        await refusal({ coverage: trap(coverage(), "coverage") }),
        /^Scanner collection preparation: coverage field coverage must be an enumerable data property$/,
      );
      expectTyped(
        await refusal({ coverage: { ...coverage(), catalog: trap({}, "id", false) } }),
        /^Scanner collection preparation: coverage field id must be an enumerable data property$/,
      );
    });

    it("uses only the validated coverage: a Proxy's get trap never runs", async () => {
      const supplied = coverage();
      const proxy = new Proxy(supplied, {
        get() {
          invoked.push("get");
          throw new Error("get trap invoked");
        },
      });
      // One component means one Core request, so two batches fail only the batch count,
      // after the copied coverage drove the requests.
      expectTyped(
        await refusal({ coverage: proxy, batches: [batch, batch] }),
        /^Scanner collection preparation: publication batch count$/,
      );
    });
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
