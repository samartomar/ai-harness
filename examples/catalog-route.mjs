#!/usr/bin/env node
/**
 * The catalog route through @aihq/core's public API: select a catalog item, prepare a
 * governance input, save its bytes, and consume them in a fresh process.
 *
 * FICTIONAL ORGANIZATION. When you do not supply your own evidence, this script invents
 * an assertion by "example-org", a fictional test organization. That assertion is not
 * evidence about the selected item, it is not official AIH qualification, and it is
 * never production approval. Catalog identities are provided data, not authenticated
 * facts; the catalog index itself says `organizationAdmission: "not-authoritative"`.
 *
 *   1. Select one entry from a catalog index: the installed `@aihq/catalog/catalog-index.json`
 *      subpath, or a file you name with --index. Core recomputes both digests of the
 *      entry's identity and refuses the entry if either disagrees.
 *   2. prepareGovernanceInputV1 with route "catalog" and the organization evidence bytes
 *      (--evidence, or the fictional assertion). A refusal writes nothing.
 *   3. Save the input and the evidence at their exact bytes under --out.
 *   4. Start a FRESH node process that reads only those saved files and calls
 *      consumeGovernanceInputV1. Its assessment resolver returns the published assessment
 *      bytes you name with --assessment; Core consults it only for verified scanner
 *      evidence about an aih subject. Authority comes from AIH_ORG_POLICY when you set it;
 *      without it consumption fails closed at `authority-unverified`.
 *
 * Consumption never installs, applies or executes anything. Exit codes: 0 consumed
 * without a refusal, 3 consumed and refused (the reason is printed), 2 bad usage or
 * a refused preparation.
 *
 *   node examples/catalog-route.mjs --out <dir> [--index <file>] [--entry <entryId>]
 *     [--evidence <file>] [--assessment <file>] [--target claude] [--effect observe]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function option(args, name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) usage(`${name} needs a value`);
  return value;
}

function usage(message) {
  process.stderr.write(`${message}\nSee the header of examples/catalog-route.mjs.\n`);
  process.exit(2);
}

/** Step 4, in its own process: only the saved files cross from step 3. */
async function consume(directory) {
  const assessmentFile = process.env.EXAMPLE_ASSESSMENT_FILE;
  const result = await consumeGovernanceInputV1({
    bytes: readFileSync(join(directory, INPUT_FILE)),
    root: directory,
    env: process.env,
    ...(assessmentFile === undefined || assessmentFile === ""
      ? {}
      : { assessment: { readAssessment: () => readFileSync(assessmentFile) } }),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: result.status,
        evidenceClaim: result.evidenceClaim,
        bindingRoute: result.bindingRoute,
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

function readIndex(path) {
  if (path !== undefined) return JSON.parse(readFileSync(path, "utf8"));
  try {
    return JSON.parse(
      readFileSync(fileURLToPath(import.meta.resolve("@aihq/catalog/catalog-index.json")), "utf8"),
    );
  } catch {
    return usage("@aihq/catalog is not installed here; name a catalog index with --index <file>.");
  }
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
  const index = readIndex(option(args, "--index"));
  if (index?.format !== "aih-catalog-index" || index?.version !== 1)
    usage(`the catalog index declares ${index?.format} v${index?.version}, not aih-catalog-index v1`);
  process.stdout.write(`catalog organizationAdmission: ${index.organizationAdmission}\n`);

  // 1. Select one item and recompute its identity; a provided digest is never trusted.
  const entryId = option(args, "--entry", "agent.aih.governance-quality.core-0-6-2");
  const entry = index.entries?.find((candidate) => candidate.entryId === entryId);
  if (entry === undefined) usage(`the catalog index has no entry ${entryId}`);
  const { kind, id, source } = entry.subject;
  const sourceDigest = governanceDecisionSourceDigestV2(source);
  const subjectDigest = governanceDecisionSubjectDigestV2({ kind, id, sourceDigest });
  if (sourceDigest !== entry.subject.sourceDigest || subjectDigest !== entry.subject.subjectDigest)
    usage(`the catalog entry ${entryId} does not recompute to the digests it names`);

  // 2. Prepare. Nothing is written unless preparation succeeds.
  const evidencePath = option(args, "--evidence");
  const target = option(args, "--target", "claude");
  if (!SUPPORTED_CLIS.includes(target)) usage(`--target must be one of ${SUPPORTED_CLIS.join(", ")}`);
  const prepared = prepareGovernanceInputV1({
    route: "catalog",
    subject: { kind, id, source },
    request: { target, effect: option(args, "--effect", "observe") },
    // The organization's own decision reference; this one is fictional.
    decisionReference: { id: "decision-example-org", digest: `sha256:${"1".repeat(64)}` },
    evidenceBytes:
      evidencePath === undefined
        ? new TextEncoder().encode(fictionalEvidence(subjectDigest))
        : readFileSync(evidencePath),
    provenance: { catalogEntryId: entryId },
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

  // 4. A fresh process consumes exactly the saved bytes.
  const assessment = option(args, "--assessment");
  if (assessment !== undefined && !existsSync(assessment)) usage(`${assessment} does not exist`);
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--consume", out], {
    stdio: "inherit",
    env: { ...process.env, EXAMPLE_ASSESSMENT_FILE: assessment ? resolve(assessment) : "" },
  });
  process.exitCode = child.status ?? 1;
}

await main(process.argv.slice(2));
