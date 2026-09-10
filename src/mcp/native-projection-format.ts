import { isDeepStrictEqual } from "node:util";
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  type Node,
  parseTree,
} from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { NativeMcpProjectionOwnership, NativeMcpTarget } from "../config/marker.js";
import { entry } from "../internals/cli-registry.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";

type Expected = NativeMcpProjectionOwnership["expected"];
const BEGIN = "# BEGIN AIH governed MCP codex";
const END = "# END AIH governed MCP codex";

/** Duplicate keys anywhere make parser/edit agreement unprovable, including receipt descendants. */
export function hasDuplicateJsonKeys(node: Node | undefined): boolean {
  if (node === undefined) return false;
  if (node.type === "object") {
    const names = (node.children ?? []).map((property) => property.children?.[0]?.value);
    if (new Set(names).size !== names.length) return true;
  }
  return (node.children ?? []).some(hasDuplicateJsonKeys);
}

export function strictJsonObject(source: string): Record<string, unknown> {
  if (hasDuplicateJsonKeys(parseTree(source))) throw new Error("duplicate JSON keys");
  const parsed = parseJsoncText(source);
  if (!isPlainObject(parsed)) throw new Error("configuration is not a JSON object");
  return parsed;
}

export function nativeConfigObject(
  target: NativeMcpTarget,
  source: string,
): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  if (entry(target).mcp.configFormat === "toml") {
    try {
      parsed = parseToml(source);
    } catch {
      throw new Error("malformed or duplicate-key TOML configuration");
    }
  } else parsed = strictJsonObject(source);
  const key = entry(target).mcp.configKey;
  if (key === undefined) throw new Error(`native MCP map key is unavailable for ${target}`);
  if (parsed[key] !== undefined && !isPlainObject(parsed[key]))
    throw new Error(`${key} is not an object`);
  if (
    target === "opencode" &&
    ((isPlainObject(parsed.mcp) && Object.hasOwn(parsed.mcp, "servers")) ||
      (typeof parsed.$schema === "string" && /(?:\/v2\/|v2[.-])/.test(parsed.$schema)))
  )
    throw new Error(
      "OpenCode V2 configuration is unsupported by the registered V1 projection; select a compatible host contract",
    );
  return parsed;
}

export function nativeConfigEntries(
  target: NativeMcpTarget,
  source: string,
): Record<string, unknown> {
  const value = nativeConfigObject(target, source)[entry(target).mcp.configKey ?? ""];
  return isPlainObject(value) ? value : {};
}

function tomlBlock(expected: Expected, eol: string): string {
  return `${BEGIN}\n${stringifyToml({ mcp_servers: expected.entries })}${END}\n`.replace(
    /\n/g,
    eol,
  );
}

function ownedTomlSpan(
  source: string,
  expected: Expected,
): { start: number; end: number } | undefined {
  const block = tomlBlock(expected, source.includes("\r\n") ? "\r\n" : "\n");
  const start = source.indexOf(block);
  if (
    start < 0 ||
    source.indexOf(block, start + block.length) >= 0 ||
    source.split(BEGIN).length !== 2 ||
    source.split(END).length !== 2
  )
    return undefined;
  return { start, end: start + block.length };
}

/** Remove a property and its separator, retaining neighboring comments and whitespace. */
function removeJsonEntry(source: string, key: string, name: string): string {
  const root = parseTree(source);
  const value = root === undefined ? undefined : findNodeAtLocation(root, [key, name]);
  const property = value?.parent;
  const parent = property?.parent;
  if (property === undefined || parent?.children === undefined)
    throw new Error("owned JSON property is absent");
  const index = parent.children.indexOf(property);
  const previous = parent.children[index - 1];
  const scanner = createScanner(source, true);
  scanner.setPosition(
    previous === undefined ? property.offset + property.length : previous.offset + previous.length,
  );
  scanner.scan();
  const edits = [{ offset: property.offset, length: property.length, content: "" }];
  if (source[scanner.getTokenOffset()] === ",")
    edits.push({ offset: scanner.getTokenOffset(), length: 1, content: "" });
  return applyEdits(source, edits);
}

export function nativeEntriesMatch(
  target: NativeMcpTarget,
  source: string,
  expected: Expected,
): boolean {
  const actual = nativeConfigEntries(target, source);
  if (
    !Object.entries(expected.entries).every(
      ([name, value]) => Object.hasOwn(actual, name) && isDeepStrictEqual(actual[name], value),
    )
  )
    return false;
  return target !== "codex" || ownedTomlSpan(source, expected) !== undefined;
}

export function editedNativeConfig(
  target: NativeMcpTarget,
  source: string | undefined,
  expected: Expected,
  previous?: Expected,
): string {
  const key = entry(target).mcp.configKey;
  if (key === undefined) throw new Error(`native MCP map key is unavailable for ${target}`);
  if (source !== undefined) nativeConfigObject(target, source);
  const eol = source?.includes("\r\n") ? "\r\n" : "\n";
  if (target === "codex") {
    let next = source ?? "";
    if (previous !== undefined) {
      const span = ownedTomlSpan(next, previous);
      if (span === undefined) throw new Error("Codex owned TOML block changed");
      next = next.slice(0, span.start) + next.slice(span.end);
    } else if (next.includes(BEGIN) || next.includes(END))
      throw new Error("unreceipted Codex MCP ownership marker already exists");
    if (Object.keys(expected.entries).length > 0) {
      next += `${next.length > 0 && !next.endsWith("\n") ? eol : ""}${tomlBlock(expected, eol)}`;
    }
    nativeConfigObject(target, next);
    return next;
  }
  if (source === undefined) return `${JSON.stringify({ [key]: expected.entries }, null, 2)}\n`;
  let text = source;
  for (const [name, value] of Object.entries(expected.entries)) {
    // Formatting options expand an edit to neighboring lines and would reformat operator entries.
    text = applyEdits(text, modify(text, [key, name], value, {}));
  }
  for (const name of Object.keys(previous?.entries ?? {})) {
    if (!Object.hasOwn(expected.entries, name)) text = removeJsonEntry(text, key, name);
  }
  nativeConfigObject(target, text);
  return text;
}
