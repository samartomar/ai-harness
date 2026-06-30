# W1 + W2 must-fix — apply on `codex/w2-cdk-verbs` before merge

_From the Wave 1 + Wave 2 review (cumulative branch `codex/w2-cdk-verbs`, stacked off `main` @ `f4088ea`). Three blockers; nothing else on the stack needs to change. After applying, re-run `npm run typecheck && npm run lint && npm test && npm run build`._

> **Stack note (verified):** the cumulative diff is **+1554 over `main`** = only W1+W2. PR #63/#64 (v1/v2) are **already on `main`** (`f4088ea`), NOT riding the stack — an earlier review agent's "#63/#64 not on main" claim used a stale base (`d675500`) and is wrong. No un-merged PRs hide here.

## Verdicts (for context)
| Item | Call |
|---|---|
| W1.2 coverage matrix | GO (sound) |
| W2.1 Rust verbs | GO (clean; held only by sharing the CDK commit range) |
| W1.1 staleness gate | FIX → MF-2 |
| W2.3 workspaces | FIX → MF-3 |
| W2.4 CDK deploy | **BLOCK** → MF-1 |

---

## MF-1 — BLOCK · `cdk deploy` crosses the external-action boundary

`cdk deploy` is remote-mutating; the contract currently nudges the agent to *run it to verify*, contradicting the repo's own `src/guardrails/command-policy.ts:81` (`*deploy*` → ask / "Deployment requires approval"). `cdk synth`/`cdk diff` are read-only — they stay as normal commands; only `deploy` changes.

**`src/contract/synth.ts:164-177`** — remove `"cdkDeploy"` from the "verify it runs" loop (keep `cdkSynth`/`cdkDiff`), then handle deploy separately with approval framing:
```ts
for (const slot of ["test","build","lint","start","cdkSynth","cdkDiff"] as const) {   // drop "cdkDeploy"
  const cmd = commands[slot];
  if (cmd?.confidence === "inferred") {
    gaps.push(`unconfirmed \`${cmd.value}\` (${slot} inferred, not declared) — verify it runs`);
  }
}
if (commands.cdkDeploy) {
  gaps.push(`\`${commands.cdkDeploy.value}\` deploys live infrastructure — requires human approval; do NOT run it to verify (see command-policy \`*deploy*\` ask tier)`);
}
```

**`src/contract/templates.ts:27-42` (`commandsBlock`)** — drop the `["cdk deploy", c.commands.cdkDeploy]` row from the peer list (keep synth/diff). After the commands block, render deploy under its own boundary heading (only when set):
```
### External actions (human approval required)
- `cdk deploy` — remote-mutating; do not run to verify _(inferred)_
```

**Test (`tests/contract/contract.test.ts` ~271-286):** flip it — assert (a) NO `cdk deploy … verify it runs` gap, (b) the approval-framed gap IS present, (c) `cdk synth`/`cdk diff` still render as normal command rows with their inferred gaps.

**Done when:** a CDK fixture renders synth/diff as commands, deploy under "External actions," and `knownGaps` carries the approval caveat — not "verify it runs."

## MF-2 — HIGH · staleness false-positive on `scale.trackedFiles`

`factsSubset` copies the whole `scale` object incl. `trackedFiles` (an exact `git ls-files` count), so adding/removing any unrelated file trips `contract.stale` → team/enterprise `aih doctor` red on noise the contract never asserts.

**`src/contract/staleness.ts:33`** — project only the stable scale fields:
```ts
scale: { class: contract.scale.class, isMonorepo: contract.scale.isMonorepo },   // drop trackedFiles
```
Update the `ContractFactsSubset` type (top of file) so `scale` is `{ class: ScaleClass; isMonorepo: boolean }`, not the full contract scale.

**Test (`tests/contract/contract.test.ts`):** add a regression — same stack, committed `trackedFiles=N`, re-derive via a `gitTrackedRunner` reporting `N+1` → `contract.stale` returns fresh/pass at team posture. Keep a test where a real command/language change still trips stale.

**Done when:** a tracked-file-count delta alone never marks stale; a real fact change still does.

## MF-3 — HIGH · uncapped workspaces map (bloat + perf)

`synthesizeWorkspaces` runs a full sub-`scanRepo` per manifest root and emits one entry each, with no cap — a 50-package monorepo = 50 sub-scans + 50 `project.json` entries + an unbounded `project.md` block. (`entryPoints` is already `.slice(0,8)` at `scan.ts:692`.)

**`src/profile/scan.ts`** — add `const WORKSPACE_CAP = 8;` and cap the loop input at `synthesizeWorkspaces` (`:722`):
```ts
for (const rel of rels.slice(0, WORKSPACE_CAP)) {   // was: for (const rel of rels)
```
Expose the total so the contract can flag truncation: add `workspaceCount?: number` to `RepoStack`, set in `synthesize` to `raw.workspaceRoots.size` when `workspaces` is present.

**`src/contract/synth.ts` (`deriveKnownGaps`)** — thread `workspaceCount` in from the stack and, when it exceeds what's shown, emit:
```ts
if (workspaceCount !== undefined && workspaceCount > shownCount) {
  gaps.push(`showing ${shownCount} of ${workspaceCount} workspaces — others omitted; run per-package commands directly`);
}
```

**Test:** a 10+-package fixture → `Object.keys(contract.workspaces).length <= 8` AND the `showing 8 of N workspaces` gap present; a ≤8-package monorepo → all shown, no gap. Deterministic.

**Done when:** a large monorepo's workspaces map is bounded (≤8) with an honest truncation gap, and only 8 sub-scans run.

---

## Sequencing
Apply MF-1 + MF-2 + MF-3 on `codex/w2-cdk-verbs`, re-run the gates, then merge the tip (lands everything). For incremental history instead: land W1 first (after MF-2; W1.2 already GO), then the W2 stack with each fix on the layer that owns it (MF-3 → polyglot, MF-1 → cdk). **Do not merge until MF-1 lands** — the deploy nudge is the one that bites.
