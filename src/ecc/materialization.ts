import type { EccComponentId } from "./components.js";
import {
  MATERIALIZATION_RECEIPT_MODE,
  MATERIALIZED_CONTENT_MODE,
  MAX_MATERIALIZED_FILE_BYTES,
  materializationRoot,
  readLiveDestination,
  removeDestination,
  writeDestinationAtomic,
} from "./materialization-fs.js";
import {
  assertComponentSourcePath,
  assertOwnedRelativePath,
  ECC_MATERIALIZATION_RECEIPT_FORMAT,
  ECC_MATERIALIZATION_RECEIPT_PATH,
  type EccComponentProvenance,
  type EccMaterializationOperation,
  type EccMaterializationReceipt,
  type EccMaterializedComponent,
  type EccOwnedFile,
  eccMaterializationReceiptPath,
  ownedFileSha256,
  ownedFragmentSha256,
  readEccMaterializationReceipt,
  serializeEccMaterializationReceipt,
} from "./materialization-receipt.js";
import type { InstalledComponentRegistration } from "./registration.js";

/**
 * AIH-direct per-component materialization (F1), receipt-bound (F5).
 *
 * The v3.4 R8 lifecycle, extended from a fixed profile to an authored
 * selection: preview-first, atomic apply, deterministic second apply, repair
 * only owned unmodified bytes, uninstall only matching owned bytes, and
 * operator content always survives.
 *
 * Every operation is driven by an explicit resolved input against a
 * caller-supplied destination root. Nothing here reads a policy, resolves a
 * selection, or knows a target adapter — those arrive in their own rows, and
 * keeping them out is what makes this engine testable against a fixture root.
 *
 * `apply` IS the reconcile: it materializes the request and subtracts every
 * receipt component the request no longer carries, because ownership that
 * outlives its selection is exactly the defect receipts exist to prevent.
 */

const MAX_COMPONENTS = 4_096;
const MAX_FILES_PER_COMPONENT = 2_048;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

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
  reason: "drifted" | "missing" | "malformed-receipt";
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
 * boundary. Owned content always steps before the ownership record: a crash
 * between them leaves a receipt that still names bytes still on disk
 * (uninstall) or content no record claims, which the next apply refuses by name
 * (apply). Neither direction can silently absorb or silently delete.
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

interface ResolvedFile {
  path: string;
  operation: EccMaterializationOperation;
  bytes: Buffer;
  fragment?: Record<string, unknown>;
  ownedKeys?: string[];
  contentSha256: string;
}

interface ResolvedComponent {
  id: string;
  authorization: InstalledComponentRegistration["authorization"];
  provenance: EccComponentProvenance;
  files: ResolvedFile[];
}

interface ResolvedRequest {
  root: string;
  components: ResolvedComponent[];
}

interface WriteStep {
  plan: EccMaterializationFilePlan;
  contents: Buffer;
}

interface SubtractStep {
  plan: EccMaterializationFilePlan;
  contents?: Buffer;
}

function byText(left: string, right: string): number {
  return left.localeCompare(right);
}

function toBytes(value: Buffer | string): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ownedFragment(
  document: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const fragment: Record<string, unknown> = {};
  for (const key of [...keys].sort(byText)) {
    if (Object.hasOwn(document, key)) fragment[key] = document[key];
  }
  return fragment;
}

