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
   git checkout -- package.json src/version.ts
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

1. **Soft-lock and sweep.** Comment `cut in progress from <full-main-SHA>` on the
   release tracker issue (parallel sessions hold merges and cuts until done). Then run
   `npm run release:preflight -- --intent <patch|minor|major>` — it validates the
   sweep mechanically (labels, milestone drift both directions, open blockers,
   tracker presence, gate-bypassing commits, version coherence, revert pairs),
   compares the declared scope with the computed bump, and emits the cut manifest
   to paste into the tracker. If the computed class exceeds intent, stop and record
   the maintainer's decision in the tracker; after explicit approval, rerun with
   `--ack-intent-escalation <token>` using the exact token emitted in the manifest.
   The token binds candidate SHA, declared intent, and computed bump; acknowledgement
   never changes the label-derived bump. The cut set
   is the merged PRs reachable from `main` since the previous tag —
   open, deferred, or partial work never affects the version. Reconcile the open `next-release` train
   milestone ([Milestones](https://github.com/samartomar/ai-harness/milestones)) to that
   git truth: every merged PR since the last tag is in it and carries exactly one
   `semver:*` label (issueless Dependabot/docs PRs are labeled directly); every
   still-open issue is moved to the successor with a reason, or carries `blocked:*`.
   Nothing is skipped silently. Corollary: **merged means ships** — WIP stays in draft
   PRs or behind flags, and regrets are reverted before the cut, not deferred.
2. **Compute the bump and roll the train — atomically.** The bump is the highest
   `semver:*` class among the merged PRs (a merged revert pair cancels out; label
   semantics in [VERSIONING.md](VERSIONING.md)). Then in one motion: rename the train
   milestone to `vX.Y.Z`, create the successor `next-release`, and move all open items
   across — no trainless window. Milestones are theme-named until this rename; a
   version number never appears on a milestone earlier than this.
3. **Set the version** — use `npm version X.Y.Z --no-git-tag-version` so
   `package.json` and `package-lock.json` stay coherent, then bump the hardcoded CLI
   constant. These places must match; see the check below:
   - `package.json` `version`
   - `package-lock.json` root/package version
   - `src/version.ts` `VERSION`
4. **Update the CHANGELOG.** Move `[Unreleased]` items into a new `## [X.Y.Z] - YYYY-MM-DD`
   section under the right headings (Added / Changed / Deprecated / Removed / Fixed /
   Security). Update the compare links at the bottom (add the new version's link and
   repoint `[Unreleased]`).
5. **Refresh versioned surfaces and user-facing docs.** Version wording in the README
   (including image alt text) and in `docs/assets/*.svg` must be updated to `X.Y.Z` —
   the version-coherence test fails `npm run verify` on stale strings. If the release
   adds or changes any command or flag, update the README command reference and any
   affected `docs/` page **in this same release PR** — the CHANGELOG records the change,
   it does not document the feature. (The v0.3.0→v0.3.1 `aih prune` gap and stale SVG
   wording shipped in an earlier tarball are why this step exists.)
6. **Verify locally:** `npm run verify` (typecheck · lint · test+coverage · build). Green
   only.
7. **Confirm versions agree:** `aih --version` (from `npm run build` output) must equal the
   `package.json` version and the tag you are about to push.
8. **Open the release tracker issue** as the last open item in the `vX.Y.Z` milestone.
   Its checklist records: included PRs + labels, previous tag + candidate SHA, local/CI
   verification, the publication authorization, tag/workflow, GitHub Release, npm
   publication, `aih verify-release`, and companion-docs reconciliation.
9. **Open a release PR** (`release/vX.Y.Z`) that says `Refs #<tracker>` — never
   `Closes` — get it green in CI, and merge to `main`.
10. **Obtain SHA-bound publication approval.** Publishing requires the maintainer's
    explicit
    `Authorize publishing vX.Y.Z from <full-main-SHA> using the swept vX.Y.Z milestone.`
    Merging the release PR is **not** permission to push the tag.
11. **Tag and push** (scope is frozen from here — anything further is the next train's).
    The `release-tags` ruleset protects `v*` tags against update and deletion; publish
    itself waits at the `npm-publish` environment's human approval gate:
   ```bash
   git checkout main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
12. **Watch the workflow.** The `release` run publishes to npm and creates the GitHub Release.
   If the `npm-publish` environment has a required reviewer, approve it.
13. **Verify the published package:**
   ```bash
   npm view @aihq/harness@X.Y.Z
   npm audit signatures        # provenance + integrity
   aih verify-release X.Y.Z
   ```
14. **Close on evidence — not at tag.** Only after the workflow succeeded, the GitHub
    Release exists, npm serves the exact version, and `aih verify-release X.Y.Z` passes:
    complete the tracker checklist, close the tracker, then close the `vX.Y.Z`
    milestone. If publication fails permanently, never re-tag — fix forward to
    `X.Y.Z+1`, close the milestone as superseded-not-released with a note, and re-board
    its content on the successor train.
15. **Sync project tracking.** Reconcile the private companion repo's truth homes
    (release history, feature-by-release mapping, current state, pipeline) and run its
    docs validation to green; record any notable decision in memory, so the next session
    resumes from an accurate state (not just the code). This closes the loop the
    CHANGELOG and milestone don't cover.

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

`src/version.ts` holds `VERSION` as a constant, separate from `package.json`, and
`package-lock.json` also records the root package version. The four-way release check is:
`version.ts VERSION === package.json version === package-lock root version === tag`.
`tests/version.test.ts` pins the first three values (a mismatch fails `npm run verify`,
CI, and the release workflow's verify step), and the release workflow refuses a tag that
does not match `package.json`. Steps 5–6 above catch any drift locally, before the tag
exists — do not skip them.
