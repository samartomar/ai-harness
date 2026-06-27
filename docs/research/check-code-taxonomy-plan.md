# First PR spec — machine-readable `Check.code`

**Scope of this PR:** add an optional `code` to `Check`, define a closed `CheckCode`
union, and populate it at the verification emitters the Supportability Pack will
consume. **Nothing else** — no templates, no run ledger, no SARIF/JSON rule-id
rewiring. Those are PR2 (templates) and PR3 (ledger).

The taxonomy below is **bottom-up**: every code corresponds to a `fail`/`skip`
that an emitter actually returns today (file:line cited). Codes with no emitter
were dropped; ticket-worthy emitters with no proposed code were added.

---

## 1. Why codes, proven by the grep

`Check.detail` is free-text English ([verify.ts:4-8](../../src/internals/verify.ts)).
Routing a support template off `detail` rots the first time someone rewords a
message. The clinching evidence: **one concept, three names today** —

| Concept | Emitter names in the tree |
|---|---|
| Node runtime broken | `node-version` ([doctor.ts:50](../../src/doctor.ts)), `node: runtime` ([npm-heal.ts:17](../../src/heal/npm-heal.ts)), `node` ([usage/index.ts:113](../../src/usage/index.ts)) |

A code unifies these; a name match never could.

---

## 2. The change to `verify.ts`

`CheckCode` lives **next to `Check`** in `src/internals/verify.ts` (a leaf module).
Dependency arrow is **`support/*` → `verify`** only; `verify` must never import
`support`. `code` is **optional**, so every Check that omits it serializes
byte-for-byte as today (`JSON.stringify` drops `undefined` keys) — see §6 for the
one golden-test caveat.

```ts
/** A single verification outcome produced by a probe action or `doctor`. */
export interface Check {
  name: string
  verdict: Verdict
  detail?: string
  /**
   * Stable machine code for routing (support templates, run-ledger findings).
   * Set ONLY on fail/skip emitters that a consumer keys off — never derive it by
   * matching `detail`. Absent ⇒ not yet ticket-routed (e.g. every `pass`).
   */
  code?: CheckCode
}

/**
 * Closed taxonomy of routable verification outcomes. Each member maps 1:1 to a
 * real fail/skip emitter (see docs/research/check-code-taxonomy-plan.md). Keep it
 * sealed: adding a failure mode = add a member here + set it at the emitter, so
 * downstream routing can switch() exhaustively with a `never` default.
 */
export type CheckCode =
  // environment / runtime
  | "env.node-runtime"
  | "env.git-missing"
  | "env.dev-tool-missing"
  // certificates / TLS
  | "cert.ca-missing"
  | "tls.verify-failed"
  // npm
  | "npm.runtime-broken"
  // PATH
  | "path.missing"
  // MCP
  | "mcp.blocked"
  | "mcp.uv-missing"
  | "mcp.config-missing"
  | "mcp.unvendored-offline"
  // CLI bootloaders / canon
  | "cli.not-detected"
  | "cli.bootloader-missing"
  | "cli.bootloader-drift"
  | "cli.wont-load"
  | "canon.router-missing"
  | "canon.context-dir-missing"
  | "canon.lint-failed"
  // guardrails / secrets
  | "secrets.plaintext-detected"
  | "guardrails.gitleaks-missing"
  // usage
  | "usage.no-data"
```

The fluent `.pass()/.fail()/.skip()` helpers ([verify.ts:22-32](../../src/internals/verify.ts))
are **unchanged** — production emits object literals, so codes are added at those
literals. (A later PR may let SARIF use `code` as the stable rule id; out of scope.)

---

## 3. Populate checklist — every site to edit

Edit only these. `audience`/`severity`/`kind` are **forward guidance for PR2**
(derived in the support layer from `code` + `verdict`); they are **not** stored on
`Check` in this PR.

### Environment / runtime
| code | emitter (name) | site | verdict | → PR2 audience / kind |
|---|---|---|---|---|
| `env.node-runtime` | `node-version` (<20) | [doctor.ts:54](../../src/doctor.ts) | fail | internal-it · failure |
| `env.node-runtime` | `node: runtime` (absent) | [npm-heal.ts:21](../../src/heal/npm-heal.ts) | fail | internal-it · failure |
| `env.node-runtime` | `node` (absent) | [usage/index.ts:116](../../src/usage/index.ts) | fail | developer · failure |
| `env.git-missing` | `git` | [doctor.ts:64](../../src/doctor.ts) | skip | developer · improvement |
| `env.dev-tool-missing` | `dev-tools` (rg/fd/jq) | [doctor.ts:161](../../src/doctor.ts) | skip | developer · improvement |

