# `aih heal` — self-healing system-doctor implementation plan

_Status: ✅ implemented on `feat/heal-self-doctor` — typecheck + `biome ci` clean, 676 tests pass (+29), `src/heal` 98.5% line coverage. Date: 2026-06-25. See §10 for as-built deviations._

Adds a **diagnose-and-repair** capability for the broken workstation runtime that `aih certs`
assumes already works (npm, Node, PATH, MCP). Genericized from a corporate harness so it works
behind **any** TLS-intercepting proxy (Zscaler, Netskope, Palo Alto, Cloudflare One, …) with **no
org-specific strings in code**. Reconciled against the actual `aih` action contract — the source
spec's "critical piece" (auto-download npm) is reshaped to fit the harness's no-remote-mutation
invariant rather than break it.

## 1. Decision

Build **`aih heal`** as a **standalone gated capability** (in `CAPABILITIES`, dry-run by default,
mutates only under `--apply`, probes under `--verify`) — modelled on [`certs`](../src/certs/index.ts),
**not** folded into `aih init`. It composes four ordered steps behind a dependency chain:

```
aih heal [--scope certs,npm,path,mcp,all] [--ca-pattern <p>] [--apply] [--verify] [--json]
```

**Locked answers (this session):**
- **npm self-heal is doc-only.** The Node-`https` download+reinstall is *emitted as a ready-to-run
  script* (a `doc` action), never executed by aih — exactly how `certs` treats the Homebrew
  cp+rehash. This preserves the harness's central guarantee. (§6 D1)
- **Standalone, like `certs`.** Host-level concerns are deliberately kept out of `init` (which is
  repo-scoped); `init`/`bootstrap` may *point at* `aih heal` via a `doc`, never run it. (§6 D2)
- **Plan doc first** (this file), then TDD implementation on approval.

## 2. The gap it closes

`certs` propagates corporate trust to npm/pip/cargo/conda, then assumes the rest of the runtime is
healthy. In a locked-down enterprise it usually is not, and the failures cascade:

1. npm corrupted (`fs-minipass`, broken symlinks, version mismatch).
2. npm's own TLS fails, so you can't `npm install` to fix npm.
3. Tool downloads blocked (proxy denies GitHub releases).
4. PATH broken — tools exist on disk but the session/GUI app can't find them.
5. Kiro/Claude/MCP servers die because Node can't do TLS (cert reached the shell but not the app).

`doctor` *reports* these; nothing *repairs* them. `heal` is the repair path — but only via actions
the contract already permits (local writes/execs, operator-run docs, read-only probes).

## 3. Reconciliation — source spec vs. the `aih` contract

| Spec framing | Codebase reality | Resolution |
|---|---|---|
| "heal acts; `doctor` only reports — a new top-level kind" | Every capability already mutates, gated by `--apply`; `doctor` is `readOnly:true` ([plan.ts:155-162](../src/internals/plan.ts)) | heal is a **normal capability**, not a new category — it inherits `--apply/--verify/--json` for free |
| `node -e "<download>"` run as an `exec` | `exec` is **local-only by contract** — "must never contact a remote system" ([plan.ts:65-77](../src/internals/plan.ts)) | Emit the script as a **`doc`** the operator runs (D1). aih still never touches a remote |
| "Set persistent user-level env vars" | Windows env today = PowerShell `$PROFILE` only ([windows.ts:120-123](../src/platform/windows.ts)) — reaches new shells, **not** GUI apps like Kiro | Add `persistentEnvArgv` → registry write (`[Environment]::SetEnvironmentVariable(…,'User')`), a **local** mutation = legal `exec`. POSIX stays the profile `envblock` |
| "`aih init` should call heal first" | `init` is repo-scoped and **deliberately excludes** host-level `certs` ([init/phases.ts:33-36](../src/init/phases.ts)) | heal stays standalone gated (D2); init/bootstrap *point at* it via `doc` |
| Hardcodes `BCBSA`/`Zscaler` cert subjects | `certs` already takes `--ca-pattern` (default `"Zscaler"`, fully overridable — [certs/index.ts:35,231-236](../src/certs/index.ts)) | heal reuses `--ca-pattern`, also honoring `AIH_CA_PATTERN`. **No org strings in code** |
| `tlsProbeArgv` via curl/Invoke-WebRequest | `certs` already curl-probes pypi inline ([certs/index.ts:203-217](../src/certs/index.ts)) | Promote to a `HostAdapter.tlsProbeArgv` so the Windows path is first-class |

## 4. The four steps (ordered; each emits plan `Action`s)

