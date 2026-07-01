# Codex Runbook — Trust Gate **T3 → T7** (end to end, autonomous)

> **You are Codex, working in the `ai-harness` repo on branch `codex/trust-gate-t3-t7`
> (based on `origin/main` @ `371a725`).** This runbook is self-contained — implement T3
> through T7 in order. T1/T2 (the trust-danger spine + the two-phase `aih workspace add`
> gate) are already merged; this builds the remaining five slices. Every engine claim is
> verified against this tree; `file:line` citations are to `origin/main`.

## Mission & rules of engagement

- **Implement T3 → T7 in order**, one **conventional commit per slice** on this branch
  (`feat(trust): T3 …`, `feat(trust): T4 …`, …). Do **not** reorder; later slices depend on
  earlier ones (T5 adds the grading seam T3 deliberately defers).
- **After every slice, the full gate must be green** (see "Definition of done"). Do not start
  the next slice on a red gate.
- **One PR at the end** covering T3–T7 (or push the branch and open the PR). **Stop at PR —
  do NOT merge.** A human reviews and merges.
- **DCO sign-off** (`Signed-off-by:`) on every commit; the repo requires it.
- **Hard invariants (never violate):**
  1. **Never execute the untrusted source.** No `npm install`, no running its scripts, no
     spawning its MCP servers, no fetching its URLs. The scanner only **reads files**.
  2. **No remote mutation.** Read-only network (tarball fetch, `git ls-remote`) is allowed
     via `exec` (precedent: `trustFetchExec`, fetch.ts:376; ECC clone, ecc/index.ts). Never
     mutate a remote.
  3. **All gating flows through `Check`/`CheckCode`/verify.** A new failure mode = a new
     sealed `CheckCode` in `src/internals/verify.ts` **plus** routing in
     `src/support/findings.ts`, added **in the same commit as its emitter**. Keep
     `tests/internals/check-code.test.ts` and `tests/support/templates.test.ts` green.
  4. **`skip` never fails a fresh repo.** Tool/network/artifact absent ⇒ `skip`, never `fail`.
  5. **Codebase is the spec.** Read the nearest peer (`src/trust/lint.ts`, `scan.ts`,
     `fetch.ts`, `acquire.ts`, `src/secrets/`, `src/mcp/`, `src/org-policy/`) before writing
     and mirror its shape (probe shape, fingerprint convention, check codes, test layout).

---

## What is ALREADY built — do NOT rebuild (T1/T2, verified)

- **Trust-danger grading.** `GovernanceControl` has `trust-danger`/`trust-origin`
  (posture.ts:19-20); `gradeVerdict(.., "trust-danger", ..)` ⇒ `"deny"` at every posture
  (posture.ts:106). `src/trust/grade.ts:8` `gradeTrustDanger(check)` is a passthrough — a
  danger fail stays failing at vibe (this closed the vibe fail-open). **There is no
  `trust-origin` grader yet** — T5 adds it.
- **CheckCodes so far** (verify.ts:61-64): `trust.fetch-blocked`, `trust.hidden-unicode`,
  `trust.prompt-injection`, `trust.source-changed`.
- **Whole-document instruction lint** (`src/trust/lint.ts`): hidden-Unicode + prompt-injection
  over `SKILL.md`, root `CLAUDE/AGENTS/GEMINI.md`, `.md` under `skills/`/`agents/`/`commands/`.
  `scanTrustDocument(path, source): Check[]` (lint.ts:190); **fingerprint helper**
  `` `${code-with-dashes}:${path}:${line}:${sha256(lineText).slice(0,8)}` `` (lint.ts:74-76).
  Reuses the `LintRule`/`LintFinding` **types** from `src/lint/rules.ts` (NOT `lintDoc`/`RULES`/
  `skipIntervals`). **Reuse this exact fingerprint convention for all new findings.**
- **The scan tree walker / insertion point** (`src/trust/scan.ts`): `scanTrustTree(root):
  Promise<Check[]>` (scan.ts:64) = `assertTrustTreeSafe` → `collectTrustDocs` (markdown only,
  scan.ts:31-54) → `scanTrustDocument` per doc → `pass` fallback. `trustScanProbes`
  (scan.ts:73-97) wraps as probes; `trustScanCommand` (scan.ts:129-145) is the `alwaysVerify`
  `aih trust scan` command. `SKIP_DIRS` (scan.ts:15-24). **Extend `scanTrustTree` — it is the
  single entry both `trust scan` and `workspace add` use.**
