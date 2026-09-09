import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

const configuredRoot = process.env.AIH_PUBLIC_PROFILE_CUSTODY_ROOT;
if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")
  throw new Error("public-profile-custody-requires-isolated-hosted-linux");
if (configuredRoot === undefined || configuredRoot.trim() !== configuredRoot || configuredRoot === "")
  throw new Error("public-profile-custody-root-required");
const root = resolve(configuredRoot);
if (!existsSync(resolve(root, "package.json"))) throw new Error("public-profile-custody-root-invalid");
const proof = resolve(root, ".aih-scratch", "public-profile-custody");
const configuredFixtures = process.env.AIH_PUBLIC_PROFILE_CUSTODY_FIXTURES;
if (configuredFixtures === undefined || configuredFixtures.trim() !== configuredFixtures || configuredFixtures === "")
  throw new Error("public-profile-custody-fixtures-required");
const fixturesRoot = resolve(configuredFixtures);
if (!existsSync(fixturesRoot)) throw new Error("public-profile-custody-fixtures-missing");
const target = resolve(proof, "disposable-target");
const consumer = resolve(proof, "packed-consumer");
const admin = resolve(proof, "protected-policy");
const packDir = resolve(proof, "packed-core");
const evidenceDir = resolve(proof, "evidence");
const enterpriseCustodyRoot =
  process.platform === "win32"
    ? "C:\\ProgramData\\aih\\supported-qualification\\v2"
    : process.platform === "darwin"
      ? "/Library/Application Support/aih/supported-qualification/v2"
      : "/etc/aih/supported-qualification/v2";
const npmCli = process.platform === "win32"
  ? resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  : undefined;
if (npmCli !== undefined && !existsSync(npmCli)) throw new Error("npm-cli-unavailable");

const supportedRepository = "samartomar/aih-catalog";
const supportedWorkflow = "samartomar/aih-catalog/.github/workflows/signed-catalog-v2.yml";
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonicalNow = () => new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? proof,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status === null)
    throw new Error(`command-unavailable:${command}:${result.error?.message ?? result.signal ?? "unknown"}`);
  return { args: [command, ...args], code: result.status, stdout: result.stdout, stderr: result.stderr };
};
const requireSuccess = (result, label) => {
  if (result.code !== 0) throw new Error(`${label}:${result.code}:${result.stderr || result.stdout}`);
  return result;
};
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function inventory(path) {
  if (!existsSync(path)) return [];
  const entries = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const stats = statSync(absolute);
      const entry = { path: relative(path, absolute).replaceAll("\\", "/"), type: stats.isDirectory() ? "directory" : "file" };
      if (stats.isDirectory()) walk(absolute);
      else entry.sha256 = sha256(readFileSync(absolute));
      entries.push(entry);
    }
  };
  walk(path);
  return entries;
}
function assertSame(left, right, label) {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`${label}-changed-state`);
}
function scopedScratchPath(path) {
  const resolved = resolve(path);
  const relativePath = relative(proof, resolved);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  )
    throw new Error(`unsafe-scratch-path:${resolved}`);
  return resolved;
}

// PolicyBundle V2 is Enterprise-only. Refuse a reused OS-global custody root
// before creating any local proof files or calling the installed CLI.
if (existsSync(enterpriseCustodyRoot))
  throw new Error(`enterprise-custody-root-preexisting:${enterpriseCustodyRoot}`);

for (const directory of [target, consumer, admin, packDir, evidenceDir])
  rmSync(scopedScratchPath(directory), { recursive: true, force: true });
for (const directory of [target, consumer, admin, packDir, evidenceDir]) mkdirSync(directory, { recursive: true });
writeJson(resolve(evidenceDir, "ci-inputs.json"), {
  format: "public-profile-custody-ci-inputs/v1",
  custodyRoot: enterpriseCustodyRoot,
  fixturesRoot,
  supportedRepository,
  supportedWorkflow,
});

const fixtureManifestPath = resolve(fixturesRoot, "manifest.json");
if (!existsSync(fixtureManifestPath)) throw new Error("public-profile-custody-fixture-manifest-missing");
const fixtureManifest = JSON.parse(readFileSync(fixtureManifestPath, "utf8"));
const fixtures = fixtureManifest?.entries;
if (
  fixtureManifest?.format !== "public-profile-custody-fixtures/v1" ||
  fixtureManifest?.repository !== supportedRepository ||
  fixtureManifest?.workflow !== supportedWorkflow ||
  fixtureManifest?.totalBytes !== 6636 ||
  !Array.isArray(fixtures) ||
  fixtures.length !== 4
) throw new Error("public-profile-custody-fixture-manifest-invalid");
writeJson(resolve(evidenceDir, "fixture-manifest.json"), fixtureManifest);

