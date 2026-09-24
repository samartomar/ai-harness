import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { reverifyPackagedAihScannerEvidenceRecordV1 } from "../../src/baseline-evidence/aih-scan-preparation.js";
import { reverifyPackagedScannerCollectionEvidenceRecordV1 } from "../../src/baseline-evidence/scanner-collection-preparation.js";
import { canonicalJson } from "../../src/capability/package-graph/canonical.js";
import {
  PackagedScannerCollectionEvidenceRecordV1Schema,
  readPackagedScannerCollectionEvidenceStructureV1,
} from "../../src/org-policy/packaged-collection-evidence-v1.js";

// Both live reverification paths read their sealed record through the packaged reader and then
// admission, so each refuses exactly what that boundary refuses, with its message, never a crash.

interface Fixture {
  readonly fixture: string;
  readonly record?: unknown;
  readonly bytes?: string;
  readonly input?: unknown;
}

const directory = resolve(import.meta.dirname, "..", "fixtures", "packaged-evidence-parity");
const fixtures = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as Fixture);

/** The fixture's single sealed wrapper; a wrapper list that is not an array has none. */
function sealedWrapper(fixture: Fixture): unknown {
  if ("input" in fixture) return Array.isArray(fixture.input) ? fixture.input[0] : undefined;
  const bytes = fixture.bytes ?? canonicalJson(fixture.record);
  return { bytes, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

/** The packaged boundary's refusal of one sealed wrapper, or undefined when it admits it. */
function boundaryRefusal(wrapper: unknown): string | undefined {
  try {
    for (const record of readPackagedScannerCollectionEvidenceStructureV1([wrapper]))
      PackagedScannerCollectionEvidenceRecordV1Schema.parse(record);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

const NOW = "2026-09-24T00:00:00.000Z";
const paths = {
  aih: (sealed: unknown, pinnedSha = "0".repeat(40)) =>
    reverifyPackagedAihScannerEvidenceRecordV1({
      packageRoot: resolve("."),
      coreRevision: { pinnedSha },
      catalog: {},
      compiled: {},
      batches: [],
      now: NOW,
      sealed,
    } as unknown as Parameters<typeof reverifyPackagedAihScannerEvidenceRecordV1>[0]),
  collection: (sealed: unknown) =>
    reverifyPackagedScannerCollectionEvidenceRecordV1({
      sourceRoot: resolve("."),
      catalogId: "mattpocock",
      batches: [],
      now: NOW,
      sealed,
    } as unknown as Parameters<typeof reverifyPackagedScannerCollectionEvidenceRecordV1>[0]),
};

const refused = fixtures.flatMap((fixture) => {
  const wrapper = sealedWrapper(fixture);
  if (wrapper === undefined) return [];
  const reason = boundaryRefusal(wrapper);
  return reason === undefined ? [] : [[fixture.fixture, wrapper, reason] as const];
});

describe("packaged record reverification boundary", () => {
  it("covers the shared refusals, including the nesting and wrapper cases", () => {
    expect(refused.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "bytes-deep-nesting",
        "bytes-proto-key",
        "publication-other-ref",
        "wrapper-extra-key",
        "wrapper-missing-sha256",
        "wrapper-proto-key",
      ]),
    );
  });

  it("keeps the AIH path's plain data-only wrapper", async () => {
    // An admitted AIH record at its own pin, so only the wrapper's shape can refuse it here.
    const valid = fixtures.find((fixture) => fixture.fixture === "valid") as Fixture;
    const { bytes, sha256 } = sealedWrapper(valid) as { bytes: string; sha256: string };
    const pin = (valid.record as { catalog: { pinnedCommit: string } }).catalog.pinnedCommit;
    await expect(paths.aih({ bytes, sha256 }, pin)).rejects.not.toThrow(/sealed AIH record/);
    for (const exotic of [
      Object.assign(Object.create(null), { bytes, sha256 }),
      { bytes, sha256, [Symbol("extra")]: true },
      Object.defineProperty({ sha256 } as Record<string, unknown>, "bytes", {
        enumerable: true,
        get: () => bytes,
      }),
    ]) {
      await expect(paths.aih(exotic, pin)).rejects.toThrow(
        /^AIH Scanner preparation: sealed AIH record$/,
      );
    }
  });

  it("refuses a throwing getter wrapper typed on both paths, without invoking it", async () => {
    const valid = fixtures.find((fixture) => fixture.fixture === "valid") as Fixture;
    const { sha256 } = sealedWrapper(valid) as { sha256: string };
    const invoked: string[] = [];
    const wrapper = () =>
      Object.defineProperty({ sha256 }, "bytes", {
        enumerable: true,
        get: () => {
          invoked.push("bytes");
          throw new Error("getter invoked");
        },
      });
    await expect(paths.aih(wrapper())).rejects.toThrow(
      /^AIH Scanner preparation: sealed AIH record$/,
    );
    await expect(paths.collection(wrapper())).rejects.toThrow(
      /record 0 field bytes must be an enumerable data property/,
    );
    expect(invoked).toEqual([]);
  });

  // The AIH path checks its own wrapper shape before the reader reads anything.
  const AIH_WRAPPER_SHAPE = new Set([
    "wrapper-extra-key",
    "wrapper-missing-sha256",
    "wrapper-proto-key",
  ]);
  for (const [path, reverify] of Object.entries(paths)) {
    it.each(refused)(
      `${path} refuses %s as the packaged reader does`,
      async (name, wrapper, boundaryReason) => {
        const reason =
          path === "aih" && AIH_WRAPPER_SHAPE.has(name)
            ? "AIH Scanner preparation: sealed AIH record"
            : boundaryReason;
        let refusal: unknown;
        try {
          await reverify(wrapper);
        } catch (error) {
          refusal = error;
        }
        // A refusal is a TypeError or ZodError; anything else (a RangeError, say) is a crash.
        expect(refusal instanceof TypeError || refusal instanceof ZodError).toBe(true);
        expect((refusal as Error).message).toBe(reason);
      },
    );
  }
});
