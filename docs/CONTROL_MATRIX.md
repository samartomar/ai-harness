# Control Matrix

> Status: shipped control matrix for the open-source CLI. This document maps
> public claims to implementation seams and regression tests; if a claim is not
> tied to source and tests here, do not treat it as an assurance claim.

Run the whole gate with:

```bash
npm run verify
```

## Claim to Proof

| ID | Public claim | Implementation seam | Regression proof |
| --- | --- | --- | --- |
| <a id="CM-01"></a>CM-01 | Managed project changes are dry-run first, and `--apply` is the explicit mutation boundary. | `src/internals/execute.ts`, `src/commands/run.ts`, and command specs that declare `readOnly` or emit typed actions. | `tests/internals/execute.test.ts` (`dry-run reports planned writes but writes nothing`, `runs exec actions only on apply and records the exit code`), `tests/contract/json-envelope.test.ts` (`omits the report key entirely when verification did not run`). |
| <a id="CM-02"></a>CM-02 | The action model is local by default; remote mutation is not a normal plan action. Explicit signing/provenance flows are the documented carve-out. | `src/internals/plan.ts`, `src/internals/execute.ts`, `src/commands/index.ts`, `src/bundle/index.ts`, `src/evidence/build.ts`, and `src/marketplace/publish.ts`. | `tests/internals/plan-purity.test.ts` (`every command's plan(ctx) only execs read-only, allowlisted binaries`), `tests/internals/exec-locality.test.ts` (`checks every registered CommandSpec plus explicit signing scenarios`). |
| <a id="CM-03"></a>CM-03 | Every built-in command spec is covered by the command registry used by proofs and contract snapshots. | `src/commands/index.ts` exports `ALL_COMMAND_SPECS`, `GROUPED_COMMAND_SPECS`, and `ALL_COMMAND_SPEC_PATHS`. | `tests/cli.test.ts` (`keeps the canonical CommandSpec registry complete for every registered built-in spec`), `tests/contract/command-surface.test.ts` (`matches the committed command-surface fixture`, `fixture file itself stays canonical (sorted, stable key order, 2-space indent, trailing \\n)`). |
| <a id="CM-04"></a>CM-04 | Writes are contained, transactional, and protected from unrelated dirty worktree loss. | `src/internals/execute.ts` path containment, backup, rollback, and dirty-worktree gates. | `tests/internals/execute.test.ts` (`path containment: a repo-scoped write escaping the root fails closed`, `fault injection during a transaction restores every touched path byte-for-byte`, `refuses to overwrite a dirty file the write would CHANGE`). |
| <a id="CM-05"></a>CM-05 | Skill installs are approval-gated at team/enterprise posture, and pack refs fail closed on missing or mismatched pins. | `src/workspace/acquire.ts`, `src/pack/status.ts`, `src/pack/install.ts`, and `src/skill/approve.ts`. | `tests/workspace/acquire.test.ts` (`REFUSES at team posture when a promoted skill has no committed approval (coded check)`, `does NOT let a same-named approval from another source satisfy the gate (source-bound)`), `tests/pack/status.test.ts` (`fails closed as pin-mismatch when the manifest commit disagrees with the lock`). |
| <a id="CM-06"></a>CM-06 | Evidence bundles are deterministic and carry a harness provenance block. | `src/evidence/build.ts`, `src/evidence/manifest.ts`, and shared fleet-bundle layout code. | `tests/evidence/build.test.ts` (`is byte-identical across two builds over identical inputs`, `indexes every kind that exists, name-sorted, with packaged-byte hashes`, `keeps older evidence indexes without a harness block valid`). |
| <a id="CM-07"></a>CM-07 | Evidence and fleet-bundle signatures can be required in gated environments. | `src/evidence/build.ts`, `src/bundle/index.ts`, and support code metadata for `bundle.signature`. | `tests/evidence/build.test.ts` (`makes signing strict under enterprise posture or --require-signature`, `emits a coded verification failure when strict signing is requested without a signer`, `records a coded failure when strict signing exec fails`), `tests/bundle/bundle.test.ts` (`keeps missing signatures optional unless --require-signature is set`, `fails strict GitHub attestation verification when --repo is missing`). |
| <a id="CM-08"></a>CM-08 | Org policy has a trusted-channel verification path and surfaces local drift/tamper signals. | `src/org-policy/validate.ts`, `src/org-policy/drift.ts`, `src/doctor.ts`, and `src/report/local.ts`. | `tests/org-policy/validate.test.ts` (`passes when the active policy matches a pinned sha256`, `fails closed when the pinned sha256 does not match`, `passes when the active policy matches a fleet-bundle policy copy`), `tests/org-policy/org-policy.test.ts` (`flags AIH_ORG_POLICY env overrides prominently at enterprise posture`, `flags working-tree policy drift from HEAD`, `emits a report digest when policy integrity has a visible signal`). |
| <a id="CM-09"></a>CM-09 | Published releases can be verified against npm signatures, GitHub checksums, cosign bundle, and tarball hash without overstating skipped legs. | `src/release/verify-release.ts` and `src/version.ts`. | `tests/release/verify-release.test.ts` (`runs npm, GitHub release, cosign, and tarball hash checks without overstating skips`, `skips only the cosign leg when cosign is unavailable`). |
| <a id="CM-10"></a>CM-10 | Telemetry setup does not transmit by default; generated collector/fetcher assets require operator action. | `src/telemetry/index.ts`, `src/telemetry/templates.ts`, and `src/telemetry/docs.ts`. | `tests/telemetry/telemetry.test.ts` (`HARD BOUNDARY: emits no exec actions at all (no local mutation needed)`, `HARD BOUNDARY: cron install + API call live in doc, not write/exec`). |
| <a id="CM-11"></a>CM-11 | Reports are offline artifacts by default; live refresh/demo/team-branch data are opt-in flags or degraded local views. | `src/report/`, especially `src/report/artifact.ts`, `src/report/index.ts`, and `src/report/repo.ts`. | `tests/report/artifact.test.ts` (`is a self-contained page: passed title in <title>, brand in <h1>, no external assets`, `embeds a meta-refresh only when a refresh interval is given (live mode)`), `tests/report/report.test.ts` (`is a read-only digest — only digest actions, never calls out`), `tests/report/repo.test.ts` (`without --team, shows the hint and makes NO gh call`). |
| <a id="CM-12"></a>CM-12 | Public claim ledger entries resolve from `<!-- aih:claim CM-xx -->` markers through control-matrix rows to named regression tests, and changed feature files without a docs or matrix update are treated as drift. | `src/docs-lint/index.ts` claim marker parsing, control-matrix proof validation, and Git diff drift check. | `tests/docs-lint/docs-lint.test.ts` (`fails a README claim marker with no CM mapping`, `fails a matrix row that cites a non-existent named test`, `fails a changed feature file when no docs or matrix file changed`, `emits coded advisory findings without failing the report for prose guidance`). |

