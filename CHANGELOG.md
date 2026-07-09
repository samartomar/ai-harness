# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/samartomar/ai-harness/compare/v2.4.3...HEAD
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
