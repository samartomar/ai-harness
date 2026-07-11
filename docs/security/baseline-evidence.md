# Baseline Component Evidence

> Status: shipped security model for `aih ecc`, `aih superpowers`, and
> `aih evidence vet-baseline`.

aih does not treat a repository name, marketplace entry, or successful download
as permission to execute baseline content. ECC and Superpowers are split into
declared components. Each component binds an exact source commit, a fixed list
of source-relative paths, and a deterministic tree hash to analyzer receipts and
a `pass` or `blocked` verdict.

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

- `aih-native@<release-version>` and pinned SkillSpector through Docker are
  required for every declared component;
- `cisco-ai-skill-scanner==2.0.12` through offline `uvx` is additionally required
  for every component whose declared bytes contain a regular `SKILL.md` file;
- SkillSpector is bound to source revision
  `326a2b489411a20ed742ff13701be39ba00063c8` and controlled image digest
  `sha256:ee8a107dfd1c258e0afed303016a4220d174ba54bd1510bf73ed91f2825075ec`.

Analyzer provisioning may fetch those exact inputs. Analyzer execution is
no-egress: SkillSpector runs with Docker `--network none`, a read-only source
mount and root filesystem, and `--no-llm`; Cisco runs with `uvx --offline
--no-python-downloads --no-env-file`. The component scanner uses a path-preserving
projection and does not follow symlinks when deciding whether Cisco is required.
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

Danger-class findings remain a floor at every posture. In particular,
auto-execution hooks, prompt injection, hidden Unicode, and secret findings are
not made installable by selecting `vibe` or adding org evidence for the same
blocked bytes.

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
