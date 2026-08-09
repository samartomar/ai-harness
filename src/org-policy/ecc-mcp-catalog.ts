import { createHash } from "node:crypto";
import snapshot from "./ecc-mcp-catalog.snapshot.json";

/** Exact public upstream source whose bytes are committed beside this module. */
export const ECC_MCP_CATALOG_PROVENANCE = {
  repository: "affaan-m/ECC",
  commit: "623f2c020f052319657674e4e6c29ab5d0ad566b",
  path: "mcp-configs/mcp-servers.json",
  contentSha256: "a4426254c55a5352db2672bc86a87f10b0029f5e4ae1b74817841e87d9ab1e57",
} as const;

/** Canonical parsed-content digest used after the JSON is bundled into dist. */
export const ECC_MCP_CATALOG_CANONICAL_SHA256 =
  "5bd0b00f7051b54e07a821f1e1fd121fcd2e50fe5ec464895b321476bd7fbae6";

/** Upstream order is a reviewable part of the source-locked inventory. */
export const ECC_MCP_CATALOG_IDS = [
  "nexus",
  "ito-compute",
  "jira",
  "github",
  "firecrawl",
  "supabase",
  "ecc-memory-vault",
  "memory",
  "omega-memory",
  "longhand",
  "sequential-thinking",
  "vercel",
  "railway",
  "cloudflare-docs",
  "cloudflare-workers-builds",
  "cloudflare-workers-bindings",
  "cloudflare-observability",
  "clickhouse",
  "exa-web-search",
  "parallel-search",
  "context7",
  "codescene",
  "magic",
  "memxus",
  "filesystem",
  "playwright",
  "fal-ai",
  "browserbase",
  "browser-use",
  "devfleet",
  "token-optimizer",
  "laraplugins",
  "confluence",
  "evalview",
  "squish",
] as const;

export const AIH_OWNED_ECC_MCP_EXCLUSIONS = [
  "github",
  "sequential-thinking",
  "context7",
  "playwright",
] as const;

type EccMcpId = (typeof ECC_MCP_CATALOG_IDS)[number];
type EccMcpOwner = "aih" | "ecc";
type EccMcpTransport = "stdio" | "http";
type EccMcpAddability = "aih-owned" | "https-configurable" | "manual-localhost" | "manual-stdio";
type EccMcpSupply =
  | "floating-package"
  | "local-command"
  | "remote-endpoint"
  | "versioned-no-integrity";

export interface EccMcpCredentialRequirement {
  /** A requirement, never a placeholder value captured from upstream config. */
  kind: "none" | "operator-supplied" | "optional";
  /** Environment/header variable names only; this inventory never carries credentials. */
  variables: readonly string[];
}

export interface EccMcpCatalogEntry {
  id: EccMcpId;
  owner: EccMcpOwner;
  transport: EccMcpTransport;
  /** Configuration can be rendered later only after an explicit user action. */
  addability: EccMcpAddability;
  /** Source classification, not an installation plan. */
  supply: EccMcpSupply;
  command?: string;
  args?: readonly string[];
  url?: string;
  /** Header names are preserved; upstream placeholder values are intentionally omitted. */
  headerNames: readonly string[];
  credentialRequirement: EccMcpCredentialRequirement;
  /** Non-secret upstream placeholders such as a project reference or local path. */
  configurationPlaceholders: readonly string[];
  description: string;
}

interface Classification {
  id: EccMcpId;
  owner: EccMcpOwner;
  addability: EccMcpAddability;
  supply: EccMcpSupply;
  credentialRequirement: EccMcpCredentialRequirement;
  configurationPlaceholders?: readonly string[];
  sourcePlaceholders?: readonly SourcePlaceholder[];
}

interface SourcePlaceholder {
  literal: string;
  kind: "credential" | "configuration";
  variable: string;
}

const none = (): EccMcpCredentialRequirement => ({ kind: "none", variables: [] });
const required = (...variables: string[]): EccMcpCredentialRequirement => ({
  kind: "operator-supplied",
  variables,
});
const optional = (...variables: string[]): EccMcpCredentialRequirement => ({
  kind: "optional",
  variables,
});
const credential = (literal: string, variable: string): SourcePlaceholder => ({
  literal,
  kind: "credential",
  variable,
});
const configuration = (literal: string, variable: string): SourcePlaceholder => ({
  literal,
  kind: "configuration",
  variable,
});

/**
 * Classification is intentionally complete: a new upstream id or a duplicate
 * classification is an import-time error, not an unreviewed catalog addition.
 */
