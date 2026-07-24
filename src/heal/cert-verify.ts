import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  NODE_EXTRA_CA_CERTS,
  nodeTrustEnvVars,
  nodeTrustPersistenceActions,
  selectedNodeTrustEnv,
  unselectedNodeTrustKeys,
} from "../certs/node-env.js";
import { AihError } from "../errors.js";
import type { EnvVar } from "../internals/envfile.js";
import { readIfExists } from "../internals/fsxn.js";
import {
  type Action,
  digest,
  envBlock,
  exec,
  type PlanContext,
  probe,
  writeText,
} from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { captured, type HealShared, type HealStep } from "./common.js";
import { probeNodeTls, selectNodeTrustCandidate } from "./node-trust.js";
import { certFixDoc, guiCaNote } from "./templates.js";

const ENV_KEY = NODE_EXTRA_CA_CERTS;
const CHECK = "cert: NODE_EXTRA_CA_CERTS";
const HEAL_NODE_TRUST_SCOPE = "heal-node-trust";
const HEAL_BUNDLE_NAME = "corporate-root-ca.pem";

function absolutePathApi(value: string): typeof posix | typeof win32 | undefined {
  if (posix.isAbsolute(value)) return posix;
  const windowsRoot = win32.parse(value).root;
  const windowsFullyAbsolute =
    win32.isAbsolute(value) && (windowsRoot.includes(":") || windowsRoot.startsWith("\\\\"));
  return windowsFullyAbsolute ? win32 : undefined;
}

function joinFromAbsoluteBase(base: string, ...segments: string[]): string {
  const pathApi = absolutePathApi(base);
  if (pathApi === undefined) {
    throw new AihError(
      "certificate paths require an absolute home or output directory",
      "AIH_UNSAFE_PATH",
    );
  }
  return pathApi.join(base, ...segments);
}

/**
 * Diagnose whether the corporate CA is wired into Node's TLS. The AUTHORITATIVE
 * signal is the live TLS handshake (in `shared`): if it succeeds, trust is fine and
 * a missing `NODE_EXTRA_CA_CERTS` is expected (no interception) — NOT a failure, so
 * heal doesn't cry wolf on a machine with no proxy. The env var is only a hard fail
 * when it's set-but-broken (a real misconfig) or when TLS is actually failing.
 */
