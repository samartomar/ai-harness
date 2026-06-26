import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AihError } from "../errors.js";
import { aihIgnoreWrite } from "../internals/gitignore.js";
import {
  type Action,
  type CommandSpec,
  type DigestAction,
  digest,
  exec,
  type PlanContext,
  plan,
  probe,
  writeText,
} from "../internals/plan.js";
import { acceptChanged, changedSince, gitTrackedSet } from "../internals/scan-allowlist.js";
import { assertNoCmdInjection } from "../internals/shell-safety.js";
import type { Platform } from "../platform/base.js";
import { reportHtml, reportMarkdown } from "./artifact.js";
import { type ContextBloat, DEFAULT_CONTEXT_BUDGET_TOKENS, scanContextBloat } from "./bloat.js";
import { type LoadGroupModel, scanLoadGroups } from "./loadgroups.js";
import { localPanels } from "./local.js";
import { aggregateOrg } from "./org.js";
import { orgDigest, orgHeadline } from "./org-render.js";
import { contextBloatDigest, loadGroupDigest } from "./render.js";

type Scope = "local" | "org";
type Format = "terminal" | "md" | "html";

/** Parse `--token-budget` (or its `--budget` alias), falling back to the default. */
function budgetOf(ctx: PlanContext): number {
  const parsed = Number(ctx.options.tokenBudget ?? ctx.options.budget);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_BUDGET_TOKENS;
}

function contextHeadline(bloat: ContextBloat): string {
  const flag = bloat.overBudget ? " — OVER budget" : "";
  return `Context footprint — ~${bloat.totalTokens} tokens across ${bloat.files.length} files${flag}`;
}

/** Headline for the per-turn load-group digest (the real cost: one tool's bundle). */
function loadGroupHeadline(model: LoadGroupModel): string {
  const who = model.worst ? ` (worst: ${model.worst.clis.join(", ")})` : "";
  const flag = model.overBudget ? " — OVER per-turn budget" : "";
  return `Per-turn context — ~${model.worstTokens} tokens${who}${flag}`;
}

/** Read + JSON-parse a saved Admin-API export for `--org`. Fail-closed with a stable code. */
function readOrgExport(ctx: PlanContext, file: string): unknown {
  const path = resolve(ctx.root, file);
  if (!existsSync(path)) throw new AihError(`--org export not found: ${file}`, "AIH_REPORT");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new AihError(
      `could not read --org export ${file}: ${(e as Error).message}`,
      "AIH_REPORT",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AihError(`--org export is not valid JSON: ${file}`, "AIH_REPORT");
  }
}

/** Validate `--format`, failing closed on an unknown value. */
function formatOf(ctx: PlanContext): Format {
  const raw = ctx.options.format;
  if (raw === undefined) return "terminal";
  const f = String(raw).toLowerCase();
  if (f === "terminal" || f === "term") return "terminal";
  if (f === "md" || f === "markdown") return "md";
  if (f === "html") return "html";
  throw new AihError(
    `unknown --format "${String(raw)}" (expected: terminal | md | html)`,
    "AIH_REPORT",
  );
}

/**
 * Artifact path for `--format md|html`. Defaults to `.aih/reports/<scope>-report.<ext>`
 * — deliberately OUTSIDE the context dir, so the generated report is never itself
 * scanned as agent context (which would inflate the very footprint it measures)
 * and re-applying stays a byte-stable no-op.
 */
function artifactPath(ctx: PlanContext, scope: Scope, format: Format): string {
  const out = ctx.options.out;
  if (typeof out === "string" && out.length > 0) return out;
  return join(".aih", "reports", `${scope}-report.${format === "html" ? "html" : "md"}`);
}

/** The OS command that opens a file in the default app (browser for the .html dashboard). */
function openArgv(platform: Platform, file: string): string[] {
  if (platform === "windows") return ["cmd", "/c", "start", "", file];
  if (platform === "darwin") return ["open", file];
  return ["xdg-open", file];
}

interface Built {
  scope: Scope;
  title: string;
  digests: DigestAction[];
  /** The local load-group model (when scope === "local"), so the gate probe can read it. */
  model?: LoadGroupModel;
}

