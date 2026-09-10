import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorProtectedPolicyViaChromium } from './author-protected-policy-chromium.mjs';
import { regularBytes, sha256 } from './bytes.mjs';

export function readCandidateQualification(candidateRoot, receipt4) {
  const bytes = regularBytes(join(candidateRoot, 'unsigned-candidate-seq4.json'));
  assert.equal(sha256(bytes), 'sha256:6423cf2a8795d5d76ca481bc6718de8425245f99701514a63e7dc415a25184d2', 'reviewed owner candidate changed');
  const candidate = JSON.parse(bytes), entry = candidate.entries.find(row => row.entryId === 'package.picocolors');
  assert(entry && candidate.sequence === 4);
  assert.equal(`sha256:${candidate.catalogHeadSha256}`, receipt4.catalogContinuity.catalogHeadDigest);
  assert.equal(`sha256:${candidate.catalogSha256}`, receipt4.qualificationBasis.catalogDigest);
  assert.equal(`sha256:${entry.memberSha256}`, receipt4.qualificationBasis.catalogMemberDigest);
  assert.deepEqual(entry.subject, receipt4.subject);
  assert.deepEqual(entry.qualification.findings, []); assert.equal(entry.qualification.gaps.length, 9);
  const root = join(candidateRoot, 'defaults', 'workbench', 'npm', 'package.picocolors');
  const evidence = item => {
    assert(/^evidence:(?:gap|report|right):evidence\/[a-z0-9.-]+\.json$/u.test(item.identity));
    const path = join(root, item.identity.split(':').at(-1)), input = regularBytes(path);
    assert.equal(sha256(input), `sha256:${item.sha256}`, 'candidate evidence byte mismatch');
    const value = JSON.parse(input); assert.equal(value.subjectDigest, entry.subject.subjectDigest);
    return { path, sha256: sha256(input), value };
  };
  const gaps = entry.qualification.gaps.map(evidence);
  const report = evidence(entry.qualification.report), rights = entry.qualification.rights.map(evidence);
  assert.equal(new Set(gaps.map(row => row.value.id)).size, 9);
  return { entry, gaps, report, rights };
}

export function decisionDispositionForSequence(sequence) {
  assert(Number.isInteger(sequence) && sequence >= 0 && sequence <= 4, 'public sequence must be 0 through 4');
  return sequence === 4 ? 'accepted-with-conditions' : 'approved';
}

export function prepareDecisionFields({ records, qualification, operator, issuedAt, expiresAt, targetRoot, adminRoot }) {
  const policy = {
    format: 'aih-local-supported-npm-acceptance-policy/v1', operator,
    attribution: 'Current local Git identity; self-asserted task attribution, without verification of an organization role.',
    targetRoot, issuedAt, expiresAt,
    scope: 'Disposable picocolors 1.1.1 npm observation and lifecycle acceptance; installation uses npm with scripts disabled. Prior profile decisions permit custody continuity only.',
    limits: 'The scan remains missing/warn with native-only evidence. No scan pass, runtime safety, package execution, release acceptance, or public organization authority is asserted.',
    acceptedGaps: qualification.gaps.map(row => ({ id: row.value.id, sha256: row.sha256, summary: row.value.summary })),
    publicReceipts: records.map(row => ({ sequence: row.sequence, sourceSha: row.sourceSha, sha256: row.sha256 })),
  };
  const control = { format: 'aih-local-supported-npm-acceptance-control/v1', targetRoot,
    conditions: ['Use only the exact attested picocolors 1.1.1 package integrity in this disposable target.', 'Keep npm install scripts disabled; do not execute package code.', 'Accept the nine documented static coverage gaps only for observer and lifecycle validation.', 'Revoke the package decision after the observed lifecycle and verify that effective policy becomes blocked.'],
    reviewBy: expiresAt, owner: operator.actor };
  const policyBytes = Buffer.from(JSON.stringify(policy, null, 2) + '\n'), controlBytes = Buffer.from(JSON.stringify(control, null, 2) + '\n');
  writeFileSync(join(adminRoot, 'local-policy.json'), policyBytes, { flag: 'wx' });
  writeFileSync(join(adminRoot, 'local-control.json'), controlBytes, { flag: 'wx' });
  const fields = records.map(({ receipt, sequence, sha256: receiptHash }) => ({
    'protected-actor': operator.actor, 'protected-attestor': operator.attestor,
    'protected-disposition': decisionDispositionForSequence(sequence),
    'protected-accepted-findings': '', 'protected-accepted-gaps': sequence === 4 ? policy.acceptedGaps.map(gap => gap.id).join(',') : '',
    ...(sequence === 4 ? { 'protected-conditions': control.conditions.join('\n'), 'protected-review-by': expiresAt } : {}),
    'protected-control-id': 'local-supported-npm-control', 'protected-control-digest': sha256(controlBytes),
    'protected-policy-id': 'local-supported-npm-policy', 'protected-policy-version': '2026.09', 'protected-policy-digest': sha256(policyBytes),
    'protected-decision-id': `local-supported-seq-${sequence}`, 'protected-effects': sequence === 4 ? 'install' : 'use',
    'protected-evidence-id': `public-receipt-seq-${sequence}`, 'protected-evidence-digest': receiptHash,
    'protected-kind': receipt.subject.kind, 'protected-subject-id': receipt.subject.id,
    'protected-qualification-kind': 'aih-supported', 'protected-catalog-digest': receipt.qualificationBasis.catalogDigest,
    'protected-catalog-head-digest': receipt.qualificationBasis.catalogHeadDigest,
    'protected-catalog-member-digest': receipt.qualificationBasis.catalogMemberDigest,
    'protected-catalog-signer': receipt.qualificationBasis.catalogSignerIdentity, 'protected-targets': 'codex',
    'protected-reason': sequence === 4 ? 'Local operator accepts the nine byte-bound scan coverage gaps for scripts-disabled npm observation and lifecycle validation only.' : 'Accept custody of this exact public profile receipt to establish the original Catalog head lineage; do not execute profile effects.',
    'protected-source-type': receipt.subject.source.type,
    ...Object.fromEntries(Object.entries(receipt.subject.source).filter(([key]) => key !== 'type').map(([key,value]) => [`protected-source-${key}`, value])),
  }));
  return { fields, policy, control, policySha256: sha256(policyBytes), controlSha256: sha256(controlBytes) };
}

