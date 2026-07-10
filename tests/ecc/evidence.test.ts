import { describe, expect, it } from "vitest";
import { eccEvidenceComponentIds } from "../../src/ecc/evidence.js";

describe("ECC evidence component selection", () => {
  it("covers the complete existing core profile plus installer runtime", () => {
    expect(eccEvidenceComponentIds("core", "claude", [])).toEqual([
      "runtime:ecc-installer",
      "module:rules-core",
      "module:agents-core",
      "module:commands-core",
      "module:hooks-runtime",
      "module:platform-configs",
      "module:workflow-quality",
    ]);
  });

  it("adds the framework-language module for current stack pack aliases", () => {
    expect(eccEvidenceComponentIds("core", "claude", ["typescript", "web"])).toEqual([
      "runtime:ecc-installer",
      "module:rules-core",
      "module:agents-core",
      "module:commands-core",
      "module:hooks-runtime",
      "module:platform-configs",
      "module:framework-language",
      "module:workflow-quality",
    ]);
  });

  it("filters modules the selected upstream target cannot install", () => {
    const antigravity = eccEvidenceComponentIds("full", "antigravity", []);
    expect(antigravity).toContain("module:rules-core");
    expect(antigravity).toContain("module:agents-core");
    expect(antigravity).not.toContain("module:hooks-runtime");
    expect(antigravity).not.toContain("module:media-generation");
    expect(antigravity).not.toContain("module:orchestration");
  });

  it("covers all 23 modules selected by the pinned full profile for Claude", () => {
    const full = eccEvidenceComponentIds("full", "claude", []);
    expect(full[0]).toBe("runtime:ecc-installer");
    expect(full.filter((id) => id.startsWith("module:"))).toHaveLength(23);
  });

  it("rejects a profile absent from the pinned profile snapshot", () => {
    expect(() => eccEvidenceComponentIds("unknown", "claude", [])).toThrow(/profile/i);
  });
});
