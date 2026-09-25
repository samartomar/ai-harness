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
      "Full profile: an instructional example that calls the Nutrient document-processing service with a credential. ECC Lean does not select it.",
    matches: ({ path }) => path === "skills/nutrient-document-processing/SKILL.md",
  },
  {
    id: "x-api-authenticated-access",
    title: "X API authenticated access",
    surfaceClass: "instructional-example",
    automaticActivation: false,
    decision:
      "Full profile: an instructional example that calls the X API with a credential. ECC Lean does not select it.",
    matches: ({ path }) =>
      path === "skills/x-api/SKILL.md" || path === ".agents/skills/x-api/SKILL.md",
  },
  {
    id: "elevenlabs-media-egress",
    title: "ElevenLabs and media-generation egress",
    surfaceClass: "instructional-example",
    automaticActivation: false,
    decision:
      "Full profile: instructional examples that send media to ElevenLabs and media-generation services; they run only when a selected skill is invoked. ECC Lean does not select them.",
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
      "Full profile: a declaration of the browser-use remote MCP server; it takes effect only when the MCP component is selected. ECC Lean does not select it.",
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
      "Full profile: instructional examples that call the Jira and USPTO services. ECC Lean does not select them.",
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
      "Full profile: generic scraper, API, stylesheet, and media-fetch examples; none activates automatically. ECC Lean does not select them.",
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
      "Full profile: skills that declare broad Bash and Write tool permissions; the declarations take effect only when the owning skill is selected and loaded. ECC Lean does not select them.",
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
      "Full profile: a package lifecycle script (prepublishOnly) that runs when the package is published, not when it is materialized. ECC Lean does not select it.",
    matches: ({ path, sourceValue }) =>
      path === ".opencode/package.json" && sourceValue.includes("prepublishOnly"),
  },
  {
    id: "visa-document-translation-automatic-processing",
    title: "Visa document translation automatic processing",
    surfaceClass: "automatically-activated-behavior",
    automaticActivation: true,
    decision:
      "Full profile: a skill that processes images and runs generated scripts automatically, without asking for confirmation. ECC Lean does not select it.",
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
      "Full profile: an instructional example that calls the DuckDNS dynamic-DNS service with a token. ECC Lean does not select it.",
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
