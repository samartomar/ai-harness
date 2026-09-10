import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type ActiveNativeMcpProjectionOwnership,
  AIH_CONFIG_FILE,
  AihConfigSchema,
  isNativeMcpProjectionOwnership,
  type McpProjectionDecisionBindings,
  NativeMcpProjectionExpectedSchema,
  type NativeMcpProjectionOwnership,
  type NativeMcpTarget,
  nativeMcpProjectionOwnership,
  revokedNativeMcpProjectionOwnership,
} from "../config/marker.js";
import { entry } from "../internals/cli-registry.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import {
  type Action,
  type PlanContext,
  type WriteAction,
  writeJson,
  writeText,
} from "../internals/plan.js";
import { hasSymlinkParent, occupied, withExpectedContents } from "./managed-projection.js";
import {
  editedNativeConfig,
  nativeConfigEntries,
  nativeEntriesMatch,
  strictJsonObject,
} from "./native-projection-format.js";
import { nativeMcpEntries } from "./render.js";
import type { McpServer } from "./servers.js";

export { NATIVE_MCP_TARGETS, type NativeMcpTarget } from "../config/marker.js";

type Expected = NativeMcpProjectionOwnership["expected"];
export interface NativeMcpProjectionResidue {
  target: NativeMcpTarget;
  path: string;
  ownership: ActiveNativeMcpProjectionOwnership;
  matches: boolean;
  unprovable:
    | "not-a-regular-file"
    | "settings-absent"
    | "entries-drifted"
    | "alternate-config"
    | undefined;
  markerSource: string | undefined;
  settingsSource: string | undefined;
  alternateConfigPath?: string;
}

function occupiedAlternateConfig(root: string, target: NativeMcpTarget): string | undefined {
  return entry(target).mcp.governed?.alternateConfigPaths?.find((path) =>
    occupied(join(root, path)),
  );
}

function withAbsentCompanions(action: WriteAction, target: NativeMcpTarget): WriteAction {
  const paths = entry(target).mcp.governed?.alternateConfigPaths ?? [];
  return paths.length === 0 ? action : { ...action, assertAbsentPaths: [...paths] };
}

export function nativeMcpProjectionPath(target: NativeMcpTarget): string {
  const path = entry(target).mcp.governed?.configPath;
  if (
    path === undefined ||
    isAbsolute(path) ||
    path.startsWith("~") ||
    path.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`${target} has no safe governed project MCP path`);
  }
  return path;
}

function readProjectionFile(root: string, path: string): string | undefined {
  if (hasUnsafeParent(root, path)) return undefined;
  const opened = readRegularFileWithStats(join(root, path), { maxBytes: 2 * 1024 * 1024 });
  if (opened === undefined || opened.identity.nlink !== 1n) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(opened.contents);
  } catch {
    return undefined;
  }
}

function hasUnsafeParent(root: string, path: string): boolean {
  if (hasSymlinkParent(root, path)) return true;
  let parent = root;
  for (const part of path.split("/").slice(0, -1)) {
    parent = join(parent, part);
    try {
      if (!lstatSync(parent).isDirectory()) return true;
    } catch {
      return occupied(parent);
    }
  }
  return false;
}

function readMarker(root: string): {
  source: string | undefined;
  config: ReturnType<typeof AihConfigSchema.parse> | undefined;
} {
  const source = readProjectionFile(root, AIH_CONFIG_FILE);
  if (source === undefined) {
    if (hasSymlinkParent(root, AIH_CONFIG_FILE) || occupied(join(root, AIH_CONFIG_FILE)))
      throw new Error("native MCP marker path is not a regular single-link file");
    return { source, config: undefined };
  }
  let config: ReturnType<typeof AihConfigSchema.parse>;
  try {
    strictJsonObject(source);
    config = AihConfigSchema.parse(JSON.parse(source));
  } catch {
    throw new Error("native MCP ownership marker is malformed");
  }
  for (const [target, ownership] of Object.entries(config.nativeMcpProjections ?? {})) {
    if (!isNativeMcpProjectionOwnership(ownership, target as NativeMcpTarget))
      throw new Error("native MCP ownership receipt is malformed or target-mismatched");
  }
  return { source, config };
}

