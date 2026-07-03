/** A single verification outcome produced by a probe action or `doctor`. */
export type Verdict = "pass" | "fail" | "skip";

/**
 * Closed taxonomy of routable verification outcomes. Each member maps 1:1 to a
 * real `fail`/`skip` emitter (see docs/research/check-code-taxonomy-plan.md) so a
 * consumer — support templates, run-ledger findings — can `switch` over it
 * exhaustively rather than string-match `detail` (which rots on a reword). Keep it
 * sealed: a new failure mode means a new member here PLUS the `code` set at the
 * emitter; never derive a code by matching `detail`.
 */
export type CheckCode =
  // environment / runtime
  | "env.node-runtime"
  | "env.git-missing"
  | "env.git-bash-missing"
  | "env.dev-tool-missing"
  | "env.tool-install-blocked"
  // certificates / TLS
  | "cert.ca-missing"
  | "tls.verify-failed"
  // npm
  | "npm.runtime-broken"
  // PATH
  | "path.missing"
  // MCP
  | "mcp.blocked"
  | "mcp.uv-missing"
  | "mcp.config-missing"
  | "mcp.unvendored-offline"
  | "mcp.policy-denied"
  | "mcp.hardcoded-secret"
  | "mcp.allowlist-drift"
  // CLI bootloaders / canon
  | "cli.not-detected"
  | "cli.config-only"
  | "cli.bootloader-missing"
  | "cli.bootloader-drift"
  | "cli.wont-load"
  | "canon.router-missing"
  | "canon.context-dir-missing"
  | "canon.lint-failed"
  | "canon.adoptable"
  | "canon.cli-native-unmigrated"
  // guardrails / secrets
  | "secrets.plaintext-detected"
  | "guardrails.gitleaks-missing"
  // usage
  | "usage.no-data"
  | "usage.recorder-missing"
  | "usage.metrics-tool-missing"
  // scale safety
  | "scale.code-review-graph-missing"
  // repo contract
  | "contract.path-unportable"
  | "contract.stale"
  // org policy
  | "org-policy.drift"
  | "org-policy.invalid"
  | "org-policy.bundle-invalid"
  // report (analytics-derived advisories)
  | "report.context-over-budget"
  | "report.low-adoption"
  | "report.contract-untrue"
  // readiness gate (`aih ready`)
  | "ready.blocked"
  // trust gate (external repos / skills)
  | "trust.fetch-blocked"
  | "trust.detector-unavailable"
  | "trust.cisco-finding"
  | "trust.hidden-unicode"
  | "trust.prompt-injection"
  | "trust.source-changed"
  | "trust.auto-exec-hook"
  | "trust.dependency-confusion"
  | "trust.typosquat"
  | "trust.malicious-code"
  | "trust.source-drift"
  | "trust.unpinned-dependency"
  | "trust.untrusted-publisher"
  | "trust.unsigned-source"
  | "trust.license-missing"
  | "trust.unapproved-skill"
  // skill packs (committed aih-packs.json curation manifest)
  | "pack.duplicate-name"
  | "pack.pin-mismatch"
  | "pack.missing-approval"
  | "pack.unknown-manifest"
  // marketplace artifact (hostable distribution directory built from the approval lock)
  | "marketplace.manifest-parse"
  | "marketplace.path-traversal"
  | "marketplace.missing-file"
  | "marketplace.checksum-mismatch"
  | "marketplace.sums-coverage"
  | "marketplace.unapproved-verdict"
  | "marketplace.signature";

export interface Check {
  name: string;
  verdict: Verdict;
  detail?: string;
  /**
   * Stable machine code for routing (support templates, run-ledger findings). Set
   * ONLY on `fail`/`skip` emitters a consumer keys off — never on a `pass`, and
   * never derived from `detail`. Absent ⇒ not yet ticket-routed. Optional by
   * design, so a Check that omits it serializes byte-for-byte as before.
   */
  code?: CheckCode;
  /** Optional repo-relative artifact location for file-backed findings. */
  location?: {
    uri: string;
    startLine?: number;
  };
  /** Optional stable fingerprint for code-scanning de-dupe. */
  fingerprint?: string;
}

/**
 * Accumulates {@link Check}s and renders a fail-closed report. `skip` never fails
 * the run (used when a tool/daemon is absent); only `fail` flips the exit code.
 */
export class VerificationReport {
  readonly checks: Check[] = [];

  add(check: Check): this {
    this.checks.push(check);
    return this;
  }

  pass(name: string, detail?: string): this {
    return this.add({ name, verdict: "pass", detail });
  }

  fail(name: string, detail?: string): this {
    return this.add({ name, verdict: "fail", detail });
  }

  skip(name: string, detail?: string): this {
    return this.add({ name, verdict: "skip", detail });
  }

  get ok(): boolean {
    return this.checks.every((c) => c.verdict !== "fail");
  }

  counts(): Record<Verdict, number> {
    const c: Record<Verdict, number> = { pass: 0, fail: 0, skip: 0 };
    for (const ch of this.checks) c[ch.verdict] += 1;
    return c;
  }

  /** 0 when no check failed, 1 otherwise. */
  exitCode(): number {
    return this.ok ? 0 : 1;
  }

  toJSON(): { ok: boolean; counts: Record<Verdict, number>; checks: Check[] } {
    return { ok: this.ok, counts: this.counts(), checks: this.checks };
  }

  summary(): string {
    const { pass, fail, skip } = this.counts();
    const lines = this.checks.map((c) => {
      const icon = c.verdict === "pass" ? "OK " : c.verdict === "fail" ? "XX " : "-- ";
      return `  ${icon}${c.name}${c.detail ? ` — ${c.detail}` : ""}`;
    });
    lines.push(`  ${pass} passed, ${fail} failed, ${skip} skipped`);
    return lines.join("\n");
  }
}
