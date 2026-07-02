import { Command } from 'commander';
import { z } from 'zod';

type Posture = "vibe" | "team" | "enterprise";
type PostureSource = "flag" | "marker" | "env" | "default" | "org-floor";

/**
 * The single external-process seam for the whole harness. PowerShell, nvidia-smi,
 * curl, gitleaks, docker — every subprocess goes through a {@link Runner}. Tests
 * inject a fake so no unit test ever spawns a real process or touches the network.
 */
interface RunResult {
    /** Process exit code; null when terminated by signal. */
    code: number | null;
    stdout: string;
    stderr: string;
    /** True when the executable could not be found / spawned (ENOENT, timeout). */
    spawnError?: boolean;
}
interface RunOptions {
    input?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
}
type Runner = (argv: string[], opts?: RunOptions) => Promise<RunResult>;
/**
 * Default runner backed by `child_process.execFile`. Never rejects on non-zero
 * exit — it resolves a {@link RunResult} so callers branch on `code`/`spawnError`
 * instead of try/catch. `argv[0]` is the executable; remaining items are args
 * (no shell, so no quoting/injection surface).
 */
declare const defaultRunner: Runner;
/**
 * Build a fake runner for tests. The handler maps an argv to a partial result;
 * returning `undefined` yields a clean exit-0 with empty output.
 */
declare function fakeRunner(handler: (argv: string[], opts?: RunOptions) => Partial<RunResult> | undefined): Runner;
/** A runner that fails as if no executable exists — for "tool absent" test paths. */
declare const missingToolRunner: Runner;

type Platform = "windows" | "darwin" | "linux";
type GpuVendor = "nvidia" | "apple" | "amd" | "none";
type AccelBackend = "cuda" | "mps" | "rocm" | "cpu";
type EnvShell = "posix" | "powershell";
interface GpuInfo {
    vendor: GpuVendor;
    backend: AccelBackend;
    /** Total VRAM in GB; 0 when unknown or no discrete GPU. */
    vramGb: number;
    name?: string;
}
interface VdiInfo {
    isVdi: boolean;
    /** The signal that matched, or why none did. */
    reason: string;
    kind?: "citrix" | "workspaces" | "res" | "rdp" | "generic";
}
interface CertEntry {
    subject: string;
    /** PEM-encoded certificate (BEGIN/END CERTIFICATE). */
    pem: string;
}
/**
 * OS-specific behaviour behind one interface. Only the adapter matching the host
 * is `verified` (smoke-tested on real metal); the others are implemented and
 * unit-tested against captured fixture output but flagged unverified. Every
 * method that shells out does so through the injected {@link Runner}.
 */
interface HostAdapter {
    readonly platform: Platform;
    readonly verified: boolean;
    /** Corporate root CAs whose subject contains `pattern`, from the OS trust store. */
    trustStoreCerts(pattern: string): Promise<CertEntry[]>;
    /** The argv that would restrict `path` to the current user (icacls/chmod). Not executed here. */
    lockDownFileArgv(path: string): string[];
    /** The argv that creates a directory symlink/junction at `linkPath` → `targetPath`. */
    symlinkDirArgv(linkPath: string, targetPath: string): string[];
    cpuPhysicalCores(): Promise<number>;
    totalRamGb(): Promise<number>;
    gpu(): Promise<GpuInfo>;
    detectVdi(): VdiInfo;
    /** Local, non-synced scratch root for caches/SQLite on this host. */
    scratchDir(user: string): string;
    /** Shell profile file(s) where env exports belong. */
    shellProfilePaths(): string[];
    envShell(): EnvShell;
    /**
     * argv that persists a user-level env var SESSION-INDEPENDENTLY — i.e. where
     * GUI-launched apps (Kiro, Claude Desktop, an IDE) inherit it, not just new
     * shells. On Windows that is the per-user registry environment
     * (`HKCU\Environment`), written with `setx` — which ships on every supported
     * image and works under Constrained Language Mode, unlike a pwsh-only
     * `[Environment]::SetEnvironmentVariable`. On POSIX the durable seam is already
     * the shell-profile `envblock`, so this returns `[]` (the caller emits no exec).
     * A local mutation only — never contacts a remote.
     */
    persistentEnvArgv(key: string, value: string): string[];
    /**
     * Absolute path to npm's `npm-cli.js` relative to the running Node binary, used
     * to compose the doc'd npm self-heal (`node <npm-cli.js> install -g npm`).
     * `undefined` when it cannot be located (npm not installed alongside Node).
     */
    npmCliPath(): string | undefined;
    /**
     * argv for a read-only TLS reachability probe of `url`. Exit 0 = handshake OK;
     * a non-zero exit = TLS/proxy failure; a spawn error (tool absent) lets the
     * caller `skip`. Never mutates; the URL is a trusted module constant.
     */
    tlsProbeArgv(url: string): string[];
}
/** Construction shape shared by the concrete adapters. */
type AdapterFactory = (run: Runner, env: NodeJS.ProcessEnv) => HostAdapter;
/** Wrap raw base64 DER into a PEM certificate block with 64-char lines. */
declare function derBase64ToPem(base64: string): string;
/** Validate a CA subject-match pattern (used in shell commands). Conservative allowlist. */
declare function safeCaPattern(pattern: string): string;
/**
 * Cross-platform, env-based VDI signals shared by every host adapter, checked
 * before the per-OS heuristics:
 *  - `AIH_VDI_KIND=<citrix|workspaces|res|rdp|generic>` lets fleet imaging pin the
 *    platform deterministically — the only reliable way to flag Amazon WorkSpaces
 *    or AVD, which expose no dependable env marker (this is what finally wires the
 *    `workspaces` kind into a reachable code path);
 *  - `AIH_FORCE_VDI=1` forces a generic VDI (back-compat; now honored on Windows
 *    too, which previously ignored it);
 *  - VMware / Omnissa Horizon exports `ViewClient_*` into the session, a genuine
 *    env-detectable marker.
 * Returns undefined when nothing matches, so the caller's OS-specific heuristics run.
 */
