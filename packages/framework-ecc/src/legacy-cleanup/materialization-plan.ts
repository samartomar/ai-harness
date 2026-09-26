import { createHash } from "node:crypto";
import {
  assertMaterializedComponentId,
  type DestinationExpectation,
  type DestinationRead,
  destinationIdentity,
  displaySafe,
  ECC_MATERIALIZATION_RECEIPT_FORMAT,
  ECC_MATERIALIZATION_RECEIPT_PATH,
  type EccCoreDerivedEvidenceReferenceV1,
  type EccCoreDerivedEvidenceV2,
  type EccMaterializationReceipt,
  type EccMaterializedComponent,
  type EccOwnedFile,
  exceedsJsonDepth,
  inspectDestination,
  MATERIALIZATION_RECEIPT_MODE,
  MATERIALIZED_CONTENT_MODE,
  MAX_MATERIALIZED_COMPONENTS,
  materializationRoot,
  ownedFragmentDigest,
  parseJsonObject,
  readEccMaterializationReceipt,
  serializeEccMaterializationReceipt,
} from "@aihq/core/framework-host";
import type {
  EccMaterializationAdvisory,
  EccMaterializationFilePlan,
  PlannedOperation,
  PlannedStep,
} from "../ecc/materialization-types.js";

function byText(left: string, right: string): number {
  return left.localeCompare(right);
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

export function currentReceipt(root: string): EccMaterializationReceipt | undefined {
  const state = readEccMaterializationReceipt(root);
  if (state.state === "malformed") throw new Error(state.detail);
  return state.state === "valid" ? state.receipt : undefined;
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
    // Writing over a destination keeps the mode it already had: AIH never
    // widens an operator file, and a re-apply never widens its own.
    mode: priorMode ?? MATERIALIZED_CONTENT_MODE,
  };
}

function retainedCoreDerivedEvidence(
  components: readonly EccMaterializedComponent[],
  existing: EccMaterializationReceipt | undefined,
  replacedComponentIds: ReadonlySet<string>,
  incoming?: EccCoreDerivedEvidenceReferenceV1,
): EccCoreDerivedEvidenceV2 | undefined {
  const componentIds = new Set(components.map((component) => component.id));
  const groups =
    existing?.schemaVersion === 2
      ? existing.coreDerivedEvidence.groups
          .map((group) => ({
            ...group,
            componentMappings: group.componentMappings.filter(
              (mapping) =>
                componentIds.has(mapping.componentId) &&
                !replacedComponentIds.has(mapping.componentId),
            ),
          }))
          .filter((group) => group.componentMappings.length > 0)
      : [];
  if (incoming !== undefined) {
    const componentMappings = incoming.componentMappings.filter((mapping) =>
      componentIds.has(mapping.componentId),
    );
    if (componentMappings.length > 0) groups.push({ ...incoming, componentMappings });
  }
  if (groups.length === 0) return undefined;
  const mapped = new Set(
    groups.flatMap((group) => group.componentMappings.map((mapping) => mapping.componentId)),
  );
  return {
    groups,
    legacyComponentIds: components.map((component) => component.id).filter((id) => !mapped.has(id)),
  };
}

function planReceipt(
  state: DestinationState,
  root: string,
  components: EccMaterializedComponent[],
  steps: PlannedStep[],
  coreDerivedEvidence?: EccCoreDerivedEvidenceReferenceV1,
  replacedComponentIds: ReadonlySet<string> = new Set(),
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
  const retainedEvidence = retainedCoreDerivedEvidence(
    components,
    existing.state === "valid" ? existing.receipt : undefined,
    replacedComponentIds,
    coreDerivedEvidence,
  );
  const receipt: EccMaterializationReceipt =
    retainedEvidence === undefined
      ? { format: ECC_MATERIALIZATION_RECEIPT_FORMAT, schemaVersion: 1, components }
      : {
          format: ECC_MATERIALIZATION_RECEIPT_FORMAT,
          schemaVersion: 2,
          components,
          coreDerivedEvidence: retainedEvidence,
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

/**
 * Plan subtraction for an exact subset already named by the live receipt. No
 * source bytes are accepted or reconstructed; unrelated receipt ownership is
 * preserved and drifted selected content remains recorded.
 */
export function planEccComponentSubtraction(
  root: string,
  componentIds: readonly string[],
): PlannedOperation {
  const rootReal = materializationRoot(root);
  if (
    componentIds.length === 0 ||
    componentIds.length > MAX_MATERIALIZED_COMPONENTS ||
    new Set(componentIds).size !== componentIds.length
  ) {
    throw new Error("ECC component subtraction selection is invalid");
  }
  const ids = new Set(componentIds.map((id) => assertMaterializedComponentId(id)));
  const receipt = currentReceipt(rootReal);
  if (
    receipt === undefined ||
    [...ids].some((id) => !receipt.components.some((c) => c.id === id))
  ) {
    throw new Error("ECC component subtraction requires exact receipt ownership");
  }
  const selected = receipt.components.filter(({ id }) => ids.has(id));
  const state = new DestinationState(rootReal);
  const subtraction = planSubtraction(state, selected);
  const components = receipt.components
    .flatMap((component): EccMaterializedComponent[] => {
      if (!ids.has(component.id)) return [structuredClone(component)];
      const retained = subtraction.retained.get(component.id) ?? [];
      return retained.length === 0 ? [] : [{ ...structuredClone(component), files: retained }];
    })
    .sort((left, right) => byText(left.id, right.id));
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
