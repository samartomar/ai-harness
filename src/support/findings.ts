/**
 * Turn coded verification outcomes into routable {@link SupportFinding}s — the
 * bridge between PR1's `Check.code` taxonomy and the copy-ready templates in
 * `templates.ts`. A finding answers "who fixes this, and how urgent": its
 * `audience` + `kind` decide whether the outcome becomes an IT/security
 * escalation, a developer self-fix ("run `aih …`"), or an optional improvement.
 *
 * Routing is keyed entirely off the machine `code` (never `Check.detail`, which
 * rots on a reword). The map is `Record<CheckCode, …>`, so adding a union member
 * without giving it support metadata is a compile error — the same exhaustiveness
 * guarantee the taxonomy test relies on.
 *
 * Pure data: no I/O, no wall-clock. Live specifics (the offending path, the proxy
 * error) ride through verbatim in `details`; the routing/voice is canned per code.
 */

import type { Check, CheckCode } from "../internals/verify.js";

/** Who acts on a finding — decides the template's register and destination. */
export type Audience = "internal-it" | "dev-platform" | "security" | "developer";

/** How urgent. `skip` outcomes are always `optional` (a skip never fails a run). */
export type Severity = "blocking" | "degraded" | "optional";

/**
 * What the finding produces. `escalation` → an IT/security/dev-platform ticket;
 * `self-fix` → a developer-runnable `aih …` recommendation; `improvement` → an
 * optional quality-of-life request (every `skip` lands here).
 */
export type TemplateKind = "escalation" | "self-fix" | "improvement";

export interface SupportFinding {
  code: CheckCode;
  audience: Audience;
  severity: Severity;
  kind: TemplateKind;
  /** Short human title (canned per code). */
  title: string;
  /** What to do next (canned per code). */
  recommendedAction: string;
  /** Live `Check.detail`(s) for this code — deduped across checks that share it. */
  details: string[];
  /** The capability whose verification surfaced this (e.g. "heal"). */
  capability: string;
}

/**
 * Per-code routing for the FAIL case. A `skip` overrides `kind`→`improvement` and
 * `severity`→`optional` uniformly (the verify contract: a skip never fails), so
 * the table only encodes the meaningful fail routing plus the canned copy.
 */
interface CodeMeta {
  audience: Audience;
  failKind: Exclude<TemplateKind, "improvement">;
  failSeverity: Exclude<Severity, "optional">;
  title: string;
  action: string;
}

/**
 * The taxonomy → support routing table. Exhaustive over {@link CheckCode} by
 * construction: a new code with no entry here won't compile.
 */
