import {assertAuthorized,recheck} from './release-authority.mjs';
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authorProtectedPolicyViaChromium } from "./author-protected-policy-chromium.mjs";

export async function runManaged(context) {
assertAuthorized(context);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const retainedBase = context.evidenceRoot;
const consumer = context.consumer;
const cli = resolve(consumer, "node_modules", "@aihq", "core", "dist", "cli.js");
const workbench = resolve(retainedBase, "managed-workbench.html");
const scratch = context.evidenceRoot;
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const asJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, stable(value), "utf8");

function requireInsideBase(path, label) {
  const resolved = resolve(path);
  const rel = relative(retainedBase, resolved);
  if (rel === "" || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`managed-usage-${label}-outside-retained-base`);
  return resolved;
}

function run(cwd, args, label, allowFailure = false, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.AIH_POLICY_AUTHORITY_REPOSITORY;
  delete env.AIH_POLICY_AUTHORITY_WORKFLOW;
  if (extraEnv.AIH_ORG_POLICY === undefined) delete env.AIH_ORG_POLICY;
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  });
  if (result.error !== undefined) throw new Error(`${label}:${result.error.message}`);
  if (result.status === null) throw new Error(`${label}:signal-${result.signal ?? "unknown"}`);
  const record = { argv: args, exitCode: result.status, stderr: result.stderr, stdout: result.stdout };
  if (result.status !== 0 && !allowFailure) throw new Error(`${label}:${result.stderr || result.stdout}`);
  return record;
}

function currentOperator() {
  const value = (key) => {
    const result = spawnSync("git", ["config", "--get", key], { cwd: repository, encoding: "utf8" });
    if (result.error !== undefined || result.status !== 0) throw new Error(`managed-usage-git-config-${key}-missing`);
    return result.stdout.trim();
  };
  const name = value("user.name");
  const actor = value("user.email");
  const attestor = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(actor) || !/^[a-z][a-z0-9-]{0,63}$/u.test(attestor))
    throw new Error("managed-usage-local-operator-invalid");
  return { actor, attestor, name };
}

function descriptorFrom(command) {
  const descriptor = JSON.parse(command.stdout).digests?.[0]?.data;
  if (
    descriptor?.adapter?.id !== "aih-usage-metering" ||
    descriptor?.adapter?.version !== "1.0.0" ||
    descriptor?.effect !== "configure" ||
    descriptor?.subject?.kind !== "tool" ||
    descriptor?.subject?.id !== "usage-metering" ||
    descriptor?.subject?.source?.type !== "aih" ||
    !/^sha256:[0-9a-f]{64}$/u.test(descriptor?.adapter?.digest ?? "") ||
    !/^sha256:[0-9a-f]{64}$/u.test(descriptor?.subject?.sourceDigest ?? "") ||
    !/^sha256:[0-9a-f]{64}$/u.test(descriptor?.subject?.subjectDigest ?? "") ||
    JSON.stringify(descriptor?.targets) !== '["claude","codex"]'
  ) throw new Error("managed-usage-descriptor-invalid");
  return descriptor;
}

function workbenchDecision(decision) {
  return {
    "protected-actor": decision.actor,
    "protected-attestor": decision.evidence.attestor,
    "protected-disposition": decision.disposition,
    "protected-accepted-findings": decision.acceptedFindings.join(","),
    "protected-accepted-gaps": decision.acceptedGaps.join(","),
    "protected-conditions": decision.conditions.join("\n"),
    "protected-control-digest": decision.control.digest,
    "protected-control-id": decision.control.id,
    "protected-decision-id": decision.id,
    "protected-effects": decision.allowedEffects.join(","),
    "protected-evidence-digest": decision.evidence.digest,
    "protected-evidence-id": decision.evidence.id,
    "protected-kind": decision.subject.kind,
    "protected-policy-digest": decision.policy.digest,
    "protected-policy-id": decision.policy.id,
    "protected-policy-version": decision.policy.version,
    "protected-qualification-kind": decision.qualificationBasis.kind,
    "protected-reason": decision.reason,
    "protected-review-by": decision.reviewBy,
    "protected-source-release": decision.subject.source.release,
    "protected-source-revision": decision.subject.source.revision,
    "protected-source-type": decision.subject.source.type,
    "protected-subject-id": decision.subject.id,
    "protected-targets": decision.targets.join(","),
  };
}

