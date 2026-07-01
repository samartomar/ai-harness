# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-01

First-developer experience plus a documentation and licensing-posture pass.

### Added

- **`aih ready` — first-developer readiness gate.** A single graded, blocker-aware verdict
  ("can a developer start work with an AI agent here, now?") composed from aih's existing
  read-only probes (runtime/TLS/PATH/core tools, per-CLI loadability, contract, secret scan).
  Diagnoses by default; the one auto-fixable blocker (missing `rg`/`fd`/`jq`) installs under
  confirmation. Adds a `sec-ready` panel to `aih report --v9`.
- **`aih prune` — remove stale per-CLI artifacts** when a CLI is no longer targeted. Dry-run
  preview by default; `--apply` moves aih-owned files to gitignored `.aih/legacy/` (reversible),
  subtracts aih's managed block in place from co-owned bootloaders (never deletes them), and
  leaves MCP/settings that carry no ownership marker as manual advisories. Introduces a
  fail-closed `remove` action (containment on source and destination, symlink refusal, backup +
  rollback, dirty-worktree guard). Diffed against committed intent only.

### Changed

- **Plan-time reads are modeled as ledgered, guarded probes** ([#35]): plan-shaping host/network
  reads stay in `plan()` but are pinned by a read-only allowlist test, so a run cannot shell out
  an arbitrary command at plan time.
- **`summarizeResult` reports honestly** when an `--apply` run commits no writes or execs
  ("nothing to apply") instead of claiming "Applied".

### Security

- **Emitted SARIF is validated against the SARIF 2.1.0 schema in CI** ([#36]) with a pinned,
  offline validator — invalid SARIF fails the build.

### Docs

- **Licensing / liability posture.** Added [`DISCLAIMER.md`](DISCLAIMER.md) (Apache-2.0, AS-IS,
  no warranty/SLA/indemnity/paid support), softened assurance wording across README/SECURITY/SUPPORT
  (no "safe/secure/guaranteed/enterprise-ready/production-ready"), and added DCO sign-off +
  contributor rules to [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **Public-docs hygiene.** Added [`PUBLIC_DOCS_POLICY.md`](PUBLIC_DOCS_POLICY.md) and a `docs/`
  tree for product / workspace / security / roadmap design docs.

[#35]: https://github.com/samartomar/ai-harness/issues/35
[#36]: https://github.com/samartomar/ai-harness/issues/36

## [0.2.0] - 2026-07-01

First release **published to npm** as [`@aihq/harness`](https://www.npmjs.com/package/@aihq/harness) —
`npm install -g @aihq/harness`. Each release ships build **provenance** (verify with
`npm audit signatures`), an **SPDX SBOM**, and a SHA256 checksum on the GitHub Release.

### Added

- **`aih trust` external-source trust gate** — `allow` / `list` / `pin` / `scan` / `verify`
  to review, pin, and gate external GitHub repos and skills before acquisition (danger
  grading, dependency-confusion + typosquat detection, incoming-MCP and secret scans, SARIF).
- **`aih report --v9` developer console** ships opt-in with LIVE / PREVIEW /
  EMPTY honesty states, machine-relative ECC inventory, MCP parity/egress,
  usage-by-CLI, heavy lifters, dormant ECC skills, remediation wins, no-JS
  honest rendering, and responsive browser-verified layout.
- **`aih usage --apply` per-tool metering hooks and `--rollup`.** The usage
  layer now writes idempotent local hooks for supported targeted CLIs, records
  local activity counts only (no prompts, args, or cost), and aggregates
  `.aih/usage.jsonl` across repos on demand.
- **`aih secrets --verify` is now a secret-scan CI gate.** Each detected plaintext
  secret (`.env*` / root `secrets/`) surfaces as a read-only `fail` probe, so
  `--verify` exits non-zero when secrets exist and `--sarif <file>` emits one
  error-level result per path (under a single `plaintext-secret` rule) for GitHub
  code-scanning. Probes stay read-only verdict carriers — no `exec`, no remote
  mutation, and only the offending path (never any secret value) is reported.

### Changed

- **First-run `ai-coding/` canon trimmed to a lean, evidence-first shape.** Dropped
  the ownership headers, NIST/OWASP/DORA "practice lineage" prose, definition-of-done
  checklists, and expanded file-family index that had crept into the scaffold — the
  generated canon stays small so it sharpens an agent's first diff instead of reading
  as markdown sprawl. Executable safety stays: `.env`/secrets denial, `aih secrets
  --verify`, large-repo graph-safety, and write-once author-owned canon.
- **Cross-CLI coherence shows a neutral `global` glyph for machine-local MCP.** A
  wired-but-global MCP (codex `~/.codex`, gemini `~/.gemini`) is no longer an amber
  `warn` — it is a distinct neutral marker that counts toward agreement, so a repo
  using those tools can reach 100% coherence. Genuine drift / missing / won't-load
  still surface as warn / bad.

### Fixed

- **`aih tools` pins `code-review-graph==2.3.6`** to match the pinned MCP runners, so the
  globally installed CLI can't drift past the graph the harness actually runs.
- **`aih report` and `aih doctor` grade every wired CLI by default, not just claude.**
  Without a committed `.aih-config.json`, coverage previously defaulted to claude and
  under-reported a repo wired for multiple tools. `resolveTargetSet` now infers the
  target set from the per-CLI adapter notes on disk, and `aih bootstrap-ai` persists
  the marker on a standalone run so the report reads the true intent.

### Security

- **Pinned transitive `esbuild` to `^0.28.1`** (npm `overrides`) to clear
  GHSA-g7r4-m6w7-qqqr (dev-server arbitrary file read on Windows). Dev-only —
  `esbuild` is a build-tool dependency (tsup / tsx / vite), never shipped in the CLI.

## 0.1.0 - 2026-06-24

Initial public cut of the Enterprise AI Bootstrapping Harness (`aih`) — a dry-run-first
CLI that bootstraps governed, proxy-safe AI coding into workstations and repos. Tagged on
GitHub but **never published to npm**; the first published release is 0.2.0.

### Added

- **Action model** — every command emits a reviewable plan of typed actions
  (`write` / `doc` / `probe` / `exec` / `envblock`). Dry-run by default; nothing is
  written without `--apply`. Local-only `exec` runs under `--apply`; no remote
  mutation or faked cloud provisioning. Idempotent skips + `.aih.bak` backups.
- **`aih init`** — one-shot bootstrap composing the scaffold, `ai-coding/` canon,
  ECC, Superpowers, and MCP phases. `--mcp-mode standard|offline|none`.
- **`aih bootstrap-ai`** — Layer-2 `ai-coding/` canon (RULE_ROUTER, adapters,
  shared canonical block, agent-behavior-core) plus a native bootloader per CLI:
  `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor MDC, Copilot instructions,
  `.windsurfrules`, and Kiro steering — all pointers into the single canon.
- **`aih ecc`** — installs affaan-m/ECC per selected CLI, scoped to the detected
  stack: `ecc-install` for cursor/zed, ECC's native scripts for Codex
  (`sync-ecc-to-codex.sh`) and Kiro (`.kiro/install.sh`), root-`AGENTS.md`
  auto-detect for OpenCode, and consult-routing for the rest.
- **`aih superpowers`** — installs obra/Superpowers per CLI (plugin / TUI / shell).
- **`aih scaffold`** — repo context docs (INDEX, architecture, conventions, tasks),
  a `SETUP-TASKS` agent playbook, write-once project guardrails, and a `VALIDATION`
  playbook that produces a picture-perfect/gaps verdict.
- **`aih mcp`** — `--mode standard|offline|none` with an enterprise degradation
  ladder (stdio-only servers, `managed-mcp.json` templates, CLI fallback) for
  locked-down environments that block MCP.
- **`aih guardrails`**, **`aih secrets`**, **`aih certs`**, **`aih vdi`**,
  **`aih hardware`**, **`aih sandbox`**, **`aih profile`**, **`aih telemetry`**,
  **`aih workspace`** (parent-only multi-repo bootstrap) — workstation/repo
  bootstrap capabilities, each dry-run-first.
- **`aih doctor`** / **`aih status`** — read-only health probes (corporate CA,
  dev tools, workspace mode) and harness status.
- **CLI targeting** — `--cli <list>`, `--all-tools`, and `--detect` across 11 tools
  (claude, codex, cursor, antigravity, gemini, copilot, windsurf, opencode, zed,
  kimi, kiro). Context directory name is configurable via `--context-dir`.

### Security

- Public-repo hardening: least-privilege CI, CodeQL (security-extended), Dependabot
  (npm + github-actions), private vulnerability reporting, `@claude` workflow gated
  to trusted authors, and GitHub Actions pinned to commit SHAs.

[Unreleased]: https://github.com/samartomar/ai-harness/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/samartomar/ai-harness/releases/tag/v0.2.0
