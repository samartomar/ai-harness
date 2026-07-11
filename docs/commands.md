# The command reference

Long-form behavior detail for every `aih` command — the one-line surface lives in the
[README](../README.md#command-surface), and `aih <command> --help` is authoritative for flags and
exact syntax.

For task-oriented command selection, use the workflow companion:
[guides/command-use-cases.md](../guides/command-use-cases.md).

**Workstation & runtime**

## aih certs

Extract the corporate root CA from the OS trust store, lock it down, propagate trust to
npm, pip, cargo, conda, Go, git, JVM tools, Gradle, and Maven, and emit Docker daemon
trust guidance.

## aih heal

Diagnose **and repair** the broken runtime `certs` assumes works — corporate TLS trust, npm, PATH,
and MCP pre-flight — generically for any TLS-intercepting proxy (`--ca-pattern`/`AIH_CA_PATTERN`,
never hardcoded). Diagnoses by default (exits non-zero when broken) and repairs under `--apply`;
the npm self-heal is emitted as an operator-run script (never executed) and the only mutation is a
local Windows registry write to persist the CA for GUI-launched apps (Claude/Kiro), so the harness
never contacts a remote. PATH fixes are emitted as reviewed shell/profile instructions rather than
silently editing shell profiles. The MCP scope also derives secret-safe endpoint origins from active
MCP config where possible and emits chain-inspection guidance plus `NODE_EXTRA_CA_CERTS` /
`SSL_CERT_FILE` remediation snippets for TLS-intercepting enterprise proxies. It does not contact
repo-derived MCP endpoints during planning; live Node/Python endpoint TLS handshakes and CA-bundle
comparisons require explicit `--probe-mcp-endpoints` and run as verification probes. For major
AI-Harness upgrades, prefer
`npm install -g @aihq/harness@latest`; add `--force` only when replacing a broken global install
after reviewing the current workstation state. `--scope certs,npm,path,mcp,all`.

## aih tools

Install the agent shell tools the harness leans on — `rg`/`fd`/`jq` plus
`ast-grep`/`comby`/`tree`/`gh`/`code-review-graph` — through the platform package manager. Dry-run
previews; `--apply` installs. A blocked install on a locked-down box is escalated as an IT ticket
rather than failing silently. On large repositories, the generated agent canon treats
`code-review-graph` as a fail-closed prerequisite: if it is unavailable, errors, or has no populated
graph, repository work stops until the graph is repaired and verified populated.

## aih ready

Readiness gate — one graded, blocker-aware verdict answering "can a developer start work with an AI
agent here, now?", composed from aih's read-only probes (runtime/TLS/PATH/core tools, per-CLI
loadability, contract, secret scan). Diagnoses by default (non-zero when blocked); the one
auto-fixable blocker (missing `rg`/`fd`/`jq`) installs under confirmation. Surfaces a `sec-ready`
panel in `aih report --v9`.

## aih session-guard

Inspect session/action text with the EPIC 5 session guardrails. `--text <text>` runs a read-only,
offline structured check for secret-like values and dangerous local actions such as destructive git/fs
commands, remote pipe-to-shell patterns, privileged operations, and publish/release commands. Results
reuse the verification pipeline shape, return bounded evidence, hash the input for correlation, and
never echo detected secret values.

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

