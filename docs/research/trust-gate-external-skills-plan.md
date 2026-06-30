# Trust Gate for External Repos + Skills — Implementation Plan

**Date:** 2026-06-30
**Status:** proposal (lead-architect design, hardened over 4-lens adversarial critique)
**Scope:** a NEW `aih` capability (acquire an external GitHub repo + promote its skills into a workspace) and the pre-acquire trust gate that fronts it.
**Method:** multi-round research workflow — 5 named scanners researched against primary sources + independently verified, 4 context lanes (threat model, provenance/adjacent scanners, verdict UX, ecosystem precedent), then synthesis → 4-lens critique (red-team, aih-conventions, Windows/egress feasibility, UX/adoption — all found critical gaps) → hardened final.

## Verified external scanners (primary-source confirmed)

- **NVIDIA SkillSpector** — _confirmed_, rec: `integrate-optional` — github.com/NVIDIA/SkillSpector — install: `uv tool install git+https://github.com/NVIDIA/skillspector.git` (CLI binary `skillspector`); MCP mode: `skillspector mcp [--transport http --host 127.0.0.1 --port 8000]`
- **Cisco AI Defense Skill Scanner (cisco-ai-skill-scanner)** — _confirmed_, rec: `integrate-optional` — PyPI: cisco-ai-skill-scanner (pip install cisco-ai-skill-scanner / uv pip install cisco-ai-skill-scanner). Repo: github.com/cisco-ai-defense/skill-scanner. Extras: [bedrock],[google],[vertex],[azure],[all]. CLI binary: skill-scanner.
- **Snyk Agent Scan (snyk-agent-scan)** — _confirmed_, rec: `borrow-ideas-only` — PyPI: snyk-agent-scan (v0.5.12). Repo: github.com/snyk/agent-scan. Run: `uvx snyk-agent-scan@latest` or `pip install snyk-agent-scan`.
- **AgentShield (npm: ecc-agentshield; bin: agentshield) — by affaan-m / Affaan Mustafa, part of the "Everything Claude Code" (ECC) ecosystem** — _confirmed_, rec: `borrow-ideas-only` — npm: ecc-agentshield (run `npx ecc-agentshield scan`; or `npm i -g ecc-agentshield`, bin `agentshield`). Repo: github.com/affaan-m/agentshield. Action: affaan-m/agentshield@v1. GitHub App: github.com/apps/ecc-tools. Org/name mismatch to flag: package is `ecc-agentshield` but repo is `affaan-m/agentshield` (there is no "ECC"/"easy-claude-code" GitHub org).
- **Invariant MCP-Scan (mcp-scan) — now Snyk Agent Scan (snyk-agent-scan)** — _confirmed_, rec: `borrow-ideas-only` — Repo: github.com/snyk/agent-scan (formerly invariantlabs-ai/mcp-scan). Current package: PyPI `snyk-agent-scan` via `uvx snyk-agent-scan@latest`. Legacy redirect: PyPI `mcp-scan` (`pip install mcp-scan` / `uvx mcp-scan@latest` forwards to snyk-agent-scan). Historical pre-acquisition pin still resolvable via `uvx mcp-scan@<old-version>`.

> All five exist. Three (Invariant mcp-scan → Snyk agent-scan) are the same lineage. `AgentShield` is `npm: ecc-agentshield` by affaan-m — there is no "ECC"/"easy-claude-code" GitHub org; and in this repo it is referenced as printed doc text only (NOT execution-wired). See §5.

---

# Trust Gate for `aih workspace add` — Acquiring External Repos + Skills (FINAL, hardened)

**Status:** final lead-architect design (revised to resolve all four critique lenses)
**Scope:** a NEW capability (`aih` acquires an external GitHub repo and promotes its skills into a workspace) and the pre-acquire trust gate that fronts it.
**Grounding:** every aih primitive cited is verified against source read for this revision — `gradeVerdict`/`resolvePosture` (posture.ts:98-114, 71-92), `postureGradeCheck` (governance.ts:10-24, confirmed warn→`pass`/`code:undefined`), the closed `CheckCode` union + the "1:1 emitter, never derive from detail" rule (verify.ts:7-59), `executePlan`'s ordering — **`txn.commit()` and exec run before probes, and probes run only under `ctx.verify`** (execute.ts:289-323), `assertContained` realpath containment (execute.ts:51-69), the **exec-under-`--apply` clone precedent** in ECC (ecc/index.ts:65-118, `AIH_ECC_REF` as the supply-chain pin), `WIN_CMD_SHIMS`/`execArgv` (tools/install.ts:179-183), the AgentShield **doc-text-only** reference (ecc/install.ts:138-141) consumed via a **user-produced** `.aih/guardrail-scan.json` (report/guardrail.ts:8-49), `evaluateMcpPolicy` + risk axes (policy.ts, servers.ts:37-54), `secretProbes` precompute-then-carry (probes.ts), the lint `skipIntervals` canon-authoring exclusions (rules.ts), `reportToSarif` (sarif.ts:21-23), the workspace parent-only / "does NOT clone" boundary + path-safety rules (workspace/index.ts, docs/research/federated-workspace-implementation-plan.md), and `OrgPolicySchema` `.strict()` (org-policy/schema.ts).

> **The two load-bearing corrections this revision makes, up front, because the rest depends on them:**
> 1. **A clone contacts the network and a probe cannot.** Acquisition is therefore **not** a single `plan()` of probes. It is the ECC pattern: clone/checkout are **`exec` actions gated on `--apply`**; the scan is **probes over the already-on-disk quarantine tree**. URL-mode scan is inherently an `--apply` operation; dry-run cannot fetch.
> 2. **The engine grades fail-open at vibe and commits writes before probes.** So (a) critical trust tells must be emitted as unconditional `fail` and graded through a **new dedicated grader, not `postureGradeCheck`'s warn→pass path**, and (b) promotion is a **separate, second `executePlan`** guarded by the first phase's verdict — never the same plan.

---

## 1. Problem & threat model

Today `aih workspace` is **parent-only and never clones** (workspace/index.ts; federated plan: "`aih workspace` is parent-only … It does NOT clone today"). The new capability — fetch a third-party GitHub repo and promote its skills into a workspace — adds the single most dangerous thing a coding harness can do: **import code and model-readable instructions that execute with the user's privileges.** Anthropic's own posture: plugins/marketplaces "can execute arbitrary code on your machine with your user privileges" and Anthropic "doesn't verify" their contents. The acquisition flow MUST be born with a gate in front of it.

### Attack surface (artifact classes)

| # | Artifact | Why it's dangerous |
|---|----------|--------------------|
| 1 | **Auto-loaded instructions** — `SKILL.md` body **+ YAML frontmatter `description`/`name`**, `agents/*.md`, slash-command defs, `CLAUDE.md`/`AGENTS.md` | The model reads these as instructions. The frontmatter `description` loads into the system prompt at *discovery* — before the skill is invoked. |
| 2 | **Auto-executing config** — `.claude/hooks`, `settings.json` hooks, `allowed-tools: Bash(*)`, `permissionMode: bypassPermissions`, leading-`!` dynamic-context commands, npm lifecycle scripts | Runs without a prompt. Reversec demonstrated `allowed-tools: Bash(*)` + a `!`-prefix line spawning a reverse shell the user never sees. |
| 3 | **MCP config** — `.mcp.json`/`mcp.json` servers (npx/uvx runtime download, remote URLs) | Tool poisoning (hidden `<IMPORTANT>` in a tool description) + rug-pull (description mutates after approval). |
| 4 | **Bundled scripts** the skill shells out to | Snyk ToxicSkills: skills *with* executable scripts are **2.12×** more likely to be vulnerable. |
| 5 | **Ordinary supply chain** — `package.json`/`requirements`, **lifecycle scripts**, lockfiles, secrets | Shai-Hulud worm (500+ npm pkgs via postinstall in *published, pinned* versions), dependency confusion, typosquats. |

