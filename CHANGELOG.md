# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [6.0.0] - 2026-08-14

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
  check in the guardrails plan that ignored posture. Vibe keeps the advisory skip, and CI
  enforcement via the pinned gitleaks in `sca.yml` is unchanged and independent of local PATH.
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
- `aih policy evaluate --verify` now provides a headless requested-versus-effective
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
  [docs/product/docs-quality-pack.md](docs/product/docs-quality-pack.md). (#166)
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
made as a reviewed contract decision. See [STABILITY.md](STABILITY.md).

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

- **Licensing / liability posture.** Added [`DISCLAIMER.md`](DISCLAIMER.md) (Apache-2.0, AS-IS,
  no warranty/SLA/indemnity/paid support), softened assurance wording across README/SECURITY/SUPPORT
  (no "safe/secure/guaranteed/enterprise-ready/production-ready"), and added DCO sign-off +
  contributor rules to [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **Public-docs hygiene.** Added [`PUBLIC_DOCS_POLICY.md`](PUBLIC_DOCS_POLICY.md) and a `docs/`
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

[Unreleased]: https://github.com/samartomar/ai-harness/compare/v6.0.0...HEAD
[6.0.0]: https://github.com/samartomar/ai-harness/compare/v5.4.0...v6.0.0
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
