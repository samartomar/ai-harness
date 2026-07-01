# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Use GitHub's [private vulnerability reporting](https://github.com/samartomar/ai-harness/security/advisories/new)
  (the repo's **Security → Report a vulnerability**), or
- contact the maintainer via their GitHub profile.

Include the affected version/commit, reproduction steps, impact, and any suggested
fix. We aim to acknowledge within a few days.

## Supported versions

Which versions receive security fixes is set by the [versioning policy](VERSIONING.md).
While the project is pre-1.0, **only the latest minor release** is supported — upgrade to
the newest `0.x` to receive fixes. At 1.0, security backports extend to the previous minor
(N-1). Fixes ship as a patch on the supported line(s), documented in the
[CHANGELOG](CHANGELOG.md) under **Security**.

## Design — safe by default

`aih` is a **local** CLI that prepares repos/workstations for AI-assisted coding.
Its threat model is built into the action model:

- **Dry-run by default.** Nothing is written and no command runs without `--apply`.
- **No remote mutation.** No action kind can authenticate to, provision, or mutate a
  remote system. Cloud/SSO/gateway setup is emitted as **documentation**, never run.
- **Local exec is opt-in and reviewable.** Under `--apply`, `exec` actions run LOCAL
  commands only (e.g. `npx ecc-install`, `bash .kiro/install.sh`, `git config`).
  The dry-run plan shows every command before you apply it.
- **Secrets.** The harness never reads or emits plaintext secrets; it generates
  deny-lists (`.claudeignore`, `.claude/settings.json`) and secret-scanning config
  (`.gitleaks.toml`) instead.
- **Generated installer commands** (ECC/Superpowers/Kiro) are exactly the upstream
  projects' documented commands — review them, and prefer your org's internal mirror.

If you find a way for an `aih` command to mutate a remote system, run an unexpected
command, or exfiltrate data, that is a security bug — please report it.
