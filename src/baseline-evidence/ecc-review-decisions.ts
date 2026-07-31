export type ResidualSurfaceClass =
  | "instructional-example"
  | "declarative-configuration"
  | "installed-executable"
  | "automatically-activated-behavior";

export interface EccReviewOccurrence {
  findingFingerprint: string;
  path: string;
  line: number;
  sourceValue: string;
}

export interface EccResidualReviewDecision {
  id: string;
  title: string;
  surfaceClass: ResidualSurfaceClass;
  automaticActivation: boolean;
  decision: string;
  occurrenceFingerprints: string[];
  occurrences: EccReviewOccurrence[];
}

interface DecisionDefinition {
  id: string;
  title: string;
  surfaceClass: ResidualSurfaceClass;
  automaticActivation: boolean;
  decision: string;
  matches: (occurrence: EccReviewOccurrence) => boolean;
}

const DEFINITIONS: readonly DecisionDefinition[] = [
  {
    id: "nutrient-document-processing",
    title: "Nutrient external document-processing access",
    surfaceClass: "instructional-example",
    automaticActivation: false,
    decision:
      "REVIEW for the full profile; excluded from ECC Lean. Permit only with an explicit Nutrient egress and credential decision.",
    matches: ({ path }) => path === "skills/nutrient-document-processing/SKILL.md",
  },
  {
    id: "x-api-authenticated-access",
    title: "X API authenticated access",
    surfaceClass: "instructional-example",
    automaticActivation: false,
    decision:
      "REVIEW for the full profile; excluded from ECC Lean. Permit only with an explicit X API egress and credential decision.",
    matches: ({ path }) =>
      path === "skills/x-api/SKILL.md" || path === ".agents/skills/x-api/SKILL.md",
  },
  {
    id: "elevenlabs-media-egress",
    title: "ElevenLabs and media-generation egress",
    surfaceClass: "instructional-example",
    automaticActivation: false,
    decision:
      "REVIEW for the full profile; excluded from ECC Lean. Examples do not execute until a selected skill is invoked.",
    matches: ({ path }) =>
      [
        "skills/fal-ai-media/SKILL.md",
        ".agents/skills/fal-ai-media/SKILL.md",
        "skills/video-editing/SKILL.md",
        ".agents/skills/video-editing/SKILL.md",
      ].includes(path),
  },
  {
    id: "browser-use-remote-mcp",
    title: "browser-use remote MCP",
    surfaceClass: "declarative-configuration",
    automaticActivation: false,
    decision:
      "REVIEW for the full profile; excluded from ECC Lean. The declaration must not activate unless the MCP component is explicitly selected.",
    matches: ({ path, sourceValue }) =>
      path === "mcp-configs/mcp-servers.json" &&
      /"url"\s*:\s*"https:\/\/api\.browser-use\.com\/mcp"/.test(sourceValue),
  },
  {
    id: "jira-uspto-egress",
    title: "Jira and USPTO access",
    surfaceClass: "instructional-example",
    automaticActivation: false,
    decision:
      "REVIEW for the full profile; excluded from ECC Lean. Approve each service boundary before its owning capability is selected.",
    matches: ({ path }) =>
      path === "skills/jira-integration/SKILL.md" ||
      path === "skills/scientific-db-uspto-database/SKILL.md",
  },
  {
    id: "generic-example-egress",
    title: "Generic scraper, API, stylesheet, and media-fetch examples",
    surfaceClass: "instructional-example",
    automaticActivation: false,
    decision:
      "Retain as one full-profile REVIEW decision. The examples are not automatically activated and are excluded from ECC Lean.",
    matches: ({ path }) =>
      [
        "skills/autonomous-agent-harness/SKILL.md",
        "skills/data-scraper-agent/SKILL.md",
        "skills/frontend-slides/html-template.md",
        "skills/remotion-video-creation/rules/compositions.md",
      ].includes(path),
  },
  {
    id: "broad-bash-write-permissions",
    title: "Broad Bash and Write permissions",
    surfaceClass: "declarative-configuration",
    automaticActivation: false,
    decision:
      "REVIEW for the full profile. Tool declarations become effective only when the owning skill is selected and loaded; ECC Lean excludes these skills.",
    matches: ({ path }) =>
      [
        ".agents/skills/eval-harness/SKILL.md",
        ".agents/skills/mle-workflow/SKILL.md",
        "skills/inherit-legacy-style/SKILL.md",
      ].includes(path),
  },
  {
    id: "package-lifecycle-execution",
    title: "Package lifecycle execution",
    surfaceClass: "installed-executable",
    automaticActivation: false,
    decision:
      "REVIEW for the full profile; excluded from ECC Lean. Materialization alone must not invoke the package lifecycle command.",
    matches: ({ path, sourceValue }) =>
      path === ".opencode/package.json" && sourceValue.includes("prepublishOnly"),
  },
  {
    id: "visa-document-translation-automatic-processing",
    title: "Visa document translation automatic processing",
    surfaceClass: "automatically-activated-behavior",
    automaticActivation: true,
    decision:
      "REVIEW for the full profile; excluded from ECC Lean. Require explicit consent before image processing or generated-script execution.",
    matches: ({ path }) =>
      path === "skills/visa-doc-translate/SKILL.md" ||
      path === ".agents/skills/visa-doc-translate/SKILL.md",
  },
  {
    id: "duckdns-authenticated-access",
    title: "DuckDNS authenticated dynamic-DNS access",
    surfaceClass: "instructional-example",
    automaticActivation: false,
    decision:
      "REVIEW for the full profile; excluded from ECC Lean. Permit only with an explicit DuckDNS egress and credential-use decision.",
    matches: ({ path }) => path === "skills/homelab-wireguard-vpn/SKILL.md",
  },
];

export function groupEccResidualReviewDecisions(
  occurrences: readonly EccReviewOccurrence[],
): EccResidualReviewDecision[] {
  const seen = new Set<string>();
  for (const occurrence of occurrences) {
    if (seen.has(occurrence.findingFingerprint)) {
      throw new Error(
        `duplicate ECC review occurrence fingerprint: ${occurrence.findingFingerprint}`,
      );
    }
    seen.add(occurrence.findingFingerprint);
  }

  const grouped = DEFINITIONS.map((definition) => {
    const matches = occurrences.filter(definition.matches);
    return {
      id: definition.id,
      title: definition.title,
      surfaceClass: definition.surfaceClass,
      automaticActivation: definition.automaticActivation,
      decision: definition.decision,
      occurrenceFingerprints: matches.map((occurrence) => occurrence.findingFingerprint),
      occurrences: matches,
    };
  }).filter((decision) => decision.occurrences.length > 0);

  const groupedFingerprints = grouped.flatMap((decision) => decision.occurrenceFingerprints);
  const groupedSet = new Set(groupedFingerprints);
  if (groupedFingerprints.length !== groupedSet.size) {
    throw new Error("an ECC review occurrence matched more than one residual decision");
  }
  const ungrouped = occurrences.filter(
    (occurrence) => !groupedSet.has(occurrence.findingFingerprint),
  );
  if (ungrouped.length > 0) {
    throw new Error(
      `ungrouped ECC review occurrence(s): ${ungrouped
        .map((occurrence) => occurrence.findingFingerprint)
        .join(", ")}`,
    );
  }
  return grouped;
}
