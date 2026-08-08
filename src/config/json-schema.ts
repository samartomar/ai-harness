import { type ZodTypeAny, z } from "zod";
import { PolicyAuthorityReceiptSchema } from "../org-policy/authority.js";
import {
  enterpriseSupportedClisJsonSchemaConstraint,
  OrgPolicySchema,
} from "../org-policy/schema.js";
import { AihConfigSchema } from "./marker.js";

export interface GeneratedConfigSchema {
  path: string;
  schema: Record<string, unknown>;
}

function schemaFor(title: string, schema: ZodTypeAny): Record<string, unknown> {
  return { ...z.toJSONSchema(schema, { io: "input" }), title };
}

export function generatedConfigSchemas(): GeneratedConfigSchema[] {
  return [
    {
      path: "schemas/aih-config.schema.json",
      schema: schemaFor(".aih-config.json", AihConfigSchema),
    },
    {
      path: "schemas/aih-org-policy.schema.json",
      schema: {
        ...schemaFor("aih-org-policy.json", OrgPolicySchema),
        allOf: [enterpriseSupportedClisJsonSchemaConstraint()],
      },
    },
    {
      path: "schemas/aih-policy-authority-receipt.schema.json",
      schema: schemaFor(".aih/policy-authority-receipt.json", PolicyAuthorityReceiptSchema),
    },
  ];
}