Initialize a repo: profile + selected baseline + bootstrap-ai + scaffold + contract + secrets +
guardrails + mcp + sandbox + usage in one pass (one writer per file). `--baseline ecc|gstack|gsd` selects the Layer-1 canon
baseline and records the choice in `.aih-config.json`; `ecc` remains the default. ECC is a separate
gated network step — run `aih ecc` when ready (it points at ECC's own installer). For locked-down
MCP rollout, `--mcp-mode offline|none` and `--mcp-compliant` are forwarded to the MCP phase.
Under `--apply`, the usage phase writes `.aih/usage-record.mjs` and the git hook chain needed to
record local activity after the repo setup files have landed.
`--sidecar` adds an external project-truth sidecar (default sibling `<repo>-ai`) and records the
current git commit binding; if `HEAD` cannot be resolved to a real commit, sidecar init fails closed.
Use `--sidecar-path <dir>` to choose a different external sidecar directory; the path must resolve
outside the repository root.
`--v3` adds the structured bootstrap-intelligence lane: repo scan, gap analysis, capability install
plan, and derived `.aih/fingerprint.json`. Under `--apply`, it also writes committed capability
intent via `aih-capabilities.json` and refreshes the rebuildable `$HOME/.aih/capabilities/cache.json`.
The v3 lane stays offline and never treats `.aih/` or `~/.aih/` as authority.

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
ignored by `prune`; the digest says so and keeps the diff anchored to committed intent. When a
dropped CLI is an ECC-supported target, prune also plans ECC's own install-state uninstall through
`npx --yes --package ecc-universal ecc uninstall --target <cli>` under `--apply`, so ECC-owned
files and merge records are removed by ECC's recorded footprint rather than by path guessing.
When Codex is dropped, prune also subtracts the recorded ECC TOML footprint from
`~/.codex/config.toml` and the fenced ECC Codex block that `aih ecc` merges into
`~/.codex/AGENTS.md`, leaving unrelated user config and text outside that block intact.

A bare prune also reads `~/.aih/ecc/registration-ledger.json`, even when no committed CLI target
changed. Project registrations whose roots are missing retire from the machine union; common or
shared components and MCPs remain until their last live contributor disappears. The dry-run digest
names retired roots, orphaned component/MCP IDs, target states, and managed destinations without
changing bytes. Under `--apply`, prune mutates only exact operations proven by strict ECC install
state (plus aih's fenced Codex records), verifies every planned input hash and path again, writes
target state, and replaces the primary ledger last. Missing home-target state, malformed/drifted
state or markers, symlinks, concurrent input changes, or partial writes fail closed and roll back;
project-local state that never existed is not guessed.

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
(`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.kiro/settings/mcp.json`; legacy
`opencode.json` residues are advisory)
and root bootloaders that still carry an aih managed block are surfaced as manual advisories
instead of being edited or deleted. Dirty/untracked removal targets refuse without `--force`.

## aih ecc

Register [affaan-m/ECC](https://github.com/affaan-m/ECC) for the selected CLIs. The default is the
additive union of the locked common baseline, components detected from every registered project,
repeatable advance declarations (`--with lang:cpp --with framework:react`), posture-selected
security, and validated MCPs. Use `--profile full` only for an explicit full-surface install.
Unknown declarations fail closed. Kiro and unsupported targets remain consult-only guidance because
their installers cannot yet materialize the scoped union safely.

The primary registration ledger is `~/.aih/ecc/registration-ledger.json`. It records each project's
component/MCP contribution and each target's installed union plus evidence provenance. The ledger is
written atomically only after all selected target installs succeed. Re-running is idempotent; adding
a second project grows the machine union without removing the first project's surface. The ledger is
the authoritative input for `aih prune`: missing project roots are retired and only orphaned,
state-recorded aih-managed operations are removed in a rollback-safe ledger-last transaction.

The validated MCP default is pinned local `sequential-thinking`, repo-declared
`code-review-graph`/`codebase-memory-mcp`, and GitHub OAuth at team/enterprise. Context7, Exa, and
other egress-bearing servers are never defaults. Project config receives that project's set; global
target config receives the machine union, with existing user-defined same-name servers preserved.

aih fetches the catalog's exact commit into quarantine, verifies signed evidence for the installer
runtime and selected components, re-hashes the same tree, then filters ECC's manifest operations and
state preview to the selected surface. Dependency preparation uses
`npm ci --omit=dev --ignore-scripts` only after clearance.

For Codex, aih copies selected skills to `~/.codex/skills/<name>/SKILL.md`, installs selected agents,
uses ECC's add-only TOML merge helper for non-MCP settings, owns a fenced MCP block, and merges a
scoped fenced AGENTS supplement. It preflights genuine project/global MCP transport collisions while
allowing its own idempotent reruns. `--ecc-path <dir>` supplies an exact local checkout to the same
evidence gate, and `AIH_ECC_REF` requests a different exact commit; either must match vendor or
attributed org evidence for that pin. Non-SHA refs are refused.
Installed Codex skills are invoked on demand with `$<skill-name>` from
`~/.codex/skills/<name>/SKILL.md`; they are not an auto-loaded `.agents/skills` surface.
See [Baseline Component Evidence](security/baseline-evidence.md) for posture behavior and org
overrides. <!-- aih:claim CM-21 -->

## aih superpowers

Verify [obra/Superpowers](https://github.com/obra/Superpowers) (brainstorm → plan → TDD →
subagent-review skills) at the catalog's exact commit. The current marketplace/plugin-picker
adapters cannot prove that installed bytes came from the verified checkout, so aih does not execute
Antigravity, Copilot, marketplace, or TUI installs. It emits pin-aware manual guidance and explicitly
marks those selections as not evidence-covered. The Kiro methodology steering bridge is AIH-owned
first-party content, not mislabeled Superpowers vendor evidence. `AIH_SUPERPOWERS_REF` accepts only
an exact commit with matching vendor or org evidence.

## aih crispy

Run the CRISPY context-engineering stage machine (deterministic, gate-ordered).

## aih workspace

Scaffold a **multi-repo** workspace (parent-only): cross-repo architecture map (write-once) +
per-repo discipline, selected CLI bootloaders, a VS Code `.code-workspace`, graph MCP scoped per present declared child repo
with absolute root-anchored paths, and a `.aih-workspace.json` marker. Declare the scope with `--repos a,b` or an existing
`.aih-workspace.json`; detected child Git repos are reported as candidates but are not auto-enrolled.
With `--git`, the generated `.gitignore` defensively ignores all immediate child Git repos, including
ones outside the declared workspace scope.

Nested helpers keep the parent bridge current: `aih workspace init [root] --apply` is the nested
parent scaffold; by default it writes only parent workspace files and explains that child onboarding
is skipped. Add `--recursive` to run child `aih init --apply --context-dir <dir> --no-log` in each
declared child repo after the parent scaffold. Missing or non-Git children are skipped with an
operator note rather than being written through.

`aih workspace link <path> --apply` registers a child repo (optional `--id`, `--repo-kind`,
`--router`, `--owner`) and can author a parent-owned contract edge with `--from`, `--to`, `--kind`,
`--contract`, and `--consumer`; missing edge repo IDs fail verification and the command writes only
parent workspace files. `aih workspace snapshot --lock --apply` records the declared child repo
branch/SHA/remotes, and `aih workspace hydrate [root]` restores from that metadata by planning clones
for missing children and clean checkouts for present children that are at the wrong recorded ref.
Hydrate never edits remote configuration; a child with no recorded remote is skipped with an
operator note.

`aih workspace report [root] --apply` refreshes the parent `.aih/workspace-report.html` artifact
without writing child repos. Add `--refresh-children` to first run child
`aih report --format html --apply --no-log` in declared child repos, then regenerate the parent
rollup so the child report cells see the refreshed artifacts. Until a declared child exists,
`aih workspace --apply` emits a hydrate note and skips that child's graph MCP scope instead of wiring
an empty path.

**Skill governance & supply chain**

## aih trust

Vet, pin, and gate external GitHub repos and skills before an agent acquires them. `scan <target>`
grades danger (auto-exec hooks, dependency-confusion, typosquat, incoming-MCP, secrets) and emits
SARIF; `allow`/`pin` record reviewed sources + pinned SHAs in org policy; `list`/`verify` audit the
committed policy and trust-lock evidence. `skillspector-pin` reports the pinned SkillSpector image
tag, upstream commit, and digest; candidate inputs surface the upstream compare URL before accepting
a pin bump and flag reuse of the current tag with different bytes or source revision. With
`--approve-local-digest`, it can record a reviewed local SkillSpector image digest in
`trust.skillspector.approvedDigests[]` for the pinned source revision.

## aih skill

The **skill lifecycle** on top of `trust` — a complete governance loop for external agent skills.
`vet <src>` runs the read-only gate pipeline (shape, license, trust scan) to a
**GREEN/YELLOW/RED/UNKNOWN** verdict + a local evidence artifact (never installs).
For multi-skill sources, `vet <src> --name <skill> --apply` writes scoped evidence for
one logical skill; `card --name <skill>` and `approve --name <skill>` require that matching
scoped evidence rather than a source-wide report.
The deep-scan ladder records detector availability in evidence via `analyzersRun`: aih-native,
SkillSpector, Cisco AI Defense skill-scanner, Semgrep, Snyk Agent Scan, AgentShield, and the
MCP scanner when MCP config is present; detector findings escalate the verdict, while unavailable
required detectors fail closed at enterprise posture.
`card`/`approve --pin --owner` turn that evidence into committed governance: a skill card + a root
**`aih-skills.lock.json`** entry, behind a fail-closed chain (pin → evidence → approvable verdict →
license → owner; RED blocked, UNKNOWN refused, YELLOW = the manual review). The lockfile has
**install-time teeth**: `workspace add` refuses promoting a skill with no committed approval *for
that source's pinned commit* at `team`/`enterprise` posture (advisory at `vibe`) — a same-named
skill from an unrelated source never inherits an approval, and stale approvals are refused.
`inventory` joins on-disk skills against the approvals — approved / unapproved / stale-pin /
quarantined, one row per physical install — and feeds a "Skill governance" panel in `report --v9`.
`sync --name <skill> --cli <claude|codex>` materializes an **approved promoted** skill into the
selected CLI's machine skill-discovery directory. It is dry-run by default; `--apply` writes the
skill files to `~/.claude/skills/<skill>` and/or `~/.codex/skills/<skill>`, and the next
`inventory` call shows those copies under the `machine` root. Existing destination files are backed
up as `*.aih.bak` when overwritten; extra destination files are left in place, so `sync` is additive
rather than a pruning mirror.
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
emptied pack is dropped whole). `scaffold` seeds a bundled first-party pack (for example
`docs-quality`) into this repo's `packs/` tree and `aih-packs.json`, but it does not write
`aih-skills.lock.json`; the repo still has to vet and approve the copied local source before the
pack is ready. `plan`/`install` drive the gated two-phase acquisition once per
source — **gate ALL sources before promoting ANY**, promote only the pack's refs (subset-exact),
route drifted installs back through the gate, resume idempotently — fail-closed at every posture
(clean approvals required even at `vibe`; `--acknowledge` refused, acknowledgements stay
per-source). `uninstall` retracts every installed member with `skill remove`'s exact per-member
semantics — reversible archive (or `--delete`), approval + card dropped, loader-ref advisories, the
same refusal guards, and **one blocked member refuses the whole plan**; the manifest curation
stays. Installed skills' pack tags roll up in the report's Skill-governance panel.

## aih marketplace

Package approved, hostable skills into a **reproducible, verifiable distribution artifact** — a
directory a team can host anywhere (git repo or static host), never a registry/server. `build`
reads `aih-skills.lock.json` (the **approval authority**) and, for non-local approvals, emits the
exact vetted skill bytes (trust-lock hash cross-checked), the committed skill cards, the
content-addressed vet evidence, a `marketplace.json` manifest, and `SHA256SUMS` — byte-identical
across builds from identical inputs (no wall-clock; `--stamp` is operator-supplied), and
**fail-closed whole**: an approved non-local skill that is uninstalled, drifted, ambiguous, or
missing its card/evidence refuses the entire build. First-party approvals with `commit: "local"`
stay in the repo and are reported as excluded rather than packaged into marketplace bytes.
`validate` is the **read-only CI gate** over a built or fetched artifact (coded findings:
`marketplace.manifest-parse`, `marketplace.path-traversal`, `marketplace.missing-file`,
`marketplace.checksum-mismatch`, `marketplace.sums-coverage`, `marketplace.unapproved-verdict`,
`marketplace.signature`), containment-checking every manifest/sums path **before** touching the
filesystem with it. `publish` signs the artifact's `SHA256SUMS` (cosign or a GitHub attestation when
the local `gh` surface supports signing — a publish without a signer is refused; that's just a
build); `validate --require-signature` then
**fails rather than skips** when that signature can't be verified. Consumers stay on
`aih workspace add` — the vet gate still runs at consume time.

## aih policy

Schema and trusted-channel gates for the org policy. `validate` is the **read-only CI gate** over
the active local org policy source: the default committed `aih-org-policy.json`, or an explicit
`AIH_ORG_POLICY` override. The policy source is JSON only; JavaScript/module policy files are not
executed and fail as `org-policy.invalid` with remediation guidance. A missing default repo file is
a friendly skip (vibe repos carry no org policy), and a parse/schema failure is a coded finding
(`org-policy.invalid`) — or, under
`--bundle <path>`, over a distributable **policy-bundle envelope**
(`org-policy.bundle-invalid`, naming which layer failed: the envelope or the embedded policy).
`verify --against <sha256|bundle>` compares the active policy (including an explicit
`AIH_ORG_POLICY` override) with a pinned raw SHA-256, a policy-bundle JSON envelope, or a fleet
bundle directory containing `files/aih-org-policy.json`; mismatches fail closed as
`org-policy.drift`.

## aih evidence

`vet-baseline <source>` runs the shared component vetter over an exact local checkout or quarantined
GitHub source and writes a typed report below `.aih/baseline-reports/` under `--apply`. It installs
nothing. Required flags are `--pin <40-character-sha>` and `--catalog ecc|superpowers`; optional
`--components <csv>` narrows the declared catalog. A local checkout's `HEAD` and a fetched source's
metadata must match the declared pin.

```bash
aih evidence vet-baseline affaan-m/ECC \
  --pin <sha> --catalog ecc \
  --components runtime:ecc-installer,module:optimization-workflows \
  --apply
```

`build` packages the **audit trail aih already emits** — approval lock, packs manifest, trust lock, skill
cards, vet evidence, run logs, report/SARIF outputs, and a verified staged truth pack when present — into
one deterministic **evidence bundle** (`build`): the exact fleet-bundle layout (`files/<rel>`
copies, `manifest.json`, `SHA256SUMS`,
optional `--sign cosign|gh`) plus `evidence.json`, a typed kind index and harness provenance block
(`aihVersion`, release tag, package name, checksum/signature asset refs, and verification command).
Byte-identical across builds from identical inputs (no wall-clock); absent artifact kinds are
skipped silently. At enterprise posture, or with `--require-signature`, signing is strict: a missing
signer, missing local signing tool, or failed signing exec emits coded `bundle.signature` evidence
instead of being treated as best effort. Re-check any copy with
`aih verify-bundle --bundle <out> --require-signature`.
Baseline reports are indexed as `baseline-evidence`; `build --sign gh --require-signature --apply`
produces the attributable bundle consumed by `trust.baselineOverrides[]`. See
[Baseline Component Evidence](security/baseline-evidence.md).

## aih truth

Project-truth sidecar commands. `aih init --sidecar --apply` creates the external sidecar and root
pointer. `aih truth pack` first runs the sidecar verification gate, then stages a token-bounded
Markdown + JSON pack under the sidecar's `truth/staging/` directory; agent-proposed truth changes
stage there first, and promotion back into repo-owned files still requires an explicit `--apply`
flow. `aih truth verify` detects drift and fails closed when the sidecar's commit binding differs
from `HEAD`, the asserted package version differs from `package.json`, a claimed `CM-xx` has no
`docs/CONTROL_MATRIX.md` row, or a superseded decision points at a missing target. Declarative
acceptance assertions flag `blocked:environment` for absent local requirements and
`blocked:vendor-specific` for vendor-specific requirements in vendor-neutral work. Declared
agent-evidence file probes are limited to public project surfaces, re-run by the harness, and
recorded in the verify report rather than accepted as prose. A verified pack can then be included by
`aih evidence build` as the hashed
`.aih/truth-pack.json` artifact; stale or malformed packs fail closed instead of being indexed.
<!-- aih:claim CM-13 -->

## aih bundle

Build a deterministic **fleet bundle** — the repo contract, org policy, and managed config packaged
with a checksum manifest (and optional `cosign` or `gh` signing) for distribution to a team or CI.

## aih verify-bundle

Read-only verification for a fleet or evidence bundle. It re-checks `SHA256SUMS` against the copied
bundle files and probes signature/provenance evidence. Without `--require-signature`, missing local
signature inputs skip honestly; verifier failures still fail the signature probe. With
`--require-signature`, missing signatures, missing verifier tools, missing GitHub `--repo`, and failed
verification are coded as `bundle.signature`. Use `--signer gh --repo <owner/repo>` for GitHub
attestations.

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

Scan for plaintext `.env*`/root `secrets/` paths, inspect known MCP config files for hardcoded
credential shapes or secret-looking key literals, and write agent deny rules + vault-injection
guidance. Findings report file/key/kind only, never detected values. `--verify` is posture-graded:
at `vibe` plaintext secret findings are warning-only, while `team` and `enterprise` return a
non-zero exit for plaintext paths, unsafe MCP config paths, or hardcoded MCP credentials. CI should
run with `--posture team`, `--posture enterprise`, or an org-policy posture floor. `--sarif <file>`
emits one result per finding for GitHub code-scanning. <!-- aih:claim CM-16 -->

## aih guardrails

Generate `.gitleaks.toml`, `.pre-commit-config.yaml`, and a GitHub Actions workflow for CI secret
scanning plus strong/network-copyleft license blocking. Generation is not activation: local
pre-commit enforcement requires `gitleaks`, `pre-commit`, and `git config core.hooksPath .githooks`;
CI enforcement requires committing the generated workflow and making the relevant jobs required
checks on protected branches. <!-- aih:claim CM-17 -->

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
dry-run previews, `--apply` appends (idempotent per commit). `aih usage --apply` installs the
universal post-commit hook that runs `aih track --apply` automatically when Git uses the default or
a repo-local hooks path; external/global `core.hooksPath` configurations get chain guidance instead.
Kiro's `metrics-on-stop` hook (`aih bootstrap-ai --cli kiro`) records on agent stop.

## aih usage

Install the **multi-tool usage-capture** layer → `.aih/usage.jsonl` (rendered by `aih report` and
`aih report --v9`). The **universal floor** is a git `post-commit` hook that records commit
activity for **any** tool (it keys off the commit, not the agent) and runs `aih track --apply` so
`.aih/history.jsonl` accumulates one deduped trend sample per commit. It writes the active
repo-local hook path (`.git/hooks` by default, or e.g. `.githooks` when configured); external/global
`core.hooksPath` values are left untouched and receive a chainable snippet. The per-tool
**skill/MCP** layer wires in via each CLI's verified local hook (Claude/Codex/Cursor/Gemini/
Copilot/Windsurf/OpenCode/Kimi/Kiro/Antigravity). Zed has no hook surface, so
`aih usage --apply --cli zed` imports matching local `threads.db` rows read-only instead; pass
`--zed-threads-db <path>` to point at a specific database. Zed rows without matching repo folder
metadata are skipped, and continued threads refresh previous imported rows by stable local event id
instead of duplicating old tool calls. The importer is best-effort: the active Node runtime must
expose its built-in SQLite reader, and compressed Zed rows also need runtime zstd support; if either
is unavailable, hook setup still succeeds and no Zed rows are imported.
Skills aggregate by source (ECC/canon/user), and `--rollup <repo,repo>` aggregates local logs across
repos on demand. Usage is local activity counts only — **no cost, no prompts, no arguments**,
machine-local and gitignored. Session rows may include deterministic token/cache counters (`input`,
`output`, `cacheRead`, `cacheCreation`) so the local cache-economy panel can render live; empty local
sinks stay honest and point at `aih report --org <export>`.