- **Fetch + quarantine + pin** (`src/trust/fetch.ts`): `resolveTrustSource` parses local path
  or `owner/repo`; `--pin` must be a 40-char SHA (fetch.ts:125,160). `trustFetchExec`
  (fetch.ts:376) downloads the **tarball at the resolved SHA** into a **tmpdir quarantine**
  (fetch.ts:97), with a **scrubbed env** (`scrubFetchEnv`, fetch.ts:116), tar-path-escape +
  symlink + hardlink rejection (`assertTrustTreeSafe`, fetch.ts:196), and a fail-closed
  `trust.fetch-blocked` on any error (fetch.ts:398). `readTrustFetchMetadata` returns
  `{owner,repo,ref,pinnedSha,...}` (fetch.ts:40,227). `localFileHash` (fetch.ts:414),
  `safeSourceRelative` (fetch.ts:418). **SHA-pin, tarball fetch, quarantine, env scrub,
  containment, and the resolved-SHA record are DONE — T5/T6 read them, don't rebuild them.**
- **Two-phase gate** (`src/workspace/acquire.ts`): `runWorkspaceAdd` (acquire.ts:469) runs
  phase-1 (`workspaceAddPhase1Plan` = `aihIgnoreWrite` + fetch + scan, acquire.ts:127), blocks
  on any phase-1 `fail` (acquire.ts:486), re-scans + re-checks `report.ok`
  (`captureClearedWorkspaceAddTrustGate`, acquire.ts:310), then promotes
  (`workspaceAddPhase2Plan`, acquire.ts:331) writing skills to `contextDir/skills/<source.id>/`
  + `.aih/trust-lock.json`. **In-flight tamper detection (source identity + artifact-hash
  changed between phases) ⇒ `trust.source-changed`** (acquire.ts:339-358). The **trust-lock**
  records `pinnedSha`, `promotedSkills`, `analyzersRun:["aih-native"]`, `artifactHashes`,
  `findings` (acquire.ts:69-92, 278-285). **Because phases 1+2 both call `scanTrustTree`, any
  check you add there flows into the gate automatically.**
- **Reusable elsewhere:** secret scan `scanSecrets(root,{accept})` / `scanConfigSecrets(root,
  files)` (src/secrets/scan.ts) + posture-graded `secretProbes`/`mcpConfigSecretProbes`
  (src/secrets/index.ts); `evaluateMcpPolicy(servers, posture)` reading `egress`/`credentials`/
  `supplyChain` (src/mcp/policy.ts, axes in src/mcp/servers.ts); `OrgPolicySchema` (strict,
  src/org-policy/schema.ts:38-73; `mcp` block template :65-71) + `readOrgPolicy`; `reportToSarif`
  (src/internals/sarif.ts); `execArgv`+`WIN_CMD_SHIMS={npm,npx,yarn,pnpm,scoop}` (src/tools/
  install.ts:179); `probe`/`probeMany` (src/internals/plan.ts:242,246). **`zod ^4.4.3` is a
  dep; there is NO YAML parser** (see T3 §4.5).

---

## Grading model (the danger vs origin split)

- **`trust-danger` codes** are emitted as `verdict:"fail"` and pass through
  `gradeTrustDanger` unchanged ⇒ they **deny at every posture**. Set:
  `trust.hidden-unicode`, `trust.prompt-injection`, `trust.auto-exec-hook`,
  `trust.dependency-confusion`, `trust.typosquat`, `trust.malicious-code`,
  `trust.source-changed` (in-flight tamper). (`trust.fetch-blocked` is **skip-only**.)
- **`trust-origin` codes** route through `postureGradeCheck(check, "trust-origin", posture)`
  (src/config/governance.ts) ⇒ **warn @vibe/team (fail→pass with a `warning-only` note),
  deny @enterprise**. Set: `trust.unpinned-dependency`, `trust.untrusted-publisher`,
  `trust.unsigned-source`, `trust.source-drift`. **The grading seam for these is built in T5**
  (T3/T4 emit only danger codes, so they need no grading wiring).

