import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { entry } from "../internals/cli-registry.js";
import type { Cli } from "../internals/clis.js";
import { readRegularFile } from "../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";
import {
  digest,
  type Plan,
  plan,
  type WriteAction,
  writeJson,
  writeText,
} from "../internals/plan.js";
import {
  existingMcpTomlNames,
  isExternalMcp,
  type McpEntry,
  mcpConfigAbs,
  mcpEntryFor,
  mcpTomlBody,
  removeMcpTomlServers,
} from "../mcp/render.js";
import type { HttpServer } from "../mcp/servers.js";
import { resolveEccMcpApproval } from "../org-policy/ecc-mcp-approval.js";
import {
  ECC_MCP_CATALOG_PROVENANCE,
  type EccMcpCatalogEntry,
  eccExternalMcpCatalog,
} from "../org-policy/ecc-mcp-catalog.js";
import { parseOrgPolicy } from "../org-policy/schema.js";
import {
  ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
  type EccMcpExplicitAddReceipt,
  type EccMcpExplicitAddRecord,
  emptyExplicitAddReceipt,
  explicitAddDigest,
  parseExplicitAddReceipt,
  receiptJson,
} from "./mcp-explicit-add-receipt.js";

const MAX_CLIENT_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_EXPLICIT_ADD_RECEIPT_BYTES = 1024 * 1024;

export interface ExplicitEccMcpRenderPlan {
  id: string;
  target: string;
  catalog: typeof ECC_MCP_CATALOG_PROVENANCE;
  config: { path: string; key: string; format: "json" | "toml" };
  rendered: McpEntry | string;
  renderedDigest: string;
}

function httpServer(entry: EccMcpCatalogEntry): HttpServer {
  if (entry.transport !== "http" || entry.url === undefined) {
    throw new Error(`ECC MCP ${entry.id} has no HTTP source`);
  }
  for (const value of Object.values(entry.headerTemplates)) {
    if (!/^Bearer \$\{[A-Z][A-Z0-9_]*\}$/.test(value) && !/^\$\{[A-Z][A-Z0-9_]*\}$/.test(value)) {
      throw new Error(`ECC MCP ${entry.id} has unsafe non-secret header template`);
    }
  }
  return {
    type: "http",
    url: entry.url,
    description: entry.description,
    headers: entry.headerTemplates,
    classification: "third-party-hosted",
    egress: "third-party",
    credentials: entry.credentialRequirement.kind === "none" ? "none" : "token",
    supplyChain: "hosted-remote",
  };
}

function approvedHttpsEntry(policyInput: unknown, id: string, target: string): EccMcpCatalogEntry {
  const policy = parseOrgPolicy(policyInput);
  const supportedClis = policy.governance?.supportedClis;
  if (supportedClis !== undefined && !supportedClis.includes(target as Cli)) {
    throw new Error(`CLI ${target} is not sanctioned by governance.supportedClis`);
  }
  const approval = resolveEccMcpApproval(policy.governance?.eccMcpApprovals ?? [], id);
  if (approval.state !== "approved") {
    throw new Error(`ECC MCP ${id} is ${approval.state}; explicit Add is refused`);
  }
  const catalog = eccExternalMcpCatalog.find((candidate) => candidate.id === id);
  if (catalog === undefined) throw new Error(`ECC MCP ${id} is not in the pinned external catalog`);
  if (catalog.addability !== "https-configurable") {
    throw new Error(`ECC MCP ${id} is not HTTPS-configurable; explicit Add is manual only`);
  }
  return catalog;
}

function catalogHttpsEntry(id: string): EccMcpCatalogEntry {
  const catalog = eccExternalMcpCatalog.find((candidate) => candidate.id === id);
  if (catalog === undefined) throw new Error(`ECC MCP ${id} is not in the pinned external catalog`);
  if (catalog.addability !== "https-configurable") {
    throw new Error(`ECC MCP ${id} is not HTTPS-configurable; explicit Add is manual only`);
  }
  return catalog;
}