### Certificates / TLS
| code | emitter (name) | site | verdict | → PR2 |
|---|---|---|---|---|
| `cert.ca-missing` | `cert: NODE_EXTRA_CA_CERTS` (set-but-missing) | [cert-verify.ts:24](../../src/heal/cert-verify.ts) | fail | internal-it · failure |
| `cert.ca-missing` | `cert: NODE_EXTRA_CA_CERTS` (not PEM) | [cert-verify.ts:27](../../src/heal/cert-verify.ts) | fail | internal-it · failure |
| `cert.ca-missing` | `cert: NODE_EXTRA_CA_CERTS` (unset + TLS failing) | [cert-verify.ts:34](../../src/heal/cert-verify.ts) | fail | internal-it · failure |
| `tls.verify-failed` | `cert: TLS …` (registry/pypi handshake) | [common.ts:64](../../src/heal/common.ts) | fail | internal-it · failure |
| `tls.verify-failed` | `CA trust reaches pypi` | [certs/index.ts:216](../../src/certs/index.ts) | fail | internal-it · failure |

### npm / PATH
| code | emitter (name) | site | verdict | → PR2 |
|---|---|---|---|---|
| `npm.runtime-broken` | `npm: runtime` (not found) | [npm-heal.ts:39](../../src/heal/npm-heal.ts) | fail | internal-it / dev-platform · failure |
| `npm.runtime-broken` | `npm: runtime` (broken module) | [npm-heal.ts:43](../../src/heal/npm-heal.ts) | fail | internal-it / dev-platform · failure |
| `path.missing` | `path: ~/.local/bin` | [path-heal.ts:50](../../src/heal/path-heal.ts) | fail | developer · failure |

### MCP
| code | emitter (name) | site | verdict | → PR2 |
|---|---|---|---|---|
| `mcp.blocked` | `mcp: npx launcher` (registry unreachable) | [mcp-probe.ts:46](../../src/heal/mcp-probe.ts) | fail | dev-platform / security · failure |
| `mcp.blocked` | `mcp: npx launcher` (npm broken) | [mcp-probe.ts:52](../../src/heal/mcp-probe.ts) | fail | dev-platform / security · failure |
| `mcp.uv-missing` | `uv present` | [mcp/index.ts:63](../../src/mcp/index.ts) | skip | dev-platform · improvement |
| `mcp.uv-missing` | `uv present` (exit≠0) | [mcp/index.ts:68](../../src/mcp/index.ts) | fail | dev-platform · failure |
| `mcp.config-missing` | `mcp: npx launcher` (no .mcp.json) | [mcp-probe.ts:27](../../src/heal/mcp-probe.ts) | skip | developer · improvement |
| `mcp.unvendored-offline` | `offline MCP servers are vendored` | [mcp/index.ts:34](../../src/mcp/index.ts) | fail | dev-platform · failure |

### CLI bootloaders / canon
| code | emitter (name) | site | verdict | → PR2 |
|---|---|---|---|---|
| `cli.bootloader-missing` | `bootloader … in sync` (missing) | [bootstrap-ai/index.ts:52](../../src/bootstrap-ai/index.ts) | fail | developer · failure |
| `cli.bootloader-missing` | `bootloader … in sync` (no managed block) | [bootstrap-ai/index.ts:56](../../src/bootstrap-ai/index.ts) | fail | developer · failure |
| `cli.bootloader-drift` | `bootloader … in sync` (drifted) | [bootstrap-ai/index.ts:59](../../src/bootstrap-ai/index.ts) | fail | developer · failure |
| `cli.bootloader-drift` | `bootloader … in sync` (no RULE_ROUTER ref) | [bootstrap-ai/index.ts:62](../../src/bootstrap-ai/index.ts) | fail | developer · failure |
| `cli.wont-load` | `cli-loadability` | [doctor.ts:133](../../src/doctor.ts) | fail | developer / dev-platform · failure |
| `canon.router-missing` | `…/RULE_ROUTER.md present` | [bootstrap-ai/index.ts:93](../../src/bootstrap-ai/index.ts) | fail | developer · failure |
| `cli.not-detected` | `ai-clis` | [doctor.ts:117](../../src/doctor.ts) | skip | developer · improvement |
| `cli.not-detected` | `<cli> installed` | [bootstrap-ai/index.ts:81](../../src/bootstrap-ai/index.ts) | skip | developer · improvement |
| `canon.context-dir-missing` | `context-dir` | [doctor.ts:83](../../src/doctor.ts) | skip | developer · improvement |
| `canon.context-dir-missing` | `child:<repo>` (workspace) | [doctor.ts:181](../../src/doctor.ts) | skip | developer · improvement |
| `canon.lint-failed` | canon lint | [lint/run.ts:126](../../src/lint/run.ts) | fail | developer · failure |

> `doctor`'s `canon markdown lint` probe delegates to `canonLintCheck`
> ([doctor.ts:110](../../src/doctor.ts) → [lint/run.ts](../../src/lint/run.ts)),
> so the code is set **once** inside `lint/run.ts`, not at the doctor call site.

