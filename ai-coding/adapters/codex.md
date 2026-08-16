# Codex CLI adapter

- Entry: root `AGENTS.md` (+ `.codex/` local wiring)
- Rule loading: Codex leans on `AGENTS.md` more than file-based rule packs, so the bootloader carries the hard guards inline and links the router one hop away.
- Baseline: `~/.codex/` (agents, skills — thinner than Claude)
- Repo canon and contract: `ai-coding/RULE_ROUTER.md`; boundaries: § External action boundary (repo rules override the baseline).
- Bootstrap: `npm run repo:init` installs or refreshes ECC through the native Codex plugin lifecycle.
  It generates the ignored project-local `.codex/config.toml` projection.
  `npm run repo:doctor` proves exact pins,
  allowlists, indexes, plugin state, and live MCP handshakes.
- Precedence: ECC supplies the reusable baseline; this repository's
  `ai-coding/` canon and tool-routing contract override it when they conflict.
- Self-hosting: Never run AIH against this checkout. Maintain repo canon manually
  under `ai-coding/SELF-HOSTING.md`; product CLI tests use temporary roots.
