# AI-Harness (`aih`)

**Make repositories and developer environments ready for AI coding agents — with context, guardrails, governed tools, and verifiable controls.**

AI coding agents can move fast. Real software teams also need them to work with the right repository context, respect security boundaries, use approved tools, and leave evidence that humans and CI can review.

AI-Harness is an open-source, cross-platform CLI for putting those controls around AI-assisted development without locking teams into a single coding agent.

## Try it in minutes

```bash
npm install -g @aihq/harness@5.1.0
aih doctor
aih init .
aih init . --apply
```

`aih doctor` checks the workstation. `aih init .` previews the repository bootstrap without writing changes. When the plan looks right, `aih init . --apply` applies it.

> **Dry-run first.** AI-Harness is designed so you can inspect the plan before changing the repository.

## The problem

Giving a coding agent access to a repository is easy. Making that access repeatable, reviewable, and governable across real engineering teams is harder.

Without a shared harness, teams can end up with fragmented agent instructions, inconsistent repository context, uncontrolled tool integrations, secret-handling risk, environment-specific setup, and little evidence of what was configured or trusted.

AI-Harness provides one command surface for preparing the environment around the agent.

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

AI-Harness is designed around the engineering environment rather than a single model or IDE. The repository remains the durable source of context and controls while supported coding-agent surfaces can consume the appropriate projection.

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

The full project README should retain the existing architecture, command contract, security boundaries, design posture, command reference, claim markers, and implementation evidence below this public-facing introduction.

## Why this proposal exists

The underlying project is already technically deep. This proposed landing section intentionally does not replace that depth. Its purpose is to let a new developer answer four questions quickly:

1. What is AI-Harness?
2. What problem does it solve?
3. Can I try it safely in a few minutes?
4. Why would I use it instead of maintaining ad-hoc agent configuration myself?

Once those are clear, the existing technical documentation can provide the deeper architecture and governance detail.