function resolveRequest(request: EccMaterializationRequest): ResolvedRequest {
  const root = materializationRoot(request.root);
  if (request.components.length > MAX_COMPONENTS) {
    throw new Error("ECC materialization component count exceeds the lifecycle boundary");
  }
  const seenComponents = new Set<string>();
  const wholeFileOwners = new Map<string, string>();
  const jsonKeyOwners = new Map<string, string>();
  let total = 0;
  const components = request.components.map((component) => {
    if (seenComponents.has(component.id)) {
      throw new Error(`duplicate ECC materialization component: ${component.id}`);
    }
    seenComponents.add(component.id);
    assertComponentSourcePath(component.provenance.componentPath);
    if (component.files.length === 0 || component.files.length > MAX_FILES_PER_COMPONENT) {
      throw new Error(
        `ECC materialization component file count is outside the lifecycle boundary: ${component.id}`,
      );
    }
    const seenPaths = new Set<string>();
    const files = component.files.map((file) => {
      const path = assertOwnedRelativePath(file.path);
      if (seenPaths.has(path)) {
        throw new Error(`duplicate ECC materialization destination: ${path} (${component.id})`);
      }
      seenPaths.add(path);
      const bytes = toBytes(file.contents);
      total += bytes.byteLength;
      if (bytes.byteLength > MAX_MATERIALIZED_FILE_BYTES || total > MAX_TOTAL_BYTES) {
        throw new Error(`ECC materialization bytes exceed the lifecycle boundary: ${path}`);
      }
      if (file.kind === "copy-file") {
        const owner = wholeFileOwners.get(path);
        if (owner !== undefined) {
          throw new Error(
            `ECC materialization destination is claimed by two components: ${path} (${owner}, ${component.id})`,
          );
        }
        wholeFileOwners.set(path, component.id);
        return {
          path,
          operation: "copy-file" as const,
          bytes,
          contentSha256: ownedFileSha256(bytes),
        };
      }
      const fragment = parseJsonObject(bytes.toString("utf8"));
      if (fragment === undefined) {
        throw new Error(`ECC materialization merge-json content is not a JSON object: ${path}`);
      }
      const ownedKeys = Object.keys(fragment).sort(byText);
      if (ownedKeys.length === 0) {
        throw new Error(`ECC materialization merge-json content owns no keys: ${path}`);
      }
      for (const key of ownedKeys) {
        const identity = `${path}/${key}`;
        const owner = jsonKeyOwners.get(identity);
        if (owner !== undefined) {
          throw new Error(
            `ECC materialization JSON key is claimed by two components: ${key} in ${path} (${owner}, ${component.id})`,
          );
        }
        jsonKeyOwners.set(identity, component.id);
      }
      return {
        path,
        operation: "merge-json" as const,
        bytes,
        fragment,
        ownedKeys,
        contentSha256: ownedFragmentSha256(fragment),
      };
    });
    return {
      id: component.id,
      authorization: component.authorization,
      provenance: component.provenance,
      files: files.sort((left, right) => byText(left.path, right.path)),
    };
  });
  for (const path of wholeFileOwners.keys()) {
    if (!jsonKeyOwners.has(path)) continue;
    throw new Error(`ECC materialization destination mixes copy-file and merge-json: ${path}`);
  }
  return { root, components: components.sort((left, right) => byText(left.id, right.id)) };
}

function currentReceipt(root: string): EccMaterializationReceipt | undefined {
  const state = readEccMaterializationReceipt(root);
  if (state.state === "malformed") throw new Error(state.detail);
  return state.state === "valid" ? state.receipt : undefined;
}

function ownedEntry(
  receipt: EccMaterializationReceipt | undefined,
  componentId: string,
  path: string,
): EccOwnedFile | undefined {
  return receipt?.components
    .find((component) => component.id === componentId)
    ?.files.find((file) => file.path === path);
}

/** Which component owns each destination — the claim an apply is not allowed to take silently. */
function ownershipIndex(receipt: EccMaterializationReceipt | undefined): {
  wholeFiles: Map<string, string>;
  jsonKeys: Map<string, string>;
} {
  const wholeFiles = new Map<string, string>();
  const jsonKeys = new Map<string, string>();
  for (const component of receipt?.components ?? []) {
    for (const file of component.files) {
      if (file.operation === "copy-file") {
        wholeFiles.set(file.path, component.id);
        continue;
      }
      for (const key of file.ownedKeys) jsonKeys.set(`${file.path}/${key}`, component.id);
    }
  }
  return { wholeFiles, jsonKeys };
}

interface MaterializePlan {
  writes: WriteStep[];
  unchanged: EccMaterializationFilePlan[];
  entries: Map<string, EccOwnedFile[]>;
}