declare function vdiFromEnv(env: NodeJS.ProcessEnv): VdiInfo | undefined;

/**
 * The AI coding CLIs the harness can target. Capabilities that install agent
 * tooling (ECC, Superpowers) and write IDE adapters use the user's selection
 * (`--cli claude,codex` or `--all-tools`) so the harness only touches the tools
 * the user actually runs. Names match each tool's own CLI / config conventions.
 */
declare const SUPPORTED_CLIS: readonly ["claude", "codex", "cursor", "antigravity", "gemini", "copilot", "windsurf", "opencode", "zed", "kimi", "kiro"];
type Cli = (typeof SUPPORTED_CLIS)[number];

interface EnvVar {
    key: string;
    value: string;
}
/** Format a single env assignment for the target shell. */
declare function formatExport(v: EnvVar, shell: EnvShell): string;
/**
 * Insert or replace the aih-managed block for `scope` in a shell profile.
 *
 * Idempotent by construction: the region between the begin/end markers is
 * replaced wholesale, so re-running with the same vars yields byte-identical
 * output and lines outside the markers are never touched. Preserves the file's
 * existing EOL style (CRLF vs LF).
 */
declare function upsertManagedBlock(existing: string, scope: string, vars: EnvVar[], shell: EnvShell): string;
/**
 * Insert or replace the aih-managed `scope` block carrying arbitrary `body` text
 * (the format-agnostic core of {@link upsertManagedBlock}). The `#`-comment markers
 * are valid in any `#`-commented format — shell profiles AND TOML — so `aih mcp`
 * reuses this to fold its `[mcp_servers.*]` tables into Codex's `~/.codex/config.toml`
 * without clobbering the rest of the file. Idempotent: the region between the markers
 * is replaced wholesale, content outside is untouched, and the file's EOL style
 * (CRLF vs LF) is preserved.
 */
declare function upsertTextBlock(existing: string, scope: string, body: string): string;
/** Remove the managed block for `scope` if present (used by uninstall paths). */
declare function removeManagedBlock(existing: string, scope: string): string;

/**
 * A minimal question/answer seam so interactive prompts stay testable: production
 * code wires {@link makeReadlinePrompter}; tests inject a fake that returns canned
 * answers. The harness stays non-interactive by default — a prompter is only wired
 * when the user explicitly opts in (e.g. `--detect`) AND the session is a TTY.
 */
interface Prompter {
    /** Print `question`, read one line, and return the trimmed answer ("" on bare Enter/EOF). */
    ask(question: string): Promise<string>;
}

/** A single verification outcome produced by a probe action or `doctor`. */
type Verdict = "pass" | "fail" | "skip";
/**
 * Closed taxonomy of routable verification outcomes. Each member maps 1:1 to a
 * real `fail`/`skip` emitter (see docs/research/check-code-taxonomy-plan.md) so a
 * consumer — support templates, run-ledger findings — can `switch` over it
 * exhaustively rather than string-match `detail` (which rots on a reword). Keep it
 * sealed: a new failure mode means a new member here PLUS the `code` set at the
 * emitter; never derive a code by matching `detail`.
 */
type CheckCode = "env.node-runtime" | "env.git-missing" | "env.dev-tool-missing" | "env.tool-install-blocked" | "cert.ca-missing" | "tls.verify-failed" | "npm.runtime-broken" | "path.missing" | "mcp.blocked" | "mcp.uv-missing" | "mcp.config-missing" | "mcp.unvendored-offline" | "mcp.policy-denied" | "mcp.hardcoded-secret" | "mcp.allowlist-drift" | "cli.not-detected" | "cli.config-only" | "cli.bootloader-missing" | "cli.bootloader-drift" | "cli.wont-load" | "canon.router-missing" | "canon.context-dir-missing" | "canon.lint-failed" | "canon.adoptable" | "canon.cli-native-unmigrated" | "secrets.plaintext-detected" | "guardrails.gitleaks-missing" | "usage.no-data" | "usage.recorder-missing" | "usage.metrics-tool-missing" | "scale.code-review-graph-missing" | "contract.path-unportable" | "contract.stale" | "org-policy.drift" | "org-policy.invalid" | "org-policy.bundle-invalid" | "report.context-over-budget" | "report.low-adoption" | "report.contract-untrue" | "ready.blocked" | "trust.fetch-blocked" | "trust.detector-unavailable" | "trust.hidden-unicode" | "trust.prompt-injection" | "trust.source-changed" | "trust.auto-exec-hook" | "trust.dependency-confusion" | "trust.typosquat" | "trust.malicious-code" | "trust.source-drift" | "trust.unpinned-dependency" | "trust.untrusted-publisher" | "trust.unsigned-source" | "trust.license-missing" | "trust.unapproved-skill" | "pack.duplicate-name" | "pack.pin-mismatch" | "pack.missing-approval" | "pack.unknown-manifest" | "marketplace.manifest-parse" | "marketplace.path-traversal" | "marketplace.missing-file" | "marketplace.checksum-mismatch" | "marketplace.sums-coverage" | "marketplace.unapproved-verdict" | "marketplace.signature";
interface Check {
    name: string;
    verdict: Verdict;
    detail?: string;
    /**
     * Stable machine code for routing (support templates, run-ledger findings). Set
     * ONLY on `fail`/`skip` emitters a consumer keys off — never on a `pass`, and
     * never derived from `detail`. Absent ⇒ not yet ticket-routed. Optional by
     * design, so a Check that omits it serializes byte-for-byte as before.
     */
    code?: CheckCode;
    /** Optional repo-relative artifact location for file-backed findings. */
    location?: {
        uri: string;
        startLine?: number;
    };
    /** Optional stable fingerprint for code-scanning de-dupe. */
    fingerprint?: string;
}
/**
 * Accumulates {@link Check}s and renders a fail-closed report. `skip` never fails
 * the run (used when a tool/daemon is absent); only `fail` flips the exit code.
 */
