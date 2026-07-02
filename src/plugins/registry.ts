import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
 *    user-controlled can point the import at other code. (The `importer` and
 *    `resolver` options are purely test seams; production uses the platform
 *    dynamic import and `import.meta.resolve`.)
 *  - SAME INSTALL TREE only. Before importing, the probe resolves where the
 *    import WOULD load from and refuses anything outside the harness's own
 *    install tree, so a global or `npx`-run aih pointed at a hostile repo can
 *    never import that repo's planted `node_modules/@aihq/enterprise`. Honesty
 *    note (also in the README): when aih itself is installed INSIDE the target
 *    repo, the repo already controls the binary — the check draws the boundary
 *    at "the tree aih runs from", nothing stronger.
 *  - STARTUP BUDGET. The import races a timeout (default
 *    {@link DEFAULT_IMPORT_TIMEOUT_MS} ms); a slow or wedged plugin degrades to
 *    local-only with a warning instead of stalling every invocation. (`aih
 *    --version` skips the probe entirely — see src/cli.ts.)
 *  - Kill switch: `AIH_NO_PLUGINS=1` (read from the injectable `env`) skips the
 *    probe without touching the importer at all.
 *  - Fail open to LOCAL. A missing package is the normal unenrolled case
 *    (silent — zero noise); anything else (the package present but failing to
 *    resolve or load, a malformed export, an invalid or colliding spec)
 *    degrades to local-only behavior with a one-line warning. A broken plugin
 *    must never break the CLI.
 *  - Built-ins always win: a plugin spec whose name collides with a built-in
 *    command, a parent group, or commander's own `help`/`version` is refused
 *    ("refusing to shadow").
 *  - Shared + reserved flags are off-limits: a plugin option may not claim any
 *    token from {@link SHARED_FLAG_TOKENS} (the addSharedFlags surface) or
 *    commander's reserved `--help`/`-h`/`--version`/`-V`.
 *  - `skipWorktreeGate` is never honored for plugin commands — the field is
 *    stripped from the registered copy (see {@link stripWorktreeGateField}).
 *  - Warnings render hostile input: every plugin-influenced string that lands
 *    in a warning routes through {@link sanitizeLabel} first.
 *
 * Trust boundary note: the boundary is package INSTALLATION — by the time this
 * module inspects the export, `import()` has already run the plugin's module
 * code, exactly like any other installed dependency. The structural gate below
 * is about REGISTRY INTEGRITY (only well-formed, non-colliding specs register),
 * not sandboxing: a gated spec may use any {@link CommandSpec} field, including
 * `readOnly` (`skipWorktreeGate` being the one carve-out).
 */

/** The one probed plugin package. Literal by design — see the module jsdoc. */
export const PLUGIN_PACKAGE = "@aihq/enterprise";

/** Startup budget for the plugin import — see the module jsdoc. */
const DEFAULT_IMPORT_TIMEOUT_MS = 2000;

/** Sentinel resolved by the timeout arm of the import race. */
const TIMED_OUT = Symbol("aih-plugin-import-timed-out");

export interface PluginLoadResult {
  commands: CommandSpec[];
  warnings: string[];
}

/** Import seam so tests can simulate any module shape without installing anything. */
export type PluginImporter = (specifier: string) => Promise<unknown>;

/**
 * Resolver seam for the install-tree boundary: maps the package specifier to
 * the FILE PATH the import would load from. Production uses
 * `import.meta.resolve`; tests inject paths inside/outside the allowed roots.
 */
export type PluginResolver = (specifier: string) => string;