function planMaterialize(
  resolved: ResolvedRequest,
  receipt: EccMaterializationReceipt | undefined,
): MaterializePlan {
  const index = ownershipIndex(receipt);
  const writes: WriteStep[] = [];
  const unchanged: EccMaterializationFilePlan[] = [];
  const entries = new Map<string, EccOwnedFile[]>();
  /**
   * Merges into one document fold across components in component order, so two
   * components contributing disjoint keys to the same file both survive — the
   * last write for a path carries every fold, and a re-apply of the same set
   * reproduces it byte for byte.
   */
  const folded = new Map<string, Record<string, unknown>>();

  for (const component of resolved.components) {
    const componentEntries: EccOwnedFile[] = [];
    for (const file of component.files) {
      const live = readLiveDestination(resolved.root, file.path);
      const plan = {
        componentId: component.id,
        path: file.path,
        operation: file.operation,
      };
      if (file.operation === "copy-file") {
        const claim = index.wholeFiles.get(file.path);
        if (live !== undefined && claim !== component.id) {
          throw new Error(
            `refusing to claim an existing unowned ECC materialization destination: ${file.path} (component ${component.id})`,
          );
        }
        const previous = ownedEntry(receipt, component.id, file.path);
        const liveSha = live === undefined ? undefined : ownedFileSha256(live);
        if (live !== undefined && previous !== undefined && liveSha !== previous.contentSha256) {
          throw new Error(
            `refusing to overwrite a hand-edited owned ECC materialization destination: ${file.path} (component ${component.id})`,
          );
        }
        componentEntries.push({
          path: file.path,
          operation: "copy-file",
          contentSha256: file.contentSha256,
        });
        if (liveSha === file.contentSha256) {
          unchanged.push({ ...plan, action: "unchanged" });
          continue;
        }
        writes.push({
          plan: { ...plan, action: live === undefined ? "create" : "update" },
          contents: file.bytes,
        });
        continue;
      }

      const wholeFileOwner = index.wholeFiles.get(file.path);
      if (wholeFileOwner !== undefined) {
        throw new Error(
          `refusing to merge into an ECC materialization destination owned as a whole file: ${file.path} (component ${component.id}, owner ${wholeFileOwner})`,
        );
      }
      const document = live === undefined ? {} : parseJsonObject(live.toString("utf8"));
      if (document === undefined) {
        throw new Error(
          `refusing to merge into an ECC materialization destination that is not a JSON object: ${file.path} (component ${component.id})`,
        );
      }
      const previous = ownedEntry(receipt, component.id, file.path);
      for (const key of file.ownedKeys ?? []) {
        if (!Object.hasOwn(document, key)) continue;
        if (index.jsonKeys.get(`${file.path}/${key}`) === component.id) continue;
        throw new Error(
          `refusing to claim an unowned ECC materialization JSON key: ${key} in ${file.path} (component ${component.id})`,
        );
      }
      if (live !== undefined && previous !== undefined && previous.operation === "merge-json") {
        const liveSha = ownedFragmentSha256(ownedFragment(document, previous.ownedKeys));
        if (liveSha !== previous.contentSha256) {
          throw new Error(
            `refusing to overwrite hand-edited owned ECC materialization JSON keys: ${file.path} (component ${component.id})`,
          );
        }
      }
      const createdByAih =
        previous !== undefined && previous.operation === "merge-json"
          ? previous.createdByAih
          : live === undefined;
      componentEntries.push({
        path: file.path,
        operation: "merge-json",
        contentSha256: file.contentSha256,
        ownedKeys: [...(file.ownedKeys ?? [])],
        createdByAih,
      });
      const next = { ...(folded.get(file.path) ?? document), ...file.fragment };
      folded.set(file.path, next);
      const merged = Buffer.from(jsonText(next), "utf8");
      if (live !== undefined && merged.equals(live)) {
        unchanged.push({ ...plan, action: "unchanged" });
        continue;
      }
      writes.push({
        plan: { ...plan, action: live === undefined ? "create" : "update" },
        contents: merged,
      });
    }
    entries.set(component.id, componentEntries);
  }
  return { writes, unchanged, entries };
}

interface SubtractionPlan {
  steps: SubtractStep[];
  advisories: EccMaterializationAdvisory[];
  /** Entries that could NOT be subtracted and therefore keep their ownership record. */
  retained: Map<string, EccOwnedFile[]>;
}

/**
 * The removal path: subtract only bytes that still match the receipt. A drifted
 * file keeps its ownership record and is reported by component and path — never
 * deleted, never replayed. A file that is already gone is reported too, but has
 * nothing left to own.
 */