export async function authorAndCheck({ core, htmlPath, adminRoot, evidenceRoot, records, operator, issuedAt, expiresAt, intended, revokedDigest }) {
  const suffix = revokedDigest ? 'revoked' : 'active';
  const result = await authorProtectedPolicyViaChromium({ htmlPath,
    outputPath: join(adminRoot, `policy-${suffix}.json`), reportPath: join(evidenceRoot, `chromium-${suffix}.json`), screenshotPath: join(evidenceRoot, `conditions-${suffix}.png`),
    authorityFields: { 'protected-bundle-version': `2026.09.848.${suffix}`, 'protected-issued-at': issuedAt, 'protected-expires-at': expiresAt, 'protected-issuer': operator.attestor, 'protected-issuer-repository': `${operator.attestor}/local-supported-npm` },
    decisions: intended.fields, revokeDecisionIndexes: revokedDigest ? [4] : [], expectedRevocationDecisionDigests: revokedDigest ? [revokedDigest] : [],
  });
  assert(core.parsePolicyBundle(result.bundle).ok, 'actual downloaded policy parser refused');
  const decisions = result.bundle.authorityReceipt.decisions; assert.equal(decisions.length, records.length);
  for (const [i, decision] of decisions.entries()) {
    const { receipt, sha256: receiptHash } = records[i], field = intended.fields[i];
    assert.equal(decision.id, field['protected-decision-id']); assert.equal(decision.actor, operator.actor); assert.equal(decision.issuer, operator.attestor);
    assert.equal(decision.subject.kind, receipt.subject.kind); assert.equal(decision.subject.id, receipt.subject.id); assert.deepEqual(decision.subject.source, receipt.subject.source);
    assert.deepEqual(decision.qualificationBasis, receipt.qualificationBasis); assert.equal(decision.evidence.digest, receiptHash);
    assert.equal(decision.policy.digest, intended.policySha256); assert.equal(decision.control.digest, intended.controlSha256);
    assert.deepEqual(decision.allowedEffects, [i === 4 ? 'install' : 'use']); assert.deepEqual(decision.targets, ['codex']);
    assert.equal(decision.disposition, field['protected-disposition']); assert.deepEqual(decision.acceptedFindings, []);
    assert.deepEqual(decision.acceptedGaps, i === 4 ? intended.policy.acceptedGaps.map(gap => gap.id) : []);
    assert.deepEqual(decision.conditions, i === 4 ? intended.control.conditions : []);
    if (i === 4) assert.equal(decision.reviewBy, expiresAt);
    assert.equal(decision.issuedAt, issuedAt); assert.equal(decision.notBefore, issuedAt); assert.equal(decision.expiresAt, expiresAt);
  }
  const digest = core.governanceDecisionDigestV2(decisions[4]);
  if (revokedDigest) assert.equal(digest, revokedDigest, 'revocation must preserve original decision bytes');
  return { ...result, decisions, packageDecisionDigest: digest };
}
