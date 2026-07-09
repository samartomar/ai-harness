import { join } from "node:path";
import { readRegularFile } from "../internals/fsxn.js";
import { parseJsoncText } from "../internals/merge.js";
import { type Action, digest, type PlanContext, probe } from "../internals/plan.js";
import type { RunResult } from "../internals/proc.js";
import type { Check } from "../internals/verify.js";
import { captured, classifyTool, type HealShared, type HealStep, versionArgv } from "./common.js";
import { mcpTlsInterceptionDoc } from "./templates.js";

const CHECK = "mcp: npx launcher";
const MAX_ENDPOINT_PROBES = 3;
const PROBE_ENDPOINTS_OPTION = "probeMcpEndpoints";

interface McpInventory {
  configured: boolean;
  usesNpx: boolean;
  nodeRuntime: boolean;
  pythonRuntime: boolean;
  endpoints: string[];
}

interface EndpointTarget {
  endpoint: string;
  host: string;
  connect: string;
  servername: string;
}

function safeHttpsOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function stringTokens(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function addEndpoint(out: Set<string>, value: unknown): void {
  const origin = safeHttpsOrigin(value);
  if (origin !== undefined) out.add(origin);
}

function addAtlassianEnvEndpoints(
  out: Set<string>,
  env: unknown,
  processEnv: NodeJS.ProcessEnv,
): void {
  if (env !== null && typeof env === "object" && !Array.isArray(env)) {
    const record = env as Record<string, unknown>;
    addEndpoint(out, record.JIRA_URL);
    addEndpoint(out, record.CONFLUENCE_URL);
  }
  addEndpoint(out, processEnv.JIRA_URL);
  addEndpoint(out, processEnv.CONFLUENCE_URL);
}

/** Does this repo configure MCP servers that shell out to `npx`? */
function mcpInventory(ctx: PlanContext): McpInventory {
  const raw = readRegularFile(join(ctx.root, ".mcp.json"))?.toString("utf8");
  const empty: McpInventory = {
    configured: false,
    usesNpx: false,
    nodeRuntime: false,
    pythonRuntime: false,
    endpoints: [],
  };
  if (raw === undefined) return empty;
  try {
    const parsed = parseJsoncText(raw) as { mcpServers?: unknown };
    const servers = parsed.mcpServers;
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
      return { ...empty, configured: true };
    }
    const endpoints = new Set<string>();
    let usesNpx = false;
    let nodeRuntime = false;
    let pythonRuntime = false;
    for (const [name, server] of Object.entries(servers)) {
      if (server === null || typeof server !== "object" || Array.isArray(server)) continue;
      const record = server as Record<string, unknown>;
      const command = typeof record.command === "string" ? record.command : "";
      const tokens = [name, command, ...stringTokens(record.args)].map((token) =>
        token.toLowerCase(),
      );
      const explicitOrigin = safeHttpsOrigin(record.url);
      if (explicitOrigin !== undefined) endpoints.add(explicitOrigin);
      const hasExplicitUrl = typeof record.url === "string" && record.url.trim().length > 0;
      if (tokens.some((token) => token.includes("github")) && !hasExplicitUrl) {
        addEndpoint(endpoints, "https://api.github.com");
      }
      if (tokens.some((token) => token.includes("atlassian") || token.includes("jira"))) {
        addAtlassianEnvEndpoints(endpoints, record.env, ctx.env);
      }
      if (command === "npx" || command === "npm") {
        usesNpx = true;
        nodeRuntime = true;
        addEndpoint(endpoints, "https://registry.npmjs.org");
      }
      if (
        command === "node" ||
        command === "npx" ||
        command === "npm" ||
        tokens.some((token) => token.endsWith(".js"))
      ) {
        nodeRuntime = true;
      }
      if (
        command === "python" ||
        command === "python3" ||
        command === "uvx" ||
        command === "uv" ||
        tokens.some((token) => token.includes("python") || token.includes("mcp-atlassian"))
      ) {
        pythonRuntime = true;
      }
    }
    return {
      configured: true,
      usesNpx,
      nodeRuntime,
      pythonRuntime,
      endpoints: [...endpoints].sort((a, b) => a.localeCompare(b)).slice(0, MAX_ENDPOINT_PROBES),
    };
  } catch {
    return { ...empty, configured: true };
  }
}

function endpointList(endpoints: readonly string[]): string {
  return endpoints.map((endpoint) => new URL(endpoint).host).join(", ");
}

function endpointTarget(endpoint: string): EndpointTarget {
  const url = new URL(endpoint);
  const servername = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const connectHost = servername.includes(":") ? `[${servername}]` : servername;
  return {
    endpoint,
    host: url.host,
    connect: `${connectHost}:${url.port || "443"}`,
    servername,
  };
}

