import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

describe("GovernanceDecisionV2 public contract", () => {
  it("publishes a strict, standalone DecisionV2 JSON Schema", () => {
    const schema = JSON.parse(
      readFileSync(join(root, "schemas/aih-governance-decision-v2.schema.json"), "utf8"),
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const valid = {
      format: "aih-governance-decision",
      version: 2,
      id: "decision-platform-tool",
      qualification: "organization-qualified",
      subject: {
        kind: "tool",
        id: "platform-review-tool",
        source: {
          type: "git",
          repository: "acme/review-tool",
          commit: "a".repeat(40),
          path: "tool.json",
        },
        sourceDigest: `sha256:${"a".repeat(64)}`,
        subjectDigest: `sha256:${"b".repeat(64)}`,
      },
      targets: ["claude", "codex"],
      allowedEffects: ["configure", "use"],
      policy: { id: "platform-policy", version: "2026.08", digest: `sha256:${"c".repeat(64)}` },
      control: { id: "review-control", digest: `sha256:${"d".repeat(64)}` },
      evidence: { id: "scan-record", digest: `sha256:${"e".repeat(64)}` },
      issuer: "platform-security",
      actor: "security-admin",
      reason: "The exact pinned subject passed the reviewed control.",
      issuedAt: "2026-08-01T00:00:00+00:00",
      notBefore: "2026-08-01T00:00:00+00:00",
      expiresAt: "2026-08-10T00:00:00+00:00",
      disposition: "approved",
      acceptedFindings: [],
      acceptedGaps: [],
      conditions: [],
    };

    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    for (const invalid of [
      { ...valid, qualification: "unqualified" },
      {
        ...valid,
        subject: {
          ...valid.subject,
          source: { type: "git", repository: "acme/review-tool", path: "tool.json" },
        },
      },
      { ...valid, targets: ["codex", "claude"] },
      { ...valid, allowedEffects: ["use", "configure"] },
      { ...valid, unsignedApproved: true },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
  });
});
