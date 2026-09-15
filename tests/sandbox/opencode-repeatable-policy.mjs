// Public fictional fixture data only. No credentials or organization attestation.
// Run with the repository's tsx runtime, or bundle this fixture before Linux use.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { aihPolicyControls } from "../../src/org-policy/catalog.js";
import { PolicyBundleSchema } from "../../src/org-policy/schema.js";

export function createOpenCodeFixturePolicies(directory, now = new Date()) {
  if (!isAbsolute(directory)) throw new Error("fixture policy directory must be absolute");
  const control = aihPolicyControls().find((item) => item.id === "sequential-thinking");
  if (control === undefined) throw new Error("shipped sequential-thinking control is unavailable");
  const issuedAt = new Date(now.getTime() - 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + 86_400_000).toISOString();
  const approved = PolicyBundleSchema.parse({
    schemaVersion: 2,
    bundleVersion: "fictional-opencode-repeatable-v1",
    issuer: "Fictional disposable project operator",
    issuedAt,
    policy: {
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      mcp: { allowManagedOnly: true },
      governance: {
        policyVersion: "fictional-opencode-repeatable-v1",
        supportedClis: ["opencode"],
        catalog: {
          reviewed: [{
            ...control,
            description: "Fictional operator selects the exact shipped local reasoning tool",
            capabilities: ["Local structured thought operation"],
            risks: [],
            evidence: { record: "aih-shipped-control" },
          }],
          custom: [],
        },
        activations: [{ candidate: control.id, state: "active", targets: ["opencode"] }],
      },
    },
    authorityReceipt: {
      format: "aih-policy-authority-receipt",
      version: 3,
      issuerRepository: "fictional-example/governance",
      issuedAt,
      expiresAt,
      targets: ["opencode"],
      trustedIssuers: [{ id: "fictional-operator", githubRepository: "fictional-example/governance" }],
      decisions: [],
      decisionRevocations: [],
    },
  });
  const blocked = structuredClone(approved);
  blocked.policy.governance.catalog.reviewed[0].source.subject =
    `mcp-server-sha256:${"0".repeat(64)}`;
  PolicyBundleSchema.parse(blocked);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = {};
  for (const [label, bundle] of [["approved", approved], ["blocked", blocked]]) {
    const path = join(directory, `${label}-policy.json`);
    const bytes = `${JSON.stringify(bundle, null, 2)}\n`;
    writeFileSync(path, bytes, { flag: "wx", mode: 0o400 });
    result[label] = { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  return {
    ...result,
    expiresAt,
    scope: "Protected-file fixture authority and shipped control identity; no external attestation or real organization.",
    decisionScope: "The shipped clean control needs no waiver decision; CLI evaluation must resolve current shipped evidence and the explicit activation.",
  };
}

if (process.argv[2] === "--out" && process.argv.length === 4) {
  process.stdout.write(`${JSON.stringify(createOpenCodeFixturePolicies(process.argv[3]), null, 2)}\n`);
}
