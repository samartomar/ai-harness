---
status: guide
owner: AI-Harness maintainers
last_verified: 2026-09-02
truth_home: true
purpose: Admin guide for governed organizations and enterprise rollout of AI-Harness.
---

# Enterprise Admin Guide to AI-Harness

Use this guide for enterprise admins, platform owners, security owners, fleet rollout, regulated teams, and organizations that need policy, evidence, approval paths, and developer handoff. For posture mechanics, read [Postures](postures.md). For the full command map, use [Command Use Cases](command-use-cases.md). Developers consuming an admin-authored policy should read [Enterprise Developer](enterprise-developer-guide.md).

This guide owns admin-side material: policy authoring, approvals, source pins, signing choices, Docker/SkillSpector preparation, bundles, and evidence packaging. It should not become the place for developer-local OAuth, API token setup, or day-to-day client usage beyond handoff requirements.

## 1. Executive Summary / Mental Model

For enterprise use, AI-Harness is a local enforcement reader plus a repeatable evidence surface. It does not move governance into an agent chat. It helps a team materialize approved repo canon, policy, MCP configuration, capability intent, skill approvals, packs, bundles, truth sidecars, and evidence in files that can be reviewed, pinned, signed, and verified.

The `enterprise` posture emphasizes least privilege, approval, auditability, and fail-closed behavior where policy requires it. The CLI remains local-first. Public docs should describe implemented mechanisms and supported commands; label unshipped admin-plane concepts as future-facing or omit them from setup guidance.

The enterprise examples in this public guide are intentionally limited to reviewed Figma, Jira/Atlassian, and AWS MCP paths. Additional service MCPs should follow the same policy and source-review pattern before appearing in public enterprise guidance.

This guide follows the promoted `@aihq/core` stable train; the frozen,
npm-deprecated legacy evidence remains at `@aihq/harness@6.1.0`, but new
installations use `@aihq/core`. The scoped public security doc documents SLSA
v1.2 Build L2 for tagged Core tarballs; no Build L3 or formal compliance claim
is made.

### Current organization-qualified boundary

The maintained AIH catalog is intended to reduce administrator work; it is not the
organization's permission boundary. The Strict V2 library/schema
foundation can represent an exact organization-chosen tool, skill, MCP server,
package, or profile, its attributable evidence and authority-bound decision, and a separate
upstream-managed installed-state observation that names the responsible integration
owner and exact integration version. Qualification must point to the exact organization
evidence or an exact catalog signer identity plus head, catalog, and member digests; it is
not a status an administrator can assert. Core derives and checks canonical source/subject
digests, and its internal effectiveness resolver accepts only an opaque, freshly verified
authority capability—not a standalone decision file. The default Enterprise transport is one
administrator-protected PolicyBundle V2 file; the existing GitHub-attested V3 receipt remains an
optional higher-assurance/compatibility transport. It deliberately keeps
`aih-supported`, `organization-qualified`, and `unqualified` distinct and never
treats an unsigned `approved` field as authority.

#### Default Enterprise authority: one protected policy file

The adopter creates the document through the existing Policy Workbench rather than writing JSON:

```console
aih policy generate --apply
```

Open `aih-policy-workbench.html`, select Enterprise, complete the **Protected Enterprise policy
file** form, add each exact artifact approval, and download `aih-policy-bundle.json`. The form accepts
ordinary fields for an exact GitHub, npm, PyPI, OCI, remote-content, or AIH source identity,
plus artifact kind, targets, effects, evidence, issuer, actor, policy, and control. It computes the canonical Decision V2 source,
subject, and revocation digests in the browser. Repeat the form for organization-chosen tools,
skills, MCP servers, or packages absent from the Catalog; use a new exact decision for a version
change and the row's Revoke action for revocation. The `issuerRepository` value is attribution in the
reused V3 contract—it does not require a GitHub workflow or dictate where the file is stored.

For MCP, Skill, or Agent scanning, use the Workbench **Artifacts** tab to create one mixed intake of
up to 100 items. Run the displayed `aih trust scan ... --evidence-out ...` command; Scanner returns one
evidence bundle to merge into the same review. **Save team review workspace** then preserves the draft
policy, intake, and evidence history in one file for another review session. That workspace explicitly is
not authority and is not the deployable policy. Keep the scanner output as an attributable record and
download the protected policy separately after approval.

The adopter stores the generated PolicyBundle V2 document in an administrator-only directory outside
the governed repository and supplies its absolute path with `--policy <file>` for one invocation or
`AIH_ORG_POLICY` for a managed process environment. The CLI flag takes precedence over the environment
variable and the default repo-local `aih-org-policy.json` lookup. The document reuses the
existing org policy, `GovernanceDecisionV2`, decision revocations, and V3 authority envelope. It is
not a new policy plane, workflow, or durable store. Vibe remains unchanged and a repo-local policy
never becomes authority merely because it contains an `approved` field.

Core accepts the file only at Enterprise posture and only while all of these conditions hold:

- the configured path is absolute and resolves outside the governed target;
- the document is strict PolicyBundle V2 JSON no larger than 1,000,000 bytes;
- the file and all existing parents are non-symlinked, and the file is regular and single-link;
- the bundle and authority issuance instants match, and the authority window is current and no
  longer than 90 days;
- the exact bytes and file identity survive live re-observation; and
- every authority-dependent mutating transaction pins and rechecks that exact external file before
  effects.

ECC and Superpowers evidence, ECC request selection, ordinary ECC profile lifecycle acquisition and
mutation, standalone MCP planning, and standalone Usage ownership checks all consume their one
verified policy observation. ECC profile install/update composes projection and native registration
inside one pinned filesystem transaction; receipt-bound uninstall remains independently authorized
by installed custody. The composed `aih init` plan retains every nested phase's file assertions,
deadline, and cooperative lock; it refuses conflicting nested authority before any plan effect runs.

When a governed plan launches a child process, Core holds and renews the same cooperative authority
lease while the process is running and revalidates the protected file immediately before and after
the process. If authority changes after the child starts, Core fails the command, blocks later child
effects and deferred writes, and reports that the already-started process may have produced effects
that Core cannot roll back.

Core never writes the protected file and never claims that these checks prove its host ACL. The
administrator or MDM/configuration-management system must restrict replacement to authorized
operators and must control the process environment that names `AIH_ORG_POLICY`. Distribute a newly
issued exact bundle to update a decision, change an artifact version, supersede an earlier policy,
or add a revocation. The same lifecycle commands append observations and revocations to Core's
existing `.aih/governance/` history; there is no second audit database. Offline use continues only
until the file's current validity window ends. Missing, stale, malformed, linked, moved-inside-target,
expired, replaced, or decision-mismatched authority fails closed.

