import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("packed AIH-managed usage proof contract", () => {
  it("uses installed packed bytes for protected-file configure and revoke without fake authority", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["verify:cold-aih-managed-usage"]).toBe(
      "npm run build && node tools/verify-cold-aih-managed-usage.mjs",
    );

    const proof = readFileSync(resolve("tools/verify-cold-aih-managed-usage.mjs"), "utf8");
    expect(proof).toContain('resolve(consumer, "node_modules", "@aihq", "core")');
    expect(proof).toContain("cold-managed-usage-unauthorized-effect-accepted");
    expect(proof).toContain("cold-managed-usage-refusal-wrote-output");
    expect(proof).toContain("cold-managed-usage-malformed-authority-accepted");
    expect(proof).toContain("cold-managed-usage-revocation-left-recorder");
    expect(proof).toContain("protected PolicyBundle V2 configured, inspected, and revoked");
    expect(proof).toContain("delete env.AIH_POLICY_AUTHORITY_REPOSITORY");
    expect(proof).toContain("AIH_ORG_POLICY: policyPath");
    expect(proof).not.toMatch(/writeFileSync\([^\n]+(?:gh|attestation)/i);
  });
});
