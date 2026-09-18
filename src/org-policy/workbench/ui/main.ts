import "./browser-validation.js";
import {
  explicitDeveloperToolSelectionForOrgPolicyV1,
  resolveDeveloperToolSelectionForOrgPolicyV1,
} from "../../developer-tool-policy.js";
import { safePolicyCommandArgument } from "../command-arguments.js";
import { projectWorkbenchPolicy, type WorkbenchPolicyBindingsV1 } from "../compile-policy.js";
import {
  type AuthoringAssetV1,
  type AuthoringCatalogBundleV1,
  AuthoringCatalogBundleV1Schema,
  WorkbenchActionV1Schema,
  type WorkbenchSourceInputsV1,
} from "../contracts.js";
import { importWorkbenchPolicySelections, serializeWorkbenchRepairV1 } from "../policy-import.js";
import { WorkbenchReferenceReportsV1Schema } from "../reference-reports.js";
import {
  reduceWorkbenchAction,
  resolveWorkbenchSelection,
  type WorkbenchReductionV1,
  workbenchStatesEqualV1,
} from "../selection-engine.js";
import { mountArtifactIntakeWorkbench } from "./artifact-intake-runtime.js";
import {
  type MountedWorkbench,
  mountWorkbench,
  workbenchBrowseBundle,
} from "./catalog-inventory.js";
import { availableDeveloperToolCatalogDetails } from "./developer-tool-catalog.js";
import {
  type DeveloperToolSelectionUi,
  mountDeveloperToolSelection,
} from "./developer-tool-selection.js";
import { reprojectSchema3Policy, type Schema3ReprojectionSteps } from "./schema3-reprojection.js";
import { el, withId } from "./shell/dom.js";
import { mountNewWorkbench } from "./shell/new-workbench.js";
import { mountChooserNote, mountUserDoor, mountUserDoorTheme } from "./user-door.js";

