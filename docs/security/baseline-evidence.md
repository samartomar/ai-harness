# Baseline Component Evidence

> Status: shipped security model for `aih ecc`, `aih superpowers`, and
> `aih evidence vet-baseline`.

aih does not treat a repository name, marketplace entry, or successful download
as permission to execute baseline content. ECC and Superpowers are split into
declared components. Each component binds an exact source commit, a fixed list
of source-relative paths, and a deterministic tree hash to analyzer receipts and
a `pass` or `blocked` verdict.

## Occurrences, findings, policy, and profile verdicts

These are separate records and must not be read as synonyms:

1. a **raw scanner occurrence** preserves the analyzer, rule, message, location,
   exact source-line value, and occurrence fingerprint, including duplicate rows;
2. a **normalized AIH finding** applies native/contextual semantics and joins
   duplicate raw rows without deleting them;
3. a **policy disposition** assigns `BLOCK`, `REVIEW`, `WARN`, `INFORMATIONAL`, or
   `SUPPRESSED` to one normalized finding;
4. an **active-profile verdict** is calculated only over explicitly selected
   component closure.

`aih evidence vet-baseline` keeps the concise component lock and writes a separate
occurrence sidecar. Its primary output reports source integrity, active profile,
selected components, pass/review/block counts, genuine reasons with source line
and value, the policy decision, and runtime restrictions.

ECC Lean is `ecc-lean-v1`: the installer plus the exact nine-component Lean
allowlist. Superpowers standard is `superpowers-standard-v1`: its plugin runtime
and 14 shipped skills. Every other catalog component remains disclosed as
`DISCOVERED / NOT SELECTED / NOT AUTHORIZED / NOT INSTALLED`; its findings cannot
hold or block the active profile.

## Two evidence tiers

The npm release ships `src/baseline-evidence/vendor-lock.json`. It is generated
once at the release pin, checked for drift in CI, included in `npm pack`, and
covered by the release checksum/provenance/signing envelope. A user seat with an
exact vendor-covered component verifies the source bytes and lock entry; it does
not need to install or rerun the analyzers.

An organization can authorize a newer exact pin or a net-new component with a
GitHub-attested evidence bundle. The org artifact uses the same component schema
and vetter. aih verifies `SHA256SUMS`, verifies the GitHub attestation against the
repository named in org policy, parses the baseline artifact, and requires an
exact source/pin/path/hash match.

Org evidence is an extension, not a waiver. It cannot turn an exact vendor
`blocked` verdict for the same bytes into permission to install. A blocked entry
is useful signed evidence: it means “stop until the upstream bytes or pin change
and vet cleanly.”

## Supported ECC catalog

The v2.9 baseline is English-only. The pinned ECC module snapshot retains all 32
vendor-declared modules for dependency, target, and drift metadata, but the shipped evidence
catalog follows the pinned `full` install profile's 23 canonical English modules. The nine
`docs-*` locale modules are not selected by the supported full profile or scoped component
descriptors, so they are not installed, authorized, or represented as vetted.

This is a support boundary, not reduced scrutiny. Every catalog component still receives the
complete analyzer profile below. A future locale must be introduced as an explicit selected
capability whose install mapping and evidence cover the same bytes; new vendor translation
directories never enter the signed baseline automatically.

## Release analyzer profile

Scanner-free installation from the shipped vendor lock is allowed only because
the release vet records exact analyzer receipts before the lock is written:

- `aih-native@native.<12-hex-digest>` — a content digest over the declared
  native-detector source closure, not the package release version, so a native
  detector change always moves the identity even between release version bumps
  (see `src/baseline-evidence/native-identity.ts`) — and pinned SkillSpector
  through Docker are required for every declared component;
- `semgrep==1.172.0` through its committed uv project is required for every
  declared component;
- `cisco-ai-skill-scanner==2.0.12` through its committed uv project is additionally required
  for every component whose declared bytes contain a regular `SKILL.md` file;
- SkillSpector is bound to source revision
  `34f60308522f45447cd343da0aad77bcea308ad4` and controlled image digest
  `sha256:eb100b229ec5b25f74d5f6c1ac31e2d0466f08dbc0726af4239dccadbd7f1b1c`.

Supplemental locked detectors are not part of the minimum release floor, but
when one completes its receipt is still retained and bound to its exact
committed uv-lock digest. This prevents an available MCP Scanner or Snyk
runtime from becoming an unattributed extra analyzer and keeps local and CI
evidence reproducible.

