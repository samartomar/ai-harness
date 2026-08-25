# Release SLSA assessment

> Status: release-workflow assessment. Reassessed on 2026-08-25 against the
> SLSA v1.2 Build track. Core has not yet produced a tagged release, so the
> `@aihq/core` result remains conditional on a successful workflow. This document
> does not claim a SLSA Source level.

## Claim

Tagged release artifacts produced by the release workflow meet **SLSA Build L2**
when the workflow completes successfully.

Scope:

- the `@aihq/core` npm tarball published by the release workflow after its
  separately authorized package bootstrap;
- the same packed tarball attached to the GitHub Release;
- `SHA256SUMS.txt`, `SHA256SUMS.txt.sigstore.json`, `provenance.intoto.jsonl`,
  and `aih-sbom.spdx.json` attached to the GitHub Release.

No Build L3 claim is made.

Historical releases through v6.1.0 used the frozen `@aihq/harness` package name;
their tag-pinned workflow and release evidence remain the authority for those
immutable artifacts. Core restarts package numbering at `0.1.0` and uses
`v-core-X.Y.Z` tags. This assessment does not claim that `@aihq/core` has already
been published.

## Requirement assessment

The current SLSA specification is v1.2. Its Build track requires provenance for
L1, signed provenance from a hosted build platform for L2, and a hardened build
platform with stronger isolation controls for L3.

| SLSA v1.2 Build requirement | Repo evidence | Assessment |
| --- | --- | --- |
| Producer chooses an appropriate build platform | `.github/workflows/release.yml` runs both release jobs on GitHub-hosted `ubuntu-latest` and publishes through the protected `npm-publish` environment. | Meets L1/L2 scope. |
| Producer follows a consistent build process | The workflow runs only on `v-core-*` tags. Its read-only job verifies current `origin/main` and package/tag identity, runs `npm run verify`, packs once, records the tarball digest, and smoke-installs the exact tarball. The protected job verifies the workflow-artifact digest, original tarball digest, and packed identity; runs no Core package code; and re-observes `main` and the tag immediately before publication. | Meets L1/L2 scope. |
| Producer distributes provenance | The workflow publishes npm provenance with `npm publish "$tarball" --ignore-scripts --provenance --access public`, generates GitHub build provenance with `actions/attest-build-provenance`, copies the bundle to `provenance.intoto.jsonl`, and attaches it to the GitHub Release. | Meets L1/L2 scope. |
| Build platform generates provenance | `actions/attest-build-provenance` targets the exact digest-checked tarball, while npm Trusted Publishing emits registry provenance for the same published tarball. | Meets L1/L2 scope. |
| Provenance is authentic | Only the protected publication job has `id-token: write` and `attestations: write`; it uses npm Trusted Publishing instead of an npm token and signs a checksum reconstructed from the carried tarball digest with GitHub OIDC. | Meets L2 scope. |
| Hosted build platform | Both jobs use GitHub-hosted `ubuntu-latest`; artifacts are not produced on a developer workstation. | Meets L2 scope. |
| Consumer verification path | `aih verify-release [version]` verifies npm signatures, GitHub release checksums, the cosign bundle over `SHA256SUMS.txt`, and the packed tarball hash. Consumers that enforce provenance policy can also verify the GitHub attestation for the tarball with `gh attestation verify`. | Supports L2 verification. |

## Remaining gaps

No Build L3 claim is made because this repository has not documented an
independent Build L3 assessment of GitHub-hosted runners or the GitHub
attestation control plane. In particular, the repo does not itself prove the
L3 requirements that tenants cannot influence overlapping or subsequent builds,
cannot tamper with build cache entries used by other builds, and cannot access
secret material used by the build platform to authenticate provenance.

The workflow is still intentionally hardened for an L2 claim:

- release actions are pinned by full commit SHA;
- candidate execution is isolated in a read-only job without publication authority;
- the protected job verifies the GitHub artifact digest, original tarball digest, and
  packed identity, then rechecks the tarball before each custody effect;
- the tag workflow fails closed unless current `main`, the tag, and the workflow SHA match;
- publishing uses npm Trusted Publishing instead of `NPM_TOKEN`;
- keyless signing uses GitHub OIDC rather than a checked-in or long-lived key;
- the tarball is smoke-installed in a disposable root before crossing into the protected job;
- release consumers get a local verification command and the raw provenance
  artifacts needed for stricter external policy.

## Release escalation acknowledgement

When the label-derived release bump exceeds the maintainer's declared intent,
release preflight requires a public comment on the established release tracker.
The comment must contain the exact candidate-SHA/declared-intent/computed-bump
token and come from an author whose GitHub repository association is `OWNER`,
`MEMBER`, or `COLLABORATOR`. Preflight validates the repository, tracker issue,
immutable comment ID and URL, author and association, creation timestamp, and
token through GitHub, then preserves that resolved artifact in the cut manifest.

This is attributable audit evidence, not automation-proof authorization. A fully
credentialed runner can still post the acknowledgement comment. The security gain
is that the escalation leaves public, timestamped evidence tied to a GitHub
identity instead of being accepted by an invisible local flag.

## Verification commands

After a tag is released:

```bash
aih verify-release <version>
gh attestation verify <downloaded-tarball.tgz> --repo samartomar/ai-harness
```

`aih verify-release` is the packaged convenience gate for the install path. It
covers the npm signature/provenance audit by installing the exact release into a
temporary prefix and running `npm audit signatures --prefix <temp>` there — a
bare `npm audit signatures` cannot verify a global install (npm refuses with
`EAUDITGLOBAL`). A consumer with a formal SLSA policy should additionally verify
the provenance attestation against its expected builder identity and release
workflow.
