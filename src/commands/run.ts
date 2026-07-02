import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { Command } from "commander";
import { readAihConfig } from "../config/marker.js";
import { resolvePosture } from "../config/posture.js";
import { loadSettings } from "../config/settings.js";
import { AihError } from "../errors.js";
import { optionSource } from "../internals/commander-options.js";
import { executePlan, summarizeResult, writeArtifact } from "../internals/execute.js";
import { readIfExists } from "../internals/fsxn.js";
import type { CommandSpec, PlanContext } from "../internals/plan.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import { isInteractive, makeReadlinePrompter, type Prompter } from "../internals/prompt.js";
import { reportToSarif } from "../internals/sarif.js";
import {
  appendRunLog,
  buildRunEntry,
  isLoggingEnabled,
  type RunEntryInput,
  statusFor,
} from "../logging/run-log.js";
import { makeHostAdapter } from "../platform/detect.js";
import { buildSupport, supportSummary } from "../support/integrate.js";
import { redactArgv, redactText } from "../support/redact.js";

export interface RunDeps {
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
  /** Inject a prompter (tests); production wires a readline prompter when interactive. */
  prompter?: Prompter;
  /** Clock seam — injected in tests so support timestamps + ledger rows are deterministic. */
  now?: () => Date;
  /** Run-id seam — injected in tests so support references + ledger rows are deterministic. */
  newRunId?: () => string;
  /** Raw invoking argv (defaults to process.argv.slice(2)); redacted before logging. */
  argv?: string[];
  /** Override extracted capability options (used by nested commands with custom positionals). */
  optionOverrides?: Record<string, unknown>;
  /** Override the positional root; false disables positional root handling. */
  positionalRoot?: string | false;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Setup files consulted for project support context, in precedence order. */
const SETUP_FILES = ["SETUP.md", "docs/SETUP.md", ".aih/SETUP.md"];

/** First existing setup file's contents, or undefined (project context is optional). */
function readSetupText(root: string): string | undefined {
  for (const rel of SETUP_FILES) {
    const text = readIfExists(join(root, rel));
    if (text !== undefined) return text;
  }
  return undefined;
}

/** A positive integer from CLI input, else undefined (used for `--refresh <sec>`). */
function positiveInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Convert a commander option flag spec into its camelCase opts key. */
export function flagKey(flags: string): string {
  const long = flags.split(/[,\s]+/).find((tok) => tok.startsWith("--"));
  const stripped = (long ?? flags).replace(/^--/, "");
  // Cut at the value placeholder ("<dir>" / "[value]") by index scan, not a
  // backtracking regex: plugin option flags reach this function, so it must
  // stay linear on hostile input (polynomial ReDoS).
  const angle = stripped.indexOf("<");
  const bracket = stripped.indexOf("[");
  const cut = Math.min(
    angle === -1 ? stripped.length : angle,
    bracket === -1 ? stripped.length : bracket,
  );
  const name = stripped.slice(0, cut).trim();
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function extractOptions(spec: CommandSpec, opts: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const o of spec.options ?? []) {
    const key = flagKey(o.flags);
    if (opts[key] !== undefined) picked[key] = opts[key];
  }
  return picked;
}

/**
 * Shared execution path for every capability command: resolve settings + host,
 * build the {@link PlanContext}, run the capability's `plan`, execute it (honoring
 * dry-run/apply/verify), and print text or `--json`. Returns the process exit code.
 */
export async function runCapability(
  spec: CommandSpec,
  command: Command,
  deps: RunDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const write = deps.write ?? ((t: string) => process.stdout.write(t));
  const run = deps.run ?? defaultRunner;
  const opts = command.optsWithGlobals() as Record<string, unknown>;
  // Optional positional target dir (e.g. `aih init .`) overrides --root.
  const defaultPositionalRoot = Array.isArray(command.processedArgs)
    ? (command.processedArgs[0] as string | undefined)
    : undefined;
  const positionalRoot =
    deps.positionalRoot === false ? undefined : (deps.positionalRoot ?? defaultPositionalRoot);

  // Run-ledger seams, hoisted before the try so BOTH the success path and the
  // catch can append exactly one row per invocation. Clock/id are injectable for
  // deterministic tests; argv is redacted once here.
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const runId = (deps.newRunId ?? (() => `run_${randomUUID().slice(0, 8)}`))();
  // Key-aware masking (--token …) THEN secret/home scrub per token, so a ledger row
  // is safe to attach to a ticket: no secrets, no home-path layout.
  const logArgv = redactArgv(deps.argv ?? process.argv.slice(2)).map((t) => redactText(t, env));
  const logRoot =
    positionalRoot ?? (opts.root as string | undefined) ?? env.AIH_ROOT ?? process.cwd();
  // `--no-log` is a commander NEGATABLE flag → it sets `opts.log = false`.
  const noLog = opts.log === false;
  const logRun = (entry: RunEntryInput): void => {
    if (isLoggingEnabled(logRoot, env, { noLog }))
      appendRunLog(logRoot, buildRunEntry(entry), startedAt);
  };

  let json = false;
  try {
    // Resolve the target root up front so the committed marker is read from the
    // SAME root loadSettings will use.
    const resolvedRoot =
      positionalRoot ?? (opts.root as string | undefined) ?? env.AIH_ROOT ?? process.cwd();
    // Context-dir precedence ladder: explicit `--context-dir` flag > committed
    // `.aih-config.json` marker > `AIH_CONTEXT_DIR` env > `ai-coding` default.
    // Commander fills the flag's default, so `opts.contextDir` is never undefined —
    // the value SOURCE is what distinguishes a real flag from the default. When no
    // flag was passed, prefer the marker so re-runs/doctor act on the dir this repo
    // was actually bootstrapped with; passing `undefined` lets loadSettings fall
    // through to env then default.
    const marker = readAihConfig(resolvedRoot);
    const contextDirSource = optionSource(command, "contextDir");
    const contextDirFromFlag = contextDirSource === "cli" ? (opts.contextDir as string) : undefined;
    const contextDirFromMarker = contextDirFromFlag === undefined ? marker?.contextDir : undefined;
    const postureFlagSource = optionSource(command, "posture") === "cli" ? "cli" : undefined;
    const resolvedPosture = resolvePosture({
      root: resolvedRoot,
      env,
      flag: opts.posture,
      flagSource: postureFlagSource,
      marker,
    });
    const settings = loadSettings(env, {
      apply: opts.apply as boolean | undefined,
      verify: opts.verify as boolean | undefined,
      json: opts.json as boolean | undefined,
      contextDir: contextDirFromFlag ?? contextDirFromMarker,
      root: resolvedRoot,
      caPattern: opts.caPattern as string | undefined,
    });
    json = settings.json;
    const host = makeHostAdapter({ run, env });
    // Wire an interactive prompter when the user opted into `--detect`, OR the command
    // asks for a confirmation prompt on a bare run (`spec.wantsInstallPrompt`, e.g.
    // `aih ready` offering to install the missing core tools) — as long as it isn't
    // `--json`/`--yes` and the session is a real TTY. Otherwise the harness stays
    // non-interactive (automation, CI, piped output) exactly as before.
    const wantConfirm =
      (opts.detect === true || spec.wantsInstallPrompt === true) &&
      opts.yes !== true &&
      !settings.json;
    const prompter =
      deps.prompter ?? (wantConfirm && isInteractive(env) ? makeReadlinePrompter() : undefined);
    // `--refresh <sec>` (report) keeps the dashboard live: open once, then regenerate
    // the artifact every <sec> seconds (the page's meta-refresh reloads it). It
    // implies --open + --apply; the loop runs until Ctrl+C.
    const watchSec = positiveInt(opts.refresh);
    // `--open`, `--refresh`, and `--demo` all imply build-and-open (so --apply too).
    const liveOpen = opts.open === true || opts.demo === true || watchSec !== undefined;
    const ctx: PlanContext = {
      root: settings.root,
      contextDir: settings.contextDir,
      posture: resolvedPosture.posture,
      postureSource: resolvedPosture.postureSource,
      // `--open`/`--refresh` (report) imply --apply so one command builds AND opens.
      apply: spec.readOnly ? false : settings.apply || liveOpen,
      // readOnly (doctor/status) always verifies; a capability can also opt into
      // always-verify (heal) so it diagnoses by default while still applying fixes.
      // `--sarif` implies --verify: asking for the report means you want the probes
      // run (read-only — it never forces --apply), so the artifact is self-sufficient.
      verify:
        spec.readOnly || spec.alwaysVerify || typeof opts.sarif === "string"
          ? true
          : settings.verify,
      json: settings.json,
      run,
      host,
      env,
      prompter,
      options: {
        ...extractOptions(spec, opts),
        ...(deps.optionOverrides ?? {}),
        caPattern: settings.caPattern,
        cli: opts.cli,
        allTools: opts.allTools,
        detect: opts.detect,
        force: opts.force,
        open: liveOpen ? true : opts.open,
      },
    };

    const built = await spec.plan(ctx);
    const result = await executePlan(built, ctx, {
      skipWorktreeGate: spec.skipWorktreeGate === true,
    });

    // A failed non-allowFailure exec must surface as a non-zero exit (writes commit
    // before execs run, so a silent success would hide partial state); a failed probe
    // flips the verify exit code. The ledger status maps from these two signals.
    const execFailed = result.execs.some((e) => e.ran && e.ok === false);
    const verifyCode = result.report ? result.report.exitCode() : 0;
    const exitCode = verifyCode || (execFailed ? 1 : 0);

    // Support templates: cross-cutting, derived from the verification report so any
    // verifying command (doctor / heal / `bootstrap-ai --verify` / …) turns a coded
    // failure into a ticket-ready, tool-neutral escalation. Built once here; emitted
    // in the human/JSON branches below (and suppressed when streaming SARIF).
    const support =
      result.report && result.report.checks.length > 0
        ? buildSupport({
            capability: result.capability,
            checks: result.report.checks,
            projectName: basename(settings.root) || "this project",
            root: settings.root,
            command: redactArgv([
              "aih",
              spec.name,
              ...(ctx.verify ? ["--verify"] : []),
              ...(ctx.apply ? ["--apply"] : []),
            ]).join(" "),
            contextDir: settings.contextDir,
            targets: (readAihConfig(settings.root)?.targets ?? []).join(", ") || "none",
            platform: host.platform,
            runId,
            timestamp: startedAt.toISOString(),
            setupText: readSetupText(settings.root),
            env,
          })
        : undefined;

    // `--support-out <dir>` writes each full ticket to a repo-contained file — the
    // operator named the path, so this is consent, exactly like `--sarif <file>`.
    let savedSupport: Record<string, string> | undefined;
    const supportOut = opts.supportOut as string | undefined;
    if (support && typeof supportOut === "string" && supportOut.length > 0) {
      savedSupport = {};
      for (const t of support.templates) {
        const rel = `${supportOut}/${t.code.replace(/[^a-z0-9.-]/gi, "_")}.md`;
        writeArtifact(ctx, rel, `${t.subject}\n\n${t.body}`);
        savedSupport[t.code] = rel;
      }
    }

    // `--sarif -` streams the SARIF document to stdout (post-step below). When it
    // will, suppress the normal human/JSON output so stdout is a clean SARIF artifact
    // a code-scanning consumer can ingest directly (`… --sarif - > out.sarif`).
    const streamSarif = opts.sarif === "-" && result.report !== undefined;
    if (!streamSarif) {
      if (json) {
        const payload = support
          ? { ...result, support: { findings: support.findings, templates: support.templates } }
          : result;
        write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        write(`${summarizeResult(result)}\n`);
        if (support) write(supportSummary(support, savedSupport));
      }
    }

    // Append one row to the run ledger — once, BEFORE the watch loop (which never
    // returns), so `--refresh` logs a single initial row rather than one per tick.
    logRun({
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      capability: spec.name,
      argv: logArgv,
      status: statusFor(verifyCode === 1, execFailed),
      exitCode,
      mode: { apply: ctx.apply, verify: ctx.verify, json, sarif: typeof opts.sarif === "string" },
      platform: host.platform,
      node: process.versions.node,
      result,
      support: support
        ? { findings: support.findings.length, templates: support.templates.length }
        : undefined,
    });

    if (watchSec !== undefined && !spec.readOnly) {
      ctx.options.open = false; // opened once above — don't relaunch the browser each tick
      write(
        `\n↻ live — regenerating every ${watchSec}s; the open dashboard auto-refreshes. Ctrl+C to stop.\n`,
      );
      for (;;) {
        await delay(watchSec * 1000);
        try {
          await executePlan(await spec.plan(ctx), ctx, {
            skipWorktreeGate: spec.skipWorktreeGate === true,
          });
        } catch (e) {
          write(`refresh error: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
    }

    // `--sarif <file>` emits the verification report as SARIF 2.1.0 for GitHub
    // code-scanning. It is written regardless of --apply: the SARIF is an analysis
    // OUTPUT the operator requested by naming the path (like `report --out`), not a
    // mutation of the managed project — and the gating use case (a CI drift gate)
    // runs `--verify` WITHOUT `--apply`. `-` streams to stdout for a no-file CI path.
    // See `writeArtifact` for the full apply-semantics rationale.
    const sarifOut = opts.sarif;
    if (typeof sarifOut === "string" && sarifOut.length > 0 && result.report) {
      const sarif = reportToSarif(result.report);
      if (sarifOut === "-") {
        write(`${sarif}\n`);
      } else {
        const backups = writeArtifact(ctx, sarifOut, sarif);
        if (!json) {
          write(
            `  [sarif] ${sarifOut}${backups.length > 0 ? " (prior saved as *.aih.bak)" : ""}\n`,
          );
        }
      }
    }

    return exitCode;
  } catch (err) {
    const code = err instanceof AihError ? err.code : "AIH_ERROR";
    const message = err instanceof Error ? err.message : String(err);
    // Log the crash as an `error` row (no result — settings/ctx may not exist yet).
    logRun({
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      capability: spec.name,
      argv: logArgv,
      status: "error",
      exitCode: 1,
      mode: {
        apply: opts.apply === true,
        verify: opts.verify === true,
        json,
        sarif: typeof opts.sarif === "string",
      },
      platform: process.platform,
      node: process.versions.node,
    });
    if (json) {
      write(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
    } else {
      write(`error [${code}]: ${message}\n`);
    }
    return 1;
  }
}
