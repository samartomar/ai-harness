# Release SLSA assessment

> Status: shipped release-assurance claim. Assessed on 2026-07-07 against the
> SLSA v1.2 Build track. This document covers tagged artifacts produced by
> `.github/workflows/release.yml`; it does not claim a SLSA Source level.

## Claim

Tagged release artifacts produced by the release workflow meet **SLSA Build L2**
when the workflow completes successfully.

Scope:

- the `@aihq/harness` npm tarball published by the release workflow;
- the same packed tarball attached to the GitHub Release;
- `SHA256SUMS.txt`, `SHA256SUMS.txt.sigstore.json`, `provenance.intoto.jsonl`,
  and `aih-sbom.spdx.json` attached to the GitHub Release.

No Build L3 claim is made.

## Requirement assessment

The current SLSA specification is v1.2. Its Build track requires provenance for
L1, signed provenance from a hosted build platform for L2, and a hardened build
platform with stronger isolation controls for L3.

| SLSA v1.2 Build requirement | Repo evidence | Assessment |
| --- | --- | --- |
| Producer chooses an appropriate build platform | `.github/workflows/release.yml` runs the release job on `ubuntu-latest` and publishes through the `npm-publish` environment. | Meets L1/L2 scope. |
| Producer follows a consistent build process | The workflow runs only on `v*` tags, asserts `package.json` matches the tag, runs artifact guard, ECC installer check, typecheck, lint, coverage tests, build, pack, checksum, SBOM, provenance, smoke install, npm publish, and GitHub Release upload in one job. | Meets L1/L2 scope. |
| Producer distributes provenance | The workflow publishes npm provenance with `npm publish ./*.tgz --provenance --access public`, generates GitHub build provenance with `actions/attest-build-provenance`, copies the bundle to `provenance.intoto.jsonl`, and attaches it to the GitHub Release. | Meets L1/L2 scope. |
| Build platform generates provenance | `actions/attest-build-provenance` targets `./*.tgz`, while npm Trusted Publishing emits registry provenance for the published package. | Meets L1/L2 scope. |
| Provenance is authentic | The release job has `id-token: write` and `attestations: write`, uses npm Trusted Publishing instead of an npm token, and signs `SHA256SUMS.txt` keylessly with GitHub OIDC into `SHA256SUMS.txt.sigstore.json`. | Meets L2 scope. |
| Hosted build platform | The release job uses GitHub-hosted `ubuntu-latest`; artifacts are not produced on a developer workstation. | Meets L2 scope. |
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
- publishing uses npm Trusted Publishing instead of `NPM_TOKEN`;
- keyless signing uses GitHub OIDC rather than a checked-in or long-lived key;
- the tarball is smoke-installed before publish;
- release consumers get a local verification command and the raw provenance
  artifacts needed for stricter external policy.

## Verification commands

After a tag is released:

```bash
npm audit signatures
aih verify-release <version>
gh attestation verify <downloaded-tarball.tgz> --repo samartomar/ai-harness
```

`aih verify-release` is the packaged convenience gate for the install path. A
consumer with a formal SLSA policy should additionally verify the provenance
attestation against its expected builder identity and release workflow.
