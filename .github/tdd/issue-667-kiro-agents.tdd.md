# Issue 667 — governed Kiro agents TDD evidence

## Source and journeys

Source: [GitHub issue #667](https://github.com/samartomar/ai-harness/issues/667). No separate
implementation plan was used.

- As an operator selecting a mapped ECC agent for `kiro`, I can preview and apply the exact selected
  `.kiro/agents/<name>.md` IDE representation and curated `.kiro/agents/<name>.json` CLI
  configuration under one evidence and receipt lifecycle.
- As an operator with a same-name or case-folded Kiro agent definition, I receive a refusal and no
  operator file is overwritten or deleted.
- As an operator narrowing or uninstalling the selection, only unchanged receipt-owned Kiro agent
  bytes are removed.
- As an operator selecting an ECC agent without an exact pinned Kiro mapping, I receive a named
  refusal without a mapped component being vetoed.

## RED and GREEN report

| Behavior | RED evidence | GREEN evidence | Guarantee |
|---|---|---|---|
| Mapped agent projection and lifecycle | Commit `6d0e5ad7`; the initial Kiro-focused run failed because agents were still `unsupported-component`. After review exposed the missing IDE representation, the focused acceptance run failed with only the JSON destination present. | The final focused run covers the adapter, target resolver, receipt, planner, command lifecycle, and acceptance journey. | Exact Markdown and JSON mappings are projected together; reapply is deterministic, collisions refuse without mutation, and uninstall preserves unrelated files. |
| Unmapped agent behavior | Commit `5ede1200`; `npm test -- --run tests/ecc/materialization-target-kiro.test.ts tests/ecc/materialization-target.test.ts -t "rejects missing or partially representable\|refuses an unmapped agent"` — 2 intended failures because the missing mapping aborted the whole Kiro adapter. | The same command — 2 files passed, 2 tests passed. | An unmapped Kiro agent is refused by name while a mapped agent in the same request still materializes. |

## Test specification

| # | What is guaranteed | Test |
|---|---|---|
| 1 | Selected Markdown and curated JSON bytes are bound to their selected-component and `runtime:ecc-kiro` evidence. | `tests/ecc/materialization-target-kiro.test.ts` — `projects the exact IDE Markdown and CLI JSON agent mappings under one Kiro target` |
| 2 | Wrong identity, non-empty MCP/hooks, inherited MCP, and invalid JSON refuse. | `tests/ecc/materialization-target-kiro.test.ts` — `refuses Kiro agents whose curated JSON identity or excluded runtime fields are unsafe` |
| 3 | An agent-only Kiro selection requires current runtime evidence. | `tests/ecc/materialization-target.test.ts` — `requires current runtime evidence for an agent-only Kiro selection` |
| 4 | Missing exact mappings are named refusals and do not veto mapped agents. | `tests/ecc/materialization-target.test.ts` — `refuses an unmapped agent by name without vetoing a mapped Kiro agent` |
| 5 | Pre-existing same-name and case-folded operator definitions refuse without mutation. | `tests/ecc/governed-lifecycle-command.test.ts` — collision tests under the Kiro lifecycle suite |
| 6 | Preview, apply, reapply, receipt ownership, and uninstall cover both variants. | `tests/ecc/acceptance-governed-lifecycle.test.ts` — `Kiro IDE and CLI variants share one governed target` |

## Completion gate

`npm run verify` passed on 2026-08-13:

- 389 test files passed; 4 skipped.
- 6,381 tests passed; 29 skipped.
- Coverage: 90.55% statements, 82.38% branches, 95.78% functions, 92.84% lines.
- Artifact, self-hosting, upstream pin, analyzer, installability, runtime inventory, docs, typecheck,
  lint, build, published binary, and published library checks passed.

The pinned ECC source at `623f2c020f052319657674e4e6c29ab5d0ad566b` contains 33 Kiro JSON
agent mappings; a read-only audit confirmed all 33 identify their filename and have no non-empty MCP
or hook configuration or enabled MCP inheritance. Other pinned ECC agents remain named Kiro
refusals. Current Kiro documentation records JSON and Markdown workspace agents as available to IDE
1.x and CLI 3.x. This change projects only the exact Markdown and JSON source mappings and makes no
live-host probe claim.

## Merge evidence

- RED checkpoint: `6d0e5ad7` (`test: add issue 667 Kiro agent acceptance`).
- RED checkpoint: `5ede1200` (`test: require named Kiro agent mapping refusals`).
- The GREEN implementation commit follows these checkpoints; this report preserves the evidence if
  the PR is squash-merged.
