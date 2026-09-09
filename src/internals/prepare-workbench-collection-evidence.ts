import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  authorPackagedAihScannerEvidenceRecordV1,
  prepareAihScannerPublicationsV1,
} from "../baseline-evidence/aih-scan-preparation.js";
import {
  authorPackagedScannerCollectionEvidenceRecordV1,
  prepareScannerCollectionPublicationsV1,
  SCANNER_COLLECTION_TOTAL_INPUT_MAX_BYTES_V1,
} from "../baseline-evidence/scanner-collection-preparation.js";
import { createCoreBaselineVetRequests } from "../baseline-evidence/scanner-consumer.js";
import { prepareRegisteredScannerCatalogV1 } from "../baseline-evidence/scanner-provider-catalogs.js";
import { canonicalStrictJsonBytesV1 } from "../contract/strict-json-v1.js";
import { hermeticGitEnv } from "../internals/git-env.js";
import { policyAuthoringCatalog } from "../org-policy/catalog.js";
import { assembleCompilerOutputsV1 } from "../org-policy/workbench/assembly.js";
import { compileBuiltInCatalogV1 } from "../org-policy/workbench/compilers/built-in.js";
import { prepareAihFirstPartyCompilerQualificationsV1 } from "../org-policy/workbench/core/catalog-qualification-v1.js";
import { builtInAssemblyInputV1 } from "../org-policy/workbench/providers/aih.js";
import { readRegularFileWithStats } from "./fsxn.js";

const usage =
  "Usage: prepare-workbench-collection-evidence --catalog <aih|mattpocock|ponytail|ecc|superpowers> --source <pinned-checkout> --publication-root <batch-directories> --output <new-json-file> [--qualification-output <new-json-file>]";
const releaseFiles = ["SHA256SUMS", "discovery.json", "inspection.json", "publication.json"];
const MAX_QUALIFICATION_DRAFT_BYTES = 1024 * 1024;

function samePlatformPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function readPublicationFile(path: string, maximum: number): Buffer {
  const opened = readRegularFileWithStats(path, { maxBytes: maximum });
  if (!opened || opened.contents.length === 0 || opened.identity.nlink !== 1n)
    throw new TypeError("Collection publication requires bounded regular files.");
  return opened.contents;
}