export function nativeMcpProjectionExpected(
  target: NativeMcpTarget,
  servers: Record<string, McpServer>,
): Expected {
  return NativeMcpProjectionExpectedSchema.parse({ entries: nativeMcpEntries(target, servers) });
}

/** Only a scope-valid active receipt can authorize inspection for subtraction. */
export function nativeMcpProjectionOnDisk(
  root: string,
  target: NativeMcpTarget,
): NativeMcpProjectionResidue | undefined {
  let marker: ReturnType<typeof readMarker>;
  try {
    marker = readMarker(root);
  } catch {
    return undefined;
  }
  const ownership = marker.config?.nativeMcpProjections?.[target];
  if (ownership === undefined || ownership.state !== "active") return undefined;
  const path = nativeMcpProjectionPath(target);
  const settingsSource = readProjectionFile(root, path);
  const alternateConfigPath = occupiedAlternateConfig(root, target);
  let matches = false;
  try {
    matches =
      alternateConfigPath === undefined &&
      settingsSource !== undefined &&
      nativeEntriesMatch(target, settingsSource, ownership.expected);
  } catch {
    matches = false;
  }
  return {
    target,
    path,
    ownership: ownership as ActiveNativeMcpProjectionOwnership,
    matches,
    unprovable: matches
      ? undefined
      : alternateConfigPath !== undefined
        ? "alternate-config"
        : settingsSource !== undefined
          ? "entries-drifted"
          : occupied(join(root, path)) || hasUnsafeParent(root, path)
            ? "not-a-regular-file"
            : "settings-absent",
    markerSource: marker.source,
    settingsSource,
    ...(alternateConfigPath === undefined ? {} : { alternateConfigPath }),
  };
}

function ownershipAction(
  ctx: PlanContext,
  target: NativeMcpTarget,
  ownership: NativeMcpProjectionOwnership | undefined,
  source: string | undefined,
): WriteAction {
  const json = ownership === undefined ? {} : { nativeMcpProjections: { [target]: ownership } };
  const action = withExpectedContents(
    writeJson(
      AIH_CONFIG_FILE,
      source === undefined
        ? {
            schemaVersion: 1,
            contextDir: ctx.contextDir,
            targets: [...(ctx.targets ?? [])],
            ...json,
          }
        : json,
      `${ownership === undefined ? "clear" : ownership.state === "revoked" ? "revoke" : "record"} ${target} native MCP ownership`,
      {
        merge: true,
        ...(ownership === undefined
          ? { removeJsonKeys: { nativeMcpProjections: [target] } }
          : { replaceJsonChildKeys: { nativeMcpProjections: [target] } }),
        durable: true,
      },
    ),
    source,
  );
  return ownership?.state === "active" ? withAbsentCompanions(action, target) : action;
}

export function nativeMcpSubtractionAction(
  residue: NativeMcpProjectionResidue,
  describe = `subtract receipt-owned ${residue.target} native MCP servers`,
): WriteAction | undefined {
  if (!residue.matches) return undefined;
  return withExpectedContents(
    writeText(
      residue.path,
      editedNativeConfig(
        residue.target,
        residue.settingsSource,
        { entries: {} },
        residue.ownership.expected,
      ),
      describe,
    ),
    residue.settingsSource,
  );
}