Composed via a fixed `HealStep[]` list, mirroring [`INIT_PHASES`](../src/init/phases.ts). `--scope`
selects which steps run; default `all`. Order is the dependency chain: **certs → npm → path → mcp**.

### A. cert-verify _(depends on nothing; gates everything)_
- **probe**: `NODE_EXTRA_CA_CERTS` set → file exists → contains `BEGIN CERTIFICATE` → live TLS
  handshake to `registry.npmjs.org` **and** `pypi.org` (via `tlsProbeArgv`).
- **on break**: emit a `doc` pointing at `aih certs --ca-pattern <p> --apply` (delegate the actual
  re-extraction to the dedicated command — see §7 open question on compose-vs-point-at).
- Pattern resolves from `--ca-pattern` → `AIH_CA_PATTERN` → `"Zscaler"` default.

### B. npm-heal _(depends on cert/TLS; doc-only)_ — the ladder
- **probe** `node --version` and `npm --version`.
- **L0** npm works → probe `pass`, no action.
- **L1** npm broken, node present, TLS ok → **`doc`** carrying the Node-`https` download+reinstall
  script (heredoc in `templates.ts`), parameterized by the detected npm version, `npmCliPath()`,
  and `NODE_EXTRA_CA_CERTS`. Operator runs it.
