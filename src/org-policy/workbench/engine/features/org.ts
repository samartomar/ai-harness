import {
  DEFAULT_DEVELOPER_TOOL_IDS,
  type DeveloperToolId,
} from "../../../../tools/default-tool-selection.js";
import {
  explicitDeveloperToolSelectionForOrgPolicyV1,
  resolveDeveloperToolSelectionForOrgPolicyV1,
} from "../../../developer-tool-policy.js";
import {
  EVIDENCE_DELIVERY_NOTE,
  evidenceDeliveryRows,
  type StudioEvidenceDelivery,
} from "../../../evidence-delivery-rows.js";
import {
  baselineEvidenceProvenanceTextV1,
  catalogProvenanceTextV1,
} from "../../../provenance-lines.js";
import { projectWorkbenchPolicy } from "../../compile-policy.js";
import { importWorkbenchPolicySelections } from "../../policy-import.js";
import { governanceOrDefault } from "../../ui/shell/policy-grammar.js";
import { type EngineOutcome, errorMessage, record } from "../shared.js";
import type { AdminEngineContext } from "./context.js";

/**
 * The organization screen's feature (acceptance rule section 7, rows 8, 9, 13
 * and 14): the readiness line, the adoption recipe, the evidence and versions
 * rows, the provenance lines, developer tool setup, and the ECC hook controls.
 *
 * The behaviour source is the hand-built `ui/shell/org-screen.ts`, the
 * developer tool surface of `ui/developer-tool-selection.ts` with the persist
 * step of `ui/main.ts` (`mountDeveloperTools`), and the two pure line builders
 * `src/org-policy/provenance-lines.ts`. Every sentence below is that source's,
 * verbatim; the view places them as text.
 */

/** `org-screen.ts` lines 84-89, verbatim. */
const ECC_DISABLE_EXPLAINED_GROUP = new Set([
  "pre:bash:block-no-verify",
  "pre:config-protection",
  "pre:edit-write:gateguard-fact-force",
  "post:quality-gate",
]);

interface EccHookCatalogEntry {
  readonly id: string;
  readonly event: string;
  readonly profiles: readonly string[];
  readonly disableEligible: boolean;
}

interface EccHookGroupDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly ids?: readonly string[];
  readonly select?: (hook: EccHookCatalogEntry) => boolean;
}

/** `org-screen.ts` lines 99-135, verbatim, over the engine's own hook shape. */
const ECC_HOOK_GROUPS: readonly EccHookGroupDefinition[] = [
  {
    id: "pre-tool-guardrails",
    label: "Pre-tool Guardrails",
    description:
      "Critical controls that prevent unverified Bash execution or accidental overwrites of baseline configuration.",
    ids: ["pre:bash:block-no-verify", "pre:config-protection"],
  },
  {
    id: "gate-checks",
    label: "Gate Checks",
    description: "Validation gates before high-risk edits and after code changes.",
    ids: ["pre:edit-write:gateguard-fact-force", "post:quality-gate"],
  },
  {
    id: "additional-pre-tool",
    label: "Additional Pre-tool Controls",
    description: "Other pinned PreToolUse controls from ECC's exact inventory.",
    select: (hook) => hook.event === "PreToolUse" && !ECC_DISABLE_EXPLAINED_GROUP.has(hook.id),
  },
  {
    id: "session-lifecycle",
    label: "Session & Lifecycle",
    description: "Pinned session-start, compaction, stop, and session-end lifecycle controls.",
    select: (hook) =>
      ["SessionStart", "PreCompact", "Stop", "SessionEnd"].indexOf(hook.event) !== -1,
  },
  {
    id: "post-tool-feedback",
    label: "Post-tool Observability & Feedback",
    description:
      "Remaining pinned PostToolUse and PostToolUseFailure observations, audit signals, and feedback controls.",
    select: (hook) =>
      ["PostToolUse", "PostToolUseFailure"].indexOf(hook.event) !== -1 &&
      !ECC_DISABLE_EXPLAINED_GROUP.has(hook.id),
  },
];

/** `ui/developer-tool-selection.ts` lines 10-41, verbatim. */
const DEVELOPER_TOOL_PRESENTATION: Readonly<
  Record<DeveloperToolId, { label: string; detail: string }>