const CODE_META: Record<CheckCode, CodeMeta> = {
  "env.node-runtime": {
    audience: "internal-it",
    failKind: "escalation",
    failSeverity: "blocking",
    title: "Node.js runtime missing or too old",
    action:
      "Install Node.js >= 20 from the internal software catalog (or nodejs.org if permitted), reopen the shell, and re-run.",
  },
  "env.git-missing": {
    audience: "developer",
    failKind: "self-fix",
    failSeverity: "degraded",
    title: "git not found on PATH",
    action: "Install git (winget/apt/brew or your software catalog) and reopen the shell.",
  },
  "env.dev-tool-missing": {
    audience: "developer",
    failKind: "self-fix",
    failSeverity: "degraded",
    title: "Dev tools (rg/fd/jq) missing",
    action:
      "Install rg/fd/jq (winget/scoop/brew), or on a locked-down VDI add your local bundle to PATH.",
  },
  "cert.ca-missing": {
    audience: "internal-it",
    failKind: "escalation",
    failSeverity: "blocking",
    title: "Corporate CA not trusted by Node",
    action:
      "Provide the corporate root CA and point NODE_EXTRA_CA_CERTS at it, then run `aih certs --apply` to propagate trust.",
  },
  "tls.verify-failed": {
    audience: "internal-it",
    failKind: "escalation",
    failSeverity: "blocking",
    title: "TLS interception is blocking package endpoints",
    action:
      "Add the intercepting proxy's root CA to the OS trust store and allowlist the endpoint, then run `aih heal --apply`.",
  },
  "npm.runtime-broken": {
    audience: "internal-it",
    failKind: "escalation",
    failSeverity: "blocking",
    title: "npm runtime is broken",
    action:
      "Repair the Node/npm installation; if the registry is unreachable, fix corporate TLS trust first (`aih heal`).",
  },
  "path.missing": {
    audience: "developer",
    failKind: "self-fix",
    failSeverity: "degraded",
    title: "Tool directory not on PATH",
    action: "Add the user tool directory to PATH (see `aih heal`) and reopen the shell.",
  },
  "mcp.blocked": {
    audience: "dev-platform",
    failKind: "escalation",
    failSeverity: "blocking",
    title: "MCP launcher (npx) is blocked",
    action:
      "Restore npx/registry reachability (proxy CA + endpoint allowlist), or approve a vendored MCP server set.",
  },
  "mcp.uv-missing": {
    audience: "dev-platform",
    failKind: "self-fix",
    failSeverity: "degraded",
    title: "uv (MCP server launcher) missing",
    action: "Install uv, or approve a vendored launcher for the stdio MCP servers.",
  },
  "mcp.config-missing": {
    audience: "developer",
    failKind: "self-fix",
    failSeverity: "degraded",
    title: "No .mcp.json configured",
    action: "Run `aih mcp --apply` to generate the project MCP configuration.",
  },
  "mcp.unvendored-offline": {
    audience: "dev-platform",
    failKind: "escalation",
    failSeverity: "degraded",
    title: "Offline MCP servers are not vendored",
    action:
      "Mirror/vendor the listed servers or pin an absolute command for each before air-gapping.",
  },
  "cli.not-detected": {
    audience: "developer",
    failKind: "self-fix",
    failSeverity: "degraded",
    title: "Target AI CLI not detected",
    action: "Install the target CLI, or target one explicitly with `--cli`/`--all-tools`.",
  },
  "cli.bootloader-missing": {
    audience: "developer",
    failKind: "self-fix",
    failSeverity: "blocking",
    title: "CLI bootloader missing",
    action: "Run `aih bootstrap-ai --apply` to write the bootloader.",
  },
  "cli.bootloader-drift": {
    audience: "developer",
    failKind: "self-fix",
    failSeverity: "degraded",
    title: "CLI bootloader drifted from canon",
    action: "Run `aih bootstrap-ai --apply` to regenerate the managed block.",
  },
  "cli.wont-load": {
    audience: "developer",
    failKind: "self-fix",
    failSeverity: "blocking",
    title: "CLI bootloader present but won't auto-load",
    action:
      "Fix the activation frontmatter / router chain (see the per-tool fix), or re-run `aih bootstrap-ai --apply`.",
  },
  "canon.router-missing": {
    audience: "developer",
    failKind: "self-fix",
    failSeverity: "blocking",
    title: "RULE_ROUTER.md missing",
    action: "Run `aih bootstrap-ai --apply` to write the router.",
  },
  "canon.context-dir-missing": {
    audience: "developer",
    failKind: "self-fix",
    failSeverity: "degraded",
    title: "Context directory not scaffolded",
    action: "Run `aih scaffold --apply` to scaffold the context directory.",
  },
  "canon.lint-failed": {
    audience: "developer",
    failKind: "self-fix",
    failSeverity: "degraded",
    title: "Canon fails the weak-model lint",
    action: "Fix the flagged references/placeholders in the context docs and re-verify.",
  },
  "secrets.plaintext-detected": {
    audience: "security",
    failKind: "escalation",
    failSeverity: "blocking",
    title: "Plaintext secret on disk",
    action: "Migrate the secret to a vault and rotate the exposed credential immediately.",
  },
  "guardrails.gitleaks-missing": {
    audience: "developer",
    failKind: "self-fix",
    failSeverity: "degraded",
    title: "gitleaks not installed",
    action: "Install gitleaks to enforce the pre-commit secret gate.",
  },
  "usage.no-data": {
    // usage-log is emitted as `skip` today, so this fail-routing never fires in
    // practice; `degraded` keeps the contract honest if it ever becomes a fail.
    audience: "developer",
    failKind: "self-fix",
    failSeverity: "degraded",
    title: "No usage data captured yet",
    action: "Commit once (or wire a per-tool hook) so usage analytics accrue.",
  },
};

/** Severity rank for sorting: most urgent first. */
const SEVERITY_RANK: Record<Severity, number> = { blocking: 0, degraded: 1, optional: 2 };

/**
 * Map one {@link Check} to a {@link SupportFinding}, or `undefined` when it isn't
 * routable — a `pass`, or a check with no `code` (not yet ticket-routed). A `skip`
 * is always an optional improvement; a `fail` uses the code's table routing.
 */
export function toFinding(check: Check, capability: string): SupportFinding | undefined {
  if (check.verdict === "pass" || check.code === undefined) return undefined;
  const meta = CODE_META[check.code];
  const isSkip = check.verdict === "skip";
  return {
    code: check.code,
    audience: meta.audience,
    severity: isSkip ? "optional" : meta.failSeverity,
    kind: isSkip ? "improvement" : meta.failKind,
    title: meta.title,
    recommendedAction: meta.action,
    details: check.detail ? [check.detail] : [],
    capability,
  };
}

/**
 * Collect findings from a verification run's checks: one finding per distinct
 * `code` (checks that share a code — e.g. several missing bootloaders — merge
 * their `details`), sorted most-urgent-first for stable, useful output.
 */
export function findingsFrom(checks: readonly Check[], capability: string): SupportFinding[] {
  const byCode = new Map<CheckCode, SupportFinding>();
  for (const check of checks) {
    const finding = toFinding(check, capability);
    if (finding === undefined) continue;
    const existing = byCode.get(finding.code);
    if (existing === undefined) {
      byCode.set(finding.code, finding);
      continue;
    }
    for (const d of finding.details) if (!existing.details.includes(d)) existing.details.push(d);
  }
  return [...byCode.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.code.localeCompare(b.code),
  );
}
