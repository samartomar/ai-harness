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
trust guidance. On Windows and macOS, it also propagates GUI-safe Node trust; fully
relaunch GUI applications after applying the change. Packaged application behavior
remains operator-verified.

## aih cleanup

Report framework contamination in the Claude USER scope (`~/.claude`) with a countable
leakage summary, then remediate it opt-in: a bare run only previews the plan; `--apply`
executes with a backup-manifest-first discipline (targeted key/hook removals — a shared
settings file is never replaced); `--rollback <backupRoot>` restores a prior backup with
per-file digest checks; `--include-unknown` widens past framework-attributed surfaces.

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
AI-Harness upgrades, install the exact active Core line with
`npm install -g @aihq/core@0.1.1`; its npm package and matching GitHub Release
evidence are public. The frozen `@aihq/harness@6.1.0` package is npm-deprecated
and remains available only for existing consumers that have not migrated; new
installations use `@aihq/core`. Add `--force` only when replacing a
broken global install after reviewing the current workstation state. For the
same bounded origins, it compares OS and
Node TLS handshakes, tries system trust before a minimal set of matched OS roots, and persists a
candidate locally only under `--apply` after it verifies. `--scope certs,npm,path,mcp,all`.

## aih tools

Install the agent shell tools the harness leans on — `rg`/`fd`/`jq` plus
`ast-grep`/`comby`/`tree`/`gh`/`code-review-graph` — through the platform package manager. Dry-run
previews; `--apply` installs. A blocked install on a locked-down box is escalated as an IT ticket
rather than failing silently. On large repositories, the generated agent canon treats
`code-review-graph` as advisory blast-area context, not a gate: if it is unavailable, errors, or has
no populated graph, agents warn once and continue with bounded `rg`/`fd` reconnaissance, repairing
the graph only when helper repair is the assigned task.

Comby is optional; AIH does not provide a Windows-native installer for it. On Windows, when no
user-managed compatible package manager provides Comby, `aih tools` emits manual guidance and its missing
probe is an advisory skip — it does not block `aih tools` or `aih ready`.

## aih ready

Readiness gate — one graded, blocker-aware verdict answering "can a developer start work with an AI
agent here, now?", composed from aih's read-only probes (runtime/TLS/PATH/core tools, per-CLI
loadability, contract, secret scan). Diagnoses by default (non-zero when blocked); the one
auto-fixable blocker (missing `rg`/`fd`/`jq`) installs under confirmation. Surfaces a `sec-ready`
panel in `aih report --v9`.

The secret gate reports the finding's LOCATION class, because the remediation differs: a
git-tracked finding is `no-committed-secret` (rotate the credential and rewrite it out of git
history), while an untracked on-disk file is `no-plaintext-secret-on-disk` (rotate and move it to a
vault / env references). Both classes carry the same posture split (warn at vibe, gate at
enterprise) and no finding is ever dropped by classification: when git cannot answer — git is
absent, or `rev-parse` errors (for example dubious ownership) — every finding stays under the
committed class, the strongest gate.

## aih session-guard

Inspect session/action text with the EPIC 5 session guardrails. `--text <text>` runs a read-only,
offline structured check for secret-like values and dangerous local actions such as destructive git/fs
commands, remote pipe-to-shell patterns, privileged operations, and publish/release commands. Results
reuse the verification pipeline shape, return bounded evidence, hash the input for correlation, and
never echo detected secret values.

## aih live

Stream bounded, schema-owned progress from one human-invoked local AI CLI:
`aih live [root] --cli codex|claude|kimi --prompt-file <file>`. Exactly one `--cli` is required;
there is no default, detection, or fan-out. The optional positional `[root]` and `--root <dir>` use
the normal aih target-root contract, and the selected process runs in that root. The prompt must be
one deliberately named, bounded regular file containing strict UTF-8. Codex and Claude receive its
decoded text byte-for-byte through stdin; no shell command or wrapper contains the prompt.

Codex runs as `codex exec --sandbox read-only --ephemeral --json -`. Claude runs with
`--permission-mode plan --tools Read,Glob,Grep`, slash commands and session persistence disabled,
and no edit or Bash tool. Their progress, human/JSON success output, and human/JSON error messages
carry the exact safety label `read_only`. That label describes these pinned core CLI/tool modes, not
a clean-room attestation for every locally configured extension. Claude's
`--disable-slash-commands` disables its skills, but aih does not pass Claude `--safe-mode`; Codex
likewise does not ignore all user configuration. Native project/user instructions, plugins, hooks,
MCP configuration, or other vendor customization surfaces can therefore still initialize according
to the selected CLI and local configuration, and aih does not attest those extensions as read-only.

Kimi 0.29.2 has no help-verified read-only/no-tools prompt streaming mode. Selecting it therefore
requires `--allow-kimi-non-read-only`; without that acknowledgement aih fails before reading the
prompt or launching a process. Kimi is labeled `non_read_only` in progress and final output, may use
its native tools, and can change the selected worktree. Aih performs no worktree-safety or
dirty-tree preflight for this Kimi path. Aih does not add OS containment or claim a sandbox. Kimi's
prompt must travel as the single direct argv value required by its
`--prompt <prompt> --output-format stream-json` interface, so this path runs only a native Kimi
executable without a shell; on Windows, a `.cmd`-only Kimi installation is rejected. Aih never
prints that argv, but the prompt process argument can be visible to local process-listing and
inspection tools such as Task Manager, WMIC, or equivalent local utilities.

Progress is emitted immediately on stderr as capped generic events; malformed/unknown native stdout
and every stderr fragment become fixed signals rather than echoed content. One sanitized, bounded
terminal result uses the standard human digest or JSON envelope on stdout. `--timeout <seconds>`
defaults to 120. Every final success or error view identifies the selected CLI and its `read_only`
or `non_read_only` label. Aih itself does not choose skills or workers, schedule tasks, retain aih
agent memory, or run a council. The deliberately launched vendor CLI can still initialize the
native customization surfaces disclosed above; an acknowledged Kimi subprocess can implement
changes through its native tools as described above.

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
guardrails + mcp + sandbox + usage in one pass (one writer per file). `--baseline ecc` records the Layer-1 canon
baseline in `.aih-config.json`; `ecc` (bundling ECC + Superpowers) is the default and only selectable value. ECC is a separate
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

## aih change-profile

Classify one explicit normalized change-facts document with
`aih change-profile [root] --input <file>`. The adapter accepts only a named, bounded regular file:
`-`, stdin, directories, empty/oversized files, invalid UTF-8, multiple or malformed JSON documents,
unknown fields, contradictory facts, and classifier-invalid facts fail closed with
`AIH_CHANGE_PROFILE_INPUT`. It performs no gatherer, Git/worktree discovery, skill loading, live
invocation, or repository mutation.

The classifier remains a separate pure deterministic function. A valid run emits exactly one
standard `change profile` digest; in `--json` output the structured profile is
`digests[0].data`. Invalid input reports only stable, sanitized, bounded issue records—not the input
path, parser diagnostics, supplied content, revisions, root, or home directory. Current and previous
change paths containing C0/C1 control or bidirectional-control characters are invalid, so successful
human and JSON results cannot echo those characters from supplied paths.

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
`merge` rather than `overwrite`. Use `--baseline ecc` to render the Layer-1 references; the
choice is persisted so later `contract` and `bootstrap-ai` runs stay aligned.
For Kiro, steering is always projected. Standalone v1 hooks require the explicit
`--kiro-hook-runtime ide1-cli3` capability because finding `kiro-cli` cannot distinguish the CLI 2
default from CLI 3 mode. `cli2` and an omitted value leave hooks advisory; a valid selection is
persisted for later doctor runs. Existing files at reserved hook names are never overwritten.
Regeneration scope honors `--cli`: the run regenerates adapters/bootloaders only for the resolved
CLI set, and the `.aih-config.json` marker's `targets` are **replaced** with that set — an explicit
`--cli claude,codex` run narrows the persisted targets, so a later bare (marker-driven) re-run no
longer resurrects a previously bootstrapped CLI's adapter + bootloader. Because the set is replaced,
naming a partial list **drops the omitted CLIs** from recorded intent — `--cli codex` alone rewrites
`targets` to just `["codex"]`, so pass the full intended list and do not omit a CLI unless you mean
to drop it (see [guides/cli-lifecycle-guide.md](../guides/cli-lifecycle-guide.md)). Files for a
dropped CLI stay on disk untouched; remove them with `aih prune`.

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
`bootstrap-ai`. **Footprint convergence is deliberate here and beats CLI scope**: adopt regenerates
every bootloader that already exists on disk (an existing `GEMINI.md` is converged even when `--cli`
names fewer tools), because reaching the already-adopted state requires every existing bootloader to
carry the managed block; content outside the block is merge-preserved. The converged set is what the
`.aih-config.json` marker records. To actually drop a CLI's artifacts, use `aih prune`.

