import { createHash } from "node:crypto";
import type { CheckCode } from "../internals/verify.js";

export interface ContentFindingIdentity {
  code: CheckCode;
  path: string;
  ruleId: string;
  content: string | Buffer;
  occurrence: number;
  displayLine?: number;
}

function normalizedSafePath(path: string): string {
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/{2,}/g, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    return "untrusted-document";
  }
  return normalized;
}

export function contentFindingFingerprint(input: ContentFindingIdentity): string {
  if (!Number.isSafeInteger(input.occurrence) || input.occurrence < 0) {
    throw new Error("finding occurrence must be a non-negative safe integer");
  }
  const path = normalizedSafePath(input.path);
  const hash = createHash("sha256");
  for (const value of [input.code, path, input.ruleId, String(input.occurrence)]) {
    hash.update(value, "utf8");
    hash.update("\0", "utf8");
  }
  hash.update(input.content);
  return `${input.code.replace(/\./g, "-")}:${path}:${hash.digest("hex")}`;
}
