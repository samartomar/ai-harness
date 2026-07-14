import { classifyCanon, isAdoptable } from "../adopt/classify.js";
import { aihConfigJson, readAihConfigBaseline } from "../config/marker.js";
import {
  BASELINE_OPTION,
  DEFAULT_BASELINE_SOURCE_ID,
  describeBaselineSource,
  resolveBaselineSource,
} from "../internals/baseline-sources.js";
import { CANON_OPTION } from "../internals/canon-mode.js";
import { detectFallbackNotice, isTargeted, resolveTargets } from "../internals/cli-detect.js";
import { deepMerge } from "../internals/merge.js";
import type { Action, CommandSpec, PlanContext, WriteAction } from "../internals/plan.js";
import { doc, plan, writeJson } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { orgPolicyProjectionActions } from "../org-policy/project.js";
import { readOrgPolicy } from "../org-policy/schema.js";
import { sidecarInitActions } from "../truth/index.js";
import { INIT_PHASES } from "./phases.js";
import { initV3Actions } from "./v3.js";

/**
 * The brownfield guard: `aih init` regenerates the canon and would overwrite an
 * existing, hand-built one. When a repo already carries adoptable canon (and isn't
 * yet aih-managed), STOP and redirect to `aih adopt`, which converges it without
 * destroying the human's work — instead of silently bulldozing it.
 */
function brownfieldRedirect(ctx: PlanContext): Action | undefined {
  const cls = classifyCanon(ctx.root, ctx.contextDir);
  if (!isAdoptable(cls.kind) || cls.configPresent) return undefined;
  return doc(
    "existing AI canon detected — use `aih adopt`, not `aih init`",
    lines(
      `This repo already has AI canon (\`${cls.kind}\`). \`aih init\` would regenerate and`,
      "overwrite it. To converge it onto aih's managed model WITHOUT losing your work:",
      "",
      "  aih adopt .            # preview the migration (carve + regenerate, non-destructive)",
      "  aih adopt . --apply    # perform it (every changed file backed up to *.aih.bak)",
      "",
      "`aih adopt` preserves project-specific content (carved into",
      "`rules/project-canon-extension.md`) and never modifies your CLI-native config.",
      "Re-run `aih init` only once the repo is on the managed model (or on a greenfield repo).",
    ),
  );
}

function uniqueList(values: readonly string[] | undefined): readonly string[] | undefined {
  return values === undefined || values.length === 0 ? undefined : [...new Set(values)];
}

function mergeStringList(
  first: readonly string[] | undefined,
  next: readonly string[] | undefined,
): readonly string[] | undefined {
  return uniqueList([...(first ?? []), ...(next ?? [])]);
}

function mergeChildKeyMap(
  first: Record<string, readonly string[]> | undefined,
  next: Record<string, readonly string[]> | undefined,
): Record<string, readonly string[]> | undefined {
  const entries = new Map<string, readonly string[]>();
  for (const source of [first, next]) {
    for (const [key, values] of Object.entries(source ?? {})) {
      entries.set(key, mergeStringList(entries.get(key), values) ?? []);
    }
  }
  return entries.size > 0 ? Object.fromEntries(entries) : undefined;
}

function mergePruneJsonChildKeys(
  first: WriteAction["pruneJsonChildKeys"],
  next: WriteAction["pruneJsonChildKeys"],
): WriteAction["pruneJsonChildKeys"] {
  const entries = new Map<string, { exact?: readonly string[]; prefixes?: readonly string[] }>();
  for (const source of [first, next]) {
    for (const [key, prune] of Object.entries(source ?? {})) {
      const prior = entries.get(key);
      entries.set(key, {
        exact: mergeStringList(prior?.exact, prune.exact),
        prefixes: mergeStringList(prior?.prefixes, prune.prefixes),
      });
    }
  }
  return entries.size > 0 ? Object.fromEntries(entries) : undefined;
}

