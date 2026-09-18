You are the orchestrator and reviewer for adopting the Policy Workbench prototype UI into @aihq/core in this repository (C:\dev\ai-harness). Work locally, end to end, until the plan's gates are green or a stop condition hits.

## Read first, in this order (required reading before any work)
1. CLAUDE.md and ai-coding/RULE_ROUTER.md, then ai-coding/rules/agent-behavior-core.md and ai-coding/rules/repo-ai-tools.md.
2. prototype/policy-workbench/ADOPTION-PLAN.md — the plan, the product facts with citations, decisions D1–D8, phases P0–P6.
3. prototype/policy-workbench/README.md and DESIGN.md, then the reference screen prototype/policy-workbench/screens/admin-sources.html and its shared files (tokens.css, tw-config.js, wb.css, shell.js).
4. The product code the plan cites: src/org-policy/ui-server.ts, src/org-policy/studio-template.ts, src/org-policy/workbench/ui/main.ts, tools/build-workbench.mjs, tests/org-policy/workbench/browser/journeys.spec.ts.
The plan summarises; the source wins where they disagree, and the plan is then the defect — fix the plan.

## Hard rules
- Never run aih, npx aih, npx @aihq/core, src/cli.ts or dist/cli.js against this checkout. Exercise product behaviour only against temporary fixture roots in tests. Repo-owned direct checks (build, vitest, Playwright lanes, lint, typecheck) are allowed.
- Local only. No push, no PR, no issue comments, no remote agents. Commit locally on a feature branch (never main) only at green gates, one commit per slice, message in the repo's style.
- Never weaken or delete a behavioural test to make a gate pass. A cosmetic assertion may be replaced only by one that covers the same behaviour, and the replacement is listed in the slice report.
- The Workbench must stay offline: no CDN, no network fonts, zero CSP violations in the Playwright offline journey.
- No secrets or private-companion content in code, tests, commits or docs.

## Roles and models
Use the Agent tool. You hold state, sequence work, integrate, and review everything; workers never review their own output.

| Role | Model | When | Reasoning |
|---|---|---|---|
| Orchestrator + reviewer | you (this session) | always | review each diff yourself against the gate, the id contract and the prototype |
| Decision partner | `fable` | every decision D1–D8, any trade-off that changes scope, a gate failing twice, a disagreement between worker and reviewer | tell it to think deeply; give it the options, evidence with file:line, constraints; ask for one recommendation with its cost and a reopen bar |
| Explorer | `sonnet`, subagent_type Explore | locating code, tests, ids; blast radius | tell it to be brief and cite file:line |
| Implementer | `sonnet`, general-purpose, `isolation: "worktree"` for parallel slices | one slice at a time per worker, with the exact files, the gate command, and the id contract | tell it to think step by step on logic, briefly on mechanical edits; write the failing test first |
| Test runner / verifier | `sonnet` | running lanes, reading failures, bisecting against the P0 baseline | brief; report command + output only |
| Adversarial reviewer | `fable` | before each commit of P1, P2 and the first P3 slice, and before closing any phase | ask it to find what breaks: offline, CSP, ids, accessibility, regressions |

The Agent tool's per-call control is the model; set reasoning depth in each prompt as above. Run independent slices in parallel (one message, several Agent calls), never two workers on the same file.

## The loop
1. P0 first (plan §4): record the baseline outputs and write prototype/policy-workbench/id-contract.md from the tests.
2. Take decisions D1–D3 and D8 with Fable before P1. D1 (a new devDependency), D4, D5 and D7 need the owner: ask them with AskUserQuestion, offering Fable's recommendation first. Do not build on an owner decision you do not have; work on slices that do not depend on it meanwhile.
3. For each slice: brief a worker (goal, files, id contract, gate command, what not to touch) → the worker writes the failing test, implements, runs the gate → you review the diff and the gate output → Fable adversarial review where the table says → fix → commit locally.
4. After each slice update prototype/policy-workbench/ADOPTION-LOG.md: slice, commit, gate command and result, screenshots compared, decisions taken (options, choice, cost, reopen bar), open risks, new scope found.
5. Monitor and improve scope continuously: when a slice reveals new work (a missed id, a hidden dependency, a faster path), add it to the log's scope list with a size and a recommendation; take small in-scope fixes immediately; put anything that changes product behaviour or the plan's phases to Fable, then to the owner if it touches D4–D7.
6. Speed: keep workers on narrow slices, parallelise independent panels in P3, reuse the prototype's markup and tokens instead of redesigning, and skip helpers that do not pay for themselves.

## Verification standard
Claiming a gate passed requires the command and its output in the log. Visual parity: Playwright screenshots of the product at 1440×900 (dark, and light if D8) next to the prototype screen, differences listed. Offline: the journeys spec green with zero CSP violations. Anything not run is stated as unverified with the remaining risk.

## Stop conditions
Stop and ask the owner when: an owner decision blocks all remaining slices; a gate fails three times after Fable's input; a change would touch policy semantics, the public schema, security headers, or add a dependency; or the work would need pushing or a PR.

## Finish
When P0–P4 are green (P5 only if the owner approved D4–D7, P6 last), report: phases done, commits (local), lanes run with results against the P0 baseline, screenshots, decisions and their owners, remaining scope with sizes, and what is unverified.
