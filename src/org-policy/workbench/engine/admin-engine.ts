import { parseNativeStrictJsonObjectV1 } from "../../../contract/native-strict-json-object-v1.js";
import { resolveDeveloperToolSelectionForOrgPolicyV1 } from "../../developer-tool-policy.js";
import { catalogSourceDisplayName } from "../catalog-browse.js";
import { safePolicyCommandArgument } from "../command-arguments.js";
import { projectWorkbenchPolicy, type WorkbenchPolicyBindingsV1 } from "../compile-policy.js";
import {
  type AuthoringAssetV1,
  type AuthoringCatalogBundleV1,
  AuthoringCatalogBundleV1Schema,
  type WorkbenchActionV1,
  type WorkbenchSourceInputsV1,
  type WorkbenchStateV1,
} from "../contracts.js";
import { importWorkbenchPolicySelections, serializeWorkbenchRepairV1 } from "../policy-import.js";
import { reduceWorkbenchAction, resolveWorkbenchSelection } from "../selection-engine.js";
import { reprojectSchema3Policy } from "../ui/schema3-reprojection.js";
import {
  DEFAULT_POLICY_FILENAME,
  MAX_IMPORT_BYTES,
  POLICY_FILENAME_PATTERN,
} from "../ui/shell/download-format.js";
import {
  activeManagedMcpServers,
  governanceOrDefault,
  serializePolicy,
} from "../ui/shell/policy-grammar.js";
import {
  createPolicySession,
  type PolicySession,
  type PolicySessionModel,
} from "../ui/shell/policy-session.js";
import { canonicalPolicyErrors } from "./canonical-validation.js";
// ADDING A FEATURE: one more import here.
import { type ChangesFeature, changesFeature } from "./features/changes.js";
import { type ClearPolicyFeature, clearPolicyFeature } from "./features/clear-policy.js";
import type { AdminEngineContext } from "./features/context.js";
// Lane B (drafts and repairs, inventory rows 19-21).
import { type DraftsFeature, draftsFeature } from "./features/drafts.js";
// LANE C (organization screen).
import { type OrgFeature, orgFeature } from "./features/org.js";
import { type ScanFeature, scanFeature } from "./features/scan.js";
// LANE A (Sources screen: rows 7, 11, 12).
import { type SourcesFeature, sourcesFeature } from "./features/sources.js";
import { workbenchBrowseBundleV1 } from "./scan-presentation.js";
import {
  type EngineFile,
  type EngineOutcome,
  type EngineResult,
  errorMessage,
  record,
  utf8ByteLength,
} from "./shared.js";

/**
 * The admin half of the engine entry (Policy Workbench UI delivery, "Preview
 * slice"). It reproduces, purely, the admin behaviour the DOM shell owns
 * today:
 *
 * - the selection validator `ui/main.ts` assigns to the browser global
 *   `__aihWorkbenchValidatePolicy` (main.ts lines 460-483),
 * - `mountCatalogController(...).dispatch` (main.ts lines 171-281) and its
 *   schema-3 re-projection on every policy change (main.ts lines 311-329),
 * - the posture handler and the supported-CLI toggle of
 *   `ui/shell/org-screen.ts` (lines 701-722 and 744-772), with their exact
 *   messages,
 * - the import, filename and download gates of `ui/shell/file-transfer.ts`.
 *
 * No DOM, no `window`, no Node built-ins: the policy session's hooks are
 * collected instead of rendered.
 */

export interface AdminCatalogItem {
  assetId: string;
  label: string;
  kind: string;
  selected: boolean;
  selectable: boolean;
  reason?: string;
}

export interface AdminCatalogGroup {
  id: string;
  label: string;
  items: readonly AdminCatalogItem[];
}

export interface AdminFramework {
  sourceId: string;
  label: string;
  groups: readonly AdminCatalogGroup[];
}

export interface AdminAiTool {
  id: string;
  label: string;
  selected: boolean;
}

