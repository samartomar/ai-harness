import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, findNodeAtLocation, modify, type Node, parseTree } from "jsonc-parser";
import {
  type ActiveKiroMcpProjectionOwnership,
  AIH_CONFIG_FILE,
  AihConfigSchema,
  isActiveKiroMcpProjectionOwnership,
  isKiroMcpProjectionOwnership,
  type KiroMcpProjectionOwnership,
  kiroMcpProjectionConfigJsonFromRaw,
  kiroMcpProjectionOwnership,
  revokedKiroMcpProjectionOwnership,
} from "../config/marker.js";
import { readRegularFile } from "../internals/fsxn.js";
import { parseJsoncText } from "../internals/merge.js";
import {
  type Action,
  type PlanContext,
  type WriteAction,
  writeJson,
  writeText,
} from "../internals/plan.js";
import { hasSymlinkParent, occupied, withExpectedContents } from "./managed-projection.js";
import { type McpEntry, mcpEntries } from "./render.js";
import type { McpServer } from "./servers.js";

/** Kiro reads this project workspace distribution; it is not a managed enforcement surface. */
export const KIRO_MCP_SETTINGS_PATH = ".kiro/settings/mcp.json";

type KiroExpected = KiroMcpProjectionOwnership["expected"];

export type KiroMcpUnprovableReason =
  | "not-a-regular-file"
  | "settings-absent"
  | "entries-drifted"
  | "duplicate-keys";

export interface KiroMcpProjectionResidue {
  path: string;
  ownership: ActiveKiroMcpProjectionOwnership;
  matches: boolean;
  unprovable: KiroMcpUnprovableReason | undefined;
  markerSource: string | undefined;
  settingsSource: string | undefined;
}

function absolute(root: string, rel: string): string {
  return join(root, ...rel.split("/"));
}

function readProjectionFile(root: string, rel: string): string | undefined {
  if (hasSymlinkParent(root, rel)) return undefined;
  return readRegularFile(absolute(root, rel))?.toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectedEntries(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.mcpServers)) return undefined;
  return value.mcpServers;
}

function duplicateObjectKeys(node: Node | undefined): string[] {
  if (node?.type !== "object") return [];
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const property of node.children ?? []) {
    const key = property.children?.[0]?.value;
    if (typeof key !== "string") continue;
    if (seen.has(key)) duplicate.add(key);
    seen.add(key);
  }
  return [...duplicate].sort();
}

function nodeAt(root: Node | undefined, path: readonly string[]): Node | undefined {
  return root === undefined ? undefined : findNodeAtLocation(root, [...path]);
}

/** The only JSONC keys this lifecycle can mutate, so only their ambiguity matters. */
function duplicateKiroMcpKeys(source: string, ownedNames: readonly string[]): string[] {
  const root = parseTree(source);
  const rootDuplicates = duplicateObjectKeys(root).filter((key) => key === "mcpServers");
  const servers = nodeAt(root, ["mcpServers"]);
  const serverDuplicates = duplicateObjectKeys(servers);
  const entryDuplicates = ownedNames.flatMap((name) =>
    duplicateObjectKeys(nodeAt(root, ["mcpServers", name])).map((key) => `${name}.${key}`),
  );
  return [...new Set([...rootDuplicates, ...serverDuplicates, ...entryDuplicates])].sort();
}

function sameExpectedEntries(value: unknown, expected: KiroExpected): boolean {
  const actual = expectedEntries(value);
  if (actual === undefined) return false;
  return Object.entries(expected.mcpServers).every(
    ([name, entry]) => Object.hasOwn(actual, name) && isDeepStrictEqual(actual[name], entry),
  );
}

function editingError(source: string, ownedNames: readonly string[]): string | undefined {
  const duplicate = duplicateKiroMcpKeys(source, ownedNames);
  return duplicate.length === 0
    ? undefined
    : `Kiro MCP settings contain duplicate mcpServers/owned entry keys: ${duplicate.join(", ")}`;
}

