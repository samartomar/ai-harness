import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalBaselineVetRequestV1Bytes } from "@aihq/scan";
import { z } from "zod";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import { hermeticGitEnv } from "../internals/git-env.js";
import { baselineCatalogById } from "./catalogs.js";
import { generateAuthorizedEccInstallPreview } from "./ecc-preview-boundary.js";
import { createCoreBaselineVetRequests } from "./scanner-consumer.js";
import {
  consumeScannerBaselinePublicationV1,
  SCANNER_BASELINE_PUBLICATION_MAX_AGE_SECONDS_V1,
  SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1,
} from "./scanner-publication.js";
import {
  type BaselineSourceEvidence,
  BaselineSourceEvidenceSchema,
  parseBaselineEvidenceLock,
} from "./schema.js";

const replayWire = z
  .object({
    digests: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(10_000),
    receipts: z
      .array(
        z
          .object({
            requestSha256: z.string().regex(/^[0-9a-f]{64}$/),
            receiptSha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();

function fail(message: string): never {
  throw new Error(`baseline Scanner bridge: ${message}`);
}

function flag(args: readonly string[], name: string): string {
  const indexes = args.flatMap((entry, index) => (entry === name ? [index] : []));
  if (indexes.length !== 1) fail(`${name} must appear exactly once`);
  const value = args[(indexes[0] as number) + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function optionalFlag(args: readonly string[], name: string): string | undefined {
  return args.includes(name) ? flag(args, name) : undefined;
}

function readJson(path: string, maximum = 2 * 1024 * 1024): unknown {
  const bytes = readFileSync(resolve(path));
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) fail(`unusable JSON file: ${path}`);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail(`non-UTF-8 JSON file: ${path}`);
  try {
    return JSON.parse(text);
  } catch {
    return fail(`invalid JSON file: ${path}`);
  }
}

function readPublishedBytes(path: string, maximum: number, label: string): Buffer {
  const opened = readRegularFileWithStats(resolve(path), { maxBytes: maximum });
  if (opened === undefined || opened.contents.length === 0 || opened.identity.nlink !== 1n)
    fail(`${label} file shape`);
  return opened.contents;
}

function checkoutHead(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: hermeticGitEnv(),
  }).trim();
}

function assertCheckout(root: string, catalogId: string) {
  const catalog = baselineCatalogById(catalogId);
  const head = checkoutHead(root);
  if (head !== catalog.pinnedSha) {
    fail(`${catalog.id} checkout is ${head}, expected ${catalog.pinnedSha}`);
  }
  return catalog;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function newDirectory(path: string): string {
  const resolved = resolve(path);
  mkdirSync(resolved, { recursive: false, mode: 0o700 });
  return resolved;
}

function request(args: readonly string[]): void {
  const catalogId = flag(args, "--catalog");
  const sourceRoot = resolve(flag(args, "--source"));
  const output = newDirectory(flag(args, "--output"));
  const catalog = assertCheckout(sourceRoot, catalogId);
  const authored = createCoreBaselineVetRequests(sourceRoot, catalog);
  for (const [index, batch] of authored.entries()) {
    const name = `batch-${String(index + 1).padStart(3, "0")}.request.json`;
    writeFileSync(join(output, name), canonicalBaselineVetRequestV1Bytes(batch), { flag: "wx" });
  }
  process.stdout.write(`authored ${authored.length} bounded Scanner request(s)\n`);
}

async function consumePublication(args: readonly string[]): Promise<void> {
  const catalogId = flag(args, "--catalog");
  const sourceRoot = resolve(flag(args, "--source"));
  const catalog = assertCheckout(sourceRoot, catalogId);
  const seenPath = optionalFlag(args, "--seen");
  const seen =
    seenPath === undefined ? { digests: [], receipts: [] } : replayWire.parse(readJson(seenPath));
  const consumed = await consumeScannerBaselinePublicationV1({
    sourceRoot,
    catalog,
    expectedRequestSha256: flag(args, "--request-sha256"),
    discoveryBytes: readPublishedBytes(flag(args, "--discovery"), 8 * 1024, "discovery"),
    publicationBytes: readPublishedBytes(
      flag(args, "--publication"),
      96 * 1024 * 1024,
      "publication",
    ),
    attestationResultBytes: readPublishedBytes(
      flag(args, "--attestation"),
      256 * 1024,
      "attestation",
    ),
    publisher: SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1,
    now: new Date().toISOString(),
    maxAgeSeconds: SCANNER_BASELINE_PUBLICATION_MAX_AGE_SECONDS_V1,
    seenEvidenceDigests: seen.digests,
    seenReceiptBindings: seen.receipts,
  });
  const output = resolve(flag(args, "--output"));
  const provenanceOutput = resolve(flag(args, "--provenance-output"));
  if (output === provenanceOutput) fail("evidence and provenance outputs must differ");
  writeJson(output, consumed.evidence);
  writeJson(provenanceOutput, consumed.provenance);
  process.stdout.write(
    `consumed published ${consumed.evidence.id}@${consumed.evidence.pinnedSha}\n`,
  );
}

function sourceEvidence(path: string): BaselineSourceEvidence {
  return BaselineSourceEvidenceSchema.parse(readJson(path, 16 * 1024 * 1024));
}

function assemble(args: readonly string[]): void {
  const eccRoot = resolve(flag(args, "--ecc-root"));
  const eccCatalog = assertCheckout(eccRoot, "ecc");
  const ecc = sourceEvidence(flag(args, "--ecc-evidence"));
  const superpowers = sourceEvidence(flag(args, "--superpowers-evidence"));
  const lock = parseBaselineEvidenceLock({ schemaVersion: 1, sources: [ecc, superpowers] });
  const preview = generateAuthorizedEccInstallPreview({
    eccRoot,
    catalog: eccCatalog,
    evidence: ecc,
  });
  writeJson(flag(args, "--out"), lock);
  writeJson(flag(args, "--preview-out"), preview);
  process.stdout.write(`assembled ${lock.sources.length} Scanner-vetted baseline sources\n`);
}

export async function runScannerBridge(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === "request") request(args);
  else if (command === "consume-publication") await consumePublication(args);
  else if (command === "assemble") assemble(args);
  else fail("expected request, consume-publication, or assemble");
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  runScannerBridge(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
