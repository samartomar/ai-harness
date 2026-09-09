import { createHash } from "node:crypto";
import type { OrgPolicy } from "./schema.js";

type Candidate = NonNullable<OrgPolicy["governance"]>["catalog"]["reviewed"][number];

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => ordinalCompare(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Digest only immutable source identity, never catalog wording or an activation flag. */
export function candidateIdentityDigest(candidate: Pick<Candidate, "source">): string {
  return `sha256:${createHash("sha256").update(stableJson(candidate.source), "utf8").digest("hex")}`;
}
