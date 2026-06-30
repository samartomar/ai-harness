import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readAihConfig } from "../config/marker.js";
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
import type { Check } from "../internals/verify.js";
import type { Platform } from "../platform/base.js";
import { type SupportTemplate, supportTemplates } from "../support/render.js";
import type { SupportContext } from "../support/templates.js";
import { type AdoptionSnapshot, reportAdvisories } from "./advisories.js";
import { reportHtml, reportMarkdown } from "./artifact.js";
import { type ContextBloat, DEFAULT_CONTEXT_BUDGET_TOKENS, scanContextBloat } from "./bloat.js";
import { contractSnapshot } from "./contract.js";
import { type LoadGroupModel, scanLoadGroups } from "./loadgroups.js";
import { localPanels } from "./local.js";
import { type NextStepsInput, nextSteps, nextStepsDigest, nextStepsHeadline } from "./nextsteps.js";
import { aggregateOrg } from "./org.js";
import { orgDigest, orgHeadline } from "./org-render.js";
import { contextBloatDigest, loadGroupDigest } from "./render.js";
import { reportHtmlV4 } from "./v4.js";
import { reportHtmlV9 } from "./v9.js";
import { supportDigest, v9ExtraDigests } from "./v9-panels.js";
import { workspaceManifestExists, workspaceReportDigest } from "./workspace.js";

type Scope = "local" | "org" | "workspace";
type Format = "terminal" | "md" | "html";

/** Parse `--token-budget` (or its `--budget` alias), falling back to the default. */
function budgetOf(ctx: PlanContext): number {
  const parsed = Number(ctx.options.tokenBudget ?? ctx.options.budget);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_BUDGET_TOKENS;
}

function contextHeadline(bloat: ContextBloat, perTurn?: LoadGroupModel): string {
  // De-alarm: a large corpus whose PER-TURN cost is within budget is not over
  // budget in the way that matters — say "large corpus · per-turn OK", not "OVER".
  const flag = !bloat.overBudget
    ? ""
    : perTurn && !perTurn.overBudget
      ? " — large corpus · per-turn within budget"
      : " — OVER budget";
  return `Context footprint — ~${bloat.totalTokens} tokens across ${bloat.files.length} files${flag}`;
}

/** Captured usage events from the Usage panel digest (0 = none captured yet). */
function usageEventsFrom(digests: DigestAction[]): number | undefined {
  const d = digests.find((x) => x.describe.startsWith("Usage"));
  const n = (d?.data as { events?: unknown } | undefined)?.events;
  return typeof n === "number" ? n : undefined;
}