Analyzer provisioning may fetch those exact inputs. Analyzer execution is
no-egress: SkillSpector runs with Docker `--network none`, a read-only source
mount and root filesystem, and `--no-llm`; Cisco runs with `uv run --project
tools/cisco-skill-scanner --locked --isolated --python 3.12 --offline
--no-python-downloads --no-env-file` through the committed scanner project and
lock; Semgrep uses the equivalent locked, isolated, offline invocation through
`tools/trust-scanners/semgrep`. The explicit Python minor keeps offline cache
selection stable when a newer interpreter is installed for an unrelated helper.
The component scanner uses a path-preserving projection, includes one regular
top-level repository license file for license inheritance, and does not follow
symlinks when deciding whether Cisco is required.
The canonical catalog persists that decision as `skillContent: true`, allowing
the pure release gate to enforce Cisco receipts without a vendor checkout. Vet
discovery and the catalog marker must agree: either a missing required receipt
or an unexpected extra receipt fails verification.

SkillSpector uses exit code 1 when a completed scan contains findings. aih accepts
that exit only when stdout parses as SARIF, then records the receipt and preserves
the findings. Malformed output, missing output, spawn failure, timeout, another
exit code, a missing analyzer, or a wrong analyzer version blocks lock generation.
Because the Docker scan is intentionally networkless, the exact SC4 “OSV.dev
unreachable, using static fallback” note remains visible as incomplete advisory
coverage; actual vulnerable-dependency findings remain blocking. No findings is
not a claim that content is safe.

### Source-wide Cisco execution

Baseline vet inventories Cisco skill inputs once per exact source instead of
rerunning the same skill directory through every overlapping component. The
coordinator creates a deterministic manifest bound to the source commit, the
complete scanner-input tree digest, every skill-directory digest, the Cisco
version and full lock digest, the native policy identity, and the selected
profile. Each worker re-hashes its assigned inputs before and after scanning.
The evidence join refuses a missing, duplicate, unexpected, source-drifted, or
digest-mismatched shard before component verdicts are calculated.
Cisco's volatile SARIF invocation start/end timestamps are removed before
evidence hashing; rules, findings, locations, fingerprints, and non-time
invocation metadata remain intact.

On one host, `AIH_CISCO_SCAN_CONCURRENCY` controls independent Cisco processes
and defaults to four. A value from 1 through 64 is accepted; invalid values fall
back to four. Multi-host execution must provide an explicit dispatcher for
disjoint manifest shards. Requesting multiple shards without a dispatcher fails
closed rather than launching several complete scans on one host. Joined SARIF is
then filtered to each component's declared paths and evaluated in that
component's native context; raw scanner evidence is retained.

## Install-time gate

For a mutating baseline command, aih:

1. resolves the selected components and an exact 40-character source pin;
2. downloads a GitHub tarball into an owner-only quarantine without executing it;
3. validates fetch metadata and rejects links, hard links, path escapes, and
   unsupported tree entries;
4. authorizes each selected component from exact vendor or attributed org evidence;
5. re-hashes the same quarantined tree immediately before constructing install actions;
6. runs only actions that consume that verified checkout, then removes quarantine.

If the tree changes after clearance, the second hash check fails and install
actions are not constructed. ECC dependency preparation uses
`npm ci --omit=dev --ignore-scripts` only after the installer runtime and selected
components clear the gate. Scoped ECC targets construct ECC's manifest plan from the verified
checkout, filter both operations and state preview to the selected component union, and reject
unknown operation kinds. Codex keeps its add-only shared-config merge path and copies only selected
skills/agents; scoped Kiro remains guidance-only because its native installer cannot enforce this
component boundary.

Selected validated MCP configuration is generated from aih's pinned catalog, not ECC's mutable
defaults. Project-local config receives the current project's selection; global config receives the
registered machine union. Context7, Exa, and other egress-bearing servers are never defaulted by
this path. The component ledger, including evidence tier/issuer/hash provenance, is atomically
committed only after all install steps succeed.

Prune consumes that provenance-bearing ledger as a primary machine store but never treats the
ledger alone as permission to delete a path. A shrinking home target must also have strict ECC
install state, and every mutation is limited to a state-recorded managed operation or an exact aih
Codex managed block. Planning hashes the ledger, state, destinations, and shared config; apply
revalidates those bytes and rejects links, path escapes, malformed ownership markers, and drift.
Target state commits before the ledger, with rollback restoring all prior bytes if any step fails.

