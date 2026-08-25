# Releasing

How a maintainer cuts a release. The heavy lifting is automated: pushing a `v-core-*` tag runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which verifies the gates,
packs a tarball + SHA256 checksum + SPDX SBOM, attests build provenance (keyless OIDC),
signs the checksum file with keyless cosign, smoke-installs the tarball, publishes to npm
via Trusted Publishing with `--provenance`, and creates the GitHub Release with generated
notes and the artifacts attached: the tarball, `SHA256SUMS.txt` (+ its cosign signature
bundle `SHA256SUMS.txt.sigstore.json`), `provenance.intoto.jsonl`, and `aih-sbom.spdx.json`.

Your job is everything up to the tag.

## Choose the release channel

Stable-direct is the default release path after every mechanical gate passes and
the exact SHA-bound publication approval is recorded. Use a release candidate
before stable when the cut includes any of these higher-risk conditions:

- a major-version or schema migration;
- a change to an evidence format;
- a change to publishing machinery; or
- behavior that has not received adequate production-equivalent verification.

An RC follows the same preflight, CI, authorization, immutability, and verification
rules as a stable cut. It publishes under `next` and never touches `latest`; promoting
to stable is a separate cut with its own exact-SHA approval. A maintainer may also
choose an RC for any other cut when extra observation would be useful.

## Package bootstrap state

The historical `@aihq/harness` bootstrap is complete and its v6.1.0 release remains
immutable. That legacy package is frozen; do not publish another version under it.
The replacement `@aihq/core` package is not yet present on npm. Its package line
starts at `0.1.0`, uses `v-core-X.Y.Z` GitHub tags, and has an additional owner-only
bootstrap gate.

1. **Keep the existing scope controls.** The `@aihq` organization and maintainer account
   retain 2FA. Do not create a throwaway package version or publish from a working tree.
2. **Prepare the exact release candidate.** Complete the release PR, merge it, obtain the
   full-SHA publication authorization in step 10 below, and verify the exact packed bytes.
3. **Configure trusted publishing with npm CLI 11.5.1 or later.** An authenticated scope
   owner runs the following commands and verifies the returned binding before any tag:
   ```bash
   npm trust github @aihq/core --file release.yml --repo samartomar/ai-harness --env npm-publish --allow-publish
   npm trust list @aihq/core
   ```
   The binding must name repository `samartomar/ai-harness`, workflow `release.yml`,
   environment `npm-publish`, and permission `npm publish`. If npm refuses the binding
   because the package does not yet exist, stop. Do not fall back to unprovenanced local
   publication; define and separately approve an exact-SHA, one-use GitHub bootstrap path.
4. **Confirm the GitHub gate.** The `npm-publish` environment requires a reviewer. The
   existing immutable `v*` tag ruleset covers Core tags, and the release workflow
   narrows its trigger to `v-core-*`. The workflow keeps `id-token: write`, uses a
   GitHub-hosted runner, and publishes the exact packed tarball with public access.
5. **Lock down after the first verified release.** Confirm npm provenance, then set the
   package's publishing access to require 2FA and disallow tokens. Separately deprecate
   `@aihq/harness` only after the replacement release is publicly installable and verified.

The npm package creation/trust action, GitHub environment approval, tag, release, legacy
deprecation, and any temporary credential path are owner actions. Each requires the exact
version and SHA named by the release tracker; source approval alone is not publication approval.

## Cut a release

