import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { canonicalJson } from "../../../src/capability/package-graph/canonical.js";
import {
  PackagedScannerCollectionEvidenceRecordV1Schema,
  PackagedScannerCollectionEvidenceStructureV1Schema,
  readPackagedScannerCollectionEvidenceStructureV1,
} from "../../../src/org-policy/packaged-collection-evidence-v1.js";

// ---------------------------------------------------------------------------
// Decision D25: Core and Catalog apply IDENTICAL structural validation to a packaged
// collection evidence record; publisher admission is Core's alone. The fixtures are shared
// byte-identically with Catalog (see the README beside them), and each side asserts every
// fixture's outcome.
// ---------------------------------------------------------------------------

type Outcome = "accepted" | "refused";
/**
 * A fixture carries a `record` value (sealed here as its canonical bytes), its exact `bytes`, or
 * the exact reader `input` (a list of sealed wrappers).
 */
interface Fixture {
  readonly fixture: string;
  readonly structure: Outcome;
  readonly coreAdmission: Outcome;
  readonly record?: unknown;
  readonly bytes?: string;
  readonly input?: unknown;
}

const directory = resolve(import.meta.dirname, "..", "..", "fixtures", "packaged-evidence-parity");
const fixtures = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as Fixture);

const TIMESTAMP = /requires an exact UTC timestamp/;
const PUBLISHER = /unreviewed packaged publisher/;
const UNTRIMMED = /packaged report text must already be trimmed/;
const NOT_NFC = /must already be NFC/;
const LONE_SURROGATE = /lone high surrogate/;
const NOT_CANONICAL = /must use canonical bytes/;
const TOO_DEEP = /nests deeper than 32 levels/;
const INVALID_JSON = /^invalid JSON packaged collection evidence/i;
/** Core's expected outcome for every shared case, and the defect a refusal must name. */
const EXPECTED: Record<string, readonly [Outcome, Outcome, RegExp?]> = {
  "asset-bound-twice": ["refused", "refused", /coverage asset bound twice/],
  "bytes-block-comment": ["refused", "refused", INVALID_JSON],
  "bytes-bom": ["refused", "refused", /invalid JSON/],
  "bytes-comment-masked-depth": ["refused", "refused", INVALID_JSON],
  "bytes-deep-nesting": ["refused", "refused", TOO_DEEP],
  "bytes-duplicate-key": ["refused", "refused", /duplicate JSON object key: inputFormat/],
  "bytes-escaped-not-nfc": ["refused", "refused", NOT_NFC],
  "bytes-line-comment": ["refused", "refused", INVALID_JSON],
  "bytes-nbsp-whitespace": ["refused", "refused", INVALID_JSON],
  "bytes-nesting-at-bound": ["refused", "refused", /unmappedDerivedAssets/],
  "bytes-nesting-over-bound": ["refused", "refused", TOO_DEEP],
  "bytes-number-exponent": ["refused", "refused", NOT_CANONICAL],
  "bytes-number-negative-zero": ["refused", "refused", /not negative zero/],
  "bytes-number-overflow": ["refused", "refused", /numbers must be finite/],
  "bytes-proto-key": ["refused", "refused", /has an unsupported field __proto__/],
  "bytes-raw-lone-surrogate": ["refused", "refused", LONE_SURROGATE],
  "bytes-trailing-comma-array": ["refused", "refused", INVALID_JSON],
  "bytes-trailing-comma-object": ["refused", "refused", INVALID_JSON],
  "bytes-trailing-data": ["refused", "refused", /invalid JSON/],
  "bytes-trailing-whitespace": ["refused", "refused", NOT_CANONICAL],
  "bytes-unbalanced-close": ["refused", "refused", INVALID_JSON],
  "bytes-unclosed": ["refused", "refused", INVALID_JSON],
  "bytes-valid": ["accepted", "accepted"],
  "publication-other-ref": ["accepted", "refused", PUBLISHER],
  "publication-unreviewed-commit": ["accepted", "refused", PUBLISHER],
  "report-analyzer-name-nbsp": ["refused", "refused", UNTRIMMED],
  "report-analyzer-name-untrimmed": ["refused", "refused", UNTRIMMED],
  "report-analyzer-proto-key": ["refused", "refused", /unsupported field __proto__/],
  "report-analyzer-version-untrimmed": ["refused", "refused", UNTRIMMED],
  "report-finding-code-untrimmed": ["refused", "refused", UNTRIMMED],
  "report-finding-count-unsafe-integer": ["refused", "refused", /findings\.0\.count/],
  "report-finding-detail-untrimmed": ["refused", "refused", UNTRIMMED],
  "report-finding-fingerprint-untrimmed": ["refused", "refused", UNTRIMMED],
  "report-finding-fingerprints-untrimmed": ["refused", "refused", UNTRIMMED],
  "report-findings": ["accepted", "accepted"],
  "string-lone-surrogate": ["refused", "refused", LONE_SURROGATE],
  "string-not-nfc": ["refused", "refused", NOT_NFC],
  "string-not-nfc-in-report": ["refused", "refused", NOT_NFC],
  "subject-and-subjects": ["refused", "refused", /coverage\.components\.0/],
  "subject-missing": ["refused", "refused", /coverage\.components\.0/],
  subjects: ["accepted", "accepted"],
  "subjects-duplicate-asset": ["refused", "refused", /coverage asset bound twice/],
  "subjects-empty": ["accepted", "accepted"],
  "subjects-unsorted": ["refused", "refused", /coverage subjects out of order/],
  "timestamp-expires-with-offset": ["refused", "refused", TIMESTAMP],
  "timestamp-prepared-hour-24": ["refused", "refused", TIMESTAMP],
  "timestamp-prepared-impossible-date": ["refused", "refused", TIMESTAMP],
  "timestamp-prepared-lowercase": ["refused", "refused", TIMESTAMP],
  "timestamp-prepared-one-fraction-digit": ["refused", "refused", TIMESTAMP],
  "timestamp-published-six-fraction-digits": ["refused", "refused", TIMESTAMP],
  "timestamp-signed-without-seconds": ["refused", "refused", TIMESTAMP],
  "timestamp-whole-seconds": ["accepted", "accepted"],
  valid: ["accepted", "accepted"],
  "wrapper-extra-key": ["refused", "refused", /record 0 has unsupported field extra/],
  "wrapper-missing-sha256": ["refused", "refused", /record 0 is missing sha256/],
  "wrapper-not-array": ["refused", "refused", /records must be an array/],
  "wrapper-proto-key": ["refused", "refused", /record 0 has unsupported field __proto__/],
  "wrapper-valid": ["accepted", "accepted"],
};

