import { describe, expect, it } from "vitest";
import type { Posture } from "../../src/config/posture.js";
import type { Check } from "../../src/internals/verify.js";
import {
  gradeTrustCheck,
  gradeTrustDanger,
  TRUST_REVIEW_CODES,
  TRUST_WARN_CODES,
} from "../../src/trust/grade.js";

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

function unpinnedCheck(): Check {
  return {
    name: "trust.unpinned-dependency",
    verdict: "fail",
    detail: "package.json:2 — direct dependency react uses unpinned version spec ^18.0.0",
    code: "trust.unpinned-dependency",
    location: { uri: "package.json", startLine: 2 },
    fingerprint: "trust-unpinned-dependency:package.json:2:abc12345",
  };
}

function reviewCheck(): Check {
  return {
    name: "trust.external-egress",
    verdict: "fail",
    detail: "authenticated external request",
    code: "trust.external-egress",
    location: { uri: "skills/example/SKILL.md", startLine: 10 },
    fingerprint: "trust-external-egress:skills/example/SKILL.md:abc12345",
  };
}

function genericDetectorCheck(): Check {
  return {
    name: "trust.detector-finding",
    verdict: "fail",
    detail: "SkillSpector: broad autonomous behavior",
    code: "trust.detector-finding",
  };
}

function visibleUnicodeCheck(): Check {
  return {
    name: "trust.visible-unicode",
    verdict: "fail",
    detail: "ordinary Chinese document labels",
    code: "trust.visible-unicode",
    location: { uri: "skills/translate/SKILL.md", startLine: 50 },
    fingerprint: "trust-visible-unicode:skills/translate/SKILL.md:abc12345",
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
    for (const _posture of ["vibe", "enterprise", "enterprise"] satisfies Posture[]) {
      const graded = gradeTrustDanger(dangerousCheck());
      expect(graded.verdict).toBe("fail");
      expect(graded.code).toBe("trust.prompt-injection");
      expect(graded.detail).toContain("hidden instruction");
    }
  });
});

describe("gradeTrustCheck", () => {
  it("keeps the review and warning code sets explicit", () => {
    expect([...TRUST_REVIEW_CODES].sort()).toEqual([
      "trust.external-egress",
      "trust.license-missing",
      "trust.permission-risk",
      "trust.skill-metadata-license",
      "trust.untrusted-publisher",
    ]);
    expect([...TRUST_WARN_CODES].sort()).toEqual([
      "trust.cisco-finding",
      "trust.detector-finding",
      "trust.legal-text-detector-finding",
      "trust.visible-unicode",
    ]);
  });

  it("grades review findings as warning-only at vibe/team and blocking at enterprise", () => {
    for (const posture of ["vibe", "enterprise"] satisfies Posture[]) {
      const graded = gradeTrustCheck(reviewCheck(), posture);
      expect(graded.verdict).toBe("pass");
      expect(graded.code).toBeUndefined();
      expect(graded.detail).toContain(`warning-only (${posture} posture)`);
      expect(graded.detail).toContain("authenticated external request");
    }

    const enterprise = gradeTrustCheck(reviewCheck(), "enterprise");
    expect(enterprise.verdict).toBe("fail");
    expect(enterprise.code).toBe("trust.external-egress");
  });

  it("keeps warning findings non-blocking and visible at every posture", () => {
    for (const check of [genericDetectorCheck(), legalTextCheck(), visibleUnicodeCheck()]) {
      for (const posture of ["vibe", "enterprise", "enterprise"] satisfies Posture[]) {
        const graded = gradeTrustCheck(check, posture);
        expect(graded.verdict).toBe("pass");
        expect(graded.code).toBeUndefined();
        expect(graded.detail).toContain(`warning-only (${posture} posture)`);
      }
    }
  });

  it("keeps unpinned executable dependencies blocking at every posture", () => {
    for (const posture of ["vibe", "enterprise", "enterprise"] satisfies Posture[]) {
      const graded = gradeTrustCheck(unpinnedCheck(), posture);
      expect(graded.verdict).toBe("fail");
      expect(graded.code).toBe("trust.unpinned-dependency");
    }
  });

  it("leaves danger findings failing at every posture", () => {
    for (const posture of ["vibe", "enterprise", "enterprise"] satisfies Posture[]) {
      const graded = gradeTrustCheck(dangerousCheck(), posture);
      expect(graded.verdict).toBe("fail");
      expect(graded.code).toBe("trust.prompt-injection");
    }
  });
});
