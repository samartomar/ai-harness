/**
 * Turn coded verification outcomes into routable {@link SupportFinding}s — the
 * bridge between PR1's `Check.code` taxonomy and the copy-ready templates in
 * `templates.ts`. A finding answers "who fixes this, and how":
 *
 *   - audience !== developer  → EXTERNAL. The fix is a system/environment change
 *     owned by IT / security / a platform team. The rendered template is
 *     tool-neutral (never names this harness) and frames a project-setup problem —
 *     a `fail` becomes an `escalation`, a `skip` an `improvement` request.
 *   - audience === developer  → INTERNAL `self-fix`: the developer runs a command
 *     themselves, so that note may reference the harness's own tooling.
 *
 * Routing is keyed entirely off the machine `code` (never `Check.detail`, which
 * rots on a reword). The map is `Record<CheckCode, …>`, so adding a union member
 * without giving it support metadata is a compile error.
 *
 * Pure data: no I/O, no wall-clock. Live specifics (the offending path, the proxy
 * error) ride through verbatim in `details`; routing + the canned action are
 * keyed per code, and EXTERNAL actions are deliberately system-fix instructions,
 * not harness commands.
 */

import type { Check, CheckCode } from "../internals/verify.js";

/** Who acts on a finding. Anything but `developer` is external (tool-neutral). */
export type Audience = "internal-it" | "dev-platform" | "security" | "developer";

/** How urgent. `skip` outcomes are always `optional` (a skip never fails a run). */
export type Severity = "blocking" | "degraded" | "optional";

/**
 * What the finding produces — derived from audience + verdict, not stored:
 * `escalation` (external fail), `improvement` (external skip), `self-fix`
 * (developer, internal).
 */
export type TemplateKind = "escalation" | "self-fix" | "improvement";

export interface SupportFinding {
  code: CheckCode;
  audience: Audience;
  severity: Severity;
  kind: TemplateKind;
  /** Short human title (canned per code). */
  title: string;
  /** What to do next (canned per code; system-fix wording for external codes). */
  recommendedAction: string;
  /** Live `Check.detail`(s) for this code — deduped across checks that share it. */
  details: string[];
  /** The capability whose verification surfaced this (e.g. "heal"). */
  capability: string;
}

/**
 * Per-code routing for the FAIL case. `kind` is NOT stored here — it derives from
 * `audience` (external→escalation, developer→self-fix) and the verdict (skip→
 * improvement). A `skip` also forces `severity`→`optional`, so the table only
 * encodes the fail severity plus the canned copy.
 */
interface CodeMeta {
  audience: Audience;
  failSeverity: Exclude<Severity, "optional">;
  title: string;
  action: string;
}

/**
 * The taxonomy → support routing table. Exhaustive over {@link CheckCode} by
 * construction. EXTERNAL entries (audience !== developer) MUST keep `action`
 * tool-neutral — a system/environment instruction the recipient can act on
 * without knowing or approving any particular tool.
 */
