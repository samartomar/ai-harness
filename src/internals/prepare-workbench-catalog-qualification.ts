import { lstatSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { canonicalStrictJsonBytesV1 } from "../contract/strict-json-v1.js";
import { parseAihSupportedQualificationReceiptV2Bytes } from "../org-policy/supported-qualification-receipt-v2.js";
import type { AuthoringCatalogBundleV1 } from "../org-policy/workbench/contracts.js";
import { CATALOG_RECEIPT_SET_MAX_BYTES } from "../org-policy/workbench/core/catalog-qualification-limits.js";
import { CATALOG_QUALIFICATION_RELEASE_POLICY_V1 } from "../org-policy/workbench/core/catalog-qualification-policy-v1.js";
import {
  type CatalogQualificationArtifactV1,
  type CoreCompilerQualificationBindingsV1,
  catalogQualificationPackagedProjectionV1,
  prepareRegisteredCompilerQualificationBindingsV1,
  verifyCatalogQualificationArtifactsForPackagingV1,
} from "../org-policy/workbench/core/catalog-qualification-v1.js";
import { defaultPreparedWorkbenchCatalog } from "../org-policy/workbench/prepared-catalog.js";
import { readRegularFileWithStats } from "./fsxn.js";

const MAX_RECEIPT_BYTES = 6_000;
const MAX_MEMBER_BYTES = 64_000;
const MAX_CLOSURE_BYTES = 1_000_000;
const closureIdentity = z
  .object({ closure: z.object({ identity: z.string().min(1).max(500) }).passthrough() })
  .passthrough();

export interface PrepareOperationalCatalogQualificationV1Input {
  readonly bundle: AuthoringCatalogBundleV1;
  readonly sourceRoot: string;
  readonly providerId: string;
  readonly artifactRoot: string;
  readonly now?: string;
}

export interface PreparedOperationalCatalogQualificationV1 {
  readonly records: readonly CatalogQualificationArtifactV1[];
  readonly bindings: CoreCompilerQualificationBindingsV1;
  readonly projection: { summary: Record<string, unknown> };
}

function boundedRegularFile(root: string, name: string, maximum: number): Buffer {
  const path = resolve(root, name);
  const opened = readRegularFileWithStats(path, { maxBytes: maximum });
  if (!opened || opened.contents.length === 0 || opened.identity.nlink !== 1n)
    throw new TypeError(`Catalog qualification requires bounded regular ${name} bytes.`);
  return opened.contents;
}

function artifactRoot(root: string): string {
  const absolute = resolve(root);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new TypeError("Catalog qualification artifacts require a real directory.");
  return absolute;
}

/**
 * Operational-only preparation. The fixed layout deliberately accepts no
 * publisher/subject/binding JSON: those values are derived by Core or locked
 * in reviewed Core policy.
 */
export async function prepareOperationalCatalogQualificationV1(
  input: PrepareOperationalCatalogQualificationV1Input,
): Promise<PreparedOperationalCatalogQualificationV1> {
  const root = artifactRoot(input.artifactRoot);
  const receiptBytes = boundedRegularFile(root, "receipt.json", MAX_RECEIPT_BYTES);
  const receiptSetBytes = boundedRegularFile(
    root,
    "receipt-set.json",
    CATALOG_RECEIPT_SET_MAX_BYTES,
  );
  const memberBytes = boundedRegularFile(root, "member.json", MAX_MEMBER_BYTES);
  const closureBytes = boundedRegularFile(root, "closure.json", MAX_CLOSURE_BYTES);
  let identity: string;
  try {
    identity = closureIdentity.parse(JSON.parse(memberBytes.toString("utf8"))).closure.identity;
  } catch {
    throw new TypeError(
      "Catalog qualification member does not declare a bounded closure identity.",
    );
  }
  const bindings = prepareRegisteredCompilerQualificationBindingsV1(
    input.bundle,
    input.sourceRoot,
    input.providerId,
  );
  if (bindings === undefined)
    throw new TypeError("Core could not derive registered compiler qualification bindings.");
  const receipt = parseAihSupportedQualificationReceiptV2Bytes(receiptBytes);
  if (receipt === undefined)
    throw new TypeError("Catalog qualification receipt is not canonical V2 bytes.");
  const records: readonly CatalogQualificationArtifactV1[] = [
    {
      receiptBytes,
      receiptSetBytes,
      memberBytes,
      closureBytesByIdentity: Object.freeze({ [identity]: closureBytes }),
      publisher: {
        ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.publisher,
        subjectName: `${receipt.entryId}.json`,
      },
      receiptSetPublisher: CATALOG_QUALIFICATION_RELEASE_POLICY_V1.receiptSetPublisher,
    },
  ];
  const prepared = await verifyCatalogQualificationArtifactsForPackagingV1(
    input.bundle,
    bindings,
    records,
    input.now,
  );
  const projection = catalogQualificationPackagedProjectionV1(prepared);
  if (projection === undefined)
    throw new TypeError(
      "Catalog qualification artifacts failed authenticated release preparation.",
    );
  return Object.freeze({ records, bindings, projection });
}

/** Encoding only; this does not verify artifacts or grant them trust. */
export function catalogQualificationDraftDataV1(
  prepared: PreparedOperationalCatalogQualificationV1,
) {
  return {
    version: 1,
    records: prepared.records.map((record) => ({
      receiptBytesBase64: Buffer.from(record.receiptBytes).toString("base64"),
      receiptSetBytesBase64: Buffer.from(record.receiptSetBytes).toString("base64"),
      memberBytesBase64: Buffer.from(record.memberBytes).toString("base64"),
      closureBytesByIdentityBase64: Object.fromEntries(
        Object.entries(record.closureBytesByIdentity).map(([identity, bytes]) => [
          identity,
          Buffer.from(bytes).toString("base64"),
        ]),
      ),
      publisher: record.publisher,
      receiptSetPublisher: record.receiptSetPublisher,
    })),
    bindings: Object.values(prepared.bindings).filter((binding) =>
      Object.hasOwn(prepared.projection.summary, binding.asset.assetId),
    ),
    projections: [prepared.projection.summary],
  };
}

/** Writes complete, reviewable package-input data only after live verification succeeds. */
export async function writeOperationalCatalogQualificationDraftV1(
  input: PrepareOperationalCatalogQualificationV1Input & { readonly output: string },
): Promise<PreparedOperationalCatalogQualificationV1> {
  const prepared = await prepareOperationalCatalogQualificationV1(input);
  const output = resolve(input.output);
  const parent = dirname(output);
  if (lstatSync(parent).isSymbolicLink()) throw new TypeError("Draft output parent is linked.");
  const data = catalogQualificationDraftDataV1(prepared);
  const source = [
    "// Generated by authenticated Core release preparation; review before replacing package data.",
    `export const CATALOG_QUALIFICATION_PACKAGE_INPUT_V1 = ${canonicalStrictJsonBytesV1(data).toString("utf8")} as const;`,
    "",
  ].join("\n");
  writeFileSync(output, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return prepared;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const flags = ["--source", "--provider", "--artifacts", "--output"];
  if (
    args.length !== 8 ||
    flags.some(
      (flag, index) =>
        args[index * 2] !== flag || !args[index * 2 + 1] || args[index * 2 + 1]?.startsWith("--"),
    )
  )
    throw new TypeError(
      "Usage: prepare-workbench-catalog-qualification --source <registered-root> --provider <id> --artifacts <four-file-root> --output <draft-module.ts>",
    );
  await writeOperationalCatalogQualificationDraftV1({
    bundle: defaultPreparedWorkbenchCatalog().bundle,
    sourceRoot: resolve(args[1] as string),
    providerId: args[3] as string,
    artifactRoot: resolve(args[5] as string),
    output: resolve(args[7] as string),
  });
  console.log("Prepared a reviewable, authenticated Catalog qualification package-input draft.");
}
