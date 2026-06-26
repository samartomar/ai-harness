/**
 * Machine-readable command-classification lexicon + its projections.
 *
 * Data ported verbatim from LeanHarness `.lh/policies/commands.yml` (MIT,
 * Copyright (c) 2026 LeanHarness contributors) — every `pattern` and `reason`
 * string is preserved exactly. The Claude `permissions` mapping convention
 * (deny → `permissions.deny`, ask → `permissions.ask`, safe_* → `permissions.allow`,
 * each wrapped `Bash(<pattern>)`) is adapted from LeanHarness `.lh/policies/claude-code.yml`
 * (MIT). The aih plan/render integration, the enforce-vs-document table, and the
 * advisory framing are original to aih.
 *
 * Posture: this lexicon is DATA. aih projects it into a native permission seam only
 * where one exists (Claude `.claude/settings.json` + `.claude/managed-settings.json`)
 * and DOCUMENTS it everywhere else — a deny pattern does nothing unless the consuming
 * CLI's own permission/hook engine honors it. The patterns are prefix/glob matchers,
 * kept verbatim; matcher semantics live with the consuming CLI, not aih.
 */

import { CLI_REGISTRY, REGISTRY_IDS } from "../internals/cli-registry.js";
import { lines } from "../internals/render.js";

/** Policy tiers, most-to-least restrictive. Ported from LeanHarness commands.yml (MIT). */
export type PolicyTier = "deny" | "ask" | "safe_read_only" | "safe_verification";

export interface CommandRule {
  /** Glob-ish command pattern, verbatim from the source lexicon. */
  pattern: string;
  /** Human reason (deny/ask only; the safe tiers are self-explanatory). */
  reason?: string;
}

/**
 * The 4-tier command classification lexicon. Ported verbatim from
 * `.lh/policies/commands.yml` (LeanHarness, MIT) — pattern + reason preserved.
 */