const CLASSIFICATIONS: readonly Classification[] = [
  {
    id: "nexus",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "local-command",
    credentialRequirement: none(),
  },
  {
    id: "ito-compute",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "local-command",
    credentialRequirement: optional("ITO_API_KEY"),
    configurationPlaceholders: ["path"],
    sourcePlaceholders: [
      configuration(
        "/absolute/path/to/ito-cloud-runtime/cli/ito-compute-cli/dist/bin/ito-mcp.js",
        "path",
      ),
    ],
  },
  {
    id: "jira",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "versioned-no-integrity",
    credentialRequirement: required("JIRA_API_TOKEN"),
    configurationPlaceholders: ["JIRA_URL", "JIRA_EMAIL"],
    sourcePlaceholders: [
      configuration("YOUR_JIRA_URL_HERE", "JIRA_URL"),
      configuration("YOUR_JIRA_EMAIL_HERE", "JIRA_EMAIL"),
      credential("YOUR_JIRA_API_TOKEN_HERE", "JIRA_API_TOKEN"),
    ],
  },
  {
    id: "github",
    owner: "aih",
    addability: "aih-owned",
    supply: "floating-package",
    credentialRequirement: required("GITHUB_PERSONAL_ACCESS_TOKEN"),
    sourcePlaceholders: [credential("YOUR_GITHUB_PAT_HERE", "GITHUB_PERSONAL_ACCESS_TOKEN")],
  },
  {
    id: "firecrawl",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: required("FIRECRAWL_API_KEY"),
    sourcePlaceholders: [credential("YOUR_FIRECRAWL_KEY_HERE", "FIRECRAWL_API_KEY")],
  },
  {
    id: "supabase",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: none(),
    configurationPlaceholders: ["PROJECT_REF"],
    sourcePlaceholders: [configuration("YOUR_PROJECT_REF", "PROJECT_REF")],
  },
  {
    id: "ecc-memory-vault",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "local-command",
    credentialRequirement: none(),
    configurationPlaceholders: ["ECC_MEMORY_HARNESS"],
    sourcePlaceholders: [configuration("YOUR_LOWERCASE_HARNESS_SLUG_HERE", "ECC_MEMORY_HARNESS")],
  },
  {
    id: "memory",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: none(),
  },
  {
    id: "omega-memory",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: none(),
  },
  {
    id: "longhand",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "local-command",
    credentialRequirement: none(),
  },
  {
    id: "sequential-thinking",
    owner: "aih",
    addability: "aih-owned",
    supply: "floating-package",
    credentialRequirement: none(),
  },
  {
    id: "vercel",
    owner: "ecc",
    addability: "https-configurable",
    supply: "remote-endpoint",
    credentialRequirement: none(),
  },
  {
    id: "railway",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: none(),
  },
  {
    id: "cloudflare-docs",
    owner: "ecc",
    addability: "https-configurable",
    supply: "remote-endpoint",
    credentialRequirement: none(),
  },
  {
    id: "cloudflare-workers-builds",
    owner: "ecc",
    addability: "https-configurable",
    supply: "remote-endpoint",
    credentialRequirement: none(),
  },
  {
    id: "cloudflare-workers-bindings",
    owner: "ecc",
    addability: "https-configurable",
    supply: "remote-endpoint",
    credentialRequirement: none(),
  },
  {
    id: "cloudflare-observability",
    owner: "ecc",
    addability: "https-configurable",
    supply: "remote-endpoint",
    credentialRequirement: none(),
  },
  {
    id: "clickhouse",
    owner: "ecc",
    addability: "https-configurable",
    supply: "remote-endpoint",
    credentialRequirement: none(),
  },
  {
    id: "exa-web-search",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: required("EXA_API_KEY"),
    sourcePlaceholders: [credential("YOUR_EXA_API_KEY_HERE", "EXA_API_KEY")],
  },
  {
    id: "parallel-search",
    owner: "ecc",
    addability: "https-configurable",
    supply: "remote-endpoint",
    credentialRequirement: optional("PARALLEL_API_KEY"),
    sourcePlaceholders: [credential("YOUR_PARALLEL_API_KEY_HERE", "PARALLEL_API_KEY")],
  },
  {
    id: "context7",
    owner: "aih",
    addability: "aih-owned",
    supply: "floating-package",
    credentialRequirement: none(),
  },
  {
    id: "codescene",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: required("CS_ACCESS_TOKEN"),
    sourcePlaceholders: [credential("YOUR_CS_ACCESS_TOKEN_HERE", "CS_ACCESS_TOKEN")],
  },
  {
    id: "magic",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: none(),
  },
  {
    id: "memxus",
    owner: "ecc",
    addability: "https-configurable",
    supply: "remote-endpoint",
    credentialRequirement: required("MEMXUS_API_KEY"),
    sourcePlaceholders: [credential("YOUR_MEMXUS_API_KEY_HERE", "MEMXUS_API_KEY")],
  },
  {
    id: "filesystem",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: none(),
    configurationPlaceholders: ["path"],
    sourcePlaceholders: [configuration("/path/to/your/projects", "path")],
  },
  {
    id: "playwright",
    owner: "aih",
    addability: "aih-owned",
    supply: "floating-package",
    credentialRequirement: none(),
  },
  {
    id: "fal-ai",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: required("FAL_KEY"),
    sourcePlaceholders: [credential("YOUR_FAL_KEY_HERE", "FAL_KEY")],
  },
  {
    id: "browserbase",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: required("BROWSERBASE_API_KEY"),
    sourcePlaceholders: [credential("YOUR_BROWSERBASE_KEY_HERE", "BROWSERBASE_API_KEY")],
  },
  {
    id: "browser-use",
    owner: "ecc",
    addability: "https-configurable",
    supply: "remote-endpoint",
    credentialRequirement: required("BROWSER_USE_KEY"),
    sourcePlaceholders: [credential("YOUR_BROWSER_USE_KEY_HERE", "BROWSER_USE_KEY")],
  },
  {
    id: "devfleet",
    owner: "ecc",
    addability: "manual-localhost",
    supply: "remote-endpoint",
    credentialRequirement: none(),
  },
  {
    id: "token-optimizer",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: none(),
  },
  {
    id: "laraplugins",
    owner: "ecc",
    addability: "https-configurable",
    supply: "remote-endpoint",
    credentialRequirement: none(),
  },
  {
    id: "confluence",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: required("CONFLUENCE_API_TOKEN"),
    configurationPlaceholders: ["CONFLUENCE_BASE_URL", "CONFLUENCE_EMAIL"],
    sourcePlaceholders: [
      configuration("YOUR_CONFLUENCE_URL_HERE", "CONFLUENCE_BASE_URL"),
      configuration("YOUR_EMAIL_HERE", "CONFLUENCE_EMAIL"),
      credential("YOUR_CONFLUENCE_TOKEN_HERE", "CONFLUENCE_API_TOKEN"),
    ],
  },
  {
    id: "evalview",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "local-command",
    credentialRequirement: optional("OPENAI_API_KEY"),
    sourcePlaceholders: [credential("YOUR_OPENAI_API_KEY_HERE", "OPENAI_API_KEY")],
  },
  {
    id: "squish",
    owner: "ecc",
    addability: "manual-stdio",
    supply: "floating-package",
    credentialRequirement: none(),
  },
];

