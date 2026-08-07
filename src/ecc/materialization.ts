import type { EccComponentId } from "./components.js";
import { commitMaterializationSteps, MATERIALIZED_CONTENT_MODE } from "./materialization-fs.js";
import {
  currentReceipt,
  DestinationState,
  ownedFragmentDigest,
  parseJsonObject,
  planEccMaterialization,
  planEccUninstall,
  plannedWrite,
  renderJsonDocument,
  resolveRequest,
} from "./materialization-plan.js";
import {
  destinationIdentity,
  ECC_MATERIALIZATION_RECEIPT_PATH,
  type EccMaterializedComponent,
  ownedFileSha256,
  readEccMaterializationReceipt,
} from "./materialization-receipt.js";
import type {
  EccMaterializationAdvisory,
  EccMaterializationDeps,
  EccMaterializationFilePlan,
  EccMaterializationPlan,
  EccMaterializationRequest,
  EccMaterializationResult,
  PlannedOperation,
  PlannedStep,
  ResolvedFile,
} from "./materialization-types.js";

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
 * receipt entry the request no longer carries, because ownership that outlives
 * its selection is exactly the defect receipts exist to prevent.
 *
 * Planning happens entirely in `materialization-plan.ts` and commits entirely
 * through `materialization-fs.ts`, which re-pins each destination immediately
 * before its own side effect and rolls back everything it already applied if a
 * later step fails.
 */

export { eccMaterializationReceiptPath } from "./materialization-receipt.js";
export type {
  EccMaterializationAction,
  EccMaterializationAdvisory,
  EccMaterializationComponentInput,
  EccMaterializationDeps,
  EccMaterializationFileInput,
  EccMaterializationFilePlan,
  EccMaterializationLedgerUpdate,
  EccMaterializationPlan,
  EccMaterializationRequest,
  EccMaterializationResult,
  EccMaterializationStep,
} from "./materialization-types.js";

