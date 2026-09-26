import { type Dirent, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { parseStrictJsonObjectV1 } from "../contract/strict-json-v1.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import {
  loadScanPackageExportsV1,
  scanPackageExportsOrThrowV1,
} from "../scan-package/load-scan-package.js";
import { BASELINE_CATALOG_IDS } from "./catalogs.js";
import { checkoutHeadV1 } from "./committed-checkout.js";
import { generateAuthorizedEccInstallPreview } from "./ecc-preview-boundary.js";
import { prepareRegisteredScannerCatalogV1 } from "./scanner-catalog-consumer.js";
import { createCoreBaselineVetRequests } from "./scanner-consumer.js";
import {
  resolveScannerDefinitionV1,
  type ScannerDefinitionOverlapModeV1,
} from "./scanner-definition.js";
import {
  consumeScannerBaselinePublicationsV1,
  consumeScannerBaselinePublicationV1,
  SCANNER_BASELINE_PUBLICATION_MAX_AGE_SECONDS_V1,
  type ScannerBaselinePublicationPublisherV1,
} from "./scanner-publication.js";
import { scannerBaselinePublicationPublisherForLocatorV1 } from "./scanner-publication-policy.js";
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

function discoveryPublisher(bytes: Buffer): ScannerBaselinePublicationPublisherV1 {
  let discovery: Record<string, unknown>;
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) fail("discovery publisher encoding");
    discovery = parseStrictJsonObjectV1(text, "discovery publisher");
  } catch {
    return fail("discovery publisher shape");
  }
  // This selects an independently reviewed policy, not trust. The consumer still
  // verifies all discovery, publication, signature, request, and freshness bindings.
  return (
    scannerBaselinePublicationPublisherForLocatorV1(discovery.locator) ??
    fail("discovery must name a reviewed immutable publisher")
  );
}

function definitionOverlap(
  args: readonly string[],
  definitionPath: string | undefined,
): ScannerDefinitionOverlapModeV1 | undefined {
  const overlap = optionalFlag(args, "--definition-overlap");
  if (overlap === undefined) return undefined;
  if (definitionPath === undefined) fail("--definition-overlap requires --definition");
  if (overlap !== "disjoint" && overlap !== "compiler-catalog")
    fail("--definition-overlap must be disjoint|compiler-catalog");
  return overlap;
}

/** A framework subject: the ids whose catalog is a framework definition (D79's scope). */
function isFrameworkCatalogIdV1(id: string): boolean {
  return (BASELINE_CATALOG_IDS as readonly string[]).includes(id);
}

/**
 * `--definition` stands in for the installed Catalog only at a pin that Catalog does not
 * carry; a carried pin keeps the installed route, and a definition that differs from the
 * carried one is refused. Nothing falls back from one route to the other. A definition's
 * components must be disjoint unless `--definition-overlap compiler-catalog` names the
 * overlapping-views exception.
 *
 * D79: for a FRAMEWORK (one of `BASELINE_CATALOG_IDS`), the definition the resolver returns is
 * the definition authority for this checkout — request authoring, publication consumption and
 * the install preview all use exactly it. A carried COLLECTION keeps its registered route
 * (snapshot bytes, coverage, coverage output), and so does any subject at a pin the installed
 * Catalog does not carry; the registered route applies whenever no definition is supplied.
 */
