/**
 * The aih ECC profile pinned at affaan-m/ECC 0c1d7be9, the revision the test
 * evidence under tests/fixtures/ecc-profile records. Test data only: the
 * plugin reads its profile and evidence from the Catalog descriptor's
 * `profileEvidence` section (src/profile/descriptor-evidence.ts).
 */
import type { ProjectionSourceTrust } from "../../src/profile/source-closure.js";

export const TRUSTED_MANIFEST_PINS = {
  "manifests/install-components.json": {
    rawSha256: "8eac72d3ab4eb41dc6feabadc7f80603999631186aeeb74b0e31019496054ed5",
    canonicalSha256: "2a16746d95a3ee19dc448ccdfdc0e54ef983085245f2d804f615df277ea14665",
  },
  "manifests/install-modules.json": {
    rawSha256: "9293e36a93d62d9016cf8eb13e852a882ac5b68503a5842de230c7d21431bbb7",
    canonicalSha256: "917a4f6961252078a9e8f43eccbe241ef1793f4d8d9d1f170873b824da6bb238",
  },
  "manifests/install-profiles.json": {
    rawSha256: "fddc15a7ea59c5069686eacd5ef90da805b867bed39ddad3ca391363329270f1",
    canonicalSha256: "ec57372aa886af63f6b847eee2c285d672dc35ff48b9ca2da939e215e566c2cb",
  },
} as const;

const ACTIVE_SKILLS = [
  "agent-architecture-audit",
  "agent-eval",
  "agent-harness-construction",
  "agentic-engineering",
  "ai-first-engineering",
  "api-connector-builder",
  "automation-audit-ops",
  "connections-optimizer",
  "content-hash-cache-pattern",
  "docker-patterns",
  "documentation-lookup",
  "dynamic-workflow-mode",
  "ecc-tools-cost-audit",
  "enterprise-agent-ops",
  "github-ops",
  "opensource-pipeline",
  "regex-vs-llm-structured-text",
  "search-first",
  "security-bounty-hunter",
  "security-review",
  "security-scan",
  "token-budget-advisor",
  "workspace-surface-audit",
];

export const AIH_ECC_PROFILE_TEMPLATE = {
  version: 1,
  source: {
    repository: "affaan-m/ECC",
    commit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
    package: "ecc-universal",
    packageVersion: "2.1.0",
    releaseAncestorCommit: "4da6deac1888690e7fb8572d097ee23db630f7a0",
    componentPath: "manifests/install-components.json",
    sourceHash: "8eac72d3ab4eb41dc6feabadc7f80603999631186aeeb74b0e31019496054ed5",
    normalizedHash: "8eac72d3ab4eb41dc6feabadc7f80603999631186aeeb74b0e31019496054ed5",
    manifestPins: TRUSTED_MANIFEST_PINS,
    license: "MIT",
  },
  selections: {
    baseline: ["core", "lang:typescript"],
    activeSkills: ACTIVE_SKILLS,
    warmReserveSkills: [
      "benchmark",
      "benchmark-methodology",
      "benchmark-optimization-loop",
      "canary-watch",
      "deep-research",
      "deployment-patterns",
      "gateguard",
      "parallel-execution-optimizer",
      "research-ops",
      "safety-guard",
      "team-agent-orchestration",
    ],
    coldReserve: "all-other-pinned-skills",
  },
  expected: { skills: 136, roles: 67, workflows: 94 },
  profileFlags: {
    defaultOn: ["continuity", "mcp-health", "repository-protection"],
    userOptIn: ["learning", "personal-observability"],
    onDemand: ["plan-canvas"],
  },
  mcpPolicy: {
    selected: ["code-review-graph", "codebase-memory-mcp", "context7", "serena"],
    disabled: ["ecc-memory-mcp", "github", "sequential-thinking", "token-savior"],
    activation: "aih-owned-native-registration",
  },
  aihAdaptedWorkflows: ["/auto-update", "/hookify", "/hookify-configure", "/project-init"],
  localPlannedSkills: ["learn-eval", "session-continuity"],
  repoCuratedSkills: ["aih-betterdoc", "decision-partner"],
  ownership: [
    {
      sourcePin: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
      sourcePath: "manifests/install-components.json",
      normalizedHash: "8eac72d3ab4eb41dc6feabadc7f80603999631186aeeb74b0e31019496054ed5",
      destination: "aih/ecc/profile.json",
      owner: "aih",
      mergeStrategy: "replace",
      previousHash: null,
    },
  ],
  state: { schemaVersion: 1, lifecycle: "active" },
} as const;

export const TRUSTED_PROJECTED_SOURCE: ProjectionSourceTrust = {
  id: "ecc-projected-source-closure-v1",
  evidencePath: "evidence/ecc/projected-source-closure-v1.json",
  evidenceSha256: "f610d0999ba4300be2ac3c08428da1249cdd53d7bf8d74722433fef0b013448e",
  sourceCommit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
  fileCount: 379,
  totalBytes: 2_672_419,
  aggregateSha256: "8dadd2c412511d690555243773f8bc4a0ed1e7ba43fc0804bc1d955b3b7bca37",
};
