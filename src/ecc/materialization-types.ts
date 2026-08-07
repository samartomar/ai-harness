import type { EccComponentId } from "./components.js";
import type { DestinationExpectation } from "./materialization-fs.js";
import type {
  EccComponentProvenance,
  EccMaterializationOperation,
  EccMaterializationReceipt,
  EccMaterializedComponent,
} from "./materialization-receipt.js";
import type { InstalledComponentRegistration } from "./registration.js";

/**
 * The vocabulary of AIH-direct materialization: what a caller supplies, what a
 * plan reports, and what one committed step is. Declarations only — the layer
 * that decides what to do lives in the plan module, and the layer that writes
 * lives in the fs module.
 */

export interface EccMaterializationFileInput {
  /** Destination-relative path; traversal, absolute inputs, and AIH state are refused. */
  path: string;
  kind: EccMaterializationOperation;
  /** `copy-file`: the exact bytes to write. `merge-json`: the owned JSON fragment. */
  contents: Buffer | string;
}

export interface EccMaterializationComponentInput {
  id: EccComponentId;
  authorization: InstalledComponentRegistration["authorization"];
  provenance: EccComponentProvenance;
  files: readonly EccMaterializationFileInput[];
}

export interface EccMaterializationRequest {
  root: string;
  components: readonly EccMaterializationComponentInput[];
}

export type EccMaterializationAction =
  | "create"
  | "update"
  | "unchanged"
  | "remove"
  | "subtract-keys";

export interface EccMaterializationFilePlan {
  componentId: string;
  path: string;
  operation: EccMaterializationOperation;
  action: EccMaterializationAction;
}

export interface EccMaterializationAdvisory {
  componentId?: string;
  path: string;
  reason: "drifted" | "missing" | "unreadable" | "malformed-receipt";
  detail: string;
}

export interface EccMaterializationPlan {
  root: string;
  write: EccMaterializationFilePlan[];
  subtract: EccMaterializationFilePlan[];
  advisories: EccMaterializationAdvisory[];
}

export interface EccMaterializationResult {
  root: string;
  written: EccMaterializationFilePlan[];
  removed: EccMaterializationFilePlan[];
  unchanged: EccMaterializationFilePlan[];
  advisories: EccMaterializationAdvisory[];
  receipt: EccMaterializationReceipt | undefined;
}

/**
 * One filesystem step, announced immediately BEFORE it is performed — so a
 * caller that throws from the callback reproduces a crash at exactly that
 * boundary. Owned content always steps before the ownership record.
 */
export interface EccMaterializationStep {
  phase: "content" | "receipt";
  kind: "write" | "remove";
  path: string;
  componentId?: string;
}

/**
 * The machine ledger's target entry, offered to the caller inside the same
 * operation. The ledger stays the machine index — which components, which
 * targets, which authorization — and never becomes the byte-ownership home.
 */
export interface EccMaterializationLedgerUpdate {
  root: string;
  components: InstalledComponentRegistration[];
}

export interface EccMaterializationDeps {
  /** Injectable final rename, matching the ledger's atomic-write seam. */
  rename?: (from: string, to: string) => void;
  onStep?: (step: EccMaterializationStep) => void;
  onLedgerUpdate?: (update: EccMaterializationLedgerUpdate) => void;
}

export interface PlannedStep {
  phase: "content" | "receipt";
  kind: "write" | "remove";
  path: string;
  plan?: EccMaterializationFilePlan;
  contents?: Buffer;
  expect: DestinationExpectation;
  prior?: Buffer;
  /**
   * The mode the prior bytes had. Declared HERE so the bridge cannot drop it
   * again: an optional field attached only by a spread is exempt from excess
   * property checking, which is how it went missing without a type error.
   */
  priorMode?: number;
  mode: number;
}

export interface PlannedOperation {
  root: string;
  steps: PlannedStep[];
  write: EccMaterializationFilePlan[];
  subtract: EccMaterializationFilePlan[];
  unchanged: EccMaterializationFilePlan[];
  advisories: EccMaterializationAdvisory[];
  components: EccMaterializedComponent[];
  receipt: EccMaterializationReceipt | undefined;
}

export type ResolvedFile =
  | { path: string; operation: "copy-file"; bytes: Buffer; contentSha256: string }
  | {
      path: string;
      operation: "merge-json";
      fragment: Record<string, unknown>;
      ownedKeys: string[];
      contentSha256: string;
    };

export interface ResolvedComponent {
  id: string;
  authorization: InstalledComponentRegistration["authorization"];
  provenance: EccComponentProvenance;
  files: ResolvedFile[];
}

export interface ResolvedRequest {
  root: string;
  components: ResolvedComponent[];
}
