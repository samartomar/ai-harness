import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { materializeAihScanSubjectsV1 } from "../../src/baseline-evidence/aih-scan-material.js";
import {
  prepareAihScannerPublicationsV1,
  reverifyPackagedAihScannerEvidenceRecordV1,
} from "../../src/baseline-evidence/aih-scan-preparation.js";
import {
  assessCandidateWorkbenchCoverage,
  defineCandidateSourceInventory,
  prepareCandidateBaselineRequests,
} from "../../src/baseline-evidence/candidate-preparation.js";
import { reverifyPackagedScannerCollectionEvidenceRecordV1 } from "../../src/baseline-evidence/scanner-collection-preparation.js";
import { prepareSourceDataBaselineCoverageV1 } from "../../src/baseline-evidence/source-data-baseline-preparation.js";
import { cloneJsonValueStructureV1 } from "../../src/contract/strict-json-v1.js";

// Every exported preparation entry point reads a caller-supplied array or object through its
// descriptors before it reads any element or field, so a getter is never invoked: it is refused
// typed, and only the validated values are used afterwards.
const NOW = "2026-09-24T00:00:00.000Z";
const batch = () => ({ discoveryBytes: Buffer.from("{}"), publicationBytes: Buffer.from("{}") });
let invoked: string[];

beforeEach(() => {
  invoked = [];
});

function trap<T extends object>(target: T, key: string, enumerable = true): T {
  Object.defineProperty(target, key, {
    enumerable,
    configurable: true,
    get() {
      invoked.push(key);
      throw new Error(`getter ${key} invoked`);
    },
  });
  return target;
}

async function refusal(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function expectTypedRefusal(run: () => unknown, reason: RegExp): Promise<void> {
  const error = await refusal(run);
  expect(invoked).toEqual([]);
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).message).toMatch(reason);
}

const aihInput = (overrides: Record<string, unknown>) =>
  ({
    packageRoot: resolve("."),
    coreRevision: { pinnedSha: "0".repeat(40) },
    catalog: {},
    compiled: {},
    batches: [batch()],
    now: NOW,
    ...overrides,
  }) as never;

describe("preparation entry points read caller input through descriptors", () => {
  it("refuses a throwing index getter on AIH publication batches typed, without invoking it", async () => {
    await expectTypedRefusal(
      () => prepareAihScannerPublicationsV1(aihInput({ batches: trap([batch()], "0") })),
      /^AIH Scanner preparation: batches field 0 must be an enumerable data property$/,
    );
    await expectTypedRefusal(
      () => prepareAihScannerPublicationsV1(aihInput({ batches: trap([], "1") })),
      /^AIH Scanner preparation: batches field 1 must be an enumerable data property$/,
    );
  });

  it("refuses accessors on the AIH catalog, compilation and Core revision before reading them", async () => {
    await expectTypedRefusal(
      () => prepareAihScannerPublicationsV1(aihInput({ catalog: trap({}, "aihSkills") })),
      /^AIH Scanner preparation: catalog field aihSkills must be an enumerable data property$/,
    );
    await expectTypedRefusal(
      () =>
        prepareAihScannerPublicationsV1(
          aihInput({ compiled: { source: trap({}, "id", false), declarations: [] } }),
        ),
      /^AIH Scanner preparation: compiled field id must be an enumerable data property$/,
    );
    await expectTypedRefusal(
      () =>
        materializeAihScanSubjectsV1({
          packageRoot: resolve("."),
          coreRevision: { pinnedSha: "0".repeat(40) },
          catalog: {},
          compiled: trap({}, "declarations", false),
        } as never),
      /^AIH scan material: compiled field declarations must be an enumerable data property$/,
    );
  });

  it("never reads AIH reverification batches: the sealed record is refused first, then preparation checks them", async () => {
    await expectTypedRefusal(
      () =>
        reverifyPackagedAihScannerEvidenceRecordV1({
          ...(aihInput({ batches: trap([batch()], "0") }) as object),
          sealed: { bytes: "{}", sha256: "0".repeat(64) },
        } as never),
      /^Packaged collection evidence seal/,
    );
  });

  it("refuses accessors on the collection reverification input typed, before reading a field", async () => {
    const input = () => ({
      sourceRoot: resolve("."),
      catalogId: "mattpocock",
      batches: [batch()],
      now: NOW,
      sealed: { bytes: "{}", sha256: "0".repeat(64) },
    });
    for (const key of ["now", "sealed", "catalogId", "batches"]) {
      await expectTypedRefusal(
        () => reverifyPackagedScannerCollectionEvidenceRecordV1(trap(input(), key) as never),
        /^Scanner collection preparation: reverify input$/,
      );
    }
    await expectTypedRefusal(
      () =>
        reverifyPackagedScannerCollectionEvidenceRecordV1({
          ...input(),
          batches: trap([batch()], "0"),
        } as never),
      // As on the AIH path: the batches are never read before preparation checks them.
      /^Packaged collection evidence seal/,
    );
  });

  it("refuses accessors on candidate preparation input typed, before schema parsing reads them", async () => {
    await expectTypedRefusal(
      () => prepareCandidateBaselineRequests(trap({ sourceRoot: "." }, "inventory") as never),
      /^Candidate preparation: input field inventory must be an enumerable data property$/,
    );
    await expectTypedRefusal(
      () =>
        assessCandidateWorkbenchCoverage({
          inventory: trap({}, "source", false),
          requests: [],
        } as never),
      /^Candidate preparation: input field source must be an enumerable data property$/,
    );
    await expectTypedRefusal(
      () => defineCandidateSourceInventory(trap({}, "components")),
      /^Candidate preparation: inventory field components must be an enumerable data property$/,
    );
  });

  it("refuses a hidden accessor on source-data preparation input typed, before schema parsing reads it", async () => {
    await expectTypedRefusal(
      () => prepareSourceDataBaselineCoverageV1(".", trap({}, "framework", false)),
      /^Baseline source data field framework must be an enumerable data property$/,
    );
  });

  it("copies a Proxy through its descriptor traps only, so its get trap never runs", () => {
    const target = { alpha: [1, { beta: "two" }] };
    const proxy = new Proxy(target, {
      get() {
        invoked.push("get");
        throw new Error("get trap invoked");
      },
    });
    const copy = cloneJsonValueStructureV1(proxy, "fixture", 32);
    expect(invoked).toEqual([]);
    expect(copy).toEqual(target);
    expect(copy).not.toBe(target);
    expect(copy.alpha).not.toBe(target.alpha);
  });
});
