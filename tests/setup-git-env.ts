// Suite-wide arm of the worktree-commit leak fix (see tests/git-fixture-env.ts):
// when the pre-commit hook's `npm test` runs this suite, the outer `git commit`
// has already exported an absolute GIT_DIR/GIT_INDEX_FILE into the whole process
// tree. hermeticGitEnv() protects the fixture spawns that opt in, but production
// code under test (e.g. `resolveGitSource`) deliberately shells git with the live
// process env — inherited GIT_* steers those spawns into the real repository
// (observed: a worktree hook run flipped the shared .git to core.bare=true and
// clobbered the staged blobs). Scrub the inherited GIT_* once per worker, before
// any test file loads, so `cwd`/`-C` is the only thing that decides which repo a
// spawn touches. A test that needs a GIT_* variable sets it itself afterwards.
for (const key of Object.keys(process.env)) {
  if (/^GIT_/i.test(key)) delete process.env[key];
}
