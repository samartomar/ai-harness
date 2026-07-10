# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Use GitHub's [private vulnerability reporting](https://github.com/samartomar/ai-harness/security/advisories/new)
  (the repo's **Security → Report a vulnerability**), or
- contact the maintainer via their GitHub profile.

Include the affected version/commit, reproduction steps, impact, and any suggested
fix. We aim to acknowledge within a few days.

## Supported versions

Which versions receive security fixes is set by the [versioning policy](VERSIONING.md):
only the latest minor receives fixes, and the fix path is upgrading to it.
Fixes ship as a patch on that line, documented in the [CHANGELOG](CHANGELOG.md)
under **Security**.

## Design — reviewable by default

`aih` is a **local** CLI that prepares repos/workstations for AI-assisted coding.
Its threat model is built into the seven action kinds: `write`, `doc`, `probe`,
`exec`, `envblock`, `digest`, and `remove`.

- **Dry-run by default for managed project changes.** Repo/workstation mutations are
  planned until `--apply`. Named output artifacts are deliberate exceptions:
  `--sarif <file>`, `--support-out <dir>`, and report outputs write the operator-named
  file; an initialized repo also appends the local run ledger unless `--no-log` or
  `AIH_LOG=0` is set. `--open`, `--refresh`, `--demo`, and `AIH_APPLY=1` intentionally
  opt into apply behavior. Plan-time commands are limited to fixed read-only probes,
  pinned by the plan-purity tests.
- **Remote mutation is absent except explicit signing.** Normal action kinds do not
  provision cloud resources or change remote services; cloud/SSO/gateway setup is
  emitted as **documentation**, never run. The opt-in signing paths are exceptions:
  GitHub attestations write to GitHub's attestation store, and keyless cosign signing
  can append to the public Rekor transparency log.
- **Local exec is opt-in and reviewable.** Under `--apply`, `exec` actions run local
  commands only (for example `npx ecc-install`, `bash .kiro/install.sh`, `git config`,
  or quarantined read-only fetches). The dry-run plan shows every command before you
  apply it.
- **Secrets.** The harness does not read `.env*` or root `secrets/**` contents
  during secret checks. It does inspect known MCP config files for hardcoded
  credential shapes and secret-looking key literals, but findings report only the
  file, key, and match kind — never the detected value. It also generates
  deny-lists (`.claudeignore`, `.claude/settings.json`) and secret-scanning config
  (`.gitleaks.toml`).
- **Generated installer commands** (ECC/Superpowers/Kiro) are exactly the upstream
  projects' documented commands — review them, and prefer your org's internal mirror.
- **Release provenance.** Tagged release artifacts produced by the release workflow
  claim SLSA Build L2 under the SLSA v1.2 Build track. Releases publish npm
  provenance, GitHub artifact attestations, an SPDX SBOM, checksums, and a
  keyless cosign bundle for `SHA256SUMS.txt`; the scoped assessment and Build L3
  gap are documented in [docs/security/release-slsa.md](docs/security/release-slsa.md).

If you find a way for an `aih` command to mutate a remote system, run an unexpected
command, or exfiltrate data, that is a security bug — please report it.
