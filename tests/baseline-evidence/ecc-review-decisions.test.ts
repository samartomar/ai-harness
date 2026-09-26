import { describe, expect, it } from "vitest";
import {
  type EccReviewOccurrence,
  groupEccResidualReviewDecisions,
} from "../../src/baseline-evidence/ecc-review-decisions.js";

function occurrence(
  fingerprint: string,
  path: string,
  sourceValue = "example",
): EccReviewOccurrence {
  return { findingFingerprint: fingerprint, path, line: 1, sourceValue };
}

describe("ECC residual review decisions", () => {
  it("consolidates related source occurrences without losing fingerprints", () => {
    const occurrences = [
      occurrence("nutrient:1", "skills/nutrient-document-processing/SKILL.md"),
      occurrence("nutrient:2", "skills/nutrient-document-processing/SKILL.md"),
      occurrence("x:root", "skills/x-api/SKILL.md"),
      occurrence("x:copy", ".agents/skills/x-api/SKILL.md"),
      occurrence("media:root", "skills/fal-ai-media/SKILL.md"),
      occurrence("media:copy", ".agents/skills/video-editing/SKILL.md"),
      occurrence(
        "browser",
        "mcp-configs/mcp-servers.json",
        '"url": "https://api.browser-use.com/mcp"',
      ),
      occurrence("jira", "skills/jira-integration/SKILL.md"),
      occurrence("uspto", "skills/scientific-db-uspto-database/SKILL.md"),
      occurrence("scraper", "skills/data-scraper-agent/SKILL.md"),
      occurrence("permissions", ".agents/skills/eval-harness/SKILL.md"),
      occurrence("lifecycle", ".opencode/package.json", '"prepublishOnly": "npm run build"'),
      occurrence(
        "automatic-translation",
        "skills/visa-doc-translate/SKILL.md",
        "AUTOMATICALLY execute the following steps WITHOUT asking for confirmation",
      ),
      occurrence(
        "duckdns",
        "skills/homelab-wireguard-vpn/SKILL.md",
        '--data-urlencode "token=${DUCKDNS_TOKEN}"',
      ),
    ];

    const decisions = groupEccResidualReviewDecisions(occurrences);

    expect(decisions).toHaveLength(10);
    for (const decision of decisions) {
      // Each note states the surface and that ECC Lean does not select it; it never gates.
      expect(decision.decision).toMatch(/^Full profile: .+ ECC Lean does not select (it|them)\.$/);
      expect(decision.decision).not.toMatch(/excluded|permit|must not|require|approve|REVIEW/i);
    }
    expect(decisions.flatMap((decision) => decision.occurrenceFingerprints).sort()).toEqual(
      occurrences.map((entry) => entry.findingFingerprint).sort(),
    );
    expect(
      decisions.find((decision) => decision.id === "x-api-authenticated-access"),
    ).toMatchObject({
      surfaceClass: "instructional-example",
      automaticActivation: false,
      occurrenceFingerprints: ["x:root", "x:copy"],
    });
    expect(
      decisions.find((decision) => decision.id === "package-lifecycle-execution"),
    ).toMatchObject({
      surfaceClass: "installed-executable",
      automaticActivation: false,
    });
    expect(
      decisions.find(
        (decision) => decision.id === "visa-document-translation-automatic-processing",
      ),
    ).toMatchObject({
      surfaceClass: "automatically-activated-behavior",
      automaticActivation: true,
      occurrenceFingerprints: ["automatic-translation"],
    });
    expect(
      decisions.find((decision) => decision.id === "duckdns-authenticated-access"),
    ).toMatchObject({
      surfaceClass: "instructional-example",
      automaticActivation: false,
      occurrenceFingerprints: ["duckdns"],
    });
  });

  it("does not group a lookalike browser-use hostname", () => {
    const decisions = groupEccResidualReviewDecisions([
      occurrence(
        "lookalike",
        "mcp-configs/mcp-servers.json",
        '"url": "https://evil.example/?next=https://api.browser-use.com/mcp"',
      ),
    ]);
    expect(decisions.map((decision) => decision.id)).toEqual(["ungrouped"]);
  });

  it("labels an occurrence no recorded grouping matches as ungrouped instead of stopping (D64)", () => {
    const decisions = groupEccResidualReviewDecisions([
      occurrence("x:root", "skills/x-api/SKILL.md"),
      occurrence("unknown", "skills/unclassified/SKILL.md"),
    ]);
    expect(decisions.map((decision) => decision.id)).toEqual([
      "x-api-authenticated-access",
      "ungrouped",
    ]);
    expect(decisions[1]).toEqual({
      id: "ungrouped",
      title: "REVIEW occurrences with no recorded grouping",
      surfaceClass: "not-classified",
      automaticActivation: "not-determined",
      decision:
        "No recorded grouping matches these REVIEW occurrences. They are shown as findings for the consumer to decide on; a maintainer can add a grouping.",
      occurrenceFingerprints: ["unknown"],
      occurrences: [occurrence("unknown", "skills/unclassified/SKILL.md")],
    });
  });

  it("still refuses duplicate fingerprints and an occurrence matched by two groupings", () => {
    const duplicate = occurrence("same", "skills/x-api/SKILL.md");
    expect(() => groupEccResidualReviewDecisions([duplicate, duplicate])).toThrow(/duplicate/);
  });
});
