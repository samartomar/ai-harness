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
 * Posture: ask-not-deny. aih emits these as a CI-checkable sidecar + human doc,
 * plus (at enterprise posture) the sidecar's generated consumer — a PR-diff
 * workflow that surfaces touched gates in the customer's pipeline (#507 slice D).
 * The consuming CLI (where it has a hook seam) reads the same categories
 * in-session. aih never gates a live tool call itself.
 */

import { lines } from "../internals/render.js";
import { CHECKOUT_ACTION_PIN } from "./sca.js";

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

/**
 * One gate path pattern against one changed path — a faithful TS mirror of the
 * generated workflow's bash matcher (`case "$path" in $pattern`), where `*`
 * matches any run of characters INCLUDING `/` and a leading globstar-slash
 * prefix may also match zero directories (the workflow retries with that prefix
 * stripped). Exported so
 * the consumer's matching POLICY is unit-tested against representative diffs,
 * not merely asserted as generated strings — the `blockedLicensesFound` pattern
 * from the SCA gate. Covers the pattern language the gates actually use
 * (`*`, `?`, literals; no bracket expressions).
 */
export function gatePatternMatches(path: string, pattern: string): boolean {
  if (bashCaseMatch(path, pattern)) return true;
  return pattern.startsWith("**/") && bashCaseMatch(path, pattern.slice("**/".length));
}

function bashCaseMatch(path: string, pattern: string): boolean {
  const regex = pattern.replace(/[.+^${}()|[\]\\?*]/g, (ch) => {
    if (ch === "*") return ".*";
    if (ch === "?") return ".";
    return `\\${ch}`;
  });
  return new RegExp(`^${regex}$`).test(path);
}

export interface TouchedRiskGate {
  name: string;
  /** The changed paths that matched this gate's path patterns, input order kept. */
  paths: string[];
}

/**
 * The gates a PR's changed paths would trigger — the same verdict the generated
 * workflow surfaces as warnings. Path patterns only: command patterns cannot be
 * derived from a diff and stay with the agent-side consumer.
 */
export function riskGatesTouched(
  changedPaths: readonly string[],
  gates: readonly RiskGate[] = RISK_GATES,
): TouchedRiskGate[] {
  const out: TouchedRiskGate[] = [];
  for (const gate of gates) {
    if (gate.pathPatterns.length === 0) continue;
    const paths = changedPaths.filter((path) =>
      gate.pathPatterns.some((pattern) => gatePatternMatches(path, pattern)),
    );
    if (paths.length > 0) out.push({ name: gate.name, paths });
  }
  return out;
}

/**
 * Render `.github/workflows/risk-gates.yml` — the sidecar's generated consumer.
 * A pull_request job (named after the sidecar's `ci.checkName`) reads
 * `sidecarPath` with jq, diffs the PR's changed paths against each gate's path
 * patterns, and surfaces every touched gate as a `::warning::` annotation plus a
 * job-summary table. Ask-not-deny end to end: a touched gate NEVER fails the
 * build (`risk-gates` grades warn at every posture) — the human PR review
 * answers the ask. The only hard failure is a corrupted sidecar; a missing one
 * is a notice, since committing the sidecar is what opts the repo in.
 *
 * This emits a GENERATED FILE only. The harness never runs CI — the workflow
 * executes in the customer's pipeline, mirroring the SCA workflow boundary.
 */