function outcome(result: { success: boolean }): Outcome {
  return result.success ? "accepted" : "refused";
}

function issues(result: {
  error?: { issues: readonly { message: string; path: readonly PropertyKey[] }[] };
}): string {
  return (result.error?.issues ?? [])
    .map((issue) => `${issue.message} @${issue.path.map(String).join(".")}`)
    .join("\n");
}

function sealedInput(fixture: Fixture): unknown {
  if ("input" in fixture) return fixture.input;
  const bytes = fixture.bytes ?? canonicalJson(fixture.record);
  return [{ bytes, sha256: `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}` }];
}

/**
 * Reads the fixture's reader input: its wrappers, or its exact bytes or its record's canonical
 * bytes (unvalidated), sealed. A refusal is a TypeError or a ZodError; anything else (a
 * RangeError, say) is a crash.
 */
function readSealed(fixture: Fixture): { structure: Outcome; admission: Outcome; reason: string } {
  try {
    const [record] = readPackagedScannerCollectionEvidenceStructureV1(sealedInput(fixture));
    const admitted = PackagedScannerCollectionEvidenceRecordV1Schema.safeParse(record);
    return { structure: "accepted", admission: outcome(admitted), reason: issues(admitted) };
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof ZodError)) throw error;
    return { structure: "refused", admission: "refused", reason: error.message };
  }
}

/**
 * Reader inputs JSON cannot express, so no shared fixture carries them. Catalog's parity test holds
 * the same cases and reasons: both readers refuse each one typed, and never invoke a getter.
 */
function unrepresentableInputs(item: { bytes: string; sha256: string }) {
  const invoked: string[] = [];
  const getter = (name: string) => () => {
    invoked.push(name);
    throw new Error(`getter ${name} invoked`);
  };
  const hidden = (key: string) =>
    Object.defineProperty({ ...item }, key, { value: true, enumerable: false });
  const index = (descriptor: PropertyDescriptor) =>
    Object.defineProperty([] as unknown[], "0", { configurable: true, ...descriptor });
  class Wrapper {}
  class Records extends Array<unknown> {}
  const refused: [string, unknown, RegExp][] = [
    [
      "wrapper non-enumerable extra",
      [hidden("extra")],
      /record 0 field extra must be an enumerable data property/,
    ],
    [
      "wrapper non-enumerable __proto__",
      [hidden("__proto__")],
      /record 0 field __proto__ must be an enumerable data property/,
    ],
    [
      "wrapper symbol key",
      [{ ...item, [Symbol("extra")]: true }],
      /record 0 must not contain symbol properties/,
    ],
    [
      "wrapper throwing getter",
      [
        Object.defineProperty({ sha256: item.sha256 }, "bytes", {
          enumerable: true,
          get: getter("bytes"),
        }),
      ],
      /record 0 field bytes must be an enumerable data property/,
    ],
    [
      "wrapper class instance",
      [Object.assign(new Wrapper(), item)],
      /record 0 has an unsupported object prototype/,
    ],
    [
      "list non-enumerable index",
      index({ value: item, enumerable: false, writable: true }),
      /records field 0 must be an enumerable data property/,
    ],
    [
      "list throwing getter index",
      index({ enumerable: true, get: getter("0") }),
      /records field 0 must be an enumerable data property/,
    ],
    [
      "list extra key",
      Object.assign([item], { extra: true }),
      /records must contain only indexed elements, with no holes/,
    ],
    [
      "list symbol key",
      Object.assign([item], { [Symbol("extra")]: true }),
      /records must not contain symbol properties/,
    ],
    ["list subclass", Records.from([item]), /records has an unsupported array prototype/],
  ];
  return { invoked, refused, accepted: [[Object.assign(Object.create(null), item)]] };
}

