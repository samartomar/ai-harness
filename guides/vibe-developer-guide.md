---
status: guide
owner: AI-Harness maintainers
last_verified: 2026-07-07
truth_home: true
purpose: Persona guide for individual developers and evaluators using AI-Harness.
---

# Vibe Developer Guide to AI-Harness

Use this guide for an individual developer, evaluator, or maintainer trying AI-Harness on one machine or one repo. For posture mechanics, read [Postures](postures.md). For the full command map, use [Command Use Cases](command-use-cases.md).

## 1. Executive Summary / Mental Model

AI-Harness is a local setup and governance CLI for AI-assisted development. For a vibe developer, the mental model is: preview the plan, apply only after review, then use `doctor`, `docs-lint`, and the generated repo canon to keep the workspace usable.

The default posture is `vibe`. It optimizes for low friction while keeping hard safety boundaries: dry-run planning first, explicit `--apply` for managed writes, secret scanning, local guardrails, advisory trust checks, and fail-closed behavior where the shipped command requires it.

Think in six layers:

| Layer | What you control | Main command |
|---|---|---|
| Workstation readiness | local tools, certificates, runtime checks | `aih doctor`, `aih ready`, `aih tools` |
| Repo canon | `ai-coding/`, bootloaders, stack contract, guardrails | `aih init`, `aih bootstrap-ai`, `aih contract` |
| Capabilities | committed capability intent plus rebuildable machine cache | `aih capability resolve`, `aih init --v3` |
| Skills and packs | approved skills, first-party docs-quality pack, local inventory | `aih skill`, `aih pack` |
| Truth and docs | BetterDoc writing rules, public docs claim gate, optional sidecar | `aih docs-lint`, `aih truth verify`, `aih truth pack` |
| Local feedback | context footprint, usage counts, session text checks | `aih report`, `aih usage`, `aih session-guard` |

## 2. Quickstart / Implementation Blueprint

Verify a published release when release integrity matters:

```console
npm install -g @aihq/harness@latest
aih verify-release
```

Full release verification requires local `npm`, `gh`, and `cosign`; proceed only when all three legs
pass. A skipped leg is incomplete evidence, not a successful rollout gate.

Start read-only:

```console
aih doctor
aih init .
```

Apply the repo bootstrap after reviewing the plan:

```console
aih init . --apply
aih bootstrap-ai --detect --apply
aih bootstrap-ai --verify
```

Add safety and documentation helpers:

```console
aih secrets --verify
aih guardrails --apply
aih docs-lint
```

If the repo already carries an approved `docs-quality` pack, install BetterDoc:

```console
aih pack plan --pack docs-quality
aih pack install --pack docs-quality --apply
aih pack status --pack docs-quality
```

If the repo does not yet carry that first-party pack, seed and approve the local source before installing:

```console
aih pack scaffold --pack docs-quality --apply
aih skill vet packs/docs-quality/betterdoc --apply
aih skill approve packs/docs-quality/betterdoc --owner <owner> --pack docs-quality --apply
aih pack install --pack docs-quality --apply
```

When you want a local dashboard:

```console
aih report --v9 --apply --out .aih/reports/local-v9.html
```

Expected result:

- the repo has a managed AI canon such as `ai-coding/`
- root bootloaders point tools at the same rule router
- secrets, guardrails, docs lint, and canon drift have verification paths
- BetterDoc can be installed through the `docs-quality` pack when the repo has approval evidence
- local reports and usage logs stay under `.aih/` and remain diagnostic, not authority

### Optional Truth Sidecar

Use a truth sidecar only after the repo has a real git commit, because `aih init --sidecar` binds the sidecar to `HEAD`.

```console
aih init . --sidecar --apply
aih truth verify
aih truth pack --apply
```

The sidecar stages project-truth material outside the repo. `truth verify` fails closed on commit, version, claim, decision, acceptance-preflight, or agent-evidence drift; it is not a substitute for human review.

### Expanded Local Evaluation

Use this when you are evaluating the optional local feature set on one machine. This is still `vibe` posture unless you set `--posture enterprise` and supply an org policy.

Run these as staged setup blocks. Review the diff and commit or stash between writing stages, or add `--force` only when you intentionally accept the dirty setup branch.

