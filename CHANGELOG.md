# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-07-02

The **skill packs** release: named, committed **curation manifests** over the per-skill
governance lifecycle — approval stays per-skill and `aih-skills.lock.json` stays the pin
authority; a pack batches, scopes, and cross-checks. Every destructive or gate-adjacent
slice passed two independent review lenses with all findings fixed before merge.

### Added

- **`aih pack status` / `aih pack validate`** — the read-only join of the new committed
  `aih-packs.json` manifest against the lockfile and inventory: per skill an `approval`
  axis (approved / missing-approval / **pin-mismatch** — the manifest's `{source, commit}`
  is a fail-closed cross-check, never a second pin) and an `install` axis (installed /
  not-installed / quarantined / stale-pin), with a `ready`/`blocked` pack rollup.
  `validate` is a CI gate: coded `pack.*` findings (duplicate-name, pin-mismatch,
  missing-approval, unknown-manifest), exit 1 on findings.
- **`aih pack add` / `remove-entry` / `init`** — authoring that DERIVES every skill ref
  from its lock entry (never invents pins; refuses unapproved skills and cross-pack
  duplicates). A fail-closed write guard refuses to rewrite a manifest containing
  entries aih cannot parse — operator data is never silently destroyed.
- **`aih pack install` / `aih pack plan`** — the gated batch install: refs grouped by
  (source, commit), pins taken FROM the lock, **all sources gated before any promotion**
  (one poisoned source blocks everything), promotion limited to exactly the pack's refs
  (an unselected skill in the same source — including a *nested* one — never rides
  along), resume is idempotent **and drift-aware** (tampered promoted files are detected
  against trust-lock receipts and reinstalled through the gate). Fail-closed at every
  posture; `plan` never fetches. Per-source failures always land in the outcome report.
- **`aih pack uninstall`** — retracts every installed member with the exact `skill
  remove` semantics in ONE all-or-nothing plan (any member's guard refusal aborts before
  anything moves), behind an **ownership preflight**: a manifest ref whose source/commit
  disagrees with the lock cannot retract the real skill's approval, and duplicate-name
  refs are refused. The manifest itself is never touched.
- **Report governance panel: per-pack rollup** (`pack <name> — N of M approved`), plus
  the pack tag in inventory provenance. Renders only when packs exist.
- Docs: README `aih pack` command row and `docs/product/pack-manifest.md` (schema,
  worked example, the bump-pin → re-vet → re-approve → status-green → install flow).

### Security

- **Skill names are validated at every schema boundary** (lock entries, pack refs, pack
  names): path-safe segments only — a crafted committed name like `../../package-lock`
  can no longer steer destructive cleanup at arbitrary in-repo files (found by external
  review with a live repro; also guarded defense-in-depth inside the card-path builder).
- Report labels strip control/bidi characters before rendering (visual-spoofing hardening).
- Trust-lock receipts union-merge ONLY for subset (pack) promotions; whole-source
  promotions keep replace semantics so a mutable source's removed skills cannot linger
  as stale evidence.

## [0.4.1] - 2026-07-02

The skill lifecycle grows **teeth and a pause button**: committed approvals are now
enforced at install time, and a skill can be disabled reversibly without retracting
its approval. Every change on this destructive/gate surface passed two independent
review lenses (an external security pass and a code-quality pass) with **every
finding fixed and regression-tested before merge**.

### Added

- **Posture-gated skill install enforcement** — `aih workspace add` now requires a
  committed `aih-skills.lock.json` approval **for this source** before promoting a
  skill: matching is content-addressed (a GitHub promotion matches only an entry
  whose commit equals the fetched pinned SHA — a same-named skill from an unrelated
  source can never inherit an approval, and a *stale* approval is refused; local
  promotions match `commit: "local"` entries). Advisory at `vibe` posture
  (warning-only, installs proceed); a promotion-blocking `trust.unapproved-skill`
  fail at `team`/`enterprise` — surfaced as a coded check through the normal
  report/SARIF/support-ticket flow, never a bare error.
- **`aih skill quarantine --name <skill>`** — disable a skill **without removing
  it**: moves its directory to the deterministic `.aih/quarantine/<path>` while
  keeping its lockfile approval and committed card; restore by moving the directory
  back (the digest prints the exact path). Refuses an already-occupied quarantine
  destination (printed restore paths are always truthful), ambiguous duplicates,
  nested-skill collateral, and machine-root installs. `skill inventory` and the
  report governance panel gain a `quarantined` state — and the panel never claims
  "all approved" while a skill sits parked. `skill remove` refuses to strand a
  same-named parked copy's shared approval.
- The remove engine's reversible move gained a **closed-union archive root**
  (`.aih/legacy` | `.aih/quarantine`) — never an arbitrary path; containment,
  symlink refusal, never-overwrite, the dirty-worktree gate, and rollback apply to
  both roots unchanged.
- `aih skill approve --name` now validates the override against the vetted
  evidence's skill list (an arbitrary name would commit an approval no promotion
  could ever match).

## [0.4.0] - 2026-07-02

The **skill lifecycle** release: a complete governance loop for external agent skills —
assess (`vet`), gate (`approve`), observe (`inventory` + report), retract (`remove`) —
layered on the `aih trust` primitive. (The `vet`/`card`/`approve` code physically rode
inside the 0.3.1 package undocumented — a tag that landed after their merge; 0.4.0 is
their official, supported introduction.)

