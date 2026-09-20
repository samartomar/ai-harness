# Policy Workbench UI delivery

> Load when: planning or doing any Policy Workbench UI work, or touching
> `workbench-ui/`, `src/org-policy/workbench/`, `src/org-policy/ui-server.ts`,
> `prototype/policy-workbench/`, or the Workbench tests.

One approved delivery contract, one shared progress record, automated boundary
checks. Every session and every subagent starts from the same records.

## Where the records live

- The approved decision, the ordered remaining outcomes with their completion
  checks, and the current focus live in the private companion repo, in its
  `policy-workbench-ui` feature and the matching entry under its active
  priorities. Resolve the companion the way
  `ai-coding/curated-skills/decision-partner/SKILL.md` describes, and follow
  its entry file before reading or writing there.
- If the companion is unavailable, stop and ask. Do not proceed from scratch
  notes, assistant memory, or the documents under `prototype/policy-workbench/`.
  Those record earlier approaches to this page. They are not the delivery
  contract.
- This file is the public-safe engineering half. When a record and the source
  disagree, the source wins and the record is the defect.
- The output files, the byte rules, the journeys, the failure cases, and the
  byte anchors are in `rules/workbench-ui-acceptance.md`.

## Startup protocol

1. Read the approved decision, the active outcome, and the current focus.
2. Inspect the actual branch, the working changes, and the relevant source.
3. State which outcome the session advances and which files it owns.
4. Continue within that scope. A different framework, delivery model, or
   validation strategy needs an explicit decision change by the owner.

## Long runs

A session runs outcome after outcome without waiting for the owner. After each
outcome it updates the progress record and commits, so the next session can
continue from the record alone. It stops only for:

- a contract change, or a dependency outside the allow-list;
- a change to a policy schema, policy semantics, or response headers;
- any push, pull request, or publication;
- a failed stop rule;
- a budget the owner stated for the run.

Owner acceptance is collected at the checkpoints the delivery record names. It
never blocks the next outcome. While a checkpoint waits, independent work
continues. The lead may reorder outcomes when the contract itself is unchanged.

## The contract, engineering half

- **Stack:** React and TypeScript components, a Vite build, Tailwind with the
  prototype's own configuration and embedded fonts, one family of accessible
  primitives.
- **Engine:** authoritative validation, selection, compilation, import, and
  file format. No Node, DOM, or host imports. Pure dependencies are allowed.
- **UI:** components, draft state, presentation. It lives in `workbench-ui/`
  and imports only the engine entry.
- **Hosts:** input acquisition, exact-byte hashing of imported policies, local
  verification, optional services, delivery. A host capability describes an
  available operation. It never implies that an imported policy is trusted.
- **CLI consumer:** reads policy files whoever authored them.
- **Delivery:** one component source, two production targets: a static hosted
  site, and one self-contained offline file served by `npx @aihq/core --ui`.
- **Dependency allow-list,** development-only, pinned, bundled into the page:
  `react`, `react-dom`, their type packages, `vite` declared directly,
  `@vitejs/plugin-react`, Testing Library (`react`, `dom`, `user-event`),
  `@radix-ui/react-dialog`. Anything else is a contract change.
- **Connectivity:** editing and download are offline. The only connected
  feature is the explicit GitHub intake on the CLI host's admin page. A host
  that lacks a capability shows a label on the control, never a dead control.
- **User output:** this delivery generates `aih-project-policy.json` only.
- **Rejected edits:** committed policy changes that are rejected roll back.
  Temporary text inside an editor is allowed.
- **Excluded from the first delivery:** a generic schema-driven editor, a state
  library, a public engine package, independent catalog releases, a write-back
  endpoint, fetching newer catalogs, npm workspaces.

## Status words

| Word | Meaning | Evidence |
|---|---|---|
| Implemented | The change is committed | The commit |
| Verified | The named checks ran green on that commit | Command and result line, and the paths the check covers |
| Owner-accepted | The owner said so after trying it | Only the owner sets it |

Work moves on when an outcome is verified. Owner acceptance is recorded at the
named checkpoints and is never claimed by an agent. "Tests passed" is never
reported as owner-accepted.

## Orchestration rules

1. **One accountable lead** owns planning, implementation, integration,
   verification, and completion. The owner never coordinates agents or relays
   their results.
2. **Small, verifiable milestones.** Define the outcome and its completion
   check before coding. Finish one before expanding scope.
3. **Minimal delegation.** Work directly by default. When authorized and
   useful, use one bounded implementation worker and reuse its context.
   Parallelize only independent work with clear file ownership.
4. **Stable review.** Finish implementation and the relevant checks before
   requesting review. Combine code, security, and domain concerns into one
   review. After fixes, recheck the affected areas only.
5. **Reuse valid evidence.** A successful check stays valid while the paths,
   dependencies, and environment it covers are unchanged.
