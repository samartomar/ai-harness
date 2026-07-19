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

## Methodology projection baseline boundary

The internal Phase 4 generation store handles crashes and interruption, multiple
cooperating AIH processes, stale plans or changed admitted bytes, accidental
external edits it detects, path escape, destination collision, incomplete
generations, corrupt ownership records, and hostile bytes handled as inert data.
For filesystem aliases, it fails closed on conditions observable through its
bounded Node `lstat`, `realpath`, descriptor-metadata, same-device, and link-count
checks. This includes symbolic links, hard links, and junction/reparse aliases
when those APIs report a link, changed realpath, changed device or identity, or a
non-single-link file; it is not a claim to enumerate every reparse form.

Apply uses private staging, verifies the exact content-addressed generation
before publication, and atomically publishes only complete old-or-new
regular-file generation-selection bytes. During apply, the previously selected
generation bytes are not changed in place and remain intact on failure; the
prior selection is not promised to remain selected when the complete next record
was already published. Clean retains rather than deletes active, unknown,
drifted, linked, incomplete, or otherwise uncertain objects.

On POSIX systems AIH creates store directories and files with modes `0700` and
`0600`; reopen rejects group/other-writable directories and
group/other-writable or executable files. On Windows, containment relies on the
ordinary-path and alias conditions visible through the Node checks above plus
exact-byte verification. This phase makes no Windows ACL assurance and no
general reparse-point guarantee.

The baseline explicitly excludes a malicious process already executing with the
same OS identity and write authority over the projection root. It provides
transactional integrity, containment, deterministic verification, and detection
of changes observable through the checks above within that cooperative boundary;
it is not tamper-proof against a compromised user account. A stronger enterprise
claim requires a broker, protected mount, sandbox, or dedicated OS identity. A
native addon loaded into the same ordinary AIH process does not create that
authority separation.

This is an internal library boundary only. It adds no apply/clean CLI, provider
reader or execution, host mapping or launch, installation, activation, or
shipped switching behavior.

If you find a way for an `aih` command to mutate a remote system, run an unexpected
command, or exfiltrate data, that is a security bug — please report it.
