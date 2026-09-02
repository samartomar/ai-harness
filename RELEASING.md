# Releasing

How a maintainer qualifies, publishes, and promotes a release. The complete model is in
[Delivery governance](https://github.com/samartomar/ai-harness/blob/main/docs/DELIVERY_GOVERNANCE.md). Pushing an annotated `v-core-*` tag runs the
read-only qualification side of
[`release.yml`](https://github.com/samartomar/ai-harness/blob/main/.github/workflows/release.yml).
It requires successful protected-main CI at the tagged SHA, validates the enterprise adoption
decision manifest, packs once, installs that artifact across the supported operating-system and Node
matrix, creates its SBOM, and seals a digest-bound qualification receipt. **A tag push cannot publish
to npm.** A later manual dispatch must resolve an exact owner authorization comment on the release
tracker before the protected job may publish the already-qualified bytes under `next` and create the
prerelease GitHub Release.

The release is not stable merely because the tag workflow succeeds. The owner also
controls the later promotion of the same accepted bytes from `next` to `latest`.

## Candidate-first release channel

Candidate-first is mandatory. Every stable or prerelease version is first published
under `next`; the tag workflow never changes `latest`. Publication makes the exact
immutable bytes publicly installable with provenance, but it does not recommend them
as the default install. Public installed acceptance then exercises those same registry
bytes with the compatible Scanner and Catalog baseline. Only after that evidence passes
may the owner give a separate SHA-bound promotion authorization and promote the same
immutable version to `latest`. Promotion never rebuilds, republishes, or retags.

The distinction is deliberate:

- **merge** integrates a reviewed change;
- **cut** groups a coherent release train and assigns one version;
- **candidate publication** exposes exact bytes under `next`;
- **promotion** changes the supported default after installed acceptance.

Ordinary work accumulates in the open train. Documentation, tests, CI, and repository tooling marked
`semver:none` cannot trigger a package cut. A maintainer may open a narrower train when delaying a
coherent enterprise outcome would cause material installed-user harm, but the same evidence,
qualification, publication, acceptance, and promotion boundaries still apply. No calendar interval,
minimum soak period, or issue label creates release authority.

## Package bootstrap state

The historical `@aihq/harness@6.1.0` package is frozen and npm-deprecated; do not
publish another version under that name. Direct consumers to `@aihq/core`.
Core restarts package numbering at `0.1.0` and uses
`v-core-X.Y.Z` GitHub tags. The immutable `v-core-0.1.0` attempt passed its
read-only candidate job, but npm refused publication with `EOTP`. Preserve that
tag and run as audit evidence; never delete, move, or reuse them.

The separately authorized `@aihq/core@0.1.1` fix-forward is now public on npm
and has a matching GitHub Release. npm exposes provenance for the package, and
the Release carries the exact tarball, checksum, checksum signature bundle,
GitHub provenance bundle, and SPDX SBOM. The one-use package-creation path is
spent. Its GitHub bootstrap secret is absent, and the workflow source rejects
token credentials at the publication boundary. Never recreate that path.

The remaining owner transition is:

1. Using npm CLI 11.15.0 or later and an interactive npm login that can satisfy
   account 2FA, create and observe the exact publisher binding:
   ```bash
   npm trust github @aihq/core --file release.yml --repo samartomar/ai-harness --env npm-publish --allow-publish
   npm trust list @aihq/core
   ```
2. Confirm the returned binding names repository `samartomar/ai-harness`,
   workflow `release.yml`, environment `npm-publish`, and allowed action
   `npm publish`.
3. After observing the binding, revoke the short-lived npm token used for package
   creation, then set package publishing access to require 2FA and disallow tokens.

Future Core tags remain blocked until that exact trust tuple is observed. The
steady-state workflow has no token fallback: without a valid npm Trusted
Publisher binding, `npm publish` must fail closed. Package trust configuration,
GitHub environment approval, tag creation, publication, and legacy deprecation
remain owner actions tied to the exact version and SHA in the release tracker;
source approval alone is not publication approval.

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
   `semver:none|patch|minor|major` label (issueless Dependabot/docs PRs are labeled
   directly); every
   still-open issue is moved to the successor with a reason, or carries `blocked:*`.
   Nothing is skipped silently. Corollary: **merged means ships** — WIP stays in draft
   PRs or behind flags, and regrets are reverted before the cut, not deferred.
2. **Compute the bump and roll the train — atomically.** `semver:none` records a
   repository-only change and does not request package bytes. A cut containing only
   `semver:none` changes is refused. Otherwise the bump is the highest package-bearing
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
   candidate does not already carry that exact version so
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
5. **Audit user-facing documentation; do not repair product documentation inside release prep.**
   README, guides, SVGs, tests, and repository contracts must have changed with the PR that changed
   their behavior and must not assert mutable registry truth or repeat a release number merely for
   display. If the sweep finds a missing behavior update, stop: merge a normal, accurately labeled PR
   before rebuilding the mechanical release branch. The release-preparation allowlist permits only
   version metadata, release notes, support/versioning text, and the enterprise manifest; it cannot
   smuggle a late product or trust-boundary change. The CHANGELOG records a change but never replaces
   its owning documentation.
6. **Verify locally:** `npm run verify` (typecheck · lint · test+coverage · build). Green
   only.
7. **Confirm versions agree:** `aih --version` (from `npm run build` output) must equal the
   `package.json` version and the version suffix of the Core tag you are about to push.
8. **Open the release tracker issue** as the last open item in the `v-core-X.Y.Z` milestone.
   Its checklist records: included PRs + labels, previous tag + candidate SHA, local/CI
   verification (including `npm run release:preflight -- --milestone v-core-X.Y.Z --intent <patch|minor|major>`), the publication authorization, tag/workflow, GitHub Release, npm
   candidate publication, public installed acceptance, `latest` promotion,
   `aih verify-release`, and companion-docs reconciliation.
9. **Open one release PR for the whole train** (`release/v-core-X.Y.Z`) that says
   `Refs #<tracker>` — never `Closes` — get it green in CI, and merge to `main`.
   Do not cut another release merely because one ordinary fix merged; the next train remains open
   until it contains one coherent enterprise adoption decision unit.
10. **Freeze the candidate with an annotated tag.** Tag creation is a distinct maintainer decision;
    merge approval does not imply it. The `release-tags` ruleset protects `v*` tags against update
    and deletion:
   ```bash
   git checkout main && git pull
   git tag -a v-core-X.Y.Z -m "Core X.Y.Z candidate"
   git push origin v-core-X.Y.Z
   ```
11. **Qualify without publishing.** The tag-triggered run validates the enterprise manifest,
    protected-main CI, package candidate, installed OS/Node matrix, SBOM, artifact custody, tag
    object, and source SHA. It emits a qualification receipt and an exact `AIH-PUBLISH-V1 ...`
    token. No job in a tag-triggered run has npm publication authority.
12. **Authorize and publish exact qualified bytes.** The repository owner posts the complete
    publication token on its own line in the release tracker. Dispatch `release.yml` at the qualified
    tag ref with the tag, qualification run ID/attempt, and exact issue-comment URL. The workflow
    rejects any other dispatch revision, resolves the comment,
    rejects a rejected or superseded candidate, re-observes protected-main ancestry and artifact
    custody, seals recovery evidence, and only then uses npm Trusted Publishing to publish the exact
    tarball under `next` and create a prerelease GitHub Release. It never changes `latest`.
13. **Run public installed acceptance.** Dispatch `installed-acceptance.yml` at the qualified tag ref
    with exact Core, Scanner, and Catalog versions and the qualification run identity. It installs only public
    registry packages in disposable roots across the OS/Node matrix and requires npm provenance,
    `aih --version`, `aih --help`, and `aih verify-release` with zero skipped legs. Useful manual
    re-observation remains:
   ```bash
   npm view @aihq/core@X.Y.Z
   aih verify-release X.Y.Z
   ```
   The verifying environment needs an authenticated `gh`, plus `npm` and `cosign` on
   `PATH` (`winget install sigstore.cosign` / `brew install cosign`) — without cosign,
   `verify-release` degrades its signature-bundle leg to a skip instead of verifying it.
    A source checkout or local tarball cannot satisfy this gate.
14. **Authorize promotion separately.** Installed acceptance emits an exact
    `AIH-PROMOTE-V1 ...` token. The owner posts it on its own line in the same tracker, then dispatches
    `promotion-authorization.yml` with the qualification and acceptance run identities and the exact
    comment URL, again at the qualified tag ref. That read-only workflow re-observes the registry candidate and GitHub prerelease.
    npm Trusted Publishing authorizes `npm publish`, not dist-tag operations, so use the workflow's
    exact printed commands in an interactive npm session that satisfies package 2FA:

    ```bash
    npm dist-tag add @aihq/core@X.Y.Z latest
    npm dist-tag rm @aihq/core next
    gh release edit v-core-X.Y.Z --repo samartomar/ai-harness --prerelease=false --latest
    npm view @aihq/core dist-tags --json
    ```
15. **Close on promoted evidence — not at tag or candidate publication.** Only after qualification,
    candidate publication, exact public installed acceptance,
    `aih verify-release X.Y.Z` passed with zero skipped legs, and npm/GitHub re-observation
    shows the same version as stable may the tracker and milestone close. If candidate
    publication fails or acceptance finds a defect, never re-tag and never promote it;
    fix forward, optionally deprecate the rejected version with a precise message, and
    preserve the evidence.
16. **Sync project tracking.** Reconcile the private companion repo's truth homes
    (release history, feature-by-release mapping, current state, pipeline) and run its
    docs validation to green; record any notable decision in memory, so the next session
    resumes from an accurate state (not just the code). This closes the loop the
    CHANGELOG and milestone don't cover.

## Dist-tags are state, not urgency

The release workflow always publishes under `next`, including a normal stable SemVer
candidate. `latest` identifies only the most recently promoted stable train. Neither a
larger version nor presence in the registry means every consumer must upgrade; release
notes separately classify adoption as no action, recommended, required by date, or
security urgent. A prerelease suffix remains useful for intentionally unstable API work,
but it is not required merely to obtain the candidate-first safety boundary.

## If something goes wrong

- **Never re-tag a published version.** npm and provenance treat `X.Y.Z` as immutable. Fix
  forward with `X.Y.Z+1`.
- A rejected candidate remains off `latest`; a bad `latest` can be pointed back with
  `npm dist-tag add @aihq/core@<good> latest`; a
  published version can be **deprecated** (`npm deprecate`) but not deleted.
- If a tag was pushed by mistake or publication fails, do not delete, move, or reuse
  the protected tag. Preserve the failed run as lifecycle evidence, fix forward to a
  new version, and supersede any draft Release or milestone with an explicit failure note.
- If npm publication succeeded before the GitHub Release step failed, preserve the
  successful npm provenance and failed run, never retry that immutable npm version,
  and repair the missing GitHub Release only under separate exact-SHA authorization
  using the digest-bound artifacts from that run.

## Version coherence (guardrail)

`src/version.ts` holds `VERSION` as a constant, separate from `package.json`, and
`package-lock.json` also records the root package version. The four-way release check is:
`version.ts VERSION === package.json version === package-lock root version === the version suffix of v-core-X.Y.Z`.
`tests/version.test.ts` pins the first three values (a mismatch fails `npm run verify`,
CI, and the release workflow's package-specific proof), and the release workflow refuses a tag that
does not match `package.json`. The workflow and release-readiness tests also fail if a
candidate can update `latest` or create a stable GitHub Release before promotion.
