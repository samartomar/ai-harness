/**
 * Turn coded verification outcomes into routable {@link SupportFinding}s — the
 * bridge between PR1's `Check.code` taxonomy and the ticket-ready templates in
 * `templates.ts`. A finding answers "who fixes this, and how":
 *
 *   - audience !== developer  → EXTERNAL. The fix is a system/environment change
 *     owned by IT / security / a platform team. The rendered ticket is
 *     tool-neutral (never names this harness) and frames the failed INTERNAL
 *     configuration — a `fail` is an `escalation`, a `skip` an `improvement`.
 *   - audience === developer  → INTERNAL `self-fix`: the developer runs a command
 *     themselves, so that note may reference the harness's own tooling.
 *
 * Everything a ticket needs is canned per `code` (title, evidence, affected area,
 * requested fix, acceptance criteria) so the template is filled from a stable
 * `code + verdict + project context`, NEVER from guessed free text. The live
 * `Check.detail`(s) ride along as supporting evidence. The map is
 * `Record<CheckCode, …>`, so a new union member without metadata won't compile.
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
  /** Short, tool-neutral issue title (canned per code). */
  title: string;
  /** The requested fix — a system/environment change for external findings. */
  recommendedAction: string;
  /** Live `Check.detail`(s) for this code — deduped across checks that share it. */
  details: string[];
  /** Canned tool-neutral observation for the "Observed evidence" block (external). */
  evidence?: string;
  /** Fixed-vocabulary routing hint for the Environment block (external). */
  affectedArea?: string;
  /** Canned post-fix checks for the "Acceptance criteria" block (external). */
  acceptance?: string[];
  /** The capability whose verification surfaced this (e.g. "heal"). */
  capability: string;
}

/**
 * Per-code routing for the FAIL case. `kind` is derived (not stored): external
 * audiences escalate (fail) / request improvements (skip); developers self-fix.
 * A `skip` forces `severity`→`optional`. External codes MUST set `evidence`,
 * `affectedArea`, and `acceptance` (and keep `action` a tool-neutral system fix);
 * developer codes omit them — the self-fix note doesn't use them.
 */
interface CodeMeta {
  audience: Audience;
  failSeverity: Exclude<Severity, "optional">;
  title: string;
  action: string;
  affectedArea?: string;
  evidence?: string;
  acceptance?: string[];
}

/** Acceptance line every external fix shares: the project itself must not change. */
const NO_CODE_CHANGES = "No project code changes are required.";

/**
 * The taxonomy → support routing table. Exhaustive over {@link CheckCode}.
 * EXTERNAL entries keep `action`/`evidence` tool-neutral — a system/environment
 * statement the recipient can act on without knowing any particular tool.
 */
