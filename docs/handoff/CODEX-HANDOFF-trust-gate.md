# Codex Handoff — Trust Gate for `aih workspace add` (external repos + skills)

> **Audience:** a coding agent (Codex) picking this up cold, no memory of the originating
> chat. Everything needed to build it is in this file. The deep "why" (full threat model,
> tool research, verdict UX, ecosystem precedent) lives in the companion design doc
> **`docs/research/trust-gate-external-skills-plan.md`** — read it once, then build from
> this file. Every non-obvious engine claim here carries a `file:line` citation in §9,
> **verified against the repo on 2026-06-30**.

---

## 0. TL;DR — read this first

- **You are building a NEW capability + the gate that fronts it.** Today `aih workspace`
  is **parent-only and never clones** (workspace/index.ts; it writes only parent bridge
  files). The new capability acquires a third-party GitHub repo and promotes its **skills**
  into a workspace. That is the single most dangerous thing a coding harness can do —
  import code + model-readable instructions that run at the user's privilege — so the gate
  is born *with* the feature, fail-closed.
- **Two load-bearing engine facts shape the whole design (verified):**
  1. **`executePlan` commits writes and runs `exec` BEFORE probes, and probes run ONLY
     under `ctx.verify`** (execute.ts:295-323). So promotion **cannot** be gated on a scan
     verdict inside one plan → the flow is **two `executePlan` calls** (fetch+scan, then a
     separate guarded promote). See §5.1.
  2. **At `vibe` posture the governance grader fails OPEN:** `postureGradeCheck` rewrites a
     warn-grade `fail` → `verdict:"pass", code:undefined` (governance.ts:15-23), so a
     reverse shell would exit 0. Proven-dangerous trust findings therefore **must NOT go
     through `postureGradeCheck`** — they use a new `gradeTrustDanger` that denies at every
     posture. See §5.3.
- **All 5 named scanners are real (verified).** SkillSpector = optional primary external
  detector; the other four = borrow taxonomy / ideas only. None goes in the read-only path
  if it executes the scanned thing. See §7.
- **The 7 design decisions are LOCKED** (see §3) — build to them, do not re-litigate.
- **Build order:** PR **T1** (controls + danger grader + first emitters) → **T2** (thin
  end-to-end `aih workspace add` vertical slice) → T3…T7. See §6.
- **`aih` invariants still hold:** dry-run by default, **no remote *mutation*** ever,
  read-only `probe()`s, parent-only/write-once workspace boundary, Windows `.cmd` reality.
  See §8.

---

## 1. What you're building

Two surfaces:

- **`aih trust scan <path | owner/repo>`** — a read-only scanner that grades an external
  skills tree and emits `Check`s + `--json` + `--sarif` + an exit code. `<path>` is the
  **air-gapped** entry (no network). `<owner/repo>` fetches first (so it needs `--apply`).
  This is a vanilla `alwaysVerify` `CommandSpec` and fits the generic runner.
- **`aih workspace add <owner/repo> [--pin <sha>] [--ref <branch|tag>] --apply`** — the
  acquisition flow: resolve → pin-to-SHA → fetch into quarantine → **run the gate** →
  grade → on a clear verdict (or an acknowledged, overridable finding) **promote skills
  into the workspace**. This needs **bespoke two-phase orchestration** (§5.1), not the
  generic single-plan path.

The gate's job: **deny what can be proven dangerous by reading the tree; hand off to
runtime what only runtime can see; never execute the untrusted code.**

---

## 2. Repository ground truth (verified 2026-06-30)