function planSubtraction(
  root: string,
  components: readonly EccMaterializedComponent[],
): SubtractionPlan {
  const steps: SubtractStep[] = [];
  const advisories: EccMaterializationAdvisory[] = [];
  const retained = new Map<string, EccOwnedFile[]>();
  /**
   * Subtractions from one document also fold: each component removes its own
   * keys from what the previous one left, so the final state of a shared
   * destination is every owner subtracted — not the last one to be planned.
   * Drift is still judged against the live bytes, which no step has touched yet.
   */
  const working = new Map<string, Record<string, unknown>>();

  for (const component of components) {
    const keep: EccOwnedFile[] = [];
    for (const file of component.files) {
      const live = readLiveDestination(root, file.path);
      const plan = {
        componentId: component.id,
        path: file.path,
        operation: file.operation,
      };
      if (live === undefined) {
        advisories.push({
          componentId: component.id,
          path: file.path,
          reason: "missing",
          detail: `owned ECC materialization destination is already absent: ${file.path}`,
        });
        continue;
      }
      if (file.operation === "copy-file") {
        if (ownedFileSha256(live) !== file.contentSha256) {
          advisories.push({
            componentId: component.id,
            path: file.path,
            reason: "drifted",
            detail: `owned ECC materialization destination no longer matches its receipt: ${file.path}`,
          });
          keep.push(file);
          continue;
        }
        steps.push({ plan: { ...plan, action: "remove" } });
        continue;
      }
      const document = parseJsonObject(live.toString("utf8"));
      if (
        document === undefined ||
        ownedFragmentSha256(ownedFragment(document, file.ownedKeys)) !== file.contentSha256
      ) {
        advisories.push({
          componentId: component.id,
          path: file.path,
          reason: "drifted",
          detail: `owned ECC materialization JSON keys no longer match their receipt: ${file.path}`,
        });
        keep.push(file);
        continue;
      }
      const owned = new Set(file.ownedKeys);
      const remaining = Object.fromEntries(
        Object.entries(working.get(file.path) ?? document).filter(([key]) => !owned.has(key)),
      );
      working.set(file.path, remaining);
      // Creating the file does not make AIH the owner of everything later
      // written into it: removal is authorized only while the owned keys are
      // still its sole content. One operator key and the file survives.
      if (file.createdByAih && Object.keys(remaining).length === 0) {
        steps.push({ plan: { ...plan, action: "remove" } });
        continue;
      }
      steps.push({
        plan: { ...plan, action: "subtract-keys" },
        contents: Buffer.from(jsonText(remaining), "utf8"),
      });
    }
    if (keep.length > 0) retained.set(component.id, keep);
  }
  return { steps, advisories, retained };
}

/**
 * Perform one owned-content step: the removal or rewrite is announced first, so
 * the ordering is observable at the boundary rather than after the fact.
 */
function commitContent(root: string, step: SubtractStep, deps: EccMaterializationDeps): void {
  deps.onStep?.({
    phase: "content",
    kind: step.contents === undefined ? "remove" : "write",
    path: step.plan.path,
    componentId: step.plan.componentId,
  });
  if (step.contents === undefined) {
    removeDestination(root, step.plan.path);
    return;
  }
  writeDestinationAtomic(
    root,
    step.plan.path,
    step.contents,
    MATERIALIZED_CONTENT_MODE,
    deps.rename,
  );
}

function receiptComponents(
  resolved: ResolvedRequest,
  entries: Map<string, EccOwnedFile[]>,
  receipt: EccMaterializationReceipt | undefined,
  retained: Map<string, EccOwnedFile[]>,
): EccMaterializedComponent[] {
  const selectedIds = new Set(resolved.components.map((component) => component.id));
  const selected = resolved.components.map((component) => ({
    id: component.id,
    authorization: component.authorization,
    provenance: component.provenance,
    // A dropped file that could not be subtracted keeps its record: bytes AIH
    // still owns are never silently disowned.
    files: [...(entries.get(component.id) ?? []), ...(retained.get(component.id) ?? [])].sort(
      (left, right) => byText(left.path, right.path),
    ),
  }));
  const kept = (receipt?.components ?? [])
    .filter((component) => !selectedIds.has(component.id) && retained.has(component.id))
    .map((component) => ({ ...component, files: retained.get(component.id) ?? [] }));
  return [...selected, ...kept].sort((left, right) => byText(left.id, right.id));
}