### Added

- **`aih skill vet <repo-or-path>`** — the read-only gate pipeline: resolve → fetch under
  `--apply` (pinned SHA, env-scrubbed temp quarantine) → skill-shape record (skill dirs,
  install scripts, MCP config, package manifests, full-codebase-analysis signal) →
  license check → the trust scan battery → a **GREEN / YELLOW / RED / UNKNOWN verdict**
  (proven-dangerous fail → RED; not-fetched / detector-unavailable / license-missing /
  unpinned → UNKNOWN; other findings + shape triggers → YELLOW) → a local evidence
  artifact (`.aih/skill-reports/<id>-<sha>.json`). Never installs; exit codes stay
  binary and the verdict rides the digest / `--json`.
- **`aih skill card` + `aih skill approve --pin --owner`** — turn vet evidence into
  committed governance state: a committed skill card (`<ctx>/skill-cards/<name>.json`)
  and a committed root **`aih-skills.lock.json`** entry pinning the evidence sha256.
  Fail-closed evidence chain: no approval without a pinned commit, matching evidence,
  an approvable verdict (RED blocked, UNKNOWN refused, YELLOW approvable — approve IS
  the manual review), a recorded license, and `--owner`. Org-policy
  `trust.requiredChecks` (license / pin / no-exec / no-mcp / detector names) evaluated
  at approve; unknown names fail closed.
- **`aih skill inventory`** — the read-only join of on-disk skills (promoted
  `<ctx>/skills`, repo `.claude`/`.kiro/skills`, machine `~/.claude/skills`) against the
  committed approvals: **approved / unapproved / stale-pin** (approved commit ≠ the
  trust-lock source's acquired pin). One row per **physical** install — duplicates of a
  logical name never collapse. Plus a **"Skill governance" panel** in
  `aih report --v9` consuming the same join (legacy report output stays byte-identical).
- **`aih skill remove --name <skill> [--delete]`** — the destructive retraction step:
  moves the skill's directory to the reversible `.aih/legacy/` archive (or a gitignored
  `*.aih.bak` sibling with `--delete`), drops its lockfile approval and committed card.
  Fail-closed refusals: a name matching **more than one physical install** (each listed);
  a skill dir **containing another skill** (collateral named); machine-root skills. An
  **orphaned approval** (dir deleted by hand, lock entry surviving) is cleaned up rather
  than refused. Loader references (settings/MCP/bootloaders) are advisory-only — never
  auto-edited. Reviewed by two independent lenses (external security pass +
  code-quality pass); every finding fixed with regression tests before merge.

### Fixed

- **The dirty-worktree gate is directory-aware for removals**: a removal target
  directory now refuses when any uncommitted file lives **inside** it (previously only
  an exactly-matching dirty path gated, so a whole-dir move could clobber uncommitted
  work inside the dir without `--force`).

## [0.3.1] - 2026-07-01

### Added

- **`aih prune --delete`** — a hard-delete opt-out from the reversible `.aih/legacy/`
  archive: renames the stale file to a gitignored `*.aih.bak` sibling instead of moving it
  under `.aih/legacy/`. An occupied backup slot is **never overwritten** — it falls back to
  `*.1.aih.bak`, `*.2.aih.bak`, … so a prior rescue is never destroyed.
- **`aih prune --unrunnable`** — also prune per-CLI artifacts for a still-*targeted* CLI
  whose binary is absent from `PATH` (probed with the readiness gate's `which`/`where`). A
  PATH problem looks identical to a dropped CLI, so it warns loudly, never rewrites the
  committed `.aih-config.json` marker, and never triggers on a default run or `aih report`.

### Changed

- **npm package slimmed ~64%** (1.1 MB → ~400 kB packed; 3.9 MB → 1.1 MB unpacked): the
  published chunks are now minified (`keepNames` preserved, so stack traces stay readable)
  and source maps are no longer shipped — local development still debugs from `src/`.

### Fixed

- **`aih prune`'s dirty-worktree gate no longer misses quoted paths.** It parsed human
  `git status --porcelain` and never C-unescaped git's quoted paths, so a dirty or untracked
  removal target whose name needs quoting (embedded newline, `"`, non-ASCII) could slip the
  gate and `--delete` could move an uncommitted file without `--force`. It now parses
  NUL-delimited `--porcelain -z -uall`, matching on-disk paths exactly.
- **`aih prune --delete` reports the actual backup path after a fallback** — when the
  `*.aih.bak` slot was occupied and the file landed at `*.1.aih.bak`, the summary previously
  pointed the restore hint at the wrong path.

### Docs

- **Documented `aih prune`** (and `--delete` / `--unrunnable`) in the README command
  reference — it shipped in 0.3.0 without a README entry. `RELEASING.md` now carries an
  explicit "update user-facing docs" and "sync project tracking" step so command/flag docs
  can't silently lag a release again.

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

[Unreleased]: https://github.com/samartomar/ai-harness/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/samartomar/ai-harness/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/samartomar/ai-harness/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/samartomar/ai-harness/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/samartomar/ai-harness/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/samartomar/ai-harness/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/samartomar/ai-harness/releases/tag/v0.2.0
