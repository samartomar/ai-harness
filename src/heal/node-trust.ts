import { readAihConfig } from "../config/marker.js";
import { entry } from "../internals/cli-registry.js";
import { type Cli, SUPPORTED_CLIS } from "../internals/clis.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { PYPI_URL, REGISTRY_URL } from "./common.js";

const MAX_TLS_ORIGINS = 6;

const NODE_TLS_SCRIPT =
  "const tls=require('node:tls');const u=new URL(process.argv[1]);" +
  "const h=u.hostname.replace(/^\\[(.*)\\]$/,'$1');" +
  "const s=tls.connect({host:h,port:Number(u.port||443),servername:h,timeout:20000}," +
  "()=>{s.end();process.exit(0)});" +
  "s.on('error',()=>process.exit(1));" +
  "s.on('timeout',()=>{s.destroy();process.exit(1)})";

export interface RuntimeTlsObservation {
  origin: string;
  os: Check;
  node: Check;
}

function httpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function runtimeTlsOrigins(ctx: PlanContext): string[] {
  const targetStrings = ctx.targets ?? readAihConfig(ctx.root)?.targets ?? [];
  const targets = targetStrings.filter((target): target is Cli =>
    (SUPPORTED_CLIS as readonly string[]).includes(target),
  );
  const candidates = [REGISTRY_URL, PYPI_URL];
  for (const cli of targets) candidates.push(...(entry(cli).tlsOrigins ?? []));

  const origins: string[] = [];
  for (const candidate of candidates) {
    const origin = httpsOrigin(candidate);
    if (origin !== undefined && !origins.includes(origin)) origins.push(origin);
    if (origins.length === MAX_TLS_ORIGINS) break;
  }
  return origins;
}

export async function probeNodeTls(
  ctx: PlanContext,
  origin: string,
  env: NodeJS.ProcessEnv = ctx.env,
): Promise<Check> {
  const host = new URL(origin).host;
  const result = await ctx.run(["node", "-e", NODE_TLS_SCRIPT, origin], {
    env,
    timeoutMs: 25_000,
  });
  if (result.spawnError && !/timed out/i.test(result.stderr)) {
    return { name: `cert: Node TLS ${host}`, verdict: "skip", detail: "node not found on PATH" };
  }
  return result.code === 0
    ? { name: `cert: Node TLS ${host}`, verdict: "pass", detail: `Node handshake to ${host} OK` }
    : {
        name: `cert: Node TLS ${host}`,
        verdict: "fail",
        code: "tls.verify-failed",
        detail: `Node TLS verification failed for ${host}`,
      };
}