```powershell
aih init . --v3
aih init . --v3 --apply
aih bootstrap-ai --all-tools --apply
aih bootstrap-ai --verify
aih ecc --cli claude,codex --profile full
aih ecc --cli claude,codex --profile full --apply
aih superpowers --cli claude,codex --apply
aih pack scaffold --pack docs-quality --apply
aih skill vet packs/docs-quality/betterdoc --apply
aih skill approve packs/docs-quality/betterdoc --owner <owner> --pack docs-quality --mode review-only --intended-use "Source-grounded documentation editing." --apply
aih pack install --pack docs-quality --apply
aih usage --cli claude,codex,cursor,zed --apply
aih track --apply
aih report --v9 --apply --out .aih/reports/local-v9.html
aih docs-lint
```

Add external skills or MCP servers only after pinning, vetting, and approving their source. For detailed third-party skill and MCP approval examples, use [Enterprise Admin](enterprise-admin-guide.md) or [Command Use Cases](command-use-cases.md). Commit only placeholders such as `${GITHUB_PERSONAL_ACCESS_TOKEN}` or `${JIRA_API_TOKEN}` in examples; keep real values in the local shell or secret manager.

### Common Use Cases

| Situation | Command path | Why |
|---|---|---|
| You only want to inspect the repo | `aih status`, then `aih doctor` | Shows configured state and failures without applying changes. |
| You are blocked by missing shell tools | `aih tools`, then `aih ready` | Previews required helper tools and rechecks readiness. |
| npm or HTTPS fails behind a proxy | `aih heal`, then `aih certs --apply` if needed | Diagnoses runtime trust first, then applies trust propagation only when reviewed. |
| You want repo capability hints | `aih init . --v3` or `aih capability resolve` | Shows evidence-backed capability decisions without treating machine cache as source truth. |
| You want local model tuning | `aih hardware` | Emits local inference settings without changing repo state. |
| You want one local dashboard | `aih report --v9 --apply --out .aih/reports/local-v9.html` | Builds an offline diagnostic artifact under `.aih/`. |
| You want local usage counts | `aih usage --apply` | Records local tool activity counts and trend samples without prompts or cost claims. |
| You want to check prompt/action safety | `aih session-guard --text "<text>"` | Scans text for secret-like values and dangerous local actions. |
| You are writing public docs | `aih docs-lint`, plus BetterDoc writing rules | Runs the shipped BetterDoc phrase guidance and hard claim-ledger gate. |

## 3. Best Practices & Architecture

Use dry-run output as the design review. A bare `aih init .`, `aih capability resolve`, `aih pack plan`, or `aih workspace` command should tell you what will change before any managed project writes happen.

Keep repo truth committed and local diagnostics local. Commit `ai-coding/`, bootloaders, `.aih-config.json`, lock files, pack manifests, policy files, and capability intent when they are intentionally part of the repo. Do not commit `.aih/` run logs, local reports, usage logs, or generated promoted skill copies unless a repo doc explicitly says they are tracked.

Use the generated router as the agent entry point. The root bootloaders are tool-specific doors; the repo contract lives behind them in `ai-coding/RULE_ROUTER.md`, `ai-coding/project.md`, and the adapters.

Treat external skills as code. Even at vibe posture, run trust and skill commands before adopting unknown skill sources. Same name does not mean same approval.

Use BetterDoc for documentation edits. The shipped source lives at `packs/docs-quality/betterdoc`; its rule is claim-first, evidence-grounded writing. Do not turn BetterDoc, `docs-lint`, reports, or sidecars into compliance claims.

Use portable checks first. `git ls-remote`, `npm view`, and GitHub web pages work across Windows, Linux, and macOS. GitHub CLI (`gh`) is useful if you already have it, especially for authenticated GitHub reads and PR/release work, but the same verification should still be possible without it.

## 4. Pitfalls to Avoid

- Do not paste API keys, tokens, `.env*`, or `secrets/**` content into prompts, docs, logs, examples, or tickets.
- Do not skip the preview step for repo bootstrap work. Use `aih init .` before `aih init . --apply`.
- Do not treat `.aih/` or `~/.aih/` as authority. They are diagnostics, generated output, or rebuildable machine cache.
- Do not hand-edit generated shared blocks in bootloaders. Edit project-owned sections or regenerate with `aih bootstrap-ai`.
- Do not install a seeded `docs-quality` pack in another repo until that repo has vetted and approved the copied local source.
- Do not describe BetterDoc, reports, truth sidecars, SLSA evidence, or posture as formal compliance evidence. They are tooling and evidence surfaces, not certifications.
- Do not promote raw ideas into `NEXT` or public GitHub issues without verification and approval.
