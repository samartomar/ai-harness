# Engine invariants

Non-negotiable seams when changing `src/`. The broad principles (pure `plan()`,
the seven-action mutation model, deterministic golden output, no remote mutation)
live in `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`, and
`STABILITY.md` — read those. This file carries the specific seams that reviews
and the baseline do not state and that agents keep breaking. Load only the
subsystem you touch.

## Reuse before you build

Before writing new scan/classify/plan/merge logic, check and reuse the shipped
machinery: `src/profile/scan.ts`, `src/secrets/scan.ts`, `src/adopt/`,
`src/scale-safety.ts`, `src/internals/{plan,execute,merge,render}.ts`,
`src/guardrails/`, `src/mcp/policy.ts`. A parallel re-implementation is a defect,
not a feature.

## Registry

- `src/internals/cli-registry.ts` is the **single source** of per-CLI facts
  (detection, bootloaders, MCP config shape, settings, hooks). Never add a
  parallel `Record<Cli, …>` table — three of them once diverged and shipped the
  wrong MCP file for 11 CLIs (#17). Fold stragglers in.
- The supported-CLI list has a canonical order pinned by test — keep new CLIs in
  that order.

## CheckCode & findings

- `CheckCode` is a **sealed union**: each member maps 1:1 to a real emitter and
  ships in the same PR as its emitter. Codes appear only on `fail`/`skip`. Never
  derive routing from `Check.detail` text — route in `src/support/findings.ts`
  and keep the exhaustiveness tests green.
- Absent tools, missing network, missing artifacts, and spawn errors map to
  `skip` — a fresh repo must exit 0. Unparseable security-relevant input
  (frontmatter, manifests, policy) fails **closed**.

## Action model & exits

- `executePlan` commits writes and runs execs **before** probes (probes run only
  under `ctx.verify`) — a plan can never gate its own writes on its own probes.
  Scan-then-conditionally-write flows use the two-`executePlan` pattern
  (`src/workspace/acquire.ts` precedent) with `alwaysVerify: true`, plus a test
  that phase 1 contains no target-writing actions.
- Exit codes flip only via `VerificationReport.exitCode()` / `alwaysVerify` —
  never a raw `process.exit`. Exit codes stay binary; richer verdicts travel in
  `--json`. Bare `aih report` always exits 0.
- `plan()` may invoke only the read-only binary allowlist
  (`tests/internals/plan-purity.test.ts`). Adding a binary requires updating that
  test in the same PR with a justification; execs that *write* ride the post-plan
  seam (the verify-bundle pattern) — never widen the allowlist for them.

## Trust grading

- The default posture grade is **fail-open** (`postureGradeCheck` rewrites a
  warn-grade fail → pass at vibe). Proven-dangerous findings must bypass it via
  `gradeTrustDanger` (`src/trust/grade.ts`). Any multi-source acquisition (packs,
  batch add) routes **every** per-source verdict through the danger grade.

## Writers & data homes

- **One writer per file.** The four `.claude/settings.json` writers (secrets,
  scaffold, sandbox, guardrails — guardrails is the one people forget) compose
  only via `writeJson({ merge: true })` / `deepMerge`, with a coordination test.
- `usage.jsonl` has one writer; a new event kind requires widening the reader's
  `KINDS` set in the same PR or events silently drop.
- Committed intent lives at the repo root (`.aih-config.json`,
  `aih-org-policy.json`, `aih-skills.lock.json`, `ai-coding/`). `.aih/` is
  **enforced-gitignored** runtime data — never a source of truth. `aihIgnoreWrite`
  re-asserts the ignore; the correct pattern is `.aih/*` plus
  `!.aih/usage-record.mjs` — a bare `.aih/` directory-exclude kills the negation.
  Presence-probe `.aih/` state with `git check-ignore`, not `existsSync`.
- Never extend `AihConfigSchema` for feature data — `.aih-config.json` is
  bootstrap intent only; derived artifacts are separate siblings that read it but
  never rewrite it. `assertContained` guards repo-scoped writes; keep it.

## Contract synthesis

- **Never emit an inferred build or start command.** A command is `detected`
  (backed by a real npm script) or it is **omitted** — `knownGaps` caveats do not
  license inventing one. The test/lint inferred asymmetry is deliberate.
- `ai-coding/project.md` is repo **facts only** — no working-agreement copy.
- The compiler **never deletes** user files; Phase-1 synth stays a pure static
  `plan()`, and it is the sole writer of `project.json` (consumers read via
  `readProjectContract`; the schema evolves additively only).

## Adopt & CLI-native dirs

- `aih` never auto-writes CLI-native dirs (`.claude/`, `.cursor/`, `.kiro/`,
  `.codex/`) outside `adopt --migrate-cli`; init phases respect the resolved
  target set via `isTargeted()`; `aih init` stays pure-local (no network execs).
- Adopt convergence must cover **every** existing bootloader or it isn't
  idempotent. Legacy retirement stays report-only — the executor has no delete
  seam; never add a destructive delete to adopt. Soft-imperative lint runs only on
  aih-generated prose, never on carved human text.

## Destructive paths

- Reuse the hardened remove engine untouched (pin `git diff --stat src/internals/`
  empty when your slice builds on it). Gate removals on dirty-set **membership**;
  never `skipWorktreeGate` on a destructive command. Parse git status with
  `--porcelain -z -uall`; route all git through the Runner seam (`gitRead`), never
  `execFileSync`. Removal ownership is 3-way: whole-file → `.aih/legacy/`,
  marker-fenced block → strip in place, unmarked co-owned → advisory only; the
  never-prune list is a hard error.

## Trust surfaces

- **The scanner only reads files.** No `npm install`, no running the source's
  scripts, no spawning its MCP servers, no fetching its URLs. Acquisition default
  is a GitHub tarball at a pinned 40-char SHA (no `.git` → no hook/smudge/submodule
  exec surface); quarantine dirs are `mkdtemp` 0700 in OS temp with zip-slip
  rejection; never run git inside a quarantine tree.
- **Parse hostile input structurally** with the pinned parser (regex frontmatter
  scans are evadable) and fail **closed** on unparseable input; lint whole
  documents including fenced/inline code.
- **Symlink policy is containment, not blanket refusal** — in-tree links are OK
  after a realpath check; escaping/absolute/hard links are refused. Blanket
  refusal was a shipped defect that blocked a legitimate skill (#144).
- **`scrubFetchEnv` must preserve** `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
  (both cases) and `NODE_EXTRA_CA_CERTS` / `SSL_CERT_*` — stripping proxy vars
  broke `workspace add` behind a corporate proxy, the exact environment `aih`
  targets (#143). See `src/trust/fetch.ts`.
- External detectors are optional corroborators: spawn errors / absence map to
  `skip` + a degraded-coverage banner (except enterprise `requiredDetectors`,
  which fail closed). Each new detector ships as `skip` until proven against a
  real local scan; the pinned tool SHA and safe (no-egress, no-LLM) invocation
  live in `src/trust/detectors.ts` — read the pin from code, don't quote a SHA
  into prose.
- Tune gates precision-over-recall (a flagged finding must be near-certainly
  wrong; over-flagging trains users to mute the gate). Never write raw
  URLs/tokens/unredacted argv into the ledger — hash identities. No hand-rolled
  crypto — signing is a thin exec wrapper over `cosign` / `gh` attestation.

## Support tickets (tool-neutral, canned)

- External support-ticket bodies are **tool-neutral** — they never mention `aih`
  or "AI Harness" (`isToolNeutral()` guard in `src/support/templates.ts`).
- Structure is fixed: Summary → Impact → Issue → Evidence → Environment →
  Requested fix → Acceptance. Every field is canned per `CheckCode`, never guessed
  free text; affected-area comes from a fixed vocabulary; never branch on
  `Check.detail`. Never pollute stdout under `--json` / `--sarif`.

## Federated workspace

- The parent writes parent bridge files only and reads child evidence read-only —
  never mutate a child repo by default; child `.aih/` data is local evidence,
  never team truth; `cross-repo-architecture.md` is write-once.
- `.aih-workspace.json` is read only through the central parser (accepts
  `string[]` and `object[]` shapes, preserves unknown fields on merge-write,
  relative non-traversing POSIX paths). Malformed manifests degrade to
  `UNKNOWN` / `ERROR`, never crash.

## Verify layer (parked — do not "fix")

- `src/internals/verify.ts` checks **presence, not enforcement**, and the sandbox
  probe fails **open** — this is a known, accepted limitation, not a bug to
  hotfix. Do not silently harden it.
- Fail-closed defaults, strict mode, an audit schema, offline semantics, and
  `@sha256` digest pinning are explicitly **parked** decisions — do not
  unilaterally implement them. Changes touching `src/internals/**` verify land as
  their own PR.

## Determinism & deliberate asymmetries

- No clock reads in `plan` / dry-run / digest paths; outputs are byte-stable with
  a called-twice-identical test. Golden defaults (claude CLI, vibe posture,
  `--canon legacy`) stay byte-identical.
- Any CLI command string emitted in a report, finding, or doc must parse against
  `tests/contract/command-surface.json` — an un-runnable suggestion is a shipped
  bug.
- Some asymmetries are deliberate — do **not** "normalize" them: the secrets scan
  ignores gitignore on purpose; bloat honors the tracked set (scan scope via
  `git ls-files -z` or generated copies double-count); `.aih-config` marker reads
  fail-**soft** while org-policy/settings fail-**closed**; the posture floor
  clamps upward only; doctor stays read-only (no `--fix` — probes carry the
  remediation in `detail`).

## Porting external code

- **Verify the actual `LICENSE` file on disk before attributing** anything lifted
  from another package — a brief once said Apache-2.0 while the code was MIT, a
  compliance bug given `aih` sells a license gate. Confirm an unconfirmed license
  before lifting even constants.
- Re-express data models; copy no function bodies; keep in-file attribution
  (`src/internals/sarif.ts` is the pattern). Pin any new runtime dep to an exact
  version and flag it in the PR body.

## Test idioms

- Assert on the plan's action list (`writesByPath` / exact sorted sets), not
  snapshot dirs; construct `ctx()` with `platform: "linux"` for determinism;
  EOL-normalize every content compare (`s.replace(/\r\n/g, "\n")`).
- Every new capability/digest gets a determinism case (two `plan()` runs
  byte-identical) and an idempotency case (second `executePlan` → `unchanged` /
  `kept` for `{ once: true }` files).
- Unit tests are hermetic (no real network/processes) — real-CLI verification is
  the separate mandatory step in `review-protocol.md`. The one sanctioned
  exception is a test that spawns real `git`; give it the `20000` ms timeout from
  `windows-environment.md`.
- Adding a field to `Check` or any serialized structure: grep `--json` / SARIF
  goldens first and update them deliberately in the same PR — additive keys are
  the only legal post-1.0 change, and each is an intentional golden update, never
  a surprise CI red. New purity/locality meta-tests iterate the shared command
  registry with a completeness guard.
