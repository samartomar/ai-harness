/**
 * The adopter-facing developer tools that ordinary setup selects when there is
 * no effective policy decision. The order is stable across UI, plans, and
 * runtime setup so persisted selections do not churn between clients.
 */
export const DEFAULT_DEVELOPER_TOOL_IDS = [
  "code-review-graph",
  "codebase-memory-mcp",
  "serena",
  "token-optimizer",
  "context7",
  "markitdown",
  "playwright",
  "headroom",
] as const;

export type DeveloperToolId = (typeof DEFAULT_DEVELOPER_TOOL_IDS)[number];

/** The two code-graph tools; either may be named the primary while both stay available. */
export const PRIMARY_CODE_GRAPH_IDS = ["code-review-graph", "codebase-memory-mcp"] as const;

export type PrimaryCodeGraphId = (typeof PRIMARY_CODE_GRAPH_IDS)[number];

export function isPrimaryCodeGraphId(value: unknown): value is PrimaryCodeGraphId {
  return typeof value === "string" && (PRIMARY_CODE_GRAPH_IDS as readonly string[]).includes(value);
}

export type DeveloperToolPolicyBindingState =
  | "valid"
  | "invalid"
  | "missing"
  | "revoked"
  | "changed"
  | "conflicting";

export interface DeveloperToolPolicySelection {
  readonly kind: "bound";
  readonly binding: DeveloperToolPolicyBindingState;
  /** Property presence is significant: omitted is legacy-unspecified; [] is explicit empty. */
  readonly selected?: readonly string[];
  readonly excluded?: readonly string[];
  /** Enterprise primary code graph; it must name a selected code-graph tool. */
  readonly primaryCodeGraph?: string;
}

export interface DefaultToolSelectionInput {
  readonly policy: { readonly kind: "none" } | DeveloperToolPolicySelection;
}

export type DefaultToolSelectionSource =
  | "default"
  | "explicit"
  | "legacy-unspecified"
  | "fail-closed";

export type DefaultToolSelectionDiagnosticCode =
  | "malformed-policy"
  | "unusable-binding"
  | "unknown-tool"
  | "duplicate-tool"
  | "selection-conflict"
  | "invalid-primary"
  | "excluded-primary";

export interface DefaultToolSelectionDiagnostic {
  readonly code: DefaultToolSelectionDiagnosticCode;
  readonly message: string;
  readonly toolId?: string;
}

export interface ResolvedDefaultToolSelection {
  readonly accepted: boolean;
  readonly source: DefaultToolSelectionSource;
  readonly selected: DeveloperToolId[];
  readonly excluded: DeveloperToolId[];
  readonly diagnostics: DefaultToolSelectionDiagnostic[];
  /** Present only when the policy names one; absence leaves the choice to the user. */
  readonly primaryCodeGraph?: PrimaryCodeGraphId;
}

const TOOL_IDS = new Set<string>(DEFAULT_DEVELOPER_TOOL_IDS);
const BINDING_STATES = new Set<DeveloperToolPolicyBindingState>([
  "valid",
  "invalid",
  "missing",
  "revoked",
  "changed",
  "conflicting",
]);

export function isDeveloperToolId(value: unknown): value is DeveloperToolId {
  return typeof value === "string" && TOOL_IDS.has(value);
}

function failed(diagnostic: DefaultToolSelectionDiagnostic): ResolvedDefaultToolSelection {
  return {
    accepted: false,
    source: "fail-closed",
    selected: [],
    excluded: [],
    diagnostics: [diagnostic],
  };
}

function ordered(ids: ReadonlySet<DeveloperToolId>): DeveloperToolId[] {
  return DEFAULT_DEVELOPER_TOOL_IDS.filter((id) => ids.has(id));
}

