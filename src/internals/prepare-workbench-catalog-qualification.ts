import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  activateCandidateCatalogV1,
  candidateCatalogUsePathV1,
  openCandidateCatalogV1,
  writeCandidateCatalogUseV1,
} from "../catalog-package/candidate-catalog.js";
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
  writeFileSync(output, catalogQualificationDraftSourceV1(prepared), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return prepared;
}

/** The exact draft file text both modes write. */
function catalogQualificationDraftSourceV1(prepared: PreparedOperationalCatalogQualificationV1) {
  return `${canonicalStrictJsonBytesV1(catalogQualificationDraftDataV1(prepared)).toString("utf8")}\n`;
}

const BATCH_ENTRY_FILES = ["closure.json", "member.json", "receipt-set.json", "receipt.json"];

export interface PrepareOperationalCatalogQualificationBatchV1Input {
  readonly bundle: AuthoringCatalogBundleV1;
  readonly sourceRoot: string;
  readonly providerId: string;
  /** One subdirectory per entry, named by its entry id, each holding exactly the four files. */
  readonly artifactsRoot: string;
  readonly now?: string;
}

export interface PreparedOperationalCatalogQualificationBatchEntryV1 {
  readonly entryId: string;
  readonly prepared: PreparedOperationalCatalogQualificationV1;
}

/**
 * Every entry of one provider's artifacts root, each verified exactly as the single mode
 * verifies one. The layout is checked for every entry before any is verified.
 */
