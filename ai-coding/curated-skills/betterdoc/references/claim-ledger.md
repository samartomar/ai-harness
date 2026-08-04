# Claim Ledger

Use the claim ledger when a document contains product, security, maturity, compliance, deployment, performance, customer, roadmap, audit, or operational claims.

The ledger can be internal reasoning or user-visible output. Show it when the user asks for a review, audit, or evidence mapping.

## Template

```md
| Claim | Evidence | Status | Scope | Risk if overstated | Action |
|---|---|---|---|---|---|
| ... | code/test/doc/user assertion/unknown | implemented/tested/deployed/runtime-verifiable/documented/planned/unknown/user-provided/assumed | version/env/component/audience | security/compliance/maturity/user confusion | preserve/scope/remove/replace/flag |
```

## Status Values

Use source-backed labels:

- `implemented`: code, schema, config, or infrastructure definition exists.
- `tested`: test, CI, fixture, or reproducible check proves the behavior.
- `deployed`: deployment record, release artifact, environment, dashboard, or runbook evidence shows it is live.
- `runtime-verifiable`: a user can verify it with a command, API call, dashboard, log, or artifact.
- `documented`: committed docs describe it, but implementation evidence was not checked.
- `planned`: roadmap, issue, TODO, or design doc says it is future work.
- `prototype/POC`: source labels it as prototype or proof of concept.
- `experimental`: source labels it experimental or unstable.
- `deprecated`: source says it should not be used for new work.
- `user-provided`: the user asserted it, but source evidence was not checked or is absent.
- `assumed`: the edit depends on an inference; label it.
- `unknown`: no source establishes the status.

Do not convert one status into another.

## Conflict Rules

When sources conflict:

1. Prefer current code, tests, generated artifacts, schemas, CI, release artifacts, and reproducible commands.
2. Then prefer current committed docs, ADRs, runbooks, deployment manifests, and evidence bundles.
3. Then prefer current issue/PR descriptions.
4. Treat older docs, old issue comments, and historical notes as stale unless confirmed.
5. Treat user-provided facts as usable only in the scope the user gave.
6. Label assumptions.

If the conflict is material, do not hide it in smoother prose. Flag it.

## Worked Example

Source material:

```md
README claim: The CLI performs safe enterprise onboarding.
Test source: tests prove dry-run planning does not write files.
No source found: no deployment, compliance, or enterprise audit evidence.
```

Ledger:

```md
| Claim | Evidence | Status | Scope | Risk if overstated | Action |
|---|---|---|---|---|---|
| CLI performs enterprise onboarding | README only | documented | general product positioning | implies maturity and customer proof | scope |
| Dry-run planning does not write files | test file / CI output | tested | dry-run planning path | core safety claim | preserve |
| Enterprise audit readiness | no source | unknown | unknown | compliance/assurance overclaim | remove or flag |
```

Revised wording:

```md
The CLI supports repository onboarding with a dry-run planning path that tests verify does not write files. The source does not establish formal enterprise audit readiness.
```

## Lightweight Review Output

When the full table is too much, use this shorter form:

```md
### Claim audit

- Preserved: `...` — source-backed by `...`.
- Scoped: `...` — changed from broad claim to component/version-specific claim.
- Removed: `...` — no source found.
- Open: `...` — needs source confirmation.
```
