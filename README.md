# aih — Enterprise AI Bootstrapping Harness

[![CI](https://github.com/samartomar/ai-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/samartomar/ai-harness/actions/workflows/ci.yml)
[![CodeQL](https://github.com/samartomar/ai-harness/actions/workflows/codeql.yml/badge.svg)](https://github.com/samartomar/ai-harness/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/samartomar/ai-harness/badge)](https://scorecard.dev/viewer/?uri=github.com/samartomar/ai-harness)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node ≥20](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](package.json)

A cross-platform CLI that prepares developer workstations and repositories for
**safe, governed AI-assisted coding behind a corporate proxy**. It extracts
corporate trust, tunes local inference, hardens repos with guardrails, wires up
MCP / observability / sandboxing, and lays down a tool-agnostic context
architecture — all from one command surface.

> Turns the architectural blueprint *"Enterprise DevSecOps AI Bootstrapping:
> Cryptographic Trust, Local Performance Optimization, and Unified Observability"*
> into a real, tested product.

## Design posture

- **Dry-run by default.** `aih <cmd>` computes and prints a plan; nothing is
  written until you add `--apply`. Add `--verify` to run read-only checks.
- **Never mutates a remote system.** Every unit of work is a local `write`, a
  local `exec` (icacls/chmod/junction…), a read-only `probe`, or a `doc` (the
  exact commands for cloud setup — SSO, gateways, Langfuse, MDM — emitted for a
  human, never executed). There is no code path that provisions cloud infra, so
  an automated run cannot "fake" it.
- **Idempotent & non-destructive.** Shell-profile edits live in marked managed
  blocks; JSON configs are deep-merged (your keys survive); every overwrite is
  backed up to `*.aih.bak` and rolls back as a transaction on failure.
- **Cross-platform.** Windows and Linux are verified on real metal (Windows:
  PowerShell/icacls/junctions; Linux: real `/proc`, `/etc/ssl/certs`, `chmod`,
  `ln -sfn`, smoke-tested in a Hyper-V Ubuntu VM). macOS is implemented and
  fixture-tested. All OS calls go through an injectable runner.

## Install

```bash
npm install        # deps
npm run build      # → dist/cli.js  (bin: aih)
node dist/cli.js --help
```

## Command surface

| Command | What it does |
| --- | --- |
| `aih certs` | Extract the corporate root CA from the OS trust store, lock it down, and propagate trust to npm/pip/cargo/conda. |
| `aih hardware` | Profile CPU/RAM/GPU; compute memory/thread/parallel limits + quantization; emit tuned Ollama/llama.cpp settings. |
| `aih vdi` | Detect VDI (Citrix/WorkSpaces/RES/RDP) and redirect caches + SQLite to local scratch (junction on Windows). |
| `aih profile` | Recursively detect the repo's stack and synthesize Cursor stack rules (`.cursor/rules/*.mdc`). Root bootloaders are owned by `bootstrap-ai`. |
| `aih ecc` | Install [affaan-m/ECC](https://github.com/affaan-m/ECC) (skills, instincts, memory, security, research-first) for the selected CLIs, scoped to the detected stack: Claude plugin path, `ecc-install` for codex/cursor/zed/opencode, `consult` advisor otherwise. |
| `aih superpowers` | Install [obra/Superpowers](https://github.com/obra/Superpowers) (brainstorm → plan → TDD → subagent-review skills) for the selected CLIs. |
| `aih scaffold` | Create the canonical context dir (`--context-dir`, default `ai-coding`) — INDEX/SKILL skeleton, an agent **`SETUP-TASKS.md`** playbook (fill context + guardrails from the code), a write-once `project-guardrails.md`, a secret deny-list, and a pre-commit hook. (Bootloaders are `bootstrap-ai`'s job.) |
| `aih guardrails` | Generate `.gitleaks.toml`, `.pre-commit-config.yaml`, and a CI license gate that blocks AGPL/strong-copyleft. |
| `aih secrets` | Scan for plaintext `.env*`/`secrets/` and write agent deny rules + vault-injection guidance. |
| `aih mcp` | Generate `.mcp.json` (local/project/remote scopes); for locked-down orgs, `--mode offline` (vendored local-command servers) or `--mode none` (no MCP + a CLI-tool fallback) plus a `managed-mcp.json` admin template. |
| `aih sandbox` | Generate a devcontainer + managed sandbox settings (egress allowlist, `failIfUnavailable`). |
| `aih telemetry` | Inject OpenTelemetry env, a redacting Bindplane collector, and an analytics fetcher (usage + skills endpoints → `{ usage_report, skills }`). |
| `aih report` | Read-only analytics digest. Local: a dev console — agent **context footprint** (token bloat), **repo & branch status** (current branch, ahead/behind vs main, dirty; `--team` adds in-progress team branches via a `gh` → `git ls-remote` → last-fetched ladder that degrades gracefully when gh/network is blocked), repo config presence, local AI-CLI tooling saturation, and **trends** (unicode sparklines of commits/LOC/adoption/branches over recorded history — see `aih track`). Org (`--org <export.json>`): top skills, tokens by type, **cache savings** (net-of-write estimate), and accept/reject from a saved Admin-API export. Body prints verbatim; `--json` carries structured data; `--format md\|html` writes a static artifact under `--apply`. **`--open`** builds the self-contained HTML dashboard (adoption ring, KPI strip, trend charts) and launches it in your browser (implies html + apply). Network-free by default; `--team` is the lone opt-in network call. |
| `aih track` | Record one metrics sample (commits 7d, LOC delta, adoption score, branch count, tracked files) to `.aih/history.jsonl` — the time-series behind `aih report` trends. Read-only git/filesystem; dry-run previews, `--apply` appends (idempotent per commit). Wire into a commit / agent-stop hook so history accumulates — the Kiro `metrics-on-stop` hook (`aih bootstrap-ai --cli kiro`) runs `aih track --apply` automatically. |
| `aih usage` | Install the **multi-tool usage-capture** layer → `.aih/usage.jsonl` (rendered by `aih report`'s Usage panel). The **universal floor** is a git `post-commit` hook that records commit activity for **any** tool (it keys off the commit, not the agent). The per-tool **skill/MCP** layer wires in via each CLI's verified local hook (Claude/Codex/Cursor/Gemini/Kiro/… — `aih usage` documents the exact mechanism); skills aggregate by source (ECC/canon/user). Behavioral capture is near-universal (9/11 CLIs have local hooks); only **dollar cost** is uneven (real USD from Claude, token counts from Codex/Gemini/Kimi/OpenCode, cloud-only for Cursor/Windsurf). |
| `aih crispy` | Run the CRISPY context-engineering stage machine (deterministic, gate-ordered). |
| `aih bootstrap` | Orchestrate the workstation 4-phase rollout (certs → hardware/vdi → telemetry). |
| `aih bootstrap-ai` | Emit + verify the repo's Layer-2 `ai-coding/` canon: `RULE_ROUTER.md`, per-CLI adapters, and root bootloaders (tool preamble + a regenerated shared block). `--verify` is the drift gate. |
| `aih init` | Initialize a repo: profile + ecc + superpowers + bootstrap-ai + scaffold + secrets + guardrails + mcp + sandbox in one pass (one writer per file). |
| `aih workspace` | Scaffold a **multi-repo** workspace (parent-only): cross-repo architecture map (write-once) + per-repo discipline, a VS Code `.code-workspace`, a filesystem MCP spanning every child repo, and a `.aih-workspace.json` marker. |
| `aih doctor` | Fail-closed verification of the workstation/repo configuration (+ workspace mode: validates each child repo). |
| `aih status` | Read-only inventory of what the harness has configured. |

Global flags: `--apply`, `--verify`, `--json`, `--context-dir <dir>`, `--root <dir>`, `--cli <list>`, `--all-tools`.
Settings also read from `AIH_*` env vars (`AIH_APPLY`, `AIH_CONTEXT_DIR`, …).

### Targeting CLIs

`aih ecc`, `aih superpowers`, and `aih bootstrap-ai` only touch the agent CLIs you actually use.
Pass `--cli` with a comma-separated list, `--all-tools` for every supported CLI, or `--detect` to
auto-target the CLIs found on this machine; the default is `claude`. Supported:
`claude, codex, cursor, antigravity, gemini, copilot, windsurf, opencode, zed, kimi, kiro`.

```bash
aih ecc --cli claude,codex          # ECC for Claude (plugin) + Codex (ecc-install)
aih superpowers --cli antigravity   # agy plugin install … (runs under --apply)
aih bootstrap-ai --cli kiro         # writes .kiro/steering/00-canon.md (inclusion: always)
aih bootstrap-ai --detect           # target only the CLIs installed here
aih init . --all-tools              # bootstrap a repo for every CLI at once
```

Each CLI gets its native entry: Claude → `CLAUDE.md`, Codex/OpenCode/Zed/Kimi/Antigravity →
`AGENTS.md`, Gemini → `GEMINI.md`, Cursor → `.cursor/rules/*.mdc`, Windsurf → `.windsurfrules`,
Copilot → `.github/copilot-instructions.md`, **Kiro → `.kiro/steering/00-canon.md`** (`inclusion:
always`, with a `#[[file:…/RULE_ROUTER.md]]` live-reference). For a tool aih doesn't target yet,
`<context-dir>/adapters/other-tools.md` documents how to point it at `RULE_ROUTER.md`.

**Kiro depth.** Since Kiro can't read `~/.claude`, selecting `kiro` also generates Kiro-native
content (schemas verified against [Kiro's docs](https://kiro.dev/docs/steering/) and ECC's real
`.kiro/` tree):

- `aih bootstrap-ai --cli kiro` → `.kiro/steering/agent-tools.md` (stack-aware CLI usage) +
  stack-aware `.kiro/hooks/*.kiro.hook` files (`aih-secret-scan-on-create`, `aih-tests-on-edit`,
  `aih-quality-gate` running the repo's real lint/test) in Kiro's real hook schema.
- `aih ecc --cli kiro` → runs ECC's **native** `.kiro/install.sh` (copies ECC's agents/skills/
  steering/hooks into `.kiro/`) when a local ECC checkout is found (`--ecc-path <dir>`, or
  `~/.claude/ecc`, `~/ECC`); otherwise documents the `git clone` + install.
- `aih superpowers --cli kiro` → `.kiro/steering/superpowers-methodology.md` (the
  brainstorm → plan → TDD → review routing, since Kiro can't load `~/.claude/superpowers`).

**Detection** (`--detect`) looks for each tool's config dir (`~/.claude`, `~/.codex`, `~/.gemini`,
`~/.cursor`, `~/.kiro`, …) or its binary on PATH (via the Runner seam — no real process in tests).
Precedence: `--all-tools` > `--cli` > `--detect` > default `claude`. When `--detect` finds nothing it
defaults to `claude` and says so. **In an interactive terminal, `--detect` shows the detected list and
asks you to confirm or edit it** (press Enter to accept, or type a comma-separated list to add/remove
tools) before anything installs — pass `--yes` (or run non-interactively / piped / `--json`) to skip
the prompt and use the detected list as-is. `aih doctor` reports which CLIs it detects, and
`aih bootstrap-ai --verify` adds a per-CLI **"installed"** confirm step (pass = found, skip = not here
yet, bootloader still written) alongside the drift gate.

**Canon directory name.** Every generated file and reference adopts `--context-dir <name>` — use any
name you like; the default is the visible `ai-coding/`:

```bash
aih init                          # → ai-coding/   (default, visible)
aih init --context-dir my-canon   # → my-canon/    (any name; everything adapts)
aih init --context-dir .ai-context  # → hidden, the old default
```

Shell-runnable installs (`ecc-install`, `agy`/`copilot plugin install`) execute under `--apply`;
in-tool slash-command installs (Claude/Codex/Kimi plugins) are emitted as exact commands to run
inside the tool. ECC and Superpowers are complementary — ECC supplies stack-aware rules, agents,
and memory; Superpowers supplies the disciplined agent loop that uses them.

### Layered AI canon (`bootstrap-ai`)

The harness models the same two-layer setup used in the reference repos (eicp / ai-os / syntegris):

- **Layer 1 — user baseline:** ECC + Superpowers, installed per CLI by `aih ecc` / `aih superpowers`.
- **Layer 2 — repo canon:** the committed `ai-coding/` (or `--context-dir`) tree — `RULE_ROUTER.md`
  (stack-aware routing entry point), `adapters/<cli>.md` (per-tool wiring notes), `REGENERATION.md`,
  and the root **bootloaders** (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor/Windsurf/Copilot).

`aih bootstrap-ai` generates and verifies Layer 2. Each bootloader is hand-editable tool-specific
content **plus one marker-delimited shared block** that `bootstrap-ai` regenerates idempotently —
your edits outside the markers survive (merged in, with an `.aih.bak` backup). `aih bootstrap-ai --verify`
is the **drift gate**: it fails if the router is missing or a bootloader's block has been hand-edited
away from the canonical source — wire it into CI to keep every tool's entry point in sync.

```bash
aih bootstrap-ai --all-tools --apply   # lay down RULE_ROUTER + adapters + bootloaders for every CLI
aih bootstrap-ai --verify              # CI drift gate (no writes; exit 1 on drift)
```

Precedence: **Layer 2 wins** on conflict — repo canon overrides the generic baseline. Run
`aih scaffold` for the context dir (`INDEX/architecture/conventions`) the router points at.

### Multi-repo workspaces

Most orgs split a product across **separate repos** (a UI repo and a backend repo in one git org). An
agent editing the UI then has no view into the backend — no cross-repo blast radius. `aih workspace`
bridges that gap from the **parent folder** that holds the repos:

```bash
aih workspace ./my-org --apply     # auto-detects child repos (*/.git); or --repos ui,backend
```

It writes, at the parent (it does **not** touch the child repos — run `aih init` in each):

- `<context-dir>/cross-repo-architecture.md` — per-repo responsibilities + a **cross-repo feature map**
  (UI column · backend column · the contract). **Write-once** — aih seeds it from your repo list, then
  you own it; re-running never overwrites it.
- `<context-dir>/repo-discipline.md` — load a repo's own canon before editing it.
- `CLAUDE.md` + `AGENTS.md` — thin workspace bootloaders pointing at the cross-repo canon.
- `<name>.code-workspace` — opens every repo in one VS Code window.
- `.mcp.json` — a filesystem MCP **spanning every child repo path**, so an agent at the workspace root
  can read across repos.
- `.aih-workspace.json` — marker that puts `aih doctor` into **workspace mode** (validates each child
  repo is scaffolded).

### Examples

```bash
aih doctor --json                 # what's configured? (read-only)
aih init . --apply                # bootstrap the current repo
aih certs --ca-pattern Zscaler --apply --verify
aih hardware                      # preview the tuned inference env block
AIH_CONTEXT_DIR=ai-coding aih scaffold --apply
```

## Development

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run lint      # biome
npm run build     # tsup → dist/
```

Stack: TypeScript (ESM) · commander · zod · vitest · biome · tsup. See
[`.github/AGENT_TASKS.md`](.github/AGENT_TASKS.md) for architecture, the
contributor/agent workflow, and delegatable tasks.

## License

[Apache-2.0](LICENSE).
