# ai-harness — AI Rule Router

Committed rule entry point for every AI coding tool in this repo. Load the
smallest rule set that matches the task, then verify against repo evidence
(source, tests, schemas, CI) before acting. Do not load everything blindly.

## Layered model (baseline + repo)

- **Layer 1 — user baseline (generic):** ECC (affaan-m/ECC) + Superpowers
  (obra/Superpowers), installed per CLI by `aih ecc` / `aih superpowers` —
  generic agents, skills, memory, security, and the brainstorm→plan→TDD→review loop.
- **Layer 2 — this repo's contract (specific):** this router, the contract
  (`ai-coding/project.json` + `ai-coding/project.md` + `ai-coding/setup.md`), the working
  discipline in `ai-coding/rules/`, the bootloaders (`CLAUDE.md`, `AGENTS.md`),
  and the per-tool notes in `ai-coding/adapters/`.

**Precedence: Layer 2 wins.** Repo canon overrides the generic baseline on conflict.

## Detected stack

- Languages: TypeScript/Node.js
- Commands: verify `npm run verify` · typecheck `npm run typecheck` · test `npm test` · build `npm run build` · lint `npm run lint`

## Always read first

- `ai-coding/rules/agent-behavior-core.md` — working discipline (think → simplify → surgical → goal-driven)
- `ai-coding/rules/project-canon-extension.md` — repo-specific rules, as a load-on-demand map; read a rule file only when your task hits its trigger
- `ai-coding/project.md` — the repo contract: stack, commands, scale, sensitive paths, known gaps (machine-readable in `ai-coding/project.json`)
- The ECC `common` rules (Layer 1) before any non-trivial change

Read depth: for read-only validation you may identify these files and confirm
routing without opening each. For implementation, review, or security work, read
the core + `ai-coding/project.md` first, then load only the task slice below.

## Task routing

### Implementation
Load `ai-coding/project.md` for the commands, scale, and constraints; follow the ECC
stack rules for TypeScript/Node.js. State the goal and the smallest viable change first.
Honor the Invariants in `ai-coding/rules/agent-behavior-core.md` (large-repo graph safety,
boundaries) before broad work.

### Code review / PR
Load `ai-coding/project.md`; review the diff, tests, and schemas against repo
evidence. Before a PR is marked ready or merged, run and record the required
review skills/agents: code review, security review, and any domain-specific
reviewer for the touched area. Comment only unless explicitly asked to fix.

### Testing
Run `npm run verify` as the pre-completion gate; use `npm test` for narrower TDD loops. New behavior needs a test; fix the implementation, not the test.

### Security / secrets
Follow the Invariants in `ai-coding/rules/agent-behavior-core.md` (secrets, input validation,
cloud-setup safety). Run `aih secrets` / `aih guardrails` for the tooling.

### External AI tooling / adapters
Load `ai-coding/adapters/<your-tool>.md` for tool-specific wiring (entry files,
how it loads rules, boundaries).

## Tooling failure recovery

If a tool, MCP server, graph, or memory store fails, state the failure briefly,
fall back to committed repo evidence, and never invent results. Don't cite a
command, path, or API you haven't verified exists. Regenerate this canon with
`aih bootstrap-ai` (router + bootloaders) and `aih contract` (project.json /
project.md) — idempotent; `aih bootstrap-ai --verify` fails if a bootloader drifted.
