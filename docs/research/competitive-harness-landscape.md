# aih vs the "AI harness" npm landscape — deep research

**Date:** 2026-06-25 · **Scope:** 23 packages (22 npm + 1 GitHub) vs `@aih/harness` (`aih`).
**Method:** pulled every package's registry metadata + README, extracted+read the actual shipped source on disk, deep-dived the *remarkable* ones at code level, and ran an adversarial completeness critique. "Only invest in their code where something is genuinely adoptable" — done; the rest are characterized at promise level and screened out with a reason.

---

## TL;DR

- **aih's moat is intact.** Not one of the 23 touches aih's headline lane: **corporate-proxy TLS-trust extraction (`certs`/`heal`), local-inference hardware tuning (`hardware`), VDI redirection (`vdi`), or OpenTelemetry observability (`telemetry`).** Most are Unix-only and ship bundled `dist/` with no real cross-platform story. aih is alone in "enterprise DevSecOps environment provisioning."
- **The ecosystem validates aih's *other* thesis.** "One canonical source → many CLI targets, governed, drift-checked" is converging across the serious projects (`@dzhechkov`, `@blazity-atlas`, `@canonical`, `automaton`, `feneto/lh`). The emerging interop layer is the [Agent Skills open standard](https://agentskills.io). aih is on the right side of this — but several peers have **engineering patterns worth grafting in**.
- **9 genuinely adoptable ideas** found, ranked below. The four highest-value: **(1)** a declarative per-tool capability registry, **(2)** a weighted AI-harness *scorecard* for `doctor`/`report`, **(3)** lint aih's *own generated* markdown for weak-model safety, **(4)** a per-tool-load-group token model + CI budget gate for `report`.
- **Most packages are out of scope** (agent *runtimes* — they execute LLMs; aih provisions the environment they run in) **or thin scaffolders** (nothing aih doesn't already do better).

---

## The landscape, bucketed

### A. Agent runtimes — different category, screened out (they run agents; aih provisions)
| Package | Promise | Verdict |
|---|---|---|
| `agentic-flow` | "Meta-harness — freeze the model, evolve the harness." Model routing, self-evolving planner/reviewer, swarm/consensus. 198 versions, very ambitious. | Out of scope. Runtime/orchestrator. Nothing aih-shaped to adopt. |
| `deepagents` | LangChain's official Deep Agents (LangGraph). `createDeepAgent()` → compiled graph. | Out of scope. **Claims "harness" for the *opposite* meaning** (runtime wrapping an LLM). Positioning note only. |
| `engram-harness` | "AI harness for everyone" — personal AI infra (skills/hooks/memory/personality), swap models. BSL-1.1. | Out of scope. Personal-OS runtime. |
| `pmm-ai` | "Autonomous AI dev platform" — project memory + orchestration + quality gates, Bun. | Out of scope. Runtime/orchestrator. |
| `@mastersof-ai/harness` | Agent runtime, full system-prompt control, markdown→agent, TUI/web UI, Claude Agent SDK. | Out of scope. Runtime. |
| `@revealui/harnesses` | Commercial multi-agent **coordination** daemon (JSON-RPC/Unix-socket, `.claude/workboard.md`, pglite). 342 versions. | Mostly out of scope, but **2 small code ideas adoptable** (capability matrix, atomic write). Watch. |
| `poncho-ai` (GitHub) | Multi-tenant harness to **build+deploy shareable agents** (Slack/Telegram/web, V8 isolates, Postgres). | Out of scope. Deploy-an-agent platform. Uses `AGENT.md`+`skills/` (agentskills.io) — ecosystem signal. |
| `ai-harness-kit` | 企业级 (enterprise) AI agent toolchain — multi-agent, workflow-gen, **predictive cost analysis**, dashboard. 2 versions. | Out of scope (agent-dev platform). One note: predictive cost analysis vs `report`'s cost panel. |

### B. Tool-agnostic context scaffolders — aih's `scaffold`/`bootstrap-ai`/`init` neighborhood
| Package | Promise | vs aih |
|---|---|---|
| `@dzhechkov/harness-cli` | **"Package-manager + cross-compiler for your AI harness."** One `CanonicalSkill` → 6 agent targets; `benchmark` (A–F, 20 checks/skill); reward-learning. **130 versions, most active.** | aih's closest tool-agnostic peer (for *skills*). **A–F per-skill benchmark is adoptable.** Watch. |
| `@blazity-atlas/ai-harness` | Config-driven doc harness. `.ai/config.json` source-of-truth, named templates (standard/library/app/monorepo/agency), `doctor --fix --force`, managed-blocks. From Blazity (real agency). | Genuine near-peer, smaller scope. **Config-as-truth + templates + dirty-worktree gate adoptable.** Watch. |
| `@appautomaton/automaton` | Portable stage-gated harness (frame→plan→execute→verify), durable `.agent/` state surviving context limits, installs across Claude/Codex/OpenCode, copy-based+refreshable. | Workflow-discipline + context-persistence layer. Overlaps `scaffold` loosely. Mostly ECC/Superpowers territory. |
| `agent-project-sdlc` | "Minimal Context Harness." `project_context/**` facts + `AGENTS.md` router + **`validate-context` CI gate** (`context.toml`). Honest positioning table. | Real peer to `scaffold`+`bootstrap-ai --verify`. **`validate-context` content-gate adoptable.** Watch. |
| `@francove/create-ai-harness` | Zero-dep `npx` scaffolder → `.ai/` + `AGENTS.md`; **`metrics` context-bloat scoring** (line budgets), placeholder-sentinel regen, context-map routing index. | Thin but **`metrics` budget rubric is adoptable.** Solo/hobby. Low watch. |
| `create-ai-harness` | Scaffold a *personal* AI harness (context, guardrails, eval loops). | Thin personal scaffolder. Nothing novel. |
| `@belt/cli` | Project scaffolding + AI harness for Claude Code (brainstorm, monorepo). 0.1.2, stale (Jan 2026). | Thin, early, stale. Pass. |
| `@piwero/ai-harness-cli` | "Composable AI agent harness framework for OpenCode", multi-provider. | OpenCode-specific, small. Pass. |
| `unity-harness-init` | Unity/C# AI dev framework implementing **Anthropic's Planner-Generator-Evaluator paper** + Copilot `/fleet`, snapshot/rollback. | Domain-specific (Unity). **Cross-platform Copilot hook schema + no-edit reviewer role adoptable.** Watch. |
| `@prata.ma/anvil-ai` | Library (not CLI) of shared parsers/helpers for "governed workspaces" — skill discovery, agent/command md parsing, `detectInstalledAgents`. | Utility lib; we'd build our own. Reinforces declarative-registry idea. Pass. |

### C. Diagnostics / lint / scoring — aih's `doctor`/`report` neighborhood (the richest vein)
| Package | Promise | vs aih |
|---|---|---|
| `@paniolo/scan` | **"AI Technical Debt Scanner"** — diagnostic-only CLI scoring a repo's AI harness across **8 dimensions** (0–100, grade bands), ~100 **evidence-graded** rules. | **No aih equivalent.** Strong adopt for `doctor`/`report`. Category leader. Watch. |
| `@razroo/isolint` | **Lint+rewrite AI-harness markdown so weak models can run it.** 28 deterministic + 5 LLM + 18 perf rules; per-tool-load-group token `cost --budget`; SARIF; gitignore-aware. | **Highest-value peer.** Multiple adoptables for `report`/`doctor`/`bootstrap-ai`. Verdict: **adopt.** |

### D. Multi-tool detection / MCP config
| Package | Promise | vs aih |
|---|---|---|
| `@canonical/harnesses` | **Declarative harness registry** (detection signals + MCP config read/write, JSON+TOML, confidence scoring, undo/transactional). From Canonical (`pragma` monorepo). | **Declarative-registry pattern is adoptable.** Backs aih's `mcp`+`--detect`. Watch. |
| `@dcyfr/ai-cli` | Portable CLI for the "DCYFR AI harness" (security/threat-intel vendor; TLP clearance metadata). | Vendor-specific. Pass. |

### E. Workflow-discipline harnesses (execute the agent loop)
| Package | Promise | vs aih |
|---|---|---|
| `@feneto/lh` (LeanHarness) | Brownfield Specify→Discover→Build→Check, bounded change boundaries, **CaveBus compression**, **risk-gates + 4-tier command lexicon**, verification evidence. Well-engineered (SLSA, vitest). | Different category (runs agent hosts) but **rich guardrail/governance plumbing is adoptable.** Verdict: **adopt.** Watch. |

---

## What aih owns that NO peer touches (the moat)

| aih capability | Peers that do this |
|---|---|
| Corporate-proxy **TLS-trust extraction + propagation** (`certs`, `heal --ca-pattern`) | **None.** Zero. |
| **Local-inference hardware tuning** (`hardware` — CPU/RAM/GPU → quant + Ollama/llama.cpp env) | **None.** |
| **VDI** detection + cache/SQLite redirection (`vdi`) | **None.** |
| **OpenTelemetry** + redacting collector (`telemetry`) | **None.** |
| Verified **cross-platform** (Win/Linux/macOS on real metal) | Almost all are Unix-only / `/proc`-dependent / bundled-`dist`-only. |
| **Multi-repo workspace** + cross-repo blast-radius graph | None (revealui does single-repo multi-*agent* coordination — different axis). |
| Breadth: **11 CLIs** incl. Kiro-native steering/hooks | dzhechkov (6 targets) is closest; most do 1–3. |

**Strategic gap to close (no peer data, but on-brand to deepen):** aih's CA propagation covers npm/pip/cargo/conda. Extend to **git, Docker daemon, JVM `cacerts`/keytool, gradle, maven, Go, and the `NODE_EXTRA_CA_CERTS` vs `SSL_CERT_FILE` matrix.** This is the most differentiated surface aih has — widen the lead.

---

## Ranked adoption shortlist (the actual deliverable)

### Tier 1 — Adopt (high value, on-brand)

**1. Declarative per-tool capability registry** — *from `@canonical/harnesses` (registry), `@revealui/harnesses` (TOOL_PROFILES + DEGRADATION_TABLE), `@razroo/isolint` (per-tool frontmatter schemas).* · maps to `mcp`/`sandbox`/`scaffold`/`bootstrap-ai`/`--detect` · **effort M · priority HIGH**
aih currently encodes its 11-CLI knowledge as implicit per-command branching. Centralize it into one typed table: `{ id, nativeEntryFile, configPath, configFormat(json|toml), mcpKey, hooks{supported,granularity,canBlock}, sandbox{modes}, supportsMcp/Skills/Worktrees, mcpScopes, maxContextTokens }`. canonical proves *"adding a tool = adding a data row, not writing code"* and adds **confidence-scored detection** (high/medium/low, sorted) — sharper than aih's binary `--detect`. revealui adds a **degradation table** `[tool][feature] = native|polyfill|absent` that generalizes aih's `mcp --mode offline|none` from branching into a lookup. aih *writes* these native files, so it owns ground truth that revealui/isolint have to guess at. **Note:** canonical handles **TOML** (Codex `config.toml`) with safe-parse + deep-merge + undo — verify aih's codex MCP/bootstrap path does TOML correctly.

**2. AI-harness quality SCORECARD for `doctor`/`report`** — *from `@paniolo/scan` (8-dim evidence-graded scorer), `@dzhechkov/harness-cli` (A–F per-skill benchmark).* · maps to `doctor`/`report` · **effort M–L · priority HIGH**
aih's `doctor` is fail-closed boolean. paniolo scores a harness across 8 weighted dimensions (`layering, sharing, discoverability, harnessWiring, maintainability, guardrails, session, deep`), each `round(passed/total×100)` with grade bands (**85=excellent / 70=good / 50=fair / else poor**), and — the rigorous part — **every rule carries provenance**: `evidence_level (E2–E4)`, `source_urls` (spec docs + arXiv), `verified_on` date, and `weak/normal/mature` test fixtures. Several paniolo checks (`adapter-thin-claude/copilot/gemini`, `adapter-points-to-shared`, `always-loaded-budget`) literally score *aih's own thin-bootloader + RULE_ROUTER architecture* — adopt them as a maturity score in `report`. dzhechkov's `benchmark` (A–F, ~20 deterministic checks per skill, "one bar") is the per-artifact analog.

**3. Lint aih's OWN generated markdown for weak-model safety** — *from `@razroo/isolint` (28 deterministic rules).* · maps to `doctor` check / optional `aih lint` / `bootstrap-ai --verify` · **effort M · priority HIGH**
aih *generates* RULE_ROUTER, per-CLI bootloaders, SKILL/INDEX, SETUP-TASKS — exactly the prose that weak/local models choke on. Lint it against isolint's deterministic rules (no LLM needed): `soft-imperative` (should→MUST), `taste-word` (drop "robust/seamless/holistic"), `ambiguous-deictic` ("the table above"), `enum-without-list`, `context-budget`, **`stale-link-reference` + `missing-file-reference`** (← directly validates RULE_ROUTER's `#[[file:…]]` refs and Kiro live-references), **`placeholder-leftover`** (← catches unfilled SETUP-TASKS `<insert X>` / TODO sentinels before commit). Self-dogfooding: aih's value *is* governed context, so it should ship the cleanest context.

