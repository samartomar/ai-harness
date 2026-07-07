---
status: guide
owner: AI-Harness maintainers
last_verified: 2026-07-07
truth_home: true
purpose: Persona guide for teams using AI-Harness across shared repositories.
---

# Team Guide to AI-Harness

Use this guide for a shared repo, small platform team, or engineering group that wants repeatable AI-assisted development without a central admin service. For posture mechanics, read [Postures](postures.md). For the full command map, use [Command Use Cases](command-use-cases.md).

## 1. Executive Summary / Mental Model

For a team, AI-Harness is a committed repo discipline. The goal is not only to help one developer start faster; it is to make supported tools read the same repo canon, route approved skills through the same governance loop, and keep important setup decisions in reviewable files instead of chat transcripts.

The `team` posture keeps the local-first model but raises the bar for shared state. Team intent belongs in committed files: `ai-coding/`, bootloaders, `.aih-config.json`, `aih-capabilities.json`, skill approvals, pack manifests, policy files, sidecar pointers when used, and decision docs. Local caches and reports help diagnosis; they are not team truth.

## 2. Quickstart / Implementation Blueprint

Create the repo canon on a branch:

```console
aih init . --posture team
aih init . --posture team --apply
aih bootstrap-ai --all-tools --apply
aih bootstrap-ai --verify
```

Add shared safety and capability gates:

```console
aih secrets --verify
aih guardrails --apply
aih capability resolve --apply
aih doctor --posture team
aih docs-lint
```

Govern skills through approvals and packs:

```console
aih skill vet <skill-source> --apply
aih skill approve <skill-source> --owner <team-or-owner> --pack <pack-name> --apply
aih pack status --pack <pack-name>
aih pack validate --pack <pack-name>
aih pack install --pack <pack-name> --apply
aih skill inventory
```

For the first-party docs-quality pack in a repo that has not yet seeded it:

```console
aih pack scaffold --pack docs-quality --apply
aih skill vet packs/docs-quality/betterdoc --apply
aih skill approve packs/docs-quality/betterdoc --owner <team-or-owner> --pack docs-quality --apply
aih pack install --pack docs-quality --apply
aih pack validate --pack docs-quality
```

Wire validation into CI:

```console
aih bootstrap-ai --verify
aih secrets --verify
aih pack validate
aih docs-lint
aih doctor --posture team
```

Use a truth sidecar only when the team wants external staged truth packs and the repo already has a real commit:

```console
aih init . --sidecar --posture team --apply
aih truth verify
aih truth pack --apply
```

### Common Use Cases

| Situation | Command path | Why |
|---|---|---|
| A repo already has AI docs | `aih adopt` | Plans a brownfield convergence without overwriting existing work. |
| The team added or dropped an AI tool | `aih bootstrap-ai --cli <full-intended-list> --apply`, then `aih bootstrap-ai --verify` | Regenerates tool entry points and records the intended CLI targets in `.aih-config.json`; use [CLI Lifecycle](cli-lifecycle-guide.md) for add/switch/prune flows. |
| A CLI is no longer targeted | Re-target first with `aih bootstrap-ai --cli <full-intended-list> --apply`, then `aih prune`, then `aih prune --apply` after review | Removes stale generated artifacts anchored to committed intent. |
| Capability decisions should be shared | `aih capability resolve --apply` | Writes committed capability intent while keeping machine cache rebuildable. |
| A shared skill set should be installed | `aih pack plan --pack <pack>`, then `aih pack install --pack <pack> --apply` | Installs a curated set instead of one-off skills. |
| Skill state looks inconsistent | `aih skill inventory`, `aih pack status --pack <pack>`, then `aih pack validate` | Shows approved/unapproved/stale/quarantined state and pack gate findings. |
| Approved skills should be available to machines | `aih skill sync --name <skill> --cli <list> --apply` | Copies an approved promoted skill into supported CLI machine discovery roots. |
| Public docs changed | `aih docs-lint` | Runs BetterDoc prose guidance and the hard claim-ledger gate. |
| Truth assertions may have drifted | `aih truth verify` | Rechecks sidecar commit/version/claim/decision assertions and agent-evidence file probes. |
| Context footprint is getting large | `aih report --gate --token-budget <n>` | Turns report analysis into a CI/review gate. |
| Multiple repos need one workspace view | `aih workspace <parent> --repos <a,b> --apply` | Creates parent-level cross-repo context without editing child repos. |
| A workspace child should be added later | `aih workspace link <path> --apply` | Registers a child and optional contract edge in parent-owned files. |
| Child reports should be refreshed | `aih workspace report --refresh-children --apply` | Uses the explicit child-write opt-in before rebuilding the parent rollup. |

## 3. Best Practices & Architecture

Keep one repo canon and route supported tools through it. `CLAUDE.md`, `AGENTS.md`, Cursor rules, Kiro steering, and other bootloaders should point to the same generated router instead of carrying separate policies.

Treat capabilities as intent, not installed content. `aih-capabilities.json` can be shared; `$HOME/.aih/capabilities/cache.json` is derived and can be pruned or rebuilt.

Treat skills as supply-chain inputs. The lifecycle is vet, approve, inventory, pack, install, validate, and optionally sync to machine roots. `aih-skills.lock.json` is the approval authority; `aih-packs.json` curates sets from that authority.

Use packs for team adoption. A developer should install "the docs-quality pack" or another named pack, not manually assemble a different skill set on each machine.

Use `docs-lint` as a public-claim gate, not only a prose cleaner. In v2.4.0, claim markers must resolve to control-matrix rows and named tests; prose guidance remains advisory.

Use truth sidecars for staged project-truth work only when the team wants that workflow. The sidecar is external by default and commit-bound; promotion back into repo-owned docs remains an explicit reviewed change.

Keep shared policy in committed files. If the same warning appears repeatedly, turn it into a committed rule, a decision record, a pack entry, or a backlog item.

Use reports for diagnosis, not hidden management. `aih report` and `aih report --v9` help identify context footprint, adoption, local usage, cache panels, and setup issues. Treat generated reports as local artifacts unless the repo explicitly tracks them.

Keep shared runbooks portable. Routine release, issue, PR, milestone, and commit checks should work with `git`, npm registry commands, browser URLs, or approved HTTP clients. GitHub CLI (`gh`) is useful for teammates who have it, especially for authenticated GitHub reads and PR/release workflows, but it should be documented as a convenience path beside the portable check.

## 4. Pitfalls to Avoid

- Do not leave team decisions only in chat, `.aih/`, `~/.aih/`, or local machine caches.
- Do not let a same-named skill from another source inherit approval. Approval is source-bound.
- Do not treat `pack scaffold` as approval. It copies bundled first-party bytes; the repo still needs vet/approve evidence before install.
- Do not bypass dirty-worktree protection with `--force` unless the team has reviewed the exact conflict.
- Do not hand-maintain multiple bootloader policies. Regenerate shared blocks with `aih bootstrap-ai`.
- Write team docs so Windows, Linux, and macOS users can run the baseline path. Add shell-specific or `gh` shortcuts only after the baseline is clear.
- Do not treat missing optional scanners as a clean security result. Record degraded coverage honestly.
- Do not treat `docs-lint`, reports, or truth packs as formal compliance evidence.
- Do not file public issues, milestones, or releases from non-public planning without explicit approval.