When T5 introduces origin codes, add a dispatcher and thread posture through the scan:
```ts
// src/trust/grade.ts (T5)
const TRUST_ORIGIN_CODES = new Set<CheckCode>([
  "trust.unpinned-dependency","trust.untrusted-publisher","trust.unsigned-source","trust.source-drift",
]);
export function gradeTrustCheck(check: Check, posture: Posture): Check {
  if (check.verdict !== "fail" || !check.code) return check;
  return TRUST_ORIGIN_CODES.has(check.code)
    ? postureGradeCheck(check, "trust-origin", posture)
    : gradeTrustDanger(check);
}
```
Apply it where the checks become probes (so posture is known at run time), and in the
`acquire.ts` re-scan, so phase-1 and phase-2 grade identically.

---

## T3 — auto-exec tells + dependency-name tells (3 trust-danger codes)

**Goal:** catch the 🟢 capability/auto-exec tier and the 🟢 dependency-name tier — statically
provable, deny at every posture. All raw `fail` (no grading machinery yet).

**New `CheckCode`s** (verify.ts, after `trust.source-changed`):
`trust.auto-exec-hook`, `trust.dependency-confusion`, `trust.typosquat`.

**New files:**
- `src/trust/manifest.ts` — `scanTrustManifests(root): Check[]`. Mirror lint.ts (pure,
  danger fails, location + fingerprint). Detect (all ⇒ `trust.auto-exec-hook`):
  - **Frontmatter** of `SKILL.md` + `.md` under `agents/`/`commands/`: structurally parse the
    leading `---`…`---` YAML (see §4.5) → flag `allowed-tools` containing `Bash(*)` (array,
    flow, or quoted), `permissionMode: bypassPermissions`, `dangerously-skip-permissions:true`.
    **Unparseable frontmatter ⇒ a `trust.auto-exec-hook` fail (fail-closed).**
  - **`package.json`** (every one): `JSON.parse` → flag any of
    `{preinstall,install,postinstall,prepare,prepublish,prepublishOnly}` under `scripts`.
    **Unparseable ⇒ fail.**
  - **`.npmrc`**: line match `ignore-scripts\s*=\s*false`.
  - **Hooks**: a `.claude/hooks/` dir, or a `hooks` key in `settings.json`/`.claude/settings.json`.
  - **`!`-prefix auto-run**: a SKILL-body line starting with optional-whitespace-then-`!`.
- `src/trust/depnames.ts` — `scanTrustDependencyNames(root, internalScopes): Check[]` +
  `resolveInternalScopes(ctx)` + a vendored `POPULAR_PACKAGES` seed list. For every
  `package.json`, over **direct** deps only (`dependencies`/`devDependencies`/
  `optionalDependencies`/`peerDependencies` — NOT transitive; transitive is the 🔴 RED tier
  the gate does not claim):
  - scope ∈ `internalScopes` ⇒ `trust.dependency-confusion`;
  - Damerau-Levenshtein distance **exactly 1** (not 0) from a `POPULAR_PACKAGES` entry, not a
    correctly-scoped form ⇒ `trust.typosquat`.

**Edits:**
- `src/trust/scan.ts` — extend `scanTrustTree(root, internalScopes = [])` to aggregate
  `scanTrustDocument` + `scanTrustManifests` + `scanTrustDependencyNames` before the `pass`
  fallback. Thread `internalScopes` from `ctx` through `trustScanProbes`/`trustScanPlanForSource`.
- `src/workspace/acquire.ts` — resolve `internalScopes` once and pass it to the two
  `scanTrustTree` re-scan calls (acquire.ts:319,347) so phase-2 matches phase-1. (Only edit.)
- `src/support/findings.ts` + the two exhaustiveness tests — one entry per new code.

**§4.5 YAML parser (resolve in this PR):** frontmatter auto-exec detection must be
**structural** (a regex frontmatter scan is evadable via quoted/flow/aliased YAML and will be
rejected in review). `zod` is present but there is **no YAML parser**. **Add `yaml`
(eemeli/yaml, zero-dep), pinned to an exact version** (offline, no network); parse frontmatter
→ read keys; unparseable ⇒ fail-closed. Note the new dep in the commit body.

