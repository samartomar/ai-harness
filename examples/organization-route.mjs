#!/usr/bin/env node
/**
 * The organization route through @aihq/core's public API: the operator supplies the
 * subject, the evidence and the authority; Core prepares a governance input, saves its
 * bytes, and consumes them in a fresh process.
 *
 * FICTIONAL ORGANIZATION. Every value you do not supply is invented for "example-org",
 * a fictional test organization: the subject `example-org/example-skill`, and an
 * assertion about it. None of it is evidence about anything real, none of it is official
 * AIH qualification, and a fictional organization's authority is
 * never production approval.
 *
 *   1. Read the subject (--subject, a JSON file holding {kind, id, source}) and the
 *      organization evidence envelope bytes (--evidence), or use the fictional ones.
 *   2. prepareGovernanceInputV1 with route "organization". A refusal writes nothing.
 *   3. Save the input and the evidence at their exact bytes under --out.
 *   4. Start a FRESH node process that reads only those saved files and calls
 *      consumeGovernanceInputV1. Authority is the administrator-protected policy bundle
 *      you name with --policy (passed as AIH_ORG_POLICY); without one, consumption fails
 *      closed at `authority-unverified`. Evidence that claims verified scanner evidence
 *      additionally needs a configured Scan verifier, which this example does not supply,
 *      so it refuses at `scan-verification-unavailable`.
 *
 * Consumption never installs, applies or executes anything. Exit codes: 0 consumed
 * without a refusal, 3 consumed and refused (the reason is printed), 2 bad usage or
 * a refused preparation.
 *
 *   node examples/organization-route.mjs --out <dir> [--subject <file>] [--evidence <file>]
 *     [--policy <file>] [--decision-id <id> --decision-digest sha256:<hex>]
 *     [--target claude] [--effect observe]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalOrganizationEvidenceEnvelopeV1,
  consumeGovernanceInputV1,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
  prepareGovernanceInputV1,
  SUPPORTED_CLIS,
} from "@aihq/core";

const INPUT_FILE = "governance-input.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The fictional organization's subject. It names no real repository. */
const FICTIONAL_SUBJECT = {
  kind: "skill",
  id: "example-skill",
  source: {
    type: "github",
    repository: "example-org/example-skill",
    commit: "1".repeat(40),
    path: "SKILL.md",
  },
};

function option(args, name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) usage(`${name} needs a value`);
  return value;
}

function usage(message) {
  process.stderr.write(`${message}\nSee the header of examples/organization-route.mjs.\n`);
  process.exit(2);
}

/** Step 4, in its own process: only the saved files cross from step 3. */
async function consume(directory) {
  const result = await consumeGovernanceInputV1({
    bytes: readFileSync(join(directory, INPUT_FILE)),
    root: directory,
    env: process.env,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: result.status,
        evidenceClaim: result.evidenceClaim,
        qualificationRoute: result.qualificationRoute,
        subjectDigest: result.subjectDigest,
        decisionDigest: result.decisionDigest,
        diagnostics: result.diagnostics,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = result.status.outcome === "refused" ? 3 : 0;
}

/** The fictional organization's assertion. It seals nothing and proves nothing. */
function fictionalEvidence(subjectDigest) {
  const now = Date.now();
  return canonicalOrganizationEvidenceEnvelopeV1({
    format: "aih-organization-evidence",
    version: 1,
    subjectDigest,
    evidence: {
      kind: "operator-assertion",
      id: "example-org-review",
      summary: "Fictional example-org assertion for a runnable example; not evidence and not approval.",
      payloadDigest: `sha256:${sha256("example-org fictional review payload")}`,
      artifactDigests: [`sha256:${sha256("example-org fictional review record")}`],
    },
    attestor: "example-org-review-board",
    issuedAt: new Date(now - 60_000).toISOString(),
    notBefore: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

async function main(args) {
  const consumeAt = option(args, "--consume");
  if (consumeAt !== undefined) return consume(resolve(consumeAt));

  const out = resolve(option(args, "--out") ?? usage("--out <dir> is required"));

  // 1. The operator's subject and evidence, or the fictional organization's.
  const subjectFile = option(args, "--subject");
  const subject =
    subjectFile === undefined ? FICTIONAL_SUBJECT : JSON.parse(readFileSync(subjectFile, "utf8"));
  const evidenceFile = option(args, "--evidence");
  const target = option(args, "--target", "claude");
  if (!SUPPORTED_CLIS.includes(target)) usage(`--target must be one of ${SUPPORTED_CLIS.join(", ")}`);

  // 2. Prepare. Core derives both digests; nothing is written unless it succeeds.
  let evidenceBytes;
  if (evidenceFile !== undefined) evidenceBytes = readFileSync(evidenceFile);
  else {
    const sourceDigest = governanceDecisionSourceDigestV2(subject.source);
    const subjectDigest = governanceDecisionSubjectDigestV2({
      kind: subject.kind,
      id: subject.id,
      sourceDigest,
    });
    evidenceBytes = new TextEncoder().encode(fictionalEvidence(subjectDigest));
  }
  const prepared = prepareGovernanceInputV1({
    route: "organization",
    subject: { kind: subject.kind, id: subject.id, source: subject.source },
    request: { target, effect: option(args, "--effect", "observe") },
    decisionReference: {
      id: option(args, "--decision-id", "decision-example-org"),
      digest: option(args, "--decision-digest", `sha256:${"1".repeat(64)}`),
    },
    evidenceBytes,
  });
  if (prepared.artifacts === undefined) {
    process.stderr.write(`${JSON.stringify(prepared, null, 2)}\n`);
    process.exit(2);
  }

  // 3. Save exact bytes.
  const { input, evidence } = prepared.artifacts;
  for (const artifact of [
    { path: INPUT_FILE, bytes: input.bytes },
    { path: evidence.path, bytes: evidence.bytes },
  ]) {
    const file = join(out, artifact.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, artifact.bytes);
    process.stdout.write(`saved ${artifact.path} sha256:${sha256(artifact.bytes)}\n`);
  }

  // 4. A fresh process consumes exactly the saved bytes, under the operator's authority.
  const policy = option(args, "--policy");
  const env = { ...process.env };
  if (policy === undefined) delete env.AIH_ORG_POLICY;
  else env.AIH_ORG_POLICY = resolve(policy);
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--consume", out], {
    stdio: "inherit",
    env,
  });
  process.exitCode = child.status ?? 1;
}

await main(process.argv.slice(2));
