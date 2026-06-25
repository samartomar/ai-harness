import {
  type Action,
  type CommandSpec,
  type Plan,
  type PlanContext,
  plan,
} from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { type HealScope, type HealShared, PYPI_URL, REGISTRY_URL, tlsCheck } from "./common.js";
import { HEAL_STEPS, parseScope } from "./phases.js";

/** A placeholder check for a TLS endpoint that this run's scope didn't probe. */
function notProbed(name: string): Check {
  return { name, verdict: "skip", detail: "not probed (out of scope)" };
}

/**
 * `aih heal` — diagnose AND repair the broken workstation runtime that `certs`
 * assumes works: corporate TLS trust, npm, PATH, and MCP pre-flight. Generic for
 * any TLS-intercepting proxy (Zscaler, Netskope, Palo Alto, …) — the CA subject
 * comes from `--ca-pattern`/`AIH_CA_PATTERN`, never hardcoded.
 *
 * It is a normal capability (dry-run by default; fixes apply under `--apply`) but
 * `alwaysVerify` makes it DIAGNOSE on every run — a bare `aih heal` prints the
 * health report and exits non-zero when something is broken. The only repair it
 * executes is a LOCAL Windows registry write (persist the CA for GUI apps); the
 * npm reinstall is emitted as an operator-run script, so the harness never
 * contacts a remote system.
 */
async function healPlan(ctx: PlanContext): Promise<Plan> {
  const scopes = new Set<HealScope>(parseScope(ctx.options.scope));

  // One TLS handshake per endpoint, shared across the cert/npm/mcp steps. Probe
  // the registry whenever any consumer is in scope; pypi only for the certs step.
  const needRegistry = scopes.has("certs") || scopes.has("npm") || scopes.has("mcp");
  const shared: HealShared = {
    tlsRegistry: needRegistry
      ? await tlsCheck(ctx, "cert: TLS registry.npmjs.org", REGISTRY_URL)
      : notProbed("cert: TLS registry.npmjs.org"),
    tlsPypi: scopes.has("certs")
      ? await tlsCheck(ctx, "cert: TLS pypi.org", PYPI_URL)
      : notProbed("cert: TLS pypi.org"),
  };

  const actions: Action[] = [];
  for (const step of HEAL_STEPS) {
    if (scopes.has(step.key)) actions.push(...(await step.plan(ctx, shared)));
  }
  return plan("heal", ...actions);
}

export const command: CommandSpec = {
  name: "heal",
  summary: "Diagnose and fix a broken runtime (certs/npm/PATH/MCP) behind any TLS proxy",
  alwaysVerify: true,
  options: [
    {
      flags: "--scope <list>",
      description: "heal targets (comma-separated): certs,npm,path,mcp,all",
      default: "all",
    },
    {
      flags: "--ca-pattern <pattern>",
      description: "CA subject substring for the certs check (or set AIH_CA_PATTERN)",
      default: "Zscaler",
    },
  ],
  plan: healPlan,
};
