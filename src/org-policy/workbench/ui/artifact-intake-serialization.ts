export type JsonScalar = null | boolean | number | string;
export type JsonValue = JsonScalar | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Stable local serialization used only to bind already-prepared browser data. */
export function canonicalJson(value: JsonValue): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(record)
    .sort()
    .map((key) => {
      const entry = record[key];
      if (entry === undefined) throw new TypeError(`missing JSON value for ${key}`);
      return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
    })
    .join(",")}}`;
}