Measured, not theoretical: Snyk ToxicSkills found **36% of 3,984 ClawHub skills** had ≥1 flaw, prompt injection in 91% of confirmed-malicious; SkillSpector's corpus: **26.1% vulnerable, 5.2% likely malicious**. Barrier to publish a malicious skill: one `SKILL.md` + a one-week-old GitHub account.

### Threat classes

- **Prompt injection in auto-loaded context** (OWASP LLM01 / Agentic ASI01). arXiv 2510.26328: skills are "fundamentally insecure"; injection works "whether in the description or the body."
- **Auto-execution** via hooks / permission frontmatter / lifecycle scripts (code exec at user privilege).
- **MCP tool poisoning + rug-pull** (Invariant Labs; CVE-2025-54136).
- **Data exfiltration** (the convergent end-goal).
- **Classic supply-chain compromise** (typosquat, dependency confusion, malicious *transitive/pinned* dep).
- **Rug-pull on a pinned-but-stale source** (tj-actions/changed-files, CVE-2025-30066 — 350+ tags repointed, secrets from 23,000+ repos in 24h).
- **Checkout-time code execution** via git's own extension points (submodules, clean/smudge filters, `core.hooksPath`, LFS) — the reason we do **not** treat a clone as inert file-writes (see §3, §6).

### What static scanning CAN and CANNOT catch — the gate's honest scope

Three tiers. This honesty is load-bearing and the critiques sharpened it:

- 🟢 **GREEN — reliably static, in-repo, low-noise (the gate denies on these at ALL postures):** hidden Unicode-Tag / zero-width runs; Base64 blobs in markdown; auto-exec frontmatter keys (`Bash(*)`, `bypassPermissions`, `!`-prefix); **any** npm lifecycle script present (`preinstall`/`install`/`postinstall`/`prepare`/`prepublish`/`prepublishOnly`); a reverse-shell pattern in a bundled script; **direct-dependency NAME tells** — dependency-confusion (internal scope) and typosquat distance against a curated popular-package list (names *are* in the repo); a symlink/hardlink escaping the tree; a mutable git ref with no resolved SHA.
- 🟡 **AMBER — partially static (warn, plus a runtime recommendation):** vendored/repo-local MCP tool-description poisoning (catchable); unverifiable publisher/origin (allowlist + attestation absence). A *hosted* server's live schema is **not in the repo at all**.
- 🔴 **RED — NOT statically catchable; the gate must explicitly hand off to runtime, and must NOT imply it covers these:** **transitive-dependency malice and pinned-but-malicious deps** (the dangerous postinstall lives in the *dependency*, not the repo — reading the repo's own `package.json` cannot see it; the Shai-Hulud case); **hosted-MCP rug-pull** (the trusted schema lives at the vendor URL — there is no artifact to hash, ever); indirect prompt injection via runtime untrusted data; "sleeper" deps that activate only under specific env.

The arXiv finding kills semantic "is this instruction malicious" detection: **"instruction-detection approaches fail since Agent Skills are all instructions."** The gate targets **syntactic/capability tells**, never intent. The universal caveat — printed, not implied — **"no findings ≠ safe."** A clean static pass is *absence of known patterns*. The gate's output always cites *why* (finding + CheckCode + tier + which analyzers actually ran), never an inflated single number (the Scorecard/VirusTotal trap), and **names degraded coverage when an optional detector did not run** (§5).

---

## 2. Design principles

1. **Read-only scanner / never-execute-untrusted-code.** The *scan* is `probe()`s (plan.ts:9-29, 61-65) reading the already-on-disk quarantine tree. It MUST NOT `npm install`, run any lifecycle script, `npx`/`uvx` an MCP server to enumerate tools, or fetch the skill's URLs — exactly the trap that bites Snyk agent-scan ("Scanning MCP configurations will execute the commands defined in them"). The only network/disk side effects are the **explicit `exec` fetch** (§3 step 3) and the **explicit promote writes** (§3 step 8) — both `--apply`-gated, both isolated.
2. **Fail-closed by danger, not by absence.** A *proven-dangerous* finding is a `fail` that flips exit at **every posture** (§4). A `skip` (tool/artifact/network absent) **never** fails a fresh repo (verify.ts). No `.mcp.json` → `skip`. **A parse error on frontmatter/manifest is a `fail`, not a skip** (fail-closed on unparseable input — §4 check B/E).
3. **Defense-in-depth, two-control split** (the alert-fatigue fix). Five analyzer families compose; their findings route to **two** governance controls by base-rate — see §4. Proven-and-rare attacks deny at team+; unverifiable-origin and common-AMBER advise.
4. **TOFU + pin-to-SHA, fetched as a tarball.** Trust-on-first-use, pinned to a full 40-char commit SHA. **Default fetch is the GitHub tarball-at-SHA, not `git clone`** — chosen on *security* grounds: no `.git`, hence no submodule/smudge/`core.hooksPath`/LFS checkout-time execution surface (§6). Record the SHA + per-artifact content hashes; re-scan on every digest change.
5. **Re-scan on update; be precise about what each surface catches.** SHA-pinning alone is "a comforting lie." Trust is **per-commit**. `aih doctor` (read-only, local) re-hashes the **promoted on-disk artifacts** and catches **local tampering only**. **Upstream rug-pull (tag repoint) is caught only by `aih trust verify`**, which does an explicit opt-in `git ls-remote` of the ref and compares to the pinned SHA (cheap, no clone) — and a full tarball re-fetch + re-hash on demand. `doctor` does **not** claim to catch upstream rug-pulls.
6. **Honest verdicts with an explicit Verdict-model mapping.** aih `Check.verdict` is `pass|fail|skip`; SARIF is `error|note`. There is **no** `warn` verdict in a Check. The mapping is stated, not implied (§4): a deny-grade finding → `Check{fail}` → SARIF `error` → blocks; an advisory-grade finding → `Check{pass}` with `warning-only (…)` detail → SARIF `note` → **promotes silently, no interactive ack**. We add **no** new interactive "install anyway?" seam — the engine has none and we won't pretend it does.
7. **Two trust axes, kept separate.** **publisher/source** ("is `owner/repo@sha` approved?") vs **artifact** ("is this exact commit content-clean?"). Provenance proves *origin*, not *safety* — a signed source clears `trust.unsigned-source` but still must pass content scans. These ride **different controls** (origin = advisory; content-danger = team-deny), which is exactly why the §4 publisher/signing rows are warn/warn/deny while the malicious-code rows are deny/deny/deny.
8. **Deny what you can prove in-repo; hand off what only runtime can see.** GREEN → genuine pre-acquire deny. AMBER/RED residue → advisory + a concrete runtime recommendation (least-privilege `permissions.deny: [Bash(*)]`; runtime `npm install --ignore-scripts` + audit in a sandbox; a runtime MCP-scan with tool-pinning-by-hash *before first use* for any hosted server).

---

## 3. The acquisition + gate flow (two phases, exec-fetch + probe-scan + guarded promote)

The gate is a precondition **on** the acquire feature. It is **two `executePlan` calls**, because the engine commits writes/execs before probes and never couples writes to a report (execute.ts:289-323).

```
aih workspace add <owner/repo> [--pin <sha>] [--ref <branch|tag>] [--apply] …
        │
   (1) RESOLVE SOURCE  (no network) ──────────────────────────────────
        │   parse owner/repo (+ optional ref); consult approved-source
        │   allowlist (org-policy) BEFORE any network op. Off-list →
        │   trust.untrusted-publisher (ADVISORY control: warn/warn/deny).
        │
   (2) PIN TO SHA  (exec: `git ls-remote`, --apply-gated) ────────────
        │   resolve <ref> → full 40-char SHA. spawnError/127/timeout →
        │   trust.fetch-blocked (SKIP, never fail — egress-blocked box).
        │   mutable ref, no SHA → trust.unpinned-dependency.
        │
   (3) FETCH INTO QUARANTINE  (exec: tarball-at-SHA, --apply-gated) ───
        │   gitignore precondition write FIRST (both plain + --git paths),
        │   THEN download the GitHub tarball at <sha> and extract into a
        │   path OUTSIDE the workspace-scanned root (OS temp, e.g.
        │   $TMPDIR/aih-quarantine/<owner>-<repo>-<sha8>/).
        │   NO .git, NO install, NO lifecycle script, NO MCP spawn.
        │   Post-extract: reject zip-slip / any path escaping the root;
        │   reject symlinks/hardlinks (realpath via assertContained logic).
        │
   (4) SCAN  (PHASE 1 — forced verify=true, probes ONLY, no writes) ──
        │   A. instruction/prompt-injection lint  (NEW src/trust/lint.ts)
        │   B. auto-exec/permission detector       (NEW, structural parse)
        │   C. incoming-MCP classifier + policy    (NEW classifier → reuse evaluateMcpPolicy)
        │   D. secret scan over the tree           (REUSE scanSecrets/scanConfigSecrets)
        │   E. manifest tells + dep-NAME checks     (NEW, structural parse)
        │   (optional) external detectors          (presence-gated, Docker-default)
        │
   (5) GRADE ─────────────────────────────────────────────────────────
        │   proven-danger → gradeTrustDanger(...) (NEW grader, denies at
        │     ALL postures); origin/AMBER → gradeVerdict(..,"trust-origin")
        │   → Check{verdict, code:trust.*, location, fingerprint(+contentHash)}
        │   accumulated in a VerificationReport → reportToSarif() for free.
        │
   (6) DECIDE  (in the COMMAND wiring, not executePlan) ──────────────
        │   block = report has any fail whose fingerprint is NOT covered
        │     by an acknowledgement bound to the CURRENT content hash AND
        │     whose code is NOT on the non-overridable denylist.
        │
   (7) STOP or PROCEED ───────────────────────────────────────────────
        │   blocked → print copy-pasteable `--acknowledge a,b,c` cmd; exit≠0.
        │   clear   → continue to phase 2.
        │
   (8) PROMOTE  (PHASE 2 — second executePlan, writes only) ──────────
            copy ONLY the skills into the workspace (symlink-free copy);
            record source + sha + content hashes + verdicts + acks in the
            trust lockfile. Discard the quarantine tree.
```

### Why two phases, concretely (the critique's #1 critical)

`executePlan` stages writes, runs `txn.commit()` (execute.ts:~289), runs `exec` actions, and **only then** runs probes — and **only if `ctx.verify`** (execute.ts:317). A single `plan()` therefore *cannot* gate a promote: by the time a probe verdict exists, the writes are already on disk, and a plain `--apply` with no `--verify` runs zero probes. So:

- **Phase 1** is one `executePlan` with **`verify: true` forced on** and a plan whose actions are *the exec fetch (steps 2-3) + probes only (step 4)* — **no `write`/`doc`/`envblock` skill-promotion actions**. It produces the `VerificationReport`. A test asserts the phase-1 plan contains **no write/doc actions that target the workspace** (only the gitignore precondition + quarantine fetch exec + probes).
- **The command wiring** (not `executePlan`) evaluates the verdict (step 6).
- **Phase 2** is a *second* `executePlan` with the promote `write` actions, invoked **only if** phase 1 cleared. `aih workspace add` sets **`alwaysVerify: true`** (mirroring `plan.ts` `alwaysVerify`) so `--apply` can never skip the gate.

This also resolves a silent footgun: **`aih trust scan <url>` cannot run in dry-run** (no exec runs without `--apply`, so nothing fetches). URL-mode scan is inherently an `--apply` fetch-then-scan; **`aih trust scan <local-path>` is the pure read-only / air-gapped entry point** that needs no network at all.

### Where each step touches aih's model

- **Steps 1-2:** new `src/workspace/acquire.ts`; allowlist read reuses org-policy precedence (org-policy/schema.ts). `ls-remote` is an **`exec`** (the only kind that may contact a remote to *read* — exec "must never contact a remote system" is about *mutation*; ECC already relies on exec-read for clone/fetch, ecc/index.ts:65-118).
- **Step 3 (quarantine):** an **`exec`** tarball fetch + extract, preceded by a gitignore precondition **`write`** (the only workspace write in phase 1, and it only adds an ignore rule). Quarantine root is **outside** any `.code-workspace`/IDE-scanned path (OS temp), so a dropped `.mcp.json`/hooks file is never auto-discovered by a client.
- **Step 4 (scan):** `ProbeAction`s. The secret probes follow the precompute-at-plan-build / return-verdict pattern of `secretProbes` (probes.ts) — the scan reads disk once at plan-build, the probe carries the verdict — but with **root = the quarantine dir** (a new caller-supplied root; `scanSecrets`/`scanConfigSecrets` take a root, so this is new *wiring*, accounted as such in §5/§8).
- **Step 5 (grade):** see §4 for the two graders.
- **Step 8 (promote):** `write` actions in a second plan. Respects the **parent-only / explicit-opt-in** boundary — promotion is an *explicit* `aih workspace add`, the kind of opt-in the federated plan reserves (the future `aih workspace init-children` shares this same gate seam — §9 Q3).

---

## 4. The gate's checks — TWO controls, an explicit verdict mapping, and a danger grader

### Two new `GovernanceControl` members (the alert-fatigue + team-deny-contradiction fix)

The draft put everything on one `supply-chain` control and then *also* graded publisher/signing as warn/warn/deny — a direct contradiction (if the control is in the team-deny set, *every* finding on it denies at team). It also would have denied on every floating dep at the most common posture, training users to rubber-stamp. Fixed by splitting by base-rate:

```ts
// posture.ts GovernanceControl union — add TWO members:
| "trust-danger"   // proven-dangerous, low false-positive: deny at ALL postures
| "trust-origin"   // unverifiable origin / common AMBER: warn at vibe+team, deny at enterprise
```

- **`trust-danger`** carries: `trust.malicious-code`, `trust.prompt-injection`, `trust.hidden-unicode`, `trust.auto-exec-hook`. These are graded by a **new grader, NOT `postureGradeCheck`** (see below), so they deny even at vibe.
- **`trust-origin`** carries: `trust.unpinned-dependency`, `trust.untrusted-publisher`, `trust.unsigned-source`, `trust.source-drift`, and incoming-MCP `mcp.policy-denied`. These route through ordinary `gradeVerdict`, which already gives the intended warn/warn/deny (vibe=warn, team=warn since not in the team-deny set, enterprise=deny). **`trust-origin` is deliberately kept OUT of the team-deny set** so a box with no allowlist/attestation is not blocked on every add.

This makes "team-deny" mean *"something is actively trying to attack you,"* not *"this dep floats"* — the difference between a gate people trust and one they mute.

### The vibe fail-open fix — a dedicated danger grader (NOT `postureGradeCheck`)

Verified: `gradeVerdict("warn", anyControl, "vibe")` returns `"warn"`, and `postureGradeCheck` then rewrites a warn-grade `fail` to `verdict:"pass", code:undefined` (governance.ts:16-23) — so at the default posture a reverse shell exits 0 with a SARIF *note*. That is fail-open. Acquiring third-party executable code is categorically different from grading a repo's own canon (where warn-at-vibe is correct). So `trust-danger` findings **do not pass through `postureGradeCheck` at all**. They use:

```ts
// NEW: src/trust/grade.ts — proven-dangerous findings deny at EVERY posture.
// Does NOT consult `postureGradeCheck` (which downgrades warn→pass at vibe/team).
export function gradeTrustDanger(check: Check): Check {
  // check is already verdict:"fail" with a trust.* danger code; keep it failing.
  return check; // posture cannot soften a proven-dangerous trust finding
}
```

`trust-danger` findings are **emitted as `verdict:"fail"` unconditionally** and pass through untouched. Posture modulates only `trust-origin`/AMBER. **Locked by tests:**
- `gradeVerdict("warn","trust-origin","vibe") === "warn"` and `=== "warn"` at team, `=== "deny"` at enterprise (origin behavior).
- An emitter test: a `trust.auto-exec-hook` Check survives at `vibe` as `verdict:"fail"` with its `code` intact (proves no warn→pass downgrade) — i.e. `gradeTrustDanger` does not soften, and the danger path never calls `postureGradeCheck`.
- An exhaustiveness test that neither `trust-danger` nor `trust-origin` inherits the `risk-gates` advisory carve-out (both must be able to produce a real `fail`).

> **Honest answer to "is enterprise actually protected?"** Yes for `trust-danger` — it denies at every posture, so even a `--posture vibe` invocation or a vibe-floor org still blocks a reverse shell. For `trust-origin`, a **vibe-floor org genuinely has no deny** (only warns); that is the documented, uncomfortable truth (`--posture` only clamps *up* via the org floor). Enterprise gets full deny on both controls.

### Explicit Verdict-model mapping (the conflation fix)

| Grade | `Check.verdict` | SARIF | Exit | UX |
|-------|-----------------|-------|------|-----|
| `trust-danger` finding (any posture) | `fail` | `error` | non-zero | **blocks**; requires `--acknowledge` (unless on the non-overridable denylist) |
| `trust-origin` deny-grade (enterprise) | `fail` | `error` | non-zero | **blocks**; `--acknowledge` allowed |
| `trust-origin` warn-grade (vibe/team) | `pass` + `warning-only (<posture>): …` detail | `note` | 0 | **promotes silently** — no interactive ask (engine has none) |

There is no "warn → promote (acknowledgeable)" state. At vibe, origin/AMBER findings simply promote with a logged note; only `fail`s block.

### New sealed `CheckCode` members — trimmed, split, and introduced 1:1 with emitters

Per the verify.ts rule ("each member maps 1:1 to a real emitter; never derive from `detail`; sealed"), each code below ships in the **same PR as its emitter** (§8), not all at once. Changes from the draft's 8:

- **Dropped `trust.mcp-tool-poisoning`.** A tool *description* is markdown the model reads as instructions (the arXiv "all instructions" point) — it rides the **same** lint and emits `trust.prompt-injection` / `trust.hidden-unicode`, not a bespoke code.
- **Split `trust.unsigned-source`** into two distinct emitters a consumer can switch over: `trust.unsigned-source` (origin unverifiable *at acquire*) and **`trust.source-drift`** (content/SHA changed on re-verify — the rug-pull sibling of `mcp.allowlist-drift`).
- **Added `trust.fetch-blocked`** (skip-only) so an egress-blocked fetch is legible without flipping exit.
- **Added `trust.dependency-confusion` / `trust.typosquat`** — direct-dep NAME tells (GREEN, names are in the repo). `trust.unpinned-dependency` stays for floating ranges / `@latest` / missing lockfile.

```ts
// trust / supply-chain  (each introduced with its emitter PR)
| "trust.malicious-code"        // [trust-danger] reverse-shell pattern in a bundled script
| "trust.prompt-injection"      // [trust-danger] hidden instruction in SKILL.md/frontmatter/agent md/MCP description
| "trust.hidden-unicode"        // [trust-danger] Unicode-Tag / zero-width smuggling
| "trust.auto-exec-hook"        // [trust-danger] Bash(*) / bypassPermissions / !-prefix / npm lifecycle script
| "trust.dependency-confusion"  // [trust-danger] direct dep name in an internal scope
| "trust.typosquat"             // [trust-danger] direct dep name within edit-distance of a popular pkg
| "trust.unpinned-dependency"   // [trust-origin] floating range / @latest MCP / mutable git ref
| "trust.untrusted-publisher"   // [trust-origin] source not on approved-source allowlist
| "trust.unsigned-source"       // [trust-origin] no SHA pin / no attestation at acquire
| "trust.source-drift"          // [trust-origin] content/SHA changed on re-verify (rug-pull)
| "trust.fetch-blocked"         // [skip-only] ls-remote/tarball fetch blocked (egress/proxy) — never fails
```

Reuse existing codes where they fit: incoming-`.mcp.json` hardcoded creds → `mcp.hardcoded-secret`; on-disk plaintext secret → `secrets.plaintext-detected`; incoming-MCP risk → `mcp.policy-denied`.

### Check-by-check map

| Check | CheckCode | Control | Threat | Detection (read-only, over the on-disk tree) | Tier | vibe/team/ent |
|-------|-----------|---------|--------|-----------------------------------------------|------|---------------|
| **A1 hidden-unicode** | `trust.hidden-unicode` | trust-danger | Prompt injection via invisible chars | Unicode-Tag run >10 (U+E0000) OR sparse non-ASCII >100, over `SKILL.md`+frontmatter+agents+`CLAUDE/AGENTS.md` **including code fences, inline code, and HTML comments** | 🟢 | deny/deny/deny |
| **A2 prompt-injection** | `trust.prompt-injection` | trust-danger | Hidden instructions / exfil shapes | Base64 blob in markdown; `env-var + external URL` co-located; non-English-in-English. Syntactic only. **Whole-document scan, no skip intervals.** Also run over incoming MCP `description` fields. | 🟢 | deny/deny/deny |
| **B auto-exec** | `trust.auto-exec-hook` | trust-danger | Auto code-exec at user privilege | **Structural parse** of YAML frontmatter + `package.json` (zod over the parsed object): `allowed-tools` containing `Bash(*)` in any flow/quoted/aliased form, `permissionMode: bypassPermissions`, `dangerously-skip-permissions`, leading-`!` context cmd, `.claude/hooks`+`settings.json` hooks, **any** of `{preinstall,install,postinstall,prepare,prepublish,prepublishOnly}`, `.npmrc ignore-scripts=false`. **Unparseable input → `fail`.** | 🟢 | deny/deny/deny |
| **B2 malicious-code** | `trust.malicious-code` | trust-danger | Reverse shell / dangerous script | Optional Semgrep/YARA (offline, vendored rules) OR aih-native pattern set over bundled scripts | 🟢 | deny/deny/deny |
| **C1 mcp-injection** | `trust.prompt-injection`/`trust.hidden-unicode` | trust-danger | Vendored MCP description injection | A1/A2 lint over incoming server `description` fields | 🟡 | deny/deny/deny |
| **C2 mcp-policy** | `mcp.policy-denied` | trust-origin | Third-party egress / unpinned MCP | **NEW** `classifyIncomingMcp(rawServer)` derives the three axes from untrusted `{command,args,url,env}` (npx/uvx ⇒ unpinned/local; http url ⇒ third-party; literal token ⇒ credentials), THEN `evaluateMcpPolicy(classified, posture)` | 🟡 | warn/warn/deny |
| **C3 hosted-MCP** | `mcp.policy-denied` + RED advisory | trust-origin | Hosted rug-pull (undetectable) | Static: `egress:third-party`+`supplyChain:hosted-remote`. **No post-approval rug-pull protection exists** — emit a standing RED advisory + recommend a runtime MCP-scan with tool-pinning-by-hash before first use. Consider deny at team+ (no pin possible). | 🔴 | warn/warn/deny |
| **D secrets** | `secrets.plaintext-detected`, `mcp.hardcoded-secret` | (reuse) | Credential harvest | `scanSecrets`+`scanConfigSecrets` with **root = quarantine dir**; `secretProbes`/`mcpConfigSecretProbes` carry the verdict | 🟢 | (existing grading) |
| **E1 dep-name** | `trust.dependency-confusion` / `trust.typosquat` | trust-danger | Confusion / typosquat | Direct-dep **names** vs internal-scope set + popular-package edit-distance list | 🟢 | deny/deny/deny |
| **E2 unpinned-dep** | `trust.unpinned-dependency` | trust-origin | Supply-chain precondition | Structural parse for floating ranges / `@latest` / missing lockfile; mutable git ref w/o SHA | 🟢 | warn/warn/deny |
| **E3 transitive/pinned-dep** | *(no GREEN code)* | — | **RED — not catchable in-repo** | Stated as RED: hand off to runtime sandboxed `npm install --ignore-scripts` + audit. **Lockfile-present ≠ clean.** Never auto-install. | 🔴 | advisory only |
| **F publisher** | `trust.untrusted-publisher` | trust-origin | Untrusted source | Off org-policy allowlist (pre-fetch) | 🟡 | warn/warn/deny |
| **G signing** | `trust.unsigned-source` / `trust.source-drift` | trust-origin | Origin unverifiable / drift | SHA-pin always-on (exec). Optional `gh attestation verify` / `npm audit signatures` (absent OR egress-blocked → `skip`, never fail). Content-hash mismatch on re-verify → `trust.source-drift` | 🟡 | warn/warn/deny |

All findings ride `reportToSarif` (sarif.ts) unchanged: `fail → error`, `skip/pass → note`, with `location: { uri: <quarantine-relative path>, startLine }` and a **content-bound** fingerprint (see §7) — `trust-prompt-injection:<path>:<line>:<contentHash8>`.

---

## 5. Compose vs build — the 5 named tools (with the AgentShield correction)

**Verification gate first:** only tools the verifier confirmed exist. All five confirmed. Three are the same lineage (Invariant mcp-scan → Snyk agent-scan), collapsing the decision space.

> **Every external spawn is routed and sandboxed.** The "non-spawning gate sidesteps the Windows `.cmd` footgun" claim holds **only for the aih-native floor**. `uvx`, `docker`, `skillspector`, `semgrep`, `gh`, `npm audit` are **NOT** in `WIN_CMD_SHIMS` (`{npm,npx,yarn,pnpm,scoop}`, tools/install.ts:179). So: extend `execArgv` to wrap **any** non-`.exe` external shim on Windows (or add these names to the set), and **route every external spawn through `execArgv`**. Test: on `platform="windows"`, the runner argv for SkillSpector/semgrep/etc. starts with `["cmd","/c",…]`. The **Docker path is the DEFAULT** for any external detector (not just a Windows convenience) — it sandboxes the untrusted-tree read. **Every external spawn maps spawnError/127/timeout → `skip`** (network/tool-failure taxonomy, §below), never `fail`.

### NVIDIA SkillSpector — **OPTIONAL primary external detector** (presence-gated, Docker-default)
Confirmed: real, Apache-2.0, never executes the scanned skill (static regex/AST/YARA + opt-in LLM), native SARIF 2.1.0, clean exit-code contract. Call: `docker run --rm -v "<quarantine>:/scan" skillspector scan /scan --no-llm --format sarif` (offline, zero content egress — the LLM pass ships file contents, keep opt-in). Ingest the **SARIF** (stable; the CLI `--format json` schema differs from the MCP schema — do not key off flat JSON). Map `rule_id` → a **fixed lookup table** → `trust.*`. Absent → `skip` **and surface degraded coverage** (see below). aih's posture spine + closed taxonomy + SARIF emitter stay the system of record; SkillSpector corroborates.

### Cisco AI Defense Skill Scanner — **BORROW TAXONOMY + optional 2nd opinion**
Confirmed: PyPI v2.0.12, Apache-2.0, read-only for skills, SARIF, 8-category taxonomy. Borrow its **Unicode Steganography** + **Social Engineering** categories and command-taint-on-pipelines as the spec for A1/A2/B. Optional offline second opinion at team+. Not the gate (exit codes undocumented — verify empirically; beta; redundant with SkillSpector). Pin upstream, not a fork.

### Snyk Agent Scan — **BORROW IDEAS ONLY** (hard blockers)
Confirmed: PyPI v0.5.12. Skills scan is static **but requires `SNYK_TOKEN` + egress**, no SARIF, no GitHub-URL targeting. Fails aih's offline/air-gapped ethos. Borrow the issue-code taxonomy (E001/E004/E005/E006 + W021 hidden-Unicode). Its MCP path **executes servers** — out of the read-only gate.

### AgentShield — **BORROW TAXONOMY; net-new probe if wanted (NOT "already wired")**
**Correction:** AgentShield is **not** execution-wired in this repo. `src/ecc/install.ts:138-141` emits `npx ecc-agentshield scan` as **printed doc text** (a suggestion line), and `src/report/guardrail.ts:8-49` consumes a `.aih/guardrail-scan.json` the **user produces out of band** (guardrail.ts explicitly: "aih does NOT run the scan inline"). There is zero execution wiring. So its **threat taxonomy** (CLAUDE/AGENTS hidden-instruction, hook injection/exfil, `.mcp.json` poisoning/rug-pull, unrestricted-tools, secrets) is a ready-made spec to seed A/B — borrow it directly. Any real AgentShield probe is **net-new code**: a presence-gated read-only spawn on the quarantined tree (`scan --path <dir> --format json`, never `--fix`/`--opus`/online; CLI emits no SARIF at 1.4.0 → consume JSON, re-grade through aih's spine), routed via `execArgv`/`cmd /c`.

### Invariant MCP-Scan (= Snyk Agent Scan) — **BORROW IDEAS; NEVER in the read-only path**
Confirmed: now the same package; **it EXECUTES the scanned MCP servers** — the opposite of a read-only gate. Borrow two ideas: (1) rug-pull-by-hash / tool-pinning whitelist → adopt into `mcp.allowlist-drift` + the trust pin-store; (2) the issue-code taxonomy as vocabulary. Live MCP enumeration is a **separate, explicit, sandboxed, consent-gated opt-in** (Docker/VM) — never the default gate, never auto-pass `--dangerously-run-mcp-servers`.

### Network / tool-failure taxonomy (the egress-blocked-enterprise fix)
Enterprise is where egress is most likely blocked, yet it is the strict-deny tier. So a positive *finding* fails; a *failure to reach a tool or remote* does not:
- `git ls-remote`, tarball fetch, `gh`, `npm audit`, and **every** external detector: `spawnError | exit 127 | timeout` → emit `Check{verdict:"skip", code:"trust.fetch-blocked"}` (or the detector's skip code), **never `fail`**.
- `aih trust scan <local-path>` is the **documented air-gapped path** — no fetch, no detectors required, pure read-only over a local dir.

### Degraded-coverage signaling (the silent-skip fix)
"Detector absent" must not look like "detector ran clean." Each optional detector's skip carries a code and a prominent summary line: *"Deep scan SKIPPED — SkillSpector not installed; coverage is GREEN-tier only."* The "no findings ≠ safe" banner enumerates **which analyzers actually ran**. At **enterprise**, org-policy may mark a detector **required** (`trust.requiredDetectors`); a configured-but-absent required detector then **fails closed** rather than silently skipping.

### Summary call

| Tool | Confirmed | Call | How |
|------|-----------|------|-----|
| **SkillSpector** | ✅ | Optional primary external detector | `docker run … scan /scan --no-llm --format sarif`; map SARIF→`trust.*`; absent→skip+degraded-banner |
| **Cisco skill-scanner** | ✅ | Borrow taxonomy + optional 2nd opinion | offline; verify exit codes empirically |
| **Snyk Agent Scan** | ✅ | Borrow ideas only | token+egress+no-SARIF = no dependency |
| **AgentShield** | ✅ (doc-text only, NOT wired) | Borrow taxonomy; optional net-new read-only probe | `scan --path <dir> --format json`, no `--fix/--opus/online`, via `cmd /c` |
| **Invariant mcp-scan** | ✅ (=Snyk) | Borrow ideas only; never read-only path | rug-pull-by-hash + taxonomy; live scan = sandboxed opt-in |

**Reimplement using aih primitives (always-on floor, no external dep):** the prompt-injection/hidden-instruction lint (NEW `src/trust/lint.ts`, see §4), the structural auto-exec/manifest parsers, the incoming-MCP classifier, secret scanning (`scanSecrets`/`scanConfigSecrets` with a quarantine root), the SHA-pin + TOFU content-hash store, the two graders, and SARIF emission. **Floor = aih-native; SkillSpector/Cisco/Semgrep = optional corroborating amplifiers with explicit degraded-coverage signaling.**

---

## 6. Fetch hardening — tarball-at-SHA over `git clone` (resolved, on security grounds)

The draft left clone-vs-tarball as an open ergonomics question. **Resolved: default to the GitHub tarball at the pinned SHA.** Rationale is security, not size:

- A `git clone --depth 1 && checkout <sha>` of an attacker repo is **not inert file-writes**. Git's own extension points run at checkout under common configs: **submodules** (`.gitmodules` + `submodule.recurse`), **clean/smudge filters** (`.gitattributes` pointing at an in-tree script), **`core.hooksPath`/`core.fsmonitor`**, and **LFS smudge**. Pulling `.git` also leaves a hooks/config surface that fires the moment any later `git` command runs in the tree.
- The **tarball at SHA has no `.git`**, eliminating every one of those vectors. Re-verify simply re-extracts and re-hashes.
- **If** a tarball is unavailable (self-hosted GHE without the tarball endpoint), fall back to a **hardened clone**: `git -c core.hooksPath=/dev/null -c protocol.file.allow=never -c filter.lfs.smudge=cat -c filter.lfs.required=false clone --depth 1 --no-recurse-submodules`, with `GIT_LFS_SKIP_SMUDGE=1`, and **never run `git` inside the quarantine tree** afterward (and delete `.git/hooks`).
- **Scrubbed env + cwd jail for every fetch/detector spawn.** `proc.ts` `defaultRunner` passes the full process env with no allowlist; that discipline therefore lives in the trust module. Strip every `*_TOKEN`/`*_KEY`/`AWS_*`/`ANTHROPIC_*`/`GITHUB_*` from the child env and pin cwd to the quarantine dir before spawning git/tar/detectors.
- **Post-extraction containment:** reject **zip-slip** (any extracted path escaping the root) and reject **symlinks/hardlinks** outright (or copy with symlink-following disabled and report each as `trust.malicious-code`). Reuse the `assertContained` realpath logic (execute.ts:51-69) — resolve the deepest existing ancestor through `realpath`, reject any `..`/absolute/symlinked-parent escape — for **both** the extracted tree (so a hashing probe never follows a link out) and the promote copy (so no symlink lands in the real workspace).
- **Quarantine location:** the OS temp dir, **outside** any `.code-workspace`/IDE-scanned path, so a dropped `.mcp.json`/`settings.json`/hooks file in the untrusted tree is never auto-loaded by an editor while it sits there. The gitignore precondition still covers any in-`.aih` artifacts on both the plain-repo and `--git` workspace paths (`workspaceGitignorePatterns`).

---

## 7. Data model — committed allowlist + gitignored lockfile + a committed override ledger

### Committed: approved-source allowlist + required detectors (org-policy)

Extend `OrgPolicySchema` (`.strict()` at every level, org-policy/schema.ts) with a `trust` **sibling strict object** — committed, shared topology, mirroring Claude Code's `strictKnownMarketplaces`:

```ts
trust: z.object({
  // undefined = open (warn at vibe/team); [] = total lockdown; list = exact-match approved.
  approvedSources: z.array(z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    pinnedSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    hostPattern: z.string().optional(),               // self-hosted GHE/GitLab
  })).optional(),
  requireSignedSource: z.boolean().default(false),    // enterprise: deny unsigned
  requiredDetectors: z.array(z.enum(["skillspector","cisco","semgrep"])).optional(), // enterprise: fail-closed if absent
}).strict().optional(),
```

**Allowlist enforcement is a separate graded check** (`trust.untrusted-publisher` on `trust-origin`), **not** an automatic effect of the posture clamp. The clamp (posture.ts:83-90) only raises *posture*; it does nothing to `approvedSources`. (Draft's "inherits the clamp for free" was misleading — corrected.)

### Gitignored: trust lockfile (`.aih/trust-lock.json`) — local derived evidence

```json
{
  "schemaVersion": 1,
  "generatedBy": "aih workspace add",
  "sources": [{
    "id": "acme-skills",
    "owner": "acme", "repo": "skills",
    "url": "https://github.com/acme/skills",
    "pinnedSha": "bc781f96a4e2c0d1f5a8b3e7c9d2f1a4b6e8c0d2",
    "acquiredAt": "2026-06-30T20:00:00Z",
    "posture": "team",
    "analyzersRun": ["aih-native", "skillspector@docker"],
    "promotedSkills": ["pdf-export", "git-formatter"],
    "artifactHashes": {
      "pdf-export/SKILL.md": "sha256:…",
      "pdf-export/scripts/run.sh": "sha256:…"
    },
    "findings": [
      { "code": "trust.unpinned-dependency", "control": "trust-origin", "verdict": "pass",
        "detail": "warning-only (team posture)", "tier": "amber",
        "fingerprint": "trust-unpinned-dependency:pdf-export/package.json:0:9f2a1c4d" }
    ],
    "acknowledgements": [
      { "fingerprint": "trust-prompt-injection:.mcp.json:add:7b3e9a1f",
        "contentHash": "sha256:7b3e9a1f…", "by": "samartomar@gmail.com",
        "at": "2026-06-30T20:01:00Z", "reason": "vendored server, description reviewed" }
    ]
  }]
}
```

### Committed: override ledger for deny-grade acknowledgements

A gitignored, content-unbound ack is a silent skip→pass on a fresh machine that copies `.aih/`. So for **team/enterprise**, a deny-grade acknowledgement **must also persist in a committed, schema-validated artifact** — the natural home is the org-policy `approvedSources` pin itself (already committed and validated), recording `{owner,repo,pinnedSha,reason}`. The gitignored lockfile holds local derived state only. This satisfies team accountability without a free-text markdown ledger and without presenting local evidence as team-wide truth (federated plan evidence-honesty rule).

### `--acknowledge` — content-bound, bulk, with a non-overridable denylist

- **Content-bound fingerprints.** Every fingerprint includes a hash of the offending artifact: `trust-prompt-injection:<path>:<line>:<contentHash8>`. An ack stores the full `contentHash`. On re-verify the fingerprint is **re-derived from current bytes**, so any change at the same path:line **invalidates** the ack (true rug-pull defense; closes the pre-seed / stale-ack hole).
- **Mechanism (concrete, since the engine has no "acknowledged fail").** Before report accumulation, an acked fingerprint converts **that specific Check** to `verdict:"skip"` with detail `acknowledged by <who> at <when>` → SARIF `note`, exit stays 0 **only** for the exact acked fingerprint. A new/unacked finding still produces a `fail`.
- **Non-overridable denylist.** `--acknowledge` is **refused** for `trust.malicious-code`, `trust.auto-exec-hook`, `trust.prompt-injection`, `trust.hidden-unicode`, `trust.dependency-confusion`, `trust.typosquat` (all `trust-danger`). A reverse shell cannot be acked into a promote. `trust-origin` deny-grades (enterprise) remain overridable with a reason.
- **Usable.** Supports `--acknowledge <fp1,fp2,…>` and `--acknowledge-all --reason <text>` (records every enumerated fingerprint). On a block, the gate **prints the exact copy-pasteable** `aih workspace add … --acknowledge a,b,c` command.

**Path-safety verbatim:** every `uri`/path in the lockfile and any `Check.location` is relative, POSIX-normalized, non-absolute, no `..`, safe to print.

---

## 8. Phased delivery (vertical-slice-first, 1:1 emitter rule, PR-sized)

Re-sequenced per the critiques: a **thin end-to-end slice ships by PR T2** (not PR 6), each `trust.*` code lands **with its emitter** (verify.ts 1:1 rule), and the `gradeVerdict`/control change lands **with the first deny-eligible emitter**, not as "pure spine."

**PR T1 — controls + danger grader + verdict mapping (with the first emitter).** Add `trust-danger` + `trust-origin` to `GovernanceControl`; add `src/trust/grade.ts` (`gradeTrustDanger`); land `trust.hidden-unicode` + `trust.prompt-injection` (both `trust-danger`) emitted as unconditional `fail`. Tests: danger denies at **vibe/team/enterprise** (proves no fail-open); `trust-origin` grades warn/warn/deny; risk-gates carve-out not inherited; whole-document scan catches injection inside a fenced block and an HTML comment. *Ships behavior, with tests — not pure spine.*

**PR T2 — thin vertical slice: `aih workspace add <owner/repo> --apply` (danger-only).** Tarball-at-SHA fetch (exec, `--apply`, scrubbed env, OS-temp quarantine, zip-slip + symlink rejection), phase-1 forced-verify scan running **only** A1/A2, phase-2 promote on clear. `aih trust scan <local-path>` (pure read-only) and `<owner/repo>` (fetch+scan) exposed. SARIF + JSON. A user can run this against a real skills repo at PR 2.

**PR T3 — auto-exec + manifest/dep-name tells (structural parse).** `trust.auto-exec-hook` (zod over parsed frontmatter/`package.json`, full lifecycle-script set, `.npmrc`, **unparseable → fail**), `trust.dependency-confusion` / `trust.typosquat` (trust-danger), `trust.unpinned-dependency` (trust-origin). Fixtures include flow/quoted/aliased YAML evasions.

**PR T4 — secret + incoming-MCP scans (reuse + NEW classifier).** Point `scanSecrets`/`scanConfigSecrets` at the quarantine root (new wiring). **NEW** `classifyIncomingMcp(rawServer)` → `evaluateMcpPolicy`; run the A1/A2 lint over MCP `description` fields (emits `trust.prompt-injection`). Hosted-server RED advisory. *Net-new classifier, accounted as such — not "free composition."*

**PR T5 — pin + drift + allowlist + lockfile + override.** `git ls-remote` pin (exec) with `trust.fetch-blocked` skip taxonomy; org-policy `trust` block + `requiredDetectors`; `.aih/trust-lock.json`; `aih trust allow/pin/list/verify`; `trust.untrusted-publisher`, `trust.unsigned-source`, `trust.source-drift`; content-bound `--acknowledge` (bulk + non-overridable denylist) with the committed override ledger.

**PR T6 — optional external detectors + doctor wiring + Windows routing.** Presence-gated SkillSpector (Docker-default, SARIF→`trust.*`, absent→skip+degraded-banner) and optional AgentShield/Cisco read-only probes — **all via `execArgv`/`cmd /c`**, with a `platform="windows"` argv test and the spawnError/127/timeout→skip taxonomy. `aih doctor` re-hashes promoted artifacts (**local drift only**); `aih trust verify` does the `ls-remote` upstream-rug-pull check.

**PR T7 — optional malicious-code deep scan + AMBER/RED advisories.** `trust.malicious-code` via offline Semgrep/YARA with **vendored** rules (no runtime rule fetch; absent rules → skip), routed via `cmd /c`; emit the explicit "this is AMBER/RED — run a sandboxed `npm install --ignore-scripts` + audit, a runtime MCP-scan with tool-pinning before first use, and set `permissions.deny:[Bash(*)]`" advisory for the residue.

---

## 9. Open questions / decisions for the user

### Decisions locked (2026-06-30)

All seven resolved with Samar; the design above reflects these. Implementation must follow them:

1. **Hosted-MCP grading → warn @vibe/team, deny @enterprise** (current §4 C3), with a standing RED advisory + "run a runtime MCP-scan with tool-pinning before first use" at every posture.
2. **Required-detector → fail-closed, enterprise-only.** An enterprise box with a configured `trust.requiredDetectors` entry that is absent **fails closed**; vibe/team always degrade-with-banner.
3. **Shared gate seam** — one gate function fronts both `aih workspace add` and the future `aih workspace init-children`. No duplication.
4. **Override ledger → org-policy `approvedSources` pin** (committed, zod-validated). No free-text markdown ledger.
5. **Dep-name lists → vendored seed popular-package list + `trust.internalScopes` from org-policy** (org-extendable). Small/curated in v1 to keep false positives low. **TODO at impl:** Samar to supply the actual internal npm scope(s); until configured, `trust.internalScopes` defaults to `[]` and the dependency-confusion check no-ops (typosquat-distance still runs against the seed list).
6. **`trust verify` cadence split** — `doctor` = offline local re-hash (local drift only, never claims upstream detection); `aih trust verify` = explicit `git ls-remote` upstream check + optional full re-fetch.
7. **External-detector LLM passes → opt-in, off by default** (SkillSpector `--no-llm` default; Cisco LLM mode off). Enabled only when the operator accepts the content egress.

### Original questions (for context)

1. **Hosted-MCP at team posture — deny or advise?** Hosted servers (`egress:third-party`, `supplyChain:hosted-remote`) have **no** post-approval rug-pull protection — you cannot pin what you cannot fetch. I lean: **warn at team, deny at enterprise** (current §4 C3), with a standing RED advisory either way. Alternative: deny at team+ too (stricter, more friction). Confirm.

2. **Required-detector fail-closed at enterprise.** I've made `trust.requiredDetectors` cause an enterprise box with a configured-but-absent detector to **fail closed**. Confirm you want enterprise to hard-block on missing deep-scan tooling rather than degrade-with-banner (the vibe/team behavior).

3. **Shared gate seam for `init-children`.** The trust gate is a precondition on **both** `workspace add` and the reserved future `aih workspace init-children`. Confirm so the seam is shared, not duplicated.

4. **Committed override ledger placement.** I route deny-grade acks into the **org-policy `approvedSources` pin** (committed, validated) rather than a separate markdown file. Confirm, or name a preferred committed artifact.

5. **Typosquat/dependency-confusion lists.** Direct-dep NAME checks need a curated popular-package list + your internal-scope set. Ship a small vendored seed list and let org-policy extend it? Confirm the source of the internal-scope set.

6. **`aih trust verify` cadence.** I've set: `doctor` = local hash check (no network, **local drift only**); `aih trust verify` = `ls-remote` upstream check (cheap) + optional full re-fetch. Confirm this split (vs. an opt-in network probe inside `doctor`).

7. **External-detector LLM passes.** All external LLM passes (SkillSpector `--no-llm` omitted, Cisco LLM mode) ship file contents to a vendor endpoint. I keep them **opt-in only**, off by default. Confirm.

---

## Changes from draft (critique resolutions)

**Critical:**
- **Vibe fail-open closed.** `trust-danger` findings are emitted as unconditional `Check{fail}` and graded by a **new `gradeTrustDanger`** that never calls `postureGradeCheck` (verified to rewrite warn→`pass`/`code:undefined` at vibe/team) — so reverse-shell / hidden-unicode / prompt-injection / auto-exec **deny at every posture**. Locked by an emitter test at `vibe`. (§4)
- **Promote-on-pass made real (two phases).** Because `executePlan` commits writes/execs **before** probes and runs probes only under `ctx.verify` (execute.ts:289-323), promotion is a **second `executePlan`** guarded by phase-1's report in the command wiring; `aih workspace add` sets `alwaysVerify:true` so `--apply` can't skip the gate; phase-1 plan asserts no workspace write/doc actions. (§3)
- **No-remote-mutation boundary respected.** Clone/`ls-remote`/tarball fetch are reclassified as **`exec` actions gated on `--apply`** (the ECC precedent, ecc/index.ts:65-118); scans are **probes over the on-disk tree**. URL-mode scan therefore requires `--apply`; `aih trust scan <local-path>` is the pure read-only path. No `write` action "clones." (§2, §3)

**High:**
- **Fetch hardened against checkout-time exec.** Default **tarball-at-SHA** (no `.git`, no submodule/smudge/hooks/LFS surface); hardened-clone fallback with hooks/submodules/LFS disabled; scrubbed env + cwd jail; zip-slip + symlink rejection via `assertContained` realpath logic. (§6)
- **`skipIntervals` NOT reused.** New `src/trust/lint.ts` reuses `LintRule`/`LintFinding` types + `scanMatches` but scans the **whole untrusted document including code fences, inline code, HTML comments, and the frontmatter `description`**, emitting posture-graded `Check`s — not `lintDoc`/`RULES` (which lint aih's own canon and would fire prose rules + skip the prime hiding spots). Fixture proves injection-in-fence and injection-in-comment caught. (§4)
- **`--acknowledge` bound to content hash + denylist + bulk + committed ledger.** Fingerprints carry a content hash; acks invalidate on any byte change; `trust-danger` codes are non-overridable; multi-fingerprint + `--acknowledge-all --reason`; deny-grade acks persist in a committed org-policy pin (not just gitignored). Concrete mechanism: acked fingerprint → `skip` before report accumulation. (§7)
- **Transitive/pinned deps + hosted-MCP rug-pull reclassified RED.** Repo-text manifest scan and artifact-hash drift explicitly **do not** cover these; the gate hands off to runtime (`--ignore-scripts` + audit; runtime MCP-scan with tool-pinning before first use). Lockfile-present ≠ clean. Added direct-dep **NAME** GREEN checks (`trust.dependency-confusion`/`trust.typosquat`) since names *are* in the repo. (§1 tiers, §4 C3/E3)
- **Structural parsing, fail-closed on parse error.** YAML frontmatter + `package.json` parsed via zog/zod over the parsed object (not regex), full npm lifecycle-script set + `.npmrc`; unparseable input → `fail`. (§4 check B/E)
- **False `evaluateMcpPolicy(incomingServers)` reuse replaced.** New `classifyIncomingMcp(rawServer)` derives egress/credentials/supplyChain from untrusted config, then feeds `evaluateMcpPolicy`; budgeted net-new in PR T4. (§4 C2, §8)
- **AgentShield "already wired" corrected.** It is **doc-text-only** (ecc/install.ts:138) consumed via a **user-produced** JSON (report/guardrail.ts) — no execution wiring; any probe is net-new. (§5)
- **Windows external-spawn footgun fixed.** "Sidesteps the footgun entirely" narrowed to the native floor; every external spawn (uvx/docker/skillspector/semgrep/gh/npm audit) routed through `execArgv`/`cmd /c` (extended beyond `WIN_CMD_SHIMS`), with a `platform="windows"` argv test; Docker is the default sandbox. (§5)
- **Egress-blocked degradation specified.** Network/tool-failure taxonomy: `ls-remote`/fetch/`gh`/`npm audit`/every detector map spawnError/127/timeout → `skip` (`trust.fetch-blocked`), never `fail`; `aih trust scan <local-path>` is the air-gapped path. (§5)
- **Team-deny contradiction resolved + alert fatigue fixed.** Split into `trust-danger` (team-deny: malicious-code/prompt-injection/hidden-unicode/auto-exec/dep-name) vs `trust-origin` (advisory: unpinned-dep/untrusted-publisher/unsigned-source/source-drift/mcp-policy), so floating deps don't deny at team. The §4 publisher/signing warn/warn/deny rows now match their control. (§4)
- **Quarantine symlink/path-safety engineered**, not asserted: realpath containment on the extracted tree (no link-follow on hash) and on the promote copy. (§6)
- **`trust.*` codes trimmed/split + introduced 1:1 with emitters.** Dropped `trust.mcp-tool-poisoning` (routes to `trust.prompt-injection`); split `trust.unsigned-source` into origin-unverifiable vs `trust.source-drift`; added `trust.fetch-blocked` (skip-only) and the dep-name codes; each lands in its emitter's PR (verify.ts 1:1 rule), and the `gradeVerdict`/control change lands with the first deny-eligible emitter (T1 is not "pure spine"). (§4, §8)

**Medium/low:**
- **Verdict-model conflation fixed** with an explicit `Check`-verdict→SARIF→exit mapping table; every "warn → acknowledgeable" replaced with the truth (vibe origin findings promote silently with a note; only `fail`s block; no new interactive seam). (§2, §4)
- **Rug-pull claim corrected.** `doctor` (read-only, local) catches **local drift only**; upstream tag-repoint detection is the explicit opt-in-network `aih trust verify` (`ls-remote` compare). (§2, §8)
- **Quarantine moved off IDE-scanned paths** (OS temp) so dropped `.mcp.json`/hooks aren't auto-loaded; gitignore precondition covers both plain and `--git` paths; quarantine is explicitly not a child repo. (§3, §6)
- **`supply-chain` naming collision avoided** by using `trust-danger`/`trust-origin` (the draft's single `supply-chain` collided with the MCP `McpSupplyChain` risk axis). (§4)
- **"Free clamp" phrasing dropped**; allowlist enforcement is a separate graded check, not an effect of the posture clamp. (§7)
- **Phasing re-sequenced** to deliver a runnable end-to-end slice at PR T2. (§8)
- **Degraded-coverage signaling** added so an absent optional detector is visible, not a silent green. (§5)

**Where a critique was over-stated (noted briefly):** the `assertContained` "guards aih's own paths, not the payload's internal links" point is correct *as written* but its realpath ancestor-resolution logic is directly **reusable** for the payload tree — so the fix is reuse, not net-new path math (§6). And "8 codes is a large sealed addition" is right on count; the response is to trim to the set above and introduce each with its emitter, not to defer them all to one PR.
