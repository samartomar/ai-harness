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

### Enterprise org-evidence boundary

At Enterprise posture, an exact organization override is required for the
selected catalog, owner, repository, and live pinned SHA before packaged vendor
evidence is read. Missing evidence, or an override for the same source at a
different pin, returns the blocking `baseline.org-evidence-required` check. A
same-source stale result identifies only the first declared stale override, its
declared pin, and the live pin, then directs the operator to re-vet and update
the override. Vibe leaves the existing packaged-evidence fallback available
when no exact org override is configured.

An exact override still follows the existing bundle checksum, attestation, and
artifact validation path. To remediate an Enterprise absence, the override
names `catalog`, `owner`, `repo`, `pinnedSha`, `bundle`, `signingRepository`,
`reason`, `reviewer`, and `approvedAt`.

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
- `semgrep==1.173.0` through its committed uv project is required for every
  declared component;
- `cisco-ai-skill-scanner==2.0.13` through its committed uv project is additionally required
  for every component whose declared bytes contain a regular `SKILL.md` file;
- SkillSpector is bound to source revision
  `2d198ab910add401cad658d1087e7c7ba24fd640` and controlled image digest
  `sha256:c5d4a1816419f129ae85ff96b3e366d4a062c1859997e26b7ab87341a43d4800`.

Supplemental locked detectors are not part of the minimum release floor and do
not enlarge the deterministic component-receipt closure. When one completes,
aih still resolves its execution-time identity from the exact committed uv-lock
digest and rejects an unattributed analyzer. Component receipts retain only the
required analyzer set so optional local availability cannot make the vendor
lock nondeterministic.

Analyzer provisioning may fetch those exact inputs. Analyzer execution is
no-egress: SkillSpector runs with Docker `--network none`, a read-only source
mount and root filesystem, and `--no-llm`; Cisco runs with `uv run --project
tools/cisco-skill-scanner --locked --isolated --python 3.12 --offline
--no-python-downloads --no-env-file` through the committed scanner project and
lock; Semgrep uses the equivalent locked, isolated, offline invocation through
`tools/trust-scanners/semgrep`, disables repository-controlled Semgrep and Git
ignore files, and includes unknown extensions. The explicit Python minor keeps offline cache
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

### Vet does not evaluate runtime cost or platform behavior

Every analyzer in the release profile reads bytes. SkillSpector, Semgrep, and
Cisco establish content provenance and static safety; none of them executes the
component, counts the processes it spawns, or evaluates how it behaves on a
specific operating system. A clean receipt set is evidence about *content*, not
about whether the component is operationally sound where it runs.

That gap is not theoretical. The vetted ECC pin
`affaan-m/ECC@623f2c020f052319657674e4e6c29ab5d0ad566b` declares 21 hook entries in
`hooks/hooks.json`, every one registered as a `command` string and none using the
`args` exec form — so the harness runs each through a shell, which then launches
`node`, which spawns the hook itself. Four of those entries sit under matcher `*`
on a tool event that fires on success (two `PreToolUse`, two `PostToolUse`), so
even a `Read` walks that chain four times; a failing call adds the wildcard
`PostToolUseFailure` entry. On Windows the cost is visible rather than merely
wasteful: `node.exe` is a console-subsystem binary, and a child launched from a GUI
parent with no console to inherit gets a freshly allocated one, which appears as a
window for the ~50–150 ms the hook lives. One assistant response measured fourteen.
Every analyzer passed on that same commit, because nothing in the receipt set asks
the question.

Read a receipt set accordingly: passing vet means the declared analyzers scanned
the bytes at that exact source identity. It does not mean the component was
executed, profiled, or exercised on the target platform. Runtime process cost,
per-tool-call spawn fan-out, and platform-specific execution behavior fall outside
the evidence closure and remain an operator judgment.

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

