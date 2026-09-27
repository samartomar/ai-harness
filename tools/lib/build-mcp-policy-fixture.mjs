/**
 * Disposable test and cold-proof fixture builder, not production authority
 * authoring. Confirms that the caller's exact governed MCP policy already
 * activates exactly the requested reviewed servers on exactly the requested
 * targets. It never adds a control, evidence, approval, qualification, or
 * signer claim; validation uses only the caller-supplied public Core module.
 */

// Core publishes no bare org-policy parser at its root. This throwaway V1
// envelope exists only so parsePolicyBundle validates the policy; it is never
// returned or written.
const VALIDATION_ONLY_ENVELOPE = Object.freeze({
  schemaVersion: 1,
  bundleVersion: "validation-only",
  issuer: "validation-only",
  issuedAt: "1970-01-01T00:00:00Z",
});

function exactSet(values, label) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => typeof value !== "string" || value === "") ||
    new Set(values).size !== values.length
  )
    throw new Error(`mcp-fixture-${label}-invalid`);
  return JSON.stringify([...values].sort());
}

export function buildMcpPolicyFixture({ core, basePolicy, targets, servers, authorityReceipt }) {
  if (
    typeof core?.parsePolicyBundle !== "function" ||
    typeof core?.PolicyAuthorityReceiptV3Schema?.safeParse !== "function"
  )
    throw new Error("mcp-fixture-public-core-api-missing");
  const wantedTargets = exactSet(targets, "targets");
  const wantedServers = exactSet(servers, "servers");
  if (basePolicy === null || typeof basePolicy !== "object" || Array.isArray(basePolicy))
    throw new Error("mcp-fixture-base-policy-invalid");
  const policy = JSON.parse(JSON.stringify(basePolicy));

  let result;
  if (authorityReceipt === undefined) {
    const parsed = core.parsePolicyBundle({ ...VALIDATION_ONLY_ENVELOPE, policy });
    if (!parsed.ok) throw new Error(`mcp-fixture-policy-invalid:${parsed.error}`);
    result = policy;
  } else {
    const receipt = core.PolicyAuthorityReceiptV3Schema.safeParse(authorityReceipt);
    if (!receipt.success)
      throw new Error(`mcp-fixture-authority-receipt-invalid:${receipt.error.message}`);
    if (exactSet(authorityReceipt.targets, "receipt-targets") !== wantedTargets)
      throw new Error("mcp-fixture-receipt-target-mismatch");
    // Envelope labels are copied from caller input; the receipt carries authority.
    result = JSON.parse(
      JSON.stringify({
        schemaVersion: 2,
        bundleVersion: policy.governance?.policyVersion,
        issuer: authorityReceipt.issuerRepository,
        issuedAt: authorityReceipt.issuedAt,
        policy,
        authorityReceipt,
      }),
    );
    const parsed = core.parsePolicyBundle(result);
    if (!parsed.ok) throw new Error(`mcp-fixture-bundle-invalid:${parsed.error}`);
  }

  if (policy.minimumPosture !== "enterprise") throw new Error("mcp-fixture-policy-posture");
  const governance = policy.governance ?? {};
  const reviewed = governance.catalog?.reviewed ?? [];
  const candidates = [...reviewed, ...(governance.catalog?.custom ?? [])];
  const activations = governance.activations ?? [];
  if (
    JSON.stringify(candidates.map((candidate) => candidate.id).sort()) !== wantedServers ||
    JSON.stringify(activations.map((activation) => activation.candidate).sort()) !== wantedServers
  )
    throw new Error("mcp-fixture-server-selection-mismatch");
  for (const server of servers) {
    const control = reviewed.find((item) => item.id === server);
    const activation = activations.find((item) => item.candidate === server);
    if (
      control?.kind !== "mcp" ||
      activation?.state !== "active" ||
      JSON.stringify([...activation.targets].sort()) !== wantedTargets
    )
      throw new Error(`mcp-fixture-target-selection-mismatch:${server}`);
  }
  return result;
}