**Internal npm scope mechanism (decision #5):**
- **Source (T3):** `AIH_TRUST_INTERNAL_SCOPES` env — comma-separated `@`-scopes
  (e.g. `@acme,@acme-internal`), matching aih's `AIH_*` env idiom. Resolver normalizes to
  `@`-prefixed entries; **default `[]`**.
- **Default-empty no-op:** with no scopes, `trust.dependency-confusion` never fires;
  **typosquat still runs** off the seed list. (T5 folds the source into org-policy
  `trust.internalScopes`, env stays an override.)
- **Owed input:** the repo owner supplies the real internal scope(s); until then it no-ops by
  design — do not hardcode any scope.

**Verify:** fixtures — `postinstall` script; `allowed-tools:[Bash(*)]` (+ quoted/flow variant);
`bypassPermissions`; `!`-prefix line; `.claude/hooks/`; `.npmrc ignore-scripts=false`;
**malformed frontmatter** → each fails with `trust.auto-exec-hook`. `@acme/x` dep with
`AIH_TRUST_INTERNAL_SCOPES=@acme` → confusion; env unset → no finding. `reqeusts`/`expresss`
(dist 1) → typosquat; `react` (dist 0) and a dist-2 name → no finding. Clean tree → `pass` and
`aih workspace add <clean> --apply` promotes; `<auto-exec> --apply` exits 1, promotes nothing.
Posture-invariant (fails at vibe and enterprise).

**Done-when:** 3 codes with emitters + routing + exhaustiveness; `scanTrustTree` runs the new
checks; both `trust scan` and `workspace add` catch them; internal-scope env drives confusion
and defaults to no-op; typosquat off the vendored seed; gate + real-CLI green.

---

## T4 — secret scan + incoming-MCP classification (over the quarantine tree)

**Goal:** catch credentials harvested into the source and risky/poisoned MCP config it ships.

**New `CheckCode`s:** reuse existing where possible — incoming `.mcp.json` hardcoded creds ⇒
`mcp.hardcoded-secret`; on-disk plaintext secret ⇒ `secrets.plaintext-detected`; incoming-MCP
policy verdict ⇒ `mcp.policy-denied` (all already in the union). Add none unless a gap appears.

**New file:** `src/trust/mcp-classify.ts` — `classifyIncomingMcp(rawServer): McpServer` that
**derives the risk axes from untrusted `{command,args,url,env}`**: `npx`/`uvx` ⇒
`supplyChain:"unpinned"`, `egress:"local-only"`; an `http(s)` url ⇒ `egress:"third-party"`,
`supplyChain:"hosted-remote"`; a literal token in `env`/`args` ⇒ `credentials:"token"`. Then
feed `evaluateMcpPolicy(classified, posture)` (src/mcp/policy.ts). This is **net-new** — do not
claim `evaluateMcpPolicy` reads raw third-party config directly; it reads the typed axes.

**Edits — `src/trust/scan.ts` `scanTrustTree`:** also run, over the scanned root:
- `scanSecrets(root, {})` and `scanConfigSecrets(root, [incoming mcp config paths])`
  (src/secrets/scan.ts) → map their hits to `secrets.plaintext-detected` /
  `mcp.hardcoded-secret` Checks (mirror `secretProbes`/`mcpConfigSecretProbes`, but rooted at
  the quarantine/local tree — pass the tree root, not `ctx.root`).
- For each incoming `.mcp.json`/`mcp.json`: `classifyIncomingMcp` each server →
  `evaluateMcpPolicy` → emit `mcp.policy-denied` for denied/warned servers (graded as
  **trust-origin** — but T4 ships before T5's grading seam, so **emit incoming-MCP risk as a
  raw `fail` only for the hard cases** (third-party egress + hosted-remote) and defer the
  warn-tier grading to T5; OR land T4 after T5 if you prefer the full grading first — keep the
  commit order but note the dependency). Run the **lint** (`scanTrustDocument`/the prompt-
  injection rules) over each MCP server `description` string ⇒ `trust.prompt-injection` /
  `trust.hidden-unicode` (a poisoned tool description is model-readable instructions).
- **Hosted MCP (locked decision #1):** a server with `egress:third-party` +
  `supplyChain:hosted-remote` → warn @vibe/team, **deny @enterprise**, plus a standing advisory
  ("no post-approval rug-pull protection — run a runtime MCP-scan with tool-pinning before
  first use"). (Its enterprise-deny needs the T5 grading seam; if T4 precedes T5, emit the
  advisory + a raw fail only when posture is enterprise via `ctx.posture`.)

> **Sequencing note:** T4's MCP-policy + secret findings are partly `trust-origin` (warn/warn/
> deny). If implementing strictly in order, emit T4's **danger-class** findings (hardcoded
> secrets, hosted-at-enterprise, description injection) now and wire the **warn-tier** MCP/
> secret grading through the T5 `gradeTrustCheck` seam. Keep secret *plaintext* findings graded
> as the existing `secrets` control already dictates.