| Evidence result | vibe | enterprise |
| --- | --- | --- |
| Exact `pass` from vendor or org | allow | allow |
| Missing component or hash/path mismatch | warn; no authorization receipt | deny |
| Exact `blocked` verdict | deny | deny |
| Invalid configured org bundle/signature | deny | deny |

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
  "schemaVersion": 2,
  "minimumPosture": "enterprise",
  "references": { "repoContract": "ai-coding/project.json" },
  "governance": { "supportedClis": ["claude"] },
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

## Evidence schema version floor

Every baseline evidence lock declares a `schemaVersion`. This build parses
version 1, and it checks that declared version before it parses anything else in
the artifact.

An attested bundle can carry a lock produced by a newer aih than the one reading
it. Such a lock may name fields or component shapes this build's parser rejects.
aih reports that case as `baseline.evidence-schema-unsupported`, naming the
declared version and the version it parses, and the run stops. The remedy is to
upgrade aih.

The floor exists so that skew is never reported as the absence it would otherwise
cause. Before it, an artifact aih could not parse was skipped, and the run ended
by saying the bundle carried no evidence for the requested pin — which sent the
reader to re-vet a pin that was already vetted. An unreadable artifact now fails
under its own code rather than being passed over, including when another artifact
in the same signed bundle would have parsed.

Editing a lock's `schemaVersion` to get past this is not a workaround: the bundle
attestation and `SHA256SUMS` cover the bytes being edited, so verification fails
first.

## Maintainer drift check

The vet-once workflow checks out both canonical upstream SHAs, runs the same
vetter, and fails when component hashes, analyzer receipts, or verdicts drift. It
pulls the controlled SkillSpector image by digest and verifies that digest, proves
the exact Cisco package can execute offline, and never commits regenerated
evidence. No workflow builds the image; building is the local audit path only. The pure
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

### The vetted identity is one exact upstream commit

Every receipt is keyed to the exact file content at the pinned commit, so the
identity that was vetted is the only identity the evidence covers. Two rules
follow, and both are load-bearing:

1. **Vet what you ship, from upstream.** The pin names an upstream repository and
   a full commit SHA — currently `affaan-m/ECC@623f2c02…` and
   `obra/Superpowers@3dcbd5c4…` in `src/internals/baseline-sources.ts`, recorded
   with their acceptance disposition in `src/internals/external-pin-ledger.json`.
   Any working checkout used to reproduce a baseline — a local clone, a personal
   fork, a CI runner tree — must be on that same commit. A fork sitting on a
   different SHA is a different artifact, and evidence generated from it does not
   describe the shipped pin, however similar the trees look.
2. **Fixes go upstream, not into the pin's blast radius.** When a defect is found
   in a pinned component, the change is raised against the upstream project and
   the pin moves only after the new commit passes a full re-vet with fresh human
   review of every finding. Patching a local or forked checkout in place produces
   a tree no receipt describes; `src/binding/scan-acceptance.json` is keyed to
   exact file-content sha256, so any rebind — even to an upstream merge of the
   that change already vetted on a fork — voids the acceptance set and is its own
   work package, never a pin swap.

The maintainer drift check above exists to enforce exactly this: it re-runs the
vetter against the canonical upstream SHAs and fails on any hash, receipt, or
verdict divergence.

### Incremental reuse and `--full`

By default, `baseline:vet` and `baseline:check` reuse a component's prior receipt
verbatim when its content hash and every required analyzer identity are
unchanged from the lock currently on disk, and rescan only what changed. Every
run prints a `baseline reuse [...]` summary naming what was reused and what was
rescanned, and why. `--full` (`npm run baseline:vet -- --full` /
`baseline:check -- --full`) disables reuse and rescans every component from
scratch. Reuse never fabricates: a spliced receipt is byte-identical to the prior
one, and a `blocked` verdict can never flip to `pass` without an actual
rescan.

### Where the from-scratch vet runs, and when

The from-scratch `--full` vet is **anchored to the pin set, not to a schedule**,
and it does not run in CI.