6. **Control coordination cost.** No automatic model switching, duplicate
   investigations, or expanding teams. After each implementation and review
   cycle, report progress and justify further work. Respect the stated time or
   usage budget, and stop and report when it is reached.
7. **Continue autonomously within scope.** Reuse existing authorization. Ask
   only for missing decisions, access, or consequential actions that need
   approval. Keep independent work moving.
8. **Close the loop.** Collect worker results, integrate, verify, and report
   the remaining gaps plainly. Turn recurring mistakes into durable rules or
   automated checks, and replace conflicting guidance.

## Delivery team

The owner fixed and authorized this team. The lead uses it without asking
again, and does not add agents or switch models beyond it.

| Role | Who | How the lead uses it |
|---|---|---|
| Lead: planning, integration, the gates, and acceptance of all worker output | Claude Fable 5.1 | The session itself |
| Large implementation tasks | Claude Opus 5 at low effort | One `workbench-implementer` subagent, continued across an outcome so its context is reused |
| Small mechanical tasks | Kimi CLI | `kimi -p` with one work order. Never run Kimi `/init` in this repo |
| A decision the lead cannot settle from the records, the source, or the tests | Codex CLI at its highest reasoning setting | `codex exec` with one written question that carries the options and the evidence |

- A Codex answer is advice. The lead decides. Anything on the stop list under
  "Long runs" still goes to the owner.
- The lead's acceptance means it integrated the work and the named checks are
  green. Only the owner sets owner-accepted.
- Codex takes its model and effort from its own configuration on the machine.
- If a worker's tool is missing or not signed in, the lead does that work
  itself and says so in its report. A missing tool never stops the run.

Keeping coordination cheap:

- Make a small change directly when a work order would cost more than the
  change.
- One worker is active at a time, unless the file allow-lists do not overlap.
  Workers edit the one checkout. They do not commit, branch, or use extra
  worktrees. The lead reviews the diff and commits.
- A work order names the paths, symbols, and checks, so a worker does not
  explore.
- Per work order, run its verification command and the affected tests only.
  Run the full gate once per outcome, alone: other heavy work on the same
  machine makes load-dependent tests fail.
- Review each result once, after the worker's own check passed. After fixes,
  recheck only what changed.
- Time-box every worker. After two failed attempts, the lead takes the task
  back.

The Opus worker's definition is below. Client configuration is not committed
in this repo, so a Claude lead writes it to the ignored
`.claude/agents/workbench-implementer.md` when that file is missing or differs.
Claude Code loads it from the next session. Until then, the lead starts the
worker as an Opus subagent directly.

```markdown
---
name: workbench-implementer
description: Bounded implementation worker for the Policy Workbench UI delivery. Use for one large implementation work order at a time, under the delegated task contract in ai-coding/rules/workbench-ui-delivery.md.
model: opus
effort: low
---

You implement one work order for the Policy Workbench UI delivery.

- Read `ai-coding/rules/workbench-ui-delivery.md` and
  `ai-coding/rules/workbench-ui-acceptance.md` first.
- Change only the files in the work order's allow-list. Do not explore beyond
  the paths and symbols it names.
- Do not commit, push, create branches or worktrees, add dependencies, or run
  AIH against this checkout.
- Run the work order's verification command and the affected tests before you
  report.
- If the task conflicts with the decision or cannot be done inside the owned
  files, stop and report the conflict. Do not redesign.
- Report what is implemented, what is verified with the command and its result
  line, and what is not verified.
```

## Delegated task contract

Every delegated task carries: the decision reference, its concrete outcome, its
owned files as an allow-list, the constraints and acceptance checks that apply,
one verification command, explicit exclusions, and this sentence: "If the task conflicts with the
decision or cannot be done inside the owned files, stop and report the
conflict. Do not redesign." The worker reports what is implemented, what is
verified with command and result line, and what is not verified. A worker can
recommend a change. Only the owner changes the decision.

## Automated boundary checks

These are requirements. Each is added with the outcome that first needs it, and
joins the routine gate `npm run verify:local -- --base <ref> --head <ref>`.

- Files under `workbench-ui/` import only the engine entry, checked on the real
  bundle and scoped by importer.
- The engine entry bundles for the browser with no Node built-ins,
  transitively, and typechecks without DOM types.
- Every downloaded file is valid against the canonical schema, and the byte
  anchors hold.
- The production offline file passes the exact offline policy with zero
  requests and zero violations. The policy text is in the acceptance rule, J3.
- The page loads from an installed package.
- The admin and user journeys pass on both production hosts.
- Every control has a behavior or artifact assertion.
- The request token survives navigation.
- `package.json` development dependencies for the UI match the allow-list.
- No generated files of the component UI under `workbench-ui/` are committed.
