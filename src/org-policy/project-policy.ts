import { z } from "zod";
import { AihError } from "../errors.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import type { OrgPolicy } from "./schema.js";
import { type WorkbenchOriginV1, WorkbenchOriginV1Schema } from "./workbench/contracts.js";

/**
 * D5 (`prototype/policy-workbench/ADOPTION-PLAN.md` §3, Option A): a narrow-only
 * project selection file. It never carries `allow`, `risk`, `security`, or
 * issuer-trust/signature fields — those remain the org policy's authority.
 * `.strict()` throughout rejects any such field on parse rather than stripping it.
 *
 * `cutFrom` pins only identity the org policy schema actually exposes today:
 * `schemaVersion` (2 | 3, the only version marker on `OrgPolicySchema`) and a
 * `sha256` content digest. The org policy has no `policyId`/`issuer`/free-text
 * `policyVersion` field of its own (see the ambiguity note on
 * `checkProjectPolicyNarrowsV1` below) — this schema does not invent one.
 */
const CutFromV1Schema = z
  .object({
    schemaVersion: z.union([z.literal(2), z.literal(3)]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CutFromV1 = z.infer<typeof CutFromV1Schema>;

const ProjectPolicyForV1Schema = z
  .object({
    type: z.enum(["project", "persona", "agent"]),
    name: z.string().min(1),
  })
  .strict();

const AiToolIdSchema = z.enum(SUPPORTED_CLIS);

const ProjectPolicyItemV1Schema = z
  .object({
    assetId: z.string().min(1).max(240),
    origin: WorkbenchOriginV1Schema,
    use: z.enum(["required", "optional"]),
  })
  .strict();

export const ProjectPolicyV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("aih-project-policy"),
    cutFrom: CutFromV1Schema,
    for: ProjectPolicyForV1Schema,
    aiTools: z
      .array(AiToolIdSchema)
      .min(1)
      .refine((tools) => new Set(tools).size === tools.length, "aiTools must be unique"),
    items: z.array(ProjectPolicyItemV1Schema).superRefine((items, ctx) => {
      const ids = items.map((item) => item.assetId);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: "custom", message: "items must have unique assetId values" });
      }
    }),
  })
  .strict();
export type ProjectPolicyV1 = z.infer<typeof ProjectPolicyV1Schema>;

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