**Verify:** fixtures — a `.env` with a token (secrets.plaintext-detected); a `.mcp.json` with a
hardcoded `ghp_…` (mcp.hardcoded-secret); an `npx -y x@latest` server (unpinned), an `http` URL
server (third-party → enterprise deny), a `<IMPORTANT>ignore…</IMPORTANT>` description
(prompt-injection). Each flows through the gate.

**Done-when:** secret + incoming-MCP scans run over the quarantine tree via `scanTrustTree`;
`classifyIncomingMcp` derives axes and feeds `evaluateMcpPolicy`; description injection caught;
hosted-MCP graded per decision #1; gate + real-CLI green.

---

## T5 — pin/drift/allowlist/lockfile/override + the trust-origin grading seam (the big slice)

**Goal:** trusted-source allowlist, signed/pinned origin, upstream drift, and a content-bound
override flow — plus the `trust-origin` grading the prior slices deferred.

**New `CheckCode`s:** `trust.unpinned-dependency`, `trust.untrusted-publisher`,
`trust.unsigned-source`, `trust.source-drift` (all `trust-origin`).

**Grading seam (do this first in T5):** add `gradeTrustCheck(check, posture)` to
`src/trust/grade.ts` (see "Grading model"), thread `ctx.posture` through
`trustScanProbes`/`scanTrustTree` and the `acquire.ts` re-scans, and convert the probe
construction so each check is graded at run time. Add a test that an origin code is `pass`
(warning-only) at vibe/team and `fail` at enterprise, while a danger code stays `fail` at all
postures.

**Org-policy `trust` block** — extend `OrgPolicySchema` (src/org-policy/schema.ts, mirror the
`mcp` block at :65-71, every level `.strict()`):
```ts
trust: z.object({
  approvedSources: z.array(z.object({
    owner: z.string().min(1), repo: z.string().min(1),
    pinnedSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    hostPattern: z.string().optional(),
    reason: z.string().optional(),          // doubles as the committed override ledger entry
  })).optional(),
  requireSignedSource: z.boolean().default(false),
  requiredDetectors: z.array(z.enum(["skillspector","cisco","semgrep"])).optional(),
  internalScopes: z.array(z.string()).default([]),
}).strict().optional(),
```
Extend `resolveInternalScopes` to union the env with `readOrgPolicy(root,env)?.trust?.internalScopes`.

**Checks:**
- `trust.untrusted-publisher` (trust-origin): a `github` source whose `owner/repo` is not in
  `approvedSources` (when `approvedSources` is defined). `undefined` ⇒ open (no finding).
- `trust.unsigned-source` (trust-origin): a `github` source acquired without an explicit
  `--pin` (HEAD/ref-resolved) when `requireSignedSource` is set, or with no attestation.
- `trust.unpinned-dependency` (trust-origin): a `package.json` dep with a floating range
  (`^`/`~`/`*`/`latest`) or a missing lockfile; an MCP server launched `@latest`.
- `trust.source-drift` (trust-origin, detected by `aih trust verify`): the source's pinned ref
  now resolves to a different SHA than the trust-lock recorded (a moved branch/tag = rug-pull
  signal; a pinned-SHA source cannot drift).

**`aih trust` subcommands** (new — register alongside `trust scan` in src/commands/index.ts):
- `aih trust allow <owner/repo> [--pin <sha>]` — append to org-policy `approvedSources`
  (an `--apply` write; the committed allowlist + override ledger).
- `aih trust list` — print approved sources + the local trust-lock sources.
- `aih trust pin <owner/repo> --pin <sha>` — record/refresh a pin.
- `aih trust verify [<id>]` — re-check promoted sources: re-hash promoted artifacts (local
  drift) **and** `git ls-remote` the source ref, comparing to the recorded `pinnedSha`
  (upstream drift ⇒ `trust.source-drift`). `ls-remote` is an `exec`; spawn/timeout/127 ⇒
  `trust.fetch-blocked` skip (never fail — egress-blocked enterprise must degrade).

**Content-bound `--acknowledge`** (on `workspace add`/`trust scan`):
- Each fingerprint already embeds a content hash (lint/manifest fingerprints). An ack stores
  the full `contentHash`. Before report accumulation, an acked fingerprint converts that Check
  to `verdict:"skip"` (detail `acknowledged by <who>`). On re-scan the fingerprint is re-derived
  from current bytes, so any change invalidates the ack.