function formatting(source: string) {
  return { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" };
}

function insertServerEntry(source: string, name: string, entry: unknown): string {
  const root = parseTree(source);
  const servers = nodeAt(root, ["mcpServers"]);
  if (servers?.type !== "object") {
    return applyEdits(
      source,
      modify(source, ["mcpServers", name], entry, { formattingOptions: formatting(source) }),
    );
  }
  const end = servers.offset + servers.length - 1;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const previousLineBreak = source.lastIndexOf("\n", end - 1);
  if (previousLineBreak < servers.offset) {
    const separator = (servers.children?.length ?? 0) === 0 ? "" : ", ";
    return `${source.slice(0, end)}${separator}${JSON.stringify(name)}: ${JSON.stringify(entry)}${source.slice(end)}`;
  }
  const lineStart = previousLineBreak + 1;
  const closingIndent = source.slice(lineStart, end);
  const propertyIndent = `${closingIndent}${closingIndent.includes("\t") ? "\t" : "  "}`;
  const rendered = JSON.stringify(entry, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${propertyIndent}${line}`))
    .join(eol);
  const property = `${JSON.stringify(name)}: ${rendered}`;
  const insert =
    (servers.children?.length ?? 0) === 0
      ? `${eol}${propertyIndent}${property}${eol}${closingIndent}`
      : `,${eol}${propertyIndent}${property}`;
  return `${source.slice(0, end)}${insert}${source.slice(end)}`;
}

/** Apply only ownership-proven leaf edits so operator JSONC text survives verbatim. */
function editedProjectionContents(
  source: string | undefined,
  expected: KiroExpected,
  removeNames: readonly string[],
): string {
  if (source === undefined) return `${JSON.stringify(expected, null, 2)}\n`;
  parseJsoncText(source);
  const names = [...new Set([...Object.keys(expected.mcpServers), ...removeNames])];
  const error = editingError(source, names);
  if (error !== undefined) throw new Error(error);
  let text = source;
  const options = { formattingOptions: formatting(source) };
  for (const [name, entry] of Object.entries(expected.mcpServers)) {
    const existing = nodeAt(parseTree(text), ["mcpServers", name]);
    text =
      existing === undefined
        ? insertServerEntry(text, name, entry)
        : applyEdits(text, modify(text, ["mcpServers", name], entry, options));
  }
  for (const name of removeNames) {
    text = applyEdits(text, modify(text, ["mcpServers", name], undefined, options));
  }
  return text;
}

function isKiroEntry(value: McpEntry): boolean {
  return (
    value.type === "stdio" &&
    typeof value.command === "string" &&
    Array.isArray(value.args) &&
    value.args.every((arg) => typeof arg === "string") &&
    typeof value.description === "string" &&
    typeof value.classification === "string" &&
    typeof value.egress === "string" &&
    typeof value.credentials === "string" &&
    typeof value.supplyChain === "string"
  );
}

export function kiroMcpProjectionExpected(servers: Record<string, McpServer>): KiroExpected {
  const entries = mcpEntries("kiro", servers);
  for (const [name, entry] of Object.entries(entries)) {
    if (!isKiroEntry(entry)) {
      throw new Error(`Kiro governed MCP projection refuses unsupported server shape for ${name}`);
    }
  }
  return { mcpServers: entries as KiroExpected["mcpServers"] };
}

function parseMarker(source: string | undefined): KiroMcpProjectionOwnership | undefined {
  if (source === undefined) return undefined;
  try {
    return AihConfigSchema.parse(JSON.parse(source)).kiroMcpProjection;
  } catch {
    return undefined;
  }
}

/** The active receipt and no-follow on-disk state, or no provable active receipt. */
export function kiroMcpProjectionOnDisk(root: string): KiroMcpProjectionResidue | undefined {
  const markerSource = readProjectionFile(root, AIH_CONFIG_FILE);
  const ownership = parseMarker(markerSource);
  if (!isActiveKiroMcpProjectionOwnership(ownership)) return undefined;
  const settingsSource = readProjectionFile(root, KIRO_MCP_SETTINGS_PATH);
  if (settingsSource === undefined) {
    return {
      path: KIRO_MCP_SETTINGS_PATH,
      ownership,
      matches: false,
      unprovable: occupied(absolute(root, KIRO_MCP_SETTINGS_PATH))
        ? "not-a-regular-file"
        : "settings-absent",
      markerSource,
      settingsSource,
    };
  }
  let matches = false;
  try {
    matches =
      editingError(settingsSource, Object.keys(ownership.expected.mcpServers)) === undefined &&
      sameExpectedEntries(parseJsoncText(settingsSource), ownership.expected);
  } catch {
    matches = false;
  }
  return {
    path: KIRO_MCP_SETTINGS_PATH,
    ownership,
    matches,
    unprovable: matches
      ? undefined
      : editingError(settingsSource, Object.keys(ownership.expected.mcpServers)) === undefined
        ? "entries-drifted"
        : "duplicate-keys",
    markerSource,
    settingsSource,
  };
}

function projectionWrite(
  expected: KiroExpected,
  source: string | undefined,
  previous: KiroExpected | undefined,
): WriteAction {
  const stale = Object.keys(previous?.mcpServers ?? {}).filter(
    (name) => !Object.hasOwn(expected.mcpServers, name),
  );
  return withExpectedContents(
    writeText(
      KIRO_MCP_SETTINGS_PATH,
      editedProjectionContents(source, expected, stale),
      "project governed Kiro workspace MCP servers (distribution only; custom agents may override or exclude workspace MCP)",
    ),
    source,
  );
}

function ownershipAction(
  ctx: PlanContext,
  expected: KiroExpected,
  source: string | undefined,
): Action {
  return withExpectedContents(
    writeJson(
      AIH_CONFIG_FILE,
      kiroMcpProjectionConfigJsonFromRaw(
        source,
        ctx.contextDir,
        [...(ctx.targets ?? [])],
        kiroMcpProjectionOwnership(expected),
      ),
      "record Kiro workspace-MCP projection ownership",
      { merge: true },
    ),
    source,
  );
}

function clearOwnershipAction(source: string | undefined): Action {
  return withExpectedContents(
    writeJson(AIH_CONFIG_FILE, {}, "clear Kiro workspace-MCP projection ownership", {
      merge: true,
      removeJsonTopLevelKeys: ["kiroMcpProjection"],
    }),
    source,
  );
}

/** Subtract unchanged receipt-owned Kiro server names without changing marker ownership. */
export function kiroMcpSubtractionAction(
  residue: KiroMcpProjectionResidue,
  describe = "subtract receipt-owned Kiro workspace MCP servers",
): WriteAction | undefined {
  if (!residue.matches) return undefined;
  return withExpectedContents(
    writeText(
      KIRO_MCP_SETTINGS_PATH,
      editedProjectionContents(
        residue.settingsSource,
        { mcpServers: {} },
        Object.keys(residue.ownership.expected.mcpServers),
      ),
      describe,
    ),
    residue.settingsSource,
  );
}

function revokeOwnershipAction(
  ownership: KiroMcpProjectionOwnership,
  source: string | undefined,
): Action {
  return withExpectedContents(
    writeJson(
      AIH_CONFIG_FILE,
      { kiroMcpProjection: revokedKiroMcpProjectionOwnership(ownership) },
      "revoke Kiro workspace-MCP ownership after operator change",
      { merge: true },
    ),
    source,
  );
}

function unreceiptedCollision(
  root: string,
  expected: KiroExpected,
  ownedNames: ReadonlySet<string> = new Set(),
  observedSource?: string,
): string | undefined {
  const source = observedSource ?? readProjectionFile(root, KIRO_MCP_SETTINGS_PATH);
  if (source === undefined) {
    return occupied(absolute(root, KIRO_MCP_SETTINGS_PATH))
      ? "Kiro MCP settings path is not a regular file"
      : undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseJsoncText(source);
  } catch {
    return "Kiro MCP settings are malformed";
  }
  if (!isRecord(parsed)) return "Kiro MCP settings are not a JSON object";
  const duplicate = editingError(source, Object.keys(expected.mcpServers));
  if (duplicate !== undefined) return duplicate;
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    return "Kiro MCP settings mcpServers is not a JSON object";
  }
  const existing = (parsed.mcpServers ?? {}) as Record<string, unknown>;
  const collision = Object.keys(expected.mcpServers).find(
    (name) => !ownedNames.has(name) && Object.hasOwn(existing, name),
  );
  return collision === undefined
    ? undefined
    : `unreceipted Kiro MCP server ${collision} already exists`;
}

/**
 * Reconcile Kiro's workspace MCP distribution. It owns only receipt-named
 * `mcpServers` children and never claims managed enforcement over Kiro custom agents.
 */
export function kiroMcpProjectionActions(
  ctx: PlanContext,
  servers: Record<string, McpServer>,
): Action[] {
  const expected = kiroMcpProjectionExpected(servers);
  const residue = kiroMcpProjectionOnDisk(ctx.root);
  if (residue !== undefined && !residue.matches) {
    if (Object.keys(expected.mcpServers).length > 0) {
      throw new Error(
        `Kiro governed MCP projection refuses to update unprovable ownership: ${residue.unprovable}`,
      );
    }
    return [revokeOwnershipAction(residue.ownership, residue.markerSource)];
  }
  if (residue !== undefined && isDeepStrictEqual(residue.ownership.expected, expected)) return [];
  if (residue === undefined) {
    if (Object.keys(expected.mcpServers).length === 0) return [];
    const collision = unreceiptedCollision(ctx.root, expected);
    if (collision !== undefined)
      throw new Error(`Kiro governed MCP projection refuses ${collision}`);
    const configSource = readProjectionFile(ctx.root, KIRO_MCP_SETTINGS_PATH);
    const markerSource = readProjectionFile(ctx.root, AIH_CONFIG_FILE);
    return [
      projectionWrite(expected, configSource, undefined),
      ownershipAction(ctx, expected, markerSource),
    ];
  }
  if (Object.keys(expected.mcpServers).length === 0) {
    const subtraction = kiroMcpSubtractionAction(residue);
    return subtraction === undefined
      ? [revokeOwnershipAction(residue.ownership, residue.markerSource)]
      : [subtraction, clearOwnershipAction(residue.markerSource)];
  }
  const collision = unreceiptedCollision(
    ctx.root,
    expected,
    new Set(Object.keys(residue.ownership.expected.mcpServers)),
    residue.settingsSource,
  );
  if (collision !== undefined) throw new Error(`Kiro governed MCP projection refuses ${collision}`);
  return [
    projectionWrite(expected, residue.settingsSource, residue.ownership.expected),
    ownershipAction(ctx, expected, residue.markerSource),
  ];
}

/** Stable state for reports; no marker makes the projection absent. */
export function kiroMcpProjectionState(root: string): {
  state: "absent" | "clean" | "altered" | "missing" | "unsafe-path" | "revoked" | "malformed";
  detail: string;
} {
  const markerSource = readProjectionFile(root, AIH_CONFIG_FILE);
  if (markerSource === undefined) {
    return occupied(absolute(root, AIH_CONFIG_FILE))
      ? { state: "unsafe-path", detail: `${AIH_CONFIG_FILE} is not a regular file` }
      : { state: "absent", detail: "no Kiro workspace-MCP ownership receipt" };
  }
  let ownership: KiroMcpProjectionOwnership | undefined;
  try {
    ownership = AihConfigSchema.parse(JSON.parse(markerSource)).kiroMcpProjection;
  } catch {
    return { state: "malformed", detail: "Kiro workspace-MCP receipt is malformed" };
  }
  if (ownership === undefined) {
    return { state: "absent", detail: "no Kiro workspace-MCP ownership receipt" };
  }
  if (!isKiroMcpProjectionOwnership(ownership)) {
    return { state: "malformed", detail: "Kiro workspace-MCP receipt is invalid" };
  }
  if (ownership.state === "revoked") {
    return { state: "revoked", detail: "Kiro workspace-MCP ownership was revoked after drift" };
  }
  const residue = kiroMcpProjectionOnDisk(root);
  if (residue === undefined)
    return { state: "malformed", detail: "Kiro workspace-MCP receipt could not be read safely" };
  if (residue.matches)
    return { state: "clean", detail: "Kiro workspace-MCP receipt and owned entries match" };
  if (residue.unprovable === "settings-absent")
    return { state: "missing", detail: "Kiro workspace-MCP settings are absent" };
  if (residue.unprovable === "not-a-regular-file")
    return { state: "unsafe-path", detail: "Kiro workspace-MCP settings path is unsafe" };
  return {
    state: "altered",
    detail: "Kiro workspace-MCP entries drifted from the ownership receipt",
  };
}