**4. Per-tool-load-group token model + CI token-budget GATE for `report`** — *from `@razroo/isolint` (`cost.js`), `@francove/create-ai-harness` (`metrics`).* · maps to `report` (+ `track`/`usage`) · **effort M · priority HIGH**
`report` currently sums all native entry files. The correct per-turn cost is **the ONE tool's always-loaded bundle, not the sum** (Claude pays CLAUDE.md; Cursor pays its `alwaysApply` `.mdc`s). aih knows exactly which file each tool loads — isolint has to *guess* (it disclaims Cursor `alwaysApply`) — so aih can implement the "worst-case tool" headline *more accurately than the source*. Then add a gate: `aih report --token-budget N` exits non-zero when the worst-case bundle exceeds N, sitting right next to the drift gate. francove supplies the concrete shape (per-file line budgets, `good`/`needs-review` named-offender warnings, `chars/4` offline proxy).

### Tier 2 — Adopt (medium, strong fit)

**5. 4-tier command lexicon + risk-gates policy** — *from `@feneto/lh` (`commands.yml`, `risk-gates.yml`, **Apache-2.0**).* · maps to `sandbox` + `guardrails` · **effort S–M · priority HIGH–MED**
Lift feneto's `deny / ask / safe_read_only / safe_verification` command table (each pattern carries a human reason; spans npm/pnpm/yarn/bun/pip/poetry/cargo, fork bombs, `dd`/`mkfs`, `DROP DATABASE`, force-push) as the seed for aih's sandbox egress/exec policy and a guardrail command vocabulary. Add named **risk-gate categories** (`auth_rewrite, payment_logic, destructive_migration, public_api_break, security_sensitive_change`) keyed by path **and** command patterns — extends aih's existing CI license gate to change-category gates. **Defense-in-depth:** generate the deny set ONCE and project it into both the host's native `settings.json` `deny[]` *and* the sandbox (feneto does this across three layers).

