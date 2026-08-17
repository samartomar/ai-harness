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
