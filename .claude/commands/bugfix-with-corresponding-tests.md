---
name: bugfix-with-corresponding-tests
description: Workflow command scaffold for bugfix-with-corresponding-tests in ai-harness.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /bugfix-with-corresponding-tests

Use this workflow when working on **bugfix-with-corresponding-tests** in `ai-harness`.

## Goal

Fixes or hardens workspace-related logic and updates or adds corresponding tests to verify the fix.

## Common Files

- `src/workspace/*.ts`
- `src/report/*.ts`
- `tests/workspace/*.test.ts`
- `tests/report/*.test.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit one or more files in src/workspace/ or src/report/ to implement the fix.
- Edit or add one or more files in tests/workspace/ or tests/report/ to add or update tests for the fix.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.