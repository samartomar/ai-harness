import {nativeTool,hostedPaths} from './hosted-paths.mjs';
import {assertAuthorized,recheck} from './release-authority.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareInstalledTarball, inventory, regularBytes, sha256 } from './bytes.mjs';
import { npmSource, readPublicReceiptInputs, repository, verifyPublicReceiptAttestations, workflow } from './public-receipt-inputs.mjs';
import { authorAndCheck, prepareDecisionFields, readCandidateQualification } from './policy-authoring.mjs';
import { supportedAcceptArguments, supportedInspectArguments } from './custody-arguments.mjs';

export async function run848(context) {
assertAuthorized(context);
const repo = resolve(import.meta.dirname, '..', '..');
const originalCoreSha256 = context.binding.core.tarballSha256;
const npmTarballSha256 = 'sha256:d3aedb2807967b7eb37fd11b03b7e3701e725af79c650d0812ff7213f8f882d9';
const candidateRoot = hostedPaths().candidate;
const custodyRoot = process.platform === 'win32' ? 'C:/ProgramData/aih/supported-qualification/v2' : process.platform === 'darwin' ? '/Library/Application Support/aih/supported-qualification/v2' : '/etc/aih/supported-qualification/v2';
const command = (file, args, options = {}) => {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...options });
  assert(!result.error && result.status !== null, 'command could not finish'); return result;
};
const success = (file, args, options) => { const result = command(file, args, options); assert.equal(result.status, 0, `command failed: ${basename(file)}`); return result; };
const dataOf = result => { assert(Array.isArray(result.digests) && result.digests.length === 1, 'one result digest required'); return result.digests[0].data; };
const assertSubset = (value, expected) => { for (const [key, field] of Object.entries(expected)) assert.deepEqual(value[key], field, `unexpected result ${key}`); };

/** Read-only local input validation. Missing public sequence 4 cannot become a local test receipt. */
async function preflight(input) {
  assert.equal(process.platform, 'win32', 'this reviewed runner requires a disposable Windows administrator host');
  assert(input && Object.getPrototypeOf(input) === Object.prototype, 'inputs object required');
  const keys = ['coreTarball', 'corePackageRoot', 'seq4Receipt', 'seq4SourceSha', 'npmCli'];
  assert.deepEqual(Object.keys(input).sort(), keys.sort(), 'exact runner input keys required');
  for (const key of keys.filter(key => key !== 'seq4SourceSha')) assert(typeof input[key] === 'string' && isAbsolute(input[key]), `absolute ${key} required`);
  assert(/^[a-f0-9]{40}$/u.test(input.seq4SourceSha ?? '') && !/^0+$/u.test(input.seq4SourceSha), 'real protected source commit required');
  const coreBytes = compareInstalledTarball(input.coreTarball, input.corePackageRoot, originalCoreSha256);
  assert.equal(coreBytes.fileCount, context.binding.core.fileCount, 'verified public installed file count');
  const manifest = JSON.parse(regularBytes(join(input.corePackageRoot, 'package.json')));
  assert.equal(manifest.name, '@aihq/core'); assert.equal(manifest.version, '0.6.1');
  const installedNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert.equal(realpathSync.native(input.npmCli), realpathSync.native(installedNpmCli), 'runner requires npm from the installed Node runtime');
  regularBytes(input.npmCli);
  const core = await import(pathToFileURL(join(input.corePackageRoot, 'dist', 'index.js')).href);
  const records = readPublicReceiptInputs({ core, seq4Path: input.seq4Receipt, seq4SourceSha: input.seq4SourceSha, root: hostedPaths().receipts });
  const qualification = readCandidateQualification(candidateRoot, records[4].receipt);
  const now = Date.now();
  for (const { receipt } of records) assert(Date.parse(receipt.notBefore) <= now && now < Date.parse(receipt.expiresAt), 'receipt must be current');
  const git = key => success('git', ['config', '--get', key], { cwd: repo }).stdout.trim();
  const name = git('user.name'), actor = git('user.email');
  const attestor = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(actor) && /^[a-z][a-z0-9-]{0,63}$/u.test(attestor), 'actual local operator identity required');
  const ghPath = nativeTool('gh'); assert(lstatSync(ghPath).isFile(), 'native GitHub CLI required');
  assert(success(ghPath, ['--version']).stdout.startsWith('gh version '), 'native GitHub CLI unavailable');
  const npmVersion = success(process.execPath, [input.npmCli, '--version']).stdout.trim();
  assert(/^\d+\.\d+\.\d+$/u.test(npmVersion), 'npm version unavailable');
  return { core, coreBytes, manifest, records, qualification, operator: { name, actor, attestor }, ghPath, npmVersion };
}