function strictPrepared(value) {
  if (value?.format !== "aih-managed-usage-review-preparation/v1" || value?.authorityExecuted !== false)
    throw new Error("managed-usage-preparation-format-invalid");
  const paths = value.paths;
  for (const key of ["admin", "target", "descriptorCommand", "assessment", "payload", "policy", "control", "evidence", "workbench"]) {
    if (typeof paths?.[key] !== "string") throw new Error(`managed-usage-preparation-path-missing:${key}`);
    requireInsideBase(paths[key], key);
  }
  for (const key of ["descriptorCommand", "assessment", "payload", "policy", "control", "evidence", "workbench"]) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(value.digests?.[key] ?? "")) throw new Error(`managed-usage-preparation-digest-missing:${key}`);
    if (sha256(readFileSync(paths[key])) !== value.digests[key]) throw new Error(`managed-usage-preparation-digest-changed:${key}`);
  }
  if (!existsSync(paths.admin) || !existsSync(paths.target)) throw new Error("managed-usage-preparation-root-missing");
  return value;
}

async function prepare() {
  if (!existsSync(cli) || !existsSync(workbench)) throw new Error("managed-usage-existing-packed-core-missing");
  const operator = currentOperator();
  const nonce = new Date().toISOString().replace(/[^0-9]/gu, "");
  const admin = requireInsideBase(resolve(retainedBase, `managed-usage-admin-${nonce}`), "admin");
  const target = requireInsideBase(resolve(retainedBase, `managed-usage-target-${nonce}`), "target");
  mkdirSync(admin); mkdirSync(target);
  const command = run(consumer, ["policy", "managed", "usage-metering", "describe", "--json"], "managed-usage-describe");
  const descriptorCommand = resolve(admin, "managed-descriptor-command.json");
  writeJson(descriptorCommand, command);
  const descriptor = descriptorFrom(command);
  const issuedAt = new Date().toISOString();
  const reviewBy = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  const gaps = [
    { id: "coverage-no-independent-scan", detail: "This fixed code-owned adapter descriptor was read directly; no independent trust scan result is asserted." },
    { id: "coverage-no-host-invocation", detail: "The journey will write fixed configuration custody but will not invoke the generated recorder or host hook." },
    { id: "coverage-no-provenance", detail: "The local packed descriptor binds release and revision but does not establish publisher or corporate-role provenance." },
    { id: "coverage-no-production-authorization", detail: "The disposable target assessment does not assess production deployment or host ACL ownership." },
  ];
  const policy = resolve(admin, "local-managed-usage-policy.md");
  const control = resolve(admin, "local-managed-usage-control.md");
  writeFileSync(policy, [
    "# Local disposable fixed AIH-managed usage policy", "",
    `Claimed local operator: ${operator.name} (\`${operator.actor}\`). This is self-asserted local attribution under the authorized delivery task; it is not verified corporate-role or public-repository proof.`, "",
    `Only the exact fixed adapter ${descriptor.adapter.id}@${descriptor.adapter.version} (${descriptor.adapter.digest}) for Core release ${descriptor.subject.source.release} and revision ${descriptor.subject.source.revision} may receive the \`configure\` effect in ${target}.`,
    "The scope permits the adapter's fixed custody outputs only. It does not permit package-code execution, recorder or hook invocation, production use, global host configuration, external publishing, Catalog admission, GitHub authority, or any target outside this disposable root.",
    "",
  ].join("\n"), "utf8");
  writeFileSync(control, [
    "# Local disposable fixed AIH-managed usage control", "",
    `Claimed local operator: ${operator.name} (\`${operator.actor}\`); self-asserted for this local task only.`, "",
    "The driver records the exact packed Core descriptor command bytes before authoring. It requires absent custody before the no-authority refusal, verifies the qualified preview is non-effective, applies only the fixed adapter, and checks configured custody. It then authors a separate revoked PolicyBundle download, reconciles revocation, and checks revoked custody plus removal of fixed outputs. No generated recorder or host hook is invoked.",
    "The assessment records missing independent scanning, host invocation, provenance, and production authorization as explicit gaps. It does not call any gap a pass.",
    "",
  ].join("\n"), "utf8");
  const assessment = resolve(admin, "local-managed-usage-assessment.md");
  writeFileSync(assessment, [
    "# Local disposable fixed adapter assessment", "",
    `Claimed local operator: ${operator.actor}; this is self-asserted task attribution, not verified corporate-role evidence.`,
    `Exact descriptor command SHA-256: ${sha256(readFileSync(descriptorCommand))}.`,
    `Adapter: ${descriptor.adapter.id}@${descriptor.adapter.version}; adapter digest: ${descriptor.adapter.digest}.`,
    `Subject: ${descriptor.subject.kind}/${descriptor.subject.id}; source: ${descriptor.subject.source.type} release ${descriptor.subject.source.release}, revision ${descriptor.subject.source.revision}; subject digest: ${descriptor.subject.subjectDigest}.`,
    `Allowed local target: ${target}; effect: configure; selected target: codex.`, "",
    "Findings: none are accepted because this preparation does not claim a scanner result.",
    ...gaps.map((gap) => `Coverage gap ${gap.id}: ${gap.detail}`), "",
    `Review deadline: ${reviewBy}.`,
    "The later decision permits only fixed adapter configuration in the named disposable target. It neither executes generated code nor authorizes package execution, production, host-global configuration, publication, Catalog, GitHub, or Scanner authority.", "",
  ].join("\n"), "utf8");
  const payload = resolve(admin, "managed-assessment-payload.json");
  const assessmentPayload = {
    format: "aih-local-managed-usage-assessment-payload/v1", version: 1, descriptor,
    descriptorCommandSha256: sha256(readFileSync(descriptorCommand)),
    assessmentSha256: sha256(readFileSync(assessment)), policySha256: sha256(readFileSync(policy)), controlSha256: sha256(readFileSync(control)),
    findings: [], gaps,
  };
  writeJson(payload, assessmentPayload);
  const evidence = {
    format: "aih-organization-evidence", version: 1, subjectDigest: descriptor.subject.subjectDigest,
    evidence: {
      kind: "assessment", id: "managed-usage-assessment",
      summary: "Actual public Core0.6.1 fixed AIH-managed usage descriptor; scoped local assessment binds descriptor and review artifacts.",
      payloadDigest: sha256(readFileSync(payload)),
      artifactDigests: [descriptorCommand, assessment, policy, control, payload].map((path) => sha256(readFileSync(path))).sort(),
    },
    attestor: operator.attestor, issuedAt, notBefore: issuedAt, expiresAt,
  };
  const evidenceText = stable(evidence);
  const evidenceDigest = sha256(`aih-organization-evidence/v1\0${evidenceText}`);
  const decision = {
    format: "aih-governance-decision", version: 2, id: "decision-org-managed-usage-050",
    qualificationBasis: { kind: "organization-qualified", evidenceDigest, attestor: operator.attestor },
    subject: descriptor.subject, targets: ["codex"], allowedEffects: ["configure"],
    policy: { id: "local-managed-usage-policy", version: "2026.09", digest: sha256(readFileSync(policy)) },
    control: { id: "local-managed-usage-control", digest: sha256(readFileSync(control)) },
    evidence: { id: evidence.evidence.id, digest: evidenceDigest, attestor: operator.attestor },
    issuer: operator.attestor, actor: operator.actor,
    reason: "The named local operator may authorize only the exact fixed adapter configure effect in this disposable root; the driver does not invoke generated package, recorder, or host-hook code.",
    issuedAt, notBefore: issuedAt, expiresAt, disposition: "accepted-with-conditions", acceptedFindings: [], acceptedGaps: gaps.map((gap) => gap.id).sort(),
    conditions: [
      `Only ${descriptor.adapter.id}@${descriptor.adapter.version} (${descriptor.adapter.digest}) from Core ${descriptor.subject.source.release}/${descriptor.subject.source.revision} may configure ${target}.`,
      "Only fixed adapter custody outputs may be written; the generated recorder and host hook must not be invoked.",
      `No production, global host, publication, Catalog, GitHub, or Scanner authority is granted; review expires at ${reviewBy}.`,
    ].sort(), reviewBy,
  };
  const evidencePath = resolve(target, "organization-evidence.json");
  writeFileSync(evidencePath, evidenceText, "utf8");
  const candidatePath = resolve(admin, "candidate-managed-decision.json");
  writeJson(candidatePath, decision);
  const prepared = {
    format: "aih-managed-usage-review-preparation/v1", authorityExecuted: false,
    scope: "Fixed AIH-managed usage adapter configure effect only in the named disposable target; no generated code execution or public authority.",
    operator: { actor: operator.actor, attestor: operator.attestor, claim: "current local Git configuration; self-asserted task attribution only" },
    descriptor, decision, decisionDigest: (await import(pathToFileURL(resolve(consumer, "node_modules", "@aihq", "core", "dist", "index.js")).href)).governanceDecisionDigestV2(decision),
    paths: { admin, target, descriptorCommand, assessment, payload, policy, control, evidence: evidencePath, workbench },
    digests: { descriptorCommand: sha256(readFileSync(descriptorCommand)), assessment: sha256(readFileSync(assessment)), payload: sha256(readFileSync(payload)), policy: sha256(readFileSync(policy)), control: sha256(readFileSync(control)), evidence: sha256(readFileSync(evidencePath)), workbench: sha256(readFileSync(workbench)) },
  };
  const preparationPath = resolve(scratch, `actual-managed-usage-review-preparation-${nonce}.json`);
  writeJson(preparationPath, prepared);
  process.stdout.write(`Managed usage assessment prepared at ${preparationPath}\n`);
  return preparationPath;
}