export async function prepareOperationalCatalogQualificationBatchV1(
  input: PrepareOperationalCatalogQualificationBatchV1Input,
): Promise<readonly PreparedOperationalCatalogQualificationBatchEntryV1[]> {
  const root = artifactRoot(input.artifactsRoot);
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  if (entries.length === 0)
    throw new TypeError("Catalog qualification artifacts root holds no entry directories.");
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new TypeError(
        `Catalog qualification artifacts root holds ${entry.name}, which is not an entry directory.`,
      );
    const files = readdirSync(resolve(root, entry.name)).sort();
    if (files.join("\n") !== BATCH_ENTRY_FILES.join("\n"))
      throw new TypeError(
        `Catalog qualification entry ${entry.name} must hold exactly closure.json, member.json, receipt-set.json and receipt.json.`,
      );
  }
  const prepared: PreparedOperationalCatalogQualificationBatchEntryV1[] = [];
  for (const entry of entries) {
    const one = await prepareOperationalCatalogQualificationV1({
      bundle: input.bundle,
      sourceRoot: input.sourceRoot,
      providerId: input.providerId,
      artifactRoot: resolve(root, entry.name),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    const subject = one.records[0]?.publisher.subjectName;
    if (subject !== `${entry.name}.json`)
      throw new TypeError(
        `Catalog qualification entry ${entry.name} holds the receipt of ${String(subject).replace(/\.json$/u, "")}.`,
      );
    prepared.push(Object.freeze({ entryId: entry.name, prepared: one }));
  }
  return Object.freeze(prepared);
}

/**
 * Writes one draft per entry, `<output-dir>/<entryId>.json`, byte-identical to what the
 * single mode writes for that entry, and only after every entry verified.
 */
export async function writeOperationalCatalogQualificationDraftsV1(
  input: PrepareOperationalCatalogQualificationBatchV1Input & { readonly outputDir: string },
): Promise<readonly { readonly entryId: string; readonly output: string }[]> {
  const outputDir = resolve(input.outputDir);
  if (lstatSync(dirname(outputDir)).isSymbolicLink())
    throw new TypeError("Draft output parent is linked.");
  const prepared = await prepareOperationalCatalogQualificationBatchV1(input);
  const sources = prepared.map(({ entryId, prepared: one }) => ({
    entryId,
    output: resolve(outputDir, `${entryId}.json`),
    source: catalogQualificationDraftSourceV1(one),
  }));
  mkdirSync(outputDir, { mode: 0o700 });
  for (const { output, source } of sources)
    writeFileSync(output, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return sources.map(({ entryId, output }) => ({ entryId, output }));
}

const USAGE =
  "Usage: prepare-workbench-catalog-qualification --source <registered-root> --provider <id> --artifacts <four-file-root> --output <draft-data.json> [--candidate-catalog <npm-pack.tgz|package-dir> --candidate-catalog-sha256 <sha256 of the .tgz, or of the directory's canonical file listing>]";
const BATCH_USAGE =
  "Usage: prepare-workbench-catalog-qualification --source <registered-root> --provider <id> --artifacts-root <one-directory-per-entry> --output-dir <new-directory> [--candidate-catalog <npm-pack.tgz|package-dir> --candidate-catalog-sha256 <sha256 of the .tgz, or of the directory's canonical file listing>]";

/**
 * Batch mode: `--source --provider --artifacts-root --output-dir`, in that order, for one
 * provider/source. Each `<artifacts-root>/<entryId>/` is verified exactly as the single
 * mode verifies `--artifacts`; `<output-dir>` must not exist and is written only after
 * every entry verified. With a candidate Catalog, each draft gets the same
 * `<draft>.candidate-catalog.json` record the single mode writes.
 */
async function prepareWorkbenchCatalogQualificationBatchCommandV1(
  args: readonly string[],
): Promise<string> {
  const flags = ["--source", "--provider", "--artifacts-root", "--output-dir"];
  const withCandidate = args.length === 12;
  if (withCandidate) flags.push("--candidate-catalog", "--candidate-catalog-sha256");
  if (
    (args.length !== 8 && !withCandidate) ||
    flags.some(
      (flag, index) =>
        args[index * 2] !== flag || !args[index * 2 + 1] || args[index * 2 + 1]?.startsWith("--"),
    ) ||
    (withCandidate && !/^[0-9a-f]{64}$/.test(args[11] as string))
  )
    throw new TypeError(BATCH_USAGE);
  const outputDir = resolve(args[7] as string);
  if (existsSync(outputDir))
    throw new TypeError(
      `EEXIST: Catalog qualification draft output directory already exists: ${outputDir}`,
    );
  const candidate = withCandidate
    ? openCandidateCatalogV1(resolve(args[9] as string), args[11] as string)
    : undefined;
  if (candidate !== undefined) activateCandidateCatalogV1(candidate);
  const written = await writeOperationalCatalogQualificationDraftsV1({
    bundle: defaultPreparedWorkbenchCatalog().bundle,
    sourceRoot: resolve(args[1] as string),
    providerId: args[3] as string,
    artifactsRoot: resolve(args[5] as string),
    outputDir,
  });
  if (candidate !== undefined)
    for (const { output } of written)
      writeCandidateCatalogUseV1("prepare-workbench-catalog-qualification", output);
  const used =
    candidate === undefined
      ? ""
      : ` Used candidate Catalog ${candidate.version} sha256:${candidate.sha256} (${candidate.digestOf}), recorded beside each draft.`;
  return `Prepared ${written.length} entries of reviewable, authenticated Catalog qualification package-input drafts in ${outputDir}.${used}`;
}

/**
 * `--source --provider --artifacts --output`, in that order. Qualification data comes
 * from the installed Catalog's prepared authoring bundle; an existing output is refused
 * before any artifact is read. With a named candidate Catalog, the candidate replaces the
 * installed Catalog for the whole run and `<output>.candidate-catalog.json` names its
 * digest and every file read from it.
 */
export async function prepareWorkbenchCatalogQualificationCommandV1(
  args: readonly string[],
): Promise<string> {
  if (args[4] === "--artifacts-root")
    return prepareWorkbenchCatalogQualificationBatchCommandV1(args);
  const flags = ["--source", "--provider", "--artifacts", "--output"];
  const withCandidate = args.length === 12;
  if (withCandidate) flags.push("--candidate-catalog", "--candidate-catalog-sha256");
  if (
    (args.length !== 8 && !withCandidate) ||
    flags.some(
      (flag, index) =>
        args[index * 2] !== flag || !args[index * 2 + 1] || args[index * 2 + 1]?.startsWith("--"),
    ) ||
    (withCandidate && !/^[0-9a-f]{64}$/.test(args[11] as string))
  )
    throw new TypeError(USAGE);
  const output = resolve(args[7] as string);
  if (existsSync(output))
    throw new TypeError(`EEXIST: Catalog qualification draft output already exists: ${output}`);
  if (withCandidate && existsSync(candidateCatalogUsePathV1(output)))
    throw new TypeError("EEXIST: the candidate Catalog use record must not already exist");
  const candidate = withCandidate
    ? openCandidateCatalogV1(resolve(args[9] as string), args[11] as string)
    : undefined;
  if (candidate !== undefined) activateCandidateCatalogV1(candidate);
  await writeOperationalCatalogQualificationDraftV1({
    bundle: defaultPreparedWorkbenchCatalog().bundle,
    sourceRoot: resolve(args[1] as string),
    providerId: args[3] as string,
    artifactRoot: resolve(args[5] as string),
    output,
  });
  const used =
    candidate === undefined
      ? ""
      : ` Used candidate Catalog ${candidate.version} sha256:${candidate.sha256} (${candidate.digestOf}), recorded in ${writeCandidateCatalogUseV1("prepare-workbench-catalog-qualification", output)}.`;
  return `Prepared a reviewable, authenticated Catalog qualification package-input draft.${used}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(await prepareWorkbenchCatalogQualificationCommandV1(process.argv.slice(2)));