export interface AdminState {
  /** False => Check and Publish are disabled and imports are rejected. */
  catalogValid: boolean;
  posture: "vibe" | "enterprise";
  aiTools: readonly AdminAiTool[];
  frameworks: readonly AdminFramework[];
  selectedAssetIds: readonly string[];
  /** Whether AIH may configure the selected Core MCP controls. */
  managedMcpOptIn: boolean;
  /** The active managed MCP servers of the current policy, sorted. */
  managedMcpServers: readonly string[];
  schemaVersion: number;
  /** Exactly the bytes a download would write. */
  policyText: string;
}

export interface AdminCheckResult {
  ok: boolean;
  errors: readonly string[];
  blockers: readonly string[];
}

/** The admin engine's core: what is not a separable editor feature. */
export interface CoreAdminEngine {
  /** A fresh, immutable snapshot each call. */
  state(): AdminState;
  setPosture(value: string): EngineOutcome;
  toggleAiTool(id: string): EngineOutcome;
  setItemSelected(assetId: string, selected: boolean): EngineOutcome;
  /**
   * The managed MCP projection opt-in. It cannot be switched off while the
   * policy still selects Core MCP controls that need it.
   */
  setManagedMcpOptIn(optIn: boolean): EngineOutcome;
  /** Strict JSON only; a rejected import keeps the current policy. */
  importPolicyText(text: string): EngineOutcome;
  check(): AdminCheckResult;
  /** An unsafe file name is refused and nothing is produced. */
  download(filename?: string): EngineResult<EngineFile>;
}

/**
 * The admin engine the UI sees. ADDING A FEATURE IS THREE LINES IN THIS FILE:
 * import its factory, add `& XFeature` here, and spread `xFeature(ctx)` into
 * the engine object below (plus one export line in `index.ts`).
 */
export type AdminEngine = CoreAdminEngine &
  ChangesFeature &
  ClearPolicyFeature &
  ScanFeature &
  // LANE C (organization screen).
  OrgFeature &
  // Lane B (drafts and repairs).
  DraftsFeature &
  // LANE A (Sources screen).
  SourcesFeature;

interface WorkbenchImportValidation {
  accepted: boolean;
  diagnostics: readonly string[];
}

const ADMINISTRATOR_ORIGIN = { kind: "administrator" } as const;

const INVALID_CATALOG_DIAGNOSTIC =
  "Prepared catalog is invalid or unavailable. Regenerate this artifact with Core.";

