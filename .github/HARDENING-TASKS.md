# Enterprise-Hardening Task Log

Standing tracker for the enterprise-readiness work derived from the June 2026
external review. Companion to [`AGENT_TASKS.md`](AGENT_TASKS.md) (which still
governs *how* to change a capability: 4 action kinds, pure `plan()`, per-module
tests, no remote mutation).

Every line item below was **verified against the actual code** (file:line) before
being listed — the raw review was ~70% accurate; corrections are recorded under
"Banked corrections" so we don't chase non-problems.

**Split:** Part 1 = *no decision needed* (verified defects + unambiguous
hardening; safe, reversible, completable now). Part 2 = *decision needed*
(product/strategy choices). We finish **Part 1 fully**, then return to Part 2.

---

## Banked corrections (do NOT plan these — already true or already wrong)

| Review claim | Reality (verified) |
| --- | --- |
| "CI actions aren't SHA-pinned" | **Stale.** `release.yml`/`ci.yml`/`codeql.yml`/`scorecard.yml` already pin every action to a full commit SHA. (The CI aih *generates* for other repos — `guardrails/sca.ts` — is the unpinned one. That's covered in P1-C.) |
| "Hardcodes Zscaler / single-CA / user-store only" | **Overstated.** `certs/index.ts:50` bundles *all* matching roots; `--ca-pattern` is general (Zscaler is the default); Windows reads machine **and** user stores. Real residual gaps are small (P1-E). |
| "Prompt logging can be enabled" | **Understated — it's worse.** `OTEL_LOG_USER_PROMPTS=1` + `OTEL_LOG_TOOL_DETAILS=1` are emitted **on, with no off switch** (`telemetry/templates.ts:71-72`). Treated as a defect → P1-A. |
| "MCP is just scaffolding" | **Partly stale.** Org kill-switch, exact-argv allowlist, Entra/Okta snippets, `--mode offline/none` all exist (`mcp/enterprise.ts`, `mcp/index.ts`). Genuine gaps are token-lifecycle / audit-schema / deployable gateway (Part 2). |

**The one structural insight:** `doctor`/`status` verify *presence*, never
*enforcement* (`internals/verify.ts` has only pass/fail/skip; the sandbox probe
even fails **open**). Fixing that is the substrate for fail-closed profiles, the
audit command, and the advisory-vs-enforced signal — see P1-F (primitive, no
decision) and Part 2 (the policy/strict defaults that ride on it).

---

## PART 1 — No decision needed

Direction is unambiguous; changes are reversible config/detection improvements,
each scoped to its module with golden tests. Status: ☐ todo · ◐ in progress · ☑ done.

### Tier 1 — bounded, completing this pass

- **P1-A · Telemetry prompt-logging becomes opt-in (default OFF).** ☑ — scope S
  - Emit `OTEL_LOG_USER_PROMPTS=0` / `OTEL_LOG_TOOL_DETAILS=0` by default; add
    `--log-prompts` / `--log-tool-details` opt-in flags that flip them back on.
  - Files: `src/telemetry/templates.ts`, `src/telemetry/env.ts`, `src/telemetry/index.ts`; tests `tests/telemetry/*`.
  - *Why no-decision:* shipping raw prompt/tool bodies to a collector by default is
    a privacy defect. Default-off + a flag preserves the capability either way.
    (Whether your org turns it on is the Part-2 policy call.)

- **P1-B · MCP hosted-server risk labeling.** ☑ — scope S
  - Add a `classification` field (e.g. `local` | `first-party` | `third-party-hosted`)
    to the server descriptor; tag the `n24q02m.com` hosted email/Notion/Telegram/
    memory servers as `third-party-hosted` and surface it in the plan doc.
  - Files: `src/mcp/servers.ts`, `src/mcp/index.ts`; tests `tests/mcp/*`.

- **P1-C · Pin every generated external dependency.** ☑ — scope M (also fixed a broken `anchore/syft-action` ref → real `sbom-action`)
  - MCP server args `@latest` → exact versions (`mcp/servers.ts`).
  - Devcontainer base image `:ubuntu` → specific dated tag; features `:1`/`lts` →
    exact versions (`sandbox/templates.ts`).
  - Generated `sca.yml` actions `@v4`/`@v0` → SHA-pinned, matching aih's own CI
    discipline (`guardrails/sca.ts`).
  - Tests: `tests/mcp/*`, `tests/sandbox/*`, `tests/guardrails/*`.
  - *Note:* exact-version/tag pinning only. Full `@sha256:` digest pinning (higher
    bump-maintenance) is logged as an optional Part-2 hardening.

- **P1-D · VDI detection breadth + wire the dead `workspaces` kind.** ☑ — scope M
  - _Residual:_ Windows env redirect still lands only in the PowerShell profile;
    covering cmd.exe / Git-Bash needs a `shellProfilePaths()` change that touches
    every env-block capability (certs/telemetry/hardware) → own PR, not folded here.
  - `base.ts` already declares `kind: "workspaces"` but no code path returns it —
    implement Amazon WorkSpaces detection; add AVD/Cloud-PC and Horizon signals;
    give macOS more than the `AIH_FORCE_VDI` stub.
  - Broaden the fixed 6-entry redirect set; cover cmd.exe / Git-Bash on Windows
    (today only the PowerShell profile gets the redirect).
  - Files: `src/platform/{windows,linux,darwin}.ts`, `src/vdi/redirects.ts`, `src/vdi/index.ts`; tests `tests/vdi/*` + platform tests.
  - *Why no-decision:* pure detection heuristics, override already exists (`AIH_FORCE_VDI`).

- **P1-E · Certs cross-platform gap-fill.** ☑ — scope S–M
  - Linux: match CAs by **subject** (shell out to openssl) instead of filename-only
    (today a correctly-installed CA whose filename lacks the pattern is missed).
  - macOS: also read the user `login.keychain`, not just the system store.
  - Apply conda trust via a written `.condarc` (`ssl_verify`), consistent with the
    pip/cargo configs already written (today conda is doc-only).
  - Files: `src/platform/{linux,darwin}.ts`, `src/certs/index.ts`, `src/certs/templates.ts`; tests `tests/certs/*`.

- **P1-G · Profiler correctness: stop the shallowest-`package.json`-wins bug.** ☑ — scope M
  - `profile/scan.ts:195` keeps only the first/shallowest `package.json`; in a
    workspace root that's the meta-package, so per-package scripts are invisible →
    confident-but-wrong commands. Walk all manifests; detect workspace
    orchestrators (pnpm-workspace / nx / turbo / lerna / gradle settings / maven
    modules) and label the repo a monorepo instead of guessing one command set.
  - Files: `src/profile/scan.ts`, `src/profile/templates.ts`; tests `tests/profile/*`.

### Tier 2 — large; each has a decision-adjacent core (bridges into Part 2)

These are decision-free in *direction*, but on implementation each turned out to
have a core that depends on a Part-2 decision (so they are best done **with** that
decision, not before it). The decision-free *skeleton* of each can be built now if
you want; the behavior-defining part is flagged per item. `AGENT_TASKS.md` also
says isolate `internals/**` changes (P1-F) as their own PR.

- **P1-F · Verify-layer primitive: presence-vs-enforced + `required`.** ☐ — scope M
  - Extend `internals/verify.ts` so a check can be marked *required* (missing →
    `fail`, not `skip`) and can **read a generated artifact back** to assert its
    values stuck. Surface "generated but not enforced" in `status`/`doctor` as an
    informational annotation **without** changing exit codes yet.
  - Touches `src/internals/**` → its own PR. The fail-closed *defaults* that use
    this primitive are Part 2.
  - ✅ _sliver landed:_ `status` read-backs the pre-commit **git hook** and reports
    "config present but hook NOT installed" in the detail (exit-0, no internals
    change). The full `required`/fail model is still queued.

- **P1-H · Profiler semantic parsing + command validation.** ☐ — scope L
  - Real `.sln`/`.csproj` enumeration, gradle `settings.gradle`, `pyproject.toml`
    parsing (not filename matching); stop the non-Node default table presenting
    unverified `mvn`/`gradle`/`dotnet` commands as authoritative; optional dry-run
    validation of generated commands.
  - ↳ _decision-adjacent:_ the **validation** half runs commands (`exec`, which is
    verify-territory) and "what to do when a generated command fails" is a behavior
    choice. The pure-parsing half is decision-free and could land alone.
  - ✅ _sliver landed:_ profiler prefers `./mvnw` / `./gradlew` when the wrapper
    file exists (no more bare `mvn`/`gradle` when the repo pins a wrapper). Semantic
    `.sln`/gradle/`pyproject` parsing + dry-run command validation still queued.

- **P1-I · Sandbox hardening primitives (generation only).** ☐ — scope M–L
  - Generate seccomp profile, `cap-drop`/`no-new-privileges`/`securityOpt`,
    rootless guidance, read-only mounts in the devcontainer. (Making them
    *fail-closed/required* is Part 2 — it can break builds when Docker is absent.)
  - ↳ _decision-adjacent:_ aggressive seccomp / `cap-drop=ALL` / read-only root can
    break the dev container (postCreate installs, tooling). Only
    `no-new-privileges` is unambiguously safe; how strict to go is the Part-2
    strict-mode call.
  - ✅ _sliver landed:_ devcontainer emits `--security-opt no-new-privileges:true`.
    seccomp / cap-drop / rootless / read-only mounts remain gated on Part-2 strict-mode.

---

## PART 2 — Decision needed (parked until Part 1 lands)

Each needs a product/strategy call before it can be planned safely.

- **D1 · Publish to npm?** Release workflow *deliberately* does not publish
  (`release.yml:3-4`); packaging groundwork (scoped name/`files`/`bin`) is done.
  Ties to the still-open OSS decision. → if yes: also pick signing approach
  (cosign vs GitHub OIDC attestation), SBOM, provenance, checksums.
- **D2 · The policy engine (`aih.policy.yaml`) contract + default values.** The
  *engine* rides on P1-F, but the **defaults** (retention days, allowed domains,
  strict-vs-advisory, which controls are "required") are policy choices.
- **D3 · `doctor --profile enterprise-strict` fail-closed behavior.** What flips
  exit codes, and does strict mode break a build when Docker/sandbox is absent?
- **D4 · `aih audit --json` output contract.** The pass/fail readiness schema
  platform teams consume — needs a stable shape decision.
- **D5 · Telemetry governance model.** Retention, sampling rate, data-class labels,
  consent gate, ECS/SIEM field mapping — and the org default for prompt logging.
- **D6 · MCP identity control plane.** Which gateway product; token lifecycle
  (rotation/TTL/revoke); audit-event schema; self-hosted registry shape.
- **D7 · Global `--offline` / `--internal-mirror` semantics.** Today only `mcp`
  has offline modes; a global flag that also rewires `ecc`'s `npx ecc-install`,
  certs, telemetry needs a mirror-catalog contract.
- **D8 · Full `@sha256:` digest pinning** (vs the exact-tag pinning in P1-C) —
  reproducibility vs bump-maintenance tradeoff.
- **D9 · Platform vs bootstrapper framing.** aih is a generator by design
  (doc-vs-exec boundary); "enforcement" is partly the customer's pipeline. Decide
  how hard to lean into "governed platform" messaging vs "honest readiness verdict."

---

## Changelog

- _2026-06-25_ — Log created; Part 1/Part 2 split recorded; baseline 520 tests green on `main`.
- _2026-06-25_ — P1-A done (telemetry prompt logging off by default + `--log-prompts`/`--log-tool-details`); 524 tests.
- _2026-06-25_ — P1-B done (structured `classification` on MCP servers + vendor-risk callout in gateway doc); 529 tests.
- _2026-06-25_ — P1-C done (pinned MCP `@latest`→`1.0.27`/`0.0.76`, devcontainer base+features+node, sca.yml actions SHA-pinned; **bonus:** fixed non-existent `anchore/syft-action`→`anchore/sbom-action` with correct `format` input); 532 tests.
- _2026-06-25_ — P1-D done (`vdiFromEnv` shared helper: `AIH_VDI_KIND` override wires `workspaces`, Horizon `ViewClient_*` auto-detect, Windows now honors `AIH_FORCE_VDI`; broadened redirect set to HF/npm/yarn/uv/playwright); 535 tests. Residual: cmd/Git-Bash profile coverage deferred (own PR).
- _2026-06-25_ — P1-E done (macOS login.keychain; Linux subject-level CA match via openssl with filename fallback + injectable anchor dirs; conda applied via `.condarc` write, Homebrew stays a doc); 542 tests, +`darwin.test.ts`.
- _2026-06-25_ — P1-G done (workspace/monorepo detection: pnpm/nx/turbo/lerna/rush/bazel/gradle/maven/npm-yarn + manifest count → `isMonorepo`/`workspaceTool`; stack rule labels the monorepo and warns commands are per-package); 551 tests. **Tier-1 of Part 1 complete (A,B,C,D,E,G).**
- _2026-06-25_ — Quality gate green: `tsc --noEmit` clean, `biome check src tests` 141 files clean, `tsup` build (ESM+DTS) success. Net Part-1 Tier-1: **+31 tests (520→551), 6 capabilities hardened, 1 latent bug fixed**. Tier-2 (P1-F/H/I) reassessed: each has a decision-adjacent core → bridges into Part 2; decision-free skeletons can land alone on request.
- _2026-06-25_ — Tier-1 committed + pushed: `feat/enterprise-hardening-p1` (623e096 feat, 20072f1 docs).
- _2026-06-25_ — Tier-2 **safe slivers** landed (the decision-free parts): P1-I devcontainer `no-new-privileges`; P1-H `./mvnw`/`./gradlew` wrapper preference; P1-F `status` pre-commit-hook enforcement read-back (exit-0). 551→558 tests; tsc + build green. Decision-bound remainders of F/H/I stay queued for Part 2.
