import { z } from "zod";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import { WorkbenchOriginV1Schema } from "./workbench/contracts.js";

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
