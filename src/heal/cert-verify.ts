import { existsSync } from "node:fs";
import { readIfExists } from "../internals/fsxn.js";
import { type Action, digest, exec, type PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { captured, type HealShared, type HealStep } from "./common.js";
import { certFixDoc, guiCaNote } from "./templates.js";

const ENV_KEY = "NODE_EXTRA_CA_CERTS";
const CHECK = "cert: NODE_EXTRA_CA_CERTS";

/**
 * Diagnose whether the corporate CA is wired into Node's TLS. The AUTHORITATIVE
 * signal is the live TLS handshake (in `shared`): if it succeeds, trust is fine and
 * a missing `NODE_EXTRA_CA_CERTS` is expected (no interception) — NOT a failure, so
 * heal doesn't cry wolf on a machine with no proxy. The env var is only a hard fail
 * when it's set-but-broken (a real misconfig) or when TLS is actually failing.
 */
function caCheck(env: NodeJS.ProcessEnv, tlsOk: boolean, tlsFailed: boolean): Check {
  const p = env[ENV_KEY];
  if (p && existsSync(p) && readIfExists(p)?.includes("BEGIN CERTIFICATE")) {
    return { name: CHECK, verdict: "pass", detail: `${p} (valid PEM)` };
  }
  if (p && !existsSync(p)) {
    return { name: CHECK, verdict: "fail", detail: `set but the file is missing: ${p}` };
  }
  if (p) {
    return { name: CHECK, verdict: "fail", detail: `not a valid PEM bundle: ${p}` };
  }
  // Unset: defer to TLS. Failing TLS → the missing CA is the likely cause (fail);
  // passing TLS → not needed here (skip); not probed → can't tell (skip).
  if (tlsFailed) {
    return {
      name: CHECK,
      verdict: "fail",
      detail: "not set — and TLS is failing; corporate CA likely needed",
    };
  }
  if (tlsOk) {
    return {
      name: CHECK,
      verdict: "skip",
      detail: "not set — not needed; TLS verifies via the system store",
    };
  }
  return { name: CHECK, verdict: "skip", detail: "not set; TLS not probed" };
}

async function planCertVerify(ctx: PlanContext, shared: HealShared): Promise<Action[]> {
  const tlsOk = shared.tlsRegistry.verdict === "pass" && shared.tlsPypi.verdict === "pass";
  const tlsFailed = shared.tlsRegistry.verdict === "fail" || shared.tlsPypi.verdict === "fail";
  const ca = caCheck(ctx.env, tlsOk, tlsFailed);
  const actions: Action[] = [captured(ca), captured(shared.tlsRegistry), captured(shared.tlsPypi)];

  // Prescribe the certs fix when TLS is actually failing, or the env var is
  // set-but-broken. A `skip` (curl absent, or unset-but-TLS-OK) never triggers it.
  if (tlsFailed || ca.verdict === "fail") {
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
