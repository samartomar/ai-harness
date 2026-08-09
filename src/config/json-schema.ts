import { type ZodTypeAny, z } from "zod";
import { PackageGraphSchema } from "../capability/package-graph/schema.js";
import { CapabilityPackageManifestSchema } from "../capability/package-manager/schema.js";
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
    {
      path: "schemas/aih-package-graph.schema.json",
      schema: {
        ...schemaFor("aih-package-graph.schema.json", PackageGraphSchema),
        $comment:
          "This JSON Schema validates the portable editor structure. Use PackageGraphSchema.parse for semantic invariants including identity uniqueness, direct-member resolution, and evidence subject-digest binding.",
      },
    },
    {
      path: "schemas/aih-capability-package-manifest.schema.json",
      schema: {
        ...schemaFor(
          "aih-capability-package-manifest.schema.json",
          CapabilityPackageManifestSchema,
        ),
        $comment:
          "This JSON Schema validates the portable editor structure. Use CapabilityPackageManifestSchema.parse for semantic invariants including identity uniqueness and total direct-reference bounds, then resolveCapabilityPackages for exact Package Graph authority, claim, source, membership, dependency, and conflict validation.",
      },
    },
  ];
}
