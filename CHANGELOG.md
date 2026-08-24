# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A closed AIH-managed adapter governs the fixed usage-metering projection without admitting
  arbitrary executable materialization.** `aih policy managed usage-metering describe` reports one
  code-derived `tool/usage-metering` subject, adapter id/version/digest, `configure` effect, and
  `claude|codex` target set. `reconcile` accepts only an exact externally verified V3 decision,
  current canonical organization evidence, and one fixed target; preview is zero-write, and literal
  `--apply` can write only the fixed recorder, host hook entry, ignore marker, and strict V4 ownership
  receipt. Apply commits an exact durable claim before effects, re-observes authority,
  qualification, ownership, and linked-path custody at the effect boundary, asserts exact outputs
  before success, and retains bounded predecessor-linked audit state. Exact reconciliation is
  zero-write. A current authenticated revocation can subtract only the exact code-derived recorder,
  hook entry, and ignore marker after live output validation; host/ignore documents and non-AIH
  content remain, because self-digested ownership metadata is never deletion authority. Revoked
  custody makes no process-termination claim; drift preserves disputed bytes and reports
  non-effective truth. Legacy V1-V3 receipts never satisfy this
  route, and a future code-derived source change requires an explicit shipped predecessor migration.
  The packed disposable-root proof currently establishes installed-byte discovery, clean
  inspection, and fail-closed refusal without authority; successful configure/revoke remains
  unclaimed until a genuine organization V3 receipt has a separately authorized public GitHub
  attestation for the exact candidate. (#854)

- **Policy resolution reports exact qualification provenance instead of the collapsed `qualified`
  state.** `aih policy resolve` emits `organization-qualified` only after canonical organization
  evidence is current and verified. `aih policy observe npm-package` emits the exact
  decision-selected `organization-qualified` or `aih-supported` route after qualification, retains
  that provenance when a later installed-state, observation, or custody check refuses, and reports
  `unqualified` before qualification succeeds. These values are derived reporting facts, not caller
  input or authorization; authority, effect resolution, exit codes, writes, and lifecycle persistence
  are unchanged. (#852)

- **Governed evaluation and reports now consume the durable npm lifecycle as observed state.**
  For a governance-owned target, `aih policy evaluate <root> --no-log --json` and the governed report path read
  only the fixed `.aih/governance/npm-package-lifecycle/v1/` store, validate each current head and
  its complete bounded history, and freshly verify the V3 authority receipt before classifying the
  exact package/target lineage. Current exact observations are `observed-effective` for at most 24
  hours and never beyond the authority, decision, or conditional-review deadline; partial,
  withheld/refused, revoked, stale, and drifted states remain distinct, non-effective, and block
  evaluation. Observation expiry alone does not freeze unrelated policy projection, while unsafe
  custody, authority failure, rejection, revocation, and other lifecycle failures still block it.
  Missing or unsafe store custody, malformed or substituted heads/records/bindings, detached history,
  authority replacement, current rejection or revocation, decision/source/subject/target/effect
  mismatch, and future-dated or expired observations fail closed. Directory enumeration stops at
  256 active lineages, 16,384 aggregate records, and 4,096 records in any one lineage instead of
  first materializing an unbounded hostile directory. A store beyond those limits is reported as
  `over-capacity`, not as fabricated corruption, and remains fail-closed for both evaluation and
  projection. Preserve the complete store as organization-controlled evidence and move incident
  reconciliation to a newly governed target; do not prune the target-local audit chain in place.
  The result is deterministic and read-only: it does
  not install, update, remove, configure, project, execute, or publish a package, and it does not make
  custom stdio or remote MCP candidates projectable. (#845)

- **`aih policy lifecycle npm-package` persists exact governed observation, bump, and revocation
  history without managing the package.** Preview is zero-write; `--apply` first repeats the current
  V3 authority, decision-selected qualification, npm v3 lockfile, installed-manifest, and
  observation checks, then appends one canonical content-addressed record and advances a subject
  head under the dedicated `.aih/governance/npm-package-lifecycle/v1/` store. Exact
  version/integrity changes keep one stable package/integration lineage while preserving prior
  records. A current authenticated V3
  decision revocation can append a revocation record only on an existing verified lineage, but remains
  non-effective and produces a failing, nonzero verification result; it makes no package-removal or
  process-stop claim.
  The transaction pins all authorizing bytes, writes a durable subject-and-target lineage claim before
  the ordinary binding, uses one store-wide cooperative lifecycle lease, and advances a strict
  writer-only aggregate capacity guard before the lifecycle mutation. The guard prevents stale
  cross-lineage plans from racing past the reader's 256-lineage or 16,384-record limits; the reader
  independently derives store truth and never treats the guard as authority. The transaction commits
  the immutable record durably before its head, gives each prepared write no more than 60 seconds to commit,
  rechecks that deadline and filesystem custody during commit, and
  re-reads the exact claim, binding, record, head, and bounded lineage before reporting success. The
  claim prevents ordinary binding loss from silently admitting a different lineage. A crashed lease is
  reclaimable after a bounded 30-second mutation window plus 30-second recovery grace; malformed or
  foreign lock state blocks, and the inert canonical anchor can remain. This coordinates local AIH
  writers rather than providing an operating-system or hostile-process isolation boundary. Corrupt,
  substituted, expired, detectably rolled-back, forked, linked, raced, over-capacity, or detached state
  fails closed; refused apply attempts append no governance claim, record, or head, though an interrupted
  apply can leave inert canonical lock metadata or the private scratch for its immutable record. Only
  byte-identical canonical bytes at that exact scratch path, with single-link custody rechecked at the
  transaction effect boundary, can be consumed by a retry; mismatched, linked, or foreign scratch fails
  closed without cleanup. Only the same prepared canonical bytes can reuse a completed-record crash
  orphan; a freshly timed command normally fails closed for approved operator incident reconciliation
  instead of deleting or silently adopting it. The command never installs, updates, removes,
  configures, executes, signs, or publishes a package, and remains limited to the fixed root npm
  route for organization-qualified or durably accepted AIH-supported decisions. On the supported
  route it pins the exact receipt and signer/replay/member/head custody, then revalidates the full
  bounded custody graph before reporting fulfilled. A target-local chain cannot detect a
  coordinated rollback that deletes both subject indexes, or a head advance and all later records;
  administrators must retain the whole store in organization-controlled versioned evidence. (#844)

- **`aih policy observe npm-package` reports an exact qualified npm install without installing or
  executing it.** The zero-write command derives one npm package and the fixed `install` effect
  from an exact current Decision V2. An organization-qualified decision requires its canonical
  organization evidence. An AIH-supported decision rejects that option and instead requires the
  exact separately attested Receipt V2 plus current head-scoped administrator custody. It then reads
  only the target root's bounded regular npm v3 lockfile and matching installed `node_modules`
  manifest, rejects linked,
  malformed, non-NFC, ambiguous, changed, or mismatched custody, and feeds an internal opaque
  observation into the existing resolver. An exact current match reports `observed-effective`
  with the full canonical receipt digest. Missing installed evidence remains non-effective
  `partial`; every unsafe, stale, rejected, revoked, or mismatched state refuses. The caller cannot
  supply a package, effect, observer, verifier, runner, clock, receipt, callback, or alternate
  install source. The command writes no target or ledger state, installs and executes nothing,
  and does not add an adapter, MCP/skill observation, signing, publication, or a bypass for held
  executable-package admission. (#842, #848)

- **`aih policy resolve` exposes the first read-only Strict V2 administrator resolution path.**
  The zero-write command accepts only an exact Decision V2 id/digest, a code-owned target and
  effect, and one bounded canonical organization-evidence envelope below the target root. It
  verifies the fixed V3 authority receipt through the existing out-of-band GitHub attestation
  boundary, re-observes evidence bytes and file identity after that process, then derives the
  opaque organization qualification internally. Inputs, unsafe custody, authority, decision,
  scope, qualification, and live-expiry failures return closed public-safe reasons. Because
  `policy resolve` deliberately supplies no upstream observation, a valid qualification reports
  `observation-missing` as non-effective `partial` with a nonzero exit; no route can report
  fulfilled, append a run ledger, export a capability mint, install, configure, execute, or
  observe a candidate. (#840)

- **Strict V2 can independently verify an attested AIH-supported qualification without making
  catalog membership an organization approval.** Core replaces Receipt V1 with one closed canonical
  Receipt V2 schema that binds the exact Decision V2 subject, all seven `aih-supported`
  catalog-basis fields, entry id, signer key, sequence, predecessor, replay identity, explicit
  non-admission, and bounded head validity. The library verifier reads only the fixed bounded
  regular file, rejects linked custody, verifies an owner-only private copy with an absolute
  external `gh` against dedicated supported repository/workflow roots, and then parses the exact
  copied canonical bytes. It refuses organization-authority root reuse, noncanonical or substituted
  bytes, stale or mismatched fields, receipt validity outside the current decision window, and raw
  or cloned capabilities. The package root exposes only an inert artifact verdict: it accepts a
  target root plus the exact expected decision reference and subject, owns the process runner and
  live clock, and returns neither authority nor a qualification capability. Because the inert call
  has no target or effect input, any other current unrevoked rejection for the same subject fails
  the verdict closed. The authority-bearing verifier remains package-internal.
  `aih policy supported accept --apply` adds bounded versioned signer/replay/head/member custody
  under a fixed cooperative lock; `inspect` is deterministic, scrubbed, and read-only. It lists
  current-head members separately from the exact occupied/remaining physical member-record capacity.
  Superseded member records remain immutable replay/audit evidence, continue to count toward the
  4,096-record cap, and are not pruned automatically; reaching the cap fails new acceptance closed
  and requires separately authorized operator migration or archival. Genesis, exact succession,
  member renewal, replay refusal, capacity, link, race, and detached-state checks fail closed. A
  current exact AIH-supported npm decision can use that custody through the same
  fixed observer and lifecycle path without an organization evidence envelope. These commands do
  not fetch a catalog, install, project, execute, sign, release, or publish anything. Simulated test
  attestations are not public verification evidence. (#835, #848)

- **Strict V2 observed effects now require independently verified organization qualification.**
  Core accepts only canonical, bounded organization-evidence bytes that bind the exact subject,
  evidence record, payload and artifact digests, issuer-claimed attestor, and current validity
  window. The domain-separated evidence digest and attestor must match an exact decision inside
  an externally verified authority receipt V3 before Core mints an opaque, clone-resistant
  qualification capability. The upstream-observation resolver requires that capability and fails
  closed on missing, unverified, mismatched, expired, or time-rewound qualification before it can
  report `observed-effective`. Evidence kinds remain bounded organization identifiers rather than
  a Core allow-list. This is a pure zero-effect runtime boundary: it does not sign evidence, trust
  a scanner result as approval, or install or execute a candidate. The separately rooted
  `aih-supported` verifier is tracked and implemented under #835. (#834)

- **Strict V2 establishes the data-only organization-qualified governance boundary without
  making the maintained catalog an allow-list.** A public canonical decision contract covers
  exact GitHub, npm, PyPI, OCI, remote, and AIH identities for tools, skills, MCP servers,
  packages, and profiles. Canonical helpers derive the source and subject digests from the closed
  descriptor, including path-based private registries and exact remote HTTPS endpoints. Its
  qualification basis points either to exact attributable organization evidence or to an exact
  catalog signer identity plus head, catalog, and member digests; neither path self-authorizes.
  Decision V2 binds policy/control identity, registered targets and effects, issuer, actor,
  disposition, and bounded validity; digest-bound revocation V2 travels with it only inside
  externally verified authority receipt V3. A separate
  upstream-observation receipt records exact installed identity, upstream integration owner and
  version, code-owned verifier identity, phase-honest outcome, and bounded freshness. The internal
  pure resolver returns effective only when an opaque, externally verified, attested authority
  receipt V3 supplies the exact current approved or conditionally accepted decision and a
  separate exact successful observation matches it; rejection, revocation, stale or partial
  observation, unknown target/effect/verifier, or any binding mismatch stays non-effective. This
  foundation performs no scan, preview, install,
  process, network, or filesystem effect, does not yet make custom policy candidates projectable,
  and does not widen the held ECC or generic executable-package closures. (#832)

- **Applied administrator Workbench generation can refresh the exact vendor baseline evidence
  channel without granting a developer-seat fetch path.** A separate administrator bootstrap pins
  credential-free HTTPS locators, publisher repository/workflow/issuer/ref/environment identity,
  the supported ECC and Superpowers source commits, schema bounds, and cache age. The applied
  administrator-root route resolves fresh, reverified last-downloaded, then packaged evidence;
  only first-artifact HTTP 404 or 410 is unavailable and advances to the next tier. DNS, TLS,
  connection, request, timeout, redirect, and other non-200 statuses are terminal so origin
  reachability cannot force cached or packaged evidence; malformed, stale, mismatched, untrusted,
  partial, or uncommitted evidence is terminal too. Fresh and cached subjects are verified locally
  and through an exact `gh attestation verify` policy before a contained owner-only cache commit or
  Workbench render. Rootless and non-applying routes gain no network, process, or cache effect, and
  the Workbench receives only bounded tier/source/schema/digest/age/time provenance — never
  locators, paths, credentials, signatures, or raw attestations. (#814)

- **Offline revocation has a replay-resistant, inert V1 contract before any continuation is
  enabled.** A canonical signed snapshot binds its exact issuer, monotonic sequence,
  second-granularity issuance and validity window, and the complete sorted decision-id revocation
  set through a domain-separated DSSE/in-toto subject. Every resolution and custody transition
  re-verifies the signed bytes against caller-supplied administrator signer/root trust; a cached
  verification result is never authority. Validity is bounded to 60 seconds through 90 days, and
  snapshot coverage cannot predate the decision or extend the decision expiry, receipt expiry, or
  review deadline. Per-issuer sequence/digest high-water state rejects rollback and equal-sequence
  substitution, while its synchronous compare-and-swap seam observes live state before and after
  the claim and reports races or corrupt state without another effect. Missing or expired coverage
  is `stale-authority`; future, malformed, unverifiable, or conflicting authority is invalid. Even a
  current exact revocation remains non-materializable data: this foundation adds no filesystem,
  process, network, deletion, subtraction, stop, CLI, Workbench, or public-library route. (#816)

- **Vendor baseline evidence now has a deterministic, separately attestable artifact.**
  The bounded artifact binds the exact shipped lock, evidence bundle, manifest,
  publisher, source pins, and a checksum subject covering every file. Local
  verification completes before caller-owned GitHub attestation verification.
  Its manual workflow separates unprivileged candidate preparation from a
  protected-environment attestation job; merge does not run it, and it includes
  no release or package-publication effect. (#815)

- **`aih report` adds a deterministic governed-subject review without turning local usage into
  authority.** The read-only digest keeps requested/effective state, evidence and blockers,
  decision/approval/revocation facts, projector capability, strict receipt state, and local usage
  coverage separate for every governed subject. An explicit MCP-server identity is authoritative
  even when it is unknown; otherwise unique name matches remain heuristic. Unknown or ambiguous
  subject evidence, ordinary non-subject activity, and rejected payloads become separate bounded
  counts only, and absent capture is distinct from installed capture with no observed events.
  Non-effective subjects report `not-projected` while retaining any surface-wide receipt under a
  separate key. Low or zero counts never change effective state, infer value, or recommend
  retirement. Invalid or non-governing policy and absent/invalid receipts remain explicit and
  redacted; Package Graph identity is not inferred.

- **The Policy Workbench teaches the first bounded adoption recipe without creating another
  control plane.** An inert, code-owned panel assigns the low-token orientation, exact-symbol,
  broad-impact, durable-memory, and on-demand overhead questions to Token Savior, Serena,
  code-review-graph, codebase-memory-mcp, and Token Optimizer respectively. It keeps their real
  lifecycle, existing-row, and approval/manual-only routes distinct; states prerequisites,
  overlap, and captured-usage limits; and fails closed if the owning profile or catalog facts
  drift. The panel adds no inventory row, selection, approval, authority, evidence, projector,
  materialization, provider execution, or exported policy state. Generic signed recipe
  distribution remains outside this surface.

- **Pinned Superpowers scan acceptances are independently reproducible.** Maintainers can run
  `npm run check:scan-acceptance -- --checkout <absolute-path>` against a separate, clean checkout
  detached at the shipped Superpowers commit. The read-only JSON audit re-runs the existing content
  inspector, sorts exact code/path/LF-normalized-content-digest observations, and distinguishes
  matched, stale, missing, new, and critical findings. It never edits the checkout or acceptance
  artifact, never accepts a finding, and never authorizes the runtime scan gate.

- **Binding scan residuals are explicit and reproducible.** Scan dispositions now retain every raw
  finding in a deterministic per-file rollup, including distinct absent, false, and true acceptance
  states. Turkish dotted and dotless I remain advisory only in proven prose, comment, and string
  contexts; identifier, key, code, bidi-control, and standalone variation-selector positions remain
  blocking. Dotted I retains the detector's raw medium finding while the binding gate applies the
  blocking policy through an exact-hash, contained reread; missing, changed, linked, or escaping
  paths fail closed and cannot be accepted. A maintainer-only regeneration command rewrites the
  deliberately empty Superpowers acceptance ledger only after the existing checker proves the exact
  detached, clean, unlinked,
  no-replacement-ref vendor checkout; check mode is byte-exact and read-only, and neither mode can
  accept a finding or authorize a runtime gate. Claude user settings are reported as a harmless
  husk only when they contain schema/comment metadata and recognized empty hook, plugin, MCP, or
  skill-override containers; malformed structure remains a warning, any other setting does not
  receive the husk classification, and active content remains contamination. (#817)

- **Governance decisions gain a canonical, inert V1 transport contract.** The strict record keeps
  `approved`, `accepted-with-conditions`, and `rejected` immutable, while revocation is a separate
  record bound to the decision and issuer. Bounded identifiers, exact candidate/source/evidence/
  reviewed-control/target/effect identity, sorted coverage, offset-qualified bounded validity,
  conditions, actor, and reason produce format- and version-domain-separated deterministic bytes
  and digests. These records are data only: this foundation verifies no signer or receipt, resolves
  no observed finding, authorizes no projector, and changes no Workbench or runtime effect.

- **Externally verified governance decisions now control qualified policy effects.** Authority
  receipt V2 carries strict decision and revocation artifacts, and the effective resolver joins each
  referenced decision to the exact candidate, source, evidence, AIH-shipped control, policy version,
  target set, effect set, issuer, validity window, and observed dispositionable findings. Accepted
  findings remain visible and are reported as accepted risk; signed decisions cannot waive a fenced
  prerequisite, invent evidence, unlock custom candidates, or broaden projector support. Evaluate,
  doctor, managed settings, Claude/Kiro MCP ownership, and usage-hook ownership expose deterministic,
  public-safe decision identity and blocker state without decision conditions. New MCP ownership is
  always strict V2 and new usage-hook ownership is always V3 with domain-separated self-digests;
  legacy MCP V1 and usage-hook V2 receipts remain readable only for exact conservative cleanup or a
  receipt-only upgrade, never as current decision authority. The generic record reserves named-gap
  coverage for future explicitly registered waivable gap classes; the current resolver registers none,
  so accepted and observed named-gap lists remain empty and evidence gaps stay non-waivable blockers.

- **The portable Policy Workbench now inspects governance decisions without granting authority.** It
  imports one standalone strict `GovernanceDecisionV1` into state separate from the authored policy and
  imported receipt, labels it unverified and not effective, renders untrusted fields as text, and emits
  the same deterministic canonical bytes as the headless parser. Invalid or out-of-order replacement
  reads fail closed and preserve the decision that was displayed when the latest import began. This
  browser surface cannot edit, verify, sign, fetch, resolve, project, or materialize a decision, and a
  decision import never changes policy, approval, receipt, or effective state.

- **Sharded ECC baseline vetting now requires a source-bound static preflight receipt.** A
  dispatcher can run the preview generator's lexical dependency-closure check once before
  launching scanner shards, then carry the strict receipt to every shard and the final fan-in.
  The receipt binds the exact ECC catalog identity, ordered installer runtime paths, static-check
  contract versions, and whole-source tree hash; stale, forged, sharded, oversized, linked, or
  mismatched inputs fail closed. This moves cheap structural rejection ahead of expensive scanner
  fan-out without executing upstream code early or replacing the authorized preview boundary's
  independent post-evidence check. Receipt files must remain outside the attested ECC tree, and
  ordinary single-host vet and check flows remain unchanged.

- **Repair V1 is reachable through its live precondition without widening Audit.** `aih repair`
  now derives the one code-owned `create-managed-directory("ai-coding")` plan from the branded
  canonical precondition, not from the general Audit finding projection. A valid temporary root
  with the canonical marker and an unoccupied target can therefore preview the plan even when an
  unrelated diagnostic is unresolved; the operation and precondition must still bind the same
  resolved root. Preview and consent disclose the precondition digest, target occupancy, and Audit
  completeness. The read-only `aih governance-doctor --repair-plan` projection remains
  `executable: false` and is not widened into an execution surface. If the effect verifies but the
  fresh post-audit is partial, Repair reports `repairState: partial`, states the remaining audit
  qualification, and exits zero; unavailable post-audit or unverified effects remain failures.

- **Repair disclosures keep human and structured output distinct.** A verified effect with a partial
  fresh post-audit is a qualified `repairState: partial` result; bounded residual entries remain in
  structured result data for machine consumers rather than being expanded into the human summary.
  An indeterminate target occupancy is a distinct precondition refusal before consent, claim, or
  effect, separate from an occupied target that simply has no mechanical repair available.

- **Precondition probe reachability clarification.** The probe is now consumed by the closed `aih
  repair` route and is code-observed and re-observed by the live attempt. It does not make the
  read-only `aih governance-doctor --repair-plan` executable and does not accept operator-supplied
  authority.

- **Current Repair write-state boundary.** The closed command route reports durable authority separately from its target effect: a committed claim is `create` in the claim store, while an applied idempotent or raced pre-existing directory is `unchanged`, never `create`; a post-claim race that prevents the effect reports the claim as spent and no applied effect. Effect verification, a fresh post-audit, and repair state remain separate facts. The live route is licensed by the branded precondition described above, not by widening the general diagnostic mapping.

- **`aih repair` is a separate, TTY-confirmed Governance Doctor repair route.** The new top-level command is dry-run by default and previews only the code-owned target `ai-coding` plus the full lowercase Plan and Summary SHA-256 digests. A repair can run only under literal CLI `--apply`; ambient `AIH_APPLY`, injected option values, `--yes`, JSON mode, environment/file/callback confirmation, piped input, EOF, Ctrl-C, timeout, uppercase or partial digests, the Summary digest, and trailing text all refuse before consent, claim, or effect. The local terminal prompt requires both stdin and stdout to be TTYs and accepts only an exact raw answer equal to the Plan digest. After confirmation the command mints out-of-band consent, spends the durable claim, re-observes the live precondition before the claim and again at the effect boundary, applies only `create-managed-directory("ai-coding")`, independently verifies the effect, runs a fresh post-audit, and reports `effectVerification`, `postAuditState`, and `repairState` as separate facts. The command uses an isolated zero-write flag surface (`--apply`, `--json`, `--posture`, `--root`, `--context-dir`) with no support ticket, ledger, force, target-selection, detect, or yes flags. `aih governance-doctor` remains read-only and its `--repair-plan` output remains non-executable.

- **A Repair attempt's outcome is three separate facts, and one of them can never speak for the others.** Creating `ai-coding` is a small, verifiable thing; the temptation once it verifies is to let that success stand for the workstation. Effect verified, Audit healthy, and Repair complete are three different claims, and only the first is proved by the effect. A closed repair-specific completion record now carries all three independently: whether the literal `ai-coding` effect independently verified; what a *fresh* post-execution audit says (`healthy`, `partial`, or `unavailable`); and whether the Repair is `complete`, `partial`, or `failed`. `complete` requires the effect verified, the fresh audit healthy, every trusted join holding, and the receipt verifying. `partial` is the single shape where a verified effect coexists with a workstation that still reports problems — not a failure, not a success, and not rounded to whichever is nearer. `failed` covers an unverified effect, an unavailable or malformed post-audit, and any trusted join that does not hold. A receipt records what an executor did and is never read as a certificate of its own success: verification is a separate record from a separate verifier against the live tree, and the effect counts as verified only when this exact identity is both reported applied and confirmed by exactly one matching verifier check. **Audit V1 is untouched** — its schema and XOR were not widened to carry a mutation's outcome; `healthy` here is deliberately stricter than Audit's own `completed`, since a repair may not call a workstation well while it still reports problems. Refusal and failure stay distinct: an input that is not what it claims to be mints nothing, because a completion record implies the attempt was real, while a genuine input that does not agree mints a `failed` record, because that is something that happened. The record binds plan, consent, spent claim, resolved-scope, precondition-evidence, receipt, post-audit, and report digests plus the exact effect identity, and its residual is a bounded, de-duplicated, ordered list of AIH-owned codes and counts — no detail, path, OS error, timestamp, or callback has a field to occupy. Freshness is the caller's obligation, which this cannot verify and does not claim to; what it guarantees is that reusing the pre-execution audit can never manufacture `complete`. The command route reaches this only through the staged live-attempt provenance wrapper, not as a caller-supplied completion API.

- **A Repair may only proceed on a target proved genuinely free, not merely unreachable.** `aih doctor` answers "is the canon reachable" with `existsSync`, and eligibility used to inherit that answer. `existsSync` returns `false` for at least three different situations — the name is free, the name is held by a link that resolves to nothing, or the lookup failed and nothing was learned — and a repair may proceed in only the first. Treating the other two as absence is how "path lookup failed" becomes "the directory is missing, go create it". Absence is now established directly by no-follow inspection: `ENOENT` alone, only beneath a parent already proved to be a real non-link directory, and only while the root is still the same filesystem object the scope was minted against — an identity comparison, not a path one, since a directory renamed away and replaced at the same canonical path passes every path-shaped check while being something else. The scope captures the root's `dev`/`ino` at mint under custody's own rule, refusing an unusable inode. `throwIfNoEntry: false` is deliberately not used, because it suppresses `ENOTDIR` as well as `ENOENT` — measured, not assumed — and would report a path whose parent is a regular file as absent. The verdict is `unoccupied` (the only one a repair may act on), `occupied` (a directory, a regular file, a live link, a dangling link, or anything else holding the name, since this recipe creates rather than replaces), or `indeterminate`, kept distinct from `occupied` so a refusal is never mistaken for a fact about the tree when it records only that the tree could not be read. Permissions, transient errors, symlinks and reparse points, malformed ancestry, and any uncertain occupancy all refuse. The probe accepts only the branded scope, refuses every substitute before any syscall, and its record carries the root digest, recipe identity, and literal target — never a path, an errno, or OS text. It is bounded rather than atomic and says so: three syscalls describe the instant they were taken, which is why a consumer re-observes before spending a claim and again at the effect boundary, where custody re-proves the same facts under the mutation grant. Custody already owned that rule where it matters most; a capability-light probe cannot import mutation capability to reach it, so the rule is stated twice and a test pins that the two agree on absence over the same trees. `aih doctor` behavior and the public/package export surface are unchanged, and the only production command route reaches this probe through the closed `aih repair` live-attempt path.

- **A Governance Doctor run that found problems and could not see everything now reports `partial`.** An Audit has always carried findings and per-diagnostic refusals side by side, but every surface asked only whether the refusal list was empty — so a run that found real problems *and* failed to resolve part of the workstation was labelled `evidence-gap`, the same word used for a run that resolved nothing at all, with its findings sitting in the payload underneath. That mixed run is now `partial`. The classification is made once, by a single code-owned derivation over the branded Audit, and travels as a frozen record instead of being re-derived by each surface: `completed` when every declared diagnostic resolved (findings present or not), `partial` when some produced findings and some did not resolve, `evidence-gap` when nothing resolved into a finding and at least one diagnostic did not resolve. The first and third are exactly what these surfaces reported before, for exactly the runs they reported them for; only the mixed run changes. **Audit exit codes do not change** — only a completed Audit ever passes, and a mixed Audit never does. `completed` is defined by the absence of an unresolved diagnostic and by nothing else, so no count, severity, or finding can argue a partial run up into a complete one, and the record cannot contradict itself: transport re-checks the state against the contents it summarizes, so a value claiming `completed` while carrying an unresolved diagnostic is refused rather than believed. Unknown, missing, or renamed fields, duplicate diagnostic identities, an unresolved collection wider than the closed diagnostic set, a state outside the closed three, a finding count outside its bound, an incompatible protocol, and proxies, accessors, sparse arrays, and foreign prototypes are all refused. The collection is named `unresolved`, not `evidenceGaps`, because a diagnostic fails to resolve in five distinct ways — `missing-adapter`, `evidence-gap`, `missing-credential`, `unsupported-host`, `unmanaged-drift` — and each is carried with its own state so a reader learns why that part of the workstation went unseen. The `--json` `outcome` carries the state; the human output adds a line saying in words that this is not a completed audit and that nothing is known about what the unresolved diagnostics cover; and the `--repair-plan` preview gains an `auditCompleteness` field, so a derived plan can never be read as evidence that the audit behind it was complete. The separate `aih repair` route may complete its local effect with `repairState: partial` and exit zero when its fresh post-audit is partial; that does not change the Audit result or make the read-only preview executable.

- **Governance Doctor Repair V1 precondition probe for the canonical context directory.** An internal, code-owned probe now answers the eligibility question for the one mechanical Repair recipe directly, instead of deriving it from the full `aih doctor` result. The full result is the wrong authority boundary for a repository-local repair: a fresh root reports two dozen non-pass checks, and at least two of them — whether an AI CLI is runnable, and whether `rg`/`fd`/`jq` are on `PATH` — are properties of the machine that no state of the repository can clear, so gating on the whole result would make "is `jq` installed" part of the authority to create a directory, and the eligible state would be unreachable rather than merely rare. The probe asks a strictly smaller question: are exactly the two checks that a missing `ai-coding` causes non-pass, and nothing else? Eligibility is the complete non-pass projection of those two shipped checks equalling one frozen causal bundle — context-dir `skip` with code `canon.context-dir-missing`, plus the code-less canon markdown lint `skip` — in order and cardinality, established differentially: creating the directory flips exactly these two and introduces none. The lint tuple is deliberately not unique, because `canonLintCheck` reports the same triple for informational findings; it is safe only inside a bundle-exact match, since that branch sits after the directory-exists guard and can therefore only fire while the context-dir check reports `pass`, at which point the observed set is no longer this bundle. Bundle-exactness *is* the disambiguation, no `detail` is read to reach it, and neither tuple may be lifted out of the bundle and keyed alone. That argument covers one reading and not two: the bundle is two filesystem observations, and a directory created between them would yield tuple 1 from the first and tuple 2 from the second, reproducing the pair over a state the tree was never in. A reading that would qualify is therefore confirmed by a second one before eligibility is reported, and the confirming reading is what the record carries. That bounds the window rather than closing it, and the limit is stated rather than glossed: a change that lands and reverts entirely between the two readings is not observable through these APIs, and leaves the tree in the state the record reports. One frozen list declares both the checks observed and the tuples expected, so the positional comparison cannot come to mean "in whatever order the calls happen to appear". The probe accepts only a `WeakSet`-branded scope it cannot itself mint, and refuses every substitute — a bare absolute path, a plain object, a spread copy, a proxy, an accessor-bearing look-alike, a parse, a prototype child — before any filesystem call. The mint takes no path, target, or recipe: it reads the root out of a branded operational context, refuses a run whose resolved context directory is not the literal `ai-coding` so that `--context-dir`, `AIH_CONTEXT_DIR`, or a marker pointing elsewhere buys no scope and no filesystem call, and requires that root to be absolute and its own native canonical form. Only `{name, verdict, code}` is projected out of each check: no raw `Check`, `detail`, or location is retained, returned, hashed, or forwarded, and the root travels only as a domain-separated digest. Two limits are stated rather than implied — the brand proves package-internal construction, not which caller built the context; and "absent" means `existsSync`-unreachable rather than unoccupied, so a consumer that acts on the verdict must establish an unoccupied path separately and refuse with its own label. `aih doctor`'s canonical-context-dir probe and this precondition now share one `canonContextDirCheck` implementation, so the probe observes the real check rather than a copy that could drift; a test pins that the two produce identical `Check` values, and `aih doctor`'s own behavior is unchanged. The precondition is consumed only by the closed `aih repair` route: it licenses the one literal effect after the route independently discloses and re-observes the live target. It adds no new CLI, flag, target selection, Workbench surface, public-library export, network, provider, scanner, signer, process, package, publication, runtime, or seat authority.

- **`aih governance-doctor --repair-plan` presents a preview-only mechanical Repair plan derivation.** The read-only route gains one explicit flag that appends a closed, bounded preview to the standard presentation; without the flag the output is unchanged. The preview derives exclusively from the run's own branded Audit, the shipped profile, and one code-owned broker mapping — no flag, option, or positional value can supply a broker, recipe, effect, path, or content — and reports one of four fixed outcomes with `executable: false` always. No consent is captured, no claim is spent, and no executor, custody, or verifier code runs: the internal Repair execution modules keep zero command-reachable importers. The findings-to-effects table is a code-owned constant whose widening is a reviewed edit; it holds exactly one entry, described in the entry below.

- **`aih governance-doctor` reports the missing canonical context directory as a finding, and can preview creating it.** Exactly one `aih doctor` outcome now survives as an audited finding instead of collapsing its diagnostic into an evidence gap: the code-owned tuple of diagnostic `aih.doctor.root`, check `context-dir`, verdict `skip`, and code `canon.context-dir-missing`. That code is compared and discarded — the emitted finding carries the AIH-owned code `AIH_CANON_CONTEXT_DIR_MISSING`, `low` severity, and AIH-authored prose, so no string a probe authors reaches an Audit, Guide, or plan as data. At this preview-only checkpoint, no real run changed: the mapping was all-or-nothing per diagnostic, so any unmapped non-pass verdict accompanying the mapped one kept the `evidence-gap` refusal. Doctor's canon markdown lint check skips on exactly the same condition as this one — both test whether the context directory exists — so the mapped tuple never occurred alone and the finding was not emitted; a fresh fixture root in fact reported 24 non-pass checks. The mapping and the eligibility boundary are proved by tests, including a pin that runs the real Doctor planner against a fixture root and asserts the evidence gap survives. Reachability for the executable route is provided by the live precondition boundary described above, not by widening this Audit-derived preview mapping. The table is neither a passthrough nor caller-configurable. Under `--repair-plan` the finding derives one `create-managed-directory` effect whose path is a literal constant in the code, never taken from the committed marker, `--context-dir`, the environment, the diagnostic's own detail or location, or any record field. Those inputs are gates only: a plan is previewed exclusively when the committed `.aih-config.json` is present and valid, its context directory is exactly `ai-coding`, the run's resolved context directory is exactly `ai-coding`, and the eligibility record's root digest is the one this operation bound. The preview module stays capability-free — it reads no file, setting, marker, or environment value and holds no callback that could — and accepts only a frozen, `WeakSet`-branded eligibility record minted at the command boundary, so a plain object, spread copy, proxy, accessor-bearing look-alike, prototype child, altered protocol string, or mismatched root mints nothing and yields the fixed `unavailable` outcome. The preview remains `executable: false`: no consent is captured, no claim is spent, and no executor, custody, or verifier code runs.

- **Governance Doctor Repair V1 executor, custody, and independent verifier.** Internal modules now apply exactly the four frozen effect kinds through plan-bound filesystem custody, and a separate verifier takes a two-part verdict — each effect's plan-declared goal must hold over the live tree and the attempt's recorded evidence must match those live bytes — so neither an executor's success carried forward nor evidence that echoes an unrepaired tree can manufacture a verified outcome; a plan declares each managed path at most once. A durable per-machine claim store under the OS account's own home — read from the account record, never from `HOME` or `USERPROFILE` — spends a granted plan once per canonical checkout root, commits that record before the first effect, accepts no caller-supplied replay state, removes nothing at any interval, and refuses past a bounded record ceiling rather than making room. Custody publishes by hard link through a write, flush, displace, link, and retire sequence that replaces nothing it did not create and restores what it displaced; attempt evidence is recorded only for effects a receipt reports applied. On POSIX the reported home must be a real, canonical, non-link directory this account alone may mutate, and its whole lexical naming ancestry is proved to the filesystem root — owned by root or by this account and not group- or world-writable, or sticky and naming an entry owned by root or this account, which admits a root-owned `0755` `/home` and a root-owned `01777` `/tmp` — with the home-and-ancestry identity re-proved at each controlled segment boundary, immediately before the exclusive claim create, and again after the read-back. Windows asserts no POSIX mode or uid bound and no ACL substitute for one, defines no `O_NOFOLLOW` so an open follows a reparse point, and exposes no directory handle to flush. Each path proof is bounded rather than atomic: a substitution spanning a proof boundary is refused, and one that lands and reverts inside a single syscall is not observable through these APIs. Every failure is a fixed label that echoes no path, byte, or OS diagnostic. The separate `aih repair` command reaches these modules only through staged live attempt, local TTY consent, and independent verification; there is still no Workbench, public-library export, broker selection UI, network, provider, scanner, signer, process, package, runtime, seat, or lifecycle-approval cutover.

- **Governance Doctor Repair V1 contract foundation.** Internal dormant contracts now define a code-owned mechanical broker registry, exact trusted-plan joins and parsing, out-of-band consent, bound execution and verification contexts, receipts that distinguish applied-unverified results, covering verification, and a pure resolver. They add no execution or mutation broker, filesystem, process, network, provider, scanner, signer, CLI, Workbench, public-library export, runtime, seat, persistence, or lifecycle-approval route.

- **`aih governance-doctor` presents the Audit and Guide read-only.** A new top-level `readOnly`/`zeroWrite` command runs the shipped canonical Governance Doctor profile through the internal operational adapter once per invocation and prints human output plus a `--json` result whose presentation report has a fixed shape. The profile is the one shipped in this package and cannot be selected by a flag, option, environment variable, or positional value; the policy decision and revision are derived in code from the validated org policy and the resolved posture, and fail closed on an unreadable policy or a posture below the policy floor. Completed audits exit zero; refused, evidence-gap, and unavailable outcomes exit non-zero. The guided next action stays `executable: false`, so no next action, `aih status`, or Repair runs, and the route appends no run-ledger row, support ticket, or other file. It adds no Repair flow, Workbench route, public library export, or runtime/seat cutover, and does not extend or re-enter `aih doctor`.

- **Governance Doctor Audit/Guide operational adapter.** An internal, AIH-owned adapter now invokes the hard-pinned read-only `aih doctor` and `aih policy evaluate` commands through validated probe actions, converts fixed safe outcomes into the existing precomputed registry, and leaves other frozen diagnostic IDs as `missing-adapter`. It settles policy denial and profile incompatibility before planning or running a diagnostic, and binds every record to the exact profile, root, target, safe evaluation-context digest, and committed read-only surface revision. It adds no Repair, apply, or escalation route and no CLI, Workbench, or public export.

- **Governance Doctor Audit/Guide foundation and source pack.** Internal, capability-free Audit and Guide records now use bounded canonical Profile/Audit/Guide bytes and domain-separated identities over precomputed read-only diagnostic data. The source-only `governance-quality` pack scaffolds its canonical profile and skill assets without creating destination lifecycle approvals.

- **Administrator catalog generation is an explicit apply-only route.** `aih policy generate <admin-root> --apply`
  can resolve separately attested, signed supported-catalog material before rendering the local Policy Workbench;
  omitting `<admin-root>` retains the portable rootless artifact with no catalog acquisition.

### Fixed

- **Verification evidence now fails closed instead of becoming ordinary drift or a partial
  success.** Codex managed-server projections distinguish malformed `enabled_tools` data from a
  valid incomplete allowlist. Git counts and numstat rows accept only complete non-negative safe
  integer shapes, while workspace collection brackets one coherent branch/commit/dirty/divergence
  observation and reports changing or unavailable state without mixing facts. A detached child,
  or one whose observed branch label is not safe for downstream ref use, remains a complete
  SHA-backed observation: the label never becomes a checkout ref, and an incomplete baseline can
  never certify the current child as unchanged. Applied GitHub trust
  scans and skill vets require one bounded, regular, exact-source metadata record before and after
  analyzer execution; missing, unreadable, malformed, mismatched, or replaced metadata has a named
  blocking code, and a caller pin is never substituted for fetched provenance. Bounded generated
  transaction sequences now cover preview, last-write/removal behavior, conflicts, disk/result
  state, rollback, and preservation of concurrent operator edits. The shipped native identity and
  all 151 vendor receipts were refreshed by full exact-pin re-vet
  [run 32554191161](https://github.com/samartomar/ai-harness/actions/runs/32554191161);
  the install preview, verdicts, findings, source pins, paths, and tree hashes are unchanged. (#818)

- **The ECC Codex Chrome DevTools launcher is now bound to Core's exact reviewed
  package identity.** Every non-governed direct or verified Codex plan, scoped or
  unscoped and independent of optional MCP selection, replaces the pinned ECC
  helper's floating `chrome-devtools-mcp@latest` default with the active Core
  ledger version and deterministic scoped configuration; the vendor MCP merge
  helper is no longer a fallback, and governed plans retain no Core MCP default.
  A prior exact AIH-written npm, Bun, pnpm, or Yarn vendor stanza migrates only
  when live AIH state still claims it; managed requested entries are re-rendered
  from the current exact specification while other valid claimed scoped entries
  remain intact. Existing operator-owned same-name servers are preserved and not
  claimed. The verified vendor baseline merge now prepares a candidate in a
  unique temporary directory, narrowed to `0700`/`0600` modes where the platform
  enforces POSIX modes, instead of mutating live config early, then commits config
  and AIH state only after managed files and AGENTS are ready and the exact
  pre-helper config and state bytes still match. Races fail closed, AGENTS/config
  changes are rolled back when safe, and the temporary candidate is removed by
  exact non-recursive cleanup. The reviewable install driver uses deterministic
  compressed static program transport to stay below Windows command-line limits;
  live paths and state remain separate arguments. Later removal requires the
  intact AIH-managed MCP fence and fails visibly while any claimed MCP custody
  remains. Prune binds its config and AGENTS subtraction to their exact observed
  source bytes, asserts the same install-state snapshot in the filesystem
  transaction before config changes, and deletes state only after exact state and
  post-subtraction config re-observation. A present but malformed AIH state is an
  explicit refusal; semantically duplicate, array, encoded, descendant, dotted,
  inline, unknown, mixed, stale, or otherwise ambiguous identity fails closed
  before install or cleanup.

- Correct the BetterDoc pack page after the self-hosting cleanup: bundled pack
  bytes still ship, while this checkout intentionally has no AIH approval lock,
  vet report, promoted copy, or product-command validation loop. The page now
  also distinguishes the manually curated repository copy and the retained
  skill card's non-authoritative pre-cleanup metadata (#822).

- **Decision sessions now use the companion's current truth homes.** The
  repo-curated decision-partner skill reads the companion's declared navigation,
  operating rules, `NEXT.md`, and affected feature files. It no longer requires
  retired decision-ledger files or directs agents to create a second history
  store.

- **Obsolete Superpowers scan acceptances no longer remain in the shipped ledger.** The exact
  pinned-checkout audit found that none of the 62 historical code/path/content-digest rows joins
  the current scanner output, so the ledger now ships with an empty accepted set. The 87 current
  advisory observations remain visible and unaccepted; this cleanup changes no detector,
  severity, vendor pin, runtime authorization rule, or critical-finding boundary. (#804)

- **Claude binding lifecycle mutations now retain exact custody of their observed state.**
  Plugin reconciliation binds the explicit absolute checkout root, re-observes the exact
  `enabledPlugins` ownership entry before and after mutation, and stops before cache or
  marketplace effects when that state drifts or is ambiguous. Removal restores only the single
  bound JSON, text, or file snapshot it classified, refuses missing or duplicate custody receipts,
  and does not reclassify a changed target into a different effect. Framework callers carry their
  resolved repository root through both paths instead of allowing either operation to infer it
  from ambient process state.

- **MCP catalog secret references now use one strict, fail-closed grammar.** Stdio environment
  values and generic HTTP headers must contain exactly one `${VAR}` reference, while an
  `Authorization` header must contain exactly `Bearer ${VAR}`. Literal, interpolated, alternate,
  malformed, whitespace-padded, or duplicate case-variant authorization forms are rejected before
  projection; diagnostics identify only the server and field key, never the rejected value. Catalog
  construction, placeholder discovery, and hygiene checks share the same validator and deterministic
  variable ordering.

- **Contained reads now reject same-file mutations observed after the descriptor read.** The
  shared reader for trust evidence, workspace locks and snapshots, reports, and MCP configuration
  now compares the final regular-file identity, size, modification time, and change time with the
  opened descriptor before returning bytes. A same-inode write that changes those stable metadata
  fields is reported as `changed`; linked, out-of-root, non-file, and inaccessible inputs retain
  their existing fail-closed outcomes. This narrows the read-time race window but does not claim an
  atomic filesystem snapshot.

- **Sensitive local reads and assignment redaction are now bounded and root-contained.** Secret-assignment redaction uses a linear-time forward scan that recognizes leading-underscore keys; trust evidence, workspace snapshots and locks, and MCP config reads accept only canonical-root-contained regular files up to 1 MiB and refuse linked parents, while snapshot `Source` remains root-relative. Trust source excerpts are limited to locations through line 10,000; beyond either bound, reads fail closed and source excerpts are omitted.

- **The three Repair execution hardenings that only bite once Repair can write.** Each closed a gap that was documented rather than hidden, and each was carried as recorded debt until now because none of them is reachable without an execution route.

  *Attempt evidence is bound to the checkout the claim was spent for.* The recorder joined a spent claim to a Receipt on plan and consent only. A claim's `scopeSha256` digests the resolved canonical checkout path; a plan's `rootSha256` digests the declared strings before anything is resolved, so no comparison between them exists and two spends of one plan against roots that resolve differently were indistinguishable. The executor now states the resolved root it applied the effects in, and the recorder digests it through the claim module's own pure scope rule and refuses a claim spent for any other checkout. The path is trusted only as the caller's statement of where it acted, never as a fact about the filesystem — the digest comparison is what makes a false statement useless rather than merely unverified, so a caller that misstates its own root can only refuse itself. The characterization test that pinned the gap is now a refusal test.

  *The authority window bounds the attempt, not only its writes.* An effect whose goal already holds takes no mutation grant, so it read no clock and reported `applied` on a plan whose authority had already closed. It mutated nothing — this was a false audit trail rather than an unauthorized write — but a Receipt is what an executable Repair rests on. The window is now checked before every effect and again by every grant, so a plan expiring between effects halts before the next one whether or not it would have written anything.

  *The trusted join is re-taken immediately before the claim is spent.* The claim is spent before the first effect precisely so an interrupted run leaves it spent, which makes the instant before the spend the last place a refusal is still free. Every join above it is pure or in-memory over frozen branded records, so re-taking them costs nothing; the one thing that can have changed is the clock. A plan whose authority closes between the preflight's own timestamp and the spend now refuses with nothing spent and nothing written, leaving a plan that can be consented and run again rather than one that is finished. Acquiring a claim is itself many syscalls — resolving the account home, proving the naming ancestry, enumerating the store against its ceiling — so the store re-reads the same window immediately before the exclusive create, beside its own last store-identity proof, and refuses before the name is taken. Bounded rather than atomic, like every other proof there: a window closing between that check and the create returning is not observable, and what the check removes is the whole-acquisition gap rather than the last syscall.

  The only route that reaches this now is the separate `aih repair` command; `aih governance-doctor` remains read-only.

- **Repair attempt evidence now requires the durable claim that licensed it.** Recording what an executor observed after applying a plan's effects previously needed only a well-formed Receipt, so any in-package caller could record evidence for a Receipt it had built itself. The two-part verifier verdict already refused evidence that echoes an unrepaired tree, so this was never a route to a fabricated repair — what it allowed was a Verification with no durable claim standing behind it, which is exactly the audit trail an executable Repair rests on. The recorder now takes a spent claim as a capability: only the claim store mints one, only after the exclusive create that commits the record, and the claim must bind the same plan and consent as the Receipt. A claim that is merely well formed — minted in memory, round-tripped through its own canonical bytes, copied, or proxied — is refused, and a boundary test pins that exactly one module may mark a claim spent. The join is at plan-and-consent granularity only, and the docs and a characterization test say so: a claim's scope digests the resolved canonical checkout path while a plan's root identity digests the declared strings, so a claim spent against a differently-resolved root is not distinguished. The sole production caller pairs the claim and receipt it just produced, so no mismatched pair is reachable; binding the scope needs the resolved root threaded into the recorder and belongs to the change that adds a second caller. The executor also gained a mid-run authority-window test: the window is re-read whenever an effect takes a mutation grant, so a plan expiring between effects demonstrably halts before the next write instead of finishing on a check it passed before the first one. At this checkpoint, an effect whose goal already held took no grant and so read no clock; the current executable route is covered by the authority-window hardening described above. Its four near-identical effect branches shared one grant helper and two applied-result helpers, which was behavior-preserving and removed 50 lines.

- **Governance Doctor Repair claim-store hardening and doc precision.** The record read path now compares the opened descriptor's identity against the one the caller's own `lstat` proved, which is the only bound standing between the open and a reparse point on a platform that defines no `O_NOFOLLOW`. Prose that claimed more than the code did is narrowed to what it enforces: the bounded-count directory handle takes no flags and is stated as the one exception; the record ceiling is documented as a preflight bound on directory *entries* rather than a lock, admitting a record only while strictly fewer than `maxStoreRecords` exist while acknowledging that concurrent acquisitions can each pass it; the shared `~/.aih` segment and its `umask`-derived unavailability are named with the operator-side remedy the closed refusal cannot say; and the Windows home-identity gap is stated where it previously read as unconditional, including the subtree-relocation shape the store-identity proof alone does not catch. The executor gains a load-time guard that a managed write custody accepts can always be recorded as attempt evidence, so a future ceiling change cannot discard a receipt for work that already landed. No behavior changes on any non-adversarial path; under a substituted record the refusal label can move from already-claimed to unreadable.

- **MCP pin attestation no longer tells an operator to pre-warm a cache that is already warm.** A
  pinned server that dies before the `initialize` handshake was always read as the cold-uv-cache
  case, so a server that answered with a real JSON-RPC error — `codebase-memory-mcp` 0.10.4
  refusing to create its daemon endpoint on a hardened host — had that error silently discarded and
  was handed the `--offline`/pre-warm remedy, which cannot fix it. The probe now reads what the
  server actually said: a reported JSON-RPC error is echoed in the detail (sanitized and
  length-bounded like every other cross-boundary echo) and routes to the new
  `mcp.server-startup-error` code, whose remediation points at the reported condition instead of at
  re-attesting. A launch that dies silently still gets the cold-cache diagnosis unchanged. Both
  states stay advisory skips — the attestation launch carries no config-supplied environment, so it
  cannot prove the server is broken under the operator's own launch — and the pin stays unattested
  either way.

## [6.1.0] - 2026-08-14

> Remediates the 6.0.1 enterprise field report: closes the high-severity projection
> idempotency regression and the diagnostic/installer gaps it documented.

### Fixed

- **`aih policy project --apply` is idempotent again for policies whose hooks arrive as
  registrations** (6.0.1 enterprise field report). The usage projector's legacy scan runs on every
  projection and treated any `PostToolUse` in `.claude/settings.json` without a usage receipt as an
  unreceipted legacy artifact — including the entries the hook registrar's own receipt claims — so
  the second run of the same command refused AIH's own first-run output, and doctor /
  `aih policy evaluate` reported the repo unowned for as long as the projected file existed. The
  scan now recognizes a PostToolUse slot the registrar receipt claims exactly; anything beyond the
  exact claim still fails closed, and a usage-metering activation meeting a registrar-owned
  destination is refused with the registrar named instead of a generic "already has PostToolUse
  hooks".
- Doctor's `usage.recorder-missing` finding names the hook-registrar case with a remedy that can
  actually run. A registration whose launcher references `.aih/usage-record.mjs` projects a hook
  against a recorder the registrar never writes — two field reports running, projection created its
  own failing check. The finding now says exactly that and points at moving usage metering to a
  `usage-metering` candidate activation (drop the registration, project once, then activate), or
  dropping the registration.
- `aih policy project --verify` actually runs verification probes. The plan carried none, so the
  flag produced no verification section at all — the same silent shape the 6.0.0 cut fixed for
  `aih secrets --verify`. It now runs the org-policy effective-resolution check and the
  usage-recorder check after applying.
- Doctor's `metrics-hook-tool` probe recognizes the standalone v1 Kiro hook
  `aih bootstrap-ai --kiro-hook-runtime ide1-cli3` actually writes. The probe matched only the
  legacy literal `aih track` command, but the current fail-open one-shot invokes
  `execFileSync('aih',['track','--apply'])`, so AIH's own hook was reported as "no Kiro
  metrics-on-stop hook to verify" and left silently unverified.
- `aih status` no longer calls the gitleaks secret gate green off the config file's presence. The
  gitleaks row now runs the same `gitleaks version` activation check `aih guardrails --verify`
  grades, and its detail says when the committed config is unenforced (binary not on PATH) — the
  generation-is-not-activation treatment the pre-commit row already had. Verdicts and the exit-0
  contract are unchanged; the detail carries the enforcement truth.
- `aih doctor --attest-mcp-pins` names the cause when an `--offline`-pinned uvx launch dies before
  the MCP handshake: hardened pins cannot resolve on a cold uv cache, so the advisory now states
  that and the one-time pre-warm remedy (run the launcher once without `--offline`) instead of a
  bare exit code.

### Added

- `aih tools` covers `gitleaks` as a core tool (winget / scoop / brew, with a manual fallback).
  The installer claimed "All agent shell tools are on PATH. Nothing to install." while
  `aih guardrails --verify` hard-failed at enterprise on the one tool it did not cover; a machine
  without gitleaks now gets an install action, and a bare `aih tools` exits non-zero naming it.

## [6.0.1] - 2026-08-14

> Ships the entire v6.0.0 cut plus one fix found while covering it. The `v6.0.0` tag was cut but
> **never published**: its release run failed the coverage gate before pack or publish (nothing
> reached npm and no GitHub Release exists), and release tags are deletion-protected, so per the
> fix-forward policy the content ships as 6.0.1. There is no published 6.0.0.

### Changed

- **BREAKING — an explicitly configured `AIH_ORG_POLICY` that points at a missing file now fails
  closed.** `readOrgPolicy` returned the same `undefined` for "no policy anywhere" and "the
  operator named a file that isn't there", so a typo'd or moved path silently dropped the org
  posture floor and the governed inventory across every caller, while `aih policy validate`
  reported a clean skip and exit 0 — validating nothing. An invocation that passes today against a
  broken `AIH_ORG_POLICY` path will now fail; fix the path, or unset the variable to fall back to
  the repo's `aih-org-policy.json`. Absence of that default file remains an honest skip.
- `aih doctor --attest-mcp-pins` and `--check-pin-currency` now read `.kiro/settings/mcp.json`
  alongside `.mcp.json`, and an unreadable MCP config fails closed rather than reading clean. Both
  pin checks were `.mcp.json`-only, so a repo whose governed servers are projected into the Kiro
  config — the shape `aih policy project` writes — got no pin attestation or currency verification
  at all, while the same doctor run attested those servers as declared registry members. Repos with
  a Kiro MCP config will see new findings that were previously invisible.
- **`aih guardrails --verify` now fails at enterprise posture when `gitleaks` is not on PATH**,
  instead of skipping at every posture. Generation is not activation: the committed
  `.gitleaks.toml` and pre-commit hook enforce nothing until the tool is installed, so an
  enterprise workstation without it reported green while its local secret gate was unenforced —
  next to `aih tools --verify` reporting every tool it knows about as present. This was the only
  check in the guardrails plan that ignored posture. Vibe keeps the advisory skip only where vibe
  is actually the effective posture: an org policy's `minimumPosture: enterprise` floors the
  effective posture, so `--posture vibe` still fails in a governed repo. CI enforcement via the
  pinned gitleaks in `sca.yml` is unchanged and independent of local PATH.
- `aih doctor`'s org-policy effective-resolution probe is now scoped to the committed
  `.aih-config.json` target set, like the MCP-allowlist and policy-drift probes beside it. Doctor
  has no `--cli` flag, so the unscoped probe collapsed to `["claude"]` and reported a permanent
  `target-not-selected:<cli>` on a correctly projected repo — in the same run whose baseline
  attestation read those servers off disk and passed. Doctor verdicts change for multi-CLI repos.
- The effective-policy digest renders the invocation's target set as `selected=… (this invocation)`
  instead of `available=`. Sitting beside the per-candidate `supported=`, the old label read as a
  per-candidate value and invited the conclusion that the two should intersect. Values unchanged,
  but consumers parsing the digest text must update.

### Added

- `aih policy evaluate` now accepts `--cli`. Its plan already resolved targets through the same
  `resolveTargets` as `aih policy project`, but the read-only flag set omits `--cli`, so the
  command rejected it outright and could not model the multi-target selection that projection
  requires. Other read-only verifiers keep deriving targets from committed evidence.

### Fixed

- Doctor's pin-currency catalog comparison resolves a Kiro-declared launch by its bare server
  name. Launch labels are config-qualified (`name @ .kiro/settings/mcp.json`) so reports stay
  unambiguous across files, but the offline projection-lag lookup keyed on the full label, so a
  catalog server declared only in the Kiro config was silently exempt from `mcp.projection-stale`.
  The lag message now says "projected pin" instead of naming `.mcp.json` unconditionally.
- Doctor's `usage.recorder-missing` remediation no longer names a command the active policy
  refuses. When governance owns the usage surface, `aih usage --apply` is rejected by design, so
  the recorder check now points at `aih policy project --apply` and names the unreceipted-hook
  case that projection will not adopt. Previously an enterprise repo could reach a state whose
  only advice was a command governance blocks.
- Blocked-target resolution reasons now state the whole requirement instead of only the deficit.
  An activation declaring `targets: ["claude","kiro"]` reported `target-not-selected:kiro` when
  neither was selected and `target-not-selected:claude` when only Kiro was, which read as a
  contradiction; the reason now also carries the required target set and the actual selection.
  The stable `target-not-selected:` / `target-not-supported:` prefixes are unchanged.
- The org authority-registry note is no longer appended to every blocked-candidate refusal.
  `verifyPolicyAuthorityReceipt` runs on every invocation, so its "registry unavailable" problem
  was suffixed onto any `policy project` refusal regardless of why the candidate blocked. An
  operator whose candidates were merely target-unselected was sent chasing
  `AIH_POLICY_AUTHORITY_REPOSITORY`, then saw the note vanish once the selection was fixed — not
  because the registry became reachable, but because nothing threw. It now appears only when a
  blocked candidate's own codes depend on the registry (evidence and approval verification).
- `aih ecc` now emits the unpinned supply-chain advisory on the consult-only path. The advisory
  naming ECC's mutable-upstream `latest` execution and how to pin it was pushed only inside
  `eccPlan`, which real dispatch never runs (`deps.execute = executeEccCommand`). A consult-only
  target such as Kiro therefore recommended `npx ecc consult` — an unpinned, latest-from-npm
  fetch — with no pinning warning at any posture, while the rest of the product denies unpinned
  supply chains at enterprise.
- `aih policy evaluate` now honors a typed `--posture`. Posture gates projector availability, so
  the command's checks are posture-scoped, but the spec omitted `honorReadOnlyPostureFlag` and the
  flag was dropped for this read-only command — every posture produced identical output reporting
  `projector-disabled-at-vibe-posture`. `aih doctor` already set this for the same check.

### Documentation

- Documented that a governed policy (any `governance.policyVersion`) exclusively owns AIH MCP and
  usage-hook projection, in the `aih mcp` and `aih usage` command sections and in the enterprise
  onboarding guide. The onboarding guide still instructed `aih mcp --posture enterprise
  --mcp-compliant --apply`, which fails closed under a governed policy, and pointed at no
  alternative. The behavior is unchanged and was already stated under `aih policy`.

### Security

- Activated the governed Snyk Agent Scan 0.5.17 integration after a protected `main` qualification
  completed the detector against a generated synthetic fixture and emitted a commit-bound sanitized
  receipt. This qualifies the governed adapter path; it does not claim arbitrary scanned content is
  safe. The public run and artifact digest are recorded in the external-pin ledger.

## [5.4.0] - 2026-08-14

### Added

- Added an enterprise application adoption guide and a copy-safe agent-ready public demo contributed
  by [Ruchi Tomar](https://github.com/ruchitomar). The public guide map and README now route teams to
  the adoption path, and the demo carries the required public-demo data boundary.

### Changed

- Refined the public launch README and refreshed reviewed developer-tool pins for Biome, Node types,
  Happy DOM, and tsx. Updated immutable GitHub Actions pins for CodeQL,
  attest-build-provenance, Claude Code Action, and setup-python, including their governed external-pin
  ledger coverage.

### Fixed

- Organization-policy evaluation now preserves shipped projector capabilities when posture disables
  an invocation. A Vibe Kiro workspace-MCP candidate reports `supported=claude,kiro` and
  `available=kiro` while remaining blocked with the existing `missing-projector`,
  `unsupported-target`, and `projector-disabled-at-vibe-posture` diagnostics. Unsupported custom
  materializers still report `supported=none`.

### Security

- Governed Python supply chains now pin Semgrep 1.173.0, Snyk Agent Scan 0.5.17, and Serena 1.7.0.
  The five committed uv locks resolve `cryptography` 50.0.0; Semgrep and Snyk resolve fixed MCP
  releases 1.29.0 and 1.28.1 respectively; governed aiohttp closures resolve 3.14.3. Exact upstream
  pins and full baseline analyzer evidence were regenerated, and the Serena 1.6.1 lock identity
  remains trusted only for update/uninstall receipt recovery. Snyk behavioral qualification remains
  blocked until an operator supplies `SNYK_TOKEN`; its pinned package and offline CLI help are
  verified without claiming a scan.

## [5.3.0] - 2026-08-13

### Added

- Governed ECC materialization for the single `kiro` target now includes evidence-passed selected
  `agent:*` components with exact pinned Kiro mappings. Each mapped agent copies the selected
  `agents/<name>.md` bytes to `.kiro/agents/<name>.md` for the IDE representation and the curated
  `.kiro/agents/<name>.json` bytes for CLI configuration. Both stay under the existing
  selected-component and `runtime:ecc-kiro` evidence binding; an unmapped agent is refused by name.
  Reapply is deterministic;
  narrowing and uninstall remove only unchanged receipt-owned files; an operator's same-name
  Markdown/JSON definition or case-folded spelling refuses without mutation. Non-empty embedded MCP
  or hook configuration, settings, scripts, and the native installer remain excluded.

## [5.2.1] - 2026-08-13

### Fixed

- `aih ecc --lifecycle` help now lists Kiro alongside the other governed targets and states the
  verified Kiro boundary: evidence-passed `baseline:rules` and `skill:*` selections only.
- Blocked organization-policy candidates keep the stable `missing-projector` and
  `unsupported-target` danger codes while also reporting the actionable resolver cause. In
  particular, custom stdio MCP sources are authorable-only until AIH has an
  integrity-enforcing materializer, and `vibe` invocations say directly that the posture disabled
  projection.

## [5.2.0] - 2026-08-13

### Added

- Kiro is now a first-class governed MCP target. Reviewed stdio controls selected for Kiro are
  distributed to `.kiro/settings/mcp.json` through a separate receipt that owns only the exact
  `mcpServers` names AIH added. Reprojection is deterministic; deselection, prune, and uninstall
  subtract only unchanged owned entries; collisions, drift, malformed paths, and linked paths fail
  closed without taking operator content. This is workspace distribution, not managed enforcement:
  a Kiro custom agent can still override or decline workspace MCP configuration.
- Kiro adoption now inventories steering, hooks, custom-agent definitions, skills, prompts, MCP
  settings, CLI settings, and specs. Every `.kiro/agents/**` definition, including Markdown, and
  runtime settings remain operator-owned; `--migrate-cli` can preserve Kiro steering, skills,
  prompts, and specs in the canon.

### Changed

- `--detect` now recognizes the documented `kiro-cli` executable while keeping `kiro` as the one
  public target id. `--kiro-hook-runtime ide1-cli3` explicitly enables and persists standalone v1
  `.kiro/hooks/*.json` projection with current PascalCase triggers for Kiro IDE 1.x and Kiro CLI
  3.x; unknown runtimes and CLI 2.x remain advisory. AIH does not mutate embedded custom-agent
  hooks, overwrite a pre-existing reserved hook filename, or infer deletion ownership from current
  or legacy hook names; prune and uninstall surface those files for manual review.
- Policy authoring, activation, approval, effective-resolution, and projector coverage can target
  Kiro for AIH-reviewed stdio MCP controls. Claude managed settings remain a separate lifecycle,
  and Kiro does not gain unsupported hook or governed ECC agent/command projection.

## [5.1.0] - 2026-08-10

### Added

- `aih capability package list/show/status/doctor` now provide one local, typed read-only view of
  policy-requested package roots, exact approval/evidence/catalog Package Graph claims, committed
  intent, ownership, custody, and current domain receipts. `add/update/remove` remain local
  zero-write previews by default; explicit `--apply` reconciles already-promoted, policy-selected
  GitHub skill packs, existing receipt-owned ECC agent/rule materialization, and explicitly added
  HTTPS ECC MCP configuration. Mixed closures publish exact content-addressed custody and ownership
  through one ordered compensating transaction; conservative removal subtracts only unchanged,
  last-owned files and issues successor custody for retained packages. Apply performs no
  acquisition, process execution, network request, or component loading; drift is retained without
  advancing ownership, and a requested root change still requires an explicit org-policy update.
- A strict Capability Package Manifest v1 and pure deterministic resolver now
  model exact Package Graph authority, claim, source-pin, direct-member, and
  dependency intent without granting approval or installing anything. Relevant
  authority conflicts, drift, missing references, unsupported member kinds,
  cycles, and partial projections fail closed; equal inputs produce a frozen,
  dependency-first resolution. The schema ships with the npm package and now
  feeds the local command journey without becoming a second policy or approval authority.
- Capability Package Manager lifecycle foundations now read the exact derived
  `aih-capability-packages.json` resolution manifest, preserve strict orchestration state in
  `.aih/capability-packages/ownership-v1.json`, require every supported GitHub
  skill-pack member to have an exact lock-authority claim, and compute frozen,
  deterministic add/update/remove metadata. The command coordinator consumes that state only for
  exact already-promoted GitHub skills, commits repository state with compensating rollback, and
  publishes ownership last. Acquisition and remote dependency management remain outside this slice.
- Governed ECC materialization now supports the single `kiro` target for
  evidence-passed selected skills and `baseline:rules` steering. AIH copies only
  exact pinned `.kiro/skills/<name>/SKILL.md` and top-level
  `.kiro/steering/*.md` bytes under independent selected-component and
  `runtime:ecc-kiro` evidence, records both identities in the ownership receipt,
  and subtracts only unchanged receipt-owned files. Agents, arbitrary `.kiro`
  inputs, ECC hooks/settings/scripts, missing or held runtime evidence, and
  hand-owned conflicts fail closed; AIH does not invoke ECC's native Kiro
  installer or claim that Kiro loaded the projected files.
- A separate Strix security-detector contract now pins the verified v1.5.2 source and immutable sandbox image index/platform manifests, preflights only an operator-installed CLI and already-present image, and normalizes bounded headless findings into strict PoC-redacted evidence with source-correct exit semantics. Org policy can declare a local-fixture-only Strix intent with telemetry off and AIH hard ceilings of $10, 20 turns, and five minutes. `aih evidence build` can package separately produced typed records from `.aih/security/strix` only after bounded, fatal-UTF-8, whole-document validation; this seam still does not run a scan or enforce the declarative requirement at posture.
- Package Graph authority adapters now hash the exact bytes they parse for the shipped baseline evidence lock, ECC materialization receipts, and strict skill lock/pack artifacts; GitHub skill identities require a matching immutable commit. A separate deterministic classifier reports exact lock/receipt registrations, catalog-only members, undeclared immutable residue, divergent identities, and unsupported mutable observations without turning graph membership into approval or evidence.
- Package Graph authority claims can now be combined through a pure additive index that retains every source claim, reports divergent definitions without choosing a winner, and emits canonical byte-identical JSON and SHA-256 identities for equal inputs. Source-store digests remain caller-asserted at this layer while the builder separately binds each normalized projection; the index performs no filesystem, network, clock, process, approval, or installation work.
- A public Package Graph Schema v1 now defines strict, namespaced surface and package identities, provider-neutral source identity with separate immutable digests, shallow direct composition, and independent declared versus scanner-observed risk facts. The generated JSON Schema ships with the npm package for editor and integration use; indexing and authority adapters remain separate additive layers rather than a new approval source.
- Org policies can now author source-locked ECC hook controls: Minimal, Standard, or Strict profile selection plus eligible per-hook disables. `aih policy project` writes only `ECC_HOOK_PROFILE` and `ECC_DISABLED_HOOKS` into receipt-owned Claude settings environment keys, preserves operator settings, and removes only unchanged owned values. ECC remains the executor and enforcement point; disabled hooks are evaluated after process spawn and still incur that spawn.
- `aih ecc mcp add <id> --cli <client>` and `aih ecc mcp remove <id> --cli <client>` now provide an explicit, receipt-owned Add/Remove lifecycle for policy-approved ECC HTTPS MCP entries across all native client configs. Add requires `governance.eccMcpApprovals` at the pinned ECC catalog digest and writes the client entry before the ownership receipt in one transaction; Remove subtracts only unchanged receipt-owned entries and reports drift without mutating. Claude, Cursor, Copilot, Kimi, and Kiro use project-local JSON; an execution-time trusted-HOME guard protects global JSON for Antigravity, Gemini, Windsurf, OpenCode, and Zed plus Codex TOML. Doctor reports local receipt/config state without endpoint or tool-surface claims.
- Org policies can now record approved or revoked use of one exact external ECC
  MCP catalog entry at the pinned source digest, including administrator,
  authentication, and permitted-data disclosures. The record is declarative
  seat-Add authority only; it performs no configuration, contact, scan,
  projection, or tool-surface check.
- Policy authoring now carries the pinned ECC MCP inventory as a source-locked
  external catalog: all 35 upstream entries are classified, four AIH-owned
  entries are excluded, and the remaining 31 are kept separate from AIH's
  reviewed controls. Ten exact HTTPS endpoints are marked configurable; unsafe
  localhost and unpinned or local-command entries remain manual.
- Org-policy remote MCP records can now use an administrator-managed `approved`
  or `revoked` status without claiming a tool-surface observation; legacy
  schema-v2 digest/verdict records remain parse-compatible but never become a
  live drift check.
- `aih trust scan` can now vet a policy-bound custom npm package by fetching its exact package/version tarball with scripts disabled, verifying the policy SHA-256 pin, scanning only the quarantined contents, and emitting the named preflight evidence record for independent authority attestation.

### Changed

- The internal ordered owned-file transaction can now express no-effect
  assertions, optional mode preimages, action-specific path policy, and
  side-effect-free pre/post verification guards inside compensating rollback.
  Legacy ECC write/remove steps keep their existing inferred behavior; this is
  a coordinator prerequisite only and does not expose package execution or
  claim isolation, crash atomicity, or cross-domain rollback.
- Capability Package Manager physical custody uses strict, internal,
  content-addressed receipts for skill promotion, ECC materialization, and explicit ECC MCP state.
  Each receipt binds exact ownership and domain-receipt bytes to deterministic package members and
  repo-local file digests; missing evidence remains explicitly unowned, malformed or drifted
  evidence fails closed, shared files are retained until their final owner is removed, and
  final-root removal creates no empty custody claim.
- Capability Package Manager lifecycle state can now be projected into an
  immutable, plan-only sequence for the committed intent and local ownership
  receipt. The planner binds exact live bytes and, where the host supports
  POSIX modes, exact mode preimages; it orders intent before receipt on writes
  and receipt before intent on final removal, and refuses malformed or unsafe
  state. It exposes no commit API and does not install, configure, adopt,
  remove, or claim ownership of package members.
- Capability Package Manager domain verification can verify an already-promoted
  GitHub skill-pack against its exact Package Graph authorities, promotion
  receipt, routed repository paths, and current bounded file bytes. The shared
  projector also keeps uninstall routing deterministic. The verifier itself is
  read-only; the package coordinator consumes its copied result only alongside
  exact live authority, ownership, and custody state.
- Workspace skill promotion now derives one bounded, Buffer-preserving snapshot
  that canonically threads multi-source trust-lock state before the legacy plan
  renders it. The internal seam revalidates GitHub pins and source files at the
  point of use, rejects hostile or oversized input, and preserves exact hardened
  lock bytes for the Capability Package Manager skill adapter; it does not by
  itself advance package ownership or claim installation.
- ECC's ordered, byte-safe materialization commit now delegates to a shared
  internal owned-file transaction. The primitive preserves caller order,
  re-pins each destination before its effect, and compensates applied steps in
  reverse without overwriting concurrent operator changes. Capability package
  coordinators use the same primitive for ordered local reconciliation; it is
  not crash journaling, filesystem isolation, or a remote acquisition mechanism.
- The Policy Workbench future-owner ticker now lists only approved AIH-owned
  surfaces and no longer advertises a rejected third-party candidate.
- Release guidance now makes stable-direct the default after mechanical gates and exact-SHA approval, while requiring a release candidate for major or schema migrations, evidence-format changes, publishing-machinery changes, and cuts without adequate production-equivalent verification.
- The portable Policy Workbench now uses a flat Ledger paper-and-ink identity across light and dark themes, with evidence colours reserved for pass, blocked, and owed states. The inspector is mutation-free and narrates the selected-to-materialized journey with one routed next action; curation and custom-source forms live in a separate authoring sidebar, and the canonical selection rail remains available on compact screens.
- The Policy Workbench now keeps ECC language, framework, capability, and module selection in the left rail instead of duplicating those controls in the main inventory, preset toolbar, and inspector. A separate Add MCP sidebar authors source-digest-bound ECC approvals; approval alone never configures a client or contacts, scans, attests, or observes an endpoint.
- The Policy Workbench now makes every selectable control reversible, files every group under resolvable owner filters, links component ids in composition and registrar panels to their details, omits constant pseudo-state rows, and narrates requested versus browser-effective counts at export and download.
- The Policy Workbench makes custom-MCP evidence work actionable: it names the tarball scan command, says evidence is owed at the exact pin, labels policy import as replacement versus evidence import as non-destructive preflight, and visually links matching imported preflight evidence without claiming it is trusted or effective.
- `aih verify-release` now distinguishes a missing or inaccessible GitHub Release from an existing release whose checksum assets are still uploading, polls the latter with bounded backoff before failing, and tells operators how to install cosign when that verification leg cannot start.

### Security

- The development dependency lock now resolves `nanoid` 3.3.18 through
  `tsup`/`postcss`, clearing GHSA-2v37-7h3g-55p8 without adding a direct runtime
  dependency or broad dependency overrides.

## [5.0.0] - 2026-08-08

### Changed

- **Breaking:** Governance now supports only `vibe` and `enterprise` postures.
  Org policies must use `schemaVersion: 2`; schema version 1 and the removed
  `team` value fail closed with a migration message directing administrators to
  set `schemaVersion: 2` and choose `vibe` or `enterprise`.
- **Breaking:** At Enterprise posture, an org policy must carry a non-empty
  `governance.supportedClis` allow-list drawn from the supported CLI registry.
  Its absence fails closed with the current registry ids and a paste-all remedy;
  wildcard sentinels are unsupported. At Vibe posture absence is unrestricted,
  while a present list enforces an organization sanction gate at either posture.

## [4.0.0] - 2026-08-07

### Removed

- **Breaking:** gstack is no longer a framework `aih` can bind. The adapter, its
  registry and schema entries, the gstack-only Claude skill-override implementation,
  and the doctor specialization around it are deleted, and the committed
  `aih-config.schema.json` no longer admits the value — the framework set is `ecc` and
  `superpowers`. A repository whose `.aih-config.json` still names `gstack`, either as
  `binding.framework.id` or as `baseline`, now fails closed with one stable diagnostic
  — `unsupported legacy configuration "gstack"; migrate to a supported framework before
  continuing` — instead of being ignored, translated, or overridden. Bind `ecc` or
  `superpowers` instead. One narrow exception keeps an existing install from being
  stranded: a gstack binding receipt and a gstack-attributed cleanup manifest stay
  readable by removal, ownership-drift reporting, and rollback, so receipt-proven
  AIH-owned state can still be subtracted and restored. Such a receipt is never
  selected, verified, provisioned, or rewritten. v3.0.0 withdrew `--baseline gstack`
  from the CLI and left the adapter in the tree; this finishes the removal.

### Added

- **The governed framework lifecycle is reachable from the shipped CLI.** In a
  repository carrying a governed org policy, `aih ecc --lifecycle install` materializes
  the policy's own component selection instead of refusing. AIH resolves which selected
  components are authorized — a component the vet blocked at its pin, or one with no
  evidence recorded at its pin, is reported with its reason, and with the vet's finding
  codes when the vet blocked it, and is never written — and then materializes the
  authorized ones itself, per component. Preview is the default and rides the existing
  `--apply` gate; a dry run against a remote pin names the pinned source and the
  selected component ids, and states that file-level preview needs `--ecc-path <dir>`
  or `--apply`. A selection every target refuses is refused by name rather than
  reconciled to an empty request. `update`, `repair`, and `rollback` still refuse in a
  governed repository and name what is wired and where removal lives.
- **Per-component ownership receipts, and removal bound to them.** The receipt records,
  for each component, its evidence authorization, its source provenance, and per file
  the destination-relative path, the SHA-256 of the exact bytes written, and whether
  AIH owns the whole file or named keys inside it. Apply is atomic and writes owned
  content before the ownership record; a second apply is byte-identical and does no
  work; repair rewrites only owned files whose live bytes still match. `aih uninstall`
  gains a member that subtracts only what the receipt proves AIH wrote: a file an
  operator has since edited, or one that has gone missing, is reported by component and
  path and left in place — never deleted and never replayed. A merged JSON file is
  removed only when AIH created it and its owned keys are still its sole content. A
  destination whose ownership the receipt cannot prove is reported with its reason
  rather than rewritten, and a destination the engine kept is reported as kept rather
  than as removed.
- **Five materialization targets, chosen by the target selection every other command
  already uses.** `--cli`, `--all-tools`, and the committed `.aih-config.json` select
  among `claude` (the default), `codex`, `kimi`, `cursor`, and `opencode`; the policy
  stays tool-neutral and gains no target grammar. Any other CLI is refused by name with
  the remedy stated. Four targets carry their own project root — `.claude/`, `.codex/`,
  `.cursor/`, and for Kimi `./.kimi-code/`, which is where the framework's own Kimi
  adapter roots a project install. OpenCode materializes only the tool-shared project
  surfaces (`AGENTS.md`, `.agents/plugins/`, `.agents/skills/`), because its only
  framework adapter is home-scoped and no evidenced per-tool `.opencode/` layout
  exists; every other component refuses by name for that target rather than landing in
  an invented directory. Several targets in one run are one materialization with one
  receipt: a destination two targets share is written once, a target that refuses a
  component does not stop the targets that accept it, and a later `--apply` with a
  narrower target set subtracts the dropped target's files after comparing each digest,
  reporting a hand-edited file as kept instead of removing it. A component whose files
  would collapse onto one destination within a single target — two Unicode spellings of
  one name, or two names differing only in case — is refused whole rather than
  materialized one file short.
- A governed policy can now declare **hook registrations**, and AIH emits them into the
  Claude hook configuration it owns while the third-party runtime that supplied each hook
  stays the one that executes it. The problem this addresses is narrow and concrete: when
  several independent writers register entries into one client hook file, the file records
  no owner per entry, so nothing can later say which writer put an entry there — and a
  writer that ships no removal path of its own leaves entries that can only be deleted by
  hand. AIH becomes the single registrar so a receipt can answer both questions. A
  third-party command is transported **byte-for-byte**: nothing parses, wraps, or re-emits
  it, and the only value AIH derives from it is the hash proving it did not change. The
  policy refuses at parse time when a launcher's hash no longer matches its pin, when a
  registration id repeats, or when registrations name two harnesses at once. Provenance is
  administrator-declared rather than inferred, so an unattributable launcher stays
  `owner: unknown` with its captured bytes still hash-pinned. Adoption reads launcher bytes
  from the destination and never from the declaration — a hand-typed launcher is not
  expressible. Projecting onto a destination that carries entries AIH did not emit is
  refused with each one named by owner and event, checked on every projection rather than
  only the first. Richer destination content is transported rather than refused:
  third-party native group and hook fields are carried verbatim through registrations,
  receipts, and the projection, so an adopted matcher-scoped hook is re-emitted with its
  matcher instead of being widened to fire on everything, and only structure that cannot
  be interpreted at all still refuses. `governance.hookRegistrations` is additive and
  `schemaVersion` stays `1`.
- **Uninstall now removes hook entries that AIH registered**, third-party ones included,
  with no hand editing. It subtracts only the `hooks` key its receipt proves it owns, leaves
  every other key in the file untouched, and does not replay the bytes recorded before it
  first projected — adoption transfers ownership, so adopted entries do not reappear. A
  destination whose receipt cannot prove clean ownership is reported with its reason and
  left alone rather than rewritten. Hook entries found with no receipt at all — what a
  crash between the projection's two writes leaves behind — are now reported instead of
  passed over in silence; they stay an advisory and never a subtraction, because without
  a receipt AIH cannot prove it emitted them.
- The Policy Workbench carries a **hook registrar panel**: a read-only projection view over
  registrations authored in the policy document and hook components selected on their own
  inventory rows, never a second place to author them. It reports entries and expected
  process spawns per event and in total, counts every row under its true owner, states that
  a hook its source reports as disabled still spawns a process — that control is read inside
  the launcher, after the process exists — and says plainly when the pinned catalog carries
  hook components but no per-hook registration table, so a small number is not read as a
  complete one. The panel reports usage; the surface does not put a price on a hook.
- The Policy Workbench now shows the **vet verdict AIH's own analyzers reached for every
  pinned component**, instead of telling an administrator to generate evidence this build
  already ships. Each row states who scanned it and at exactly what version, plus the
  content identity of the scanned tree. Components the vet blocked are **visually distinct
  and stay selectable**: they carry a leading rule, a mono flag naming the finding code, and
  a screen-reader disclosure listing every finding with its detail. That is deliberate —
  `blocked` here means an AIH-owned gate failed, and the governance decision to accept or
  reject that finding belongs to the administrator rather than to aih. Verdicts are
  **pin-bound**: when the shipped evidence was produced against a different commit than the
  catalog serves, no verdict is shown at all, because a verdict from another commit would
  launder a stale result into a current claim.
- A selected component row in the Policy Workbench now **states the fulfillment
  consequence of selecting it**, with matching counts in the report preview — an
  annotation on the existing rows rather than a new row or a second authoring path.
  Each state reports only what the shipped catalog's own pin can establish and defers
  the rest to the target repository's evaluation, because the page reads a build-time
  pin while the engine reads the target repository's runtime evidence. A vet-blocked row
  names accepting the finding as the path that changes its outcome; it stays visible and
  selectable, and the annotation is a label, never a disabled experience. Row
  annotations and summary counts now derive from one classifier that fails closed, so a
  row and the summary can no longer contradict each other, and a selection the row layer
  does not recognise is reported in its own honest bucket instead of being claimed as
  something else.
- `aih policy generate --apply` now creates a portable, self-contained Policy Workbench for
  authoring and downloading the actual org-policy schema without inspecting a target repository,
  resolving `--root`/`AIH_ROOT` repository state, or writing a repository run ledger.
  The workbench keeps requested policy intent distinct from evaluated state, preserves authority
  data as preflight-only until target-repository verification, keeps custom MCP pending and
  blocked, and records ECC/Superpowers agent, skill, and command curation as pinned external
  guidance rather than an AIH installer or projector. Signed approval clarification is bound
  into the approval attestation digest and required when waiving an evidence gap.
- `aih policy evaluate <root> --no-log --json` provides a headless requested-versus-effective
  governed-candidate gate. It resolves exact MCP and AIH-owned hook identities,
  receipt-verified external authority, targets, ownership, rollback/drift, and projector
  coverage; unsafe or unsupported requests remain blocked and visible in reports and doctor.
- The from-scratch baseline vet can now be **fanned out across hosts**. `baseline:vet` accepts
  `--shard <i>/<n> --receipts-out <file>` to scan one slice of each catalog and write a receipt
  bundle, and `--reuse-from <a,b,c>` to merge those bundles into the prior lock for a single
  assembly run. Sharding distributes the *work* of producing receipts and never the authority
  to assert one: the assembly run re-hashes every component tree and re-checks the
  required-analyzer identity set before splicing, so a stale or mismatched receipt is rescanned
  rather than trusted, and two bundles that disagree about the same component are refused
  instead of resolved. Shard coverage is always reported so a dropped shard cannot masquerade
  as a slow run. CI is unchanged and still runs the single-host `--full` ground truth.

### Changed

- **Merged JSON writes preserve the destination's own formatting.** AIH re-serialized
  the whole file, so an operator's comments, indentation, key order, and line endings
  did not survive a write even though every value did. A merge onto an existing
  parseable object now edits only the top-level keys whose value changed: every other
  key keeps its bytes, its comments, and its position, and a key AIH writes adopts the
  file's own indentation and line ending. AIH also stops normalizing what it did not
  change — an existing trailing comma is kept, and a missing final newline is no longer
  added. Two cases refuse rather than strip a comment: a comment inside the `hooks` span
  AIH owns and replaces whole, which previously was stripped in silence while the run
  reported success; and a destination that declares the same top-level key more than
  once and also carries a comment, because a duplicated name splits the writer from
  every reader of the file and is therefore collapsed by a whole-file render that would
  drop the comment. Without a comment to lose, a duplicated key is still collapsed by
  that render, as before. Non-merge writes, new files, empty files, and non-object roots
  render exactly as they did.
- **Hook revocation subtracts per group, so cohabitation is not drift.** One operator
  hook anywhere under the `hooks` key made the ownership verdict read `drifted` and
  revocation refuse outright, leaving hand editing as the only exit on exactly the
  configuration this feature exists for — a repository's own hooks, a framework's, and
  AIH's in one settings file. Ownership is now granular to the projected group: an entry
  is owned when its whole group structurally equals the receipt's rendering, produced by
  the same composer the projection writes with, and claims are occurrence-counted, so N
  owned copies claim exactly N groups on disk and an unvouched duplicate is preserved. A
  new verdict, `cohabited`, covers every owned group being provable with foreign content
  beside it; revocation then subtracts exactly the owned groups, writes the remainder
  back, and drops the `hooks` key only when subtraction leaves it empty. `active` keeps
  its exact-match meaning. Anything that breaks provability stays `drifted` and advisory
  with nothing removed: an operator entry inserted inside an AIH-written group, a
  modified owned command, a missing owned group. A file is removed only when AIH created
  it, its owned keys are its sole content, and nothing foreign remains — a file holding
  any operator content, including an entryless group or an empty event, is subtracted
  and never removed. Nothing is replayed: the remainder derives from the file's current
  bytes, so a group the operator has since deleted is not resurrected.
- Externally-owned inventory in the Policy Workbench is now **selectable**. AIH records
  ECC and Superpowers components with provenance — repository, pinned commit, path — while
  those frameworks install and run them, so a pin on a third-party component is provenance
  and never a gate. `Unsupported` no longer appears on any of the 151 recorded components;
  it and `blocked` are now reserved for items where an AIH-owned gate actually fails, which
  is AIH's own MCP controls, hooks, and custom candidates. Selecting a third-party component
  records requested intent and holds it at `requested-evidence-needed` until evidence
  arrives, so evidence is a separate axis from selection rather than a precondition for it.
  Each row states the `aih evidence vet-baseline` command that would produce its evidence.
- An org policy may select from **one external framework at a time**, enforced in
  `OrgPolicySchema`; ECC and Superpowers are mutually exclusive because composing two
  catalogs is a claim neither framework makes. A component may not appear in both external
  selections and curation.
- The from-scratch baseline vet is now **anchored to the pin set rather than to a schedule**,
  and no longer runs in CI. Every input it consumes is content-addressed — sources by commit
  SHA, SkillSpector by image digest, the scanner environments by hash-pinned `uv.lock`,
  `aih-native` by a content digest over its own detector closure — so between two runs at an
  unchanged pin set nothing can differ except the machine, and repeating the scan sampled the
  runner image rather than re-testing the supply chain. A green vet now stands until a pin
  moves, and when one moves it becomes blocking. CI instead runs two cheap checks: the new
  `check:baseline-pins`, which compares the pin set the build declares against the pin set the
  committed lock recorded, and `baseline:check`, which proves the lock still reproduces from
  the pinned sources. `check:baseline-pins` replaces a path-pattern relevance gate that
  inferred the answer from which files a diff touched — comparing recorded identities against
  declared ones is the fact rather than a proxy, and it catches the case a path pattern is
  worst at, where the sources are untouched but the analyzer is no longer the one that
  scanned. The pair is tamper-resistant: editing the lock's recorded pins to fake agreement
  fails, because `baseline:check` then re-derives at those pins and the receipts do not
  reproduce.
- Every externally-pinned vetting input is rebound to a current upstream identity and re-vetted
  from scratch: ECC `4da6deac` → `623f2c02`, Superpowers v6.1.1 → v6.2.0, SkillSpector 2.5.0 →
  2.5.3 (new controlled digest, reproduced independently on four hosts), cisco-ai-skill-scanner
  2.0.12 → 2.0.13, cisco-ai-mcp-scanner 4.8.1 → 4.8.2, uv 0.12.0 → 0.12.2, the self-host
  `github-mcp-server` image v1.7.0 → v1.8.0 by digest, and the generated `@playwright/mcp`
  launcher 0.0.78 → 0.0.79. Semgrep deliberately stays at 1.172.0, which remains covered by the
  open vendor-blocked item. Available versions are not approved versions: each identity is
  recorded in `src/internals/external-pin-ledger.json` with the evidence that qualified it.

### Fixed

- The ECC native runtime AIH projects into a project could not start at all. It runs
  from wherever it was projected, outside the installed package, so no dependency
  closure sits beside it — and `zod` stayed an external bare import, which Node failed
  to resolve before the runtime read a single argument. No invocation of the projected
  runtime worked, in any mode. `zod` is now bundled into the chunk all three entry
  points already share. An installed 3.4.0 profile keeps the broken runtime until it is
  updated, because the registered runtime is a built artifact.
- An org baseline-evidence bundle this build cannot read is now diagnosed for what it
  is. An attested artifact that failed to parse was passed over in silence, and the run
  then reported that the bundle carries no evidence for the pin — sending an
  administrator to re-vet a pin that was already vetted. Every attested baseline
  artifact is now classified by its declared schema version before any structural parse,
  and a lock that is unreadable or newer than this build fails under its own code,
  `baseline.evidence-schema-unsupported`, naming the declared version, the version this
  build parses, and the remedy: upgrade aih, rather than restore bytes or re-vet.
  Artifacts are floored whether or not they match the requested catalog, so a run cannot
  quietly settle for an older artifact in the same signed bundle.
- The ECC composite hook dispatcher no longer emits `hookSpecificOutput` on Claude events
  that reject it. Claude validates that field against a per-event allowlist and discards the
  whole hook payload when the event is absent from it, so 8 of the 13 registered Claude
  events previously failed client output validation whenever the dispatcher had context to
  add — including `PreCompact`, which silently lost the durable pre-compaction summary the
  continuity handler had produced. Context for those events now travels in the root-level
  `systemMessage`, and a `PermissionRequest` denial uses the root-level `permissionDecision`
  and `reason`. `PreToolUse` is unchanged, and Codex is unchanged because only Claude
  publishes a per-event allowlist. An installed profile keeps the previous behavior until it
  is updated, because the registered runtime is a built artifact.

## [3.4.0] - 2026-08-04

### Added

- `aih ecc --lifecycle` now provides a preview-first, authenticated Claude and
  Codex ECC profile lifecycle: install, update, repair, rollback, and uninstall
  project-local projections together with field-owned native hook and selected-
  MCP registration. Exact pinned source closure, client transport policy,
  deterministic ownership/parity receipts, compound transactional recovery,
  operator-config preservation, bounded native runtimes, fail-open operational
  handlers, opt-in personal state, Token Savior qualification, and guarded Plan
  Canvas support are verified in disposable projects and client homes.
- `docs/CANON_GOVERNANCE.md` maps each canon-governance practice (small
  always-loaded bootloader, generated projections, always-loaded safety
  invariants, hermetic git spawns, PR sizing) to where it is stated and the
  machine check or test that enforces it, with the audit's deliberately
  deferred gaps recorded alongside.
- CI now runs the direct self-hosting canon gate
  (`npm run check:self-hosting-canon`) without invoking AIH against its own
  checkout. It checks the manual shared-block/bootloader byte mirror, current
  repository contract facts, package-script and CI wiring, and the absence of
  self-targeting setup instructions. Product repositories retain
  `aih bootstrap-ai --verify`; this repository adopts relevant generator changes
  manually and verifies the resulting source relationships directly.
- `aih bootstrap-ai --verify` now emits an advisory skip check
  (`cli.bootloader-unmanaged`) for every bootloader present in the repo but
  outside the resolved target set, so a drift gate pinned to explicit `--cli`
  targets reports the coverage gap in its verification report and SARIF instead
  of a dry-run-only notice.
- The generated shared canon block gains a `public-surfaces` invariant — issues,
  PRs, commits, and canon files are treated as public surfaces; confidential or
  private-companion content never appears in them. The line is generic by design
  (the canon ships into every bootstrapped repo); the repo-specific detail stays
  in `doc-and-truth-homes.md`.

### Changed

- The `doc-and-truth-homes` rule now loads at the moments leaks actually happen:
  its trigger (and the router's trigger table) names filing issues, drafting
  PRs, and committing, and the lazy-canon selector includes the rule for
  closeout tasks.
- `git-ci-discipline.md` records the PR-sizing convention: combine related,
  file-disjoint small units into one PR (labeled with the max `semver:*` of its
  parts); keep only broad-blast-radius changes separate, where a clean
  one-commit revert matters.

### Fixed

- ECC profile repair and rollback now preflight the authenticated projection and
  native hook/MCP registration together, then apply both through one filesystem
  transaction. A stale or modified native runtime therefore cannot leave a
  partially repaired or rolled-back projection. Install and update now retain
  receipt-bound ownership authority across their projection and registration
  phases, so the generic dirt gate does not reject AIH-managed files as operator
  changes. Update, repair, rollback, and uninstall use the same stronger
  per-file ownership and content-pin checks.
  The canonical profile records
  the active AIH-owned lifecycle/registration state, and a deterministic parity
  receipt accounts for every projected client mapping plus the native hook and
  MCP policy; exact-pinned-source and disposable installed-client tests bind the
  receipt and exercise install, repeat install, repair, native parsing, and
  uninstall.
- `aih` no longer lets an inherited `GIT_*` environment steer its own `git`
  subprocesses out of the directory they were pointed at. `git` resolves which
  repository it operates on from `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`
  (etc.) *before* `cwd` or `-C`, and it exports an absolute `GIT_DIR` into the
  process tree of every hook it runs — so `aih` invoked from a pre-commit hook
  performed its git reads and writes against the caller's real repository
  instead. Observed: a worktree hook run flipped a shared `.git` to
  `core.bare=true` and clobbered staged blobs. Every production git spawn now
  goes through a shared `hermeticGitEnv()` that strips inherited `GIT_*`, so
  `cwd`/`-C` is the only thing that selects the repository. Transport-only
  settings (`GIT_SSL_*`, `GIT_PROXY_COMMAND`, `GIT_ASKPASS`,
  `GIT_TERMINAL_PROMPT`) are preserved, so corporate-CA clones configured by
  `aih certs` keep working; `GIT_CONFIG_*` is stripped because it can relocate
  the repo via `core.worktree`. The generated ECC ownership-manifest and usage
  recorders carry the same scrub inline, since they run as their own node
  processes under git hooks — previously they could record another repo's
  commit/branch as provenance.
- `aih bootstrap-ai --verify` is no longer sensitive to the checkout's folder
  name. The RULE_ROUTER and bootloader headings previously embedded
  `basename(<root>)`, so the drift gate false-failed with
  `canon.generated-drift` from any renamed clone or `git worktree` checkout of
  a repo whose canon was generated elsewhere. The display name now derives from
  stable sources — the git `origin` remote's repo segment (read from
  `.git/config` directly, resolving worktree pointer files; never a `git`
  subprocess), then `package.json` `name` with the scope stripped — falling back
  to the folder basename only when neither exists. `aih adopt` reuses the same
  derivation, so both writers stay byte-identical. Upgrade note: a repo whose
  checkout folder name differs from its git origin (or `package.json`) name will
  report one `canon.generated-drift` on its next `--verify`; run
  `aih bootstrap-ai --apply` once to adopt the stable heading.

## [3.3.0] - 2026-08-01

### Added

- `CHANGELOG.md` now ships inside the published npm tarball, and both the GitHub
  Release body and the README link to it. An evaluator working from
  `npmjs.com/package/@aihq/harness` — which renders only the README — previously had
  no route to per-version release notes without cloning the repo, and the Release
  body carried GitHub's auto-generated PR-title list rather than the curated prose
  that already existed a click away. The Release link is pinned to the tag being
  published, so it cannot drift or 404. Refs #563

### Changed

- Compact per-CLI adapter notes now contain only the tool-specific entry, loading,
  and baseline delta plus one router pointer; `--canon legacy` retains the previous
  full adapter bytes. Bootstrap generates only the resolved target set and leaves
  existing dropped adapters as membership evidence until the explicit `aih prune`
  sweep classifies their complete artifact set. The last split invariant wordings
  now share one authored template source across the compact block and behavior core,
  with fleet idempotency, template-partition, hand-edit, and orphan-sweep proofs.
  Bootloader paths, `ai-canonical:shared`, full managed blocks, and the wired
  `risk-gates.json` consumer are unchanged. Refs #507

### Fixed

- Release preflight now attributes rebase-merged commits through GitHub's exact
  commit-to-pull-request association before applying the no-PR gate. Multiple
  commits from the same pull request are deduplicated, while direct commits,
  missing associations, ambiguous associations, and untrusted metadata continue
  to fail closed.
- `aih uninstall` now treats a generated context tree that is also a registered
  live CLI config directory, such as `.claude`, as co-owned. Preview and `--apply`
  leave the complete directory in place, name the generated canon files left for
  manual cleanup, and distinguish operator-owned settings, agents, commands, and
  managed-settings content that remains untouched. Distinct context directories
  such as `ai-coding` and `.ai-context` keep their existing reversible wholesale
  backup behavior. Refs #570
- Regular-file reads now open with `O_NONBLOCK` as well as `O_NOFOLLOW` where
  available, so a FIFO is rejected before it can block `aih doctor`, `aih prune`,
  `aih uninstall`, or any bundle reader. The no-follow identity fallback, regular
  files, directories, dangling links, size limits, and descriptor-bound race checks
  are unchanged. Refs #571
- `aih uninstall` no longer destroys the evidence for content it leaves behind. It
  removes `.aih-config.json`, and that marker is the only record of which keys aih
  wrote into `.claude/managed-settings.json` — so removing it first made any residue
  permanently unattributable. Uninstall now reconciles marker-proven content FIRST:
  when the recorded managed-MCP pair exactly matches what is on disk, it subtracts
  exactly `allowManagedMcpServersOnly` and `allowedMcpServers` and then removes the
  marker, both staged in one rollback-capable transaction so an interrupted run can
  never leave a removed marker beside unsubtracted content. Every other key —
  operator-authored content, `organizationPolicy`, `sandbox` — keeps its value, and
  the file itself is never deleted, because the marker proves two keys and never the
  file. (As with every aih JSON merge-write, the file is re-serialized, so JSONC
  comments and hand formatting are not preserved.) A drifted pair — or a path that is
  not a readable regular file — is left untouched and the dry run names what is about
  to become unattributable; an absent, malformed, revoked, or hash-invalid marker was
  never a provable claim, so there is nothing to reconcile and nothing is reported.
  The subtraction is also skipped when the projected file sits inside a tree the same
  run removes wholesale — a repo bootstrapped with `--context-dir .claude` — rather
  than promising to preserve keys in a file that is about to move to backup. Refs #567
- `aih prune` now reconciles the projected `.claude/managed-settings.json` left behind
  when a repo drops Claude from its committed targets. Nothing did: `aih policy
  project` returns an empty plan for an untargeted CLI, prune only knew the registered
  per-CLI settings path, and uninstall never included the file. Prune now subtracts
  exactly the two marker-proven managed-MCP keys and clears the ownership record, in
  that order, in one rollback-capable transaction; a drifted pair — or a path that is
  not a readable regular file — is preserved and its ownership revoked rather than
  overwritten. With no active ownership record at all (absent, malformed, revoked, or
  hash-invalid marker) prune stays silent: it has nothing to subtract and nothing to
  revoke, and naming the file would tell an agent to re-run a command designed to
  refuse. `aih doctor` owns that case instead. `organizationPolicy` and
  `sandbox` are never removed — no provenance is recorded for them, and `sandbox` is
  co-written by `aih guardrails` and `aih sandbox`. Every ownership decision reads the
  path as a regular file with no symlink follow, so a symlink (including a dangling
  one), a directory, or a path reached through a symlinked parent is reported and the
  claim revoked rather than any subtraction being planned — the parent case included
  because the executor refuses those, so calling it repairable would name a command
  guaranteed to refuse. The residue is detected from the committed
  target set rather than the adapter files on disk, so an earlier prune that already
  removed the adapter cannot strand it. Because prune can now do the job, `aih doctor`
  names it: a marker-proven residue reports `org-policy.dropped-target-residue` with
  exactly one runnable command, and running it clears that finding. A residue aih
  cannot prove it owns reports the new distinct code
  `org-policy.dropped-target-unowned` with the explicit reason, so an agent escalates
  instead of retrying the same command forever. Refs #566
- `aih mcp` at enterprise posture no longer writes the Claude managed MCP allowlist
  into a repo that does not target Claude. It resolved the repo's CLI targets and then
  wrote `.claude/managed-settings.json` regardless — re-creating the residue `aih init`
  stopped writing in #360, and overwriting operator-owned managed-MCP configuration in
  a Kiro-only repo. The write is now scoped to the resolved target set, matching `aih
  policy project`, and the run states why nothing was projected instead of failing
  silently. Existing operator-owned Claude configuration is never suppressed or
  deleted — this only stops aih creating it — and `.mcp.json` generation for the
  repo's real targets is unchanged. This is what makes the #566 repair durable: a
  later `aih mcp --apply` no longer re-creates what prune just removed. Refs #568
- `aih doctor` now scopes Claude-owned policy checks to the target set the repo
  actually committed. A repo that targets only Kiro (or any other non-Claude tool)
  is no longer failed for a missing `.claude/managed-settings.json` projection that
  `aih policy project` would never write there — the check reports why it did not
  apply instead. When Claude artifacts are still on disk after Claude was dropped as
  a target, both the org-policy drift probe and the managed MCP allowlist probe now
  report dropped-target residue naming a repair the operator can actually perform —
  add the tool back to the targets, or remove the file — instead of prescribing a
  re-projection that emits no actions for that repo. (Since the #566 entry above,
  `aih prune` reconciles the projected managed-settings file too, so a marker-proven
  residue now names it; a residue aih cannot prove it owns still names neither.)
  `.aih-config.json` itself is never reported as residue, so a
  repo is never told to delete its own target declaration. Because narrowing a governance
  check suppresses findings, it takes the strongest evidence available: the committed
  `.aih-config.json`, and only when every target id in it is recognized. A missing,
  malformed, or empty marker — and weaker signals such as a `--cli` flag, `--detect`,
  or targets inferred from adapter files on disk — narrow nothing and keep the
  previous strict behavior, so a deleted file or a command-line flag cannot silence
  an org-policy finding. Refs #554

### Security

- Known third-party scanner residual: the exact AIH tool environments for Semgrep
  1.172.0 and Snyk Agent Scan 0.5.15 retain `mcp` 1.23.3 and 1.27.0 because those
  vendors pin those versions exactly, leaving six high Dependabot alerts open and
  unsuppressed. AIH invokes Semgrep as an offline static scan and does not launch
  the affected MCP server transports or task paths during normal scanner use. No
  scanner identity or pin was weakened; #574 records the upstream constraints,
  exposure, and exit condition.

## [3.2.0] - 2026-08-01

### Added

- ECC Kiro installs now carry an ownership record, so a copy left behind by a newer
  ECC source becomes visible instead of silently passing. A run snapshots the target
  directory, then hashes only the files it created into repo-local
  `.aih/ecc/install-manifest.json` alongside the ECC commit they came from. A later
  run separates content still matching its record from content the operator has since
  edited — which is never auto-replaced — from content with no record at all, which is
  never claimed. The finding is advisory; a missing or unreadable record fails closed
  to "not proven ours", and installs predating the record report as unknown provenance
  until reinstalled. Per-mechanism install claims now derive from the target registry,
  so a newly registered tool cannot inherit a claim that is untrue for it. Refs #555

- Governed external-tool configuration now records a source-bound acceptance ledger,
  refreshes the approved local MCP and repository-tool runtimes at exact versions,
  pins the self-hosted GitHub MCP container by digest, and removes only the exact
  historical AIH-generated AWS core MCP launch whose dependency can no longer resolve.
  Operator-modified AWS entries remain untouched.

- Baseline qualification now retains one source-wide occurrence ledger, evaluates
  exact active-profile closures separately from unselected inventory, groups
  residual administrator decisions, and supports deterministic Cisco source
  shards with a fail-closed evidence join. Refs #549

- Added `aih change-profile --input <file>`, a canonical read-only adapter over the
  pure deterministic change-profile classifier. It accepts one bounded strict-UTF-8
  regular JSON file and emits one standard digest; every invalid-input class shares
  the stable `AIH_CHANGE_PROFILE_INPUT` code with bounded sanitized issue records.

- Added `aih live [root] --cli codex|claude|kimi --prompt-file <file>` for real-time,
  capped progress from one explicitly selected local CLI. Codex and Claude use pinned
  core read-only modes; this is not clean-room isolation from local vendor customization:
  Claude skills are disabled without `--safe-mode`, Codex does not ignore all user
  configuration, and native instructions/plugins/hooks/MCP configuration may still
  initialize without an aih read-only attestation. Kimi 0.29.2 requires explicit
  non-read-only consent, is visibly labeled `non_read_only`, may use native tools and
  change the selected worktree, and is accepted only through its direct
  native-executable argv transport. Aih performs
  no worktree-safety or dirty-tree preflight for Kimi; although aih never prints its
  prompt argument, Task Manager, WMIC, and other local process-inspection tools may
  expose it.

- A partially-authorized `aih ecc --profile full` run now states why its scope
  was reduced. When the org's signed acceptance covers only a subset of the
  full-profile module set, `authorizedEccSelection` downgrades to `scope:
  "scoped"` and the pipeline proceeds under `allowPartial` — correct fail-closed
  behavior, but the operator-visible symptom was "I asked for full and got a
  reduced set," inferable only from the held-baseline-components digest. The
  verified install plan now emits an `ECC profile scope` digest naming the
  reduction and the withheld module ids, carried in the `--json` envelope as
  `{ requestedScope, authorizedScope, held }`. This reports only: the gating is
  unchanged, unauthorized modules still do not install, and a fully-authorized
  full profile is untouched. Refs #527

### Changed

- `docs/security/baseline-evidence.md` now states two limits of the evidence model
  that were true but undocumented. First, vet is a content gate only: every release
  analyzer reads bytes, so a clean receipt set says nothing about runtime process
  cost or platform behavior. The shipped ECC pin is the worked example — it declares
  21 hook entries, all `command` strings with no `args` exec form, four of them bound
  to a wildcard tool event that fires on success, which on Windows surfaces as a
  console window per hook; every analyzer passed that commit because nothing in the
  receipt set asks the question. Second, the vetted identity is exactly one upstream
  commit: any checkout used to reproduce a baseline must sit on that SHA, and a fix
  to a pinned component goes upstream rather than into a local or forked tree,
  because `src/binding/scan-acceptance.json` is keyed to exact file-content sha256
  and any rebind voids the acceptance set.

### Fixed

- The context footprint now measures every target's rule tree instead of only Cursor's.
  Targets that load a whole directory rather than named files declare it in the CLI
  registry, so `.kiro/steering/` is walked exactly as `.cursor/rules/` already was, and
  a newly registered target is measured without editing the report. Steering files a
  repo added by hand were previously invisible to the footprint and to `--gate`.

- `aih ecc` no longer promises an upgrade path its installers cannot deliver. The blanket
  "re-run after the stack changes to re-scope" line was emitted once for every target, but
  installation dispatches to four mechanisms that do not share those semantics, and on every
  path aih controls a rerun *adds* newly-matched content while leaving already-installed
  files untouched. Each group now states its own rerun behavior, consult-only targets no
  longer receive re-scope guidance at all, and both Kiro doc paths say plainly that the copy
  adds only what is missing instead of calling it "(idempotent)" — technically true, but read
  by operators as "safe to re-run for updates". Output text only; no behavior changed.
  Refs #555

- Org-policy drift probes now honor the repo's configured target set. Doctor evaluated the
  Claude-owned org-policy projection for every repository regardless of its targets, then
  prescribed `aih policy project --apply`, which deliberately emits zero actions when Claude
  is not targeted — so the finding was unsatisfiable by construction for all ten non-Claude
  targets. The asymmetry was structural rather than an oversight: the write half gates on an
  async target resolve that the synchronous probe half could not call. The projection's
  owning CLI is now resolved once from the registry's declared `configDirs` rather than a
  hardcoded tool name, scoping the whole probe set to match the write half's all-or-nothing
  semantics and covering the sibling `.example` files that live outside the tool's config
  dir. Closes #554

- The generated Codex merge script seeds its config atomically instead of check-then-create.
  The seed write guarded an already-atomic `wx` open with a preceding `existsSync` check,
  which added nothing but a TOCTOU window — and the two disagreed whenever the path traversed
  a directory symlink. With a symlinked HOME on Windows, `existsSync` reported absent while
  `open()` found the file, turning a benign already-exists into a hard `EEXIST` crash that
  aborted the install before its own safety guards ran. The pre-check is dropped, `wx` is
  kept, and `EEXIST` is treated as the benign outcome it is. Context-report sources are also
  now derived from the CLI registry rather than a hand-kept per-tool list that was wrong in
  both directions. Closes #553

- Trust scanning no longer advertises or accepts AgentShield as a governed
  detector while its upstream source is unavailable. Existing org policies that
  name `agentshield` must remove it. The pinned Cisco MCP scanner now requests
  only the YARA analyzer supported by its static mode and fails closed unless
  every submitted tool has explicit YARA coverage.

- The ECC baseline now pins the merged `affaan-m/ECC` upstream source instead of
  the temporary `samartomar/ECC` fork bridge, with regenerated component inventory,
  install preview, and analyzer evidence at the exact upstream commit. Closes #440

- Bare first-run CLI targeting now follows the documented `claude` default instead
  of silently widening to every runnable CLI on `PATH`. Existing repositories still
  regenerate from committed `.aih-config.json` targets, and `--detect` remains the
  explicit way to select runnable installed tools. This also prevents a bare `aih
  mcp --apply` from unexpectedly writing global Codex or Gemini configuration.
  Refs #507

- `aih init` / `aih bootstrap-ai` now say so when that `claude` default narrows past
  bootloaders the repo already has, naming the files (`AGENTS.md`, `GEMINI.md`, …)
  the run will neither regenerate nor drift-check. The `--verify` drift gate only
  probes the resolved targets, so an unrecorded target set could previously let the
  rest of a multi-tool repo's canon rot behind a green check. Refs #507

- `aih workspace` no longer destroys a bootstrapped repo's own bootloader. The
  workspace bootloader write is a whole-file `writeText`, while `aih
  bootstrap-ai` merges the canon into an `ai-canonical:shared` fence and leaves
  everything around it verbatim — so pointing `aih workspace --apply` at a
  directory that was already bootstrapped as a repo silently replaced its
  `CLAUDE.md`, fence and hand-written preamble alike, with no warning and no
  route back. The plan now runs a preflight that refuses with
  `AIH_WORKSPACE_BOOTLOADER_CONFLICT` when a targeted root bootloader carries
  that block, naming the conflicting files and pointing at the parent-only
  layout. Ownership is tested on the `BEGIN` line alone via the new
  `hasManagedBlockStart`, so a bootloader whose `END` line was truncated — which
  carries no well-formed block yet is still repo-owned, and is the hardest case
  to recover — refuses rather than failing open. The refusal happens before
  anything is staged, so the bootloader is
  left byte-for-byte unchanged, and it runs for dry-run too, so a plan never
  advertises a write that `--apply` would reject. `--force` is preserved as the
  explicit destructive override, under which the documented overwrite — and its
  `*.aih.bak` backup — still occurs. A directory is either a bootstrapped repo
  or a workspace parent; the combined layout stays unsupported. `.mcp.json` is
  merged, not overwritten, and is unaffected. Refs #539

- A failing `exec` action now surfaces the child's diagnostic instead of only its
  exit code. `defaultRunner` always captured both child streams, but the plan
  projection kept only `code`/`ok`, so `aih ecc --cli claude --apply` on a clean
  machine reported `step failed (exit 1)` with no way to tell a missing `npx`
  from a registry 404, an unreachable proxy, or a throwing upstream installer —
  the only recourse was re-running the command by hand. `PlanResult["execs"]`
  entries now carry `stderr`/`stdout`, rendered under the `[exec]` line and
  carried in the `--json` envelope. Child output can contain credentials
  (registry-URL tokens, proxy auth), so it is masked at a single source-side
  chokepoint through `redactSecrets` before any renderer sees it, and bounded to
  the trailing 20 lines / 4096 characters with an explicit omission count.
  Successful actions attach nothing. Refs #538

### Security

- Trust normalization now separates raw scanner occurrences from AIH findings and
  policy dispositions, deduplicates repeated evidence, and classifies lexical HTTP
  examples, boolean negation, visible prose Unicode, and documentation-only
  third-party heuristics without turning them into executable-risk blocks.
  Actual control characters, credential extraction, destructive automation, and
  unresolved executable permission or egress risk remain fail-closed. Refs #549

- Two output-hardening gaps closed in the shared workspace manifest validation
  layer (`src/workspace/manifest.ts`), inherited identically by the snapshot,
  hydrate, link, task-plan, and workspace-index paths. `normalizeWorkspacePath`
  threw its absolute-path rejection before the printability assertion ran, so a
  hostile manifest path carrying a raw ESC byte was joined into the thrown
  message and printed unsanitized by the CLI error path; the assertion is now
  hoisted above every rejection and the messages interpolate the normalized
  value, making them sanitized by construction. `assertWorkspacePrintable`
  blocked C0/DEL and table metacharacters but accepted U+202E and the rest of
  the bidi set, letting a hostile edge `kind` spoof the visual order of a
  rendered digest table; the gate now rejects every Unicode control and format
  codepoint, which also covers C1 and the zero-width and tag characters. No
  behavior change for well-formed manifests. Refs #520

## [3.1.0] - 2026-07-25

### Added

- The risk-gates sidecar has a real consumer: at team/enterprise posture
  `aih guardrails` now also generates `.github/workflows/risk-gates.yml` — a
  pull-request workflow (the same "runs in YOUR CI, not from aih" boundary as the
  SCA workflow) that reads `risk-gates.json`, diffs the PR's changed paths against
  each gate's path patterns, and surfaces every touched gate as warning
  annotations plus a job-summary table. Ask-not-deny end to end: a touched gate
  never fails the build, matching the `risk-gates` warn grading at every posture;
  the job name is the sidecar's declared `ci.checkName`, and the only hard failure
  is a corrupted sidecar. The matcher policy is unit-tested through a TS mirror of
  the workflow's bash matcher (`riskGatesTouched`), and gate patterns are matched
  with shell globbing disabled so they can never expand against the checkout. At
  vibe posture neither sidecar nor workflow is emitted. Refs #507
- Canon MUST-to-enforcing-check map: `docs/CONTROL_MATRIX.md` gains a
  `## Canon MUST Map` section classifying every imperative line the generated
  Layer-2 canon (`src/bootstrap-ai/canon.ts`) emits — generation-invariant MUSTs
  cite their drift probe or canon lint seam, governance MUSTs cite their gate
  (secret scan, guardrail artifacts, posture grading), and agent-behavioral MUSTs
  are labeled `agent-directed, not aih-gated`. A regression gate
  (`tests/bootstrap-ai/canon-must-map.test.ts`) regenerates the reachable canon
  surface, extracts imperative lines by a documented token set, and fails closed
  on any unmapped imperative or stale map row. (Refs #507)
- `aih workspace graph` projects the workspace's own declared contract relations
  (`.aih-workspace.json` `repos[]` + `edges[]`) into a queryable cross-repo graph —
  declared over inferred: a declared two-repo workspace yields queryable cross-repo
  edges from declarations alone, with graph-tool inference demoted to optional
  enrichment. `--apply` writes the pure, deterministic projection (every edge marked
  `provenance: "declared"`) to `.aih/workspace-graph.json`; `--repo`/`--from`/`--to`/
  `--kind` answer edge queries without writing; `--json` carries the graph, query,
  and matches. Fail-closed: dangling edge endpoints and undeclared query repo ids
  are errors, so a typo can never read as "no dependencies". (#505)
- Org-policy surface UX for the enterprise first-setup loop. `aih policy init [root]`
  seeds a starter `aih-org-policy.json` from observed fleet state: catalog-bound MCP
  surfaces (the exact lens enterprise baseline attestation grades) become
  `mcp.allowedServers`, so a fresh enterprise setup passes attestation for servers aih
  itself generated with no hand-editing. Fail-closed boundaries: an existing policy or
  an active `AIH_ORG_POLICY` override refuses; surfaces attestation force-undeclares
  are listed for review, never silently declared; marketplace surfaces are never
  auto-trusted into `trust.approvedSources`. At enterprise posture `aih mcp` now names
  its own declaration gap: generated servers the active policy leaves undeclared
  produce a ready-to-merge `allowedServers` snippet digest (or a pointer at
  `aih policy init` when no policy exists) — guidance only, no gate or verdict
  changes. Every `aih policy` subcommand also accepts the conventional optional
  `[root]` positional, so `aih policy validate <root>` works like the other
  repo-scoped commands. (#503)

- Doctor distinguishes generation deltas from user drift on aih-generated managed
  artifacts. When `.claude/managed-settings.json` or the managed MCP allowlist
  matches an EARLIER aih generation's own output — a pre-hardening bare `uvx <pkg>`
  launch shape, an older version pin, or missing newer projection keys — after an
  in-place upgrade, doctor now reports a generation delta (`org-policy.generation-delta`,
  `mcp.allowlist-generation-delta`) naming `aih policy project --apply` inline instead
  of implying a local edit. Attribution is fail-closed: any difference not positively
  explained by aih's generation history still fails under the existing drift codes,
  and the re-projection under `--apply` (shipped in v2.11.0) is re-validated to
  migrate old-generation managed allowlists. (#501)
- Resolved-artifact attestation for uvx MCP pins. Doctor always renders an
  `mcp-uvx-pin-attestation` row: with exactly-pinned uvx servers in `.mcp.json` it
  reports the pins as NOT attested (`mcp.pin-unattested`, an advisory skip) until the
  operator opts in with `aih doctor --attest-mcp-pins`, which launches each pinned
  server once with an MCP `initialize` handshake and compares its self-reported
  `serverInfo.version` to the pin — a mismatch warns (`mcp.version-drift`), a match
  passes. The launch gate is fail-closed (literal `uvx`, exact end-to-end pins, no
  config-supplied environment); attestation proves what the resolved artifact
  self-reports at runtime, not the artifact's provenance or integrity. Because the
  probe executes the pinned third-party artifact, the live handshake is opt-in only.
  (#502)
- Pin currency for the wired MCP tool pins. Doctor renders an `mcp-pin-currency`
  row covering both halves of the pin-refresh double lag: offline on every run it
  compares each exactly-pinned npx/uvx launch in `.mcp.json` against the pin this
  aih build's catalog generates for the same server (a difference is the
  re-projection half — `mcp.projection-stale`, fixed by `aih mcp --apply`), and
  `aih doctor --check-pin-currency` opts in to the upstream half, querying each
  pin's registry for its latest release (npm via `npm view`, PyPI via its JSON
  metadata endpoint) — registry metadata only, nothing downloaded or executed,
  opt-in because it is network egress from a read-only command. A newer upstream
  release warns (`mcp.pin-stale`) as a vet-then-bump candidate, never an automatic
  upgrade; the documented refresh path is vet (`aih trust scan`) → bump in an aih
  release → re-project (`aih mcp --apply`) → re-attest (`--attest-mcp-pins`). The
  codebase-memory-mcp interactive graph-UI variant is deliberately not installed or
  linked — the wired, vetted surface is the headless stdio launch only — and that
  decision is recorded in docs/commands.md. (#504)

### Changed

- Single-sourced the generated discipline text at its authored layer (slice A of
  the #507 canon-structure theme): the working-agreement principles (think before
  coding, simplicity first, surgical changes, goal-driven, canon tools), the
  invariant list, and the reporting bar are now authored once in
  `src/bootstrap-ai/canon.ts` (`DISCIPLINE_PRINCIPLES` / `DISCIPLINE_INVARIANTS` /
  `DISCIPLINE_REPORTING`), and both renderings — the shared canonical block's
  compact bullets and `rules/agent-behavior-core.md`'s long-form sections — derive
  from that single source, drift-guarded by the extended byte-identical-fragments
  tests. Emitted output is byte-identical in both canon modes: the marker id
  (`ai-canonical:shared`), every emitted path, legacy output, and the committed
  dogfood tree are all unchanged, so no deployed bootloader reads as drifted.
  Refs #507.

### Fixed

- Adapter regeneration scope now honors `--cli`: the `.aih-config.json` marker's
  `targets` are replaced with each run's resolved CLI set instead of being
  array-unioned with previous runs, so an explicit `aih bootstrap-ai --cli
  claude,codex` narrows the persisted footprint and later marker-driven re-runs no
  longer resurrect a dropped CLI's adapter + bootloader (files on disk stay
  untouched; `aih prune` removes them). `aih adopt`'s convergence of every
  bootloader that already exists on disk is deliberate — required to reach
  already-adopted — and is now documented as footprint-convergence-beats-CLI-scope
  in the command reference. The ECC Codex `--profile full` passthrough reported by
  the same enterprise rollout batch is locked with live-path regression tests
  (resolved profile → registration request → full-scope Codex merge), and the
  enterprise onboarding + release-SLSA docs now route global-install provenance
  through `aih verify-release` instead of a bare `npm audit signatures`, which
  cannot audit a global install (`EAUDITGLOBAL`); the verifier runs
  `npm audit signatures --prefix <temp>` against the exact release instead. (#506)
- `aih ready` reports the factual secret-location class instead of labelling every
  plaintext finding "committed": git-tracked findings stay under `no-committed-secret`
  (rotate + rewrite git history), while untracked on-disk files report
  `no-plaintext-secret-on-disk` (rotate + move to a vault / env references). Both
  classes keep the same posture split, no finding is dropped, and an unanswerable
  git state (git absent, or rev-parse erroring for reasons like dubious ownership)
  fails closed to the committed class. (#502)
- Doctor's `ai-clis` probe no longer stays green for a dead CLI. Each detected
  binary must pass a bounded `--version` exec: broken binaries are named in the
  probe detail, and when every detected binary fails the exec the probe hard-fails
  as `cli.binary-broken` instead of reporting the machine as runnable. (#502)
- The canon lint's `canon-ref-resolves` rule no longer flags references inside an
  explicit "only if `<file>` exists" conditional. The waiver is ref-bound (the
  guard's subject must be the reference itself or an anaphoric "it"), positive
  polarity only (negated guards such as "does not exist" never waive), prose-only
  (fenced code blocks never qualify), and line-scoped; escaping refs stay fatal
  even when guarded. (#502)

### Fixed

- Baseline-vet concurrency helper (`src/baseline-evidence/concurrency.ts`) no
  longer silently reinterprets a malformed `AIH_VET_CONCURRENCY` override:
  `resolveVetConcurrency` now requires the (whitespace-trimmed) value to be a
  plain positive integer, so values like `"2x"`, `"1.5"`, and `"1e3"` — which
  `Number.parseInt` previously coerced into `2`, `1`, and `1` respectively —
  fall back to the documented `max(1, floor(cpus/2))` default instead of
  silently changing the effective concurrency. Separately, `runWithConcurrency`
  now fails fast: once any task rejects, no worker pulls a new item from the
  shared iterator, so detector subprocesses and temp scan directories are no
  longer created after the caller has already begun failure cleanup;
  already-in-flight tasks are still awaited to settle (no orphaned or
  unhandled-rejected promises) and the first rejection observed is still the
  one propagated to the caller. (#529)
- `aih heal` now distinguishes OS-native TLS success from Node runtime trust,
  tests system trust before a minimal OS-root fallback, and persists only a
  candidate that verifies; `aih certs` also propagates GUI-safe Node trust on
  Windows and macOS. (#512)

## [3.0.0] - 2026-07-23

### Added

- **Framework binding for Claude (v1).** `aih` binds a pinned upstream AI framework
  into a project's Claude Code host, project-scoped, running a fast-scan safety gate
  (D12) before any upstream code executes. The v1 catalog is ECC (Lean default / Full
  opt-in) and Superpowers; each binds through its own adapter into per-project
  `enabledPlugins` with no machine-scope writes, and a typed lock plus Framework Card
  records the exact installed surface. Committed binding schema, adapter contract, and
  fast-scan gate. (#480, #481)
- ECC and Superpowers framework adapters. ECC installs via its upstream installer
  pinned at `samartomar/ECC@16563d4a` with exclusivity-checked Lean and Full modes;
  Superpowers binds as a host plugin pinned at `obra/superpowers`. Each round-trips
  bind → verify → remove to a clean tree and preserves unrelated and user-modified
  content on removal (D18 ownership). (#482)
- SRI-verified npm tarball acquisition for the fast-scan gate: framework sources
  resolved from npm are integrity-checked against the lockfile digest before the gate
  reads them. (#490)
- Binding doctor, a typed Framework Card, and D12 scan-cache tiers. The doctor probes
  contamination and leakage, host tuple, settings and hook-chain drift, MCP inventory,
  and context cost; the card is derived from the observed surface; the scan cache is
  keyed on digest + profile + adapter + host tuple, and an off-tuple host never
  satisfies a cached qualification. (#492)
- Framework Value Gate. Each supported framework's measured benefit — capability and
  governance surface deltas plus a characteristic-workflow signal — is scored against
  a no-framework baseline, failing closed to `INCOMPLETE_MEASUREMENT` when a required
  input is missing. (#494)

### Removed

- **Breaking:** `aih bootstrap-ai --baseline gsd` is removed, and GSD leaves the
  framework and baseline sets: a `gsd-core` binding declaration and a persisted
  `baseline: "gsd"` marker both fail closed with the existing unknown-baseline
  errors, and the committed `aih-config.schema.json` no longer admits the value.
  Migrate to `--baseline ecc` (the sole selectable canon baseline, bundling ECC and
  Superpowers). (#491)
- **Breaking:** `aih bootstrap-ai --baseline gstack` is removed and the gstack
  adapter is no longer surfaced from the CLI: new gstack binds refuse with a typed
  error citing the scope decision, and a persisted `baseline: "gstack"` marker fails
  closed. The adapter and its contract remain in-tree (verify/remove/report stay
  functional for an existing bind); re-entry is a future release's decision. (#493)

### Changed

- The binding fast-scan gate is closure-aware and selected-profile driven, evaluating
  each framework against calibrated Unicode and typography acceptance instead of a
  hardcoded catalog. (#487)

### Fixed

- The binding contamination report no longer counts a contentless immediate
  `~/.claude/skills/` subdirectory — such as the host-CLI-scaffolded empty
  `skills/learned` — as machine-scope skill leakage; a subdirectory with any content
  still counts, and the `~/.claude/ecc/*` machine roots keep bare-directory counting.
  (#495)
- The binding contamination report scans current-layout ECC machine roots. (#483)
- A first `aih init --apply` now synthesizes the repo contract from the planned MCP
  surface: the contract phase composes after mcp and reads the staged `.mcp.json`
  server names, so `project.json` / `project.md` no longer report "no servers
  detected" in the same run that writes those servers. A second apply stays
  byte-identical.
- Generated canon consistency: the compact RULE_ROUTER renders the "External action
  boundary" section its adapters cite; the shared block and the agent behavior core
  render identical secrets invariants from one source; the `.env*` rule states the
  `.env.example` / `.env.sample` exception the secrets enforcement already grants;
  the empty-state Testing line routes through `aih contract` / `aih bootstrap-ai`
  instead of inviting a hand edit in a regenerated file; the AGENTS.md reader list
  derives from the CLI registry (adding Kiro alongside Kimi); the Cursor stack
  rule's empty state no longer renders "Use No test/…".
- `setup.md` first-run guidance is executable on a fresh clone: it names the
  `pre-commit` install step beside the hook that fails closed without it, and the
  dependency-install fallback follows the detected language instead of assuming
  Node package managers.
- The scaffolded `SETUP-TASKS.md` playbook now matches the canon's advisory graph
  posture: when `large-repo graph safety` fails it tells the agent to warn once and
  continue with bounded reconnaissance — code-review-graph is advisory, not a gate;
  repair it only when helper repair is the assigned task — instead of ordering a
  stop until the graph is repaired and populated.
- The `large-repo graph safety` doctor probe and the `scale.code-review-graph-missing`
  support finding carry that same advisory posture instead of ordering a stop until
  `aih doctor` verifies a populated graph: warn once and continue with bounded rg/fd
  reconnaissance; repair the graph only when helper repair is the assigned task. The
  finding's severity drops from blocking to degraded, the probe still reports `fail`
  so `aih doctor` and the report digest keep surfacing the missing helper, and the
  `aih tools` docs now describe the advisory posture instead of a fail-closed
  prerequisite.

## [2.11.0] - 2026-07-15

### Added

- Baseline vet progress now reports a bounded elapsed duration for every detector terminal outcome
  without putting volatile timing data into analyzer receipts or baseline evidence. (#467)
- `aih policy project --apply` projects the committed `aih-org-policy.json` into
  its generated managed settings without running the full `aih init` sequence.
  Managed-only MCP projection also records its existing ownership provenance so
  AIH can later remove only the exact settings it owns. It refuses an
  `AIH_ORG_POLICY` override for configuration writes, preserving the existing
  trusted mutation boundary.
- Repository-local AI tooling now provides isolated, on-demand Token Savior and
  code-review-graph wiring with documented routing and no shared global tool state. (#454)

### Security

- Release preflight now preserves exact Git record bytes, treats GitHub pull-request
  metadata as untrusted until its shape and identity match the commit reference, and
  marks bounded child-process output as incomplete instead of accepting partial evidence. (#465)

### Fixed

- Codex ECC preflight now recognizes the pinned helper's current `chrome-devtools` default instead
  of treating retired Context7 defaults as planned global writes. Existing conflicting Context7
  settings remain fail-closed. (#466)
- GitHub trust-source fetches now reject redirects that leave the canonical HTTPS GitHub fetch
  endpoints, carry credentials or custom ports, or exceed three hops before any redirected
  connection is made.
- `aih doctor` now accepts a populated `code-review-graph` binary for a workspace child when that
  child has no valid generated workspace graph MCP alias. Generated aliases remain the preferred
  exact, offline verification path; empty or failing graph status still does not satisfy graph safety.
- Enterprise MCP policy now records provenance for the Claude managed allowlist,
  removes it only when its exact AIH-generated values remain on disk, and preserves
  operator-owned settings. Active managed-only policy consistently filters generated
  MCP registrations for primary clients, workspace graphs, and ECC; an untrusted
  `AIH_ORG_POLICY` override cannot drive an enterprise apply. Empty non-matching
  allowlists now explain why no generated server was written.
- `aih mcp --apply` and `aih mcp approve --apply` now refuse generated configuration or policy
  writes when the target was created, deleted, or changed after planning, preserving the operator's
  current JSON, TOML, or policy configuration until they re-run the command.
- Codex now receives the repository-scoped code-review-graph MCP entry, and Token Savior
  excludes its own local cache from indexing. (#455, #456)
- MCP resolver pin evidence is normalized consistently across generated catalog, hygiene,
  baseline attestation, trust classification, and workspace graph checks. (#462)
- Native trust scanning now indexes line locations once and caches full-line digests for oversized
  untrusted lines, preventing quadratic many-finding scans while preserving ordinary fingerprints
  and destination-sensitive danger finding identity. (#448)
- The baseline `vet-once` CI job now resolves Cisco AI Defense from a committed, hash-pinned uv
  lock, runs that exact environment offline from each skill directory, and uploads the freshly
  generated evidence candidate before failing on drift. Analyzer receipts bind to the uv lock so
  a transitive dependency change cannot reuse evidence from a different scanner environment.
  (#449)

## [2.10.0] - 2026-07-12

### Added

- Baseline vet (`baseline:vet`/`baseline:check`) now defaults to incremental reuse, splicing a
  component's prior receipt into the new lock verbatim when its content and every required
  analyzer identity are unchanged, and fully rescanning anything else with all fail-closed paths
  preserved. The `aih-native` analyzer identity is now a content-bound digest instead of the
  package version, so an in-repo detector change invalidates reuse across a version bump that
  touches no detector; `--full` remains an explicit escape hatch that disables reuse outright.
  (#450)

### Changed

- Trust-detector precision: a conservative negation check now recognizes negated protective
  guardrails (e.g. "do not ... leak credentials") as true negatives instead of flagging them as
  `trust.prompt-injection`, with genuine exfiltration detection unchanged and no vendor text
  modified. Cisco's missing-license metadata finding moves from the blocking `trust.cisco-finding`
  bucket to a new acknowledgeable origin-class code: advisory at vibe/team, acknowledgeable (not
  silently passing) at enterprise. (#447)

### Fixed

- CI now provisions the SkillSpector scanner image via a content-addressed GHCR pull-by-digest
  instead of rebuilding it every run, verifying the binding via `RepoDigests` so the check holds
  under any Docker image store instead of requiring the containerd snapshotter; this removes the
  job's daemon.json/store mutation entirely. (#445)
- The installable release gate (`check:baseline-installable`) now iterates every baseline catalog
  instead of a hardcoded `ecc` catalog, so Superpowers is evaluated and gated alongside ECC even
  though it has no installer runtime of its own. (#446)

## [2.9.0] - 2026-07-12

### Added

- Long trust scans now report bounded progress on stderr while preserving clean JSON stdout, reuse
  one path-only inventory, and remove command-owned quarantines on every exit unless
  `trust scan --keep-quarantine` is explicit. Remote ECC dry-runs now render a deterministic,
  pin-bound selected-component install preview marked contingent on evidence authorization. (#432)
- Upward release-intent escalation now requires an authorized GitHub comment on the release
  tracker containing the exact SHA/declared-intent/computed-bump token. Preflight validates and
  records the immutable comment ID and URL, author authority, and timestamp in the cut manifest;
  this creates public attributable evidence while explicitly remaining vulnerable to a fully
  credentialed runner posting the comment itself. (#431)

### Changed

- ECC baseline evidence now follows the pinned `full` install profile's 23 canonical English
  modules instead of signing nine unselected `docs-*` locale modules merely because they exist
  in the vendor snapshot. Every supported component retains the complete native,
  SkillSpector, and applicable Cisco analyzer requirements; adding a locale later requires an
  explicit install-and-evidence capability. (#437)
- ECC baseline evidence now applies per component: authorized components install while held
  components are reported with their evidence codes and reasons. The target ledger records only
  the installed surface, and the installer runtime itself must be authorized before execution.
  (#429)
- Trust detectors now allow decorative emoji, arrows, and box drawing only on reviewable
  documentation surfaces, suppress narrow agent-role false positives there, and use full-strength
  content-bound finding fingerprints whose identity does not depend on display line numbers. (#428)
- Sandbox-smoke unavailability is now recorded as an environment `skip` at every posture instead
  of blocking acquired content; an actual failed smoke run on a capable host remains blocking.
  (#427)
- Legal-text detector findings now warn-pass only at vibe posture; team and enterprise require an
  exact fingerprint acknowledgement with a recorded reason, while danger-class findings remain
  non-acknowledgeable. (#426)

### Fixed

- `aih prune` now coordinates aih-owned ECC removals, unavoidable upstream target uninstalls,
  target-state updates, and the registration ledger in one phased ledger-last driver. Failures
  and supported interrupts roll back aih-owned changes; upstream uninstalls that may already have
  mutated emit explicit evidence for every affected target and path without advancing the ledger.
  Dropped Codex cleanup also remains compatible with pre-ledger target state. (#430)
- The shipped default ECC baseline is now gated as installable at every posture from its own
  signed evidence. A new `check:baseline-installable` release gate (wired into `verify`, the CI
  matrix on all three OS, and the release workflow before packaging) proves the pinned vendor lock
  installs at least one component at vibe, team, and enterprise into throwaway fixture HOMEs while
  holding blocked auto-exec components, and rejects any install path that escapes the fixture. (#425)
- Release-shipped baseline evidence now requires exact `aih-native` and reproducibly built
  SkillSpector receipts for every component, plus pinned offline Cisco receipts for every
  skill-bearing component. Generation preserves valid finding-bearing SkillSpector SARIF,
  rejects missing or malformed analyzer runs transactionally, and release verification refuses
  stale or partial receipt profiles before packaging. A fast offline preflight now reports an
  unprovisioned required analyzer up front instead of aborting mid-vet. (#437)
- `npm run release:preflight` now resolves a commit's issue reference to its closing merged PR
  through GitHub timeline evidence (the issue's CLOSED_EVENT closer), so a cut whose commit subject
  cites an issue instead of a PR number is swept correctly rather than aborting the sweep. (#441)

### Docs

- Recorded the v2.9 field-findings design and execution notes covering the trust, release, and
  ECC-baseline hardening delivered in this release. (#433)

## [2.8.0] - 2026-07-10

### Added

- Generic detector findings anchored in regular, non-executable `LICENSE*`, `COPYING*`, or
  `NOTICE*` files are now fingerprint-bound reviewable trust-origin findings. `aih skill vet`
  accepts exact acknowledgements with a required reason, while known danger rules and findings on
  instruction, config, script, executable, or source-code surfaces remain blocking. (#398)
- `npm run release:preflight -- --intent <patch|minor|major>` now compares declared cut scope with
  the label-derived bump. Upward escalation blocks before the release PR while still emitting the
  manifest; an explicit acknowledgement token binds candidate SHA, declared intent, and computed
  bump without changing the computed version. (#382)
- `aih prune` now reconciles the scoped ECC registration ledger: missing project roots retire from
  the additive union, only unshared aih-managed component/MCP operations are removed, user-owned
  and still-required content is preserved, and target state plus the primary ledger commit in one
  hash-bound rollback-safe transaction with the ledger last. (#409)
- `aih ecc` now registers a scoped component surface by default: the locked common baseline,
  detected or repeatably declared (`--with`) stack riders, posture-selected security, and the
  validated MCP set. Successful installs update an additive per-project/target ledger under
  `~/.aih/ecc/`; `--profile full` remains the explicit full-surface opt-in. (#408)
- Two-tier per-component baseline evidence now gates ECC and Superpowers setup:
  release-shipped vendor evidence verifies exact-pin hashes, org-signed overrides
  admit reviewed newer or net-new components without weakening danger-class floors,
  and `aih evidence vet-baseline` generates analyzer-backed lock entries. (#407)

## [2.7.0] - 2026-07-10

### Changed

- Large-repository agent canon now treats `code-review-graph` as a fail-closed
  prerequisite: repository work stops when the tool is unavailable, errors, or
  has no populated graph, and resumes only after the graph is repaired and
  verified populated. (#403)

### Fixed

- Stale pre-2.5 narrative shipped in user-facing surfaces: the README overview
  SVG's release journey now tips at the current version (was "2.4 AI-Canonical ·
  shipped"), and README/SECURITY/STABILITY support-policy wording now matches
  VERSIONING.md's latest-minor-only policy (the N-1 backport claim was stale).
  The versioned-surface lock now catches two-segment version tokens (`v2.4`) in
  SVG text and guards the support-policy claim, so this class fails
  `npm run verify` before a tag exists.

## [2.6.0] - 2026-07-10

### Added

- `npm run release:preflight`: machine-checked release sweep emitting a cut
  manifest — validates per-PR `semver:*` labels, milestone-vs-git drift in both
  directions, open blockers, tracker presence, gate-bypassing commits, version
  coherence, and revert-pair cancellation; exits non-zero on any named finding.
  (#397)

### Changed

- Declarations are now emitted by `tsc -p tsconfig.dts.json` instead of tsup's
  vendored `rollup-plugin-dts`; `dist` carries per-module declaration files with
  the public entry unchanged at `dist/index.d.ts`. This unblocks TypeScript 7.
  (#396)
- Toolchain: TypeScript 7.0.2 and Biome 2.5.3 (#392); fast-check 4.9 (#393);
  CodeQL actions bumped as one group so `init`/`analyze` stay version-matched.
  (#391)

## [2.5.1] - 2026-07-10

### Fixed

- `docs/assets` SVGs shipped inside the v2.5.0 tarball still carried v2.4.3
  wording; refreshed, and versioned surfaces (README `aih vX.Y.Z` claims and
  every `docs/assets/*.svg`) are now locked to the package version by a test
  that fails `npm run verify` on drift. (#383)
- Resolved all 22 `lint/correctness/noUnsafeOptionalChaining` test-suite
  findings that blocked the Biome 2.5.3 upgrade. (#387)

### Added

- `semver-label` CI check: every PR must carry exactly one
  `semver:patch|minor|major` label — the release cut computes the version bump
  from the labels on merged PRs. Dependabot PRs are auto-labeled; external
  contributors need no action (a maintainer labels before merge). (#384, #386)
- Property-based fuzz coverage (`fast-check`) for the platform parsers,
  asserting `parsePemBlocks` invariants across generated multi-block
  certificate inputs. (#389)

### Changed

- `RELEASING.md` and `VERSIONING.md` now document the release-train flow:
  releases cut from a rolling `next-release` milestone, the bump computed from
  merged-PR labels, atomic train rollover at cut, SHA-bound publication
  approval, and milestones closed on publish evidence rather than at tag.
  Support policy amended to latest-minor-only until a maintenance lane exists.
  (#381)
- Dependabot now splits the npm toolchain (`@biomejs/biome`, `typescript`,
  `tsup`) into its own update group so a blocked toolchain bump cannot wedge
  routine updates, and groups the CodeQL actions so `init`/`analyze` always
  move together. (#388, #390)
- Dev dependencies: `@types/node` 26.1.1, `vitest`/`@vitest/coverage-v8`
  4.1.10, `tsx` 4.23.0 (#388); `anthropics/claude-code-action` 1.0.170 (#385).

## [2.5.0] - 2026-07-10

### Fixed

- `aih skill vet --name <skill>` now resolves license evidence from the selected
  skill folder before falling back to source-root evidence, and reports the
  exact selected-artifact path used without applying sibling skill licenses.
  (#373)
- Skill vet and workspace promotion now fail closed when multiple physical skill
  directories resolve to the same promoted skill name or case-insensitive
  promotion path, so selected evidence cannot bind to one implementation while
  promotion installs another. (#373)
- Scoped `aih skill vet --name <skill>` evidence now records selected skill
  names, included paths, and excluded sibling skill paths, and `aih skill
  approve` carries that scope into the committed card and lockfile evidence.
  (#374)
- Trust scan now separates ordinary visible Unicode typography in
  docs/reference files into acknowledgeable `trust.visible-unicode` findings
  while preserving `trust.hidden-unicode` blocking for zero-width, bidi, tag,
  homoglyph-confusable, instruction, config, executable, and source-code
  surfaces. (#375)

## [2.4.3] - 2026-07-09

### Fixed

- `aih init` now projects active org policy into Claude managed settings only
  when Claude is targeted, so doctor-compatible managed-settings regeneration
  works without creating Claude state in Kiro/Cursor/Codex-only repos. (#360)
- Local `gh attestation sign` failures now report GitHub Actions OIDC guidance
  instead of treating unsupported local GitHub CLI signing as an unexplained
  signature failure, and signer stderr/stdout is redacted before report output.
  (#361)
- Org-policy sources are JSON-only: JavaScript/module-shaped policy files fail
  closed with explicit guidance instead of being treated as a supported policy
  generation format. (#362)
- `aih heal --scope mcp` now inventories derived MCP HTTPS origins and emits
  enterprise TLS-interception diagnostics for Node/Python MCP servers; live
  endpoint handshakes and CA-bundle comparisons require explicit
  `--probe-mcp-endpoints` and run as verification probes rather than during
  plan construction. (#363)

## [2.4.2] - 2026-07-08

### Changed

- `aih skill vet --name <skill>` now writes per-skill evidence for multi-skill
  sources, and `skill card --name` / `skill approve --name` require that matching
  scoped evidence instead of a source-wide report. (#349)
- `aih trust skillspector-pin --approve-local-digest` now records reviewed local
  SkillSpector image digests in org policy, and trust scans accept only the
  built-in controlled digest or those reviewed policy digests. (#350)
- Enterprise MCP docs now spell out the required hand-authored
  `mcp.approvals[]` fields, including subject-bound approval and ISO-8601
  `approvedAt`, plus the `AIH_ORG_POLICY` distributed-policy edit path. (#351)
- Setup and heal guidance now covers npm major-version upgrades, reviewed
  `--force` use for broken global installs, common `uvx` PATH locations, and
  pinned `uvx` MCP cache warmup before offline startup. (#352)

## [2.4.1] - 2026-07-08

### Changed

- Added internal v2.4.1 release gates for AI/MCP runtime inventory, BUGBOUNTY
  report summaries, and non-mutating nightly safety evidence. (#340, #342,
  #345, #347)
- PRs now carry explicit milestone, BB row/theme grouping, code-review-graph
  evidence, and ECC specialized internal review evidence before high-risk release
  work can be considered merge-ready. (#346)
- Added a public-safe BUGBOUNTY v2.4.1 release report grouping the 134 fixed
  findings by BB row and release theme. (#343)
- Added the first-party `review-quality` pack with the `bugbounty-pr-scan`
  skill so generated ECC, agent, skill, MCP, workflow, Codex, Claude, and
  BUGBOUNTY runbook artifacts have a reusable PR scan lane. (#344, #346)
- `aih docs-lint` now scans the published `guides/` Markdown surface and treats
  guide updates as docs-ledger coverage for feature-source changes.
- `aih secrets --verify` documentation now scopes the gate to posture: plaintext
  secret findings are warning-only at `vibe` and non-zero at `team`/`enterprise`.
- `aih guardrails` command policy no longer allows broad shell readers or
  `python -c *` by default; those commands require approval, with explicit
  secret-path Bash deny patterns.
- Generated guardrail CI now verifies the pinned gitleaks release tarball
  checksum before extraction.
- `aih mcp` now replaces generated same-name JSON server entries so stale
  credential fields do not survive regeneration, warns when first-run target
  detection selects global MCP config files, hardens the AWS `uvx` MCP launcher
  with the no-fetch/no-env flags used by other local Python MCP servers, and
  scopes `--mcp-compliant` docs/help to omitted generated entries.
- `aih doctor`, `aih heal`, and `aih secrets --verify` now close MCP gaps:
  malformed managed MCP policy/config fails closed, managed allowlist drift is
  compared against org-policy narrowing, heal parses `.mcp.json` server commands
  instead of raw text, and known global MCP config files are scanned for redacted
  hardcoded credential findings.
- MCP third-party egress approvals are now bound to a subject fingerprint over
  the current server shape and risk axes; stale name-only approvals no longer
  downgrade enterprise denials.

## [2.4.0] - 2026-07-07

### Added

- `aih docs-lint` now enforces the public claim ledger: claim markers must map to
  stable `CM-xx` control-matrix rows, each row must cite existing named tests,
  and changed feature files with no docs or matrix update are reported as drift
  while prose guidance remains advisory. (#325)
- `aih init --sidecar`, `aih truth pack`, and `aih truth verify` now ship Phase A
  project-truth sidecars: the sidecar records a commit binding, stages token-bounded
  packs outside the repo, detects commit/version/claim/decision drift, fails closed
  on invalid assertions, and lets evidence bundles include only verified hashed
  truth-pack artifacts. (#326)
- `aih truth verify` now runs acceptance-satisfiability preflight assertions and
  harness-rerun agent evidence: absent local requirements emit `blocked:environment`,
  vendor-specific requirements in vendor-neutral work emit `blocked:vendor-specific`,
  and stale file evidence claims fail closed instead of relying on prose. (#327)
- The v2.4.0 docs currency pass now uses the BetterDoc skill, refreshes the README
  image metadata, brings the README command surface back in line with command docs,
  includes the README image assets in the npm package, and updates the overview
  SVG from release-candidate copy to shipped v2.4.0 wording. (#328)
- The language coverage matrix now grades the Node + Python + Rust polyglot
  fixture's framework coverage as good, reflecting the existing per-workspace
  command routing for secondary Python/Rust workspaces. (#263)
- Go, Maven, and .NET profile detection now covers framework, DB, lint, package
  manager, and workspace or solution signals in the language coverage fixtures,
  with matching setup restore/install hints. (#264)
- Rust Cargo profiles now emit `cargo fmt --check` as a format command alongside
  `cargo clippy`, and the language coverage matrix tracks that rustfmt signal.
  (#265)
- CLI loadability now embeds a router canary, tracks per-tool dry-run probe
  support, and treats non-probeable tools as manual/unverified instead of
  counting structural wiring as runtime proof. (#266)
- The trust gate now documents its widened deep-scan detector ladder beyond
  SkillSpector/Cisco, including Semgrep, Snyk Agent Scan, AgentShield, and their
  vet evidence availability records. (#268)
- The reserved `@aihq/enterprise` extension point now has a shipped capability
  spec plus probe-contract coverage for literal-name resolution and local-only
  fallback behavior. (#269)
- Tagged release artifacts now carry a documented SLSA v1.2 Build L2 claim,
  with the supporting release-workflow evidence and the remaining Build L3 gap
  recorded in the security docs. (#270)
- Deferred analytics Tier 2 and Tier 3 now have a design note that scopes the
  aggregate-first shared collector, preserves the no-remote-call D2 invariant,
  and records hosted-SaaS trigger conditions. (#271)
- The locked-skills MCP server now has a recorded framework/language decision:
  pinned Python FastMCP 3.x with `SkillsDirectoryProvider`, plus official-SDK
  alternatives and security-surface constraints. (#274)
- The trust gate now recognizes skills-over-MCP shapes (`SkillsProvider` /
  `skill://`), records FastMCP version, egress, and `_manifest` SHA-256 evidence,
  and treats hot reload as supply-chain drift like `@latest`. (#275)
- The FastMCP 3.x vs official `mcp` SDK comparison for skills-over-MCP is now
  captured as a design note, including the conclusion that framework choice is
  orthogonal to the governance gap. (#276)
- `aih certs` now documents its corporate-trust propagation for git, Go, JVM
  tools, Gradle, and Maven alongside Docker daemon guidance and the existing
  npm, pip, cargo, and conda coverage. (#267)
- `aih docs-lint` now runs the BetterDoc slop-lint phrase and claim guidance as
  a native read-only CLI check with coded findings for blocked documentation
  prose and missing rules. (#262)
- `aih pack scaffold --pack <name> --apply` now seeds bundled first-party packs
  into an external repo's `packs/` tree and `aih-packs.json` without inventing
  approvals; the npm package now includes `packs/` and `aih-packs.json` so the
  scaffold has local source bytes to copy. (#261)
- Pack governance docs now consistently describe the shipped `aih-packs.json` /
  `--pack <name>` curation model and mark the earlier built-in pack catalog as a
  historical proposal rather than current command behavior. (#260)
- `aih workspace init --recursive --apply` and
  `aih workspace report --refresh-children --apply` now provide explicit
  child-write opt-ins for workspace onboarding and child report refreshes, while
  default workspace runs remain parent-only. (#259)
- `aih workspace link <path>` now registers child repos and parent-owned contract
  edges in `.aih-workspace.json`, regenerating workspace router/contracts docs
  without writing child repo files. (#258)
- `aih usage --apply` now chains `aih track --apply` into the universal post-commit
  hook, so `.aih/history.jsonl` accrues one deduped trend sample per commit outside
  Kiro's agent-stop hook as well. The hook installs into the active repo-local Git
  hooks path and emits chain guidance instead of writing to external/global
  `core.hooksPath` targets. (#254)
- `aih mcp` now targets OpenCode's global `~/.config/opencode/opencode.json` MCP map, preserves
  existing provider/model settings while merging, flags missing env placeholders and placeholder
  remote hosts before writing, disables unsafe generated OpenCode entries with `enabled:false`, and
  surfaces npm MCP package version-pin drift under `--verify`. (#279)

## [2.1.0] - 2026-07-07

### Added

- **Local usage sink for cache and skill report panels**: `.aih/usage.jsonl`
  now has an optional deterministic token/cache counter shape, `aggregateUsage`
  rolls it up, and `aih report` renders the local cache/skill economy live when
  samples exist while keeping empty stubs pointed at `aih report --org`. (#249)
- **Per-tool usage capture hooks**: `aih usage --apply` now emits working
  recorder hooks for the remaining hook-capable CLIs, maps their real hook
  payload shapes into `.aih/usage.jsonl`, and keeps v9 usage-by-CLI / heavy
  lifter panels live only when local samples exist. (#250)
- **Zed usage capture**: `aih usage --apply --cli zed` can import local
  `threads.db` samples into `.aih/usage.jsonl`, mapping cumulative/request token
  counters plus derivable skill/MCP/tool attribution while keeping report panels
  live only from matching local repo rows. (#251)
- **Claude skill attribution**: Claude `Skill` hook payloads now map exposed
  skill names into named skill usage rows, infer ECC provenance from installed
  ECC skill paths, and keep unnamed Skill/Task/Agent calls as generic tool
  activity instead of fake skill invocations. (#252)
- **Stack-scoped dormant skills**: v9 dormant ECC skill candidates now use the
  detected ECC stack packs to filter unrelated installed skills before
  subtracting fired skill rows, reducing noisy trim candidates. (#253)
- **As-built design docs**: added the missing docs for public positioning,
  workspace report rollups, workspace contracts/snapshots, skill card schema,
  approved skills lockfile, and external skill packs, and indexed them from
  `docs/README.md`. (#272)
- **ECC installer resolution**: `aih ecc` now invokes ECC through
  `ecc-universal`'s `ecc-install` bin instead of the nonexistent `ecc-install`
  package, checks that npm metadata in CI, routes Codex through ECC's manifest
  file install plus safe add-only shared-file merges instead of the upstream
  copy target, blocks Codex MCP transport collisions before install, and lets
  `aih prune` call ECC's install-state uninstall for dropped ECC-supported
  targets while subtracting `aih`'s recorded Codex TOML footprint and fenced
  AGENTS merge block. (#283)
- **Approved skill machine sync**: `aih skill sync --name <skill> --cli claude,codex`
  now previews or applies approved promoted skill files into the selected CLI
  machine discovery roots (`~/.claude/skills`, `~/.codex/skills`), and
  `skill inventory` scans both machine roots. (#282)
- **README governance and safety wording**: the README now explains enterprise
  packs using the shipped `aih-packs.json` / `--pack <name>` model, states that
  draft pack names are org-curated patterns rather than shipped built-ins, adds
  the pinned-commit trust verdict safety disclaimer, and describes `aih workspace`
  as a federated bridge rather than a monorepo replacement. (#273)

### Changed

- **Posture parsing**: explicit `community` posture values now fail closed with
  the existing invalid-posture error instead of silently downgrading to `vibe`;
  absent posture values still default to `vibe`. (#280)
- **Config baseline parsing**: a present invalid `.aih-config.json` `baseline`
  now fails closed instead of being discarded, and posture resolution refuses to
  continue when the persisted baseline is malformed. (#281)

## [2.0.0] - 2026-07-05

This package release ships the completed v1.3.1, v1.4.0, v1.5.0,
v1.6.0, and v2.0.0 roadmap milestones together. The milestone labels remain on
their GitHub issues; the npm artifact advances directly from 1.3.0 to 2.0.0
because the completed work landed as one verified mainline release train.

### Added

- **Executor structured verification sidecar**: `executePlan(..., { verify: true })`
  now returns an additive structured verification pipeline run alongside the
  legacy `VerificationReport`, preserving the existing report shape while
  exposing per-pass structured results and evidence graph data for both legacy
  and structured probes. (#228)
- **Executor structured probe seam**: `plan()` can now emit structured
  verification probe runs on the existing `probe` action kind, with the executor
  adapting them through the legacy report bridge. `session-guard` now uses this
  seam while preserving CLI output and exit-code behavior. (#226)
- **Report advisory structured bridge integration**: `aih report` now models
  budget, adoption, and contract-truth advisories as structured verification
  results before adapting them back to legacy coded checks, preserving existing
  report exit-code and support-template behavior. (#224)
- **Structured verification compatibility bridge**: new exported helpers convert
  structured verification results and pipeline runs into the legacy
  `VerificationReport`/probe contract, preserving legacy exit-code behavior while
  EPIC 7 cleanup migrates callers onto the structured pipeline. (#222)
- **Structured verification pipeline core**: new programmatic
  `src/verification` substrate for typed pass results, deterministic merge
  summaries, evidence aggregation, ordered pass selection, and duplicate-safe pass
  registration. This is the Wave 1 / EPIC 0 foundation for parallel verification
  and evidence graph work. (#210)
- **Parallel verification runner, pass catalog, and context budgeting**: structured
  verification can now run bounded pass sets with deterministic merge/evidence
  graph output, built-in exec-locality/policy/security/dependency/doc passes, and
  lazy canon loading that respects context budgets and secret/path exclusions.
  (#212, #214, #216)
- **Capability resolve/cache substrate**: new `aih capability resolve` and
  `aih capability prune` commands emit evidence-backed capability decisions,
  persist committed repo intent in `aih-capabilities.json`, and maintain a
  rebuildable `$HOME/.aih/capabilities/cache.json` machine cache. Resolve stays
  offline and delegates content by reference; posture changes the decision mode
  (`vibe` auto-add, `team` warn, `Enterprise` approval-required) without adding
  a second authority. (#205)
- **Init v3 bootstrap intelligence**: `aih init --v3` now appends a structured
  repo scan, gap analysis, evidence-backed capability install plan, and derived
  `.aih/fingerprint.json` to the existing init flow. Under `--apply`, root
  committed intent remains the source of truth while `.aih/` and `~/.aih/` stay
  rebuildable derived state. (#218)
- **Session guardrails**: new read-only `aih session-guard --text <text>` plus
  exported session guardrail APIs run bounded, offline checks for secret-like
  session text and dangerous local actions without echoing detected values. (#220)
- **Enterprise baseline attestation in `aih doctor`**: at Enterprise posture, `doctor`
  now compares MCP servers and packaged marketplace skills against the declared
  registry in `aih-org-policy.json`, emitting coded `baseline.*` findings for
  undeclared external capability residue or invalid/missing registry inputs. MCP
  matches are bound to the generated catalog's command/args/env or URL/headers
  shape across known repo-scoped config files, and marketplace sources must carry
  a pinned commit that matches the packaged artifact. (#189)
- **Workspace manifest child source metadata**: object-form `.aih-workspace.json`
  repos may now carry optional `remote` and `ref` fields for future hydrate/source
  reconstruction. The parser validates them as safe printable strings and existing
  object entries round-trip without flattening to bare path strings. (#180)
- **Workspace snapshot child remotes**: `aih workspace snapshot --lock --apply` now records
  each child repo's local origin URL when available, preserving fetch location in
  `workspace-lock.json` without consulting ambient Git config or touching remotes. (#181)
- **Workspace reconstruction and lifecycle hardening**: workspace bootloader
  targeting, hydrate from committed locks, nested-repo safety, absolute child path
  reporting, child graph coverage, posture-transitive verification, and
  uninstall/footprint removal now cover the main workspace lifecycle without
  treating generated state as authority. (#177, #182, #183, #184, #185, #186, #188)
- **Selectable canon baseline**: repo canon bootstrapping can select pinned
  baseline sources instead of hardcoding one framework, preserving delegate-don't-
  vendor while making framework neutrality explicit. (#191)
- **MCP approval on-ramp**: org policy can now combine `mcp.allowedServers` with
  `mcp.approvals[]` reviewer evidence so vetted third-party MCP servers warn
  instead of deny under Enterprise posture. `aih mcp approve <server>
  --accept-egress --reason <text> --apply` writes the repo-local approval entry while
  `AIH_ORG_POLICY` remains the winning policy source. (#178)
- **Enterprise-compliant MCP apply**: `aih mcp --posture enterprise
  --mcp-compliant --apply` now writes only policy-approved generated MCP servers,
  quarantines denied generated entries with reasons, and pairs with
  `--mcp-compliant --verify` to fail if exact generated denied entries still remain
  in targeted client configs. Egress approvals in `mcp.allowedServers` no longer
  narrow the managed stdio command allowlist unless `mcp.allowManagedOnly` is set.
  (#187)

### Changed

- **Paired structured verification coverage**: `skill vet`, `trust allow`/`pin`/
  `verify`, `doctor`, and `workspace add` phase-2 promotion now route their
  remaining gate checks through paired structured probes on the existing `probe`
  action kind, preserving legacy report order/count/verdict/detail behavior while
  adding structured sidecar results for the new verification pipeline. (#234,
  #236, #238, #240)
- **Trust scan paired structured probes**: `trust scan` now routes static and
  fetched-source verification checks through paired structured probes on the
  existing `probe` action kind, preserving one-to-one legacy report checks while
  adding structured sidecar results without double-running the scan. (#232)
- **Executor structured-first verification cleanup**: executor verification now
  collects structured entries first and adapts the legacy `VerificationReport`
  from that shared pass data, preserving legacy coded checks, locations, and
  fingerprints while adding file-backed evidence to the structured sidecar. (#230)

### Fixed

- **Enterprise MCP policy for GitHub**: org policy can now declare incumbent MCP
  hosts, configure a GitHub/GHES MCP origin, or disable the hosted GitHub server.
  Under enterprise posture, a committed org policy that does not declare the
  GitHub host incumbent no longer lets hosted GitHub auto-pass as
  `vendor-incumbent`; the verify remediation names set-host/self-host/disable
  paths. (#190)
- **Hosted GitHub MCP auth**: `aih mcp --github-auth token` now keeps the hosted
  GitHub endpoint but emits `credentials:"token"` plus an `Authorization` header
  sourced from `${GITHUB_PERSONAL_ACCESS_TOKEN}`, giving non-DCR MCP clients a
  Docker-optional path without writing token values into config. Token mode
  ignores ambient `GITHUB_HOST`; non-default endpoints must come from committed
  incumbent org policy. (#179)
- **v1.3.1 UX polish**: `bootstrap-ai`/`adopt` now report managed bootloader
  convergence as `merge` instead of `overwrite`, read-only `doctor`/`status`/
  `verify-bundle`/`verify-release` accept and validate `--posture` while ignoring
  it as a read-only posture source, strict `--cli` whitespace mistakes hint at
  comma-separated lists, and `prune` warns when shared selection flags are ignored
  because it diffs committed intent only. (#173, #174, #175, #176)

## [1.3.0] - 2026-07-04

### Added

- **`docs-quality` pack (BetterDoc)**: the first first-party pack — a claim-first,
  evidence-grounded documentation skill shipped in-repo at
  `packs/docs-quality/betterdoc/` and installable via `aih pack install --pack
  docs-quality --apply`. Documented in
  [docs/product/docs-quality-pack.md](https://github.com/samartomar/ai-harness/blob/main/docs/product/docs-quality-pack.md). (#166)
- **CONTROL_MATRIX.md** maps public claims to implementation seams and regression
  tests, including posture grading and offline/no-default-phone-home boundaries.
  (#160)
- **Canonical command-spec registry proof** now enumerates grouped subcommands and
  uses that registry in plan-purity and apply-time exec-locality tests. (#161)
- **Evidence bundle harness provenance block** records aih version/release refs,
  package name, checksum/signature asset references, npm provenance status, and the
  verification command in `evidence.json`. (#162)
- **`aih policy verify --against <sha256|bundle>`** verifies the active org policy
  against a pinned hash, policy-bundle envelope, or fleet-bundle policy copy. (#163)

### Changed

- **First-party trust tier**: `aih skill vet` now grades a **first-party** source
  (a local path under the repo root) on aih-native coverage — an *unavailable* deep
  detector (SkillSpector/Cisco) no longer forces UNKNOWN for a repo-relative path,
  so first-party skills are approvable without Docker. Remote and out-of-repo
  sources are unchanged, and native RED plus shape/license rules still apply. (#166)
- **Repo agent canon** now loads rule files on demand through a small dispatch map
  and adds a tracking/done rule so issue linkage, milestone hygiene, and docs updates
  are part of the repo's completion contract. (#170)

### Security

- Evidence and fleet-bundle signatures can now be required with
  `--require-signature`; enterprise evidence builds fail closed on missing or
  failed signing with coded `bundle.signature` findings. (#162)
- `aih doctor` and `aih report` surface active org-policy source, `AIH_ORG_POLICY`
  overrides, and local HEAD drift as policy-integrity signals. (#163)

## [1.2.1] - 2026-07-03

### Fixed

- Preserve object-form workspace manifest repos when re-running
  `aih workspace --repos ... --apply`, avoiding object/string repo duplication
  that could leave the manifest fail-closed on the next run.
- Reject inline Markdown/HTML control syntax in workspace manifest printable
  fields before those values reach generated reports and docs.
- Reject sparse workspace repo arrays during parallel repo-state fan-out instead
  of returning holes or partial results.

## [1.2.0] - 2026-07-03

This package release ships the completed v1.0.2, v1.1.0, and v1.2.0 roadmap
milestones together. The milestone tags remain on their GitHub issues; the npm
artifact advances directly from 1.0.1 to 1.2.0 because the completed work landed
as one verified mainline release train.

### Added

- **`aih verify-release`** verifies a published aih version across npm registry
  signatures, GitHub Release checksums, the cosign bundle over `SHA256SUMS.txt`,
  and the release tarball hash. It resolves the version once per plan so every
  probe grades the same artifact. (#151)
- **Generated JSON Schemas** for `.aih-config.json` and `aih-org-policy.json`,
  plus the SchemaStore submission path for editor/catalog integration. (#152)
- **Run-ledger schemaVersion 2** adds host and repo identity fields, with a SIEM
  collector recipe for enterprise ingestion. (#153)
- **mcp-scanner detector support** for the `.mcp.json` layer, gated behind
  explicit onboarding so teams can opt into the Cisco scanner follow-on without
  surprise egress or credentials exposure. (#154)
- **Enterprise review pack**: architecture, threat model, and enterprise
  onboarding docs for security and platform reviewers. (#146)
- **codebase-memory-mcp catalog wiring** in the always-on MCP/tooling surface.
  (#150)
- **Contract quality gates** now include declared-only `verify` and `typecheck`
  command slots, so generated contracts, setup docs, router guidance, and Kiro
  steering can point agents at the real `npm run verify` completion gate. (#157)
- **Property-based executor and fault-injection coverage** for the executor
  surface. (#155)

### Changed

- Generated contract artifacts now populate CLI entrypoints from `package.json`
  bin/main metadata and render setup/known-gaps guidance from the richer contract
  surface. (#147, #149)
- Report remediation commands are validated against the CLI contract before being
  emitted, reducing the chance that docs or reports tell users to run a stale or
  nonexistent command. (#148)
- Public docs and roadmap notes now reflect shipped release mechanics, command
  references, schema links, and review-gate expectations. (#142)
- Release version coherence now covers `package-lock.json` as well as
  `package.json` and the CLI `VERSION` constant, and RELEASING.md names the
  lockfile update explicitly.

### Security

- Quarantined GitHub fetches honor `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`
  without weakening the fetch boundary, so enterprise proxy networks can acquire
  pinned sources through the same trust gate. (#143)
- Skill-source extraction allows in-tree symlinks only after realpath containment
  checks and continues to reject tree-escaping entries. (#144)
- The SkillSpector detector image is sourced and pinned, with hardened container
  execution and read-only source mounts. (#145)

## [1.0.1] - 2026-07-02

Documentation and presentation only — no code, CLI surface, output, or behavior change
(the 1.0 contract is untouched; the command-surface fixture is unchanged).

### Changed

- **Repositioning**: the product framing moves off "AI-assisted coding behind a corporate
  proxy" — the proxy is one capability (`aih certs` / `aih heal`), not the audience. The
  README, hero image, and package/CLI descriptions now describe **governed AI-assisted
  coding in enterprise environments**, from locked-down TLS-intercepted networks to open
  ones.
- **README restructure**: a **The 1.0 contract** callout leads (pin `^1`; surface
  snapshot-tested in CI; alias-before-removal; N-1 security backports). The single 37-row
  command table becomes five grouped one-line tables; the full per-command reference moves
  verbatim to [docs/commands.md](docs/commands.md). The stale pre-1.0 versioning note is
  corrected, and the supply-chain summary names the signed release assets
  (`SHA256SUMS.txt.sigstore.json`, provenance bundle).
- **Hero image**: refreshed for 1.0 — a stable-contract badge and a "road to 1.0" release
  journey (0.2 → 1.0).

## [1.0.0] - 2026-07-02

The **stability** release: the CLI / JSON / SARIF output contract is now FROZEN and
CI-enforced. An enterprise can pin the major (`@aihq/harness@^1`), consume `--json`
output, SARIF, and exit codes in automation, and trust that no minor or patch release
breaks any of it — every surface change now fails a committed-fixture test until it is
made as a reviewed contract decision. See [STABILITY.md](https://github.com/samartomar/ai-harness/blob/main/STABILITY.md).

### Added

- **Contract snapshot tests** (`tests/contract/`) — the enforcement layer: a committed
  fixture of the FULL command surface (64 command nodes, 837 options, 40 arguments,
  aliases included) walked from the real program, byte-stable across OS/locale; zod
  shape tests for the `--json` envelope (required keys/types enforced, unknown-key
  ADDITIONS stay legal — additive changes remain minors); pinned exit-code semantics
  (0 = clean dry-run / passing verify / skips-never-fail; 1 = failing check, refusal,
  failed exec under `--apply`). Any drift fails CI with the contract procedure in the
  failure message. (#124)
- **Deprecation machinery — alias-before-removal**: `CommandSpec.deprecatedAliases`
  registers a renamed command's old names as aliases of the SAME command (flags can
  never drift), visible in help as `name|alias`; invoking an alias emits one stderr
  warning naming the replacement and runs the identical action (`--json` stdout stays
  clean). Plugin specs cannot carry or squat on aliases (stripped + reserved). Ships
  proven-but-dormant: zero deprecations exist today. (#125)
- **STABILITY.md** — the contract document: covered surfaces (exactly what the
  contract tests enforce), the breaking/minor/patch table, the alias-before-removal
  policy (an alias lives ≥1 minor; only the next major removes it), and the
  enforcement pointers. VERSIONING.md gains the **N-1 security-backport policy**
  (fixes land on the latest and the previous minor of the current major);
  CONTRIBUTING.md documents the fixture-regen procedure. (#125)

### Changed

- Nothing. That is the point: 1.0.0 is 0.6.0's surface, frozen. No command, flag,
  output shape, exit code, or on-disk layout changed.

## [0.6.0] - 2026-07-02

The **marketplace + seams** release: the approved skill set becomes a **reproducible,
verifiable distribution artifact** a team can host anywhere (never a registry or server —
`aih-skills.lock.json` stays the approval authority and `workspace add` stays the consume
channel), plus the three additive seams that keep a future enterprise layer a bolt-on
instead of a fork: a pluggable command registry, a policy-bundle schema, and an
evidence-bundle schema. The signing and code-loading slices each passed two independent
review lenses with every finding fixed before merge; CodeQL contributed a third catch of
its own.

### Added

- **`aih marketplace build`** — package every `aih-skills.lock.json` entry (the
  **approval authority**) into a hostable directory: the exact vetted skill bytes
  (trust-lock hash cross-checked), committed cards, content-addressed vet evidence,
  a strict `marketplace.json` manifest (schemaVersion 1), and `SHA256SUMS`.
  **Approved-only and bytes-exact**: an uninstalled, drifted, ambiguous, or
  card/evidence-less approval refuses the whole build. Byte-identical rebuilds — no
  wall-clock anywhere (`--stamp` is operator-supplied). (#114)
- **`aih marketplace validate`** — the read-only artifact gate: schema, checksums,
  path containment (checked **before** any filesystem access), approved-verdict, sums
  coverage, and a **declared-set rule** (a payload file the manifest never declared is a
  coded failure, not a free rider). Coded `marketplace.*` findings throughout. (#114, #115)
- **`aih marketplace publish`** — provenance for the artifact: sign its `SHA256SUMS`
  with cosign (detached signature) or a GitHub attestation. `--signer` is mandatory and
  closed (a publish without a signer is just a build); a plan-time preflight refuses to
  sign anything that does not validate clean; an **apply-time content pin** refuses to
  sign bytes that changed after the plan was computed. `validate --require-signature`
  turns every unverifiable-signature skip into a coded failure, and both verifier
  families demand identity material (cosign: `--key` or certificate identity + OIDC
  issuer; gh: `--repo`, optional `--signer-workflow`). (#115)
- **Pluggable command registry** — on startup the CLI probes the optional peer
  `@aihq/enterprise` (LITERAL specifier, never configurable; `AIH_NO_PLUGINS=1` kill
  switch) and registers its exported `aihCommands` through the identical path as
  built-ins: shared flags, posture, dirty-worktree gate, run ledger. The probe is
  fenced: an **install-tree resolution boundary** (a hostile repo's planted
  `node_modules/@aihq/enterprise` is refused; any anomaly fails closed to local-only),
  a 2-second import budget, a `--version` fast path that never touches plugins,
  name/flag reservations (built-ins, parent groups, `help`/`version`, shared and
  reserved flags), per-spec registration containment, `skipWorktreeGate` stripped from
  plugin specs, and one sanitizer for every plugin-influenced warning. An unenrolled
  machine sees zero output and zero behavior change. (#116)
- **Policy-bundle schema + `aih policy validate`** — a versioned envelope
  (`schemaVersion`, `bundleVersion`, `issuer`, `issuedAt`, embedded org policy,
  optional `rings`) shared by the local `aih-org-policy.json` and a future signed org
  bundle; read-only validation with layer-attributed errors and coded
  `org-policy.invalid` / `org-policy.bundle-invalid` findings. (#118)
- **Evidence-bundle schema + `aih evidence build`** — a typed kind-index over the
  governance artifacts aih already emits (run logs, vet evidence, skill cards, the
  skills/trust locks, packs, reports, SARIF) written to `.aih/evidence-bundle/` in the
  fleet-bundle layout (`files/` + `manifest.json` + `SHA256SUMS` + `evidence.json`),
  deterministic and name-sorted, with optional best-effort `--sign cosign|gh`. (#118)
- **Fleet bundle** now carries the approval chain: `aih-skills.lock.json`,
  `aih-packs.json`, and the committed skill cards (via new one-level directory
  expansion with hostile-entry refusal) ride the signed channel. (#118)
- **Release provenance on GitHub Releases**: each release now attaches a keyless cosign
  signature over `SHA256SUMS.txt` (`.sig` + `.pem`) and the Sigstore build-provenance
  bundle, alongside the existing SBOM + checksums. Coverage uploads to Codecov (badge
  in the README); workflow tokens default to read-only. (#117)

### Fixed

- `flagKey`'s option-placeholder trim is an index scan — the previous regex backtracked
  polynomially and became reachable by plugin-supplied option flags (CodeQL
  `js/polynomial-redos`, caught after both human review lenses passed). (#116)
- Scan-discovered artifact reads (evidence bundle, fleet-bundle directory expansion)
  are fd-guarded via a shared `readRegularFile` — one descriptor for the
  regular-file check and the read, closing a symlink-swap window between directory
  enumeration and read (code-review HIGH). (#118)
- README documented a nonexistent `aih bundle verify`; the command is
  `aih verify-bundle`. (#118)

### Docs

- **BetterDoc pass over the whole public doc surface** (20 files): every command,
  flag, path, and status claim verified against the source or the built CLI;
  RELEASING.md's asset list and prerelease dist-tag corrected against the real
  workflow; ROADMAP moved five shipped releases out of future tense; spec/plan docs
  gained verified status lines with src pointers. Report imagery is now the
  `aih report --demo --v9` developer console; the overview card's values refreshed
  (37 commands, marketplace flagged as the new surface). (#119)

## [0.5.0] - 2026-07-02

The **skill packs** release: named, committed **curation manifests** over the per-skill
governance lifecycle — approval stays per-skill and `aih-skills.lock.json` stays the pin
authority; a pack batches, scopes, and cross-checks. Every destructive or gate-adjacent
slice passed two independent review lenses with all findings fixed before merge.

### Added

- **`aih pack status` / `aih pack validate`** — the read-only join of the new committed
  `aih-packs.json` manifest against the lockfile and inventory: per skill an `approval`
  axis (approved / missing-approval / **pin-mismatch** — the manifest's `{source, commit}`
  is a fail-closed cross-check, never a second pin) and an `install` axis (installed /
  not-installed / quarantined / stale-pin), with a `ready`/`blocked` pack rollup.
  `validate` is a CI gate: coded `pack.*` findings (duplicate-name, pin-mismatch,
  missing-approval, unknown-manifest), exit 1 on findings.
- **`aih pack add` / `remove-entry` / `init`** — authoring that DERIVES every skill ref
  from its lock entry (never invents pins; refuses unapproved skills and cross-pack
  duplicates). A fail-closed write guard refuses to rewrite a manifest containing
  entries aih cannot parse — operator data is never silently destroyed.
- **`aih pack install` / `aih pack plan`** — the gated batch install: refs grouped by
  (source, commit), pins taken FROM the lock, **all sources gated before any promotion**
  (one poisoned source blocks everything), promotion limited to exactly the pack's refs
  (an unselected skill in the same source — including a *nested* one — never rides
  along), resume is idempotent **and drift-aware** (tampered promoted files are detected
  against trust-lock receipts and reinstalled through the gate). Fail-closed at every
  posture; `plan` never fetches. Per-source failures always land in the outcome report.
- **`aih pack uninstall`** — retracts every installed member with the exact `skill
  remove` semantics in ONE all-or-nothing plan (any member's guard refusal aborts before
  anything moves), behind an **ownership preflight**: a manifest ref whose source/commit
  disagrees with the lock cannot retract the real skill's approval, and duplicate-name
  refs are refused. The manifest itself is never touched.
- **Report governance panel: per-pack rollup** (`pack <name> — N of M approved`), plus
  the pack tag in inventory provenance. Renders only when packs exist.
- Docs: README `aih pack` command row and `docs/product/pack-manifest.md` (schema,
  worked example, the bump-pin → re-vet → re-approve → status-green → install flow).

### Security

- **Skill names are validated at every schema boundary** (lock entries, pack refs, pack
  names): path-safe segments only — a crafted committed name like `../../package-lock`
  can no longer steer destructive cleanup at arbitrary in-repo files (found by external
  review with a live repro; also guarded defense-in-depth inside the card-path builder).
- Report labels strip control/bidi characters before rendering (visual-spoofing hardening).
- Trust-lock receipts union-merge ONLY for subset (pack) promotions; whole-source
  promotions keep replace semantics so a mutable source's removed skills cannot linger
  as stale evidence.

## [0.4.1] - 2026-07-02

The skill lifecycle grows **teeth and a pause button**: committed approvals are now
enforced at install time, and a skill can be disabled reversibly without retracting
its approval. Every change on this destructive/gate surface passed two independent
review lenses (an external security pass and a code-quality pass) with **every
finding fixed and regression-tested before merge**.

### Added

- **Posture-gated skill install enforcement** — `aih workspace add` now requires a
  committed `aih-skills.lock.json` approval **for this source** before promoting a
  skill: matching is content-addressed (a GitHub promotion matches only an entry
  whose commit equals the fetched pinned SHA — a same-named skill from an unrelated
  source can never inherit an approval, and a *stale* approval is refused; local
  promotions match `commit: "local"` entries). Advisory at `vibe` posture
  (warning-only, installs proceed); a promotion-blocking `trust.unapproved-skill`
  fail at `team`/`enterprise` — surfaced as a coded check through the normal
  report/SARIF/support-ticket flow, never a bare error.
- **`aih skill quarantine --name <skill>`** — disable a skill **without removing
  it**: moves its directory to the deterministic `.aih/quarantine/<path>` while
  keeping its lockfile approval and committed card; restore by moving the directory
  back (the digest prints the exact path). Refuses an already-occupied quarantine
  destination (printed restore paths are always truthful), ambiguous duplicates,
  nested-skill collateral, and machine-root installs. `skill inventory` and the
  report governance panel gain a `quarantined` state — and the panel never claims
  "all approved" while a skill sits parked. `skill remove` refuses to strand a
  same-named parked copy's shared approval.
- The remove engine's reversible move gained a **closed-union archive root**
  (`.aih/legacy` | `.aih/quarantine`) — never an arbitrary path; containment,
  symlink refusal, never-overwrite, the dirty-worktree gate, and rollback apply to
  both roots unchanged.
- `aih skill approve --name` now validates the override against the vetted
  evidence's skill list (an arbitrary name would commit an approval no promotion
  could ever match).

## [0.4.0] - 2026-07-02

The **skill lifecycle** release: a complete governance loop for external agent skills —
assess (`vet`), gate (`approve`), observe (`inventory` + report), retract (`remove`) —
layered on the `aih trust` primitive. (The `vet`/`card`/`approve` code physically rode
inside the 0.3.1 package undocumented — a tag that landed after their merge; 0.4.0 is
their official, supported introduction.)

### Added

- **`aih skill vet <repo-or-path>`** — the read-only gate pipeline: resolve → fetch under
  `--apply` (pinned SHA, env-scrubbed temp quarantine) → skill-shape record (skill dirs,
  install scripts, MCP config, package manifests, full-codebase-analysis signal) →
  license check → the trust scan battery → a **GREEN / YELLOW / RED / UNKNOWN verdict**
  (proven-dangerous fail → RED; not-fetched / detector-unavailable / license-missing /
  unpinned → UNKNOWN; other findings + shape triggers → YELLOW) → a local evidence
  artifact (`.aih/skill-reports/<id>-<sha>.json`). Never installs; exit codes stay
  binary and the verdict rides the digest / `--json`.
- **`aih skill card` + `aih skill approve --pin --owner`** — turn vet evidence into
  committed governance state: a committed skill card (`<ctx>/skill-cards/<name>.json`)
  and a committed root **`aih-skills.lock.json`** entry pinning the evidence sha256.
  Fail-closed evidence chain: no approval without a pinned commit, matching evidence,
  an approvable verdict (RED blocked, UNKNOWN refused, YELLOW approvable — approve IS
  the manual review), a recorded license, and `--owner`. Org-policy
  `trust.requiredChecks` (license / pin / no-exec / no-mcp / detector names) evaluated
  at approve; unknown names fail closed.
- **`aih skill inventory`** — the read-only join of on-disk skills (promoted
  `<ctx>/skills`, repo `.claude`/`.kiro/skills`, machine `~/.claude/skills`) against the
  committed approvals: **approved / unapproved / stale-pin** (approved commit ≠ the
  trust-lock source's acquired pin). One row per **physical** install — duplicates of a
  logical name never collapse. Plus a **"Skill governance" panel** in
  `aih report --v9` consuming the same join (legacy report output stays byte-identical).
- **`aih skill remove --name <skill> [--delete]`** — the destructive retraction step:
  moves the skill's directory to the reversible `.aih/legacy/` archive (or a gitignored
  `*.aih.bak` sibling with `--delete`), drops its lockfile approval and committed card.
  Fail-closed refusals: a name matching **more than one physical install** (each listed);
  a skill dir **containing another skill** (collateral named); machine-root skills. An
  **orphaned approval** (dir deleted by hand, lock entry surviving) is cleaned up rather
  than refused. Loader references (settings/MCP/bootloaders) are advisory-only — never
  auto-edited. Reviewed by two independent lenses (external security pass +
  code-quality pass); every finding fixed with regression tests before merge.

### Fixed

- **The dirty-worktree gate is directory-aware for removals**: a removal target
  directory now refuses when any uncommitted file lives **inside** it (previously only
  an exactly-matching dirty path gated, so a whole-dir move could clobber uncommitted
  work inside the dir without `--force`).

## [0.3.1] - 2026-07-01

### Added

- **`aih prune --delete`** — a hard-delete opt-out from the reversible `.aih/legacy/`
  archive: renames the stale file to a gitignored `*.aih.bak` sibling instead of moving it
  under `.aih/legacy/`. An occupied backup slot is **never overwritten** — it falls back to
  `*.1.aih.bak`, `*.2.aih.bak`, … so a prior rescue is never destroyed.
- **`aih prune --unrunnable`** — also prune per-CLI artifacts for a still-*targeted* CLI
  whose binary is absent from `PATH` (probed with the readiness gate's `which`/`where`). A
  PATH problem looks identical to a dropped CLI, so it warns loudly, never rewrites the
  committed `.aih-config.json` marker, and never triggers on a default run or `aih report`.

### Changed

- **npm package slimmed ~64%** (1.1 MB → ~400 kB packed; 3.9 MB → 1.1 MB unpacked): the
  published chunks are now minified (`keepNames` preserved, so stack traces stay readable)
  and source maps are no longer shipped — local development still debugs from `src/`.

### Fixed

- **`aih prune`'s dirty-worktree gate no longer misses quoted paths.** It parsed human
  `git status --porcelain` and never C-unescaped git's quoted paths, so a dirty or untracked
  removal target whose name needs quoting (embedded newline, `"`, non-ASCII) could slip the
  gate and `--delete` could move an uncommitted file without `--force`. It now parses
  NUL-delimited `--porcelain -z -uall`, matching on-disk paths exactly.
- **`aih prune --delete` reports the actual backup path after a fallback** — when the
  `*.aih.bak` slot was occupied and the file landed at `*.1.aih.bak`, the summary previously
  pointed the restore hint at the wrong path.

### Docs

- **Documented `aih prune`** (and `--delete` / `--unrunnable`) in the README command
  reference — it shipped in 0.3.0 without a README entry. `RELEASING.md` now carries an
  explicit "update user-facing docs" and "sync project tracking" step so command/flag docs
  can't silently lag a release again.

## [0.3.0] - 2026-07-01

First-developer experience plus a documentation and licensing-posture pass.

### Added

- **`aih ready` — first-developer readiness gate.** A single graded, blocker-aware verdict
  ("can a developer start work with an AI agent here, now?") composed from aih's existing
  read-only probes (runtime/TLS/PATH/core tools, per-CLI loadability, contract, secret scan).
  Diagnoses by default; the one auto-fixable blocker (missing `rg`/`fd`/`jq`) installs under
  confirmation. Adds a `sec-ready` panel to `aih report --v9`.
- **`aih prune` — remove stale per-CLI artifacts** when a CLI is no longer targeted. Dry-run
  preview by default; `--apply` moves aih-owned files to gitignored `.aih/legacy/` (reversible),
  subtracts aih's managed block in place from co-owned bootloaders (never deletes them), and
  leaves MCP/settings that carry no ownership marker as manual advisories. Introduces a
  fail-closed `remove` action (containment on source and destination, symlink refusal, backup +
  rollback, dirty-worktree guard). Diffed against committed intent only.

### Changed

- **Plan-time reads are modeled as ledgered, guarded probes** ([#35]): plan-shaping host/network
  reads stay in `plan()` but are pinned by a read-only allowlist test, so a run cannot shell out
  an arbitrary command at plan time.
- **`summarizeResult` reports honestly** when an `--apply` run commits no writes or execs
  ("nothing to apply") instead of claiming "Applied".

### Security

- **Emitted SARIF is validated against the SARIF 2.1.0 schema in CI** ([#36]) with a pinned,
  offline validator — invalid SARIF fails the build.

### Docs

- **Licensing / liability posture.** Added [`DISCLAIMER.md`](https://github.com/samartomar/ai-harness/blob/main/DISCLAIMER.md) (Apache-2.0, AS-IS,
  no warranty/SLA/indemnity/paid support), softened assurance wording across README/SECURITY/SUPPORT
  (no "safe/secure/guaranteed/enterprise-ready/production-ready"), and added DCO sign-off +
  contributor rules to [`CONTRIBUTING.md`](https://github.com/samartomar/ai-harness/blob/main/CONTRIBUTING.md).
- **Public-docs hygiene.** Added [`PUBLIC_DOCS_POLICY.md`](https://github.com/samartomar/ai-harness/blob/main/PUBLIC_DOCS_POLICY.md) and a `docs/`
  tree for product / workspace / security / roadmap design docs.

[#35]: https://github.com/samartomar/ai-harness/issues/35
[#36]: https://github.com/samartomar/ai-harness/issues/36

## [0.2.0] - 2026-07-01

First release **published to npm** as [`@aihq/harness`](https://www.npmjs.com/package/@aihq/harness) —
`npm install -g @aihq/harness`. Each release ships build **provenance** (verify with
`npm audit signatures`), an **SPDX SBOM**, and a SHA256 checksum on the GitHub Release.

### Added

- **`aih trust` external-source trust gate** — `allow` / `list` / `pin` / `scan` / `verify`
  to review, pin, and gate external GitHub repos and skills before acquisition (danger
  grading, dependency-confusion + typosquat detection, incoming-MCP and secret scans, SARIF).
- **`aih report --v9` developer console** ships opt-in with LIVE / PREVIEW /
  EMPTY honesty states, machine-relative ECC inventory, MCP parity/egress,
  usage-by-CLI, heavy lifters, dormant ECC skills, remediation wins, no-JS
  honest rendering, and responsive browser-verified layout.
- **`aih usage --apply` per-tool metering hooks and `--rollup`.** The usage
  layer now writes idempotent local hooks for supported targeted CLIs, records
  local activity counts only (no prompts, args, or cost), and aggregates
  `.aih/usage.jsonl` across repos on demand.
- **`aih secrets --verify` is now a secret-scan CI gate.** Each detected plaintext
  secret (`.env*` / root `secrets/`) surfaces as a read-only `fail` probe, so
  `--verify` exits non-zero when secrets exist and `--sarif <file>` emits one
  error-level result per path (under a single `plaintext-secret` rule) for GitHub
  code-scanning. Probes stay read-only verdict carriers — no `exec`, no remote
  mutation, and only the offending path (never any secret value) is reported.

### Changed

- **First-run `ai-coding/` canon trimmed to a lean, evidence-first shape.** Dropped
  the ownership headers, NIST/OWASP/DORA "practice lineage" prose, definition-of-done
  checklists, and expanded file-family index that had crept into the scaffold — the
  generated canon stays small so it sharpens an agent's first diff instead of reading
  as markdown sprawl. Executable safety stays: `.env`/secrets denial, `aih secrets
  --verify`, large-repo graph-safety, and write-once author-owned canon.
- **Cross-CLI coherence shows a neutral `global` glyph for machine-local MCP.** A
  wired-but-global MCP (codex `~/.codex`, gemini `~/.gemini`) is no longer an amber
  `warn` — it is a distinct neutral marker that counts toward agreement, so a repo
  using those tools can reach 100% coherence. Genuine drift / missing / won't-load
  still surface as warn / bad.

### Fixed

- **`aih tools` pins `code-review-graph==2.3.6`** to match the pinned MCP runners, so the
  globally installed CLI can't drift past the graph the harness actually runs.
- **`aih report` and `aih doctor` grade every wired CLI by default, not just claude.**
  Without a committed `.aih-config.json`, coverage previously defaulted to claude and
  under-reported a repo wired for multiple tools. `resolveTargetSet` now infers the
  target set from the per-CLI adapter notes on disk, and `aih bootstrap-ai` persists
  the marker on a standalone run so the report reads the true intent.

### Security

- **Pinned transitive `esbuild` to `^0.28.1`** (npm `overrides`) to clear
  GHSA-g7r4-m6w7-qqqr (dev-server arbitrary file read on Windows). Dev-only —
  `esbuild` is a build-tool dependency (tsup / tsx / vite), never shipped in the CLI.

## 0.1.0 - 2026-06-24

Initial public cut of the Enterprise AI Bootstrapping Harness (`aih`) — a dry-run-first
CLI that bootstraps governed, proxy-safe AI coding into workstations and repos. Tagged on
GitHub but **never published to npm**; the first published release is 0.2.0.

### Added

- **Action model** — every command emits a reviewable plan of typed actions
  (`write` / `doc` / `probe` / `exec` / `envblock`). Dry-run by default; nothing is
  written without `--apply`. Local-only `exec` runs under `--apply`; no remote
  mutation or faked cloud provisioning. Idempotent skips + `.aih.bak` backups.
- **`aih init`** — one-shot bootstrap composing the scaffold, `ai-coding/` canon,
  ECC, Superpowers, and MCP phases. `--mcp-mode standard|offline|none`.
- **`aih bootstrap-ai`** — Layer-2 `ai-coding/` canon (RULE_ROUTER, adapters,
  shared canonical block, agent-behavior-core) plus a native bootloader per CLI:
  `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor MDC, Copilot instructions,
  `.windsurfrules`, and Kiro steering — all pointers into the single canon.
- **`aih ecc`** — installs affaan-m/ECC per selected CLI, scoped to the detected
  stack: `ecc-install` for cursor/zed, ECC's native scripts for Codex
  (`sync-ecc-to-codex.sh`) and Kiro (`.kiro/install.sh`), root-`AGENTS.md`
  auto-detect for OpenCode, and consult-routing for the rest.
- **`aih superpowers`** — installs obra/Superpowers per CLI (plugin / TUI / shell).
- **`aih scaffold`** — repo context docs (INDEX, architecture, conventions, tasks),
  a `SETUP-TASKS` agent playbook, write-once project guardrails, and a `VALIDATION`
  playbook that produces a picture-perfect/gaps verdict.
- **`aih mcp`** — `--mode standard|offline|none` with an enterprise degradation
  ladder (stdio-only servers, `managed-mcp.json` templates, CLI fallback) for
  locked-down environments that block MCP.
- **`aih guardrails`**, **`aih secrets`**, **`aih certs`**, **`aih vdi`**,
  **`aih hardware`**, **`aih sandbox`**, **`aih profile`**, **`aih telemetry`**,
  **`aih workspace`** (parent-only multi-repo bootstrap) — workstation/repo
  bootstrap capabilities, each dry-run-first.
- **`aih doctor`** / **`aih status`** — read-only health probes (corporate CA,
  dev tools, workspace mode) and harness status.
- **CLI targeting** — `--cli <list>`, `--all-tools`, and `--detect` across 11 tools
  (claude, codex, cursor, antigravity, gemini, copilot, windsurf, opencode, zed,
  kimi, kiro). Context directory name is configurable via `--context-dir`.

### Security

- Public-repo hardening: least-privilege CI, CodeQL (security-extended), Dependabot
  (npm + github-actions), private vulnerability reporting, `@claude` workflow gated
  to trusted authors, and GitHub Actions pinned to commit SHAs.

[Unreleased]: https://github.com/samartomar/ai-harness/compare/v6.1.0...HEAD
[6.1.0]: https://github.com/samartomar/ai-harness/compare/v6.0.1...v6.1.0
[6.0.1]: https://github.com/samartomar/ai-harness/compare/v5.4.0...v6.0.1
[5.4.0]: https://github.com/samartomar/ai-harness/compare/v5.3.0...v5.4.0
[5.3.0]: https://github.com/samartomar/ai-harness/compare/v5.2.1...v5.3.0
[5.2.1]: https://github.com/samartomar/ai-harness/compare/v5.2.0...v5.2.1
[5.2.0]: https://github.com/samartomar/ai-harness/compare/v5.1.0...v5.2.0
[5.1.0]: https://github.com/samartomar/ai-harness/compare/v5.0.0...v5.1.0
[5.0.0]: https://github.com/samartomar/ai-harness/compare/v4.0.0...v5.0.0
[4.0.0]: https://github.com/samartomar/ai-harness/compare/v3.4.0...v4.0.0
[3.4.0]: https://github.com/samartomar/ai-harness/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/samartomar/ai-harness/compare/v3.2.0...v3.3.0
[3.2.0]: https://github.com/samartomar/ai-harness/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/samartomar/ai-harness/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/samartomar/ai-harness/compare/v2.11.0...v3.0.0
[2.11.0]: https://github.com/samartomar/ai-harness/compare/v2.10.0...v2.11.0
[2.10.0]: https://github.com/samartomar/ai-harness/compare/v2.9.0...v2.10.0
[2.9.0]: https://github.com/samartomar/ai-harness/compare/v2.8.0...v2.9.0
[2.8.0]: https://github.com/samartomar/ai-harness/compare/v2.7.0...v2.8.0
[2.7.0]: https://github.com/samartomar/ai-harness/compare/v2.6.0...v2.7.0
[2.6.0]: https://github.com/samartomar/ai-harness/compare/v2.5.1...v2.6.0
[2.5.1]: https://github.com/samartomar/ai-harness/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/samartomar/ai-harness/compare/v2.4.3...v2.5.0
[2.4.3]: https://github.com/samartomar/ai-harness/compare/v2.4.2...v2.4.3
[2.4.2]: https://github.com/samartomar/ai-harness/compare/v2.4.1...v2.4.2
[2.4.1]: https://github.com/samartomar/ai-harness/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/samartomar/ai-harness/compare/v2.1.0...v2.4.0
[2.1.0]: https://github.com/samartomar/ai-harness/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/samartomar/ai-harness/compare/v1.3.0...v2.0.0
[1.3.0]: https://github.com/samartomar/ai-harness/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/samartomar/ai-harness/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/samartomar/ai-harness/compare/v1.0.1...v1.2.0
[1.0.1]: https://github.com/samartomar/ai-harness/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/samartomar/ai-harness/compare/v0.6.0...v1.0.0
[0.6.0]: https://github.com/samartomar/ai-harness/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/samartomar/ai-harness/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/samartomar/ai-harness/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/samartomar/ai-harness/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/samartomar/ai-harness/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/samartomar/ai-harness/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/samartomar/ai-harness/releases/tag/v0.2.0
