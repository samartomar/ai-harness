---
name: test-driven-repro-workflow
description: Workflow command scaffold for test-driven-repro-workflow in ai-harness.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /test-driven-repro-workflow

Use this workflow when working on **test-driven-repro-workflow** in `ai-harness`.

## Goal

Adds new test cases to reproduce or validate workspace-related issues or edge cases.

## Common Files

- `tests/workspace/*.test.ts`
- `tests/report/*.test.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit or add one or more test files in tests/workspace/ or tests/report/ to cover a new scenario or bug.
- No changes to src/ files in this commit.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.