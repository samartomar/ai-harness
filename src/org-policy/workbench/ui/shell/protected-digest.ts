/**
 * Headless protected-authority digest logic extracted from
 * `studio-protected-authority-runtime.js` (S0). Verbatim ports; the runtime
 * binds its local helpers to these exports. Hashing itself stays in the
 * runtime because it owns the "no Web Crypto" refusal; this module owns the
 * exact bytes that get hashed and the canonical forms that get downloaded.
 */

/** Domain tags prefixed (with a NUL separator) to each canonical preimage. */
export const PROTECTED_DIGEST_DOMAINS = {
  source: "aih-governance-decision-source/v2",
  subject: "aih-governance-decision-subject/v2",
  decision: "aih-governance-decision/v2",
  evidence: "aih-organization-evidence/v1",
} as const;

export type ProtectedDigestDomain = keyof typeof PROTECTED_DIGEST_DOMAINS;

/** Legacy `protectedStableJson`: sorted-key compact JSON (also the evidence download bytes). */
export function protectedStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(protectedStableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${protectedStableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The exact string hashed for a domain digest: `domain + "\0" + stableJson(value)`. */
export function protectedDigestPreimage(domain: ProtectedDigestDomain, value: unknown): string {
  return PROTECTED_DIGEST_DOMAINS[domain] + String.fromCharCode(0) + protectedStableJson(value);
}

/** Legacy `protectedCanonicalTimestamp`. */
export function protectedCanonicalTimestamp(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

/** Legacy `protectedStrictStrings`: well-formed UTF-16, already NFC, keys included. */
export function protectedStrictStrings(value: unknown, label: string): void {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const current = value.charCodeAt(index);
      if (current >= 0xd800 && current <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw new Error(`${label} contains malformed Unicode`);
        }
        index += 1;
        continue;
      }
      if (current >= 0xdc00 && current <= 0xdfff) {
        throw new Error(`${label} contains malformed Unicode`);
      }
    }
    if (value.normalize("NFC") !== value) {
      throw new Error(`${label} must already be NFC`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      protectedStrictStrings(child, `${label}[${String(index)}]`);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      protectedStrictStrings(key, `${label} key`);
      protectedStrictStrings(record[key], `${label}.${key}`);
    }
  }
}

/** Legacy `protectedEvidenceId`: a stable scan id from an item id and source digest. */
export function protectedEvidenceId(record: {
  readonly itemId?: unknown;
  readonly sourceDigest: string;
}): string {
  const item =
    String(record.itemId || "artifact")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "artifact";
  return `scan-${item.slice(0, 42)}-${record.sourceDigest.slice(7, 19)}`.slice(0, 64);
}