**6. gitignore-honoring scan via git plumbing** — *from `@razroo/isolint` (`gitAllowlist`).* · maps to `report`/`secrets` · **effort S · priority MED**
`git ls-files --cached --others --exclude-standard -z` to scan only authoring source. aih compiles one canon into N generated per-tool copies; a naive walk **double-counts** source + every generated file in footprint/secrets scans. Correctness fix; reuses aih's `cmd /c` execFile seam.

**7. SARIF emission + `--since <ref>` changed-files filter** — *from `@razroo/isolint` (`report.js` SARIF 2.1.0, `git-diff.js`).* · maps to `doctor`/`secrets`/drift-gate · **effort M · priority MED**
Emit SARIF 2.1.0 from aih's gates → GitHub code-scanning annotations (aih already wires CodeQL). `--since origin/main` makes PR CI check only changed files. Squarely on-brand for the enterprise DevSecOps pitch.

**8. On-denial remediation hints** — *from `@feneto/lh` (every block emits the exact unblock command).* · maps to `doctor`/`bootstrap-ai --verify`/`sandbox`/`guardrails` · **effort S · priority MED**
When aih blocks or fails a verify, append the precise next command (`run: aih boundary allow <path>` style). Cheap, big UX win on every fail-closed surface.

**9. Config-as-source-of-truth + named repo templates + `doctor --fix --force` dirty-gate** — *from `@blazity-atlas/ai-harness`.* · maps to `init`/`doctor`/`scaffold` · **effort M · priority MED**
A `.aih/config.json` (`schemaVersion`, template, `artifactRoot`, `paths`) lets re-runs/`doctor` read intent from one place instead of re-deriving from flags. Offer named repo-shape templates (library/app/monorepo). Gate auto-repairs behind `--force` when the git worktree is dirty (blazity's `doctor --fix --force`).

### Tier 3 — Adopt (small polish)
- **10. Content presence-checks + `validate-context` gate** (*francove `metrics`; `agent-project-sdlc`*) — beyond drift, assert required guardrail sections actually *exist* in generated canon; numeric line budgets. `bootstrap-ai --verify`/`doctor`. **S**
- **11. Numeric validation/retry budget in canon templates** (*francove `testing.md`: "run once, max 2 retries, warnings-only ≠ failure"*) — anti-infinite-loop governance clause in Layer-2 canon. **S**
- **12. CaveBus protected-token preservation invariant** (*feneto/lh `protected.js`*) — for `crispy`/`report` compression, re-extract file-paths/commands/risk-notes from source and assert none were dropped. **M**
- **13. `redactSecrets()` at the source** (*feneto/lh*) — small high-signal pattern set (`sk-*`, `ghp_*`, `AKIA*`, `BEGIN PRIVATE KEY`, `TOKEN=`/`SECRET=`) applied before any `telemetry`/`report` log is written, complementing the Bindplane redactor. **S**
- **14. Cross-platform Copilot hook emission** (*unity-harness-init*) — when targeting copilot, emit `.github/hooks/*.json` in Copilot's native schema with the `{command, windows}` sibling-key for POSIX-vs-cmd.exe. Matches aih's cross-platform posture + your known `.cmd`-shim Windows gotcha. **M**

---

## Explicitly NOT adopting (redundant or out of scope) — with reasons

- **All agent runtimes** (`agentic-flow`, `deepagents`, `engram`, `pmm-ai`, `@mastersof-ai`, `poncho`, `ai-harness-kit`): they execute LLMs; aih provisions the environment they run in. aih should *target* them, not become them.
- **revealui daemon/dispatch/workboard + round-trippable markdown state file**: redundant with aih's managed blocks + `report --open` dashboard + `.aih-workspace.json`. (Also: revealui's lock uses a **busy-wait spin on `Date.now()`** — a CPU-pegging anti-pattern; do **not** copy.)
- **francove two-tier lifecycle + placeholder-sentinel**: redundant with aih's managed blocks + write-once `project-guardrails.md` + deep-merge.
- **isolint `validate-rewrite` structural self-check**: largely redundant with aih's transactional rollback + drift gate.
- **`chars/4` token proxy**: keep ONLY as the offline fallback for `report --token-budget` on locked-down/no-network corporate boxes — never as a replacement for real measurement.
- **revealui atomic temp+rename / PID-lock**: marginal hardening; aih's transactional rollback already covers the failure mode. Optional S-effort polish at most, not a priority.

