# The command reference

Long-form behavior detail for every `aih` command — the one-line surface lives in the
[README](../README.md#command-surface), and `aih <command> --help` is authoritative for flags and
exact syntax.

**Workstation & runtime**

## aih certs

Extract the corporate root CA from the OS trust store, lock it down, and propagate trust to
npm/pip/cargo/conda.

## aih heal

Diagnose **and repair** the broken runtime `certs` assumes works — corporate TLS trust, npm, PATH,
and MCP pre-flight — generically for any TLS-intercepting proxy (`--ca-pattern`/`AIH_CA_PATTERN`,
never hardcoded). Diagnoses by default (exits non-zero when broken) and repairs under `--apply`;
the npm self-heal is emitted as an operator-run script (never executed) and the only mutation is a
local Windows registry write to persist the CA for GUI-launched apps (Claude/Kiro), so the harness
never contacts a remote. `--scope certs,npm,path,mcp,all`.

## aih tools

Install the agent shell tools the harness leans on — `rg`/`fd`/`jq` plus
`ast-grep`/`comby`/`tree`/`gh`/`code-review-graph` — through the platform package manager. Dry-run
previews; `--apply` installs. A blocked install on a locked-down box is escalated as an IT ticket
rather than failing silently.

## aih ready

Readiness gate — one graded, blocker-aware verdict answering "can a developer start work with an AI
agent here, now?", composed from aih's read-only probes (runtime/TLS/PATH/core tools, per-CLI
loadability, contract, secret scan). Diagnoses by default (non-zero when blocked); the one
auto-fixable blocker (missing `rg`/`fd`/`jq`) installs under confirmation. Surfaces a `sec-ready`
panel in `aih report --v9`.

## aih hardware

Profile CPU/RAM/GPU; compute memory/thread/parallel limits + quantization; emit tuned
Ollama/llama.cpp settings.

## aih vdi

Detect VDI (Citrix/WorkSpaces/RES/RDP) and redirect caches + SQLite to local scratch (junction on
Windows).

## aih bootstrap

Orchestrate the workstation 4-phase rollout (certs → hardware/vdi → telemetry).

**Repo canon & bootstrap**

## aih init