function assertCheckout(root: string, catalogId: string, args: readonly string[]) {
  const definitionPath = optionalFlag(args, "--definition");
  const overlap = definitionOverlap(args, definitionPath);
  if (definitionPath !== undefined) {
    const resolved = resolveScannerDefinitionV1({
      sourceRoot: root,
      catalogId,
      definitionPath: resolve(definitionPath),
      head: checkoutHeadV1(root),
      ...(overlap === undefined ? {} : { overlap }),
    });
    if (isFrameworkCatalogIdV1(catalogId) || resolved.route === "definition")
      return { catalog: resolved.catalog, coverage: undefined, coverageDigest: undefined };
  }
  const prepared = prepareRegisteredScannerCatalogV1(root, catalogId);
  const { catalog } = prepared;
  const head = checkoutHeadV1(root);
  if (head !== catalog.pinnedSha) {
    fail(`${catalog.id} checkout is ${head}, expected ${catalog.pinnedSha}`);
  }
  return prepared;
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

async function request(args: readonly string[]): Promise<void> {
  const catalogId = flag(args, "--catalog");
  const sourceRoot = resolve(flag(args, "--source"));
  const prepared = assertCheckout(sourceRoot, catalogId, args);
  const output = newDirectory(flag(args, "--output"));
  const { catalog } = prepared;
  const authored = createCoreBaselineVetRequests(sourceRoot, catalog);
  const { canonicalBaselineVetRequestV1Bytes } = scanPackageExportsOrThrowV1(
    await loadScanPackageExportsV1(["canonicalBaselineVetRequestV1Bytes"]),
  );
  for (const [index, batch] of authored.entries()) {
    const name = `batch-${String(index + 1).padStart(3, "0")}.request.json`;
    writeFileSync(join(output, name), canonicalBaselineVetRequestV1Bytes(batch), { flag: "wx" });
  }
  if (prepared.coverage !== undefined) {
    writeJson(join(output, "coverage-map.json"), {
      ...prepared.coverage,
      coverageDigest: prepared.coverageDigest,
      requestSha256: authored.map((batch) => batch.requestSha256),
    });
  }
  process.stdout.write(`authored ${authored.length} bounded Scanner request(s)\n`);
}

async function consumePublication(args: readonly string[]): Promise<void> {
  const catalogId = flag(args, "--catalog");
  const sourceRoot = resolve(flag(args, "--source"));
  const { catalog } = assertCheckout(sourceRoot, catalogId, []);
  const seenPath = optionalFlag(args, "--seen");
  const seen =
    seenPath === undefined ? { digests: [], receipts: [] } : replayWire.parse(readJson(seenPath));
  const discoveryBytes = readPublishedBytes(flag(args, "--discovery"), 8 * 1024, "discovery");
  const publisher = discoveryPublisher(discoveryBytes);
  const consumed = await consumeScannerBaselinePublicationV1({
    sourceRoot,
    catalog,
    expectedRequestSha256: flag(args, "--request-sha256"),
    discoveryBytes,
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
    publisher,
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

function closedPublicationBatches(
  root: string,
  requestDigests: readonly string[],
): readonly Readonly<{
  expectedRequestSha256: string;
  discoveryBytes: Buffer;
  publicationBytes: Buffer;
  attestationResultBytes: Buffer;
}>[] {
  const expectedNames = requestDigests.map(
    (_, index) => `batch-${String(index + 1).padStart(3, "0")}`,
  );
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return fail("publication root shape");
  }
  const actualNames = entries.map((entry) => entry.name).sort();
  if (
    entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink()) ||
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  )
    fail("publication batch layout");
  return expectedNames.map((name, index) => {
    const batch = join(root, name);
    const children = readdirSync(batch, { withFileTypes: true });
    const expectedFiles = ["attestation.json", "discovery.json", "publication.json"];
    const actualFiles = children.map((entry) => entry.name).sort();
    if (
      children.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
      actualFiles.length !== expectedFiles.length ||
      actualFiles.some((entry, fileIndex) => entry !== expectedFiles[fileIndex])
    )
      fail(`publication ${name} layout`);
    return {
      expectedRequestSha256: requestDigests[index] as string,
      discoveryBytes: readPublishedBytes(join(batch, "discovery.json"), 8 * 1024, "discovery"),
      publicationBytes: readPublishedBytes(
        join(batch, "publication.json"),
        96 * 1024 * 1024,
        "publication",
      ),
      attestationResultBytes: readPublishedBytes(
        join(batch, "attestation.json"),
        256 * 1024,
        "attestation",
      ),
    };
  });
}

async function consumePublications(args: readonly string[]): Promise<void> {
  const catalogId = flag(args, "--catalog");
  const sourceRoot = resolve(flag(args, "--source"));
  const publicationRoot = resolve(flag(args, "--publication-root"));
  const { catalog } = assertCheckout(sourceRoot, catalogId, args);
  const requests = createCoreBaselineVetRequests(sourceRoot, catalog);
  const seenPath = optionalFlag(args, "--seen");
  const seen =
    seenPath === undefined ? { digests: [], receipts: [] } : replayWire.parse(readJson(seenPath));
  const publications = closedPublicationBatches(
    publicationRoot,
    requests.map((request) => request.requestSha256),
  );
  const publishers = publications.map((publication) =>
    discoveryPublisher(publication.discoveryBytes),
  );
  const publisher = publishers[0];
  if (publisher === undefined || publishers.some((entry) => entry.commit !== publisher.commit))
    fail("publication batches must use one reviewed publisher");
  const consumed = await consumeScannerBaselinePublicationsV1({
    sourceRoot,
    catalog,
    publications,
    publisher,
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
    `consumed ${requests.length} published ${consumed.evidence.id} batch(es)@${consumed.evidence.pinnedSha}\n`,
  );
}

function sourceEvidence(path: string): BaselineSourceEvidence {
  return BaselineSourceEvidenceSchema.parse(readJson(path, 16 * 1024 * 1024));
}

function assemble(args: readonly string[]): void {
  const eccRoot = resolve(flag(args, "--ecc-root"));
  const { catalog: eccCatalog } = assertCheckout(eccRoot, "ecc", args);
  const ecc = sourceEvidence(flag(args, "--ecc-evidence"));
  const superpowers = sourceEvidence(flag(args, "--superpowers-evidence"));
  const lock = parseBaselineEvidenceLock({ schemaVersion: 2, sources: [ecc, superpowers] });
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
  if (command === "request") await request(args);
  else if (command === "consume-publication") await consumePublication(args);
  else if (command === "consume-publications") await consumePublications(args);
  else if (command === "assemble") assemble(args);
  else fail("expected request, consume-publication, consume-publications, or assemble");
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  runScannerBridge(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
