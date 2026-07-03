# Tracking & done

> Load when: wrapping up a unit of work or opening a PR.

Keep the public repo self-tracking so milestones update themselves instead of by
hand: progress is *derived* from issues closing, not something to maintain
manually.

## Keep git tracked

- **Every non-trivial change maps to a GitHub issue.** If none exists, draft one
  (title, the Problem → Fix → Acceptance body, and a suggested milestone) and open
  it only on the owner's go — never file autonomously, but never leave the work
  untracked either. Flag it in the same breath as the change.
- **The PR body names what it resolves** — `Closes #N` (or `Refs #N` when the work
  is partial). Merging then auto-closes the issue and moves its milestone's
  progress on its own.
- **Milestone: read the active one and propose it** (from the roadmap / open
  milestones) for the owner to confirm — don't guess or auto-assign when several
  are open.
- **Close an issue only with evidence** — a command + its output, or the merged
  PR. Never a silent close.

## Docs are part of the change (hard done-criterion)

A change is not done — not reportable as done, not ready to merge — while a doc it
touched is stale. Before claiming done, check each and update in the *same* PR:

- Alters a documented command, flag, behavior, or public surface → update that doc.
- User-facing change → an `[Unreleased]` CHANGELOG entry.
- Command or flag change → `docs/commands.md` **and** a regenerated
  command-surface fixture.
- Generated or byte-locked docs change via their renderer, never by hand.

If a doc genuinely needs no change, say so; silence is not the same as checked.
