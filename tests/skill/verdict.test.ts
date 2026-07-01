import { describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import type { SkillShape } from "../../src/skill/shape.js";
import { skillVerdict } from "../../src/skill/verdict.js";

function cleanShape(overrides: Partial<SkillShape> = {}): SkillShape {
  return {
    skillDirs: ["clean"],
    installScripts: false,
    mcpConfig: false,
    packageManifests: [],
    fullCodebaseAnalysis: false,
    ...overrides,
  };
}

const PASS: Check = { name: "trust scan", verdict: "pass", detail: "scanned 1 trust document(s)" };
const LICENSE_PASS: Check = { name: "skill license", verdict: "pass", detail: "LICENSE: MIT" };
const LICENSE_MISSING: Check = {
  name: "skill license",
  verdict: "fail",
  code: "trust.license-missing",
  detail: "no LICENSE file",
};
const DANGER: Check = {
  name: "trust.prompt-injection",
  verdict: "fail",
  code: "trust.prompt-injection",
  detail: "SKILL.md:3 — attempts to override prior/system instructions",
};
const FETCH_BLOCKED: Check = {
  name: "skill vet scan",
  verdict: "skip",
  code: "trust.fetch-blocked",
  detail: "remote source fetch is skipped in dry-run",
};
const DETECTOR_SKIP: Check = {
  name: "trust detector skillspector",
  verdict: "skip",
  code: "trust.detector-unavailable",
  detail: "DEGRADED-COVERAGE",
};
const OTHER_FAIL: Check = {
  name: "incoming MCP policy",
  verdict: "fail",
  code: "mcp.policy-denied",
  detail: ".mcp.json → mcpServers.hosted: third-party egress",
};

const CLEARED = { pinned: true, fetched: true };

describe("skillVerdict", () => {
  it("grades RED for a proven-dangerous finding and RED beats everything", () => {
    const graded = skillVerdict([DANGER, LICENSE_MISSING], cleanShape(), CLEARED);

    expect(graded.verdict).toBe("RED");
    expect(graded.reasons).toEqual([
      expect.stringContaining("trust.prompt-injection"),
      expect.stringContaining("no license was found"),
    ]);
  });

  it("grades UNKNOWN when the source was not fetched", () => {
    const graded = skillVerdict([FETCH_BLOCKED], cleanShape(), { pinned: true, fetched: false });

    expect(graded.verdict).toBe("UNKNOWN");
    expect(graded.reasons).toEqual([expect.stringContaining("not fetched")]);
  });

  it("grades UNKNOWN on a fetch-blocked check even when fetched is claimed", () => {
    const failedFetch: Check = { ...FETCH_BLOCKED, verdict: "fail" };
    const graded = skillVerdict([failedFetch], cleanShape(), CLEARED);

    expect(graded.verdict).toBe("UNKNOWN");
  });

  it("grades UNKNOWN on a detector-unavailable skip", () => {
    const graded = skillVerdict([PASS, LICENSE_PASS, DETECTOR_SKIP], cleanShape(), CLEARED);

    expect(graded.verdict).toBe("UNKNOWN");
    expect(graded.reasons).toEqual([expect.stringContaining("detector")]);
  });

  it("grades UNKNOWN when the license is missing", () => {
    const graded = skillVerdict([PASS, LICENSE_MISSING], cleanShape(), CLEARED);

    expect(graded.verdict).toBe("UNKNOWN");
    expect(graded.reasons).toEqual([expect.stringContaining("license")]);
  });

  it("grades UNKNOWN for an unpinned GitHub source", () => {
    const graded = skillVerdict([PASS, LICENSE_PASS], cleanShape(), {
      pinned: false,
      fetched: true,
    });

    expect(graded.verdict).toBe("UNKNOWN");
    expect(graded.reasons).toEqual([expect.stringContaining("not pinned")]);
  });

  it("grades YELLOW on shape triggers with all-pass checks", () => {
    for (const overrides of [
      { installScripts: true },
      { mcpConfig: true },
      { fullCodebaseAnalysis: true },
    ] satisfies Array<Partial<SkillShape>>) {
      const graded = skillVerdict([PASS, LICENSE_PASS], cleanShape(overrides), CLEARED);

      expect(graded.verdict).toBe("YELLOW");
      expect(graded.reasons).toEqual([expect.stringContaining("shape:")]);
    }
  });

  it("grades YELLOW on a non-danger failing check", () => {
    const graded = skillVerdict([PASS, LICENSE_PASS, OTHER_FAIL], cleanShape(), CLEARED);

    expect(graded.verdict).toBe("YELLOW");
    expect(graded.reasons).toEqual([expect.stringContaining("mcp.policy-denied")]);
  });

  it("lets UNKNOWN outrank YELLOW but not RED", () => {
    const unknownOverYellow = skillVerdict(
      [PASS, LICENSE_MISSING],
      cleanShape({ installScripts: true }),
      CLEARED,
    );
    expect(unknownOverYellow.verdict).toBe("UNKNOWN");

    const redOverUnknown = skillVerdict(
      [DANGER, LICENSE_MISSING],
      cleanShape({ installScripts: true }),
      { pinned: false, fetched: false },
    );
    expect(redOverUnknown.verdict).toBe("RED");
    expect(redOverUnknown.reasons.length).toBeGreaterThan(2);
  });

  it("grades GREEN with no reasons on the happy path", () => {
    const graded = skillVerdict([PASS, LICENSE_PASS], cleanShape(), CLEARED);

    expect(graded).toEqual({ verdict: "GREEN", reasons: [] });
  });
});