> = {
  "code-review-graph": {
    label: "Code Review Graph",
    detail: "Review code relationships and likely change impact in this project.",
  },
  "codebase-memory-mcp": {
    label: "Codebase Memory MCP",
    detail: "Search and remember code in this project.",
  },
  serena: {
    label: "Serena",
    detail: "Find and edit symbols in this project.",
  },
  "token-optimizer": {
    label: "Token Optimizer",
    detail: "On-demand token reports; optional hooks where supported.",
  },
  context7: {
    label: "Context7",
    detail:
      "Hosted documentation service; setup can make network requests subject to egress policy.",
  },
  playwright: {
    label: "Playwright",
    detail: "Automate a local browser with web access. Setup verification is pending.",
  },
  markitdown: {
    label: "MarkItDown CLI",
    detail:
      "Convert documents to Markdown locally. The MCP adapter is optional and is not enabled by this selection.",
  },
};

const DEVELOPER_TOOL_SAVED_MESSAGE = "Saved as an explicit developer-tool policy choice.";
const DEVELOPER_TOOL_REJECTED_MESSAGE = "Developer tool policy update was rejected.";
const NO_CORE_CONTROLS_READINESS =
  "No Core controls selected. Choose controls after setting the hosts and posture you intend to use.";

/** `ui/developer-tool-selection.ts` lines 60-69, verbatim. */
function developerToolSourceLabel(source: string): string {
  if (source === "default") return "All default developer tools are selected.";
  if (source === "legacy-unspecified")
    return "Legacy policy has no developer-tool decision: defaults apply until you save a choice.";
  if (source === "fail-closed")
    return "Policy selection is blocked until its diagnostic is resolved.";
  return "Explicit policy selection is shown below.";
}

/** `org-screen.ts` lines 168-177 (`adoptionRoute`), verbatim. */
function adoptionRoute(route: Record<string, unknown> | undefined): string {
  if (route === undefined) return "No route";
  return route.kind === "workbench-row"
    ? `Existing Workbench row: ${String(route.candidate)}`
    : route.kind === "ecc-mcp-approval"
      ? `ECC MCP approval for ${String(route.id)}, then configure its ${String(route.addability)} entry`
      : route.kind === "aih-ecc-profile-lifecycle"
        ? `AIH ECC profile lifecycle: ${String(route.command)}`
        : "No route";
}