export function riskGatesWorkflowYaml(sidecarPath: string): string {
  return lines(
    "# .github/workflows/risk-gates.yml — PR risk-gate surfacing (managed by aih guardrails)",
    "# Policy intent: surface which declared risk-gate categories a PR touches so",
    "# the human review answers the ask knowingly. Ask-not-deny: this job annotates",
    "# and summarizes; it never fails the build on a touched gate.",
    `# Gate data: ${sidecarPath} (generated by aih guardrails; the job name below is`,
    "# the sidecar's declared ci.checkName).",
    "",
    "name: risk-gates",
    "",
    "on:",
    "  pull_request:",
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  risk-gates:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: ${CHECKOUT_ACTION_PIN}`,
    "        with:",
    "          fetch-depth: 0",
    "      - name: Surface risk gates touched by this PR (ask-not-deny)",
    "        shell: bash",
    "        env:",
    `          SIDECAR: ${sidecarPath}`,
    "        run: |",
    "          set -euo pipefail",
    "          # noglob: gate patterns are MATCHED against the diff, never expanded",
    "          # against the checkout (an unquoted $patterns word must stay literal).",
    "          set -f",
    '          if [ ! -f "$SIDECAR" ]; then',
    "            echo \"::notice::risk-gates sidecar $SIDECAR is missing - regenerate with 'aih guardrails --apply' and commit it.\"",
    "            exit 0",
    "          fi",
    '          jq empty "$SIDECAR" || { echo "::error::$SIDECAR is not valid JSON - regenerate with \'aih guardrails --apply\'."; exit 1; }',
    "          changed=$(mktemp)",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion in the generated script, not a TS template
    '          git diff --name-only "origin/${GITHUB_BASE_REF}...HEAD" > "$changed"',
    "          gates=$(mktemp)",
    '          jq -r \'.gates[] | select(.pathPatterns | length > 0) | .name + "\\t" + (.pathPatterns | join(" "))\' "$SIDECAR" > "$gates"',
    '          summary=""',
    "          while IFS=$'\\t' read -r name patterns; do",
    "            # A stray CR (CRLF-writing jq or git) must not glue onto the last field.",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion in the generated script, not a TS template
    "            patterns=\"${patterns%$'\\r'}\"",
    '            hits=""',
    "            while IFS= read -r path; do",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion in the generated script, not a TS template
    "              path=\"${path%$'\\r'}\"",
    '              [ -n "$path" ] || continue',
    "              for pattern in $patterns; do",
    '                hit=""',
    "                # Bash pattern match ('*' crosses '/'); '**/' also matches zero dirs.",
    '                case "$path" in $pattern) hit=1 ;; esac',
    '                if [ -z "$hit" ]; then',
    '                  case "$pattern" in',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion in the generated script, not a TS template
    '                    "**/"*) case "$path" in ${pattern#\\*\\*/}) hit=1 ;; esac ;;',
    "                  esac",
    "                fi",
    '                if [ -n "$hit" ]; then',
    '                  hits="$hits $path"',
    "                  break",
    "                fi",
    "              done",
    '            done < "$changed"',
    '            if [ -n "$hits" ]; then',
    "              echo \"::warning::risk gate '$name' touched by this PR:$hits\"",
    "              summary=\"$summary| $name |$hits |\"$'\\n'",
    "            fi",
    '          done < "$gates"',
    '          if [ -n "$summary" ]; then',
    "            {",
    '              echo "## Risk gates touched (ask-not-deny)"',
    '              echo ""',
    '              echo "Declared in $SIDECAR. This check never fails the build; it surfaces"',
    '              echo "the risk so the PR review answers the ask."',
    '              echo ""',
    '              echo "| Gate | Changed paths |"',
    '              echo "| --- | --- |"',
    "              printf '%s' \"$summary\"",
    '            } >> "$GITHUB_STEP_SUMMARY"',
    "          else",
    '            echo "No declared risk gates touched by this PR."',
    "          fi",
  );
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
    "aih never gates a live tool call — it only WRITES `risk-gates.json`, this doc,",
    "and (at enterprise posture) the sidecar's consumer,",
    "`.github/workflows/risk-gates.yml`. That workflow runs on pull_request in YOUR",
    "pipeline: it reads the sidecar, diffs the PR's changed paths against each gate's",
    "path patterns, and surfaces every touched gate as a warning annotation plus a",
    "job-summary table. Ask-not-deny: the job never fails the build on a touched gate",
    "— the human PR review answers the ask. To activate it, commit the workflow and",
    "the sidecar and push. At enterprise the sidecar marks the `risk-gates` check",
    "`required`: branch protection should require the check to have RUN; it still",
    "passes either way. Command patterns are for the agent-side consumer (a CLI hook",
    "seam reading the same categories in-session), not the PR diff. On other CI",
    "systems, port the jq + `git diff` matching into an equivalent stage.",
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
