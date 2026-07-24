import { X509Certificate } from "node:crypto";
import { nodeTrustEnvVars, selectedNodeTrustEnv } from "../certs/node-env.js";
import { readAihConfig } from "../config/marker.js";
import { entry } from "../internals/cli-registry.js";
import { type Cli, SUPPORTED_CLIS } from "../internals/clis.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import type { CertEntry } from "../platform/base.js";
import { PYPI_URL, REGISTRY_URL } from "./common.js";

const MAX_TLS_ORIGINS = 6;
const NODE_TLS_TIMEOUT_MS = 25_000;
const NODE_TRUST_SELECTION_TIMEOUT_MS = 120_000;
const MAX_NODE_TRUST_SELECTION_PROBES = 128;

const NODE_TLS_SCRIPT =
  "const tls=require('node:tls');const u=new URL(process.argv[1]);" +
  "const h=u.hostname.replace(/^\\[(.*)\\]$/,'$1');" +
  "const s=tls.connect({host:h,port:Number(u.port||443),servername:h,timeout:20000," +
  "rejectUnauthorized:true},()=>{const ok=s.authorized;s.end();process.exit(ok?0:1)});" +
  "s.on('error',()=>process.exit(1));" +
  "s.on('timeout',()=>{s.destroy();process.exit(1)})";

const MAX_CAPTURED_CHAIN_CERTS = 8;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_ROOTS_PER_ORIGIN = 8;
const MAX_CANDIDATE_UNIONS = 256;
const MAX_TRUST_STORE_ROOTS = 1024;
const MAX_ROOT_PEM_BYTES = 64 * 1024;

const NODE_TLS_CAPTURE_SCRIPT =
  "const tls=require('node:tls');const u=new URL(process.argv[1]);" +
  "const h=u.hostname.replace(/^\\[(.*)\\]$/,'$1');" +
  "const s=tls.connect({host:h,port:Number(u.port||443),servername:h," +
  "rejectUnauthorized:false,timeout:20000},()=>{" +
  "const out=[];const seen=new Set();let c=s.getPeerCertificate(true);" +
  `for(let i=0;c&&c.raw&&i<${MAX_CAPTURED_CHAIN_CERTS};i++){` +
  "const raw=c.raw.toString('base64');if(seen.has(raw))break;" +
  "seen.add(raw);out.push(raw);const next=c.issuerCertificate;" +
  "if(!next||next===c)break;c=next}" +
  "s.destroy();process.stdout.write(JSON.stringify(out),()=>process.exit(0))});" +
  "s.on('error',()=>process.exit(1));" +
  "s.on('timeout',()=>{s.destroy();process.exit(1)})";

const NODE_TLS_EXTRA_CA_SCRIPT =
  "const fs=require('node:fs');const tls=require('node:tls');" +
  "const u=new URL(process.argv[1]);const h=u.hostname.replace(/^\\[(.*)\\]$/,'$1');" +
  "let extra;try{extra=JSON.parse(fs.readFileSync(0,'utf8'))}catch{process.exit(1)}" +
  "if(!Array.isArray(extra)||!extra.every((pem)=>typeof pem==='string'))process.exit(1);" +
  "const s=tls.connect({host:h,port:Number(u.port||443),servername:h,timeout:20000," +
  "rejectUnauthorized:true,ca:[...tls.rootCertificates,...extra]},()=>{" +
  "const ok=s.authorized;s.end();process.exit(ok?0:1)});" +
  "s.on('error',()=>process.exit(1));" +
  "s.on('timeout',()=>{s.destroy();process.exit(1)})";

export interface RuntimeTlsObservation {
  origin: string;
  os: Check;
  node: Check;
}

export type NodeTrustCandidate =
  | { kind: "system-ca" }
  | { kind: "extra-ca"; certs: CertEntry[] }
  | { kind: "unresolved" };

interface ParsedRoot {
  entry: CertEntry;
  cert: X509Certificate;
  fingerprint: string;
}

interface ProbeBudget {
  deadline: number;
  remaining: number;
}

