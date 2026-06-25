import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AihError } from "../errors.js";
import { aihIgnoreWrite } from "../internals/gitignore.js";
import {
  type Action,
  type CommandSpec,
  type DigestAction,
  digest,
  type PlanContext,
  plan,
  writeText,
} from "../internals/plan.js";
import { reportHtml, reportMarkdown } from "./artifact.js";
import { type ContextBloat, DEFAULT_CONTEXT_BUDGET_TOKENS, scanContextBloat } from "./bloat.js";
import { localPanels } from "./local.js";
import { aggregateOrg } from "./org.js";
import { orgDigest, orgHeadline } from "./org-render.js";
import { contextBloatDigest } from "./render.js";

type Scope = "local" | "org";
type Format = "terminal" | "md" | "html";

/** Parse `--budget`, falling back to the default for missing/invalid input. */
function budgetOf(ctx: PlanContext): number {
  const parsed = Number(ctx.options.budget);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_BUDGET_TOKENS;
}

function contextHeadline(bloat: ContextBloat): string {
  const flag = bloat.overBudget ? " — OVER budget" : "";
  return `Context footprint — ~${bloat.totalTokens} tokens across ${bloat.files.length} files${flag}`;
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

interface Built {
  scope: Scope;
  title: string;
  digests: DigestAction[];
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
  const bloat = scanContextBloat(ctx.root, ctx.contextDir, budgetOf(ctx));
  return {
    scope: "local",
    title: "aih report — local developer console",
    digests: [
      digest(contextHeadline(bloat), contextBloatDigest(bloat), bloat),
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
  const format = formatOf(ctx);
  const built = await buildReport(ctx);
  const actions: Action[] = [...built.digests];
  if (format !== "terminal") {
    const path = artifactPath(ctx, built.scope, format);
    const content =
      format === "html"
        ? reportHtml(built.title, built.digests)
        : reportMarkdown(built.title, built.digests);
    actions.push(
      writeText(path, content, `${built.scope} report (${format}) → ${path.replace(/\\/g, "/")}`),
    );
    // When the artifact lands in the default `.aih/` output dir, ensure git ignores
    // it — org reports can hold sensitive aggregate usage data and must not be left
    // as committable untracked files. Idempotent: a no-op if scaffold/bootstrap-ai/
    // init already added the rule. A custom `--out` path is the operator's to manage.
    if (path.replace(/\\/g, "/").startsWith(".aih/")) {
      actions.push(aihIgnoreWrite(ctx.root));
    }
  }
  return plan("report", ...actions);
}

export const command: CommandSpec = {
  name: "report",
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
      flags: "--budget <tokens>",
      description: "context token budget for the bloat warning (local scope)",
      default: String(DEFAULT_CONTEXT_BUDGET_TOKENS),
    },
    {
      flags: "--team",
      description:
        "include in-progress team branches (gh → git ls-remote → fetched; opt-in network)",
    },
  ],
  plan: reportPlan,
};
