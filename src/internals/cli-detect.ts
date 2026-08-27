import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAihConfig } from "../config/marker.js";
import { SettingsError } from "../errors.js";
import type { OrgPolicy } from "../org-policy/schema.js";
import { readOrgPolicy } from "../org-policy/schema.js";
import { entry } from "./cli-registry.js";
import { type Cli, resolveClis, SUPPORTED_CLIS } from "./clis.js";
import type { PlanContext } from "./plan.js";
import type { Prompter } from "./prompt.js";

/**
 * Best-effort presence detection for each AI CLI: a home-relative config dir, or
 * a binary on PATH (probed through the Runner seam, so tests stay hermetic).
 * Signals are conservative — present is high-signal, absent just means "not found
 * here", never an error. The config dirs / binaries come from {@link entry} (the
 * single CLI registry), so they can't drift from the rest of the per-CLI facts.
 */

export interface CliPresence {
  cli: Cli;
  present: boolean;
  /** How it was detected, when present. */
  via?: "config" | "binary";
  /** The matching config dir or binary name. */
  detail?: string;
}

/** The user's home directory — from the injected env first (testable), then the OS. */
export function homeDir(ctx: PlanContext): string {
  return ctx.env.USERPROFILE || ctx.env.HOME || homedir();
}

/**
 * Resolve a CLI-native global config directory. Kiro's KIRO_HOME is itself the
 * `.kiro` root, unlike HOME which is the parent of every other registry path.
 */
function configDirPath(ctx: PlanContext, cli: Cli, rel: string): { path: string; detail: string } {
  const kiroHome = ctx.env.KIRO_HOME?.trim();
  if (cli === "kiro" && kiroHome) {
    if (rel === ".kiro") return { path: kiroHome, detail: "KIRO_HOME" };
    const suffix = rel.startsWith(".kiro/") ? rel.slice(".kiro/".length) : rel;
    return { path: join(kiroHome, suffix), detail: `KIRO_HOME/${suffix}` };
  }
  return { path: join(homeDir(ctx), rel), detail: `~/${rel}` };
}

/** Is `name` resolvable on PATH? Uses `where` (Windows) / `which` (POSIX) via the Runner. */
async function binaryOnPath(ctx: PlanContext, name: string): Promise<boolean> {
  const argv = ctx.host.platform === "windows" ? ["where", name] : ["which", name];
  const res = await ctx.run(argv);
  return !res.spawnError && res.code === 0 && res.stdout.trim().length > 0;
}

/** Detect one CLI: config dir wins (cheap, deterministic), else a PATH probe. */
export async function detectOne(ctx: PlanContext, cli: Cli): Promise<CliPresence> {
  const sig = entry(cli);
  for (const rel of sig.configDirs) {
    const config = configDirPath(ctx, cli, rel);
    if (existsSync(config.path))
      return { cli, present: true, via: "config", detail: config.detail };
  }
  for (const bin of sig.binaries) {
    if (await binaryOnPath(ctx, bin)) return { cli, present: true, via: "binary", detail: bin };
  }
  return { cli, present: false };
}

/** Detect every supported CLI (presence + how), in canonical order. */
export async function detectClis(ctx: PlanContext): Promise<CliPresence[]> {
  return Promise.all(SUPPORTED_CLIS.map((cli) => detectOne(ctx, cli)));
}

/**
 * A CLI's two install signals checked INDEPENDENTLY (unlike {@link detectOne},
 * which short-circuits on the first hit). A config dir alone is a weak signal — it
 * survives an uninstall — so an honest inventory needs to know whether the binary
 * is ALSO on PATH ("runnable") vs only a (possibly stale) config dir remaining.
 */
export interface CliInstall {
  cli: Cli;
  /** A home config dir exists (weak: a leftover dir survives an uninstall). */
  config: boolean;
  /** A registry binary resolves on PATH (strong: the tool is actually runnable). */
  binary: boolean;
  /** The matching config dir (`~/…`), when `config`. */
  configDetail?: string;
  /** The matching binary name, when `binary`. */
  binaryDetail?: string;
}