function renderPlan(catalog: EccMcpCatalogEntry, target: string): ExplicitEccMcpRenderPlan {
  const cli = entry(target).id as Cli;
  const mcp = entry(cli).mcp;
  if (
    mcp.support !== "native" ||
    mcp.configPath === undefined ||
    mcp.configKey === undefined ||
    (mcp.configFormat !== "json" && mcp.configFormat !== "toml")
  ) {
    throw new Error(`CLI ${target} cannot render a native MCP configuration`);
  }
  const server = httpServer(catalog);
  const rendered =
    mcp.configFormat === "toml" ? mcpTomlBody({ [catalog.id]: server }) : mcpEntryFor(cli, server);
  return {
    id: catalog.id,
    target: cli,
    catalog: ECC_MCP_CATALOG_PROVENANCE,
    config: { path: mcp.configPath, key: mcp.configKey, format: mcp.configFormat },
    rendered,
    renderedDigest: explicitAddDigest(rendered),
  };
}

/**
 * Produces one client-shaped entry from an exact policy approval and the pinned
 * snapshot. This is pure data: it reads no config and performs no file, network,
 * scan, attestation, endpoint, or tool-surface operation.
 */
export function explicitEccMcpRenderPlan(
  policyInput: unknown,
  id: string,
  target: string,
): ExplicitEccMcpRenderPlan {
  return renderPlan(approvedHttpsEntry(policyInput, id, target), target);
}

/** Receipt material only; no config write is implied by constructing this record. */
export function explicitEccMcpReceiptRecord(
  plan: ExplicitEccMcpRenderPlan,
): EccMcpExplicitAddRecord {
  return {
    id: plan.id,
    target: plan.target,
    catalog: plan.catalog,
    config: { ...plan.config, renderedSha256: plan.renderedDigest },
  };
}

export interface ExplicitEccMcpFilesystemOptions {
  /** Explicit target root. Never inferred from the checkout or cwd. */
  root: string;
  /** Explicit HOME is required only for a global client configuration. */
  home?: string;
  id: string;
  target: string;
}

export interface ExplicitEccMcpAddOptions extends ExplicitEccMcpFilesystemOptions {
  policy: unknown;
}

export type ExplicitEccMcpReceiptState =
  | "clean"
  | "absent"
  | "altered"
  | "revoked"
  | "malformed"
  | "unsafe-path";