interface WorkbenchSession {
  snapshotPolicy(): unknown;
  restorePolicy(policy: unknown): unknown;
}
interface BrowserModel {
  initialPolicy: unknown;
  workbenchBundle?: unknown;
  workbenchReferenceReports?: unknown;
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

function schema3ReprojectionSteps(
  bundle: import("../contracts.js").AuthoringCatalogBundleV1,
  bindings: WorkbenchPolicyBindingsV1,
  restore: (policy: unknown) => void,
): Schema3ReprojectionSteps {
  return {
    importSelections: (policy) => importedState(policy, bundle, bindings, sourceInputs),
    project: (policy, state) =>
      projectWorkbenchPolicy(policy, state, bundle, bindings, "author", sourceInputs),
    restore,
  };
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

interface CatalogControllerHooks {
  prepareApproval(asset: AuthoringAssetV1): void;
  /** Runs on every outside policy change before the catalog re-projects it. */
  beforeRestore?(snapshot: unknown): void;
  /** S4: the new shell's inspector rail panel and its reveal action. */
  inspectorHost?: HTMLElement;
  revealInspector?(): void;
}

/**
 * The catalog controller wiring both shells share (NEW-SHELL-PLAN.md S3):
 * dispatch through the selection engine into the policy session, local
 * draft intake, and the schema-3 re-projection on every policy change.
 */
function mountCatalogController(
  root: HTMLElement,
  session: WorkbenchSession,
  bundle: AuthoringCatalogBundleV1,
  bindings: WorkbenchPolicyBindingsV1,
  guard: { applying: boolean },
  hooks: CatalogControllerHooks,
): MountedWorkbench {
  const mounted = mountWorkbench(root, {
    shell: "new",
    bundle,
    referenceReports,
    adoptionBindings: bindings,
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
    prepareApproval: hooks.prepareApproval,
    ...(hooks.inspectorHost === undefined ? {} : { inspectorHost: hooks.inspectorHost }),
    ...(hooks.revealInspector === undefined ? {} : { revealInspector: hooks.revealInspector }),
    dispatch(action, expectedState) {
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
      if (expectedState !== undefined && !workbenchStatesEqualV1(current, expectedState))
        return {
          accepted: false,
          state: current,
          diagnostics: [
            {
              code: "invalid-action" as const,
              message: "Your draft changed. Review a fresh comparison before applying it.",
            },
          ],
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
          guard.applying = true;
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
          guard.applying = false;
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
    if (guard.applying) return;
    const snapshot = session.snapshotPolicy();
    hooks.beforeRestore?.(snapshot);
    const outcome = reprojectSchema3Policy(
      snapshot,
      schema3ReprojectionSteps(bundle, bindings, (policy) => {
        try {
          guard.applying = true;
          window.__aihWorkbenchApplyingProjection = true;
          session.restorePolicy(policy);
        } finally {
          window.__aihWorkbenchApplyingProjection = false;
          guard.applying = false;
        }
      }),
    );
    mounted.restore(outcome.state, outcome.diagnostics);
  });
  return mounted;
}

/**
 * Developer tool setup, shared by both shells (S6 moves it to the new
 * shell's organization screen): the selection persists through the catalog
 * projection into the policy session, exactly as before.
 */
function mountDeveloperTools(
  session: WorkbenchSession,
  bundle: AuthoringCatalogBundleV1,
  bindings: WorkbenchPolicyBindingsV1,
  guard: { applying: boolean },
  elements: { root: HTMLElement; status: HTMLElement; summary?: HTMLElement },
  inspectCatalogDetails: (assetId: string, trigger: HTMLButtonElement) => void,
): DeveloperToolSelectionUi {
  return mountDeveloperToolSelection({
    root: elements.root,
    status: elements.status,
    ...(elements.summary === undefined ? {} : { summary: elements.summary }),
    initialPolicy: session.snapshotPolicy(),
    catalogDetails: availableDeveloperToolCatalogDetails(bundle.assets),
    inspectCatalogDetails,
    persist(selection) {
      const snapshot = session.snapshotPolicy();
      const basePolicy = object(snapshot);
      const imported = importedState(snapshot, bundle, bindings, sourceInputs);
      if (basePolicy === undefined || !imported.accepted)
        return {
          accepted: false,
          diagnostics:
            basePolicy === undefined
              ? ["Policy session returned an invalid policy."]
              : imported.diagnostics,
        };
      const compiled = projectWorkbenchPolicy(
        basePolicy,
        imported.state,
        bundle,
        bindings,
        "author",
        sourceInputs,
      );
      if (!compiled.accepted) return { accepted: false, diagnostics: compiled.diagnostics };
      const policy = {
        ...compiled.policy,
        developerTools: explicitDeveloperToolSelectionForOrgPolicyV1(
          selection.selected,
          selection.excluded,
        ),
      };
      const developerTools = resolveDeveloperToolSelectionForOrgPolicyV1(policy);
      if (!developerTools.accepted)
        return {
          accepted: false,
          diagnostics: developerTools.diagnostics.map((diagnostic) => diagnostic.message),
        };
      try {
        guard.applying = true;
        window.__aihWorkbenchApplyingProjection = true;
        session.restorePolicy(policy);
        return { accepted: true, policy };
      } catch (error) {
        return {
          accepted: false,
          diagnostics: [error instanceof Error ? error.message : "Policy update was rejected."],
        };
      } finally {
        window.__aihWorkbenchApplyingProjection = false;
        guard.applying = false;
      }
    },
  });
}

/** S7: the legacy view tabs, as new-shell screens. */
const NEW_SHELL_VIEW_SCREENS: Record<string, string> = {
  compose: "sources",
  artifacts: "acme",
  author: "acme",
  imports: "scan",
};

const model = object(window.__aihWorkbenchModel);
if (model === undefined) throw new Error("Policy Workbench model is unavailable.");
const browserModel = model as unknown as BrowserModel;
// P5b: the user door renders its own page; "admin", "chooser" and an absent
// door keep the admin workspace exactly as before.
const userDoor = model.door === "user";
if (userDoor) {
  const userRoot = document.getElementById("user-door");
  if (userRoot === null) throw new Error("Project selection page is unavailable.");
  mountUserDoorTheme(document.getElementById("theme-toggle"));
  mountUserDoor(userRoot, model);
}
const sourceInputs = browserModel.workbenchSourceInputs;
const bundleResult = AuthoringCatalogBundleV1Schema.safeParse(browserModel.workbenchBundle);
const bindings = object(browserModel.workbenchBindings) as WorkbenchPolicyBindingsV1 | undefined;
const referenceReports = WorkbenchReferenceReportsV1Schema.parse(
  browserModel.workbenchReferenceReports ?? {},
);

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
    const developerTools = resolveDeveloperToolSelectionForOrgPolicyV1(policy);
    if (!developerTools.accepted)
      return {
        accepted: false,
        diagnostics: developerTools.diagnostics.map((diagnostic) => diagnostic.message),
      };
    const imported = importedState(policy, bundle, bindings, sourceInputs);
    return { accepted: imported.accepted, diagnostics: imported.diagnostics };
  };
}
// The admin page is the new shell (NEW-SHELL-PLAN.md S10).
if (!userDoor) {
  const { session, shell, org, acme } = mountNewWorkbench({
    model: model as unknown as Parameters<typeof mountNewWorkbench>[0]["model"],
    catalogValid: preparedCatalogValid,
    ledgerAssets: bundle === undefined ? [] : Object.values(workbenchBrowseBundle(bundle).assets),
    selectedAssetIds(policy) {
      if (!preparedCatalogValid) return [];
      return resolveWorkbenchSelection(
        bundle,
        importedState(policy, bundle, bindings, sourceInputs).state,
      ).assetIds;
    },
    selectionValidator: () => window.__aihWorkbenchValidatePolicy,
    openInspectorView: (view) => catalog?.showInspectorView(view),
  });
  let catalog: MountedWorkbench | undefined;
  window.__aihPolicyWorkbenchSession = session;
  if (model.door === "chooser") mountChooserNote(document.getElementById("announcement"));
  // S7: the legacy view names route to the new shell's screens; the artifact
  // intake runtime calls the global `setWorkbenchView` when it opens.
  const setView = (view: string) => {
    shell.router.setScreen(NEW_SHELL_VIEW_SCREENS[view] ?? view);
  };
  window.__aihSetWorkbenchView = setView;
  (window as unknown as { setWorkbenchView: (view: string) => void }).setWorkbenchView = setView;
  mountArtifactIntakeWorkbench();
  document.getElementById("panel-artifacts")?.removeAttribute("role");
  // The new shell styles the intake card from its compiled CSS (wb-tokens.css).
  for (const style of document.head.querySelectorAll("style:not([id])"))
    if (style.textContent?.startsWith("#artifact-intake-review{")) style.remove();
  // S3: the sources screen hosts the shared catalog controller; it re-projects
  // an imported schema-3 policy and reports diagnostics in the catalog.
  if (preparedCatalogValid) {
    const sources = shell.screenBody("sources");
    const root = withId(el("div", "min-w-0"), "framework-rows");
    sources.replaceChildren(root);
    const guard = { applying: false };
    // S6: developer tool setup lives on the organization screen.
    const developerTools = mountDeveloperTools(
      session,
      bundle,
      bindings,
      guard,
      org.developerTools,
      (assetId, trigger) => catalog?.inspectAssetDetails(assetId, trigger),
    );
    catalog = mountCatalogController(root, session, bundle, bindings, guard, {
      inspectorHost: shell.inspectorPanel,
      revealInspector: () => shell.revealInspector(),
      prepareApproval(asset) {
        // S7: the protected approval form lives on the additions screen.
        shell.router.setScreen("acme");
        acme.prepareApproval(asset);
        document.dispatchEvent(
          new CustomEvent("aih-workbench-prepare-approval", {
            detail: { assetId: asset.id },
          }),
        );
      },
      beforeRestore: (snapshot) => developerTools.restore(snapshot),
    });
  }
}