function probeEndpointTls(ctx: PlanContext): boolean {
  return ctx.options[PROBE_ENDPOINTS_OPTION] === true;
}

function firstErrorLine(text: string): string | undefined {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: openssl output is external text; strip control bytes before embedding the first error line.
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0)
  );
}

function missingExecutable(res: RunResult): boolean {
  return res.spawnError === true && !/timed out/i.test(res.stderr);
}

async function nodeTlsCheck(ctx: PlanContext, endpoints: readonly string[]): Promise<Check> {
  const name = "mcp: Node TLS endpoints";
  const ca = ctx.env.NODE_EXTRA_CA_CERTS;
  for (const endpoint of endpoints) {
    const res = await ctx.run(
      [
        "node",
        "-e",
        "const tls=require('node:tls');const u=new URL(process.argv[1]);const host=u.hostname.replace(/^\\[(.*)\\]$/,'$1');const s=tls.connect({host,port:Number(u.port||443),servername:host,timeout:20000},()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));s.on('timeout',()=>{s.destroy();process.exit(1)})",
        endpoint,
      ],
      { timeoutMs: 25_000 },
    );
    if (missingExecutable(res)) return { name, verdict: "skip", detail: "node not found on PATH" };
    if (res.code !== 0) {
      return {
        name,
        verdict: "fail",
        code: "mcp.blocked",
        detail:
          `Node TLS failed for ${new URL(endpoint).host}; compare the served certificate chain ` +
          `with ${ca ? `NODE_EXTRA_CA_CERTS=${ca}` : "NODE_EXTRA_CA_CERTS (not set)"} and rebuild the CA bundle if it is stale or incomplete.`,
      };
    }
  }
  return {
    name,
    verdict: "pass",
    detail: `Node verified MCP endpoint TLS: ${endpointList(endpoints)}`,
  };
}

async function caBundleTlsCheck(
  ctx: PlanContext,
  endpoints: readonly string[],
  runtime: "Node" | "Python",
  envName: "NODE_EXTRA_CA_CERTS" | "SSL_CERT_FILE",
): Promise<Check> {
  const name = `mcp: ${runtime} CA bundle verifies endpoints`;
  const ca = ctx.env[envName];
  if (ca === undefined || ca.trim().length === 0) {
    return {
      name,
      verdict: "skip",
      detail: `${envName} is not set, so aih cannot compare served MCP chains to that runtime bundle`,
    };
  }
  for (const endpoint of endpoints) {
    const target = endpointTarget(endpoint);
    const res = await ctx.run(
      [
        "openssl",
        "s_client",
        "-connect",
        target.connect,
        "-servername",
        target.servername,
        "-verify_return_error",
        "-CAfile",
        ca,
        "-showcerts",
      ],
      { timeoutMs: 20_000 },
    );
    if (missingExecutable(res)) {
      return { name, verdict: "skip", detail: "openssl not found on PATH" };
    }
    if (res.code !== 0) {
      const error = firstErrorLine(res.stderr || res.stdout);
      return {
        name,
        verdict: "fail",
        code: "mcp.blocked",
        detail:
          `${runtime} CA bundle ${envName} did not verify the served TLS chain for ${target.host}; ` +
          `the bundle may be stale or incomplete${error ? ` (${error})` : ""}`,
      };
    }
  }
  return {
    name,
    verdict: "pass",
    detail: `${runtime} CA bundle ${envName} verified MCP endpoint TLS chains: ${endpointList(endpoints)}`,
  };
}

async function pythonTlsCheck(ctx: PlanContext, endpoints: readonly string[]): Promise<Check> {
  const name = "mcp: Python TLS endpoints";
  const ca = ctx.env.SSL_CERT_FILE;
  const argvPrefix = ctx.host.platform === "windows" ? ["py", "-3"] : ["python3"];
  for (const endpoint of endpoints) {
    const res = await ctx.run(
      [
        ...argvPrefix,
        "-c",
        "import socket, ssl, sys, urllib.parse; u=urllib.parse.urlparse(sys.argv[1]); host=u.hostname or ''; port=u.port or 443; ctx=ssl.create_default_context(); sock=socket.create_connection((host, port), timeout=20); tls=ctx.wrap_socket(sock, server_hostname=host); tls.close()",
        endpoint,
      ],
      { timeoutMs: 25_000 },
    );
    if (missingExecutable(res)) {
      return {
        name,
        verdict: "skip",
        detail:
          ctx.host.platform === "windows"
            ? "Python launcher `py -3` not found on PATH"
            : "python3 not found on PATH",
      };
    }
    if (res.code !== 0) {
      return {
        name,
        verdict: "fail",
        code: "mcp.blocked",
        detail:
          `Python TLS failed for ${new URL(endpoint).host}; compare the served certificate chain ` +
          `with ${ca ? `SSL_CERT_FILE=${ca}` : "SSL_CERT_FILE (not set)"} and rebuild the CA bundle if it is stale or incomplete.`,
      };
    }
  }
  return {
    name,
    verdict: "pass",
    detail: `Python verified MCP endpoint TLS: ${endpointList(endpoints)}`,
  };
}