For Kiro, adopt inventories steering, standalone hooks, custom-agent definitions, skills, prompts,
settings, and specs. Every `.kiro/agents/**` definition, including Markdown, and
`.kiro/settings/*.json` remain operator-owned runtime configuration: they are reported but never
auto-migrated or rewritten. `--migrate-cli` can copy Kiro steering, skills, prompts, and specs into
the canon. Pass `--kiro-hook-runtime ide1-cli3` only when the converged target will load the
standalone IDE 1.x/CLI 3.x hook surface.

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
state (plus aih's fenced Codex records) and coordinates the unavoidable upstream uninstall inside
the same driver. Apply re-verifies every planned input, prepares recovery material, performs
aih-owned removals, runs the upstream uninstall, writes target state, and replaces the primary
ledger last. Missing home-target state, malformed/drifted state or markers, symlinks, concurrent
input changes, or partial aih-owned writes fail closed and roll back; project-local state that never
existed is not guessed. If an upstream uninstall may have mutated before failing—or a later step
fails after an upstream uninstall succeeded—the command emits `ECC prune divergence` with the
complete set of affected targets and paths, rolls back aih-owned changes, and never advances the
ledger. The driver budgets the outer transaction above the bounded sequential uninstall budget;
catchable POSIX `SIGINT` and `SIGTERM` during an active uninstall use the same rollback and
divergence path. It does not claim that upstream-owned bytes were restored. When a registration
ledger predates a Codex target record, prune retains the state-file-based Codex cleanup path instead
of treating the mere presence of a ledger as proof that Codex cleanup is coordinated.

## aih capability

Resolve the repo's agent-capability needs into committed intent plus a derived machine cache.
`capability resolve` scans the repo stack, emits evidence-backed decisions
(`{name, install, reason, evidence[]}`), writes root `aih-capabilities.json` under `--apply`, and
updates `$HOME/.aih/capabilities/cache.json` as a rebuildable cache. It never fetches, installs, or
vendors third-party bytes. At `vibe` posture detected capabilities are auto-add decisions; at
`enterprise` they are approval-required hints for the org policy/on-ramp.
`capability prune` rewrites only that derived cache, dropping repo entries whose committed
`aih-capabilities.json` is gone or unreadable and refreshing cache hashes/capability lists from
retained manifests. The committed repo file remains the source of truth; `~/.aih/` is safe to
delete and rebuild.

`aih capability package` is the policy-driven package reconciliation surface. The org policy
records only requested package roots and the GitHub repository identity of the committed pack
catalog; it does not carry pins, approvals, evidence, or package claims. The commands join those
roots against the exact local `aih-skills.lock.json`, `aih-packs.json`, Package Graph claims,
derived `aih-capability-packages.json` resolution manifest, ownership receipt, custody receipt, and
promotion trust-lock bytes.

```sh
aih capability package list [--json]
aih capability package show <package-id> [--json]
aih capability package status [<package-id>] [--json]
aih capability package doctor [--json]
aih capability package add <package-id> [--apply] [--json]
aih capability package update <package-id> [--apply] [--json]
aih capability package remove <package-id> [--apply] [--json]
```

`list`, `show`, `status`, and `doctor` are local read-only views. `add`, `update`, and
`remove` are also local read-only previews unless `--apply` is explicit. Preview emits no
filesystem action, process, network request, acquisition, or component load.

Apply reconciles only domain state that already exists under an authoritative receipt: GitHub skill
bytes in the repo promotion store bound by `.aih/trust-lock.json`, ECC agent/rule files bound by the
ECC materialization receipt, and HTTPS ECC MCP configuration bound by the explicit-add receipt.
Add/update publish derived intent, exact content-addressed custody, and ownership without fetching,
loading, or executing a component. Remove is permitted only after effective policy deselects the
package; it subtracts unchanged last-owned files, preserves shared members and unrelated domain
state, issues successor custody for retained packages, and retains drifted content with its prior
ownership. A mixed closure is coordinated in one ordered local transaction with compensating
rollback, not crash journaling or filesystem isolation.

If a requested root set differs from effective policy, preview or apply says
`refused at policy: selection-change-required`; the CLI argument never becomes policy authority.
Human and JSON rendering use the same typed result, and every fail-closed result names its stage and
stable reason.

## aih uninstall

Remove the core aih install footprint from a repo; `aih clean` is the same command. Dry-run
preview by default. Under `--apply`, marker-backed aih-owned whole paths (`ai-coding/` or the
committed context dir, `.aih-config.json`, `.aih/`, and marker-owned Kiro extras such as
`.kiro/steering/agent-tools.md`) move to reversible sibling
`*.aih.bak` backups, which avoids archiving into `.aih/legacy/` while `.aih/` itself is being
removed. The context dir and `.aih/` are only backed up when the root marker and generated canon
evidence agree; the Kiro steering extra requires the generated Kiro bootloader marker too.
Current `.json` and legacy `.kiro.hook` files at AIH-reserved names remain manual advisories because
the filename is not per-file ownership evidence. Otherwise these
paths are advisory/no-op. Co-owned files such as repo-scoped MCP configs from registered CLIs
(`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.kiro/settings/mcp.json`; legacy
`opencode.json` residues are advisory)
and root bootloaders that still carry an aih managed block are surfaced as manual advisories
instead of being edited or deleted. Dirty/untracked removal targets refuse without `--force`.
An active Kiro MCP projection receipt is handled before marker removal: uninstall subtracts only
unchanged receipt-owned `mcpServers` names and leaves unrelated top-level keys and servers intact;
drift or unsafe paths revoke the claim without mutating `.kiro/settings/mcp.json`.

## aih ecc

Register [affaan-m/ECC](https://github.com/affaan-m/ECC) for the selected CLIs. The default is the
additive union of the locked common baseline, components detected from every registered project,
repeatable advance declarations (`--with lang:cpp --with framework:react`), posture-selected
security, and validated MCPs. Use `--profile full` only for an explicit full-surface install.
Unknown declarations fail closed. The ordinary native-installer path keeps Kiro and unsupported
targets consult-only because their installers cannot materialize the scoped union safely. The
governed lifecycle described below has a separate verified Kiro rules-and-skills adapter.

The AIH-owned Claude/Codex profile has a separate, explicit lifecycle mode on the same command:

```sh
aih ecc --lifecycle install <project>
aih ecc --lifecycle update <project> --apply
aih ecc --lifecycle repair <project> --apply
aih ecc --lifecycle rollback <project> --apply
aih ecc --lifecycle uninstall <project> --apply
```

Lifecycle mode always projects the reviewed Claude and Codex surface together. It authenticates the
exact ECC pin, the committed review receipt, every manifest, and every projected source byte before
constructing a target plan. Dry-run is the default and may acquire the exact remote source into a
disposable quarantine so the preview is based on real rendered bytes; it never writes the target.
`--ecc-path <dir>` supplies an existing exact checkout to the same boundary. Lifecycle receipts live
under `.aih/ecc-profile/` and make repeat install, repair, update, rollback, and uninstall fail closed
on foreign or operator-modified files. Repair, rollback, and uninstall use the receipt's bounded,
hash-authenticated installed bytes and source identity, so a later package pin cannot strand an
older managed installation. Legacy selection flags such as `--profile`, `--with`, and `--cli`
cannot be combined with `--lifecycle`.

In a **governed** repository (an org policy carrying `governance`), `--lifecycle install` is not this
profile installer: it materializes the policy's evidence-passed component selection AIH-directly, and
removal lives in `aih uninstall`. That governed install does read `--cli`, because which tools a
materialization lands for is the ordinary workstation target selection — `--cli`, `--all-tools`, the
committed `.aih-config.json` targets, else the `claude` default. At Enterprise posture, the active org policy must carry a non-empty `governance.supportedClis` allow-list; omission fails closed with the current registry ids and a paste-all remedy, never a wildcard. At Vibe posture, omission is unrestricted. A present list at either posture is the organization sanction gate and refuses any selected, detected, or marker-derived CLI outside it by name. The materialization capability gate then allows only `claude`, `codex`, `kimi`, `cursor`, `opencode`, and the single `kiro` identity; a sanctioned CLI outside that set is refused as not a governed materialization target. Four of the generic targets carry their own project root —
`.claude/`, `.codex/`, `.cursor/`, and for Kimi `.kimi-code/`, which is where the framework's own
Kimi adapter roots a project install. OpenCode materializes only the tool-shared project surfaces
(`AGENTS.md`, `.agents/plugins/`, `.agents/skills/`), because its only framework adapter is
home-scoped and no evidenced per-tool `.opencode/` content layout exists; every other component
refuses by name for that target rather than landing in an invented directory. Kiro materializes an
evidence-passed selected `agent:<name>` with exact pinned Kiro mappings as the selected source
Markdown at `.kiro/agents/<name>.md` for the IDE representation and the curated
`.kiro/agents/<name>.json` CLI configuration. It projects a selected `skill:<name>` only as the exact pinned
`.kiro/skills/<name>/SKILL.md` file, and `baseline:rules` only as top-level pinned
`.kiro/steering/*.md` files. Those bytes require a separate current, unheld
`runtime:ecc-kiro` content authorization recorded beside the selected component identity. Current
[Kiro custom-agent documentation](https://kiro.dev/docs/custom-agents/) (verified 2026-08-13)
describes JSON and Markdown agent configurations loaded from `.kiro/agents/` by IDE 1.x and CLI
3.x. AIH projects both exact ECC mappings under one component receipt; it does not synthesize or
convert either representation. An unmapped agent is refused by name; a pre-existing same-name
Markdown/JSON or case-folded operator definition is refused without overwrite. Non-empty agent MCP or hook
configuration, every other Kiro surface, and
the native installer remain outside this lifecycle. The mapping is source-documented and
receipt-verified; it is not a live host probe. Several targets in one
run are one materialization into one root with one receipt: destinations two targets share
(`AGENTS.md`, `.agents/plugins/`, `.agents/skills/`) are written once, a target that refuses a
component does not stop the targets that own it, and a later `--apply` with a narrower target set
subtracts the dropped target's files and reports each removal.

ECC MCP approvals have a separate explicit Add/Remove surface:

```sh
aih ecc mcp add <ecc-mcp-id> --cli <client> --root <project>
aih ecc mcp add <ecc-mcp-id> --cli <client> --root <project> --apply
aih ecc mcp remove <ecc-mcp-id> --cli <client> --root <project> --apply
```

`add` requires exactly one explicit `--cli` target and a valid target-root `aih-org-policy.json`
whose `governance.eccMcpApprovals` approves the requested id at the pinned ECC catalog digest. A
present `governance.supportedClis` list must also sanction the selected client. It renders only the
approved HTTPS entry for that one client, preserves unrelated client config, writes
the client entry before `.aih/ecc-mcp-explicit-add-v1.json`, and pins both files against plan-to-apply
changes. Dry-run is the default. `remove` does not need current approval; it subtracts only an
unchanged entry whose receipt still proves AIH wrote that exact id/target/config digest. Missing,
malformed, unsafe, absent, or drifted state is report-only and leaves the client config untouched.
The write set covers project-local JSON for Claude `.mcp.json`, Cursor `.cursor/mcp.json`, Copilot
`.vscode/mcp.json`, Kimi `.mcp.json`, and Kiro `.kiro/settings/mcp.json`; global JSON for Antigravity,
Gemini, Windsurf, OpenCode, and Zed; and Codex TOML. Global writes opt into an execution-time
trusted-HOME containment and no-symlink-parent guard. Doctor reports clean, absent, altered, revoked,
malformed, or unsafe receipt/config state from local files only. This command does not contact an endpoint,
scan remote tools, attest behavior, install all approved MCPs, or treat approval as automatic projection.

The same lifecycle manages project-local Claude and Codex hook/MCP registration without claiming
either client's whole shared settings file. It adds one AIH composite hook per supported native
event, registers the reviewed MCP identities, preserves unrelated operator entries, and records
the exact Node/AIH launcher bytes plus each owned config fragment in
`.aih/ecc-profile/native-registration-v1.json`. Native state stays outside the project under the
platform state directory; set `AIH_ECC_STATE_ROOT` to an absolute external directory to override
that location. Conflicting server identities, linked launchers, overlapping state roots, modified
managed fragments, and partial second-phase installs fail closed; a failed registration after a
projection install triggers compensating projection recovery. Repair and rollback preflight the
projection and native registration before applying either surface, so recovery runs as one
filesystem transaction. The compound lifecycle uses its receipt-bound per-file ownership and
content-pin checks instead of treating its own managed projection as generic worktree dirt;
unowned files and intervening drift still fail closed. Serena starts only through the AIH
protocol guard with the exact reviewed package pin, offline resolution, isolated `SERENA_HOME`,
telemetry disabled, and the reviewed tool allowlist. Ordinary MCP-health failures remain visible
and advisory rather than blocking unrelated work.

The primary registration ledger is `~/.aih/ecc/registration-ledger.json`. It records each project's
component/MCP contribution and each target's installed union plus evidence provenance. The ledger is
written atomically only after all selected target installs succeed. Re-running is idempotent; adding
a second project grows the machine union without removing the first project's surface. The ledger is
the authoritative input for `aih prune`: missing project roots are retired and only orphaned,
state-recorded aih-managed operations are removed in a rollback-safe ledger-last transaction.

Evidence verdicts partition the request per component. Authorized components install; held
components do not, and the report names each held component with its evidence code and reason. A
mixed result is a successful partial install, not an all-or-nothing failure. The project entry keeps
the requested intent so a later evidence refresh can satisfy it, while target entries record only
the components and MCPs actually installed. Reconcile and prune operate on that partial target
surface without inventing held components. Structural evidence failures that make the partition
untrustworthy still fail the request, and aih refuses all installer execution unless
`runtime:ecc-installer` itself has an authorization receipt.

The validated MCP default is pinned local `sequential-thinking`, repo-declared
`code-review-graph`/`codebase-memory-mcp`, and GitHub OAuth at enterprise. Context7, Exa, and
other egress-bearing servers are never defaults. Project config receives that project's set; global
target config receives the machine union, with existing user-defined same-name servers preserved.

aih fetches the catalog's exact commit into quarantine, verifies signed evidence for the installer
runtime and selected components, re-hashes the same tree, then filters ECC's manifest operations and
state preview to the authorized selected surface. Dependency preparation uses
`npm ci --omit=dev --ignore-scripts` only after clearance.

For Codex, aih copies selected skills to `~/.codex/skills/<name>/SKILL.md`, installs selected agents,
uses ECC's add-only TOML merge helper for non-MCP settings, owns a fenced MCP block, and merges a
scoped fenced AGENTS supplement. It preflights genuine project/global MCP transport collisions while
allowing its own idempotent reruns. `--ecc-path <dir>` supplies an exact local checkout to the same
evidence gate, and `AIH_ECC_REF` requests a different exact commit; either must match vendor or
attributed org evidence for that pin. Non-SHA refs are refused.
For an exact remote pin, dry-run reads the shipped pin-bound install preview and prints the selected
target's stable file/merge/exec operations without fetching, invoking the installer, or writing a
target. Every row is marked `contingent on evidence authorization`: it previews what the authorized
install phase would attempt and does not claim that evidence has passed.
Installed Codex skills are invoked on demand with `$<skill-name>` from
`~/.codex/skills/<name>/SKILL.md`; they are not an auto-loaded `.agents/skills` surface.
Per-mechanism claims are registry-driven. Each target declares how ECC installs for it — ECC's npm
installer, the cached checkout plus add-only Codex merge helpers, ECC's native `.kiro/install.sh`, or
consult-only — and the summary emits only the claims true for the selected targets. An unmapped
target defaults to consult, so a newly registered CLI installs nothing rather than inheriting a claim
that is false for it. No mechanism replaces already-installed content, so a rerun cannot re-scope an
existing install.

Kiro installs are ownership-tracked so a stale copy is visible. Because ECC's own installer writes
the bytes, aih attributes ownership by what a run CREATES: it snapshots `.kiro/` before the
installer, re-walks it after a successful install, and records each created file's sha256 plus the
ECC commit it came from into repo-local `.aih/ecc/install-manifest.json`. That location survives
target-directory cleanup and is never committed. A later run re-checks each recorded path: a matching
hash from an older commit is *stale*, a changed hash is *locally modified* and is never
auto-replaced, a recorded path that is gone is *removed*, and anything with no record is *unknown
provenance* and is never claimed or touched. Kiro's installer copies only absent destinations, so a
rerun cannot clear a stale finding — replacing that content is deliberate operator work and is not
automated.

The finding is advisory (`ecc.install-drift`), so it reports without failing the run. Installs
predating the manifest have no record and report as unknown provenance until reinstalled; ownership
is never inferred from a content match, which cannot distinguish an aih-written file from a
user-authored identical one. A missing or unreadable manifest fails closed the same way. Codex and
the npm targets install into home-scoped directories shared by every repo on the machine, so they
declare no managed root and receive no ownership claim at all.

See [Baseline Component Evidence](https://github.com/samartomar/ai-harness/blob/main/docs/security/baseline-evidence.md) for posture behavior and org
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

Parent-only is enforced, not just documented: if a targeted root bootloader already opens an
`ai-canonical:shared` block (i.e. the directory was bootstrapped as a repo by `aih bootstrap-ai`) —
including one whose closing marker was truncated — the command refuses with
`AIH_WORKSPACE_BOOTLOADER_CONFLICT` and writes nothing — dry-run included,
so the plan never advertises a write that `--apply` would reject. A directory is either a
bootstrapped repo or a workspace parent, never both. Run `aih workspace` from the parent directory
instead, or pass `--force` to take the documented overwrite (the original is backed up to
`*.aih.bak`).

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

`aih workspace graph [root]` projects the declared contract relations in `.aih-workspace.json` into a
queryable cross-repo graph — declared over inferred: the declarations are the source of truth, and
the per-repo workspace graph MCP servers are optional enrichment, never required for declared
coverage. The projection is a pure function of the manifest (nodes from `repos[]`, edges from
`edges[]`, each edge marked `provenance: "declared"`); `--apply` writes it to
`.aih/workspace-graph.json`, and `--repo <id>`, `--from <id>`, `--to <id>`, and `--kind <kind>`
filter the printed edge table (`--json` carries the same graph, query, and matches). It fails closed:
a declared edge endpoint or a query repo id that does not match a declared repo id is an error, so a
typo can never read as "no dependencies".

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
Trust scans build one path-and-size inventory, stream bounded progress to stderr before and between
external detector boundaries, and keep `--json` stdout as one parseable result. Command-owned
GitHub quarantines are removed after success, block, or error; `trust scan --keep-quarantine` is the
only retention path and prints the retained temporary path to stderr.
An applied GitHub scan also requires its generated quarantine metadata to be one bounded regular
file whose owner, repository, ref, resolved commit, source name, and tree path bind the exact
requested source. The record is checked before and after analyzer execution. Missing, unreadable,
malformed, mismatched, or replaced metadata is a named blocking result; an explicit caller `--pin`
is an expectation and never substitutes for fetched provenance.

## aih skill

The **skill lifecycle** on top of `trust` — a complete governance loop for external agent skills.
`vet <src>` runs the read-only gate pipeline (shape, license, trust scan) to a
**GREEN/YELLOW/RED/UNKNOWN** verdict + a local evidence artifact (never installs).
For an applied GitHub vet, the evidence artifact receives a commit only from the same strict,
before-and-after quarantine metadata check used by `trust scan`; an untrusted metadata record keeps
the verdict `UNKNOWN` and omits the commit rather than falling back to the requested pin.
For multi-skill sources, `vet <src> --name <skill> --apply` writes scoped evidence for
one logical skill; `card --name <skill>` and `approve --name <skill>` require that matching
scoped evidence rather than a source-wide report.
The deep-scan ladder records detector availability in evidence via `analyzersRun`: aih-native,
SkillSpector, Cisco AI Defense skill-scanner, Semgrep, Snyk Agent Scan, and the
MCP scanner when MCP config is present; detector findings escalate the verdict, while unavailable
required detectors fail closed at enterprise posture.
Ordinary visible Unicode is retained as a non-blocking warning; actual bidi, zero-width, tag,
unexpected control, and executable-token confusable characters remain blocking. Generic detector
findings, documentation/code examples, and broad autonomy are warnings unless native/contextual
evidence elevates them. External network/credential use and unresolved skill-license metadata are
review-required: they warn below enterprise, while enterprise requires
`--acknowledge <fingerprint[,fingerprint...]> --reason <reason>`. A top-level repository license
resolves scanner-only missing-frontmatter findings. Generic results in regular non-executable
`LICENSE*`, `COPYING*`, or `NOTICE*` files are visible warnings at every posture. Raw scanner
occurrences remain available even when a duplicate is normalized or an obvious semantic
contradiction is suppressed. Corroborated danger remains blocking and cannot be acknowledged.
`card`/`approve --pin --owner` turn that evidence into committed governance: a skill card + a root
**`aih-skills.lock.json`** entry, behind a fail-closed chain (pin → evidence → approvable verdict →
license → owner; RED blocked, UNKNOWN refused, YELLOW = the manual review). The lockfile has
**install-time teeth**: `workspace add` refuses promoting a skill with no committed approval *for
that source's pinned commit* at `enterprise` posture (advisory at `vibe`) — a same-named
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

Starter seeding, portable authoring, effective-resolution, schema, projection, and trusted-channel gates for the org policy.
`aih policy generate` is deliberately rootless with respect to a governed target repository: it writes a self-contained
Policy Workbench and does not inspect a target repository, resolve repository state, or append a repository run ledger. Its
parsed `--root` and `AIH_ROOT` compatibility inputs are ignored; the current directory is used only to contain a relative
`--out` path. Its one optional positional is an administrator root rather than a target repository — see
"Administrator catalog consumption" below. The remaining `policy`
subcommands are repo-scoped and accept the conventional optional `[root]` positional — `aih policy validate .` works exactly
like `aih init .` (`--root` and `AIH_ROOT` still apply). The `policy supported accept|inspect`
administrator commands use `--root <target>` instead of a positional root so their input surface
contains only the exact decision binding and code-owned target.

`generate --apply` writes `aih-policy-workbench.html` (or `--out <path>`). The workbench authors and downloads the actual
`aih-org-policy.json` schema, with schema-backed audit references for ECC or Superpowers agents, skills, and commands.
At Enterprise posture, its protected-file form also authors organization-qualified Decision V2
records for exact GitHub, npm, PyPI, OCI, remote-content, or AIH source identities classified
as tools, skills, MCP servers, packages, or profiles. The administrator enters ordinary fields for targets, effects, evidence,
issuer, actor, policy, and control; Web Crypto computes the domain-separated source, subject, and
revocation digests. The read-only preview and `aih-policy-bundle.json` download are PolicyBundle V2,
and Core's exported parser accepts the same bytes. This surface accepts no editable raw-JSON decision
or bundle input. Vibe continues to export only ordinary repo-local policy and cannot generate
authority.
The protected-file decisions authorize only the effects named in the exact decision and supported by
a closed Core lifecycle; the Workbench itself performs no install, projection, or execution.
Separately, external-curation records remain guidance only: AIH does not install, project, or enforce those external assets. Its
catalog is an authoring projection of the same pinned AIH controls and framework catalog data used by the engine; it does
not scan a repository. The workbench can also author `governance.supportedClis`, the organization-sanctioned CLI
allow-list. At Enterprise posture it is required and non-empty; omission is refused with the current registry ids and a paste-all remedy, while wildcard sentinels are not supported. At Vibe posture omission is unrestricted, and a present list enforces at either posture. The list is independent of activation targets: sanctioned, materialization-capable, and projector-capable are three separate host sets. Browser import/export preserves policy semantics, including pinned stdio candidates, fenced remote endpoint candidates, annotations,
signed-approval clarification, and external curation intent. A newly authored
remote candidate records only an exact HTTPS origin, approval metadata, an
administrator-managed `approved` or `revoked` status, and an explicit
no-content-scan marker; the workbench never contacts or scans that endpoint.
Imported legacy digest/verdict records remain exact and read-only until removed
and recreated under the administrative-status model. The workbench can preflight JSON and preserve an
imported authority receipt's subjects in `governance.authority.approvals`, but it does not verify a receipt or make any
approval effective. It can separately import one strict standalone `GovernanceDecisionV1`, render its
untrusted fields as text, and download the same deterministic canonical bytes as the headless parser.
The record stays outside the policy and receipt state and is always labeled unverified and not effective;
the browser cannot edit, verify, sign, fetch, resolve, project, or materialize it. Invalid and out-of-order
replacement reads fail closed without changing the decision displayed when the latest import began.
Target-repository `evaluate` remains the source of effective state. Both custom-MCP forms remain pending,
hard-blocked candidates with no activation affordance until supported scanning, evidence, and projection exist.

The left rail is the sole selection surface for ECC languages, frameworks, capabilities, and modules; those controls are not repeated in the main inventory, preset toolbar, or inspector. The flat Ledger paper-and-ink presentation reserves colour for evidence state, supports a neutral dark theme, and keeps that canonical rail available on compact screens. The inspector contains no policy mutation controls: it narrates the selected-to-materialized journey and routes one next action to the canonical selection or a separate authoring sidebar. A separate Add MCP sidebar authors approved/revoked `governance.eccMcpApprovals` records at the pinned catalog digest. It lists all 31 external ECC entries and records declarative permission. Only entries labeled HTTPS-configurable can use the later `aih ecc mcp add <id> --cli <client>` path; manual entries remain approval-only. The browser does not install, contact, scan, attest, or observe the endpoint.

A separate adoption-recipe panel is the first bounded, code-owned routing guide rather than another
inventory or authoring surface. It gives exactly one question class to each of Token Savior, Serena,
code-review-graph, codebase-memory-mcp, and Token Optimizer; states the prerequisite and overlap
boundary; names the existing Workbench-row, AIH ECC lifecycle, or ECC approval/manual route; and
reports only the usage signal the local capture layer can attribute. Token Savior explicitly has no
captured attribution. The panel is escaped and inert: it adds no row or control, changes no policy
export, executes no provider, and grants no evidence, authority, effective state, projector, or
materialization. It is not a generic signed-recipe or catalog-distribution plane.

### Administrator catalog consumption

`aih policy generate <admin-root>` opts a single administrator workstation into signed supported-catalog consumption before
the Workbench is rendered, and requires `--apply`: a non-applying invocation fails before acquisition, subprocess, cache,
or output effects. Omit the positional and nothing changes: the portable artifact is written with no acquisition, no
subprocess, and no cache work. Developer seats never take this route.

The route starts from one canonical `admin-catalog-bootstrap.json`. At Enterprise posture — selected only by an explicit
`--posture enterprise`, never by an environment variable — it is read from a fixed OS/admin-managed location
(`C:\ProgramData\aih\admin-catalog` on Windows, `/Library/Application Support/aih/admin-catalog` on macOS,
`/etc/aih/admin-catalog` elsewhere) and there is no fallback to the copy under `<admin-root>`. At Vibe posture it is read
from `<admin-root>/.aih/admin-catalog` and reported as the visibly weaker `local-admin-file` provenance, which is never
Enterprise-eligible. The bootstrap pins the HTTPS locators, the catalog/promotion/package digests, both signer identities and
their distinct root digests, separate catalog and administrator workflow/bundle identities, the schema and effect versions,
the source and channel, and a bounded cache policy. Its authority-controlled catalog path segment must be real directories
rather than symlinks or junctions before the bootstrap file is read.

Resolution degrades fresh → revalidated verified cache → packaged, and only a literal acquisition failure permits the
fall-through: every trust, pin, cache, or attestation failure is fatal before rendering. Fetched and cached artifacts and the
administrator distribution are independently verified with their respective pinned workflow and bundle by `gh attestation
verify`, bound to the pinned repository, issuer, ref, and predicate; that verification completes before any material is
admitted. The inner catalog-head DSSE PAE and
signatures must exactly match bootstrap-carried state, so outer artifact provenance cannot authorize a replacement head
signature. AIH never signs on the workstation and holds no key material — the administrator distribution is pre-signed by an
external organization-admin OIDC workflow, and the locally composed binding must reproduce those exact canonical bytes. The
visible Workbench provenance line then shows verified tier, source, channel, resolved time, download age, and bootstrap
provenance. The embedded safe model also carries sequence, digests, posture, and verification time; neither surface carries
locators, filesystem paths, tokens, signatures, raw attestations, signer identities, root digests, or machine detail.

The Workbench's ECC hook-controls panel is bound to the pinned runtime inventory: 40 individually gated hook IDs plus one non-disableable Bash wrapper. It authors a required Minimal, Standard, or Strict profile and an optional canonical disabled-ID list, prunes disables that are ineligible after a profile change, and offers a clear inverse back to the policy baseline. AIH configures supported Claude environment intent; ECC executes and enforces it after process spawn.

The headless schema also accepts a declarative remote record with an
administrator-managed `approved` or `revoked` status and no tool-surface digest.
It still requires the exact HTTPS origin, approver, authentication mode,
permitted data classes, and `contentScanned: false`. Previously valid schema-v2
digest/verdict records remain readable; their `drifted` vocabulary is legacy
metadata, never evidence that AIH contacted the endpoint or a live blocking
check.

The headless schema also accepts `governance.eccMcpApprovals`. Each strict
record names one of the 31 external ECC catalog entries, the catalog's exact
raw source digest, an `approved` or `revoked` state, administrator,
authentication mode, and permitted data classes. Duplicate, unknown,
AIH-owned, or source-mismatched records fail closed. This field is declarative
seat-Add authority only: parsing it performs no client write, endpoint contact,
scan, projection, or tool-surface check. The explicit user-triggered Add
lifecycle is a separate command surface.

`init` seeds a starter `aih-org-policy.json` from **observed fleet state**, so authoring the policy
becomes a review exercise instead of a blank page — and a fresh enterprise setup passes baseline
attestation for aih-generated MCP servers without hand-editing. The starter declares exactly what
the attestation lens observes: catalog-bound MCP surfaces become `mcp.allowedServers`; surfaces
attestation force-undeclares (stale generated residue, non-catalog servers) are listed for review,
never silently declared; and marketplace surfaces are **never auto-trusted** — `trust.approvedSources`
grants acquisition trust beyond registry membership, so those entries stay an explicit review step.
Fail-closed boundaries: an existing policy is never overwritten (plan-time refusal plus an
apply-time absent pin), an active `AIH_ORG_POLICY` override refuses outright (the starter only
targets the committed default file), and an unreadable MCP config aborts the plan. The starter
records the resolved posture as `minimumPosture`, and `--verify` grades the written file with the
same schema gate as `validate`. Declaring `mcp.allowedServers` records registry membership only;
`aih mcp approve` is a legacy, non-governed approval path. Governed operators use an externally
verified evidence/approval receipt, then `aih policy evaluate` and `aih policy project`.

`project --apply` compiles the active verified org policy into generated policy artifacts. The source
may be the committed `aih-org-policy.json` or an Enterprise PolicyBundle V2 at an absolute external
`AIH_ORG_POLICY` path whose authority, custody, freshness, and exact file identity Core verifies. For
Claude this includes `.claude/managed-settings.json` and, at enterprise posture, the two system-path
examples; selected Kiro reviewed stdio MCP candidates are distributed separately to
`.kiro/settings/mcp.json`. An active
AIH-owned `usage-metering` policy hook may also project to the selected Claude or Codex host through
the existing host-specific generator. A policy may separately declare `governance.eccHookControls`; for a Claude target, projection merges only receipt-owned `ECC_HOOK_PROFILE` and `ECC_DISABLED_HOOKS` values into `.claude/settings.json.env`, preserves every operator sibling, refuses unreceipted collisions or drift, and shares one content-pinned settings snapshot with the hook registrar. ECC—not AIH—executes and enforces those controls after process spawn, so a disabled hook still incurs one spawn.
It does not run `aih init`, regenerate the canon, or modify unrelated settings. The managed settings/MCP
portion is a Claude projection: it writes only when Claude is selected (the default); `--cli cursor`,
for example, produces no managed-settings projection. When managed-only MCP is active, it records existing AIH ownership provenance in
`.aih-config.json` so later deactivation can remove only the exact generated values. It refuses a
configuration write when `AIH_ORG_POLICY` selects an ordinary override; previewing without `--apply`
remains inspectable. The only external mutation source is the exact protected PolicyBundle V2 that
Core has verified for the same path, and its bytes remain pinned through the transaction.

New Claude and Kiro MCP ownership records are always strict schema V2 and bind the exact effective
decision identity for their own surface. New usage-hook ownership records are always V3 and bind the
same decision facts plus the policy version under a domain-separated self-digest. The persisted
records are comparison and rollback evidence, never authority: freshly verified organization
authority is resolved first. Exact legacy MCP V1 and usage-hook V2 records remain readable only so
`project --apply` can conservatively subtract unchanged owned state or refresh the receipt without
rewriting unchanged host content. They never authorize a current decision-bearing effect.

`project --apply` is also the upgrade migration path: it replaces managed MCP allowlist entries an
earlier aih generation wrote (for example a pre-hardening bare `uvx <pkg>` launch shape or an older
version pin) and adds projection keys a newer generation introduced. When `aih doctor` can
positively attribute the whole on-disk difference to that generation history, it reports a
**generation delta** (`org-policy.generation-delta`, `mcp.allowlist-generation-delta`) naming
`aih policy project --apply` inline rather than implying a local edit; any unattributable
difference still fails closed under the ordinary drift codes.

`evaluate` is the read-only effective-policy gate. It compares each requested governed candidate with
the live AIH MCP or hook adapter and reports requested versus effective state, exact source and evidence
digest, approval reference, target coverage, projection ownership/receipt/drift state, clarification or
annotation, and the blocking reason. A config entry is not active merely because it is listed. Custom
stdio MCP candidates name a pinned package identity and HTTPS registry for curation/evidence only. They
remain blocked by the unwaivable `missing-projector` danger until AIH has an integrity-enforcing
materialization and rollback lifecycle; policy evaluation and projection never construct or launch their
commands. Unsafe inputs, collisions, missing projectors, unsupported targets, and all unwaivable danger
codes remain blocked.

When `governance.authority.decisions` is non-empty, each value is an untrusted decision-id reference.
Only the byte-exact copy inside a currently verified authority receipt V2 can affect resolution. A
current decision must join the exact candidate kind, source and evidence digests, AIH-shipped
reviewed-control digest, policy version, requested targets, registered effect set, and trusted
issuer. `approved` requires no observed dispositionable findings or accepted coverage;
`accepted-with-conditions` requires exact accepted-to-observed finding equality and a current review
deadline; `rejected` and separately signed revocation events withhold the effect. Missing, ambiguous,
expired, not-yet-valid, over- or under-scoped, or otherwise mismatched decisions leave the request
visible and ineffective. Findings stay findings in output, with a derived `clean` or `accepted` risk
state only after every other gate passes. Decision conditions remain in the signed authority record
and are deliberately omitted from public managed-settings and evaluate JSON.

The generic decision record reserves `acceptedGaps` for an explicitly registered waivable named-gap
class, but the current resolver registers none. Therefore current decisions must keep `acceptedGaps`
empty and report `observedGaps` as empty. Evidence gaps such as missing or unverifiable evidence remain
fenced prerequisites reported through the ordinary danger/blocker fields; an authority-bound decision cannot
turn them into accepted gaps or authorize an effect.

The target-coverage triplet separates capability from invocation state: `supported` lists targets with
a shipped projector adapter for that candidate, `available` lists targets selected in the current
runtime, and `complete` or `blocked` says whether those requested targets are covered by shipped adapters
and this invocation's selected runtime targets. Coverage alone does not make a candidate effective;
evidence, danger, and other blocking gates still apply. For example,
Vibe posture can report `supported=claude,kiro; available=kiro; blocked`: the Kiro workspace adapter
exists, but posture intentionally disabled this invocation. Custom stdio candidates without an
integrity-enforcing materializer continue to report `supported=none`.

Custom evidence, approvals, and governance decisions require verified organization authority.
The default Enterprise route is one PolicyBundle V2 JSON file at an absolute `AIH_ORG_POLICY` path
outside the governed target. It combines the ordinary policy with the exact V3 decision-authority
payload. Generate it through the Policy Workbench protected-file form; the `issuerRepository` field
is an attribution identity required by the reused V3 schema, not a requirement that the file live in
GitHub. Core accepts only current, strict, bounded, regular, single-link, non-symlinked custody,
re-observes the exact bytes, and pins them inside every authority-dependent mutating transaction.
Core never writes this
file and does not prove its host ACL; the organization must control both file replacement and the
process configuration that selects it. PolicyBundle V1 remains a validation/distribution envelope
and cannot grant authority. PolicyBundle V2 is Enterprise-only; Vibe and repo-local policy behavior
remain unchanged.
The installed `@aihq/core` library exports `PolicyBundleSchema` and `parsePolicyBundle` for decoded
structure validation; those object-level helpers do not enforce raw UTF-8 bytes, duplicate keys, or
the active-file byte limit, and successful parsing alone does not mint authority.
Existing lifecycle history retains the authority digest used by prior effects. A fresh target has no
separate global bundle-version high-water mark, so the organization's file distribution system must
prevent rollback to older policy bytes that remain within their validity window.

The optional GitHub transport continues to read `.aih/policy-authority-receipt.json` and requires
`gh attestation verify` against the out-of-band organization authority named by
`AIH_POLICY_AUTHORITY_REPOSITORY`; deployments may additionally pin
`AIH_POLICY_AUTHORITY_WORKFLOW`. Those process-environment values must be supplied by the
organization admin/runtime, never by `aih-org-policy.json`; the governed repository's remote is not
an authority root. The strict receipt format is published as
`schemas/aih-policy-authority-receipt.schema.json`. Neither transport treats unverified JSON as
authority. A decision binds candidate id/kind, immutable
source and evidence digests, projector, policy version, reason, signed clarification for a waiver, target scope, signer repository, and
validity window; legacy receipt inputs may omit clarification but cannot waive a gap, and its post-signing transport locator is not part of the signed digest. Requested ECC or
Superpowers framework intents remain visibly report-only and hard-blocked until a separately designed
policy-gated binding lifecycle exists — this command does not select, install, or project ECC/Superpowers
agents, skills, commands, or bindings. AIH-owned hook rollback removes only unchanged receipt-proven host
entries and retains drifted user edits for doctor remediation. When `governance` is present it exclusively
owns AIH MCP and usage-hook projection: `aih mcp` and `aih usage` fail closed, `aih init` suppresses their
generic phases, workspace graph MCP registration is suppressed, and governed ECC materialization strips MCP and
host-hook/runtime operations across core, platform, and full scope while retaining eligible agents, skills, and commands.
Use
`aih policy evaluate <root> --no-log --json` in CI and inspect the digest before `aih policy project --apply`.

Authority receipt V1 remains the legacy approval transport. Decision-bearing policy requires receipt
V2, whose decision and revocation arrays are strict, bounded, sorted, namespace-disjoint from legacy
approvals, issuer-checked, target-bounded, and time-bounded. A V1 receipt can never satisfy a decision
reference, and a decision present only in policy JSON has no authority. The portable Workbench's
standalone decision import is likewise an unverified inspection and canonical-transport view only: it
is not copied into the policy or receipt, cannot create authority, and cannot decide effective state.

### Strict V2 organization-qualified contract foundation

The public library and package schemas expose `GovernanceDecisionV2`, digest-bound
`GovernanceDecisionRevocationV2`, authority receipt V3, and
`UpstreamObservationReceiptV1`. The decision can identify an exact organization-chosen
tool, skill, MCP server, package, or profile through immutable GitHub, npm, PyPI,
OCI, remote-content, or AIH identity. Private npm/PyPI registry paths and complete
remote HTTPS endpoint paths remain part of the identity. Canonical library helpers
derive the source and subject digests; portable JSON Schema validates the closed shape,
while the TypeScript parser enforces those digest relationships. A qualification basis
must reference either the decision's exact attributable organization evidence or the
exact catalog signer identity, head, catalog, member, subject kind, and subject digest.
`aih-supported` and `organization-qualified` are derived qualification provenance, not
administrator-set status labels; absence from the maintained catalog is not a schema denial, and
`unqualified` is a non-effective resolver state rather than an approvable origin. Public policy
resolver results use exactly those three values in their `qualification` field; the older collapsed
`qualified` value is not emitted.

Organization evidence travels in the closed, canonical
`OrganizationEvidenceEnvelopeV1` contract. It binds the exact subject digest, a bounded
organization-defined evidence kind and record id, a public-safe summary, payload and artifact
digests, an issuer-claimed attestor, and a validity window. Core hashes the canonical bytes with
the `aih-organization-evidence/v1` domain and mints an opaque qualification capability only when
the digest, attestor, subject, scope, time, and exact Decision V2 reference all match an externally
verified receipt V3. The attestor field is an authority-issued attribution, not a separately
verified signer identity.

Receipt V3 carries only Strict V2 decisions
and revocations: unsigned policy or Workbench `approved` fields, legacy approvals,
and standalone decision files cannot enter authority. It becomes usable only through either the
protected PolicyBundle V2 transport or the optional GitHub-attested receipt transport. The separate observation receipt binds
the decision digest, exact subject and installed digests, registered targets/effects,
the named upstream integration owner and exact integration version,
code-owned verifier id/version/digest, explicit outcome, and an observation window of at most 24
hours, shortened by the authority, decision, or conditional-review deadline. Core's internal pure resolver accepts only the opaque verified authority capability,
an exact decision id/digest reference, and an opaque qualification capability; raw decisions,
evidence envelopes, revocations, and cloned capabilities are untrusted data. It reports
`observed-effective` only when those facts match a current approved or
conditionally accepted decision from that receipt. Missing, rejected,
revoked, stale, partial, refused, drifted, unknown, or mismatched inputs remain explicitly
non-effective. This slice mints organization-qualified capabilities only from a closed
`OrganizationEvidenceEnvelopeV1`, and `aih-supported` capabilities only from the
separately rooted, closed `AihSupportedQualificationReceiptV2` contract. Core reads its fixed
`.aih/aih-supported-qualification-receipt.json` transport through a bounded regular-file and
non-linked-parent boundary, copies the exact bytes into owner-only temporary custody, and runs an
absolute external `gh attestation verify` against both
`AIH_SUPPORTED_QUALIFICATION_REPOSITORY` and
`AIH_SUPPORTED_QUALIFICATION_WORKFLOW`. Those roots are required and cannot reuse the root bound
inside the opaque organization authority. Only after attestation succeeds does Core parse the exact
copied canonical bytes, require `organizationAdmission: "not-authoritative"`, and
exact-match the full Decision V2 subject plus catalog signer, catalog, head, member, subject kind,
subject digest, and qualification kind. Receipt V2 also binds the entry id, signer key, sequence,
predecessor, replay identity, and head validity ceiling; Receipt V1 is unsupported. Raw, cloned,
expired, substituted, replayed, rolled-back, or differently scoped receipts cannot mint the
process-local qualification capability. The portable schema is shipped at
`@aihq/core/schemas/aih-supported-qualification-receipt-v2.schema.json` in the
published `0.1.1` Core package.

A packed consumer may call `verifyAihSupportedQualificationArtifactV2` with only the target root,
the exact expected decision id/digest, and the exact expected subject. The package resolves the
root, constructs its production process runner from the live process environment, verifies the
organization authority before the separately rooted supported receipt, and takes a fresh UTC time
after authority verification. The result is only a scrubbed `verified` or `unverified` artifact
state. Because this inert call has no target or effect input, any other current, unrevoked rejected
decision for the same subject makes the result `unverified`. The package root does not export the
authority-bearing verifier and this call returns no
authority, receipt bytes, qualification capability, effect, or reusable evidence. A fake external
`gh` in a disposable test proves the process path only; it is not a public attestation.

`aih policy supported accept --root <target> --decision <id> --decision-digest <sha256>
--target <id> --apply` is the durable administrator step for the supported route. Before any
custody write, Core verifies the fixed Receipt V2 bytes against the dedicated support
repository/workflow root and verifies the separate current organization decision. The command
derives continuity only from the attested receipt. It writes bounded, canonical signer, replay,
head, and head-scoped member records under the posture-owned custody root using a fixed cooperative
lock, immutable slots, exact-original preconditions, and a head compare-and-swap. Genesis requires
sequence zero and the zero predecessor; a successor requires the exact current head and sequence
plus one. Same exact acceptance is zero-write. Gaps, rollback, replay reuse, signer-key mismatch,
removed members, linked paths, foreign records, capacity overflow, races, and partial state fail
closed.

At Enterprise posture, custody is held below the fixed OS administrator base; at Vibe posture it is
held below `<target>/.aih/supported-qualification/v2/`.
`aih policy supported inspect --root <target> --json` is strictly read-only and returns only a
deterministic, path-scrubbed list of members bound to current heads. Its `memberRecords` object
reports the fixed physical member-record `limit`, exact `occupied` count, and `remaining` capacity.
That count includes immutable records retained from superseded heads even though those stale members
are omitted from the current-head `members` list. Retained member records preserve replay and audit
truth, continue to consume the 4,096-record capacity, and are not pruned by this command or by
acceptance. At capacity, further member acceptance fails closed. Store migration or archival then
requires a separately authorized administrator incident-reconciliation procedure; AIH does not
silently delete or reuse the retained evidence. Inspect reports no receipt bytes, verifier output,
credentials, or
reusable capability. Catalog membership remains provenance; only the separately verified
organization decision supplies admission. Simulated test attestations are not public evidence, and
these commands perform no signing, release, or publication.

`aih policy resolve [root] --decision <id> --decision-digest <sha256> --target <id>
--effect <effect> --evidence <root-relative-file>` exposes the organization-evidence route as a
read-only, zero-write administrator command. It accepts only code-owned CLI targets and the fixed
`configure`, `install`, `observe`, or `use` effects. The evidence path must be a bounded
forward-slash relative path below the target root; the root and parent directories must be
non-linked, the file must be regular/non-linked, and the exact bytes and file identity are re-read
after organization authority is verified.
Authority comes only from the protected external PolicyBundle V2 or the optional fixed receipt with
out-of-band `AIH_POLICY_AUTHORITY_REPOSITORY` (plus optional
`AIH_POLICY_AUTHORITY_WORKFLOW`), never from the command line, standalone policy JSON, or evidence
file. JSON output uses closed reason values and contains no verifier text or filesystem path.

`aih policy resolve` intentionally supplies no upstream observation. A valid authority, decision,
scope, and organization qualification therefore returns
`qualification: "organization-qualified"`, `outcome: "partial"`,
`reason: "observation-missing"`, and a nonzero exit; every refusal is also nonzero. The command
reports `qualification: "unqualified"` when qualification was not established. It cannot report
`observed-effective`, append a run ledger, return a qualification capability, or scan,
install, configure, or execute the candidate. Policy evaluation does not treat a V3 decision alone
as effective. Exact npm installations use the separately persisted, freshly reverified npm lifecycle
described below. Organization-managed tool, skill, MCP, or package files absent from AIH catalogs use
the fixed `upstream-artifact` observer/lifecycle described after it; those subjects remain
non-projectable because observation is not configuration. The
verifier's only process/provider observation is the bounded external GitHub attestation check, and
its only transient write is owner-only authority-verification custody outside the target. It
performs no candidate scan or execution, installation, target-root mutation, or package planning
and cannot satisfy or bypass the held ECC preview and executable-package closure work.

### Fixed AIH-managed usage-metering adapter

`aih policy managed usage-metering describe --json` is a read-only discovery
surface for one code-owned adapter. It reports the exact current AIH
`tool/usage-metering` subject and source revision, adapter id/version/digest,
fixed `configure` effect, and the closed `claude|codex` target set. The command
does not derive any descriptor field from the resolved root or posture and has no
command, path, package, source, effect, adapter, or target selector.

`aih policy managed usage-metering reconcile [root] --decision <id>
--decision-digest <sha256> --target <claude|codex> --evidence <root-relative-file>`
performs a qualified, non-effective preview. Literal `--apply` is required for
configuration or revocation. The request must exact-match a current externally
verified V3 decision for the descriptor and a current canonical organization
evidence envelope. Absence from the AIH-supported catalog is not a denial. The
caller cannot select or transport an executable: the adapter, effect, subject,
recorder, hook commands, host paths, and ignore marker are all derived from the
installed Core bytes. The authority stage still invokes the fixed absolute
`gh attestation verify` boundary described above, and the generic worktree
preflight may invoke read-only `git status`. The fixed materialization runs no
candidate or helper process, performs no network request, and executes no
candidate code.

Before configuration, apply observes the root and fixed owned inputs and commits
canonical V4 receipt state `claimed` durably. The following transaction asserts
that exact claim while writing only `.aih/usage-record.mjs`, `.gitignore`, and
the selected `.claude/settings.json` or `.codex/hooks.json` entry. Authority,
qualification evidence, and ownership are freshly re-observed at the effect
boundary. Finalization asserts the exact generated outputs and replaces the
claim with `configured` custody. The receipt binds the authority-receipt digest,
Decision V2 id/digest, qualification attestor/record/evidence digest, exact
subject/source, target, adapter id/version/digest, configure effect, pre-existing
ownership observation, and every output path/digest. Canonical self-digests and
a bounded predecessor-linked history expose interrupted and refreshed states;
they are integrity and recovery evidence, not independent authority.

The generic dirty-worktree gate still protects a pre-existing administrator
change to a host file or `.gitignore`. Only internal V4 receipt transitions and
the authenticated exact-CAS subtraction of already validated code-owned output
bypass that gate, so one configure or revoke invocation can complete without
mistaking its own newly written custody files for unrelated administrator work.

An exact configured reconciliation is zero-write. A current authenticated V3
decision revocation first commits `revoking`, then subtracts only the exact
code-derived recorder, fixed hook entry, and AIH ignore marker after live output
validation, and finally retains `revoked` custody and its output identities. The
host and ignore documents remain, with non-AIH fields and rules preserved;
self-digested pre-existence metadata is never deletion authority. Missing,
linked, malformed, substituted, replayed, stale, mismatched, expired, conflicting,
or drifted state fails closed; disputed bytes are not overwritten or removed.
Revocation records permission removal only: it does not claim that an already
running process stopped or that previously recorded usage disappeared.

`aih policy managed usage-metering inspect [root] --json` is read-only and reports
`absent`, `claimed`, `configured`, `revoking`, `revoked`, `drifted`, or `invalid`.
Transitional, drifted, and invalid custody exits nonzero. A V1, V2, or V3 policy
hook receipt remains visible to legacy policy tooling but cannot satisfy this V4
route. A future AIH source revision must ship an explicit code-owned predecessor
descriptor and migration before it can update owned bytes; receipt data cannot
nominate its own adapter or migration implementation.

`npm run verify:cold-aih-managed-usage` builds and packs Core, installs that
tarball into a disposable consumer, uses the installed CLI to generate the Policy Workbench, and
drives its structured form/download to create the separate protected PolicyBundle V2 used for
descriptor discovery, absent inspection,
qualified preview, configure, inspect, authenticated revocation, final inspection,
and fail-closed authority substitution. It uses no fake `gh` and no workflow for
organization authority. The proof establishes Core's exact file-custody contract;
it does not prove that a real adopter host applied administrator-only ACL or MDM
controls to the file and process configuration.

`aih policy observe npm-package [root] --decision <id> --decision-digest <sha256> --target <id>
[--evidence <root-relative-file>]` is the fixed upstream-observation route. It accepts no package or
effect option: the exact current Decision V2 must name a `package` subject with an npm source, and
the command always observes the `install` effect. The decision selects one mutually exclusive
qualification route. `organization-qualified` requires the canonical `--evidence` envelope;
`aih-supported` rejects `--evidence` and requires the current durable supported custody described
above, then freshly re-verifies the fixed Receipt V2, its outer attestation, the authority,
decision, validity, and current head-scoped member. Both routes then read only `package-lock.json`
and `node_modules/<decision-package>/package.json` under the target root. The
lockfile must be bounded strict JSON with a version 3 entry carrying the decision's exact name,
version, and integrity; the installed manifest must repeat the exact name and version. Linked
parents or files, npm link entries, malformed or ambiguous JSON, oversized files, and any byte or
file-identity change during re-observation fail closed.

An exact current match returns `outcome: "observed-effective"`, exits zero, and includes the full
domain-separated canonical observation-receipt digest. The receipt itself and the opaque
qualification/observation capabilities never leave package-internal custody. Missing lockfile or
manifest evidence reports non-effective `partial`; unsafe, changed, stale, rejected, revoked, and
mismatched states refuse, and both classes exit nonzero. JSON reports `qualification` as the exact
verified route: `organization-qualified` or `aih-supported`. A later installed-state, observation,
or custody refusal preserves that already-established provenance; a refusal before qualification
succeeds reports `unqualified`. The field is derived from the sealed decision route, cannot be
caller-selected, and is not authority or proof of an effect. The protected-file authority path
starts no process. The optional GitHub authority transport and, on the supported branch, the
separate support-receipt attestation are the only external verifier processes. The command does not
write the target, append a run ledger, install, configure,
execute, sign, publish, or make the subject projectable. This route does not observe skills, MCP
servers, remote endpoints, PyPI/OCI packages, or generic executable closures.

`aih policy lifecycle npm-package [root] --decision <id> --decision-digest <sha256> --target <id>
[--evidence <root-relative-file>]` repeats the decision-selected observation route and can persist
its result as governance history. Organization-qualified decisions require `--evidence`;
AIH-supported decisions reject it. The command is preview-only unless `--apply` is explicit:

```bash
aih policy lifecycle npm-package <root> \
  --decision <exact-decision-id> \
  --decision-digest sha256:<exact-decision-digest> \
  --target <code-owned-cli-id> \
  --evidence <root-relative-canonical-envelope> \
  --json

aih policy lifecycle npm-package <root> \
  --decision <exact-decision-id> \
  --decision-digest sha256:<exact-decision-digest> \
  --target <code-owned-cli-id> \
  --apply --json
```

The first example is the organization-qualified route. The second is the AIH-supported route after
`aih policy supported accept --apply`; it deliberately omits `--evidence`.

Preview performs the complete fresh verification but writes nothing. `--apply` appends a canonical
content-addressed record and advances the matching subject head in
`.aih/governance/npm-package-lifecycle/v1/`; it never uses generic report history as policy
authority. Each fresh unchanged re-observation appends an independently timed immutable record;
the output of one prepared plan is deterministic. A separately authorized exact version/integrity
change appends a bump on the stable package/integration lineage. A current
authenticated V3 decision revocation can append a revocation record only for an already observed
current head. That records governance state; it does not remove, stop, update, or configure the npm
package. The durable append is reported truthfully, but revocation removes permission rather than
establishing an effect, so verification and the command exit remain failing and nonzero.

Apply re-verifies authority, the selected qualification route, installed custody, and observation
before constructing the transaction, pins every authorizing file, and gives the prepared write at
most 60 seconds—shorter when an authority, decision, review, or observation deadline arrives first.
It refuses after that deadline, serializes cooperative lifecycle writers with one fixed store-wide
lease, advances a strict canonical
aggregate capacity guard with an exact-original transaction precondition, writes a durable immutable
lineage claim before the ordinary binding and record, writes the record before the head, and reads the
exact committed claim, binding, record, head, and bounded lineage before it reports success. The claim keeps
an accidentally missing binding from admitting a different registry or integration lineage without a
global record-partition scan. The capacity guard is writer coordination rather than reader authority:
the read path independently derives the active-lineage and record counts. The writer permits at most
256 active lineages, 16,384 aggregate records, and 4,096 records in one lineage. Missing or partial
observation, invalid or stale authority, linked store paths,
substitution, a stale head whose canonical successor remains, forks, collisions, deadline expiry,
content races, capacity exhaustion, and detached post-commit state refuse without a successful
lifecycle claim. On the supported route, commit also pins the exact fixed receipt and current
signer/replay/member/head records, then performs a full bounded custody re-observation before it can
report fulfilled. A
non-effective result remains nonzero; no lifecycle record can make a failed observation effective.
If an interrupted immutable-record rename leaves its private `.aih.tmp` scratch, a retry may consume
it only when the exact candidate bytes still match, the file has single-link custody, and the
transaction rechecks that precondition before any related filesystem effect. Mismatched, linked,
wrongly named, or otherwise foreign scratch is preserved and refused rather than cleaned up.
If a hard process or machine failure leaves a record without its head, only the same prepared
canonical bytes can be reused. A fresh command performs a newly timed observation and therefore
normally sees that orphan as an ambiguous fork; it fails closed for approved operator incident
reconciliation and neither deletes nor silently adopts the orphan.

The fixed store-wide cooperative writer lock uses an owner lease with a maximum 30-second
forward-mutation window and a further 30-second recovery grace. After that grace a later writer can reclaim a crashed owner's
canonical claim; malformed or foreign lock state fails closed. Its inert canonical anchor and staging
directory can remain under the lifecycle store. This coordinates AIH writers on the local filesystem;
it is not an operating-system lock and does not isolate the store from a process that can rewrite it.

This target-local store blocks a different lineage while either subject index remains and detects a
stale head while its canonical successor records remain. It cannot by itself detect coordinated
deletion of both the claim and binding, or a rollback that removes a head advance and every later
record; preserve the whole store in organization-controlled versioned evidence. The existing
offline-revocation high-water primitive remains inert until Core has an administrator-managed
trust-root loader and a fixed verifier/producer.

The durable store also feeds the read-only governed-state surfaces. For a policy that owns AIH
governance surfaces, `aih policy evaluate <root> --no-log --json` and the governed report read the fixed lifecycle
heads in deterministic order, validate canonical head/binding/claim custody plus the complete bounded
history, and freshly verify current V3 authority. An exact current observation is reported as
`observed-effective`; partial, withheld/refused, revoked, stale, and drifted states stay distinct and
block evaluation. Observation expiry alone does not freeze unrelated policy projection. Unsafe or
malformed store custody, a missing/substituted head or record, detached history, authority
replacement, a current rejection or revocation, or decision/source/subject/target/effect mismatch
also blocks projection and cannot become effective. A store beyond 256 active lineages, 16,384
aggregate records, or 4,096 records in one lineage is reported distinctly as `over-capacity`, blocks
both evaluation and projection, and is not described as corruption. Preserve the complete store in
organization-controlled evidence and reconcile onto a newly governed target; do not delete or prune
the target-local audit chain to make the reader pass. These reads write no target or run-ledger state
and perform no package effect.

This remains a narrow root npm lifecycle for organization-qualified or durably accepted
AIH-supported decisions. Neither the lifecycle command nor evaluate/report makes a candidate
projectable. Catalog-independent organization-qualified tool, skill, MCP, and package files use the
separate fixed route below.

### Catalog-independent organization-managed artifact observation

`aih policy observe upstream-artifact [root] --decision <id> --decision-digest <sha256>
--target <id> --evidence <root-relative-file> --manifest <root-relative-file>` observes exact files
the organization already placed below the governed root. The Decision V2 must be
`organization-qualified` and name a tool, skill, MCP server, or package; `aih-supported` is not
accepted on this route. The canonical `UpstreamArtifactManifestV1` is bounded to 512 KiB and 256
sorted, portable-case-unique file entries. It accepts exact mixed-case paths while rejecting any
segment with a trailing dot/space or Windows device alias. It exact-matches the decision id, subject
kind/id, source/subject digests, target, allowed effect, accountable integration owner, and exact
integration-contract version. Its raw canonical SHA-256 must be present in the canonical
organization evidence envelope's `artifactDigests`. The manifest binds the decision id rather than
the decision digest because the decision already binds the evidence digest and the evidence binds
the manifest bytes; a decision-digest field would create a digest cycle. The portable schema ships
at `@aihq/core/schemas/aih-upstream-artifact-manifest-v1.schema.json` in the published
`0.1.1` Core package, and the public library
exports the strict canonical parser and serializer.

The fixed observer accepts no caller-selected command, executable, callback, runner, clock,
network source, installer, or projector. It validates the same canonical evidence/manifest request
path grammar used by durable history before authority verification. It reads only single-link
evidence and bounded regular single-link artifact files, rejects AIH's reserved `.aih/` custody tree
and absolute, traversing, backslash, linked-parent, linked-file, platform-aliased,
repeated-identity, malformed, missing, oversized, or mismatched inputs, and rechecks authority,
evidence, manifest, and every observed file after the initial read. A success is exact observed state
only. It performs no installation, copy, configuration, activation, removal, process launch,
endpoint reachability check, or candidate-code execution.

`aih policy lifecycle upstream-artifact [root]` takes the same exact options. Preview performs the
full fresh observation and writes nothing. Literal `--apply` appends an immutable
content-addressed record, then advances the exact lineage head under
`.aih/governance/upstream-artifact-lifecycle/v1/`. The owner-stable lineage binds subject kind/id,
target, effect, and integration owner; every immutable observation record binds the exact
integration-contract version, subject/source digest, and exact evidence/manifest request paths, so a
newly authorized version/source update appends without rewriting the prior record. Claims, aggregate
capacity, authorizing files, and the mutable head use exact-original transaction preconditions, and
the record is written before the head. The reader rejects unknown claims, orphan record partitions,
forks, stale heads, unauthenticated head backups, linked custody, malformed canonical bytes, and
capacity mismatch. Limits are 256 lineages, 16,384 aggregate records, and 4,096 records per lineage.

A current authenticated Decision V2 revocation can append negative history only for the exact
current lineage. The result remains non-effective, failing, and nonzero; it does not remove files or
claim that a process stopped. `aih policy evaluate <root> --no-log --json` and
`aih report <root> --no-log` freshly verify authority once and then repeat the fixed read-only
observation for every current stored request. They re-read and exact-compare the bounded lifecycle
snapshot before returning any `observed-effective` state. Missing or drifted live inputs and
substituted stored verifier/installed identities remain non-effective. After an external file or
version change, run `aih policy observe upstream-artifact`, then preview and apply lifecycle with the
newly authorized decision/evidence to append the new audit record. Live file observation is still
not installation, activation, endpoint reachability, or process-running proof.

`npm run verify:cold-upstream-artifact-lifecycle` builds and packs Core, installs only the tarball in
a disposable consumer, and exercises the public parser, packaged schema, installed CLI, and the
structured Workbench form/download that generates its authority file. It
first proves that observation and explicit lifecycle apply refuse without authority. It then uses a
separate protected PolicyBundle V2 to observe and persist one catalog-absent exact organization
tool, append an exact source/version update, refuse live file drift, record authenticated
revocation, and expose the resulting negative durable history through `policy evaluate`. It uses no
fake `gh`, never installs/configures/executes the observed tool, and does not claim that Core proves
the host ACL protecting the policy file.

Approvals cover only a missing or failed **waivable** evidence record, require a non-empty signed reason,
and last at most 90 days. Mandatory detector failures and every unwaivable danger code remain blocked even
with an otherwise valid approval.

`validate` is the **read-only CI gate** over the active local org policy source: the default
committed `aih-org-policy.json`, or an explicit `AIH_ORG_POLICY` override. The policy source is
JSON only; JavaScript/module policy files are not executed and fail as `org-policy.invalid` with
remediation guidance. At Enterprise posture, `governance.supportedClis` is required and must be a non-empty unique list drawn from AIH's supported CLI registry; absence fails closed with the current registry ids and a paste-all remedy, and wildcard sentinels are not supported. At Vibe posture absence is unrestricted, while a present list enforces at either posture. A missing default repo file is a friendly skip (vibe repos carry no org policy), and a parse/schema failure is a coded finding (`org-policy.invalid`) — or, under
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
[Baseline Component Evidence](https://github.com/samartomar/ai-harness/blob/main/docs/security/baseline-evidence.md).
Strict typed Strix records placed under `.aih/security/strix/*.json` are indexed as
`strix-security-evidence` only after a 32 MiB read cap plus fatal-UTF-8, whole-document
validation. Evidence publication does not run Strix or claim the harness produced the record.

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

Core `0.1.1` behavior: read-only release verification for published `@aihq/core`
versions. With no positional version,
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
at `vibe` plaintext secret findings are warning-only, while `enterprise` return a
non-zero exit for plaintext paths, unsafe MCP config paths, or hardcoded MCP credentials. CI should
run with `--posture enterprise` or an org-policy posture floor. `--sarif <file>`
emits one result per finding for GitHub code-scanning. <!-- aih:claim CM-16 -->

## aih guardrails

Generate `.gitleaks.toml`, `.pre-commit-config.yaml`, and a GitHub Actions workflow for CI secret
scanning plus strong/network-copyleft license blocking. At enterprise posture it also emits
the machine-readable risk-gate sidecar (`<context-dir>/risk-gates.json`) together with its
consumer, `.github/workflows/risk-gates.yml`: a pull-request job that diffs the PR's changed paths
against the declared gate patterns and surfaces every touched gate as warning annotations plus a
job summary — ask-not-deny, so it never fails the build on a touched gate. Generation is not
activation: local pre-commit enforcement requires `gitleaks`, `pre-commit`, and
`git config core.hooksPath .githooks`; CI enforcement requires committing the generated workflows
and making the relevant jobs required checks on protected branches. <!-- aih:claim CM-17 -->

**Analytics & operations**

## aih report

Read-only analytics digest. Local: a dev console — agent **context footprint** (token bloat) plus a
**per-turn load-group** panel (the heaviest single tool's always-loaded bootloaders — what one tool
actually pays per turn, not the union sum; `--gate --token-budget <n>` exits non-zero in CI when
it's exceeded). The footprint spans every registered CLI's bootloaders, the canon context dir, and
each target's whole **rule tree** where the tool loads a directory rather than named files
(Cursor's `.cursor/rules/`, Kiro's `.kiro/steering/`) — so files you added by hand next to the ones
aih writes are counted too. It is **gitignore-honoring** (counts only tracked/untracked-not-ignored
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

The local digest includes a deterministic **Governance review**. Every governed subject remains in
ordinal id order without truncation and keeps requested/effective state, evidence/findings/blockers,
decision/approval/revocation facts, projector and target coverage, strict per-target receipt state,
and local usage coverage separate. An MCP event with an explicit `server` either matches that exact
governed source or remains unmatched; it never falls back to its name. Other unique event-name
matches are heuristic. Unknown or ambiguous subject evidence and ordinary non-subject activity use
separate bounded counts; their names, malformed rows, and unknown-kind rows never render.
Non-effective subjects say `not-projected` while any surface-wide receipt remains a separately named
fact. Strict receipt state—not path presence—decides whether capture is installed; zero observed
events is review input, never proof of no use or a value, revoke, retire, trim, or uninstall
recommendation. Invalid, absent, or non-governing policy is explicit and redacted, and Package Graph
identity is omitted without an exact subject join.

## aih track

Record one metrics sample (commits 7d, LOC delta, adoption score, branch count, tracked files) to
`.aih/history.jsonl` — the time-series behind `aih report` trends. Read-only git/filesystem;
dry-run previews, `--apply` appends (idempotent per commit). `aih usage --apply` installs the
universal post-commit hook that runs `aih track --apply` automatically when Git uses the default or
a repo-local hooks path; external/global `core.hooksPath` configurations get chain guidance instead.
Kiro's `metrics-on-stop` hook
(`aih bootstrap-ai --cli kiro --kiro-hook-runtime ide1-cli3`) records on agent stop.
It uses Kiro's standalone v1 JSON hook surface for Kiro IDE 1.x and Kiro CLI 3.x. Kiro CLI 2.x
stores hooks inside custom-agent JSON, which AIH deliberately does not mutate.

## aih usage

> Under a policy carrying a governed inventory (any `governance.policyVersion`), this command
> fails closed — governance exclusively owns AIH usage-hook projection. Use
> `aih policy project --apply` instead, and note it wires usage only when the policy activates a
> `usage-metering` candidate for the selected targets. See [`aih policy`](#aih-policy).

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
Kiro's usage hook is a standalone v1 `.kiro/hooks/aih-usage-metering.json` Stop hook for Kiro IDE
1.x and Kiro CLI 3.x. Enable it explicitly with `--kiro-hook-runtime ide1-cli3`; the selection is
persisted in a valid `.aih-config.json` marker so later doctor runs can grade it. AIH does not inject
the embedded agent hooks used by Kiro CLI 2.x or overwrite a pre-existing reserved filename.
Skills aggregate by source (ECC/canon/user), and `--rollup <repo,repo>` aggregates local logs across
repos on demand. Usage is local activity counts only — **no cost, no prompts, no arguments**,
machine-local and gitignored. Session rows may include deterministic token/cache counters (`input`,
`output`, `cacheRead`, `cacheCreation`) so the local cache-economy panel can render live; empty local
sinks stay honest and point at `aih report --org <export>`.

## aih telemetry

Inject OpenTelemetry env, a redacting Bindplane collector, and an analytics fetcher (usage + skills
endpoints → `{ usage_report, skills }`).

## aih mcp

> Under a policy carrying a governed inventory (any `governance.policyVersion`), this command and
> `aih mcp approve` fail closed — governance exclusively owns AIH MCP projection. Use
> `aih policy evaluate` then `aih policy project --apply`, selecting every CLI in the activation's
> `targets`. See [`aih policy`](#aih-policy).

Generate the MCP server config **for the targeted CLIs** (`--cli`/`--all-tools`/`--detect`;
otherwise the committed `.aih-config.json` targets, then Claude on a first run):
Claude/Kimi share `.mcp.json`, Cursor uses `.cursor/mcp.json`, and Kiro uses
`.kiro/settings/mcp.json`; Codex gets native TOML in `~/.codex/config.toml` (including
`bearer_token_env_var` for token auth), OpenCode gets its global
`~/.config/opencode/opencode.json` `mcp` map, and Copilot/Zed or other global-config entries get
their registry-specific native writes or guidance. Global config targets are selected only through
an explicit flag or a committed marker; `--apply` can affect that CLI across all projects. Scopes:
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
At Enterprise posture the plan also names its own declaration gap: when generated servers are
missing from `mcp.allowedServers`, an `Undeclared generated MCP servers` digest emits a
ready-to-merge `allowedServers` snippet (the union of current and generated declarations) — or, with
no committed policy at all, points at `aih policy init` — so baseline attestation never flags an
aih-generated server without the fix in hand. The digest is guidance only: it changes no gate, and
declaring registry membership is still not an egress approval.
With `allowManagedOnly: true`, an empty list is deny-all across direct, offline, init, and client
writers; a populated list emits only listed, enabled servers. With `false`, the enabled catalog
remains available, and cleanup preserves operator entries while replacing exact AIH output.

Governed candidate projection is separate from this standalone generator. When an AIH-reviewed
stdio MCP activation targets Kiro, `aih policy project` merges only its selected server names into
`.kiro/settings/mcp.json` and records a separate `kiroMcpProjection` ownership receipt. Repeating the
same projection is a no-op; deselection, prune, and uninstall subtract only unchanged receipt-owned
names. Existing collisions, drift, malformed files, and linked paths fail closed without taking
ownership. This is workspace distribution, not managed enforcement: Kiro custom agents can supply
their own `mcpServers` or decline workspace inheritance.
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

**codebase-memory-mcp graph UI — deliberately not surfaced.** Upstream codebase-memory-mcp also
publishes an optional interactive graph-visualization UI variant alongside the headless server.
aih does not install, launch, or link it, by decision rather than omission: the catalog wires the
stdio server only, under hardened uvx flags (`--offline --no-python-downloads --no-env-file`), and
every downstream control — the managed allowlist, pin attestation, and pin currency — is scoped to
exactly that launch shape. A browser-serving UI binary is a different execution and egress surface
(a listening port and a served web app rather than a stdio pipe), and it has not been vetted as
part of the wired-tool pin. Operators who want the UI can run it out-of-band against the same
indexes and should treat it as an unvetted convenience. Revisit this decision only together with a
vetted pin bump that covers the UI variant's surface.

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
It remains read-only.

The `ai-clis` probe verifies a detected CLI binary can actually execute, not only that it resolves
on PATH: each detected binary runs a bounded `--version` exec, broken binaries are named in the
probe detail, and a machine where EVERY detected binary fails the exec hard-fails as
`cli.binary-broken` rather than reporting runnable CLIs.

The `mcp-uvx-pin-attestation` row covers the resolved artifact behind uvx MCP pins in `.mcp.json`.
By default it reports exactly-pinned uvx servers as not attested (`mcp.pin-unattested`, an advisory
skip). `--attest-mcp-pins` opts in to a live check: doctor launches each exactly-pinned server once
with an MCP `initialize` handshake and compares the server's self-reported `serverInfo.version` to
the pin — a mismatch warns (`mcp.version-drift`), a match passes. The launch gate is fail-closed
(literal `uvx` command, exact end-to-end pins, no config-supplied environment; anything else is
reported as unattestable). Attestation proves what the resolved artifact self-reports at runtime;
it does not prove provenance or integrity, and it executes the pinned artifact — which is why the
live handshake is opt-in.

A launch that dies before the handshake is read from what the server said, not from its exit code
alone. Hardened pins carry `--offline`, so a silent non-zero exit on a cold uv cache names that
cause and the one-time pre-warm remedy. When the server instead answers with a JSON-RPC `error`
object it resolved and ran, so pre-warming cannot help: the detail echoes the reported error
(sanitized and length-bounded) and the row routes to `mcp.server-startup-error` — still an advisory
skip, because the attestation launch carries no config-supplied environment and cannot prove the
server is broken under the operator's own launch. The pin stays unattested either way.

The `mcp-pin-currency` row tracks how current those pins are. Both this row and pin attestation
read every repo-local MCP config with the plain `mcpServers` shape — `.mcp.json` and
`.kiro/settings/mcp.json` — and a launch from a non-root config is reported with its file
qualified (`name @ .kiro/settings/mcp.json`); the catalog comparison still keys on the bare
server name, so a Kiro-declared catalog server is compared exactly like a `.mcp.json` one. The
catalog pins are compile-time constants, so picking up an upstream improvement lags twice by
construction: the pin must be bumped in an aih release, and each repo must then re-project its
config. The row surfaces both halves. Offline, on every run, each exactly-pinned npx/uvx launch is
compared against the pin this aih build's catalog generates for the same server; a difference reports
`mcp.projection-stale` and names the fix (`aih mcp --apply`) — after an aih upgrade, that
re-projection is the second half of a pin refresh. `--check-pin-currency` opts in to the upstream
half: doctor queries each pin's registry for its latest release (npm via `npm view`, PyPI via its
JSON metadata endpoint over curl) — metadata only, nothing is downloaded or executed, but it is
network egress from a read-only command, so it is opt-in. A pin whose registry publishes a newer
release warns (`mcp.pin-stale`); a current pin set passes. A newer release is a bump **candidate**,
never an instruction: the refresh path is (1) vet the new version through the trust gate
(`aih trust scan <owner>/<repo> --pin <sha>`, which fails closed at enterprise posture unless the
required analyzers — the pinned SkillSpector image, locked Semgrep, and the Cisco skill-scanner —
are available),
(2) bump the catalog pin in an aih release, (3) re-project each non-governed repo with `aih mcp
--apply` (when `governance` is present, do not use the blocked legacy MCP/workspace commands:
validate the external evidence or signed authority receipt with `aih policy evaluate`, then use
`aih policy project --apply`; manually remediate any reported workspace residue), and (4) re-attest
with `aih doctor --attest-mcp-pins`.

In the canon markdown lint, `canon-ref-resolves` accepts a reference guarded by an explicit
existence conditional on the same line ("Read `x.md` only if it exists"): the waiver applies only
when the guard's subject is that reference itself (or an anaphoric "it"), only with positive
polarity (a negated guard such as "does not exist" never waives), and never inside fenced code
blocks; escaping references stay fatal even when guarded. `--posture enterprise` also runs the enterprise baseline attestation: MCP
servers from known repo-scoped MCP config files (`.mcp.json`, Cursor, Kiro, VS Code, and legacy
OpenCode residues)
and packaged marketplace skills from `.aih/marketplace/marketplace.json` must be declared in
`aih-org-policy.json` (`mcp.allowedServers` / `trust.approvedSources`), or `doctor` emits coded
`baseline.*` findings for a missing registry, invalid registry input, or undeclared residue. MCP
declarations are bound to the generated catalog's command/args/env or URL/headers shape, and
marketplace declarations must include the reviewed `pinnedSha` that matches the artifact's packaged
commit. Workspace graph MCPs generated for declared child repos are treated as internal workspace
plumbing. When a child has no valid generated graph alias, a populated child-scoped
`code-review-graph` binary also satisfies that child's graph-safety probe; generated aliases remain
the preferred exact offline path. The full Package Graph schema remains the follow-on registry
unification.

## aih governance-doctor

Read-only presentation of the Governance Doctor Audit and Guide. <!-- aih:claim CM-65 --> It is a
top-level route rather than a mode of `aih doctor`, because the internal operational adapter it
drives already plans and probes the Doctor command; a Doctor sub-route would re-enter Doctor.

The command reads one artifact: the canonical profile shipped inside this package at
`packs/governance-quality/governance-doctor-audit-guide/profile.json`. The loader takes no
argument, so no flag, option, environment variable, or positional value can name a different
profile, supply profile bytes, or point at another registry entry. Non-canonical bytes are
rejected by the shared profile parser rather than re-canonicalized.

The policy decision and the policy revision are derived in code from the org policy the shared
schema validates and the posture the shared ladder resolved. The command accepts no allow/deny
decision, callback, or opaque revision from a caller. The decision fails closed twice: an org
policy that cannot be read or parsed denies the run, and a run whose resolved posture sits below
the policy's declared `minimumPosture` floor denies the run. In the normal CLI path an explicitly
configured but unreadable `AIH_ORG_POLICY` already fails posture resolution with `AIH_ORG_POLICY`
before this command plans anything.

Per invocation the internal adapter runs exactly once and dispatches only its two code-owned
read-only diagnostics — `aih doctor` and `aih policy evaluate` — through their own command specs.
The Guide's next action is reported by id and stays `executable: false`: this route executes no
next action, no `aih status`, and no Repair. The internal Repair modules have no execution,
consent, or application route from this or any other command.

One `aih doctor` outcome is now mapped to a finding rather than collapsing its diagnostic into an
evidence gap: the code-owned tuple of check `context-dir`, verdict `skip`, and code
`canon.context-dir-missing`, which becomes the low-severity `AIH_CANON_CONTEXT_DIR_MISSING`. The
diagnostic's own code and detail text are compared against a code-owned table and then discarded —
neither appears in the report.

**This does not widen the general Audit mapping.** The mapping is all-or-nothing per diagnostic: if
any other Doctor check also skips or fails, the whole diagnostic still collapses into `evidence-gap`
exactly as before. Doctor's canon markdown lint check skips on *exactly* the same condition as this
one — both test whether the context directory exists — so the mapped tuple is still subject to the
same closed Audit rule. The separate `aih repair` route does not use that mapping as its execution
license; it uses the branded live precondition documented below, while this command remains a
read-only Audit/Guide presentation.

**Flags**

The shared zero-write set — `--json`, `--posture <posture>`, `--root <dir>`, and
`--context-dir <dir>` — plus the preview-only `--repair-plan`. There is no apply, force, verify,
support-output, ledger, or SARIF flag on this route. `--posture` is validated and participates in
its posture-scoped policy resolution; the shared organization floor can still raise the resolved
posture.

**`--repair-plan` (preview only)**

Appends a mechanical Repair plan preview to the standard presentation; without the flag the output
is unchanged. The preview derives exclusively from the same single adapter run's branded Audit,
the shipped profile, and one code-owned broker mapping — no flag, option, or positional value can
supply a broker, recipe, effect, path, or content. Its closed JSON shape reports a fixed outcome
(`no-mechanical-repair`, `plan`, `posture-unavailable`, or `unavailable`), plan and summary
digests when a plan was derivable, bounded effect summaries over managed-relative paths,
`auditCompleteness` — the same `completed` / `partial` / `evidence-gap` classification the
presentation reports, or `null` where there is no audited result behind the preview at all —
and `executable: false` always. A plan may be derived from a `partial` audit: the finding it
repairs is real either way, and the classification travels with the plan precisely so that
"a repair was planned" can never be read as "the audit was complete". This preview is not the
live-precondition plan used by `aih repair`; it remains an Audit projection, is presented and
discarded, and never becomes executable. Nothing becomes executable: the preview captures no
consent, spends no claim, runs no executor or verifier, and writes nothing.

The one mappable finding is `AIH_CANON_CONTEXT_DIR_MISSING`, and it derives one
`create-managed-directory` effect at the fixed path `ai-coding`. That path is a constant in the
code: it is never taken from the committed marker, from `--context-dir`, from the environment, or
from the diagnostic's own text. Those inputs are only ever *gates*. A plan is previewed only when
this repository's committed `.aih-config.json` is present and valid, its context directory is
exactly `ai-coding`, and the run's resolved context directory is exactly `ai-coding` too — so a
`--context-dir` override that disagrees with the committed marker previews `unavailable` rather
than a plan for either directory.

**Output and exit codes**

Human rendering and the presentation report carried by `--json` derive from the same closed
result. The JSON report has one fixed key set across every outcome; absent values are `null` or an
empty list rather than a missing key. It carries closed, bounded fields only:
`outcome`, `state`, the derived `policy` state, identity digests, dispatched diagnostic ids,
per-diagnostic refusals, the surface/target ids, the repair posture, and the profile's roles,
prerequisites, conflicts, guidance, and findings rendered as quoted, source-attributed prose with
`authority: "none"`. It carries no raw diagnostic check text, argv, environment value, filesystem
location, child-process output, support ticket, or run-ledger row.

| `outcome` | `state` | Exit |
| --- | --- | --- |
| `completed` | `null` | 0 |
| `partial` | `null` (per-diagnostic states in `refusals`) | 1 |
| `evidence-gap` | `null` (per-diagnostic states in `refusals`) | 1 |
| `refused` | `policy-denied` or `compatibility-required` | 1 |
| `unavailable` | `profile-unavailable` or `adapter-unavailable` | 1 |

`completed` means every declared diagnostic resolved — findings may be present or absent.
`partial` means some diagnostics produced findings and some did not resolve: the run found
real problems *and* could not see part of the workstation, so it is neither a completed
audit nor an absence of evidence. `evidence-gap` means nothing resolved into a finding and
at least one diagnostic did not resolve. Only `completed` exits zero, so a `partial` run
exits the same way it always did. A diagnostic fails to resolve in five distinct ways —
`missing-adapter`, `evidence-gap`, `missing-credential`, `unsupported-host`, and
`unmanaged-drift` — and each appears in `refusals` with its own state.

The run is zero-write: it appends no `.aih/runs/` ledger row, writes no support tickets, and
produces no repository or workstation file.

## aih repair

Preview and, when explicitly confirmed, apply the single local Governance Doctor mechanical repair.
<!-- aih:claim CM-74 --> This is a separate mutating command, not an apply mode of
`aih governance-doctor`; the Governance Doctor presentation remains read-only and its
`--repair-plan` payload remains `executable: false`.

The invocation accepts an optional `[root]` positional (`aih repair [root]`) for the target
repository/workstation root. When supplied it takes precedence; otherwise the normal target-root
precedence is `--root`, `AIH_ROOT`, then the current working directory.

The live repair route is licensed by the narrow, branded canonical precondition rather than by the
Audit's finding projection. This keeps the general diagnostic mapping all-or-nothing while making
the one safe repository-local repair reachable on a realistic temporary root: the committed marker
must name `ai-coding`, the live precondition must prove that the target is unoccupied, and the
operation and precondition must bind the same resolved root. An unrelated diagnostic refusal does
not become a reason to create the directory, but it also cannot make this one local precondition
unreachable. If target occupancy is indeterminate, Repair reports an indeterminate-precondition
refusal distinct from an occupied target/no-mechanical-repair result, before consent, claim, or
effect. `aih governance-doctor --repair-plan` remains the Audit projection and remains
preview-only with `executable: false`.

Dry-run is the default. Preview runs the code-owned diagnostic/policy adapter and the live branded
precondition. When a plan is derivable, it discloses the target `ai-coding`, the full lowercase
Plan SHA-256, the full lowercase Summary SHA-256, the precondition SHA-256, target occupancy, and
Audit completeness. The disclosure is evidence for the operator, not authority supplied by the
operator; the branded precondition is code-observed and re-observed by the live attempt, and is
never taken from a caller object. Preview
captures no consent, spends no claim, runs no executor or verifier, and writes no file.

Apply requires all of these gates:

- a literal CLI `--apply`; ambient `AIH_APPLY`, injected Commander option values, `--open`, and
  other shared live options do not authorize this command
- human output mode, not `--json`
- no `AIH_NO_PROMPT`, no environment confirmation token, no file token, no callback, and no `--yes`
- both stdin and stdout attached to a TTY
- an exact raw answer equal to the full lowercase Plan SHA-256; `y`, `yes`, uppercase digests, the
  Summary digest, blank input, EOF, Ctrl-C, timeout, and trailing text all refuse

Only after that local terminal confirmation, when an eligible plan is available, does the command
mint out-of-band consent, take the durable per-machine claim, re-observe the live precondition
before the claim and again at the effect boundary, and apply exactly one literal effect:

```sh
create-managed-directory("ai-coding")
```

The effect path is code-owned. It is never read from `.aih-config.json`, `--context-dir`, an
environment variable, diagnostic text, or a plan-like caller object; those inputs only gate whether
the one canonical repair is available. The command exposes the isolated zero-write flag set:
`--apply`, `--json`, `--posture <posture>`, `--root <dir>`, and `--context-dir <dir>`. It has no
`--force`, `--support-out`, `--no-log`, `--detect`, `--all-tools`, `--cli`, or `--yes`.

When an eligible apply reaches execution, its write summary keeps durable authority and the target
effect separate: a committed durable claim is reported as `create` in the local claim store; the
target effect is `create` only when the directory changes, and `unchanged` when an idempotent or
raced pre-existing directory leaves it as-is. A race detected after the claim but before the effect
reports the claim as spent and no applied effect, rather than fabricating a `create`. The result
still reports three separate facts: `effectVerification`, `postAuditState`, and `repairState`.
`complete` requires the `ai-coding` effect to verify, a fresh post-execution audit to be healthy,
every trusted join to hold, and the receipt itself to verify. A verified effect with a fresh partial
Audit reports `repairState: partial` and is qualified by the partial post-audit state, then exits
zero: the requested local effect succeeded even though the workstation is not healthy. The bounded
residual entries remain structured in the result data for machine consumers; they are not expanded
into the human summary. An unavailable post-audit, unverified effect, or broken join reports
`failed` and exits non-zero. These fields are never collapsed into one success bit. A partial result
is not an Audit `completed` result and does not make the read-only `--repair-plan` executable.

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
