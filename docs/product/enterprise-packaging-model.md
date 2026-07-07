# Enterprise Skill Pack Model for ai-harness

> Status: historical design exploration. A pack system has since shipped (v0.5.0,
> PRs #108–#111 — `src/pack/`), but with a different shape than proposed here: packs are a
> committed curation manifest (`aih-packs.json`) over per-skill approvals, addressed as
> `aih pack install --pack <name>`. See [pack-manifest.md](pack-manifest.md) for the shipped
> model. The built-in pack catalog below (enterprise-core, workspace-intel, product-ui, …),
> the positional `aih pack install <name>` shapes, and the manifest format in this doc were
> not implemented. Kept as the design record.

## Goal

Package community and internal AI coding skills as approved packs.

The goal is not to install many skills. The goal is to install the right skills under policy, with evidence.

## Core rule

```text
Do not install skills directly from random repos into developer machines.
Route all skills through ai-harness pack governance.
```

## Pack command shape

The original built-in catalog proposal used `pack list` and positional installs
such as `pack install enterprise-core`; that shape was not shipped. The current
product uses repo-defined packs from `aih-packs.json`:

```bash
aih pack status --pack <name>
aih pack validate --pack <name>
aih pack plan --pack <name>
aih pack install --pack <name> --apply
```

Each referenced skill must already be approved in `aih-skills.lock.json`.

In the historical proposal, every pack install was intended to:

1. Resolve exact source and commit.
2. Run trust scan.
3. Check license.
4. Create or update skill card.
5. Write approval lockfile.
6. Install only approved artifacts.
7. Update report/inventory.

## Pack 1: enterprise-core

Default baseline.

```text
Includes:
  ai-harness repo/workstation bootstrap
  Superpowers
  ECC
  AgentShield or equivalent config scanner
  SkillSpector / Cisco skill-scanner integration hooks
  report / usage / track
  sandbox / MCP policy
  optional Spec Kit light mode

Default:
  yes

Scope:
  workstation + repo

Risk:
  medium because it modifies agent config, but intended to be controlled by dry-run, pinning, and verification
```

Recommended install:

```bash
# if an org curates this pack in aih-packs.json
aih pack install --pack enterprise-core --apply
```

Purpose:

```text
scoped baseline AI coding setup
repeatable developer workstation config
governed repo canon
methodical coding workflow
agent config scanning
```

## Pack 2: workspace-intel

For disconnected repos such as UI, backend, infra, docs, and deployment.

```text
Includes:
  ai-harness workspace
  workspace router
  workspace report rollup
  workspace snapshots
  cross-repo contract edges
  Understand Anything
  optional GSD Core

Default:
  no, but recommended for multi-repo products

Scope:
  workspace parent + approved child repos

Risk:
  medium/high because it can analyze large private codebases
```

Recommended install:

```bash
aih workspace init --apply
aih workspace report --refresh-children --apply
# if an org curates this pack in aih-packs.json
aih pack install --pack workspace-intel --apply
aih workspace report --open
```

Purpose:

```text
child repo health matrix
repo-to-router bridge
codebase knowledge graphs
cross-repo dependency awareness
known-good repo SHA snapshots
multi-repo impact reasoning
```

Suggested controls:

```text
prefer local model for Understand Anything
mark generated graphs as sensitive
keep graph files gitignored unless policy allows
scope analysis to approved repos
run first analysis in sandbox for unknown repos
```

## Pack 3: product-ui

For UI, UX, product, and frontend repos.

```text
Includes:
  frontend-design
  stop-slop
  optional gstack
  Superpowers remains active for implementation discipline

Default:
  yes for repos tagged frontend/ui/product
  no for backend/infra repos

Scope:
  child UI repo only

Risk:
  low/medium
```

Recommended install:

```bash
# run inside the target UI repo after curating product-ui in aih-packs.json
aih pack install --pack product-ui --apply
```

Purpose:

```text
better visual taste
less generic AI UI
better UI/product copy
stronger design/review/QA loop
```

Controls:

```text
stop-slop runs as review/rewrite guidance, not hard compliance policy
frontend-design installs only in frontend/UI repos
gstack remains optional and Claude-focused
```

## Pack 4: docs-quality

For documentation, release notes, readmes, product copy, and support articles.

```text
Includes:
  stop-slop
  optional internal style guide
  optional docs review skill

Default:
  yes for docs repos
  optional for application repos

Scope:
  repo or workspace

Risk:
  low
```

Recommended install:

```bash
aih pack install --pack docs-quality --apply
```

Purpose:

```text
remove AI-sounding filler
improve directness
clean up release and product writing
standardize documentation tone
```

Boundary:

```text
Do not apply stop-slop blindly to legal, compliance, policy, medical, regulated, or accessibility content.
Use it as a reviewer unless team policy says otherwise.
```

## Pack 5: content-video

For video, motion, marketing, launch, and demo repos.

```text
Includes:
  Remotion skills
  stop-slop
  optional frontend-design
  media/egress policy
  artifact policy

Default:
  no

Scope:
  approved marketing/content/video repos only

Risk:
  medium/high
```

Recommended install:

```bash
# run inside the target media repo after curating content-video in aih-packs.json
aih pack install --pack content-video --apply
```

Purpose:

```text
product demo videos
motion graphics
launch assets
animated walkthroughs
marketing clips
```

Controls:

```text
Node/npm policy required
pin source commit
control FFmpeg usage
control third-party APIs such as TTS/media providers
control remote media egress
keep generated video artifacts out of source unless approved
add media-rights checklist
```

## Pack 6: founder-product

Optional startup/founder workflow pack.

```text
Includes:
  gstack
  product-ui pack
  docs-quality pack
  optional Superpowers review commands

Default:
  no

Scope:
  solo founder / product team / startup environment

Risk:
  medium because it is opinionated and Claude-focused
```

Recommended install:

```bash
# run inside the target UI repo after curating founder-product in aih-packs.json
aih pack install --pack founder-product --apply
```

Purpose:

```text
product interrogation
CEO-style review
design review
engineering review
QA
shipping checklist
security sanity checks
release docs
```

Boundary:

```text
gstack should not be installed by default in a strict baseline.
Make it a product/founder preset.
```

## Pack 7: skill-governance

This is the differentiator pack.

```text
Includes:
  skill vet command
  skill cards
  approval lockfile
  scanner orchestration
  skill inventory
  quarantine/removal
  internal marketplace output

Default:
  yes for governed environments

Scope:
  workstation + repo + workspace

Risk:
  low; this is a control layer
```

Recommended install:

```bash
aih pack install --pack skill-governance --apply
```

Purpose:

```text
show what is installed
show why it is approved
show what was scanned
show what commit was pinned
show what policy allowed it
block or quarantine unreviewed skills
```

## Suggested pack manifest format

```json
{
  "schemaVersion": 1,
  "name": "product-ui",
  "description": "Frontend quality pack for UI repos",
  "defaultScope": "repo",
  "allowedRepoKinds": ["frontend", "ui", "product"],
  "skills": [
    {
      "name": "frontend-design",
      "source": "github:anthropics/claude-code/plugins/frontend-design/skills/frontend-design",
      "pin": "<sha>",
      "mode": "instruction-only",
      "risk": "green-after-license-review"
    },
    {
      "name": "stop-slop",
      "source": "github:hardikpandya/stop-slop",
      "pin": "<sha>",
      "mode": "review-only",
      "risk": "green"
    }
  ],
  "requiredChecks": [
    "license",
    "pin",
    "skillspector",
    "skill-scanner",
    "no-exec",
    "no-mcp"
  ]
}
```

## Do not install everything globally

Wrong:

```bash
aih init --install-all-skills --apply
```

Right shape, after curating each named pack in `aih-packs.json`:

```bash
aih pack install --pack enterprise-core --apply
aih pack install --pack product-ui --apply
aih pack install --pack workspace-intel --apply
```

## Source classification

| Source | Pack | Default | Risk | Notes |
|---|---|---:|---:|---|
| Superpowers | enterprise-core | yes | medium | Main disciplined coding method. |
| ECC | enterprise-core | yes | medium | Cross-harness skill/memory/security layer. |
| AgentShield | skill-governance | yes | low/medium | Config and agent security scanning. |
| gstack | founder-product | optional | medium | Product/design/review/QA workflow. |
| stop-slop | docs-quality/product-ui | yes for writing/UI | low | Review/rewrite guidance. |
| frontend-design | product-ui | yes for UI | low/medium | UI taste and frontend design skill. Legal/license review before vendoring. |
| Understand Anything | workspace-intel | optional | medium/high | Codebase graph and onboarding intelligence. |
| Remotion skills | content-video | optional | medium/high | Video/motion/content repos only. |
| GSD Core | workspace-intel | optional | medium | Long-running context discipline. |
| Spec Kit | enterprise-core/spec | optional | low/medium | Spec-first workflow. |

## Final packaging rule

```text
Community skills are not dependencies.
They are governed capabilities.
```

Every capability needs:

```text
source
pin
license
owner
risk class
policy verdict
scan evidence
install scope
rollback path
```