async function executeAcceptance(input, checked) {
  // Protected custody has a fixed production location. This driver only runs on a fresh disposable administrator host.
  assert(!existsSync(custodyRoot), 'protected custody already exists; preserve it and use a clean disposable host');
  verifyPublicReceiptAttestations(checked.records, checked.ghPath);
  compareInstalledTarball(input.coreTarball, input.corePackageRoot, originalCoreSha256);
  assert(!existsSync(custodyRoot), 'protected custody appeared during preflight');
  const root = mkdtempSync(join(context.evidenceRoot, 'aih-848-supported-npm-'));
  const targetRoot = join(root, 'target'), adminRoot = join(root, 'admin'), evidenceRoot = join(root, 'evidence');
  for (const path of [targetRoot, adminRoot, evidenceRoot]) mkdirSync(path);
  const operations = [];
  const env = { ...process.env, AIH_SUPPORTED_QUALIFICATION_REPOSITORY: repository, AIH_SUPPORTED_QUALIFICATION_WORKFLOW: workflow };
  delete env.AIH_ORG_POLICY;
  const run = (label, args, { cwd = targetRoot, refused = false, parse = true } = {}) => {
    const result = command(process.execPath, [join(input.corePackageRoot, 'dist', 'cli.js'), ...args, '--posture', 'enterprise'], { cwd, env });
    writeFileSync(join(evidenceRoot, `${label}.json`), JSON.stringify({ args, exitCode: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2) + '\n', { flag: 'wx' });
    assert(refused ? result.status !== 0 : result.status === 0, `unexpected exit: ${label}`);
    const value = parse ? JSON.parse(result.stdout) : undefined;
    operations.push({ label, args, exitCode: result.status, ...(value ? { result: value } : {}) }); return value;
  };
  const snap = () => ({ target: inventory(targetRoot), custody: inventory(custodyRoot) });
  const zeroWrite = (label, operation) => {
    const before = snap(), result = operation(), after = snap(); assert.deepEqual(after, before, `${label} changed target or custody`);
    writeFileSync(join(evidenceRoot, `${label}-inventory.json`), JSON.stringify({ before, after }) + '\n', { flag: 'wx' }); return result;
  };
  const npm = (label, args, cwd = targetRoot) => {
    const result = command(process.execPath, [input.npmCli, ...args], { cwd });
    writeFileSync(join(evidenceRoot, `${label}.json`), JSON.stringify({ args, exitCode: result.status, stdout: result.stdout, stderr: result.stderr }) + '\n', { flag: 'wx' });
    assert.equal(result.status, 0, label); return result;
  };
  writeFileSync(join(targetRoot, 'package.json'), '{"name":"aih-848-disposable-target","version":"1.0.0","private":true}\n', { flag: 'wx' });
  npm('npm-install', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry', npmSource.registry, `${npmSource.package}@${npmSource.version}`]);
  const packed = JSON.parse(npm('npm-pack', ['pack', `${npmSource.package}@${npmSource.version}`, '--ignore-scripts', '--json', '--registry', npmSource.registry, '--pack-destination', evidenceRoot], adminRoot).stdout);
  assert.equal(packed.length, 1); assert.equal(packed[0].filename, 'picocolors-1.1.1.tgz');
  const tarballPath = join(evidenceRoot, packed[0].filename), compressed = regularBytes(tarballPath);
  assert.equal(`sha512-${createHash('sha512').update(compressed).digest('base64')}`, npmSource.integrity);
  const packageBytes = compareInstalledTarball(tarballPath, join(targetRoot, 'node_modules', 'picocolors'), npmTarballSha256); assert.equal(packageBytes.fileCount, 7);
  const lock = JSON.parse(regularBytes(join(targetRoot, 'package-lock.json'))), installed = lock.packages['node_modules/picocolors'];
  assert.equal(installed.version, npmSource.version); assert.equal(installed.integrity, npmSource.integrity);
  assert.equal(installed.resolved, 'https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz');
  const htmlPath = join(adminRoot, 'aih-policy-workbench.html');
  run('generate-workbench', ['policy', 'generate', '--apply', '--out', htmlPath, '--no-log'], { cwd: adminRoot, parse: false });
  const issuedAt = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const expiresAt = new Date(Math.min(Date.parse(issuedAt) + 86400000, ...checked.records.map(row => Date.parse(row.receipt.expiresAt)))).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  assert(Date.parse(expiresAt) - Date.parse(issuedAt) > 3600000, 'one hour of valid authority required');
  const intended = prepareDecisionFields({ ...checked, issuedAt, expiresAt, targetRoot, adminRoot });
  const authorArgs = { ...checked, intended, issuedAt, expiresAt, htmlPath, adminRoot, evidenceRoot };
  const active = await authorAndCheck(authorArgs); env.AIH_ORG_POLICY = active.report.download.path;
  mkdirSync(join(targetRoot, '.aih'));
  const acceptArguments = index => supportedAcceptArguments(targetRoot, active.decisions[index].id, checked.core.governanceDecisionDigestV2(active.decisions[index]));
  for (const [index, record] of checked.records.entries()) {
    assert(regularBytes(record.path, 5970).equals(record.bytes), 'original receipt changed before consumption');
    writeFileSync(join(targetRoot, '.aih', 'aih-supported-qualification-receipt.json'), record.bytes);
    const accept = acceptArguments(index);
    const preview = zeroWrite(`seq${index}-preview`, () => run(`seq${index}-preview`, accept)); assert.equal(preview.applied, false);
    const applied = run(`seq${index}-apply`, [...accept, '--apply']); assert.equal(applied.applied, true);
    const custody = dataOf(run(`seq${index}-inspect`, supportedInspectArguments(targetRoot)));
    assert.equal(custody.memberRecords.occupied, index + 1); assert.equal(custody.members.length, 1);
    assertSubset(custody.members[0], { entryId: record.receipt.entryId, target: 'codex', decision: { id: active.decisions[index].id, digest: checked.core.governanceDecisionDigestV2(active.decisions[index]) } });
    assertSubset(custody.members[0].subject, { kind: record.receipt.subject.kind, id: record.receipt.subject.id, digest: record.receipt.subject.subjectDigest });
    assert(!existsSync(join(targetRoot, '.aih', 'supported-qualification', 'v2')), 'unexpected target-local custody');
  }
  zeroWrite('supported-head-repeat', () => run('supported-head-repeat', [...acceptArguments(4), '--apply']));
  const packageArgs = ['--decision', active.decisions[4].id, '--decision-digest', active.packageDecisionDigest, '--target', 'codex', '--json', '--no-log'];
  const observe = () => ['policy', 'observe', 'npm-package', targetRoot, ...packageArgs];
  const lifecycle = apply => ['policy', 'lifecycle', 'npm-package', targetRoot, ...packageArgs, ...(apply ? ['--apply'] : [])];
  const observed = zeroWrite('npm-observe', () => run('npm-observe', observe()));
  assertSubset(dataOf(observed), { authority: 'verified', qualification: 'aih-supported', effective: 'observed-effective', outcome: 'observed-effective' });
  const preview = zeroWrite('npm-lifecycle-preview', () => run('npm-lifecycle-preview', lifecycle(false)));
  assertSubset(dataOf(preview), { applied: false, outcome: 'reported-only', state: 'observed-effective' });
  const applied = run('npm-lifecycle-apply', lifecycle(true)); assertSubset(dataOf(applied), { applied: true, outcome: 'fulfilled', state: 'observed-effective' });
  const repeated = run('npm-lifecycle-repeat', lifecycle(true)); assertSubset(dataOf(repeated), { applied: true, outcome: 'fulfilled', state: 'observed-effective' });
  // An observation is time-bound; repeating a lifecycle may retain a successor record. Only supported-head repeat claims zero writes.
  const effective = dataOf(run('effective-before-revocation', ['policy', 'evaluate', targetRoot, '--cli', 'codex', '--json', '--no-log']));
  assert.equal(effective.blocking, false); assert(effective.npmPackageLifecycle.some(row => row.decision.digest === active.packageDecisionDigest && row.state === 'observed-effective'));
  const revoked = await authorAndCheck({ ...authorArgs, revokedDigest: active.packageDecisionDigest });
  assert.notEqual(revoked.report.download.sha256, active.report.download.sha256); env.AIH_ORG_POLICY = revoked.report.download.path;
  const revoke = run('npm-lifecycle-revoke', lifecycle(true), { refused: true });
  assertSubset(dataOf(revoke), { applied: true, outcome: 'fulfilled', state: 'decision-revoked', reason: 'decision-revoked' });
  const evaluated = dataOf(run('effective-after-revocation', ['policy', 'evaluate', targetRoot, '--cli', 'codex', '--json', '--no-log'], { refused: true }));
  assert.equal(evaluated.blocking, true);
  assert(evaluated.npmPackageLifecycle.some(row => row.decision.id === active.decisions[4].id && row.decision.digest === active.packageDecisionDigest && row.reason === 'decision-revoked' && row.state === 'revoked'));
  compareInstalledTarball(input.coreTarball, input.corePackageRoot, originalCoreSha256);
  compareInstalledTarball(tarballPath, join(targetRoot, 'node_modules', 'picocolors'), npmTarballSha256);
  await recheck(context);
  const report = { publicRelease: {qualificationSha256:context.input.qualificationSha256,registryIntegrity:context.binding.registryIntegrity}, format: 'aih-supported-npm-actual-acceptance/v1', status: 'passed', root, custodyRoot, operator: checked.operator,
    scope: 'Actual local installed candidate acceptance. Public Core0.6.1 bytes independently verified against registry and qualification. No public organization authority or package execution claim.',
    core: checked.coreBytes, npm: { source: npmSource, version: checked.npmVersion, ...packageBytes },
    qualification: { state: 'missing', verdict: 'warn', acceptedGaps: intended.policy.acceptedGaps },
    publicReceipts: checked.records.map(({ bytes, receipt, ...row }) => ({ ...row, receipt, attestationSha256: sha256(Buffer.from(JSON.stringify(row.attestation))) })),
    authority: { active: active.report, revoked: revoked.report, policySha256: intended.policySha256, controlSha256: intended.controlSha256 }, operations, finalInventory: snap() };
  const reportPath = join(evidenceRoot, 'actual-848-report.json'); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`SUPPORTED_NPM_ACCEPTANCE_PASS ${reportPath}`); return report;
}

const input={coreTarball:context.input.coreTarball,corePackageRoot:context.input.corePackageRoot,seq4Receipt:context.input.seq4Receipt,seq4SourceSha:context.input.seq4SourceSha,npmCli:context.npmCli};
const checked=await preflight(input);
await executeAcceptance(input,checked);
}
