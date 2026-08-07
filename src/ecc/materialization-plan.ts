import { createHash } from "node:crypto";
import {
  type DestinationExpectation,
  type DestinationRead,
  inspectDestination,
  MATERIALIZATION_RECEIPT_MODE,
  MATERIALIZED_CONTENT_MODE,
  MAX_MATERIALIZED_FILE_BYTES,
  materializationRoot,
} from "./materialization-fs.js";
import {
  assertComponentSourcePath,
  assertMaterializedComponentId,
  assertOwnedJsonKey,
  assertOwnedRelativePath,
  destinationIdentity,
  displaySafe,
  ECC_MATERIALIZATION_RECEIPT_FORMAT,
  ECC_MATERIALIZATION_RECEIPT_PATH,
  type EccMaterializationReceipt,
  type EccMaterializedComponent,
  type EccOwnedFile,
  exceedsJsonDepth,
  MAX_MATERIALIZATION_RECEIPT_BYTES,
  MAX_MATERIALIZED_COMPONENTS,
  MAX_MATERIALIZED_FILES_PER_COMPONENT,
  ownedFileSha256,
  ownedFragmentSha256,
  readEccMaterializationReceipt,
  serializeEccMaterializationReceipt,
} from "./materialization-receipt.js";
import type {
  EccMaterializationAdvisory,
  EccMaterializationFilePlan,
  EccMaterializationRequest,
  PlannedOperation,
  PlannedStep,
  ResolvedFile,
  ResolvedRequest,
} from "./materialization-types.js";

/**
 * Planning for AIH-direct materialization: everything an operation decides
 * before it is allowed to touch a byte.
 *
 * Two properties this layer exists to hold. First, subtraction and
 * materialization are ONE ordered pass over ONE evolving destination state — a
 * merge planned against pre-subtraction bytes would re-insert the very keys the
 * same operation just removed, leaving AIH-authored content that no receipt
 * claims and no later operation could remove. Second, the complete ownership
 * record is built and schema-validated here, so a component that cannot be
 * recorded never reaches the filesystem.
 */

const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/**
 * Deliberate UNDER-estimates of the ownership record each input costs. They let
 * a request whose record could never be read back refuse before the engine
 * touches the filesystem at all; the exact check still runs at serialization,
 * so under-estimating is safe and over-estimating would refuse a legitimate
 * request.
 */
const MIN_RECORD_BYTES_PER_COMPONENT = 200;
const MIN_RECORD_BYTES_PER_FILE = 64;

function byText(left: string, right: string): number {
  return left.localeCompare(right);
}

function toBytes(value: Buffer | string): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Render a whole document, or refuse. `JSON.parse` accepts values far deeper
 * than `JSON.stringify` survives, so a deep value under an OPERATOR key opens
 * the parse gate and detonates the render gate — with the owned digest still
 * matching, so subtraction is already authorised. Removal paths turn undefined
 * into an advisory; write paths refuse by name.
 */