export interface ExplicitEccMcpReceiptStateResult {
  id?: string;
  target?: string;
  state: ExplicitEccMcpReceiptState;
  detail: string;
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function withExpectedSource(action: WriteAction, source: string | undefined): WriteAction {
  return {
    ...action,
    expect: source === undefined ? { absent: true } : { sha256: sha256(source) },
  };
}

function assertNoSymlinkParent(root: string, absolute: string): void {
  const rel = relative(resolve(root), resolve(absolute));
  if (rel === "" || rel.startsWith("..") || /^[/\\]/.test(rel)) {
    throw new Error(`unsafe explicit ECC MCP path outside root: ${absolute}`);
  }
  let current = resolve(root);
  for (const part of rel.split(/[\\/]+/).slice(0, -1)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`unsafe explicit ECC MCP symlinked parent: ${absolute}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function regularProjectSource(
  root: string,
  path: string,
  maxBytes = MAX_CLIENT_CONFIG_BYTES,
): string | undefined {
  const absolute = join(root, path);
  assertNoSymlinkParent(root, absolute);
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`unsafe explicit ECC MCP path: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const source = readRegularFile(absolute, { maxBytes });
  if (source === undefined) throw new Error(`unsafe explicit ECC MCP path: ${path}`);
  return source.toString("utf8");
}

function jsonRoot(source: string | undefined, path: string): Record<string, unknown> {
  const parsed = source === undefined ? {} : parseJsoncText(source);
  if (!isPlainObject(parsed)) throw new Error(`malformed explicit ECC MCP JSON config: ${path}`);
  return parsed;
}

function jsonServers(
  config: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  const servers = config[key];
  if (servers === undefined) return {};
  if (!isPlainObject(servers)) throw new Error(`malformed explicit ECC MCP server map: ${path}`);
  return servers;
}

interface ResolvedConfig {
  path: string;
  source: string | undefined;
  external: boolean;
  trustedBase?: string;
}

function resolvedConfig(
  root: string,
  home: string | undefined,
  rendered: ExplicitEccMcpRenderPlan,
): ResolvedConfig {
  const external = isExternalMcp(rendered.config.path);
  if (!external) {
    return {
      path: rendered.config.path,
      source: regularProjectSource(root, rendered.config.path),
      external,
    };
  }
  if (home === undefined)
    throw new Error(`CLI ${rendered.target} needs an explicit HOME for global MCP configuration`);
  const trustedBase = resolve(home);
  const absolute = mcpConfigAbs(trustedBase, rendered.config.path);
  const rel = relative(trustedBase, resolve(absolute));
  if (rel === "" || rel.startsWith("..") || /^[/\\]/.test(rel)) {
    throw new Error(`unsafe explicit ECC MCP global config path: ${absolute}`);
  }
  return {
    path: absolute,
    source: regularProjectSource(trustedBase, rel),
    external: true,
    trustedBase,
  };
}

function writeOptions(config: ResolvedConfig): { external?: boolean; trustedBase?: string } {
  return config.external ? { external: true, trustedBase: config.trustedBase } : {};
}

function tomlServerSection(source: string, name: string): string | undefined {
  const header =
    /^[ \t]*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^.\]'"]+))(\.[^\]]+)?\][ \t]*(?:#.*)?$/;
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const parsed = lines.map((line) => {
    const match = header.exec(line);
    return match === null
      ? undefined
      : { name: match[1] ?? match[2] ?? match[3], nested: match[4] !== undefined };
  });
  const start = parsed.findIndex((item) => item?.name === name);
  if (start < 0 || parsed[start]?.nested) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const item = parsed[index];
    if (item?.name === name) {
      if (item.nested) continue;
      return undefined;
    }
    if (item !== undefined || /^[ \t]*\[/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  if (parsed.slice(end).some((item) => item?.name === name)) return undefined;
  return lines.slice(start, end).join("\n").trim();
}

function hasTomlServerTree(source: string, name: string): boolean {
  const tree =
    /^[ \t]*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^.\]'"]+))(?:\.[^\]]+)?\][ \t]*(?:#.*)?$/;
  return source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => {
      const match = tree.exec(line);
      return (match?.[1] ?? match?.[2] ?? match?.[3]) === name;
    });
}

function appendToml(source: string | undefined, body: string): string {
  const prefix = source?.trimEnd() ?? "";
  return prefix.length === 0 ? body : `${prefix}\n\n${body}`;
}

function receiptSource(root: string): string | undefined {
  return regularProjectSource(
    root,
    ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
    MAX_EXPLICIT_ADD_RECEIPT_BYTES,
  );
}

function parsedReceipt(root: string): {
  source: string | undefined;
  receipt: EccMcpExplicitAddReceipt;
} {
  const source = receiptSource(root);
  if (source === undefined) return { source, receipt: emptyExplicitAddReceipt() };
  try {
    return { source, receipt: parseExplicitAddReceipt(JSON.parse(source)) };
  } catch {
    throw new Error("malformed explicit ECC MCP receipt");
  }
}

function sameRecord(record: EccMcpExplicitAddRecord, rendered: ExplicitEccMcpRenderPlan): boolean {
  return (
    record.id === rendered.id &&
    record.target === rendered.target &&
    JSON.stringify(record.catalog) === JSON.stringify(rendered.catalog) &&
    record.config.path === rendered.config.path &&
    record.config.key === rendered.config.key &&
    record.config.format === rendered.config.format &&
    record.config.renderedSha256 === rendered.renderedDigest
  );
}

function removalReport(detail: string): Plan {
  return plan(
    "explicit ECC MCP remove",
    digest("Explicit ECC MCP removal not applied", detail, { state: "report-only" }),
  );
}

/**
 * Enumerates local receipt ownership without contacting an endpoint or launching
 * a client. Doctor consumes this instead of re-parsing client-specific JSON/TOML.
 */
export function readExplicitEccMcpReceiptStates(options: {
  root: string;
  home?: string;
}): ExplicitEccMcpReceiptStateResult[] {
  let receiptState: { source: string | undefined; receipt: EccMcpExplicitAddReceipt };
  try {
    receiptState = parsedReceipt(options.root);
  } catch (error) {
    const detail = (error as Error).message;
    return [{ state: detail.includes("unsafe") ? "unsafe-path" : "malformed", detail }];
  }
  if (receiptState.source === undefined)
    return [{ state: "absent", detail: "explicit ECC MCP receipt is absent" }];
  return receiptState.receipt.records.map((record) => {
    let rendered: ExplicitEccMcpRenderPlan;
    let config: ResolvedConfig;
    try {
      rendered = renderPlan(catalogHttpsEntry(record.id), record.target);
      config = resolvedConfig(options.root, options.home, rendered);
    } catch (error) {
      const detail = (error as Error).message;
      return {
        id: record.id,
        target: record.target,
        state: detail.includes("unsafe") ? "unsafe-path" : "revoked",
        detail,
      };
    }
    if (!sameRecord(record, rendered)) {
      return {
        id: record.id,
        target: record.target,
        state: "revoked",
        detail: "receipt no longer matches the pinned catalog renderer",
      };
    }
    if (config.source === undefined) {
      return {
        id: record.id,
        target: record.target,
        state: "absent",
        detail: "client config is absent",
      };
    }
    try {
      const current =
        rendered.config.format === "json"
          ? jsonServers(jsonRoot(config.source, config.path), rendered.config.key, config.path)[
              rendered.id
            ]
          : tomlServerSection(config.source, rendered.id);
      if (current === undefined) {
        return {
          id: record.id,
          target: record.target,
          state: "absent",
          detail: "receipt-owned entry is absent",
        };
      }
      return explicitAddDigest(current) === record.config.renderedSha256
        ? {
            id: record.id,
            target: record.target,
            state: "clean",
            detail: "receipt-owned entry is unchanged",
          }
        : {
            id: record.id,
            target: record.target,
            state: "altered",
            detail: "receipt-owned entry drifted",
          };
    } catch (error) {
      const detail = (error as Error).message;
      return {
        id: record.id,
        target: record.target,
        state: detail.includes("unsafe") ? "unsafe-path" : "malformed",
        detail,
      };
    }
  });
}

/**
 * Plan a project-local JSON add. It does not contact an endpoint, scan, launch a
 * client, or apply files; callers pass its actions to the normal plan executor.
 */
export function planExplicitEccMcpAdd(options: ExplicitEccMcpAddOptions): Plan {
  const rendered = explicitEccMcpRenderPlan(options.policy, options.id, options.target);
  const config = resolvedConfig(options.root, options.home, rendered);
  const receiptState = parsedReceipt(options.root);
  const record = receiptState.receipt.records.find(
    (candidate) => candidate.id === rendered.id && candidate.target === rendered.target,
  );
  let configAction: WriteAction;
  if (rendered.config.format === "json") {
    if (typeof rendered.rendered === "string") throw new Error("JSON renderer returned TOML");
    const servers = jsonServers(
      jsonRoot(config.source, config.path),
      rendered.config.key,
      config.path,
    );
    const existing = servers[rendered.id];
    if (existing !== undefined) {
      if (
        record !== undefined &&
        sameRecord(record, rendered) &&
        explicitAddDigest(existing) === rendered.renderedDigest
      )
        return plan("explicit ECC MCP add");
      throw new Error(
        `explicit ECC MCP ${rendered.id} is operator-owned or drifted; Add is refused`,
      );
    }
    if (record !== undefined)
      throw new Error(
        `explicit ECC MCP ${rendered.id} receipt no longer matches its config; Add is refused`,
      );
    configAction = withExpectedSource(
      writeJson(
        config.path,
        { [rendered.config.key]: { [rendered.id]: rendered.rendered } },
        `add approved ECC MCP ${rendered.id} to ${rendered.target}`,
        {
          merge: true,
          replaceJsonChildKeys: { [rendered.config.key]: [rendered.id] },
          ...writeOptions(config),
        },
      ),
      config.source,
    );
  } else {
    const body = rendered.rendered as string;
    const existing = tomlServerSection(config.source ?? "", rendered.id);
    if (existing !== undefined) {
      if (
        record !== undefined &&
        sameRecord(record, rendered) &&
        explicitAddDigest(existing) === rendered.renderedDigest
      )
        return plan("explicit ECC MCP add");
      throw new Error(
        `explicit ECC MCP ${rendered.id} is operator-owned or drifted; Add is refused`,
      );
    }
    if (record !== undefined)
      throw new Error(
        `explicit ECC MCP ${rendered.id} receipt no longer matches its config; Add is refused`,
      );
    if (hasTomlServerTree(config.source ?? "", rendered.id)) {
      throw new Error(`explicit ECC MCP ${rendered.id} is operator-owned; Add is refused`);
    }
    if (existingMcpTomlNames(config.source ?? "", "__explicit_ecc__").has(rendered.id)) {
      throw new Error(`explicit ECC MCP ${rendered.id} is operator-owned; Add is refused`);
    }
    configAction = withExpectedSource(
      writeText(
        config.path,
        appendToml(config.source, body),
        `add approved ECC MCP ${rendered.id} to ${rendered.target}`,
        writeOptions(config),
      ),
      config.source,
    );
  }
  const nextReceipt = {
    ...receiptState.receipt,
    records: [...receiptState.receipt.records, explicitEccMcpReceiptRecord(rendered)],
  };
  const receiptAction = withExpectedSource(
    writeText(
      ".aih/ecc-mcp-explicit-add-v1.json",
      receiptJson(nextReceipt),
      `record ownership of ECC MCP ${rendered.id} for ${rendered.target}`,
    ),
    receiptState.source,
  );
  return plan("explicit ECC MCP add", configAction, receiptAction);
}

/**
 * Plan a receipt-proven project-local JSON removal. Any unsafe, malformed, absent,
 * or drifted state is report-only and leaves configuration untouched.
 */
export function planExplicitEccMcpRemove(options: ExplicitEccMcpFilesystemOptions): Plan {
  let rendered: ExplicitEccMcpRenderPlan;
  let source: string | undefined;
  let config: ResolvedConfig;
  let receiptState: { source: string | undefined; receipt: EccMcpExplicitAddReceipt };
  try {
    rendered = renderPlan(catalogHttpsEntry(options.id), options.target);
    config = resolvedConfig(options.root, options.home, rendered);
    source = config.source;
    receiptState = parsedReceipt(options.root);
  } catch (error) {
    return removalReport((error as Error).message);
  }
  if (source === undefined)
    return removalReport(`configuration is absent: ${rendered.config.path}`);
  const record = receiptState.receipt.records.find(
    (candidate) => candidate.id === rendered.id && candidate.target === rendered.target,
  );
  if (record === undefined || !sameRecord(record, rendered)) {
    return removalReport(
      `no exact receipt-owned ECC MCP record exists for ${rendered.id}/${rendered.target}`,
    );
  }
  let configAction: WriteAction;
  try {
    if (rendered.config.format === "json") {
      const servers = jsonServers(jsonRoot(source, config.path), rendered.config.key, config.path);
      if (
        servers[rendered.id] === undefined ||
        explicitAddDigest(servers[rendered.id]) !== record.config.renderedSha256
      )
        return removalReport(`ECC MCP ${rendered.id}/${rendered.target} drifted or is absent`);
      configAction = withExpectedSource(
        writeJson(
          config.path,
          {},
          `remove unchanged receipt-owned ECC MCP ${rendered.id} from ${rendered.target}`,
          {
            merge: true,
            removeJsonKeys: { [rendered.config.key]: [rendered.id] },
            ...writeOptions(config),
          },
        ),
        source,
      );
    } else {
      const existing = tomlServerSection(source, rendered.id);
      if (existing === undefined || explicitAddDigest(existing) !== record.config.renderedSha256)
        return removalReport(`ECC MCP ${rendered.id}/${rendered.target} drifted or is absent`);
      configAction = withExpectedSource(
        writeText(
          config.path,
          removeMcpTomlServers(source, [rendered.id]),
          `remove unchanged receipt-owned ECC MCP ${rendered.id} from ${rendered.target}`,
          writeOptions(config),
        ),
        source,
      );
    }
  } catch (error) {
    return removalReport((error as Error).message);
  }
  const nextReceipt = {
    ...receiptState.receipt,
    records: receiptState.receipt.records.filter((candidate) => candidate !== record),
  };
  const receiptAction = withExpectedSource(
    writeText(
      ".aih/ecc-mcp-explicit-add-v1.json",
      receiptJson(nextReceipt),
      `retire ownership record for ECC MCP ${rendered.id} on ${rendered.target}`,
    ),
    receiptState.source,
  );
  return plan("explicit ECC MCP remove", configAction, receiptAction);
}
