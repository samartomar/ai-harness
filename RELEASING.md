# Releasing

How a maintainer cuts a release. The heavy lifting is automated: pushing a `v*` tag runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which verifies the gates,
packs a tarball + SHA256 + SPDX SBOM, attests build provenance (keyless OIDC), smoke-installs
the tarball, publishes to npm via Trusted Publishing with `--provenance`, and creates the
GitHub Release with generated notes and the artifacts attached.

Your job is everything up to the tag.

## One-time setup (before the first publish)

The package is scoped (`@aihq/harness`). A Trusted Publisher is configured under the package's
npm settings, so the package has to exist first. Bootstrap it once, then every release after is
tokenless.

1. **Create the `@aihq` org** — npmjs.com → **Add Organization → `aihq`** → Free (unlimited
   public packages). This claims the `@aihq` scope. Enable **2FA** on the account.
2. **Create the package name** with a throwaway pre-release, kept off `latest`:
   ```bash
   npm login
   npm version 0.2.0-rc.0 --no-git-tag-version
   npm publish --tag next --access public   # enter OTP; creates @aihq/harness on `next`
   git checkout -- package.json src/program.ts
   ```
3. **Add the Trusted Publisher** — npmjs.com → **@aihq/harness → Settings → Trusted publishing
   → Add** (GitHub Actions): organization/user `samartomar`, repository `ai-harness`, workflow
   `release.yml`, environment `npm-publish`. Then **restrict token-based publishing** so only
   OIDC can publish.
4. The `npm-publish` environment already requires a reviewer (publish waits for approval) and
   is restricted to `v*` tags — confirm under **repo Settings → Environments**.

Tracked in [#37](https://github.com/samartomar/ai-harness/issues/37). No npm token is ever
stored; after the bootstrap, publish is OIDC-only.

## Cut a release

1. **Land all scope.** The milestone for this version should have no open blockers
   ([Milestones](https://github.com/samartomar/ai-harness/milestones)).
2. **Set the version** — bump it in **both** places (they must match; see the check below):
   - `package.json` `version`
   - `src/program.ts` `VERSION`
   Choose the bump per [VERSIONING.md](VERSIONING.md).
3. **Update the CHANGELOG.** Move `[Unreleased]` items into a new `## [X.Y.Z] - YYYY-MM-DD`
   section under the right headings (Added / Changed / Deprecated / Removed / Fixed /
   Security). Update the compare links at the bottom (add the new version's link and
   repoint `[Unreleased]`).
4. **Update user-facing docs.** If the release adds or changes any command or flag, update
   the README command reference and any affected `docs/` page **in this same release PR** —
   the CHANGELOG records the change, it does not document the feature. (The v0.3.0→v0.3.1
   `aih prune` gap is why this step exists.)
5. **Verify locally:** `npm run verify` (typecheck · lint · test+coverage · build). Green
   only.
6. **Confirm versions agree:** `aih --version` (from `npm run build` output) must equal the
   `package.json` version and the tag you are about to push.
7. **Open a release PR** (`release/vX.Y.Z`), get it green in CI, and merge to `main`.
8. **Tag and push:**
   ```bash
   git checkout main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
9. **Watch the workflow.** The `release` run publishes to npm and creates the GitHub Release.
   If the `npm-publish` environment has a required reviewer, approve it.
10. **Verify the published package:**
   ```bash
   npm view @aihq/harness@X.Y.Z
   npm audit signatures        # provenance + integrity
   ```
11. **Close the milestone** and move any spillover to the next one.
12. **Sync project tracking.** Update the roadmap/progress notes and record any notable
    decision in memory, so the next session resumes from an accurate state (not just the
    code). This closes the loop the CHANGELOG and milestone don't cover.

## Pre-releases and dist-tags

`release.yml` publishes to the `latest` dist-tag. To ship a pre-release for pilots first
(e.g. `X.Y.Z-rc.1`), publish it under `next` and promote after validation:

```bash
npm dist-tag add @aihq/harness@X.Y.Z next     # or publish the rc with --tag next
# after pilots pass:
npm dist-tag add @aihq/harness@X.Y.Z latest
```

Publishing an rc under `next` currently needs a manual `npm publish --tag next` or a small
workflow tweak — the automated path always targets `latest`.

## If something goes wrong

- **Never re-tag a published version.** npm and provenance treat `X.Y.Z` as immutable. Fix
  forward with `X.Y.Z+1`.
- A bad `latest` can be pointed back with `npm dist-tag add @aihq/harness@<good> latest`; a
  published version can be **deprecated** (`npm deprecate`) but not deleted.
- If a tag was pushed by mistake before publish completed, delete the tag
  (`git push origin :vX.Y.Z`) and the draft Release, fix, and re-tag.

## Version coherence (guardrail)

`src/program.ts` holds `VERSION` as a constant, separate from `package.json`. Until a CI
assertion enforces `program.ts VERSION === package.json version === tag` (planned for
v0.2.0), step 5 above is the manual guard — do not skip it.