### Guardrails / secrets / usage
| code | emitter (name) | site | verdict | → PR2 |
|---|---|---|---|---|
| `secrets.plaintext-detected` | `plaintext-secret` (one per path) | [secrets/probes.ts:33](../../src/secrets/probes.ts) | fail | **security · failure** ⭐ |
| `guardrails.gitleaks-missing` | `gitleaks present` (not on PATH) | [guardrails/index.ts:167](../../src/guardrails/index.ts) | skip | developer · improvement |
| `guardrails.gitleaks-missing` | `gitleaks present` (exit≠0) | [guardrails/index.ts:174](../../src/guardrails/index.ts) | fail | developer · failure |
| `usage.no-data` | `usage-log` | [usage/index.ts:123](../../src/usage/index.ts) | skip | maintainer · improvement |

**Site count:** ~30 emitter edits across 11 files. This is **not** a one-line PR —
scope it as "type + populate the 21 codes' emitters + tests." `pass` branches are
never coded (you don't ticket a pass).

---

## 4. Deliberately dropped / deferred (with reason)

| Item | Why it's not in v1 |
|---|---|
| `npm.trust-missing` (original proposal) | **No emitter exists.** The npm-registry signal is a TLS handshake → already `tls.verify-failed`; the real npm failure is the runtime check → `npm.runtime-broken`. A code with nothing to bind to is the exact rot we're removing. |
| `guardrails.precommit-not-installed` (original) | **Renamed → `guardrails.gitleaks-missing`.** The emitter checks the *gitleaks binary*, not hook-install state. Name the code after what the probe inspects. |
| `report` `token-budget` fail ([report/index.ts:182](../../src/report/index.ts)) | A self-imposed CI budget gate, not an environment/IT failure — no ticket audience. Leave code-less. |
| `doctor` `platform` skip ([doctor.ts:72](../../src/doctor.ts)), `config-marker` skip ([doctor.ts:91](../../src/doctor.ts)) | Informational; no actionable ticket. |
| `sandbox` / `vdi` / `telemetry` / `hardware` / `status` skips | Peripheral capabilities, mostly `skip`; revisit if a template demands them. |

---

## 5. Test plan (`tests/internals/check-code.test.ts`)

Assert codes **at the emitter**, not via string-matching detail:

1. **Per-emitter code** — invoke each populated probe with a context that forces
   the fail/skip branch (the existing probe tests already construct these), assert
   `check.code === "<expected>"`. Reuse the runner/env seams already used in
   `tests/heal/*`, `tests/report/*`.
2. **Node unification** — the three node emitters (`doctor`, `npm-heal`, `usage`)
   all yield `env.node-runtime`. One test, three call sites.
3. **No-code invariant** — a representative `pass` (e.g. `node-version` ≥20) has
   `code === undefined`. Guards against over-coding.
4. **Closed-union reachability** (optional meta-test) — a fixture array maps every
   `CheckCode` member to a probe that can emit it; fail if a member is unreachable.
   Catches dead codes before they ship.

No new golden artifacts. Codes are asserted on the in-memory `Check`, so tests stay
deterministic without a clock/runner change.

---

## 6. Integration risk — one real caveat

Adding `code` is backward-compatible **except** for `--json`: `VerificationReport.toJSON()`
([verify.ts:49-51](../../src/internals/verify.ts)) returns the raw `checks` array,
so a populated `code` **will appear** in `aih <cmd> --json` output. SARIF is safe
(`reportToSarif` dedupes by `name`, ignores `code`). **Action:** before coding,
grep tests for snapshots that assert full `Check` objects under `--json`
(`tests/**/*.test.ts` referencing `checks:` or `--json` report bodies); update any
that pin exact check shapes. Adding a key to `--json` is acceptable, but it must be
a *conscious* golden update, not a surprise CI red.

---

## 7. Acceptance criteria

- [ ] `CheckCode` union + optional `Check.code` in `verify.ts`; no `verify → support` import.
- [ ] All ~30 emitter sites in §3 set the mapped code on their fail/skip branches; `pass` branches untouched.
- [ ] `npm.trust-missing` absent; `guardrails.gitleaks-missing` present; `secrets.plaintext-detected` present.
- [ ] `tests/internals/check-code.test.ts` covers every populated code (incl. the 3-way node unification).
- [ ] Any `--json` golden that snapshots check objects is consciously updated; SARIF goldens unchanged.
- [ ] `biome ci` clean; full suite green (verify exit code, not pipe tail).

**Out of scope (PR2/PR3):** `SupportFinding`/`SupportTemplate`, audience/severity
derivation, `src/support/*`, the `.aih/runs/*.jsonl` ledger, `RunDeps` clock/id
seams, argv/path redaction. This PR only makes failures *addressable*.