/** `browserCommandArgumentErrors` of `ui/main.ts` (lines 93-123), verbatim. */
function commandArgumentErrors(policy: unknown): string[] {
  const root = record(policy);
  const governance = record(root?.governance);
  const catalog = record(governance?.catalog);
  const approvals = Array.isArray(record(governance?.authority)?.approvals)
    ? (record(governance?.authority)?.approvals as unknown[])
    : [];
  const candidates = ["reviewed", "custom"].flatMap((key) => {
    const collection = catalog?.[key];
    return Array.isArray(collection) ? collection : [];
  });
  const sources = [...candidates, ...approvals]
    .map((value) => record(value)?.source)
    .map(record)
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

/** `actionFor` of `ui/catalog-inventory.ts` (lines 273-313), verbatim. */
function actionFor(
  asset: AuthoringAssetV1,
  state: WorkbenchStateV1,
): WorkbenchActionV1 | undefined {
  const request =
    state.requests.find(
      (candidate) => candidate.assetId === asset.id && candidate.origin.kind === "administrator",
    ) ??
    state.requests.find(
      (candidate) =>
        candidate.assetId === asset.id && candidate.origin.kind === "legacy-unattributed",
    );
  if (request !== undefined)
    return { type: "remove-request", assetId: asset.id, origin: request.origin };
  const root =
    state.roots.find(
      (candidate) => candidate.assetId === asset.id && candidate.origin.kind === "administrator",
    ) ??
    state.roots.find(
      (candidate) =>
        candidate.assetId === asset.id && candidate.origin.kind === "legacy-unattributed",
    );
  if (root !== undefined) return { type: "remove-root", assetId: asset.id, origin: root.origin };
  if (asset.authoring.action === "record-request")
    return { type: "record-request", assetId: asset.id, origin: ADMINISTRATOR_ORIGIN };
  if (asset.authoring.action === "select-control" || asset.authoring.action === "record-selection")
    return { type: "select-root", assetId: asset.id, origin: ADMINISTRATOR_ORIGIN };
  return undefined;
}

function removesSelection(action: WorkbenchActionV1): boolean {
  return action.type === "remove-request" || action.type === "remove-root";
}

function hostList(model: Record<string, unknown>): { id: string; label: string }[] {
  const catalog = record(model.catalog);
  const hosts = Array.isArray(catalog?.hosts) ? (catalog.hosts as unknown[]) : [];
  return hosts.flatMap((value) => {
    const host = record(value);
    const id = host?.id;
    if (typeof id !== "string") return [];
    return [{ id, label: typeof host?.label === "string" ? host.label : id }];
  });
}

/**
 * Whether the download gate accepts this policy file name: the same
 * `POLICY_FILENAME_PATTERN` over the trimmed value that `download()` applies,
 * and that `updateFilenameHelp` consults (`ui/shell/file-transfer.ts` lines
 * 235-245). The view asks this to write its help and hint; it never has to
 * know the pattern.
 */
export function isPolicyFileName(name: string): boolean {
  return typeof name === "string" && POLICY_FILENAME_PATTERN.test(name.trim());
}

export function createAdminEngine(modelValue: unknown): EngineResult<AdminEngine> {
  try {
    return buildAdminEngine(modelValue);
  } catch (error) {
    return { ok: false, errors: [errorMessage(error, "The Workbench model is unavailable.")] };
  }
}

function buildAdminEngine(modelValue: unknown): EngineResult<AdminEngine> {
  const model = record(modelValue);
  if (model === undefined)
    return { ok: false, errors: ["The Workbench model must be a JSON object."] };
  if (record(model.initialPolicy) === undefined)
    return { ok: false, errors: ["The Workbench model has no initial policy object."] };
  if (record(model.catalog) === undefined)
    return { ok: false, errors: ["The Workbench model has no catalog object."] };

  const sourceInputs = (record(model.workbenchSourceInputs) ?? {}) as WorkbenchSourceInputsV1;
  const parsedBundle = AuthoringCatalogBundleV1Schema.safeParse(model.workbenchBundle);
  const bundle: AuthoringCatalogBundleV1 | undefined = parsedBundle.success
    ? parsedBundle.data
    : undefined;
  const bindings = record(model.workbenchBindings) as WorkbenchPolicyBindingsV1 | undefined;
  const catalogValid = bundle !== undefined && bindings !== undefined;
  // What the catalog VIEWS list. Authority stays with `bundle`.
  const browseBundle = bundle === undefined ? undefined : workbenchBrowseBundleV1(bundle);

  const imported = (policy: unknown) => {
    if (bundle === undefined || bindings === undefined)
      return { accepted: false, state: undefined, diagnostics: [INVALID_CATALOG_DIAGNOSTIC] };
    return importWorkbenchPolicySelections(policy, bundle, bindings, sourceInputs);
  };

  // main.ts lines 463-483: the selection validator the grammar consults.
  const selectionValidator = (policy: unknown): WorkbenchImportValidation => {
    if (!catalogValid) return { accepted: false, diagnostics: [INVALID_CATALOG_DIAGNOSTIC] };
    const candidate = record(policy);
    if (candidate?.schemaVersion !== 2 && candidate?.schemaVersion !== 3)
      return { accepted: false, diagnostics: ["Unsupported policy version"] };
    const commandErrors = commandArgumentErrors(policy);
    if (commandErrors.length > 0) return { accepted: false, diagnostics: commandErrors };
    const developerTools = resolveDeveloperToolSelectionForOrgPolicyV1(policy);
    if (!developerTools.accepted)
      return {
        accepted: false,
        diagnostics: developerTools.diagnostics.map((diagnostic) => diagnostic.message),
      };
    const state = imported(policy);
    return { accepted: state.accepted, diagnostics: state.diagnostics };
  };

  const guard = { applying: false };
  let last: EngineOutcome = { ok: true, message: "" };
  let session: PolicySession | undefined;

  // main.ts lines 311-329: an outside policy change re-projects a schema-3
  // policy through the prepared catalog and restores it.
  const reproject = (): void => {
    if (guard.applying || session === undefined || bundle === undefined || bindings === undefined)
      return;
    const active = session;
    reprojectSchema3Policy(active.snapshotPolicy(), {
      importSelections: (policy) =>
        importWorkbenchPolicySelections(policy, bundle, bindings, sourceInputs),
      project: (policy, state) =>
        projectWorkbenchPolicy(policy, state, bundle, bindings, "author", sourceInputs),
      restore: (policy) => {
        try {
          guard.applying = true;
          active.restorePolicy(policy);
        } finally {
          guard.applying = false;
        }
      },
    });
  };

  session = createPolicySession(model as unknown as PolicySessionModel, {
    announce: (message, error) => {
      last = { ok: error !== true, message };
    },
    render: () => {},
    changed: () => reproject(),
    resetEditing: () => {},
    selectionValidator: () => selectionValidator,
  });
  const active = session;

  // The diff baseline: the policy text the page opened with, captured once.
  // An import therefore shows as changes, and `clear()`, which restores the
  // initial policy, brings the diff back to none.
  const baseline = serializePolicy(model.initialPolicy);

  const outcome = (fallback: string): EngineOutcome =>
    last.message === "" ? { ok: true, message: fallback } : last;

  const currentState = (): WorkbenchStateV1 | undefined => {
    const state = imported(active.snapshotPolicy());
    return state.accepted ? (state.state as WorkbenchStateV1) : undefined;
  };

  const selectedIds = (): string[] => {
    if (bundle === undefined) return [];
    const state = currentState();
    if (state === undefined) return [];
    return [...resolveWorkbenchSelection(bundle, state).assetIds];
  };

  /** Persist a compiled policy under the re-projection guard (main.ts 171-281). */
  const persist = (policy: unknown): string | undefined => {
    try {
      guard.applying = true;
      active.restorePolicy(policy);
      return undefined;
    } catch (error) {
      return errorMessage(error, "Policy update was rejected.");
    } finally {
      guard.applying = false;
    }
  };

  // main.ts lines 171-281: reduce, compile, persist, and fall back to a repair.
  const dispatch = (action: WorkbenchActionV1): EngineOutcome => {
    if (bundle === undefined || bindings === undefined)
      return { ok: false, message: INVALID_CATALOG_DIAGNOSTIC };
    const state = imported(active.snapshotPolicy());
    if (!state.accepted)
      return { ok: false, message: state.diagnostics.join(" ") || "Selection rejected." };
    const current = state.state as WorkbenchStateV1;
    const reduced = reduceWorkbenchAction(bundle, current, action);
    if (!reduced.accepted)
      return {
        ok: false,
        message:
          (reduced.diagnostics ?? []).map((diagnostic) => diagnostic.message).join(" ") ||
          "Selection rejected.",
      };
    const basePolicy = record(active.snapshotPolicy());
    if (basePolicy === undefined)
      return { ok: false, message: "Policy session returned an invalid policy." };
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
      if (failed !== undefined) return { ok: false, message: failed };
      return { ok: true, message: "Selection applied." };
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
      if (failed !== undefined) return { ok: false, message: failed };
      return { ok: true, message: repair.diagnostics.join(" ") || "Selection applied." };
    }
    return {
      ok: false,
      message: compiled.diagnostics.join(" ") || "Selection rejected.",
    };
  };

  /** `new-workbench.ts` line 104: the scan screen's two finding groups, from the model. */
  const findingKinds = (group: "dispositionable" | "fenced"): string[] => {
    const findings = record(model.findings);
    const value = findings?.[group];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  };

  /**
   * One catalog item per id, with ONE selection read shared by all of them.
   * The ids come from the browse projection; the asset records are the
   * complete bundle's, so what is browsed and what is selectable agree.
   */
  const catalogItems = (assetIds: readonly string[]): AdminCatalogItem[] => {
    if (bundle === undefined) return [];
    const chosen = new Set(selectedIds());
    const state = currentState();
    return assetIds.flatMap((assetId) => {
      const asset = bundle.assets[assetId];
      if (asset === undefined) return [];
      const action = state === undefined ? undefined : actionFor(asset, state);
      const selectable = catalogValid && action !== undefined;
      return [
        {
          assetId,
          label: asset.label,
          kind: asset.kind,
          selected: chosen.has(assetId),
          selectable,
          ...(selectable
            ? {}
            : {
                reason: catalogValid
                  ? `This item is not selectable: ${asset.authoring.action}.`
                  : INVALID_CATALOG_DIAGNOSTIC,
              }),
        },
      ];
    });
  };

  /**
   * The catalog the administrator browses is the BROWSE projection, exactly
   * what the hand-built catalog offers (`workbenchBrowseBundleV1`): no
   * Ponytail source, no `aih/github` Core item, developer-tool projection
   * applied. Selection, import and download keep using `bundle`.
   */
  const frameworks = (): AdminFramework[] => {
    if (browseBundle === undefined) return [];
    const byFramework = new Map<string, AdminCatalogGroup[]>();
    const listed = new Map<string, readonly string[]>();
    for (const group of Object.values(browseBundle.groups)) {
      const assetIds = group.assetIds.filter((id) => browseBundle.assets[id] !== undefined);
      if (assetIds.length === 0) continue;
      listed.set(group.id, assetIds);
    }
    const items = new Map(
      catalogItems([...listed.values()].flat()).map((item) => [item.assetId, item]),
    );
    for (const group of Object.values(browseBundle.groups)) {
      const assetIds = listed.get(group.id);
      if (assetIds === undefined) continue;
      const sourceId = browseBundle.assets[assetIds[0] ?? ""]?.sourceId ?? "";
      const groups = byFramework.get(sourceId) ?? [];
      groups.push({
        id: group.id,
        label: group.label,
        items: assetIds.flatMap((id) => {
          const item = items.get(id);
          return item === undefined ? [] : [item];
        }),
      });
      byFramework.set(sourceId, groups);
    }
    return [...byFramework.entries()].map(([sourceId, groups]) => ({
      sourceId,
      // The name a person recognizes, not a raw URL: the same display name the
      // hand-built source rail and masthead show.
      label: catalogSourceDisplayName(browseBundle, sourceId),
      groups,
    }));
  };

  const ctx: AdminEngineContext = {
    model,
    active,
    bundle,
    browseBundle,
    bindings,
    catalogValid,
    sourceInputs,
    baseline,
    currentState,
    selectedAssetIds: selectedIds,
    catalogItems,
    dispatch,
    resetOutcome: () => {
      last = { ok: true, message: "" };
    },
    outcome,
    findingKinds,
    // LANE C (organization screen).
    restore: persist,
  };

  const core: CoreAdminEngine = {
    state() {
      const policy = record(active.snapshotPolicy()) ?? {};
      const version = policy.schemaVersion;
      const governance = record(policy.governance);
      const sanctioned = new Set(
        Array.isArray(governance?.supportedClis)
          ? (governance.supportedClis as unknown[]).filter(
              (value): value is string => typeof value === "string",
            )
          : [],
      );
      return {
        catalogValid,
        posture: policy.minimumPosture === "enterprise" ? "enterprise" : "vibe",
        aiTools: hostList(model).map((host) => ({
          id: host.id,
          label: host.label,
          selected: sanctioned.has(host.id),
        })),
        frameworks: frameworks(),
        selectedAssetIds: selectedIds(),
        managedMcpOptIn: active.managedMcpOptIn(),
        managedMcpServers: activeManagedMcpServers(policy),
        schemaVersion: typeof version === "number" ? version : Number.NaN,
        policyText: active.serialize(),
      };
    },

    // org-screen.ts lines 701-722.
    setPosture(value) {
      try {
        if (value !== "vibe" && value !== "enterprise")
          return { ok: false, message: `Unsupported posture: ${value}` };
        const policy = record(active.snapshotPolicy()) ?? {};
        const governance = record(policy.governance);
        const selected = Array.isArray(governance?.supportedClis)
          ? (governance.supportedClis as unknown[])
          : [];
        if (value === "enterprise" && selected.length === 0)
          return {
            ok: false,
            message:
              "Enterprise posture was not applied. Select at least one Allowed CLI first, or choose the Enterprise preset to explicitly sanction every supported CLI and compose Core.",
          };
        last = { ok: true, message: "" };
        active.edit((draft: Record<string, unknown>) => {
          draft.minimumPosture = value;
          return undefined;
        }, "Posture changed without modifying selections.");
        return outcome("Posture changed without modifying selections.");
      } catch (error) {
        return { ok: false, message: errorMessage(error, "Posture change was rejected.") };
      }
    },

    // org-screen.ts lines 724-742: the same refusal, the same two messages.
    setManagedMcpOptIn(optIn) {
      try {
        if (typeof optIn !== "boolean")
          return { ok: false, message: `Unsupported managed MCP projection setting: ${optIn}` };
        if (!optIn && activeManagedMcpServers(active.snapshotPolicy()).length > 0)
          return {
            ok: false,
            message:
              "Managed MCP projection remains enabled because selected Core MCP controls need it. Remove those controls before disabling this setting.",
          };
        const message = optIn
          ? "Managed MCP projection enabled for selected Core MCP controls. It is saved only when those controls are present."
          : "Managed MCP projection disabled. No server was contacted or changed.";
        last = { ok: true, message: "" };
        active.setManagedMcpOptIn(optIn, message);
        return outcome(message);
      } catch (error) {
        return {
          ok: false,
          message: errorMessage(error, "Managed MCP projection change was rejected."),
        };
      }
    },

    // org-screen.ts lines 744-772.
    toggleAiTool(id) {
      try {
        const known = hostList(model);
        if (!known.some((host) => host.id === id))
          return { ok: false, message: `Unknown AI tool: ${id}` };
        const governance = governanceOrDefault(
          record(active.snapshotPolicy())?.governance,
        ) as Record<string, unknown>;
        const currently = Array.isArray(governance.supportedClis)
          ? (governance.supportedClis as unknown[]).filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        const chosen = new Set(currently);
        if (chosen.has(id)) chosen.delete(id);
        else chosen.add(id);
        const ordered = known.map((host) => host.id).filter((host) => chosen.has(host));
        last = { ok: true, message: "" };
        const message = ordered.length
          ? `Supported CLI allow-list updated: ${ordered.join(", ")}. Reviewed activation targets were rebound to their exact sanctioned projector intersections; unsanctioned selected or detected CLIs are refused by the engine.`
          : "Supported CLI allow-list cleared without broadening existing activation targets. Vibe permits an omitted list; Enterprise requires an explicit list.";
        active.edit((draft: Record<string, unknown>) => {
          const writable = writableGovernance(draft);
          if (ordered.length) writable.supportedClis = ordered;
          else delete writable.supportedClis;
          const gap = rebindSanctionedTargets(writable);
          return gap
            ? `Policy change rejected: ${gap}. Remove that control before removing its last projectable sanctioned CLI.`
            : undefined;
        }, message);
        return outcome(message);
      } catch (error) {
        return { ok: false, message: errorMessage(error, "AI tool change was rejected.") };
      }
    },

    setItemSelected(assetId, selected) {
      try {
        if (typeof assetId !== "string" || assetId.length === 0)
          return { ok: false, message: "An asset id is required." };
        if (typeof selected !== "boolean")
          return { ok: false, message: "A selected flag is required." };
        if (bundle === undefined || !catalogValid)
          return { ok: false, message: INVALID_CATALOG_DIAGNOSTIC };
        const asset = bundle.assets[assetId];
        if (asset === undefined) return { ok: false, message: `Unknown asset: ${assetId}` };
        const state = currentState();
        if (state === undefined)
          return { ok: false, message: "The current policy cannot be read as a selection." };
        const action = actionFor(asset, state);
        if (action === undefined)
          return { ok: false, message: `This item is not selectable: ${assetId}` };
        const removing = removesSelection(action);
        if (removing === selected) return { ok: true, message: "No change." };
        last = { ok: true, message: "" };
        return dispatch(action);
      } catch (error) {
        return { ok: false, message: errorMessage(error, "Selection was rejected.") };
      }
    },

    // file-transfer.ts lines 35-51 and 249-264.
    importPolicyText(text) {
      try {
        if (typeof text !== "string")
          return { ok: false, message: "Policy import rejected: valid policy JSON required" };
        if (utf8ByteLength(text) > MAX_IMPORT_BYTES)
          return { ok: false, message: "Import rejected: file exceeds the 1 MiB limit." };
        let parsed: Record<string, unknown>;
        try {
          parsed = parseNativeStrictJsonObjectV1(text, "file import");
        } catch (error) {
          return {
            ok: false,
            message: `Policy import rejected: ${errorMessage(error, "valid policy JSON required")}`,
          };
        }
        // The grammar decides first, exactly as before. The canonical schema
        // then judges the migrated policy BEFORE anything is committed, so a
        // refusal here changes no session state at all.
        try {
          const prepared = active.validatePolicy(parsed);
          const objections = canonicalPolicyErrors(prepared.policy);
          if (objections.length > 0)
            return {
              ok: false,
              message: `Policy import rejected: ${objections.slice(0, 3).join("; ")}`,
            };
        } catch (error) {
          return {
            ok: false,
            message: `Policy import rejected: ${errorMessage(error, "valid policy JSON required")}`,
          };
        }
        // Backstop: the canonical schema is applied again to what the session
        // actually committed, AFTER re-projection, because that, not the input
        // text, is what a download would write.
        const prior = active.snapshotPolicy();
        const priorManagedMcpOptIn = active.managedMcpOptIn();
        last = { ok: true, message: "" };
        try {
          active.importPolicy(parsed);
        } catch (error) {
          return {
            ok: false,
            message: `Policy import rejected: ${errorMessage(error, "valid policy JSON required")}`,
          };
        }
        const canonical = canonicalPolicyErrors(active.snapshotPolicy());
        if (canonical.length > 0) {
          // Put the previous policy back under the same guard the dispatcher
          // uses, so restoring it cannot fire another re-projection. An import
          // also sets the managed MCP opt-in, which a restore only widens, so
          // that flag is put back as well.
          try {
            guard.applying = true;
            active.restorePolicy(prior);
            if (active.managedMcpOptIn() !== priorManagedMcpOptIn)
              active.setManagedMcpOptIn(priorManagedMcpOptIn, "");
          } catch (error) {
            return {
              ok: false,
              message: `Policy import rejected: ${errorMessage(error, "valid policy JSON required")}`,
            };
          } finally {
            guard.applying = false;
          }
          return {
            ok: false,
            message: `Policy import rejected: ${canonical.slice(0, 3).join("; ")}`,
          };
        }
        return outcome("Policy imported.");
      } catch (error) {
        return {
          ok: false,
          message: `Policy import rejected: ${errorMessage(error, "valid policy JSON required")}`,
        };
      }
    },

    check() {
      try {
        const grammar = active.validate();
        // Canonical objections follow the grammar's, and only the ones the
        // grammar did not already say.
        const canonical = canonicalPolicyErrors(active.snapshotPolicy()).filter(
          (message) => !grammar.includes(message),
        );
        const errors = [...grammar, ...canonical];
        const blockers = active.readinessBlockers();
        return { ok: catalogValid && errors.length === 0, errors, blockers };
      } catch (error) {
        return {
          ok: false,
          errors: [errorMessage(error, "The policy check failed.")],
          blockers: [],
        };
      }
    },

    download(filename) {
      try {
        if (!catalogValid) return { ok: false, errors: [INVALID_CATALOG_DIAGNOSTIC] };
        const grammar = active.validate();
        const canonical = canonicalPolicyErrors(active.snapshotPolicy()).filter(
          (message) => !grammar.includes(message),
        );
        // Canonical objections go last so an existing grammar or readiness
        // message keeps the exact position it had in "Download blocked: …".
        const blocked = [...grammar, ...active.readinessBlockers(), ...canonical];
        if (blocked.length)
          return { ok: false, errors: [`Download blocked: ${blocked.slice(0, 3).join("; ")}`] };
        const name = (filename ?? DEFAULT_POLICY_FILENAME).trim();
        if (!POLICY_FILENAME_PATTERN.test(name))
          return {
            ok: false,
            errors: [
              "Download blocked: Use a JSON filename without folders, spaces, or hidden characters.",
            ],
          };
        return { ok: true, value: { name, text: active.serialize() } };
      } catch (error) {
        return { ok: false, errors: [errorMessage(error, "The download was refused.")] };
      }
    },
  };
  // ADDING A FEATURE: one more spread line here, and nothing else.
  const engine: AdminEngine = {
    ...core,
    ...changesFeature(ctx),
    ...clearPolicyFeature(ctx),
    // Lane B (drafts and repairs).
    ...draftsFeature(ctx),
    ...scanFeature(ctx),
    // LANE C (organization screen).
    ...orgFeature(ctx),
    // LANE A (Sources screen).
    ...sourcesFeature(ctx),
  };
  return { ok: true, value: engine };
}