function preflightNewOutput(path: string): void {
  const output = resolve(path);
  try {
    lstatSync(output);
    throw new TypeError("EEXIST: Collection preparation output must not already exist.");
  } catch (error) {
    if (error instanceof TypeError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = dirname(output);
  const temporary = resolve(tmpdir());
  const insideTemporary =
    samePlatformPath(parent, temporary) ||
    (() => {
      const value = relative(temporary, parent);
      return value.length > 0 && !value.startsWith("..") && !isAbsolute(value);
    })();
  const anchor = insideTemporary ? temporary : parent;
  for (let current = parent; ; current = dirname(current)) {
    let status: ReturnType<typeof lstatSync>;
    try {
      status = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new TypeError(
          "Collection preparation output requires an existing real parent directory.",
        );
      throw error;
    }
    if (status.isSymbolicLink() || !status.isDirectory())
      throw new TypeError("Collection preparation output requires a real parent directory.");
    if (insideTemporary && samePlatformPath(current, anchor)) break;
    if (dirname(current) === current) {
      if (insideTemporary)
        throw new TypeError("Collection preparation output did not reach its temporary anchor.");
      break;
    }
  }
  if (insideTemporary) {
    const canonicalAnchor = realpathSync(anchor);
    const expected = resolve(canonicalAnchor, relative(anchor, parent));
    if (!samePlatformPath(realpathSync(parent), expected))
      throw new TypeError(
        "Collection preparation output requires a canonical real parent directory.",
      );
  }
}

function sameOutputPath(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    const canonicalLeft = join(realpathSync(dirname(left)), basename(left));
    const canonicalRight = join(realpathSync(dirname(right)), basename(right));
    return samePlatformPath(canonicalLeft, canonicalRight);
  } catch {
    return false;
  }
}

function compareAssetIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function firstPartyQualificationDraft(
  value: NonNullable<ReturnType<typeof prepareAihFirstPartyCompilerQualificationsV1>>,
): Buffer {
  const draft = {
    format: "aih-first-party-catalog-qualification-draft",
    version: 1,
    authority: "none",
    purpose: "candidate-input-only",
    profiles: Object.entries(value.profiles)
      .sort(([left], [right]) => compareAssetIds(left, right))
      .map(([assetId, profile]) => ({
        assetId,
        sha256: profile.sha256,
        bytesBase64: Buffer.from(profile.bytes).toString("base64"),
      })),
    bindings: Object.entries(value.bindings)
      .sort(([left], [right]) => compareAssetIds(left, right))
      .map(([, binding]) => binding),
    unsupported: value.unsupported,
  };
  const bytes = canonicalStrictJsonBytesV1(draft);
  if (bytes.length === 0 || bytes.length > MAX_QUALIFICATION_DRAFT_BYTES)
    throw new TypeError("First-party qualification draft exceeds its byte limit.");
  return bytes;
}

export type WorkbenchCollectionCatalogIdV1 =
  | "aih"
  | "mattpocock"
  | "ponytail"
  | "ecc"
  | "superpowers";
/** Compatibility alias for the upstream-Git reverification aggregator. */
export type RegisteredCollectionCatalogIdV1 = Exclude<WorkbenchCollectionCatalogIdV1, "aih">;

export interface WorkbenchCollectionPublicationMaterialV1 {
  readonly sourceRoot: string;
  readonly catalogId: WorkbenchCollectionCatalogIdV1;
  readonly batches: readonly {
    readonly discoveryBytes: Buffer;
    readonly publicationBytes: Buffer;
  }[];
}

/**
 * Reads the one fixed, bounded transport layout shared by preparation and
 * release reverification. Inspection and checksums are not trust inputs.
 */
export function readWorkbenchCollectionPublicationMaterialV1(
  sourceRoot: string,
  catalogId: WorkbenchCollectionCatalogIdV1,
  publicationRoot: string,
): WorkbenchCollectionPublicationMaterialV1 {
  const source = resolve(sourceRoot);
  const publications = resolve(publicationRoot);
  const sourceStat = lstatSync(source);
  const publicationStat = lstatSync(publications);
  if (
    !sourceStat.isDirectory() ||
    sourceStat.isSymbolicLink() ||
    !publicationStat.isDirectory() ||
    publicationStat.isSymbolicLink()
  )
    throw new TypeError("Collection material requires real source and publication directories.");
  const expected =
    catalogId === "aih"
      ? undefined
      : createCoreBaselineVetRequests(
          source,
          prepareRegisteredScannerCatalogV1(source, catalogId).catalog,
        ).map((_, index) => `batch-${String(index + 1).padStart(3, "0")}`);
  const directories = readdirSync(publications, { withFileTypes: true });
  const layout =
    expected ?? directories.map((_, index) => `batch-${String(index + 1).padStart(3, "0")}`);
  if (
    layout.length === 0 ||
    directories.length !== layout.length ||
    directories.some(
      (entry) => !entry.isDirectory() || entry.isSymbolicLink() || !layout.includes(entry.name),
    )
  )
    throw new TypeError("Collection publication batch layout does not match Core requests.");
  let totalBytes = 0;
  const boundedRead = (path: string, maximum: number) => {
    const remaining = SCANNER_COLLECTION_TOTAL_INPUT_MAX_BYTES_V1 - totalBytes;
    if (remaining <= 0)
      throw new TypeError("Collection publication aggregate byte limit exceeded.");
    const bytes = readPublicationFile(path, Math.min(maximum, remaining));
    totalBytes += bytes.length;
    return bytes;
  };
  const batches = layout.map((name) => {
    const directory = join(publications, name);
    const files = readdirSync(directory, { withFileTypes: true });
    if (
      files.length !== releaseFiles.length ||
      files.some(
        (entry) => !entry.isFile() || entry.isSymbolicLink() || !releaseFiles.includes(entry.name),
      )
    )
      throw new TypeError("Collection publication requires the exact published four-file layout.");
    return {
      discoveryBytes: boundedRead(join(directory, "discovery.json"), 8 * 1024),
      publicationBytes: boundedRead(join(directory, "publication.json"), 96 * 1024 * 1024),
    };
  });
  return Object.freeze({ sourceRoot: source, catalogId, batches: Object.freeze(batches) });
}

/** Internal preparation only: verifies existing publications; never scans, signs, or publishes. */
export async function prepareWorkbenchCollectionEvidenceCommandV1(
  args: readonly string[],
): Promise<string> {
  const flags = ["--catalog", "--source", "--publication-root", "--output"];
  const hasQualificationOutput = args.length === 10 && args[8] === "--qualification-output";
  if (
    (args.length !== 8 && !hasQualificationOutput) ||
    flags.some(
      (flag, index) =>
        args[index * 2] !== flag || !args[index * 2 + 1] || args[index * 2 + 1]?.startsWith("--"),
    ) ||
    (hasQualificationOutput && (!args[9] || args[9]?.startsWith("--")))
  )
    throw new TypeError(usage);
  const catalogId = args[1];
  if (
    catalogId !== "aih" &&
    catalogId !== "mattpocock" &&
    catalogId !== "ponytail" &&
    catalogId !== "ecc" &&
    catalogId !== "superpowers"
  )
    throw new TypeError(usage);
  const aih = catalogId === "aih";
  if (hasQualificationOutput && !aih) throw new TypeError(usage);
  const output = resolve(args[7] as string);
  const qualificationOutput = hasQualificationOutput ? resolve(args[9] as string) : undefined;
  preflightNewOutput(output);
  if (qualificationOutput !== undefined) preflightNewOutput(qualificationOutput);
  if (qualificationOutput !== undefined && sameOutputPath(qualificationOutput, output))
    throw new TypeError(usage);
  const material = readWorkbenchCollectionPublicationMaterialV1(
    args[3] as string,
    catalogId,
    args[5] as string,
  );
  const { sourceRoot, batches } = material;
  const now = new Date().toISOString();
  let qualificationDraft: Buffer | undefined;
  const sealed = aih
    ? await (async () => {
        const catalog = policyAuthoringCatalog();
        const compiled = compileBuiltInCatalogV1(catalog);
        const prepared = await prepareAihScannerPublicationsV1({
          packageRoot: sourceRoot,
          coreRevision: {
            pinnedSha: execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
              encoding: "utf8",
              env: hermeticGitEnv(),
            }).trim(),
          },
          catalog,
          compiled,
          batches,
          now,
        });
        if (qualificationOutput !== undefined) {
          const firstParty = prepareAihFirstPartyCompilerQualificationsV1(
            assembleCompilerOutputsV1(
              [builtInAssemblyInputV1(compiled)],
              compiled.coreCapabilities,
            ),
            prepared,
          );
          if (firstParty === undefined)
            throw new TypeError(
              "Collection preparation could not derive first-party qualification candidates.",
            );
          qualificationDraft = firstPartyQualificationDraft(firstParty);
        }
        return authorPackagedAihScannerEvidenceRecordV1(prepared);
      })()
    : authorPackagedScannerCollectionEvidenceRecordV1(
        await prepareScannerCollectionPublicationsV1({ sourceRoot, catalogId, batches, now }),
      );
  if (!sealed) throw new TypeError("Collection preparation did not establish operational custody.");
  writeFileSync(output, canonicalStrictJsonBytesV1(sealed), { flag: "wx", mode: 0o600 });
  if (qualificationOutput !== undefined && qualificationDraft !== undefined)
    writeFileSync(qualificationOutput, qualificationDraft, { flag: "wx", mode: 0o600 });
  return `Prepared sealed collection report ${sealed.sha256}.${qualificationOutput === undefined ? "" : " Prepared a no-authority first-party Catalog qualification candidate draft."} No scan, signing, publication, or qualification was performed.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(await prepareWorkbenchCollectionEvidenceCommandV1(process.argv.slice(2)));
