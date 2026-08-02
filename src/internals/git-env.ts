// Production-side arm of the worktree-commit leak fix (the test-side arm is
// tests/git-fixture-env.ts + tests/setup-git-env.ts).
//
// git resolves WHICH repository it operates on from GIT_DIR / GIT_WORK_TREE /
// GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY / GIT_COMMON_DIR (etc.) BEFORE it ever
// looks at `cwd` or a `-C` flag — `-C` does not win, it is simply ignored for
// repo location. Those variables are normally unset, but git EXPORTS an absolute
// GIT_DIR (and often GIT_INDEX_FILE) into the entire process tree of any hook it
// runs. So when `aih` runs from a pre-commit hook, every production git spawn
// that inherits the live env escapes its intended directory and operates on the
// caller's real repository instead. Observed 2026-08-01: a worktree hook run
// flipped the shared `.git` of this checkout to `core.bare=true` and clobbered
// the staged blobs.
//
// Route every production git spawn through hermeticGitEnv() so `cwd`/`-C` is the
// only thing that decides which repo a spawn touches.

/**
 * Stripped by default: EVERY `GIT_*` name, rather than a denylist of the
 * currently-known repo-location variables. A denylist rots as git adds
 * variables; a prefix rule cannot.
 */
const GIT_VARIABLE = /^GIT_/i;

/**
 * The one carve-out: variables that configure HOW git reaches a remote, never
 * WHICH repository it operates on. They cannot steer a spawn, and stripping them
 * would break aih's own network git (`resolveGitSource`'s clone/ls-remote, the
 * ECC repo sync, `workspace hydrate`'s clone) behind a TLS-inspecting corporate
 * proxy — the exact setup aih's own `aih certs` blueprint provisions by telling
 * users to export GIT_SSL_CAINFO.
 *
 * Deliberately NOT carved out: `GIT_CONFIG_*`. GIT_CONFIG_COUNT/KEY/VALUE can
 * set `core.worktree`/`core.bare`, which relocates the repo — the very thing
 * this guard exists to prevent.
 */
const GIT_TRANSPORT_VARIABLE = /^GIT_(?:SSL_[A-Z_]*|PROXY_COMMAND|ASKPASS|TERMINAL_PROMPT)$/i;

/**
 * An env snapshot safe to pass to `execFile`/`execFileSync`/`spawn` when
 * spawning `git`: every inherited `GIT_*` variable is removed except the
 * transport carve-out above, so no parent-process git state (an absolute
 * GIT_DIR, GIT_INDEX_FILE, ... leaked by an outer `git commit`) can steer the
 * spawn away from its `cwd`/`-C`.
 *
 * Mirrors tests/git-fixture-env.ts `hermeticGitEnv()`, including its rationale
 * for NOT redirecting GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM at an empty file: the
 * inherited values are dropped so git falls back to the real `~/.gitconfig`,
 * which keeps host `core.autocrlf` intact. Emptying the config instead would
 * desync line endings between hermetic and non-hermetic checkouts.
 *
 * `base` defaults to the live `process.env` (read on every call, so it reflects
 * any later env mutation). It is a parameter only so the stripping logic can be
 * unit-tested against a synthetic env without mutating the process.
 */
export function hermeticGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!GIT_VARIABLE.test(key) || GIT_TRANSPORT_VARIABLE.test(key)) env[key] = value;
  }
  return env;
}

/**
 * True when `command` invokes git, so a generic spawn seam can apply
 * {@link hermeticGitEnv} without every caller opting in. Matches the bare name
 * aih's argv arrays use plus an absolute/Windows-shim path, and deliberately not
 * `gh` or `gitleaks` — those are separate executables with their own env
 * contract.
 */
export function isGitExecutable(command: string): boolean {
  const basename = command.replace(/\\/g, "/").split("/").pop() ?? command;
  return /^git(?:\.exe|\.cmd)?$/i.test(basename);
}

/**
 * The same guard as one line of JavaScript source, for the standalone scripts
 * aih GENERATES and installs (the ECC install-manifest recorder, the usage
 * recorder). Those run in their own node process — often as a git hook, which is
 * precisely when GIT_DIR is exported — so they cannot import the helper above
 * and must carry the scrub inline. Defines a `gitEnv` const for the spawns to
 * pass as `env`.
 *
 * Blanket `GIT_*` strip with no transport carve-out: generated scripts only ever
 * run local, offline provenance reads (`rev-parse`, `show`), so no transport
 * variable is relevant to them.
 */
export const HERMETIC_GIT_ENV_SCRIPT_LINE =
  "const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));";