async function execute(preparationPath) {
  if (!existsSync(cli)) throw new Error("managed-usage-existing-packed-core-missing");
  const prepared = strictPrepared(asJson(preparationPath));
  const { paths, decision } = prepared;
  const core = await import(pathToFileURL(resolve(consumer, "node_modules", "@aihq", "core", "dist", "index.js")).href);
  if (core.governanceDecisionDigestV2(decision) !== prepared.decisionDigest) throw new Error("managed-usage-decision-digest-changed");
  const initial = run(paths.target, ["policy", "managed", "usage-metering", "inspect", paths.target, "--json"], "managed-usage-inspect-before");
  if (JSON.parse(initial.stdout).digests?.[0]?.data?.state !== "absent") throw new Error("managed-usage-target-not-absent");
  const request = ["policy", "managed", "usage-metering", "reconcile", paths.target, "--decision", decision.id, "--decision-digest", prepared.decisionDigest, "--target", "codex", "--evidence", "organization-evidence.json", "--json"];
  const refused = run(paths.target, [...request, "--apply"], "managed-usage-no-authority-refusal", true);
  if (refused.exitCode === 0 || !`${refused.stdout}\n${refused.stderr}`.includes("authority-unverified")) throw new Error("managed-usage-no-authority-not-refused");
  const afterRefusal = run(paths.target, ["policy", "managed", "usage-metering", "inspect", paths.target, "--json"], "managed-usage-inspect-after-refusal");
  if (JSON.parse(afterRefusal.stdout).digests?.[0]?.data?.state !== "absent") throw new Error("managed-usage-refusal-mutated-target");
  const activePath = resolve(paths.admin, "managed-usage-policy-active.json");
  const revokedPath = resolve(paths.admin, "managed-usage-policy-revoked.json");
  const activeReportPath = resolve(paths.admin, "managed-usage-chromium-active.json");
  const active = existsSync(activePath) || existsSync(activeReportPath)
    ? (() => {
      if (!existsSync(activePath) || !existsSync(activeReportPath))
        throw new Error("managed-usage-active-download-incomplete");
      const report = asJson(activeReportPath);
      if (report?.download?.sha256 !== sha256(readFileSync(activePath)))
        throw new Error("managed-usage-active-download-digest-mismatch");
      return { bundle: asJson(activePath), report };
    })()
    : await authorProtectedPolicyViaChromium({
      authorityFields: { "protected-bundle-version": "2026.09.managed.1", "protected-issued-at": decision.issuedAt, "protected-expires-at": decision.expiresAt, "protected-issuer": decision.issuer, "protected-issuer-repository": `${decision.issuer}/local-disposable-admin` },
      decisions: [workbenchDecision(decision)], htmlPath: paths.workbench, outputPath: activePath,
      reportPath: activeReportPath, screenshotPath: resolve(paths.admin, "managed-usage-conditions-active.png"), expectedRevocationDecisionDigests: [],
    });
  const activeDecision = active.bundle.authorityReceipt.decisions.find((item) => item.id === decision.id);
  if (activeDecision === undefined || core.governanceDecisionDigestV2(activeDecision) !== prepared.decisionDigest || !core.parsePolicyBundle(active.bundle).ok)
    throw new Error("managed-usage-active-policy-mismatch");
  const activeEnv = { AIH_ORG_POLICY: activePath };
  const preview = run(paths.target, request, "managed-usage-qualified-preview", false, activeEnv);
  const previewData = JSON.parse(preview.stdout).digests?.[0]?.data?.domain;
  if (previewData?.outcome !== "reported-only" || previewData?.qualification !== "organization-qualified" || existsSync(resolve(paths.target, ".aih", "org-policy-hook-receipt.json")))
    throw new Error("managed-usage-preview-not-non-effective");
  const applied = run(paths.target, [...request, "--apply"], "managed-usage-qualified-apply", false, activeEnv);
  const configured = run(paths.target, ["policy", "managed", "usage-metering", "inspect", paths.target, "--json"], "managed-usage-inspect-configured");
  if (JSON.parse(configured.stdout).digests?.[0]?.data?.state !== "configured") throw new Error("managed-usage-not-configured");
  const revoked = await authorProtectedPolicyViaChromium({
    authorityFields: { "protected-bundle-version": "2026.09.managed.2", "protected-issued-at": decision.issuedAt, "protected-expires-at": decision.expiresAt, "protected-issuer": decision.issuer, "protected-issuer-repository": `${decision.issuer}/local-disposable-admin` },
    decisions: [workbenchDecision(decision)], htmlPath: paths.workbench, outputPath: revokedPath,
    reportPath: resolve(paths.admin, "managed-usage-chromium-revoked.json"), screenshotPath: resolve(paths.admin, "managed-usage-conditions-revoked.png"), revokeDecisionIndexes: [0], expectedRevocationDecisionDigests: [prepared.decisionDigest],
  });
  if (revoked.bundle.authorityReceipt.decisionRevocations?.[0]?.decisionDigest !== prepared.decisionDigest || !core.parsePolicyBundle(revoked.bundle).ok)
    throw new Error("managed-usage-revoked-policy-mismatch");
  const revokedRequest = request.filter((value, index, values) => value !== "--evidence" && values[index - 1] !== "--evidence");
  const revokedApply = run(paths.target, [...revokedRequest, "--apply"], "managed-usage-revoke", false, { AIH_ORG_POLICY: revokedPath });
  const revokedInspect = run(paths.target, ["policy", "managed", "usage-metering", "inspect", paths.target, "--json"], "managed-usage-inspect-revoked");
  if (JSON.parse(revokedInspect.stdout).digests?.[0]?.data?.state !== "revoked") throw new Error("managed-usage-not-revoked");
  if (existsSync(resolve(paths.target, ".aih", "usage-record.mjs")))
    throw new Error("managed-usage-revoked-recorder-remains");
  const ignorePath = resolve(paths.target, ".gitignore");
  if (existsSync(ignorePath) && readFileSync(ignorePath, "utf8").includes("# aih-managed"))
    throw new Error("managed-usage-revoked-ignore-marker-remains");
  const hooksPath = resolve(paths.target, ".codex", "hooks.json");
  if (existsSync(hooksPath) && readFileSync(hooksPath, "utf8").includes("usage-record.mjs"))
    throw new Error("managed-usage-revoked-hook-remains");
  await recheck(context);
  const report = { publicRelease: {qualificationSha256:context.input.qualificationSha256,registryIntegrity:context.binding.registryIntegrity},
    format: "aih-managed-usage-accountable-acceptance/v1",
    claim: "Actual packed Core fixed AIH-managed usage lifecycle in a disposable target. Protected local PolicyBundle V2 is the authority transport; no GitHub, Catalog, Scanner, corporate-role, package execution, or public authority is claimed.",
    preparation: preparationPath, descriptor: prepared.descriptor, decision: { id: decision.id, digest: prepared.decisionDigest }, paths,
    digests: { ...prepared.digests, activePolicy: sha256(readFileSync(activePath)), revokedPolicy: sha256(readFileSync(revokedPath)) },
    authority: { transport: "administrator-protected-policy-bundle-v2", active: active.report, revoked: revoked.report },
    operations: { initial, refused, afterRefusal, preview, applied, configured, revokedApply, revokedInspect },
  };
  const reportPath = resolve(scratch, `actual-managed-usage-accountable-report-${decision.issuedAt.replace(/[^0-9]/gu, "")}.json`);
  writeJson(reportPath, report);
  process.stdout.write(`Managed usage accountable acceptance PASS; retained report ${reportPath}\n`);
}

run(context.consumer, ['policy','generate','--apply','--out',workbench,'--no-log'], 'generate-managed-workbench');
const preparedPath=await prepare();
await execute(preparedPath);
}