export const COMMAND_LEXICON: Record<PolicyTier, CommandRule[]> = {
  deny: [
    { pattern: "rm -rf /", reason: "Refuses to delete filesystem root." },
    { pattern: "rm -rf /*", reason: "Refuses to delete filesystem root contents." },
    { pattern: "rm -rf ~", reason: "Refuses to delete the home directory." },
    { pattern: "rm -rf ~/*", reason: "Refuses to delete home directory contents." },
    { pattern: "rm -rf .git", reason: "Refuses to delete git metadata." },
    { pattern: "rm -rf .git/", reason: "Refuses to delete git metadata." },
    { pattern: "git push --force*", reason: "Force push requires explicit manual control." },
    { pattern: "git push -f *", reason: "Force push requires explicit manual control." },
    { pattern: "git reset --hard*", reason: "Hard reset can destroy local work." },
    { pattern: "git clean -fd*", reason: "Git clean with force can delete untracked work." },
    { pattern: "git clean -fx*", reason: "Git clean with force can delete untracked work." },
    { pattern: "git clean -fxd*", reason: "Git clean with force can delete untracked work." },
    { pattern: "*DROP DATABASE*", reason: "Destructive database command." },
    { pattern: "*drop database*", reason: "Destructive database command." },
    { pattern: "*DROP TABLE*", reason: "Destructive database command." },
    { pattern: "*drop table*", reason: "Destructive database command." },
    { pattern: "cat .env*", reason: "Refuses to expose secrets." },
    { pattern: "printenv*", reason: "Refuses to expose environment secrets." },
    { pattern: "env", reason: "Refuses to expose environment secrets." },
    { pattern: "*> /dev/sd*", reason: "Refuses to write directly to block devices." },
    { pattern: "dd if=*", reason: "Refuses raw disk writes." },
    { pattern: "mkfs*", reason: "Refuses filesystem creation on devices." },
    { pattern: ":(){ :|:& };:*", reason: "Refuses fork bombs." },
  ],
  ask: [
    { pattern: "npm install*", reason: "Dependency installation requires approval." },
    { pattern: "npm update*", reason: "Dependency updates require approval." },
    { pattern: "npm ci*", reason: "Dependency installation requires approval." },
    { pattern: "pnpm add*", reason: "Dependency installation requires approval." },
    { pattern: "pnpm update*", reason: "Dependency updates require approval." },
    { pattern: "pnpm install*", reason: "Dependency installation requires approval." },
    { pattern: "yarn add*", reason: "Dependency installation requires approval." },
    { pattern: "yarn install*", reason: "Dependency installation requires approval." },
    { pattern: "bun add*", reason: "Dependency installation requires approval." },
    { pattern: "bun install*", reason: "Dependency installation requires approval." },
    { pattern: "pip install*", reason: "Dependency installation requires approval." },
    { pattern: "poetry add*", reason: "Dependency installation requires approval." },
    { pattern: "cargo add*", reason: "Dependency installation requires approval." },
    { pattern: "git push*", reason: "Pushing changes requires approval." },
    { pattern: "git reset*", reason: "Resetting git state requires approval." },
    { pattern: "git clean*", reason: "Cleaning git state requires approval." },
    { pattern: "*migrate reset*", reason: "Migration reset requires approval." },
    { pattern: "*db reset*", reason: "Database reset requires approval." },
    { pattern: "*deploy*", reason: "Deployment requires approval." },
    { pattern: "*curl*|*sh*", reason: "Piping remote scripts requires approval." },
    { pattern: "rm -r*", reason: "Recursive deletion requires approval." },
  ],
  safe_read_only: [
    { pattern: "git status*" },
    { pattern: "git diff*" },
    { pattern: "git log*" },
    { pattern: "git branch*" },
    { pattern: "git show*" },
    { pattern: "git blame*" },
    { pattern: "ls*" },
    { pattern: "find*" },
    { pattern: "grep*" },
    { pattern: "rg*" },
    { pattern: "cat README.md" },
    { pattern: "sed -n*" },
    { pattern: "wc *" },
    { pattern: "head *" },
    { pattern: "tail *" },
  ],
  safe_verification: [
    { pattern: "npm test*" },
    { pattern: "npm run test*" },
    { pattern: "npm run lint*" },
    { pattern: "npm run typecheck*" },
    { pattern: "pnpm test*" },
    { pattern: "pnpm lint*" },
    { pattern: "pnpm typecheck*" },
    { pattern: "pnpm run test*" },
    { pattern: "pnpm run lint*" },
    { pattern: "yarn test*" },
    { pattern: "yarn lint*" },
    { pattern: "bun test*" },
    { pattern: "pytest*" },
    { pattern: "go test*" },
    { pattern: "cargo test*" },
    { pattern: "node --check*" },
    { pattern: "python -m json.tool*" },
    { pattern: "python -c *" },
  ],
};

/** Registry CLI ids aih can project the lexicon into a NATIVE permission seam for. */
const ENFORCED_CLIS = new Set<string>(["claude"]);

/**
 * Project the lexicon into Claude-style `permissions` matchers (`Bash(<pattern>)`).
 * A pure 1:1 string map — no transformation, no dedupe — so any matcher semantics
 * live with the consuming CLI, not aih. deny → `permissions.deny`, ask →
 * `permissions.ask`, the two safe tiers → `permissions.allow`.
 */
export function claudeBashPermissions(): { deny: string[]; ask: string[]; allow: string[] } {
  return {
    deny: COMMAND_LEXICON.deny.map((r) => `Bash(${r.pattern})`),
    ask: COMMAND_LEXICON.ask.map((r) => `Bash(${r.pattern})`),
    allow: [...COMMAND_LEXICON.safe_read_only, ...COMMAND_LEXICON.safe_verification].map(
      (r) => `Bash(${r.pattern})`,
    ),
  };
}