function remainingProbeTimeout(budget: ProbeBudget): number | undefined {
  if (budget.remaining === 0) return undefined;
  const remainingMs = budget.deadline - Date.now();
  if (remainingMs <= 0) return undefined;
  budget.remaining -= 1;
  return Math.min(NODE_TLS_TIMEOUT_MS, remainingMs);
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

function candidateOrigins(values: readonly string[]): string[] | undefined {
  const origins: string[] = [];
  for (const value of values) {
    const origin = httpsOrigin(value);
    if (origin === undefined) return undefined;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins.length > 0 && origins.length <= MAX_TLS_ORIGINS ? origins : undefined;
}

function verifiedTlsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe = { ...env };
  for (const key of Object.keys(safe)) {
    if (key.toLowerCase() === "node_tls_reject_unauthorized") delete safe[key];
  }
  return safe;
}

function parseCapturedChain(stdout: string): X509Certificate[] | undefined {
  if (Buffer.byteLength(stdout, "utf8") > MAX_CAPTURE_BYTES) return undefined;
  let values: unknown;
  try {
    values = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_CAPTURED_CHAIN_CERTS) {
    return undefined;
  }

  const chain: X509Certificate[] = [];
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_CAPTURE_BYTES ||
      value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    ) {
      return undefined;
    }
    try {
      chain.push(new X509Certificate(Buffer.from(value, "base64")));
    } catch {
      return undefined;
    }
  }
  return chain;
}