declare class VerificationReport {
    readonly checks: Check[];
    add(check: Check): this;
    pass(name: string, detail?: string): this;
    fail(name: string, detail?: string): this;
    skip(name: string, detail?: string): this;
    get ok(): boolean;
    counts(): Record<Verdict, number>;
    /** 0 when no check failed, 1 otherwise. */
    exitCode(): number;
    toJSON(): {
        ok: boolean;
        counts: Record<Verdict, number>;
        checks: Check[];
    };
    summary(): string;
}

/**
 * The harness never performs a remote mutation. Every unit of work is one of:
 *  - `write`:    create/merge a local file (transactional, with backup);
 *  - `doc`:      emit guidance / commands for a human (printed, or written to a
 *                doc file) — this is where cloud setup steps live, deliberately
 *                not run;
 *  - `probe`:    a read-only verification that yields a {@link Check} under
 *                --verify;
 *  - `exec`:     a LOCAL helper command run after writes under --apply (e.g.
 *                icacls/chmod to lock down a PEM, `mklink`/`ln` for a VDI
 *                junction, or a read-only quarantined tarball fetch) — it must
 *                never mutate a remote system;
 *  - `envblock`: upsert an aih-managed env block (one `scope`) into a shell
 *                profile; multiple scopes targeting the same file compose
 *                instead of clobbering each other;
 *  - `digest`:   a read-only computed result printed verbatim (an analytics
 *                report / roll-up) plus optional structured `data` echoed into
 *                `--json` — mutates nothing, never contacts a remote system.
 *  - `remove`:   delete a repo-LOCAL file aih exclusively owns (a stale per-CLI
 *                adapter / kiro extra when its CLI is dropped), reversibly by
 *                default (moved to gitignored `.aih/legacy/`). Fail-closed:
 *                contained, symlink-guarded, backed up before unlink. Never remote.
 * Because no action kind can mutate a remote system, an autonomous run cannot
 * "fake provisioning" — the capability simply does not exist.
 */
type ActionKind = "write" | "probe" | "doc" | "exec" | "envblock" | "digest" | "remove";
interface WriteAction {
    kind: "write";
    path: string;
    describe: string;
    /** Raw file contents (for text files). */
    contents?: string;
    /** Structured value (for JSON files); enables `merge`. */
    json?: unknown;
    /** Deep-merge `json` onto an existing file instead of overwriting. */
    merge?: boolean;
    /** POSIX file mode, e.g. 0o755 for hooks. */
    mode?: number;
    /** Write only if the file is absent; never overwrite (user-owned seed files). */
    once?: boolean;
    /**
     * Allow this write to land OUTSIDE the target root (home/system files: PEM
     * bundles, shell profiles, VDI redirects). Repo-scoped writes leave this unset
     * and the executor fails closed if their resolved path escapes the root.
     */
    external?: boolean;
}
interface DocAction {
    kind: "doc";
    describe: string;
    text: string;
    /** When set, the guidance is also written to this doc file. */
    path?: string;
}
interface ProbeAction {
    kind: "probe";
    describe: string;
    run: (ctx: PlanContext) => Promise<Check> | Check;
    /** Dynamic scans may expand to several 1:1 checks after a prior exec action. */
    runMany?: (ctx: PlanContext) => Promise<Check[]> | Check[];
}
/**
 * A LOCAL helper command run after writes under `--apply` (e.g. icacls/chmod to
 * lock down a PEM, `mklink /J` for a VDI junction, `update-ca-certificates`, or
 * a read-only quarantined tarball fetch). It must never mutate a remote system —
 * that is what keeps the "no faked provisioning" guarantee intact.
 */
interface ExecAction {
    kind: "exec";
    describe: string;
    argv: string[];
    /** Optional working directory for local, quarantined helper commands. */
    cwd?: string;
    /** Optional scrubbed environment for local helper commands. */
    env?: NodeJS.ProcessEnv;
    /** Optional timeout override for long-but-bounded local helpers. */
    timeoutMs?: number;
    /** Optional verification check to emit when the command exits non-zero. */
    failureCheck?: Check | ((result: RunResult) => Check);
    /** Skip follow-on probes when this command fails. */
    blockProbesOnFailure?: boolean;
    /** Continue the plan even if the command exits non-zero. */
    allowFailure?: boolean;
    /**
     * Apply-time content pin: refuse to run (abort the apply) unless the file's
     * bytes still hash to `sha256` — pins an apply-time exec to the plan-time
     * preflighted content, so nothing swapped in between plan and apply can ever
     * be consumed by the command (the validate-then-use TOCTOU).
     */
    expect?: {
        path: string;
        sha256: string;
    };
}
/**
 * Upsert an aih-managed env block (one `scope`) into a shell profile. Unlike a
 * plain `write`, multiple `envblock` actions targeting the SAME file COMPOSE:
 * the executor folds every scope's block into the file in order (starting from
 * the on-disk content), so e.g. `bootstrap` can layer certs + hardware + vdi +
 * telemetry blocks into one profile without any of them clobbering the others.
 */
interface EnvBlockAction {
    kind: "envblock";
    path: string;
    scope: string;
    shell: EnvShell;
    vars: EnvVar[];
    describe: string;
}
/**
 * A read-only ANALYSIS result surfaced to the operator. Unlike {@link DocAction}
 * (whose body only ever lands in a file), a digest's `text` is printed verbatim
 * beneath its headline by the summary, and its optional `data` rides into
 * `--json` — the shape analytics reports and inventory roll-ups need. It mutates
 * nothing and never contacts a remote system.
 */