const CODE_META: Record<CheckCode, CodeMeta> = {
  "env.node-runtime": {
    audience: "internal-it",
    failSeverity: "blocking",
    title: "Node.js runtime missing or too old",
    action:
      "Provision Node.js 20 or newer on this machine (internal software catalog or an approved installer), then reopen the shell.",
  },
  "env.git-missing": {
    audience: "developer",
    failSeverity: "degraded",
    title: "git not found on PATH",
    action: "Install git (winget/apt/brew or your software catalog) and reopen the shell.",
  },
  "env.dev-tool-missing": {
    audience: "developer",
    failSeverity: "degraded",
    title: "Dev tools (rg/fd/jq) missing",
    action:
      "Install rg/fd/jq (winget/scoop/brew), or on a locked-down VDI add your local bundle to PATH.",
  },
  "cert.ca-missing": {
    audience: "internal-it",
    failSeverity: "blocking",
    title: "Corporate certificate authority not trusted by the toolchain",
    action:
      "Add the corporate root certificate authority to the OS trust store and to the development toolchain's trusted-certificate configuration on this machine (for Node-based tools, the NODE_EXTRA_CA_CERTS environment variable).",
  },
  "tls.verify-failed": {
    audience: "internal-it",
    failSeverity: "blocking",
    title: "TLS interception is blocking package registries",
    action:
      "Add the intercepting proxy's root certificate to the OS trust store and allowlist the package registry endpoints (registry.npmjs.org, pypi.org) for this machine.",
  },
  "npm.runtime-broken": {
    audience: "internal-it",
    failSeverity: "blocking",
    title: "Node.js / npm runtime is broken on this machine",
    action:
      "Repair the Node.js / npm installation on this machine; if the package registry is unreachable, restore corporate TLS trust first.",
  },
  "path.missing": {
    audience: "developer",
    failSeverity: "degraded",
    title: "Tool directory not on PATH",
    action: "Add the user tool directory to PATH (see `aih heal`) and reopen the shell.",
  },
  "mcp.blocked": {
    audience: "dev-platform",
    failSeverity: "blocking",
    title: "Package launcher (npx) cannot reach the registry",
    action:
      "Restore outbound access to the package registry for the launcher (proxy certificate + endpoint allowlist), or approve a vendored, locally-installed server set.",
  },
  "mcp.uv-missing": {
    audience: "dev-platform",
    failSeverity: "degraded",
    title: "Python launcher (uv) not available",
    action:
      "Provision the `uv` launcher on this machine, or approve a vendored launcher for the local tool servers.",
  },
  "mcp.config-missing": {
    audience: "developer",
    failSeverity: "degraded",
    title: "No .mcp.json configured",
    action: "Run `aih mcp --apply` to generate the project MCP configuration.",
  },
  "mcp.unvendored-offline": {
    audience: "dev-platform",
    failSeverity: "degraded",
    title: "Offline tool servers are not vendored",
    action:
      "Mirror the listed packages into the internal registry, or approve a pinned absolute command for each, before air-gapping this machine.",
  },
  "cli.not-detected": {
    audience: "developer",
    failSeverity: "degraded",
    title: "Target AI CLI not detected",
    action: "Install the target CLI, or target one explicitly with `--cli`/`--all-tools`.",
  },
  "cli.bootloader-missing": {
    audience: "developer",
    failSeverity: "blocking",
    title: "CLI bootloader missing",
    action: "Run `aih bootstrap-ai --apply` to write the bootloader.",
  },
  "cli.bootloader-drift": {
    audience: "developer",
    failSeverity: "degraded",
    title: "CLI bootloader drifted from canon",
    action: "Run `aih bootstrap-ai --apply` to regenerate the managed block.",
  },
  "cli.wont-load": {
    audience: "developer",
    failSeverity: "blocking",
    title: "CLI bootloader present but won't auto-load",
    action:
      "Fix the activation frontmatter / router chain (see the per-tool fix), or re-run `aih bootstrap-ai --apply`.",
  },
  "canon.router-missing": {
    audience: "developer",
    failSeverity: "blocking",
    title: "RULE_ROUTER.md missing",
    action: "Run `aih bootstrap-ai --apply` to write the router.",
  },
  "canon.context-dir-missing": {
    audience: "developer",
    failSeverity: "degraded",
    title: "Context directory not scaffolded",
    action: "Run `aih scaffold --apply` to scaffold the context directory.",
  },
  "canon.lint-failed": {
    audience: "developer",
    failSeverity: "degraded",
    title: "Canon fails the weak-model lint",
    action: "Fix the flagged references/placeholders in the context docs and re-verify.",
  },
  "secrets.plaintext-detected": {
    audience: "security",
    failSeverity: "blocking",
    title: "Plaintext secret committed to the repository",
    action:
      "Rotate the exposed credential immediately and migrate it to the approved secret store; purge it from version control history.",
  },
  "guardrails.gitleaks-missing": {
    audience: "developer",
    failSeverity: "degraded",
    title: "gitleaks not installed",
    action: "Install gitleaks to enforce the pre-commit secret gate.",
  },
  "usage.no-data": {
    audience: "developer",
    failSeverity: "degraded",
    title: "No usage data captured yet",
    action: "Commit once (or wire a per-tool hook) so usage analytics accrue.",
  },
};

/** Severity rank for sorting: most urgent first. */
const SEVERITY_RANK: Record<Severity, number> = { blocking: 0, degraded: 1, optional: 2 };

/** External audiences get tool-neutral, system-fix templates; developers self-fix. */
export function isExternal(audience: Audience): boolean {
  return audience !== "developer";
}

/**
 * Map one {@link Check} to a {@link SupportFinding}, or `undefined` when it isn't
 * routable — a `pass`, or a check with no `code`. Kind derives from audience +
 * verdict; a `skip` is always optional.
 */
export function toFinding(check: Check, capability: string): SupportFinding | undefined {
  if (check.verdict === "pass" || check.code === undefined) return undefined;
  const meta = CODE_META[check.code];
  const isSkip = check.verdict === "skip";
  const kind: TemplateKind = !isExternal(meta.audience)
    ? "self-fix"
    : isSkip
      ? "improvement"
      : "escalation";
  return {
    code: check.code,
    audience: meta.audience,
    severity: isSkip ? "optional" : meta.failSeverity,
    kind,
    title: meta.title,
    recommendedAction: meta.action,
    details: check.detail ? [check.detail] : [],
    capability,
  };
}

/**
 * Collect findings from a verification run's checks: one finding per distinct
 * `code` (checks that share a code merge their `details`), sorted
 * most-urgent-first for stable, useful output.
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