- **L2** npm broken, TLS to registry **fails** → **`doc`**: offline path ("fetch `npm-X.Y.Z.tgz`
  elsewhere → `node npm-cli.js install -g npm`") + a back-pointer to step A.
- **L3** node missing → **`doc`**: "install Node ≥20 from your internal software catalog".

### C. path-heal _(ordered after npm so freshly-installed tools resolve)_
- **probe**: is the user bin dir (`~/.local/bin` POSIX / `%USERPROFILE%\.local\bin` Win) on disk?
  on the live `PATH`? exported persistently?
- **fix POSIX**: `envblock` (scope `heal-path`) prepending the bin dir in the shell profile —
  composes with the `certs` block, never clobbers ([plan.ts:79-93](../src/internals/plan.ts)).
- **fix Windows**: `exec` `persistentEnvArgv("Path", …)` (registry, User scope) **plus** a `doc`
  noting the current session stays stale until relaunch. This is where `persistentEnvArgv` earns
  its keep — the `$PROFILE` block alone never reaches GUI-launched Kiro/Claude.

### D. mcp-probe _(depends on npm/npx; read-only)_
- **probe**: can `npx --version` run? do `.mcp.json` servers need npx? Emits a **chained root-cause
  verdict** — if step A or B failed, this reports "blocked on certs/npm", not a bare MCP error.
- No mutation. Optional `digest` summarizing the cause chain for `--json`.

## 5. Platform abstraction — 3 new `HostAdapter` methods

Added to [base.ts](../src/platform/base.ts) and implemented in **all three** adapters; only the
host-matching adapter is `verified`. No factory change (methods ride the interface).

```ts
/** Persist a user-level env var session-independently. Local mutation only. */
persistentEnvArgv(key: string, value: string): string[];
/** Locate npm-cli.js relative to the node binary (for the doc'd self-heal). */
npmCliPath(): string | undefined;
/** Read-only TLS reachability probe for a URL (exit code is the signal). */
tlsProbeArgv(url: string): string[];
```

| Method | Windows | POSIX (darwin/linux) |
|---|---|---|
| `persistentEnvArgv` | `pwsh([Environment]::SetEnvironmentVariable('k','v','User'))` | `[]` no-op (persistence = the profile `envblock`); documented contract |
| `npmCliPath` | `<nodeDir>\node_modules\npm\bin\npm-cli.js` | `<nodeDir>/../lib/node_modules/npm/bin/npm-cli.js`; `existsSync`-gated |
| `tlsProbeArgv` | `curl -Iv` (ships on Win10+), PS `Invoke-WebRequest` fallback | `curl -Iv --max-time 20 <url>` (matches certs) |

## 6. Decisions (locked 2026-06-25)

- **D1 — npm self-heal is doc-only.** The download/reinstall is an emitted operator-run script, not
  an `exec`. Keeps "aih never contacts a remote." If auto-run is ever wanted, it needs a separate,
  explicit network-action design — out of scope here.
- **D2 — Standalone, not an init phase.** Mirrors how host-level `certs` is excluded from `init`.
- **D3 — Generic, env-driven.** `--ca-pattern` + `AIH_CA_PATTERN`; zero hardcoded org/proxy names.
- **D4 — Invariant guard is a test, not a comment.** A test asserts no `exec` in any heal plan ever
  references `registry`/`npm install`/a download (the `certs` suite has the analogous guard).

## 7. File set & integration

| File | Purpose |
|---|---|
| `src/heal/index.ts` | `CommandSpec` + `healPlan` composing the steps (mirrors `init/index.ts`) |
| `src/heal/phases.ts` | The ordered `HealStep[]` (cert→npm→path→mcp) + `--scope` filter |
| `src/heal/cert-verify.ts` | Cert-propagation probes; break → `doc` at `aih certs --apply` |
| `src/heal/npm-heal.ts` | The 4-level ladder (probe + doc) |
| `src/heal/path-heal.ts` | PATH probe + POSIX `envblock` / Windows registry `exec` |
| `src/heal/mcp-probe.ts` | Read-only chained root-cause probe |
| `src/heal/templates.ts` | Node-`https` download heredoc + all `doc` bodies |
| `tests/heal/heal.test.ts` | Vitest + `fakeRunner` + `Proxy` host (mirrors `certs.test.ts`) |

**Registration** — [commands/index.ts](../src/commands/index.ts): import `heal`, add to
`CAPABILITIES` immediately **after `certs`** (reads as the dependency order). Capability options:
`--scope <list>` (default `all`) and `--ca-pattern <pattern>`. Shared `--apply/--verify/--json/--root`
arrive automatically via `addSharedFlags`.

## 8. Test plan (TDD, ≥80%)

Faithful to `certs.test.ts`: a `fakeRunner` keyed on `argv[0]` (`node`/`npm`/`npx`/`curl`/`pwsh`), a
`Proxy`-wrapped host stubbing `trustStoreCerts` + the 3 new methods, a `makeCtx` helper, and
`findProbe`/`findDoc`/`findExec` action finders. Cases:
- cert-verify: env-unset / file-missing / bad-PEM / TLS-fail / all-green.
- npm ladder: L0/L1/L2/L3 each assert the exact action kind + that L1's doc carries the version &
  `NODE_EXTRA_CA_CERTS`.
- path: present / missing-on-PATH / not-persistent, per platform (POSIX envblock vs Win registry exec).
- mcp: npx-ok vs npx-missing → correct chained verdict.
- **invariant guard (D4)**: across every scope, no `exec` argv contains `npm`/`registry`/download.
- per-platform argv via `AIH_PLATFORM` override (windows/darwin/linux).

## 9. Open questions (need a call before/while coding)

1. **cert-verify: compose vs point-at.** Default proposed = *point-at* (`doc` → `aih certs --apply`)
   to keep heal a light diagnostician and avoid re-writing the PEM. Alternative = *compose*
   `certs.plan(ctx)` under `--apply` (heavier, but one-command repair). Lean: point-at.
2. **`--scope` vs `--cli` targeting.** heal is host-level/CLI-agnostic except `mcp-probe`. Proposed:
   `--scope` only; `mcp-probe` reads `.mcp.json` without needing `--cli`. Confirm.
3. **`bootstrap` back-pointer.** Should `aih bootstrap` emit a leading `doc` recommending
   `aih heal --verify` first? (Pointer only, never auto-run — consistent with D2.)

## 10. As-built deviations (implementation discoveries)

Three refinements emerged while implementing against the real renderer/primitives — each an
improvement on the §4 sketch, captured here so the doc stays truthful:

1. **`persistentEnvArgv` moved from path-heal → cert-verify.** §4C assigned the Windows registry
   write to PATH. In practice the higher-value target is **`NODE_EXTRA_CA_CERTS`**: GUI-launched
   Kiro/Claude read env from the per-user registry, not the PowerShell `$PROFILE`, so persisting the
   CA there is the actual fix for the headline "Kiro fails" failure. cert-verify now emits that
   `exec` on Windows (the run's only exec); POSIX returns `[]` and emits nothing.
2. **path-heal is doc-only on both platforms.** Auto-editing PATH via the env-block primitive is
   unsafe — `formatExport` single-quotes values containing `$`, which would break `$PATH`
   expansion, and a raw profile write would clobber the composed `certs` block. So heal diagnoses
   and emits the exact per-shell command as reviewed guidance (consistent with the doc-only npm
   decision, D1).
3. **New `CommandSpec.alwaysVerify` flag.** To make a bare `aih heal` DIAGNOSE by default (like
   `doctor`) while still repairing under `--apply`, heal opts into `alwaysVerify` (run.ts forces
   `verify` for it). Diagnosis is computed once at plan-build and captured into the probes, so the
   report renders without a second curl/pwsh spawn. Visible fix guidance rides on `digest` actions
   (the renderer prints digest text but not plain `doc` text).