const receiptRecords = fixtures.map((fixture, sequence) => {
  if (
    fixture?.sequence !== sequence ||
    fixture.path !== `seq${sequence}.json` ||
    fixture.bytes !== 1659 ||
    typeof fixture.receiptSha256 !== "string" ||
    !Number.isSafeInteger(fixture.workflowRun) ||
    !/^[0-9a-f]{40}$/u.test(fixture.sourceSha ?? "") ||
    !/^sha256:[0-9a-f]{64}$/u.test(fixture.catalogHeadDigest ?? "") ||
    !/^sha256:[0-9a-f]{64}$/u.test(fixture.catalogMemberDigest ?? "")
  ) throw new Error(`public-profile-custody-fixture-invalid:seq${sequence}`);
  const path = resolve(fixturesRoot, fixture.path);
  if (relative(fixturesRoot, path) !== fixture.path || !existsSync(path))
    throw new Error(`missing-public-receipt:seq${sequence}`);
  const bytes = readFileSync(path);
  const receipt = JSON.parse(bytes.toString("utf8"));
  if (
    bytes.length !== fixture.bytes ||
    sha256(bytes) !== fixture.receiptSha256 ||
    receipt.catalogContinuity?.sequence !== sequence ||
    receipt.catalogContinuity?.catalogHeadDigest !== fixture.catalogHeadDigest ||
    receipt.qualificationBasis?.catalogHeadDigest !== fixture.catalogHeadDigest ||
    receipt.qualificationBasis?.catalogMemberDigest !== fixture.catalogMemberDigest ||
    receipt.entryId !== "recipe.default" ||
    receipt.subject?.kind !== "profile" ||
    receipt.subject?.id !== "default-profile" ||
    receipt.subject?.source?.type !== "aih" ||
    receipt.subject?.source?.release !== "1.0.0" ||
    receipt.subject?.source?.revision !== "sha256:1492fa09fc057e2e3659ca5ad3d143ba5a4b529a2b18e027b5e40a75439518c9" ||
    receipt.subject?.subjectDigest !== "sha256:76eae60a7002fc68bb2938c9fac915d01e0191642c1346c04e0887c96f5fe2fb"
  ) throw new Error(`unexpected-public-receipt:seq${sequence}`);
  const attestation = requireSuccess(
    run("gh", [
      "attestation", "verify", path, "--repo", supportedRepository, "--source-digest", fixture.sourceSha,
      "--signer-workflow", supportedWorkflow, "--source-ref", "refs/heads/main", "--deny-self-hosted-runners", "--format", "json",
    ]),
    `public-attestation-seq${sequence}`,
  );
  writeFileSync(resolve(evidenceDir, `seq${sequence}-attestation.json`), attestation.stdout, "utf8");
  return { sequence, run: fixture.workflowRun, sourceSha: fixture.sourceSha, path, bytes, receipt, receiptSha256: sha256(bytes) };
});

const first = receiptRecords[0]?.receipt;
if (!first || !receiptRecords.every(({ receipt }) => JSON.stringify(receipt.subject) === JSON.stringify(first.subject)))
  throw new Error("public-profile-subject-continuity");
const issuedAt = canonicalNow();
const expiresAt = receiptRecords[3]?.receipt.expiresAt;
if (!expiresAt || Date.parse(issuedAt) >= Date.parse(expiresAt)) throw new Error("public-authority-window-unavailable");
if (receiptRecords.some(({ receipt }) => Date.parse(receipt.issuedAt) > Date.parse(issuedAt)))
  throw new Error("public-receipt-not-yet-issued");

const npm = (args, options) => npmCli === undefined ? run("npm", args, options) : run(process.execPath, [npmCli, ...args], options);
const pack = requireSuccess(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], { cwd: root }), "pack-core");
const packManifest = JSON.parse(pack.stdout)[0];
const tarball = resolve(packDir, packManifest?.filename ?? "");
if (packManifest?.name !== "@aihq/core" || !existsSync(tarball)) throw new Error("packed-core-identity");
writeFileSync(resolve(consumer, "package.json"), '{"name":"public-profile-custody-consumer","private":true}\n');
requireSuccess(npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], { cwd: consumer }), "install-packed-core");
const installed = resolve(consumer, "node_modules", "@aihq", "core");
const cli = resolve(installed, "dist", "cli.js");
if (!existsSync(cli)) throw new Error("packed-core-cli-missing");
const packedCore = await import(pathToFileURL(resolve(installed, "dist", "index.js")).href);
const workbenchPath = resolve(admin, "aih-policy-workbench.html");
const generate = requireSuccess(run(process.execPath, [cli, "policy", "generate", "--apply", "--out", workbenchPath], { cwd: admin }), "generate-packed-workbench");
if (!existsSync(workbenchPath)) throw new Error("packed-workbench-missing");

