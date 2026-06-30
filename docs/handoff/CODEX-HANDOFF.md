# Codex Handoff — `aih` (AI Harness) enterprise control‑plane roadmap

> **Audience:** a coding agent (Codex) picking this up cold, with no memory of the
> originating chat. Everything needed to act is in this file. Verified against the
> repository on **2026‑06‑29**; every non‑obvious claim carries a `file:line` citation
> in §7.

---

## 0. TL;DR — read this first

- **Product north star:** `aih` is **the enterprise control plane that configures,
  constrains, evaluates, and observes whichever AI‑coding runtime an org uses** — it is
  **NOT** an agent runtime. Do not add agent‑execution / dispatch / memory‑backend
  features. Every change must serve configure / constrain / evaluate / observe.
- **Baseline off `main`, not the current branch.** The working branch
  `fix/pin-crg-install` is **1 commit ahead / 6 behind `main`**. `main` is the source of
  truth. Branch new work from `origin/main`.
- **Much of the historical roadmap is already DONE on `main`** (see §4 — do **not**
  rebuild it). Earlier planning notes that call these "gaps" are stale.
- **The three OSS decisions are now LOCKED** (see §3) — they unblock the npm publish work.
- **Immediate, highest‑leverage work** (see §5): finish **Track B publish (#37)**, then
  the **#36 SARIF‑schema CI gate**, then the product spine **Wave 1 → 2 → 3**.

---

## 1. What `aih` is

`@aih/harness` (`aih`) is an Apache‑2.0, ESM, Node ≥20 CLI (built with tsup) that
bootstraps **governed, proxy‑safe AI coding into enterprise workstations and repos**. It
is **dry‑run by default**, performs **no remote mutation**, writes transactionally with a
rollback path, and supports 11 AI CLIs (claude, codex, cursor, antigravity, gemini,
copilot, windsurf, opencode, zed, kimi, kiro).

Its **uncontested moat** vs. every surveyed peer: corporate‑proxy TLS trust
(`certs`/`heal`), local‑inference hardware tuning (`hardware`), VDI (`vdi`), and
OpenTelemetry (`telemetry`). Peers are agent *runtimes* or thin scaffolders; `aih` is
enterprise DevSecOps environment provisioning. **Keep that boundary.**

---

## 2. Repository ground truth (verified 2026‑06‑29)

### 2.1 Git state
- Current branch `fix/pin-crg-install` @ `6efb83d`, **1 ahead / 6 behind `main`**.
  - The 1 ahead = the CRG pin (`fix(tools): pin code-review-graph install to ==2.3.6`).
    Land it via its own PR; it is unrelated to this roadmap.
  - `main` has #62 (v9 report), #63/#64/#65 (repo‑contract v1/v2 + governance) and a
    W1/W2 contract coverage stack that the branch lacks.
- Working tree is clean except one untracked doc: `docs/research/local-report-v4-plan.md`
  (decide: commit, move, or leave — it is a planning doc, unrelated to the CRG pin).
- There is a stash from `feat/local-report-v9` (`git stash list`) — unrelated; ignore.

### 2.2 Command surface (`src/commands/index.ts`)
Capabilities (mutators, dry‑run by default): `certs heal hardware vdi profile ecc
superpowers scaffold guardrails secrets mcp sandbox telemetry report track usage crispy
bootstrap bootstrap-ai workspace init adopt contract bundle tools`. Read‑only: `doctor
status` (+ `verifyBundle`). **There is no `assess`, `capabilities`, or `score` command
yet** — those are net‑new surfaces this roadmap introduces.

### 2.3 Build / test / verify gate — run ALL before claiming done
```
npx tsc --noEmit          # typecheck (strict; covers src, tests, *.config.ts)
npx biome ci src tests    # NOTE: CI/release use `biome ci` (stricter than the local
                          #       `npm run lint` which is `biome check`). Match CI.
npx vitest run --coverage # 85 test files under tests/**; HARD floors:
                          #   statements 91 / branches 78 / functions 94 / lines 92
npx tsup                  # build (two ESM entries: cli, index; target node20)
```
- CI (`.github/workflows/ci.yml`): 3‑OS matrix (ubuntu/windows/macOS), Node 22; coverage
  gate runs **only on ubuntu**. `release.yml` repeats the identical verify block.
- A meta‑test (`tests/config/coverage-policy.test.ts`) fails if the thresholds block is
  removed; `tests/release-readiness.test.ts` asserts package metadata + governance files.
- **Always also run the REAL CLI** for verification (e.g. `npx tsx src/cli.ts doctor`),
  not just unit mocks — clean repo should exit 0, a broken one exit 1. Mocks miss the
  Windows `.cmd` spawn class of bug (see §6).

### 2.4 Architectural seams you will reuse (learn these before editing)
- **Typed CLI registry** — `src/internals/cli-registry.ts`. The single Zod‑validated
  source of truth for per‑CLI facts: `configDirs`/`binaries` (detection), `bootloaders`,
  `mcp` (McpProfile), optional `settings` (SettingsProfile = managed settings file for
  hooks/permissions/policy), optional `activation`, optional `contextCap`. `Support` is a
  **3‑state** enum `native | fallback | absent`. `bootloadersFor()` is the authoritative
  target→files map. Detection (`cli-detect.ts`), bootloaders (`bootstrap-ai/canon.ts`),
  and MCP writes (`mcp/index.ts`) all derive from it. **Never reintroduce a parallel
  `Record<Cli,…>` table** — that is the anti‑pattern the registry exists to kill (one such
  straggler remains: `CLI_META` in `bootstrap-ai/canon.ts`; fold into the registry, don't
  add to it).
- **Verification seam** — `src/internals/verify.ts` + `src/internals/plan.ts`. A `probe()`
  yields a `Check {name, verdict, code?}`; `VerificationReport.ok` is false on any `fail`;
  `exitCode()` maps to 0/1. A `skip` never fails. `digest()` carries printed analytics.
  **Every new gating check needs:** a `CheckCode` member in `verify.ts`, and ticket
  routing in `src/support/findings.ts`.
- **Safe execution** — dry‑run is default; `--apply` writes through
  `src/internals/execute.ts` (`writeArtifact`). A **dirty‑worktree preflight**
  (`src/internals/worktree-gate.ts` + `execute.ts`) refuses to clobber uncommitted changes
  unless `--force`. Analytics/report writes go under gitignored `.aih/` with
  `skipWorktreeGate: true` (see `report/index.ts`).
- **Committed config marker** — `.aih-config.json` at repo root (`src/config/marker.ts`);
  written by `init`/`adopt`, read by `doctor` as the authoritative context dir.
- **SARIF** — `src/internals/sarif.ts` (`reportToSarif(report)`), wired to `--sarif` on
  `doctor`, `bootstrap-ai`, `secrets`; emitted in `src/commands/run.ts`. `fail→error`,
  `pass`/`skip`→`note`.
- **Maturity scorecard** — `src/report/scorecard.ts` (`scorecardDigest`): weighted 0–100
  over 5 dimensions with grade bands (85/70/50). Today it scores **harness wiring only**
  and is **report‑embedded** (no standalone export).
- **POLICY** — `src/org-policy/*` (compose/constants/drift/project/schema) +
  `src/guardrails/command-policy.ts` (command lexicon → native permission seam, currently
  **Claude‑only** via a hardcoded `ENFORCED_CLIS = {"claude"}`) + `src/mcp/policy.ts`.

---

## 3. The three LOCKED decisions (verbatim, with corrections)

| Gate | Decision | Why |
|---|---|---|
| **npm name** | **Use `@aih/harness`** | Better for enterprise trust, future org ownership, namespace control. **Create/control the `aih` npm scope before publishing.** Scoped public packages need explicit public access on publish. |
| **License** | **Keep Apache‑2.0** | Enterprise‑friendly permissive license with a patent grant. **Correction:** Apache‑2.0 does **not** grant trademark rights (it explicitly excludes trademark permission beyond normal origin description) → keep Apache **+ a separate trademark policy.** |
| **Contributor model** | **Use DCO, not CLA** | Core stays Apache; commercial value is the private control plane. DCO is lighter; contributors certify they have the right to submit. |

**Implementation status of the decisions (verified):**
- `package.json` already sets `name:@aih/harness`, `license:Apache-2.0`, and
  `publishConfig.access:"public"` → aligned with "scoped + public access".
- `TRADEMARKS.md` already exists (covers `aih` / `AI Harness` / `ai-harness`,
  nominative use allowed, fork branding constrained) → trademark‑policy decision satisfied.
- `DCO.md` exists and `CONTRIBUTING.md` requires `Signed-off-by` → DCO decision satisfied.
- **Remaining decision‑driven action:** create the `aih` npm org/scope and connect the
  trusted publisher (see §5, Track B). This is the only piece the decisions still block.

---

## 4. DONE ledger — do NOT rebuild these (verified on `main`)

| Item | Where | Note |
|---|---|---|
| SARIF 2.1.0 emission | `src/internals/sarif.ts`, `--sarif` on doctor/bootstrap‑ai/secrets, `commands/run.ts` | Merged in #18. |
| package.json registry metadata | `package.json` (`repository`/`homepage`/`bugs`/`publishConfig.access:public`) | Merged in #32. **All four present** — do not "add" them. |
| Governance files | `.github/CODEOWNERS`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `TRADEMARKS.md`, `DCO.md`, `.github/dependabot.yml` | Present. (CODEOWNERS lives at `.github/`, which GitHub honors — no root copy needed.) |
| 3‑state registry `Support` + capability‑ish fields | `src/internals/cli-registry.ts` (`SUPPORT_LEVELS`, `settings`, `activation`, `contextCap`) | #34 + later. |
| Maturity scorecard (0–100, grade bands) | `src/report/scorecard.ts` | Wiring‑only; report‑embedded. |
| CONFIG safety primitive | `src/config/marker.ts` (`.aih-config.json`) + `src/internals/worktree-gate.ts` + `execute.ts` (`--force`) | **Fully built** — earlier notes calling this a gap are wrong. |
| Release pipeline + provenance + SBOM | `.github/workflows/release.yml` | On v* tags: verify gate → `npm pack` → `SHA256SUMS.txt` → SPDX SBOM (anchore) → build‑provenance attestation (OIDC) → smoke‑install → `gh release` → **`npm publish ./*.tgz --provenance --access public`** under `environment: npm-publish`. **The publish step is wired but has never run** (package is 404 on npm). |
| POLICY subsystem | `src/org-policy/*`, `src/guardrails/command-policy.ts`, `src/mcp/policy.ts` | Command lexicon + org‑policy compose/drift; enforcement currently Claude‑only. |
| Brownfield adopt mode | `src/adopt/*` | Built. |
| Repo‑contract subsystem | `src/contract/*`, `src/report/contract.ts` | #63/#64/#65. |
| v4 + v9 dashboards | `src/report/v4.ts`, `src/report/v9*.ts` | Built. |
| Context‑assurance **pillars** | canon lint (`src/lint/*`, rule `canon-ref-resolves`), load budget (`src/report/loadgroups.ts` + `--gate`), per‑tool loadability (`src/report/cli-loadability.ts`) | All three exist — but **not unified** (that's Wave 2). |

---

## 5. OPEN work — the roadmap, sequenced

Each item: **Goal · Files · Approach · Verify · Done‑when.** Build order is top‑to‑bottom;
Track B + #36 can run in parallel with the product spine.

### 5.A — Track B: finish npm trusted publishing (issue #37) — *do first, smallest, unblocked*
- **Goal:** actually ship `@aih/harness` to npm with provenance. The workflow is written;
  the npm‑side wiring + first release remain.
- **Files / actions:**
  - **(npm side, human/owner)** Create the `aih` npm org/scope; on npmjs.com configure the
    **trusted publisher** for `@aih/harness` → GitHub repo `samartomar/ai-harness`,
    workflow `release.yml`, environment `npm-publish`. No `NPM_TOKEN` secret — OIDC only.
  - `.github/workflows/release.yml` — confirm the publish job's `environment: npm-publish`
    has a required‑reviewer protection rule (manual approval gate before first publish).
  - Optional: publish the first release under a `next` dist‑tag, promote to `latest` after
    real Windows/macOS/proxy/VDI pilots.
  - Housekeeping the recon flagged: fix the `release.yml` header comment that points to the
    CHANGELOG for the publish rationale (it actually lives in `.github/HARDENING-TASKS.md`);
    consider adding a `NOTICE` file (Apache convention).
- **Verify:** push a throwaway pre‑release tag in a fork or dry‑run the job; confirm
  provenance + SBOM attach and `npm view @aih/harness` resolves post‑publish.
- **Done‑when:** `@aih/harness` is installable from npm with a verifiable provenance
  attestation; #37 closed.

### 5.B — #36: SARIF schema CI gate — *small, complements existing SARIF*
- **Goal:** prevent SARIF regressions by validating emitted SARIF against the 2.1.0 schema
  in CI.
- **Files:** `.github/workflows/ci.yml` (add a step that runs `aih doctor --sarif -` and
  validates against `sarif-2.1.0.json`), a small fixture/test under `tests/`.
- **Verify:** intentionally break the SARIF shape → CI step fails.
- **Done‑when:** CI fails on malformed SARIF; #36 closed.

### 5.C — Wave 1: deepen the Typed Tool Capability Registry
- **Goal:** make the registry able to answer "what can each runtime actually do" so `aih`
  can configure/constrain/evaluate per tool — the substrate for Waves 2–3.
- **Files:** `src/internals/cli-registry.ts` (+ `tests/internals/cli-registry.test.ts`),
  consumers: `src/report/cli-coverage.ts`, `src/guardrails/command-policy.ts`,
  `src/scaffold/hooks.ts`, `src/bootstrap-ai/canon.ts` (fold `CLI_META`).
- **Approach:** add **only fields a command will read** (the file's standing discipline —
  no researched‑but‑unverified numbers):
  - `hooks` capability descriptor (today hooks are only an implicit pointer via `settings`).
  - `permissions`/sandbox seam (`enforced | documented | none` + projection target) so
    `command-policy.ts` reads the registry instead of the hardcoded
    `ENFORCED_CLIS = {"claude"}` literal.
  - `agentTooling` (skills/agents support + baseline dir) — lets `canon.ts` `CLI_META`
    derive from the registry.
  - Populate `contextCap` where a real per‑bootloader cap is documented (it is currently a
    no‑op on every tool).
  - Widen / surface via a new **`aih capabilities --json`** (per‑tool capability matrix).
- **Verify:** registry parses (Zod fails the suite on bad edits); table tests per field;
  `command-policy` enforcement rows now derive from the registry.
- **Done‑when:** capability fields exist + are consumed; `aih capabilities` emits the
  matrix; no new parallel per‑CLI table introduced.

### 5.D — Wave 2: unify Context Assurance into one verdict
- **Goal:** "the context I ship is the context that actually loads, resolves, and fits
  budget" as a **single** Check — today it's three separate Checks across two commands.
- **Files:** new `src/internals/context-assurance.ts`; wire into `src/doctor.ts`; reuse
  `src/lint/run.ts` (`canonLintCheck`), `src/report/cli-loadability.ts` (`loadabilityFor`),
  `src/report/loadgroups.ts` (`scanLoadGroups` worst‑case); add a `CheckCode`
  (e.g. `context.assurance-failed`) in `src/internals/verify.ts` + routing in
  `src/support/findings.ts`.
- **Approach:** aggregator resolves its tool set via
  `bootloadersFor(resolveTargetSet(ctx).targeted)` so **"tools assured" == "tools
  written"** (the current gap: lint/loadability/budget each iterate a *different* tool set
  and none use the registry's `bootloadersFor()`). Emit ONE `fail` if any pillar fails.
  Also add a non‑gating budget probe to `doctor` (today budget only runs in `report
  --gate`), routed through the aggregator. Keep `report --gate` exit semantics unchanged.
- **Verify:** real‑CLI runs — a dangling canon ref, a won't‑load bootloader, and an
  over‑budget load group each flip the unified verdict to exit 1.
- **Done‑when:** one assurance Check covers resolve + load + budget over the written set;
  wired into `doctor`.

### 5.E — Wave 3: enterprise‑posture rollup + exportable evidence bundle
- **Goal:** an auditor‑grade, single readiness signal + one archivable bundle.
- **Files:** `src/report/scorecard.ts`, `src/report/local.ts`, `src/report/index.ts`,
  `src/commands/run.ts`, `src/internals/sarif.ts`, `src/config/marker.ts`,
  `src/guardrails/sca.ts`.
- **Approach:**
  1. **Posture rollup:** broaden the scorecard (or add a sibling digest) from
     wiring‑only to fold in guardrails posture, `mcp-governance` verdict, secrets‑clean,
     and SARIF‑clean — same `DigestAction` shape + grade bands; decide whether it gates
     under `--gate`.
  2. **Evidence bundle:** `aih report --evidence-out <dir>` (or a new read‑only `aih
     assess`) writing `results.sarif` (`reportToSarif` over the verify report) +
     `scorecard.json` (currently report‑only) + config snapshot (`readAihConfig`) +
     `manifest.json` (version/runId/timestamp). Reuse `writeArtifact`, set
     `skipWorktreeGate`, write under gitignored `.aih/`.
  3. **SBOM contract:** `aih` does **not** generate an SBOM locally today (only the
     customer‑CI YAML in `src/guardrails/sca.ts` does). Either add a local pinned‑`syft`
     step or have the bundle record an **SBOM reference + provenance note**. Decide and
     document; don't claim a local SBOM that isn't produced.
- **Verify:** bundle round‑trips; SARIF validates (reuse #36 gate); scorecard JSON matches
  the report digest.
- **Done‑when:** one command emits a complete, validating evidence bundle.

### 5.F — #35: `plan()` purity (independent correctness cleanup, Medium)
- **Goal:** `certs` (`trustStoreCerts`), `heal` (`tlsCheck`), `report` (git reads) do
  read‑only I/O during `plan()` outside the ledger. Model these as ledgered `probe`
  actions (or document the exception). This is **read‑only/low‑risk**, not the
  arbitrary‑exec class — keep it scoped.
- **Files:** `src/certs/*`, `src/heal/*`, `src/report/*`, `src/internals/plan.ts`.
- **Done‑when:** plan‑time host/network reads are ledgered probes or explicitly documented;
  #35 closed.

### 5.G — Wave 4: deepen the moat (longer horizon, mostly net‑new)
Enterprise **policy projection beyond Claude** (registry‑driven, builds on Wave 1's
permissions field) · **CA propagation breadth** (extend `certs`/`heal` beyond
npm/pip/cargo/conda to git, Docker daemon, JVM cacerts/keytool, gradle, maven, Go,
`NODE_EXTRA_CA_CERTS` vs `SSL_CERT_FILE`) · **MCP identity governance** depth ·
**privacy‑controlled observability** · **signed offline bundles** · **VDI compatibility
matrix**.

### 5.H — Housekeeping (cheap, do alongside)
- Add a `lint:ci` (`biome ci src tests`) and a single `verify`
  (`tsc --noEmit && biome ci src tests && vitest run --coverage && tsup`) npm script —
  the local `lint` (`biome check`) silently diverges from the CI gate.
- Land the branch's CRG‑pin commit via its own PR; decide on the untracked
  `docs/research/local-report-v4-plan.md`.

---

## 6. Conventions Codex MUST follow

1. **Codebase is the spec.** Before writing, read the nearest peer file end‑to‑end and
   inherit its conventions (probe shape, digest shape, naming, check codes, test layout).
2. **Registry is the single source of truth.** Add capability facts to
   `cli-registry.ts`; never create a parallel per‑CLI table. Fold the lingering `CLI_META`
   in, don't extend it.
3. **All gating flows through the verification seam.** New checks → `Check`/`CheckCode` in
   `verify.ts` + routing in `support/findings.ts`; new analytics → `digest()`.
4. **Safe by default.** Dry‑run unless `--apply`; writes through `execute.ts`/
   `writeArtifact`; respect the dirty‑worktree gate; analytics under gitignored `.aih/`
   with `skipWorktreeGate`. No remote mutation, ever (it's the one hard rule in
   `CONTRIBUTING.md`).
5. **Windows reality:** the execFile runner cannot spawn `.cmd` shims (`npm`/`npx`/`yarn`)
   directly — route via `cmd /c`. **Test with the real CLI**, not just mocks (mocks miss
   this). Samar develops on Windows and tests on a second PC — **push and confirm with the
   commit hash**.
6. **Verify exit codes, not pipe tails.** `cmd | tail && commit` masks failures. The full
   gate (§2.3) must pass, and the real CLI must exit 0 (clean) / 1 (broken).
7. **License hygiene when porting external data models:** re‑express data shapes, copy no
   function bodies, attribute in‑file. Known sources: `@canonical/harnesses` (LGPL‑3.0),
   RevealUI (FSL‑1.1‑MIT), `@razroo/isolint` (MIT), `@feneto/lh` (Apache‑2.0); paniolo /
   blazity unconfirmed — confirm before lifting their constants.
8. **DCO sign‑off** (`Signed-off-by:`) on every commit; conventional‑commit messages
   (`feat`/`fix`/`refactor`/…). **Stop at PR** — do not merge unless explicitly asked.
9. **Scope discipline:** fix the asked item end‑to‑end; surface tangents and ask rather
   than chaining into them.

---

## 7. Evidence appendix (selected `file:line`, verified 2026‑06‑29)

- Branch vs main: `git rev-list --left-right --count HEAD...main` → `1  6`.
- `main` release publish: `git show main:.github/workflows/release.yml` L8 `environment
  npm-publish`, L27 `id-token: write`, L68‑69 `npm publish ./*.tgz --provenance --access
  public`.
- npm unpublished: `npm view @aih/harness version` → `E404 Not Found`.
- Issues open: `#35` plan() purity, `#36` SARIF schema CI, `#37` Track B publishing — all
  `OPEN` (`gh issue view`).
- Registry: `src/internals/cli-registry.ts` L24‑25 `SUPPORT_LEVELS = native|fallback|absent`;
  `CliEntry` L59‑83 (`settings` L70, `activation` L76, `contextCap` L82); `bootloadersFor`
  L263. Hardcoded enforcement: `src/guardrails/command-policy.ts:125`
  `ENFORCED_CLIS = new Set(["claude"])`.
- Context assurance: lint rule `src/lint/rules.ts:270-307` (`canon-ref-resolves`, fail);
  budget `src/report/loadgroups.ts` (`overBudget`, `DEFAULT_CONTEXT_BUDGET_TOKENS=40_000`
  in `bloat.ts:8`); loadability `src/report/cli-loadability.ts:132`; `--gate` →
  `src/report/advisories.ts:54-75`; `bootloadersFor` consumed only by the writer
  (`bootstrap-ai/canon.ts:458`), never by verification.
- Scorecard: `src/report/scorecard.ts:278` (`scorecardDigest`, overall L283, grade bands
  L39‑44); report‑only consumer `src/report/local.ts:118`.
- CONFIG primitive: `src/config/marker.ts:17` (`.aih-config.json`); dirty gate
  `src/internals/execute.ts:172-187` + `worktree-gate.ts:54`; `--force`
  `src/commands/index.ts:67`.
- SARIF: `src/internals/sarif.ts:50` (`reportToSarif`), level map L21‑23; flag on
  `doctor.ts:38`, `bootstrap-ai/index.ts:293`, `secrets/index.ts:111`; emit
  `commands/run.ts:294-307`.
- Gate: `package.json:24-34` scripts; `ci.yml:29-31` `biome ci` (ubuntu); coverage floors
  `vitest.config.ts:14-22` (91/78/94/92); `release.yml:34-39` repeats verify.
