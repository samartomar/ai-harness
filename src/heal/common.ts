import { type Action, type PlanContext, type ProbeAction, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";

/**
 * Shared contract for the `heal` steps. Each step DIAGNOSES at plan-build time and
 * returns the actions it contributes: captured `probe`s (the health report), a
 * `digest` carrying any visible fix guidance, and — only where the fix is a local
 * mutation (Windows registry env) — an `exec`. Nothing here ever contacts a remote;
 * the npm reinstall is emitted as operator-run guidance, never executed.
 */

export type HealScope = "certs" | "npm" | "path" | "mcp";
export const HEAL_SCOPES: readonly HealScope[] = ["certs", "npm", "path", "mcp"] as const;

/** Registries the cert/npm steps probe for TLS reachability (trusted constants). */
export const REGISTRY_URL = "https://registry.npmjs.org";
export const PYPI_URL = "https://pypi.org";

/**
 * Cross-step facts computed ONCE per run (by the orchestrator) and threaded into
 * the steps, so the TLS handshake is probed a single time rather than re-spawned
 * by both the cert and npm steps.
 */
export interface HealShared {
  tlsRegistry: Check;
  tlsPypi: Check;
}

/** One ordered heal step; `plan` returns the actions this step contributes. */
export interface HealStep {
  key: HealScope;
  title: string;
  plan(ctx: PlanContext, shared: HealShared): Promise<Action[]>;
}

/** Hostname of a URL for terse probe details (never throws on a constant URL). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Read-only TLS reachability probe. Exit 0 → `pass`; tool absent (`spawnError`) →
 * `skip` (never fails the run, per the verification contract); any other exit →
 * `fail` with the proxy/cert detail. This is the one place heal spawns a process
 * to observe the network — it mutates nothing.
 */
export async function tlsCheck(ctx: PlanContext, name: string, url: string): Promise<Check> {
  const res = await ctx.run(ctx.host.tlsProbeArgv(url));
  if (res.spawnError) {
    return { name, verdict: "skip", detail: "TLS probe tool unavailable" };
  }
  if (res.code === 0) {
    return { name, verdict: "pass", detail: `handshake to ${hostOf(url)} OK` };
  }
  const firstErr = res.stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return {
    name,
    verdict: "fail",
    detail: firstErr ? `TLS/proxy failure — ${firstErr}` : `TLS probe exited ${res.code}`,
  };
}

/**
 * Turn an already-computed {@link Check} into a probe action that simply returns
 * it. The diagnosis runs once at plan-build; under `--verify` the executor just
 * collects these captured results (no second curl/pwsh spawn).
 */
export function captured(check: Check): ProbeAction {
  return probe(check.name, () => check);
}
