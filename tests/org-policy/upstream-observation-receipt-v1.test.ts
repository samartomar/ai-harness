import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

describe("UpstreamObservationReceiptV1 public contract", () => {
  it("publishes a strict observation schema that does not turn approval into effective state", () => {
    const schema = JSON.parse(
      readFileSync(join(root, "schemas/aih-upstream-observation-receipt-v1.schema.json"), "utf8"),
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const valid = {
      format: "aih-upstream-observation-receipt",
      version: 1,
      decision: { id: "decision-platform-tool", digest: `sha256:${"a".repeat(64)}` },
      subject: {
        kind: "tool",
        id: "platform-review-tool",
        sourceDigest: `sha256:${"b".repeat(64)}`,
        subjectDigest: `sha256:${"c".repeat(64)}`,
      },
      targets: ["claude"],
      allowedEffects: ["configure"],
      installed: { id: "platform-review-tool", digest: `sha256:${"d".repeat(64)}` },
      verifier: { id: "upstream-admin", version: "1" },
      observedAt: "2026-08-02T00:00:00+00:00",
      outcome: "observed-success",
    };
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    for (const invalid of [
      { ...valid, outcome: "partial" },
      { ...valid, outcome: "drifted" },
      { ...valid, outcome: "revoked" },
      { ...valid, verifier: { id: "upstream-admin", version: "latest" } },
      { ...valid, approved: true },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
  });
});
