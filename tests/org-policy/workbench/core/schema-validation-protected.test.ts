import { expect, it } from "vitest";
import { z } from "zod";
import { PolicyBundleSchema } from "../../../../src/org-policy/schema.js";
import { policySchemaErrors } from "../../../../src/org-policy/workbench/schema-validation.js";

const protectedBundle = {
  schemaVersion: 2,
  bundleVersion: "2026.09",
  issuer: "platform-team",
  issuedAt: "2026-09-04T23:00:00Z",
  policy: {
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "2026.09",
      catalog: { reviewed: [], custom: [] },
      supportedClis: ["claude"],
    },
  },
  authorityReceipt: {
    format: "aih-policy-authority-receipt",
    version: 3,
    issuerRepository: "acme/governance",
    issuedAt: "2026-09-04T23:00:00Z",
    expiresAt: "2026-09-11T23:00:00Z",
    trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
    targets: ["claude"],
    decisions: [],
    decisionRevocations: [],
  },
} as const;

it("validates generated protected PolicyBundle schema date-time fields", () => {
  const schema = z.toJSONSchema(PolicyBundleSchema, { io: "input" });
  expect(policySchemaErrors(schema, protectedBundle, "bundle")).toEqual([]);

  const protectedVariant = ((schema as { oneOf?: unknown[] }).oneOf ?? []).find((candidate) =>
    JSON.stringify(candidate).includes("authorityReceipt"),
  );
  if (!protectedVariant) throw new Error("expected emitted protected PolicyBundle variant");

  expect(
    policySchemaErrors(protectedVariant, { ...protectedBundle, issuedAt: "not-a-date" }, "bundle"),
  ).toContain("bundle.issuedAt: has an invalid date-time");
});