/** Build the report's digests (terminal output) for the active scope. */
async function buildReport(ctx: PlanContext): Promise<Built> {
  const orgFile = ctx.options.org;
  if (typeof orgFile === "string" && orgFile.length > 0) {
    const data = aggregateOrg(readOrgExport(ctx, orgFile));
    return {
      scope: "org",
      title: "aih report — org usage",
      digests: [digest(orgHeadline(data), orgDigest(data), data)],
    };
  }
  const budget = budgetOf(ctx);
  // Honor .gitignore (unless --no-gitignore) so the footprint counts only the
  // tracked/untracked-not-ignored source, never generated per-CLI copies or
  // ignored files. `--since <ref>` further narrows to files changed in a PR.
  const allow = ctx.options.allFiles === true ? undefined : await gitTrackedSet(ctx);
  // `--since` not in a git repo → silent no-op (full scan); in a repo it narrows
  // to files changed vs the ref.
  const since =
    typeof ctx.options.since === "string" ? await changedSince(ctx, ctx.options.since) : undefined;
  const scanOpts = { accept: acceptChanged(allow, since) };
  const bloat = scanContextBloat(ctx.root, ctx.contextDir, budget, scanOpts);
  const model = scanLoadGroups(ctx.root, ctx.contextDir, budget, scanOpts);
  return {
    scope: "local",
    title: "aih report — local developer console",
    model,
    digests: [
      // Full on-disk inventory (union across all tools) — keeps the established
      // "Context footprint" lead digest + dashboard budget bar. The per-turn
      // worst-case panel (what one tool actually loads) follows it.
      digest(contextHeadline(bloat), contextBloatDigest(bloat), bloat),
      digest(loadGroupHeadline(model), loadGroupDigest(model), model),
      ...(await localPanels(ctx)),
    ],
  };
}

/**
 * `aih report` — read-only analytics digest. Two scopes (local default, `--org`),
 * both emitting `digest` actions (body printed verbatim, structured `data` into
 * `--json`). With `--format md|html`, a single combined artifact is ALSO written
 * under `--apply` ({@link artifactPath}). Network-free by default — the org scope
 * reads a locally-saved export, and the local repo-status panel reads local git
 * only. The sole opt-in network call is `--team` (gh/remote branch view), gated
 * like the telemetry fetcher's `--run`.
 */
