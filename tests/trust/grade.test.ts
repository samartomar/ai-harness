import { describe, expect, it } from "vitest";
import type { Posture } from "../../src/config/posture.js";
import type { Check } from "../../src/internals/verify.js";
import { gradeTrustDanger } from "../../src/trust/grade.js";

function dangerousCheck(): Check {
  return {
    name: "trust prompt injection",
    verdict: "fail",
    detail: "hidden instruction in SKILL.md",
    code: "trust.prompt-injection",
    location: { uri: "skills/evil/SKILL.md", startLine: 3 },
    fingerprint: "trust-prompt-injection:skills/evil/SKILL.md:3:abc12345",
  };
}

describe("gradeTrustDanger", () => {
  it("keeps danger findings failing at every posture", () => {
    for (const _posture of ["vibe", "team", "enterprise"] satisfies Posture[]) {
      const graded = gradeTrustDanger(dangerousCheck());
      expect(graded.verdict).toBe("fail");
      expect(graded.code).toBe("trust.prompt-injection");
      expect(graded.detail).toContain("hidden instruction");
    }
  });
});
