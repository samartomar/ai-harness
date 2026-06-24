# aih — Enterprise AI Bootstrapping Harness

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
| `aih profile` | Recursively detect the repo's stack and synthesize a thin `CLAUDE.md` + Cursor rules. |
| `aih ecc` | Install [affaan-m/ECC](https://github.com/affaan-m/ECC) (skills, instincts, memory, security, research-first) for the selected CLIs, scoped to the detected stack: Claude plugin path, `ecc-install` for codex/cursor/zed/opencode, `consult` advisor otherwise. |
| `aih superpowers` | Install [obra/Superpowers](https://github.com/obra/Superpowers) (brainstorm → plan → TDD → subagent-review skills) for the selected CLIs. |
| `aih scaffold` | Create the canonical context dir (`--context-dir`, default `.ai-context`) + thin IDE adapters (one per selected CLI) + INDEX/SKILL skeleton. |
| `aih guardrails` | Generate `.gitleaks.toml`, `.pre-commit-config.yaml`, and a CI license gate that blocks AGPL/strong-copyleft. |
| `aih secrets` | Scan for plaintext `.env*`/`secrets/` and write agent deny rules + vault-injection guidance. |
| `aih mcp` | Generate `.mcp.json` (local/project/remote scopes) and document the SSO MCP gateway. |
| `aih sandbox` | Generate a devcontainer + managed sandbox settings (egress allowlist, `failIfUnavailable`). |
| `aih telemetry` | Inject OpenTelemetry env, a redacting Bindplane collector, and an analytics fetcher. |
| `aih crispy` | Run the CRISPY context-engineering stage machine (deterministic, gate-ordered). |
| `aih bootstrap` | Orchestrate the workstation 4-phase rollout (certs → hardware/vdi → telemetry). |
| `aih init` | Initialize a repo: profile + ecc + superpowers + scaffold + secrets + guardrails + mcp + sandbox in one pass. |
| `aih doctor` | Fail-closed verification of the workstation/repo configuration. |
| `aih status` | Read-only inventory of what the harness has configured. |

Global flags: `--apply`, `--verify`, `--json`, `--context-dir <dir>`, `--root <dir>`, `--cli <list>`, `--all-tools`.
Settings also read from `AIH_*` env vars (`AIH_APPLY`, `AIH_CONTEXT_DIR`, …).

### Targeting CLIs

`aih ecc`, `aih superpowers`, and `aih scaffold` only touch the agent CLIs you actually use.
Pass `--cli` with a comma-separated list, or `--all-tools` for every supported CLI; the default
is `claude`. Supported: `claude, codex, cursor, antigravity, gemini, copilot, windsurf, opencode, zed, kimi`.

```bash
aih ecc --cli claude,codex          # ECC for Claude (plugin) + Codex (ecc-install)
aih superpowers --cli antigravity   # agy plugin install … (runs under --apply)
aih init . --all-tools              # bootstrap a repo for every CLI at once
```

Shell-runnable installs (`ecc-install`, `agy`/`copilot plugin install`) execute under `--apply`;
in-tool slash-command installs (Claude/Codex/Kimi plugins) are emitted as exact commands to run
inside the tool. ECC and Superpowers are complementary — ECC supplies stack-aware rules, agents,
and memory; Superpowers supplies the disciplined agent loop that uses them.

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
