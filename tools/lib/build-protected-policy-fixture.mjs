import { writeFileSync } from "node:fs";

/**
 * Disposable test and cold-proof fixture builder, not production authority
 * authoring. Wraps the caller's exact policy and exact Decision V2 authority
 * receipt in a PolicyBundle V2, validates the exact serialized bytes with the
 * caller-supplied installed public Core module, and only then writes them.
 */
export function buildProtectedPolicyFixture({
  core,
  basePolicy,
  outputPath,
  bundleVersion,
  issuer,
  authorityReceipt,
}) {
  if (
    typeof core?.parsePolicyBundle !== "function" ||
    typeof core?.PolicyAuthorityReceiptV3Schema?.safeParse !== "function"
  )
    throw new Error("protected-fixture-public-core-api-missing");
  if (typeof outputPath !== "string" || outputPath === "")
    throw new Error("protected-fixture-output-path-missing");
  const receipt = core.PolicyAuthorityReceiptV3Schema.safeParse(authorityReceipt);
  if (!receipt.success)
    throw new Error(`protected-fixture-authority-receipt-invalid:${receipt.error.message}`);
  const text = `${JSON.stringify(
    {
      schemaVersion: 2,
      bundleVersion,
      issuer,
      issuedAt: authorityReceipt.issuedAt,
      policy: basePolicy,
      authorityReceipt,
    },
    null,
    2,
  )}\n`;
  const bundle = JSON.parse(text);
  const parsed = core.parsePolicyBundle(bundle);
  if (!parsed.ok) throw new Error(`protected-fixture-bundle-invalid:${parsed.error}`);
  writeFileSync(outputPath, text);
  return bundle;
}
