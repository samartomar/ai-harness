import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (typeof npmCli !== "string" || !isAbsolute(npmCli) || !existsSync(npmCli))
  throw new Error("npm-cli-unavailable");

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function runNode(cwd, args) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`cold-managed-usage-command-failed:${args.join(" ")}:${result.stderr.slice(0, 160)}`);
  return result;
}

function runInstalledCli(cwd, cli, bin, args, allowFailure = false, extraEnv = {}) {
  const env = { ...process.env };
  delete env.AIH_POLICY_AUTHORITY_REPOSITORY;
  delete env.AIH_POLICY_AUTHORITY_WORKFLOW;
  delete env.AIH_ORG_POLICY;
  Object.assign(env, extraEnv);
  const result = spawnSync(
    process.platform === "win32" ? process.execPath : bin,
    process.platform === "win32" ? [cli, ...args] : args,
    { cwd, encoding: "utf8", env },
  );
  if (result.status !== 0 && !allowFailure)
    throw new Error(
      `cold-managed-usage-cli-failed:${args.join(" ")}:${result.stderr.slice(0, 160)}`,
    );
  return result;
}

const tempBase = resolve(tmpdir());
const temp = mkdtempSync(join(tempBase, "aih-managed-usage-cold-"));
try {
  const packed = runNode(root, [npmCli, "pack", "--json", "--pack-destination", temp]);
  const packManifest = JSON.parse(packed.stdout);
  if (
    !Array.isArray(packManifest) ||
    packManifest[0]?.name !== "@aihq/core" ||
    typeof packManifest[0]?.filename !== "string"
  )
    throw new Error("cold-managed-usage-pack-manifest");

  const consumer = resolve(temp, "consumer");
  const target = resolve(temp, "target");
  mkdirSync(consumer);
  mkdirSync(target);
  writeFileSync(resolve(consumer, "package.json"), '{"name":"cold-aih-managed-usage"}');
  runNode(consumer, [
    npmCli,
    "install",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    resolve(temp, packManifest[0].filename),
  ]);

  const installed = resolve(consumer, "node_modules", "@aihq", "core");
  const cli = resolve(installed, "dist", "cli.js");
  const bin = resolve(consumer, "node_modules", ".bin", "aih");
  if (!existsSync(cli) || !existsSync(bin)) throw new Error("cold-managed-usage-install");

  const described = runInstalledCli(consumer, cli, bin, [
    "policy",
    "managed",
    "usage-metering",
    "describe",
    "--json",
  ]);
  const describeResult = JSON.parse(described.stdout);
  const descriptor = describeResult.digests?.[0]?.data;
  if (
    descriptor?.adapter?.id !== "aih-usage-metering" ||
    descriptor?.adapter?.version !== "1.0.0" ||
    descriptor?.effect !== "configure" ||
    descriptor?.subject?.kind !== "tool" ||
    descriptor?.subject?.id !== "usage-metering" ||
    descriptor?.subject?.source?.type !== "aih" ||
    !/^sha256:[0-9a-f]{64}$/.test(descriptor?.adapter?.digest ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(descriptor?.subject?.subjectDigest ?? "") ||
    JSON.stringify(descriptor?.targets) !== '["claude","codex"]'
  )
    throw new Error("cold-managed-usage-descriptor");

  const inspectedBefore = runInstalledCli(target, cli, bin, [
    "policy",
    "managed",
    "usage-metering",
    "inspect",
    target,
    "--json",
  ]);
  const before = JSON.parse(inspectedBefore.stdout).digests?.[0]?.data;
  if (before?.state !== "absent") throw new Error("cold-managed-usage-initial-inspection");

  const now = new Date();
  const canonicalUtc = (value) => value.toISOString().replace(/\.\d{3}Z$/, "Z");
  const issuedAt = canonicalUtc(now);
  const expiresAt = canonicalUtc(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const revokedAt = new Date(Date.parse(issuedAt)).toISOString();
  const evidencePath = resolve(target, "organization-evidence.json");
  const evidence = {
    attestor: "cold-administrator-proof",
    evidence: {
      artifactDigests: [`sha256:${"2".repeat(64)}`],
      id: "cold-proof-record",
      kind: "assessment",
      payloadDigest: `sha256:${"1".repeat(64)}`,
      summary: "Disposable evidence for the packed organization-authority proof.",
    },
    expiresAt,
    format: "aih-organization-evidence",
    issuedAt,
    notBefore: issuedAt,
    subjectDigest: descriptor.subject.subjectDigest,
    version: 1,
  };
  const evidenceText = stableJson(evidence);
  writeFileSync(evidencePath, evidenceText);
  const refused = runInstalledCli(
    target,
    cli,
    bin,
    [
      "policy",
      "managed",
      "usage-metering",
      "reconcile",
      target,
      "--decision",
      "decision-cold-managed-usage",
      "--decision-digest",
      `sha256:${"3".repeat(64)}`,
      "--target",
      "claude",
      "--evidence",
      "organization-evidence.json",
      "--apply",
      "--json",
    ],
    true,
  );
  if (!Number.isInteger(refused.status) || refused.status <= 0)
    throw new Error("cold-managed-usage-unauthorized-effect-accepted");
  if (!`${refused.stdout}\n${refused.stderr}`.includes("authority-unverified"))
    throw new Error("cold-managed-usage-authority-boundary");

  const inspectedAfter = runInstalledCli(target, cli, bin, [
    "policy",
    "managed",
    "usage-metering",
    "inspect",
    target,
    "--json",
  ]);
  const after = JSON.parse(inspectedAfter.stdout).digests?.[0]?.data;
  if (after?.state !== "absent") throw new Error("cold-managed-usage-refusal-wrote-custody");
  for (const relative of [
    ".aih/org-policy-hook-receipt.json",
    ".aih/usage-record.mjs",
    ".gitignore",
    ".claude/settings.json",
    ".codex/hooks.json",
  ]) {
    if (existsSync(resolve(target, relative)))
      throw new Error(`cold-managed-usage-refusal-wrote-output:${relative}`);
  }

  const packedCore = await import(pathToFileURL(resolve(installed, "dist", "index.js")).href);
  if (
    typeof packedCore.governanceDecisionDigestV2 !== "function" ||
    typeof packedCore.parsePolicyBundle !== "function" ||
    typeof packedCore.PolicyBundleSchema?.safeParse !== "function"
  )
    throw new Error("cold-managed-usage-public-decision-helper");
  const evidenceDigest = `sha256:${createHash("sha256")
    .update(`aih-organization-evidence/v1\0${evidenceText}`, "utf8")
    .digest("hex")}`;
  const decision = {
    acceptedFindings: [],
    acceptedGaps: [],
    actor: "cold-admin",
    allowedEffects: ["configure"],
    conditions: [],
    control: { digest: `sha256:${"b".repeat(64)}`, id: "review-control" },
    disposition: "approved",
    evidence: {
      attestor: evidence.attestor,
      digest: evidenceDigest,
      id: evidence.evidence.id,
    },
    expiresAt,
    format: "aih-governance-decision",
    id: "decision-cold-managed-usage",
    issuedAt,
    issuer: "platform-security",
    notBefore: issuedAt,
    policy: { digest: `sha256:${"a".repeat(64)}`, id: "platform-policy", version: "2026.08" },
    qualificationBasis: {
      attestor: evidence.attestor,
      evidenceDigest,
      kind: "organization-qualified",
    },
    reason: "The disposable proof authorizes the exact packed AIH adapter.",
    subject: descriptor.subject,
    targets: ["claude", "codex"],
    version: 2,
  };
  const decisionDigest = packedCore.governanceDecisionDigestV2(decision);
  const admin = resolve(temp, "admin");
  const policyPath = resolve(admin, "policy-bundle.json");
  mkdirSync(admin);
  const authorityReceipt = (decisionRevocations) => ({
    decisionRevocations,
    decisions: [decision],
    expiresAt,
    format: "aih-policy-authority-receipt",
    issuedAt,
    issuerRepository: "example.invalid/cold-admin",
    targets: ["claude", "codex"],
    trustedIssuers: [
      { githubRepository: "example.invalid/cold-admin", id: "platform-security" },
    ],
    version: 3,
  });
  const writePolicy = (bundleVersion, decisionRevocations = []) =>
    writeFileSync(
      policyPath,
      stableJson({
        authorityReceipt: authorityReceipt(decisionRevocations),
        bundleVersion,
        issuedAt,
        issuer: "Cold administrator packed proof",
        policy: {
          governance: {
            catalog: { custom: [], reviewed: [] },
            policyVersion: "2026.08",
            supportedClis: ["claude"],
          },
          minimumPosture: "enterprise",
          references: { repoContract: "ai-coding/project.json" },
          schemaVersion: 2,
        },
        schemaVersion: 2,
      }),
    );
  writePolicy("2026.08.1");
  if (!packedCore.parsePolicyBundle(JSON.parse(readFileSync(policyPath, "utf8"))).ok)
    throw new Error("cold-managed-usage-public-policy-bundle-parser");
  const authorityEnv = { AIH_ORG_POLICY: policyPath };
  const request = [
    "policy",
    "managed",
    "usage-metering",
    "reconcile",
    target,
    "--decision",
    decision.id,
    "--decision-digest",
    decisionDigest,
    "--target",
    "claude",
    "--evidence",
    "organization-evidence.json",
    "--json",
  ];
  const preview = runInstalledCli(target, cli, bin, request, true, authorityEnv);
  if (!`${preview.stdout}\n${preview.stderr}`.includes("organization-qualified"))
    throw new Error(
      `cold-managed-usage-qualified-preview:${preview.status}:${preview.stdout.slice(0, 800)}:${preview.stderr.slice(0, 800)}`,
    );
  if (existsSync(resolve(target, ".aih", "org-policy-hook-receipt.json")))
    throw new Error("cold-managed-usage-preview-wrote-custody");

  runInstalledCli(target, cli, bin, [...request, "--apply"], false, authorityEnv);
  const configured = runInstalledCli(
    target,
    cli,
    bin,
    ["policy", "managed", "usage-metering", "inspect", target, "--json"],
    true,
    authorityEnv,
  );
  if (JSON.parse(configured.stdout).digests?.[0]?.data?.state !== "configured")
    throw new Error("cold-managed-usage-configure");

  writeFileSync(policyPath, "{}");
  const malformed = runInstalledCli(target, cli, bin, [...request, "--apply"], true, authorityEnv);
  if (!Number.isInteger(malformed.status) || malformed.status <= 0)
    throw new Error("cold-managed-usage-malformed-authority-accepted");
  const stillConfigured = runInstalledCli(target, cli, bin, [
    "policy",
    "managed",
    "usage-metering",
    "inspect",
    target,
    "--json",
  ]);
  if (JSON.parse(stillConfigured.stdout).digests?.[0]?.data?.state !== "configured")
    throw new Error("cold-managed-usage-malformed-authority-mutated");

  writePolicy("2026.08.2", [
    {
      decisionDigest,
      format: "aih-governance-decision-revocation",
      issuer: decision.issuer,
      reason: "The disposable cold administrator revoked this exact decision.",
      revokedAt,
      version: 2,
    },
  ]);
  const revokedRequest = request.filter(
    (value, index, values) => value !== "--evidence" && values[index - 1] !== "--evidence",
  );
  const revocationResult = runInstalledCli(
    target,
    cli,
    bin,
    [...revokedRequest, "--apply"],
    true,
    authorityEnv,
  );
  const inspected = runInstalledCli(
    target,
    cli,
    bin,
    ["policy", "managed", "usage-metering", "inspect", target, "--json"],
    true,
    authorityEnv,
  );
  const revokedState = JSON.parse(inspected.stdout).digests?.[0]?.data?.state;
  if (revokedState !== "revoked")
    throw new Error(
      `cold-managed-usage-revocation:${revocationResult.status}:${revocationResult.stdout.slice(0, 800)}:${revocationResult.stderr.slice(0, 800)}:${readFileSync(resolve(target, ".aih", "org-policy-hook-receipt.json"), "utf8").slice(0, 4000)}`,
    );
  if (existsSync(resolve(target, ".aih", "usage-record.mjs")))
    throw new Error("cold-managed-usage-revocation-left-recorder");

  process.stdout.write(
    "Cold packed AIH-managed usage-metering proof PASS (packed CLI; missing and malformed authority refused; protected PolicyBundle V2 configured, inspected, and revoked without fabricated GitHub authority; host ACL is outside this proof)\n",
  );
} finally {
  const resolvedTemp = resolve(temp);
  if (!resolvedTemp.startsWith(`${tempBase}${sep}`)) throw new Error("unsafe-cold-proof-cleanup");
  rmSync(resolvedTemp, { force: true, recursive: true });
}
