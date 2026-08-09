import { createHash } from "node:crypto";

export function codeUnitCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function ownDataPropertyValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) {
    throw new TypeError("canonical JSON properties must be own data properties");
  }
  if (!("value" in descriptor)) {
    throw new TypeError("canonical JSON does not support accessor properties");
  }
  return descriptor.value;
}

export function canonicalizeObjectKeys(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    throw new TypeError("canonical JSON numbers must be finite and not negative zero");
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON does not support ${typeof value}`);
  }

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError("canonical JSON does not support this array prototype");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("canonical JSON does not support symbol keys");
    }
    if (
      Object.keys(value).some((key) => {
        const index = Number(key);
        return (
          !Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key
        );
      })
    ) {
      throw new TypeError("canonical JSON arrays cannot have extra enumerable string keys");
    }
    const normalized: unknown[] = [];
    Object.defineProperty(normalized, "toJSON", {
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false,
    });
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined) {
        throw new TypeError("canonical JSON does not support array holes");
      }
      if (!("value" in descriptor)) {
        throw new TypeError("canonical JSON does not support accessor properties");
      }
      normalized.push(canonicalizeObjectKeys(descriptor.value));
    }
    return normalized;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("canonical JSON does not support this object prototype");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("canonical JSON does not support symbol keys");
  }

  const normalized: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort(codeUnitCompare)) {
    normalized[key] = canonicalizeObjectKeys(ownDataPropertyValue(value, key));
  }
  return normalized;
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalizeObjectKeys(value));
  if (serialized === undefined) throw new TypeError("value is not JSON serializable");
  return serialized;
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