const policyDigest = sha256(Buffer.from("public-profile-custody-policy/v1\0", "utf8"));
const controlDigest = sha256(Buffer.from("public-profile-custody-control/v1\0", "utf8"));
const decisionFields = receiptRecords.map(({ receipt, receiptSha256, sequence }) => ({
  "protected-actor": "custody-owner@example.invalid",
  "protected-attestor": "catalog-attestation",
  "protected-catalog-digest": receipt.qualificationBasis.catalogDigest,
  "protected-catalog-head-digest": receipt.qualificationBasis.catalogHeadDigest,
  "protected-catalog-member-digest": receipt.qualificationBasis.catalogMemberDigest,
  "protected-catalog-signer": receipt.qualificationBasis.catalogSignerIdentity,
  "protected-control-digest": controlDigest,
  "protected-control-id": "catalog-custody",
  "protected-decision-id": `decision-profile-default-${sequence}`,
  "protected-effects": "use",
  "protected-evidence-digest": receiptSha256,
  "protected-evidence-id": `receipt-seq-${sequence}`,
  "protected-kind": "profile",
  "protected-policy-digest": policyDigest,
  "protected-policy-id": "public-profile-custody",
  "protected-policy-version": "2026.09",
  "protected-qualification-kind": "aih-supported",
  "protected-reason": "Custody only for the exact publicly attested profile receipt.",
  "protected-source-release": receipt.subject.source.release,
  "protected-source-revision": receipt.subject.source.revision,
  "protected-source-type": "aih",
  "protected-subject-id": receipt.subject.id,
  "protected-targets": "claude",
}));
const helper = await import(pathToFileURL(resolve(root, "tools", "lib", "author-protected-policy-via-workbench.mjs")).href);
const policyPath = resolve(admin, "aih-policy-bundle.json");
const policyBundle = await helper.authorProtectedPolicyViaPackedWorkbench({
  authorityFields: {
    "protected-bundle-version": "2026.09.09-public-custody",
    "protected-expires-at": expiresAt,
    "protected-issued-at": issuedAt,
    "protected-issuer": "catalog-custody",
    "protected-issuer-repository": "example.invalid/public-profile-custody",
  },
  decisions: decisionFields,
  htmlPath: workbenchPath,
  outputPath: policyPath,
});
if (!packedCore.parsePolicyBundle(JSON.parse(readFileSync(policyPath, "utf8"))).ok)
  throw new Error("packed-policy-bundle-parse");
const decisions = policyBundle.authorityReceipt?.decisions;
if (!Array.isArray(decisions) || decisions.length !== 4) throw new Error("packed-policy-decisions");
const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
const authorityEnv = {
  ...process.env,
  AIH_ORG_POLICY: policyPath,
  AIH_SUPPORTED_QUALIFICATION_REPOSITORY: supportedRepository,
  AIH_SUPPORTED_QUALIFICATION_WORKFLOW: supportedWorkflow,
};
const invoke = (args) => run(process.execPath, [cli, ...args, "--json"], { cwd: target, env: authorityEnv });
const writeReceipt = (record) => {
  const receiptPath = resolve(target, ".aih", "aih-supported-qualification-receipt.json");
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, record.bytes, { flag: "w" });
};
const results = [];
for (const record of receiptRecords) {
  writeReceipt(record);
  const decision = decisionById.get(`decision-profile-default-${record.sequence}`);
  if (!decision) throw new Error(`missing-generated-decision:${record.sequence}`);
  const decisionDigest = packedCore.governanceDecisionDigestV2(decision);
  const args = ["policy", "supported", "accept", "--root", target, "--decision", decision.id, "--decision-digest", decisionDigest, "--target", "claude"];
  const targetCustodyRoot = resolve(target, ".aih", "supported-qualification", "v2");
  const beforePreview = inventory(enterpriseCustodyRoot);
  const preview = requireSuccess(invoke(args), `preview-seq${record.sequence}`);
  const afterPreview = inventory(enterpriseCustodyRoot);
  assertSame(beforePreview, afterPreview, `preview-seq${record.sequence}`);
  const apply = requireSuccess(invoke([...args, "--apply"]), `apply-seq${record.sequence}`);
  const inspect = requireSuccess(invoke(["policy", "supported", "inspect", "--root", target]), `inspect-seq${record.sequence}`);
  const inspected = JSON.parse(inspect.stdout);
  const custody = inspected.digests?.[0]?.data;
  const members = custody?.members;
  const member = members?.[0];
  if (
    !Array.isArray(members) ||
    members.length !== 1 ||
    custody?.memberRecords?.occupied !== record.sequence + 1 ||
    member?.entryId !== "recipe.default" ||
    member?.subject?.kind !== "profile" ||
    member?.subject?.id !== "default-profile" ||
    member?.subject?.digest !== record.receipt.subject.subjectDigest ||
    member?.target !== "claude" ||
    member?.decision?.id !== `decision-profile-default-${record.sequence}` ||
    member?.decision?.digest !== decisionDigest
  )
    throw new Error(`inspect-missing-current-seq${record.sequence}`);
  if (existsSync(targetCustodyRoot) || inventory(enterpriseCustodyRoot).length === 0)
    throw new Error(`inspect-custody-root-mismatch-seq${record.sequence}`);
  results.push({ sequence: record.sequence, decisionDigest, preview: JSON.parse(preview.stdout), apply: JSON.parse(apply.stdout), inspect: inspected, receiptSha256: record.receiptSha256 });
}