## aih telemetry

Inject OpenTelemetry env, a redacting Bindplane collector, and an analytics fetcher (usage + skills
endpoints → `{ usage_report, skills }`).

## aih mcp

Generate the MCP server config **for the targeted CLIs** (`--cli`/`--all-tools`; otherwise the
committed `.aih-config.json` targets, then runnable installed CLIs on a first run, falling back to
Claude when nothing runnable is detected):
Claude/Kimi share `.mcp.json`, Cursor uses `.cursor/mcp.json`, and Kiro uses
`.kiro/settings/mcp.json`; Codex gets native TOML in `~/.codex/config.toml` (including
`bearer_token_env_var` for token auth), OpenCode gets its global
`~/.config/opencode/opencode.json` `mcp` map, and Copilot/Zed or other global-config entries get
their registry-specific native writes or guidance. If first-run detection selects global config
targets, the plan emits an MCP target-selection digest because `--apply` can affect that CLI across
all projects. Scopes:
local/project/remote. For locked-down orgs,
`--mode offline` (vendored local-command servers) or `--mode none` (no MCP + a CLI-tool fallback)
plus a `managed-mcp.json` admin template. Enterprise org policy can also tune the hosted GitHub
MCP entry: `mcp.incumbentHosts` declares which vendor hosts are reachable/incumbent,
`mcp.githubHost` points at a GHES or internal GitHub MCP origin, and `mcp.disabledServers`
can remove `github` entirely. Without committed org policy, the legacy github.com default remains
unchanged; with committed org policy, the GitHub host must be declared incumbent before it passes
the enterprise gate. `GITHUB_HOST` may supply the same https origin when no policy host is set.
For vetted third-party MCP, add the server to `mcp.allowedServers` and keep reviewer evidence in
`mcp.approvals`; `aih mcp approve <server> --accept-egress --reason "<why>" --apply` writes that
local policy entry with a subject fingerprint for the current server shape. Without `--apply`, it
previews the change. Hand-authored `mcp.approvals[]` entries must include `server`, `subject`,
`acceptEgress: true`, `reason`, and ISO-8601 `approvedAt`; `reviewer` is optional. When
`AIH_ORG_POLICY` is set, edit the distributed org policy directly because it wins over local files
and `aih mcp approve --apply` refuses repo-local approval writes. `allowedServers` narrows the
managed stdio allowlist only when `mcp.allowManagedOnly` is true. At Enterprise posture, a normal
apply keeps the full generated server set but warns when policy denies any server; add
`--mcp-compliant` to omit denied generated servers from MCP client configs and list them with reasons
in the governance guidance. Use the same flag on `--verify` to verify the compliant plan.
<!-- aih:claim CM-18 -->
GitHub auth defaults to `--github-auth oauth`, which works for clients with a registered OAuth
app; use `--github-auth token` for clients that need a PAT-backed `Authorization` header. The token
value is never written into MCP config — the header references `${GITHUB_PERSONAL_ACCESS_TOKEN}`
and `.env.example` documents only that placeholder. Token auth ignores ambient `GITHUB_HOST`;
non-default hosted GitHub MCP endpoints must come from committed org policy and incumbent hosts.
Before writing MCP client config, `aih mcp` surfaces hygiene warnings for entries that would
retry-fail because an env placeholder is unset or a URL host is a placeholder such as `*.example`.
For OpenCode, those unsafe generated entries are written with `enabled:false` so the client does not
retry them on startup until the operator fixes the env or URL. Under `--verify`, npm-backed MCP
package pins are compared with the configured registry response so version-pin drift is visible.

