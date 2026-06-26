import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AIH_CONFIG_FILE, aihConfigJson, readAihConfig } from "../../src/config/marker.js";
import { aihIgnoreWrite } from "../../src/internals/gitignore.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-marker-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeMarker(body: unknown): void {
  writeFileSync(join(dir, AIH_CONFIG_FILE), JSON.stringify(body));
}

describe("readAihConfig", () => {
  it("parses a valid marker", () => {
    writeMarker({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude", "codex"] });
    expect(readAihConfig(dir)).toEqual({
      schemaVersion: 1,
      contextDir: "ai-coding",
      targets: ["claude", "codex"],
    });
  });

  it("defaults targets to [] when the field is absent", () => {
    writeMarker({ schemaVersion: 1, contextDir: "ai-coding" });
    expect(readAihConfig(dir)?.targets).toEqual([]);
  });

  it("returns undefined (no throw) when the marker is absent", () => {
    expect(readAihConfig(dir)).toBeUndefined();
  });

  it("returns undefined (no throw) on malformed JSON — fail-soft", () => {
    writeFileSync(join(dir, AIH_CONFIG_FILE), "{ not json");
    expect(readAihConfig(dir)).toBeUndefined();
  });

  it("returns undefined on a schema violation (wrong version)", () => {
    writeMarker({ schemaVersion: 2, contextDir: "ai-coding" });
    expect(readAihConfig(dir)).toBeUndefined();
  });

  it("returns undefined on a context dir that traverses parents (reuses settings constraints)", () => {
    writeMarker({ schemaVersion: 1, contextDir: "../escape" });
    expect(readAihConfig(dir)).toBeUndefined();
  });
});

describe("aihConfigJson", () => {
  it("builds the schemaVersion-1 marker body", () => {
    expect(aihConfigJson("ai-coding", ["claude"])).toEqual({
      schemaVersion: 1,
      contextDir: "ai-coding",
      targets: ["claude"],
    });
  });

  it("round-trips through readAihConfig byte-for-byte", () => {
    const body = aihConfigJson("custom-canon", ["claude", "cursor"]);
    writeMarker(body);
    expect(readAihConfig(dir)).toEqual(body);
  });
});

describe("the marker file is committable (not git-ignored by aih's own patterns)", () => {
  /** Minimal matcher for the three glob shapes aih emits (`*.x`, `.aih/`, literal). */
  function ignoredBy(rel: string, patterns: string[]): boolean {
    return patterns.some((p) => {
      if (p.endsWith("/")) return rel === p.slice(0, -1) || rel.startsWith(p);
      if (p.startsWith("*")) return rel.endsWith(p.slice(1));
      return rel === p;
    });
  }

  it("lives at the repo root, not under the git-ignored .aih/ dir", () => {
    expect(AIH_CONFIG_FILE).toBe(".aih-config.json");
    expect(AIH_CONFIG_FILE.includes("/")).toBe(false); // root-level, no nesting
    expect(AIH_CONFIG_FILE.startsWith(".aih/")).toBe(false);
  });

  it("is not matched by any of aih's generated .gitignore patterns", () => {
    // Tie the assertion to the REAL patterns aih writes, so adding the marker to
    // the ignore set in the future would fail this test loudly.
    const patterns = (aihIgnoreWrite(dir).contents ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    expect(ignoredBy(".aih-config.json", patterns)).toBe(false);
    // Sanity: the matcher DOES catch a real .aih/ artifact, so the negative above
    // is meaningful (not a matcher that never matches anything).
    expect(ignoredBy(".aih/report.html", patterns)).toBe(true);
  });
});