export interface PluginLoadOptions {
  /** Test seam replacing the platform dynamic import. */
  importer?: PluginImporter;
  /** Test seam replacing `import.meta.resolve` for the install-tree check. */
  resolver?: PluginResolver;
  /** Environment for the kill switch — matches runCapability's deps.env convention. */
  env?: NodeJS.ProcessEnv;
  /** Import budget in milliseconds (default {@link DEFAULT_IMPORT_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/** Same command-name grammar the built-ins follow. */
const SPEC_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Long flag tokens `addSharedFlags` (src/commands/index.ts) puts on every
 * capability subcommand. Mirrored as a constant because the registry must stay
 * a leaf module — importing the command tree from here would create an import
 * cycle (commands/index.ts imports {@link sanitizeLabel} back from this file).
 * The mirror is pinned against the real addSharedFlags registration by
 * tests/plugins/registry.test.ts, so any drift fails CI.
 */
export const SHARED_FLAG_TOKENS: ReadonlySet<string> = new Set([
  "--apply",
  "--force",
  "--verify",
  "--json",
  "--posture",
  "--support-out",
  "--no-log",
  "--context-dir",
  "--root",
  "--cli",
  "--all-tools",
  "--detect",
  "--yes",
]);

/** Commander's own global surface — never claimable by a plugin option. */
const RESERVED_FLAG_TOKENS: ReadonlySet<string> = new Set(["--help", "-h", "--version", "-V"]);

/**
 * Default importer: the platform's dynamic import. The specifier only ever
 * reaches it as {@link PLUGIN_PACKAGE} — the parameter is not a configuration
 * point (see {@link loadExternalCommands}).
 */
const defaultImporter: PluginImporter = (specifier) => import(specifier);

/**
 * Default resolver: `import.meta.resolve`, synchronous and unflagged since
 * Node 20.6. package.json `engines.node` is ">=20", so {@link resolveBoundary}
 * typeof-guards it: on 20.0–20.5 the check degrades to a "cannot verify"
 * warning instead of crashing. Deliberately NOT falling back to
 * `createRequire().resolve` — CJS resolution rejects packages that expose
 * ESM-only `exports` maps, which the plugin is.
 */
const defaultResolver: PluginResolver = (specifier) =>
  fileURLToPath(import.meta.resolve(specifier));

/**
 * C0 controls (U+0000–U+001F, incl. ESC), DEL (U+007F) and C1 controls
 * (U+0080–U+009F). Written as escape sequences so the source file itself
 * never contains a raw control byte.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping C0/C1 controls is this sanitizer's whole job
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** First line of an error's message, for one-line warnings. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n", 1)[0] ?? message;
}

/**
 * Make a plugin-influenced string safe to echo in a one-line warning: collapse
 * newlines to spaces, strip C0/C1 control characters (including ESC, so
 * ANSI/OSC sequences lose their teeth) plus DEL, and truncate to `max` with an
 * ellipsis. Exported so the plugin-registration containment in
 * src/commands/index.ts routes through the SAME sanitizer — one
 * implementation, no drift.
 */
export function sanitizeLabel(value: string, max = 60): string {
  const collapsed = value.replace(/[\r\n]+/g, " ");
  const stripped = collapsed.replace(CONTROL_CHARS, "");
  if (stripped.length <= max) return stripped;
  return `${stripped.slice(0, max - 1)}…`;
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

// ---- install-tree boundary --------------------------------------------------

/**
 * Every root the plugin is allowed to resolve under: each `node_modules`
 * directory on the ancestor chain of THIS module's own file (after bundling,
 * that file IS the CLI binary in `dist/`), plus `<package root>/node_modules`
 * where the package root is the first ancestor directory carrying a
 * package.json — that second clause covers running from the dev tree, where no
 * ancestor is itself a node_modules. Everything is realpath'd; candidates that
 * do not exist are dropped (a missing directory cannot contain the plugin).
 * Exported as a test seam so tests can build paths inside a real root.
 */
export function allowedPluginRoots(): string[] {
  const selfFile = realpathSync(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  let packageRoot: string | undefined;
  for (let dir = dirname(selfFile); ; dir = dirname(dir)) {
    if (basename(dir) === "node_modules") candidates.push(dir);
    if (packageRoot === undefined && existsSync(join(dir, "package.json"))) packageRoot = dir;
    if (dirname(dir) === dir) break; // filesystem root: dirname() is a fixpoint
  }
  if (packageRoot !== undefined) candidates.push(join(packageRoot, "node_modules"));
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (!roots.includes(real)) roots.push(real);
    } catch {
      // Candidate does not exist (e.g. a global install carries no nested
      // node_modules of its own) — it cannot contain the plugin; drop it.
    }
  }
  return roots;
}

type BoundaryOutcome =
  | { kind: "proceed"; warning?: string }
  | { kind: "absent" }
  | { kind: "refuse"; warning: string };

/**
 * Resolve the plugin and require its realpath to sit under one of
 * {@link allowedPluginRoots}. ANY error anywhere in this check fails CLOSED to
 * local-only with a one-line warning — except a module-not-found naming the
 * literal package, which is the silent unenrolled case.
 */
function checkInstallTree(resolve: PluginResolver): BoundaryOutcome {
  let resolved: string;
  try {
    resolved = resolve(PLUGIN_PACKAGE);
  } catch (err) {
    if (isPluginAbsent(err)) return { kind: "absent" };
    return {
      kind: "refuse",
      warning: `${PLUGIN_PACKAGE} failed to resolve (${sanitizeLabel(firstLine(err), 200)}); running local-only`,
    };
  }
  try {
    const pluginReal = realpathSync(resolved);
    const roots = allowedPluginRoots();
    if (roots.some((root) => pluginReal.startsWith(root + sep))) return { kind: "proceed" };
    return {
      kind: "refuse",
      warning:
        `refusing to load ${PLUGIN_PACKAGE} from outside aih's own install tree ` +
        `(resolved to ${sanitizeLabel(pluginReal, 200)}); running local-only`,
    };
  } catch (err) {
    return {
      kind: "refuse",
      warning: `${PLUGIN_PACKAGE} install-tree check failed (${sanitizeLabel(firstLine(err), 200)}); running local-only`,
    };
  }
}

/**
 * Which boundary check applies for this call. The check pairs with the import
 * it guards: it runs whenever the REAL importer will run (production), or when
 * a resolver is explicitly injected (tests). An injected importer WITHOUT a
 * resolver imports nothing from disk, so there is no on-disk tree to validate
 * — the check is moot and skipped. When `import.meta.resolve` itself is
 * unavailable (Node 20.0–20.5; engines allows >=20), the check is skipped with
 * a warning that {@link loadExternalCommands} only emits if the plugin
 * actually loads — an unenrolled machine stays silent.
 */
function resolveBoundary(opts: PluginLoadOptions): BoundaryOutcome {
  if (opts.resolver !== undefined) return checkInstallTree(opts.resolver);
  if (opts.importer !== undefined) return { kind: "proceed" };
  if (typeof import.meta.resolve === "function") return checkInstallTree(defaultResolver);
  return {
    kind: "proceed",
    warning:
      `cannot verify ${PLUGIN_PACKAGE} resolves from aih's own install tree ` +
      "(import.meta.resolve unavailable on this Node); loading it anyway",
  };
}

// ---- startup budget ----------------------------------------------------------

/**
 * Race the plugin import against the startup budget so a slow or wedged module
 * body cannot stall every `aih` invocation. Pathological caveat (accepted): a
 * never-settling top-level await inside the plugin can still hold the event
 * loop open at process exit — the timeout restores COMMAND availability, not
 * process-exit hygiene.
 */
async function importWithTimeout(importer: PluginImporter, timeoutMs: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const expiry = new Promise<typeof TIMED_OUT>((resolveExpiry) => {
      timer = setTimeout(() => resolveExpiry(TIMED_OUT), timeoutMs);
    });
    // Always the literal constant — the specifier is not a configuration point.
    const pending = Promise.resolve(importer(PLUGIN_PACKAGE));
    // A rejection arriving AFTER the race already timed out must not become an
    // unhandled rejection; the timeout arm has already produced the outcome.
    pending.catch(() => {});
    return await Promise.race([pending, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---- structural gate ---------------------------------------------------------

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
      if (
        option.default !== undefined &&
        typeof option.default !== "string" &&
        typeof option.default !== "boolean"
      ) {
        return `option \`${sanitizeLabel(option.flags)}\` default must be a string or boolean`;
      }
      // Reject flags colliding with the shared capability surface or with
      // commander's reserved globals. Tokens are parsed the way a human reads
      // the flags string: split on spaces, commas, pipes. A matched token is
      // by definition equal to one of our own trusted constants, so echoing it
      // back verbatim is safe.
      for (const token of option.flags.split(/[ ,|]+/)) {
        if (RESERVED_FLAG_TOKENS.has(token)) return `option flag \`${token}\` is reserved`;
        if (SHARED_FLAG_TOKENS.has(token)) {
          return `option flag \`${token}\` collides with a shared aih flag`;
        }
      }
    }
  }
  return undefined;
}

/** Label a spec for warnings: its (sanitized) name when it has one, else its array position. */
function specLabel(raw: unknown, index: number): string {
  if (isRecord(raw) && typeof raw.name === "string" && raw.name.length > 0) {
    return `command "${sanitizeLabel(raw.name)}"`;
  }
  return `aihCommands[${index}]`;
}

/**
 * Install-is-trust: behavior fields (`readOnly`, `alwaysVerify`,
 * `wantsInstallPrompt`) ride through untouched — by the time a spec is here
 * the plugin's module code has already run, so those fields grant nothing an
 * installed package couldn't already do. `skipWorktreeGate` is the one
 * exception: the dirty-worktree preflight is the OPERATOR's last data-loss
 * guard before `--apply` mutates a repo, and that guard is never delegable to
 * plugin code. The field is stripped from a shallow CLONE — the plugin's own
 * object is never mutated — with a warning naming the command.
 */
function stripWorktreeGateField(spec: CommandSpec, warnings: string[]): CommandSpec {
  if (!("skipWorktreeGate" in spec)) return spec;
  warnings.push(
    `plugin command "${sanitizeLabel(spec.name)}": skipWorktreeGate is not honored for plugin commands (dirty-worktree preflight applies)`,
  );
  const { skipWorktreeGate, ...cleaned } = spec;
  return cleaned;
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
    commands.push(stripWorktreeGateField(spec, warnings));
  }
  return { commands, warnings };
}