function commit(operation: PlannedOperation, deps: EccMaterializationDeps): void {
  commitMaterializationSteps(
    operation.root,
    operation.steps.map((step) => ({
      path: step.path,
      mode: step.mode,
      expect: step.expect,
      ...(step.contents === undefined ? {} : { contents: step.contents }),
      ...(step.prior === undefined ? {} : { prior: step.prior }),
      ...(step.priorMode === undefined ? {} : { priorMode: step.priorMode }),
      announce: () =>
        deps.onStep?.({
          phase: step.phase,
          kind: step.kind,
          path: step.path,
          ...(step.plan === undefined ? {} : { componentId: step.plan.componentId }),
        }),
    })),
    deps.rename,
  );
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

function result(operation: PlannedOperation): EccMaterializationResult {
  return {
    root: operation.root,
    written: operation.write,
    removed: operation.subtract,
    unchanged: operation.unchanged,
    advisories: operation.advisories,
    receipt: operation.receipt,
  };
}

/** The full plan — what would be written and what would be subtracted — with no writes at all. */
export function previewEccMaterialization(
  request: EccMaterializationRequest,
): EccMaterializationPlan {
  const operation = planEccMaterialization(request);
  return {
    root: operation.root,
    write: operation.write,
    subtract: operation.subtract,
    advisories: operation.advisories,
  };
}

/**
 * Materialize the request and subtract whatever it no longer carries. Content
 * is written before the ownership record, the complete record is validated
 * before the first byte moves, and an existing destination AIH does not own —
 * or one hand-edited after AIH wrote it — refuses by path and component instead
 * of being absorbed.
 */
export function applyEccMaterialization(
  request: EccMaterializationRequest,
  deps: EccMaterializationDeps = {},
): EccMaterializationResult {
  const operation = planEccMaterialization(request);
  commit(operation, deps);
  ledgerUpdate(operation.root, operation.components, deps);
  return result(operation);
}

/**
 * Subtract every owned component. Only bytes that still match the receipt are
 * removed; anything else degrades to an advisory that names the component and
 * the path. A malformed record refuses every claim and removes nothing.
 */
export function uninstallEccMaterialization(
  root: string,
  deps: EccMaterializationDeps = {},
): EccMaterializationResult {
  const state = readEccMaterializationReceipt(root);
  if (state.state === "malformed") {
    return {
      root,
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
  const operation = planEccUninstall(root);
  commit(operation, deps);
  ledgerUpdate(operation.root, operation.components, deps);
  return result(operation);
}

interface RestoreTarget {
  path: string;
  operation: "copy-file" | "merge-json";
  bytes?: Buffer;
  fragments: Record<string, unknown>[];
  plans: EccMaterializationFilePlan[];
}

/**
 * Restore owned files whose live bytes still match the receipt — and only
 * those. A drifted file is reported by component and path and never
 * overwritten; a request that contradicts the receipt is an update, not a
 * repair, and refuses. A destination several components share is rebuilt once,
 * from every fragment that owns part of it.
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
  const state = new DestinationState(resolved.root);
  const sources = new Map<string, ResolvedFile>(
    resolved.components.flatMap((component) =>
      component.files.map(
        (file) => [`${component.id}/${destinationIdentity(file.path)}`, file] as const,
      ),
    ),
  );
  const written: EccMaterializationFilePlan[] = [];
  const unchanged: EccMaterializationFilePlan[] = [];
  const advisories: EccMaterializationAdvisory[] = [];
  const restore = new Map<string, RestoreTarget>();

  for (const component of receipt.components) {
    for (const file of component.files) {
      const plan = { componentId: component.id, path: file.path, operation: file.operation };
      const live = state.inspect(file.path);
      if (live.state === "unreadable") {
        advisories.push({
          componentId: component.id,
          path: file.path,
          reason: "unreadable",
          detail: `owned ECC materialization destination cannot be verified: ${live.detail}`,
        });
        continue;
      }
      if (live.state === "present") {
        const document =
          file.operation === "merge-json"
            ? parseJsonObject(live.bytes.toString("utf8"))
            : undefined;
        const liveSha =
          file.operation === "copy-file"
            ? ownedFileSha256(live.bytes)
            : document === undefined
              ? undefined
              : ownedFragmentDigest(document, file.ownedKeys);
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
      const source = sources.get(`${component.id}/${destinationIdentity(file.path)}`);
      if (source === undefined) {
        advisories.push({
          componentId: component.id,
          path: file.path,
          reason: "missing",
          detail: `owned ECC materialization destination is absent and the request carries no source for it: ${file.path}`,
        });
        continue;
      }
      if (source.operation !== file.operation || source.contentSha256 !== file.contentSha256) {
        throw new Error(
          `ECC materialization repair source contradicts the receipt: ${file.path} (component ${component.id})`,
        );
      }
      const target = restore.get(destinationIdentity(file.path)) ?? {
        path: file.path,
        operation: file.operation,
        fragments: [],
        plans: [],
      };
      if (source.operation === "copy-file") target.bytes = source.bytes;
      else target.fragments.push(source.fragment);
      target.plans.push({ ...plan, action: "create" });
      restore.set(destinationIdentity(file.path), target);
    }
  }

  const steps: PlannedStep[] = [];
  for (const target of restore.values()) {
    const contents = target.operation === "copy-file" ? target.bytes : mergedFragments(target);
    if (contents === undefined) {
      advisories.push({
        path: target.path,
        reason: "unreadable",
        detail: `ECC materialization repair cannot render the restored document: ${target.path}`,
      });
      continue;
    }
    const [first] = target.plans;
    if (first === undefined) continue;
    steps.push(plannedWrite(state, { ...first, path: target.path }, contents));
    written.push(...target.plans);
  }
  commit({ ...emptyOperation(resolved.root), steps }, deps);
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
 * Fold every fragment that owns part of one destination into a single document,
 * on a null prototype: `Object.assign` routes a `__proto__` key to the prototype
 * setter, silently dropping it from what repair writes — the file would then
 * fail its own digest and become permanently unremovable.
 */
function mergedFragments(target: RestoreTarget): Buffer | undefined {
  const merged = Object.create(null) as Record<string, unknown>;
  for (const fragment of target.fragments) {
    for (const [key, value] of Object.entries(fragment)) merged[key] = value;
  }
  const rendered = renderJsonDocument(merged);
  return rendered === undefined ? undefined : Buffer.from(rendered, "utf8");
}

function emptyOperation(root: string): PlannedOperation {
  return {
    root,
    steps: [],
    write: [],
    subtract: [],
    unchanged: [],
    advisories: [],
    components: [],
    receipt: undefined,
  };
}

/** Re-exported so a caller can name the content mode this engine writes with. */
export { MATERIALIZED_CONTENT_MODE };