Superpowers marketplace and plugin-picker flows cannot currently prove that the
installed bytes came from a verified local checkout. aih therefore runs no
mutable Antigravity, Copilot, marketplace, or TUI install. It emits guidance that
names the reviewed pin and explicitly says the marketplace selection is not
evidence-covered. The Kiro methodology steering bridge is generated by aih and
is labeled first-party rather than Superpowers vendor evidence.

## Posture behavior

| Evidence result | vibe | team | enterprise |
| --- | --- | --- | --- |
| Exact `pass` from vendor or org | allow | allow | allow |
| Missing component or hash/path mismatch | warn; no authorization receipt | deny | deny |
| Exact `blocked` verdict | deny | deny | deny |
| Invalid configured org bundle/signature | deny | deny | deny |

Danger-class findings remain a floor at every posture. In particular, unpinned
executable dependencies, destructive automatic execution, genuine credential
extraction, actual hidden/control Unicode, source drift, and unavailable
mandatory coverage are not made installable by selecting `vibe` or adding org
evidence for the same blocked bytes. Review-required findings may be accepted
only by exact occurrence fingerprints against the reviewed source commit,
component tree, analyzer versions, policy version, and profile. Any drift voids
the decision. Legacy code-only acceptance does not match the corrected policy,
and acceptance is never used to hide a detector bug. Visible Unicode and other
warning findings remain disclosed without blocking.

## Vet and sign an org override

Vet either the whole catalog or an explicit component subset. The source must be
the catalog repository at the declared exact commit; a local checkout's `HEAD`
must equal `--pin`.

```bash
aih evidence vet-baseline affaan-m/ECC \
  --pin <40-character-sha> \
  --catalog ecc \
  --components runtime:ecc-installer,module:optimization-workflows \
  --apply

aih evidence build \
  --out .aih/org-evidence/ecc \
  --sign gh \
  --require-signature \
  --apply
```

The vet command installs nothing. It writes a typed report below
`.aih/baseline-reports/`; `evidence build` indexes that report as
`baseline-evidence` and signs the bundle checksum file. Distribute the bundle
through the repository or another reviewed channel, then bind it in
`aih-org-policy.json`:

```json
{
  "schemaVersion": 1,
  "minimumPosture": "team",
  "references": { "repoContract": "ai-coding/project.json" },
  "trust": {
    "baselineOverrides": [
      {
        "catalog": "ecc",
        "owner": "affaan-m",
        "repo": "ECC",
        "pinnedSha": "0123456789abcdef0123456789abcdef01234567",
        "bundle": ".aih/org-evidence/ecc",
        "signingRepository": "acme/engineering-governance",
        "reason": "Reviewed newer ECC baseline for the platform team",
        "reviewer": "security@example.com",
        "approvedAt": "2026-07-10T12:00:00.000Z"
      }
    ]
  }
}
```

`signingRepository` is the GitHub repository identity accepted by
`gh attestation verify`; it is not a display label. Bundle paths must be contained
repo-relative POSIX paths. Use catalog `superpowers`, owner `obra`, and repo
`Superpowers` for a Superpowers override.

## Maintainer drift check

The vet-once workflow checks out both canonical upstream SHAs, runs the same
vetter, and fails when component hashes, analyzer receipts, or verdicts drift. It
reproducibly builds the controlled SkillSpector image, proves the exact Cisco
package can execute offline, and never commits regenerated evidence. The pure
`check:baseline-analyzers` gate also runs in normal verification and before
release packaging, so a stale or partial receipt set cannot reach a cut.

```bash
npm run baseline:check -- \
  --ecc-root /path/to/exact/ECC \
  --superpowers-root /path/to/exact/Superpowers
```

Use `npm run baseline:vet -- ...` only when intentionally regenerating the lock
for a reviewed pin change. A release or pin bump must review the resulting lock
diff; a signed `blocked` entry is not a successful install baseline.

### Incremental reuse and `--full`

By default, `baseline:vet` and `baseline:check` reuse a component's prior receipt
verbatim when its content hash and every required analyzer identity are
unchanged from the lock currently on disk, and rescan only what changed. Every
run prints a `baseline reuse [...]` summary naming what was reused and what was
rescanned, and why. `--full` (`npm run baseline:vet -- --full` /
`baseline:check -- --full`) disables reuse and rescans every component from
scratch; CI's vet-once workflow always passes `--full`, so it remains the
from-scratch ground truth that routine incremental reuse trades away for
speed. Reuse never fabricates: a spliced receipt is byte-identical to the prior
one, and a `blocked` verdict can never flip to `pass` without an actual
rescan.