/**
 * Per-CLI install signals with config AND PATH checked separately, so a caller can
 * tell a runnable install (binary on PATH) from a config dir that may just be a
 * leftover. Async — one PATH probe per binary through the Runner seam.
 */
export async function detectInstall(ctx: PlanContext): Promise<CliInstall[]> {
  return Promise.all(
    SUPPORTED_CLIS.map(async (cli): Promise<CliInstall> => {
      const sig = entry(cli);
      const out: CliInstall = { cli, config: false, binary: false };
      for (const rel of sig.configDirs) {
        const config = configDirPath(ctx, cli, rel);
        if (existsSync(config.path)) {
          out.config = true;
          out.configDetail = config.detail;
          break;
        }
      }
      for (const bin of sig.binaries) {
        if (await binaryOnPath(ctx, bin)) {
          out.binary = true;
          out.binaryDetail = bin;
          break;
        }
      }
      return out;
    }),
  );
}

/**
 * Config-dir-only presence (synchronous, no PATH probe), in canonical order. For
 * read-only inventories like `aih report`, where spawning a `which`/`where` per
 * binary isn't worth it — reuses the same {@link SIGNALS} config dirs.
 */
export function detectClisByConfig(ctx: PlanContext): CliPresence[] {
  return SUPPORTED_CLIS.map((cli) => {
    for (const rel of entry(cli).configDirs) {
      const config = configDirPath(ctx, cli, rel);
      if (existsSync(config.path))
        return { cli, present: true, via: "config", detail: config.detail };
    }
    return { cli, present: false };
  });
}

/** The CLIs detected as present, in canonical order. */
export function presentClis(presences: CliPresence[]): Cli[] {
  return presences.filter((p) => p.present).map((p) => p.cli);
}

export interface TargetResolution {
  /** The CLIs to act on. */
  clis: Cli[];
  /** True when `--detect` found nothing and the result fell back to `claude`. */
  detectFellBack: boolean;
  /**
   * True when NOTHING selected the targets — no injected `ctx.targets`, no
   * `--cli`/`--all-tools`/`--detect`, and no marker targets — so the result is the
   * bare `claude` default. Callers use it to warn before narrowing past canon the
   * repo already has; an expressed selection is never second-guessed.
   */
  bareDefault: boolean;
}

/**
 * Show the auto-detected CLIs and let the user confirm or edit the list before the
 * harness installs anything. Bare Enter accepts the detected set; typing a
 * comma-separated list replaces it (add/remove tools). Reuses {@link resolveClis}
 * for parsing + validation, so unknown names are dropped with the same rules.
 * Returns the final list (possibly empty when nothing was detected and the user
 * skipped — the caller then falls back to `claude`).
 */
export async function confirmDetectedClis(
  prompter: Prompter,
  detected: Cli[],
  configOnly: Cli[] = [],
): Promise<Cli[]> {
  const supported = SUPPORTED_CLIS.join(", ");
  const configOnlyNote =
    configOnly.length > 0
      ? [
          "",
          `Config-only traces found (not targeted unless you type them explicitly): ${configOnly.join(", ")}`,
        ].join("\n")
      : "";
  const question =
    detected.length > 0
      ? [
          `Runnable AI CLIs on this machine: ${detected.join(", ")}`,
          `Install for these? Press Enter to accept, or type a comma-separated list to change`,
          `(supported: ${supported}): `,
          configOnlyNote,
        ].join("\n")
      : [
          "No runnable AI CLIs were detected on this machine.",
          `Type a comma-separated list to install for, or press Enter to skip (defaults to claude).`,
          `Supported: ${supported}: `,
          configOnlyNote,
        ].join("\n");
  const answer = await prompter.ask(question);
  if (answer.trim().length === 0) return detected;
  return resolveClis({ cli: answer });
}

