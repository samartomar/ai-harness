import { createHash } from "node:crypto";
import { loadFrameworkDescriptorSectionV1 } from "../catalog-package/framework-descriptors.js";
import { AIH_OWNED_ECC_MCP_EXCLUSIONS, ECC_MCP_CATALOG_PROVENANCE } from "./ecc-mcp-contract.js";

export { AIH_OWNED_ECC_MCP_EXCLUSIONS, ECC_MCP_CATALOG_PROVENANCE };

/** Canonical parsed-content digest used after the JSON is bundled into dist. */
export const ECC_MCP_CATALOG_CANONICAL_SHA256 =
  "bab2a851f40920effb15f8ca13c34d5699697ff3de16afd03bcb6b6c93c281b3";

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
  /** Non-secret env-reference templates verified against upstream header placeholders. */
  headerTemplates: Readonly<Record<string, string>>;
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
  headerTemplates?: Readonly<Record<string, string>>;
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env reference, never a credential
    headerTemplates: { Authorization: "Bearer ${MEMXUS_API_KEY}" },
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env reference, never a credential
    headerTemplates: { "x-browser-use-api-key": "${BROWSER_USE_KEY}" },
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

function headerTemplates(
  id: EccMcpId,
  headers: unknown,
  classification: Classification,
): Readonly<Record<string, string>> {
  const templates = classification.headerTemplates ?? {};
  const names = headerNames(headers);
  if (
    names.length !== Object.keys(templates).length ||
    names.some((name) => templates[name] === undefined)
  ) {
    fail(`${id} has unclassified HTTP header templates`);
  }
  if (!isRecord(headers)) return templates;
  for (const [name, template] of Object.entries(templates)) {
    const variable =
      /^Bearer \$\{([A-Z][A-Z0-9_]*)\}$/.exec(template)?.[1] ??
      /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(template)?.[1];
    const source = classification.sourcePlaceholders?.find(
      (placeholder) => placeholder.kind === "credential" && placeholder.variable === variable,
    );
    if (
      variable === undefined ||
      source === undefined ||
      headers[name] !== template.replace(`\${${variable}}`, source.literal)
    ) {
      fail(`${id} header template is not source-verified`);
    }
  }
  return templates;
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
      headerTemplates: headerTemplates(id, server.headers, classification),
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
    headerTemplates: {},
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

let loadedInventory: readonly EccMcpCatalogEntry[] | undefined;
function inventoryV1(): readonly EccMcpCatalogEntry[] {
  if (loadedInventory !== undefined) return loadedInventory;
  const document = loadFrameworkDescriptorSectionV1<{ bytesBase64: string; sha256: string }>(
    "ecc",
    "mcpInventoryDocument",
  );
  const bytes = Buffer.from(document.bytesBase64, "base64");
  if (
    document.sha256 !== ECC_MCP_CATALOG_PROVENANCE.contentSha256 ||
    createHash("sha256").update(bytes).digest("hex") !== document.sha256
  ) {
    fail("Catalog-carried source document digest mismatch");
  }
  loadedInventory = validateEccMcpCatalogInventory(JSON.parse(bytes.toString("utf8")));
  return loadedInventory;
}

/** Complete upstream inventory, loaded through the installed Catalog on explicit use. */
export function eccMcpCatalogInventoryV1(): readonly EccMcpCatalogEntry[] {
  return Object.freeze([...inventoryV1()]);
}

/**
 * ECC-owned options only. These are facts for a future explicit add flow, never
 * McpServer instances, governed candidates, settings, or an installation plan.
 */
let loadedExternal: readonly EccMcpCatalogEntry[] | undefined;
function externalInventoryV1(): readonly EccMcpCatalogEntry[] {
  loadedExternal ??= inventoryV1().filter((entry) => entry.owner === "ecc");
  return loadedExternal;
}
export function eccExternalMcpCatalogV1(): readonly EccMcpCatalogEntry[] {
  return Object.freeze([...externalInventoryV1()]);
}
