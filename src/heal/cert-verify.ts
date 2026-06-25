import { existsSync } from "node:fs";
import { readIfExists } from "../internals/fsxn.js";
import { type Action, digest, exec, type PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { captured, type HealShared, type HealStep } from "./common.js";
import { certFixDoc, guiCaNote } from "./templates.js";

const ENV_KEY = "NODE_EXTRA_CA_CERTS";
const CHECK = "cert: NODE_EXTRA_CA_CERTS";

/**
 * Diagnose whether the corporate CA is actually wired into Node's TLS — not just
 * that `certs` ran, but that the env var points at a real, valid PEM. This is the
 * file every Node-based runtime (npm, Kiro, Claude, MCP servers) reads, so a break
 * here cascades into all of them.
 */
function caCheck(env: NodeJS.ProcessEnv): Check {
  const p = env[ENV_KEY];
  if (!p) {
    return {
      name: CHECK,
      verdict: "fail",
      detail: "not set — runtimes won't trust the corporate CA",
    };
  }
  if (!existsSync(p)) {
    return { name: CHECK, verdict: "fail", detail: `set but the file is missing: ${p}` };
  }
  const body = readIfExists(p);
  if (!body?.includes("BEGIN CERTIFICATE")) {
    return { name: CHECK, verdict: "fail", detail: `not a valid PEM bundle: ${p}` };
  }
  return { name: CHECK, verdict: "pass", detail: `${p} (valid PEM)` };
}

async function planCertVerify(ctx: PlanContext, shared: HealShared): Promise<Action[]> {
  const ca = caCheck(ctx.env);
  const actions: Action[] = [captured(ca), captured(shared.tlsRegistry), captured(shared.tlsPypi)];

  // "Broken" = any hard failure in the chain. A `skip` (e.g. curl absent) is not a
  // failure — heal can't conclude the trust is broken, so it won't prescribe a fix.
  const broken = [ca, shared.tlsRegistry, shared.tlsPypi].some((c) => c.verdict === "fail");
  if (broken) {
    const pattern = String(ctx.options.caPattern ?? "Zscaler");
    const flag =
      ctx.host.envShell() === "powershell"
        ? `--ca-pattern "${pattern}"`
        : `--ca-pattern '${pattern}'`;
    actions.push(digest("heal: re-propagate corporate trust", certFixDoc(pattern, flag)));
  }

  // Windows only: when the CA is valid in this shell, also persist it at the
  // per-user registry scope so GUI-launched apps (Kiro/Claude/IDEs) inherit it —
  // the PowerShell $PROFILE export never reaches them. `persistentEnvArgv` returns
  // [] on POSIX (the profile envblock is the durable seam there), so nothing is
  // emitted off-Windows. The set is idempotent (same value), and it's a LOCAL
  // registry write — never a remote call.
  if (ca.verdict === "pass") {
    const persist = ctx.host.persistentEnvArgv(ENV_KEY, ctx.env[ENV_KEY] as string);
    if (persist.length > 0) {
      actions.push(exec("persist the CA at user scope so GUI apps inherit it", persist));
      actions.push(digest("heal: GUI apps inherit the CA (Windows)", guiCaNote()));
    }
  }

  return actions;
}

export const certStep: HealStep = {
  key: "certs",
  title: "certificate trust chain",
  plan: planCertVerify,
};