- **Refused for every `trust-danger` code** (a reverse shell / injection cannot be acked into a
  promote). `trust-origin` deny-grades (enterprise) are overridable with a `--reason`, persisted
  in the committed org-policy `approvedSources[].reason` (the override ledger — decision #4).
- Support `--acknowledge <fp,…>` and `--acknowledge-all --reason <text>`; on a block, print the
  exact copy-pasteable acknowledge command.

**Required-detector (decision #2):** `requiredDetectors` set + a detector absent ⇒ **fail-closed
at enterprise only**; vibe/team degrade-with-banner. (The detector spawning lands in T6; T5
defines the policy field + the enterprise fail-closed grading.)

**Verify:** off-allowlist source warns @team, denies @enterprise; `--pin` source clears
unsigned; a floating dep warns/denies by posture; `aih trust verify` flags a moved ref as
`trust.source-drift`; acking a danger fingerprint is refused; acking an enterprise origin
deny-grade with `--reason` promotes and writes the ledger; re-scan after editing the acked file
re-blocks. Lockfile + allowlist round-trip.

**Done-when:** the four origin codes + grading seam; org-policy `trust` block; the `aih trust`
subcommands; content-bound acknowledge + override ledger; required-detector enterprise
fail-closed; gate + real-CLI green.

---

## T6 — external detectors + doctor re-hash + `trust verify` + Windows routing

**Goal:** optional corroborating detectors (SkillSpector) + local-drift detection in `doctor`,
all degrading honestly when a tool or the network is absent.

**Edits / new:**
- `src/trust/detectors.ts` (new) — **presence-gated** SkillSpector via Docker (sandboxes the
  untrusted read): `docker run --rm -v "<quarantine>:/scan" skillspector scan /scan --no-llm
  --format sarif`; ingest the **SARIF**, map `rule_id` → `trust.*` via a fixed lookup table.
  Detector **absent / spawnError / 127 / timeout ⇒ `skip`** (never fail) **and** a prominent
  **degraded-coverage banner** ("deep scan SKIPPED — coverage is GREEN-tier only"); the "no
  findings ≠ safe" line enumerates which analyzers ran. **LLM passes off by default** (decision
  #7) — `--no-llm` always; only enable on explicit opt-in (they ship file contents to a vendor).
- **Windows routing:** `docker`/`uvx`/`semgrep`/`skillspector` are NOT in `WIN_CMD_SHIMS`
  (tools/install.ts:179). Route every external spawn through `execArgv` (widen the set or wrap
  any non-`.exe` shim in `cmd /c`); add a `platform="windows"` test asserting the detector argv
  starts with `["cmd","/c",…]` for shim binaries.
- **Required-detector fail-closed:** wire decision #2 — a configured-but-absent
  `requiredDetector` at **enterprise** ⇒ `fail`; vibe/team ⇒ the degraded banner.
- `src/doctor.ts` — add a read-only check that re-hashes the **promoted** artifacts recorded in
  `.aih/trust-lock.json` (`artifactHashes`) and compares to disk ⇒ **local drift only** (a
  promoted file was edited after acquisition). `doctor` must **not** claim upstream-rug-pull
  detection (that's `aih trust verify`, T5). Record `analyzersRun` honestly in the lock
  (`["aih-native","skillspector@docker"]` when it ran).

**Verify:** with Docker absent → `trust scan` still runs (aih-native floor) and prints the
degraded banner + skip; with a stub detector present → its SARIF findings map to `trust.*`;
enterprise + required-but-absent → fail; `doctor` flags an edited promoted artifact; Windows
argv test green.

**Done-when:** external detectors corroborate without ever being load-bearing or executing the
skill; absence degrades (skip + banner); enterprise required-detector fails closed; `doctor`
catches local promoted-artifact drift; gate + real-CLI green.

---

## T7 — malicious-code deep scan + AMBER/RED runtime advisories

**Goal:** optional offline code-pattern scan of bundled scripts + an explicit runtime hand-off
for what static analysis cannot cover.

**Edits / new:**
- `src/trust/detectors.ts` — optional `trust.malicious-code` (trust-danger) via **offline**
  Semgrep/YARA with **vendored** rules (no runtime rule fetch; absent rules ⇒ skip), or an
  aih-native pattern set (reverse-shell / `curl|sh` / base64-pipe-to-shell) over bundled
  scripts. Route external spawns via `execArgv`; spawn/timeout ⇒ skip.
- **AMBER/RED advisory emitter** — a `doc`/digest action that states plainly what the gate does
  NOT cover and the runtime mitigation: transitive/pinned-dependency malice ⇒ run a sandboxed
  `npm install --ignore-scripts` + `npm audit`; hosted-MCP rug-pull ⇒ runtime MCP-scan with
  tool-pinning before first use; residual auto-exec risk ⇒ set `permissions.deny:[Bash(*)]`.
  Never auto-run any of these.

**Verify:** a fixture script with a reverse-shell pattern ⇒ `trust.malicious-code` (when the
deep scan is available); rules/tool absent ⇒ skip + the advisory still prints; the advisory
enumerates the RED tier honestly.

**Done-when:** optional deep scan emits `trust.malicious-code` when available and skips cleanly
when not; the AMBER/RED runtime hand-off is explicit and never auto-executes; gate + real-CLI green.

---

## Definition of done (run after EVERY slice; verify exit codes, not pipe tails)

```
npx tsc --noEmit          # strict typecheck
npx biome ci src tests    # CI/release linter (stricter than `biome check`)
npx vitest run --coverage # meet the floors in vitest.config.ts
npx tsup                  # build
```
Plus the **real CLI** for the slice (e.g. `npx tsx src/cli.ts trust scan <fixture>` →
exit 1 on a malicious fixture, 0 on a clean one; `npx tsx src/cli.ts workspace add <clean>
--apply` promotes; `<malicious> --apply` exits 1 and promotes nothing). New `CheckCode`s must
keep `tests/internals/check-code.test.ts` + `tests/support/templates.test.ts` green.

**At the end:** push the branch and open ONE PR titled `feat(trust): T3–T7 — auto-exec, deps,
secrets/MCP, pin/allowlist/override, detectors, deep scan`, summarizing each slice. **Stop at
PR.**

---

## Evidence appendix (`origin/main` @ `371a725`)

- Controls/grading: posture.ts:19-20, :106; grade.ts:8-10; governance.ts:10-24 (postureGradeCheck).
- CheckCodes: verify.ts:61-64. Routing: support/findings.ts (`Record<CheckCode,…>`, trust
  entries ~L384-410). Exhaustiveness: tests/internals/check-code.test.ts, tests/support/templates.test.ts.
- Lint + fingerprint: lint.ts:3 (types), :74-76 (fingerprint), :190-200 (scanTrustDocument).
- Scan insertion point: scan.ts:64-71 (scanTrustTree), :31-54 (collectTrustDocs, markdown-only),
  :73-97 (trustScanProbes), :129-145 (trustScanCommand), :15-24 (SKIP_DIRS).
- Fetch/quarantine/pin (already built): fetch.ts:125,160 (--pin 40-char), :97 (tmpdir quarantine),
  :116 (scrubFetchEnv), :196-225 (assertTrustTreeSafe symlink/hardlink/escape), :376-412
  (trustFetchExec tarball-at-SHA + fail-closed), :40,227 (metadata pinnedSha), :414,418 (hash/rel).
- Two-phase gate: acquire.ts:469-526 (runWorkspaceAdd), :127 (phase1), :310-329 (capture/re-scan),
  :331-371 (phase2 promote + lock), :69-92,278-285 (trust-lock shape), :339-358 (source-changed),
  :179-216 (buildPromotion → contextDir/skills/<id>), :319,347 (re-scan calls to thread scopes/posture).
- Reuse: secrets/scan.ts (scanSecrets/scanConfigSecrets/MCP_CONFIG_FILES), secrets/index.ts:82,96
  (secretProbes/mcpConfigSecretProbes); mcp/policy.ts:79 (evaluateMcpPolicy), mcp/servers.ts:37/46/54
  (egress/credentials/supplyChain axes); org-policy/schema.ts:38-73 (OrgPolicySchema strict, mcp
  block :65-71), readOrgPolicy; sarif.ts:50 (reportToSarif); tools/install.ts:179 (execArgv/
  WIN_CMD_SHIMS); plan.ts:242,246 (probe/probeMany), :29 (ActionKind), :177-183 (alwaysVerify);
  execute.ts:157 (executePlan: commit→exec→probes), :91 (writeArtifact), :51-69 (assertContained).
- Deps: package.json `zod ^4.4.3`; **no YAML parser** (add pinned `yaml` in T3).
