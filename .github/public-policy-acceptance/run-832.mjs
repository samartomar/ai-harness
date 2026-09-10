import {assertAuthorized,recheck} from './release-authority.mjs';
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { authorProtectedPolicyViaChromium } from "./author-protected-policy-chromium.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nodeNpmCli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
if (!existsSync(nodeNpmCli)) throw new Error("npm-cli-unavailable");
const TIMEOUT = 5 * 60 * 1000;
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
function completed(result, label) {
  if (result.error !== undefined)
    throw new Error(`${label}:${result.error.code === "ETIMEDOUT" ? "timeout" : result.error.message}`);
  if (result.status === null) throw new Error(`${label}:signal-${result.signal ?? "unknown"}`);
}
function run(cwd, args, label, allowFailure = false, env = process.env) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: TIMEOUT,
  });
  completed(result, label);
  if (result.status !== 0 && !allowFailure)
    throw new Error(`${label}:${(result.stderr || result.stdout).slice(0, 1000)}`);
  return result;
}
function npm(cwd, args, label) {
  return run(cwd, [nodeNpmCli, ...args, "--registry", "https://registry.npmjs.org/"], label);
}
function currentOperator() {
  const value = (key) => {
    const result = spawnSync("git", ["config", "--get", key], { cwd: repository, encoding: "utf8" });
    completed(result, `git-config-${key}`);
    if (result.status !== 0) throw new Error(`git-config-${key}-missing`);
    return result.stdout.trim();
  };
  const name = value("user.name");
  const actor = value("user.email");
  const attestor = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(actor) || !/^[a-z][a-z0-9-]{0,63}$/u.test(attestor))
    throw new Error("git-config-operator-invalid");
  return { actor, attestor };
}
function installedCli(cwd, cli, args, label, allowFailure = false, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.AIH_POLICY_AUTHORITY_REPOSITORY;
  delete env.AIH_POLICY_AUTHORITY_WORKFLOW;
  if (extra.AIH_ORG_POLICY === undefined) delete env.AIH_ORG_POLICY;
  return run(cwd, [cli, ...args], label, allowFailure, env);
}
function writeJson(path, value) {
  writeFileSync(path, stable(value), "utf8");
}
function actualNpmSpec(cwd, packageName, version) {
  const viewed = npm(cwd, ["view", `${packageName}@${version}`, "name", "version", "dist.integrity", "--json"], `npm-view-${version}`);
  const value = JSON.parse(viewed.stdout);
  if (value?.name !== packageName || value?.version !== version || typeof value?.["dist.integrity"] !== "string")
    throw new Error(`npm-view-identity-${version}`);
  return {
    type: "npm",
    registry: "https://registry.npmjs.org/",
    package: packageName,
    version,
    integrity: value["dist.integrity"],
  };
}
function tarEntry(bytes, entryName) {
  const tar = gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/u, "");
    const fullName = prefix ? `${prefix}/${name}` : name;
    const rawSize = header.subarray(124, 136).toString("utf8").replace(/\0.*$/u, "").trim();
    const size = rawSize === "" ? 0 : Number.parseInt(rawSize, 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
      throw new Error("npm-tar-invalid-entry");
    if (fullName === entryName) return Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return undefined;
}
function npmByteCapture(cwd, destination, source) {
  mkdirSync(destination, { recursive: true });
  const pack = npm(cwd, ["pack", `${source.package}@${source.version}`, "--ignore-scripts", "--json", "--pack-destination", destination], `npm-pack-${source.version}`);
  const record = JSON.parse(pack.stdout)[0];
  const tarball = resolve(destination, record?.filename ?? "");
  const bytes = readFileSync(tarball);
  if (
    record?.name !== source.package ||
    record?.version !== source.version ||
    createHash("sha512").update(bytes).digest("base64") !== source.integrity.slice("sha512-".length)
  )
    throw new Error(`npm-pack-integrity-${source.version}`);
  const capture = {
    format: "aih-local-npm-immutable-byte-capture",
    version: 1,
    authority: "none",
    source,
    tarball: {
      filename: record.filename,
      sha256: sha256(bytes),
      sha512: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    },
  };
  const path = resolve(destination, "byte-capture.json");
  writeJson(path, capture);
  const manifestBytes = tarEntry(bytes, "package/package.json");
  if (manifestBytes === undefined) throw new Error(`npm-pack-manifest-missing-${source.version}`);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const licenseBytes = tarEntry(bytes, "package/LICENSE") ?? tarEntry(bytes, "package/LICENSE.md");
  const facts = {
    format: "aih-local-npm-extracted-facts",
    version: 1,
    authority: "none",
    source,
    manifest: {
      sha256: sha256(manifestBytes),
      license: manifest?.license ?? null,
      runtimeDependencies: Object.keys(manifest?.dependencies ?? {}).sort(),
      developmentDependencies: Object.entries(manifest?.devDependencies ?? {})
        .map(([name, version]) => ({ name, version }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      scripts: Object.keys(manifest?.scripts ?? {}).sort(),
    },
    rights: licenseBytes === undefined ? { path: null, sha256: null } : { path: "package/LICENSE", sha256: sha256(licenseBytes) },
  };
  const factsPath = resolve(destination, "extracted-package-facts.json");
  writeJson(factsPath, facts);
  return { capture, path, bytes: readFileSync(path), facts, factsPath, factsBytes: readFileSync(factsPath) };
}
function scanActualNpmBytes(cwd, cli, admin, source, operator) {
  const intakePath = resolve(admin, `scan-intake-${source.version}.json`);
  const evidencePath = resolve(admin, `scan-evidence-${source.version}.json`);
  writeJson(intakePath, {
    format: "aih-artifact-intake",
    version: 1,
    authority: { state: "not-authority" },
    defaults: { accountableOwner: operator.actor },
    items: [
      {
        id: `scan-${source.version.replaceAll(".", "-")}`,
        kind: "agent",
        source: {
          type: "npm",
          registry: source.registry,
          package: source.package,
          version: source.version,
          integrity: source.integrity,
        },
      },
    ],
  });
  const result = installedCli(
    admin,
    cli,
    ["trust", "scan", intakePath, "--apply", "--evidence-out", evidencePath, "--json", "--no-log"],
    `actual-trust-scan-${source.version}`,
    true,
  );
  if (!existsSync(evidencePath))
    throw new Error(`actual-trust-scan-no-evidence-${source.version}:${(result.stderr || result.stdout).slice(0, 1000)}`);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const observed = evidence?.evidence?.[0];
  if (
    evidence?.format !== "aih-preflight-evidence-bundle" ||
    observed?.source?.type !== "npm" ||
    observed.source.package !== source.package ||
    observed.source.version !== source.version ||
    observed.observed?.registryIntegrity !== source.integrity
  )
    throw new Error(`actual-trust-scan-mismatch-${source.version}`);
  writeFileSync(resolve(admin, `scan-command-${source.version}.json`), stable({
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }));
  return {
    bytes: readFileSync(evidencePath),
    commandPath: resolve(admin, `scan-command-${source.version}.json`),
    state: observed.state,
    evidencePath,
    scanExit: result.status,
  };
}
function useRetainedNpmScan(scanRoot, source) {
  const evidencePath = resolve(scanRoot, `scan-evidence-${source.version}.json`);
  const commandPath = resolve(scanRoot, `scan-command-${source.version}.json`);
  if (!existsSync(evidencePath) || !existsSync(commandPath))
    throw new Error(`retained-trust-scan-missing-${source.version}`);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const observed = evidence?.evidence?.[0];
  const command = JSON.parse(readFileSync(commandPath, "utf8"));
  if (
    evidence?.format !== "aih-preflight-evidence-bundle" ||
    observed?.source?.type !== "npm" ||
    observed.source.package !== source.package ||
    observed.source.version !== source.version ||
    observed.observed?.registryIntegrity !== source.integrity ||
    !Number.isInteger(command?.exitCode)
  ) throw new Error(`retained-trust-scan-mismatch-${source.version}`);
  return { bytes: readFileSync(evidencePath), commandPath, state: observed.state, evidencePath, scanExit: command.exitCode };
}
function installTargetNpm(cwd, source) {
  writeFileSync(resolve(cwd, "package.json"), '{"name":"org-qualified-npm-target","private":true}\n');
  npm(cwd, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", `${source.package}@${source.version}`], `install-target-${source.version}`);
  const lock = JSON.parse(readFileSync(resolve(cwd, "package-lock.json"), "utf8"));
  const entry = lock?.packages?.[`node_modules/${source.package}`];
  if (entry?.version !== source.version || entry?.integrity !== source.integrity)
    throw new Error(`installed-lock-mismatch-${source.version}`);
}
function scanAssessmentFacts(scan) {
  const command = JSON.parse(readFileSync(scan.commandPath, "utf8"));
  const report = JSON.parse(command.stdout);
  const verification = Array.isArray(report?.verification?.results) ? report.verification.results : [];
  const failures = verification
    .filter((entry) => entry?.verdict === "fail")
    .map((entry) => ({ passName: entry.passName, severity: entry.severity, message: entry.message }));
  const warnings = verification
    .filter((entry) => entry?.verdict === "warn")
    .map((entry) => ({ passName: entry.passName, message: entry.message }));
  if (!report?.verification?.summary || !Array.isArray(report?.report?.checks))
    throw new Error("scan-command-report-shape-invalid");
  return { failures, warnings, summary: report.verification.summary };
}
function writeLocalAssessment(admin, source, scan, capture, actor, reviewBy) {
  const details = scanAssessmentFacts(scan);
  const findings = details.failures.length === 0
    ? "The full Core command report has no failed verification result. This is not a scanner-pass claim."
    : `The full Core command report has ${details.failures.length} failed verification result(s): ${details.failures.map((entry) => `${entry.passName} (${entry.severity}): ${entry.message}`).join(" | ")}.`;
  const gaps = details.warnings.length === 0
    ? "The full Core command report has no warning records."
    : `The full Core command report retains ${details.warnings.length} coverage warning(s): ${details.warnings.map((entry) => `${entry.passName}: ${entry.message}`).join(" | ")}.`;
  const text = [
    "# Local disposable npm assessment",
    "",
    `Claimed local operator: ${actor}; this is self-asserted attribution under the authorized delivery task, not verified corporate-role evidence.`,
    `Exact source: ${source.package}@${source.version} (${source.integrity}).`,
    `Core scan state: ${scan.state}; command exit: ${scan.scanExit}.`,
    `Core final verdict: ${details.summary.finalVerdict}; trust score: ${details.summary.trustScore}.`,
    `Core scan bundle SHA-256: ${sha256(scan.bytes)}.`,
    `Full Core scan-command report SHA-256: ${sha256(readFileSync(scan.commandPath))}.`,
    `Immutable npm tarball SHA-256: ${capture.capture.tarball.sha256}.`,
    `Extracted package manifest SHA-256: ${capture.facts.manifest.sha256}; declared license: ${capture.facts.manifest.license ?? "absent"}; runtime dependencies: ${capture.facts.manifest.runtimeDependencies.join(", ") || "none"}; development dependencies: ${capture.facts.manifest.developmentDependencies.map((entry) => `${entry.name}@${entry.version}`).join(", ") || "none"}; scripts: ${capture.facts.manifest.scripts.join(", ") || "none"}.`,
    `Extracted rights file SHA-256: ${capture.facts.rights.sha256 ?? "absent"}.`,
    "",
    findings,
    gaps,
    "",
    `Proposed conditional-decision review deadline: ${reviewBy}.`,
    "Scope condition: a later Decision V2 may authorize only the exact install effect in this disposable root. Scripts-disabled npm materialization prepares the target; AIH then observes the already-installed lock and manifest identity and does not install or execute package code.",
    "The assessment grants no package execution, production use, host integration, global npm configuration, publication, Catalog admission, GitHub authority, Scanner signing, or authority outside this disposable root.",
    "",
  ].join("\n");
  const path = resolve(admin, `local-assessment-${source.version}.md`);
  writeFileSync(path, text, "utf8");
  return path;
}
function namedFindingRecords(source, scan) {
  const details = scanAssessmentFacts(scan);
  if (source.version !== "1.1.0") {
    if (details.failures.length !== 0) throw new Error(`unexpected-scan-failures-${source.version}`);
    return [];
  }
  const named = [
    ["no lockfile was found", "finding-missing-lockfile"],
    ["ansi-colors uses unpinned", "finding-unpinned-ansi-colors"],
    ["benchmark uses unpinned", "finding-unpinned-benchmark"],
    ["chalk uses unpinned", "finding-unpinned-chalk"],
    ["clean-publish uses unpinned", "finding-unpinned-clean-publish"],
    ["cli-color uses unpinned", "finding-unpinned-cli-color"],
    ["colorette uses unpinned", "finding-unpinned-colorette"],
    ["kleur uses unpinned", "finding-unpinned-kleur"],
    ["nanocolors uses unpinned", "finding-unpinned-nanocolors"],
    ["prettier uses unpinned", "finding-unpinned-prettier"],
  ];
  const records = named.map(([needle, id]) => {
    const found = details.failures.find((entry) => entry.message.includes(needle));
    if (!found || found.severity !== "high" || !found.passName.startsWith("trust.unpinned-dependency"))
      throw new Error(`expected-scan-finding-missing-${id}`);
    return { id, scannerCode: found.passName, severity: found.severity, detail: found.message };
  });
  if (details.failures.length !== records.length) throw new Error("unexpected-unpinned-finding-count");
  return records.sort((left, right) => left.id.localeCompare(right.id));
}
function namedGapRecords(scan) {
  const evidence = JSON.parse(scan.bytes);
  const observed = evidence?.evidence?.[0];
  const details = scanAssessmentFacts(scan);
  const expectedWarnings = [
    ["skill sandbox smoke test", "coverage-sandbox-inapplicable"],
    ["trust detector cisco", "coverage-cisco-unavailable"],
    ["trust detector semgrep", "coverage-semgrep-invalid"],
    ["trust detector skillspector", "coverage-skillspector-unavailable"],
    ["trust detector snyk-agent-scan", "coverage-snyk-unavailable"],
  ];
  const records = expectedWarnings.map(([passName, id]) => {
    const found = details.warnings.find((entry) => entry.passName === passName);
    if (!found) throw new Error(`expected-scan-gap-missing-${id}`);
    return { id, scannerCode: passName, detail: found.message };
  });
  if (details.warnings.length !== records.length || observed?.kind !== "agent")
    throw new Error("unexpected-scan-gap-shape");
  if (observed?.detectors?.length !== 1 || observed.detectors[0]?.id !== "aih-native" || observed.detectors[0]?.status !== "pass")
    throw new Error("unexpected-scan-native-detector-shape");
  return [
    { id: "coverage-agent-intake-kind", detail: "Artifact Intake records this npm package under supported generic kind agent." },
    ...records,
    { id: "coverage-native-only", detail: "Only optional aih-native passed; no deep detector produced a pass." },
    { id: "coverage-no-provenance", detail: "Registry identity and immutable bytes do not establish publisher provenance." },
    { id: "coverage-no-runtime-execution", detail: "No runtime import, API, package-manager behavior, or integration behavior was executed." },
  ].sort((left, right) => left.id.localeCompare(right.id));
}
function writeAssessmentPayload(admin, source, scan, capture, assessmentPath) {
  const payload = {
    format: "aih-local-npm-organization-assessment-payload",
    version: 1,
    source,
    immutableBytes: {
      tarballSha256: capture.capture.tarball.sha256,
      byteCaptureSha256: sha256(capture.bytes),
      extractedFactsSha256: sha256(capture.factsBytes),
      manifestSha256: capture.facts.manifest.sha256,
      licenseSha256: capture.facts.rights.sha256,
    },
    preflight: {
      state: scan.state,
      bundleSha256: sha256(scan.bytes),
      commandReportSha256: sha256(readFileSync(scan.commandPath)),
      findings: namedFindingRecords(source, scan),
      gaps: namedGapRecords(scan),
    },
    assessmentSha256: sha256(readFileSync(assessmentPath)),
  };
  const path = resolve(admin, `assessment-payload-${source.version}.json`);
  writeJson(path, payload);
  return { path, bytes: readFileSync(path), payload };
}
function conditionalTerms(source, scan, reviewBy, targetPath) {
  const findings = namedFindingRecords(source, scan).map((entry) => entry.id);
  const gaps = namedGapRecords(scan).map((entry) => entry.id);
  return {
    disposition: "accepted-with-conditions",
    acceptedFindings: findings,
    acceptedGaps: gaps,
    conditions: [
      `Only ${source.package}@${source.version} with ${source.integrity} may have the install effect in ${targetPath}, with npm scripts disabled.`,
      "AIH may only observe the already-installed lock and manifest identity; it may not execute package code.",
      `No production, host, global npm, publication, Catalog, GitHub, or Scanner authority is granted; review expires at ${reviewBy}.`,
    ].sort(),
    reviewBy,
  };
}
function candidate(core, source, scan, capture, suffix, issuedAt, expiresAt, reviewBy, governance) {
  const sourceDigest = core.governanceDecisionSourceDigestV2(source);
  const subject = {
    kind: "package",
    id: "picocolors-package",
    source,
    sourceDigest,
    subjectDigest: core.governanceDecisionSubjectDigestV2({
      kind: "package",
      id: "picocolors-package",
      sourceDigest,
    }),
  };
  const evidence = {
    format: "aih-organization-evidence",
    version: 1,
    subjectDigest: subject.subjectDigest,
    evidence: {
      kind: "assessment",
      id: `npm-scan-${suffix}`,
      summary: `Actual packed Core npm scan state ${scan.state}; scoped administrator assessment binds retained exact bytes.`,
      payloadDigest: sha256(governance.payload.bytes),
      artifactDigests: [
        sha256(scan.bytes),
        sha256(readFileSync(scan.commandPath)),
        sha256(capture.bytes),
        sha256(capture.factsBytes),
        sha256(readFileSync(governance.assessmentPath)),
        sha256(governance.payload.bytes),
      ].sort(),
    },
    attestor: governance.attestor,
    issuedAt,
    notBefore: issuedAt,
    expiresAt,
  };
  const evidenceText = stable(evidence);
  const evidenceDigest = sha256(`aih-organization-evidence/v1\0${evidenceText}`);
  const decision = {
    format: "aih-governance-decision",
    version: 2,
    id: `decision-org-npm-scan-${suffix}`,
    qualificationBasis: { kind: "organization-qualified", evidenceDigest, attestor: evidence.attestor },
    subject,
    targets: ["codex"],
    allowedEffects: ["install"],
    policy: { id: "local-disposable-npm-policy", version: "2026.09", digest: sha256(readFileSync(governance.policyPath)) },
    control: { id: "local-immutable-byte-observation", digest: sha256(readFileSync(governance.controlPath)) },
    evidence: { id: evidence.evidence.id, digest: evidenceDigest, attestor: evidence.attestor },
    issuer: governance.attestor,
    actor: governance.actor,
    reason: "The named local administrator may authorize only the exact install effect in a disposable root; AIH observes the scripts-disabled preinstalled identity and never executes package code. No production, host, publication, or Catalog authority is granted.",
    issuedAt,
    notBefore: issuedAt,
    expiresAt,
    ...conditionalTerms(source, scan, reviewBy, governance.targetPath),
  };
  return { source, subject, scan, capture, governance, evidenceText, decision, decisionDigest: core.governanceDecisionDigestV2(decision) };
}
function retainEvidenceEnvelope(admin, value) {
  const path = resolve(admin, `organization-evidence-${value.source.version}.json`);
  writeFileSync(path, value.evidenceText, "utf8");
  value.governance.evidencePath = path;
  return path;
}
function workbenchFields(value) {
  const { decision } = value;
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
    "protected-effects": "install",
    "protected-evidence-digest": decision.evidence.digest,
    "protected-evidence-id": decision.evidence.id,
    "protected-kind": "package",
    "protected-policy-digest": decision.policy.digest,
    "protected-policy-id": decision.policy.id,
    "protected-policy-version": decision.policy.version,
    "protected-qualification-kind": "organization-qualified",
    "protected-reason": decision.reason,
    "protected-review-by": decision.reviewBy ?? "",
    "protected-source-type": "npm",
    "protected-source-registry": decision.subject.source.registry,
    "protected-source-package": decision.subject.source.package,
    "protected-source-version": decision.subject.source.version,
    "protected-source-integrity": decision.subject.source.integrity,
    "protected-subject-id": decision.subject.id,
    "protected-targets": "codex",
  };
}
function assertAuthoredConditionalDecision(core, written, intended) {
  const expected = {
    disposition: intended.disposition,
    acceptedFindings: intended.acceptedFindings,
    acceptedGaps: intended.acceptedGaps,
    conditions: intended.conditions,
    reviewBy: intended.reviewBy,
    subjectDigest: intended.subject.subjectDigest,
    evidenceDigest: intended.evidence.digest,
  };
  const actual = {
    disposition: written?.disposition,
    acceptedFindings: written?.acceptedFindings,
    acceptedGaps: written?.acceptedGaps,
    conditions: written?.conditions,
    reviewBy: written?.reviewBy,
    subjectDigest: written?.subject?.subjectDigest,
    evidenceDigest: written?.evidence?.digest,
  };
  if (stable(actual) !== stable(expected) || core.governanceDecisionDigestV2(written) !== core.governanceDecisionDigestV2(intended))
    throw new Error("workbench-conditional-decision-mismatch");
}

export async function run832(context) {
assertAuthorized(context);
const tempBase = realpathSync.native(context.evidenceRoot);
const temp = realpathSync.native(mkdtempSync(join(tempBase, "aih-org-qualified-npm-")));
const retain = true;
try {
  const manifest = {name:'@aihq/core',version:'0.6.1'};
  const coreTarball = context.input.coreTarball;
  const consumer = context.consumer;
  const admin = resolve(temp, "admin");
  const target = resolve(temp, "target");
  mkdirSync(admin); mkdirSync(target);
  const operator = currentOperator();
  const policyPath = resolve(admin, "local-disposable-policy.md");
  const controlPath = resolve(admin, "local-disposable-control.md");
  writeFileSync(policyPath, 'Local disposable npm observation policy. Operator: '+operator.actor+'. Exact retained scan gaps are accepted only through the native browser decision; no corporate role or package execution authority.');
  writeFileSync(controlPath, 'Operator: '+operator.actor+'. Only scripts-disabled exact picocolors npm installation and read-only observation/lifecycle in the fresh target; revoke afterwards.');
  if (
    !readFileSync(policyPath, "utf8").includes(operator.actor) ||
    !readFileSync(controlPath, "utf8").includes(operator.actor)
  ) throw new Error("local-policy-operator-mismatch");
  const coreDir = resolve(consumer, "node_modules", "@aihq", "core");
  const cli = resolve(coreDir, "dist", "cli.js");
  if (!existsSync(cli)) throw new Error("packed-cli-missing");
  const core = await import(pathToFileURL(resolve(coreDir, "dist", "index.js")).href);
  const workbench = resolve(admin, "aih-policy-workbench.html");
  installedCli(admin, cli, ["policy", "generate", "--apply", "--out", workbench], "generate-packed-workbench");

  const firstSource = actualNpmSpec(admin, "picocolors", "1.1.0");
  const firstCapture = npmByteCapture(admin, resolve(admin, "bytes-1.1.0"), firstSource);
  const retainedScanRoot = context.scanRoot;
  const firstScan = retainedScanRoot === undefined
    ? scanActualNpmBytes(admin, cli, admin, firstSource, operator)
    : useRetainedNpmScan(retainedScanRoot, firstSource);
  const authorityIssuedAt = new Date().toISOString();
  const authorityExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const conditionalReviewBy = new Date(Date.parse(authorityIssuedAt) + 4 * 60 * 60 * 1000).toISOString();
  const firstAssessmentPath = writeLocalAssessment(admin, firstSource, firstScan, firstCapture, operator.actor, conditionalReviewBy);
  const firstPayload = writeAssessmentPayload(admin, firstSource, firstScan, firstCapture, firstAssessmentPath);
  const first = candidate(core, firstSource, firstScan, firstCapture, "110", authorityIssuedAt, authorityExpiresAt, conditionalReviewBy, { ...operator, assessmentPath: firstAssessmentPath, controlPath, policyPath, payload: firstPayload, targetPath: target });
  retainEvidenceEnvelope(admin, first);
  writeJson(resolve(admin, "candidate-decision-110.json"), first.decision);

  const secondSource = actualNpmSpec(admin, "picocolors", "1.1.1");
  const secondCapture = npmByteCapture(admin, resolve(admin, "bytes-1.1.1"), secondSource);
  const secondScan = retainedScanRoot === undefined
    ? scanActualNpmBytes(admin, cli, admin, secondSource, operator)
    : useRetainedNpmScan(retainedScanRoot, secondSource);
  const secondAssessmentPath = writeLocalAssessment(admin, secondSource, secondScan, secondCapture, operator.actor, conditionalReviewBy);
  const secondPayload = writeAssessmentPayload(admin, secondSource, secondScan, secondCapture, secondAssessmentPath);
  const second = candidate(core, secondSource, secondScan, secondCapture, "111", authorityIssuedAt, authorityExpiresAt, conditionalReviewBy, { ...operator, assessmentPath: secondAssessmentPath, controlPath, policyPath, payload: secondPayload, targetPath: target });
  retainEvidenceEnvelope(admin, second);
  writeJson(resolve(admin, "candidate-decision-111.json"), second.decision);

  if (false) {
    if (!retain) throw new Error("review-preparation-requires-AIH_NPM_GOVERNANCE_RETAIN=1");
    const preparation = {
      format: "organization-qualified-npm-review-preparation/v1",
      authorityExecuted: false,
      nextAuthorityRequirement: "A root-reviewed strict accepted-with-conditions decision authored by the built Workbench conditional form; no current candidate decision is authority.",
      operator,
      operatorAttribution: "Claimed local Git identity is self-asserted under the authorized delivery task; it is not verified corporate-role evidence or organization authority by itself.",
      reviewWindow: { issuedAt: authorityIssuedAt, reviewBy: conditionalReviewBy, expiresAt: authorityExpiresAt },
      scope: "The eventual Decision V2 may allow only install in this disposable root. Scripts-disabled npm materializes the package; AIH observes an already-installed lock and manifest and never executes package code.",
      adminRoot: admin,
      sources: [first.source, second.source],
      assessments: [
        { version: first.source.version, path: first.governance.assessmentPath, sha256: sha256(readFileSync(first.governance.assessmentPath)), evidencePath: first.governance.evidencePath, evidenceSha256: sha256(readFileSync(first.governance.evidencePath)), payloadPath: first.governance.payload.path, payloadSha256: sha256(first.governance.payload.bytes), scanBundleSha256: sha256(first.scan.bytes), scanCommandSha256: sha256(readFileSync(first.scan.commandPath)), byteCaptureSha256: sha256(first.capture.bytes), extractedFactsSha256: sha256(first.capture.factsBytes) },
        { version: second.source.version, path: second.governance.assessmentPath, sha256: sha256(readFileSync(second.governance.assessmentPath)), evidencePath: second.governance.evidencePath, evidenceSha256: sha256(readFileSync(second.governance.evidencePath)), payloadPath: second.governance.payload.path, payloadSha256: sha256(second.governance.payload.bytes), scanBundleSha256: sha256(second.scan.bytes), scanCommandSha256: sha256(readFileSync(second.scan.commandPath)), byteCaptureSha256: sha256(second.capture.bytes), extractedFactsSha256: sha256(second.capture.factsBytes) },
      ],
      conditionalDecisionDrafts: [first.decision, second.decision],
    };
    const reviewPath = resolve(context.evidenceRoot, `actual-832-review-preparation-${authorityIssuedAt.replace(/[^0-9]/gu, "")}.json`);
    writeJson(reviewPath, preparation);
    process.stdout.write(`Organization-qualified npm review preparation retained at ${reviewPath}; disposable evidence ${temp}\n`);
  } else {
  let protectedPolicyPath = resolve(admin, "protected-policy-2026.09.2.json");
  const chromiumAuthoringReports = [];
  const author = async (version, values, revoked = []) =>
    authorProtectedPolicyViaChromium({
      authorityFields: {
        "protected-bundle-version": version,
        "protected-issued-at": authorityIssuedAt,
        "protected-expires-at": authorityExpiresAt,
        "protected-issuer": operator.attestor,
        "protected-issuer-repository": `${operator.attestor}/local-disposable-admin`,
      },
      decisions: values.map(workbenchFields),
      htmlPath: workbench,
      outputPath: resolve(admin, `protected-policy-${version}.json`),
      reportPath: resolve(admin, `chromium-policy-authoring-${version}.json`),
      screenshotPath: resolve(admin, `chromium-conditions-${version}.png`),
      revokeDecisionIndexes: revoked,
      expectedRevocationDecisionDigests: revoked.map((index) => values[index]?.decisionDigest),
    });
  const activePolicyResult = await author("2026.09.2", [first, second]);
  chromiumAuthoringReports.push(activePolicyResult.report);
  const activePolicy = activePolicyResult.bundle;
  const firstWritten = activePolicy.authorityReceipt.decisions.find((entry) => entry.id === first.decision.id);
  const secondWritten = activePolicy.authorityReceipt.decisions.find((entry) => entry.id === second.decision.id);
  if (
    !firstWritten ||
    firstWritten.subject?.subjectDigest !== first.subject.subjectDigest ||
    firstWritten.evidence?.digest !== first.decision.evidence.digest ||
    !secondWritten ||
    secondWritten.subject?.subjectDigest !== second.subject.subjectDigest ||
    secondWritten.evidence?.digest !== second.decision.evidence.digest
  ) throw new Error("workbench-decision-binding-mismatch");
  assertAuthoredConditionalDecision(core, firstWritten, first.decision);
  assertAuthoredConditionalDecision(core, secondWritten, second.decision);
  // The protected Workbench is the decision author: it finalizes issuedAt/notBefore/expiresAt.
  first.decision = firstWritten;
  first.decisionDigest = core.governanceDecisionDigestV2(firstWritten);
  second.decision = secondWritten;
  second.decisionDigest = core.governanceDecisionDigestV2(secondWritten);
  if (!core.parsePolicyBundle(JSON.parse(readFileSync(protectedPolicyPath, "utf8"))).ok) throw new Error("workbench-active-policy-invalid");
  const env = { AIH_ORG_POLICY: protectedPolicyPath };
  const npmArgs = (mode, value, evidence, apply = false) => [
    "policy", mode, "npm-package", target,
    "--decision", value.decision.id, "--decision-digest", value.decisionDigest,
    "--target", "codex", ...(evidence ? ["--evidence", evidence] : []), ...(apply ? ["--apply"] : []), "--json",
  ];
  installTargetNpm(target, firstSource);
  writeFileSync(resolve(target, "evidence-110.json"), first.evidenceText);
  const observedFirst = installedCli(target, cli, npmArgs("observe", first, "evidence-110.json"), "observe-initial", false, env);
  const previewFirst = installedCli(target, cli, npmArgs("lifecycle", first, "evidence-110.json"), "lifecycle-initial-preview", false, env);
  const appliedFirst = installedCli(target, cli, npmArgs("lifecycle", first, "evidence-110.json", true), "lifecycle-initial-apply", false, env);

  installTargetNpm(target, secondSource);
  writeFileSync(resolve(target, "evidence-111.json"), second.evidenceText);
  const observedSecond = installedCli(target, cli, npmArgs("observe", second, "evidence-111.json"), "observe-bump", false, env);
  const appliedSecond = installedCli(target, cli, npmArgs("lifecycle", second, "evidence-111.json", true), "lifecycle-bump-apply", false, env);

  const revokedPolicyResult = await author("2026.09.3", [first, second], [1]);
  chromiumAuthoringReports.push(revokedPolicyResult.report);
  const revokedPolicy = revokedPolicyResult.bundle;
  protectedPolicyPath = revokedPolicyResult.report.download.path;
  env.AIH_ORG_POLICY = protectedPolicyPath;
  if (revokedPolicy.authorityReceipt.decisionRevocations?.[0]?.decisionDigest !== second.decisionDigest)
    throw new Error("workbench-revocation-decision-mismatch");
  const revoked = installedCli(target, cli, npmArgs("lifecycle", second, "evidence-111.json", true), "lifecycle-revoke", true, env);
  const evaluated = installedCli(target, cli, ["policy", "evaluate", target, "--cli", "codex", "--json"], "evaluate-revoked", true, env);
  if (revoked.status === 0 || !revoked.stdout.includes("decision-revoked") || !evaluated.stdout.includes("decision-revoked"))
    throw new Error(`revocation-not-retained:${revoked.status}:${revoked.stdout.slice(0, 1000)}:${evaluated.stdout.slice(0, 1000)}`);

  await recheck(context);
  const report = {
    format: "organization-qualified-npm-acceptance/v1",
    publicRelease: { qualificationSha256: context.input.qualificationSha256, registryIntegrity: context.binding.registryIntegrity },
    claim: "Actual public Core0.6.1 disposable-target organization-qualified npm lifecycle. Protected local PolicyBundle V2 is the authority transport; no GitHub authority attestation or Catalog qualification is claimed.",
    package: { core: { name: manifest.name, version: manifest.version, tarballSha256: sha256(readFileSync(coreTarball)) }, initial: first.source, bump: second.source },
    scans: [
      { version: first.source.version, state: first.scan.state, commandExit: first.scan.scanExit, bundleSha256: sha256(first.scan.bytes), commandSha256: sha256(readFileSync(first.scan.commandPath)), byteCaptureSha256: sha256(first.capture.bytes), extractedFactsSha256: sha256(first.capture.factsBytes), manifestSha256: first.capture.facts.manifest.sha256, licenseSha256: first.capture.facts.rights.sha256, assessmentSha256: sha256(readFileSync(first.governance.assessmentPath)) },
      { version: second.source.version, state: second.scan.state, commandExit: second.scan.scanExit, bundleSha256: sha256(second.scan.bytes), commandSha256: sha256(readFileSync(second.scan.commandPath)), byteCaptureSha256: sha256(second.capture.bytes), extractedFactsSha256: sha256(second.capture.factsBytes), manifestSha256: second.capture.facts.manifest.sha256, licenseSha256: second.capture.facts.rights.sha256, assessmentSha256: sha256(readFileSync(second.governance.assessmentPath)) },
    ],
    authority: { transport: "administrator-protected-policy-bundle-v2", path: protectedPolicyPath, sha256: sha256(readFileSync(protectedPolicyPath)), chromiumAuthoringReports },
    decisions: [ { id: first.decision.id, digest: first.decisionDigest }, { id: second.decision.id, digest: second.decisionDigest } ],
    operations: {
      observedInitial: JSON.parse(observedFirst.stdout), lifecycleInitialPreview: JSON.parse(previewFirst.stdout), lifecycleInitialApplied: JSON.parse(appliedFirst.stdout), observedBump: JSON.parse(observedSecond.stdout), lifecycleBumpApplied: JSON.parse(appliedSecond.stdout), revoked: JSON.parse(revoked.stdout), evaluated: JSON.parse(evaluated.stdout),
    },
  };
  const data = operation => operation.digests[0].data;
  for (const key of ['observedInitial','observedBump']) {
    const observed=data(report.operations[key]);
    if(observed.authority!=='verified'||observed.qualification!=='organization-qualified'||observed.effective!=='observed-effective')throw new Error('released-npm-observation-not-effective');
  }
  for(const key of ['lifecycleInitialApplied','lifecycleBumpApplied'])if(report.operations[key].applied!==true||data(report.operations[key]).state!=='observed-effective')throw new Error('released-npm-lifecycle-not-effective');
  if(report.operations.lifecycleInitialPreview.applied!==false||data(report.operations.lifecycleInitialPreview).outcome!=='reported-only')throw new Error('released-npm-preview-effective');
  if(report.operations.revoked.applied!==true||data(report.operations.revoked).reason!=='decision-revoked')throw new Error('released-npm-revocation-missing');
  if(!data(report.operations.evaluated).blocking||!data(report.operations.evaluated).npmPackageLifecycle.some(row=>row.state==='revoked'&&row.reason==='decision-revoked'&&row.decision.digest===second.decisionDigest))throw new Error('released-npm-effective-revocation-missing');
  const retained = resolve(context.evidenceRoot, `actual-832-org-qualified-accountable-report-${authorityIssuedAt.replace(/[^0-9]/gu, "")}.json`);
  writeJson(retained, report);
  process.stdout.write(`Organization-qualified npm acceptance PASS; retained report ${retained}\n`);
  if (retain) process.stdout.write(`Retained disposable evidence ${temp}\n`);
  }
} finally {
  if (!retain) {
    const resolved = resolve(temp);
    if (!resolved.startsWith(`${tempBase}${sep}`)) throw new Error("unsafe-temp-cleanup");
    rmSync(resolved, { force: true, recursive: true });
  }
}

}
