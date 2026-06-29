import { detectInstall } from "../internals/cli-detect.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { scaleSafetyDigest } from "../scale-safety.js";
import { inventory } from "../status.js";
import { cliCoverageDigest } from "./cli-coverage.js";
import { aiEventsDigest } from "./events.js";
import { graphDigests } from "./graph.js";
import { guardrailDigest } from "./guardrail.js";
import { trendsPanel } from "./history.js";
import { mcpGovernanceDigest } from "./mcp-governance.js";
import { qualityDigest } from "./quality.js";
import { repoStatusPanel } from "./repo.js";
import { repoInfoDigest } from "./repoinfo.js";
import { scorecardDigest } from "./scorecard.js";
import { toolsInstalledDigest } from "./tools.js";
import { usagePanel } from "./usage.js";
import { velocityDigests } from "./velocity.js";

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
    "Repo config FILES the harness manages — whether the FILE exists in THIS repo,",
    "NOT whether a tool is installed on your machine (e.g. `gitleaks` here means the",
    "`.gitleaks.toml` policy file, not the gitleaks binary). `aih doctor` verifies them.",
    "",
    ...items.map(
      (i) =>
        `  ${i.present ? "✓" : "·"} ${i.name}  (${i.relative}${i.present ? "" : " — not in this repo"})`,
    ),
  );
  return digest(`Configuration — ${present.length} of ${items.length} config files present`, body, {
    present: present.map((i) => i.name),
    absent: items.filter((i) => !i.present).map((i) => i.name),
    // name → repo-relative file, so the dashboard can show it's a FILE, not a tool.
    files: Object.fromEntries(items.map((i) => [i.name, i.relative])),
    total: items.length,
  });
}

/**
 * Local tooling saturation — which AI CLIs are INSTALLED on this machine (by home
 * config dir). This is machine detection, deliberately distinct from repo wiring:
 * the per-CLI "AI CLI wiring" matrix ({@link cliCoverageDigest}) answers "is this
 * repo configured for that tool", which is orthogonal to "is it installed here".
 */
export async function machineToolingPanel(ctx: PlanContext): Promise<DigestAction> {
  const found = await detectInstall(ctx);
  // Honest split: a binary on PATH = runnable; a config dir with NO binary is a weak
  // signal (a leftover `~/.codeium/windsurf` survives an uninstall), so it is flagged
  // "config only (may be stale)" rather than counted as installed.
  const runnable = found.filter((f) => f.binary);
  const configOnly = found.filter((f) => !f.binary && f.config);
  const absent = found.filter((f) => !f.binary && !f.config);
  const row = (f: (typeof found)[number]): string => {
    if (f.binary) return `  ✓ ${f.cli}  (on PATH: ${f.binaryDetail})`;
    if (f.config)
      return `  ◐ ${f.cli}  (${f.configDetail} — config only; binary not on PATH, may be stale)`;
    return `  · ${f.cli}`;
  };
  const body = lines(
    "AI coding CLIs on this machine — ✓ runnable (binary on PATH), ◐ config dir only",
    "(a GUI install without a CLI launcher, or a leftover dir — may be stale), · not found.",
    "Distinct from repo wiring; see the AI CLI wiring panel for what this repo targets.",
    "",
    ...found.map(row),
    "",
    "  Idle tools are reallocatable seats; absent ones are onboarding opportunities.",
  );
  const configNote = configOnly.length > 0 ? ` · ${configOnly.length} config-only` : "";
  return digest(
    `Machine tooling — ${runnable.length} runnable${configNote} of ${found.length} AI CLIs`,
    body,
    {
      present: runnable.map((f) => f.cli),
      configOnly: configOnly.map((f) => f.cli),
      absent: absent.map((f) => f.cli),
      total: found.length,
    },
  );
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
  const panels: (DigestAction | undefined)[] = [
    ...(await velocityDigests(ctx)), // OUTPUT VELOCITY: daily commits + LOC 30d
    aiEventsDigest(ctx), // AI events feed (undefined when no events recorded)
    scorecardDigest(ctx), // HARNESS MATURITY: weighted wiring scorecard (undefined off-canon)
    await qualityDigest(ctx), // CODE QUALITY: test/source file ratio
    ...(await graphDigests(ctx)), // CODE QUALITY/PERF: code-review-graph (gated, Phase 2)
    guardrailDigest(ctx), // CODE QUALITY: guardrail severity (gated, Phase 3)
    await repoInfoDigest(ctx), // PERFORMANCE: repo info + file types
    await scaleSafetyDigest(ctx), // PERFORMANCE: large-repo analysis must have a graph path
    await toolsInstalledDigest(ctx), // HARNESS ADOPTION: shell tools on PATH
    await repoStatusPanel(ctx),
    trendsPanel(ctx),
    usagePanel(ctx),
    cliCoverageDigest(ctx), // HARNESS ADOPTION: per-CLI wiring matrix (targeted-scoped)
    mcpGovernanceDigest(ctx), // HARNESS ADOPTION: MCP enterprise-policy verdict (reuses the policy engine)
    configPanel(ctx),
    await machineToolingPanel(ctx), // HARNESS ADOPTION: which CLIs are runnable vs config-only
    economyPanel(),
  ];
  return panels.filter((d): d is DigestAction => d !== undefined);
}