const head = receiptRecords[3];
writeReceipt(head);
const headDecision = decisionById.get("decision-profile-default-3");
const headDigest = packedCore.governanceDecisionDigestV2(headDecision);
const repeatArgs = ["policy", "supported", "accept", "--root", target, "--decision", headDecision.id, "--decision-digest", headDigest, "--target", "claude", "--apply"];
const beforeRepeat = inventory(enterpriseCustodyRoot);
const repeat = requireSuccess(invoke(repeatArgs), "repeat-seq3");
const afterRepeat = inventory(enterpriseCustodyRoot);
assertSame(beforeRepeat, afterRepeat, "repeat-seq3");

const rollback = receiptRecords[2];
writeReceipt(rollback);
const rollbackDecision = decisionById.get("decision-profile-default-2");
const rollbackDigest = packedCore.governanceDecisionDigestV2(rollbackDecision);
const beforeRollback = inventory(enterpriseCustodyRoot);
const rollbackResult = invoke(["policy", "supported", "accept", "--root", target, "--decision", rollbackDecision.id, "--decision-digest", rollbackDigest, "--target", "claude", "--apply"]);
if (rollbackResult.code === 0) throw new Error("rollback-seq2-was-accepted");
if (!`${rollbackResult.stdout}\n${rollbackResult.stderr}`.includes("supported custody continuity is invalid"))
  throw new Error("rollback-seq2-did-not-reach-continuity-rejection");
const afterRollback = inventory(enterpriseCustodyRoot);
assertSame(beforeRollback, afterRollback, "rollback-seq2");

const report = {
  format: "public-profile-custody-acceptance/v1",
  custodyRoot: enterpriseCustodyRoot,
  package: { name: packManifest.name, version: packManifest.version, tarball: packManifest.filename, tarballSha256: sha256(readFileSync(tarball)), gitHead: requireSuccess(run("git", ["rev-parse", "HEAD"], { cwd: root }), "git-head").stdout.trim() },
  policy: { path: policyPath, sha256: sha256(readFileSync(policyPath)), issuedAt, expiresAt, authorityReceiptDigest: sha256(Buffer.from(JSON.stringify(policyBundle.authorityReceipt))) },
  publicReceipts: receiptRecords.map(({ sequence, run: workflowRun, sourceSha, receipt, receiptSha256 }) => ({ sequence, workflowRun, workflowUrl: `https://github.com/samartomar/aih-catalog/actions/runs/${workflowRun}`, sourceSha, receiptSha256, receiptDigest: packedCore.receiptDigestV2(receipt), catalogSignerIdentity: receipt.qualificationBasis.catalogSignerIdentity, signerKeyId: receipt.catalogContinuity.signerKeyId, catalogHeadDigest: receipt.catalogContinuity.catalogHeadDigest, catalogMemberDigest: receipt.qualificationBasis.catalogMemberDigest })),
  operations: results,
  exactHeadRepeat: { result: JSON.parse(repeat.stdout), unchangedState: true },
  olderSequenceRollback: { sequence: 2, exitCode: rollbackResult.code, stdout: rollbackResult.stdout, stderr: rollbackResult.stderr, refused: true, unchangedState: true },
  finalCustodyInventory: inventory(enterpriseCustodyRoot),
  claim: "Public profile Receipt V2 custody continuity only; no npm observation, lifecycle, qualification, publication, install, configuration, or use effect is claimed.",
};
writeJson(resolve(evidenceDir, "public-profile-custody-report.json"), report);
process.stdout.write(`PUBLIC_PROFILE_CUSTODY_ACCEPTANCE_PASS ${resolve(evidenceDir, "public-profile-custody-report.json")}\n`);
