import type { Command } from "commander";
import { loadSettings } from "../config/settings.js";
import { AihError } from "../errors.js";
import { executePlan, summarizeResult } from "../internals/execute.js";
import type { CommandSpec, PlanContext } from "../internals/plan.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import { makeHostAdapter } from "../platform/detect.js";

export interface RunDeps {
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
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
    const ctx: PlanContext = {
      root: settings.root,
      contextDir: settings.contextDir,
      apply: spec.readOnly ? false : settings.apply,
      verify: spec.readOnly ? true : settings.verify,
      json: settings.json,
      run,
      host,
      env,
      options: {
        ...extractOptions(spec, opts),
        caPattern: settings.caPattern,
        cli: opts.cli,
        allTools: opts.allTools,
        detect: opts.detect,
      },
    };

    const built = await spec.plan(ctx);
    const result = await executePlan(built, ctx);

    if (json) {
      write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      write(`${summarizeResult(result)}\n`);
    }
    return result.report ? result.report.exitCode() : 0;
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
