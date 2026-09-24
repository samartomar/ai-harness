import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
/** A fixture carries a `record` value (sealed here as its canonical bytes) or its exact `bytes`. */
interface Fixture {
  readonly fixture: string;
  readonly structure: Outcome;
  readonly coreAdmission: Outcome;
  readonly record?: unknown;
  readonly bytes?: string;
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
/** Core's expected outcome for every shared case, and the defect a refusal must name. */
const EXPECTED: Record<string, readonly [Outcome, Outcome, RegExp?]> = {
  "asset-bound-twice": ["refused", "refused", /coverage asset bound twice/],
  "bytes-bom": ["refused", "refused", /invalid JSON/],
  "bytes-duplicate-key": ["refused", "refused", /duplicate JSON object key: inputFormat/],
  "bytes-escaped-not-nfc": ["refused", "refused", NOT_NFC],
  "bytes-number-exponent": ["refused", "refused", NOT_CANONICAL],
  "bytes-number-negative-zero": ["refused", "refused", /not negative zero/],
  "bytes-number-overflow": ["refused", "refused", /numbers must be finite/],
  "bytes-proto-key": ["refused", "refused", /has an unsupported field __proto__/],
  "bytes-raw-lone-surrogate": ["refused", "refused", LONE_SURROGATE],
  "bytes-trailing-data": ["refused", "refused", /invalid JSON/],
  "bytes-trailing-whitespace": ["refused", "refused", NOT_CANONICAL],
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

/** Seals the fixture (its exact bytes, or its record's canonical bytes, unvalidated) and reads it. */
function readSealed(fixture: Fixture): { structure: Outcome; admission: Outcome; reason: string } {
  const bytes = fixture.bytes ?? canonicalJson(fixture.record);
  const sha256 = `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
  try {
    const [record] = readPackagedScannerCollectionEvidenceStructureV1([{ bytes, sha256 }]);
    const admitted = PackagedScannerCollectionEvidenceRecordV1Schema.safeParse(record);
    return { structure: "accepted", admission: outcome(admitted), reason: issues(admitted) };
  } catch (error) {
    return { structure: "refused", admission: "refused", reason: (error as Error).message };
  }
}

describe("packaged collection evidence parity with Catalog", () => {
  it("holds exactly the shared cases", () => {
    expect(fixtures.map((item) => item.fixture).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(fixtures.map((item) => [item.fixture, item] as const))("%s", (name, fixture) => {
    const [structure, admission, reason] = EXPECTED[name] ?? [];
    expect([fixture.structure, fixture.coreAdmission]).toEqual([structure, admission]);
    expect("record" in fixture).not.toBe("bytes" in fixture);
    // The sealed reader: the boundary Catalog's reader mirrors byte for byte.
    const sealed = readSealed(fixture);
    expect([sealed.structure, sealed.admission]).toEqual([structure, admission]);
    if (fixture.bytes !== undefined) {
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