function commitReceipt(
  root: string,
  components: EccMaterializedComponent[],
  deps: EccMaterializationDeps,
): EccMaterializationReceipt | undefined {
  const state = readEccMaterializationReceipt(root);
  const raw = state.state === "valid" ? state.raw : undefined;
  if (components.length === 0) {
    if (state.state === "absent") return undefined;
    deps.onStep?.({ phase: "receipt", kind: "remove", path: ECC_MATERIALIZATION_RECEIPT_PATH });
    removeDestination(root, ECC_MATERIALIZATION_RECEIPT_PATH);
    return undefined;
  }
  const receipt: EccMaterializationReceipt = {
    format: ECC_MATERIALIZATION_RECEIPT_FORMAT,
    schemaVersion: 1,
    components,
  };
  const text = serializeEccMaterializationReceipt(receipt);
  if (text === raw) return receipt;
  deps.onStep?.({ phase: "receipt", kind: "write", path: ECC_MATERIALIZATION_RECEIPT_PATH });
  writeDestinationAtomic(
    root,
    ECC_MATERIALIZATION_RECEIPT_PATH,
    Buffer.from(text, "utf8"),
    MATERIALIZATION_RECEIPT_MODE,
    deps.rename,
  );
  return receipt;
}

function ledgerUpdate(
  root: string,
  components: readonly EccMaterializedComponent[],
  deps: EccMaterializationDeps,
): void {
  deps.onLedgerUpdate?.({
    root,
    components: components.map((component) => ({
      id: component.id as EccComponentId,
      authorization: component.authorization,
    })),
  });
}

/**
 * Ownership the request no longer carries: every file of a deselected
 * component, and every file a still-selected component dropped. Left behind,
 * both are the same defect — owned bytes no selection asked for and no record
 * would still claim.
 */
function staleOwnership(
  resolved: ResolvedRequest,
  receipt: EccMaterializationReceipt | undefined,
): EccMaterializedComponent[] {
  const requested = new Map(
    resolved.components.map((component) => [
      component.id,
      new Set(component.files.map((file) => file.path)),
    ]),
  );
  return (receipt?.components ?? [])
    .map((component) => ({
      ...component,
      files: component.files.filter(
        (file) => !(requested.get(component.id)?.has(file.path) ?? false),
      ),
    }))
    .filter((component) => component.files.length > 0);
}

/** The full plan — what would be written and what would be subtracted — with no writes at all. */
export function previewEccMaterialization(
  request: EccMaterializationRequest,
): EccMaterializationPlan {
  const resolved = resolveRequest(request);
  const receipt = currentReceipt(resolved.root);
  const materialize = planMaterialize(resolved, receipt);
  const subtraction = planSubtraction(resolved.root, staleOwnership(resolved, receipt));
  return {
    root: resolved.root,
    write: materialize.writes.map((step) => step.plan),
    subtract: subtraction.steps.map((step) => step.plan),
    advisories: subtraction.advisories,
  };
}

/**
 * Materialize the request and subtract whatever it no longer carries. Content
 * is written before the ownership record, each file lands through a temp+rename
 * so a destination is never half-written, and an existing destination AIH does
 * not own — or one that was hand-edited after AIH wrote it — refuses by name
 * instead of being absorbed.
 */
export function applyEccMaterialization(
  request: EccMaterializationRequest,
  deps: EccMaterializationDeps = {},
): EccMaterializationResult {
  const resolved = resolveRequest(request);
  const receipt = currentReceipt(resolved.root);
  const materialize = planMaterialize(resolved, receipt);
  const subtraction = planSubtraction(resolved.root, staleOwnership(resolved, receipt));

  for (const step of subtraction.steps) commitContent(resolved.root, step, deps);
  for (const step of materialize.writes) commitContent(resolved.root, step, deps);

  const components = receiptComponents(
    resolved,
    materialize.entries,
    receipt,
    subtraction.retained,
  );
  const committed = commitReceipt(resolved.root, components, deps);
  ledgerUpdate(resolved.root, components, deps);
  return {
    root: resolved.root,
    written: materialize.writes.map((step) => step.plan),
    removed: subtraction.steps.map((step) => step.plan),
    unchanged: materialize.unchanged,
    advisories: subtraction.advisories,
    receipt: committed,
  };
}

/**
 * Restore owned files whose live bytes still match the receipt — and only
 * those. A drifted file is reported by component and path and never
 * overwritten; a request that contradicts the receipt is an update, not a
 * repair, and refuses.
 */
