import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("packed AIH-managed usage proof contract", () => {
  it("uses installed packed bytes and proves refusal without fabricating authority", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["verify:cold-aih-managed-usage"]).toBe(
      "npm run build && node tools/verify-cold-aih-managed-usage.mjs",
    );

    const proof = readFileSync(resolve("tools/verify-cold-aih-managed-usage.mjs"), "utf8");
    expect(proof).toContain('resolve(consumer, "node_modules", "@aihq", "harness")');
    expect(proof).toContain("cold-managed-usage-unauthorized-effect-accepted");
    expect(proof).toContain("cold-managed-usage-refusal-wrote-output");
    expect(proof).toContain("no successful configure or revocation is claimed");
    expect(proof).toContain("delete env.AIH_POLICY_AUTHORITY_REPOSITORY");
    expect(proof).not.toMatch(/writeFileSync\([^\n]+(?:gh|attestation)/i);
  });
});