interface SnapshotServer {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  headers?: unknown;
  env?: unknown;
  description?: unknown;
}

function fail(message: string): never {
  throw new Error(`invalid source-locked ECC MCP inventory: ${message}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classificationsById(): ReadonlyMap<EccMcpId, Classification> {
  const byId = new Map<EccMcpId, Classification>();
  for (const classification of CLASSIFICATIONS) {
    if (byId.has(classification.id)) fail(`duplicate classification for ${classification.id}`);
    byId.set(classification.id, classification);
  }
  if (byId.size !== ECC_MCP_CATALOG_IDS.length) fail("unknown or missing classification");
  for (const id of ECC_MCP_CATALOG_IDS) if (!byId.has(id)) fail(`missing classification for ${id}`);
  return byId;
}

function snapshotServers(value: unknown): Record<string, SnapshotServer> {
  if (!isRecord(value) || !isRecord(value.mcpServers)) fail("snapshot has no mcpServers object");
  const entries = Object.entries(value.mcpServers);
  if (entries.length !== ECC_MCP_CATALOG_IDS.length) fail("snapshot count mismatch");
  const ids = entries.map(([id]) => id);
  if (ids.some((id, index) => id !== ECC_MCP_CATALOG_IDS[index]))
    fail("ECC MCP catalog ids/order mismatch");
  return value.mcpServers as Record<string, SnapshotServer>;
}

function headerNames(headers: unknown): string[] {
  if (headers === undefined) return [];
  if (!isRecord(headers) || Object.values(headers).some((value) => typeof value !== "string")) {
    fail("HTTP headers must be a string map");
  }
  return Object.keys(headers);
}

function sourceStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(sourceStrings);
  if (isRecord(value)) return Object.values(value).flatMap(sourceStrings);
  return [];
}

function sourcePlaceholderLiterals(server: SnapshotServer): string[] {
  const literals = new Set<string>();
  for (const text of sourceStrings(server)) {
    for (const match of text.matchAll(/\bYOUR_[A-Z0-9_]+\b/g)) literals.add(match[0]);
    for (const match of text.matchAll(/\/(?:absolute\/)?path\/to\/[A-Za-z0-9_./-]+/g)) {
      literals.add(match[0]);
    }
  }
  return [...literals].sort();
}

function assertPlaceholderClassification(
  id: EccMcpId,
  server: SnapshotServer,
  classification: Classification,
): void {
  const declared = classification.sourcePlaceholders ?? [];
  const declarations = new Map<string, SourcePlaceholder>();
  for (const placeholder of declared) {
    if (declarations.has(placeholder.literal))
      fail(`${id} has duplicate placeholder classification`);
    declarations.set(placeholder.literal, placeholder);
    const valid =
      placeholder.kind === "credential"
        ? classification.credentialRequirement.variables.includes(placeholder.variable)
        : (classification.configurationPlaceholders ?? []).includes(placeholder.variable);
    if (!valid)
      fail(`${id} has inconsistent placeholder classification for ${placeholder.literal}`);
  }
  const actual = sourcePlaceholderLiterals(server);
  if (actual.length !== declarations.size || actual.some((literal) => !declarations.has(literal))) {
    fail(`${id} has an unknown or stale placeholder classification`);
  }
}

function readEntry(
  id: EccMcpId,
  server: SnapshotServer,
  classification: Classification,
): EccMcpCatalogEntry {
  assertPlaceholderClassification(id, server, classification);
  const type = server.type === "http" ? "http" : "stdio";
  if (type === "http") {
    if (typeof server.url !== "string") fail(`${id} HTTP transport has no URL`);
    if (
      id === "devfleet"
        ? !server.url.startsWith("http://localhost:")
        : !server.url.startsWith("https://")
    ) {
      fail(`${id} transport URL mismatch`);
    }
    return {
      id,
      owner: classification.owner,
      transport: "http",
      addability: classification.addability,
      supply: classification.supply,
      url: server.url,
      headerNames: headerNames(server.headers),
      credentialRequirement: classification.credentialRequirement,
      configurationPlaceholders: classification.configurationPlaceholders ?? [],
      description: stringField(id, "description", server.description),
    };
  }
  if (
    server.type !== undefined ||
    typeof server.command !== "string" ||
    (server.args !== undefined &&
      (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string")))
  ) {
    fail(`${id} stdio transport mismatch`);
  }
  return {
    id,
    owner: classification.owner,
    transport: "stdio",
    addability: classification.addability,
    supply: classification.supply,
    command: server.command,
    args: server.args ?? [],
    headerNames: [],
    credentialRequirement: classification.credentialRequirement,
    configurationPlaceholders: classification.configurationPlaceholders ?? [],
    description: stringField(id, "description", server.description),
  };
}

function stringField(id: string, name: string, value: unknown): string {
  if (typeof value !== "string") fail(`${id} has no ${name}`);
  return value;
}

/**
 * Validates a source snapshot without contacting, scanning, projecting, or
 * installing any MCP. `expectedContentSha256` is exposed only for fixture-level
 * validation of a changed payload; production callers use the pinned default.
 */
export function validateEccMcpCatalogInventory(
  value: unknown,
  expectedContentSha256 = ECC_MCP_CATALOG_CANONICAL_SHA256,
): readonly EccMcpCatalogEntry[] {
  if (sha256(JSON.stringify(value)) !== expectedContentSha256) fail("snapshot digest mismatch");
  const classifications = classificationsById();
  const servers = snapshotServers(value);
  const entries = ECC_MCP_CATALOG_IDS.map((id) => {
    const server = servers[id];
    const classification = classifications.get(id);
    if (server === undefined || classification === undefined) fail(`missing ${id}`);
    return readEntry(id, server, classification);
  });
  const stdio = entries.filter((entry) => entry.transport === "stdio").length;
  const http = entries.filter((entry) => entry.transport === "http").length;
  if (stdio !== 24 || http !== 11) fail(`transport count mismatch: stdio ${stdio}, http ${http}`);
  return entries;
}

/** Complete upstream inventory, validated at import time against pinned canonical content. */
export const eccMcpCatalogInventory = validateEccMcpCatalogInventory(snapshot);

/**
 * ECC-owned options only. These are facts for a future explicit add flow, never
 * McpServer instances, governed candidates, settings, or an installation plan.
 */
export const eccExternalMcpCatalog = eccMcpCatalogInventory.filter(
  (entry) => entry.owner === "ecc",
);
