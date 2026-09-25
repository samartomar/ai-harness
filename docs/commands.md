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
comparisons require explicit `--probe-mcp-endpoints` and run as verification probes. For
AI-Harness upgrades, resolve the promoted version with
`npm view @aihq/core dist-tags.latest`, approve that exact version, and install it;
its npm package and matching GitHub Release carry the verification evidence. The
frozen `@aihq/harness@6.1.0` package is npm-deprecated
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

Readiness preflight — a graded, blocker-aware view of host and configuration checks
(runtime/TLS/PATH/core tools, per-CLI loadability, contract, secret scan). Native MCP
configuration is inventoried separately from runtime acceptance. A launcher version
does not prove a server can initialize, authenticate or perform a tool operation.
Diagnoses by default (non-zero when blocked); the one
auto-fixable blocker (missing `rg`/`fd`/`jq`) installs under confirmation. Surfaces a `sec-ready`
panel in `aih report --v9`.

Configured MCP servers remain unverified, including Codex project configuration and
offline `uvx` declarations. Unverified capabilities for selected clients prevent a
clean `READY` banner. Other clients' project configurations remain visible without
affecting the selected workflow's score or banner.
An explicitly required, enabled Codex server on a selected target blocks acceptance
while its runtime is unavailable or unverified. Explicitly optional failures remain
warnings; an omitted requirement stays unspecified. Disabled servers remain visible.
AIH reads registered project configuration and selected clients' registered global
configuration; this inventory does not resolve every native override or workspace
trust decision. Routine readiness does not start configured third-party servers or
run the repository's first command. Follow the
[bounded native acceptance steps](governed-mcp.md#bounded-native-acceptance)
to record actual tool use and policy behavior separately.

For the bounded OpenCode Linux fixture, `--runtime-evidence <absolute-file>`
explicitly adds a current-material evaluation beside preflight. Select the current
consumer with `--root` and `--cli opencode`. The optional `runtimeEvidence` JSON
result distinguishes unavailable, invalid, stale and current records, with
observation/expiry times, exercise, restart and specific restrictions. It never
removes preflight blockers or verifies unrelated configured servers. The same
option is supported by local `aih report --v9`, including its JSON output.
Reading the record does not launch its asserted commands. See
[OpenCode runtime observations](../guides/opencode-linux-sandbox.md#current-runtime-observations)
for the producer, current-binding checks and scope limits.

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

After its normal phases complete, `aih init` also runs the ordinary developer-tool lifecycle. A
preview reports the effective selection without reconciling a tool. With `--apply`, it reconciles all
seven existing runtime tool IDs: selected tools are provisioned, while policy-excluded tools can remove only
unchanged receipt-owned integration. During apply, Token Optimizer remains `blocked` until its
license is explicitly accepted with `--accept-token-optimizer-license` (PolyForm Noncommercial 1.0.0;
since v5.13.21 upstream also permits internal use by organizations with fewer than 5 people and under
US$20,000 monthly revenue, which aih does not assess for you); `--token-optimizer-profile
quiet|balanced` selects its setup profile. A blocked prerequisite is reported for that tool while
independent selected tools continue. Headroom is also default-selected, but it stays
`selected-pending` with a skipped check, with or without `--apply`, until it is explicitly activated.
`aih init` accepts the same `--activate-headroom --accept-headroom-egress`, `--deactivate-headroom`
and `--primary-code-graph <id>` flags as `aih developer-tools` and validates them before any phase
runs. An activation during init projects the Headroom MCP entry in one more MCP pass that uses the
same `--mcp-mode`; `--mcp-mode none` refuses activation because it projects no MCP servers.

The Superpowers phase (the `ecc` baseline, when governance does not own the aih surfaces) keeps its
place in the preview but runs last, through `@aihq/framework-superpowers` and the same evidence gate
as `aih superpowers`: under `--apply` it acquires obra/Superpowers at the exact pin into quarantine and
verifies it before emitting any guidance. Without the plugin, init reports the phase as refused with
`framework-plugin-unavailable` (a skipped check naming the install command) and still succeeds.

## aih developer-tools

Preview or reconcile the policy-selected default developer tools for one repository. Without an
effective organization policy, the default selection is `code-review-graph`, `codebase-memory-mcp`,
`serena`, `token-optimizer`, `context7`, `markitdown` (the CLI), `playwright`, and `headroom`.
Selecting Headroom records intent only; it runs only after the explicit activation described in
[Headroom activation](#headroom-activation-mcp-only). A valid policy can select a subset, explicitly exclude
tools, or select none. A legacy valid policy that omits `selected` preserves the defaults, subject to
its exclusions; `selected: []` is an explicit empty selection. A malformed selection or an invalid,
missing, changed, revoked, or conflicting bound policy fails closed before the lifecycle runs, and
does not fall back to defaults.

The policy-selected choices are visible through `aih developer-tools <root>`.
Existing saved catalog entries remain backend policy data; inspecting selection
does not rewrite them or change their authority.
An explicit selection saved before Playwright or Headroom became a default stays unchanged until edited.

Run `aih developer-tools <root>` to inspect the selection. Add `--apply` to acquire, configure, and
verify supported selected tools; Headroom remains pending unless it is explicitly activated. Excluded tools are also reconciled only to remove unchanged receipt-owned
integration. `aih init` already invokes this lifecycle after its ordinary setup, so the standalone
command is useful for inspection or a later focused reconciliation. During apply, if Token Optimizer
is selected, pass `--accept-token-optimizer-license`; otherwise its lifecycle result is `blocked`.
Its default profile is `quiet`; pass `--token-optimizer-profile balanced` to choose the balanced
profile.

Token Optimizer's native project-hook integration currently supports Codex only. If a selected run
does not target Codex, the tool reports `blocked` with that explicit target reason and does not
assume another client. When policy marks Token Optimizer unselected, its receipt-owned cleanup still
runs and removes only unchanged owned integration when present.

For standalone `aih developer-tools --json`, the normal plan result also includes top-level
`accepted`, `selection` (`source`, `selected`, `excluded`, `diagnostics`, and `primaryCodeGraph`
when the policy sets one), `tools` (`id`, `state`, `detail`, and `changed`), `primaryCodeGraph`
(`id` and `source`, when a primary is chosen), and `changed`. With `aih init --json`, the same
lifecycle data is in the digest whose `describe` value is `Developer tool lifecycle`; its `data`
contains `accepted`, `selection`, `tools` and `primaryCodeGraph`, while `report.checks` records
selected-tool outcomes. Tool states are `selected-pending`, `installed`, `configured`, `verified`,
`policy-excluded`, and `blocked`. A selected Headroom that is not activated is `selected-pending`
and its verification check is `skip`, not `pass` or `fail`; this is not evidence of installation or
readiness. A V3 policy that explicitly selects or excludes Headroom, or sets
`developerTools.primaryCodeGraph`, requires `minimumCoreVersion: "0.7.0"`. Existing V3 policies with
the `0.6.0` floor and neither reference remain accepted.

### Headroom activation (MCP-only)

Headroom 0.38.0 (`headroom-ai[mcp]`, Apache-2.0, source tag `v0.38.0`) is integrated in one mode
only: its MCP server, `headroom mcp serve` over stdio, exposing `headroom_compress`,
`headroom_retrieve` and `headroom_stats`. Headroom's proxy, `wrap`, `deploy`, `mcp install` and
`learn --apply` modes are out of scope: they route provider traffic, install Serena, or edit
user-scope configuration, and AIH never runs them.

Selection and activation are separate. Default or policy selection only records intent; no run ever
installs, downloads, registers or starts Headroom without these explicit flags:

- `--activate-headroom --accept-headroom-egress --apply` activates. `--activate-headroom` without
  `--accept-headroom-egress` is refused before anything runs, and so is `--accept-headroom-egress`
  on its own. Without `--apply` the request is only previewed.
- Activation runs `uv sync --locked --no-build --compile-bytecode --no-config` for the committed,
  hash-pinned lock in `src/tools/headroom-runtime/` into AIH-owned state, pre-provisions the two
  tokenizer vocabularies (below), writes an activation receipt, and proves a real MCP handshake
  through the generated launcher: `initialize`, a `tools/list` that is exactly the three tools, and
  a `headroom_stats` call. If the handshake fails the receipt is rolled back, so no host entry is
  written for an unverified runtime.
- The generated `headroom` MCP entry is then projected into every selected host through the normal
  MCP projection (`.mcp.json`, the AIH-managed block of `.codex/config.toml`, and the other native
  hosts). Its launcher runs `node <core>/dist/ecc-runtime.js headroom ...`, which refuses to start
  without a current activation receipt for this worktree.
- The receipt (`activation.json` in the Headroom state root) records both consent flags and the UTC
  consent time, the package, source commit and platform wheel hash, the pyproject, `uv.lock` and
  aggregate dependency-lock digests, the vocabulary hashes, the network switches, the hosts, and
  the exact generated launcher with its digest.
- Later ordinary `--apply` runs re-verify the handshake offline and never download. A failed check
  is `blocked`; the activation is kept.
- `--deactivate-headroom --apply` removes the AIH-owned Headroom MCP entries from every host the
  activation receipt recorded, even when this run's `--cli` names fewer hosts (only entries
  byte-identical to the recorded launcher; a user-edited JSON entry is left alone as yours), then
  the whole Headroom state root including the runtime, caches and receipt. User-authored
  configuration is not touched.
- If a recorded host cannot be cleaned (for example a `headroom` table you edited inside AIH's
  managed block in `~/.codex/config.toml`), deactivation stops before deleting anything: Headroom is
  reported `blocked`, the runtime and receipt are kept, and the receipt records which host and why.
  Until you delete or restore that table (or move it outside the managed block) and rerun
  `--deactivate-headroom`, no run re-registers Headroom or reports it active.
- An organization policy may exclude Headroom (`developerTools.excluded`, or MCP controls such as
  `mcp.disabledServers`); activation is then refused and an existing activation is removed on the
  next `--apply` in the same way. A policy cannot activate Headroom: the policy schema has no
  activation field. Activation is also refused when governance owns AIH MCP projection.

Activation needs `uv` and an installed CPython 3.11–3.14 (`--no-python-downloads`). The locked
closure has prebuilt wheels for Windows x64, Linux x64 and arm64 (glibc 2.28 or newer), and macOS
arm64 only; on other platforms (including Intel macOS and Windows arm64) activation reports
`blocked` without downloading anything. On Windows without long-path support, keep
`LOCALAPPDATA` short: the deepest runtime path adds about 160 characters to the state root.

### Headroom privacy and egress

What leaves the machine, and when:

- **Activation only, with consent:** the pinned wheels from `pypi.org` and `files.pythonhosted.org`
  (every artifact is hash-checked against `uv.lock`), and the tiktoken `o200k_base` and
  `cl100k_base` vocabularies from `openaipublic.blob.core.windows.net` (tiktoken checks their
  published SHA-256 and AIH checks it again). Proxy and CA settings (`HTTPS_PROXY`,
  `SSL_CERT_FILE`, and similar) are honoured for this step only.
- **At run time, nothing by design.** The launcher starts Headroom offline (`uv run --offline
  --frozen`) with a credential-free environment (no API keys, proxy variables or
  `HEADROOM_PROXY_URL` are passed) and these switches: `HEADROOM_BEACON=off` and `DO_NOT_TRACK=1`
  (upstream's anonymous usage beacon to Headroom Labs is on by default; upstream documents it as
  compression counters, provider and model ids, OS and architecture), `HEADROOM_UPDATE_CHECK=off`
  (daily PyPI version check), `HEADROOM_OFFLINE=1` (upstream's master switch, which also disables
  its license/usage reporter and model downloads), `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`,
  `LITELLM_LOCAL_MODEL_COST_MAP=True` (LiteLLM otherwise downloads its model price map from GitHub
  on import), and `LITELLM_MODE=PRODUCTION` (LiteLLM otherwise loads a `.env` file found above its
  install directory). These are environment switches, not an operating-system network sandbox.
- **Loopback only:** `headroom_retrieve` and `headroom_stats` also ask a local Headroom proxy at
  `http://127.0.0.1:8787` (upstream default) for content it compressed. AIH does not install or start
  that proxy; when nothing listens the tools report it as unreachable.

What is cached locally: everything lives under one AIH-owned root, `<state>/aih/d/p/<project-key>/h`
on Windows (`%LOCALAPPDATA%`) or `<state>/aih/developer-tools/projects/<project-key>/headroom`
elsewhere (`$XDG_STATE_HOME`, default `~/.local/state`): the runtime environment (`e`), its uv
cache (`u`), Headroom's workspace (`w`, `HEADROOM_WORKSPACE_DIR`: the compression store keeps the
original, uncompressed content for retrieval, plus session statistics and savings events), the
tokenizer cache (`t`), a Hugging Face home (`f`) and the receipt. Deactivation removes all of it.

Model and ONNX downloads: the MCP extra does not install ONNX Runtime, Transformers or PyTorch, so
upstream's ONNX Runtime download (`cdn.pyke.io`) and Hugging Face compression models are not used in
this mode, and the offline switches above block Hugging Face access regardless. The only run-time
assets are the two tokenizer vocabularies. To pre-provision them on a host that cannot reach
`openaipublic.blob.core.windows.net`, create the `t` directory under the Headroom state root before
activating and place the files there under tiktoken's cache names:
`fb374d419588a4632f3f557e76b4b70aebbca790` (`o200k_base`, SHA-256
`446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d`) and
`9b5ad71b2ce5302211f9c61530b329a4922fc6a4` (`cl100k_base`, SHA-256
`223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7`); activation then reuses them.
PyPI access (directly or through a proxy) is still required to install the locked wheels.

### Primary code graph

Both code-graph tools stay available; the primary is the one agents ask first when a code-graph
question fits either. The rule: a policy `developerTools.primaryCodeGraph`
(`code-review-graph` or `codebase-memory-mcp`) binds, and a different `--primary-code-graph` is
refused; a policy that omits the field leaves the choice to the user, whose
`--primary-code-graph <id>` (on `aih developer-tools` or `aih init`) applies and is remembered. With
no choice at all there is no primary and routing stays task-based. Naming a primary the effective
policy excludes (or does not select) is an error.

On `--apply`, the effective primary and its source (`policy` or `user`) are recorded in the
developer-tools receipt. `aih bootstrap-ai` and `aih init` add one routing note naming the primary
to `rules/agent-behavior-core.md`; the shared bootloader block is unchanged. In a shared repository,
set the policy field so every user's generated guidance agrees. `aih doctor`'s large-repo graph
readiness follows the primary: with Codebase Memory as primary it checks the exact generated
registration and makes real MCP calls through it (`list_projects`, `index_status`, indexing an
unindexed project locally once), and it never downloads the native payload.

MarkItDown CLI converts local documents to Markdown. Setup installs version 0.1.8 with the PDF,
Word, PowerPoint, Excel and Outlook converters into an external runtime keyed by its dependency
lock using an existing Python 3.10–3.13 interpreter, verifies an actual conversion, and reports the installed CLI command. It does not change
global PATH or replace a user-installed CLI. Azure services, YouTube and audio-transcription extras
are not installed by default. Add `markitdown` to `developerTools.excluded` to opt out; repeat setup
and worktree changes preserve the policy choice.

MarkItDown MCP is a separate optional integration. Add `markitdown-mcp` to `mcp.allowedServers`
to select the pinned official adapter (0.0.1a7 with converter 0.1.8); `mcp.disabledServers` overrides
that selection. This adapter can access user-selected files and URLs with the current user's
permissions, and its first launch acquires its dependencies. Selecting the default CLI does not
enable the MCP adapter. GitHub MCP also requires an explicit choice through `mcp.allowedServers`,
a configured policy GitHub host, `--github-auth token`, or `--self-host`; it is absent from an
unconfigured project's default MCP set.

Playwright MCP uses the pinned `@playwright/mcp@0.0.82` runtime. It is selected by default for
all project types. Add `playwright` to `developerTools.excluded` to opt out; an explicit subset or
empty selection also omits it. MCP policy restrictions still apply. Its browser can access websites
with the current user's permissions; a local MCP process does not confine browser network access.
The generated launcher uses a headless, isolated browser session. Setup checks the MCP connection
and a browser operation on a blank page before reporting the tool as verified. It requires npm
alongside the current Node runtime and a browser supported by that Playwright release.

On `--apply`, each selected tool checks its own prerequisites. Code Review Graph, Serena and MarkItDown require
an external `uv`; Token Optimizer requires external Python, Git, and curl. Codebase Memory selects a
native payload for the current platform and architecture. An unavailable prerequisite or payload is
reported as that tool's `blocked` result while independent tools continue. This reference does not
claim host-wide Windows or macOS qualification; use the per-tool result on the target host.

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
dropped CLI is an ECC-supported target, prune uses the AIH registration ledger and ECC install
state to identify its owned footprint. Without a registration ledger, it preserves unreceipted ECC
client files and reports manual cleanup; ordinary AIH-owned adapter cleanup can still proceed.
When Codex is dropped, prune also subtracts the recorded ECC TOML footprint from
`~/.codex/config.toml` and the fenced ECC Codex block that `aih ecc` merges into
`~/.codex/AGENTS.md`, leaving unrelated user config and text outside that block intact.

A bare prune also reads `~/.aih/ecc/registration-ledger.json`, even when no committed CLI target
changed. Project registrations whose roots are missing retire from the machine union; common or
shared components and MCPs remain until their last live contributor disappears. The dry-run digest
names retired roots, orphaned component/MCP IDs, target states, and managed destinations without
changing bytes. Under `--apply`, prune removes only operations proven by ECC install state (plus
aih's fenced Codex records). Copied files must match their recorded SHA-256; JSON cleanup subtracts
only the recorded managed values. Modified files and legacy copies without a recorded digest are
preserved, and the operation refuses with a manual-cleanup explanation. Apply re-verifies every
planned input, prepares recovery material, performs owned removals, updates target state, and
replaces the primary ledger last. It does not run an upstream uninstaller. Missing required target
state, malformed or drifted state or markers, symlinks, concurrent input changes, or partial writes
fail closed; failures during the transaction roll back its owned changes. Project-local state that
never existed is not guessed. When a registration
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
security, and validated MCPs. Use `--profile full` for the full content selection.
Unknown declarations fail closed. The ordinary native-installer path keeps Kiro and unsupported
targets consult-only because their installers cannot materialize the scoped union safely. The
governed lifecycle described below has a separate verified Kiro rules-and-skills adapter.

Core and Full profiles do not authorize ECC hooks, executable plugins or host runtime.
Outside policy governance, explicitly declare `--with baseline:hooks` to admit those operations.
Governed delivery keeps upstream host runtime excluded even with that declaration; AIH retains
its separate MCP and hook ownership boundaries. Preview, installation and reconciliation apply
the same consent filter. Consult-only targets provide component advice and cannot authorize
executable or runtime recommendations.

When a verified upstream plan provides a hook-consent helper, AIH applies its effective
decision before checking operation kinds. The plan, receipt and selected modules must
agree; declined consent excludes `hooks-runtime`. Older plans without that helper retain
their existing behavior. Claude plans that still require `update-claude-settings` are
refused before installation because that operation's managed-hook ownership lifecycle
is not supported. This compatibility handling does not change the qualified ECC pin.

Reinstall refuses before changes when a narrower consent selection would leave previously
installed runtime content behind. It preserves the existing files and ownership state for
review and cleanup before retrying; reinstall does not silently withdraw that integration.

The AIH-owned Claude/Codex profile has a separate, explicit lifecycle mode on the same command:

```sh
aih ecc --lifecycle install <project>
aih ecc --lifecycle update <project> --apply
aih ecc --lifecycle repair <project> --apply
aih ecc --lifecycle rollback <project> --apply
aih ecc --lifecycle uninstall <project> --apply
```

Lifecycle mode always projects the reviewed Claude and Codex surface together. Install and update
read the profile and its evidence only from the installed Catalog's ECC framework descriptor
(`sections.profileEvidence`), whose commit must equal the `@aihq/framework-ecc` upstream commit;
while the installed Catalog carries no such section they refuse with
`framework-profile-evidence-unavailable` and name the next route. It authenticates the
exact ECC pin, the review receipt, every manifest, and every projected source byte before
constructing a target plan. Dry-run is the default and may acquire the exact remote source into a
disposable quarantine so the preview is based on real rendered bytes; it never writes the target.
`--ecc-path <dir>` supplies an existing exact checkout to the same boundary. Lifecycle receipts live
under `.aih/ecc-profile/` and make repeat install, repair, update, rollback, and uninstall fail closed
on foreign or operator-modified files. Repair, rollback, and uninstall use the receipt's bounded,
hash-authenticated installed bytes and source identity, so a later package pin cannot strand an
older managed installation. The receipt is operator-writable, so its self-declared identities never authorize
a write on their own: the active source and, for rollback, the snapshot's source and projection digest
must equal an entry in Core's append-only ECC profile installation trust record (shipped in `@aihq/core`, read by the plugin through `@aihq/core/framework-host`; the plugin ships no anchors of its own), or the command refuses
with `framework-profile-recovery-unanchored` before planning any write. Recovery identities are versioned: version 2
(recorded by current installs) also binds each file's merge strategy, and a version-1 identity from an earlier release
recovers only when a version-2 anchor at the same pin authenticates its write semantics. Uninstall, update and rollback
never delete a merge destination such as `.codex/config.toml`: they remove only aih's managed blocks and keep the
file, even when only whitespace remains, because nothing proves aih created the whole file; the plan names each file
kept that way so you can remove it by hand if nothing uses it. Update normally requires a new ECC pin; within the
installed pin it migrates only between two projections that Core's trust record both anchors at the same source closure,
such as a later render that projects only the stub for a skill a client cannot run. It removes the files aih owned that
the new projection drops, never touches operator files, and keeps rollback to the installed projection. Repair of an
installation that a later anchored render of its pin supersedes refuses and routes to `--lifecycle update`, because
repair replays the receipt and would restore what the current render withholds. These refusals exit with
`AIH_FRAMEWORK_PLUGIN`, a stable reason and the next route: `framework-profile-superseded` for that repair,
`framework-profile-update-same-pin` for any other update within the installed pin, and `framework-profile-already-owned`
for an install over an installation of another pin or projection. Legacy selection flags such as `--profile`, `--with`, and `--cli`
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

Governed Codex skill selection uses the shared project `.agents/skills/` route.
Reapplication withdraws an older `.codex/skills/` duplicate only when unchanged
materialization receipts prove ownership; edited and unowned copies are retained
and reported. It does not replace disabled-skill settings or filter native plugin
inventory. The governed preview includes exact selection/source and destination
facts beside exclusions, refusals and ownership advisories. Proposed destinations,
installed bytes and actual native loading remain different claims. See the
[selection ownership guide](../guides/portable-policy-delivery.md#inspect-selection-and-discovery-ownership)
for preview, ordinary reinitialization and migration.

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
that location. That machine state root is shared by every project on the machine and survives
uninstall, so once it exists `aih uninstall` and `aih prune` in any project refuse when the
`@aihq/framework-ecc` bundled in `@aihq/core` is missing (`framework-plugin-unavailable`) and name
the root in full with the manual route: reinstall `@aihq/core`, or, once no project on this machine uses the ECC native
registration, remove that root by hand. Conflicting server identities, linked launchers, overlapping state roots, modified
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

The ECC registration lane's validated MCP default is pinned local `sequential-thinking`, repo-declared
`code-review-graph`/`codebase-memory-mcp`, and GitHub OAuth at enterprise. Context7, Exa, and
other egress-bearing servers are not defaults of that lane. Project config receives that project's set; global
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

Every `chrome-devtools-mcp` launch aih can read in the user (`~/.codex/config.toml`) or project
(`.codex/config.toml`) Codex config must set `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS = "1"` and
`CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = "1"` in its `env` table, whatever the entry is called. aih
checks this at plan time and again just before apply, on governed installs too and for its own stale
managed entries. It refuses with `mcp.telemetry-opt-out-missing`, naming the scope, entry, config
path, missing variables and next step, and never rewrites the entry. aih sees only launches written
literally in the config: an entry whose command is a wrapper script that starts
`chrome-devtools-mcp` without naming it is outside what aih can verify, so set both variables inside
that script yourself.

Kiro installs are ownership-tracked so a stale copy is visible. Because ECC's own installer writes
the bytes, aih attributes ownership by what a run CREATES: it snapshots `.kiro/` before the
installer, re-walks it after a successful install, and records each created file's sha256 plus the
ECC commit it came from into repo-local `.aih/ecc/install-manifest.json`. That location survives
target-directory cleanup and is never committed. A later run re-checks each recorded path: a matching
hash from an older commit is _stale_, a changed hash is _locally modified_ and is never
auto-replaced, a recorded path that is gone is _removed_, and anything with no record is _unknown
provenance_ and is never claimed or touched. Kiro's installer copies only absent destinations, so a
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

The Superpowers behaviour ships inside `@aihq/core` as its bundled `@aihq/framework-superpowers`
package; there is nothing extra to install. If an install lacks it, the command refuses with
`framework-plugin-unavailable` and names the reinstall: `npm install -g @aihq/core`, or in a project delete `node_modules/@aihq/core` and run `npm install`. A bundled plugin that fails
its contract, version or Catalog identity check refuses with `framework-plugin-incompatible`.

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
**install-time teeth**: `workspace add` refuses promoting a skill with no committed approval _for
that source's pinned commit_ at `enterprise` posture (advisory at `vibe`) — a same-named
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

**Repository note.** This repository commits `aih-packs.json` to curate its first-party documentation, governance, and review skill packs. Curation grants no approval or install authority; each target still needs its own verified per-skill approvals. Backend catalog source records are independent of pack curation. On an AIH target without the optional manifest, `aih pack status` reports no packs and `aih pack validate` skips the pack-manifest check; neither reconstructs a manifest from unrelated files.

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

### Project assignment and required-content delivery

`aih policy bind <root> --project <id> --cli <list> --policy <file>` previews a
durable assignment; add `--apply` after review. It records the canonical root,
project identifier, exact selected policy path/digest and complete approved
target set in `.aih-config.json`. Fresh AIH processes restore that selection.
Binding is not authority, account-wide environment configuration or implicit
policy merging. Explicit conflicting sources or targets fail closed.

`aih policy rebind <root> --project <same-id> --cli <list> --policy <file> --apply`
acknowledges reviewed policy bytes, a reviewed target change, or a new canonical
checkout of the same project. It reruns the policy authority and target checks.
`aih policy revoke <root> --project <same-id> --apply` retains a revoked binding
that blocks mutation; it does not delete content or stop native processes.
Withdraw owned content through the authorized policy before revoking it. Rebind
with current verified authority to recover.

`aih policy project <root> --apply` projects supported controls and reconciles
selected governed ECC content. `--ecc-path <path>` supplies a local checkout
that must still pass exact source and qualification checks. An explicitly empty
authorized ECC selection withdraws owned content; losing policy is not an
unrestricted installer fallback. `aih init` also accepts `--ecc-path` for a bound
project's required-content delivery and suppresses an unselected Superpowers
baseline under governed policy.

`policy evaluate --json`, readiness and HTML reports distinguish policy and
binding blockers, selected content, ownership drift and unverified native
loading. Receipt-current describes recorded source/owned bytes, not a native
session or enforced practice. The full administrator/developer lifecycle and
downstream content ownership contract are in
[Project policy delivery](../guides/portable-policy-delivery.md).

### Policy data and headless authority

The Policy Workbench browser and `aih policy generate` command were removed in this greenfield cutover; there is no `aih-ui` replacement. Core retains the policy schema, validation, effective-state resolution, and governed command routes. It does not expose a public browser or a replacement authoring command. Administrators prepare policy and PolicyBundle V2 files outside the governed target, validate them with `aih policy validate`, and supply an administrator-controlled protected file through `--policy <file>` or `AIH_ORG_POLICY`. A readable file or Catalog entry alone is not authority.

Schema-v3 policy input still records exact `authoringSelections` and `minimumCoreVersion`; legacy schema-v2 input remains accepted. The retained `compilePolicy` and `compileOrganizationManifestV1` functions are Core/build-time APIs, not public `aih policy` authoring commands. Source selection, Scanner evidence, Catalog qualification, organization decisions, and effective policy are separate checks. An imported declaration or source-data snapshot grants no approval by itself.

Compatible source data can be updated without replacing the installed Core package through `aih policy data prepare`, `aih policy data sign`, and `aih policy data import`. Each writes only with `--apply`; otherwise it is a dry run. Preparation takes `--source`, `--sequence`, `--out`, an optional `--source-bundle`, and `--previous-digest` after the first accepted snapshot. `--scanner-proof` and `--qualification-proof` supply independent raw proofs. Signing takes `--input`, `--key`, `--trust`, and `--out`; it checks the configured `workbench-source-data/v1` signer role and source scope but does not activate data or establish Scanner or Catalog custody. Keep signing keys outside repositories and exported policies.

Import takes `--input`, optional `--store`, and `--scanner-source` for exact source bytes when replaying Scanner proofs. For digest-addressed manifests, `--proof-root <directory>` must contain the original `<sha256>.blob` files. Core checks size and hash before independently verifying original publications. Signed snapshots are bounded to 16 MiB; referenced compiler inputs and raw proofs have a separate aggregate 128 MiB ceiling and per-blob limits. GitHub CLI (`gh`) is required during independent raw-proof verification. The separately configured store `trust.json` is never accepted from an imported bundle. A new compiler format requires a Core release.

Accepted snapshots remain under per-user `.aih/workbench-data/v1` (override `AIH_WORKBENCH_DATA`); local verifier receipts remain under `.aih/workbench-verifier/v1` (override `AIH_WORKBENCH_VERIFIER_HOME`) outside that store. These are backend verification paths, not a retained browser UI. Back up signing roots, exact inputs, raw proofs, and signed bundles independently; copying a cache does not establish verification authority or extend report freshness.

### Retained headless policy fields

The retired administrator-catalog Workbench preparation route is not a CLI command. Core still parses and validates the declarative policy fields below. Catalog source qualification and administrator authority remain separate from policy input; neither a cached catalog nor a saved policy grants approval or effective state.

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
apply-time absent pin), an active `--policy` or `AIH_ORG_POLICY` selection refuses outright (the
starter only targets the committed default file), and an unreadable MCP config aborts the plan. The starter
records the resolved posture as `minimumPosture`, and `--verify` grades the written file with the
same schema gate as `validate`. Declaring `mcp.allowedServers` records registry membership only;
`aih mcp approve` is a legacy, non-governed approval path. Governed operators use an externally
verified evidence/approval receipt, then `aih policy evaluate` and `aih policy project`.

`project --apply` compiles the active verified org policy into generated policy artifacts. The source
may be the committed `aih-org-policy.json` or an Enterprise PolicyBundle V2 at an absolute external
path selected by `--policy <file>` or `AIH_ORG_POLICY`, whose authority, custody, freshness, and exact file
identity Core verifies. A relative `--policy` value resolves from the target root. The explicit CLI flag wins
over the environment variable, and a missing selected file fails closed rather than falling back to the
default filename. For
Claude this includes `.claude/managed-settings.json` and, at enterprise posture, the two system-path
examples. Selected reviewed stdio MCP candidates also have receipt-owned workspace
distribution for Codex, Cursor, Copilot CLI, OpenCode V1, Kimi Code, and Kiro; see
[governed MCP targets and compatibility](governed-mcp.md) for the native paths and limits. An active
AIH-owned `usage-metering` policy hook may also project to the selected Claude or Codex host through
the existing host-specific generator. A policy may separately declare `governance.frameworkHookControls` (schema 3, `minimumCoreVersion` 0.7.0), keyed by framework id with `{ profile?, disabledHookIds }`; the project's `.aih-config.json` `frameworkHookControls` list is `{ disabledHookIds }` only and may add further disables of disable-eligible rows; a profile or any other field there is refused, because enterprise policy is the only profile source. Each framework plugin validates the ids and profile against its own hook inventory and returns the hook-control plan; a requested framework whose plugin is not installed refuses with `framework-plugin-unavailable`. Controls are planned and validated for every targeted host, OpenCode-only included, and each disabled hook's per-host decision (`upstream-switch`, `not-applicable`, or `unenforced` with its next route) is carried in the projection output as an `<framework> hook controls` label. For a Claude target, projection merges only the receipt-owned environment keys the plan names — for ECC, `ECC_HOOK_PROFILE` and `ECC_DISABLED_HOOKS` — into `.claude/settings.json.env` (receipt `.aih/org-policy-framework-hook-controls-receipt.json`), preserves every operator sibling, refuses unreceipted collisions or drift, and shares one content-pinned settings snapshot with the hook registrar. The framework—not AIH—executes and enforces those controls after process spawn, so a disabled ECC hook still incurs one spawn.
It does not run `aih init`, regenerate the canon, or modify unrelated settings. The managed settings/MCP
file is a Claude projection: it writes only when Claude is selected (the default).
Other governed MCP targets receive their own workspace configuration rather than a Claude
managed-settings file. When managed-only MCP is active, it records existing AIH ownership provenance in
`.aih-config.json` so later deactivation can remove only the exact generated values. It refuses a
configuration write when `AIH_ORG_POLICY` selects an ordinary override; previewing without `--apply`
remains inspectable. The only external mutation source is the exact protected PolicyBundle V2 that
Core has verified for the same path, and its bytes remain pinned through the transaction.

New governed MCP ownership records are always strict schema V2 and bind the exact effective
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
payload. Administrators prepare and validate that file outside the governed target; the `issuerRepository` field
is an attribution identity required by the reused V3 schema, not a requirement that the file live in
GitHub. Core accepts only current, strict, bounded, regular, single-link, non-symlinked custody,
re-observes the exact bytes, and pins them inside every authority-dependent mutating transaction.
ECC and Superpowers evidence, ECC request selection, ordinary ECC profile lifecycle acquisition and
mutation, standalone MCP planning, and standalone Usage ownership checks reuse that one verified
policy observation. ECC profile install/update composes projection and native registration in one
pinned filesystem transaction; receipt-bound uninstall remains independently authorized by installed
custody. Init retains each nested phase's file assertions, deadline, and lock and refuses a
conflicting observation before effects. A plan that launches a child process retains and renews the
cooperative authority lease across the awaited process and revalidates immediately before and after
it. A failed post-process revalidation blocks later effects and deferred writes but reports honestly
that an already-run external command is not rollbackable by Core.
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
reference, and a decision present only in policy JSON has no authority. A standalone
decision file cannot create authority or decide effective state.

### Strict V2 organization-qualified contract foundation

The public library and package schemas expose `GovernanceDecisionV2`, digest-bound
`GovernanceDecisionRevocationV2`, authority receipt V3, and
`UpstreamObservationReceiptV1`. The decision can identify an exact organization-chosen
tool, skill, agent, MCP server, package, or profile through immutable GitHub, npm, PyPI,
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
and revocations: unsigned policy fields, legacy approvals,
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
`@aihq/core/schemas/aih-supported-qualification-receipt-v2.schema.json`; the schema
was introduced in Core `0.3.0`.

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
described below. Organization-managed tool, skill, agent, MCP, or package files absent from AIH catalogs use
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
tarball into a disposable consumer, then uses the installed public Core parser to validate
an exact headless PolicyBundle V2 fixture used for
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
projectable. Catalog-independent organization-qualified tool, skill, agent, MCP, and package files use the
separate fixed route below.

### Catalog-independent organization-managed artifact observation

`aih policy observe upstream-artifact [root] --decision <id> --decision-digest <sha256>
--target <id> --evidence <root-relative-file> --manifest <root-relative-file>` observes exact files
the organization already placed below the governed root. The Decision V2 must be
`organization-qualified` and name a tool, skill, agent, MCP server, or package; `aih-supported` is not
accepted on this route. The canonical `UpstreamArtifactManifestV1` is bounded to 512 KiB and 256
sorted, portable-case-unique file entries. It accepts exact mixed-case paths while rejecting any
segment with a trailing dot/space or Windows device alias. It exact-matches the decision id, subject
kind/id, source/subject digests, target, allowed effect, accountable integration owner, and exact
integration-contract version. Its raw canonical SHA-256 must be present in the canonical
organization evidence envelope's `artifactDigests`. The manifest binds the decision id rather than
the decision digest because the decision already binds the evidence digest and the evidence binds
the manifest bytes; a decision-digest field would create a digest cycle. The portable schema ships
at `@aihq/core/schemas/aih-upstream-artifact-manifest-v1.schema.json` in the published
`0.3.0` Core package, and the public library
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
a disposable consumer, and exercises the public parser, packaged schema, installed CLI, and
an exact headless validated authority fixture. It
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

Read-only release verification for published `@aihq/core` versions. With no positional version,
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
Claude uses `.mcp.json`, Kimi Code uses `.kimi-code/mcp.json`, Cursor uses `.cursor/mcp.json`, and Kiro uses
`.kiro/settings/mcp.json`; Codex gets native TOML in `~/.codex/config.toml` (including
`bearer_token_env_var` for token auth), OpenCode gets its global
`~/.config/opencode/opencode.json` V1 `mcp` map, and Copilot CLI uses `.github/mcp.json`
with `mcpServers` (its CLI does not consume VS Code's `.vscode/mcp.json`). Zed and other
global-config entries get their registry-specific native writes or guidance. Global config targets are selected only through
an explicit flag or a committed marker; `--apply` can affect that CLI across all projects. Scopes:
local/project/remote. `--mode offline` selects stdio servers and uses the same native
paths, environment translation and preservation rules as standard generation for
every selected CLI. Vendor package launchers before blocking egress; preserved
operator-owned servers must be reviewed separately. `--mode none` emits CLI-tool
fallback guidance and leaves active host configuration unchanged. Both modes emit
a `managed-mcp.json.example` administrator template only when Claude is selected;
deploying that template is a separate administrative step.

Codex stdio environment references become `env_vars`; Cursor uses `${env:NAME}`,
and OpenCode uses `{env:NAME}`. Copilot CLI and Kimi Code environment mappings with
no supported native representation are refused before configuration is written.
The plan reports feature support and host requirements separately from runtime
acceptance. See [governed MCP configuration](governed-mcp.md) for the scope and
verification differences. Enterprise org policy can also tune the hosted GitHub
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

For a bounded OpenCode Linux workflow, configure `--cli opencode` with an
external `--policy`, `--bwrap-executable`, `--opencode-executable`,
`--seccomp-executable`, repeatable
non-secret `--binding NAME=value` and native `--client-arg` values. Optional
repeatable `--hide-path` and `--read-only-path` values name existing absolute
paths. Preview first, then use `--apply` to save the per-root launch profile.
`aih sandbox --cli opencode --launch --apply` reloads that root's bindings for a
fresh native process. See [repeatable OpenCode Linux
launches](../guides/opencode-linux-sandbox.md) for setup, restart, worktree
ownership, filesystem exposure and the separate native acceptance boundary.

The Claude policy writes the egress list at `sandbox.network.allowedDomains`, alongside
`sandbox.enabled`, `sandbox.failIfUnavailable`, and `sandbox.allowUnsandboxedCommands: false`.
The additional `sandbox.commandPolicy` block is AIH metadata; Claude's command permission
rules use `permissions.allow`, `permissions.ask`, and `permissions.deny`.

When reapplying, AIH removes the obsolete `sandbox.allowedDomains` key only if its
ordered value exactly matches the previous generated defaults for the detected
stack. The write is bound to the settings bytes inspected during planning and
refuses the migration if they change. Other legacy values remain untouched with
a review note; AIH does not copy them into the new network allowlist. This exact
value match is a migration heuristic, not an ownership receipt.

`.claude/managed-settings.json` is a deployment artifact. Claude does not load that filename
from the project directory as managed policy. The adopter must deploy it through a supported
[managed settings source](https://code.claude.com/docs/en/managed-settings).
For a session-scoped trial on a supported host, `claude --settings .claude/managed-settings.json`
loads the file explicitly; this does not make it an administrator-managed policy.

Claude's built-in Bash sandbox currently supports macOS, Linux and WSL2, with host-specific
prerequisites. Native Windows is unsupported. The Bash sandbox also does not automatically
confine local MCP servers; those require their own process boundary. See Claude's
[sandbox documentation](https://code.claude.com/docs/en/sandboxing) for platform support and
the distinction between Bash sandboxing and tool permissions. Generating this Claude policy
does not configure sandbox enforcement for another CLI.

**Verification**

The command checks Docker reachability; a missing binary or unreachable daemon is reported
as skipped. It does not start a container or prove client execution. The generated container
has no outbound network block, and a Git worktree does not provide a security boundary.

In a disposable consumer project, verify that the intended client loads the policy, completes
an allowed command, and denies an explicitly prohibited operation without the prohibited
effect occurring. Test an actual local MCP tool call separately from discovery, and test
network restrictions independently from file restrictions. A successful file-denial test
does not prove a network boundary or another client's behavior.

## aih docs-lint

Read-only BetterDoc documentation lint. It scans the public-facing Markdown surface <!-- aih:claim CM-12 -->
(`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/`, and `guides/`, excluding internal
report specs under `docs/specs/`) using the phrase and claim guidance in
`packs/docs-quality/aih-betterdoc/references/slop-lint.md`. Prose
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
`packs/governance-quality/aih-gov-doctor/profile.json`. The loader takes no
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
exactly as before. Doctor's canon markdown lint check skips on _exactly_ the same condition as this
one — both test whether the context directory exists — so the mapped tuple is still subject to the
same closed Audit rule. The separate `aih repair` route does not use that mapping as its execution
license; it uses the branded live precondition documented below, while this command remains a
read-only Audit/Guide presentation.

**Flags**

The shared zero-write set — `--json`, `--posture <posture>`, `--root <dir>`, `--policy <file>`, and
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
from the diagnostic's own text. Those inputs are only ever _gates_. A plan is previewed only when
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

| `outcome`      | `state`                                        | Exit |
| -------------- | ---------------------------------------------- | ---- |
| `completed`    | `null`                                         | 0    |
| `partial`      | `null` (per-diagnostic states in `refusals`)   | 1    |
| `evidence-gap` | `null` (per-diagnostic states in `refusals`)   | 1    |
| `refused`      | `policy-denied` or `compatibility-required`    | 1    |
| `unavailable`  | `profile-unavailable` or `adapter-unavailable` | 1    |

`completed` means every declared diagnostic resolved — findings may be present or absent.
`partial` means some diagnostics produced findings and some did not resolve: the run found
real problems _and_ could not see part of the workstation, so it is neither a completed
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
the failed _internal configuration_ the recipient must fix at the system level. Each follows the
structure **Summary → Impact → Issue → Observed evidence → Environment → Requested fix → Acceptance
criteria**, and every escalation ends with a security work-around guard (keep TLS verification and secret
controls enabled; don't change project code). Evidence, affected area, and acceptance criteria are canned
per code — never guessed — with the live check detail riding along as evidence (redacted: home-dir
scrubbed, secret-aware argv masking).

**Project context (`SETUP.md`).** A project can shape the tickets with opt-in HTML-comment markers in
`SETUP.md`, `docs/SETUP.md`, or `.aih/SETUP.md` (first found wins):

- `<!-- support:why -->…<!-- /support:why -->` — _why a correct environment matters for this project_,
  woven into the ticket's Impact / "Why this helps" section. Falls back to the first paragraph under a
  `## Why` / `## Overview` / `## Purpose` / `## Background` / `## About` heading, so existing setup files
  contribute without edits.
- `<!-- support:routing -->…<!-- /support:routing -->` — real routing metadata (assignment group, ticket
  prefix) rendered verbatim in the Environment block. **Never invented** — shown only when you provide it.
- `<!-- support:language -->…<!-- /support:language -->` — an instruction to adapt the message to the
  org's corporate language, surfaced as a **terminal note** to the author, never embedded in the ticket
  body (which stays clean to paste).
