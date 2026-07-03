# Codex CLI adapter

Codex CLI-specific files are bootloaders and local wiring only — not the
source of repo truth.

## Entry points

- root `AGENTS.md` (+ `.codex/` local wiring)
- `ai-coding/RULE_ROUTER.md` — layered model, detected stack, task routing
- `ai-coding/project.md` — the repo contract (stack, commands, scale, gaps)

## How it loads rules

- Codex leans on `AGENTS.md` more than file-based rule packs, so the bootloader carries the hard guards inline and links the router one hop away.

## Boundaries

Codex CLI may propose, implement when assigned, and review — boundaries in `ai-coding/RULE_ROUTER.md` § External action boundary (push / PR / merge need explicit human approval).

## Baseline layer

ECC + Superpowers install the generic baseline at `~/.codex/` (agents, skills — thinner than Claude); repo canon
under `ai-coding/` overrides it on conflict (see `RULE_ROUTER.md` § Layered model).
