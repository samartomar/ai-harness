import { safePolicyCommandArgument } from "../command-arguments.js";
import { projectWorkbenchPolicy, type WorkbenchPolicyBindingsV1 } from "../compile-policy.js";
import {
  AuthoringCatalogBundleV1Schema,
  WorkbenchActionV1Schema,
  type WorkbenchSourceInputsV1,
} from "../contracts.js";
import { importWorkbenchPolicySelections, serializeWorkbenchRepairV1 } from "../policy-import.js";
import { reduceWorkbenchAction, type WorkbenchReductionV1 } from "../selection-engine.js";
import { mountArtifactIntakeWorkbench } from "./artifact-intake-runtime.js";
import { mountWorkbench } from "./catalog-inventory.js";
import { mountLegacyWorkbench } from "./legacy-runtime.js";

interface WorkbenchSession {
  snapshotPolicy(): unknown;
  restorePolicy(policy: unknown): unknown;
}
interface BrowserModel {
  initialPolicy: unknown;
  workbenchBundle?: unknown;
  workbenchBindings?: unknown;
  workbenchSourceInputs: WorkbenchSourceInputsV1;
}
interface WorkbenchImportValidation {
  accepted: boolean;
  diagnostics: readonly string[];
}

declare const window: Window & {
  __aihWorkbenchModel?: unknown;
  __aihPolicyWorkbenchSession?: WorkbenchSession;
  __aihWorkbenchValidatePolicy?: (policy: unknown) => WorkbenchImportValidation;
  __aihWorkbenchApplyingProjection?: boolean;
  __aihSetWorkbenchView?: (view: string) => void;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function importedState(
  policy: unknown,
  bundle: import("../contracts.js").AuthoringCatalogBundleV1,
  bindings: WorkbenchPolicyBindingsV1,
  sourceInputs: WorkbenchSourceInputsV1,
) {
  return importWorkbenchPolicySelections(policy, bundle, bindings, sourceInputs);
}

function browserCommandArgumentErrors(policy: unknown): string[] {
  const root = object(policy);
  const governance = object(root?.governance);
  const catalog = object(governance?.catalog);
  const approvals = Array.isArray(object(governance?.authority)?.approvals)
    ? (object(governance?.authority)?.approvals as unknown[])
    : [];
  const candidates = ["reviewed", "custom"].flatMap((key) => {
    const collection = catalog?.[key];
    return Array.isArray(collection) ? collection : [];
  });
  const sources = [...candidates, ...approvals]
    .map((value) => object(value)?.source)
    .map(object)
    .filter((value): value is Record<string, unknown> => value !== undefined);
  const errors: string[] = [];
  for (const source of sources) {
    if (source.type !== "command" || !Array.isArray(source.args)) continue;
    for (const argument of source.args) {
      if (
        typeof argument !== "string" ||
        !safePolicyCommandArgument(argument, ["--registry=", "--index-url="])
      ) {
        errors.push(
          "Command source arguments must be safe tokens or exact HTTPS registry/index origins.",
        );
      }
    }
  }
  return [...new Set(errors)];
}

const model = object(window.__aihWorkbenchModel);
if (model === undefined) throw new Error("Policy Workbench model is unavailable.");
const browserModel = model as unknown as BrowserModel;
const sourceInputs = browserModel.workbenchSourceInputs;
const bundleResult = AuthoringCatalogBundleV1Schema.safeParse(browserModel.workbenchBundle);
const bindings = object(browserModel.workbenchBindings) as WorkbenchPolicyBindingsV1 | undefined;

// Legacy forms continue to own their grammar; generic inventory owns all catalog selection.
const bundle = bundleResult.success ? bundleResult.data : undefined;
const preparedCatalogValid = bundle !== undefined && bindings !== undefined;
window.__aihWorkbenchValidatePolicy = () => ({
  accepted: false,
  diagnostics: ["Prepared catalog is invalid or unavailable. Regenerate this artifact with Core."],
});
if (preparedCatalogValid) {
  window.__aihWorkbenchValidatePolicy = (policy) => {
    const candidate = object(policy);
    if (candidate?.schemaVersion !== 2 && candidate?.schemaVersion !== 3)
      return { accepted: false, diagnostics: ["Unsupported policy version"] };
    const commandErrors = browserCommandArgumentErrors(policy);
    if (commandErrors.length > 0) return { accepted: false, diagnostics: commandErrors };
    const imported = importedState(policy, bundle, bindings, sourceInputs);
    return { accepted: imported.accepted, diagnostics: imported.diagnostics };
  };
}
mountLegacyWorkbench(browserModel);
mountArtifactIntakeWorkbench();

if (preparedCatalogValid) {
  const root = document.getElementById("framework-rows");
  const session = window.__aihPolicyWorkbenchSession;
  if (root === null || session === undefined)
    throw new Error("Policy Workbench selection controller is unavailable.");
  let applyingWorkbenchProjection = false;
  const mounted = mountWorkbench(root, {
    bundle,
    initialState: importedState(browserModel.initialPolicy, bundle, bindings, sourceInputs).state,
    initialDiagnostics: importedState(browserModel.initialPolicy, bundle, bindings, sourceInputs)
      .diagnostics,
    inspectEvidence(asset) {
      document.dispatchEvent(
        new CustomEvent("aih-workbench-inspect-evidence", {
          detail: { assetId: asset.id },
        }),
      );
    },
    prepareApproval(asset) {
      window.__aihSetWorkbenchView?.("author");
      const form = document.getElementById("protected-form");
      const subject = document.getElementById("protected-subject-id") as HTMLInputElement | null;
      const kind = document.getElementById("protected-kind") as HTMLSelectElement | null;
      const section = form?.closest<HTMLElement>("[data-groupcard]");
      if (section !== null && section !== undefined) {
        section.dataset.open = "1";
        section.querySelector<HTMLElement>("[data-group]")?.setAttribute("aria-expanded", "true");
      }
      if (subject !== null) subject.value = asset.id;
      if (kind !== null && [...kind.options].some((option) => option.value === asset.kind))
        kind.value = asset.kind;
      form?.scrollIntoView({ block: "start" });
      subject?.focus({ preventScroll: true });
      document.dispatchEvent(
        new CustomEvent("aih-workbench-prepare-approval", {
          detail: { assetId: asset.id },
        }),
      );
    },
    dispatch(action) {
      const imported = importedState(session.snapshotPolicy(), bundle, bindings, sourceInputs);
      const current = imported.state;
      if (!imported.accepted)
        return {
          accepted: false,
          state: current,
          diagnostics: imported.diagnostics.map((message) => ({
            code: "unknown-asset" as const,
            message,
          })),
        };
      const reduced = reduceWorkbenchAction(bundle, current, action);
      if (!reduced.accepted) return reduced;
      const basePolicy = object(session.snapshotPolicy());
      if (basePolicy === undefined) {
        return {
          accepted: false,
          state: current,
          diagnostics: [
            {
              code: "unknown-asset",
              message: "Policy session returned an invalid policy.",
            },
          ],
        };
      }
      const persist = (policy: unknown): WorkbenchReductionV1 | undefined => {
        try {
          applyingWorkbenchProjection = true;
          window.__aihWorkbenchApplyingProjection = true;
          session.restorePolicy(policy);
          return undefined;
        } catch (error) {
          return {
            accepted: false,
            state: current,
            diagnostics: [
              {
                code: "unknown-asset",
                message: error instanceof Error ? error.message : "Policy update was rejected.",
              },
            ],
          };
        } finally {
          window.__aihWorkbenchApplyingProjection = false;
          applyingWorkbenchProjection = false;
        }
      };
      const compiled = projectWorkbenchPolicy(
        basePolicy,
        reduced.state,
        bundle,
        bindings,
        "author",
        sourceInputs,
      );
      if (compiled.accepted) {
        const failed = persist(compiled.policy);
        if (failed !== undefined) return failed;
        const refreshed = importedState(compiled.policy, bundle, bindings, sourceInputs);
        return {
          ...reduced,
          state: refreshed.state,
          diagnostics: refreshed.diagnostics.map((message) => ({
            code: "unknown-asset" as const,
            message,
          })),
        };
      }
      const repair = serializeWorkbenchRepairV1(
        basePolicy,
        current,
        action,
        bundle,
        bindings,
        sourceInputs,
      );
      if (repair.accepted && repair.policy !== undefined) {
        const failed = persist(repair.policy);
        return (
          failed ?? {
            accepted: true,
            state: repair.state,
            diagnostics: repair.diagnostics.map((message) => ({
              code: "unknown-asset" as const,
              message,
            })),
          }
        );
      }
      return {
        accepted: false,
        state: current,
        diagnostics: compiled.diagnostics.map((message) => ({
          code: "unknown-asset" as const,
          message,
        })),
      };
    },
  });
  document.addEventListener("aih-workbench-add-draft", (event) => {
    const detail = event instanceof CustomEvent ? event.detail : undefined;
    const candidate = object(detail);
    const parsed = WorkbenchActionV1Schema.safeParse(
      candidate === undefined ? undefined : { type: "add-draft", draft: candidate.draft },
    );
    if (!parsed.success) {
      document.dispatchEvent(
        new CustomEvent("aih-workbench-draft-rejected", {
          detail: {
            diagnostics: parsed.error.issues.map((issue) => issue.message),
          },
        }),
      );
      return;
    }
    const result = mounted.dispatch(parsed.data);
    document.dispatchEvent(
      new CustomEvent(
        result.accepted ? "aih-workbench-draft-accepted" : "aih-workbench-draft-rejected",
        {
          detail: {
            diagnostics: (result.diagnostics ?? []).map((diagnostic) => diagnostic.message),
          },
        },
      ),
    );
  });
  window.addEventListener("aih-workbench-policy-change", () => {
    if (applyingWorkbenchProjection) return;
    const snapshot = session.snapshotPolicy();
    const imported = importedState(snapshot, bundle, bindings, sourceInputs);
    const basePolicy = object(snapshot);
    if (!imported.accepted || basePolicy === undefined) {
      mounted.restore(imported.state, imported.diagnostics);
      return;
    }
    if (basePolicy.schemaVersion !== 3) {
      mounted.restore(imported.state, imported.diagnostics);
      return;
    }
    const projected = projectWorkbenchPolicy(
      basePolicy,
      imported.state,
      bundle,
      bindings,
      "author",
      sourceInputs,
    );
    if (!projected.accepted) {
      mounted.restore(imported.state, [...imported.diagnostics, ...projected.diagnostics]);
      return;
    }
    try {
      applyingWorkbenchProjection = true;
      window.__aihWorkbenchApplyingProjection = true;
      session.restorePolicy(projected.policy);
      mounted.restore(imported.state, imported.diagnostics);
    } catch (error) {
      mounted.restore(imported.state, [
        ...imported.diagnostics,
        error instanceof Error ? error.message : "Policy update was rejected.",
      ]);
    } finally {
      window.__aihWorkbenchApplyingProjection = false;
      applyingWorkbenchProjection = false;
    }
  });
}
if (!preparedCatalogValid) {
  const root = document.getElementById("framework-rows");
  if (root !== null) {
    const message = document.createElement("p");
    message.className = "help error";
    message.textContent =
      "Prepared catalog is invalid. Catalog selection and policy download are disabled.";
    root.replaceChildren(message);
  }
  for (const id of ["validate", "download"]) {
    const button = document.getElementById(id);
    if (button instanceof HTMLButtonElement) button.disabled = true;
  }
}
