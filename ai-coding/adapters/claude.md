# Claude Code adapter

- Entry: root `CLAUDE.md`
- Rule loading: Claude auto-loads `CLAUDE.md`; read the router from there before non-trivial work.
- Baseline: `~/.claude/` (rules, skills, agents, commands)
- Repo canon and contract: `ai-coding/RULE_ROUTER.md`; boundaries: § External action boundary (repo rules override the baseline).
- Self-hosting: Never run AIH against this checkout. Maintain repo canon manually
  under `ai-coding/SELF-HOSTING.md`; product CLI tests use temporary roots.