interface DigestAction {
    kind: "digest";
    describe: string;
    /** Report body, printed verbatim beneath the headline in text mode. */
    text?: string;
    /** Machine-readable payload echoed into `--json` output. */
    data?: unknown;
    /** Optional late-bound digest for analyses that depend on earlier exec/probe actions. */
    run?: (ctx: PlanContext) => Promise<string | {
        text: string;
        data?: unknown;
    }> | string | {
        text: string;
        data?: unknown;
    };
}
/**
 * Remove a repo-LOCAL file or directory that aih exclusively owns — aih's only
 * destructive action. Three emitters: `aih prune` (artifacts its detection proved
 * aih-owned — a per-CLI adapter note, a kiro steering/hook extra — once the CLI is
 * dropped), `aih skill remove` (a user-directed removal of an installed skill's
 * directory + committed card), and `aih skill quarantine` (the same reversible move,
 * but into `.aih/quarantine/` with the skill's approval kept). The executor fails
 * closed: mandatory {@link assertContained} on the raw
 * path (no `external` field exists, so a global `~/home` file is structurally
 * unreachable), a symlink guard, and a backup before unlink. By default it MOVES the
 * file to gitignored `.aih/legacy/<path>` (reversible; occupied destinations are never
 * overwritten); `archiveRoot` picks `.aih/quarantine/` instead, with the identical
 * containment/symlink/never-overwrite machinery. Under `hardDelete` it instead renames
 * to the sibling `<path>.aih.bak`
 * — the same single-slot, latest-wins backup every aih write gets — for users who
 * explicitly opt out of the archive.
 */
interface RemoveAction {
    kind: "remove";
    /** Repo-relative path of the file to remove. */
    path: string;
    describe: string;
    /** Opt-in: single-slot `<path>.aih.bak` rename instead of the `.aih/legacy/` archive. */
    hardDelete?: boolean;
    /** Archive root for the reversible move. Closed union — never an arbitrary path. */
    archiveRoot?: ".aih/legacy" | ".aih/quarantine";
}
type Action = WriteAction | DocAction | ProbeAction | ExecAction | EnvBlockAction | DigestAction | RemoveAction;
interface Plan {
    capability: string;
    actions: Action[];
}
/** Everything a capability needs to compute (and a runner to execute) its plan. */
interface PlanContext {
    /** Target repository / workstation root. */
    root: string;
    /** Canonical context directory name (default ".ai-context"). */
    contextDir: string;
    /** Harness-wide governance posture dial, resolved by the shared ladder. */
    posture?: Posture;
    /** Where the active posture came from (flag/marker/env/default/org floor). */
    postureSource?: PostureSource;
    /** When false (default), the plan is computed but nothing is written. */
    apply: boolean;
    /** When true, probe actions run and contribute to the verification report. */
    verify: boolean;
    json: boolean;
    /**
     * Local process runner. During `plan()` (dry-run) only READ-ONLY tools on FIXED targets
     * may be run, and only to DECIDE the plan (heal's node/npm/TLS checks pick the repair
     * ladder; certs reads the OS trust store; report shells `git` for stats). Never shell out
     * an arbitrary or interpolated command at plan time — that is the `AIH_GRAPH_CMD` class of
     * bug. The read-only allowlist is pinned by `tests/internals/plan-purity.test.ts` (#35).
     */
    run: Runner;
    host: HostAdapter;
    env: NodeJS.ProcessEnv;
    /**
     * Interactive prompt seam. Present only when the user opted into an interactive
     * flow (e.g. `--detect`) in a TTY; undefined keeps the harness non-interactive.
     */
    prompter?: Prompter;
    /**
     * The resolved CLI target set, injected by an orchestrator (`aih init`) that
     * resolves `--detect`/`--cli` ONCE and threads the result into every phase. A
     * tool-specific phase emits a tool's files only when that tool is targeted (see
     * {@link isTargeted}). Undefined when a leaf command runs standalone — it then
     * keeps its single-tool identity (`aih profile` is the Cursor profiler, `aih
     * secrets` the Claude secrets guard) and always writes.
     */
    targets?: Cli[];
    /** Capability-specific options parsed from the CLI. */
    options: Record<string, unknown>;
}
type PlanFn = (ctx: PlanContext) => Plan | Promise<Plan>;
interface CommandOption {
    flags: string;
    description: string;
    default?: string | boolean;
}
interface CommandSpec {
    name: string;
    summary: string;
    /**
     * Old command NAMES this command still answers to after a rename — the
     * alias-before-removal deprecation machinery (STABILITY.md). Each entry
     * registers as a commander alias of this command on the shared registerSpec
     * path (src/commands/index.ts): the old name dispatches the SAME action with
     * the same flags, after ONE stderr line naming the replacement. An alias
     * lives for at least one minor release and is removed only by the next
     * major (VERSIONING.md), staying reserved in {@link builtinCommandNames}
     * for its whole grace window. Core-only: the plugin registry strips this
     * field from plugin specs — a plugin ships new commands, it never renames
     * (or shadows) core ones. TOP-LEVEL commands only: specs registered through
     * the manual parent-group paths (trust/skill/pack/marketplace/policy/
     * evidence subcommands) never pass through registerSpec, so the field is
     * silently ignored there — wire alias support into that path before the
     * first nested rename.
     */
    deprecatedAliases?: string[];
    options?: CommandOption[];
    plan: PlanFn;
    /** Read-only commands (doctor/status) skip the apply path entirely. */
    readOnly?: boolean;
    /**
     * Force `verify` on every run so the capability's probes always populate the
     * verification report — i.e. it DIAGNOSES by default (like `doctor`) yet still
     * mutates under `--apply` (unlike `readOnly`). `heal` uses this so a bare
     * `aih heal` surfaces the health report and a non-zero exit when broken.
     */
    alwaysVerify?: boolean;
    /**
     * Exempt from the dirty-worktree `--apply` preflight. For pure-analytics commands
     * (`aih report`) whose only writes are gitignored OUTPUT artifacts (the `.aih/`
     * report file + its ignore rule) — those never clobber uncommitted work, so
     * blocking the report on a dirty tree is wrong.
     */
    skipWorktreeGate?: boolean;
    /**
     * Wire an interactive prompter for this command in a TTY even without `--detect`,
     * so a bare run can offer a confirmation (e.g. `aih ready` asking to install the
     * missing core tools). Still suppressed under `--json`/`--yes`/non-TTY, so
     * automation stays non-interactive.
     */
    wantsInstallPrompt?: boolean;
}
declare function writeText(path: string, contents: string, describe: string, opts?: {
    mode?: number;
    once?: boolean;
    external?: boolean;
}): WriteAction;
declare function writeJson(path: string, value: unknown, describe: string, opts?: {
    merge?: boolean;
    external?: boolean;
}): WriteAction;
declare function doc(describe: string, text: string, path?: string): DocAction;
declare function digest(describe: string, text: string, data?: unknown): DigestAction;
declare function dynamicDigest(describe: string, run: NonNullable<DigestAction["run"]>): DigestAction;
declare function probe(describe: string, run: ProbeAction["run"]): ProbeAction;
declare function probeMany(describe: string, runMany: NonNullable<ProbeAction["runMany"]>): ProbeAction;
declare function exec(describe: string, argv: string[], opts?: {
    allowFailure?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    failureCheck?: ExecAction["failureCheck"];
    blockProbesOnFailure?: boolean;
    expect?: ExecAction["expect"];
}): ExecAction;
declare function envBlock(path: string, scope: string, shell: EnvShell, vars: EnvVar[], describe: string): EnvBlockAction;
declare function remove(path: string, describe: string, opts?: {
    hardDelete?: boolean;
    archiveRoot?: RemoveAction["archiveRoot"];
}): RemoveAction;
declare function plan(capability: string, ...actions: Action[]): Plan;

