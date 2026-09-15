import {
  DEFAULT_DEVELOPER_TOOL_IDS,
  type DeveloperToolId,
} from "../../../tools/default-tool-selection.js";
import {
  explicitDeveloperToolSelectionForOrgPolicyV1,
  resolveDeveloperToolSelectionForOrgPolicyV1,
} from "../../developer-tool-policy.js";

const PRESENTATION: Readonly<Record<DeveloperToolId, { label: string; detail: string }>> = {
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
  markitdown: {
    label: "MarkItDown CLI",
    detail:
      "Convert documents to Markdown locally. The MCP adapter is optional and is not enabled by this selection.",
  },
};

export interface DeveloperToolSelectionUiOptions {
  readonly root: HTMLElement;
  readonly status: HTMLElement;
  readonly initialPolicy: unknown;
  readonly persist: (selection: {
    selected: readonly DeveloperToolId[];
    excluded: readonly DeveloperToolId[];
  }) => { accepted: boolean; diagnostics?: readonly string[]; policy?: unknown };
}

export interface DeveloperToolSelectionUi {
  restore(policy: unknown): void;
}

function sourceLabel(
  source: "default" | "explicit" | "legacy-unspecified" | "fail-closed",
): string {
  if (source === "default") return "All default developer tools are selected.";
  if (source === "legacy-unspecified")
    return "Legacy policy has no developer-tool decision: defaults apply until you save a choice.";
  if (source === "fail-closed")
    return "Policy selection is blocked until its diagnostic is resolved.";
  return "Explicit policy selection is shown below.";
}

/**
 * Render authoring intent only. This surface never infers installation,
 * configuration, or verification from a policy draft.
 */
export function mountDeveloperToolSelection(
  options: DeveloperToolSelectionUiOptions,
): DeveloperToolSelectionUi {
  let currentPolicy = options.initialPolicy;
  let feedback: string | undefined;

  const restore = (policy: unknown): void => {
    currentPolicy = policy;
    feedback = undefined;
    render();
  };

  const persist = (action: "include" | "remove" | "exclude", id: DeveloperToolId): void => {
    const current = resolveDeveloperToolSelectionForOrgPolicyV1(currentPolicy);
    if (!current.accepted) {
      feedback = current.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
      render();
      return;
    }
    const selected = new Set(current.selected);
    const excluded = new Set(current.excluded);
    if (action === "include") {
      selected.add(id);
      excluded.delete(id);
    } else if (action === "remove") {
      selected.delete(id);
      excluded.delete(id);
    } else {
      selected.delete(id);
      excluded.add(id);
    }
    const canonical = explicitDeveloperToolSelectionForOrgPolicyV1(
      DEFAULT_DEVELOPER_TOOL_IDS.filter((candidate) => selected.has(candidate)),
      DEFAULT_DEVELOPER_TOOL_IDS.filter((candidate) => excluded.has(candidate)),
    );
    const result = options.persist({
      selected: canonical.selected ?? [],
      excluded: canonical.excluded ?? [],
    });
    if (result.accepted && result.policy !== undefined) currentPolicy = result.policy;
    feedback = result.accepted
      ? "Saved as an explicit developer-tool policy choice."
      : (result.diagnostics ?? ["Developer tool policy update was rejected."]).join(" ");
    render();
  };

  const button = (
    label: string,
    action: "include" | "remove" | "exclude",
    id: DeveloperToolId,
  ): HTMLButtonElement => {
    const control = document.createElement("button");
    control.type = "button";
    control.className = "btn sm";
    control.textContent = label;
    control.addEventListener("click", () => persist(action, id));
    return control;
  };

  const render = (): void => {
    const resolution = resolveDeveloperToolSelectionForOrgPolicyV1(currentPolicy);
    options.root.replaceChildren();
    if (!resolution.accepted) {
      options.status.textContent = `Blocked — ${resolution.diagnostics.map((diagnostic) => diagnostic.message).join(" ")}`;
      options.status.className = "help error";
    } else {
      options.status.textContent = feedback ?? sourceLabel(resolution.source);
      options.status.className = "help";
    }
    for (const id of DEFAULT_DEVELOPER_TOOL_IDS) {
      const presentation = PRESENTATION[id];
      const selected = resolution.accepted && resolution.selected.includes(id);
      const excluded = resolution.accepted && resolution.excluded.includes(id);
      const row = document.createElement("article");
      row.className = "gcard developer-tool-row";
      row.dataset.developerToolId = id;
      row.dataset.developerToolState = !resolution.accepted
        ? "blocked"
        : excluded
          ? "excluded"
          : selected
            ? "selected-pending"
            : "not-selected";
      const title = document.createElement("h3");
      title.textContent = presentation.label;
      const detail = document.createElement("p");
      detail.className = "help";
      detail.textContent = presentation.detail;
      const state = document.createElement("p");
      state.className = "help";
      state.textContent = !resolution.accepted
        ? "Blocked — resolve the policy binding or selection diagnostic before setup."
        : excluded
          ? "Excluded by policy"
          : selected
            ? "Selected — pending setup"
            : "Not selected";
      const actions = document.createElement("div");
      actions.className = "brow";
      if (resolution.accepted) {
        if (excluded) {
          actions.append(button(`Include ${presentation.label} in setup`, "include", id));
        } else {
          actions.append(
            button(
              selected
                ? `Remove ${presentation.label} from selection`
                : `Include ${presentation.label} in setup`,
              selected ? "remove" : "include",
              id,
            ),
            button(`Exclude ${presentation.label} from setup`, "exclude", id),
          );
        }
      }
      row.append(title, detail, state, actions);
      options.root.append(row);
    }
  };

  render();
  return { restore };
}
