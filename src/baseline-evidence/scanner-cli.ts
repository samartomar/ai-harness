import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalBaselineVetRequestV1Bytes,
  parseBaselineVetAttestationEnvelopeV1Json,
  parseBaselineVetRequestV1Json,
  readBaselineVetBundleV1,
} from "@aihq/scan";
import { z } from "zod";
import { hermeticGitEnv } from "../internals/git-env.js";
import { baselineCatalogById } from "./catalogs.js";
import { generateAuthorizedEccInstallPreview } from "./ecc-preview-boundary.js";
import {
  consumeVerifiedScannerBaselineBatches,
  createCoreBaselineVetRequests,
} from "./scanner-consumer.js";
import {
  type BaselineSourceEvidence,
  BaselineSourceEvidenceSchema,
  parseBaselineEvidenceLock,
} from "./schema.js";

const rootWire = z
  .object({
    identity: z.string().min(1).max(256),
    class: z.enum(["test-ephemeral", "organization"]),
    keyId: z.string().regex(/^ed25519:[0-9a-f]{64}$/),
    publicKeySpkiBase64: z.string().min(1).max(8_192),
  })
  .strict();
const rootsWire = z.object({ roots: z.array(rootWire).min(1).max(64) }).strict();
const signerWire = z
  .object({
    identity: z.string().min(1).max(256),
    class: z.enum(["test-ephemeral", "organization"]),
    keyId: z.string().regex(/^ed25519:[0-9a-f]{64}$/),
  })
  .strict();
const expectedWire = z.object({ now: z.string(), signer: signerWire }).strict();
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

function roots(path: string) {
  return rootsWire.parse(readJson(path)).roots.map((root) => ({
    identity: root.identity,
    class: root.class,
    keyId: root.keyId,
    publicKey: createPublicKey({
      key: Buffer.from(root.publicKeySpkiBase64, "base64"),
      format: "der",
      type: "spki",
    }),
  }));
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

function existingDirectory(path: string, label: string): string {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory`);
  return resolved;
}

function batchNames(path: string, suffix: string, label: string): readonly string[] {
  const root = existingDirectory(path, label);
  const names = readdirSync(root).sort();
  if (names.length === 0) fail(`${label} is empty`);
  for (const [index, name] of names.entries()) {
    const expected = `batch-${String(index + 1).padStart(3, "0")}${suffix}`;
    if (name !== expected) fail(`${label} must contain contiguous canonical batch names`);
    const stat = lstatSync(join(root, name));
    const validShape =
      suffix === ".bundle"
        ? stat.isDirectory() && !stat.isSymbolicLink()
        : stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
    if (!validShape) fail(`${label} contains an unsafe batch entry`);
  }
  return names;
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

async function consume(args: readonly string[]): Promise<void> {
  const catalogId = flag(args, "--catalog");
  const sourceRoot = resolve(flag(args, "--source"));
  const catalog = assertCheckout(sourceRoot, catalogId);
  const requestsRoot = existingDirectory(flag(args, "--requests"), "request batches");
  const bundlesRoot = existingDirectory(flag(args, "--bundles"), "bundle batches");
  const evidenceRoot = existingDirectory(flag(args, "--evidence"), "evidence batches");
  const requestNames = batchNames(requestsRoot, ".request.json", "request batches");
  const bundleNames = batchNames(bundlesRoot, ".bundle", "bundle batches");
  const evidenceNames = batchNames(evidenceRoot, ".evidence.json", "evidence batches");
  if (requestNames.length !== bundleNames.length || requestNames.length !== evidenceNames.length) {
    fail("request, bundle, and evidence batch counts differ");
  }
  const batches = requestNames.map((requestName, index) => ({
    request: parseBaselineVetRequestV1Json(readFileSync(join(requestsRoot, requestName), "utf8")),
    result: readBaselineVetBundleV1({
      bundleDirectory: join(bundlesRoot, bundleNames[index] ?? ""),
    }),
    envelope: parseBaselineVetAttestationEnvelopeV1Json(
      readFileSync(join(evidenceRoot, evidenceNames[index] ?? ""), "utf8"),
    ),
  }));
  const expected = expectedWire.parse(readJson(flag(args, "--expected")));
  const seenPath = optionalFlag(args, "--seen");
  const seen =
    seenPath === undefined ? { digests: [], receipts: [] } : replayWire.parse(readJson(seenPath));
  const evidence = await consumeVerifiedScannerBaselineBatches({
    sourceRoot,
    catalog,
    batches,
    roots: roots(flag(args, "--roots")),
    expected,
    seenEvidenceDigests: seen.digests,
    seenReceiptBindings: seen.receipts,
  });
  writeJson(flag(args, "--output"), evidence);
  process.stdout.write(`${evidence.id}@${evidence.pinnedSha}\n`);
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
  else if (command === "consume") await consume(args);
  else if (command === "assemble") assemble(args);
  else fail("expected request, consume, or assemble");
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  runScannerBridge(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
