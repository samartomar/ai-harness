/** A single verification outcome produced by a probe action or `doctor`. */
export type Verdict = "pass" | "fail" | "skip";

export interface Check {
  name: string;
  verdict: Verdict;
  detail?: string;
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
