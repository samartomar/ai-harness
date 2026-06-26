import type { Command } from "commander";
import { loadSettings } from "../config/settings.js";
import { AihError } from "../errors.js";
import { executePlan, summarizeResult, writeArtifact } from "../internals/execute.js";
import type { CommandSpec, PlanContext } from "../internals/plan.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import { isInteractive, makeReadlinePrompter, type Prompter } from "../internals/prompt.js";
import { reportToSarif } from "../internals/sarif.js";
import { makeHostAdapter } from "../platform/detect.js";

export interface RunDeps {
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
  /** Inject a prompter (tests); production wires a readline prompter when interactive. */
  prompter?: Prompter;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A positive integer from CLI input, else undefined (used for `--refresh <sec>`). */
function positiveInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Convert a commander option flag spec into its camelCase opts key. */
export function flagKey(flags: string): string {
  const long = flags.split(/[,\s]+/).find((tok) => tok.startsWith("--"));
  const name = (long ?? flags)
    .replace(/^--/, "")
    .replace(/[<[].*$/, "")
    .trim();
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
  const positionalRoot = Array.isArray(command.processedArgs)
    ? (command.processedArgs[0] as string | undefined)
    : undefined;

  let json = false;
  try {
    const settings = loadSettings(env, {
      apply: opts.apply as boolean | undefined,
      verify: opts.verify as boolean | undefined,
      json: opts.json as boolean | undefined,
      contextDir: opts.contextDir as string | undefined,
      root: positionalRoot ?? (opts.root as string | undefined),
      caPattern: opts.caPattern as string | undefined,
    });
    json = settings.json;
    const host = makeHostAdapter({ run, env });
    // Wire an interactive prompter only when the user opted into `--detect`, isn't
    // in `--json`/`--yes` mode, and the session is a real TTY. Otherwise the
    // harness stays non-interactive (automation, CI, piped output) exactly as before.
    const wantConfirm = opts.detect === true && opts.yes !== true && !settings.json;
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
        caPattern: settings.caPattern,
        cli: opts.cli,
        allTools: opts.allTools,
        detect: opts.detect,
        open: liveOpen ? true : opts.open,
      },
    };

    const built = await spec.plan(ctx);
    const result = await executePlan(built, ctx);

    // `--sarif -` streams the SARIF document to stdout (post-step below). When it
    // will, suppress the normal human/JSON output so stdout is a clean SARIF artifact
    // a code-scanning consumer can ingest directly (`… --sarif - > out.sarif`).
    const streamSarif = opts.sarif === "-" && result.report !== undefined;
    if (!streamSarif) {
      if (json) {
        write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        write(`${summarizeResult(result)}\n`);
      }
    }

    if (watchSec !== undefined && !spec.readOnly) {
      ctx.options.open = false; // opened once above — don't relaunch the browser each tick
      write(
        `\n↻ live — regenerating every ${watchSec}s; the open dashboard auto-refreshes. Ctrl+C to stop.\n`,
      );
      for (;;) {
        await delay(watchSec * 1000);
        try {
          await executePlan(await spec.plan(ctx), ctx);
        } catch (e) {
          write(`refresh error: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
    }
    // A failed non-allowFailure exec must surface as a non-zero exit, so CI and
    // scripts never read a failed install/open/bootstrap step as success (writes are
    // committed before execs run, so a silent success would hide partial state).
    const execFailed = result.execs.some((e) => e.ran && e.ok === false);
    const verifyCode = result.report ? result.report.exitCode() : 0;

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

    return verifyCode || (execFailed ? 1 : 0);
  } catch (err) {
    const code = err instanceof AihError ? err.code : "AIH_ERROR";
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      write(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
    } else {
      write(`error [${code}]: ${message}\n`);
    }
    return 1;
  }
}
