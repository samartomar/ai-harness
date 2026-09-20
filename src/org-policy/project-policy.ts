import { z } from "zod";
import { AihError } from "../errors.js";
import { type ProjectPolicyV1, ProjectPolicyV1Schema } from "./project-policy-schema.js";
import type { OrgPolicy } from "./schema-core.js";
import type { WorkbenchOriginV1 } from "./workbench/contracts.js";

export {
  type CutFromV1,
  type ProjectPolicyV1,
  ProjectPolicyV1Schema,
} from "./project-policy-schema.js";

export class ProjectPolicyError extends AihError {
  constructor(message: string) {
    super(message, "AIH_PROJECT_POLICY");
  }
}

function zodIssueMessages(issues: z.ZodError["issues"]): string[] {
  return issues.flatMap((issue) =>
    issue.code === "invalid_union" ? issue.errors.flatMap(zodIssueMessages) : [issue.message],
  );
}

/** Parse an `aih-project-policy.json` document. Fails closed on any unknown shape. */
export function parseProjectPolicyV1(json: unknown): ProjectPolicyV1 {
  try {
    return ProjectPolicyV1Schema.parse(json);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new ProjectPolicyError(
        `aih-project-policy is invalid: ${zodIssueMessages(err.issues).join("; ")}`,
      );
    }
    throw err;
  }
}

export type ProjectPolicyNarrowCheckV1 = { ok: true } | { ok: false; reasons: string[] };

/**
 * Build the set of asset keys the org policy's authoring selections make
 * available, from `roots[].resolvedItems` and `requests[]`, minus anything
 * named in `exclusions[]`.
 *
 * AMBIGUITY (flagged, not guessed): `authoringSelections` (`WorkbenchStateV1`)
 * has no single flat "allowed assetIds" field — it is a working state of
 * `roots` (each with its own `resolvedItems` pins), `requests`, and
 * `exclusions`, keyed by `assetId` + `origin` together, not `assetId` alone.
 * This function treats "allowed" as the union of root-resolved items and
 * requested items, keyed by `assetId` only and excluding assetIds that appear
 * in any exclusion, which is the most conservative reading available without
 * a documented org-policy "effective selection" projection. If the real
 * semantics differ (e.g. an item allowed under one origin but excluded under
 * another should still count as narrowed for that origin), this function will
 * need the owner's exact definition of "present/allowed" — it does not exist
 * in `src/org-policy` today.
 */
function allowedAssetIds(orgPolicy: OrgPolicy): Set<string> {
  const selections = "authoringSelections" in orgPolicy ? orgPolicy.authoringSelections : undefined;
  if (selections === undefined) return new Set();
  const excluded = new Set(selections.exclusions.map((exclusion) => exclusion.assetId));
  const allowed = new Set<string>();
  for (const root of selections.roots) {
    for (const item of root.resolvedItems) {
      if (!excluded.has(item.assetId)) allowed.add(item.assetId);
    }
  }
  for (const request of selections.requests) {
    if (!excluded.has(request.assetId)) allowed.add(request.assetId);
  }
  return allowed;
}

/**
 * Pure narrow check (no filesystem, no consumer wiring): every project-policy
 * item's `assetId` must be present in the org policy's authoring selections,
 * and `cutFrom.sha256` must match `orgPolicyDigestSha256` — the caller's
 * already-computed digest of the org policy bytes it read `orgPolicy` from.
 * A digest mismatch means the org policy moved on since the cut was taken.
 */
export function checkProjectPolicyNarrowsV1(
  projectPolicy: ProjectPolicyV1,
  orgPolicy: OrgPolicy,
  orgPolicyDigestSha256: string,
): ProjectPolicyNarrowCheckV1 {
  const reasons: string[] = [];
  if (projectPolicy.cutFrom.sha256 !== orgPolicyDigestSha256) {
    reasons.push("org policy changed");
  }
  if (projectPolicy.cutFrom.schemaVersion !== orgPolicy.schemaVersion) {
    reasons.push(
      `org policy schemaVersion changed: cut from ${projectPolicy.cutFrom.schemaVersion}, now ${orgPolicy.schemaVersion}`,
    );
  }
  const allowed = allowedAssetIds(orgPolicy);
  for (const item of projectPolicy.items) {
    if (!allowed.has(item.assetId)) {
      reasons.push(`item not allowed by org policy: ${item.assetId}`);
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export type { WorkbenchOriginV1 };
