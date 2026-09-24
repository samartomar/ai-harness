import { createHash } from "node:crypto";
import {
  type Node as JsonNode,
  type ParseError,
  parse as parseJson,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";
import { canonicalJson } from "../capability/package-graph/canonical.js";

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

export function assertWellFormedNfcV1(value: string, label: string, requireNfc = true): void {
  // ASCII strings are already well formed and NFC, including short ids and keys.
  // Keep the existing Unicode checks for any non-ASCII input.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: identifying the complete ASCII range, not rejecting JSON control characters
  if (!/[^\x00-\x7f]/u.test(value)) return;
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} contains malformed Unicode (a lone high surrogate)`);
      }
      index += 1;
      continue;
    }
    if (current >= 0xdc00 && current <= 0xdfff) {
      throw new TypeError(`${label} contains malformed Unicode (a lone low surrogate)`);
    }
  }
  if (requireNfc && value.normalize("NFC") !== value) {
    throw new TypeError(`${label} must already be NFC; normalization is not performed`);
  }
}

export function assertStrictJsonValueV1<T>(
  value: T,
  label: string,
  requireNfc = true,
  active = new WeakSet<object>(),
): T {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertWellFormedNfcV1(value, label, requireNfc);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${label} numbers must be finite and not negative zero`);
    }
    return value;
  }
  if (!isObject(value)) throw new TypeError(`${label} does not support ${typeof value}`);
  if (active.has(value)) throw new TypeError(`${label} must not contain a cycle`);
  active.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not contain symbol properties`);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`${label} has an unsupported array prototype`);
    }
    if (
      Object.keys(value).some((key) => {
        const index = Number(key);
        return (
          !Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key
        );
      })
    ) {
      throw new TypeError(`${label} arrays cannot have extra enumerable string keys`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError(`${label} arrays must contain only data properties and no holes`);
      }
      assertStrictJsonValueV1(descriptor.value, `${label}[${String(index)}]`, requireNfc, active);
    }
    active.delete(value);
    return value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} has an unsupported object prototype`);
  }
  for (const key of Object.keys(value)) {
    assertWellFormedNfcV1(key, `${label} key`, requireNfc);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${label}.${key} must be an own data property`);
    }
    assertStrictJsonValueV1(descriptor.value, `${label}.${key}`, requireNfc, active);
  }
  active.delete(value);
  return value;
}

/**
 * A nesting bound for callers that read hostile text or values, far above any real record
 * (packaged scanner evidence nests seven levels). Catalog's strict JSON reader uses the same.
 */
export const STRICT_JSON_MAX_DEPTH_V1 = 32;

function nestedTooDeep(label: string, maxDepth: number): TypeError {
  return new TypeError(`${label} nests deeper than ${String(maxDepth)} levels`);
}

const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_HEX4 = /^[0-9a-fA-F]{4}$/;
const JSON_SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

/**
 * Checks the whole text against the grammar Catalog's strict JSON reader enforces, iteratively and
 * before jsonc-parser runs: that parser recovers from errors (comments, trailing commas, stray
 * characters, unbalanced delimiters) and keeps recursing, so it only ever sees text that is RFC 8259
 * JSON with an object root, JSON whitespace only, ASCII `\u` escapes, and objects and arrays nested
 * at most `STRICT_JSON_MAX_DEPTH_V1` levels (the root is level 1).
 */
function assertStrictJsonTextV1(text: string, label: string): void {
  let index = 0;
  const fail = (expected: string): never => {
    throw new TypeError(`invalid JSON ${label}: ${expected} at offset ${String(index)}`);
  };
  const space = () => {
    while (index < text.length && " \t\n\r".includes(text.charAt(index))) index += 1;
  };
  const string = () => {
    index += 1;
    for (;;) {
      if (index >= text.length) fail("closing quote");
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        return;
      }
      if (code < 0x20) fail("escaped control character");
      if (code !== 0x5c) index += 1;
      else if (text.charAt(index + 1) === "u") {
        if (!JSON_HEX4.test(text.slice(index + 2, index + 6))) fail("four hex digits");
        index += 6;
      } else if (JSON_SIMPLE_ESCAPES.has(text.charAt(index + 1))) index += 2;
      else fail("escape character");
    }
  };
  const key = () => {
    space();
    if (text.charAt(index) !== '"') fail("property name");
    string();
    space();
    if (text.charAt(index) !== ":") fail("colon");
    index += 1;
  };
  /** The open containers, innermost last: `}` for an object, `]` for an array. */
  const closers: string[] = [];
  space();
  if (text.charAt(index) !== "{") fail("object root");
  let expectValue = true;
  for (;;) {
    if (expectValue) {
      space();
      const char = text.charAt(index);
      if (char === "{" || char === "[") {
        if (closers.length >= STRICT_JSON_MAX_DEPTH_V1)
          throw nestedTooDeep(label, STRICT_JSON_MAX_DEPTH_V1);
        const closer = char === "{" ? "}" : "]";
        closers.push(closer);
        index += 1;
        space();
        if (text.charAt(index) === closer) {
          index += 1;
          closers.pop();
          expectValue = false;
        } else if (closer === "}") key();
        continue;
      }
      if (char === '"') string();
      else {
        const word = ["true", "false", "null"].find((literal) => text.startsWith(literal, index));
        if (word !== undefined) index += word.length;
        else {
          JSON_NUMBER.lastIndex = index;
          const number = JSON_NUMBER.exec(text);
          if (number === null) fail("value");
          index += (number as RegExpExecArray)[0].length;
        }
      }
      expectValue = false;
      continue;
    }
    const closer = closers[closers.length - 1];
    if (closer === undefined) break;
    space();
    const char = text.charAt(index);
    if (char === ",") {
      index += 1;
      if (closer === "}") key();
      expectValue = true;
    } else if (char === closer) {
      index += 1;
      closers.pop();
    } else fail(closer === "}" ? "comma or closing brace" : "comma or closing bracket");
  }
  space();
  if (index !== text.length) fail("end of text");
}

/**
 * The own entries of a plain JSON object or array, read through their descriptors so a getter is
 * never invoked. Every own key is enumerated (`Reflect.ownKeys`), and a non-plain prototype, a
 * symbol key, a non-enumerable or accessor property, or, for an array, anything but its indices in
 * order (an extra key or a hole) is refused. Catalog's structural readers apply the same checks
 * (`jsonOwnEntriesV1` in its src/production/strict-json-v1.ts).
 */
export function jsonOwnEntriesV1(value: object, label: string): [string, unknown][] {
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`${label} has an unsupported ${array ? "array" : "object"} prototype`);
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw new TypeError(`${label} must not contain symbol properties`);
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true)
      throw new TypeError(`${label} field ${key} must be an enumerable data property`);
    if (array && key !== String(entries.length))
      throw new TypeError(`${label} must contain only indexed elements, with no holes`);
    entries.push([key, descriptor.value]);
  }
  if (array && entries.length !== (value as unknown[]).length)
    throw new TypeError(`${label} must contain only indexed elements, with no holes`);
  return entries;
}

/**
 * Refuses a value that is not plain JSON data (`jsonOwnEntriesV1` on every object and array) or
 * whose objects and arrays nest deeper than `maxDepth` (the root is level 1): level by level,
 * without recursion and without invoking a getter, so it runs before any recursive check does.
 */
export function assertJsonValueStructureV1(value: unknown, label: string, maxDepth: number): void {
  let level = new Set<object>(isObject(value) ? [value] : []);
  for (let depth = 1; level.size > 0; depth += 1) {
    if (depth > maxDepth) throw nestedTooDeep(label, maxDepth);
    const next = new Set<object>();
    for (const item of level)
      for (const [, child] of jsonOwnEntriesV1(item, label)) if (isObject(child)) next.add(child);
    level = next;
  }
}

export function deepFreezeStrictJsonV1<T>(value: T, seen = new WeakSet<object>()): T {
  if (!isObject(value) || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      deepFreezeStrictJsonV1(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

function assertNoDuplicateKeys(node: JsonNode): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key === "string") {
        if (seen.has(key)) throw new TypeError(`duplicate JSON object key: ${key}`);
        seen.add(key);
      }
      const child = property.children?.[1];
      if (child !== undefined) assertNoDuplicateKeys(child);
    }
    return;
  }
  if (node.type === "array") {
    for (const child of node.children ?? []) assertNoDuplicateKeys(child);
  }
}

export function parseStrictJsonObjectV1(text: string, label: string): Record<string, unknown> {
  assertStrictJsonTextV1(text, label);
  assertWellFormedNfcV1(text, `${label} JSON text`);
  const options = { allowTrailingComma: false, disallowComments: true } as const;
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, options);
  if (errors.length > 0 || tree === undefined) {
    const detail = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${String(error.offset)}`)
      .join("; ");
    throw new TypeError(`invalid JSON ${label}${detail.length > 0 ? `: ${detail}` : ""}`);
  }
  if (tree.type !== "object") throw new TypeError(`${label} JSON root must be an object`);
  assertNoDuplicateKeys(tree);
  const parseErrors: ParseError[] = [];
  const parsed = parseJson(text, parseErrors, options);
  if (parseErrors.length > 0 || !isObject(parsed) || Array.isArray(parsed)) {
    throw new TypeError(`invalid JSON ${label}`);
  }
  return assertStrictJsonValueV1(parsed, label) as Record<string, unknown>;
}

export function canonicalStrictJsonBytesV1(value: unknown): Buffer {
  assertStrictJsonValueV1(value, "canonical JSON");
  return Buffer.from(canonicalJson(value), "utf8");
}

export function canonicalStrictJsonSha256V1(value: unknown): string {
  return createHash("sha256").update(canonicalStrictJsonBytesV1(value)).digest("hex");
}

export function assertSafeRelativePosixPathV1(path: string, label: string): string {
  assertWellFormedNfcV1(path, label);
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    /[\\%?#:]/.test(path) ||
    hasControlCharacter(path) ||
    path.endsWith("/")
  ) {
    throw new TypeError(`${label} must be a safe relative POSIX path`);
  }
  if (
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${label} must be a safe relative POSIX path`);
  }
  return path;
}