## Posture Table

`src/config/posture.ts` converts each governance finding into an `allow`, `warn`,
or `deny` verdict for the active posture.

| Control family | vibe | team | enterprise |
| --- | --- | --- | --- |
| `allow` findings | allow | allow | allow |
| `trust-danger` | deny | deny | deny |
| `risk-gates` | warn | warn | warn |
| `secrets` | warn | deny | deny |
| `path-portability` | warn | deny | deny |
| `contract-freshness` | warn | deny | deny |
| `command-policy`, `mcp`, `ca-trust`, `verify`, `trust-origin` | warn | warn | deny |

Regression proof: `tests/config/posture.test.ts` covers the posture normalizer,
precedence (`flag > marker > env > default` before org floors), org-policy floor
clamping, `AIH_ORG_POLICY`, and the table above.

## Offline and Network Boundary

The package dependencies are `commander`, `jsonc-parser`, `yaml`, and `zod`; the
core CLI does not depend on an HTTP client library. Normal command plans are
local actions, probes, digests, or operator docs. Network-capable behavior exists
only in named surfaces where the operator invokes that capability: release
verification (`npm`, `gh`, `cosign`), source acquisition/trust flows, marketplace
or fleet-bundle attestation, cert/TLS probes such as `curl -Iv https://pypi.org`,
and generated telemetry docs/fetcher scripts that the operator must run.

The statement this repo supports is therefore: no default phone-home and no hidden
telemetry transmission. It is not a claim that every command is offline-only.