/** Capability commands (repo/workstation mutators), dry-run by default. */
declare const CAPABILITIES: CommandSpec[];
/** Read-only commands (always safe). */
declare const READONLY: CommandSpec[];
declare const ALL_COMMANDS: CommandSpec[];
/**
 * Every top-level name the core CLI claims: ALL_COMMANDS' names AND their
 * deprecated aliases (an old name stays reserved for its whole grace window —
 * see CommandSpec.deprecatedAliases), plus the parent group names
 * (`workspace` is both a CommandSpec and a group — the Set folds it) plus
 * commander's own reserved `help`/`version`. The plugin registry refuses any
 * external spec colliding with one of these, so a plugin can never shadow
 * `doctor`, capture the `marketplace` group, impersonate `help`, or squat on
 * a deprecated old name mid-migration. `specs` is a test seam (defaults to
 * ALL_COMMANDS) so the alias reservation is provable while zero built-ins
 * carry one.
 */
declare function builtinCommandNames(specs?: readonly CommandSpec[]): ReadonlySet<string>;
/**
 * Register every command on the program. `extra` carries EXTERNAL plugin specs
 * (see src/plugins/registry.ts, already gated + collision-free): they flow
 * through the IDENTICAL registerSpec path as the built-ins — same shared
 * flags, same optional `[root]` positional, same runCapability action (posture
 * resolution, dirty-worktree gate, run ledger). TOP-LEVEL specs only: a plugin
 * cannot contribute subcommands to a parent group (trust/skill/pack/…) in v1.
 *
 * Containment: built-ins register OUTSIDE any try/catch — a throw there is a
 * core bug that must crash loudly. Each plugin spec registers inside its own
 * try/catch: a Commander throw (e.g. a flag conflict the structural gate
 * cannot predict) drops THAT spec with a warning pushed to the `warnings`
 * sink, and every other command stays live.
 */
declare function registerCommands(program: Command, extra?: CommandSpec[], warnings?: string[]): void;

/** Resolved runtime settings (env defaults overlaid with CLI flags). */
interface Settings {
    apply: boolean;
    verify: boolean;
    json: boolean;
    contextDir: string;
    root: string;
    caPattern: string;
}
/**
 * A canonical context-dir name: a simple, repo-relative path with no traversal.
 * Exported so {@link readAihConfig} validates the committed `.aih-config.json`
 * marker against the SAME constraints settings enforce — a marker can never carry
 * a dir that a flag/env value would have rejected.
 */
declare const ContextDir: z.ZodString;
/**
 * Resolve settings fail-closed: env provides defaults (`AIH_*`), `overrides`
 * (CLI flags) win, and any malformed value throws {@link SettingsError} before a
 * command runs. Dry-run (`apply=false`) is the safe default.
 */
declare function loadSettings(env: NodeJS.ProcessEnv, overrides?: Partial<Settings>): Settings;

/**
 * Typed error hierarchy for the harness. Every error carries a stable machine
 * `code` so `--json` output and `doctor` reports stay parseable across versions.
 */
declare class AihError extends Error {
    readonly code: string;
    constructor(message: string, code?: string);
}
/** Invalid/contradictory configuration (env or CLI). Fail-closed. */
declare class SettingsError extends AihError {
    constructor(message: string);
}
/** A host/platform probe could not be satisfied on this OS. */
declare class PlatformError extends AihError {
    constructor(message: string);
}
/** A staged filesystem transaction failed (and was rolled back). */
declare class FsTxnError extends AihError {
    constructor(message: string);
}
/** A verification probe failed in a way that should halt the run. */
declare class VerificationError extends AihError {
    constructor(message: string);
}
/** Capability not yet implemented (foundation stub). */
declare class NotImplementedError extends AihError {
    constructor(message: string);
}
/** Existing config could not be parsed for a merge — fail closed, never partial-merge. */
declare class MergeError extends AihError {
    constructor(message: string);
}
/** An action path escaped its intended root (path-containment violation). Fail-closed. */
declare class PathContainmentError extends AihError {
    constructor(message: string);
}
/** An `--apply` was attempted on a dirty git worktree without `--force`. Fail-closed. */
declare class DirtyWorktreeError extends AihError {
    constructor(message: string);
}