1. **Soft-lock and sweep.** Comment `cut in progress from <full-main-SHA>` on the
   release tracker issue (parallel sessions hold merges and cuts until done). Then run
   `npm run release:preflight -- --intent <patch|minor|major>` — it validates the
   sweep mechanically (labels, milestone drift both directions, open blockers,
   tracker presence, gate-bypassing commits, version coherence, revert pairs),
   compares the declared scope with the computed bump, and emits the cut manifest
   to paste into the tracker. If the computed class exceeds intent, stop and record
   the maintainer's decision in the tracker. An authorized repository owner, member,
   or collaborator must post the exact token emitted in the manifest as a comment on
   that release tracker, then rerun with
   `--ack-intent-escalation-comment <GitHub-issue-comment-URL>`. Preflight resolves the
   comment through GitHub and records its repository, tracker issue, immutable comment
   ID and URL, author and repository authority, creation timestamp, and exact token in
   the cut manifest. The token remains bound to candidate SHA, declared intent, and
   computed bump; acknowledgement never changes the label-derived bump.

   A fully credentialed runner can still post this comment itself. The control creates
   public, timestamped, attributable evidence and removes an invisible
   self-acknowledgement flag; it is not automation-proof authorization. The cut set
   is the merged PRs reachable from `main` since the previous Core tag — for the
   first Core cut only, since the final legacy `v6.1.0` tag —
   open, deferred, or partial work never affects the version. Reconcile the open `next-release` train
   milestone ([Milestones](https://github.com/samartomar/ai-harness/milestones)) to that
   git truth: every merged PR since the last tag is in it and carries exactly one
   `semver:*` label (issueless Dependabot/docs PRs are labeled directly); every
   still-open issue is moved to the successor with a reason, or carries `blocked:*`.
   Nothing is skipped silently. Corollary: **merged means ships** — WIP stays in draft
   PRs or behind flags, and regrets are reverted before the cut, not deferred.
2. **Compute the bump and roll the train — atomically.** The bump is the highest
   `semver:*` class among the merged PRs (a merged revert pair cancels out; label
   semantics in [VERSIONING.md](VERSIONING.md)). For the first Core cut, preflight
   preserves that risk class but reports the explicit new-line bootstrap version
   `0.1.0`; later cuts compute from the preceding `v-core-*` tag. Then in one motion: rename the train
   milestone to `v-core-X.Y.Z`, create the successor `next-release`, and move all open items
   across — no trainless window. Milestones are theme-named until this rename; a
   version number never appears on a milestone earlier than this.
   After the rollover, every later preflight must name the versioned cut milestone,
   for example `npm run release:preflight -- --milestone v-core-X.Y.Z --intent <patch|minor|major>`;
   the new `next-release` milestone is the successor train and must not be swept into the cut.
3. **Set the version** — use `npm version X.Y.Z --no-git-tag-version` when the
   candidate does not already carry that exact version (the first Core candidate
   already carries `0.1.0`) so
   `package.json` and `package-lock.json` stay coherent, then bump the hardcoded CLI
   constant. These places must match; see the check below:
   - `package.json` `version`
   - `package-lock.json` root/package version
   - `src/version.ts` `VERSION`
4. **Update the CHANGELOG.** Move `[Unreleased]` items into a new
   `## [Core X.Y.Z] - YYYY-MM-DD`
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
   `package.json` version and the version suffix of the Core tag you are about to push.
8. **Open the release tracker issue** as the last open item in the `v-core-X.Y.Z` milestone.
   Its checklist records: included PRs + labels, previous tag + candidate SHA, local/CI
   verification (including `npm run release:preflight -- --milestone v-core-X.Y.Z --intent <patch|minor|major>`), the publication authorization, tag/workflow, GitHub Release, npm
   publication, `aih verify-release`, and companion-docs reconciliation.
9. **Open a release PR** (`release/v-core-X.Y.Z`) that says `Refs #<tracker>` — never
   `Closes` — get it green in CI, and merge to `main`.
10. **Obtain SHA-bound publication approval.** Publishing requires the maintainer's
    explicit
    `Authorize publishing @aihq/core@X.Y.Z from <full-main-SHA> using the swept v-core-X.Y.Z milestone.`
    Merging the release PR is **not** permission to push the tag.
11. **Tag and push** (scope is frozen from here — anything further is the next train's).
    The `release-tags` ruleset protects `v*` tags against update and deletion; publish
    itself waits at the `npm-publish` environment's human approval gate:
   ```bash
   git checkout main && git pull
   git tag v-core-X.Y.Z
   git push origin v-core-X.Y.Z
   ```
12. **Watch the workflow.** The `release` run publishes to npm and creates the GitHub Release.
   If the `npm-publish` environment has a required reviewer, approve it.
13. **Verify the published package:**
   ```bash
   npm view @aihq/core@X.Y.Z
   npm audit signatures        # provenance + integrity
   aih verify-release X.Y.Z
   ```
   The verifying environment needs an authenticated `gh`, plus `npm` and `cosign` on
   `PATH` (`winget install sigstore.cosign` / `brew install cosign`) — without cosign,
   `verify-release` degrades its signature-bundle leg to a skip instead of verifying it.
14. **Close on evidence — not at tag.** Only after the workflow succeeded, the GitHub
    Release exists, npm serves the exact version, and `aih verify-release X.Y.Z` passes
    with zero skipped legs (a skip is a prerequisite gap in the verifying environment,
    not a pass — equip it and re-run):
    complete the tracker checklist, close the tracker, then close the `v-core-X.Y.Z`
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
publishes to `latest`. So tagging `v-core-X.Y.Z-rc.1` ships a pilot build automatically. Dist-tags
can also be moved by hand:

```bash
npm dist-tag add @aihq/core@X.Y.Z next     # or publish the rc with --tag next
# after pilots pass:
npm dist-tag add @aihq/core@X.Y.Z latest
```

## If something goes wrong

- **Never re-tag a published version.** npm and provenance treat `X.Y.Z` as immutable. Fix
  forward with `X.Y.Z+1`.
- A bad `latest` can be pointed back with `npm dist-tag add @aihq/core@<good> latest`; a
  published version can be **deprecated** (`npm deprecate`) but not deleted.
- If a tag was pushed by mistake or publication fails, do not delete, move, or reuse
  the protected tag. Preserve the failed run as lifecycle evidence, fix forward to a
  new version, and supersede any draft Release or milestone with an explicit failure note.

## Version coherence (guardrail)

`src/version.ts` holds `VERSION` as a constant, separate from `package.json`, and
`package-lock.json` also records the root package version. The four-way release check is:
`version.ts VERSION === package.json version === package-lock root version === the version suffix of v-core-X.Y.Z`.
`tests/version.test.ts` pins the first three values (a mismatch fails `npm run verify`,
CI, and the release workflow's verify step), and the release workflow refuses a tag that
does not match `package.json`. Steps 5–6 above catch any drift locally, before the tag
exists — do not skip them.