/**
 * MCP pre-flight — strictly read-only. It surfaces the ROOT CAUSE rather than a
 * bare "MCP failed": if `npx` can't run, was it the cert/TLS layer (fix certs) or
 * a broken npm (fix npm)? The chain reuses the shared TLS result, so it adds no
 * extra network probe.
 */
async function planMcpProbe(ctx: PlanContext, shared: HealShared): Promise<Action[]> {
  const inventory = mcpInventory(ctx);
  const { configured, usesNpx } = inventory;

  let check: Check;
  if (!configured) {
    check = {
      name: CHECK,
      verdict: "skip",
      detail: "no .mcp.json (no MCP servers configured)",
      code: "mcp.config-missing",
    };
    return [captured(check)];
  }
  if (!usesNpx) {
    check = { name: CHECK, verdict: "skip", detail: ".mcp.json servers don't launch via npx" };
  } else if (shared.tlsRegistry.verdict === "fail") {
    const res = await ctx.run(versionArgv(ctx.host.platform, "npx"));
    const npxOk = classifyTool(res, ctx.host.platform === "windows") === "ok";
    check = npxOk
      ? {
          name: CHECK,
          verdict: "pass",
          detail: `npx ${res.stdout.trim()} — MCP servers can launch`,
        }
      : {
          name: CHECK,
          verdict: "fail",
          detail:
            "npx can't reach the registry — root cause: certs/TLS (heal the certs step first)",
          code: "mcp.blocked",
        };
  } else {
    const res = await ctx.run(versionArgv(ctx.host.platform, "npx"));
    const npxOk = classifyTool(res, ctx.host.platform === "windows") === "ok";
    check = npxOk
      ? {
          name: CHECK,
          verdict: "pass",
          detail: `npx ${res.stdout.trim()} — MCP servers can launch`,
        }
      : {
          name: CHECK,
          verdict: "fail",
          detail: "npx unavailable — root cause: npm is broken (see the npm step)",
          code: "mcp.blocked",
        };
  }
  const actions: Action[] = [captured(check)];
  if (inventory.endpoints.length > 0 && (inventory.nodeRuntime || inventory.pythonRuntime)) {
    actions.push(
      captured({
        name: "mcp: TLS endpoint inventory",
        verdict: "pass",
        detail: `derived ${inventory.endpoints.length} endpoint(s): ${endpointList(inventory.endpoints)}`,
      }),
      digest(
        "heal: MCP TLS interception diagnostics",
        mcpTlsInterceptionDoc(ctx.host.platform, inventory.endpoints, {
          node: inventory.nodeRuntime,
          python: inventory.pythonRuntime,
        }),
      ),
    );
    if (!probeEndpointTls(ctx)) {
      actions.push(
        captured({
          name: "mcp: endpoint TLS probes",
          verdict: "skip",
          detail:
            "live MCP endpoint TLS handshakes require --probe-mcp-endpoints because endpoints come from repo or local MCP config",
        }),
      );
      return actions;
    }
    if (inventory.nodeRuntime) {
      actions.push(
        probe("mcp: Node TLS endpoints", (probeCtx) => nodeTlsCheck(probeCtx, inventory.endpoints)),
        probe("mcp: Node CA bundle verifies endpoints", (probeCtx) =>
          caBundleTlsCheck(probeCtx, inventory.endpoints, "Node", "NODE_EXTRA_CA_CERTS"),
        ),
      );
    }
    if (inventory.pythonRuntime) {
      actions.push(
        probe("mcp: Python TLS endpoints", (probeCtx) =>
          pythonTlsCheck(probeCtx, inventory.endpoints),
        ),
        probe("mcp: Python CA bundle verifies endpoints", (probeCtx) =>
          caBundleTlsCheck(probeCtx, inventory.endpoints, "Python", "SSL_CERT_FILE"),
        ),
      );
    }
  }
  return actions;
}

export const mcpStep: HealStep = {
  key: "mcp",
  title: "MCP pre-flight",
  plan: planMcpProbe,
};