describe("packaged collection evidence parity with Catalog", () => {
  it("refuses reader inputs JSON cannot express, typed and without invoking a getter", () => {
    const [item] = sealedInput(
      fixtures.find((fixture) => fixture.fixture === "valid") as Fixture,
    ) as { bytes: string; sha256: string }[];
    const { invoked, refused, accepted } = unrepresentableInputs(
      item as { bytes: string; sha256: string },
    );
    for (const [name, input, reason] of refused) {
      let refusal: unknown;
      try {
        readPackagedScannerCollectionEvidenceStructureV1(input);
      } catch (error) {
        refusal = error;
      }
      expect(refusal, name).toBeInstanceOf(TypeError);
      expect((refusal as Error).message, name).toMatch(reason);
    }
    for (const input of accepted)
      expect(readPackagedScannerCollectionEvidenceStructureV1(input)).toHaveLength(1);
    expect(invoked).toEqual([]);
  });

  it("refuses record values JSON cannot express, typed and without invoking a getter", () => {
    const valid = (fixtures.find((fixture) => fixture.fixture === "valid") as Fixture)
      .record as Record<string, unknown>;
    const invoked: string[] = [];
    // 100,000 levels nested through non-enumerable index properties, which Object.keys misses.
    let deep: unknown = 0;
    for (let level = 0; level < 100_000; level += 1)
      deep = Object.defineProperty([], "0", { value: deep, enumerable: false, writable: true });
    const cases: [unknown, RegExp][] = [
      [{ ...valid, x: deep }, /field 0 must be an enumerable data property/],
      [
        Object.defineProperty({ ...valid }, "extra", { value: 1, enumerable: false }),
        /field extra must be an enumerable data property/,
      ],
      [{ ...valid, [Symbol("extra")]: 1 }, /must not contain symbol properties/],
      [
        Object.defineProperty({ ...valid }, "authority", {
          enumerable: true,
          get: () => {
            invoked.push("authority");
            throw new Error("getter invoked");
          },
        }),
        /field authority must be an enumerable data property/,
      ],
    ];
    for (const [value, reason] of cases) {
      const result = PackagedScannerCollectionEvidenceStructureV1Schema.safeParse(value);
      expect(result.success).toBe(false);
      expect(issues(result)).toMatch(reason);
    }
    expect(invoked).toEqual([]);
  });

  it("refuses a record value nested past the bound, before any recursive check", () => {
    let deep: unknown = 0;
    for (let level = 0; level < 100_000; level += 1) deep = [deep];
    const result = PackagedScannerCollectionEvidenceStructureV1Schema.safeParse({ x: deep });
    expect(result.success).toBe(false);
    expect(issues(result)).toMatch(TOO_DEEP);
  });

  it("refuses a hole in the sealed record list", () => {
    const [item] = sealedInput(
      fixtures.find((fixture) => fixture.fixture === "valid") as Fixture,
    ) as unknown[];
    const sparse: unknown[] = [];
    sparse[1] = item;
    expect(() => readPackagedScannerCollectionEvidenceStructureV1(sparse)).toThrow(
      /records must contain only indexed elements, with no holes/,
    );
  });

  it("holds exactly the shared cases", () => {
    expect(fixtures.map((item) => item.fixture).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(fixtures.map((item) => [item.fixture, item] as const))("%s", (name, fixture) => {
    const [structure, admission, reason] = EXPECTED[name] ?? [];
    expect([fixture.structure, fixture.coreAdmission]).toEqual([structure, admission]);
    expect(["record", "bytes", "input"].filter((form) => form in fixture)).toHaveLength(1);
    // The sealed reader: the boundary Catalog's reader mirrors byte for byte.
    const sealed = readSealed(fixture);
    expect([sealed.structure, sealed.admission]).toEqual([structure, admission]);
    if (!("record" in fixture)) {
      if (reason !== undefined) expect(sealed.reason).toMatch(reason);
      return;
    }
    // The structural schema over the record value.
    const structural = PackagedScannerCollectionEvidenceStructureV1Schema.safeParse(fixture.record);
    const admitted = PackagedScannerCollectionEvidenceRecordV1Schema.safeParse(fixture.record);
    expect(outcome(structural)).toBe(structure);
    expect(outcome(admitted)).toBe(admission);
    if (reason !== undefined)
      expect(issues(structural.success ? admitted : structural)).toMatch(reason);
  });
});
