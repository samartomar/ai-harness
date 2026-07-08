import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AIH_CONFIG_FILE,
  aihConfigJson,
  readAihConfig,
  readAihConfigBaseline,
  readAihConfigDiagnostic,
  readAihConfigPosture,
} from "../../src/config/marker.js";
import * as fsxn from "../../src/internals/fsxn.js";
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

  it("fails closed when a persisted baseline is invalid", () => {
    writeMarker({ schemaVersion: 1, contextDir: "ai-coding", baseline: "missing" });
    expect(readAihConfigDiagnostic(dir)).toEqual({ invalid: true, present: true });
    expect(() => readAihConfig(dir)).toThrow(/invalid baseline/);
    expect(() => readAihConfigBaseline(dir)).toThrow(/invalid baseline/);
  });

  it("fails closed when a persisted posture is invalid", () => {
    writeMarker({ schemaVersion: 1, contextDir: "ai-coding", posture: "community" });
    expect(readAihConfigDiagnostic(dir)).toEqual({ invalid: true, present: true });
    expect(() => readAihConfig(dir)).toThrow(/invalid posture/);
    expect(() => readAihConfigPosture(dir)).toThrow(/invalid posture/);
  });

  it("returns undefined on a context dir that traverses parents (reuses settings constraints)", () => {
    writeMarker({ schemaVersion: 1, contextDir: "../escape" });
    expect(readAihConfig(dir)).toBeUndefined();
  });

  it("diagnoses schema violations as present but invalid", () => {
    writeMarker({ schemaVersion: 2, contextDir: "ai-coding" });
    expect(readAihConfigDiagnostic(dir)).toEqual({ invalid: true, present: true });
  });

  it("stays fail-soft when the marker exists but cannot be read", () => {
    const spy = vi.spyOn(fsxn, "readIfExists").mockImplementation(() => {
      throw new Error("locked");
    });
    try {
      expect(readAihConfigDiagnostic(dir)).toEqual({ invalid: true, present: true });
      expect(readAihConfig(dir)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
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

  it("persists only non-default baseline choices", () => {
    expect(aihConfigJson("ai-coding", ["claude"], "ecc")).toEqual({
      schemaVersion: 1,
      contextDir: "ai-coding",
      targets: ["claude"],
    });
    expect(aihConfigJson("ai-coding", ["claude"], "gstack")).toEqual({
      schemaVersion: 1,
      contextDir: "ai-coding",
      targets: ["claude"],
      baseline: "gstack",
    });
  });

  it("parses a persisted non-default baseline", () => {
    writeMarker(aihConfigJson("ai-coding", ["claude"], "gsd"));
    expect(readAihConfig(dir)?.baseline).toBe("gsd");
  });

  it("round-trips through readAihConfig byte-for-byte", () => {
    const body = aihConfigJson("custom-canon", ["claude", "cursor"]);
    writeMarker(body);
    expect(readAihConfig(dir)).toEqual(body);
  });
});

describe("the marker file is committable (not git-ignored by aih's own patterns)", () => {
  /**
   * Minimal matcher for the glob shapes aih emits (`*.x`, `dir/*`, `dir/`, literal,
   * `!negation`). Applies patterns in ORDER with git's last-match-wins rule, so the
   * `!.aih/` (re-include dir) → `.aih/*` (re-ignore contents) → `!.aih/usage-record.mjs`
   * (re-include recorder) sequence resolves like real git: a bare `!.aih/` dir-reinclude
   * does NOT re-include everything beneath it, because the later `.aih/*` re-ignores it.
   */
  function ignoredBy(rel: string, patterns: string[]): boolean {
    const matches = (p: string): boolean => {
      if (p.endsWith("/*")) return rel.startsWith(p.slice(0, -1)); // `.aih/*` → anything under `.aih/`
      if (p.endsWith("/")) return rel === p.slice(0, -1) || rel.startsWith(p);
      if (p.startsWith("*")) return rel.endsWith(p.slice(1));
      return rel === p;
    };
    let ignored = false;
    for (const p of patterns) {
      const negated = p.startsWith("!");
      const body = negated ? p.slice(1) : p;
      // A bare directory re-include (`!.aih/`) restores traversal but doesn't itself
      // re-include children — only a matching negation for the child path does.
      if (negated && body.endsWith("/") && rel !== body.slice(0, -1)) continue;
      if (matches(body)) ignored = !negated;
    }
    return ignored;
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
    // The committed recorder must stay tracked (the `!.aih/usage-record.mjs` negation),
    // else every fresh clone hits MODULE_NOT_FOUND on hook events.
    expect(ignoredBy(".aih/usage-record.mjs", patterns)).toBe(false);
  });
});