---

## Watch list (real peers to track over time)

1. **`@razroo/isolint`** — highest. Genuinely engineered (SLSA provenance, regression-tested fix-monotonicity, in `razroo/iso` monorepo). Different category (prose linter + small-model plan runtime) but directly sharpens `report`.
2. **`@dzhechkov/harness-cli`** — most active (130 versions). "One canon → many platforms" is aih's tool-agnostic thesis applied to skills; A–F benchmark. Track for convergence toward provisioning.
3. **`@paniolo/scan`** — the AI-harness-scorer category leader; evidence-graded rigor aih should match.
4. **`@canonical/harnesses`** — declarative registry done right; backed by Canonical.
5. **`@blazity-atlas/ai-harness`** — config-driven near-peer from a real agency (Blazity); closest design philosophy to aih at smaller scope.
6. **`@feneto/lh`** — well-built workflow harness; richest guardrail/command-policy lexicons (Apache-2.0, liftable).
7. **`@revealui/harnesses`** — commercial multi-agent coordination; watch if it grows a provisioning/`--detect` layer. (README over-claims vs `dist` — trust the code, not the marketing.)

---

## Confidence & gaps
- **Code-level deep-dive (high confidence):** isolint, paniolo, canonical, revealui, francove/create-ai-harness, feneto/lh, unity-harness-init, blazity, deepagents.
- **README + structure + partial code (good confidence):** dzhechkov, automaton, anvil, agent-project-sdlc, poncho.
- **Promise-level, screened out as out-of-scope runtimes/thin (sufficient):** agentic-flow, engram, pmm-ai, mastersof-ai, dcyfr, belt, piwero, ai-harness-kit.
- A parallel deep-dive workflow hit a **transient server-side rate limit** on the runtime/thin packages; those were screened at promise level (correctly — they're out of scope), so no adoption signal was lost. The remarkable subset all received code-level reads.