/** Pure planning; both native bytes and target-scoped receipt commit in the existing transaction. */
export function nativeMcpProjectionActions(
  ctx: PlanContext,
  target: NativeMcpTarget,
  servers: Record<string, McpServer>,
  decisions: McpProjectionDecisionBindings = [],
): Action[] {
  const marker = readMarker(ctx.root);
  const expected = nativeMcpProjectionExpected(target, servers);
  const desired = nativeMcpProjectionOwnership(target, expected, decisions);
  const residue = nativeMcpProjectionOnDisk(ctx.root, target);
  const empty = Object.keys(expected.entries).length === 0;
  if (!empty) {
    const alternate = occupiedAlternateConfig(ctx.root, target);
    if (alternate !== undefined)
      throw new Error(
        `${target} governed MCP projection refuses alternate config ${alternate}; reconcile its host precedence before projecting`,
      );
  }
  if (residue !== undefined && !residue.matches) {
    if (!empty)
      throw new Error(
        `${target} governed MCP projection refuses unprovable ownership: ${residue.unprovable}`,
      );
    return [
      ownershipAction(
        ctx,
        target,
        revokedNativeMcpProjectionOwnership(residue.ownership),
        marker.source,
      ),
    ];
  }
  if (residue !== undefined && isDeepStrictEqual(residue.ownership, desired)) return [];
  if (empty) {
    if (residue === undefined) return [];
    const subtraction = nativeMcpSubtractionAction(residue);
    return subtraction === undefined
      ? []
      : [subtraction, ownershipAction(ctx, target, undefined, marker.source)];
  }
  const path = nativeMcpProjectionPath(target);
  const source = residue?.settingsSource ?? readProjectionFile(ctx.root, path);
  if (source === undefined && (occupied(join(ctx.root, path)) || hasUnsafeParent(ctx.root, path)))
    throw new Error(`${target} MCP settings path is not a regular single-link file`);
  const actual = source === undefined ? {} : nativeConfigEntries(target, source);
  for (const name of Object.keys(expected.entries)) {
    if (
      Object.hasOwn(actual, name) &&
      !Object.hasOwn(residue?.ownership.expected.entries ?? {}, name)
    )
      throw new Error(`unreceipted ${target} MCP server ${name} already exists`);
  }
  return [
    withAbsentCompanions(
      withExpectedContents(
        writeText(
          path,
          editedNativeConfig(target, source, expected, residue?.ownership.expected),
          `project governed ${target} native MCP servers (${entry(target).mcp.governed?.contract}; distribution only)`,
        ),
        source,
      ),
      target,
    ),
    ownershipAction(ctx, target, desired, marker.source),
  ];
}

export function nativeMcpProjectionState(
  root: string,
  target: NativeMcpTarget,
): {
  state: "absent" | "clean" | "altered" | "missing" | "unsafe-path" | "revoked" | "malformed";
  detail: string;
} {
  let marker: ReturnType<typeof readMarker>;
  try {
    marker = readMarker(root);
  } catch {
    return {
      state: readProjectionFile(root, AIH_CONFIG_FILE) === undefined ? "unsafe-path" : "malformed",
      detail: `${target} native MCP ownership marker is unsafe or malformed`,
    };
  }
  const ownership = marker.config?.nativeMcpProjections?.[target];
  if (ownership === undefined)
    return { state: "absent", detail: `no ${target} native MCP ownership receipt` };
  if (ownership.state === "revoked")
    return { state: "revoked", detail: `${target} native MCP ownership was revoked after drift` };
  const residue = nativeMcpProjectionOnDisk(root, target);
  if (residue?.matches)
    return { state: "clean", detail: `${target} native MCP receipt and owned entries match` };
  if (residue?.unprovable === "alternate-config")
    return {
      state: "altered",
      detail: `${target} native MCP configuration is ambiguous with alternate config ${residue.alternateConfigPath}`,
    };
  if (residue?.unprovable === "settings-absent")
    return { state: "missing", detail: `${target} native MCP settings are absent` };
  if (residue?.unprovable === "not-a-regular-file")
    return { state: "unsafe-path", detail: `${target} native MCP settings path is unsafe` };
  return {
    state: "altered",
    detail: `${target} native MCP entries drifted from the ownership receipt`,
  };
}
