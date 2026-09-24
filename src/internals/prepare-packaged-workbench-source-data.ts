import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BaselineCatalogSchema } from "../baseline-evidence/catalog.js";
import { admittedSourceFromCandidateBundleV1 } from "../baseline-evidence/scanner-catalog-consumer.js";
import { scannerBaselinePublicationPublisherForLocatorV1 } from "../baseline-evidence/scanner-publication-policy.js";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import type { PreparedEccRuntimeDescriptorV1 } from "../ecc/runtime-descriptor.js";
import {
  type AuthoringCatalogBundleV1,
  AuthoringCatalogBundleV1Schema,
} from "../org-policy/workbench/contracts.js";
import { PackagedSourceDataRecordV1Schema } from "../org-policy/workbench/core/packaged-source-data-record.js";
import { readSourceDataProofBlobV1 } from "../org-policy/workbench/core/source-data-proof-blobs.js";
import {
  prepareSourceDataScannerRuntimeFactsV1,
  SourceDataScannerProofV1Schema,
  sealPreparedEccRuntimeDescriptorV1,
} from "../org-policy/workbench/core/source-data-scanner.js";
import { readRegularFileWithStats } from "./fsxn.js";
import { hermeticGitEnv } from "./git-env.js";
import { sourceCompilerTemplateV1 } from "./workbench-source-data-material.js";

/** Encode already verified preparation for the mandatory connected release replay. */
export function preparePackagedWorkbenchSourceDataV1(input: {
  sourceBundle: AuthoringCatalogBundleV1;
  proof: unknown;
  compilerInput: unknown;
  proofRoot: string;
  source: { repository: string; commit: string };
  updateKind?: "evidence-only";
  runtimeDescriptor?: PreparedEccRuntimeDescriptorV1;
}) {
  const proof = SourceDataScannerProofV1Schema.parse(input.proof);
  const compilerBytes = canonicalStrictJsonBytesV1(input.compilerInput);
  const compilerDigest = createHash("sha256").update(compilerBytes).digest("hex");
  const compilerReference = proof.compilerInput as {
    version?: string;
    sha256?: string;
    bytes?: number;
  };
  if (
    compilerReference.version !== "source-compiler-input-blob/v1" ||
    compilerReference.sha256 !== compilerDigest ||
    compilerReference.bytes !== compilerBytes.length
  )
    throw new TypeError("Packaged compiler input does not match its original proof");
  const inlineBlobs: { sha256: string; bytes: number; bytesBase64: string }[] = [];
  const publicationBlobs: { sha256: string; bytes: number; url: string }[] = [];
  for (const batch of proof.batches) {
    if (!("version" in batch))
      throw new TypeError("Package preparation requires bounded proof blob references");
    const discoveryBytes = readSourceDataProofBlobV1(batch.discovery, input.proofRoot, 8_192);
    const attestationBytes = readSourceDataProofBlobV1(batch.attestation, input.proofRoot, 512_000);
    readSourceDataProofBlobV1(batch.publication, input.proofRoot, 12_000_000);
    const discovery = JSON.parse(discoveryBytes.toString("utf8"));
    if (typeof discovery.locator !== "string")
      throw new TypeError("Original publication locator missing");
    inlineBlobs.push(
      {
        sha256: batch.discovery.sha256,
        bytes: batch.discovery.bytes,
        bytesBase64: discoveryBytes.toString("base64"),
      },
      {
        sha256: batch.attestation.sha256,
        bytes: batch.attestation.bytes,
        bytesBase64: attestationBytes.toString("base64"),
      },
    );
    publicationBlobs.push({
      sha256: batch.publication.sha256,
      bytes: batch.publication.bytes,
      url: discovery.locator,
    });
  }
  const record = PackagedSourceDataRecordV1Schema.parse({
    version: "packaged-workbench-source-data/v1",
    sourceBundle: input.sourceBundle,
    ...(input.updateKind ? { updateKind: input.updateKind } : {}),
    source: input.source,
    scannerProof: proof,
    compilerTemplate: sourceCompilerTemplateV1(input.compilerInput),
    ...(input.runtimeDescriptor === undefined
      ? {}
      : { runtimeDescriptor: sealPreparedEccRuntimeDescriptorV1(input.runtimeDescriptor) }),
    inlineBlobs,
    publicationBlobs,
  });
  return {
    bytes: canonicalStrictJsonBytesV1(record).toString("utf8"),
    sha256: canonicalStrictJsonSha256V1(record),
  };
}

