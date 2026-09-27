import {
  type DefaultToolSelectionInput,
  type DeveloperToolId,
  type PrimaryCodeGraphId,
  type ResolvedDefaultToolSelection,
  resolveDefaultToolSelection,
} from "../tools/default-tool-selection.js";
import {
  HEADROOM_MINIMUM_CORE_VERSION,
  WORKBENCH_MINIMUM_CORE_VERSION,
} from "./workbench/contracts.js";

/**
 * Browser-safe representation of a deliberate V3 tool decision. Full policy
 * schema validation adds the same boundary checks for persisted policy files.
 */
export interface DeveloperToolSelectionV1 {
  readonly selected?: readonly DeveloperToolId[];
  readonly excluded?: readonly DeveloperToolId[];
  readonly primaryCodeGraph?: PrimaryCodeGraphId;
}

const DEVELOPER_TOOL_POLICY_KEYS = new Set(["selected", "excluded", "primaryCodeGraph"]);

/**
 * A persisted Headroom choice or primary code graph is not consumable by the
 * earlier 0.6.x Core reader.
 */
export function minimumCoreVersionForDeveloperToolSelectionV1(
  selection: unknown,
): typeof WORKBENCH_MINIMUM_CORE_VERSION | typeof HEADROOM_MINIMUM_CORE_VERSION {
  const tools = object(selection);
  return (Array.isArray(tools?.selected) && tools.selected.includes("headroom")) ||
    (Array.isArray(tools?.excluded) && tools.excluded.includes("headroom")) ||
    (tools !== undefined && Object.hasOwn(tools, "primaryCodeGraph"))
    ? HEADROOM_MINIMUM_CORE_VERSION
    : WORKBENCH_MINIMUM_CORE_VERSION;
}

export function isSupportedDeveloperToolPolicyFloorV1(
  minimumCoreVersion: unknown,
  selection: unknown,
): boolean {
  if (
    minimumCoreVersion !== WORKBENCH_MINIMUM_CORE_VERSION &&
    minimumCoreVersion !== HEADROOM_MINIMUM_CORE_VERSION
  )
    return false;
  return (
    minimumCoreVersion === HEADROOM_MINIMUM_CORE_VERSION ||
    minimumCoreVersionForDeveloperToolSelectionV1(selection) === WORKBENCH_MINIMUM_CORE_VERSION
  );
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isSupportedV2LegacyEnvelope(root: Record<string, unknown>): boolean {
  const references = object(root.references);
  return (
    root.schemaVersion === 2 &&
    (root.minimumPosture === "vibe" || root.minimumPosture === "enterprise") &&
    references !== undefined &&
    typeof references.repoContract === "string" &&
    references.repoContract.trim().length > 0
  );
}

function isSupportedV3Envelope(root: Record<string, unknown>): boolean {
  const references = object(root.references);
  const authoringSelections = object(root.authoringSelections);
  return (
    root.schemaVersion === 3 &&
    isSupportedDeveloperToolPolicyFloorV1(root.minimumCoreVersion, root.developerTools) &&
    (root.minimumPosture === "vibe" || root.minimumPosture === "enterprise") &&
    references !== undefined &&
    typeof references.repoContract === "string" &&
    references.repoContract.trim().length > 0 &&
    authoringSelections !== undefined &&
    authoringSelections.selectionVersion === "workbench-selection/v1" &&
    Array.isArray(authoringSelections.roots) &&
    Array.isArray(authoringSelections.exclusions) &&
    Array.isArray(authoringSelections.requests) &&
    Array.isArray(authoringSelections.drafts)
  );
}

/**
 * The portable Workbench has no project binding. It therefore treats a V2
 * draft without this field as no policy and a V3 draft without it as the
 * established legacy-unspecified form. Runtime binding validation happens
 * before setup and supplies the fail-closed binding state to the shared
 * resolver there.
 */
export function developerToolSelectionInputForOrgPolicyV1(
  policy: unknown,
): DefaultToolSelectionInput {
  if (policy === undefined) return { policy: { kind: "none" } };
  const root = object(policy);
  if (root === undefined) return malformedSelectionInput();
  if (isSupportedV2LegacyEnvelope(root))
    return Object.hasOwn(root, "developerTools")
      ? malformedSelectionInput()
      : { policy: { kind: "none" } };
  if (!isSupportedV3Envelope(root)) return malformedSelectionInput();
  if (!Object.hasOwn(root, "developerTools"))
    return { policy: { kind: "bound", binding: "valid" } };
  const rawSelection = object(root.developerTools);
  if (
    rawSelection === undefined ||
    Object.keys(rawSelection).some((key) => !DEVELOPER_TOOL_POLICY_KEYS.has(key))
  )
    return malformedSelectionInput();
  // The shared resolver owns boundary validation of raw arrays, ids, duplicate
  // entries, overlap, and the primary code graph. Keep the raw values intact so
  // it can fail closed.
  const selection = {
    kind: "bound",
    binding: "valid",
    ...(Object.hasOwn(rawSelection, "selected") ? { selected: rawSelection.selected } : {}),
    ...(Object.hasOwn(rawSelection, "excluded") ? { excluded: rawSelection.excluded } : {}),
    ...(Object.hasOwn(rawSelection, "primaryCodeGraph")
      ? { primaryCodeGraph: rawSelection.primaryCodeGraph }
      : {}),
  } as unknown as DefaultToolSelectionInput["policy"];
  return { policy: selection };
}

function malformedSelectionInput(): DefaultToolSelectionInput {
  // Preserve a malformed supplied selection as a resolver failure. In
  // particular, do not treat it as an omitted/legacy choice and add defaults.
  return {
    policy: { kind: "bound", binding: "valid", selected: undefined },
  } as unknown as DefaultToolSelectionInput;
}

export function resolveDeveloperToolSelectionForOrgPolicyV1(
  policy: unknown,
): ResolvedDefaultToolSelection {
  return resolveDefaultToolSelection(developerToolSelectionInputForOrgPolicyV1(policy));
}

/** Canonical bytes written by the Workbench after any intentional interaction. */
export function explicitDeveloperToolSelectionForOrgPolicyV1(
  selected: readonly DeveloperToolId[],
  excluded: readonly DeveloperToolId[] = [],
): DeveloperToolSelectionV1 {
  const resolved = resolveDefaultToolSelection({
    policy: { kind: "bound", binding: "valid", selected, excluded },
  });
  if (!resolved.accepted)
    throw new Error(
      `Developer tool selection is invalid: ${resolved.diagnostics.map((item) => item.message).join(" ")}`,
    );
  return {
    selected: resolved.selected,
    ...(resolved.excluded.length ? { excluded: resolved.excluded } : {}),
  };
}
