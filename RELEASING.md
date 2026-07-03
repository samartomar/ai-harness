# Releasing

How a maintainer cuts a release. The heavy lifting is automated: pushing a `v*` tag runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which verifies the gates,
packs a tarball + SHA256 checksum + SPDX SBOM, attests build provenance (keyless OIDC),
signs the checksum file with keyless cosign, smoke-installs the tarball, publishes to npm
via Trusted Publishing with `--provenance`, and creates the GitHub Release with generated
notes and the artifacts attached: the tarball, `SHA256SUMS.txt` (+ its cosign signature
bundle `SHA256SUMS.txt.sigstore.json`), `provenance.intoto.jsonl`, and `aih-sbom.spdx.json`.

Your job is everything up to the tag.

## One-time setup (done — kept for reference)

This bootstrap is complete: `@aihq/harness` is live on npm and publishing is OIDC-only
([#37](https://github.com/samartomar/ai-harness/issues/37), closed).

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

Tracked in [#37](https://github.com/samartomar/ai-harness/issues/37) (closed). No npm token
is ever stored; after the bootstrap, publish is OIDC-only.

## Cut a release

1. **Land all scope.** The milestone for this version should have no open blockers
   ([Milestones](https://github.com/samartomar/ai-harness/milestones)).
2. **Set the version** — use `npm version X.Y.Z --no-git-tag-version` so
   `package.json` and `package-lock.json` stay coherent, then bump the hardcoded CLI
   constant. These places must match; see the check below:
   - `package.json` `version`
   - `package-lock.json` root/package version
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

`release.yml` picks the dist-tag from the version: a **pre-release** (any version containing
`-`, e.g. `X.Y.Z-rc.1`) publishes under `next` and never touches `latest`; a stable version
publishes to `latest`. So tagging `vX.Y.Z-rc.1` ships a pilot build automatically. Dist-tags
can also be moved by hand:

```bash
npm dist-tag add @aihq/harness@X.Y.Z next     # or publish the rc with --tag next
# after pilots pass:
npm dist-tag add @aihq/harness@X.Y.Z latest
```

## If something goes wrong

- **Never re-tag a published version.** npm and provenance treat `X.Y.Z` as immutable. Fix
  forward with `X.Y.Z+1`.
- A bad `latest` can be pointed back with `npm dist-tag add @aihq/harness@<good> latest`; a
  published version can be **deprecated** (`npm deprecate`) but not deleted.
- If a tag was pushed by mistake before publish completed, delete the tag
  (`git push origin :vX.Y.Z`) and the draft Release, fix, and re-tag.

## Version coherence (guardrail)

`src/program.ts` holds `VERSION` as a constant, separate from `package.json`, and
`package-lock.json` also records the root package version. The four-way release check is:
`program.ts VERSION === package.json version === package-lock root version === tag`.
`tests/version.test.ts` pins the first three values (a mismatch fails `npm run verify`,
CI, and the release workflow's verify step), and the release workflow refuses a tag that
does not match `package.json`. Steps 5–6 above catch any drift locally, before the tag
exists — do not skip them.
