export const CHANGE_PROFILE_RULE_TABLE_VERSION = "1.0.0" as const;

export type ChangeProfileCategory =
  | "baseline"
  | "overlays"
  | "triggers"
  | "exclusions"
  | "escalations";

export interface ChangeProfileRule {
  readonly id: string;
  readonly ordinal: number;
  readonly category: ChangeProfileCategory;
}

const rules: ChangeProfileRule[] = [
  { id: "review.correctness", ordinal: 10, category: "baseline" },
  { id: "review.maintainability", ordinal: 20, category: "baseline" },
  { id: "review.verification", ordinal: 30, category: "baseline" },
  { id: "review.architecture", ordinal: 40, category: "exclusions" },
  { id: "language.typescript", ordinal: 100, category: "overlays" },
  { id: "language.javascript", ordinal: 110, category: "overlays" },
  { id: "language.python", ordinal: 120, category: "overlays" },
  { id: "language.go", ordinal: 130, category: "overlays" },
  { id: "language.rust", ordinal: 140, category: "overlays" },
  { id: "language.java", ordinal: 150, category: "overlays" },
  { id: "language.dotnet", ordinal: 160, category: "overlays" },
  { id: "framework.react", ordinal: 200, category: "overlays" },
  { id: "framework.vue", ordinal: 210, category: "overlays" },
  { id: "framework.angular", ordinal: 220, category: "overlays" },
  { id: "framework.nextjs", ordinal: 230, category: "overlays" },
  { id: "framework.express", ordinal: 240, category: "overlays" },
  { id: "framework.gin", ordinal: 250, category: "overlays" },
  { id: "framework.aws-cdk", ordinal: 260, category: "overlays" },
  { id: "framework.aws-sam", ordinal: 270, category: "overlays" },
  { id: "framework.serverless", ordinal: 280, category: "overlays" },
  { id: "risk.security", ordinal: 300, category: "triggers" },
  { id: "risk.dependencies", ordinal: 310, category: "triggers" },
  { id: "risk.database", ordinal: 320, category: "triggers" },
  { id: "risk.infrastructure", ordinal: 330, category: "triggers" },
  { id: "risk.api-contract", ordinal: 340, category: "triggers" },
  { id: "risk.ui", ordinal: 350, category: "triggers" },
  { id: "risk.ci", ordinal: 360, category: "triggers" },
  { id: "surface.documentation", ordinal: 400, category: "triggers" },
  { id: "surface.tests", ordinal: 410, category: "triggers" },
  { id: "surface.configuration", ordinal: 420, category: "triggers" },
  { id: "surface.scripts", ordinal: 430, category: "triggers" },
  { id: "surface.unknown", ordinal: 440, category: "triggers" },
  { id: "framework.ui-ambiguous", ordinal: 500, category: "escalations" },
  { id: "manifest.malformed", ordinal: 510, category: "escalations" },
  { id: "content.binary", ordinal: 520, category: "escalations" },
  { id: "content.submodule-unclassified", ordinal: 530, category: "escalations" },
  { id: "content.unreadable", ordinal: 540, category: "escalations" },
  { id: "content.oversized", ordinal: 550, category: "escalations" },
  { id: "content.unknown", ordinal: 560, category: "escalations" },
];

for (const rule of rules) Object.freeze(rule);
export const CHANGE_PROFILE_RULES: readonly ChangeProfileRule[] = Object.freeze(rules);