/**
 * Project the lexicon into the sandbox managed-settings exec-policy block. Spread
 * into the `sandbox` object so the command policy ships alongside the egress
 * allowlist in `.claude/managed-settings.json`.
 */
export function sandboxExecPolicy(): Record<string, unknown> {
  return {
    commandPolicy: {
      deny: COMMAND_LEXICON.deny.map((r) => ({ pattern: r.pattern, reason: r.reason })),
      ask: COMMAND_LEXICON.ask.map((r) => ({ pattern: r.pattern, reason: r.reason })),
      safeReadOnly: COMMAND_LEXICON.safe_read_only.map((r) => r.pattern),
      safeVerification: COMMAND_LEXICON.safe_verification.map((r) => r.pattern),
    },
  };
}

/** Render the deny/ask tier as `- \`pattern\` — reason` bullets (backticks keep `|`/`*` literal). */
function ruleBullets(rules: CommandRule[]): string[] {
  return rules.map((r) => `- \`${r.pattern}\`${r.reason ? ` — ${r.reason}` : ""}`);
}

/**
 * The enforce-vs-document table, keyed off the CLI registry (the single source of
 * truth for the supported CLI set + labels). Only CLIs with a native permission
 * seam are "Enforced"; everyone else is "Documented" — stated explicitly so no one
 * assumes a non-Claude run is gated by this file.
 */
function enforcementRows(): string[] {
  return REGISTRY_IDS.map((id) => {
    const label = CLI_REGISTRY[id]?.label ?? id;
    return ENFORCED_CLIS.has(id)
      ? `| ${label} | \`.claude/settings.json\` permissions + \`.claude/managed-settings.json\` sandbox commandPolicy | **Enforced** |`
      : `| ${label} | none today (markdown/rules only) | **Documented** (advisory) |`;
  });
}

/** Markdown reference table for humans (lives under the canonical context dir). */
export function commandPolicyDoc(): string {
  return lines(
    "# Command Policy: deny / ask / safe lexicon",
    "",
    "> Generated by `aih guardrails`. Data ported from LeanHarness",
    "> `.lh/policies/commands.yml` (MIT). A machine-readable classification of shell",
    "> commands for the AI coding tools in this repo.",
    "",
    "## ⚠ Advisory vs. enforced — read this first",
    "",
    "This lexicon is **advisory** unless the consuming CLI honors it. aih *projects*",
    "it into native enforcement only where a tool exposes a permission/hook seam, and",
    "*documents* it everywhere else. A pattern in this file does nothing on its own —",
    "the target CLI's permission engine is what acts on it. Do **not** assume a run on",
    "a tool in the *Documented* row below is gated by this policy.",
    "",
    "| CLI | Native seam aih writes | Enforcement |",
    "| --- | --- | --- |",
    ...enforcementRows(),
    "",
    "Patterns are prefix/glob matchers, preserved verbatim from the source. Matcher",
    "semantics (how a `*` or `|` is interpreted) live with the consuming CLI, not aih.",
    "",
    "## deny — refused outright",
    "",
    "Projected into Claude `permissions.deny` as `Bash(<pattern>)` and into the sandbox",
    "`commandPolicy.deny`.",
    "",
    ...ruleBullets(COMMAND_LEXICON.deny),
    "",
    "## ask — require human approval",
    "",
    "Projected into Claude `permissions.ask` and the sandbox `commandPolicy.ask`.",
    "",
    ...ruleBullets(COMMAND_LEXICON.ask),
    "",
    "## safe (read-only) — inspection commands",
    "",
    "Projected into Claude `permissions.allow`.",
    "",
    ...ruleBullets(COMMAND_LEXICON.safe_read_only),
    "",
    "## safe (verification) — test / lint / typecheck runners",
    "",
    "Projected into Claude `permissions.allow`.",
    "",
    ...ruleBullets(COMMAND_LEXICON.safe_verification),
  );
}
