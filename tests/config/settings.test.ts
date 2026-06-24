import { describe, expect, it } from "vitest";
import { loadSettings } from "../../src/config/settings.js";
import { SettingsError } from "../../src/errors.js";

describe("loadSettings", () => {
  it("defaults to dry-run with ai-coding and the Zscaler CA pattern", () => {
    const s = loadSettings({});
    expect(s.apply).toBe(false);
    expect(s.contextDir).toBe("ai-coding");
    expect(s.caPattern).toBe("Zscaler");
  });

  it("reads AIH_* env defaults", () => {
    const s = loadSettings({
      AIH_APPLY: "1",
      AIH_CONTEXT_DIR: "ai-coding",
      AIH_CA_PATTERN: "Corp",
    });
    expect(s.apply).toBe(true);
    expect(s.contextDir).toBe("ai-coding");
    expect(s.caPattern).toBe("Corp");
  });

  it("lets CLI overrides win over env", () => {
    const s = loadSettings({ AIH_APPLY: "1" }, { apply: false });
    expect(s.apply).toBe(false);
  });

  it("throws SettingsError on a malformed boolean", () => {
    expect(() => loadSettings({ AIH_APPLY: "maybe" })).toThrow(SettingsError);
  });

  it("rejects a context dir that traverses parents", () => {
    expect(() => loadSettings({}, { contextDir: "../escape" })).toThrow(SettingsError);
  });
});
