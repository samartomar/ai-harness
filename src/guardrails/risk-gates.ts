/**
 * Named risk-gate categories: high-risk change classes that warrant a deliberate
 * "ask" (never a hard deny) before an agent proceeds.
 *
 * Data ported verbatim from LeanHarness `.lh/policies/risk-gates.yml` (MIT,
 * Copyright (c) 2026 LeanHarness contributors) — every category name, description,
 * `path_patterns`, `command_patterns`, and the `behavior: ask` invariant are
 * preserved. The enforcement notes are ported verbatim; the approval-source
 * precedence is reframed into tool-agnostic prose (the source referenced
 * LeanHarness-internal `.lh/` paths that do not exist in aih). The aih JSON sidecar
 * + doc renderers are original.
 *
 * Posture: ask-not-deny. aih emits these as a CI-checkable sidecar + human doc; the
 * consuming CLI (or a CI job diffing a PR's touched paths/commands against the
 * gates) decides whether to ask. aih never gates a live tool call itself.
 */

import { lines } from "../internals/render.js";

/** Version of the ported policy data (tracks the source `risk-gates.yml` version). */
export const POLICY_VERSION = "0.1";

export interface RiskGate {
  name: string;
  description: string;
  pathPatterns: string[];
  commandPatterns: string[];
  /** ask-not-deny: a risk gate prompts for approval, it never refuses outright. */
  behavior: "ask";
}

/** Ported verbatim from `.lh/policies/risk-gates.yml` (LeanHarness, MIT). */
export const RISK_GATES: RiskGate[] = [
  {
    name: "auth_rewrite",
    description: "Replacing or broadly restructuring authentication/session behavior.",
    pathPatterns: ["**/auth/**", "**/session/**", "**/*auth*", "**/*session*"],
    commandPatterns: [],
    behavior: "ask",
  },
  {
    name: "payment_logic",
    description: "Changing payment, billing, checkout, invoice, or subscription behavior.",
    pathPatterns: [
      "**/billing/**",
      "**/payment/**",
      "**/checkout/**",
      "**/*billing*",
      "**/*payment*",
      "**/*checkout*",
    ],
    commandPatterns: [],
    behavior: "ask",
  },
  {
    name: "destructive_migration",
    description: "Destructive schema or data migration.",
    pathPatterns: ["**/migrations/**", "**/migration/**", "**/schema.*"],
    commandPatterns: ["*drop*", "*migrate reset*", "*db reset*", "*prisma migrate reset*"],
    behavior: "ask",
  },
  {
    name: "new_dependency",
    description: "Adding, removing, or upgrading dependencies.",
    pathPatterns: [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lockb",
      "requirements.txt",
      "pyproject.toml",
      "poetry.lock",
      "Gemfile",
      "Gemfile.lock",
      "go.mod",
      "go.sum",
      "Cargo.toml",
      "Cargo.lock",
    ],
    commandPatterns: [
      "npm install*",
      "npm update*",
      "pnpm add*",
      "pnpm update*",
      "yarn add*",
      "bun add*",
      "pip install*",
      "poetry add*",
      "cargo add*",
    ],
    behavior: "ask",
  },
  {
    name: "public_api_break",
    description:
      "Changing public API behavior, routes, exported contracts, schemas, or SDK interfaces.",
    pathPatterns: [
      "**/api/**",
      "**/routes/**",
      "**/controllers/**",
      "**/schema/**",
      "**/*schema*",
      "**/*contract*",
    ],
    commandPatterns: [],
    behavior: "ask",
  },
  {
    name: "broad_refactor",
    description: "Large refactors across many unrelated files.",
    pathPatterns: [],
    commandPatterns: [],
    behavior: "ask",
  },
  {
    name: "security_sensitive_change",
    description: "Security, permissions, secrets, encryption, token, or authorization behavior.",
    pathPatterns: [
      "**/security/**",
      "**/permissions/**",
      "**/authorization/**",
      "**/secrets/**",
      "**/*token*",
      "**/*permission*",
      "**/*secret*",
    ],
    commandPatterns: ["*chmod 777*", "*chown*"],
    behavior: "ask",
  },
];