export function repairEccMaterialization(
  request: EccMaterializationRequest,
  deps: EccMaterializationDeps = {},
): EccMaterializationResult {
  const resolved = resolveRequest(request);
  const receipt = currentReceipt(resolved.root);
  if (receipt === undefined) {
    throw new Error("ECC materialization repair requires an ownership receipt");
  }
  const sources = new Map(
    resolved.components.flatMap((component) =>
      component.files.map((file) => [`${component.id}/${file.path}`, file] as const),
    ),
  );
  const written: EccMaterializationFilePlan[] = [];
  const unchanged: EccMaterializationFilePlan[] = [];
  const advisories: EccMaterializationAdvisory[] = [];

  for (const component of receipt.components) {
    for (const file of component.files) {
      const plan = {
        componentId: component.id,
        path: file.path,
        operation: file.operation,
      };
      const live = readLiveDestination(resolved.root, file.path);
      if (live !== undefined) {
        const document =
          file.operation === "merge-json" ? parseJsonObject(live.toString("utf8")) : undefined;
        const liveSha =
          file.operation === "copy-file"
            ? ownedFileSha256(live)
            : document === undefined
              ? undefined
              : ownedFragmentSha256(ownedFragment(document, file.ownedKeys));
        if (liveSha === file.contentSha256) {
          unchanged.push({ ...plan, action: "unchanged" });
          continue;
        }
        advisories.push({
          componentId: component.id,
          path: file.path,
          reason: "drifted",
          detail: `owned ECC materialization destination no longer matches its receipt: ${file.path}`,
        });
        continue;
      }
      const source = sources.get(`${component.id}/${file.path}`);
      if (source === undefined) {
        advisories.push({
          componentId: component.id,
          path: file.path,
          reason: "missing",
          detail: `owned ECC materialization destination is absent and the request carries no source for it: ${file.path}`,
        });
        continue;
      }
      if (source.contentSha256 !== file.contentSha256) {
        throw new Error(
          `ECC materialization repair source contradicts the receipt: ${file.path} (component ${component.id})`,
        );
      }
      const contents =
        file.operation === "copy-file"
          ? source.bytes
          : Buffer.from(jsonText({ ...source.fragment }), "utf8");
      commitContent(resolved.root, { plan: { ...plan, action: "create" }, contents }, deps);
      written.push({ ...plan, action: "create" });
    }
  }
  return {
    root: resolved.root,
    written,
    removed: [],
    unchanged,
    advisories,
    receipt,
  };
}

/**
 * Subtract every owned component. Only bytes that still match the receipt are
 * removed; anything else degrades to an advisory that names the component and
 * the path. Owned content goes before the ownership record, and the record
 * document itself goes last.
 */
export function uninstallEccMaterialization(
  root: string,
  deps: EccMaterializationDeps = {},
): EccMaterializationResult {
  const rootReal = materializationRoot(root);
  const state = readEccMaterializationReceipt(rootReal);
  if (state.state === "malformed") {
    return {
      root: rootReal,
      written: [],
      removed: [],
      unchanged: [],
      advisories: [
        {
          path: ECC_MATERIALIZATION_RECEIPT_PATH,
          reason: "malformed-receipt",
          detail: `${state.detail}; refusing every ownership claim, nothing removed`,
        },
      ],
      receipt: undefined,
    };
  }
  if (state.state === "absent") {
    return {
      root: rootReal,
      written: [],
      removed: [],
      unchanged: [],
      advisories: [],
      receipt: undefined,
    };
  }
  const subtraction = planSubtraction(rootReal, state.receipt.components);
  for (const step of subtraction.steps) commitContent(rootReal, step, deps);
  const components = state.receipt.components
    .filter((component) => subtraction.retained.has(component.id))
    .map((component) => ({
      ...component,
      files: subtraction.retained.get(component.id) ?? [],
    }));
  const committed = commitReceipt(rootReal, components, deps);
  ledgerUpdate(rootReal, components, deps);
  return {
    root: rootReal,
    written: [],
    removed: subtraction.steps.map((step) => step.plan),
    unchanged: [],
    advisories: subtraction.advisories,
    receipt: committed,
  };
}

export { eccMaterializationReceiptPath };