function validRoots(entries: readonly CertEntry[], now: number): ParsedRoot[] {
  const roots = new Map<string, ParsedRoot>();
  for (const entry of entries) {
    if (Buffer.byteLength(entry.pem, "utf8") > MAX_ROOT_PEM_BYTES) continue;
    try {
      const cert = new X509Certificate(entry.pem);
      const validFrom = Date.parse(cert.validFrom);
      const validTo = Date.parse(cert.validTo);
      if (
        !cert.ca ||
        !Number.isFinite(validFrom) ||
        !Number.isFinite(validTo) ||
        now < validFrom ||
        now > validTo
      ) {
        continue;
      }
      const fingerprint = cert.fingerprint256;
      if (!roots.has(fingerprint)) {
        roots.set(fingerprint, {
          cert,
          fingerprint,
          entry: { subject: cert.subject, pem: cert.toString() },
        });
      }
    } catch {
      // Malformed trust-store entries are not candidates.
    }
  }
  return [...roots.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

function rootIssuesTail(root: X509Certificate, tail: X509Certificate): boolean {
  try {
    return tail.checkIssued(root) && tail.verify(root.publicKey);
  } catch {
    return false;
  }
}

function rootCandidateUnions(
  candidatesByOrigin: readonly (readonly ParsedRoot[])[],
): ParsedRoot[][] | undefined {
  if (
    candidatesByOrigin.length === 0 ||
    candidatesByOrigin.some(
      (candidates) => candidates.length === 0 || candidates.length > MAX_ROOTS_PER_ORIGIN,
    )
  ) {
    return undefined;
  }

  const unions = new Map<string, ParsedRoot[]>();
  const selected = new Map<string, ParsedRoot>();
  let exceeded = false;

  const visit = (originIndex: number): void => {
    if (exceeded) return;
    if (originIndex === candidatesByOrigin.length) {
      const roots = [...selected.values()].sort((a, b) =>
        a.fingerprint.localeCompare(b.fingerprint),
      );
      const key = roots.map((root) => root.fingerprint).join("|");
      if (!unions.has(key)) {
        if (unions.size === MAX_CANDIDATE_UNIONS) {
          exceeded = true;
          return;
        }
        unions.set(key, roots);
      }
      return;
    }

    for (const root of candidatesByOrigin[originIndex] ?? []) {
      const alreadySelected = selected.has(root.fingerprint);
      selected.set(root.fingerprint, root);
      visit(originIndex + 1);
      if (!alreadySelected) selected.delete(root.fingerprint);
    }
  };

  visit(0);
  if (exceeded) return undefined;
  return [...unions.values()].sort((a, b) => {
    const byCardinality = a.length - b.length;
    if (byCardinality !== 0) return byCardinality;
    return a
      .map((root) => root.fingerprint)
      .join("|")
      .localeCompare(b.map((root) => root.fingerprint).join("|"));
  });
}

async function capturePeerChain(
  ctx: PlanContext,
  origin: string,
  timeoutMs: number,
): Promise<X509Certificate[] | undefined> {
  const result = await ctx.run(["node", "-e", NODE_TLS_CAPTURE_SCRIPT, origin], {
    env: ctx.env,
    timeoutMs,
    maxBufferBytes: MAX_CAPTURE_BYTES,
  });
  if (result.spawnError || result.truncated || result.code !== 0) return undefined;
  return parseCapturedChain(result.stdout);
}

async function probeExtraCa(
  ctx: PlanContext,
  origin: string,
  certs: readonly CertEntry[],
  timeoutMs: number,
): Promise<boolean> {
  const result = await ctx.run(["node", "-e", NODE_TLS_EXTRA_CA_SCRIPT, origin], {
    env: verifiedTlsEnv(selectedNodeTrustEnv(ctx.env, [])),
    input: JSON.stringify(certs.map((cert) => cert.pem)),
    timeoutMs,
    maxBufferBytes: 4096,
  });
  return !result.spawnError && !result.truncated && result.code === 0;
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
  timeoutMs = NODE_TLS_TIMEOUT_MS,
): Promise<Check> {
  const host = new URL(origin).host;
  const result = await ctx.run(["node", "-e", NODE_TLS_SCRIPT, origin], {
    env: verifiedTlsEnv(env),
    timeoutMs,
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

export async function selectNodeTrustCandidate(
  ctx: PlanContext,
  divergentOrigins: readonly string[],
): Promise<NodeTrustCandidate> {
  const origins = candidateOrigins(divergentOrigins);
  if (origins === undefined) return { kind: "unresolved" };

  const budget: ProbeBudget = {
    deadline: Date.now() + NODE_TRUST_SELECTION_TIMEOUT_MS,
    remaining: MAX_NODE_TRUST_SELECTION_PROBES,
  };
  const systemEnv = selectedNodeTrustEnv(ctx.env, nodeTrustEnvVars());
  let systemCaPasses = true;
  for (const origin of origins) {
    const timeoutMs = remainingProbeTimeout(budget);
    if (timeoutMs === undefined) return { kind: "unresolved" };
    if ((await probeNodeTls(ctx, origin, systemEnv, timeoutMs)).verdict !== "pass") {
      systemCaPasses = false;
    }
  }
  if (systemCaPasses) return { kind: "system-ca" };

  const chains: X509Certificate[][] = [];
  for (const origin of origins) {
    const timeoutMs = remainingProbeTimeout(budget);
    if (timeoutMs === undefined) return { kind: "unresolved" };
    const chain = await capturePeerChain(ctx, origin, timeoutMs);
    if (chain === undefined) return { kind: "unresolved" };
    chains.push(chain);
  }

  const rootEntries = await ctx.host.trustStoreRoots();
  if (rootEntries.length > MAX_TRUST_STORE_ROOTS) return { kind: "unresolved" };
  const roots = validRoots(rootEntries, Date.now());
  const candidatesByOrigin: ParsedRoot[][] = [];
  for (const chain of chains) {
    const tail = chain.at(-1);
    if (tail === undefined) return { kind: "unresolved" };
    candidatesByOrigin.push(roots.filter((root) => rootIssuesTail(root.cert, tail)));
  }

  const unions = rootCandidateUnions(candidatesByOrigin);
  if (unions === undefined) return { kind: "unresolved" };

  for (const union of unions) {
    const certs = union.map((root) => root.entry);
    let passes = true;
    for (const origin of origins) {
      const timeoutMs = remainingProbeTimeout(budget);
      if (timeoutMs === undefined) return { kind: "unresolved" };
      if (!(await probeExtraCa(ctx, origin, certs, timeoutMs))) passes = false;
    }
    if (passes) return { kind: "extra-ca", certs };
  }
  return { kind: "unresolved" };
}
