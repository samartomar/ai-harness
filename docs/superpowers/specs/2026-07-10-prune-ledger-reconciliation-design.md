# Scoped ECC Prune Reconciliation Design

**Status:** Approved for implementation on 2026-07-10

**Issue:** #409

## Goal

Make `aih prune` the fail-closed inverse of scoped ECC registration. A prune run
removes registrations for projects whose canonical roots no longer exist,
recomputes the live machine union, removes only orphaned aih-managed ECC
artifacts, reconciles target install state, and commits the registration ledger
last.

## Non-goals

- Do not uninstall a whole CLI target and reinstall it.
- Do not infer ownership from filenames, directories, or current stack scans.
- Do not add components a target has never installed.
- Do not mutate the real dev-seat HOME in tests or validation.
- Do not change existing per-CLI stale-artifact prune semantics.
- Do not implement policy for unsupported or guidance-only ECC targets.

## Chosen approach

Use a differential between the primary registration ledger and ECC's recorded
per-target install states.

The alternatives are rejected:

1. Whole-target uninstall followed by reinstall has excessive blast radius,
   creates a destructive intermediate state, and can restore or overwrite shared
   configuration unrelated to the orphaned component.
2. Ledger-only reconciliation leaves derived ECC files and managed MCP/agent
   surfaces installed after their final contributor disappears.

The differential approach uses the same component-to-operation selector as G1.
An operation remains installed when the recomputed live selection still chooses
it. An operation is removable only when a valid ECC install state records it as
managed and no desired operation shares its destination.

## Reconciliation model

### Live projects

The planner reads `~/.aih/ecc/registration-ledger.json` with the strict v1 parser.
For every registered canonical root:

- an existing, non-symlink directory is live;
- `ENOENT` is retired;
- a symlink, non-directory, permission failure, or other filesystem error is a
  fail-closed configuration error.

The reconciled project set contains only live records and retains their exact
scope, component, and MCP contributions. The desired machine union is computed
from that set.

If any live project has `scope: full`, existing installed target components and
operations are retained because the full-surface sentinel is intentionally
unbounded. If no live project remains, the desired union is empty. Common
components survive whenever at least one live project contributes them; they are
not an immortal machine baseline after the final project is retired.

### Target records

Reconciliation never adds target content. Each ledger target retains only its
previously installed component records and MCP IDs that are still in the desired
machine union. Authorization receipts remain byte-for-byte unchanged for retained
components. Empty target records remain valid evidence that the target was
reconciled to an empty scoped surface.

### Install-state discovery

Only existing, strictly parsed ECC install states are candidates. Known G1 target
locations are closed and deterministic:

| Target | Scope | Install state |
|---|---|---|
| Claude | home | `~/.claude/ecc/install-state.json` |
| Codex | home | `~/.codex/ecc-install-state.json` plus aih merge state `~/.codex/ecc-aih-install-state.json` |
| OpenCode | home | `~/.opencode/ecc-install-state.json` |
| Cursor | each live project | `<root>/.cursor/ecc-install-state.json` |
| Antigravity | each live project | `<root>/.agent/ecc-install-state.json` |
| Gemini | each live project | `<root>/.gemini/ecc-install-state.json` |
| Zed | each live project | `<root>/.zed/ecc-install-state.json` |

Absent state is a no-op. Malformed state, target/root/path mismatch, duplicate
destinations, unsupported operation kinds, or an operation outside the recorded
target root aborts the entire reconciliation before mutation. Project-local state
under a retired root needs no separate cleanup because that root is already gone.

## Operation ownership and removal

The G1 materialization selector becomes a shared predicate. For a scoped desired
selection it retains:

- all operations in selected whole modules;
- only selected agent leaves and their approved scaffolding;
- only selected skill leaves, including `aih-scoped-skills` Codex operations.

For every operation no longer selected:

- `ownership` must equal `managed`;
- the destination must be contained by the install state's canonical target root;
- no destination parent or destination may be a symlink;
- a `copy-file` destination may be removed only when it is a regular file;
- `merge-json` removes only the recorded managed JSON subset and preserves all
  unrelated keys; malformed or drifted non-object JSON fails closed;
- any unsupported kind fails before mutation.

Retained operations are written back to the install state with the original
`installedAt`, request/source metadata, and operation records. Empty directories
created solely for removed files may be cleaned only up to, but never including,
the recorded target root.

Codex's aih-managed MCP block and ECC AGENTS block are regenerated from the
retained scoped target record, while its separate aih merge state is reduced to
the retained managed MCP footprint. Content outside explicit markers is preserved.
If the marker is malformed or missing while state claims a managed surface, prune
fails closed rather than guessing. Project `.mcp.json` files remain governed by
their existing project-local ownership rules; retired roots are absent and live
projects are not rewritten from another project's registration.

## Apply transaction and failure behavior

Dry-run performs all reads, validation, selection, and diff computation but makes
no filesystem changes. Its digest lists retired roots, orphan component/MCP IDs,
affected targets, state paths, and managed destinations in stable sorted order.

Apply executes one local Node driver so component files, managed blocks, target
states, and the registration ledger share one failure boundary. The driver:

1. re-reads the ledger and each planned install state and verifies their SHA-256
   preflight hashes to reject plan/apply races;
2. validates every path and computes every next byte sequence before mutation;
3. creates exclusive sibling backups for every changed or removed file;
4. applies orphan removals and managed-surface rewrites;
5. atomically replaces each reconciled target install state;
6. atomically replaces the registration ledger last;
7. removes transaction backups only after the ledger commit succeeds.

Any failure before step 6 restores every changed/removed file and target state.
If the final ledger replace fails, rollback restores component files and target
states, leaving the old ledger authoritative. Transient Windows
`EBUSY`/`EPERM`/`EACCES` rename failures use the repository's bounded retry policy.

## Integration with existing prune

Ledger reconciliation is independent of `.aih-config.json` and per-CLI target
staleness. A bare `aih prune` always checks for the primary ECC ledger even when
the existing stale-artifact set is empty. Existing `--delete`, `--unrunnable`,
ignored selection flags, dirty-worktree protection, advisory behavior, and dropped
CLI whole-target uninstall actions are unchanged.

When existing prune drops an entire ECC target, its current whole-target cleanup
remains authoritative for that target; component reconciliation excludes that
target in the same plan to avoid double mutation.

## Test design

Tests use disposable HOME/project roots and real serialized state fixtures.

- Pure reconciliation: React + C++ then missing C++ drops only C++; shared
  components remain until the last live contributor; full scope prevents shrink;
  zero live projects yields an empty union; malformed ledger and unsafe roots fail.
- Operation selection: whole modules, leaf skills/agents, Codex scoped skills,
  shared destinations, and empty selection.
- Dry-run: deterministic digest and no byte changes.
- Apply: orphan managed files removed, retained/common files preserved, JSON subset
  removal preserves user keys, target state shrinks, ledger commits last.
- Failure: malformed state, unsafe/symlink paths, drift, injected partial removal,
  injected state write, and injected ledger rename all roll back completely.
- Retry/idempotency: a transient rename succeeds; a second apply performs no writes
  and produces byte-identical states and ledger.
- Regression: the full existing prune and ECC suites remain green on Linux,
  Windows, and macOS; `npm run verify` is the merge gate.

## Documentation and release contract

Update `[Unreleased]`, command help, architecture, stability, security/control
documentation, and command contract fixtures. Public docs must state that component
prune is implemented only after this slice lands and must not imply publication.
The PR carries `semver:minor`, `contract:additive`, milestone #32, and closes #409.