function caCheck(
  env: NodeJS.ProcessEnv,
  tlsOk: boolean,
  tlsFailed: boolean,
  nodeTrustDiverged: boolean,
): Check {
  const p = env[ENV_KEY];
  if (nodeTrustDiverged) {
    return {
      name: CHECK,
      verdict: "fail",
      detail: "Node TLS verification fails despite an OS-verified origin",
      code: "tls.verify-failed",
    };
  }
  if (p && existsSync(p) && readIfExists(p)?.includes("BEGIN CERTIFICATE")) {
    return { name: CHECK, verdict: "pass", detail: "configured PEM bundle is present and valid" };
  }
  if (p && !existsSync(p)) {
    return {
      name: CHECK,
      verdict: "fail",
      detail: "configured PEM bundle file is missing",
      code: "cert.ca-missing",
    };
  }
  if (p) {
    return {
      name: CHECK,
      verdict: "fail",
      detail: "configured bundle is not valid PEM",
      code: "cert.ca-missing",
    };
  }
  // Unset: defer to TLS. Failing TLS → the missing CA is the likely cause (fail);
  // passing TLS → not needed here (skip); not probed → can't tell (skip).
  if (tlsFailed) {
    return {
      name: CHECK,
      verdict: "fail",
      detail: "not set — and TLS is failing; corporate CA likely needed",
      code: "cert.ca-missing",
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

function finalTrustProbe(origins: readonly string[], vars: readonly EnvVar[]): Action {
  return probe("cert: verify persisted Node trust", async (probeCtx) => {
    const env = selectedNodeTrustEnv(probeCtx.env, vars);

    let failed = 0;
    for (const origin of origins) {
      if ((await probeNodeTls(probeCtx, origin, env)).verdict !== "pass") failed += 1;
    }
    return failed === 0
      ? {
          name: "cert: verify persisted Node trust",
          verdict: "pass",
          detail: `selected Node trust verified across ${origins.length} reviewed origin(s)`,
        }
      : {
          name: "cert: verify persisted Node trust",
          verdict: "fail",
          code: "tls.verify-failed",
          detail: `selected Node trust failed for ${failed} of ${origins.length} reviewed origin(s)`,
        };
  });
}

function supersededByFinalTrustProbe(check: Check): Check {
  return {
    name: check.name,
    verdict: "skip",
    detail: "pre-apply Node trust divergence; final persisted trust verification owns the result",
  };
}

async function planCertVerify(ctx: PlanContext, shared: HealShared): Promise<Action[]> {
  const tlsOk = shared.tlsRegistry.verdict === "pass" && shared.tlsPypi.verdict === "pass";
  const divergentOrigins = shared.runtimeTls
    .filter(({ os, node }) => os.verdict === "pass" && node.verdict === "fail")
    .map(({ origin }) => origin);
  const nodeTrustDiverged = divergentOrigins.length > 0;
  const tlsFailed =
    shared.tlsRegistry.verdict === "fail" || shared.tlsPypi.verdict === "fail" || nodeTrustDiverged;
  const ca = caCheck(ctx.env, tlsOk, tlsFailed, nodeTrustDiverged);
  const actions: Action[] = [
    captured(ca),
    ...shared.runtimeTls.flatMap(({ os, node }) => [captured(os), captured(node)]),
  ];

  // A generic CA repair remains appropriate for OS-level TLS failures and a broken
  // explicitly configured bundle. Runtime-only divergence takes the narrower,
  // candidate-verified path below instead.
  if ((tlsFailed || ca.verdict === "fail") && !nodeTrustDiverged) {
    const pattern = String(ctx.options.caPattern ?? "Zscaler");
    const flag =
      ctx.host.envShell() === "powershell"
        ? `--ca-pattern "${pattern}"`
        : `--ca-pattern '${pattern}'`;
    actions.push(digest("heal: re-propagate corporate trust", certFixDoc(pattern, flag)));
  }

  if (!nodeTrustDiverged) return actions;

  const candidate = await selectNodeTrustCandidate(ctx, divergentOrigins);
  if (candidate.kind === "unresolved") {
    actions.push(
      digest(
        "heal: unresolved Node trust candidate",
        "No candidate passed Node verification for every reviewed origin. No trust settings were changed; keep TLS verification enabled and review the local trust chain before retrying.",
      ),
    );
    return actions;
  }

  if (ctx.apply) {
    actions.splice(
      0,
      actions.length,
      captured(supersededByFinalTrustProbe(ca)),
      ...shared.runtimeTls.flatMap(({ os, node }) => [
        captured(os),
        captured(
          os.verdict === "pass" && node.verdict === "fail"
            ? supersededByFinalTrustProbe(node)
            : node,
        ),
      ]),
    );
  }

  const home = ctx.env.USERPROFILE || ctx.env.HOME || ctx.root;
  const profile = ctx.host.shellProfilePaths()[0] ?? joinFromAbsoluteBase(home, ".profile");
  let vars: EnvVar[];
  if (candidate.kind === "system-ca") {
    vars = nodeTrustEnvVars();
    actions.push(
      envBlock(
        profile,
        HEAL_NODE_TRUST_SCOPE,
        ctx.host.envShell(),
        vars,
        "persist the verified Node system-CA selection in the managed shell profile",
        {
          unsetKeys: unselectedNodeTrustKeys(vars),
          sensitive: { path: true },
        },
      ),
      ...nodeTrustPersistenceActions(ctx, vars),
    );
  } else {
    const bundlePath = joinFromAbsoluteBase(home, ".config", "enterprise-ca", HEAL_BUNDLE_NAME);
    vars = nodeTrustEnvVars(bundlePath).filter((variable) => variable.key === NODE_EXTRA_CA_CERTS);
    const bundle = candidate.certs.map((cert) => cert.pem).join("");
    const lockArgv = ctx.host.lockDownFileArgv(bundlePath);
    actions.push(
      writeText(
        bundlePath,
        bundle,
        `selected minimal Node CA bundle (${candidate.certs.length} cert(s))`,
        { external: true, sensitive: { path: true } },
      ),
      exec("lock down the selected Node CA bundle to the current user", lockArgv, {
        blockProbesOnFailure: true,
        sensitive: {
          argv: lockArgv.flatMap((value, index) => (value === bundlePath ? [index] : [])),
        },
        failureCheck: {
          name: "cert: lock selected Node CA bundle",
          verdict: "fail",
          code: "cert.ca-missing",
          detail: "could not lock the selected Node CA bundle to the current user",
        },
      }),
      envBlock(
        profile,
        HEAL_NODE_TRUST_SCOPE,
        ctx.host.envShell(),
        vars,
        "persist the verified minimal Node CA bundle in the managed shell profile",
        {
          unsetKeys: unselectedNodeTrustKeys(vars),
          sensitive: { path: true },
          requiresPriorExecSuccess: true,
        },
      ),
      ...nodeTrustPersistenceActions(ctx, vars).map((action) =>
        action.kind === "write" ? { ...action, requiresPriorExecSuccess: true } : action,
      ),
    );
  }

  actions.push(
    digest(
      "heal: selected Node trust configuration",
      guiCaNote(vars.map((variable) => variable.key)),
    ),
  );
  if (ctx.apply) actions.push(finalTrustProbe(divergentOrigins, vars));
  return actions;
}

export const certStep: HealStep = {
  key: "certs",
  title: "certificate trust chain",
  plan: planCertVerify,
};