/**
 * Probe for {@link PLUGIN_PACKAGE} and return its registrable CommandSpecs.
 * Never throws: every failure mode degrades to `{ commands: [] }` plus at most
 * one-line warnings, so the CLI stays fully local no matter how broken the
 * plugin is. `AIH_NO_PLUGINS=1` (from `opts.env ?? process.env`) skips the
 * probe entirely. See {@link PluginLoadOptions} for the test seams.
 */
export async function loadExternalCommands(
  builtinNames: ReadonlySet<string>,
  opts: PluginLoadOptions = {},
): Promise<PluginLoadResult> {
  const env = opts.env ?? process.env;
  if (env.AIH_NO_PLUGINS === "1") return { commands: [], warnings: [] };

  const boundary = resolveBoundary(opts);
  if (boundary.kind === "absent") return { commands: [], warnings: [] };
  if (boundary.kind === "refuse") return { commands: [], warnings: [boundary.warning] };

  const importer = opts.importer ?? defaultImporter;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS;
  try {
    const mod = await importWithTimeout(importer, timeoutMs);
    if (mod === TIMED_OUT) {
      return {
        commands: [],
        warnings: [
          `plugin ${PLUGIN_PACKAGE} load timed out after ${timeoutMs}ms — continuing without it`,
        ],
      };
    }
    const result = gateModule(mod, builtinNames);
    // The "check skipped" note only matters when something actually loaded.
    if (boundary.warning !== undefined) result.warnings.unshift(boundary.warning);
    return result;
  } catch (err) {
    if (isPluginAbsent(err)) return { commands: [], warnings: [] };
    return {
      commands: [],
      warnings: [
        `${PLUGIN_PACKAGE} is installed but failed to load (${sanitizeLabel(firstLine(err), 200)}); running local-only`,
      ],
    };
  }
}
