# Suggested Repo Documentation Placement

> Status: placement implemented — the recommended tree below exists (all five docs live at
> these paths) and `docs/README.md` is the index. Several of the suggested tracking issues
> have since shipped: the workspace router and report rollup (`src/workspace/`,
> `src/report/workspace.ts`), `aih skill vet` (`src/skill/vet.ts`, v0.4.0), and the pack
> commands (`src/pack/`, v0.5.0 — shipped as `aih-packs.json` curation with
> `--pack <name>`, without the built-in pack list suggested here). The README wording and
> issue-label sections remain suggestions. Kept as the design record.

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

Additional docs placed after this note was first written:

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

These docs now exist and are indexed from `docs/README.md`; they should be read
as as-built docs where their status line says shipped, not as the earlier
unplaced placeholders.

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

Historical example pack themes an org could curate in `aih-packs.json`:

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

Group entries by area: Product, Workspace, Security and governance, Research,
and Roadmap. Keep each entry's status line honest so the index does not imply
shipped content for historical or directional notes.

## Historical issue-draft notes

The draft issue text below records the proposal state that originally produced
this docs placement map. Do not treat these bullets as current acceptance
criteria when they conflict with shipped docs or command references.

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
Historical proposal: add `aih pack list|plan|install`.

Acceptance:
- Dry-run by default.
- Install requires `--apply`.
- Installs only approved skills.
- Superseded proposal: built-in packs such as enterprise-core, workspace-intel,
  product-ui, docs-quality, content-video, founder-product, skill-governance.
- Superseded proposal: updates approved-skills lockfile and report inventory.

Shipped behavior: `aih-packs.json` curates repo-defined packs, and
`aih-skills.lock.json` remains the approval authority.
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
