# ai-harness Implementation Roadmap: Workspace + Skills + Enterprise Packs

> Status: shipped. Every step below has landed on main — the workspace steps
> incrementally, the skill/pack/marketplace steps as the v0.4.0 → v0.6.0 releases
> (confirmed against merged PRs #103–#118). Per-step as-built status:
>
> | Step | Status | Evidence |
> |---|---|---|
> | 1 Workspace bootloader recognition | shipped | parent marker + bootloaders (`src/workspace/`); recognized by `src/report/workspace.ts` |
> | 2 Manifest + report rollup | shipped | `src/workspace/manifest.ts`, `src/report/workspace.ts` |
> | 3 Workspace router | shipped | `src/workspace/templates.ts` → `<contextDir>/workspace-router.md` |
> | 4 Contract edges | shipped (manifest `edges[]` + `workspace-contracts.md`); the `aih workspace link` command was not implemented | `src/workspace/manifest.ts`, `templates.ts` |
> | 5 Snapshots | shipped — `aih workspace snapshot` | `src/workspace/snapshot.ts` → `.aih/workspace-snapshots/` |
> | 6 Task plans | shipped — `aih workspace plan "<task>"` | `src/workspace/task-plan.ts` → `.aih/workspace-plans/` |
> | 7 Skill vet | shipped (v0.4.0) | `src/skill/vet.ts`; GREEN/YELLOW/RED/UNKNOWN in `src/skill/verdict.ts` |
> | 8 Card + approval lockfile | shipped (v0.4.0) — as committed `aih-skills.lock.json` + `<contextDir>/skill-cards/`, not `.aih/approved-skills.lock` | `src/skill/{card,approve,lockfile}.ts` |
> | 9 Pack install | shipped (v0.5.0) — as `aih-packs.json` curation with `--pack <name>`; no built-in pack catalog | `src/pack/` |
> | 10 Internal marketplace | shipped (v0.6.0 slices on main) — build/validate/publish with signed SHA256SUMS | `src/marketplace/` |
>
> The body below is the original design record; the file names it predicted match the
> as-built tree closely, with divergences noted above.

## Goal

Turn `ai-harness` into a governed control plane for:

```text
repo bootstrap
workspace bridge
skill vetting
approved skill packs
report rollups
internal skill marketplace
```

## Step 1 — Workspace bootloader recognition

Keep this step small and focused on workspace parent bootloader/report recognition.

Do not expand it into the full workspace feature.

Expected scope:

```text
workspace parent bootloader recognition
cross-repo-architecture.md recognized
repo-discipline.md recognized
report/doctor/loadability behavior fixed
focused tests
basic dogfood evidence
```

## Step 2 — Workspace manifest + report rollup

Purpose:

```text
Make parent `aih report` useful for a workspace.
```

Files likely touched:

```text
src/workspace/manifest.ts
src/report/workspace.ts
src/report/index.ts
tests/workspace-report.test.ts
```

Acceptance criteria:

```text
reads current v0 repos string[] manifest
reads new v1 repos object[] manifest
detects child git repo status
detects child ai-coding/RULE_ROUTER.md
detects child .aih/history.jsonl
detects child .aih/usage.jsonl
detects child report artifact when present
uses NOT_ONBOARDED for missing child canon
uses STALE when child sample/report is old
emits JSON workspace report
emits HTML/MD workspace report under --apply
```

User-facing output:

```text
Repo       Git  Canon          Usage    Track    Drift  Last sample  Status
ui         OK   OK             OK       OK       0      today        OK
backend    OK   OK             OK       OK       1      yesterday    WARN
infra      OK   NOT_ONBOARDED  MISSING  MISSING  n/a    n/a          NOT_ONBOARDED
```

## Step 3 — Workspace router

Purpose:

```text
Generate the simple routing bridge from parent to child routers.
```

Files likely touched:

```text
src/workspace/templates.ts
src/workspace/index.ts
tests/workspace.test.ts
```

Generate:

```text
ai-coding/workspace-router.md
```

Keep for compatibility:

```text
ai-coding/repo-discipline.md
```

Acceptance criteria:

```text
workspace-router.md generated under --apply
contains repo table
links each child RULE_ROUTER.md
states federated workspace rule
does not modify child repos
respects marker-delimited managed block if file exists
```

## Step 4 — Cross-repo contract edges

Purpose:

```text
Make the workspace bridge useful beyond directory inventory.
```

Files likely touched:

```text
src/workspace/manifest.ts
src/workspace/contracts.ts
src/workspace/templates.ts
src/report/workspace.ts
tests/workspace-contracts.test.ts
```

Add manifest support:

```json
{
  "edges": [
    {
      "id": "ui-consumes-backend-api",
      "from": "ui",
      "to": "backend",
      "kind": "api-contract",
      "contractPath": "backend/openapi.yaml",
      "consumerPath": "ui/src/api"
    }
  ]
}
```

Generate:

```text
ai-coding/workspace-contracts.md
```

Acceptance criteria:

```text
edges[] parsed and validated
missing repo IDs fail verify
missing contract file reports MISSING, not crash
contract status appears in workspace report
workspace-contracts.md generated/updated safely
```

Suggested command:

```bash
aih workspace link --from ui --to backend --kind api-contract --contract backend/openapi.yaml --consumer ui/src/api --apply
```

## Step 5 — Workspace snapshots

Purpose:

```text
Record child repo SHAs that are known to work together.
```

Files likely touched:

```text
src/workspace/snapshot.ts
src/cli.ts
src/report/workspace.ts
tests/workspace-snapshot.test.ts
```

Commands:

```bash
aih workspace snapshot --apply
aih workspace snapshot --label known-good-before-release --apply
```

Generated files:

```text
.aih/workspace-snapshots/<timestamp>.json
.aih/workspace-snapshots/latest.json
```

Acceptance criteria:

```text
records child repo path, branch, sha, dirty state
records timestamp and label
updates latest.json
report shows changes since latest snapshot
handles missing child repo gracefully
handles dirty repo honestly
```

## Step 6 — Workspace task plan generator

Purpose:

```text
Give agents a reviewable multi-repo execution plan before editing.
```

Files likely touched:

```text
src/workspace/plan.ts
src/cli.ts
tests/workspace-plan.test.ts
```

Command:

```bash
aih workspace plan "change login API and update UI"
```

Output:

```text
.aih/workspace-plans/<timestamp>-change-login-api-and-update-ui.md
```

Acceptance criteria:

```text
includes repos touched
includes read order
includes affected contract edges
includes implementation order
includes verification order
includes rollback checklist
does not edit child repos
```

## Step 7 — Skill vet command

Purpose:

```text
Turn ai-harness into a skill trust gate.
```

Files likely touched:

```text
src/skill/vet.ts
src/skill/source.ts
src/skill/scanners.ts
src/skill/policy.ts
src/skill/card.ts
src/cli.ts
tests/skill-vet.test.ts
```

Commands:

```bash
aih skill vet <repo-or-path>
aih skill vet https://github.com/hardikpandya/stop-slop --policy enterprise
aih skill vet https://github.com/Egonex-AI/Understand-Anything --policy enterprise
```

Acceptance criteria:

```text
clones/fetches to temp sandbox
pins commit SHA
identifies skill shape
checks license file
detects install scripts
runs available scanners through adapter interface
emits JSON report
prints GREEN/YELLOW/RED/UNKNOWN verdict
never installs during vet
```

MVP scanner behavior:

```text
if external scanners are unavailable, report UNKNOWN or PARTIAL instead of pretending PASS
```

## Step 8 — Skill card + approval lockfile

Purpose:

```text
Create evidence for approved skills.
```

Files likely touched:

```text
src/skill/card.ts
src/skill/approve.ts
src/skill/lockfile.ts
tests/skill-approve.test.ts
```

Commands:

```bash
aih skill card <repo-or-path>
aih skill approve <repo-or-path> --policy enterprise --pin <sha> --apply
aih skill inventory
```

Generated files:

```text
.aih/skill-cards/<skill>.json
.aih/skill-reports/<skill>-<sha>.json
.aih/approved-skills.lock
```

Acceptance criteria:

```text
approval requires pinned source
approval requires scan report
approval requires license status
lockfile includes source, commit, verdict, pack, scope, card path
inventory lists approved and unapproved installed skills
```

## Step 9 — Pack install

Purpose:

```text
Install governed groups of skills, not one-off random repos.
```

Files likely touched:

```text
src/pack/index.ts
src/pack/manifest.ts
src/pack/install.ts
src/pack/builtin.ts
src/cli.ts
tests/pack-install.test.ts
```

Commands:

```bash
aih pack list
aih pack plan enterprise-core
aih pack install enterprise-core --apply
aih pack install product-ui --repo ui --apply
```

Acceptance criteria:

```text
pack plan is dry-run by default
pack install requires --apply
pack install only installs approved/policy-allowed skills
pack install can target repo/workspace/user scope
pack install updates report inventory
pack install has rollback path
```

Built-in packs:

```text
enterprise-core
workspace-intel
product-ui
docs-quality
content-video
founder-product
skill-governance
```

## Step 10 — Internal marketplace build

Purpose:

```text
Let teams publish approved skills/packs from an internal controlled source.
```

Files likely touched:

```text
src/marketplace/build.ts
src/marketplace/validate.ts
src/cli.ts
tests/marketplace.test.ts
```

Commands:

```bash
aih marketplace build --from .aih/approved-skills.lock --apply
aih marketplace validate <path>
aih marketplace publish --target internal-git --apply
```

Acceptance criteria:

```text
marketplace includes only approved skills
marketplace contains pinned source metadata
marketplace contains skill cards and reports
validation blocks path traversal
generated marketplace is reproducible
```

## MVP order

Build in this order:

```text
1. Step 1: workspace bootloader recognition
2. Step 2: workspace report rollup
3. Step 3: workspace router
4. Step 7: skill vet command
5. Step 8: skill card + approved-skills lockfile
6. Step 9: pack install
7. Step 4: contract edges
8. Step 5: snapshots
9. Step 6: workspace task plans
10. Step 10: internal marketplace
```

Reason:

```text
workspace report + router give immediate product value
skill vet + lockfile create the trust story
pack install turns research into a packaged solution
contracts/snapshots/task plans deepen workspace intelligence
marketplace is valuable after governance primitives exist
```

## First public/demo milestone

Call it:

```text
ai-harness Enterprise Packs Preview
```

Demo flow:

```bash
aih doctor
aih init --apply
aih report --open
aih workspace init --repos ui,backend,infra --apply
aih workspace report --open
aih skill vet https://github.com/hardikpandya/stop-slop --policy enterprise
aih pack plan product-ui --repo ui
```

Demo message:

```text
ai-harness does not blindly install AI skills.
It vets them, pins them, packages them, installs them under policy, and reports what happened.
```

## Final product milestone

Call it:

```text
AIH Enterprise Skill Control Plane
```

Includes:

```text
workspace bridge
workspace report rollup
skill vetting
skill cards
approval lockfile
enterprise packs
internal marketplace output
report dashboard integration
```
