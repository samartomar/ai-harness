import type { CommandSpec } from "../internals/plan.js";

/**
 * The pluggable command registry — aih's ONE extension seam (OPA/Semgrep-style
 * open core). The public harness is complete and fully local on its own; on
 * startup the CLI probes for a single optional peer package,
 * {@link PLUGIN_PACKAGE}, and when it is installed and valid, the `aihCommands`
 * CommandSpecs it exports merge into the registry and appear as NATIVE
 * subcommands — flowing through the identical registration path as the
 * built-ins (shared flags, posture resolution, dirty-worktree gate, run
 * ledger), so the private package bolts on without forking the core. An
 * unenrolled machine sees zero output and zero behavior change.
 *
 * Rules the seam is built on:
 *  - LITERAL package name only. The probe always imports {@link PLUGIN_PACKAGE}
 *    verbatim — never an env var, flag, or config value — so nothing
 *    user-controlled can point the import at other code. (The `importer`
 *    parameter is purely a test seam; production feeds it the literal constant.)
 *  - Kill switch: `AIH_NO_PLUGINS=1` skips the probe without touching the
 *    importer at all.
 *  - Fail open to LOCAL. A missing package is the normal unenrolled case
 *    (silent — zero noise); anything else (the package present but failing to
 *    load, a malformed export, an invalid or colliding spec) degrades to
 *    local-only behavior with a one-line warning. A broken plugin must never
 *    break the CLI.
 *  - Built-ins always win: a plugin spec whose name collides with a built-in
 *    command or parent group is refused ("refusing to shadow").
 *
 * Trust boundary note: the boundary is package INSTALLATION — by the time this
 * module inspects the export, `import()` has already run the plugin's module
 * code, exactly like any other installed dependency. The structural gate below
 * is about REGISTRY INTEGRITY (only well-formed, non-colliding specs register),
 * not sandboxing: a gated spec may use any {@link CommandSpec} field, including
 * `readOnly`.
 */

/** The one probed plugin package. Literal by design — see the module jsdoc. */
export const PLUGIN_PACKAGE = "@aihq/enterprise";

export interface PluginLoadResult {
  commands: CommandSpec[];
  warnings: string[];
}

/** Import seam so tests can simulate any module shape without installing anything. */
export type PluginImporter = (specifier: string) => Promise<unknown>;

/** Same command-name grammar the built-ins follow. */
const SPEC_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Default importer: the platform's dynamic import. The specifier only ever
 * reaches it as {@link PLUGIN_PACKAGE} — the parameter is not a configuration
 * point (see {@link loadExternalCommands}).
 */
const defaultImporter: PluginImporter = (specifier) => import(specifier);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** First line of an error's message, for one-line warnings. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n", 1)[0] ?? message;
}

/**
 * The plugin being ABSENT is the normal unenrolled case and must stay silent.
 * Absent means: a module-not-found rejection that names the literal package.
 * The error code alone is not enough — a plugin that IS installed but has a
 * broken transitive dependency also rejects with `ERR_MODULE_NOT_FOUND`
 * (naming the transitive module, "imported from …/@aihq/enterprise/…"); that
 * is "installed but failed to load" and deserves the warning instead.
 */
function isPluginAbsent(err: unknown): boolean {
  if (!isRecord(err)) return false;
  const message = typeof err.message === "string" ? err.message : "";
  const namesPackage =
    message.includes(`'${PLUGIN_PACKAGE}'`) || message.includes(`"${PLUGIN_PACKAGE}"`);
  if (!namesPackage) return false;
  if (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND") return true;
  return /cannot find (package|module)|failed to resolve/i.test(message);
}

/**
 * REGISTRY-INTEGRITY gate — deliberately plain checks, not zod (`plan` is a
 * function, and the trust boundary already passed at install time; see the
 * module jsdoc). Returns the failed rule, or undefined when the spec is sound.
 */
function specGateFailure(raw: unknown): string | undefined {
  if (!isRecord(raw)) return "not a CommandSpec object";
  if (typeof raw.name !== "string" || !SPEC_NAME.test(raw.name)) {
    return "name must be a string matching /^[a-z][a-z0-9-]*$/";
  }
  if (typeof raw.summary !== "string" || raw.summary.trim().length === 0) {
    return "summary must be a non-empty string";
  }
  if (typeof raw.plan !== "function") return "plan must be a function";
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) return "options must be an array";
    for (const option of raw.options as readonly unknown[]) {
      if (
        !isRecord(option) ||
        typeof option.flags !== "string" ||
        typeof option.description !== "string"
      ) {
        return "every option must be an object with string `flags` + string `description`";
      }
    }
  }
  return undefined;
}

/** Label a spec for warnings: its name when it has one, else its array position. */
function specLabel(raw: unknown, index: number): string {
  if (isRecord(raw) && typeof raw.name === "string" && raw.name.length > 0) {
    return `command "${raw.name}"`;
  }
  return `aihCommands[${index}]`;
}

/** Gate the loaded module's export down to registrable, non-colliding specs. */
function gateModule(mod: unknown, builtinNames: ReadonlySet<string>): PluginLoadResult {
  const exported = isRecord(mod) ? mod.aihCommands : undefined;
  if (!Array.isArray(exported)) {
    return {
      commands: [],
      warnings: [
        `${PLUGIN_PACKAGE} must export \`aihCommands\` as a CommandSpec array — ` +
          `${exported === undefined ? "the export is missing" : `got ${typeof exported}`}; running local-only`,
      ],
    };
  }
  const specs: readonly unknown[] = exported;
  const commands: CommandSpec[] = [];
  const warnings: string[] = [];
  const taken = new Set<string>();
  for (const [index, raw] of specs.entries()) {
    const failure = specGateFailure(raw);
    if (failure !== undefined) {
      warnings.push(`skipping ${specLabel(raw, index)}: ${failure}`);
      continue;
    }
    // The gate above proved name/summary/plan/options; every other CommandSpec
    // field rides through as-is (interfaces have no implicit index signature,
    // hence the two-step cast).
    const spec = raw as unknown as CommandSpec;
    if (builtinNames.has(spec.name)) {
      warnings.push(
        `refusing to shadow built-in \`${spec.name}\` with a plugin command — built-ins always win`,
      );
      continue;
    }
    if (taken.has(spec.name)) {
      warnings.push(
        `refusing to shadow earlier plugin command \`${spec.name}\` — first registration wins`,
      );
      continue;
    }
    taken.add(spec.name);
    commands.push(spec);
  }
  return { commands, warnings };
}

/**
 * Probe for {@link PLUGIN_PACKAGE} and return its registrable CommandSpecs.
 * Never throws: every failure mode degrades to `{ commands: [] }` plus at most
 * one-line warnings, so the CLI stays fully local no matter how broken the
 * plugin is. `AIH_NO_PLUGINS=1` skips the probe entirely.
 */
export async function loadExternalCommands(
  builtinNames: ReadonlySet<string>,
  importer: PluginImporter = defaultImporter,
): Promise<PluginLoadResult> {
  if (process.env.AIH_NO_PLUGINS === "1") return { commands: [], warnings: [] };
  try {
    // Always the literal constant — the specifier is not a configuration point.
    const mod = await importer(PLUGIN_PACKAGE);
    return gateModule(mod, builtinNames);
  } catch (err) {
    if (isPluginAbsent(err)) return { commands: [], warnings: [] };
    return {
      commands: [],
      warnings: [
        `${PLUGIN_PACKAGE} is installed but failed to load (${firstLine(err)}); running local-only`,
      ],
    };
  }
}