async function reportPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  // `--open` implies the HTML dashboard (you can't usefully "open" a terminal/md
  // report in a browser); `--refresh <sec>` embeds a meta-refresh + also forces html
  // (the watch loop in run.ts keeps regenerating the file while the page reloads).
  const open = ctx.options.open === true;
  // `--demo` opens the dashboard defaulting to the embedded DEMO dataset (for
  // visualizing / showcasing the full report); the in-page "◑ demo data" toggle is
  // present in EVERY report regardless. Demo implies the HTML dashboard + open.
  const demo = ctx.options.demo === true;
  const refreshRaw = Number(ctx.options.refresh);
  const refresh =
    Number.isFinite(refreshRaw) && refreshRaw > 0 ? Math.floor(refreshRaw) : undefined;
  const format = open || demo || refresh !== undefined ? "html" : formatOf(ctx);
  const shouldOpen = open || demo;
  const built = await buildReport(ctx);
  const actions: Action[] = [...built.digests];
  // CI gate: only with `--gate`, push a probe that flips the exit code through the
  // existing verify→exitCode() path (the same mechanism `heal` / `bootstrap-ai
  // --verify` use). It gates on the WORST-CASE tool, not the summed total. Without
  // `--gate` no probe is added, so a bare `aih report` always exits 0.
  if (ctx.options.gate === true && built.model) {
    const m = built.model;
    actions.push(
      probe("per-turn token budget", () =>
        m.overBudget
          ? {
              name: "token-budget",
              verdict: "fail",
              detail: `worst tool (${m.worst?.clis.join(", ") ?? "none"}) ~${m.worstTokens} tok > budget ${m.budgetTokens}`,
            }
          : {
              name: "token-budget",
              verdict: "pass",
              detail: `worst tool ~${m.worstTokens} tok ≤ budget ${m.budgetTokens}`,
            },
      ),
    );
  }
  if (format !== "terminal") {
    const path = artifactPath(ctx, built.scope, format);
    const content =
      format === "html"
        ? reportHtml(built.title, built.digests, { refresh, demo })
        : reportMarkdown(built.title, built.digests);
    // The default artifact lands under `.aih/` (repo-contained). An explicit `--out`
    // is the operator's own chosen target, so it opts out of repo containment.
    const operatorOut = typeof ctx.options.out === "string" && ctx.options.out.length > 0;
    actions.push(
      writeText(path, content, `${built.scope} report (${format}) → ${path.replace(/\\/g, "/")}`, {
        external: operatorOut,
      }),
    );
    // When the artifact lands in the default `.aih/` output dir, ensure git ignores
    // it — org reports can hold sensitive aggregate usage data and must not be left
    // as committable untracked files. Idempotent: a no-op if scaffold/bootstrap-ai/
    // init already added the rule. A custom `--out` path is the operator's to manage.
    if (path.replace(/\\/g, "/").startsWith(".aih/")) {
      actions.push(aihIgnoreWrite(ctx.root));
    }
    // Launch the dashboard in the default browser (local exec, runs under --apply;
    // `--open` implies --apply so a single `aih report --open` builds AND opens it).
    if (shouldOpen) {
      const file = resolve(ctx.root, path);
      // On Windows the file is opened via `cmd /c start "" <file>`; reject a
      // metacharacter-laden `--out` before it reaches cmd.exe.
      if (ctx.host.platform === "windows") assertNoCmdInjection(file, "--out");
      actions.push(
        exec(
          `open ${path.replace(/\\/g, "/")} in your browser`,
          openArgv(ctx.host.platform, file),
          { allowFailure: true }, // best-effort: the html is already written
        ),
      );
    }
  }
  return plan("report", ...actions);
}

export const command: CommandSpec = {
  name: "report",
  // alwaysVerify so the `--gate` probe runs and drives the exit code. A bare
  // `aih report` has no probes, so this is a no-op there (empty report → exit 0).
  alwaysVerify: true,
  summary: "Analytics digest — local context footprint or org usage (--org); md/html via --format",
  options: [
    {
      flags: "--org <file>",
      description: "render the enterprise org digest from a saved Admin-API export (JSON)",
    },
    {
      flags: "--format <fmt>",
      description: "also write a file artifact under --apply: terminal | md | html",
      default: "terminal",
    },
    {
      flags: "--out <path>",
      description: "artifact path for --format md|html (default .aih/reports/<scope>-report.<ext>)",
    },
    {
      flags: "--token-budget <tokens>",
      description: "per-turn token budget for the worst-case tool (local scope; gate input)",
      default: String(DEFAULT_CONTEXT_BUDGET_TOKENS),
    },
    {
      flags: "--budget <tokens>",
      description: "deprecated alias for --token-budget",
    },
    {
      flags: "--gate",
      description:
        "exit non-zero when the worst-case tool's per-turn context exceeds the budget (CI)",
    },
    {
      flags: "--all-files",
      description: "skip the gitignore allowlist — count every file on disk (generated copies too)",
    },
    {
      flags: "--since <ref>",
      description:
        "only count context files changed vs <ref> (fast PR CI; full scan when not a repo)",
    },
    {
      flags: "--team",
      description:
        "include in-progress team branches (gh → git ls-remote → fetched; opt-in network)",
    },
    {
      flags: "--open",
      description: "build the HTML dashboard and open it in your browser (implies html + apply)",
    },
    {
      flags: "--demo",
      description:
        "open the dashboard with embedded DEMO data for showcasing (implies html + open)",
    },
    {
      flags: "--refresh <sec>",
      description:
        "live mode: open the dashboard and regenerate it every <sec> seconds (Ctrl+C to stop)",
    },
  ],
  plan: reportPlan,
};
