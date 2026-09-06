import { BASELINE_SOURCES } from "../../internals/baseline-sources.js";
import {
  type BaselineCatalog,
  type BaselineCatalogComponent,
  defineBaselineCatalog,
} from "../catalog.js";

const SUPERPOWERS_SKILLS = [
  "brainstorming",
  "dispatching-parallel-agents",
  "executing-plans",
  "finishing-a-development-branch",
  "receiving-code-review",
  "requesting-code-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "using-git-worktrees",
  "using-superpowers",
  "verification-before-completion",
  "writing-plans",
  "writing-skills",
] as const;

const components: readonly BaselineCatalogComponent[] = [
  {
    id: "runtime:superpowers-plugin",
    paths: [
      ".claude-plugin",
      ".codex-plugin",
      ".cursor-plugin",
      ".kimi-plugin",
      ".opencode",
      ".pi",
      "gemini-extension.json",
      "hooks",
      "package.json",
      "scripts",
    ],
  },
  ...SUPERPOWERS_SKILLS.map((name) => ({
    id: `skill:${name}`,
    paths: [`skills/${name}`],
    skillContent: true as const,
  })),
];

function sourcePin(): string {
  for (const baseline of BASELINE_SOURCES) {
    const source = baseline.sources.find(
      (candidate) => candidate.owner === "obra" && candidate.repo === "Superpowers",
    );
    if (source) return source.pinnedSha;
  }
  throw new Error("baseline source registry is missing obra/Superpowers");
}

/** Source-local normalized Superpowers baseline input. */
export function superpowersBaselineCatalogV1(pin?: string): BaselineCatalog {
  return defineBaselineCatalog({
    id: "superpowers",
    owner: "obra",
    repo: "Superpowers",
    pinnedSha: pin ?? sourcePin(),
    components,
  });
}
