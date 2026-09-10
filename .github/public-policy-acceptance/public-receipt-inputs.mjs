import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { regularBytes, sha256 } from './bytes.mjs';
export const repository = 'samartomar/aih-catalog';
export const workflow = `${repository}/.github/workflows/signed-catalog-v2.yml`;
export const seq4Head = 'sha256:28c46b424ae9627f0dc40a51ef7822caeb6333a4d75f962bf22ba0c7dc8d6935';
export const npmSource = Object.freeze({ type: 'npm', registry: 'https://registry.npmjs.org/', package: 'picocolors', version: '1.1.1', integrity: 'sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==' });
const prior = [
  ['ea64c29471f12fd5ac1de53a72cb6edd0fc0d142', 'f7eda39ab0fb03a602ef8c5cd090bbe142b2637b5f8a2c5eba9fef31d0e44e10'],
  ['5e18dd66e42f91c30e4c5acd81d41f1e33cd987a', 'b3da8cf6c43774726025d315f04915864fdc5227ae2c1a82e609ce930d0c2df0'],
  ['b019b4e9d6260915a49d177bcc22b58518305dd4', 'e64810a7bd39cf90986123cdf62a14f2eff9a6ce56285a3c91baf481f39d4f53'],
  ['0ce02656d5e281262af2177571033449f277dc46', '94784c497e240cc36d72d123c5ffbc1903f7e0ecfc02742233014a2a221aeb87'],
];
/** Strictly parse original receipts; this function does not confer public authority. */
export function readPublicReceiptInputs({ core, seq4Path, seq4SourceSha, root = resolve(import.meta.dirname, '..', 'public-profile-custody', 'public-receipts') }) {
  assert.equal(typeof core?.parseAihSupportedQualificationReceiptV2Bytes, 'function', 'Core receipt parser required');
  assert(/^[a-f0-9]{40}$/u.test(seq4SourceSha ?? ''), 'sequence4 protected source commit required');
  const inputs = prior.map(([sourceSha, digest], sequence) => ({ sequence, sourceSha, sha256: `sha256:${digest}`, path: sequence === 0 ? join(root, 'seq0', 'qualification-receipt-v2.json') : join(root, `seq${sequence}`, 'receipts', 'recipe.default.json') }));
  inputs.push({ sequence: 4, sourceSha: seq4SourceSha, path: seq4Path });
  let previous = `sha256:${'0'.repeat(64)}`, signer, key;
  return inputs.map(input => {
    const bytes = regularBytes(input.path, core.MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2);
    if (input.sha256) assert.equal(sha256(bytes), input.sha256, 'retained original receipt changed');
    const receipt = core.parseAihSupportedQualificationReceiptV2Bytes(bytes);
    assert(receipt, `invalid canonical receipt: seq${input.sequence}`);
    assert.equal(receipt.catalogContinuity.sequence, input.sequence);
    assert.equal(receipt.catalogContinuity.previousCatalogHeadDigest, previous);
    signer ??= receipt.qualificationBasis.catalogSignerIdentity; key ??= receipt.catalogContinuity.signerKeyId;
    assert.equal(receipt.qualificationBasis.catalogSignerIdentity, signer); assert.equal(receipt.catalogContinuity.signerKeyId, key);
    if (input.sequence < 4) { assert.equal(receipt.entryId, 'recipe.default'); assert.equal(receipt.subject.kind, 'profile'); }
    else { assert.equal(receipt.entryId, 'package.picocolors'); assert.equal(receipt.subject.kind, 'package'); assert.deepEqual(receipt.subject.source, npmSource); assert.equal(receipt.catalogContinuity.catalogHeadDigest, seq4Head); }
    previous = receipt.catalogContinuity.catalogHeadDigest;
    return { ...input, path: resolve(input.path), bytes, sha256: sha256(bytes), receipt };
  });
}
/** No injected verifier or local authority fallback. Verify exact original bytes again afterward. */
export function verifyPublicReceiptAttestations(records, ghPath) {
  for (const row of records) {
    const result = spawnSync(ghPath, ['attestation', 'verify', row.path, '--repo', repository, '--signer-workflow', workflow, '--source-digest', row.sourceSha, '--source-ref', 'refs/heads/main', '--deny-self-hosted-runners', '--format', 'json'], { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    assert(!result.error && result.status === 0, `public attestation refused seq${row.sequence}`);
    assert(regularBytes(row.path, 5970).equals(row.bytes), 'receipt changed during attestation');
    const parsed = JSON.parse(result.stdout); assert(Array.isArray(parsed) && parsed.length > 0, 'empty attestation verification');
    row.attestation = parsed;
  }
  return records;
}