export function renderJsonDocument(value: unknown): string | undefined {
  if (exceedsJsonDepth(value)) return undefined;
  try {
    return jsonText(value);
  } catch {
    return undefined;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
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

/**
 * The owned keys of a document, on a null-prototype object: a `__proto__` key
 * assigned onto a normal object routes to the prototype setter, which would
 * both drop the key from the digest input and mutate the fragment's prototype.
 */
export function ownedFragment(
  document: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const fragment = Object.create(null) as Record<string, unknown>;
  for (const key of [...keys].sort(byText)) {
    if (Object.hasOwn(document, key)) fragment[key] = document[key];
  }
  return fragment;
}

/** The owned-fragment digest, or undefined when the value cannot be hashed at all. */
export function ownedFragmentDigest(
  document: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  try {
    return ownedFragmentSha256(ownedFragment(document, keys));
  } catch {
    return undefined;
  }
}

/**
 * The destination state a plan evolves. Every read goes through here, so a step
 * planned after another step on the same path sees what that step will leave,
 * not what is on disk right now.
 */
export class DestinationState {
  /**
   * Keyed by the FOLDED identity, the same key every ownership guard uses: on a
   * case-insensitive volume a step planned against one spelling must be visible
   * to a later step that reads another.
   */
  private readonly planned = new Map<string, { bytes: Buffer | undefined; mode: number }>();

  constructor(private readonly root: string) {}

  inspect(path: string): DestinationRead {
    const planned = this.planned.get(destinationIdentity(path));
    if (planned !== undefined) {
      return planned.bytes === undefined
        ? { state: "absent" }
        : { state: "present", bytes: planned.bytes, mode: planned.mode };
    }
    return inspectDestination(this.root, path);
  }

  /** The write-path read: an unreadable destination refuses rather than degrading. */
  read(path: string): Buffer | undefined {
    const live = this.inspect(path);
    if (live.state === "unreadable") throw new Error(`refusing ${live.detail}`);
    return live.state === "absent" ? undefined : live.bytes;
  }

  expectation(path: string): {
    expect: DestinationExpectation;
    prior?: Buffer;
    priorMode?: number;
  } {
    const live = this.inspect(path);
    if (live.state === "unreadable") throw new Error(`refusing ${live.detail}`);
    return live.state === "absent"
      ? { expect: { absent: true } }
      : { expect: { sha256: sha256(live.bytes) }, prior: live.bytes, priorMode: live.mode };
  }

  set(path: string, bytes: Buffer | undefined, mode = MATERIALIZED_CONTENT_MODE): void {
    this.planned.set(destinationIdentity(path), { bytes, mode });
  }
}

export function resolveRequest(request: EccMaterializationRequest): ResolvedRequest {
  const root = materializationRoot(request.root);
  if (request.components.length > MAX_MATERIALIZED_COMPONENTS) {
    throw new Error("ECC materialization component count exceeds the lifecycle boundary");
  }
  const seenComponents = new Set<string>();
  const wholeFileOwners = new Map<string, string>();
  const mergeOwners = new Map<string, string>();
  const jsonKeyOwners = new Map<string, string>();
  let total = 0;
  let recordBytes = 0;

  const components = request.components.map((component) => {
    const componentId = assertMaterializedComponentId(component.id);
    if (seenComponents.has(componentId)) {
      throw new Error(`duplicate ECC materialization component: ${displaySafe(componentId)}`);
    }
    seenComponents.add(componentId);
    assertComponentSourcePath(component.provenance.componentPath);
    recordBytes += MIN_RECORD_BYTES_PER_COMPONENT;
    if (
      component.files.length === 0 ||
      component.files.length > MAX_MATERIALIZED_FILES_PER_COMPONENT
    ) {
      throw new Error(
        `ECC materialization component file count is outside the lifecycle boundary: ${componentId}`,
      );
    }
    const seenPaths = new Set<string>();
    const files = component.files.map((file): ResolvedFile => {
      const path = assertOwnedRelativePath(file.path);
      const identity = destinationIdentity(path);
      if (seenPaths.has(identity)) {
        throw new Error(
          `duplicate ECC materialization destination: ${displaySafe(path)} (${componentId})`,
        );
      }
      seenPaths.add(identity);
      recordBytes += Buffer.byteLength(path, "utf8") + MIN_RECORD_BYTES_PER_FILE;
      if (recordBytes > MAX_MATERIALIZATION_RECEIPT_BYTES) {
        throw new Error(
          "ECC materialization ownership record would exceed the size this engine can read back",
        );
      }
      const bytes = toBytes(file.contents);
      total += bytes.byteLength;
      if (bytes.byteLength > MAX_MATERIALIZED_FILE_BYTES || total > MAX_TOTAL_BYTES) {
        throw new Error(
          `ECC materialization bytes exceed the lifecycle boundary: ${displaySafe(path)}`,
        );
      }
      if (file.kind === "copy-file") {
        const owner = wholeFileOwners.get(identity);
        if (owner !== undefined) {
          throw new Error(
            `ECC materialization destination is claimed by two components: ${path} (${owner}, ${component.id})`,
          );
        }
        wholeFileOwners.set(identity, component.id);
        return { path, operation: "copy-file", bytes, contentSha256: ownedFileSha256(bytes) };
      }
      const fragment = parseJsonObject(bytes.toString("utf8"));
      if (fragment === undefined) {
        throw new Error(
          `ECC materialization merge-json content is not a JSON object: ${displaySafe(path)}`,
        );
      }
      const ownedKeys = Object.keys(fragment).map(assertOwnedJsonKey).sort(byText);
      if (ownedKeys.length === 0) {
        throw new Error(
          `ECC materialization merge-json content owns no keys: ${displaySafe(path)}`,
        );
      }
      mergeOwners.set(identity, component.id);
      for (const key of ownedKeys) {
        const keyIdentity = `${identity}/${key}`;
        const owner = jsonKeyOwners.get(keyIdentity);
        if (owner !== undefined) {
          throw new Error(
            `ECC materialization JSON key is claimed by two components: ${key} in ${path} (${owner}, ${component.id})`,
          );
        }
        jsonKeyOwners.set(keyIdentity, component.id);
      }
      return {
        path,
        operation: "merge-json",
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

  for (const [identity, wholeOwner] of wholeFileOwners) {
    const mergeOwner = mergeOwners.get(identity);
    if (mergeOwner === undefined) continue;
    throw new Error(
      `ECC materialization destination mixes copy-file and merge-json: ${identity} (${wholeOwner}, ${mergeOwner})`,
    );
  }
  return { root, components: components.sort((left, right) => byText(left.id, right.id)) };
}

export function currentReceipt(root: string): EccMaterializationReceipt | undefined {
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
    ?.files.find((file) => destinationIdentity(file.path) === destinationIdentity(path));
}

/** Which component owns each destination — the claim an apply may not take silently. */
function ownershipIndex(receipt: EccMaterializationReceipt | undefined): {
  wholeFiles: Map<string, string>;
  jsonKeys: Map<string, string>;
} {
  const wholeFiles = new Map<string, string>();
  const jsonKeys = new Map<string, string>();
  for (const component of receipt?.components ?? []) {
    for (const file of component.files) {
      const identity = destinationIdentity(file.path);
      if (file.operation === "copy-file") {
        wholeFiles.set(identity, component.id);
        continue;
      }
      for (const key of file.ownedKeys) jsonKeys.set(`${identity}/${key}`, component.id);
    }
  }
  return { wholeFiles, jsonKeys };
}

interface SubtractionOutcome {
  steps: PlannedStep[];
  plans: EccMaterializationFilePlan[];
  advisories: EccMaterializationAdvisory[];
  /** Entries that could NOT be subtracted and therefore keep their ownership record. */
  retained: Map<string, EccOwnedFile[]>;
}

/**
 * The removal path: subtract only bytes that still match the receipt. A drifted
 * or unreadable file keeps its ownership record and is reported by component
 * and path — never deleted, never replayed. A file that is already gone is
 * reported too, but has nothing left to own.
 */
export function planSubtraction(
  state: DestinationState,
  components: readonly EccMaterializedComponent[],
): SubtractionOutcome {
  const steps: PlannedStep[] = [];
  const plans: EccMaterializationFilePlan[] = [];
  const advisories: EccMaterializationAdvisory[] = [];
  const retained = new Map<string, EccOwnedFile[]>();

  for (const component of components) {
    const keep: EccOwnedFile[] = [];
    for (const file of component.files) {
      const live = state.inspect(file.path);
      const plan = { componentId: component.id, path: file.path, operation: file.operation };
      if (live.state === "unreadable") {
        advisories.push({
          componentId: component.id,
          path: file.path,
          reason: "unreadable",
          detail: `owned ECC materialization destination cannot be verified: ${live.detail}`,
        });
        keep.push(file);
        continue;
      }
      if (live.state === "absent") {
        advisories.push({
          componentId: component.id,
          path: file.path,
          reason: "missing",
          detail: `owned ECC materialization destination is already absent: ${file.path}`,
        });
        continue;
      }
      if (file.operation === "copy-file") {
        if (sha256(live.bytes) !== file.contentSha256) {
          advisories.push({
            componentId: component.id,
            path: file.path,
            reason: "drifted",
            detail: `owned ECC materialization destination no longer matches its receipt: ${file.path}`,
          });
          keep.push(file);
          continue;
        }
        steps.push(removalStep(state, { ...plan, action: "remove" }));
        plans.push({ ...plan, action: "remove" });
        continue;
      }
      const document = parseJsonObject(live.bytes.toString("utf8"));
      if (
        document === undefined ||
        ownedFragmentDigest(document, file.ownedKeys) !== file.contentSha256
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
        Object.entries(document).filter(([key]) => !owned.has(key)),
      );
      // Creating the file does not make AIH the owner of everything later
      // written into it: removal is authorized only while the owned keys are
      // still its sole content. One operator key and the file survives.
      if (file.createdByAih && Object.keys(remaining).length === 0) {
        steps.push(removalStep(state, { ...plan, action: "remove" }));
        plans.push({ ...plan, action: "remove" });
        continue;
      }
      const rendered = renderJsonDocument(remaining);
      if (rendered === undefined) {
        advisories.push({
          componentId: component.id,
          path: file.path,
          reason: "unreadable",
          detail: `owned ECC materialization destination holds a value nested beyond what this engine renders: ${displaySafe(file.path)}`,
        });
        keep.push(file);
        continue;
      }
      const contents = Buffer.from(rendered, "utf8");
      steps.push(plannedWrite(state, { ...plan, action: "subtract-keys" }, contents));
      plans.push({ ...plan, action: "subtract-keys" });
    }
    if (keep.length > 0) retained.set(component.id, keep);
  }
  return { steps, plans, advisories, retained };
}

function removalStep(state: DestinationState, plan: EccMaterializationFilePlan): PlannedStep {
  const { expect, prior, priorMode } = state.expectation(plan.path);
  state.set(plan.path, undefined);
  return {
    phase: "content",
    kind: "remove",
    path: plan.path,
    plan,
    expect,
    ...(prior === undefined ? {} : { prior }),
    ...(priorMode === undefined ? {} : { priorMode }),
    mode: MATERIALIZED_CONTENT_MODE,
  };
}

export function plannedWrite(
  state: DestinationState,
  plan: EccMaterializationFilePlan,
  contents: Buffer,
): PlannedStep {
  const { expect, prior, priorMode } = state.expectation(plan.path);
  state.set(plan.path, contents);
  return {
    phase: "content",
    kind: "write",
    path: plan.path,
    plan,
    contents,
    expect,
    ...(prior === undefined ? {} : { prior }),
    ...(priorMode === undefined ? {} : { priorMode }),
    mode: MATERIALIZED_CONTENT_MODE,
  };
}

/**
 * Ownership the request no longer carries at all: every file of a deselected
 * component, and every path a still-selected component dropped. Keys a
 * still-selected component dropped from a path it keeps are subtracted by the
 * write that replaces that document.
 */
function staleOwnership(
  resolved: ResolvedRequest,
  receipt: EccMaterializationReceipt | undefined,
): EccMaterializedComponent[] {
  const requested = new Map(
    resolved.components.map((component) => [
      component.id,
      new Set(component.files.map((file) => destinationIdentity(file.path))),
    ]),
  );
  return (receipt?.components ?? [])
    .map((component) => ({
      ...component,
      files: component.files.filter(
        (file) => !(requested.get(component.id)?.has(destinationIdentity(file.path)) ?? false),
      ),
    }))
    .filter((component) => component.files.length > 0);
}

interface MaterializeOutcome {
  steps: PlannedStep[];
  plans: EccMaterializationFilePlan[];
  unchanged: EccMaterializationFilePlan[];
  entries: Map<string, EccOwnedFile[]>;
}

function planMaterialize(
  resolved: ResolvedRequest,
  receipt: EccMaterializationReceipt | undefined,
  state: DestinationState,
): MaterializeOutcome {
  const index = ownershipIndex(receipt);
  const steps: PlannedStep[] = [];
  const plans: EccMaterializationFilePlan[] = [];
  const unchanged: EccMaterializationFilePlan[] = [];
  const entries = new Map<string, EccOwnedFile[]>();
  /**
   * Whether AIH created each merge-json DESTINATION. It is a property of the
   * file, not of any one component: a component joining a file AIH created must
   * not record `false`, or uninstall would strand an empty document.
   */
  const created = new Map<string, boolean>();

  for (const component of resolved.components) {
    const componentEntries: EccOwnedFile[] = [];
    for (const file of component.files) {
      const identity = destinationIdentity(file.path);
      const plan = { componentId: component.id, path: file.path, operation: file.operation };
      const live = state.read(file.path);

      if (file.operation === "copy-file") {
        if (live !== undefined && index.wholeFiles.get(identity) !== component.id) {
          throw new Error(
            `refusing to claim an existing unowned ECC materialization destination: ${file.path} (component ${component.id})`,
          );
        }
        const previous = ownedEntry(receipt, component.id, file.path);
        const liveSha = live === undefined ? undefined : sha256(live);
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
        const action = live === undefined ? "create" : "update";
        steps.push(plannedWrite(state, { ...plan, action }, file.bytes));
        plans.push({ ...plan, action });
        continue;
      }

      const wholeFileOwner = index.wholeFiles.get(identity);
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
      for (const key of file.ownedKeys) {
        if (!Object.hasOwn(document, key)) continue;
        if (index.jsonKeys.get(`${identity}/${key}`) === component.id) continue;
        throw new Error(
          `refusing to claim an unowned ECC materialization JSON key: ${key} in ${file.path} (component ${component.id})`,
        );
      }
      if (live !== undefined && previous?.operation === "merge-json") {
        if (ownedFragmentDigest(document, previous.ownedKeys) !== previous.contentSha256) {
          throw new Error(
            `refusing to overwrite hand-edited owned ECC materialization JSON keys: ${file.path} (component ${component.id})`,
          );
        }
      }
      if (!created.has(identity)) {
        const recorded = (receipt?.components ?? [])
          .flatMap((entry) => entry.files)
          .find(
            (entry) =>
              entry.operation === "merge-json" && destinationIdentity(entry.path) === identity,
          );
        created.set(
          identity,
          recorded?.operation === "merge-json" ? recorded.createdByAih : live === undefined,
        );
      }
      componentEntries.push({
        path: file.path,
        operation: "merge-json",
        contentSha256: file.contentSha256,
        ownedKeys: [...file.ownedKeys],
        createdByAih: created.get(identity) ?? live === undefined,
      });
      // Keys this component owned before and no longer carries leave with the
      // same write that lands the new ones.
      const dropped = new Set(
        previous?.operation === "merge-json"
          ? previous.ownedKeys.filter((key) => !file.ownedKeys.includes(key))
          : [],
      );
      const base = Object.fromEntries(
        Object.entries(document).filter(([key]) => !dropped.has(key)),
      );
      const rendered = renderJsonDocument({ ...base, ...file.fragment });
      if (rendered === undefined) {
        throw new Error(
          `refusing an ECC materialization destination nested beyond what this engine renders: ${displaySafe(file.path)} (component ${displaySafe(component.id)})`,
        );
      }
      const merged = Buffer.from(rendered, "utf8");
      if (merged.byteLength > MAX_MATERIALIZED_FILE_BYTES) {
        throw new Error(
          `ECC materialization merge result exceeds the readable size bound: ${file.path} (component ${component.id})`,
        );
      }
      if (live !== undefined && merged.equals(live)) {
        unchanged.push({ ...plan, action: "unchanged" });
        continue;
      }
      const action = live === undefined ? "create" : "update";
      steps.push(plannedWrite(state, { ...plan, action }, merged));
      plans.push({ ...plan, action });
    }
    entries.set(component.id, componentEntries);
  }
  return { steps, plans, unchanged, entries };
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
  return [...selected, ...kept]
    .filter((component) => component.files.length > 0)
    .sort((left, right) => byText(left.id, right.id));
}

/**
 * Build, validate, and append the ownership-record step. The record is rendered
 * and schema-checked HERE, before any caller has committed a byte: a component
 * that cannot be recorded must never reach the filesystem, because content
 * without a receipt is content nothing can ever revoke.
 */
function planReceipt(
  state: DestinationState,
  root: string,
  components: EccMaterializedComponent[],
  steps: PlannedStep[],
): EccMaterializationReceipt | undefined {
  const existing = readEccMaterializationReceipt(root);
  const raw = existing.state === "valid" ? existing.raw : undefined;
  if (components.length === 0) {
    if (existing.state === "absent") return undefined;
    const { expect, prior } = state.expectation(ECC_MATERIALIZATION_RECEIPT_PATH);
    steps.push({
      phase: "receipt",
      kind: "remove",
      path: ECC_MATERIALIZATION_RECEIPT_PATH,
      expect,
      ...(prior === undefined ? {} : { prior }),
      mode: MATERIALIZATION_RECEIPT_MODE,
    });
    return undefined;
  }
  const receipt: EccMaterializationReceipt = {
    format: ECC_MATERIALIZATION_RECEIPT_FORMAT,
    schemaVersion: 1,
    components,
  };
  const text = serializeEccMaterializationReceipt(receipt);
  if (text === raw) return receipt;
  const { expect, prior } = state.expectation(ECC_MATERIALIZATION_RECEIPT_PATH);
  steps.push({
    phase: "receipt",
    kind: "write",
    path: ECC_MATERIALIZATION_RECEIPT_PATH,
    contents: Buffer.from(text, "utf8"),
    expect,
    ...(prior === undefined ? {} : { prior }),
    mode: MATERIALIZATION_RECEIPT_MODE,
  });
  return receipt;
}

/**
 * Plan an apply. Subtraction is planned first and materialization second
 * against the state subtraction leaves, so the two halves can never contradict
 * each other.
 */
export function planEccMaterialization(request: EccMaterializationRequest): PlannedOperation {
  const resolved = resolveRequest(request);
  const receipt = currentReceipt(resolved.root);
  const state = new DestinationState(resolved.root);
  const subtraction = planSubtraction(state, staleOwnership(resolved, receipt));
  const materialize = planMaterialize(resolved, receipt, state);
  const components = receiptComponents(
    resolved,
    materialize.entries,
    receipt,
    subtraction.retained,
  );
  const steps = [...subtraction.steps, ...materialize.steps];
  const committed = planReceipt(state, resolved.root, components, steps);
  return {
    root: resolved.root,
    steps,
    write: materialize.plans,
    subtract: subtraction.plans,
    unchanged: materialize.unchanged,
    advisories: subtraction.advisories,
    components,
    receipt: committed,
  };
}

/** Plan a full uninstall: subtract every owned component, record last. */
export function planEccUninstall(root: string): PlannedOperation {
  const rootReal = materializationRoot(root);
  const receipt = currentReceipt(rootReal);
  const state = new DestinationState(rootReal);
  const subtraction = planSubtraction(state, receipt?.components ?? []);
  const components = (receipt?.components ?? [])
    .filter((component) => subtraction.retained.has(component.id))
    .map((component) => ({ ...component, files: subtraction.retained.get(component.id) ?? [] }));
  const steps = [...subtraction.steps];
  const committed = planReceipt(state, rootReal, components, steps);
  return {
    root: rootReal,
    steps,
    write: [],
    subtract: subtraction.plans,
    unchanged: [],
    advisories: subtraction.advisories,
    components,
    receipt: committed,
  };
}
