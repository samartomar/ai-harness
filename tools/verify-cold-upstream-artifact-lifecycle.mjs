import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (typeof npmCli !== "string" || !isAbsolute(npmCli) || !existsSync(npmCli))
  throw new Error("cold-upstream-artifact-npm-cli-unavailable");

function runNode(cwd, args) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `cold-upstream-artifact-command-failed:${args.join(" ")}:${(result.stderr || result.stdout).slice(0, 200)}`,
    );
  return result;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

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
      `cold-upstream-artifact-cli-failed:${args.join(" ")}:${(result.stderr || result.stdout).slice(0, 200)}`,
    );
  return result;
}

const tempBase = resolve(tmpdir());
const temp = mkdtempSync(join(tempBase, "aih-upstream-artifact-cold-"));
try {
  const packed = runNode(root, [npmCli, "pack", "--json", "--pack-destination", temp]);
  const packManifest = JSON.parse(packed.stdout);
  if (
    !Array.isArray(packManifest) ||
    packManifest[0]?.name !== "@aihq/core" ||
    typeof packManifest[0]?.filename !== "string"
  )
    throw new Error("cold-upstream-artifact-pack-manifest");

  const consumer = resolve(temp, "consumer");
  const target = resolve(temp, "target");
  mkdirSync(consumer);
  mkdirSync(target);
  writeFileSync(resolve(consumer, "package.json"), '{"name":"cold-upstream-artifact"}\n');
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
  const schema = resolve(installed, "schemas", "aih-upstream-artifact-manifest-v1.schema.json");
  if (!existsSync(cli) || !existsSync(bin) || !existsSync(schema))
    throw new Error("cold-upstream-artifact-install");

  writeFileSync(
    resolve(consumer, "verify-public.mjs"),
    [
      'import { canonicalUpstreamArtifactManifestV1, parseUpstreamArtifactManifestV1Bytes } from "@aihq/core";',
      'import { readFileSync } from "node:fs";',
      'import { createRequire } from "node:module";',
      'const sha = `sha256:${"a".repeat(64)}`;',
      'const manifest = { format: "aih-upstream-artifact-manifest", version: 1, decisionId: "decision-custom-mcp", subject: { kind: "mcp", id: "custom-mcp", sourceDigest: sha, subjectDigest: sha }, target: "codex", effect: "configure", integration: { owner: "organization-platform", version: "1.0.0" }, files: [{ path: ".codex/config.toml", sha256: sha }] };',
      "const bytes = Buffer.from(canonicalUpstreamArtifactManifestV1(manifest));",
      'if (parseUpstreamArtifactManifestV1Bytes(bytes)?.subject.id !== "custom-mcp") throw new Error("public parser rejected canonical manifest");',
      'if (parseUpstreamArtifactManifestV1Bytes(Buffer.from(`${bytes.toString("utf8")}\\n`)) !== undefined) throw new Error("public parser accepted noncanonical bytes");',
      "const require = createRequire(import.meta.url);",
      'const schemaPath = require.resolve("@aihq/core/schemas/aih-upstream-artifact-manifest-v1.schema.json");',
      'if (JSON.parse(readFileSync(schemaPath, "utf8")).title !== "aih-upstream-artifact-manifest-v1.schema.json") throw new Error("public schema unavailable");',
    ].join("\n"),
  );
  runNode(consumer, [resolve(consumer, "verify-public.mjs")]);

  for (const surface of [
    ["policy", "observe", "upstream-artifact", "--help"],
    ["policy", "lifecycle", "upstream-artifact", "--help"],
  ]) {
    const help = runInstalledCli(consumer, cli, bin, surface).stdout;
    for (const required of [
      "--decision <id>",
      "--decision-digest <sha256>",
      "--target <cli>",
      "--evidence <path>",
      "--manifest <path>",
      "--json",
    ])
      if (!help.includes(required))
        throw new Error(`cold-upstream-artifact-help:${surface.join(" ")}:${required}`);
  }

  for (const mode of ["observe", "lifecycle"]) {
    const args = [
      "policy",
      mode,
      "upstream-artifact",
      target,
      "--decision",
      "decision-custom-mcp",
      "--decision-digest",
      `sha256:${"b".repeat(64)}`,
      "--target",
      "codex",
      "--evidence",
      "evidence.json",
      "--manifest",
      "manifest.json",
      ...(mode === "lifecycle" ? ["--apply"] : []),
      "--json",
    ];
    const refused = runInstalledCli(target, cli, bin, args, true);
    if (!Number.isInteger(refused.status) || refused.status <= 0)
      throw new Error(`cold-upstream-artifact-unauthorized-${mode}-accepted`);
    if (!`${refused.stdout}\n${refused.stderr}`.includes("authority-unverified"))
      throw new Error(`cold-upstream-artifact-authority-boundary:${mode}`);
  }
  if (existsSync(resolve(target, ".aih", "governance", "upstream-artifact-lifecycle")))
    throw new Error("cold-upstream-artifact-refusal-wrote-lifecycle");

  const packedCore = await import(pathToFileURL(resolve(installed, "dist", "index.js")).href);
  for (const helper of [
    "canonicalUpstreamArtifactManifestV1",
    "governanceDecisionDigestV2",
    "governanceDecisionSourceDigestV2",
    "governanceDecisionSubjectDigestV2",
    "parsePolicyBundle",
  ]) {
    if (typeof packedCore[helper] !== "function")
      throw new Error(`cold-upstream-artifact-public-helper:${helper}`);
  }
  if (typeof packedCore.PolicyBundleSchema?.safeParse !== "function")
    throw new Error("cold-upstream-artifact-public-helper:PolicyBundleSchema");
  const now = new Date();
  const canonicalUtc = (value) => value.toISOString().replace(/\.\d{3}Z$/, "Z");
  const issuedAt = canonicalUtc(now);
  const expiresAt = canonicalUtc(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const revokedAt = new Date(Date.parse(issuedAt)).toISOString();
  const makeCandidate = (revision, integrationVersion) => {
    const artifactBytes = Buffer.from(`organization tool ${revision}\n`, "utf8");
    const source = {
      contentDigest: sha256(`reviewed organization tool ${revision}`),
      endpoint: "https://tools.example.invalid/catalog-independent/",
      type: "remote",
    };
    const sourceDigest = packedCore.governanceDecisionSourceDigestV2(source);
    const subject = {
      id: "custom-tool",
      kind: "tool",
      source,
      sourceDigest,
      subjectDigest: packedCore.governanceDecisionSubjectDigestV2({
        id: "custom-tool",
        kind: "tool",
        sourceDigest,
      }),
    };
    const decisionId = `decision-custom-tool-${revision}`;
    const manifest = {
      decisionId,
      effect: "use",
      files: [{ path: "vendor/custom-tool.txt", sha256: sha256(artifactBytes) }],
      format: "aih-upstream-artifact-manifest",
      integration: { owner: "organization-platform", version: integrationVersion },
      subject: {
        id: subject.id,
        kind: subject.kind,
        sourceDigest,
        subjectDigest: subject.subjectDigest,
      },
      target: "codex",
      version: 1,
    };
    const manifestText = packedCore.canonicalUpstreamArtifactManifestV1(manifest);
    const evidence = {
      attestor: "organization-scanner",
      evidence: {
        artifactDigests: [sha256(manifestText)],
        id: `scan-record-${revision}`,
        kind: "assessment",
        payloadDigest: sha256(`scanner payload ${revision}`),
        summary: "The organization reviewed this exact catalog-independent tool.",
      },
      expiresAt,
      format: "aih-organization-evidence",
      issuedAt,
      notBefore: issuedAt,
      subjectDigest: subject.subjectDigest,
      version: 1,
    };
    const evidenceText = stableJson(evidence);
    const evidenceDigest = sha256(`aih-organization-evidence/v1\0${evidenceText}`);
    const decision = {
      acceptedFindings: [],
      acceptedGaps: [],
      actor: "cold-admin",
      allowedEffects: ["use"],
      conditions: [],
      control: { digest: sha256("organization tool review control"), id: "review-control" },
      disposition: "approved",
      evidence: {
        attestor: evidence.attestor,
        digest: evidenceDigest,
        id: evidence.evidence.id,
      },
      expiresAt,
      format: "aih-governance-decision",
      id: decisionId,
      issuedAt,
      issuer: "platform-security",
      notBefore: issuedAt,
      policy: { digest: sha256("platform policy"), id: "platform-policy", version: "2026.08" },
      qualificationBasis: {
        attestor: evidence.attestor,
        evidenceDigest,
        kind: "organization-qualified",
      },
      reason: "The exact catalog-independent tool passed organization review.",
      subject,
      targets: ["codex"],
      version: 2,
    };
    return {
      artifactBytes,
      decision,
      decisionDigest: packedCore.governanceDecisionDigestV2(decision),
      evidenceText,
      manifestText,
    };
  };
  const first = makeCandidate("v1", "1.0.0");
  const second = makeCandidate("v2", "2.0.0");
  const artifactPath = resolve(target, "vendor", "custom-tool.txt");
  const manifestPath = resolve(target, "manifest.json");
  const evidencePath = resolve(target, "evidence.json");
  mkdirSync(dirname(artifactPath), { recursive: true });
  const writeCandidate = (candidate) => {
    writeFileSync(artifactPath, candidate.artifactBytes);
    writeFileSync(manifestPath, candidate.manifestText);
    writeFileSync(evidencePath, candidate.evidenceText);
  };
  writeCandidate(first);

  const admin = resolve(temp, "admin");
  const policyPath = resolve(admin, "policy-bundle.json");
  mkdirSync(admin);
  const writePolicy = (bundleVersion, decisions, decisionRevocations = []) =>
    writeFileSync(
      policyPath,
      stableJson({
        authorityReceipt: {
          decisionRevocations,
          decisions,
          expiresAt,
          format: "aih-policy-authority-receipt",
          issuedAt,
          issuerRepository: "example.invalid/cold-admin",
          targets: ["codex"],
          trustedIssuers: [
            { githubRepository: "example.invalid/cold-admin", id: "platform-security" },
          ],
          version: 3,
        },
        bundleVersion,
        issuedAt,
        issuer: "Cold administrator packed proof",
        policy: {
          governance: {
            catalog: { custom: [], reviewed: [] },
            policyVersion: "2026.08",
            supportedClis: ["claude", "codex"],
          },
          minimumPosture: "enterprise",
          references: { repoContract: "ai-coding/project.json" },
          schemaVersion: 2,
        },
        schemaVersion: 2,
      }),
    );
  writePolicy("2026.08.1", [first.decision]);
  if (!packedCore.parsePolicyBundle(JSON.parse(readFileSync(policyPath, "utf8"))).ok)
    throw new Error("cold-upstream-artifact-public-policy-bundle-parser");
  const authorityEnv = { AIH_ORG_POLICY: policyPath };
  const request = (mode, candidate, apply = false) => [
    "policy",
    mode,
    "upstream-artifact",
    target,
    "--decision",
    candidate.decision.id,
    "--decision-digest",
    candidate.decisionDigest,
    "--target",
    "codex",
    "--evidence",
    "evidence.json",
    "--manifest",
    "manifest.json",
    ...(apply ? ["--apply"] : []),
    "--json",
  ];
  const observedFirst = runInstalledCli(
    target,
    cli,
    bin,
    request("observe", first),
    false,
    authorityEnv,
  );
  if (!observedFirst.stdout.includes("observed-effective"))
    throw new Error("cold-upstream-artifact-v1-observation");
  const previewFirst = runInstalledCli(
    target,
    cli,
    bin,
    request("lifecycle", first),
    true,
    authorityEnv,
  );
  if (!previewFirst.stdout.includes("observed-effective"))
    throw new Error("cold-upstream-artifact-v1-preview");
  if (existsSync(resolve(target, ".aih", "governance", "upstream-artifact-lifecycle", "v1")))
    throw new Error("cold-upstream-artifact-preview-wrote-lifecycle");
  runInstalledCli(target, cli, bin, request("lifecycle", first, true), false, authorityEnv);

  writeCandidate(second);
  writePolicy("2026.08.2", [first.decision, second.decision]);
  const observedSecond = runInstalledCli(
    target,
    cli,
    bin,
    request("observe", second),
    false,
    authorityEnv,
  );
  if (!observedSecond.stdout.includes("observed-effective"))
    throw new Error("cold-upstream-artifact-v2-observation");
  runInstalledCli(target, cli, bin, request("lifecycle", second, true), false, authorityEnv);

  writeFileSync(artifactPath, "tampered\n");
  const drifted = runInstalledCli(
    target,
    cli,
    bin,
    request("observe", second),
    true,
    authorityEnv,
  );
  if (!Number.isInteger(drifted.status) || drifted.status <= 0)
    throw new Error("cold-upstream-artifact-drift-accepted");
  writeCandidate(second);

  writePolicy("2026.08.3", [first.decision, second.decision], [
    {
      decisionDigest: second.decisionDigest,
      format: "aih-governance-decision-revocation",
      issuer: second.decision.issuer,
      reason: "The disposable administrator revoked this exact tool decision.",
      revokedAt,
      version: 2,
    },
  ]);
  const revoked = runInstalledCli(
    target,
    cli,
    bin,
    request("lifecycle", second, true),
    true,
    authorityEnv,
  );
  if (!Number.isInteger(revoked.status) || revoked.status <= 0 || !revoked.stdout.includes("revoked"))
    throw new Error(`cold-upstream-artifact-revocation:${revoked.stdout.slice(0, 800)}`);
  const evaluated = runInstalledCli(
    target,
    cli,
    bin,
    ["policy", "evaluate", target, "--no-log", "--json"],
    true,
    authorityEnv,
  );
  if (!evaluated.stdout.includes("revoked"))
    throw new Error(`cold-upstream-artifact-history:${evaluated.stdout.slice(0, 800)}`);

  process.stdout.write(
    "Cold packed organization-managed artifact proof PASS (packed parser/schema/CLI; missing authority refused; protected PolicyBundle V2 observed and recorded a catalog-absent exact tool, appended an exact version update, refused drift, recorded revocation, and exposed durable history; no install, configuration, execution, or host-ACL claim)\n",
  );
} finally {
  const resolvedTemp = resolve(temp);
  if (!resolvedTemp.startsWith(`${tempBase}${sep}`)) throw new Error("unsafe-cold-proof-cleanup");
  rmSync(resolvedTemp, { force: true, recursive: true });
}
