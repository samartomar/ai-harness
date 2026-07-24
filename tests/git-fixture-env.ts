// Shared by every test that spawns real `git` against a throwaway fixture
// repo (see tests/**/*.test.ts under binding/, skill/, uninstall/, internals/,
// review-quality/). git resolves the repository from GIT_DIR / GIT_WORK_TREE /
// GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY / GIT_COMMON_DIR (etc.) BEFORE it ever
// looks at `cwd` or a `-C` flag. Those variables are normally unset — but
// `git commit` itself exports an ABSOLUTE GIT_DIR (and sometimes
// GIT_INDEX_FILE) into its own environment when run from a linked worktree.
// If that commit's process tree runs this suite (e.g. via the pre-commit
// hook's `npm test`), every fixture spawn that forgets to scrub those
// inherited variables escapes its own temp dir and silently mutates whatever
// repo the outer `git commit` came from instead. Route every fixture git
// spawn through hermeticGitEnv() so `cwd`/`-C` is the only thing that decides
// which repo it touches.
//
// We strip the inherited GIT_* variables and nothing more. In particular we do
// NOT redirect GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM at an empty file: production
// code under test (e.g. `resolveGitSource`) shells git with the real host env,
// and some fixtures interoperate with the checkouts it produces (see
// tests/binding/review-fixes.test.ts, which re-checks-out a resolver-created
// cache dir). Emptying the config would drop host `core.autocrlf`, so hermetic
// test-git and non-hermetic production-git would disagree on line endings and a
// cross-boundary checkout would see phantom modifications. Stripping GIT_* is
// what closes the worktree-commit leak; it is the whole fix.

/**
 * An env snapshot safe to pass to `execFileSync`/`spawnSync` when spawning
 * `git` against a fixture directory: every inherited `GIT_*` variable is
 * removed so no parent-process git state (an absolute GIT_DIR, GIT_INDEX_FILE,
 * etc. leaked by an outer `git commit`) can steer the spawn away from `cwd`.
 *
 * `base` defaults to the live `process.env` (recomputed on every call, so it
 * reflects any env mutation a test performs). It exists as a parameter only so
 * the stripping logic can be unit-tested against a synthetic env without
 * mutating the process — production call sites always use the default.
 */
export function hermeticGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!/^GIT_/i.test(key)) env[key] = value;
  }
  return env;
}
