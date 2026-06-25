import { detectClisByConfig } from "../internals/cli-detect.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { inventory } from "../status.js";
import { trendsPanel } from "./history.js";
import { repoStatusPanel } from "./repo.js";

/**
 * The local-scope panels of `aih report` beyond the context footprint. Each is a
 * `digest` (verbatim body + structured `data`): repo **configuration** (reusing
 * `status`'s inventory), local **tooling** saturation (which AI CLIs are set up
 * here), and an honest **stub** for the cache/skill economy that has no on-box
 * data source yet. All read-only and local — no network, no process spawning.
 */

/** Configuration presence — reuses `aih status`'s inventory (no rebuild). */
export function configPanel(ctx: PlanContext): DigestAction {
  const items = inventory(ctx.root, ctx.contextDir);
  const present = items.filter((i) => i.present);
  const body = lines(
    "Repo configuration the harness manages (presence only — run `aih doctor`",
    "for fail-closed verification):",
    "",
    ...items.map(
      (i) =>
        `  ${i.present ? "✓" : "·"} ${i.name}${i.present ? "" : `  (${i.relative} not present)`}`,
    ),
  );
  return digest(`Configuration — ${present.length} of ${items.length} artifacts present`, body, {
    present: present.map((i) => i.name),
    absent: items.filter((i) => !i.present).map((i) => i.name),
    total: items.length,
  });
}

/** Local tooling saturation — which AI CLIs are configured on this machine. */
export function toolingPanel(ctx: PlanContext): DigestAction {
  const found = detectClisByConfig(ctx);
  const present = found.filter((p) => p.present);
  const body = lines(
    "AI coding CLIs configured on this machine (by home config dir):",
    "",
    ...found.map(
      (p) => `  ${p.present ? "✓" : "·"} ${p.cli}${p.present && p.detail ? `  (${p.detail})` : ""}`,
    ),
    "",
    "  Idle tools are reallocatable seats; absent ones are onboarding opportunities.",
  );
  return digest(`Tooling — ${present.length} of ${found.length} AI CLIs configured here`, body, {
    present: present.map((p) => p.cli),
    total: found.length,
  });
}

/** Honest stub: the cache/skill economy needs an on-box data source that doesn't exist yet. */
export function economyPanel(): DigestAction {
  const body = lines(
    "Per-developer cache multiplier and skill ledger need an on-box data source",
    "that does not exist yet:",
    "",
    "  • Cache / token economy — your OTEL stream exports to the collector → backend,",
    "    not a local file. A local sink (or an Admin-API self-query) would unlock it.",
    "  • Skill ledger — needs local skill-invocation logs (ECC's recorder is unwired,",
    "    Superpowers records nothing, Kiro meters commit cadence only).",
    "",
    "  Org-level skill + cache data is available now via `aih report --org <export>`.",
  );
  return digest("Local cache & skill economy — no local data source yet", body, {
    available: false,
  });
}

/**
 * All local panels beyond the context footprint, in display order. Async because
 * the repo/branch-status panel reads git through the Runner seam.
 */
export async function localPanels(ctx: PlanContext): Promise<DigestAction[]> {
  return [
    await repoStatusPanel(ctx),
    trendsPanel(ctx),
    configPanel(ctx),
    toolingPanel(ctx),
    economyPanel(),
  ];
}