const CODE_META: Record<CheckCode, CodeMeta> = {
  "env.node-runtime": {
    audience: "internal-it",
    failSeverity: "blocking",
    title: "required language runtime missing or unsupported",
    affectedArea: "local developer tooling",
    evidence:
      "The required language runtime (Node.js 20 or newer) is missing or below the supported version on this machine.",
    action:
      "Please provision the supported language runtime on this machine via the approved software catalog or installer, then have the developer reopen their shell.",
    acceptance: [
      "The supported runtime version is available on this machine.",
      "Project setup checks pass without further manual steps.",
      NO_CODE_CHANGES,
    ],
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
  "env.tool-install-blocked": {
    audience: "internal-it",
    failSeverity: "degraded",
    title: "required developer tool could not be installed",
    affectedArea: "local developer tooling / software installation",
    evidence:
      "A required command-line tool is not available, and an automated install could not complete on this machine (no supported package manager is present, privileges are insufficient, or the package source is blocked).",
    action:
      "Please provision the missing tool via the approved software catalog / package manager, or unblock the package source on this machine so the developer can install it.",
    acceptance: [
      "The tool resolves on PATH.",
      "Project tooling checks pass without further manual steps.",
      NO_CODE_CHANGES,
    ],
  },
  "cert.ca-missing": {
    audience: "internal-it",
    failSeverity: "blocking",
    title: "corporate CA not trusted by development tools",
    affectedArea: "workstation certificate trust / development toolchain trust",
    evidence:
      "TLS verification is failing because the approved corporate CA is not available to the tools running on this machine.\nThe Node CA bundle setting (NODE_EXTRA_CA_CERTS) is not set or does not point to a valid corporate CA bundle.",
    action:
      "Please make the approved corporate root certificate authority available on this machine and configure the development tools to trust it. For Node-based tools, this usually means setting NODE_EXTRA_CA_CERTS to the approved corporate CA bundle path, in addition to any required OS trust-store configuration.",
    acceptance: [
      "Development tools can complete TLS verification against approved internal and package sources.",
      "Package access works without disabling TLS checks.",
      NO_CODE_CHANGES,
    ],
  },
  "tls.verify-failed": {
    audience: "internal-it",
    failSeverity: "blocking",
    title: "TLS verification to approved package sources is failing",
    affectedArea: "workstation certificate trust / development toolchain trust",
    evidence:
      "TLS connections to approved package registries are failing on this machine, consistent with an intercepting proxy whose certificate is not trusted by the development tools.",
    action:
      "Please ensure the intercepting proxy's certificate is trusted on this machine (OS trust store and the development toolchain) and that the approved package registry endpoints are reachable.",
    acceptance: [
      "Development tools can complete TLS verification against approved internal and package sources.",
      "Package access works without disabling TLS checks.",
      NO_CODE_CHANGES,
    ],
  },
  "npm.runtime-broken": {
    audience: "internal-it",
    failSeverity: "blocking",
    title: "package manager is broken on this machine",
    affectedArea: "approved package registry access",
    evidence:
      "The package manager fails to run or cannot install from approved registries on this machine.",
    action:
      "Please repair the package manager installation on this machine so it runs and can install from approved registries; if the registry is unreachable, restore corporate TLS trust first.",
    acceptance: [
      "The package manager runs and can install from approved sources.",
      "No TLS checks are disabled to achieve this.",
      NO_CODE_CHANGES,
    ],
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
    title: "package launcher cannot reach the approved registry",
    affectedArea: "approved package registry access",
    evidence:
      "The developer-platform package launcher cannot reach the approved package registry on this machine.",
    action:
      "Please restore access from this machine to the approved package registry for the launcher (certificate trust plus endpoint allowlisting), or approve a vendored, locally-installed server set.",
    acceptance: [
      "The launcher can reach approved package sources.",
      "No TLS checks are disabled to achieve this.",
      NO_CODE_CHANGES,
    ],
  },
  "mcp.uv-missing": {
    audience: "dev-platform",
    failSeverity: "degraded",
    title: "required package launcher not available",
    affectedArea: "MCP / developer platform configuration",
    evidence: "A required package launcher (uv) is not available on this machine.",
    action:
      "Please provision the required package launcher on this machine, or approve a vendored, locally-installed alternative.",
    acceptance: [
      "The required launcher is available, or an approved vendored alternative is in place.",
      NO_CODE_CHANGES,
    ],
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
    title: "developer-platform servers are not vendored for offline use",
    affectedArea: "MCP / developer platform configuration",
    evidence:
      "One or more developer-platform servers still resolve packages from the network at runtime, which will fail once this machine is air-gapped.",
    action:
      "Please mirror the required packages into the approved internal registry, or approve a pinned, locally-available command for each, before this machine is air-gapped.",
    acceptance: [
      "All required servers run from approved, locally available sources.",
      "No runtime downloads are needed after air-gapping.",
      NO_CODE_CHANGES,
    ],
  },
  "mcp.policy-denied": {
    audience: "developer",
    failSeverity: "degraded",
    title: "MCP server denied by enterprise policy",
    action:
      "Self-host or pin the denied server (or remove it) — run `aih mcp --posture enterprise` to see the per-server verdicts, then update .mcp.json (keep it under CODEOWNERS).",
  },
  "mcp.hardcoded-secret": {
    audience: "developer",
    failSeverity: "blocking",
    title: "hardcoded secret in MCP config",
    action:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: documents the literal ${ENV} reference form for the developer
      "Replace the literal value in the flagged MCP config with an env reference (e.g. `${GITHUB_PERSONAL_ACCESS_TOKEN}`), supply it from the environment/vault at runtime, and rotate the exposed credential.",
  },
  "mcp.allowlist-drift": {
    audience: "developer",
    failSeverity: "blocking",
    title: "managed MCP allowlist drifted",
    action:
      "Re-run `aih mcp --posture enterprise --apply` (or the org-policy projection) so `.claude/managed-settings.json` matches the committed `.mcp.json` fixed server set.",
  },
  "cli.not-detected": {
    audience: "developer",
    failSeverity: "degraded",
    title: "Target AI CLI not detected",
    action: "Install the target CLI, or target one explicitly with `--cli`/`--all-tools`.",
  },
  "cli.config-only": {
    audience: "developer",
    failSeverity: "degraded",
    title: "AI CLI config found but binary missing",
    action:
      "Install the CLI binary or target it explicitly only when the tool can run; config directories alone may be stale.",
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
  "canon.adoptable": {
    audience: "developer",
    failSeverity: "degraded",
    title: "Existing AI canon not yet on the managed model",
    action:
      "Run `aih adopt` to converge the existing canon onto the managed model instead of overwriting it.",
  },
  "canon.cli-native-unmigrated": {
    audience: "developer",
    failSeverity: "degraded",
    title: "CLI-native config holds content not in the canon",
    action:
      "Run `aih adopt` for the migration map; opt into `--migrate-cli` (content-verified) to fold it into the canon. aih never modifies CLI-native locations on its own.",
  },
  "secrets.plaintext-detected": {
    audience: "security",
    failSeverity: "blocking",
    title: "plaintext secret committed to the repository",
    affectedArea: "security review for plaintext secret handling",
    evidence: "A plaintext credential was found committed to the repository working tree.",
    action:
      "Please rotate the exposed credential, move it to the approved secret store, and confirm it is removed from the working tree and version history.",
    acceptance: [
      "The exposed credential is rotated and stored in the approved secret store.",
      "The plaintext value is removed from the working tree and version history.",
      "Secret-scanning controls remain enabled.",
    ],
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
  "scale.code-review-graph-missing": {
    audience: "developer",
    failSeverity: "blocking",
    title: "code-review-graph unavailable for large repo",
    action:
      "Enable the local graph before broad analysis: run `aih mcp --apply` and `aih tools --apply`, then re-check with `aih doctor`. Until it is available, use bounded rg/fd reads only.",
  },
  "report.context-over-budget": {
    audience: "developer",
    failSeverity: "degraded",
    title: "per-turn context exceeds the token budget",
    action:
      "Trim the heaviest tool's always-loaded bootloaders (push detail behind on-demand `RULE_ROUTER.md` pointers), or raise `--token-budget` if the limit is too tight. See the per-turn load-group panel in `aih report`.",
  },
  "report.low-adoption": {
    audience: "developer",
    failSeverity: "degraded",
    title: "harness adoption is incomplete for this repo",
    action:
      "Wire the missing managed artifacts — `aih init --apply` (or the specific `aih scaffold`/`aih mcp`/`aih guardrails --apply`) finishes bootstrapping; re-check with `aih doctor`.",
  },
  "contract.path-unportable": {
    audience: "developer",
    failSeverity: "degraded",
    title: "repo contract has a non-portable path",
    action:
      "Re-run `aih contract --apply` to regenerate `project.json` from the live tree. If a path is still non-portable, it was hand-edited — replace any absolute, drive-letter, or `..` path with a repo-relative POSIX path.",
  },
  "contract.stale": {
    audience: "developer",
    failSeverity: "blocking",
    title: "repo contract drifted from the live repository",
    action:
      "Re-run `aih contract --apply` to regenerate `project.json` from the live tree, then re-check with `aih doctor`.",
  },
  "org-policy.drift": {
    audience: "developer",
    failSeverity: "blocking",
    title: "org policy projection drifted",
    action:
      "Re-run the org-policy projection (`aih init --posture enterprise --apply`, or the narrower command that owns the drifted file) so managed settings match `aih-org-policy.json`.",
  },
  "report.contract-untrue": {
    audience: "developer",
    failSeverity: "degraded",
    title: "repo contract reports a non-portable path",
    action:
      "`aih report` found a non-portable path in the committed `project.json`. Re-run `aih contract --apply` to regenerate it from the live tree; verify with `aih doctor` (the `contract truth` probe).",
  },
  "ready.blocked": {
    audience: "developer",
    failSeverity: "blocking",
    title: "developer readiness is blocked",
    action:
      "`aih ready` found one or more blockers that stop an agent from starting here. Clear each named blocker with its own fix (see the readiness digest — e.g. `aih heal`, `aih contract --apply`, `aih secrets --apply`, `aih bootstrap-ai --apply`), then re-run `aih ready`.",
  },
  "trust.hidden-unicode": {
    audience: "developer",
    failSeverity: "blocking",
    title: "hidden Unicode found in external skill content",
    action:
      "Reject the external source until the hidden Unicode is removed or the source is replaced with a reviewed, clean commit.",
  },
  "trust.fetch-blocked": {
    audience: "developer",
    failSeverity: "blocking",
    title: "external trust source could not be fetched",
    action:
      "Do not promote the external source. Re-run with a reachable repository and an exact reviewed commit SHA, then verify the quarantined scan passes before promotion.",
  },
  "trust.detector-unavailable": {
    audience: "developer",
    failSeverity: "blocking",
    title: "required trust detector unavailable",
    action:
      "Install the required detector locally or remove it from the enterprise trust.requiredDetectors policy. Optional detector skips only reduce coverage and do not block lower postures.",
  },
  "trust.prompt-injection": {
    audience: "developer",
    failSeverity: "blocking",
    title: "prompt-injection shape found in external skill content",
    action:
      "Reject the external source until the hidden instruction/exfiltration text is removed or the source is replaced with a reviewed, clean commit.",
  },
  "trust.source-changed": {
    audience: "developer",
    failSeverity: "blocking",
    title: "external trust source changed after clearance",
    action:
      "Do not promote the external source. Re-run the acquisition from the exact source/ref so the scan, artifact hashes, and promotion all refer to the same content.",
  },
  "trust.auto-exec-hook": {
    audience: "developer",
    failSeverity: "blocking",
    title: "auto-execution hook found in external skill source",
    action:
      "Reject the external source until the auto-executing hook, install lifecycle script, permission bypass, or auto-run line is removed.",
  },
  "trust.dependency-confusion": {
    audience: "developer",
    failSeverity: "blocking",
    title: "external source declares an internal-scope dependency",
    action:
      "Reject the external source until the dependency is removed or replaced with a reviewed, pinned package from an approved source.",
  },
  "trust.typosquat": {
    audience: "developer",
    failSeverity: "blocking",
    title: "dependency name resembles a popular package",
    action:
      "Reject the external source until the dependency name is corrected or the package is independently reviewed and pinned.",
  },
  "trust.malicious-code": {
    audience: "developer",
    failSeverity: "blocking",
    title: "malicious code shape found in external skill source",
    action:
      "Reject the external source until the reverse shell, remote shell pipe, base64-to-shell payload, or equivalent malicious script shape is removed.",
  },
  "trust.source-drift": {
    audience: "developer",
    failSeverity: "blocking",
    title: "external trust source ref drifted upstream",
    action:
      "Treat the promoted source as stale. Re-review the upstream ref, update the approved pinned SHA if it is intentional, then reacquire the source.",
  },
  "trust.unpinned-dependency": {
    audience: "developer",
    failSeverity: "blocking",
    title: "external source declares an unpinned dependency",
    action:
      "Reject the external source until direct dependencies are pinned to exact versions and a package lockfile is committed.",
  },
  "trust.untrusted-publisher": {
    audience: "developer",
    failSeverity: "blocking",
    title: "external source publisher is not approved",
    action:
      "Use an approved external source, or add the reviewed owner/repository to the org-policy approved source list before promotion.",
  },
  "trust.unsigned-source": {
    audience: "developer",
    failSeverity: "blocking",
    title: "external source is not pinned to a reviewed commit",
    action:
      "Re-run the trust scan or workspace acquisition with `--pin <40-character SHA>` for the reviewed commit.",
  },
};

/** Severity rank for sorting: most urgent first. */
const SEVERITY_RANK: Record<Severity, number> = { blocking: 0, degraded: 1, optional: 2 };

/** External audiences get tool-neutral, system-fix tickets; developers self-fix. */
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
    evidence: meta.evidence,
    affectedArea: meta.affectedArea,
    acceptance: meta.acceptance,
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