/** `org-screen.ts` lines 160-166 (`eligibleDisabledIds`), verbatim. */
function eligibleDisabledIds(
  hooks: readonly EccHookCatalogEntry[],
  eligibleIds: readonly string[],
  profile: string,
  disabled: unknown,
): string[] {
  const chosen = new Set(Array.isArray(disabled) ? (disabled as unknown[]) : []);
  return eligibleIds.filter((id) => {
    const hook = hooks.find((candidate) => candidate.id === id);
    return chosen.has(id) && hook !== undefined && hook.profiles.indexOf(profile) !== -1;
  });
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** One adoption recipe role, already in the sentences the drawer shows. */
export interface AdoptionRoleV1 {
  readonly id: string;
  readonly label: string;
  readonly guidance: string;
  readonly prerequisites: string;
  readonly conflicts: string;
  readonly nextAction: string;
  readonly usage: string;
}

/** The "Evidence & versions" drawer's content, or absent without delivery data. */
export interface EvidenceDeliveryV1 {
  readonly coreVersion: string;
  readonly rows: readonly (readonly [string, string])[];
  readonly note: string;
}

/** The two provenance sentences the page prints under its header. */
export interface ProvenanceLinesV1 {
  readonly catalog?: string;
  readonly baselineEvidence?: string;
}

export type DeveloperToolStateV1 = "blocked" | "excluded" | "selected-pending" | "not-selected";

export type DeveloperToolActionV1 = "include" | "remove" | "exclude";

export interface DeveloperToolRowV1 {
  readonly id: DeveloperToolId;
  readonly label: string;
  readonly detail: string;
  readonly state: DeveloperToolStateV1;
  /** The state, in words: nothing here is distinguished by colour. */
  readonly stateText: string;
  readonly actions: readonly DeveloperToolActionV1[];
}

export interface DeveloperToolsV1 {
  /** The disclosure's summary, exactly as the hand-built page writes it. */
  readonly summary: string;
  /** The status line: the resolution's own sentence, or its blocked diagnostic. */
  readonly status: string;
  readonly blocked: boolean;
  readonly rows: readonly DeveloperToolRowV1[];
}

export interface EccHookRowV1 {
  readonly id: string;
  readonly event: string;
  /** "Eligible profiles: …", and whether the wrapper stays enabled. */
  readonly detail: string;
  readonly disableEligible: boolean;
  readonly disabled: boolean;
  /** False while no profile is chosen, or the hook is not eligible under it. */
  readonly canToggle: boolean;
}

export interface EccHookGroupV1 {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly hooks: readonly EccHookRowV1[];
}

export interface EccHookControlsV1 {
  readonly profiles: readonly { readonly id: string; readonly label: string }[];
  /** The recorded profile, or "" while none is recorded. */
  readonly profile: string;
  readonly detail: string;
  readonly groups: readonly EccHookGroupV1[];
  /**
   * Set when the pinned inventory does not group exactly once each. The
   * hand-built page throws there; the view shows this refusal instead of a
   * grouping that silently drops or duplicates a control.
   */
  readonly groupingError?: string;
}

/** Everything the organization screen renders, as a fresh read. */
export interface OrgViewV1 {
  /** The readiness line (`role="status"`, polite) of `org-screen.ts` 851-880. */
  readonly readiness: string;
  readonly adoptionRoles: readonly AdoptionRoleV1[];
  readonly evidenceDelivery?: EvidenceDeliveryV1;
  readonly provenance: ProvenanceLinesV1;
  readonly developerTools: DeveloperToolsV1;
  readonly eccHooks: EccHookControlsV1;
}

export interface OrgFeature {
  /** Everything the organization screen shows; a fresh read each call. */
  org(): OrgViewV1;
  /** Include, remove, or exclude one default developer tool. */
  setDeveloperTool(id: string, action: DeveloperToolActionV1): EngineOutcome;
  /** Record the ECC hook profile; ineligible disabled ids are dropped. */
  setEccHookProfile(profile: string): EngineOutcome;
  /** Disable or re-enable one ECC hook under the recorded profile. */
  toggleEccHookDisabled(id: string): EngineOutcome;
}

export function orgFeature(ctx: AdminEngineContext): OrgFeature {
  const active = ctx.active;

  const governance = (): Record<string, unknown> =>
    governanceOrDefault(record(active.snapshotPolicy())?.governance) as Record<string, unknown>;

  const eccCatalog = (): {
    profiles: { id: string; label: string }[];
    hooks: EccHookCatalogEntry[];
    detail: string;
    eligibleIds: string[];
  } => {
    const controls = record(record(ctx.model.catalog)?.eccHookControls);
    const disabledHooks = record(controls?.disabledHooks);
    const profiles = (Array.isArray(controls?.profiles) ? controls.profiles : []).flatMap(
      (value) => {
        const profile = record(value);
        return typeof profile?.id === "string"
          ? [
              {
                id: profile.id,
                label: typeof profile.label === "string" ? profile.label : profile.id,
              },
            ]
          : [];
      },
    );
    const hooks = (Array.isArray(controls?.hooks) ? controls.hooks : []).flatMap((value) => {
      const hook = record(value);
      if (typeof hook?.id !== "string" || typeof hook.event !== "string") return [];
      return [
        {
          id: hook.id,
          event: hook.event,
          profiles: strings(hook.profiles),
          disableEligible: hook.disableEligible === true,
        },
      ];
    });
    return {
      profiles,
      hooks,
      detail: typeof disabledHooks?.detail === "string" ? disabledHooks.detail : "",
      eligibleIds: strings(disabledHooks?.eligibleIds),
    };
  };

  /** `main.ts` `mountDeveloperTools.persist`: compile, attach the choice, restore. */
  const persistDeveloperTools = (selection: {
    selected: readonly DeveloperToolId[];
    excluded: readonly DeveloperToolId[];
  }): EngineOutcome => {
    if (ctx.bundle === undefined || ctx.bindings === undefined)
      return { ok: false, message: DEVELOPER_TOOL_REJECTED_MESSAGE };
    const snapshot = active.snapshotPolicy();
    const basePolicy = record(snapshot);
    if (basePolicy === undefined)
      return { ok: false, message: "Policy session returned an invalid policy." };
    const imported = importWorkbenchPolicySelections(
      snapshot,
      ctx.bundle,
      ctx.bindings,
      ctx.sourceInputs,
    );
    if (!imported.accepted)
      return {
        ok: false,
        message: imported.diagnostics.join(" ") || DEVELOPER_TOOL_REJECTED_MESSAGE,
      };
    const compiled = projectWorkbenchPolicy(
      basePolicy,
      imported.state,
      ctx.bundle,
      ctx.bindings,
      "author",
      ctx.sourceInputs,
    );
    if (!compiled.accepted)
      return {
        ok: false,
        message: compiled.diagnostics.join(" ") || DEVELOPER_TOOL_REJECTED_MESSAGE,
      };
    const policy = {
      ...(compiled.policy as Record<string, unknown>),
      developerTools: explicitDeveloperToolSelectionForOrgPolicyV1(
        selection.selected,
        selection.excluded,
      ),
    };
    const developerTools = resolveDeveloperToolSelectionForOrgPolicyV1(policy);
    if (!developerTools.accepted)
      return {
        ok: false,
        message:
          developerTools.diagnostics.map((diagnostic) => diagnostic.message).join(" ") ||
          DEVELOPER_TOOL_REJECTED_MESSAGE,
      };
    const failed = ctx.restore(policy);
    if (failed !== undefined) return { ok: false, message: failed };
    return { ok: true, message: DEVELOPER_TOOL_SAVED_MESSAGE };
  };

  return {
    org() {
      const policy = record(active.snapshotPolicy()) ?? {};
      const recorded = governance();
      const model = ctx.model as {
        evidenceDelivery?: StudioEvidenceDelivery;
        catalogProvenance?: { sourceId: string; channel: string; resolvedAt: string };
      };

      // org-screen.ts lines 851-880: the readiness line, word for word.
      const blockers = active.readinessBlockers();
      const reviewed = Array.isArray(record(recorded.catalog)?.reviewed)
        ? (record(recorded.catalog)?.reviewed as unknown[])
        : [];
      const activations = Array.isArray(recorded.activations)
        ? (recorded.activations as unknown[]).flatMap((value) => {
            const activation = record(value);
            return activation === undefined ? [] : [activation];
          })
        : [];
      const activeIds = new Set(
        activations
          .filter((activation) => activation.state === "active")
          .map((activation) => activation.candidate),
      );
      const controls = reviewed
        .flatMap((value) => {
          const candidate = record(value);
          return candidate === undefined ? [] : [candidate];
        })
        .filter(
          (candidate) =>
            activeIds.has(candidate.id) && (candidate.kind === "mcp" || candidate.kind === "hook"),
        );
      const intersections = controls
        .map((candidate) => {
          const activation = activations.find(
            (entry) => entry.state === "active" && entry.candidate === candidate.id,
          );
          const targets =
            activation !== undefined && Array.isArray(activation.targets)
              ? strings(activation.targets).join(", ")
              : "none";
          return `${String(candidate.id)} → ${targets}`;
        })
        .join("; ");
      const posture = policy.minimumPosture === "enterprise" ? "enterprise" : "vibe";
      const readiness = controls.length
        ? blockers.length
          ? `Deployment setup needs attention before download: ${blockers.join("; ")}. Exact selected target intersections: ${intersections}.`
          : `Draft is ready to export. ${posture === "vibe" ? "Governance MCP and hook projection remains disabled in Vibe; choose Enterprise for governed deployment. " : "Governed deployment still requires policy authority and target verification. "}Exact selected target intersections: ${intersections}. Export records the managed-MCP setting.`
        : NO_CORE_CONTROLS_READINESS;

      // org-screen.ts lines 306-330: one article per adoption recipe role.
      const roles = Array.isArray(record(ctx.model.adoptionRecipe)?.roles)
        ? (record(ctx.model.adoptionRecipe)?.roles as unknown[])
        : [];
      const adoptionRoles = roles.flatMap((value) => {
        const role = record(value);
        if (role === undefined || typeof role.id !== "string") return [];
        const usage = record(role.usage);
        return [
          {
            id: role.id,
            label: typeof role.label === "string" ? role.label : role.id,
            guidance: typeof role.guidance === "string" ? role.guidance : "",
            prerequisites: strings(role.prerequisites).join("; "),
            conflicts: strings(role.conflicts).join("; "),
            nextAction: adoptionRoute(record(role.route)),
            usage:
              usage?.kind === "mcp-server-event"
                ? `MCP server event: ${String(usage.serverId)}`
                : "none captured",
          },
        ];
      });

      const deliveryRows = evidenceDeliveryRows(model);
      const evidenceDelivery =
        deliveryRows === undefined || model.evidenceDelivery === undefined
          ? undefined
          : {
              coreVersion: model.evidenceDelivery.coreVersion,
              rows: deliveryRows,
              note: EVIDENCE_DELIVERY_NOTE,
            };

      const catalogLine = catalogProvenanceTextV1(
        ctx.model as Parameters<typeof catalogProvenanceTextV1>[0],
      );
      const baselineLine = baselineEvidenceProvenanceTextV1(
        ctx.model as Parameters<typeof baselineEvidenceProvenanceTextV1>[0],
      );

      // developer-tool-selection.ts lines 137-231, without its DOM.
      const resolution = resolveDeveloperToolSelectionForOrgPolicyV1(active.snapshotPolicy());
      const diagnostics = resolution.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
      const summary = !resolution.accepted
        ? "Developer tool setup: Blocked"
        : resolution.source === "default" || resolution.source === "legacy-unspecified"
          ? "Developer tool setup: All default tools selected"
          : `Developer tool setup: ${[
              `${String(resolution.selected.length)} selected`,
              ...(resolution.excluded.length > 0
                ? [`${String(resolution.excluded.length)} excluded`]
                : []),
            ].join(" · ")}`;
      const developerTools: DeveloperToolsV1 = {
        summary,
        status: resolution.accepted
          ? developerToolSourceLabel(resolution.source)
          : `Blocked: ${diagnostics}`,
        blocked: !resolution.accepted,
        rows: DEFAULT_DEVELOPER_TOOL_IDS.map((id) => {
          const presentation = DEVELOPER_TOOL_PRESENTATION[id];
          const selected = resolution.accepted && resolution.selected.includes(id);
          const excluded = resolution.accepted && resolution.excluded.includes(id);
          const state: DeveloperToolStateV1 = !resolution.accepted
            ? "blocked"
            : excluded
              ? "excluded"
              : selected
                ? "selected-pending"
                : "not-selected";
          return {
            id,
            label: presentation.label,
            detail: presentation.detail,
            state,
            stateText: !resolution.accepted
              ? "Blocked: resolve the policy binding or selection diagnostic before setup."
              : excluded
                ? "Excluded by policy"
                : selected
                  ? "Selected: pending setup"
                  : "Not selected",
            actions: !resolution.accepted
              ? []
              : excluded
                ? (["include"] as const)
                : selected
                  ? (["remove", "exclude"] as const)
                  : (["include", "exclude"] as const),
          };
        }),
      };

      // org-screen.ts lines 882-996: the profile, the detail, and the groups.
      const catalog = eccCatalog();
      const recordedHooks = record(recorded.eccHookControls) ?? {};
      const profile = typeof recordedHooks.profile === "string" ? recordedHooks.profile : "";
      const disabledIds = strings(recordedHooks.disabledIds);
      let total = 0;
      const groups = ECC_HOOK_GROUPS.map((group) => {
        const members = group.ids
          ? group.ids.flatMap((id) => {
              const hook = catalog.hooks.find((candidate) => candidate.id === id);
              return hook === undefined ? [] : [hook];
            })
          : catalog.hooks.filter((hook) => group.select?.(hook) === true);
        total += members.length;
        return {
          id: group.id,
          label: group.label,
          description: group.description,
          hooks: members.map((hook) => ({
            id: hook.id,
            event: hook.event,
            detail: `Eligible profiles: ${hook.profiles.join(", ")}. ${hook.disableEligible ? "" : "This wrapper remains enabled."}`,
            disableEligible: hook.disableEligible,
            disabled: disabledIds.indexOf(hook.id) !== -1,
            canToggle:
              hook.disableEligible && profile !== "" && hook.profiles.indexOf(profile) !== -1,
          })),
        };
      });

      return {
        readiness,
        adoptionRoles,
        ...(evidenceDelivery === undefined ? {} : { evidenceDelivery }),
        provenance: {
          ...(catalogLine === undefined ? {} : { catalog: catalogLine }),
          ...(baselineLine === undefined ? {} : { baselineEvidence: baselineLine }),
        },
        developerTools,
        eccHooks: {
          profiles: catalog.profiles,
          profile,
          detail: catalog.detail,
          groups,
          ...(total === catalog.hooks.length
            ? {}
            : {
                groupingError: "ECC hook grouping must render every pinned hook exactly once",
              }),
        },
      };
    },

    setDeveloperTool(id, action) {
      try {
        if (action !== "include" && action !== "remove" && action !== "exclude")
          return { ok: false, message: `Unsupported developer tool action: ${String(action)}` };
        const known = DEFAULT_DEVELOPER_TOOL_IDS.find((candidate) => candidate === id);
        if (known === undefined) return { ok: false, message: `Unknown developer tool: ${id}` };
        const current = resolveDeveloperToolSelectionForOrgPolicyV1(active.snapshotPolicy());
        if (!current.accepted)
          return {
            ok: false,
            message:
              current.diagnostics.map((diagnostic) => diagnostic.message).join(" ") ||
              DEVELOPER_TOOL_REJECTED_MESSAGE,
          };
        const selected = new Set(current.selected);
        const excluded = new Set(current.excluded);
        if (action === "include") {
          selected.add(known);
          excluded.delete(known);
        } else if (action === "remove") {
          selected.delete(known);
          excluded.delete(known);
        } else {
          selected.delete(known);
          excluded.add(known);
        }
        const canonical = explicitDeveloperToolSelectionForOrgPolicyV1(
          DEFAULT_DEVELOPER_TOOL_IDS.filter((candidate) => selected.has(candidate)),
          DEFAULT_DEVELOPER_TOOL_IDS.filter((candidate) => excluded.has(candidate)),
        );
        return persistDeveloperTools({
          selected: canonical.selected ?? [],
          excluded: canonical.excluded ?? [],
        });
      } catch (error) {
        return { ok: false, message: errorMessage(error, DEVELOPER_TOOL_REJECTED_MESSAGE) };
      }
    },

    // org-screen.ts lines 779-797.
    setEccHookProfile(profile) {
      try {
        const catalog = eccCatalog();
        if (!catalog.profiles.some((candidate) => candidate.id === profile))
          return { ok: false, message: `Unknown ECC hook profile: ${String(profile)}` };
        const message = `ECC hook profile set to ${profile}. AIH records supported Claude environment intent; ECC executes the hooks.`;
        ctx.resetOutcome();
        active.edit((draft: Record<string, unknown>) => {
          const writable = governanceOrDefault(draft.governance) as Record<string, unknown>;
          draft.governance = writable;
          const hooks = record(writable.eccHookControls);
          const kept = eligibleDisabledIds(
            catalog.hooks,
            catalog.eligibleIds,
            profile,
            hooks?.disabledIds,
          );
          writable.eccHookControls = Object.assign(
            { profile },
            kept.length ? { disabledIds: kept } : {},
          );
          return undefined;
        }, message);
        return ctx.outcome(message);
      } catch (error) {
        return { ok: false, message: errorMessage(error, "ECC hook profile change was rejected.") };
      }
    },

    // org-screen.ts lines 798-828.
    toggleEccHookDisabled(id) {
      try {
        const catalog = eccCatalog();
        const recordedHooks = record(governance().eccHookControls);
        const profile =
          typeof recordedHooks?.profile === "string" ? recordedHooks.profile : undefined;
        if (profile === undefined || profile === "")
          return { ok: false, message: "Choose an ECC hook profile before disabling a hook." };
        const hook = catalog.hooks.find((candidate) => candidate.id === id);
        if (hook === undefined) return { ok: false, message: `Unknown ECC hook: ${String(id)}` };
        if (!hook.disableEligible)
          return {
            ok: false,
            message: `${hook.id} is a required wrapper; it has no individual disabled setting.`,
          };
        if (hook.profiles.indexOf(profile) === -1)
          return {
            ok: false,
            message: `${hook.id} is not eligible under the ${profile} profile.`,
          };
        const disabledNow = strings(recordedHooks?.disabledIds);
        const disabling = disabledNow.indexOf(hook.id) === -1;
        const message = `${disabling ? "Disabled " : "Re-enabled "}${hook.id} for ECC's ${profile} profile. ECC applies this after process spawn; it is not AIH enforcement.`;
        ctx.resetOutcome();
        active.edit((draft: Record<string, unknown>) => {
          const writable = governanceOrDefault(draft.governance) as Record<string, unknown>;
          draft.governance = writable;
          const hooks = record(writable.eccHookControls);
          const disabled = strings(hooks?.disabledIds);
          const next =
            disabled.indexOf(hook.id) === -1
              ? disabled.concat([hook.id])
              : disabled.filter((candidate) => candidate !== hook.id);
          const kept = eligibleDisabledIds(catalog.hooks, catalog.eligibleIds, profile, next);
          writable.eccHookControls = Object.assign(
            { profile },
            kept.length ? { disabledIds: kept } : {},
          );
          return undefined;
        }, message);
        return ctx.outcome(message);
      } catch (error) {
        return { ok: false, message: errorMessage(error, "ECC hook change was rejected.") };
      }
    },
  };
}