Initialize a repo: profile + selected baseline + bootstrap-ai + scaffold + secrets + guardrails + mcp +
sandbox in one pass (one writer per file). `--baseline ecc|gstack|gsd` selects the Layer-1 canon
baseline and records the choice in `.aih-config.json`; `ecc` remains the default. ECC is a separate
gated network step — run `aih ecc` when ready (it points at ECC's own installer).

## aih profile

Recursively detect the repo's stack and synthesize Cursor stack rules (`.cursor/rules/*.mdc`). Root
bootloaders are owned by `bootstrap-ai`.

## aih scaffold

Scaffold repo hygiene: a secret deny-list (agent read-deny rules), a pre-commit hook, and the aih
`.gitignore` entries. Under `--canon legacy` it also creates the full context-doc family in the
canonical context dir (`--context-dir`, default `ai-coding`) — INDEX/SKILL skeleton, an agent
**`SETUP-TASKS.md`** playbook (fill context + guardrails from the code), and a write-once
`project-guardrails.md`. (Bootloaders are `bootstrap-ai`'s job.)

## aih bootstrap-ai

Emit + verify the repo's Layer-2 `ai-coding/` canon: `RULE_ROUTER.md`, per-CLI adapters, and root
bootloaders (tool preamble + a regenerated shared block). `--verify` is the drift gate **and a
weak-model-safety lint of the generated canon** — every `#[[file:…]]`/backtick reference must
resolve and no leftover `<insert>`/`TODO` scaffolding ships (a dangling reference fails the gate;
soft-imperative/taste-word prose is advisory). Existing bootloaders are merged: hand-written
content outside the managed block is preserved, and dry-run/apply summaries report those writes as
`merge` rather than `overwrite`. Use `--baseline ecc|gstack|gsd` to render the Layer-1 references;
non-default choices are persisted so later `contract` and `bootstrap-ai` runs stay aligned.

## aih contract

Synthesize the machine-readable repo contract (`project.json`) from the detected stack — the
structured seam agents and tooling read for build/test/lint commands and conventions, alongside the
`ai-coding/` prose canon. Merges over any user-added keys (write-once-safe); dry-run previews,
`--apply` writes.

## aih adopt

Converge an **existing** AI canon onto aih's managed model **without overwriting your work**
(brownfield migration) — for a repo that already has an `AGENTS.md`/`.cursor`/`ai-*` setup.
`--migrate-cli` folds committed CLI-native content into the canon (copy + pointer-convert,
content-verified, backed up); `--ack <paths>` marks paths as intentionally tool-native so adopt
stops flagging them. Bootloader convergence uses the same managed-block merge reporting as
`bootstrap-ai`.

## aih prune

Remove the stale per-CLI artifacts a repo still carries for a CLI it no longer targets (the inverse
of `bootstrap-ai`). Dry-run preview by default; `--apply` moves aih-owned files to gitignored
`.aih/legacy/` (reversible), subtracts aih's managed block **in place** from co-owned bootloaders
(never deletes them), and leaves unmarked MCP/settings as manual advisories. Diffed against
**committed intent only** (`.aih-config.json`), so a bare run is safe anywhere; a dirty/untracked
target refuses without `--force`. `--delete` hard-deletes to a gitignored `*.aih.bak` sibling
(never overwriting a prior backup) instead of archiving; `--unrunnable` also prunes a
still-targeted CLI whose binary is absent from `PATH` (loud warning; never the default).
Shared selection flags (`--cli`, `--all-tools`, `--detect`) are accepted by the command surface but
ignored by `prune`; the digest says so and keeps the diff anchored to committed intent.

## aih capability

Resolve the repo's agent-capability needs into committed intent plus a derived machine cache.
`capability resolve` scans the repo stack, emits evidence-backed decisions
(`{name, install, reason, evidence[]}`), writes root `aih-capabilities.json` under `--apply`, and
updates `$HOME/.aih/capabilities/cache.json` as a rebuildable cache. It never fetches, installs, or
vendors third-party bytes. At `vibe` posture detected capabilities are auto-add decisions; at
`team` they warn; at `Enterprise` they are approval-required hints for the org policy/on-ramp.
`capability prune` rewrites only that derived cache, dropping repo entries whose committed
`aih-capabilities.json` is gone or unreadable and refreshing cache hashes/capability lists from
retained manifests. The committed repo file remains the source of truth; `~/.aih/` is safe to
delete and rebuild.

## aih uninstall

Remove the core aih install footprint from a repo; `aih clean` is the same command. Dry-run
preview by default. Under `--apply`, marker-backed aih-owned whole paths (`ai-coding/` or the
committed context dir, `.aih-config.json`, `.aih/`, and marker-owned Kiro extras such as
`.kiro/steering/agent-tools.md` plus `.kiro/hooks/aih-*.kiro.hook`) move to reversible sibling
`*.aih.bak` backups, which avoids archiving into `.aih/legacy/` while `.aih/` itself is being
removed. The context dir and `.aih/` are only backed up when the root marker and generated canon
evidence agree; Kiro extras require the generated Kiro bootloader marker too. Otherwise these
paths are advisory/no-op. Co-owned files such as repo-scoped MCP configs from registered CLIs
(`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `opencode.json`, `.kiro/settings/mcp.json`)
and root bootloaders that still carry an aih managed block are surfaced as manual advisories
instead of being edited or deleted. Dirty/untracked removal targets refuse without `--force`.

## aih ecc

Install [affaan-m/ECC](https://github.com/affaan-m/ECC) (skills, instincts, memory, security,
research-first) for the selected CLIs, scoped to the detected stack: Claude plugin path,
`ecc-install` for codex/cursor/zed/opencode, `consult` advisor otherwise.

## aih superpowers

Install [obra/Superpowers](https://github.com/obra/Superpowers) (brainstorm → plan → TDD →
subagent-review skills) for the selected CLIs.

## aih crispy

Run the CRISPY context-engineering stage machine (deterministic, gate-ordered).

## aih workspace

Scaffold a **multi-repo** workspace (parent-only): cross-repo architecture map (write-once) +
per-repo discipline, selected CLI bootloaders, a VS Code `.code-workspace`, graph MCP scoped per present declared child repo
with absolute root-anchored paths, and a `.aih-workspace.json` marker. Declare the scope with `--repos a,b` or an existing
`.aih-workspace.json`; detected child Git repos are reported as candidates but are not auto-enrolled.
With `--git`, the generated `.gitignore` defensively ignores all immediate child Git repos, including
ones outside the declared workspace scope.

Nested helpers keep the parent bridge current: `aih workspace snapshot --lock --apply` records the
declared child repo branch/SHA/remotes, and `aih workspace hydrate [root]` restores from that
metadata by planning clones for missing children and clean checkouts for present children that are at
the wrong recorded ref. Hydrate never edits remote configuration; a child with no recorded remote is
skipped with an operator note. Until a declared child exists, `aih workspace --apply` emits a hydrate
note and skips that child's graph MCP scope instead of wiring an empty path.

**Skill governance & supply chain**

## aih trust

Vet, pin, and gate external GitHub repos and skills before an agent acquires them. `scan <target>`
grades danger (auto-exec hooks, dependency-confusion, typosquat, incoming-MCP, secrets) and emits
SARIF; `allow`/`pin` record reviewed sources + pinned SHAs in org policy; `list`/`verify` audit the
committed policy and trust-lock evidence.

## aih skill

The **skill lifecycle** on top of `trust` — a complete governance loop for external agent skills.
`vet <src>` runs the read-only gate pipeline (shape, license, trust scan) to a
**GREEN/YELLOW/RED/UNKNOWN** verdict + a local evidence artifact (never installs).
`card`/`approve --pin --owner` turn that evidence into committed governance: a skill card + a root
**`aih-skills.lock.json`** entry, behind a fail-closed chain (pin → evidence → approvable verdict →
license → owner; RED blocked, UNKNOWN refused, YELLOW = the manual review). The lockfile has
**install-time teeth**: `workspace add` refuses promoting a skill with no committed approval *for
that source's pinned commit* at `team`/`enterprise` posture (advisory at `vibe`) — a same-named
skill from an unrelated source never inherits an approval, and stale approvals are refused.
`inventory` joins on-disk skills against the approvals — approved / unapproved / stale-pin /
quarantined, one row per physical install — and feeds a "Skill governance" panel in `report --v9`.
`quarantine --name <skill>` **disables reversibly** (dir → `.aih/quarantine/`, approval kept; move
it back to restore). `remove --name <skill>` retracts: archives the skill dir reversibly
(`--delete` to hard-delete), drops the approval + card; refuses ambiguous duplicates, nested-skill
collateral, machine-root installs, and stranding a parked copy's approval; cleans up orphaned
approvals.

## aih pack

**Curation manifests** on top of the per-skill lifecycle — a committed root `aih-packs.json` names
sets of approved skills so a team installs "the docs-quality pack", not N individual approvals. The
`aih-skills.lock.json` stays the **pin authority**: every manifest ref is a fail-closed cross-check
against the lock entry (`pack.pin-mismatch` blocks; a disagreeing manifest is never a second pin).
`status`/`validate` grade each pack on the two orthogonal axes (approval × install) — `validate` is
the **CI gate** (coded findings: `pack.missing-approval`, `pack.pin-mismatch`,
`pack.duplicate-name`). `add`/`remove-entry`/`init` author the manifest with refs **derived from
the lock** (authoring never invents a pin; `init` seeds a pack from `skill approve --pack` tags; an
emptied pack is dropped whole). `plan`/`install` drive the gated two-phase acquisition once per
source — **gate ALL sources before promoting ANY**, promote only the pack's refs (subset-exact),
route drifted installs back through the gate, resume idempotently — fail-closed at every posture
(clean approvals required even at `vibe`; `--acknowledge` refused, acknowledgements stay
per-source). `uninstall` retracts every installed member with `skill remove`'s exact per-member
semantics — reversible archive (or `--delete`), approval + card dropped, loader-ref advisories, the
same refusal guards, and **one blocked member refuses the whole plan**; the manifest curation
stays. Installed skills' pack tags roll up in the report's Skill-governance panel.

## aih marketplace

Package the approved skill set into a **reproducible, verifiable distribution artifact** — a
directory a team can host anywhere (git repo or static host), never a registry/server. `build`
reads `aih-skills.lock.json` (the **approval authority**) and emits the exact vetted skill bytes
(trust-lock hash cross-checked), the committed skill cards, the content-addressed vet evidence, a
`marketplace.json` manifest, and `SHA256SUMS` — byte-identical across builds from identical inputs
(no wall-clock; `--stamp` is operator-supplied), and **fail-closed whole**: an approved skill that
is uninstalled, drifted, ambiguous, or missing its card/evidence refuses the entire build.
`validate` is the **read-only CI gate** over a built or fetched artifact (coded findings:
`marketplace.manifest-parse`, `marketplace.path-traversal`, `marketplace.missing-file`,
`marketplace.checksum-mismatch`, `marketplace.sums-coverage`, `marketplace.unapproved-verdict`,
`marketplace.signature`), containment-checking every manifest/sums path **before** touching the
filesystem with it. `publish` signs the artifact's `SHA256SUMS` (cosign or a GitHub attestation — a
publish without a signer is refused; that's just a build); `validate --require-signature` then
**fails rather than skips** when that signature can't be verified. Consumers stay on
`aih workspace add` — the vet gate still runs at consume time.

## aih policy

Schema and trusted-channel gates for the org policy. `validate` is the **read-only CI gate** over
the committed `aih-org-policy.json` — a missing file is a friendly skip (vibe repos carry no org
policy), a parse/schema failure is a coded finding (`org-policy.invalid`) — or, under
`--bundle <path>`, over a distributable **policy-bundle envelope**
(`org-policy.bundle-invalid`, naming which layer failed: the envelope or the embedded policy).
`verify --against <sha256|bundle>` compares the active policy (including an explicit
`AIH_ORG_POLICY` override) with a pinned raw SHA-256, a policy-bundle JSON envelope, or a fleet
bundle directory containing `files/aih-org-policy.json`; mismatches fail closed as
`org-policy.drift`.

## aih evidence

Package the **audit trail aih already emits** — approval lock, packs manifest, trust lock, skill
cards, vet evidence, run logs, report/SARIF outputs — into one deterministic **evidence bundle**
(`build`): the exact fleet-bundle layout (`files/<rel>` copies, `manifest.json`, `SHA256SUMS`,
optional `--sign cosign|gh`) plus `evidence.json`, a typed kind index and harness provenance block
(`aihVersion`, release tag, package name, checksum/signature asset refs, and verification command).
Byte-identical across builds from identical inputs (no wall-clock); absent artifact kinds are
skipped silently. At enterprise posture, or with `--require-signature`, signing is strict: a missing
signer, missing local signing tool, or failed signing exec emits coded `bundle.signature` evidence
instead of being treated as best effort. Re-check any copy with
`aih verify-bundle --bundle <out> --require-signature`.

## aih bundle

Build a deterministic **fleet bundle** — the repo contract, org policy, and managed config packaged
with a checksum manifest (and optional `cosign` or `gh` signing) for distribution to a team or CI.
`aih verify-bundle` always re-checks checksums; `--require-signature` turns a missing signature,
missing verifier tool, missing GitHub `--repo`, or failed signature verification into a coded
`bundle.signature` failure instead of an optional skip.

## aih verify-release

Read-only release verification for published `@aihq/harness` versions. With no positional version,
it resolves the latest package version from npm; with `aih verify-release <version>`, it checks that
specific version. The command installs that exact package into a temporary prefix with scripts
disabled, runs `npm audit signatures --prefix <temp>`, downloads the GitHub Release checksum and
Sigstore bundle, verifies the checksum file with `cosign verify-blob` against the tag-specific release
workflow identity, packs the npm tarball, and compares its SHA-256 hash to `SHA256SUMS.txt`.
Missing local tools (`npm`, `gh`, or `cosign`) produce
honest skips instead of false passes.

## aih secrets

Scan for plaintext `.env*`/`secrets/` and write agent deny rules + vault-injection guidance.
`--verify` is the **secret-scan CI gate** (exit 1 when plaintext secrets exist); `--sarif <file>`
emits one error-level result per path for GitHub code-scanning.

## aih guardrails

Generate `.gitleaks.toml`, `.pre-commit-config.yaml`, and a CI license gate that blocks
AGPL/strong-copyleft.

**Analytics & operations**

## aih report

Read-only analytics digest. Local: a dev console — agent **context footprint** (token bloat) plus a
**per-turn load-group** panel (the heaviest single tool's always-loaded bootloaders — what one tool
actually pays per turn, not the union sum; `--gate --token-budget <n>` exits non-zero in CI when
it's exceeded). The footprint is **gitignore-honoring** (counts only tracked/untracked-not-ignored
source, never generated per-CLI copies — `--all-files` to override; `--since <ref>` narrows to
files changed in a PR), **repo & branch status** (current branch, ahead/behind vs main, dirty;
`--team` adds in-progress team branches via a `gh` → `git ls-remote` → last-fetched ladder that
degrades gracefully when gh/network is blocked), repo config presence, local AI-CLI tooling
saturation, and **trends** (unicode sparklines of commits/LOC/adoption/branches over recorded
history — see `aih track`). Org (`--org <export.json>`): top skills, tokens by type, **cache
savings** (net-of-write estimate), and accept/reject from a saved Admin-API export. Body prints
verbatim; `--json` carries structured data; `--format md|html` writes a static artifact under
`--apply`. **`--v9`** opts into the developer-console HTML dashboard with LIVE / PREVIEW / EMPTY
panel honesty, machine-relative ECC inventory, usage-by-CLI, heavy lifters, dormant ECC skills, MCP
parity, remediation wins, and no-cost local usage analytics; legacy and `--v4` remain
opt-in/unchanged. **`--open`** builds the self-contained HTML dashboard and launches it in your
browser (implies html + apply); **`--refresh <sec>`** keeps it live — opens once, then regenerates
every `<sec>`s while the page auto-reloads (Ctrl+C to stop). Dark by default with a light toggle;
fonts are embedded so it works fully offline. Network-free by default; `--team` is the lone opt-in
network call.

## aih track

Record one metrics sample (commits 7d, LOC delta, adoption score, branch count, tracked files) to
`.aih/history.jsonl` — the time-series behind `aih report` trends. Read-only git/filesystem;
dry-run previews, `--apply` appends (idempotent per commit). Wire into a commit / agent-stop hook
so history accumulates — e.g. Kiro's `metrics-on-stop` hook (`aih bootstrap-ai --cli kiro`) runs
`aih track --apply` automatically.

## aih usage

Install the **multi-tool usage-capture** layer → `.aih/usage.jsonl` (rendered by `aih report` and
`aih report --v9`). The **universal floor** is a git `post-commit` hook that records commit
activity for **any** tool (it keys off the commit, not the agent). The per-tool **skill/MCP** layer
wires in via each CLI's verified local hook (Claude/Codex/Cursor/Gemini/Kiro/…); skills aggregate
by source (ECC/canon/user), and `--rollup <repo,repo>` aggregates local logs across repos on
demand. Usage is local activity counts only — **no cost, no prompts, no arguments**, machine-local
and gitignored.

## aih telemetry

Inject OpenTelemetry env, a redacting Bindplane collector, and an analytics fetcher (usage + skills
endpoints → `{ usage_report, skills }`).

## aih mcp

Generate the MCP server config **for the targeted CLIs** (`--cli`/`--all-tools`, default claude):
Claude/Kimi share `.mcp.json`, Cursor uses `.cursor/mcp.json`, and Kiro uses
`.kiro/settings/mcp.json`; Codex gets native TOML in `~/.codex/config.toml` (including
`bearer_token_env_var` for token auth), and Copilot/OpenCode/Zed or global-config entries get their
registry-specific native writes or guidance. Scopes:
local/project/remote. For locked-down orgs,
`--mode offline` (vendored local-command servers) or `--mode none` (no MCP + a CLI-tool fallback)
plus a `managed-mcp.json` admin template. Enterprise org policy can also tune the hosted GitHub
MCP entry: `mcp.incumbentHosts` declares which vendor hosts are reachable/incumbent,
`mcp.githubHost` points at a GHES or internal GitHub MCP origin, and `mcp.disabledServers`
can remove `github` entirely. Without committed org policy, the legacy github.com default remains
unchanged; with committed org policy, the GitHub host must be declared incumbent before it passes
the enterprise gate. `GITHUB_HOST` may supply the same https origin when no policy host is set.
GitHub auth defaults to `--github-auth oauth`, which works for clients with a registered OAuth
app; use `--github-auth token` for clients that need a PAT-backed `Authorization` header. The token
value is never written into MCP config — the header references `${GITHUB_PERSONAL_ACCESS_TOKEN}`
and `.env.example` documents only that placeholder. Token auth ignores ambient `GITHUB_HOST`;
non-default hosted GitHub MCP endpoints must come from committed org policy and incumbent hosts.

## aih sandbox

Generate a devcontainer + managed sandbox settings (egress allowlist, `failIfUnavailable`).

**Verification**

## aih doctor

Fail-closed verification of the workstation/repo configuration (+ workspace mode: validates each
child repo). Includes a **canon markdown lint** (read-only) over the scaffolded `ai-coding/` tree.
It remains read-only. `--posture enterprise` also runs the enterprise baseline attestation: MCP
servers from known repo-scoped MCP config files (`.mcp.json`, Cursor, Kiro, VS Code, and OpenCode)
and packaged marketplace skills from `.aih/marketplace/marketplace.json` must be declared in
`aih-org-policy.json` (`mcp.allowedServers` / `trust.approvedSources`), or `doctor` emits coded
`baseline.*` findings for a missing registry, invalid registry input, or undeclared residue. MCP
declarations are bound to the generated catalog's command/args/env or URL/headers shape, and
marketplace declarations must include the reviewed `pinnedSha` that matches the artifact's packaged
commit. Workspace graph MCPs generated for declared child repos are treated as internal workspace
plumbing; the full Package Graph schema remains the follow-on registry unification.

## aih status

Read-only inventory of what the harness has configured. Accepts and validates `--posture <posture>`
for script consistency, but ignores the value; it remains read-only.

`aih verify-bundle` and `aih verify-release` also accept and validate `--posture <posture>` for the
same script-friendly surface, while ignoring the value and preserving their read-only behavior.

## Support tickets

Any verifying command (`aih doctor`, `aih heal`, `aih bootstrap-ai --verify`, `aih secrets --verify`, …)
turns a failed or skipped check that carries a `Check.code` into a **ticket-ready, tool-neutral support
template** — so a developer blocked by corporate environment config (untrusted CA, broken npm, blocked
registry) can escalate without hand-writing the ask. `aih report` also derives its own **advisory**
findings from the analytics panels (per-turn context **over budget**, incomplete **adoption** in an
initialised repo) as developer self-fix notes — they never fail the run (a bare `aih report` still exits
0; only `--gate` makes the budget a CI gate). Templates render in three registers, keyed off who fixes
the issue:

- **External escalation** — an external-audience check that **failed**; the fix is a system change owned
  by IT, security, or the dev-platform team (untrusted corporate CA, broken package manager, unreachable
  registry). Blocking failures lead with `[<project>] Blocking setup issue — …`.
- **External improvement request** — an external-audience check that **skipped**: a non-blocking
  configuration gap that degrades the setup without blocking it.
- **Developer self-fix note** — a developer-audience finding the developer resolves directly (install
  git, `aih mcp --apply`); terse, runnable, and the only register that may name `aih`.

By default the terminal prints one `[copy] …` label per template under a **Support templates:** heading.
Add **`--support-out <dir>`** to write each full ticket to a repo-contained `<dir>/<code>.md` file (you
named the path — that's the consent, same as `--sarif <file>`). **`--json`** carries the data under a
top-level `support: { findings, templates }` key. Support output is **suppressed when streaming SARIF**
(`--sarif -`) so stdout stays a clean code-scanning artifact.

**External tickets are tool-neutral by contract** — they never name aih or its commands; they describe
the failed *internal configuration* the recipient must fix at the system level. Each follows the
structure **Summary → Impact → Issue → Observed evidence → Environment → Requested fix → Acceptance
criteria**, and every escalation ends with a security work-around guard (keep TLS verification and secret
controls enabled; don't change project code). Evidence, affected area, and acceptance criteria are canned
per code — never guessed — with the live check detail riding along as evidence (redacted: home-dir
scrubbed, secret-aware argv masking).

**Project context (`SETUP.md`).** A project can shape the tickets with opt-in HTML-comment markers in
`SETUP.md`, `docs/SETUP.md`, or `.aih/SETUP.md` (first found wins):

- `<!-- support:why -->…<!-- /support:why -->` — *why a correct environment matters for this project*,
  woven into the ticket's Impact / "Why this helps" section. Falls back to the first paragraph under a
  `## Why` / `## Overview` / `## Purpose` / `## Background` / `## About` heading, so existing setup files
  contribute without edits.
- `<!-- support:routing -->…<!-- /support:routing -->` — real routing metadata (assignment group, ticket
  prefix) rendered verbatim in the Environment block. **Never invented** — shown only when you provide it.
- `<!-- support:language -->…<!-- /support:language -->` — an instruction to adapt the message to the
  org's corporate language, surfaced as a **terminal note** to the author, never embedded in the ticket
  body (which stays clean to paste).