/** The four Scanner-published sources whose Catalog record carries packaged source data. */
const PROVIDERS = {
  "anthropics-skills": "anthropics/skills",
  ponytail: "DietrichGebert/ponytail",
  ecc: "affaan-m/ECC",
  superpowers: "obra/Superpowers",
} as const;
type ProviderV1 = keyof typeof PROVIDERS;

const FLAGS = [
  "--provider",
  "--source-root",
  "--publication-root",
  "--source-bundle",
  "--compiler-input",
  "--published-catalog",
  "--output",
] as const;
const USAGE =
  "Usage: prepare-packaged-workbench-source-data --provider <anthropics-skills|ponytail|ecc|superpowers> --source-root <pinned-checkout> --publication-root <batch-NNN/{discovery.json,publication.json,attestation.jsonl}> --source-bundle <catalog-compiled-single-source-bundle> --compiler-input <compiler-input> --published-catalog <requested-baseline-catalog> --output <new-json-file> [--update-kind evidence-only]";
const BATCH_FILES = ["attestation.jsonl", "discovery.json", "publication.json"];
const LIMITS = { discovery: 8_192, publication: 12_000_000, attestation: 512_000 };

function fail(message: string): never {
  throw new TypeError(`Packaged source data: ${message}`);
}

function parseArgs(args: readonly string[]) {
  const withUpdate = args.length === FLAGS.length * 2 + 2;
  if (
    (args.length !== FLAGS.length * 2 && !withUpdate) ||
    FLAGS.some(
      (flag, index) =>
        args[index * 2] !== flag || !args[index * 2 + 1] || args[index * 2 + 1]?.startsWith("--"),
    ) ||
    (withUpdate &&
      (args[FLAGS.length * 2] !== "--update-kind" ||
        args[FLAGS.length * 2 + 1] !== "evidence-only")) ||
    !Object.hasOwn(PROVIDERS, args[1] as string)
  )
    throw new TypeError(USAGE);
  const value = (flag: (typeof FLAGS)[number]) => args[FLAGS.indexOf(flag) * 2 + 1] as string;
  return {
    provider: value("--provider") as ProviderV1,
    sourceRoot: resolve(value("--source-root")),
    publicationRoot: resolve(value("--publication-root")),
    sourceBundle: resolve(value("--source-bundle")),
    compilerInput: resolve(value("--compiler-input")),
    publishedCatalog: resolve(value("--published-catalog")),
    output: resolve(value("--output")),
    updateKind: withUpdate ? ("evidence-only" as const) : undefined,
  };
}

function readBounded(path: string, maxBytes: number, label: string): Buffer {
  const opened = readRegularFileWithStats(path, { maxBytes });
  if (!opened || opened.contents.length === 0 || opened.identity.nlink !== 1n)
    fail(`${label} must be a bounded regular file`);
  return opened.contents;
}

function readJson(path: string, maxBytes: number, label: string): unknown {
  return parseStrictJsonObjectV1(readBounded(path, maxBytes, label).toString("utf8"), label);
}

/** batch-001 .. batch-NNN, each exactly the downloaded publication, discovery and attestation. */
function readBatches(root: string) {
  const entries = readdirSync(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.length === 0 ||
    names.length > 16 ||
    entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink()) ||
    names.some((name, index) => name !== `batch-${String(index + 1).padStart(3, "0")}`)
  )
    fail("the publication root must hold exactly batch-001 .. batch-NNN (at most 16)");
  return names.map((name) => {
    const directory = join(root, name);
    const files = readdirSync(directory, { withFileTypes: true });
    if (
      files.length !== BATCH_FILES.length ||
      files.some(
        (file) => !file.isFile() || file.isSymbolicLink() || !BATCH_FILES.includes(file.name),
      )
    )
      fail(`${name} must hold exactly discovery.json, publication.json and attestation.jsonl`);
    const discovery = readBounded(join(directory, "discovery.json"), LIMITS.discovery, name);
    const locator = (
      parseStrictJsonObjectV1(discovery.toString("utf8"), `${name} discovery`) as {
        locator?: unknown;
      }
    ).locator;
    const publisher = scannerBaselinePublicationPublisherForLocatorV1(locator);
    if (publisher === undefined) fail(`${name} is not an allowlisted Scanner publication`);
    return {
      publisherCommit: publisher.commit,
      discovery,
      publication: readBounded(join(directory, "publication.json"), LIMITS.publication, name),
      attestation: readBounded(join(directory, "attestation.jsonl"), LIMITS.attestation, name),
    };
  });
}