interface WriteSummary {
    path: string;
    describe: string;
    merged: boolean;
    /**
     * Effect relative to current disk state. `unchanged` writes are skipped (no
     * backup); `kept` is a write-once file that already exists (left untouched).
     */
    effect: "create" | "overwrite" | "merge" | "unchanged" | "kept";
}
interface RemoveSummary {
    path: string;
    describe: string;
    /** `remove` = move to `.aih/legacy/`; `delete` = hard-delete (single-slot `.aih.bak`
     * backup); `absent` = nothing on disk. */
    effect: "remove" | "delete" | "absent";
    /** Repo-relative destination (`.aih/legacy/…` or `<path>.aih.bak`), when present. */
    to?: string;
}
interface PlanResult {
    capability: string;
    applied: boolean;
    writes: WriteSummary[];
    docs: {
        describe: string;
        path?: string;
    }[];
    probes: {
        describe: string;
    }[];
    execs: {
        describe: string;
        argv: string[];
        ran: boolean;
        code?: number | null;
        ok?: boolean;
    }[];
    /** Read-only computed reports surfaced verbatim (text) + machine-readable (`data`). */
    digests: {
        describe: string;
        text: string;
        data?: unknown;
    }[];
    backups: string[];
    /** Files aih removed (moved to `.aih/legacy/`) or would remove (dry-run). */
    removed: RemoveSummary[];
    report?: VerificationReport;
}
/**
 * Write a single, explicitly-requested analysis artifact (e.g. a `--sarif` report)
 * to a repo-contained path, transactionally. Returns the backups created (0 or 1).
 *
 * DESIGN — why this is NOT gated on `--apply`: the harness invariant "no writes
 * without --apply" protects the user's MANAGED project surface (bootloaders,
 * configs, the context dir) from being mutated without consent. A `--sarif` file
 * is not part of that surface — it is a report OUTPUT the operator requested by
 * naming its path on the command line, exactly like `report --out` or a test
 * runner writing `junit.xml`. Naming the path IS the consent. Crucially, the
 * primary use case — `aih bootstrap-ai --verify --sarif results.sarif` feeding
 * GitHub code-scanning — runs the drift gate WITHOUT `--apply` (CI must not
 * regenerate the repo it is gating); apply-gating the artifact would make the flag
 * a no-op in exactly the scenario it exists for, or force `--apply` to also rewrite
 * every bootloader. So the artifact is decoupled from the plan's apply gate — but
 * NOT from its safety machinery: the path is still contained to `root`
 * ({@link assertContained}) and an overwrite is still backed up to `*.aih.bak` via
 * {@link FsTransaction}. Re-writing identical bytes is a no-op (no rewrite, no
 * backup churn), matching {@link executePlan}'s idempotency contract.
 */
declare function writeArtifact(ctx: PlanContext, relPath: string, contents: string): string[];
/** Compute final file contents for a write action, applying JSON merge if requested. */
declare function resolveContents(action: WriteAction, absPath: string): string;
/**
 * Execute a plan. In dry-run (`ctx.apply === false`) nothing is written — the
 * result still reports exactly what would change. With `ctx.apply` writes are
 * committed transactionally; with `ctx.verify` probe actions run and populate a
 * {@link VerificationReport}.
 */
declare function executePlan(plan: Plan, ctx: PlanContext, opts?: {
    skipWorktreeGate?: boolean;
}): Promise<PlanResult>;
/** Human-readable summary of a plan result (used when --json is off). */
declare function summarizeResult(result: PlanResult): string;

/**
 * Run a synchronous fs operation, retrying ONLY the transient Windows lock codes
 * in {@link TRANSIENT_LOCK_CODES} with a short bounded backoff (~0.5s worst case).
 * Any other error — `EEXIST` from an exclusive create, a genuine `EACCES` on a
 * locked-down path that never clears — is re-thrown on its first occurrence, so
 * this absorbs the sub-millisecond scanner window without ever masking a real
 * failure. The retry preserves the caller's atomicity/rollback guarantees: it
 * re-issues the same single syscall, nothing more.
 *
 * Exported for direct unit testing — the FS-level retry is exercised through the
 * real filesystem elsewhere, but a transient lock cannot be reproduced on demand,
 * so the retry/give-up/passthrough contract is pinned here.
 */
declare function retryTransient<T>(op: () => T): T;
interface StagedWrite {
    path: string;
    contents: string;
    mode?: number;
}
interface AppliedRemoval {
    path: string;
    legacyPath: string;
}
interface FsTxnResult {
    written: string[];
    backups: string[];
    /** Files moved out of the tree (source → `.aih/legacy/` destination). */
    removed: AppliedRemoval[];
}
/**
 * Stages writes in memory and commits them atomically. Each existing target is
 * first copied to `<path>.aih.bak`; new content is written to a temp file and
 * `rename`d into place (atomic on the same volume). If any write throws, every
 * write applied so far is rolled back (created files removed, overwritten files
 * restored from their backup).
 */