function validateToolList(
  value: unknown,
  field: "selected" | "excluded",
): { ids: Set<DeveloperToolId> } | { diagnostic: DefaultToolSelectionDiagnostic } {
  if (!Array.isArray(value))
    return {
      diagnostic: {
        code: "malformed-policy",
        message: `Developer tool ${field} must be an array when supplied.`,
      },
    };
  const ids = new Set<DeveloperToolId>();
  for (const item of value) {
    if (!isDeveloperToolId(item))
      return {
        diagnostic: {
          code: "unknown-tool",
          message: `Developer tool ${field} contains an unsupported id.`,
          ...(typeof item === "string" ? { toolId: item } : {}),
        },
      };
    if (ids.has(item))
      return {
        diagnostic: {
          code: "duplicate-tool",
          message: `Developer tool ${field} contains a duplicate id.`,
          toolId: item,
        },
      };
    ids.add(item);
  }
  return { ids };
}

/**
 * Resolve the single default-selection contract shared by Workbench and setup.
 * Any unusable bound policy or malformed selection returns no tools, so callers
 * cannot accidentally replace a failed policy with the no-policy defaults.
 */
export function resolveDefaultToolSelection(
  input: DefaultToolSelectionInput | unknown,
): ResolvedDefaultToolSelection {
  if (input === null || typeof input !== "object" || !("policy" in input))
    return failed({
      code: "malformed-policy",
      message: "Developer tool policy input is malformed.",
    });
  const policy = input.policy;
  if (policy === null || typeof policy !== "object" || !("kind" in policy))
    return failed({ code: "malformed-policy", message: "Developer tool policy is malformed." });
  if (policy.kind === "none")
    return {
      accepted: true,
      source: "default",
      selected: [...DEFAULT_DEVELOPER_TOOL_IDS],
      excluded: [],
      diagnostics: [],
    };
  if (
    policy.kind !== "bound" ||
    !("binding" in policy) ||
    !BINDING_STATES.has(policy.binding as DeveloperToolPolicyBindingState)
  )
    return failed({
      code: "malformed-policy",
      message: "Developer tool policy binding is malformed.",
    });
  if (policy.binding !== "valid")
    return failed({
      code: "unusable-binding",
      message: `Developer tool policy binding is ${String(policy.binding)}; defaults were not applied.`,
    });

  const hasSelected = Object.hasOwn(policy, "selected");
  const hasExcluded = Object.hasOwn(policy, "excluded");
  const selectedResult = validateToolList(
    hasSelected ? (policy as { selected?: unknown }).selected : [...DEFAULT_DEVELOPER_TOOL_IDS],
    "selected",
  );
  if ("diagnostic" in selectedResult) return failed(selectedResult.diagnostic);
  const excludedResult = validateToolList(
    hasExcluded ? (policy as { excluded?: unknown }).excluded : [],
    "excluded",
  );
  if ("diagnostic" in excludedResult) return failed(excludedResult.diagnostic);

  for (const id of DEFAULT_DEVELOPER_TOOL_IDS) {
    if (hasSelected && selectedResult.ids.has(id) && excludedResult.ids.has(id))
      return failed({
        code: "selection-conflict",
        message: "A developer tool cannot be both selected and excluded.",
        toolId: id,
      });
  }
  const selected = new Set([...selectedResult.ids].filter((id) => !excludedResult.ids.has(id)));
  let primaryCodeGraph: PrimaryCodeGraphId | undefined;
  if (Object.hasOwn(policy, "primaryCodeGraph")) {
    const primary = (policy as { primaryCodeGraph?: unknown }).primaryCodeGraph;
    if (!isPrimaryCodeGraphId(primary))
      return failed({
        code: "invalid-primary",
        message:
          "Developer tool primaryCodeGraph must be code-review-graph or codebase-memory-mcp.",
        ...(typeof primary === "string" ? { toolId: primary } : {}),
      });
    if (!selected.has(primary))
      return failed({
        code: "excluded-primary",
        message: "Developer tool primaryCodeGraph names a tool the policy does not select.",
        toolId: primary,
      });
    primaryCodeGraph = primary;
  }
  return {
    accepted: true,
    source: hasSelected ? "explicit" : "legacy-unspecified",
    selected: ordered(selected),
    excluded: ordered(excludedResult.ids),
    diagnostics: [],
    ...(primaryCodeGraph === undefined ? {} : { primaryCodeGraph }),
  };
}