### 2.1 Where this sits
- Active branch `chore/enterprise-readiness-prep`. The federated-workspace lane
  (docs/research/federated-workspace-implementation-plan.md) is the sibling roadmap; the
  trust gate is a **precondition on its future `aih workspace init-children`** AND on the
  new `workspace add` (locked decision #3 — one shared gate seam).
- `aih workspace` today writes parent-only bridge files and **does not clone** — confirm
  by reading workspace/index.ts before adding any fetch.

### 2.2 Build / test / verify gate — run ALL before claiming done
```
npx tsc --noEmit          # strict typecheck (src, tests, *.config.ts)
npx biome ci src tests    # CI/release use `biome ci` (stricter than local `biome check`)
npx vitest run --coverage # HARD coverage floors live in vitest.config.ts — match them
npx tsup                  # build (ESM: cli + index, target node20)
```
- **Also run the REAL CLI** (`npx tsx src/cli.ts trust scan <fixture-dir>`), not just unit
  mocks — clean tree exits 0, a planted reverse-shell fixture exits 1. Mocks miss the
  Windows `.cmd`/spawn class of bug (§8).
- A new `CheckCode` requires a matching real emitter (verify.ts's "1:1 emitter, never
  derive from `detail`, sealed union" rule) **and** ticket routing in
  `src/support/findings.ts`. Add the code **in the same PR as its emitter**, not ahead.

### 2.3 The seams you will REUSE (learn them before editing)

| Seam | File | What it gives you |
|---|---|---|
| **Action model** | `src/internals/plan.ts` | `write` / `doc` / `probe` (read-only `Check` carrier) / `exec` (LOCAL command under `--apply`) / `envblock` / `digest`. `alwaysVerify` forces probes on every run (plan.ts:177-183). |
| **Plan executor** | `src/internals/execute.ts` | `executePlan`: stage writes → `txn.commit()` → run `exec` → run `probe`s (verify-only). **Order is the reason for two phases.** `assertContained` (51-69) = realpath quarantine containment. `writeArtifact` (91-99) = consent-by-path output write (used for `--sarif`). Dirty-worktree gate (172-187). |
| **Posture spine** | `src/config/posture.ts` | `resolvePosture` (org-floor clamps UP), `gradeVerdict(finding,control,posture)` → allow/warn/deny, `GovernanceControl` union. |
| **Posture grader** | `src/config/governance.ts` | `postureGradeCheck` — warn→pass downgrade. **Use for `trust-origin` only; bypass for `trust-danger`.** |
| **Verify model** | `src/internals/verify.ts` | `Verdict` pass/fail/skip, `Check{name,verdict,detail?,code?,location?,fingerprint?}`, closed `CheckCode` union, `VerificationReport` (only `fail` flips exit). |
| **SARIF** | `src/internals/sarif.ts` | `reportToSarif(report)` → 2.1.0; `fail→error`, `pass/skip→note`; honors `location` + `fingerprint`. Free for any `VerificationReport`. |
| **Secret scan** | `src/secrets/scan.ts` | `scanSecrets(root,{accept})` (.env + root `secrets/`, one level deep) and `scanConfigSecrets(root,files)` (hardcoded creds in MCP configs). **Both take a root → point them at the quarantine dir.** Probe wrappers: `secretProbes`/`mcpConfigSecretProbes` (secrets/index.ts:82,96). |
| **MCP policy** | `src/mcp/policy.ts` + `src/mcp/servers.ts` | `evaluateMcpPolicy(servers, posture)` reads risk axes `egress`/`credentials`/`supplyChain` (servers.ts:37/46/54). You must write a NEW `classifyIncomingMcp(rawServer)` to DERIVE those axes from untrusted `{command,args,url,env}`, then feed this. |
| **Clone-as-exec precedent** | `src/ecc/index.ts` | `git clone`/`fetch`/`pull` are `exec` actions under `--apply` (42-135), pinned via `AIH_ECC_REF` (68-69). Proves `exec` may do read-only network — plan.ts:18's "never contact a remote" means never *mutate* a remote. |
| **External-scan-result intake** | `src/report/guardrail.ts` | `guardrailDigest` consumes a user-produced `.aih/guardrail-scan.json`; "aih does NOT run the scan inline" (8-11). The precedent for ingesting an external scanner's output rather than executing it. |
| **Windows spawn** | `src/tools/install.ts` | `execArgv(platform, argv)` wraps `.cmd` shims (`WIN_CMD_SHIMS = {npm,npx,yarn,pnpm,scoop}`, 179) in `cmd /c`. `git`/`gh`/`docker` are real `.exe`; `uvx`/`semgrep`/`skillspector` may be shims — route them too (§6 PR T6). |
| **Org policy** | `src/org-policy/schema.ts` | `OrgPolicySchema` (38-73), every level `.strict()`. Add the committed `trust` block here as a sibling `.strict().optional()` (the `mcp` block at 65-71 is the template). |
| **Lint primitives** | `src/lint/rules.ts` | `LintFinding`/`LintRule` types (21,44), `skipIntervals` (61), `lintDoc`/`RULES` (426,279). **Reuse the TYPES, NOT `lintDoc`/`RULES` (they lint aih's own canon) and NOT `skipIntervals` (it skips code fences/HTML comments — the prime injection hiding spots).** |
| **Workspace boundary** | `src/workspace/index.ts`, `git.ts` | Parent-only writes; `workspaceGitignoreWrite` (git.ts:33) + transient patterns (15-21). Promotion is the explicit opt-in the federated plan reserves. |

---

## 3. The 7 LOCKED decisions (build to these)

1. **Hosted-MCP grading** → **warn @vibe/team, deny @enterprise**, plus a standing RED
   advisory + "run a runtime MCP-scan with tool-pinning before first use" at every posture.
   (A hosted server's schema lives at the vendor URL — it can never be pinned/hashed, so
   there is no post-approval rug-pull protection to offer.)
2. **Required-detector absent** → **fail-closed, enterprise-only.** An enterprise box with
   a configured `trust.requiredDetectors` entry that is not installed **fails closed**;
   vibe/team always degrade-with-banner.
3. **Shared gate seam** — one gate function fronts both `aih workspace add` and the future
   `aih workspace init-children`. No duplication.
4. **Override ledger** → deny-grade acknowledgements persist in the committed,
   zod-validated **org-policy `trust.approvedSources` pin**, not a free-text markdown file.
5. **Dep-name lists** → **vendored seed popular-package list + `trust.internalScopes` from
   org-policy** (org-extendable). Small/curated in v1 to keep false positives low.
   **TODO (owner: Samar):** supply the actual internal npm scope(s). Until set,
   `trust.internalScopes` defaults to `[]` and the dependency-confusion check **no-ops**
   (typosquat-distance against the seed list still runs).
6. **`trust verify` cadence** — `aih doctor` = **offline local re-hash** of promoted
   artifacts (**local drift only**, never claims upstream detection); **`aih trust verify`**
   = explicit `git ls-remote` upstream check (cheap) + optional full re-fetch+re-hash.
7. **External-detector LLM passes** → **opt-in, off by default** (SkillSpector `--no-llm`
   default; Cisco LLM mode off). Any LLM pass ships file contents to a vendor endpoint —
   enable only when the operator accepts that egress.

---

## 4. Threat model + the gate's HONEST scope (condensed; full version in the design doc)

**Attack surface (artifact classes):** (1) auto-loaded instructions — `SKILL.md` body **+
YAML frontmatter `description`/`name`**, `agents/*.md`, slash-commands, `CLAUDE.md`/
`AGENTS.md`; (2) auto-executing config — `.claude/hooks`, `settings.json` hooks,
`allowed-tools: Bash(*)`, `permissionMode: bypassPermissions`, leading-`!` dynamic-context
commands, npm lifecycle scripts; (3) MCP config (tool poisoning + rug-pull); (4) bundled
scripts; (5) ordinary supply chain (deps, lifecycle scripts, lockfiles, secrets).

**Three tiers — state them in output; do not let absence-of-findings read as safe:**
- 🟢 **GREEN — reliably static, deny at ALL postures:** hidden Unicode-Tag/zero-width runs;
  Base64 blobs in markdown; auto-exec frontmatter keys; **any** npm lifecycle script
  present; reverse-shell pattern in a bundled script; direct-dep NAME tells
  (dependency-confusion vs internal scopes, typosquat distance vs seed list); symlink/
  hardlink escaping the tree; mutable git ref with no resolved SHA.
- 🟡 **AMBER — partially static, warn + runtime recommendation:** vendored/in-repo MCP
  tool-description injection (catchable); unverifiable publisher/origin.
- 🔴 **RED — NOT statically catchable; hand off to runtime, never imply coverage:**
  transitive-dependency / pinned-but-malicious deps (the dangerous postinstall is in the
  *dependency*, not the repo); hosted-MCP rug-pull (schema lives at the vendor URL);
  runtime indirect prompt injection.

**Detection targets syntactic/capability tells, never intent** — "Agent Skills are all
instructions," so semantic "is this malicious" classification is a non-goal. Output always
cites finding + CheckCode + tier + **which analyzers actually ran**, and prints "no findings
≠ safe."

---

## 5. Architecture (the parts that must be right)

### 5.1 Two-phase flow — WHY, and the one place you step outside the generic runner
`executePlan` runs, in order: stage writes → `txn.commit()` (execute.ts:295-297) → `exec`
actions, apply-only (300-314) → `probe`s, verify-only (317-323). So within ONE plan, by the
time a probe verdict exists the writes are already committed — you **cannot** gate a promote
on a scan result in a single plan. Therefore:

- **Phase 1** — one `executePlan` with `verify:true` forced (`alwaysVerify`) whose plan is
  **the fetch `exec`s + scan `probe`s ONLY** (no skill-promotion writes). It yields a
  `VerificationReport`.
- **Decision** — in the command handler (NOT inside `executePlan`): block if the report has
  any `fail` whose fingerprint is not covered by a content-bound acknowledgement AND whose
  code is not on the non-overridable denylist.
- **Phase 2** — a SECOND `executePlan` (writes only: copy skills + record lockfile),
  invoked only if Phase 1 cleared.

The generic command runner (commands/run.ts:197) runs exactly one plan per command, so
`aih workspace add` is implemented as a **bespoke handler in `src/workspace/acquire.ts`
that calls `executePlan` twice** — the single, documented exception to the one-plan-per-
command shape, justified because gating-a-write-on-a-probe is structurally impossible in
one plan. `aih trust scan` stays a vanilla `alwaysVerify` `CommandSpec` (Phase-1 plan
only). A test asserts the Phase-1 plan contains **no workspace-targeting write/doc actions**
(only the gitignore precondition + quarantine fetch `exec` + probes).

### 5.2 Fetch hardening — tarball-at-SHA over `git clone` (security, not size)
A `git clone` of an attacker repo is **not inert file-writes**: submodules, clean/smudge
filters, `core.hooksPath`/`core.fsmonitor`, and LFS smudge all run at checkout under common
configs, and `.git` leaves a hooks/config surface. **Default to the GitHub tarball at the
pinned SHA** (no `.git` → none of those vectors). Fallback when a tarball endpoint is absent
(self-hosted GHE): a hardened clone — `git -c core.hooksPath=/dev/null -c
protocol.file.allow=never -c filter.lfs.smudge=cat -c filter.lfs.required=false clone
--depth 1 --no-recurse-submodules` with `GIT_LFS_SKIP_SMUDGE=1`, then delete `.git/hooks`
and **never run `git` inside the quarantine tree**. For every fetch/detector spawn: **scrub
the child env** (strip `*_TOKEN`/`*_KEY`/`AWS_*`/`ANTHROPIC_*`/`GITHUB_*` — proc.ts passes
full env with no allowlist, so this discipline lives in the trust module) and **jail cwd**
to the quarantine dir. Quarantine root = **OS temp, OUTSIDE any `.code-workspace`/IDE-scanned
path**, so a dropped `.mcp.json`/hooks file is never auto-loaded while it sits there.
Post-extract: reject **zip-slip** and reject **symlinks/hardlinks** (reuse the
`assertContained` realpath logic, execute.ts:57, for both the extracted tree and the promote
copy).

### 5.3 Two new controls + a danger grader (the vibe fail-open + alert-fatigue fix)
Add **two** members to `GovernanceControl` (posture.ts), split by base-rate:
```ts
| "trust-danger"   // proven-dangerous, low false-positive: deny at ALL postures
| "trust-origin"   // unverifiable origin / common AMBER: warn @vibe/team, deny @enterprise
```
- `trust-danger` findings are emitted as `verdict:"fail"` and graded by a **new
  `src/trust/grade.ts` `gradeTrustDanger(check)` that does NOT call `postureGradeCheck`** —
  posture cannot soften them, so they deny even at `vibe`/under a vibe-floor org.
- `trust-origin` findings route through ordinary `gradeVerdict`/`postureGradeCheck`
  (warn/warn/deny). **Keep `trust-origin` OUT of the team-deny set** so a box with no
  allowlist/attestation is not blocked on every add.

> **Honest protection statement (put it in the docs):** `trust-danger` denies at every
> posture. `trust-origin` only *warns* under a vibe-floor org (posture clamps up, never
> down) and denies at enterprise.

### 5.4 New sealed `CheckCode` members (each ships WITH its emitter PR)
```ts
// trust-danger (deny all postures)
| "trust.malicious-code"        // reverse-shell pattern in a bundled script
| "trust.prompt-injection"      // hidden instruction in SKILL.md/frontmatter/agent md/MCP description
| "trust.hidden-unicode"        // Unicode-Tag / zero-width smuggling
| "trust.auto-exec-hook"        // Bash(*) / bypassPermissions / !-prefix / npm lifecycle script
| "trust.dependency-confusion"  // direct dep name in an internal scope
| "trust.typosquat"             // direct dep name within edit-distance of a popular pkg
// trust-origin (warn/warn/deny)
| "trust.unpinned-dependency"   // floating range / @latest MCP / mutable git ref
| "trust.untrusted-publisher"   // source not on the approved-source allowlist
| "trust.unsigned-source"       // no SHA pin / no attestation at acquire
| "trust.source-drift"          // content/SHA changed on re-verify (rug-pull)
// skip-only
| "trust.fetch-blocked"         // ls-remote/tarball/detector blocked (egress/proxy) — NEVER fails
```
Reuse existing codes where they fit: incoming-`.mcp.json` hardcoded creds →
`mcp.hardcoded-secret`; on-disk plaintext secret → `secrets.plaintext-detected`;
incoming-MCP risk verdict → `mcp.policy-denied`. **Do NOT add** a `trust.mcp-tool-poisoning`
code — a poisoned tool *description* is markdown the model reads, so it emits
`trust.prompt-injection`/`trust.hidden-unicode`.

### 5.5 Verdict mapping (there is no `warn` verdict in a `Check`)
| Grade | `Check.verdict` | SARIF | Exit | UX |
|---|---|---|---|---|
| `trust-danger` (any posture) | `fail` | `error` | ≠0 | blocks; `--acknowledge` refused (non-overridable denylist) |
| `trust-origin` deny (enterprise) | `fail` | `error` | ≠0 | blocks; `--acknowledge` allowed with reason |
| `trust-origin` warn (vibe/team) | `pass` + `warning-only (…)` detail | `note` | 0 | promotes silently (logged note; engine has no interactive ask) |

### 5.6 Data model
- **Committed** (org-policy/schema.ts, new `.strict().optional()` `trust` block):
  `approvedSources: [{owner, repo, pinnedSha?, hostPattern?}]` (undefined = open/warn; `[]`
  = lockdown; list = exact-match), `requireSignedSource: boolean`,
  `requiredDetectors: ("skillspector"|"cisco"|"semgrep")[]`, `internalScopes: string[]`.
  Allowlist enforcement is a **graded check** (`trust.untrusted-publisher` on
  `trust-origin`), NOT an automatic effect of the posture clamp.
- **Gitignored** (`.aih/trust-lock.json`, local derived evidence): per source `{owner, repo,
  pinnedSha, acquiredAt, posture, analyzersRun, promotedSkills, artifactHashes{path→sha256},
  findings[], acknowledgements[{fingerprint, contentHash, by, at, reason}]}`.
- **`--acknowledge` is content-bound:** every fingerprint embeds a hash of the offending
  bytes (`trust-prompt-injection:<path>:<line>:<contentHash8>`); on re-verify the fingerprint
  is re-derived from current bytes, so any change invalidates the ack (rug-pull defense).
  Mechanism: an acked fingerprint converts THAT `Check` to `verdict:"skip"` with detail
  `acknowledged by <who>` BEFORE report accumulation. Refused for every `trust-danger` code.
  Support `--acknowledge <fp,…>` and `--acknowledge-all --reason <text>`; on a block, print
  the exact copy-pasteable acknowledge command.
- **Path-safety (verbatim):** every lockfile `uri`/`Check.location` is relative,
  POSIX-normalized, non-absolute, no `..`, safe to print.

---

## 6. OPEN work — the build, sequenced (Goal · Files · Approach · Verify · Done-when)

> Vertical-slice-first: a working `aih workspace add` exists by **T2**. Each `trust.*` code
> lands with its emitter (verify.ts 1:1 rule). The `gradeVerdict`/control change lands with
> the first deny-eligible emitter, with tests — T1 is NOT "pure spine, no behavior."

### PR T1 — controls + danger grader + first emitters
- **Goal:** the grading spine + prove the vibe-deny works.
- **Files:** `src/config/posture.ts` (add `trust-danger`,`trust-origin` to
  `GovernanceControl`), `src/trust/grade.ts` (new — `gradeTrustDanger`), `src/trust/lint.ts`
  (new — whole-document hidden-unicode + injection-shape scan; reuse `LintFinding`/`LintRule`
  types, NOT `skipIntervals`/`RULES`), `src/internals/verify.ts` (`trust.hidden-unicode`,
  `trust.prompt-injection`), `src/support/findings.ts` (routing), tests.
- **Approach:** emit both codes as unconditional `verdict:"fail"`; `gradeTrustDanger`
  returns them unchanged; `trust-origin` uses `postureGradeCheck`.
- **Verify:** test `gradeTrustDanger` keeps a `trust.auto-exec-hook`-style fail failing at
  `vibe` (no warn→pass); test `gradeVerdict("warn","trust-origin","vibe")==="warn"`,
  `"team"==="warn"`, `"enterprise"==="deny"`; test the lint catches injection inside a
  fenced code block AND an HTML comment.
- **Done-when:** danger denies at vibe/team/enterprise; origin grades warn/warn/deny; codes
  routed; gate green.

### PR T2 — thin vertical slice: `aih workspace add` (danger-only)
- **Goal:** a user can scan + (safely) add a real skills repo end to end.
- **Files:** `src/workspace/acquire.ts` (new — two-phase orchestrator), `src/trust/fetch.ts`
  (new — tarball-at-SHA into OS-temp quarantine; scrub env; cwd jail; zip-slip + symlink
  rejection via `assertContained` logic), `src/trust/scan.ts` (new — Phase-1 plan builder:
  fetch `exec`s + A1/A2 probes), command registration (`src/commands/index.ts`), `aih trust
  scan <path|owner/repo>` command, tests + fixtures.
- **Approach:** `workspace add` handler calls `executePlan` twice (§5.1); set
  `alwaysVerify`. Gitignore precondition write FIRST (both plain + `--git` paths), then the
  fetch `exec`. SARIF + JSON via the standard `--sarif`/`--json` wiring (commands/run.ts).
- **Verify:** real-CLI run against a fixture skills repo with a planted Unicode-injection →
  exit 1, nothing promoted; clean fixture → promoted + lockfile written. `aih trust scan
  <local-dir>` works with NO network.
- **Done-when:** the slice round-trips on a real repo; Phase-1-has-no-promote-writes test
  passes.

### PR T3 — auto-exec + manifest/dep-name tells (structural parse)
- **Files:** `src/trust/manifest.ts` (new — zod over parsed YAML frontmatter + `package.json`),
  `verify.ts` (`trust.auto-exec-hook`, `trust.dependency-confusion`, `trust.typosquat`,
  `trust.unpinned-dependency`), `src/trust/depnames.ts` (vendored seed list + edit-distance),
  tests.
- **Approach:** detect `allowed-tools` containing `Bash(*)` (flow/quoted/aliased forms),
  `permissionMode: bypassPermissions`, `dangerously-skip-permissions`, leading-`!`,
  `.claude/hooks` + `settings.json` hooks, the FULL lifecycle-script set
  `{preinstall,install,postinstall,prepare,prepublish,prepublishOnly}`, `.npmrc
  ignore-scripts=false`. **Unparseable frontmatter/manifest → `fail` (fail-closed).** Dep
  names: confusion vs `trust.internalScopes`, typosquat distance vs the seed list.
- **Verify:** fixtures include YAML evasions (quoted/flow/anchor), a malformed frontmatter
  (→ fail), a `@internalscope/x` confusion, a `reqeusts` typosquat.
- **Done-when:** the GREEN auto-exec + dep-name tiers deny at all postures.

### PR T4 — secret + incoming-MCP scans (reuse + NEW classifier)
- **Files:** `src/trust/scan.ts` (wire `scanSecrets`/`scanConfigSecrets` with `root =
  quarantine`), `src/trust/mcp-classify.ts` (new — `classifyIncomingMcp(rawServer)` →
  `{classification,egress,credentials,supplyChain}`), reuse `evaluateMcpPolicy`, run the
  `src/trust/lint.ts` scan over incoming MCP `description` fields, tests.
- **Approach:** derive axes from untrusted `{command,args,url,env}` (npx/uvx ⇒
  unpinned/local; http url ⇒ third-party/hosted-remote; literal token ⇒ credentials), THEN
  `evaluateMcpPolicy(classified, posture)`. Hosted server → standing RED advisory + the
  locked #1 grading (warn@team/deny@enterprise).
- **Verify:** fixture `.mcp.json` with a hosted server (warn@team, deny@enterprise), an
  `npx -y x@latest` (unpinned), a `<IMPORTANT>`-in-description (→ `trust.prompt-injection`).
- **Done-when:** incoming-MCP risk graded via the classifier; secret scan covers the
  quarantine tree. *(Budget this as net-new classifier work, not free composition.)*

### PR T5 — pin + drift + allowlist + lockfile + override
- **Files:** `src/trust/pin.ts` (`git ls-remote` `exec`, `trust.fetch-blocked` skip),
  `src/org-policy/schema.ts` (the `trust` block), `src/trust/lock.ts`
  (`.aih/trust-lock.json`), `aih trust allow/pin/list/verify` subcommands, `verify.ts`
  (`trust.untrusted-publisher`, `trust.unsigned-source`, `trust.source-drift`), content-bound
  `--acknowledge` (bulk + non-overridable denylist) + committed override-ledger write, tests.
- **Done-when:** sources allowlisted + pinned; acks content-bound; upstream drift detectable
  by `aih trust verify`.

### PR T6 — optional external detectors + doctor wiring + Windows routing
- **Files:** `src/trust/detectors.ts` (presence-gated SkillSpector via
  `docker run … --no-llm --format sarif`, SARIF→`trust.*` via a fixed lookup table;
  optional AgentShield/Cisco read-only probes), extend `execArgv`/`WIN_CMD_SHIMS` (or wrap
  any non-`.exe` shim) for `uvx`/`docker`/`semgrep`, `src/doctor.ts` (re-hash promoted
  artifacts — **local drift only**), tests.
- **Approach:** **Docker is the default** for any external detector (sandboxes the
  untrusted-tree read). **Every external spawn maps spawnError/127/timeout → `skip`** (never
  `fail`), so an egress-blocked enterprise box degrades. **Degraded-coverage banner:** a
  skipped detector prints "deep scan SKIPPED — coverage is GREEN-tier only" and the "no
  findings ≠ safe" line enumerates which analyzers ran. At enterprise, a configured-but-
  absent `requiredDetector` **fails closed** (locked #2).
- **Verify:** `platform="windows"` test asserts the detector argv starts with `["cmd","/c",…]`
  for shim binaries; absent-detector → skip + banner; required-but-absent @enterprise → fail.
- **Done-when:** external detectors corroborate without ever being load-bearing or executing
  the skill; Windows routing tested.

### PR T7 — optional malicious-code deep scan + AMBER/RED advisories
- **Files:** `src/trust/detectors.ts` (`trust.malicious-code` via offline Semgrep/YARA with
  **vendored** rules — no runtime rule fetch; absent rules → skip), advisory emitter for the
  AMBER/RED residue ("run a sandboxed `npm install --ignore-scripts` + audit; runtime
  MCP-scan with tool-pinning before first use; set `permissions.deny:[Bash(*)]`").
- **Done-when:** the residual runtime hand-off is explicit and never auto-runs.

---

## 7. Compose vs build — the 5 named scanners (verified; full notes in the design doc)

| Tool | Confirmed handle | Call | How aih uses it |
|---|---|---|---|
| **NVIDIA SkillSpector** | `github.com/NVIDIA/SkillSpector` (Apache-2.0, SARIF, never executes the skill) | **integrate-optional** primary external detector | `docker run --rm -v "<quarantine>:/scan" skillspector scan /scan --no-llm --format sarif`; ingest **SARIF** (not flat JSON); map rule IDs → `trust.*`; absent → skip + degraded banner |
| **Cisco AI Defense Skill Scanner** | PyPI `cisco-ai-skill-scanner` (Apache-2.0, SARIF, read-only) | **borrow taxonomy** + optional 2nd opinion | seed A1/A2/B from its Unicode-steganography + social-engineering categories; verify exit codes empirically |
| **Snyk Agent Scan** | PyPI `snyk-agent-scan` | **borrow ideas only** | needs `SNYK_TOKEN`+egress, no SARIF, no URL targeting; MCP path EXECUTES servers — out of the read-only gate |
| **AgentShield** | `npm: ecc-agentshield` by affaan-m (**no "ECC" org**; in THIS repo it's printed doc-text only — ecc/install.ts; `report/guardrail.ts` reads a USER-produced JSON, NOT execution-wired) | **borrow taxonomy**; optional net-new read-only probe | if wanted: `scan --path <dir> --format json` (no `--fix`/`--opus`/online) via `cmd /c`, re-grade through aih's spine |
| **Invariant MCP-Scan** | now `snyk-agent-scan` (acquired) | **borrow ideas only; never read-only path** | adopt rug-pull-by-hash / tool-pinning into the pin-store; live MCP enumeration = separate sandboxed consent-gated opt-in, never the default gate |

**Build (aih-native floor, always-on, no external dep):** the whole-document prompt-injection
/ hidden-unicode lint, the structural auto-exec/manifest parsers, the incoming-MCP
classifier, secret scanning (quarantine root), the SHA-pin + content-hash store, the two
graders, SARIF. **Floor = aih-native; SkillSpector/Cisco/Semgrep = optional corroborating
amplifiers with explicit degraded-coverage signaling.**

---

## 8. Conventions Codex MUST follow

1. **Codebase is the spec.** Read the nearest peer (`src/secrets/`, `src/mcp/`,
   `src/workspace/`, `src/lint/`) end-to-end before writing; inherit probe shape, check
   codes, builder usage, test layout.
2. **No remote MUTATION, ever** (the one hard rule in CONTRIBUTING.md). `exec` may do
   read-only network (clone/ls-remote/tarball — ECC precedent); it must never mutate a
   remote. The scanner must **never execute the untrusted code** (no `npm install`, no
   lifecycle script, no MCP server spawn, no fetching the skill's URLs).
3. **Safe by default.** Dry-run unless `--apply`; writes through `executePlan`/
   `writeArtifact`; respect the dirty-worktree gate; the lockfile + reports go under
   gitignored `.aih/`. Quarantine lives in OS temp, off any IDE-scanned path.
4. **All gating flows through the verify seam.** New checks → `Check`/`CheckCode` in
   `verify.ts` (1:1 with an emitter, added in that emitter's PR) + routing in
   `support/findings.ts`. `skip` never fails a fresh repo; spawn/egress failure → `skip`.
5. **Posture grading:** `trust-danger` bypasses `postureGradeCheck` (deny all postures);
   `trust-origin` uses it (warn/warn/deny). Never put `trust-origin` in the team-deny set.
6. **Windows reality:** `execFile` can't spawn `.cmd` shims directly — route via `cmd /c`
   (`execArgv`; widen `WIN_CMD_SHIMS` for `uvx`/`docker`/`semgrep` or wrap any non-`.exe`
   shim). `git`/`gh` are real `.exe`. **Test with the real CLI**, not just mocks. Samar
   develops on Windows and tests on a second PC — **push and confirm with the commit hash.**
7. **Verify exit codes, not pipe tails.** The full gate (§2.2) must pass; the real CLI must
   exit 0 (clean fixture) / 1 (planted-malicious fixture).
8. **License hygiene when porting:** re-express data shapes, copy no function bodies,
   attribute in-file (e.g. SARIF shape already credits `@razroo/isolint` MIT in sarif.ts).
9. **DCO sign-off + conventional commits.** **Stop at PR — do not merge unless explicitly
   asked.** Fix the asked item end-to-end; surface tangents and ask rather than chaining.

---

## 9. Evidence appendix (`file:line`, verified 2026-06-30)

- **Action model:** `src/internals/plan.ts:29` (`ActionKind`), `:61-65` (`ProbeAction`,
  read-only `Check`), `:73-79` + `:18-19`/`:68-72` (`exec` = LOCAL, "never contact a remote"
  = never mutate), `:177-183` (`alwaysVerify`), `:31-51` (`WriteAction` once/external/merge).
- **executePlan ordering (the two-phase proof):** `src/internals/execute.ts:157`
  (`executePlan`), `:295-297` (`txn.commit()`), `:300-314` (exec after commit, apply-only),
  `:317-323` (probes, verify-only). `assertContained` `:51-69` (realpath containment, `:57`).
  `writeArtifact` `:91-99` (consent-by-path). Dirty-worktree gate `:172-187`.
- **Posture:** `src/config/posture.ts:42-46` (`asPosture`), `:70-91` (`resolvePosture`,
  org-floor clamps up `:83-90`), `:98-114` (`gradeVerdict`), `:7-18` (`Posture`,
  `GovernanceControl`).
- **Vibe fail-open:** `src/config/governance.ts:10-24` (`postureGradeCheck`); `:15`
  (only `fail` is touched), `:18-23` (warn-grade → `verdict:"pass", code:undefined`).
- **Verify model:** `src/internals/verify.ts:12-59` (`CheckCode` closed union + the "1:1
  emitter, never derive from detail, sealed" doc), `:61-79` (`Check`), `:85-133`
  (`VerificationReport`; `ok` `:105-107`, `exitCode` `:116`).
- **SARIF:** `src/internals/sarif.ts:21-23` (`fail→error`, else `note`), `:50`
  (`reportToSarif`).
- **Secret scan:** `src/secrets/scan.ts:49` (`scanSecrets(root,{accept})`), `:183`
  (`scanConfigSecrets(root,files)`), `:105-110` (`MCP_CONFIG_FILES`); probe wrappers
  `src/secrets/index.ts:82` (`secretProbes`), `:96` (`mcpConfigSecretProbes`).
- **MCP policy + axes:** `src/mcp/policy.ts:79-84` (`evaluateMcpPolicy`), `:34-76`
  (`evaluateOne`, reads only the axes); `src/mcp/servers.ts:37` (`McpEgress`), `:46`
  (`McpCredentials`), `:54` (`McpSupplyChain`), `:57-62` (`McpRisk`).
- **Clone-as-exec precedent:** `src/ecc/index.ts:42-135` (`kiroEccActions`: `git
  clone`/`fetch`/`pull` as `exec` under `--apply`), `:68-69` (`AIH_ECC_REF` pin), `:25`
  (repo URL).
- **External-scan intake precedent:** `src/report/guardrail.ts:36-53` (`guardrailDigest`
  consumes `.aih/guardrail-scan.json`), `:8-11` ("aih does NOT run the scan inline").
- **Windows spawn:** `src/tools/install.ts:179` (`WIN_CMD_SHIMS = {npm,npx,yarn,pnpm,scoop}`),
  `:180-184` (`execArgv`).
- **Org policy:** `src/org-policy/schema.ts:38-73` (`OrgPolicySchema`, `.strict()` `:72`,
  `mcp` block template `:65-71`), `:83` (`parseOrgPolicy`), `:103` (`readOrgPolicy`).
- **Lint primitives (reuse types, NOT lintDoc/RULES/skipIntervals):** `src/lint/rules.ts:21`
  (`LintFinding`), `:44` (`LintRule`), `:61` (`skipIntervals` — skips code fences/HTML
  comments), `:279` (`RULES`), `:426` (`lintDoc`).
- **Command runner (single plan, SARIF/posture wiring):** `src/commands/run.ts:136`
  (`resolvePosture`), `:174-177` (`--sarif` implies verify), `:197` (`executePlan`), `:308`
  (`reportToSarif`), `:312` (`writeArtifact` for `--sarif`).
- **Workspace boundary:** `src/workspace/index.ts` (parent-only, does not clone),
  `src/workspace/git.ts:33` (`workspaceGitignoreWrite`), `:15-21`
  (`WORKSPACE_TRANSIENT_PATTERNS`).
- **Companion design doc (deep why):** `docs/research/trust-gate-external-skills-plan.md`
  (threat model, tool research + verification, verdict UX, ecosystem precedent, §9 locked
  decisions).