function mergeJsonWriteActions(first: WriteAction, next: WriteAction): WriteAction {
  if (
    first.expect !== undefined &&
    next.expect !== undefined &&
    JSON.stringify(first.expect) !== JSON.stringify(next.expect)
  ) {
    throw new Error(
      `cannot compose guarded writes for ${first.path}: source changed while planning`,
    );
  }
  return {
    ...first,
    expect: next.expect ?? first.expect,
    json: deepMerge(first.json, next.json),
    removeJsonKeys: mergeChildKeyMap(first.removeJsonKeys, next.removeJsonKeys),
    replaceJsonKeys: mergeStringList(first.replaceJsonKeys, next.replaceJsonKeys),
    replaceJsonChildKeys: mergeChildKeyMap(first.replaceJsonChildKeys, next.replaceJsonChildKeys),
    pruneJsonChildKeys: mergePruneJsonChildKeys(first.pruneJsonChildKeys, next.pruneJsonChildKeys),
    removeJsonTopLevelKeys: mergeStringList(
      first.removeJsonTopLevelKeys,
      next.removeJsonTopLevelKeys,
    ),
  };
}

/**
 * Orchestrate a full repo bootstrap by COMPOSING the repo-scoped capabilities —
 * profile, superpowers, bootstrap-ai, scaffold, contract, secrets, guardrails,
 * mcp, sandbox, usage — in that order (ECC is a separate gated step; init points at it). Each phase's actions come straight from
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
  // Brownfield guard FIRST: never bulldoze an existing hand-built canon — redirect
  // to `aih adopt` and emit nothing else, so a dry-run or `--apply` both stop here.
  const redirect = brownfieldRedirect(ctx);
  if (redirect) return plan("init", redirect);

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
  const baseline = resolveBaselineSource(ctx.options, readAihConfigBaseline(ctx.root));
  const baseCtx: PlanContext = {
    ...ctx,
    targets: resolution.clis,
    options: { ...ctx.options, baseline: baseline.id },
  };

  // If `--detect` found nothing and we defaulted to claude, say so once at the top
  // (the phases short-circuit on `ctx.targets`, so no phase emits this itself).
  if (resolution.detectFellBack) {
    actions.push(doc("no AI CLIs detected — defaulted to claude", detectFallbackNotice()));
  }

  for (const phase of INIT_PHASES) {
    if (phase.command.name === "superpowers" && baseline.id !== "ecc") continue;
    const phaseCtx =
      phase.command.name === "mcp"
        ? { ...baseCtx, options: { ...ctx.options, mode: mcpMode } }
        : baseCtx;
    const sub = await phase.command.plan(phaseCtx);
    actions.push(doc(`init: ${phase.command.name}`, phase.headline));
    actions.push(...sub.actions);
  }

  const policy = readOrgPolicy(baseCtx.root, baseCtx.env);
  if (policy !== undefined && isTargeted(baseCtx, "claude")) {
    actions.push(
      doc(
        "init: org-policy",
        "org-policy — project the active aih-org-policy.json into managed settings for doctor-compatible regeneration",
      ),
      ...orgPolicyProjectionActions(baseCtx, policy),
    );
  }

  // ECC is not a phase: its installer runs the network (`npx ecc-install` / a git
  // checkout), so `aih init` points at the separate gated step instead of running
  // it. This single doc is the only action init adds beyond the phase headers.
  actions.push(baselineInstallDoc(baseline));

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
      aihConfigJson(ctx.contextDir, resolution.clis, baseline.id),
      "persist bootstrap intent (context-dir + CLI targets) so re-runs and doctor read it",
      {
        merge: true,
        removeJsonTopLevelKeys:
          ctx.options.baseline === DEFAULT_BASELINE_SOURCE_ID ? ["baseline"] : undefined,
      },
    ),
  );

  actions.push(...(await sidecarInitActions(baseCtx)));

  if (ctx.options.v3 === true) {
    actions.push(...(await initV3Actions(baseCtx)));
  }

  // Root bootloaders have a single owner (bootstrap-ai), so no two phases write the
  // same bootloader. The fold below handles the genuinely SHARED target
  // `.claude/settings.json`, which THREE phases merge-write: scaffold + secrets seed
  // IDENTICAL `Read(...)` deny rules, and guardrails projects the command-policy Bash
  // lexicon (DIFFERENT content). A first-writer-wins drop would keep only scaffold and
  // silently discard guardrails' command policy from `aih init` (it would then land
  // ONLY via standalone `aih guardrails`), defeating that defense-in-depth projection
  // on the primary init path. So when every writer to a path is a JSON merge-write,
  // UNION their payloads into the first action via `deepMerge` — which array-unions
  // `permissions.deny`/`allow`, so the deny rules + command policy compose without
  // duplicates; the executor then merges that one composed payload onto any
  // pre-existing on-disk file. Non-mergeable repeats (write-once seeds, text/overwrite
  // writes) keep the safe first-writer-wins drop, with no `.aih.bak` churn. Non-write
  // actions (docs/probes) are never folded.
  const writeSlotByPath = new Map<string, number>();
  const deduped: Action[] = [];
  for (const a of actions) {
    if (a.kind !== "write") {
      deduped.push(a);
      continue;
    }
    const slot = writeSlotByPath.get(a.path);
    if (slot === undefined) {
      writeSlotByPath.set(a.path, deduped.length);
      deduped.push(a);
      continue;
    }
    const first = deduped[slot] as WriteAction;
    const bothJsonMerge =
      first.merge === true && first.json !== undefined && a.merge === true && a.json !== undefined;
    // Fold a later JSON merge-write into the first (composing both payloads);
    // otherwise drop it so the first writer still wins.
    if (bothJsonMerge) {
      deduped[slot] = mergeJsonWriteActions(first, a);
    }
  }

  return plan("init", ...deduped);
}

function baselineInstallDoc(baseline: ReturnType<typeof resolveBaselineSource>): Action {
  if (baseline.id === "ecc") {
    return doc(
      "install ECC (separate, gated network step)",
      lines(
        "`aih init` scaffolds locally. ECC installs via ECC's OWN installer (network), so it",
        "is a separate step you run when ready:",
        "",
        "  aih ecc --apply                # install ECC (latest) for your selected CLIs",
        "  aih ecc --cli kiro --apply     # Kiro: git checkout of ECC + its native .kiro/install.sh",
      ),
    );
  }
  return doc(
    "install selected baseline (separate, gated network step)",
    lines(
      `\`aih init\` scaffolds locally. ${baseline.label} is delegated to ${describeBaselineSource(
        baseline,
      )},`,
      "so install it separately with the source's own pinned instructions when ready:",
      "",
      `  ${baseline.installVerb}`,
    ),
  );
}

export const command: CommandSpec = {
  name: "init",
  summary:
    "Initialize a target repo: profile + selected baseline + bootstrap-ai + scaffold + contract + secrets + guardrails + mcp + sandbox + usage",
  options: [
    {
      flags: "--sidecar",
      description: "create an external sibling truth sidecar and bind it to the current commit",
    },
    {
      flags: "--sidecar-path <dir>",
      description: "external truth sidecar directory (defaults to sibling <repo>-ai)",
    },
    {
      flags: "--mcp-mode <mode>",
      description:
        "MCP handling: standard | offline (vendored) | none (CLI fallback, blocked orgs)",
      default: "standard",
    },
    {
      flags: "--mcp-compliant",
      description:
        "under Enterprise posture, write only policy-allowed MCP servers and quarantine denied ones",
    },
    {
      flags: "--v3",
      description: "include the structured init-v3 scan, gap, install-plan, and fingerprint flow",
    },
    CANON_OPTION,
    BASELINE_OPTION,
  ],
  plan: initPlan,
};
