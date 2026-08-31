# Support

## Getting help

- **Questions & usage** — open a [GitHub issue](https://github.com/samartomar/ai-harness/issues/new/choose)
  with the `question` label, or start a [Discussion](https://github.com/samartomar/ai-harness/discussions).
- **Bugs** — open an issue with reproduction steps, the `aih` version (`aih --version`),
  your OS, and the CLI you were targeting. `aih doctor` output helps.
- **Security** — do not open a public issue; follow [SECURITY.md](SECURITY.md).
- **Feature requests & roadmap** — open an issue with the `roadmap` label; see
  [ROADMAP.md](ROADMAP.md).

## What is supported

Which versions receive fixes is defined in [VERSIONING.md](VERSIONING.md). While pre-1.0,
the promoted stable train is supported. A candidate under npm `next` is available for
evaluation but is not the supported default and does not require every consumer to upgrade.

## Response expectations

This is a community open-source project maintained on a best-effort basis by volunteers.
Issues and pull requests are handled best-effort only; security reports are prioritized.

There is **no paid support, no SLA, no consulting, and no implementation service**, and using
this project or filing an issue creates **no service relationship** of any kind. See
[DISCLAIMER.md](DISCLAIMER.md).

## Before you file

- Run `aih doctor` and include the output.
- Resolve the promoted version with `npm view @aihq/core dist-tags.latest`, obtain your
  organization's approval for that exact version, then run
  `npm install -g @aihq/core@<approved-version>` followed by
  `aih verify-release <approved-version>`. A skipped verification leg is incomplete
  evidence.
- Search [existing issues](https://github.com/samartomar/ai-harness/issues?q=is%3Aissue)
  first.
