import { describe, expect, it } from "vitest";
import type { Posture } from "../../src/config/posture.js";
import type { Check } from "../../src/internals/verify.js";
import { gradeTrustCheck, gradeTrustDanger, TRUST_ORIGIN_CODES } from "../../src/trust/grade.js";

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

function originCheck(): Check {
  return {
    name: "trust.unpinned-dependency",
    verdict: "fail",
    detail: "package.json:2 — direct dependency react uses unpinned version spec ^18.0.0",
    code: "trust.unpinned-dependency",
    location: { uri: "package.json", startLine: 2 },
    fingerprint: "trust-unpinned-dependency:package.json:2:abc12345",
  };
}

function legalTextCheck(): Check {
  return {
    name: "trust.legal-text-detector-finding",
    verdict: "fail",
    detail: "LICENSE:4 — generic legal-text heuristic",
    code: "trust.legal-text-detector-finding",
    location: { uri: "LICENSE", startLine: 4 },
    fingerprint: `trust-legal-text-detector-finding:LICENSE:${"a".repeat(64)}`,
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

describe("gradeTrustCheck", () => {
  it("keeps the trust-origin code set sealed to reviewable findings", () => {
    expect([...TRUST_ORIGIN_CODES].sort()).toEqual([
      "trust.legal-text-detector-finding",
      "trust.source-drift",
      "trust.unpinned-dependency",
      "trust.unsigned-source",
      "trust.untrusted-publisher",
      "trust.visible-unicode",
    ]);
  });

  it("grades origin findings as warning-only at vibe/team and blocking at enterprise", () => {
    for (const posture of ["vibe", "team"] satisfies Posture[]) {
      const graded = gradeTrustCheck(originCheck(), posture);
      expect(graded.verdict).toBe("pass");
      expect(graded.code).toBeUndefined();
      expect(graded.detail).toContain(`warning-only (${posture} posture)`);
      expect(graded.detail).toContain("direct dependency react");
    }

    const enterprise = gradeTrustCheck(originCheck(), "enterprise");
    expect(enterprise.verdict).toBe("fail");
    expect(enterprise.code).toBe("trust.unpinned-dependency");
  });

  it.each([
    ["vibe", "pass"],
    ["team", "fail"],
    ["enterprise", "fail"],
  ] as const)("grades legal-text findings at %s as %s", (posture, verdict) => {
    const graded = gradeTrustCheck(legalTextCheck(), posture);

    expect(graded.verdict).toBe(verdict);
    if (verdict === "fail") {
      expect(graded.code).toBe("trust.legal-text-detector-finding");
      expect(graded.fingerprint).toBe(legalTextCheck().fingerprint);
    }
  });

  it("leaves danger findings failing at every posture", () => {
    for (const posture of ["vibe", "team", "enterprise"] satisfies Posture[]) {
      const graded = gradeTrustCheck(dangerousCheck(), posture);
      expect(graded.verdict).toBe("fail");
      expect(graded.code).toBe("trust.prompt-injection");
    }
  });
});
