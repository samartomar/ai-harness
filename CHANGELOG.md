# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`aih secrets --verify` is now a secret-scan CI gate.** Each detected plaintext
  secret (`.env*` / root `secrets/`) surfaces as a read-only `fail` probe, so
  `--verify` exits non-zero when secrets exist and `--sarif <file>` emits one
  error-level result per path (under a single `plaintext-secret` rule) for GitHub
  code-scanning. Probes stay read-only verdict carriers — no `exec`, no remote
  mutation, and only the offending path (never any secret value) is reported.

## [0.1.0] - 2026-06-24

First public cut of the Enterprise AI Bootstrapping Harness (`aih`) — a dry-run-first
CLI that bootstraps governed, proxy-safe AI coding into workstations and repos.

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

[Unreleased]: https://github.com/samartomar/ai-harness/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/samartomar/ai-harness/releases/tag/v0.1.0