/**
 * Resolve the target CLIs, honoring `--detect`. Precedence: `--all-tools` >
 * explicit `--cli <list>` > `--detect` (the CLIs found on this machine) > the
 * default (`claude`). When `--detect` finds nothing, fall back to `claude` so the
 * harness still produces a usable result, and flag `detectFellBack` so the caller
 * can surface a clear notice instead of silently defaulting.
 *
 * When a {@link Prompter} is wired (interactive TTY, not `--json`/`--yes`), the
 * detected list is shown for confirmation/editing before it's used — so a human
 * always sees "install for these?" while automation stays non-interactive.
 */
function enforceOrgSupportedCliAllowList(
  ctx: PlanContext,
  resolution: TargetResolution,
  policy?: OrgPolicy,
): TargetResolution {
  const sanctioned = (policy ?? readOrgPolicy(ctx.root, ctx.env))?.governance?.supportedClis;
  if (sanctioned === undefined) return resolution;
  const allowed = new Set<Cli>(sanctioned);
  const blocked = resolution.clis.filter((cli) => !allowed.has(cli));
  if (blocked.length > 0) {
    throw new SettingsError(
      "organization sanction gate refused selected CLI target(s): " +
        blocked.join(", ") +
        ". Allowed: " +
        sanctioned.join(", ") +
        ". Update aih-org-policy.json governance.supportedClis or select a sanctioned CLI.",
    );
  }
  return resolution;
}

export async function resolveTargets(
  ctx: PlanContext,
  policy?: OrgPolicy,
): Promise<TargetResolution> {
  // An orchestrator (`aih init`) resolves the target set ONCE and threads it into
  // every phase via `ctx.targets`, so the user is prompted at most once and all
  // phases agree on the set. When present, it is authoritative — short-circuit
  // before any detection/prompt so no phase re-resolves or re-prompts.
  if (ctx.targets !== undefined)
    return enforceOrgSupportedCliAllowList(
      ctx,
      {
        clis: ctx.targets,
        detectFellBack: false,
        bareDefault: false,
      },
      policy,
    );
  const opts = ctx.options;
  const explicit = typeof opts.cli === "string" && opts.cli.trim().length > 0;
  if (opts.detect === true && opts.allTools !== true && !explicit) {
    const installs = await detectInstall(ctx);
    const runnable = installs.filter((i) => i.binary).map((i) => i.cli);
    const configOnly = installs.filter((i) => i.config && !i.binary).map((i) => i.cli);
    if (ctx.prompter) {
      const confirmed = await confirmDetectedClis(ctx.prompter, runnable, configOnly);
      if (confirmed.length > 0)
        return enforceOrgSupportedCliAllowList(
          ctx,
          {
            clis: confirmed,
            detectFellBack: false,
            bareDefault: false,
          },
          policy,
        );
      return enforceOrgSupportedCliAllowList(
        ctx,
        {
          clis: ["claude"],
          detectFellBack: true,
          bareDefault: false,
        },
        policy,
      );
    }
    if (runnable.length > 0)
      return enforceOrgSupportedCliAllowList(
        ctx,
        {
          clis: runnable,
          detectFellBack: false,
          bareDefault: false,
        },
        policy,
      );
    return enforceOrgSupportedCliAllowList(
      ctx,
      {
        clis: ["claude"],
        detectFellBack: true,
        bareDefault: false,
      },
      policy,
    );
  }
  // No explicit selection (no --cli/--all-tools/--detect): honor the committed
  // `.aih-config.json` targets when present. The marker records what the repo was
  // bootstrapped FOR, so a re-run on a multi-tool adopted repo regenerates for the
  // SAME tools instead of narrowing to the `claude` default — which would drop the
  // codex/gemini canon. Mirrors how `doctor` treats the marker's contextDir as
  // authoritative. Fail-soft: a malformed marker / unknown tool just falls through.
  const unselected = !explicit && opts.allTools !== true && opts.detect !== true;
  if (unselected) {
    // A committed marker is authoritative (an adopted repo's targets) — so a re-run
    // regenerates for the SAME tools instead of narrowing.
    const cfg = readAihConfig(ctx.root);
    if (cfg && cfg.targets.length > 0) {
      const fromMarker = resolveClis({ cli: cfg.targets.join(",") });
      if (fromMarker.length > 0)
        return enforceOrgSupportedCliAllowList(
          ctx,
          {
            clis: fromMarker,
            detectFellBack: false,
            bareDefault: false,
          },
          policy,
        );
    }
  }
  // Fallback: explicit `--cli` (validated strictly so a typo fails closed) or a
  // deterministic first-run default of claude. Discovering runnable tools is an
  // explicit `--detect` operation. Reaching here with nothing selected IS the bare
  // default — flagged so callers can warn before it narrows past existing canon.
  return enforceOrgSupportedCliAllowList(
    ctx,
    {
      clis: resolveClis(opts, { strict: true }),
      detectFellBack: false,
      bareDefault: unselected,
    },
    policy,
  );
}