declare class FsTransaction {
    private staged;
    private stagedRemovals;
    stage(path: string, contents: string, mode?: number): void;
    /**
     * Stage a file REMOVAL as a reversible move to `legacyPath` (under gitignored
     * `.aih/legacy/`). The move IS the backup: rollback (and the user) restore by
     * moving it back. Symlinks are refused at commit (moving a link then restoring it
     * would recreate a regular file). No-op if the source is already gone.
     * `backupSibling` marks a hard-delete destination (`<path>.aih.bak`): still
     * never-overwrite, but a taken slot falls back to `<path>.N.aih.bak` (matches the
     * gitignored `*.aih.bak` glob) instead of the archive's `<path>.N`.
     */
    stageRemoval(path: string, legacyPath: string, opts?: {
        backupSibling?: boolean;
    }): void;
    preview(): ReadonlyArray<StagedWrite>;
    commit(): FsTxnResult;
}
/** Read a file's text, or `undefined` if it does not exist. */
declare function readIfExists(path: string): string | undefined;
/**
 * Open-then-read on ONE file descriptor: the regular-file check (`fstat` on the
 * open fd, never a second path lookup) and the read cannot be raced apart, and
 * a symlink swapped in after directory enumeration is refused at open where
 * `O_NOFOLLOW` exists rather than silently followed. Returns undefined for
 * anything that is not a readable regular file.
 *
 * Use this — not {@link readIfExists} — for any path DISCOVERED by a directory
 * scan: a plain exists-then-read pair on a scanned path is a swap window where
 * a symlink planted between enumeration and read gets silently followed and its
 * target's bytes laundered into an artifact (marketplace build, evidence
 * bundle, fleet bundle all package what they read).
 */
declare function readRegularFile(abs: string): Buffer | undefined;

/**
 * Parse JSON or JSONC text (tolerant of comments + trailing commas). Returns
 * `undefined` for empty input. Throws {@link MergeError} on a genuine syntax
 * error: `jsonc-parser` returns a PARTIAL value for malformed input (incomplete
 * braces, trailing garbage), and merging onto a partial parse would silently
 * drop the user's real config — so we fail closed and ask for a manual fix
 * instead of overwriting from a half-read file.
 */
declare function parseJsoncText(text: string): unknown;
declare function isPlainObject(v: unknown): v is Record<string, unknown>;
/**
 * Deep-merge `incoming` (harness-generated) onto `base` (existing user config),
 * preserving every key that exists only in `base`. Objects merge recursively;
 * primitive arrays become a deduped union (base order first) so things like
 * `permissions.deny` accumulate instead of clobbering; for any other type
 * mismatch, `incoming` wins.
 */
declare function deepMerge(base: unknown, incoming: unknown): unknown;

/**
 * Deterministic string-building helpers shared by capability templates. All
 * generated files flow through these so golden-file tests stay stable: no dates,
 * no random ordering, single trailing newline.
 */
/**
 * Strip trailing newlines in linear time. The idiomatic `/\n+$/` is a
 * polynomial-ReDoS footgun (CodeQL `js/polynomial-redos`): on a long run of
 * newlines followed by a non-newline a backtracking engine retries the run from
 * every start position — O(n²). A reverse scan is provably O(n) and byte-for-byte
 * identical (only `\n` (U+000A) is stripped, exactly as the old regex did, so
 * `\r` in a `\r\n` sequence is preserved either way).
 */
declare function stripTrailingNewlines(text: string): string;
/** Join parts (strings or string arrays) with newlines; exactly one trailing newline. */
declare function lines(...parts: Array<string | string[]>): string;
/** Indent every non-empty line of `text` by `n` spaces. */
declare function indent(text: string, n?: number): string;
/** Render a YAML frontmatter block from ordered key/value pairs (insertion order). */
declare function frontmatter(fields: Record<string, string | boolean | number | string[]>): string;
/** Stable 2-space JSON with a trailing newline (insertion order preserved). */
declare function jsonFile(value: unknown): string;
/** Ensure exactly one trailing newline. */
declare function ensureTrailingNewline(text: string): string;
/** Marker that opens an aih-managed region (comment syntax works in sh + PowerShell). */
declare function beginMarker(scope: string): string;
/** Marker that closes an aih-managed region. */
declare function endMarker(scope: string): string;
/** Wrap `body` in begin/end markers for in-place regeneration. */
declare function managedBlock(scope: string, body: string): string;

/** Resolve the effective platform, honoring the `AIH_PLATFORM` test override. */
declare function resolvePlatform(env?: NodeJS.ProcessEnv): Platform;
interface HostAdapterOptions {
    platform?: Platform;
    run?: Runner;
    env?: NodeJS.ProcessEnv;
}
/** Construct the host adapter for this (or an overridden) platform. */
declare function makeHostAdapter(opts?: HostAdapterOptions): HostAdapter;

/** First integer anywhere in `stdout` (handles trailing newlines/whitespace). */
declare function parseFirstInt(stdout: string): number | undefined;
/** Parse `nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits`. */
declare function parseNvidiaSmi(stdout: string): GpuInfo;
/** Parse tab-separated `base64<TAB>subject` lines (Windows cert export). */
declare function parseCertLines(stdout: string): CertEntry[];
/**
 * Extract PEM certificate blocks from `security`/openssl `-p` style output.
 *
 * A linear `indexOf` walk rather than `/BEGIN[\s\S]*?END/g`: that lazy match
 * between two literal anchors is a polynomial-ReDoS footgun (CodeQL
 * `js/polynomial-redos`) — on output with many `BEGIN` markers and no closing
 * `END`, the engine rescans to end from every `BEGIN`, O(n²). The walk finds
 * each `BEGIN` then its nearest following `END` (the same blocks the lazy regex
 * matched, in order) with non-overlapping O(n) scans.
 */
