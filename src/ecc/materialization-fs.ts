import { realpathSync } from "node:fs";
import {
  type OwnedFileExpectation,
  type OwnedFilePolicy,
  type OwnedFileRead,
  type OwnedFileStep,
  OwnedFileTransaction,
  resolveOwnedFileRoot,
} from "../internals/owned-file-transaction.js";
import {
  assertUnreservedSegments,
  ECC_MATERIALIZATION_RECEIPT_PATH,
  MAX_MATERIALIZED_FILE_BYTES,
} from "./materialization-receipt.js";

/**
 * ECC compatibility and path policy for the generic ordered owned-file transaction.
 * Planning, ownership, evidence, and receipt-last semantics remain in the ECC layers;
 * this module preserves the existing filesystem API and error vocabulary.
 */

const ENGINE_STATE_PATHS = new Set([ECC_MATERIALIZATION_RECEIPT_PATH]);
const LABEL = "ECC materialization";

export { MAX_MATERIALIZED_FILE_BYTES };
export const MATERIALIZED_CONTENT_MODE = 0o644;
export const MATERIALIZATION_RECEIPT_MODE = 0o600;
const CONTENT_DIRECTORY_MODE = 0o755;
const STATE_DIRECTORY_MODE = 0o700;

export type DestinationRead = OwnedFileRead;
export type DestinationExpectation = OwnedFileExpectation;
export interface MaterializationCommitStep extends OwnedFileStep {}

/**
 * Preserve the historical import-time refusal: the JS realpath implementation leaves
 * Windows short-name aliases unresolved, which defeats ECC's reserved-segment policy.
 */
const nativeRealpath = (realpathSync as unknown as { native?: (path: string) => string }).native;
if (typeof nativeRealpath !== "function") {
  throw new Error(
    "ECC materialization requires fs.realpathSync.native; the JS implementation does not resolve filesystem aliases and would defeat the reserved-path guard",
  );
}

const ECC_POLICY: OwnedFilePolicy = {
  label: LABEL,
  maxFileBytes: MAX_MATERIALIZED_FILE_BYTES,
  contentDirectoryMode: CONTENT_DIRECTORY_MODE,
  stateDirectoryMode: STATE_DIRECTORY_MODE,
  statePaths: ENGINE_STATE_PATHS,
  assertOwnedPath(path, ownState) {
    if (!ownState) assertUnreservedSegments(path.split("/"), path);
  },
  assertResolvedSegments(segments, requested, ownState) {
    if (!ownState) assertUnreservedSegments(segments, requested);
  },
};

function transaction(
  rootReal: string,
  rename?: (from: string, to: string) => void,
): OwnedFileTransaction {
  return new OwnedFileTransaction(rootReal, ECC_POLICY, { rename });
}

/** The destination root must be an absolute, real, non-symlinked directory. */
export function materializationRoot(root: string): string {
  return resolveOwnedFileRoot(root, LABEL);
}

export function inspectDestination(rootReal: string, path: string): DestinationRead {
  return transaction(rootReal).inspect(path);
}

/** The write-path read: an unreadable destination refuses rather than degrading. */
export function readLiveDestination(rootReal: string, path: string): Buffer | undefined {
  return transaction(rootReal).read(path);
}

/** Write bounded bytes through a same-directory exclusive temporary file and rename. */
export function writeDestinationAtomic(
  rootReal: string,
  path: string,
  contents: Buffer,
  mode: number,
  rename?: (from: string, to: string) => void,
): void {
  transaction(rootReal, rename).writeAtomic(path, contents, mode);
}

export function removeDestination(rootReal: string, path: string): void {
  transaction(rootReal).remove(path);
}

/** Commit the already-planned ordered ECC steps with receipt order unchanged. */
export function commitMaterializationSteps(
  rootReal: string,
  steps: readonly MaterializationCommitStep[],
  rename?: (from: string, to: string) => void,
): void {
  transaction(rootReal, rename).commit(steps);
}