Existing target history binds the authority digest used for each recorded effect. A fresh target has
no separate global PolicyBundle version high-water mark, so Core cannot detect rollback to older
file bytes that are still within their declared validity window. The administrator's MDM or file
distribution system owns that fresh-target rollback prevention.

Automation can validate the decoded bundle structure from an installed package before distribution:

```js
import { parsePolicyBundle, PolicyBundleSchema } from "@aihq/core";
```

`PolicyBundleSchema` supplies the closed structural contract; `parsePolicyBundle` returns
layer-attributed envelope or embedded-policy errors. These object-level helpers do not enforce the
raw file's UTF-8, duplicate-key, or byte-limit rules. The file becomes authority only when Core's
active-file reader validates those exact bytes from the protected external `AIH_ORG_POLICY` path and
rechecks them at the effect boundary.

#### Exact governance command map

The packed [command reference](../docs/commands.md#aih-policy) is authoritative for flags. Use the
closed route selected by the exact decision; do not treat a command's reachability as approval:

Add `--policy <team-policy-file>` to any command below when the target does not use the default
repo-local filename. Keep scanner evidence as separate JSON records. Every `--evidence <file>` value
is root-relative to the governed target and is revalidated by the consuming command; importing that
record into the Workbench is preflight inspection, not organization authority or approval.

| Journey step | Exact command |
|---|---|
| Verify organization-qualified evidence | `aih policy resolve <root> --decision <id> --decision-digest sha256:<digest> --target <id> --effect <effect> --evidence <file> --json` |
| Accept and inspect an AIH-supported member | `aih policy supported accept --root <root> --decision <id> --decision-digest sha256:<digest> --target <id> --apply --json`; then `aih policy supported inspect --root <root> --json` |
| Discover, preview, apply, and inspect the fixed AIH-managed adapter | `aih policy managed usage-metering describe --json`; `aih policy managed usage-metering reconcile <root> --decision <id> --decision-digest sha256:<digest> --target <claude|codex> --evidence <file> [--apply] --json`; `aih policy managed usage-metering inspect <root> --json` |
| Re-observe an upstream-managed exact npm package | `aih policy observe npm-package <root> --decision <id> --decision-digest sha256:<digest> --target <id> [--evidence <file>] --json` |
| Persist observation, exact version update, or authenticated revocation | `aih policy lifecycle npm-package <root> --decision <id> --decision-digest sha256:<digest> --target <id> [--evidence <file>] [--apply] --json` |
| Observe an organization-managed exact tool, skill, MCP server, or package absent from AIH catalogs | `aih policy observe upstream-artifact <root> --decision <id> --decision-digest sha256:<digest> --target <id> --evidence <file> --manifest <file> --json` |
| Persist its observation, exact artifact update, or authenticated revocation | `aih policy lifecycle upstream-artifact <root> --decision <id> --decision-digest sha256:<digest> --target <id> --evidence <file> --manifest <file> [--apply] --json` |
| Inspect durable effective-state and audit truth without adding inspection rows | `aih policy evaluate <root> --no-log --json`; `aih report <root> --no-log` (see the packed [`aih report` reference](../docs/commands.md#aih-report)) |

A version update requires a newly authorized decision whose exact version/integrity and evidence
match the newly observed installation; rerun lifecycle preview and explicit apply. A revocation
requires the current authenticated decision revocation and the same lifecycle command. Revocation appends
an audit fact and remains non-effective/nonzero; it does not claim that an upstream package manager
removed or stopped the package. The fixed AIH-managed route has its own authenticated reconcile and
inspect lifecycle because it owns only its code-derived bytes.

For an `aih-supported` basis, Core consumes the fixed
`.aih/aih-supported-qualification-receipt.json` file. The file must be canonical,
no larger than 5,970 bytes, and externally attested by the independently configured
`AIH_SUPPORTED_QUALIFICATION_REPOSITORY` and
`AIH_SUPPORTED_QUALIFICATION_WORKFLOW`. Core rejects linked custody, verifies an
owner-only private copy with an absolute external GitHub CLI, then exact-matches the
receipt's full subject and seven catalog-basis fields to the current Decision V2.
Those roots cannot reuse the verified organization authority root. A verified
supported receipt qualifies provenance only; the organization must still issue the
separate Decision V2 that authorizes the exact target and effect.

#### Catalog-absent organization detector evidence

An organization does not need an AIH-maintained catalog entry to produce Scanner evidence for its
own exact compatible detector. The Scanner V2 contract accepts a canonical
`DetectorRegistrationV1` whose authoring form contains one to 128 deterministically ordered entries
and is bounded to 512 KiB. Each entry has this closed shape (every digest placeholder is 64 lowercase
hexadecimal characters):

```json
{
  "protocol": "DetectorRegistrationV1",
  "registrations": [
    {
      "detector": {
        "detectorId": "detector.example.policy",
        "analyzerIdentity": "native.0123456789ab",
        "ociImage": {
          "reference": "local.invalid/aih-scan/cisco@sha256:<manifest-sha256>",
          "sha256": "<manifest-sha256>"
        },
        "adapter": {
          "identity": "adapter.0123456789ab",
          "sha256": "<adapter-sha256>"
        },
        "observationConfigurationSha256": "<configuration-sha256>",
        "executionProfileSha256": "<execution-profile-sha256>",
        "supportedPlatforms": [{ "os": "linux", "architecture": "amd64" }],
        "sbom": { "mediaType": "application/spdx+json", "sha256": "<sbom-sha256>" },
        "provenance": {
          "mediaType": "application/vnd.in-toto+json",
          "sha256": "<provenance-sha256>"
        }
      },
      "runtime": {
        "sourceReference": "local.invalid/aih-scan/cisco@sha256:<manifest-sha256>",
        "sourceSha256": "<manifest-sha256>",
        "configSha256": "<image-config-sha256>"
      },
      "adapterCapability": "cisco-oci-v1",
      "broker": {
        "identity": "broker.0123456789ab",
        "capability": "cisco-oci-v1"
      }
    }
  ]
}
```

`detector.cisco` is reserved for Scanner's direct built-in path. Organization IDs must remain in
the `detector.<namespace>...` grammar. The registration selects only the checked-in
`cisco-oci-v1` adapter on Linux `amd64`; it cannot provide JavaScript, a command, a host path, or a
dynamic adapter. The strict capture request combines this registration and selected `detectorId`
with the matching canonical OCI layout, source root, selected closure, and exact SBOM/provenance
annex files. Runtime/configuration substitution, unknown fields, duplicate IDs, mutable image
references, unsupported platforms, cross-detector evidence, source/request drift, and final
caller-registration drift fail closed.

Resolve the promoted `@aihq/scan` stable train and verify its matching npm,
GitHub Release, and provenance evidence. Install the approved exact version into a
disposable consumer:

```bash
SCANNER_VERSION="$(npm view @aihq/scan dist-tags.latest)"
npm install --save-dev "@aihq/scan@$SCANNER_VERSION"
npx --no-install aih-scan capture --request <capture-request.json> --output <new-bundle>
npx --no-install aih-scan sign --bundle <bundle> --signer <signer.json> --private-key <key.pem> --claims <claims.json> --output <evidence.json>
npx --no-install aih-scan verify --evidence <evidence.json> --bundle <bundle> --roots <independent-roots.json> --expected <expected-claims.json>
npx --no-install aih-scan project-core-evidence --evidence <evidence.json> --bundle <bundle> --roots <independent-roots.json> --expected <expected-claims.json> --subject-digest sha256:<core-subject-digest> --output <organization-evidence.json>
```

Capture, signing, independent verification, and Core projection are separate phases. Scanner runs
only in a disposable target and cannot mint qualification, approval, Core authority, installation,
configuration, or runtime effects. Generated test keys, signer-class strings, and packed proofs are
mechanics only. Production use still requires independently controlled signer roots and claims, a
current organization decision from the protected PolicyBundle V2 (or the optional attested
receipt transport), and a matching Core observation/effect route. Place the projected canonical envelope below the governed
target only after preserving its custody, then use `aih policy resolve` or a supported observer from
the command map above. Missing catalog membership is not a denial, but missing authority is.

The `aih policy resolve` command verifies the organization-evidence
half of that boundary from an administrator-selected target root:

```bash
aih policy resolve <root> \
  --decision <exact-decision-id> \
  --decision-digest sha256:<exact-decision-digest> \
  --target <code-owned-cli-id> \
  --effect <configure|install|observe|use> \
  --evidence <root-relative-canonical-envelope> \
  --json
```

Set `AIH_ORG_POLICY` to the absolute protected PolicyBundle V2 path. The command re-verifies the
exact authority file, decision, and evidence; it writes neither the target
nor a run ledger. A valid result is still `partial`/`observation-missing` and exits nonzero.
Treat that result as verified prerequisites, not as permission or effective state.

Deployments that deliberately retain the GitHub-attested receipt transport instead configure
`AIH_POLICY_AUTHORITY_REPOSITORY` and, when required,
`AIH_POLICY_AUTHORITY_WORKFLOW`. That transport uses the fixed
`.aih/policy-authority-receipt.json`; it is optional and does not make a reference AIH repository
the authority for adopter organizations.

For an organization-qualified npm `package` decision whose allowed effects include `install`, an
administrator can also observe an installation that npm already manages:

```bash
aih policy observe npm-package <root> \
  --decision <exact-decision-id> \
  --decision-digest sha256:<exact-decision-digest> \
  --target <code-owned-cli-id> \
  --evidence <root-relative-canonical-envelope> \
  --json
```

The command derives the package from the decision and reads the fixed npm v3 lockfile plus the
matching installed manifest. It cannot install or execute the package, and exposes no package,
effect, observer, verifier, runner, clock, receipt, or callback override. Exact current evidence
returns `observed-effective` with a canonical receipt digest for at most 24 hours and never beyond
the authority, decision, or conditional-review deadline; missing installed evidence remains
`partial`, while linked, changed, stale, revoked, rejected, malformed, or mismatched evidence
refuses. This observation command persists no receipt or capability.

After reviewing that observation, persist its audit lineage with the same exact inputs. The first
call remains a zero-write preview; only the second call can write:

```bash
aih policy lifecycle npm-package <root> \
  --decision <exact-decision-id> \
  --decision-digest sha256:<exact-decision-digest> \
  --target <code-owned-cli-id> \
  --evidence <root-relative-canonical-envelope> \
  --json

aih policy lifecycle npm-package <root> \
  --decision <exact-decision-id> \
  --decision-digest sha256:<exact-decision-digest> \
  --target <code-owned-cli-id> \
  --evidence <root-relative-canonical-envelope> \
  --apply --json
```

The applied command repeats live authority, qualification, installed-state, and observation checks
before appending an immutable record under `.aih/governance/npm-package-lifecycle/v1/`. Each prepared
write has at most 60 seconds to commit, shortened by any earlier authority, decision, review, or
observation deadline. Use a newly
authorized exact decision/evidence set for a version or integrity bump; the prior record remains in
the stable package/integration lineage. When the current V3 authority revokes the decision, the
same command appends that revocation only for the verified current lineage. This is an audit fact,
not a claim that npm removed or stopped the package. The record append is durable evidence, but the
revoked result remains non-effective, failing, and nonzero. Refused, expired, corrupt, detectably
rolled-back, forked, raced, linked, over-capacity, or detached state cannot produce a successful
apply result.
A durable subject-and-target claim prevents loss of the ordinary subject binding from silently
admitting a different registry or integration lineage. AIH serializes these local writers with one
fixed store-wide cooperative lease and advances a strict writer-only aggregate capacity guard using
an exact-original transaction precondition. A stale cross-lineage plan therefore cannot race past
the reader's limits. The reader independently derives its counts and does not trust this guard as
authority. A crashed owner is reclaimable after its bounded 30-second mutation
window and 30-second recovery grace, while malformed or foreign lock state blocks. The inert lock
anchor can remain in the lifecycle store. This is local AIH writer coordination, not an
operating-system lock or protection from another process that can rewrite the store.

A failed immutable-record rename can leave the exact private `.aih.tmp` scratch. AIH consumes that
scratch on retry only when its canonical candidate bytes and single-link custody still match at the
transaction boundary. It preserves and refuses mismatched, linked, wrongly named, or foreign scratch
instead of treating untrusted state as cleanup input.

A hard process or machine failure can leave an immutable record before its head advances. Only the
same prepared canonical bytes can be reused; a fresh command performs a newly timed observation and
normally treats that orphan as an ambiguous fork. AIH fails closed instead of deleting or adopting
it, so preserve the store and route it through the organization's approved
incident-reconciliation process.

The target-local chain blocks a different lineage while either subject index remains and detects a
stale head while its canonical successor records remain. It cannot prove that an administrator or
attacker did not delete both the claim and binding, or roll back a head advance and all later records.
Retain the whole store in organization-controlled versioned evidence. Neither the
lifecycle store nor the inert offline high-water seam is authority. Current authority comes from
the protected PolicyBundle V2 file or the optional GitHub-attested receipt transport. On a fresh
target, the administrator's file-distribution system must still prevent rollback to older
still-valid bundle bytes.

For this narrow npm route, the durable lifecycle now reaches the governance read surfaces. Run
`aih policy evaluate <root> --no-log --json` after the lifecycle apply, then inspect the governed report with
`aih report <root> --no-log`. Both
validate the fixed store and freshly verify current organization authority. They report the exact lineage as
`observed-effective` only while the observation and authority remain current; partial,
withheld/refused, revoked, stale, or drifted state is explicit and blocks evaluation. Observation
expiry alone does not freeze unrelated policy projection; unsafe custody, authority failure,
rejection, revocation, and other lifecycle failures still block it. With `--no-log`, these commands
do not repeat the package observation, mutate the target, or control the installed runtime. The store supports at most
256 active lineages, 16,384 aggregate records, and 4,096 records in one lineage. Exceeding a limit is
reported as `over-capacity`, not as corruption, and blocks both evaluation and projection. Preserve
the complete store as organization-controlled evidence and reconcile onto a newly governed target;
do not delete or prune target-local history to make the check pass.

For catalog-independent files already placed in the governed root by the organization, use the
fixed `upstream-artifact` observer and lifecycle. The canonical manifest is shipped as
`@aihq/core/schemas/aih-upstream-artifact-manifest-v1.schema.json` in the published
`0.3.0` Core package; its public parser also rejects
noncanonical or oversized bytes. It binds the exact organization-qualified Decision V2 id,
tool/skill/MCP/package subject and digests, target, allowed effect, accountable integration owner,
fixed integration-contract version, and one to 256 sorted root-relative file digests. The raw
canonical manifest SHA-256 must appear in the organization evidence `artifactDigests`. The manifest
uses the decision id rather than its digest because the decision binds the evidence digest and the
evidence binds the manifest bytes; adding the decision digest to the manifest would create a digest
cycle. Paths remain mixed-case capable but must be portable-case unique; every segment rejects
trailing-dot/space and Windows-device aliases.

```bash
aih policy observe upstream-artifact <root> \
  --decision <exact-decision-id> \
  --decision-digest sha256:<exact-decision-digest> \
  --target <code-owned-cli-id> \
  --evidence <root-relative-canonical-envelope> \
  --manifest <root-relative-canonical-manifest> \
  --json

aih policy lifecycle upstream-artifact <root> \
  --decision <exact-decision-id> \
  --decision-digest sha256:<exact-decision-digest> \
  --target <code-owned-cli-id> \
  --evidence <root-relative-canonical-envelope> \
  --manifest <root-relative-canonical-manifest> \
  --apply --json
```

The code-owned observer validates durable evidence/manifest request paths before authority
verification, reads only single-link evidence and the named bounded regular files, rejects AIH's
reserved `.aih/` custody tree, linked or ambiguous paths, and repeated physical file identities, and
re-observes authority, evidence, manifest, and every file before returning `observed-effective`. It
has no caller-selected command, callback, executable, network, installer, or projector. Lifecycle
preview is zero-write; apply appends immutable history under
`.aih/governance/upstream-artifact-lifecycle/v1/`, records an exact update without rewriting the
prior record, and records a current authenticated revocation as failing/nonzero negative state.
Neither command installs, copies, configures, activates, removes, stops, or executes an artifact.
For every current observation record, `policy evaluate --no-log --json` and `report --no-log` use
its stored exact request to repeat the same live read-only observation under one freshly verified
authority result, then exact-compare a fresh bounded lifecycle snapshot before returning any
effective state. Missing or drifted live inputs and substituted stored verifier/installed identities
stay non-effective. After an external version or source change, run
`policy observe upstream-artifact` and lifecycle apply with the newly authorized decision/evidence to
append the new audit record.

Scanner can produce attributable evidence for a catalog-absent exact detector through its one
code-owned adapter. Its source repository and promoted `@aihq/scan` stable train are public.
Observe npm package provenance and GitHub Release evidence independently; success at one boundary
does not prove the other.
The packed Core proof uses the packed CLI to generate the Workbench, drives its structured fields and
download, and uses that protected PolicyBundle V2 with a disposable consumer root to
exercise successful organization authority, exact observation, lifecycle update, and authenticated
revocation without fabricated GitHub authority. It proves Core's file-custody contract, not the real
deployment's ACL or MDM controls. Scanner publication, Scanner signer roots, Catalog attestation,
and organization authority remain separate trust and release boundaries.

## 2. Quickstart / Implementation Blueprint

### Admin Workstation Prerequisites

Prepare the admin workstation before authoring policy or bundles:

- Node.js/npm for installing and verifying the current published AIH package. The
  active Core line starts at `@aihq/core@0.1.0`; `@aihq/harness@6.1.0` is frozen
  and npm-deprecated.
- Git for source pins, release checks, and admin-configuration commits.
- Docker or a compatible container runtime when the organization requires containerized detectors such as SkillSpector, or when scanner images need to be built, pushed, and signed.
- Cosign or the organization's selected signer when marketplace artifacts, bundles, evidence, or container images require signatures.
- Access to the approved container registry, package registry, source hosts, and secret manager.
- Corporate TLS/proxy configuration needed for npm, Git, Docker registry, GitHub, Atlassian, Figma, AWS, and signing endpoints.

Portable readiness checks:

```powershell
node --version
npm --version
git --version
docker version
cosign version
```

If Docker or cosign is not part of the organization's selected policy path, document the alternate detector or signing path instead of implying those checks ran.

Verify the release before rollout:

```console
CORE_VERSION="$(npm view @aihq/core dist-tags.latest)"
npm install -g "@aihq/core@$CORE_VERSION"
aih verify-release "$CORE_VERSION"
```

For unmanaged macOS or Linux evaluation hosts, route npm `EACCES` failures to the
[user-owned npm prefix recovery](../README.md#macoslinux-global-install-permission-errors);
do not normalize `sudo npm install -g` in rollout instructions.

Full release verification requires local `npm`, `gh`, and `cosign`; proceed only when all three legs
pass. A skipped leg is incomplete evidence, not a successful rollout gate.

For an upgrade, resolve and approve the explicit promoted version; `npm update -g`
may stay within the current major. Re-run `aih verify-release "$CORE_VERSION"` after
installation. Use `--force` only
when replacing a broken global install after reviewing the npm prefix and approved package source.

Bootstrap a governed repo with an enterprise posture:

```console
aih init . --posture enterprise --mcp-mode offline --mcp-compliant
aih init . --posture enterprise --mcp-mode offline --mcp-compliant --apply
aih bootstrap-ai --all-tools --apply
aih bootstrap-ai --verify
```

Validate policy and baseline:

```console
aih policy validate
aih doctor --posture enterprise
aih secrets --verify
aih docs-lint
aih pack validate
```

Record capability intent when the organization wants a committed capability manifest:

```console
aih capability resolve --posture enterprise --apply
aih capability prune --apply
```

Approve and distribute governed skills:

```console
aih skill vet <skill-source> --apply
aih skill approve <skill-source> --owner <security-or-platform-owner> --pack <pack-name> --apply
aih pack status --pack <pack-name>
aih pack validate --pack <pack-name>
aih marketplace build --out <artifact-dir> --apply
aih marketplace publish --dir <artifact-dir> --signer cosign --apply
aih marketplace validate --dir <artifact-dir> --require-signature
```

Use the first-party docs-quality pack in a governed repo only after local approval evidence exists:

```console
aih pack scaffold --pack docs-quality --apply
aih skill vet packs/docs-quality/aih-betterdoc --apply
aih skill approve packs/docs-quality/aih-betterdoc --owner <security-or-platform-owner> --pack docs-quality --apply
aih pack validate --pack docs-quality
```

Create and verify a truth sidecar only after the repo has a real commit to bind:

```console
aih init . --sidecar --posture enterprise --apply
aih truth verify --posture enterprise
aih truth pack --posture enterprise --apply
```

Build evidence for review:

```console
aih evidence build --out <evidence-dir> --sign cosign --require-signature --apply
aih verify-bundle --bundle <evidence-dir> --require-signature
```

### Admin Configuration Location

An enterprise admin may use an otherwise empty repository, MDM directory, configuration-management
root, or another read-only location. That location distributes the Workbench-generated file; it is
not another AIH runtime or approval workflow and must not become a secret store. Keep real tokens,
PATs, OAuth state, AWS profiles, and Jira/Figma credentials in developer-local environment variables,
browser OAuth, or the organization's secret manager.

Generate the file with `aih policy generate --apply`, then use the Workbench rather than typing an
`aih-org-policy.json` or PolicyBundle by hand. Set `AIH_ORG_POLICY` to the absolute generated bundle
path outside each governed target. Vibe repositories may still use a repo-local
`aih-org-policy.json`; that file is ordinary policy, not Enterprise authority.

### Scanner And Docker Preparation

`aih trust scan` can evaluate sources without Docker for checks that do not require a containerized detector. Docker becomes part of the admin setup when policy requires a detector such as `skillspector`, or when the organization wants scanner images built and signed before use. If `aih-org-policy.json` lists `skillspector` in `trust.requiredDetectors`, do not treat scanner coverage as complete until the detector path is available and recorded.

From the checked-out AI-Harness root, build the reviewed SkillSpector image from a fixed commit:

```powershell
$AihRoot = (Resolve-Path .).Path
$SkillSpectorRoot = Join-Path ([System.IO.Path]::GetTempPath()) "aih-skillspector-2d198ab910ad"
git clone https://github.com/NVIDIA/SkillSpector.git $SkillSpectorRoot
Set-Location $SkillSpectorRoot
git checkout 2d198ab910add401cad658d1087e7c7ba24fd640
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --build-arg SOURCE_DATE_EPOCH=1785167267 -f (Join-Path $AihRoot "tools\skillspector.Dockerfile") -t skillspector:aih-2d198ab910ad --load .
docker image inspect skillspector:aih-2d198ab910ad --format "{{.Id}}"
```

Use AI-Harness to report the currently pinned analyzer image metadata before changing policy or detector requirements:

```powershell
aih trust skillspector-pin
```

If the local image ID differs from the controlled digest reported by `aih trust skillspector-pin`, record an explicit reviewed local digest before requiring `skillspector` in enterprise policy:

```powershell
$SkillSpectorDigest = docker image inspect skillspector:aih-2d198ab910ad --format "{{.Id}}"
aih trust skillspector-pin `
  --candidate-revision 2d198ab910add401cad658d1087e7c7ba24fd640 `
  --candidate-tag skillspector:aih-2d198ab910ad `
  --candidate-digest $SkillSpectorDigest `
  --approve-local-digest `
  --reason "Reviewed local Docker build from pinned SkillSpector source." `
  --reviewer security-platform `
  --apply
aih policy validate
```

For a proposed analyzer source pin bump, use candidate fields from the reviewed upstream/image metadata to surface the compare URL before changing code or policy:

```powershell
aih trust skillspector-pin --candidate-revision <40-char-sha> --candidate-tag <image-tag> --candidate-digest sha256:<64-char-hex>
```

The source commit pin is the review anchor; the image ID verifies the local build output. If the image will be shared beyond the admin machine, tag it into the approved registry and sign the registry reference or immutable digest according to the organization's signing policy:

```powershell
$ImageRef = "<registry>/<namespace>/skillspector:aih-2d198ab910ad"
docker tag skillspector:aih-2d198ab910ad $ImageRef
docker push $ImageRef
cosign sign --key <cosign-key-ref> $ImageRef
cosign verify --key <cosign-public-key-ref> $ImageRef
```

Use a digest form such as `<registry>/<namespace>/skillspector@sha256:<digest>` when the registry/signing policy requires immutable references. Do not commit registry credentials, cosign private keys, Docker auth files, or scanner output containing repo secrets.

### Enterprise Configuration Levels

| Level | Admin intent | Command setup |
|---|---|---|
| Min Configuration | Install verified AI-Harness, enforce enterprise posture, generate only policy-allowed MCP, and keep evidence local. | `aih verify-release`, `aih policy validate`, `aih init . --posture enterprise --mcp-mode offline --mcp-compliant`, `aih bootstrap-ai --all-tools --apply`, `aih doctor --posture enterprise`, `aih secrets --verify` |
| Balanced | Min plus ECC, BetterDoc, and one reviewed MCP example such as Figma for teams that need coding canon, docs quality, and approved design context. | Min commands plus `aih ecc --cli claude,codex --profile core --posture enterprise --apply`, `aih pack scaffold --pack docs-quality --posture enterprise --apply`, `aih pack install --pack docs-quality --posture enterprise --apply`, `aih mcp approve figma --accept-egress ...`, and reviewed `.mcp.json` for Figma. |
| Powerhouse Mode | Balanced plus usage/reporting, Superpowers, truth sidecar, selected external skills, Figma, Atlassian/Jira, and selected AWS MCP. | Balanced commands plus `aih superpowers`, `aih usage`, `aih track`, `aih report --v9`, `aih truth verify`, `aih truth pack`, external `aih trust`/`aih skill` approvals, and explicit MCP approvals/config for Figma, Atlassian, and AWS. |

Most writing commands refuse a dirty worktree unless `--force` is supplied. In governed rollout, prefer one reviewed commit per stage. For a dedicated setup branch or disposable admin repo where the operator has reviewed the pending diff, `--force` can be added to chained authoring commands.

Min Configuration:

```powershell
$CoreVersion = npm view @aihq/core dist-tags.latest
npm install -g "@aihq/core@$CoreVersion"
aih verify-release $CoreVersion
aih policy validate
aih init . --posture enterprise --mcp-mode offline --mcp-compliant
aih init . --posture enterprise --mcp-mode offline --mcp-compliant --apply
aih bootstrap-ai --all-tools --apply
aih bootstrap-ai --verify
aih mcp --posture enterprise --mode offline --mcp-compliant --apply
aih mcp --posture enterprise --mode offline --mcp-compliant --verify
aih doctor --posture enterprise
aih secrets --verify
```

Warm pinned `uvx` MCP packages before relying on offline startup in managed images
or disconnected workstations:

```powershell
uvx code-review-graph@2.3.7 --version
uvx codebase-memory-mcp@0.10.5 --help
uvx --offline --no-python-downloads --no-env-file code-review-graph@2.3.7 --version
```

If `uvx` is missing, `aih heal --scope path` diagnoses the PATH gap and emits
reviewed shell/profile instructions. It does not silently edit shell profiles.

Balanced:

```powershell
aih ecc --cli claude,codex --profile core --posture enterprise
aih ecc --cli claude,codex --profile core --posture enterprise --apply
aih pack scaffold --pack docs-quality --posture enterprise --apply
aih skill vet packs/docs-quality/aih-betterdoc --posture enterprise --apply
aih skill approve packs/docs-quality/aih-betterdoc --owner docs-platform --pack docs-quality --mode review-only --intended-use "Source-grounded documentation editing." --posture enterprise --apply
aih pack install --pack docs-quality --posture enterprise --apply
aih pack validate --pack docs-quality
aih mcp approve figma --accept-egress --reason "Approved Figma remote MCP for reviewed design-context workflows; file permissions remain in Figma." --reviewer design-platform --posture enterprise --apply
```

Powerhouse Mode:

```powershell
aih superpowers --cli claude,codex --posture enterprise --apply
aih usage --cli claude,codex,cursor,zed --posture enterprise --apply
aih track --posture enterprise --apply
aih report --v9 --posture enterprise --apply --out .aih/reports/enterprise-v9.html
aih init . --sidecar --posture enterprise --apply
aih truth verify --posture enterprise
aih truth pack --posture enterprise --apply
aih evidence build --out .aih/evidence-bundle --sign cosign --require-signature --posture enterprise --apply
aih verify-bundle --bundle .aih/evidence-bundle --require-signature
```

### External Skill Authoring And Approval

Use a full commit SHA for every external source. The pins below remain the
previously reviewed examples. On 2026-07-29, newer candidates
`anthropics/skills@b29e7cf65e5cb78a5ac33d582270551bc74a14eb` and
`nextlevelbuilder/ui-ux-pro-max-skill@4857a2c5ef989794751a0f66b8545a4a49566286`
both produced RED, degraded enterprise scans and were not promoted. Re-verify
the source, license, package behavior, and complete detector coverage before
approving any newer commit.

| Source | Pin | Notes |
|---|---|---|
| [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills) | `9d2f1ae187231d8199c64b5b762e1bdf2244733d` | Official Agent Skills examples. Select individual skill folders after license and fit review. |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `12b486b22e67f5d887962ef8351c1ac863bfaeb9` | UI/UX design-assist skill. The upstream repo recommends its CLI installer; treat that CLI as a separately reviewed tool before enterprise use. |

Anthropic skill selection example:

```powershell
$AnthropicSkillsPin = "9d2f1ae187231d8199c64b5b762e1bdf2244733d"
$SelectedAnthropicSkills = @(
  "frontend-design",
  "webapp-testing",
  "mcp-builder",
  "skill-creator",
  "doc-coauthoring",
  "brand-guidelines",
  "internal-comms"
)

git ls-remote https://github.com/anthropics/skills.git HEAD
aih trust scan anthropics/skills --pin $AnthropicSkillsPin --posture enterprise --apply
aih trust allow anthropics/skills --pin $AnthropicSkillsPin --posture enterprise --apply

foreach ($Skill in $SelectedAnthropicSkills) {
  aih skill vet anthropics/skills `
    --pin $AnthropicSkillsPin `
    --name $Skill `
    --posture enterprise `
    --apply

  aih skill approve anthropics/skills `
    --pin $AnthropicSkillsPin `
    --name $Skill `
    --owner platform-ai `
    --pack enterprise-skills `
    --mode review-only `
    --intended-use "Approved Anthropic skill: $Skill. Use only within its reviewed task scope." `
    --posture enterprise `
    --apply
}

aih pack init --pack enterprise-skills --description "Reviewed enterprise skill selection." --posture enterprise --apply
aih pack validate --pack enterprise-skills
```

For multi-skill sources, vet every selected skill with `--name <skill>` before approving it.
A source-wide `aih skill vet` remains useful for broad triage, but it does not satisfy a named
`aih skill approve --name <skill>` gate.

For Anthropic document skills such as `docx`, `pdf`, `pptx`, and `xlsx`, verify the license terms and distribution path before approval. The upstream repo distinguishes open source examples from source-available document capability references.

UI/UX Pro Max authoring example:

```powershell
$UiUxPin = "12b486b22e67f5d887962ef8351c1ac863bfaeb9"
git ls-remote https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git HEAD
aih trust scan nextlevelbuilder/ui-ux-pro-max-skill --pin $UiUxPin --posture enterprise --apply
aih trust allow nextlevelbuilder/ui-ux-pro-max-skill --pin $UiUxPin --posture enterprise --apply
aih skill vet nextlevelbuilder/ui-ux-pro-max-skill --pin $UiUxPin --name ui-ux-pro-max --posture enterprise --apply
aih skill approve nextlevelbuilder/ui-ux-pro-max-skill `
  --pin $UiUxPin `
  --name ui-ux-pro-max `
  --owner design-platform `
  --pack powerhouse-skills `
  --mode design-assist `
  --intended-use "Reviewed UI/UX design assistance. Does not replace design review or design-system ownership." `
  --posture enterprise `
  --apply
aih pack init --pack powerhouse-skills --description "Reviewed design and build skills." --posture enterprise --apply
aih pack validate --pack powerhouse-skills
```

If the organization chooses the upstream CLI installer path, pin and review the npm package and generated files separately. Do not let `npm install -g ui-ux-pro-max-cli` become an unreviewed managed-workstation step.

### MCP Control Examples

`aih mcp approve` records server-name approval, the current server-shape `subject`, egress acceptance, review reason, reviewer, and `approvedAt` in repo-local policy. It does not by itself write custom third-party MCP client config for servers outside the generated AI-Harness catalog. For Figma, Atlassian/Jira, and selected AWS MCP servers, keep a reviewed config template beside the policy and let developers apply it only after policy approval.

| Service | Server key to approve | Reviewed endpoint or source | Developer auth boundary |
|---|---|---|---|
| Figma | `figma` | `https://mcp.figma.com/mcp`; desktop fallback `http://127.0.0.1:3845/mcp` only when approved. | Figma OAuth, plan/seat/file permissions, and explicit file or selection links. |
| Jira / Atlassian | `atlassian` unless the org intentionally names the server `jira` | `https://mcp.atlassian.com/v1/mcp/authv2` | OAuth 2.1 preferred. API token only if Atlassian admin enables it; never commit `JIRA_API_TOKEN`. |
| AWS retired core | `awslabs.core-mcp-server` | Not generated: the latest package depends on an entirely yanked diagram-server distribution. Use the hosted Knowledge endpoint after egress approval, or qualify the Agent Toolkit for AWS successor. | Fresh uv resolution fails; do not preserve a stale cached launch. |
| AWS Knowledge | `aws-knowledge-mcp-server` | `https://knowledge-mcp.global.api.aws` | Remote AWS-hosted endpoint. Review data egress and IAM/org controls. |
| AWS docs/IaC from [awslabs/mcp](https://github.com/awslabs/mcp) | `awslabs.aws-documentation-mcp-server`, `awslabs.aws-iac-mcp-server` | Legacy review source: tag `2026.07.20260728181317` at `536db49a5a5883ab26f8210af90dfc714fee89e7`. For new production adoption, prefer the Agent Toolkit for AWS successor. Package examples in the legacy repo use floating `@latest`; replace them with a reviewed version or internal mirror. | AWS profile/role comes from local environment or SSO, not committed config. |

Approval commands:

```powershell
aih mcp approve figma --accept-egress --reason "Approved Figma remote MCP for reviewed design-context workflows; file permissions remain in Figma." --reviewer design-platform --posture enterprise --apply
aih mcp approve atlassian --accept-egress --reason "Approved Atlassian Rovo MCP for Jira/Confluence work with existing user permissions." --reviewer delivery-platform --posture enterprise --apply
aih mcp approve aws-knowledge-mcp-server --accept-egress --reason "Approved AWS-hosted Knowledge MCP for AWS docs and regional availability lookup." --reviewer cloud-platform --posture enterprise --apply
aih mcp approve awslabs.aws-documentation-mcp-server --accept-egress --reason "Approved local AWS documentation MCP package from reviewed awslabs/mcp source." --reviewer cloud-platform --posture enterprise --apply
aih mcp approve awslabs.aws-iac-mcp-server --accept-egress --reason "Approved local AWS IaC MCP package from reviewed awslabs/mcp source." --reviewer cloud-platform --posture enterprise --apply
```

Use `aih mcp approve --apply` for repo-local policy because it computes the current `subject` and `approvedAt`. If `AIH_ORG_POLICY` is active, update the distributed policy directly; local approval writes are refused because the distributed policy wins. Hand-authored `mcp.approvals[]` entries need `server`, `subject`, `acceptEgress: true`, `reason`, and ISO-8601 `approvedAt`; `reviewer` is optional. Example shape:

```json
{
  "schemaVersion": 2,
  "minimumPosture": "enterprise",
  "references": {
    "repoContract": "ai-coding/project.json"
  },
  "mcp": {
    "allowedServers": ["figma"],
    "approvals": [
      {
        "server": "figma",
        "subject": "mcp-server-sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "acceptEgress": true,
        "reason": "Approved Figma remote MCP for reviewed design-context workflows.",
        "reviewer": "design-platform",
        "approvedAt": "2026-07-08T00:00:00.000Z"
      }
    ]
  }
}
```

Reviewed MCP config template:

```json
{
  "mcpServers": {
    "figma": {
      "type": "http",
      "url": "https://mcp.figma.com/mcp"
    },
    "atlassian": {
      "type": "http",
      "url": "https://mcp.atlassian.com/v1/mcp/authv2"
    },
    "aws-knowledge-mcp-server": {
      "type": "http",
      "url": "https://knowledge-mcp.global.api.aws"
    }
  }
}
```

For clients that require `mcp-remote` for Atlassian, keep that as a client-specific local proxy template:

```json
{
  "mcpServers": {
    "atlassian": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@<approved-version-or-internal-mirror>",
        "https://mcp.atlassian.com/v1/mcp/authv2"
      ]
    }
  }
}
```

Replace the placeholder with an approved version or internal mirror. Do not publish copy-paste enterprise examples that depend on floating `@latest` packages.

For generated local Python MCP servers, AI-Harness starts pinned packages through
`uvx --offline --no-python-downloads --no-env-file`. Warm those packages on each
managed image before expecting MCP clients to start offline:

```powershell
uvx code-review-graph@2.3.7 --version
uvx codebase-memory-mcp@0.10.5 --help
```

### Admin Finalization Checklist

Before handing configuration to developers, verify the admin package from the same repo or distribution location developers will use:

```powershell
aih verify-release $CoreVersion
aih policy validate
aih policy verify --against <trusted-policy-sha-or-bundle>
aih pack validate --pack docs-quality
aih pack validate --pack enterprise-skills
aih pack validate --pack powerhouse-skills
aih marketplace build --out <marketplace-artifact-dir> --apply
aih marketplace publish --dir <marketplace-artifact-dir> --signer cosign --apply
aih marketplace validate --dir <marketplace-artifact-dir> --require-signature
aih evidence build --out <evidence-dir> --sign cosign --require-signature --apply
aih verify-bundle --bundle <bundle-dir> --require-signature
aih verify-bundle --bundle <evidence-dir> --require-signature
```

Then check the handoff material:

- `aih-org-policy.json` is committed or bundled from the admin repo and contains only policy, pins, approvals, and references. Keep it as JSON; `aih` does not execute JavaScript/module policy files.
- Required detectors are available, or the policy does not require them.
- `aih trust skillspector-pin` has been reviewed when SkillSpector is a required detector or a detector pin changes.
- Skill sources are pinned, vetted, approved, and included only through reviewed packs.
- MCP examples use approved server keys such as `figma`, `atlassian`, `aws-knowledge-mcp-server`, or reviewed `awslabs/*` package keys.
- `.mcp.json` or client-specific templates contain placeholders or OAuth endpoints only, not real tokens.
- Marketplace artifacts, bundles, evidence bundles, and container images are signed when policy requires signatures.
- The developer handoff names the admin repo clone path, the `AIH_ORG_POLICY` value, local auth expectations, and the verification commands developers must run.

### Common Use Cases

| Situation | Command path | Why |
|---|---|---|
| A release must be verified before rollout | `aih verify-release <version>` | Checks npm/GitHub/cosign/tarball evidence; rollout requires all three legs to pass, with no skips. |
| Org policy may have drifted | `aih policy validate`, then `aih policy verify --against <sha-or-bundle>` | Separates schema validation from trusted-channel comparison. |
| Enterprise MCP must be constrained | `aih mcp --posture enterprise --mode offline --mcp-compliant --apply` | Writes only policy-allowed generated MCP servers and emits governance guidance for denied ones. |
| Enterprise baseline residue must be surfaced | `aih doctor --posture enterprise` | Attests declared MCP and packaged marketplace surfaces against org policy. |
| Capability needs should not auto-install | `aih capability resolve --posture enterprise --apply` | Records approval-required capability hints without fetching or installing third-party bytes. |
| A skill source needs approval | `aih skill vet <source> --apply`, then `aih skill approve <source> --owner <owner> --pack <pack> --apply` | Records evidence before approval and binds approval to source/pin. |
| A team needs a distributable skill set | `aih marketplace build --out <dir> --apply`, then `aih marketplace publish --dir <dir> --signer cosign --apply`, then `aih marketplace validate --dir <dir> --require-signature` | Packages approved skills, signs the distribution artifact, and validates artifact integrity. |
| A fleet needs policy/config distribution | `aih bundle --out <dir> --apply`, then `aih verify-bundle --bundle <dir> --require-signature` | Produces and verifies deterministic bundle material. |
| Audit material needs to cross teams | `aih evidence build --out <dir> --sign cosign --require-signature --apply` | Packages governance artifacts and evidence into a verifiable bundle. Use the signer selected by policy. |
| Project-truth assertions need verification | `aih truth verify --posture enterprise` | Fails closed on sidecar drift, invalid assertions, acceptance blockers, or stale agent evidence. |
| Public claims changed | `aih docs-lint` | Enforces claim markers through control-matrix rows and named tests while keeping prose guidance advisory. |
| Multi-repo state needs a governed parent view | `aih workspace link`, `aih workspace snapshot --lock --apply`, `aih workspace report --refresh-children --apply` | Keeps workspace coordination parent-owned and uses explicit child-write opt-ins. |

## 3. Best Practices & Architecture

Separate authoring, enforcement, and evidence. Policy and approvals should be authored through reviewed files or approved distribution channels. The CLI should read committed or signed state and produce verifiable local outcomes.

Prefer pinned and approved inputs. MCP servers, skills, marketplace artifacts, policy bundles, truth packs, and release assets should be declared, pinned, and validated before use in governed environments.

Use enterprise posture to expose residue. `aih doctor --posture enterprise` should surface undeclared MCP servers, missing registries, invalid registry input, undeclared packaged marketplace skills, or policy drift instead of silently tolerating them.

Keep capability cache derived. `enterprise` posture may record approval-required capability hints, but `$HOME/.aih/capabilities/cache.json` is not a policy authority and can be rebuilt from committed manifests.

Use `docs-lint` as a release-quality gate for public claims. Current behavior fails closed on hard claim-ledger orphans; banned-phrase and vague-absolute findings remain advisory unless a local policy treats them as blockers.

Use truth sidecars as staged evidence inputs. The sidecar is external and commit-bound. A verified truth pack can be included in evidence bundles as a hashed artifact, but stale or malformed packs fail closed instead of being indexed.

Keep external tickets tool-neutral when the fix belongs to IT, security, or platform operations. Support templates should describe the blocked internal configuration and requested fix without exposing unnecessary tool internals.

Package evidence intentionally. Use `aih evidence build`, fleet bundles, checksums, and signature requirements when artifacts need to cross team or environment boundaries.

Keep public-state checks portable. Enterprise runbooks should work on Windows, Linux, and macOS using `git`, npm registry reads, browser URLs, or approved HTTP clients. GitHub CLI (`gh`) is useful for approved authenticated reads and GitHub attestation/signing workflows, but it should appear as an optional path beside the portable check.

Keep compliance language scoped. AI-Harness can produce evidence, checks, and policy verification outputs. Those outputs do not by themselves establish SOC 2, HIPAA, SLSA Build L3, legal safe harbor, customer-use claims, production proof, or formal audit completion.

## 4. Pitfalls to Avoid

- Do not bypass corporate TLS/proxy controls to make setup faster. Use `aih certs`, `aih heal`, support templates, or approved platform paths.
- Do not install unpinned hosted MCP servers or external skills into governed repos without approval evidence.
- Do not treat `pack scaffold` or a first-party local path as distribution approval for another repo. Vet and approve the copied source in that repo.
- Do not rely on mutable local caches such as `.aih/` or `~/.aih/` as policy authority.
- Do not expose private telemetry, customer, tenant, or unshipped admin-plane details in public docs or issues.
- Do not treat a missing scanner as a passing scanner when policy requires that detector.
- Do not treat `docs-lint`, reports, truth packs, release provenance, or evidence bundles as formal compliance certification.
- Avoid hidden prerequisites such as `gh`, `jq`, Homebrew, apt, winget, or shell-specific syntax. Name the approved path for each operating system or posture.
- Do not claim compliance, certification, production proof, or audit readiness unless the source explicitly supports it.
