import type { z } from "zod";
import { OrgPolicySchema } from "../../schema-core.js";

/**
 * The canonical organization-policy grammar, applied inside the engine.
 *
 * The browser has validated with a hand-written checker over
 * `z.toJSONSchema(OrgPolicySchema)` plus `ui/shell/policy-grammar.ts`. JSON
 * Schema cannot express a zod `refine`/`superRefine`, so every refinement in
 * `schema-core.ts` that the grammar does not re-implement was unenforced in the
 * browser while Core enforced it. This module closes that by running the SAME
 * schema Core runs — `../../schema-core.js`, never `../../schema.js`, which
 * carries the Node loader.
 *
 * The rendering mirrors `schema-core.ts`: `describePolicyBundleIssue` formats an
 * issue as `path — message` with `(root)` for an empty path, and
 * `zodIssueMessages` (used by `parseOrgPolicy`) flattens `invalid_union` into
 * its member issues. Neither helper is exported from `schema-core.ts`, so the
 * format is mirrored here rather than reused; `engine-canonical-parity.test.ts`
 * pins the messages this produces.
 */

/** Messages beyond this are noise in a UI that renders them as a list. */
const MAX_MESSAGES = 10;

function flatten(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code !== "invalid_union") return [issue];
    const members = flatten(issue.errors.flat());
    // A discriminated union that matched no discriminator reports an
    // `invalid_union` with an EMPTY member list. `parseOrgPolicy` flattens that
    // to nothing and renders "org-policy is invalid:" with no reason; the
    // engine keeps the union's own message instead, because a refusal with no
    // text is not something a UI can show.
    return members.length > 0 ? members : [issue];
  });
}

function describe(issue: z.core.$ZodIssue): string {
  return `${issue.path.map(String).join(".") || "(root)"} — ${issue.message}`;
}

/**
 * Every canonical objection to `policy`, de-duplicated and capped. An empty
 * array means the canonical schema accepts it. This never throws: a malformed
 * input is a rejection, not a crash (acceptance rule §4 case 12).
 */
export function canonicalPolicyErrors(policy: unknown): string[] {
  try {
    const result = OrgPolicySchema.safeParse(policy);
    if (result.success) return [];
    return [...new Set(flatten(result.error.issues).map(describe))].slice(0, MAX_MESSAGES);
  } catch (error) {
    return [
      `(root) — the canonical policy schema could not evaluate this policy: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}
