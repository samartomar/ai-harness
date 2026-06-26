import { aihConfigJson } from "../config/marker.js";
import { detectFallbackNotice, resolveTargets } from "../internals/cli-detect.js";
import type { Action, CommandSpec, PlanContext } from "../internals/plan.js";
import { doc, plan, writeJson } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { INIT_PHASES } from "./phases.js";

/**
 * Orchestrate a full repo bootstrap by COMPOSING the repo-scoped capabilities —
 * profile, superpowers, bootstrap-ai, scaffold, secrets, guardrails, mcp,
 * sandbox — in that order (ECC is a separate gated step; init points at it). Each phase's actions come straight from
 * `command.plan(ctx)` (never re-implemented),
 * preceded by a `doc` headline so a dry-run reads as labelled sections. Because
 * every sub-capability is invoked with the same `ctx`, a custom `--context-dir`,
 * `--apply`, or `--verify` flows through to all of them, and
 * `aih init . --apply` lays the entire repo bootstrap down in one pass.
 *
 * The composition introduces no remote mutation of its own: it only adds `doc`
 * headers and forwards whatever write/doc/probe actions the leaves already
 * produce, so the harness's "no faked provisioning" guarantee is preserved.
 */
async function initPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const actions: Action[] = [];
  // `--mcp-mode` flows to the mcp phase only (standard|offline|none) so a
  // locked-down org gets the right MCP handling in one `aih init`.
  const mcpMode = String(ctx.options.mcpMode ?? "standard");

  // Resolve the target CLIs ONCE (honoring `--detect`/`--cli`, prompting once when
  // interactive) and thread the result into every phase via `ctx.targets`. Each
  // tool-specific phase then emits only for a targeted tool: a bare `aih init`
  // (default `claude`) hardens for Claude but writes no orphan `.cursor/*`; an
  // explicit `aih init --detect` on a Kiro-only box writes neither `.claude/*` nor
  // `.cursor/*`. Without this single resolution, every phase that calls
  // `resolveTargets` would re-prompt under `--detect`.
  const resolution = await resolveTargets(ctx);
  const baseCtx: PlanContext = { ...ctx, targets: resolution.clis };

  // If `--detect` found nothing and we defaulted to claude, say so once at the top
  // (the phases short-circuit on `ctx.targets`, so no phase emits this itself).
  if (resolution.detectFellBack) {
    actions.push(doc("no AI CLIs detected — defaulted to claude", detectFallbackNotice()));
  }

  for (const phase of INIT_PHASES) {
    const phaseCtx =
      phase.command.name === "mcp"
        ? { ...baseCtx, options: { ...ctx.options, mode: mcpMode } }
        : baseCtx;
    const sub = await phase.command.plan(phaseCtx);
    actions.push(doc(`init: ${phase.command.name}`, phase.headline));
    actions.push(...sub.actions);
  }

  // ECC is not a phase: its installer runs the network (`npx ecc-install` / a git
  // checkout), so `aih init` points at the separate gated step instead of running
  // it. This single doc is the only action init adds beyond the phase headers.
  actions.push(
    doc(
      "install ECC (separate, gated network step)",
      lines(
        "`aih init` scaffolds locally. ECC installs via ECC's OWN installer (network), so it",
        "is a separate step you run when ready:",
        "",
        "  aih ecc --apply                # install ECC (latest) for your selected CLIs",
        "  aih ecc --cli kiro --apply     # Kiro: git checkout of ECC + its native .kiro/install.sh",
      ),
    ),
  );

  // Persist the bootstrap intent at the repo ROOT (committed — NOT under the
  // git-ignored `.aih/`, or it would be lost on clone) so re-runs and `aih doctor`
  // read the context-dir + CLI targets this repo was actually bootstrapped with,
  // instead of silently re-deriving the `ai-coding` default. Reuse the SINGLE
  // resolution computed above (it already honored `--detect`/`--cli` and any
  // interactive edit), so the marker records exactly the set the phases used and
  // no extra confirmation fires. Mirrors `.aih-workspace.json` in `workspace/`.
  actions.push(
    writeJson(
      ".aih-config.json",
      aihConfigJson(ctx.contextDir, resolution.clis),
      "persist bootstrap intent (context-dir + CLI targets) so re-runs and doctor read it",
      { merge: true },
    ),
  );

  // Root bootloaders have a single owner (bootstrap-ai), so no two phases write
  // the same bootloader. The dedup is a safety net for genuinely shared targets
  // like `.claude/settings.json` (scaffold + secrets both merge-write it): keep
  // the FIRST writer, no `.aih.bak` churn. Non-write actions (docs/probes) are
  // never deduped.
  const seenWritePaths = new Set<string>();
  const deduped = actions.filter((a) => {
    if (a.kind !== "write") return true;
    if (seenWritePaths.has(a.path)) return false;
    seenWritePaths.add(a.path);
    return true;
  });

  return plan("init", ...deduped);
}

export const command: CommandSpec = {
  name: "init",
  summary:
    "Initialize a target repo: profile + superpowers + bootstrap-ai + scaffold + secrets + guardrails + mcp + sandbox (ECC via `aih ecc`)",
  options: [
    {
      flags: "--mcp-mode <mode>",
      description:
        "MCP handling: standard | offline (vendored) | none (CLI fallback, blocked orgs)",
      default: "standard",
    },
  ],
  plan: initPlan,
};
