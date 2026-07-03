# Claude Code adapter

Claude Code-specific files are bootloaders and local wiring only — not the
source of repo truth.

## Entry points

- root `CLAUDE.md`
- `ai-coding/RULE_ROUTER.md` — layered model, detected stack, task routing
- `ai-coding/project.md` — the repo contract (stack, commands, scale, gaps)

## How it loads rules

- Claude auto-loads `CLAUDE.md`; read the router from there before non-trivial work.

## Boundaries

Claude Code may propose, implement when assigned, and review — boundaries in `ai-coding/RULE_ROUTER.md` § External action boundary (push / PR / merge need explicit human approval).

## Baseline layer

ECC + Superpowers install the generic baseline at `~/.claude/` (rules, skills, agents, commands); repo canon
under `ai-coding/` overrides it on conflict (see `RULE_ROUTER.md` § Layered model).
