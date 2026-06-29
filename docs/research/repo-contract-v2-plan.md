# Enterprise-Control-Plane v2 — the six-pillar governance plane over the `project.json` contract

_Generated 2026-06-29 on `feat/repo-contract-v1` (v1 COMPLETE — 1A-1D + §6 + 2A — on `feat/repo-contract-v1`, pending merge to `main`). Self-contained: a cold session can execute this without prior chat context. Claims were grounded against live source — file:line references are to this branch. v2 is the **enterprise control plane** that governs the v1 compact contract; v1 (`readProjectContract`/`project.json`/`src/contract/*`, PLUS the shipped contract-truth report panel & doctor probe) is the substrate it reads. **v2 builds ON the merged v1** — `[needs v1]` controls (those reading `commands`/`sensitivePaths`/`contractRef`) branch off `main` once v1 merges; `[cold-start]` PRs need nothing. CADENCE (Samar 2026-06-29): the FULL six-pillar program, all 13 PRs._

> Companion docs: `docs/research/repo-contract-v1-plan.md` (the substrate; read its §5 seam first). Companion memories: `aih-readiness-wave-plan` (Wave 0–4 + Track B), `mcp-curated-catalog-increments` (P4 prototype), `local-report-v9-shipped` (P4/P6 surface), `harness-adoption-plan`, `enterprise-readiness-deferred-gaps` (#35/#36/#37). This doc is the authoritative v2 build spec; the memories are the index.

## Problem

v1 gives a repo a **deterministic, machine-readable operating contract** (`project.json`: commands, sensitivePaths, scale, knownGaps) — but it is single-repo and single-actor. An organization running aih across N workstations and M repos has no way to: (1) set one enforcement posture that every control reads; (2) author an **org-owned policy** that overrides what a repo declares; (3) govern MCP/identity at the team level; (4) prove what was enforced (audit/evidence); (5) reach N machines with trusted, signed config and detect drift back; (6) get one assurance verdict that the context a repo loads is both lint-clean and token-honest. Today posture is a **two-valued, MCP-only** concept read at the leaf (`src/mcp/index.ts:370` `asPosture(ctx.options.posture)`); the managed enforcement allowlist (`allowManagedMcpServersOnly`/`allowedMcpServers`) exists **only as doc-string text** (`src/mcp/enterprise.ts:98-108`), never as a written file; there is no org-policy artifact anywhere in `src/`.

**v2 is that control plane, re-badged from Samar's Wave 4 "Moat" + Track B roadmap and re-anchored on the contract** — not new scope. It is **posture-graded** (one dial: `vibe | team | enterprise`), governed by a **separate org-owned policy file** (distinct ownership/lifecycle from the repo contract), and **honest about a local CLI's ceiling**: aih is the PRODUCER and VERIFIER of governance artifacts — never the runtime arbiter. The `src/internals/plan.ts:8-27` invariant (no `ActionKind` mutates a remote system or intercepts a live tool call) bounds the entire program: enterprise's ceiling is **CI-authoritative + OS-system-path managed-settings override**, never live interception.

### Locked decisions (Samar, 2026-06-29)
1. **Scope = the FULL enterprise control plane** as one program (all six pillars end-to-end), NOT a small first increment. Cadence reality: ~15–20 small PRs for a solo maintainer (see §6 sequencing), not one.
2. **Enforcement = posture-graded.** `vibe` = warn + recover; `team` = hard-block secrets + path-portability; `enterprise` = CI-authoritative + OS-system-path managed-settings/managed-mcp **override the repo**. One dial sets the teeth.
3. **Policy unit = a SEPARATE managed org-policy file** (org-owned), governed independently, that **references** the repo contract by path but is **NOT keyed off it** — distinct artifacts, distinct ownership, distinct lifecycle.

## 1. What v2 is (the plane over the substrate)

| Layer | Artifact | Owner | Lifecycle | aih's role |
|---|---|---|---|---|
| **org policy** (v2) | `aih-org-policy.json` (name locked, §8 OQ) | org / platform team | independent; own CODEOWNERS line | reads it, sets posture FLOOR, projects into managed-* |
| **repo contract** (v1) | `ai-coding/project.json` | repo team | re-derived each run | v1 writes; v2 reads via `readProjectContract` |
| **generic baseline** | `COMMAND_LEXICON` / `RISK_GATES` / `LICENSE_MATRIX` / MCP risk-axes | aih (shipped data) | versioned in source | the default deltas merge onto |

v2 = **policy / governance / identity / audit / fleet** organized by posture, sitting **above** the v1 substrate. The six pillars are a dependency graph rooted in one spine (P1):

```
            P1  Posture dial  (the spine — every control reads ctx.posture + gradeVerdict)
             │
             ▼
            P2  Org policy & gates  (the separate org-policy file: schema, precedence, projection)
           ╱ │ ╲
          ▼  ▼  ▼
        P3  P5  (consume P2's org-policy artifact)
   MCP/RBAC  Fleet/trust
          ╲  │  ╱
           ▼ ▼ ▼
        P4 / P6  (audit/evidence + context assurance — fold every verdict into ONE report digest)
```

- **P1 Posture dial** — generalize the MCP `community|enterprise` posture into a harness-wide `vibe|team|enterprise` dial every control reads.
- **P2 Org policy & gates** — the separate managed org-policy file: schema, distribution, precedence (org overrides repo), posture-graded enforcement, projection into managed-settings/managed-mcp + CI/pre-commit.
- **P3 MCP & identity (RBAC/SSO)** — the doc-only gateway → generated per-team/role MCP allowlists + a WRITTEN managed-settings allowlist; honest local scope (config/projection, not a running proxy).
- **P4 Audit/evidence** — the 4 metrics + run-ledger + SARIF + governance digest (**already grounded by the metrics workflow** — merged here, not re-derived).
- **P5 Distribution & trust (fleet)** — signed offline bundles, npm provenance (#37), MDM/fleet config push + DRIFT detection, CA-propagation breadth, VDI matrix.
- **P6 Context assurance** — unify LINT + LOAD/token into one contract-driven assurance verdict (Wave 2; token index **already grounded** — merged here).

Re-badge map: P1+P2 = Wave 4 "enterprise policy projection"; P3 = "MCP identity governance"; P4 = "privacy-controlled observability"; P5 = "signed offline bundles + CA breadth + VDI matrix" + Track B (#37 SBOM/provenance, CODEOWNERS/DCO); P6 = Wave 2 context-assurance.

## 2. The PRECEDENCE invariant + the posture dial

There are **two distinct axes**. Do not conflate them — v1's "repo wins over baseline" and v2's "org overrides repo" only reconcile when split this way.

### AXIS A — POSTURE / TEETH (a FLOOR that clamps upward)

```
org-policy.minimumPosture (FLOOR) → --posture flag → .aih-config marker.posture → AIH_POSTURE env → 'vibe' default
```

The org file does **not** pick the posture; it sets a **minimum** a developer can RAISE locally but never LOWER. This preserves v1 ergonomics (a dev opts into `enterprise` locally) while making the org clamp non-negotiable. The org floor is **fail-CLOSED** — a malformed managed policy must REFUSE to silently drop to `vibe` (mirrors `loadSettings` throwing `SettingsError`, `src/config/settings.ts`), the **opposite trust direction** from the fail-SOFT repo marker (`readAihConfig` returns `undefined` on malformed, `src/config/marker.ts:45`). The ladder is the **proven context-dir ladder copied verbatim** (`src/commands/run.ts:118-140`, `getOptionValueSource("contextDir")==="cli"` → flag, else marker, else env, else default).

`resolvePosture()` returns `{posture, postureSource}` so a control can distinguish an **org-floor clamp** from a **dev opt-in** — required for honest reporting (P4) and for deciding whether to emit the system-path `.example` (P2).

### AXIS B — POLICY CONTENT (deltas merged, then projected)

```
baseline datasets → repo-contract overrides (project.json) → org-policy deltas (add/remove deny, raise tier, pin MCP set)
```

This **extends** v1's "repo canon wins over generic baseline" by inserting **org ABOVE repo** for content. Mechanically a deep-merge of three plain objects via the existing `writeJson({merge:true})` idiom (`src/internals/plan.ts`). Org deltas are **deltas, never redefinitions** — preserving `command-policy.ts`'s "data is data; aih projects where a seam exists, documents elsewhere" stance.

### How "org overrides repo" is ENFORCED (the honest mechanism — verified in source)

aih projects org-policy into `.claude/managed-settings.json` (**PROJECT path**, `writeJson` merge — proven by `src/sandbox/index.ts:16,51-60` today) at `team` tier; at `enterprise` tier it ALSO emits the **OS SYSTEM-path** `managed-settings.json` + `managed-mcp.json` as `.example` files (macOS `/Library/Application Support/ClaudeCode/`, Linux `/etc/claude-code/`, Windows `C:\Program Files\ClaudeCode\` — enumerated in `src/mcp/enterprise.ts:79-86`). **Claude Code reads the system-path managed-settings ABOVE project `.claude/settings.json`** — that read order (owned by Claude Code, not aih) is what makes org override repo at runtime.

**CRITICAL:** aih CANNOT WRITE the system path (`enterprise.ts` says so explicitly; `plan.ts:8-27` no-remote-mutation). It emits the `.example` + an MDM/GPO deploy doc; an admin/MDM deploys it. So **"read-only-to-the-repo" is achieved by FILE LOCATION** (an OS path the repo cannot reach) **+ CODEOWNERS-gating the committed source** — not by aih enforcing ACLs. aih is the PRODUCER+VERIFIER of the precedence (it writes the right file at the right path per tier and ships a drift probe, P5, that FAILS on divergence), never the runtime arbiter.

### The per-control behavior matrix

The `plan.ts` invariant bounds what posture can change to exactly **three observable things**: (1) **probe verdict tier** — `allow`/`warn` vs a `fail` Check that flips exit (`result.report.exitCode()`, `run.ts:193`); (2) **artifact set** — advisory doc vs native-seam projection + managed-* + required CI; (3) **list breadth** — which deny/ask entries promote. No posture level can claim to block a live agent call.

| Control | `vibe` | `team` | `enterprise` |
|---|---|---|---|
| **secrets / path-portability** | warn + recover (doc; finding rendered `warn`) | **HARD-BLOCK**: `fail` Check, non-zero exit locally | CI-authoritative under `--verify`-without-`--apply` + SARIF to code-scanning |
| **command-policy (deny/ask)** | advisory doc only | project deny/ask into `.claude/settings.json` + managed-settings `commandPolicy` (Claude seam) + CI check emitted | required CI status check + system-path managed-settings + widened deny list |
| **risk-gates** | doc only | CI sidecar wired as a PR check; stays `behavior:"ask"` | required check; ask-not-deny invariant unchanged |
| **MCP posture** | community semantics — third-party egress WARN | WARN + governance doc (**new middle tier — does not exist today**) | third-party/unpinned DENY + WRITTEN managed-mcp fixed set + `allowManagedMcpServersOnly`/`allowedMcpServers` |
| **MCP/identity RBAC allowlist** | emit per-role allowlist as advice; warn on third-party tools | hard-block secret/unpinned tools out of allowlist; WRITTEN project managed-settings | system-path managed-mcp/managed-settings OVERRIDE repo + CI-authoritative + drift probe |
| **CA breadth / drift** | emit CA config; drift WARNS | drift is a PR check | drift hard-BLOCKS in CI where org managed-* override repo |
| **TDD / verify probes** | informational | `--verify` gates locally | required in CI |
| **external-action boundary** | UNCHANGED — aih never mutates remote / never intercepts a live call (`plan.ts` invariant), at EVERY level | | |

The honest caveat **"advisory on non-Claude CLIs"** (`ENFORCED_CLIS = new Set(["claude"])`, `src/guardrails/command-policy.ts:125`) is preserved verbatim at ALL tiers — posture changes projection breadth + a required-CI flag, never a runtime-enforcement claim.

## 3. The six pillars — exists today / v2 gap / feasibility split

### P1 — Harness-wide posture dial
- **Exists today (credit):** A posture concept lives ONLY in MCP, two-valued, read at the leaf — `src/mcp/policy.ts:21` `McpPosture = "community"|"enterprise"`, `asPosture()` (`policy.ts:34`, anything ≠ enterprise ⇒ community), `PolicyVerdict = "allow"|"warn"|"deny"` (`policy.ts:24`), `evaluateMcpPolicy`/`evaluateOne` (pure, reads only egress/credentials/supplyChain). Consumed by a doc (`mcpGovernanceDoc`) + a `--verify` probe (`mcpPolicyProbe`, code `mcp.policy-denied`, `src/mcp/index.ts`). Wired via the only `--posture` flag (`mcp/index.ts:406-409`). `PlanContext` (`src/internals/plan.ts:126-155`) has **no posture field**.
- **v2 gap:** promote posture to a first-class 3-valued `PlanContext` field, widen the enum (`enterprise`===today's enterprise; `community` splits into `vibe`=most permissive + `team`=middle), generalize `asPosture`/`evaluateMcpPolicy` into a shared `src/config/posture.ts` with `gradeVerdict(finding, control, posture)`, add `--posture` as a SHARED flag, FREEZE the org-floor read-seam (location + floor-clamp + `contractRef` shape).
- **Feasibility:** **feasible-v2** — the enum/ladder/field/`gradeVerdict`/shared-flag/read-seam (P1 owns ONLY these). The org-policy schema/distribution/projection is **needs-capture-first** (P2's home; P1 must freeze the read-seam so P2 builds on a stable interface). True runtime interception of a live agent call is **defer-v3** (`plan.ts` invariant forbids it).

### P2 — Org policy & gates
- **Exists today (credit):** four pure, versioned, machine-readable, CI-shaped datasets — `COMMAND_LEXICON` (`command-policy.ts:36`, 4 tiers) + `claudeBashPermissions()`/`sandboxExecPolicy()`; `RISK_GATES` (`risk-gates.ts:33`, `POLICY_VERSION`, `riskGatesJson()` sidecar, ask-not-deny); `LICENSE_MATRIX` (`sca.ts:27`, `blockedLicensesFound()`); MCP risk-axes (`policy.ts`). Two managed siblings already written: `.claude/managed-settings.json` (`sandbox/index.ts:16`, `{merge:true}`, multi-producer) and `managed-mcp.json.example` (`managedMcpExample()`, `enterprise.ts:53`). The marker (`config/marker.ts`) is the repo-root, schemaVersion-pinned, fail-soft discipline to mirror.
- **v2 gap:** no org-policy file type/schema/loader; no composer resolving `org > repo > baseline`; no projection step that deep-merges org deltas into the SAME managed-settings + emits the system-path `.example` at enterprise; no posture→exit-code severity mechanism (a probe is advisory at vibe, merge-blocking at enterprise).
- **Feasibility:** **feasible-v2** — name/location (`aih-org-policy.json` at repo root, own CODEOWNERS), zod `OrgPolicySchema` (deltas-not-redefinitions), the `org>repo>baseline` composer, two-tier distribution (project-committed at team / system-path `.example` at enterprise), umbrella-projection into the existing managed files. **needs-capture-first:** sandbox/guardrails/secrets reading the shared dial = P1 dependency. **defer-v3:** fleet/MDM drift between committed projection and system-path pushed file (P5).

### P3 — MCP & identity (RBAC/SSO)
- **Exists today (credit):** SSO is deliberately DOC-ONLY — `src/mcp/gateway.ts:3-11` BOUNDARY comment + `gatewayDoc()` emits Entra/Okta steps + a STATIC IdP-group→tool RBAC table (`gateway.ts:64-69`) + `agentgateway login --check` as text. Gateway is wired only as a `doc()` under `scope==="remote"` (`mcp/index.ts:349-355`), filtered to n24q02m hosts (`mcp/index.ts:342-348`). Every server already carries identity axes (credentials/egress/supplyChain) in the catalog (`servers.ts`). `managedMcpExample()` builds a real fixed-set object but **no** `allowedMcpServers`/`allowManagedMcpServersOnly` keys.
- **v2 gap:** the RBAC table is hard-coded, not generated; the enforcement allowlist (`allowManagedMcpServersOnly`+`allowedMcpServers`) is **doc-string text only** (`enterprise.ts:98-108`) — **the single highest-value v2 deliverable is making it a WRITTEN managed-settings file + a drift/coherence probe**; no read of a separate org-policy file; no "team" tier.
- **Feasibility:** **feasible-v2** — generate per-role/team allowlists from catalog+org-policy; WRITE the real managed-mcp fixed-set + managed-settings allowlist; posture-gate which servers are permitted; emit a structured gateway RBAC config; doctor probe `allowlist==catalog==policy`. **needs-capture-first:** per-team grants are a PROJECTION of P2's org-policy schema (catalog+posture+single-default-team ships first). **defer-v3:** ENFORCING OIDC auth + group→tool authorization at call time (needs the running agentgateway+IdP aih does not host — `gateway.ts` BOUNDARY already encodes this; P3 formalizes it, must NOT erase it).

### P4 — Audit / evidence  (**ALREADY GROUNDED by the metrics workflow — merge, do not re-derive**)
- **Exists today (credit):** `reportToSarif()` (`src/internals/sarif.ts`, VerificationReport→SARIF 2.1.0, fail→error, stable `partialFingerprints`); the run ledger (`src/logging/run-log.ts`, `.aih/runs/YYYY-MM.jsonl`, verification counts per run); **`mcpGovernanceDigest` is ALREADY SHIPPED** (`src/report/local.ts:130`, reuses `evaluateMcpPolicy`/`PolicyVerdict`) — the prototype digest spine to EXTEND, not fork. The four-metric verdicts and recorder constraints are settled (see §5).
- **v2 gap:** fold every control's posture verdict into ONE report digest at the `scorecardDigest` slot; add the contract-truth digest + `report.contract-untrue` CheckCode; widen the usage-into-init capture.
- **Feasibility:** **feasible-v2** — the digest extension, the posture-rollup, the two cold-start-buildable metrics (§5). **needs-capture-first:** the live metrics (one recorder change, §5). **defer-v3:** full claimed-vs-fired reconciliation, dynamic lenses, first-diff telemetry backend, TDD-trace.

### P5 — Distribution & trust (fleet)
- **Exists today (credit):** CA propagation to 5 surfaces (Node/pip/cargo/conda/Homebrew) + 6 env vars (`src/certs/index.ts:77-116`, all `external:true`); fleet distribution drawn doc-only by design (`src/bootstrap/phases.ts` `mdmDistributionDoc()`, "aih does not talk to the MDM backend"); `--mode offline` + `offlineVendoredProbe` (`mcp.unvendored-offline`, `mcp/index.ts:39-62`); supply-chain pinning (`src/ecc/install.ts` `AIH_ECC_INSTALL_VERSION`/`AIH_ECC_REF`/`AIH_MCP_FS_VERSION`); VDI detection+redirect engine (`src/vdi/index.ts`, Citrix/WorkSpaces/AVD/Horizon/RES/RDP, pass/skip probe); release pipeline 60% scaffolded (`.github/workflows/release.yml` — SPDX SBOM + keyless build-provenance attestation, NOT npm publish); the marker baseline + SARIF + run-ledger rails drift detection needs.
- **v2 gap:** CA breadth for git/Docker/JVM/Gradle/Maven/Go; a deterministic versioned FLEET BUNDLE producer; bundle SIGNING+verify; a DRIFT-detection probe diffing local resolved config against the org-policy; npm OIDC trusted publishing (#37); a published VDI compatibility MATRIX.
- **Feasibility:** **feasible-v2** — CA breadth (git/Go are free env-block additions; Docker/JVM/Gradle/Maven new writers reusing `upsertIniKey`+`external:true`); bundle assembler + `SHA256SUMS` + `verify-bundle`; signing ONLY as a thin exec wrapping cosign/minisign/`gh attestation` (**aih must NOT roll its own crypto**); npm #37 (CI/registry-config only, **no aih source change** — "aih's role is to BE the published artifact, not to publish itself"); VDI matrix doc+probe. **needs-capture-first:** DRIFT detection + MDM/fleet PUSH both block on P2's org-policy artifact being concrete (the thing to diff/package against). **defer-v3:** real cross-platform VDI VERIFICATION on live Citrix/AVD/WorkSpaces (pilot/test-evidence, gates #37 next→latest).

### P6 — Context assurance  (**token index ALREADY GROUNDED — merge**)
- **Exists today (credit):** the LINT pass (`src/lint/rules.ts`), the LOAD/token machinery (`fileFootprint`/`estimateTokens`, bytes/4), and the v9 report slice (`local-report-v9-shipped`). The Token-Optimization Index is settled (§5, corrected ruler).
- **v2 gap:** unify LINT + LOAD/token into ONE contract-driven assurance verdict surfaced through the same digest spine, posture-graded.
- **Feasibility:** **feasible-v2** — the redefined token index (3 literal paths) is cold-start-buildable now; the unified assurance verdict folds in after v1's contract reader exists. **defer-v3:** dynamic per-lens token budgets.

## 4. Data artifacts v2 introduces / widens

### NEW — the separate org-policy file (P2; P1 freezes its read-seam)
- **Name + location (locked, §8 OQ resolved here):** `aih-org-policy.json` at repo ROOT (sibling of `.aih-config.json`), committed source, **own CODEOWNERS line** so its lifecycle is independent of the repo contract. Discovery seam: repo-root committed source > `AIH_ORG_POLICY` env override > OS/MDM-pushed system-path copy (the system-path copy is authoritative for true enterprise override — confirmed by Claude's system>project read order, §2).
- **Schema (`src/org-policy/schema.ts`, zod, fail-CLOSED):**
  ```
  { schemaVersion: literal,
    minimumPosture: "vibe"|"team"|"enterprise",   // a FLOOR, never an outright pick
    references: { repoContract: <path> },          // REFERENCES, not keyed-off (drift-check only)
    command?:   { deny: {add[],remove[]}, ask: {add[],remove[]} },   // deltas over COMMAND_LEXICON
    riskGates?: { add[], override{} },              // deltas over RISK_GATES (stays behavior:"ask")
    licenses?:  { disposition overrides },          // deltas over LICENSE_MATRIX
    mcp?:       { allowedServers[], allowManagedOnly: bool } }        // role→server-group grants
  ```
- **Reads:** `references.repoContract` (for the drift/consistency check), the baseline datasets, the active posture. **Writes:** nothing directly — it is the SOURCE that the P2 composer projects into managed-settings/managed-mcp/CI. **Seams:** org-policy is the **one writer of the policy intent**; the managed-* files are **read-only-to-the-repo COMPILED OUTPUTS** (system path) / committed outputs (project path).
- **Distribution (two-tier, already modeled):** team → project `.claude/managed-settings.json` (aih writes, CODEOWNERS-gated); enterprise → ALSO emit OS system-path `managed-settings.json`/`managed-mcp.json` as `.example` + an MDM/GPO deploy doc (aih emits, admin deploys — `plan.ts` no-remote-mutation honored).

### WIDENED — `.aih-config.json` marker (P1)
- Add optional `posture` key to `AihConfigSchema` (`src/config/marker.ts`) — the team's committed default dial. Additive, fail-soft read preserved.

### WIDENED — `.aih/usage.jsonl` (P4/P6 capture) — **MANDATORY KINDS widen**
- `readUsage` hard-filters on a fixed `KINDS` Set (`src/.../events.ts:38,50`) and **DROPS unknown kinds** — adding `kind:"verify"` / `kind:"deny"` **REQUIRES widening `KINDS` in the SAME PR** (not transparently additive — flag this explicitly).
- `fromHookPayload` (`capture.ts:40-61`) extracts ZERO exit/status today — exit-code/permission-deny extraction + a 127/not-found/cmd-shim classifier is **NET-NEW recorder logic**.
- `attemptKey` has no turn boundary — needs a bounded ts-window or an additive turn id.
- One-writer / read-only-consumer: the usage recorder is the SOLE writer of `usage.jsonl`; report/metrics are read-only consumers. Add `aih usage` as ONE `InitPhase` placed **LAST** (after sandbox) so its `.claude/settings.json` PostToolUse merge unions with the deny rules (one-writer fold).

## 5. The four metrics  (**corrected TOI ruler + needs-capture-first split — settled by the metrics workflow**)

| Metric | Deterministic definition | Data source | Gameability mitigation | Verdict |
|---|---|---|---|---|
| **Leak-Preventions (posture half)** | plan-time count of `secrets.plaintext-detected` + `mcp.hardcoded-secret` Checks + guarded-path count | existing secret-scan Checks (scan-derived NOW; `contract.sensitivePaths` enrichment after v1) | value-blind (path/kind only, never values); count of FINDINGS not self-reported | **feasible-v2** (cold-start-buildable) |
| **Token-Optimization Index** | **two filtered sums over the SAME `bloat.files` inventory** via `fileFootprint`/`estimateTokens` (bytes/4): `legacyTokens` {legacy ~16-file always-loaded family} vs `contractTokens` {`RULE_ROUTER.md`+`project.json`+`project.md`}. **NOT** the wrong `worstTokens − earliestContextTokens` subtraction | the file inventory + byte counts | both sums over the same inventory (can't pad one without the other moving); 3 literal contract paths | **feasible-v2, REDEFINED** (cold-start-buildable) |
| **First-Diff Accuracy + Hallucination Rate + live Leak-deny** | claimed-vs-fired / first-diff telemetry / live deny events | `usage.jsonl` AFTER the recorder change (KINDS widen + exit/deny extraction + turn boundary, §4) | recorder captures fired events, not agent self-report | **needs-capture-first** (ONE recorder change) |
| **(advanced) true claimed-vs-fired reconciliation, dynamic lenses, first-diff backend, full TDD-trace** | — | — | — | **DEFER-V3** |

**Cold-start-buildable pre-v1** (ship to de-risk and bank wins): the redefined TOI (3 literal paths), the Leak-Preventions posture half (scan-derived), and the usage-into-init fold.

## 6. PR stack across all pillars (sequenced per the review)

**v1 DEPENDENCY (flagged per-PR):** the `[needs v1]` PRs read `commands`/`sensitivePaths`/`contractRef`. **STATUS: v1 is COMPLETE** (1A-1D + §6 + 2A, tip `e9d5690` on `feat/repo-contract-v1`) — `readProjectContract`/`project.json`/`src/contract/*` AND the contract-truth report panel (2A `7c43883`) + doctor probe (1D `0d38976`) all exist there. Once v1 merges to `main`, branch v2 off `main`; the `[needs v1]` PRs are unblocked; **[cold-start]** PRs build off any base now. **Because 2A/1D shipped, PRs #5 and #12 EXTEND already-shipped code — they do NOT rebuild it (see their rows).**

| # | Goal | Files (reuse real modules) | Acceptance test | Effort | Risk | Deps |
|---|---|---|---|---|---|---|
| **0a** [cold-start] | Redefined Token-Optimization Index over 3 literal paths | `src/report/*` token slice; reuse `fileFootprint`/`estimateTokens` | two filtered sums over one `bloat.files` inventory; `legacy` vs `contract` byte-deterministic | S | Low | none |
| **0b** [cold-start] | Leak-Preventions posture half (scan-derived) | reuse `secrets.plaintext-detected`+`mcp.hardcoded-secret` Checks | count = findings, value-blind; deterministic on seeded secret | S | Low | none |
| **0c** [cold-start] | `aih usage` capture as LAST `InitPhase` | `src/init/phases.ts`; reuse `.claude/settings.json` `deepMerge` fold | PostToolUse merge unions with deny rules; one-writer per file | S | Low | none |
| **1** | P1 dial — extract shared `src/config/posture.ts` (3-valued, `community→vibe` back-compat keeping mcp goldens byte-identical), add `posture`+`postureSource` to `PlanContext`, `resolvePosture()` ladder mirroring `run.ts:118-140`, `--posture` SHARED flag in `addSharedFlags`, FREEZE org-floor read-seam | `src/config/posture.ts`, `src/internals/plan.ts`, `src/commands/{run,index}.ts`, `src/config/marker.ts` (`posture` key), `src/config/settings.ts` (`AIH_POSTURE`), `src/mcp/{policy,index}.ts` (import shared, drop local `--posture`) | ladder test (flag>marker>env>default + org-floor clamp cannot be LOWERED); mcp golden output byte-identical at vibe default | M | Med | none (spine) |
| **2** | P2 org-policy file — `src/org-policy/schema.ts` (zod, fail-closed, deltas-not-redefinitions), composer resolving `org>repo>baseline`, projector into managed-settings/managed-mcp (`.example` at enterprise) | `src/org-policy/{schema,compose,project}.ts`; reuse `writeJson({merge:true})`, `managedSandboxSettings`, `managedMcpExample`, `sandboxExecPolicy` | malformed org-policy fail-CLOSED (refuses vibe); `org>repo>baseline` deep-merge deterministic; system-path `.example` emitted only at enterprise | M | Med | **#1** |
| **3** | P3 written MCP allowlist + drift probe (**highest-value deliverable**) | `src/mcp/{enterprise,index}.ts`; reuse `managedMcpExample`, `sandbox/index.ts` merge-write pattern, `mcpPolicyProbe` clone | real `.claude/managed-settings.json {allowManagedMcpServersOnly,allowedMcpServers}` WRITTEN; doctor probe `allowlist==catalog==policy` fails on drift | M | Med | **#1, #2** |
| **4** | P3 generated per-role allowlist + structured gateway RBAC config | `src/mcp/gateway.ts` (replace static table with catalog-derived) | per-role allowlist generated from catalog (not hard-coded); BOUNDARY preserved (no OIDC reg) | M | Low | **#2** |
| **5** [needs v1] | Posture-grade secrets/path-portability probes via `gradeVerdict` | `src/secrets/index.ts`; **REUSE the shipped `contractTruthCheck` / `contract.path-unportable` (v1 1D `0d38976`)** — don't rebuild the path probe; reuse `gradeVerdict` | vibe=warn, team=fail(secrets,path), enterprise=fail(all)+SARIF; per-control matrix test | M | Med | **#1, v1** |
| **6** [needs v1] | Posture-grade command-policy + risk-gates projection | `src/guardrails/{command-policy,risk-gates,precommit}.ts`; reuse `claudeBashPermissions`/`sandboxExecPolicy`/`riskGatesJson` | team=project+CI-check; enterprise=required check+system managed-settings; `ENFORCED_CLIS` caveat preserved; risk-gates stays `behavior:"ask"` | M | Med | **#1, v1 PR-1A** |
| **7** | P5 CA breadth — git/Go (env-block), Docker/JVM/Gradle/Maven (new writers) | `src/certs/{index,templates,ini}.ts`; reuse `upsertIniKey`+`external:true` | git `http.sslCAInfo` upsert; Docker `certs.d`; keytool exec; each manager one new action; idempotent re-run | M | Low | none |
| **8** | P5 fleet-bundle producer + `verify-bundle` + signing (thin exec) | new `src/bundle/*`; reuse `writeText`/`exec`/`probe`; wrap cosign/`gh attestation` | bundle collects contract+org-policy+managed-*+vendored deps+PEM into checksummed tree; `verify-bundle` checks `SHA256SUMS`+signature; **no own crypto** | L | Med | **#2** |
| **9** [needs v1] | P5 DRIFT-detection probe diffing local resolved config vs org-policy | `src/.../drift.ts`; reuse `reportToSarif`+run-ledger rails, marker baseline | Check per divergence; warn at vibe, merge-blocking at enterprise; rides SARIF→code-scanning | M | Med | **#1, #2, v1 PR-1A** |
| **10** | P5 npm OIDC trusted publishing + `--provenance` (#37) | `.github/workflows/release.yml`, npm trusted-publisher config | OIDC swap for `NPM_TOKEN`; `npm publish --provenance`; environment-approval gate; SBOM format decided | S | Low | none (no aih source change) |
| **11** | P5 VDI compatibility matrix (doc+probe) | `src/vdi/index.ts`, report/doctor surface | platform×redirect×verified-status table surfaced; existing detection legible | S | Low | none |
| **12** | P4/P6 MERGE — fold every control's posture verdict into ONE rolled-up report digest. **NOTE: the contract-truth digest (`src/report/contract.ts contractTruthDigest`) + `report.contract-untrue` CheckCode ALREADY SHIPPED in v1 2A (`7c43883`) — EXTEND it + `mcpGovernanceDigest` (`local.ts:130`); do NOT rebuild either or fork the spine.** | `src/report/{local,contract}.ts`, `src/internals/verify.ts`; reuse `DigestAction`/`PolicyVerdict` | one digest rolls up secrets/command/risk/MCP/CA verdicts under active posture; omit-undefined; v9 additive slice | M | Med | **#1, #2, #3, #5, #6, v1** |

**CA breadth (#7) + npm #37 (#10) + VDI matrix (#11) carry no v1 dependency** and can interleave anytime to de-risk. Per-control grading (#5/#6) are independent small PRs once #1 lands.

## 7. The v2 seam / precedence invariant (keeps v1 ↔ v2 ↔ org-policy composable)

> **Posture has ONE shared resolver (`resolvePosture` → `{posture, postureSource}`) and ONE shared grader (`gradeVerdict`), both in `src/config/posture.ts`; every control reads `ctx.posture` and NONE forks the enum. Two precedence axes never cross: TEETH is a FLOOR that clamps upward (`org minimumPosture → flag → marker → env → vibe`, org fail-CLOSED, marker fail-SOFT); CONTENT is a deep-merge that layers UP (`baseline → repo-contract → org-policy deltas`, deltas-not-redefinitions). The org-policy file is the SOLE writer of policy intent and READS the repo contract by reference only (never keyed off it); the managed-* files are read-only-to-the-repo COMPILED OUTPUTS, made authoritative at runtime by Claude's own system>project>settings read order — NOT by aih, which can never write the system path nor intercept a live call (`plan.ts:8-27`). v1 remains the sole writer of `project.json`; v2 is a READ-ONLY consumer of it via `readProjectContract`. The org-policy schema evolves ADDITIVELY only (new fields optional with defaults), so an old org-policy still parses and a missing one degrades to repo+baseline — never a fabricated floor or a parallel manifest. aih is the PRODUCER+VERIFIER of precedence at every tier; the runtime arbiter is always the consuming CLI.**

## 8. What defers to v3 (and why)

- **Runtime enforcement** — aih intercepting/blocking a live agent tool call. `plan.ts:8-27` forbids it: no `ActionKind` mutates a remote or intercepts a call. aih is config/projection, not a proxy.
- **Call-time OIDC auth + tool-level RBAC** — per-user token exchange + group→tool authorization before forwarding. Needs the running agentgateway+IdP an operator hosts (`gateway.ts` BOUNDARY). aih's ceiling is generating+validating the config an admin applies.
- **Advanced metrics** — true claimed-vs-fired reconciliation, dynamic lenses, first-diff telemetry backend, full TDD-trace.
- **Live Leak-deny / First-Diff Accuracy / Hallucination Rate** — need the ONE recorder change (widen `KINDS`; add exit/permission-deny extraction to `fromHookPayload`; add a turn boundary to `usage.jsonl`) before they are even capture-able; the reconciliation on top is v3.
- **Real cross-platform VDI VERIFICATION** on live Citrix/AVD/WorkSpaces — pilot/test-evidence (gates #37 next→latest promotion). The compatibility MATRIX doc is v2; the verification evidence is not a code task.
- **Fleet/MDM drift between committed projection and the system-path pushed file** — a P5 fleet-management capability beyond authoring+projection; v2 emits the `.example` as the canonical target, v3 compares against what MDM actually pushed.

### Open questions — HINTS for the executing session to weigh and decide

_Samar's call (2026-06-29): give Codex the hints + recommendations and let it **weight and decide** — these are NOT hard-locked. Each carries a recommendation; Codex resolves as it builds._

1. **Floor-clamp failure mode:** when the org file is unreadable, does a command hard-ERROR (fail-closed for SECURITY) or fall back to the marker's floor (fail-closed for AVAILABILITY)? Solo-maintainer must pick — recommend AVAILABILITY (clamp to marker, surface a `fail` Check) so an offline dev with a stale org file isn't bricked.
2. **Does `minimumPosture` clamp LOCAL dev runs or only CI?** If local, an offline dev with a stale org file could be blocked. Recommend: clamp universally but with the availability fallback in (1).
3. **CODEOWNERS lifecycle:** confirm `aih-org-policy.json` and `project.json` get SEPARATE CODEOWNERS lines; decide whether `references.repoContract` is drift-checked or purely informational (recommend drift-checked, surfaced as a `knownGaps`-style finding).
4. **SBOM format (CycloneDX vs SPDX)** for #37 — `release.yml` emits SPDX today; pick one before wiring `--provenance` (recommend keep SPDX).
5. **Cadence — DECIDED (Samar, 2026-06-29): the FULL six-pillar program**, all 13 PRs in the §6 dependency order, as a sustained sequence (cold-start wins → P1 → P2 → P3/P5 → P4/P6 merge). Codex owns the whole plane. (The thinner MVP-four — #1/#2/#3/#9 — was the alternative; not chosen.)

## START HERE (cold session)

1. **v1 status:** v1 is COMPLETE (1A-1D + §6 + 2A) on `feat/repo-contract-v1`, pending merge — `src/contract/*` + `readProjectContract` AND the contract-truth report panel (2A) + doctor probe (1D) exist. Branch v2 off `main` once v1 merges so `[needs v1]` PRs see the contract reader; `[cold-start]` PRs (#0a/#0b/#0c) build off any base. **Cadence = the full six-pillar program** (all 13 PRs, §6 order): build order is cold-start wins → P1 spine → the rest. **PRs #5 and #12 EXTEND already-shipped 2A/1D code — reuse, don't rebuild.**
2. **Read end-to-end:** this doc; `docs/research/repo-contract-v1-plan.md` (§5 seam); `src/mcp/policy.ts` (the posture engine to generalize); `src/commands/run.ts:118-182` (the ladder + `PlanContext` assembly site — copy verbatim for `resolvePosture`); `src/config/{marker,settings}.ts` (fail-soft vs fail-closed); `src/mcp/enterprise.ts:53-108` (managedMcpExample + the doc-string allowlist that becomes a WRITTEN file); `src/sandbox/index.ts:16,51-60` (the proven `{merge:true}` managed-settings write); `src/report/local.ts:130` (`mcpGovernanceDigest` — the digest spine to EXTEND).
3. **Bank the cold-start wins first** (#0a/#0b/#0c) to de-risk, then build the SPINE: **PR #1 (P1 dial)** exactly as §6 — `src/config/posture.ts` + `PlanContext.posture/postureSource` + `resolvePosture()` ladder + shared `--posture` flag + FROZEN org-floor read-seam. Keep mcp goldens byte-identical at the `vibe` default (`community→vibe` back-compat map).
4. **Then #2 (P2 schema/composer/projection)** on P1's frozen seam, **then #3 (the written MCP allowlist + drift probe — the single highest-value deliverable)**. Gates each PR: `npm run typecheck`, `npm run lint` (biome ci — stricter than `biome check`), `npm test`, `npm run build` — all green (verify exit codes, not pipe tails). Push + confirm hash on the 2nd PC before merging the heavy projection PRs (#2/#3).
