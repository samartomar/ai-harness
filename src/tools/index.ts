import {
  type Action,
  type CommandSpec,
  doc,
  exec,
  type Plan,
  type PlanContext,
  plan,
  probe,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import {
  chooseOption,
  detectPms,
  execArgv,
  missingTools,
  onPath,
  type ToolSpec,
} from "./install.js";

/** How a tool would be installed, given the available package managers. */
function howToInstall(t: ToolSpec, pms: ReadonlySet<string>): string {
  const opt = chooseOption(t, pms);
  return opt ? `\`${opt.argv.join(" ")}\`` : `manually — ${t.manual}`;
}

/**
 * Post-install verification: is the tool on PATH now? A CORE tool still missing is
 * a `fail` (real gap, drives a non-zero exit + an escalation ticket); an OPTIONAL
 * one is a `skip` (advisory improvement). Both carry `env.tool-install-blocked` so
 * the support pipeline turns a blocked install into a ready-to-send ticket.
 */
async function verifyTool(ctx: PlanContext, t: ToolSpec, pms: ReadonlySet<string>): Promise<Check> {
  if (await onPath(ctx, t.bin)) {
    return { name: t.tool, verdict: "pass", detail: `${t.bin} on PATH` };
  }
  return {
    name: t.tool,
    verdict: t.tier === "core" ? "fail" : "skip",
    detail: `${t.bin} not on PATH — install: ${howToInstall(t, pms)}`,
    code: "env.tool-install-blocked",
  };
}

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

  const actions: Action[] = [];
  // One install action per missing tool: a LOCAL exec when a PM matches (allowFailure
  // so one blocked install doesn't abort the rest), else a doc with the manual route.
  for (const t of missing) {
    const opt = chooseOption(t, pms);
    if (opt) {
      actions.push(
        exec(`install ${t.tool} (${opt.pm})`, execArgv(ctx.host.platform, opt.argv), {
          allowFailure: true,
        }),
      );
    } else {
      actions.push(
        doc(
          `install ${t.tool} manually (no supported package manager found)`,
          `No detected package manager can install ${t.tool}. Install it manually: ${t.manual}`,
        ),
      );
    }
  }
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
