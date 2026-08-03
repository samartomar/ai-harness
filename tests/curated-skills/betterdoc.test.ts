import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const skill = readFileSync(resolve("ai-coding/curated-skills/betterdoc/SKILL.md"), "utf8");
const router = readFileSync(resolve("ai-coding/RULE_ROUTER.md"), "utf8");
const extension = readFileSync(resolve("ai-coding/rules/project-canon-extension.md"), "utf8");

const referenceNames = [
  "artifact-preservation.md",
  "claim-ledger.md",
  "doc-types.md",
  "slop-lint.md",
] as const;

describe("repo-curated BetterDoc skill", () => {
  it("keeps the reusable reference surface aligned with packaged BetterDoc", () => {
    for (const name of referenceNames) {
      const packaged = readFileSync(
        resolve("packs/docs-quality/betterdoc/references", name),
        "utf8",
      );
      const curated = readFileSync(
        resolve("ai-coding/curated-skills/betterdoc/references", name),
        "utf8",
      );
      expect(curated, name).toBe(packaged);
    }
  });

  it("adds this public repository's evidence and privacy boundaries", () => {
    expect(skill).toContain("PUBLIC_DOCS_POLICY.md");
    expect(skill).toContain("ai-coding/rules/doc-and-truth-homes.md");
    expect(skill).toContain("docs/CONTROL_MATRIX.md");
    expect(skill).toContain("Never copy strategy, competitive analysis, pricing");
    expect(skill).toContain("Never hand-edit generated or byte-locked documentation");
  });

  it("uses direct documentation checks without applying AIH to this checkout", () => {
    expect(skill).toContain("Never run AIH against this checkout");
    expect(skill).toContain("npm run docs:lint");
    expect(skill).not.toMatch(/(?:aih|src\/cli\.ts|dist\/cli\.js)\s+docs-lint/i);
  });

  it("is routed for public documentation work across supported clients", () => {
    expect(router).toContain("ai-coding/curated-skills/betterdoc/SKILL.md");
    expect(extension).toContain("../curated-skills/betterdoc/SKILL.md");
  });
});
