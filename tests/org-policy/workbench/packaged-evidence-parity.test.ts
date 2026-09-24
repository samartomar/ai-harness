import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PackagedScannerCollectionEvidenceRecordV1Schema,
  PackagedScannerCollectionEvidenceStructureV1Schema,
} from "../../../src/org-policy/packaged-collection-evidence-v1.js";

// ---------------------------------------------------------------------------
// Decision D25: Core and Catalog apply IDENTICAL structural validation to a packaged
// collection evidence record; publisher admission is Core's alone. The fixtures are shared
// byte-identically with Catalog (see the README beside them), and each side asserts every
// fixture's outcome.
// ---------------------------------------------------------------------------

type Outcome = "accepted" | "refused";
interface Fixture {
  readonly fixture: string;
  readonly structure: Outcome;
  readonly coreAdmission: Outcome;
  readonly record: unknown;
}

const directory = resolve(import.meta.dirname, "..", "..", "fixtures", "packaged-evidence-parity");
const fixtures = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as Fixture);

const TIMESTAMP = /requires an exact UTC timestamp/;
const PUBLISHER = /unreviewed packaged publisher/;
const UNTRIMMED = /packaged report text must already be trimmed/;
/** Core's expected outcome for every shared case, and the defect a refusal must name. */
const EXPECTED: Record<string, readonly [Outcome, Outcome, RegExp?]> = {
  "asset-bound-twice": ["refused", "refused", /coverage asset bound twice/],
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

describe("packaged collection evidence parity with Catalog", () => {
  it("holds exactly the shared cases", () => {
    expect(fixtures.map((item) => item.fixture).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(fixtures.map((item) => [item.fixture, item] as const))("%s", (name, fixture) => {
    const [structure, admission, reason] = EXPECTED[name] ?? [];
    expect([fixture.structure, fixture.coreAdmission]).toEqual([structure, admission]);
    const structural = PackagedScannerCollectionEvidenceStructureV1Schema.safeParse(fixture.record);
    const admitted = PackagedScannerCollectionEvidenceRecordV1Schema.safeParse(fixture.record);
    expect(outcome(structural)).toBe(structure);
    expect(outcome(admitted)).toBe(admission);
    if (reason !== undefined)
      expect(issues(structural.success ? admitted : structural)).toMatch(reason);
  });
});