Every input the vet consumes is content-addressed: sources by commit SHA,
SkillSpector by image digest, the scanner environments by hash-pinned `uv.lock`,
and `aih-native` by a content digest over its own detector source closure.
Between two runs at an unchanged pin set there is nothing that can differ except
the machine. Re-running the scan therefore does not re-test the supply chain; it
samples the runner image. Content-addressed evidence does not expire — a receipt
asserts that these exact bytes, scanned by these exact analyzers, produced this
verdict, and that does not become less true with time.

So the model is two states:

- **Pins unchanged** — the committed evidence *is* the answer. CI proves two
  cheap things: `npm run check:baseline-pins` compares the pin set this build
  declares against the pin set the committed lock recorded, and `baseline:check`
  proves the lock still reproduces from the pinned sources. Neither rescans
  unchanged content.
- **A pin moved** — the committed lock is stale evidence rather than a verdict
  about what ships. `check:baseline-pins` fails closed and names the re-vet as
  the remedy. That re-vet is a required, blocking step, not an advisory one.

`check:baseline-pins` replaces an earlier path-pattern gate that inferred
relevance from which files a diff touched. A path pattern is a proxy; comparing
recorded identities against declared ones is the fact itself, and it catches the
case a path pattern is worst at — the sources are untouched but the analyzer
doing the scanning is no longer the analyzer that scanned.

The pair is also tamper-resistant. Hand-editing the lock's recorded pins to fake
agreement does not work: `baseline:check` then re-derives evidence at those pins
and the receipts do not reproduce.

Because the from-scratch run is now rare and blocking rather than routine, it is
worth making it fast. `baseline:vet --shard <i>/<n> --receipts-out <file>` scans
one slice of each catalog on one host, and `--reuse-from <a,b,c>` merges the
resulting receipt bundles for a single assembly run that re-hashes every
component tree and re-checks every analyzer identity before splicing. Sharding
distributes the cost of producing a receipt and never the authority to assert
one.

Before asking an external dispatcher to fan out those shards, create one static
ECC preflight receipt and carry that file to every shard host and to the fan-in
host:

```bash
npm run baseline:vet -- \
  --ecc-root /path/to/exact/ECC \
  --preflight-only \
  --preflight-receipt-out /path/to/ecc-preflight.json

npm run baseline:vet -- \
  --ecc-root /path/to/exact/ECC \
  --superpowers-root /path/to/exact/Superpowers \
  --shard 1/4 \
  --receipts-out /path/to/shard-1.json \
  --preflight-receipt /path/to/ecc-preflight.json

npm run baseline:vet -- \
  --ecc-root /path/to/exact/ECC \
  --superpowers-root /path/to/exact/Superpowers \
  --reuse-from /path/to/shard-1.json,/path/to/shard-2.json,/path/to/shard-3.json,/path/to/shard-4.json \
  --preflight-receipt /path/to/ecc-preflight.json
```

The static receipt binds the exact ECC checkout and pinned source identity; it
does not run analyzers, vet Superpowers, or authorize an install. Every shard
must provide `--preflight-receipt` with `--shard` and `--receipts-out`, and the
fan-in must provide it with `--reuse-from`. The final assembly boundary
re-validates that receipt before work starts, requires the completed ECC evidence
to carry the same whole-source digest, and re-checks each component hash and
analyzer identity before reusing its evidence. Missing, stale, or mismatched
receipts fail closed.

Both the receipt output and every later receipt input must live outside the ECC
source root. Writing the receipt into the tree would change the bytes it just
attested and make it unusable; resolving through a linked parent into that tree
is refused for the same reason.

The receipt proves the non-executing lexical dependency closure only. Dynamic
adapter compatibility remains behind analyzer evidence: final preview assembly
loads the upstream generator there, repeats the closure check independently,
and validates the generated operations against the code-owned target contract.

This static preflight receipt is distinct from the analyzer-availability
preflight that runs before an ordinary vet; the latter still checks that all
required runtimes are provisioned and fails closed when they are not. Ordinary
non-sharded `baseline:vet` and `baseline:check` invocations remain unchanged
and do not require a receipt. This repository commits no dispatcher, scheduler,
transport, or receipt-collection service: external orchestration owns host
fan-out, file handoff, and invocation of the fan-in command.