/** `writableGovernance` of `ui/shell/org-screen.ts` (lines 179-182). */
function writableGovernance(policy: Record<string, unknown>): Record<string, unknown> {
  const governance = governanceOrDefault(policy.governance) as Record<string, unknown>;
  policy.governance = governance;
  return governance;
}

/** `projectorGap` of `ui/shell/org-screen.ts` (lines 138-140). */
function projectorGap(
  governance: Record<string, unknown>,
  candidate: Record<string, unknown>,
): string {
  const clis = (governance.supportedClis as string[]).join(", ");
  const targets = (candidate.targets as string[]).join(", ");
  return `${String(candidate.id)} has no projector for the organization-sanctioned CLI set ${clis}; control projector targets: ${targets}`;
}

/** `rebindSanctionedTargets` of `ui/shell/org-screen.ts` (lines 143-157). */
function rebindSanctionedTargets(governance: Record<string, unknown>): string | null {
  if (!Array.isArray(governance.supportedClis)) return null;
  const supported = governance.supportedClis as string[];
  const activations = (governance.activations ?? []) as Record<string, unknown>[];
  const reviewedList = ((record(governance.catalog)?.reviewed ?? []) as unknown[]).map(
    (value) => value as Record<string, unknown>,
  );
  for (const activation of activations) {
    const reviewed = reviewedList.find((candidate) => candidate.id === activation.candidate);
    if (!reviewed) continue;
    const targets = (reviewed.targets as string[]).filter((target) => supported.includes(target));
    if (!targets.length) return projectorGap(governance, reviewed);
    activation.targets = targets;
  }
  return null;
}
