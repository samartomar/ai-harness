# Agent behavior core

Canonical working discipline for every AI tool in this repo — the rulebook `ai-coding/RULE_ROUTER.md` and the bootloaders route to. Read it before any non-trivial change.

## 1. Think before coding

Don't assume; don't hide confusion; surface tradeoffs.

- State assumptions explicitly. If uncertain, ask — or, in an autonomous run,
  record the assumption and proceed with the most defensible reading.
- If multiple interpretations exist, name them; don't pick one silently.
- If a simpler approach exists, say so. Push back when warranted.

## 2. Simplicity first

The minimum code that solves the problem; nothing speculative.

- No features beyond what was asked.
- No configurability or error handling for cases that cannot occur.
- If 200 lines could be 50, rewrite it.

## 3. Surgical changes

Touch only what the task requires; clean up only your own mess.

- Don't reformat, rename, or "improve" adjacent code that isn't broken.
- Match the nearest peer file's style even if you'd do it differently.
- Remove only the orphans YOUR change created; flag unrelated dead code, don't delete it.
- Every changed line should trace directly to the request.

## 4. Goal-driven execution

Define success criteria, then loop until verified.

- "Add validation" → write tests for invalid input, then make them pass.
- "Fix the bug" → write a failing test that reproduces it, then make it pass.
- For multi-step work, state a short plan with a verify step for each step.

## Invariants (always hold)

- Validate at boundaries; reject malformed/hostile input — never coerce. Fail closed on ambiguity.
- Explicit error handling; no silent failures.
- No secrets in code, prompts, fixtures, logs, or error text.
- Do not open `.env*` or `secrets/**`; validate secret presence with `aih secrets --verify`.
- On large repos, code-review-graph is a hard prerequisite for repository work. If it is unavailable, errors, or has no populated graph, stop; repair it and verify a populated graph before continuing.
- Repo evidence (source, tests, schemas, CI) is the truth, not model memory. Don't
  invent commands, paths, or APIs; verify a path exists before citing it.

## Tool selection

Use the canonical tool this repo names; don't load MCP servers just-in-case; when two
tools look alike, pick the one the canon names — and here the canon names the graph pair:

- **code-review-graph** — change-time reasoning: impact radius, affected flows, review
  context, refactor planning, architecture. Reach for it BEFORE editing (the impact rule above).
- **codebase-memory-mcp** — retrieval + memory: semantic code search, trace a path between
  symbols, structural graph queries, and durable decision memory (ADRs).

They each build their own graph, so don't run the same query against both:
impact / what-breaks -> code-review-graph; find / trace / recall -> codebase-memory-mcp.

## Reporting a change

Claiming done, tests pass, or typecheck clean requires showing the command and its
output — a sanity gate is not a completion gate. If you couldn't run it, say so and name
what's unverified. Then report (1) the impact surface, (2) the validation you ran,
(3) higher-confidence checks run or explicitly skipped, (4) the remaining risk.
