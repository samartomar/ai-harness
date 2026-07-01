# Suggested Repo Documentation Placement
> Status: design/proposed direction, not shipped features. See [ROADMAP.md](../../ROADMAP.md).

Status: design / proposed

## Goal

Place the design docs in `ai-harness` so they are discoverable but do not overload the README.

## Recommended tree

```text
docs/
  product/
    enterprise-packaging-model.md
  workspace/
    federated-bridge.md
  security/
    skill-trust-gate.md
  roadmap/
    workspace-and-skills-roadmap.md
    docs-placement.md
```

Additional planned/proposed docs (not yet placed):

```text
docs/
  product/
    finalized-positioning.md
  workspace/
    workspace-report-rollup.md
    workspace-contracts-and-snapshots.md
  security/
    skill-card-schema.md
    approved-skills-lockfile.md
  research/
    external-skill-packs.md
```

## Placement mapping

The design docs map to repo locations as follows:

```text
enterprise-skill-packs
  -> docs/product/enterprise-packaging-model.md

skill-trust-gate
  -> docs/security/skill-trust-gate.md

workspace-federated-bridge
  -> docs/workspace/federated-bridge.md

implementation-roadmap
  -> docs/roadmap/workspace-and-skills-roadmap.md

repo-docs-placement
  -> docs/roadmap/docs-placement.md
```

## README change: short section only

Add a small README section, not the full docs.

```md
## Enterprise packs and skill governance

`aih` is intended to act as a governed control plane for AI coding skills and agent workflows.

Instead of installing community skills directly, teams can vet, pin, approve, package, install, and report them under policy.

Recommended model:

- `enterprise-core`: Superpowers + ECC + report/track/usage + guardrails.
- `workspace-intel`: workspace router, report rollup, snapshots, contracts, codebase intelligence.
- `product-ui`: frontend-design + stop-slop + optional gstack.
- `content-video`: Remotion skills under media/egress policy.
- `skill-governance`: skill cards, approved-skills lockfile, scanner evidence.

See:

- `docs/product/enterprise-packaging-model.md`
- `docs/security/skill-trust-gate.md`
- `docs/workspace/federated-bridge.md`
```

## README change: workspace wording

Update workspace wording to be explicit.

```md
`aih workspace` scaffolds a federated bridge across disconnected repos. It is not a monorepo replacement.

The parent workspace owns routing, cross-repo contracts, snapshots, and rollup reports. Each child repo keeps its own `ai-coding/RULE_ROUTER.md`, usage, track history, report, commands, and guardrails.

By default, parent workspace commands write only parent files. Recursive child writes require explicit opt-in.
```

## README change: safety wording

Add this to avoid the "attack platform" misunderstanding.

```md
### Skill trust gate

The skill trust gate is a governance feature, not an exploit scanner or attack platform.

It answers a narrow question:

> Is this skill approved to install under our policy at this pinned commit, based on available evidence?

A `GREEN` verdict does not mean a skill is safe forever. It means the skill passed the configured policy gate for that source, version, scope, and install mode.
```

## Docs index

Create:

```text
docs/README.md
```

Group entries by area: Product, Workspace, Security and governance, Roadmap. Mark
planned/proposed docs that are not yet placed so the index does not imply shipped content.

## Suggested issue labels

```text
area/workspace
area/skills
area/packs
area/security
area/report
area/marketplace
kind/design
kind/mvp
kind/docs
kind/refactor
enterprise
```

## Suggested tracking issues

### Issue: Workspace report rollup

```md
Implement parent-level workspace report rollup.

Acceptance:
- Read `.aih-workspace.json`.
- Support repo list as string[] and object[].
- Show child repo health matrix.
- Detect child canon, usage, track, report, drift.
- Use OK/WARN/MISSING/STALE/NOT_ONBOARDED/PARTIAL/UNKNOWN/ERROR states.
- Do not write child repos.
```

### Issue: Workspace router

```md
Generate `ai-coding/workspace-router.md` at parent workspace.

Acceptance:
- Lists each child repo.
- Links each child `ai-coding/RULE_ROUTER.md`.
- States federated workspace rule.
- Keeps `repo-discipline.md` compatibility.
- Does not modify child repos.
```

### Issue: Skill vet command

```md
Add `aih skill vet <repo-or-path>`.

Acceptance:
- Fetches to temp sandbox.
- Pins commit SHA.
- Detects skill/plugin/agent/MCP shape.
- Checks license.
- Detects install scripts and package manifests.
- Runs available scanners through adapter interface.
- Emits GREEN/YELLOW/RED/UNKNOWN verdict.
- Does not install anything.
```

### Issue: Enterprise pack install

```md
Add `aih pack list|plan|install`.

Acceptance:
- Dry-run by default.
- Install requires `--apply`.
- Installs only approved skills.
- Supports built-in packs: enterprise-core, workspace-intel, product-ui, docs-quality, content-video, founder-product, skill-governance.
- Updates approved-skills lockfile and report inventory.
```

## Final docs rule

Keep README short. Put full strategy in docs.

README should answer:

```text
What is this?
Why should I care?
How do I run it?
Where is the deeper design?
```

Docs should answer:

```text
How does workspace work?
How do skill packs work?
How does trust gating work?
What is the roadmap?
```
