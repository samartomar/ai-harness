# AI-Harness (`aih`)

**The open-source engineering control plane for AI coding agents.**

Use the coding agent you want. AI-Harness gives your repository and developer environment the context, guardrails, governed tools, and verification needed to move from ad-hoc AI coding to repeatable engineering.

AI coding agents can move fast. Real software teams also need them to work with the right repository context, respect security boundaries, use approved tools, and leave evidence that humans and CI can review.

AI-Harness is a cross-platform CLI that prepares the engineering environment around the agent without locking teams into a single coding surface.

## Try it in minutes

```bash
npm install -g @aihq/harness@5.1.0
aih doctor
aih init .
aih init . --apply
```

`aih doctor` checks the workstation. `aih init .` previews the repository bootstrap without writing changes. When the plan looks right, `aih init . --apply` applies it.

> **Dry-run first.** AI-Harness is designed so you can inspect the plan before changing the repository.

## Why teams need a harness

Giving a coding agent access to a repository is easy. Making that access repeatable, reviewable, and governable across a real engineering team is harder.

Without a shared harness, teams can end up with fragmented instructions, inconsistent context, uncontrolled tool integrations, secret-handling risk, environment-specific setup, and little evidence of what was configured or trusted.

AI-Harness gives those concerns one repository-aware control surface.

| Without a harness | With AI-Harness |
| --- | --- |
| Agent instructions scattered across tools | Repository-owned context and canon |
| Different setup per developer | Repeatable workstation and repo bootstrap |
| Tool and MCP access configured ad hoc | Explicit, reviewable integrations |
| External skills trusted implicitly | Vet → approve → pack → evidence lifecycle |
| Security controls bolted on later | Guardrails and secret checks built into setup |
| Hard to prove what was configured | Verifiable state, bundles, and evidence |
| AI tooling changes force governance rework | Tool-agnostic controls that outlive individual agents |

## What AI-Harness brings together

| Need | AI-Harness approach |
| --- | --- |
| Repository context | Repository-owned canon and tool-agnostic context architecture |
| Agent setup | Bootstrap and adapters for supported AI coding surfaces |
| Workstation readiness | Environment diagnostics, corporate trust, runtime and tooling checks |
| Security guardrails | Secret checks, local guardrails, sandboxing and policy-aware controls |
| MCP and tools | Explicit, reviewable integration and capability configuration |
| External skills | Vet → approve → pack → marketplace → evidence governance loop |
| Verification | Deterministic checks, signed/verifiable evidence and release verification |
| Enterprise rollout | Policy, bundles, workspace support and governed deployment patterns |

## One harness, multiple AI coding workflows

AI-Harness is designed around the engineering environment rather than a single model or IDE. The repository remains the durable source of context and controls while supported coding-agent surfaces consume the appropriate projection.

That means teams can evolve their AI tooling without rebuilding their engineering governance from scratch.

## From an ordinary repository to an agent-ready repository

```text
Repository
    │
    ▼
AI-Harness
    │
    ├── Environment readiness
    ├── Repository context
    ├── Agent instructions
    ├── Security guardrails
    ├── MCP / tool governance
    ├── Skill supply-chain controls
    └── Verification + evidence
    │
    ▼
AI-assisted engineering with reviewable controls
```

## Start with the workflow that matches you

- **Trying it yourself:** start with the Vibe Developer guide.
- **Adding it to a shared repository:** use the Shared Repository guide.
- **Rolling it out across an organization:** use the Enterprise Admin guide.
- **Working inside an approved enterprise configuration:** use the Enterprise Developer guide.

## What stays below this landing section

The full README should retain the existing architecture, command contract, security boundaries, design posture, command reference, claim markers, implementation evidence, and enterprise rollout detail below this public-facing introduction.
