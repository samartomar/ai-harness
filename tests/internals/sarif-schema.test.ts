import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { reportToSarif } from "../../src/internals/sarif.js";
import { VerificationReport } from "../../src/internals/verify.js";

// #36 — validate emitted SARIF against the official SARIF 2.1.0 schema, offline.
// The schema fixture is the vendored copy of https://json.schemastore.org/sarif-2.1.0.json
// (draft-07); no network in the unit suite. A regression (bad field, wrong nesting) fails
// CI here instead of only when GitHub code-scanning rejects the upload.
const schema = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "sarif-2.1.0.schema.json"),
    "utf8",
  ),
);

// strict:false — the published SARIF schema uses constructs ajv's strict mode warns on; we
// validate documents against it, not lint the schema itself.
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validateSarifDoc = ajv.compile(schema);

function assertSchemaValid(sarifJson: string): void {
  const ok = validateSarifDoc(JSON.parse(sarifJson));
  if (!ok) {
    throw new Error(
      `emitted SARIF is not 2.1.0 schema-valid:\n${JSON.stringify(validateSarifDoc.errors, null, 2)}`,
    );
  }
}

describe("reportToSarif — SARIF 2.1.0 schema conformance (#36)", () => {
  it("emits schema-valid SARIF for a mixed report (pass/fail/skip + file-backed finding)", () => {
    const report = new VerificationReport()
      .pass("router present", "router present")
      .fail("bootloader CLAUDE.md in sync", "drifted from the canonical block — regenerate")
      .skip("claude installed", "not detected on this machine")
      .add({
        name: "plaintext-secret",
        verdict: "fail",
        detail: ".env — plaintext secret on disk",
        location: { uri: ".env", startLine: 1 },
        fingerprint: "plaintext-secret:.env",
      });
    expect(() => assertSchemaValid(reportToSarif(report))).not.toThrow();
  });

  it("emits schema-valid SARIF for a report with no checks (empty results + rules)", () => {
    expect(() => assertSchemaValid(reportToSarif(new VerificationReport()))).not.toThrow();
  });

  it("emits schema-valid SARIF under a custom tool name (aih-secrets)", () => {
    expect(() =>
      assertSchemaValid(reportToSarif(new VerificationReport().fail("x", "y"), "aih-secrets")),
    ).not.toThrow();
  });
});
