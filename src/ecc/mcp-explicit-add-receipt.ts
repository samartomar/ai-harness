import { createHash } from "node:crypto";
import { entry } from "../internals/cli-registry.js";
import {
  ECC_MCP_CATALOG_PROVENANCE,
  eccExternalMcpCatalog,
} from "../org-policy/ecc-mcp-catalog.js";

export const ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH = ".aih/ecc-mcp-explicit-add-v1.json";

export interface EccMcpExplicitAddRecord {
  id: string;
  target: string;
  catalog: typeof ECC_MCP_CATALOG_PROVENANCE;
  config: {
    path: string;
    key: string;
    format: "json" | "toml";
    renderedSha256: string;
  };
}

export interface EccMcpExplicitAddReceipt {
  format: "aih-ecc-mcp-explicit-add";
  version: 1;
  records: EccMcpExplicitAddRecord[];
}

export function explicitAddDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

export function emptyExplicitAddReceipt(): EccMcpExplicitAddReceipt {
  return { format: "aih-ecc-mcp-explicit-add", version: 1, records: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeRecord(value: unknown): value is EccMcpExplicitAddRecord {
  if (!isRecord(value) || !isRecord(value.catalog) || !isRecord(value.config)) return false;
  const config = value.config;
  const catalog = eccExternalMcpCatalog.find(
    (candidate) => candidate.id === value.id && candidate.addability === "https-configurable",
  );
  let target: ReturnType<typeof entry> | undefined;
  try {
    target = typeof value.target === "string" ? entry(value.target) : undefined;
  } catch {
    return false;
  }
  const targetMcp = target?.mcp;
  return (
    exactKeys(value, ["id", "target", "catalog", "config"]) &&
    exactKeys(value.catalog, ["repository", "commit", "path", "contentSha256"]) &&
    exactKeys(config, ["path", "key", "format", "renderedSha256"]) &&
    catalog !== undefined &&
    target !== undefined &&
    targetMcp !== undefined &&
    value.catalog.repository === ECC_MCP_CATALOG_PROVENANCE.repository &&
    value.catalog.commit === ECC_MCP_CATALOG_PROVENANCE.commit &&
    value.catalog.path === ECC_MCP_CATALOG_PROVENANCE.path &&
    value.catalog.contentSha256 === ECC_MCP_CATALOG_PROVENANCE.contentSha256 &&
    config.path === targetMcp.configPath &&
    config.key === targetMcp.configKey &&
    config.format === targetMcp.configFormat &&
    (config.format === "json" || config.format === "toml") &&
    typeof config.renderedSha256 === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(config.renderedSha256)
  );
}

export function parseExplicitAddReceipt(value: unknown): EccMcpExplicitAddReceipt {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["format", "version", "records"]) ||
    value.format !== "aih-ecc-mcp-explicit-add" ||
    value.version !== 1
  ) {
    throw new Error("invalid explicit ECC MCP receipt format");
  }
  if (!Array.isArray(value.records) || !value.records.every(isSafeRecord)) {
    throw new Error("invalid explicit ECC MCP receipt records");
  }
  const seen = new Set<string>();
  for (const record of value.records) {
    const key = `${record.id}\0${record.target}`;
    if (seen.has(key))
      throw new Error(`duplicate explicit ECC MCP receipt record ${record.id}/${record.target}`);
    seen.add(key);
  }
  return {
    format: value.format,
    version: value.version,
    records: value.records.map((record) => ({
      ...record,
      catalog: { ...record.catalog },
      config: { ...record.config },
    })),
  };
}

export function receiptJson(receipt: EccMcpExplicitAddReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}