function blob(proofRoot: string, bytes: Buffer) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = join(proofRoot, `${sha256}.blob`);
  if (!existsSync(path)) writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return { sha256, bytes: bytes.length };
}

/**
 * Internal preparation only. Rebuilds the source-data Scanner proof from downloaded
 * publications, replays it through Core's own verifier (gh attestation verify, source-byte
 * binding, installed Catalog authority) and encodes one packaged record. It never scans,
 * signs, or publishes, and never writes over an existing file.
 */
export async function preparePackagedWorkbenchSourceDataCommandV1(
  args: readonly string[],
): Promise<string> {
  const options = parseArgs(args);
  if (existsSync(options.output))
    throw new TypeError("EEXIST: packaged source data output must not already exist");
  const sourceId = `source:${options.provider}`;
  const repository = PROVIDERS[options.provider];
  const bundleValue = readJson(options.sourceBundle, 64 * 1024 * 1024, "source bundle");
  const admitted = admittedSourceFromCandidateBundleV1(bundleValue, sourceId);
  const sourceBundle = AuthoringCatalogBundleV1Schema.parse(bundleValue);
  const compilerInput = readJson(options.compilerInput, 64 * 1024 * 1024, "compiler input");
  const publishedCatalog = BaselineCatalogSchema.parse(
    readJson(options.publishedCatalog, 16 * 1024 * 1024, "published catalog"),
  );
  const [owner, repo] = repository.split("/");
  const pin = admitted.source.revision.id;
  if (
    publishedCatalog.owner !== owner ||
    publishedCatalog.repo !== repo ||
    publishedCatalog.pinnedSha !== pin
  )
    fail(`the published catalog must be ${repository}@${pin}`);
  const head = execFileSync("git", ["-C", options.sourceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    env: hermeticGitEnv(),
  }).trim();
  if (head !== pin)
    fail(`${options.provider} checkout is ${head}, the source bundle admits ${pin}`);
  const batches = readBatches(options.publicationRoot);
  const publisherCommit = batches[0]?.publisherCommit as string;
  if (batches.some((batch) => batch.publisherCommit !== publisherCommit))
    fail("every batch must come from one publisher commit");

  const proofRoot = mkdtempSync(join(tmpdir(), "aih-packaged-proof-"));
  try {
    const now = new Date().toISOString();
    const proof = {
      version: "source-data-scanner-proof/v1",
      compilerInput: {
        version: "source-compiler-input-blob/v1",
        ...blob(proofRoot, canonicalStrictJsonBytesV1(compilerInput)),
      },
      publishedCatalog,
      preparedAt: now,
      publisherCommit,
      batches: batches.map((batch) => ({
        version: "scanner-proof-blobs/v1",
        discovery: blob(proofRoot, batch.discovery),
        publication: blob(proofRoot, batch.publication),
        attestation: blob(proofRoot, batch.attestation),
      })),
    };
    const facts = await prepareSourceDataScannerRuntimeFactsV1(
      sourceBundle,
      proof,
      options.sourceRoot,
      now,
      undefined,
      now,
      proofRoot,
    );
    if (options.provider === "ecc" && facts.descriptor === undefined)
      fail("ecc verification produced no runtime descriptor");
    if (options.provider !== "ecc" && facts.descriptor !== undefined)
      fail("only ecc carries a runtime descriptor");
    const record = preparePackagedWorkbenchSourceDataV1({
      sourceBundle,
      proof,
      compilerInput,
      proofRoot,
      source: { repository, commit: head },
      ...(options.updateKind === undefined ? {} : { updateKind: options.updateKind }),
      ...(facts.descriptor === undefined ? {} : { runtimeDescriptor: facts.descriptor }),
    });
    writeFileSync(options.output, record.bytes, { flag: "wx", mode: 0o600 });
    return `Prepared packaged source data ${options.provider}@${head} sha256:${record.sha256}. No scan, signing, publication, or qualification was performed.`;
  } finally {
    rmSync(proofRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(await preparePackagedWorkbenchSourceDataCommandV1(process.argv.slice(2)));
