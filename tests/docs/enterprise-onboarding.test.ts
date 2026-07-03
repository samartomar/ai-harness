import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";

const root = process.cwd();

function jsonBlocks(markdown: string): unknown[] {
  return [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1] ?? "{}"),
  );
}

describe("enterprise onboarding docs", () => {
  it("keeps org-policy examples valid", () => {
    const doc = readFileSync(join(root, "docs", "ENTERPRISE_ONBOARDING.md"), "utf8");
    const examples = jsonBlocks(doc);

    expect(examples).toHaveLength(2);
    for (const example of examples) {
      expect(() => parseOrgPolicy(example)).not.toThrow();
    }
  });
});
