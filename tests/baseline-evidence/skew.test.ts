import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BASELINE_EVIDENCE_SCHEMA_VERSION } from "../../src/baseline-evidence/schema.js";
import { classifyBaselineLockSkew } from "../../src/baseline-evidence/skew.js";

/**
 * The version-skew floor (locked 2026-08-06, "Break the coupling"). Once the
 * vendor evidence lock ships on its own cadence, an installed build can meet a
 * lock NEWER than itself. It must say so — loudly, and naming both versions —
 * rather than skipping the artifact and reporting the absence it caused.
 */
describe("classifyBaselineLockSkew", () => {
  it("publishes the latest-approved evidence-schema compatibility policy", () => {
    const policy = readFileSync(resolve("docs/security/baseline-evidence.md"), "utf8").replace(
      /\s+/g,
      " ",
    );

    expect(policy).toContain(
      "Only the evidence-lock schema version approved by the latest aih release is supported",
    );
    expect(policy).toContain("There is no N-1 evidence-schema compatibility commitment");
    expect(policy).toContain("Older and newer schema versions fail closed");
    expect(policy).toContain(
      "Revisit this policy only if unmanaged consumers are introduced or a maintainer explicitly commits to N-1 evidence-schema compatibility",
    );
  });

  it("accepts a lock declaring the schema version this build parses", () => {
    const skew = classifyBaselineLockSkew({
      schemaVersion: BASELINE_EVIDENCE_SCHEMA_VERSION,
      sources: [],
    });
    expect(skew).toEqual({ status: "supported", declared: BASELINE_EVIDENCE_SCHEMA_VERSION });
  });

  it("rejects a newer lock, naming the declared version, this build's version, and the remedy", () => {
    const skew = classifyBaselineLockSkew({
      schemaVersion: BASELINE_EVIDENCE_SCHEMA_VERSION + 1,
      sources: [],
    });
    expect(skew).toMatchObject({
      status: "too-new",
      declared: BASELINE_EVIDENCE_SCHEMA_VERSION + 1,
      supported: BASELINE_EVIDENCE_SCHEMA_VERSION,
    });
    expect(skew.status === "too-new" && skew.detail).toContain(
      `schema version ${BASELINE_EVIDENCE_SCHEMA_VERSION + 1}`,
    );
    expect(skew.status === "too-new" && skew.detail).toContain(
      `version ${BASELINE_EVIDENCE_SCHEMA_VERSION}`,
    );
    expect(skew.status === "too-new" && skew.detail).toContain("upgrade");
  });

  it("diagnoses skew from the version alone, without parsing components it cannot read", () => {
    // The whole point of a floor: a v2 lock may legally carry component shapes
    // this build's schema rejects. The version must be the diagnosis, not the
    // downstream parse error it would otherwise produce.
    const skew = classifyBaselineLockSkew({
      schemaVersion: BASELINE_EVIDENCE_SCHEMA_VERSION + 1,
      sources: [{ id: "ecc", componentsV2: "a shape this build has never seen" }],
    });
    expect(skew.status).toBe("too-new");
  });

  it("rejects a lock whose schema version is absent, fractional, or not a number", () => {
    for (const value of [
      { sources: [] },
      { schemaVersion: "1", sources: [] },
      { schemaVersion: 1.5, sources: [] },
      { schemaVersion: 0, sources: [] },
      { schemaVersion: Number.NaN, sources: [] },
    ]) {
      expect(classifyBaselineLockSkew(value).status).toBe("unreadable");
    }
  });

  it("rejects a lock that is not a JSON object", () => {
    for (const value of [null, undefined, 1, "lock", [], [{ schemaVersion: 1 }]]) {
      expect(classifyBaselineLockSkew(value).status).toBe("unreadable");
    }
  });
});
