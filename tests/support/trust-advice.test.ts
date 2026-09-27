import { describe, expect, it } from "vitest";
import type { CheckCode } from "../../src/internals/verify.js";
import { skillVetCommand } from "../../src/skill/vet.js";
import { toFinding } from "../../src/support/findings.js";
import { trustCodeClassV1 } from "../../src/trust/evidence.js";
import { trustScanCommand } from "../../src/trust/scan.js";
import { workspaceAddCommand } from "../../src/workspace/acquire.js";

// Finding and evidence-problem codes are labels: their advice says what was
// found and what the consumer can do, never that the source must be rejected.
const LABEL_CODES = [
  "trust.auto-exec-hook",
  "trust.dependency-confusion",
  "trust.hidden-unicode",
  "trust.malicious-code",
  "trust.prompt-injection",
  "trust.typosquat",
  "trust.unpinned-dependency",
  "trust.external-egress",
  "trust.license-missing",
  "trust.permission-risk",
  "trust.skill-metadata-license",
  "trust.cisco-finding",
  "trust.detector-finding",
  "trust.legal-text-detector-finding",
  "trust.visible-unicode",
  "trust.unreviewed-analyzer-rule",
  "trust.detector-unavailable",
  "trust.sandbox-smoke-unavailable",
  "trust.sandbox-smoke-failed",
  "trust.fetch-blocked",
] as const satisfies readonly CheckCode[];

const GATE_ADVICE =
  /\breject\b|do not (install|promote)|before promot|promotion requires|are blocking|do not block|never blocks/i;

describe("trust finding advice", () => {
  it.each(LABEL_CODES)("%s advice states a label, not a gate", (code) => {
    expect(["finding", "evidence-problem"]).toContain(trustCodeClassV1(code));
    const finding = toFinding({ name: code, verdict: "fail", code, detail: "x" }, "trust");
    expect(finding?.recommendedAction).not.toMatch(GATE_ADVICE);
  });
});

describe("org policy effective advice", () => {
  it("names only the reasons a candidate cannot take effect, never findings", () => {
    const finding = toFinding(
      {
        name: "org-policy.effective-blocked",
        verdict: "fail",
        code: "org-policy.effective-blocked",
        detail: "x",
      },
      "org-policy",
    );
    expect(finding?.title).toBe("requested org policy cannot take effect");
    expect(finding?.recommendedAction).toContain(
      "Findings and evidence problems are labels on the candidate",
    );
    expect(finding?.recommendedAction).not.toMatch(/cannot be approved|until evaluation passes/i);
  });
});

describe("trust help text", () => {
  const specs = [workspaceAddCommand, skillVetCommand, trustScanCommand];
  it.each(specs.map((spec) => [spec.name, spec] as const))(
    "%s states acknowledgements as records, not skips",
    (_name, spec) => {
      const texts = [spec.summary, ...(spec.options ?? []).map((option) => option.description)];
      for (const text of texts) {
        expect(text).not.toMatch(/\bskip (exact|every)\b|promote only after|trust-gate/i);
      }
      const acknowledge = spec.options?.find((option) => option.flags.startsWith("--acknowledge "));
      expect(acknowledge?.description).toMatch(/^record an acknowledgement of exact/);
    },
  );
});
