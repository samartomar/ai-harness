import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
  consumeVerifiedScannerBaseline,
  createCoreBaselineVetRequest,
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

function request(args: readonly string[]): void {
  const catalogId = flag(args, "--catalog");
  const sourceRoot = resolve(flag(args, "--source"));
  const output = resolve(flag(args, "--output"));
  const catalog = assertCheckout(sourceRoot, catalogId);
  const authored = createCoreBaselineVetRequest(sourceRoot, catalog);
  writeFileSync(output, canonicalBaselineVetRequestV1Bytes(authored), { flag: "wx" });
  process.stdout.write(`${authored.requestSha256}\n`);
}

async function consume(args: readonly string[]): Promise<void> {
  const catalogId = flag(args, "--catalog");
  const sourceRoot = resolve(flag(args, "--source"));
  const catalog = assertCheckout(sourceRoot, catalogId);
  const requestValue = parseBaselineVetRequestV1Json(
    readFileSync(resolve(flag(args, "--request")), "utf8"),
  );
  const result = readBaselineVetBundleV1({
    bundleDirectory: resolve(flag(args, "--bundle")),
  });
  const envelope = parseBaselineVetAttestationEnvelopeV1Json(
    readFileSync(resolve(flag(args, "--evidence")), "utf8"),
  );
  const expected = expectedWire.parse(readJson(flag(args, "--expected")));
  const seenPath = optionalFlag(args, "--seen");
  const seen =
    seenPath === undefined ? { digests: [], receipts: [] } : replayWire.parse(readJson(seenPath));
  const evidence = await consumeVerifiedScannerBaseline({
    sourceRoot,
    catalog,
    request: requestValue,
    result,
    envelope,
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

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "request") request(args);
  else if (command === "consume") await consume(args);
  else if (command === "assemble") assemble(args);
  else fail("expected request, consume, or assemble");
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
