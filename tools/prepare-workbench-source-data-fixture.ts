import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalStrictJsonBytesV1, canonicalStrictJsonSha256V1 } from "../src/contract/strict-json-v1.js";
import { extractWorkbenchSourceDataV1, WorkbenchSourceDataPayloadV1Schema } from "../src/org-policy/workbench/core/source-data.js";
import { packagedPreparedWorkbenchCatalogV1 } from "../src/org-policy/workbench/prepared-catalog.js";

const directory = process.argv[2];
if (!directory) throw new Error("Fixture directory required");
mkdirSync(join(directory, "store"), {recursive: true});
const key = generateKeyPairSync("ed25519");
const keyId = createHash("sha256").update(key.publicKey.export({format: "der", type: "spki"})).digest("hex");
const write = (name: string, value: unknown) => writeFileSync(join(directory, name), canonicalStrictJsonBytesV1(value), {flag: "wx", mode: 0o600});
writeFileSync(join(directory, "fixture-key.pem"), key.privateKey.export({format: "pem", type: "pkcs8"}), {flag: "wx", mode: 0o600});
write("store/trust.json", {version: 1, authorities: [{keyId, publicKeyPem: key.publicKey.export({format: "pem", type: "spki"}).toString(), role: "workbench-source-data/v1", sources: ["source:mattpocock"]}]});
const baseline = extractWorkbenchSourceDataV1(packagedPreparedWorkbenchCatalogV1().bundle, "source:mattpocock");
// This fixture transitions inventory identity, never fabricates scan/qualification for new bytes.
const updated = structuredClone(baseline);
const source = updated.sources["source:mattpocock"]!;
source.revision.id = "f".repeat(40);
source.revision.contentDigest = `sha256:${"f".repeat(64)}`;
for (const asset of Object.values(updated.assets)) { asset.sourceRevisionId = source.revision.id; asset.contentDigest = `sha256:${"e".repeat(64)}`; }
updated.evidence = {};
delete updated.qualifications;
updated.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({...updated, provenance: {}})}`;
write("source-one.json", baseline);
write("source-two.json", updated);
// Prepare/sign command behavior is covered by data-command.test.ts. The packed
// journey retains the two real installed imports and verifies their chain.
const issuedAt = new Date().toISOString();
let previousDigest: string | null = null;
for (const [index, sourceBundle] of [baseline, updated].entries()) {
  const payload = WorkbenchSourceDataPayloadV1Schema.parse({
    version: "workbench-source-data/v1", compatibility: "core-workbench-data/v1",
    sequence: index + 1, previousDigest, issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 86_400_000).toISOString(), sourceBundle,
  });
  const envelope = {
    version: "signed-workbench-source-data/v1", keyId, payload,
    signature: sign(null, canonicalStrictJsonBytesV1(payload), key.privateKey).toString("base64"),
  };
  write(index === 0 ? "signed-one.json" : "signed-two.json", envelope);
  previousDigest = `sha256:${canonicalStrictJsonSha256V1(envelope)}`;
}
console.log("SOURCE_DATA_FIXTURES_PREPARED");
