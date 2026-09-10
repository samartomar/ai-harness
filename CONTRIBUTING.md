# Contributing

Thanks for helping improve `aih`. Human and AI contributors follow the same rules.

## Dev loop

```bash
npm ci
npx vitest run tests/<area>/<change>.test.ts
npm run verify:local -- --base origin/main --head HEAD --include-working
```

Use focused tests while editing. `verify:local` is the routine local completion
gate: it uses CI's classifier, runs every static quality check, then runs the
applicable Core, Workbench browser, or provider lanes. Global, unknown, and
selector changes retain the full suite with coverage and browser acceptance.
The existing provider and browser runners include their packed-artifact checks.

Supply the intended base and head refs explicitly; the checkout must be at the
specified head. `--include-working` also includes staged, unstaged, and untracked
non-ignored paths, including new tests. Without it, a dirty checkout fails.
The same base and head are allowed only with nonempty explicit working changes.
Add `--plan` to inspect the paths, selection reasons, fallback, commands, and
hosted gaps without running checks. For browser/provider lanes, install the
pinned Chromium beforehand with `npx --no-install playwright install chromium`
(CI installs Chromium's system dependencies on its Ubuntu runner).

A successful local run covers the current host only. The printed hosted OS gaps,
CodeQL, PR metadata, release-preparation authorization when applicable, and
protected CI checks still need their CI results. Local verification neither
installs tools nor dispatches remote jobs. Record the command and actual result;
rerun affected checks when their relevant inputs change.

`npm run verify` remains deliberate full validation, including the full coverage
suite and cold/package lifecycle checks. Use it for a release investigation or
when that broader evidence is needed; it is not the default for every edit.
Release-specific acceptance remains governed by [RELEASING.md](RELEASING.md).

## Running vs. developing `aih`

`aih` is published to npm, so you may have it installed globally. Inside this repo a
bare `aih` runs the **published** binary against your working tree — not your edits.
Never run AIH against this checkout, through the source runner, built artifact,
or an installed binary. Exercise project behavior only in tests that target
temporary fixture roots, including passing and failing CLI cases when the
change affects that boundary. Direct repository checks and version/help smoke
tests are allowed; see [the self-hosting contract](ai-coding/SELF-HOSTING.md).

## Conventions

- TypeScript ESM, `commander` for the CLI, `zod` for boundary validation,
  `vitest` for tests, `biome` for lint/format (2-space, double quotes).
- One capability per `src/<cap>/` directory exporting `command: CommandSpec`.
  `plan()` is pure — it returns actions; the executor performs them.
- Generated output must be deterministic (golden-testable). Drive tests with
  `fakeRunner` + `makeHostAdapter`; never hit the network or spawn real processes.

## The one hard rule

No production code may authenticate to, provision, or mutate a **remote** system.
Cloud/SSO/gateway/observability-backend/MDM setup is emitted as `doc` actions
(commands for a human), never executed. Design and architecture docs live under
[`docs/`](docs/README.md).

## Pull requests

Keep diffs scoped. Add tests for new behavior. Reference the capability and the
boundary in your description. For AI-delegated work, comment `@claude <task>` on
an issue (see the Claude workflow).

**Labels are a maintainer's job.** The `semver-label` check requires exactly one
`semver:none|patch|minor|major` label, because the release cut computes the version from
the labels on merged PRs ([VERSIONING.md](VERSIONING.md)). Applying labels needs repo
triage permission, so if you contribute from a fork this check stays red until a
maintainer labels your PR — that is expected, and no action is needed from you. Say in
the PR description how you'd classify the change if you have a view. Use `semver:none`
for docs, tests, CI, or maintainer tooling that does not require new package bytes; it
cannot trigger a release cut.

Use one implementation owner. Before a risky change is ready or merged, obtain
one independent Astra review with low reasoning effort covering correctness,
security, and the touched domain in a single findings list. Risky changes include
trust or execution authority, credentials, destructive file operations, schema
compatibility, and CI/release machinery. Routine changes do not automatically
need agents or panels. Add another reviewer only for a named unresolved boundary;
record that reason. Validate findings against source, fix confirmed defects,
and rerun the affected checks. Record the review, findings, and disposition in
the PR; existing human approval and protected CI requirements still apply.

A CLI-surface change (command/flag/positional) must regenerate
`tests/contract/command-surface.json` in the same PR
(`AIH_REGEN_CONTRACT=1 npx vitest run tests/contract/command-surface.test.ts`) and be
flagged in the PR description so a maintainer can apply the `contract:additive` label;
removals/renames are majors-only — see [STABILITY.md](STABILITY.md).

## Contributor rules

By contributing you agree that:

- Your contribution is licensed under the project's [Apache-2.0](LICENSE) license.
- You have the right to submit it. **Do not submit employer-confidential, proprietary, or
  otherwise restricted code**, or anything you are not authorized to release as open source.
- **Do not submit secrets, tokens, credentials, private keys, or sensitive logs** — not in
  code, tests, fixtures, or commit history.

## Developer Certificate of Origin (DCO)

Sign off every commit to certify the [DCO](https://developercertificate.org/) — that you wrote
the change or have the right to submit it under Apache-2.0:

```bash
git commit -s -m "your message"     # adds: Signed-off-by: Your Name <you@example.com>
```