## aih sandbox

Generate a devcontainer + managed sandbox settings (egress allowlist, `failIfUnavailable`).

**Verification**

## aih docs-lint

Read-only BetterDoc documentation lint. It scans the public-facing Markdown surface <!-- aih:claim CM-12 -->
(`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/`, and `guides/`, excluding internal
report specs under `docs/specs/`) using the phrase and claim guidance in
`packs/docs-quality/betterdoc/references/slop-lint.md`. Prose
guidance emits coded advisory findings (`docs.banned-phrase`, `docs.vague-absolute`,
`docs.unsupported-callout-claim`) without failing the run. Hard claim-ledger orphans fail closed:
`<!-- aih:claim CM-xx -->` markers must resolve to `docs/CONTROL_MATRIX.md`, each matrix row must
cite at least one named regression test that exists, and changed feature files need a docs or
control-matrix update so public claims can detect drift. A missing rules file emits
`docs.rules-missing`.

## aih doctor

Fail-closed verification of the workstation/repo configuration (+ workspace mode: validates each
child repo). Includes a **canon markdown lint** (read-only) over the scaffolded `ai-coding/` tree.
It remains read-only. `--posture enterprise` also runs the enterprise baseline attestation: MCP
servers from known repo-scoped MCP config files (`.mcp.json`, Cursor, Kiro, VS Code, and legacy
OpenCode residues)
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