/**
 * Approval-source precedence (reframed from LeanHarness's `.lh/`-pathed sources
 * into tool-agnostic prose). A gate's "ask" is satisfied when one of these, in
 * order, records approval for the touched path/command.
 */
export const APPROVAL_SOURCES: readonly string[] = [
  "A committed risk-approvals record the consuming tool reads from the repo.",
  "An approved entry in the project's boundary/policy file.",
  "Explicit user approval in the current session, when the tool surfaces it.",
];

/** Enforcement notes — ported verbatim from `risk-gates.yml` (LeanHarness, MIT). */
export const ENFORCEMENT_NOTES: readonly string[] = [
  "Risk gates cause ask, not deny, unless the operation is clearly destructive.",
  "Multiple risk gates may trigger for a single path or command.",
  "Approval detection is conservative; a tool may re-ask even after approval.",
  "The broad_refactor gate has no path patterns and is detected by heuristic or explicit trigger.",
];

export interface RiskGatesJsonOptions {
  required?: boolean;
}

/** The CI-checkable JSON sidecar: a CI job can diff a PR's touched paths/commands against this. */
export function riskGatesJson(options: RiskGatesJsonOptions = {}): Record<string, unknown> {
  return {
    version: POLICY_VERSION,
    gates: RISK_GATES,
    approvalSources: APPROVAL_SOURCES,
    enforcementNotes: ENFORCEMENT_NOTES,
    ci: {
      checkName: "risk-gates",
      required: options.required === true,
    },
  };
}

/** Render one gate's pattern list as backtick bullets (or a dash when empty). */
function patternList(patterns: string[]): string[] {
  if (patterns.length === 0) return ["  - _(none — detected by heuristic or explicit trigger)_"];
  return patterns.map((p) => `  - \`${p}\``);
}

/**
 * Human-readable risk-gate reference. Doubles as the "runs in YOUR CI" note (the
 * gates are checked by the customer's pipeline against `risk-gates.json`, never by
 * aih), mirroring the existing `ciNote()` boundary in guardrails/index.ts.
 */
export function riskGatesDoc(): string {
  const gateSections = RISK_GATES.flatMap((g) => [
    "",
    `### ${g.name} — \`${g.behavior}\``,
    "",
    g.description,
    "",
    "Path patterns:",
    ...patternList(g.pathPatterns),
    "",
    "Command patterns:",
    ...patternList(g.commandPatterns),
  ]);

  return lines(
    "# Risk Gates: ask-not-deny change categories",
    "",
    "> Generated by `aih guardrails`. Data ported from LeanHarness",
    "> `.lh/policies/risk-gates.yml` (MIT). The machine-readable form is",
    "> `risk-gates.json` in this directory — a CI-checkable sidecar.",
    "",
    "These are high-risk change classes that warrant a deliberate **ask** before an",
    "agent proceeds. They never hard-deny — they prompt for approval.",
    "",
    "## Runs in YOUR CI, not from aih",
    "",
    "aih only WRITES `risk-gates.json` + this doc; it never gates a live tool call.",
    "Wire the sidecar into YOUR pipeline: a CI job diffs the PR's touched paths and",
    "the commands it runs against the gate patterns below and requires approval before",
    "merge. On the agent side, the consuming CLI (where it has a hook seam) reads the",
    "same categories and asks the operator in-session.",
    "",
    "## Approval sources (in precedence order)",
    "",
    ...APPROVAL_SOURCES.map((s) => `1. ${s}`),
    "",
    "## Enforcement notes",
    "",
    ...ENFORCEMENT_NOTES.map((n) => `- ${n}`),
    "",
    "## Categories",
    ...gateSections,
  );
}
