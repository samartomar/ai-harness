import {
  type Action,
  type CommandSpec,
  doc,
  type Plan,
  type PlanContext,
  plan,
  probe,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import {
  detectPms,
  installActionsFor,
  missingTools,
  type ToolSpec,
  verifyTool,
} from "./install.js";

function summaryText(missing: ToolSpec[], pms: ReadonlySet<string>): string {
  const pmList = pms.size > 0 ? [...pms].sort().join(", ") : "none detected";
  return lines(
    `Missing agent shell tools: ${missing.map((t) => t.bin).join(", ")}.`,
    `Package managers available: ${pmList}.`,
    "",
    "Dry-run shows the exact install command per tool; `aih tools --apply` runs them",
    "(local execs). A blocked install (no package manager, no admin, locked registry)",
    "becomes a support ticket — see `--support-out <dir>` to save it.",
  );
}

/**
 * `aih tools` — install the agent shell tools the harness leans on. Diagnoses by
 * default (`alwaysVerify`): a bare run probes each tool and surfaces the exact
 * install command (exit non-zero if a CORE tool is missing); `--apply` executes the
 * installs through the detected package manager, then the same probes confirm — and
 * a still-missing tool escalates as a ticket instead of silently passing.
 */
async function toolsPlan(ctx: PlanContext): Promise<Plan> {
  const pms = await detectPms(ctx);
  const missing = await missingTools(ctx);

  if (missing.length === 0) {
    return plan(
      "tools",
      doc("tools — all present", "All agent shell tools are on PATH. Nothing to install."),
    );
  }

  // One install action per missing tool (LOCAL exec when a PM matches, else a manual
  // doc) — the shared {@link installActionsFor} builder, reused by `aih ready --apply`.
  const actions: Action[] = installActionsFor(ctx, missing, pms);
  // Verify each AFTER the execs (the executor runs execs before probes); a blocked
  // one becomes a coded finding the support layer renders as a ticket.
  for (const t of missing) {
    actions.push(probe(`${t.tool} installed`, (c: PlanContext) => verifyTool(c, t, pms)));
  }
  actions.push(doc("tools summary", summaryText(missing, pms)));
  return plan("tools", ...actions);
}

export const command: CommandSpec = {
  name: "tools",
  summary:
    "Install the agent shell tools the harness leans on (rg/fd/jq + ast-grep/comby/tree/gh/code-review-graph); escalates a blocked install as a ticket",
  // Diagnose by default so a bare `aih tools` surfaces what's missing + how to get it,
  // yet still install under `--apply` (the heal model).
  alwaysVerify: true,
  options: [],
  plan: toolsPlan,
};