declare function parsePemBlocks(stdout: string, subject?: string): CertEntry[];

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
 *  - `deprecatedAliases` is never honored for plugin commands — aliases are
 *    the CORE rename machinery (STABILITY.md), and an alias is an extra
 *    dispatch name the collision rules above do not walk. The field is
 *    stripped from the registered copy with a warning (see
 *    {@link stripDeprecatedAliasesField}); built-in aliases stay reserved
 *    against plugin NAMES via builtinCommandNames.
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
declare const PLUGIN_PACKAGE = "@aihq/enterprise";
interface PluginLoadResult {
    commands: CommandSpec[];
    warnings: string[];
}
/** Import seam so tests can simulate any module shape without installing anything. */
type PluginImporter = (specifier: string) => Promise<unknown>;
/**
 * Resolver seam for the install-tree boundary: maps the package specifier to
 * the FILE PATH the import would load from. Production uses
 * `import.meta.resolve`; tests inject paths inside/outside the allowed roots.
 */
type PluginResolver = (specifier: string) => string;
interface PluginLoadOptions {
    /** Test seam replacing the platform dynamic import. */
    importer?: PluginImporter;
    /** Test seam replacing `import.meta.resolve` for the install-tree check. */
    resolver?: PluginResolver;
    /** Environment for the kill switch — matches runCapability's deps.env convention. */
    env?: NodeJS.ProcessEnv;
    /** Import budget in milliseconds (default {@link DEFAULT_IMPORT_TIMEOUT_MS}). */
    timeoutMs?: number;
}
/**
 * Long flag tokens `addSharedFlags` (src/commands/index.ts) puts on every
 * capability subcommand. Mirrored as a constant because the registry must stay
 * a leaf module — importing the command tree from here would create an import
 * cycle (commands/index.ts imports {@link sanitizeLabel} back from this file).
 * The mirror is pinned against the real addSharedFlags registration by
 * tests/plugins/registry.test.ts, so any drift fails CI.
 */
declare const SHARED_FLAG_TOKENS: ReadonlySet<string>;
/**
 * Make a plugin-influenced string safe to echo in a one-line warning: collapse
 * newlines to spaces, strip C0/C1 control characters (including ESC, so
 * ANSI/OSC sequences lose their teeth) plus DEL, and truncate to `max` with an
 * ellipsis. Exported so the plugin-registration containment in
 * src/commands/index.ts routes through the SAME sanitizer — one
 * implementation, no drift.
 */
declare function sanitizeLabel(value: string, max?: number): string;
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
declare function allowedPluginRoots(): string[];
/**
 * Probe for {@link PLUGIN_PACKAGE} and return its registrable CommandSpecs.
 * Never throws: every failure mode degrades to `{ commands: [] }` plus at most
 * one-line warnings, so the CLI stays fully local no matter how broken the
 * plugin is. `AIH_NO_PLUGINS=1` (from `opts.env ?? process.env`) skips the
 * probe entirely. See {@link PluginLoadOptions} for the test seams.
 */
declare function loadExternalCommands(builtinNames: ReadonlySet<string>, opts?: PluginLoadOptions): Promise<PluginLoadResult>;

declare const VERSION = "1.0.1";
/**
 * Build the configured commander program. Imported by both the CLI entry and
 * tests. Stays SYNC: `extra` lets callers merge pre-loaded plugin specs — the
 * async plugin probe lives in {@link buildProgramWithPlugins}. `warnings` is an
 * optional sink for per-spec registration containment: a plugin spec Commander
 * refuses at registration time is dropped with a warning instead of taking the
 * CLI down (see registerCommands in src/commands/index.ts).
 */
declare function buildProgram(extra?: CommandSpec[], warnings?: string[]): Command;
/**
 * The CLI entry's builder: probe for the optional `@aihq/enterprise` peer
 * (fail-open to local — see src/plugins/registry.ts) and build with whatever
 * validly loaded. `warnings` (probe + registration containment, in that order)
 * is printed to stderr by the entry BEFORE parse; an unenrolled machine gets
 * zero warnings and the exact buildProgram surface.
 */
declare function buildProgramWithPlugins(): Promise<{
    program: Command;
    warnings: string[];
}>;

export { ALL_COMMANDS, type AccelBackend, type Action, type ActionKind, type AdapterFactory, AihError, CAPABILITIES, type CertEntry, type Check, type CheckCode, type CommandOption, type CommandSpec, ContextDir, type DigestAction, DirtyWorktreeError, type DocAction, type EnvBlockAction, type EnvShell, type EnvVar, type ExecAction, FsTransaction, FsTxnError, type FsTxnResult, type GpuInfo, type GpuVendor, type HostAdapter, type HostAdapterOptions, MergeError, NotImplementedError, PLUGIN_PACKAGE, PathContainmentError, type Plan, type PlanContext, type PlanFn, type PlanResult, type Platform, PlatformError, type PluginImporter, type PluginLoadOptions, type PluginLoadResult, type PluginResolver, type ProbeAction, READONLY, type RemoveAction, type RemoveSummary, type RunOptions, type RunResult, type Runner, SHARED_FLAG_TOKENS, type Settings, SettingsError, VERSION, type VdiInfo, type Verdict, VerificationError, VerificationReport, type WriteAction, type WriteSummary, allowedPluginRoots, beginMarker, buildProgram, buildProgramWithPlugins, builtinCommandNames, deepMerge, defaultRunner, derBase64ToPem, digest, doc, dynamicDigest, endMarker, ensureTrailingNewline, envBlock, exec, executePlan, fakeRunner, formatExport, frontmatter, indent, isPlainObject, jsonFile, lines, loadExternalCommands, loadSettings, makeHostAdapter, managedBlock, missingToolRunner, parseCertLines, parseFirstInt, parseJsoncText, parseNvidiaSmi, parsePemBlocks, plan, probe, probeMany, readIfExists, readRegularFile, registerCommands, remove, removeManagedBlock, resolveContents, resolvePlatform, retryTransient, safeCaPattern, sanitizeLabel, stripTrailingNewlines, summarizeResult, upsertManagedBlock, upsertTextBlock, vdiFromEnv, writeArtifact, writeJson, writeText };