/** A string[] field off a digest's `data`, or [] when absent/malformed. */
function strArrayFrom(digests: DigestAction[], startsWith: string, key: string): string[] {
  const d = digests.find((x) => x.describe.startsWith(startsWith));
  const v = (d?.data as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** How many agent shell tools are NOT on PATH (from the Tools-installed digest). */
function toolsMissingFrom(digests: DigestAction[]): number | undefined {
  const d = digests.find((x) => x.describe.startsWith("Tools installed"));
  const absent = (d?.data as { absent?: unknown } | undefined)?.absent;
  return Array.isArray(absent) ? absent.length : undefined;
}

function scaleGraphMissingFrom(digests: DigestAction[]): boolean {
  return digests.some((x) => x.describe.startsWith("Scale safety — graph missing"));
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
  if (scope === "workspace") {
    return join(".aih", `workspace-report.${format === "html" ? "html" : "md"}`);
  }
  return join(".aih", "reports", `${scope}-report.${format === "html" ? "html" : "md"}`);
}

/** The Configuration panel's adoption snapshot (present count + absent names), if it ran. */
function adoptionFrom(digests: DigestAction[]): AdoptionSnapshot | undefined {
  const d = digests.find((x) => x.describe.startsWith("Configuration"));
  const data = d?.data as { present?: unknown; absent?: unknown; total?: unknown } | undefined;
  if (!data || !Array.isArray(data.present) || !Array.isArray(data.absent)) return undefined;
  const absent = data.absent.filter((x): x is string => typeof x === "string");
  return {
    present: data.present.length,
    total: typeof data.total === "number" ? data.total : data.present.length + absent.length,
    absent,
  };
}

/**
 * Render the report's advisory checks into copy-ready templates for the dashboard.
 * Byte-stable: every report finding is a developer self-fix note, whose body carries
 * NO runId/timestamp, so re-applying the HTML artifact stays a no-op.
 */
function reportSupportTemplates(ctx: PlanContext, checks: Check[]): SupportTemplate[] {
  if (checks.length === 0) return [];
  const sctx: SupportContext = {
    projectName: basename(ctx.root) || "this project",
    root: ctx.root,
    command: "aih report",
    contextDir: ctx.contextDir,
    targets: "",
    platform: ctx.host.platform,
    runId: "",
    timestamp: "",
  };
  return supportTemplates(checks, "report", sctx);
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
  if (ctx.options.workspace === true || workspaceManifestExists(ctx.root)) {
    const d = await workspaceReportDigest(ctx);
    return {
      scope: "workspace",
      title: "aih report — workspace rollup",
      digests: d ? [d] : [digest("Workspace rollup — ERROR", "No .aih-workspace.json found.", {})],
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
  const panels = await localPanels(ctx);
  // Self-guiding "Next steps": translate the report's own signals (adoption gaps,
  // empty telemetry, the over-budget-but-fine corpus) into exact `aih` commands, so
  // the report tells the reader what to run instead of leaving them to diagnose it.
  const nextInput: NextStepsInput = {
    adoption: adoptionFrom(panels),
    bloat,
    perTurn: model,
    usageEvents: usageEventsFrom(panels),
    // Telemetry is "wired" once `aih usage --apply` wrote its recorder — even before
    // an event lands. Drives dropping the "wire telemetry" step after it's done.
    telemetryWired: existsSync(join(ctx.root, ".aih", "usage-record.mjs")),
    toolsMissing: toolsMissingFrom(panels),
    scaleGraphMissing: scaleGraphMissingFrom(panels),
    // Runnable AI CLIs on this machine (Machine tooling `present`) that this repo
    // doesn't target (AI CLI wiring `targeted`) — e.g. kiro installed but unwired.
    ...(() => {
      const targets = strArrayFrom(panels, "AI CLI wiring", "targeted");
      const present = strArrayFrom(panels, "Machine tooling", "present");
      return { targets, installedUntargeted: present.filter((p) => !targets.includes(p)) };
    })(),
    initialized: readAihConfig(ctx.root) !== undefined,
  };
  return {
    scope: "local",
    title: "aih report — local developer console",
    model,
    digests: [
      // Full on-disk inventory (union across all tools) — keeps the established
      // "Context footprint" lead digest + dashboard budget bar, now reconciled with
      // the per-turn cost. The per-turn worst-case panel follows it.
      digest(contextHeadline(bloat, model), contextBloatDigest(bloat, model), bloat),
      digest(loadGroupHeadline(model), loadGroupDigest(model), model),
      // Prominent, self-guiding action list — third so it sits above the detail panels.
      digest(nextStepsHeadline(nextInput), nextStepsDigest(nextInput), {
        nextSteps: nextSteps(nextInput),
      }),
      ...panels,
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
  // `--v4` opts into the next-gen dashboard skin (additive; the legacy renderer stays
  // the default). HTML-only, like --open/--demo, so it forces the html format too.
  const v4 = ctx.options.v4 === true;
  // `--v9` opts into the developer-console dashboard (additive; legacy + `--v4` stay
  // untouched). HTML-only like the others, so it forces the html format too.
  const v9 = ctx.options.v9 === true;
  const refreshRaw = Number(ctx.options.refresh);
  const refresh =
    Number.isFinite(refreshRaw) && refreshRaw > 0 ? Math.floor(refreshRaw) : undefined;
  const format = open || demo || v4 || v9 || refresh !== undefined ? "html" : formatOf(ctx);
  const shouldOpen = open || demo;
  const built = await buildReport(ctx);
  const actions: Action[] = [...built.digests];
  // Report-panel advisories → coded checks routed through the support pipeline.
  // `--gate` keeps the per-turn budget as the CI gate ("per-turn token budget": a
  // `fail` flips the exit via the existing verify→exitCode() path, the same
  // mechanism `heal` / `bootstrap-ai --verify` use). WITHOUT `--gate`, over-budget
  // is a non-gating `skip` advisory and adoption gaps surface only in an initialised
  // repo — so a bare `aih report` still exits 0 and grows no gating probe.
  const advisoryChecks = reportAdvisories({
    model: built.model,
    adoption: adoptionFrom(built.digests),
    contract: contractSnapshot(ctx),
    gate: ctx.options.gate === true,
    initialized: readAihConfig(ctx.root) !== undefined,
  });
  for (const check of advisoryChecks) actions.push(probe(check.name, () => check));
  if (format !== "terminal") {
    const path = artifactPath(ctx, built.scope, format);
    let content: string;
    if (format === "html") {
      if (v9) {
        // v9 binds extra v9-only digests (drift, MCP servers/egress, support) so the
        // shared localPanels — and thus legacy/v4 output — stay byte-identical.
        const extra = [
          ...(built.scope === "local" ? await v9ExtraDigests(ctx) : []),
          supportDigest(reportSupportTemplates(ctx, advisoryChecks)),
        ];
        content = reportHtmlV9(built.title, [...built.digests, ...extra], { refresh, demo });
      } else if (v4) {
        content = reportHtmlV4(built.title, built.digests, { refresh, demo });
      } else {
        content = reportHtml(built.title, built.digests, {
          refresh,
          demo,
          support: reportSupportTemplates(ctx, advisoryChecks),
        });
      }
    } else {
      content = reportMarkdown(built.title, built.digests);
    }
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
  // Pure analytics: its only writes are the gitignored `.aih/` report artifact + its
  // ignore rule, which never clobber uncommitted work — so `aih report --open` must
  // not be blocked by a dirty worktree.
  skipWorktreeGate: true,
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
      flags: "--workspace",
      description:
        "force federated workspace rollup mode (auto-detected when .aih-workspace.json exists)",
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
    {
      flags: "--v4",
      description: "render the next-gen v0.5 dashboard skin (opt-in; implies html)",
    },
    {
      flags: "--v9",
      description: "render the v9 developer-console dashboard skin (opt-in; implies html)",
    },
  ],
  plan: reportPlan,
};