/**
 * The root bootloader files present in the repo that `clis` will NOT regenerate.
 *
 * Reported as FILES, not tool names: `AGENTS.md` is the bootloader for codex,
 * antigravity, opencode, zed AND kimi, so naming tools would invent an intent the
 * repo never expressed. Paths come from the same CLI registry that drives
 * generation, so this can't drift from what a run actually writes.
 */
export function unmanagedBootloaders(root: string, clis: readonly Cli[]): string[] {
  const managed = new Set(clis.flatMap((cli) => entry(cli).bootloaders));
  const present = SUPPORTED_CLIS.flatMap((cli) => entry(cli).bootloaders)
    .filter((rel) => !managed.has(rel) && existsSync(join(root, rel)))
    .sort();
  return [...new Set(present)];
}

/**
 * The notice emitted when a bare run's `claude` default leaves bootloaders the repo
 * already has unregenerated — and therefore outside the `--verify` drift gate, which
 * only probes the resolved targets. Silent narrowing is the one sharp edge of the
 * deterministic default, so it is stated rather than inferred.
 */
export function bareDefaultNarrowingNotice(paths: readonly string[]): string {
  return [
    "No --cli, --all-tools, --detect, or committed .aih-config.json targets were given,",
    "so this run targets only `claude`. These bootloaders already exist here and will NOT",
    "be regenerated or drift-checked by this run:",
    ...paths.map((p) => `  - ${p}`),
    "",
    "Re-run with `--cli <list>` (e.g. `--cli claude,codex`) or `--detect` to include them.",
    "Committing .aih-config.json via `aih init`/`aih bootstrap-ai` records the target set",
    "so later bare re-runs regenerate all of it automatically.",
  ].join("\n");
}

/** Back-compat thin wrapper for callers that only need the CLI list. */
export async function resolveTargetClis(ctx: PlanContext): Promise<Cli[]> {
  return (await resolveTargets(ctx)).clis;
}

/**
 * Whether a leaf phase should emit `cli`-specific files. Under `aih init` the
 * orchestrator pre-resolves the target set into {@link PlanContext.targets}, so a
 * phase emits a tool's files only when that tool is targeted — e.g. on a Kiro-only
 * `aih init --detect` neither `.cursor/*` (cursor) nor `.claude/*` (claude) is
 * written. Run standalone (no `ctx.targets`), the leaf keeps its single-tool
 * identity and always emits: `aih profile` is the Cursor profiler, `aih
 * secrets`/`aih sandbox` the Claude guards.
 */
export function isTargeted(ctx: PlanContext, cli: Cli): boolean {
  return ctx.targets === undefined || ctx.targets.includes(cli);
}

/** The notice emitted when `--detect` found no AI CLIs and defaulted to claude. */
export function detectFallbackNotice(): string {
  return [
    "No runnable AI CLIs were detected on this machine (no known binary on PATH),",
    "so the target defaulted to `claude`. To target specific tools, pass `--cli <list>`",
    "(e.g. `--cli kiro,codex`) or `--all-tools`; or install a CLI binary and re-run with `--detect`.",
    "Config directories alone are treated as config-only traces and are not targeted by `--detect`.",
    "Supported: claude, codex, cursor, antigravity, gemini, copilot, windsurf, opencode, zed, kimi, kiro.",
  ].join("\n");
}
