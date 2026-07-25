# Conditional Node TLS Trust Remediation

**Status:** approved design
**Tracking:** GitHub issue #512

## Problem

`aih heal` treats an OS-native TLS success as evidence that Node trust is also
healthy. That inference is false on managed workstations where the OS trusts an
intercepting certificate authority but a Node or Electron runtime uses a
different trust source. The current result can therefore be false-green:
OS-native probes pass while the affected runtime still rejects the served
certificate chain.

The remediation must remain conditional. A healthy workstation must be a no-op,
and `aih` must not export or trust every system certificate merely because one
runtime probe failed.

## Goals

- Compare OS-native and Node TLS results for the same reviewed HTTPS origins.
- Identify the smallest trust configuration that makes the Node probe pass.
- Persist only a configuration that passed a candidate probe.
- Support GUI-launched runtimes on Windows and macOS without weakening TLS
  verification.
- Keep the mechanism tool-neutral and deterministic in tests.
- Preserve dry-run review: detection is read-only; local mutation requires
  `--apply`.

## Non-goals

- Disabling certificate verification.
- Trusting a certificate obtained only from an unverified network connection.
- Modifying remote proxies, gateways, allowlists, or application traffic.
- Diagnosing application-layer request mutation after TLS succeeds.
- Reading application logs, credentials, or organization-specific configuration.
- Adding a new command or public CLI flag.

## Existing seams

The implementation extends existing boundaries instead of adding a parallel
trust subsystem:

- Host adapters continue to own OS trust-store enumeration and persistent
  environment mechanics.
- The runner remains the only subprocess seam and supplies candidate
  environments to child Node probes.
- `certs` continues to own explicit CA extraction and runtime propagation.
- `heal` continues to compare live health signals and conditionally plan repair.
- CLI-specific public endpoint origins, where known, live in the existing CLI
  registry rather than a separate lookup table.

## Detection flow

For each bounded, reviewed HTTPS origin selected by the existing registry,
package-source constants, or configured MCP inventory:

1. Run the existing OS-native TLS probe.
2. Run a Node TLS probe against the same origin with the current environment.
3. Classify the pair:
   - OS pass + Node pass: healthy; no trust mutation.
   - OS fail: network or OS trust remains the upstream blocker; do not invent a
     Node-only repair.
   - OS pass + Node fail: confirmed runtime trust divergence; evaluate
     candidates.
   - Missing probe tool: skip with an explicit typed check.

Probe targets are capped and deduplicated. Derived URLs must be HTTPS origins
without embedded credentials. Tests use reserved example domains and fake
runners; unit tests never contact the network.

## Candidate evaluation

Candidates are tested in increasing order of scope:

1. **System trust candidate**
   - Spawn the child Node probe with `NODE_USE_SYSTEM_CA=1`.
   - Preserve the current environment and any existing extra CA bundle.
   - If every divergent target passes, select this candidate.

2. **Minimal CA bundle candidate**
   - Read public certificates from the OS root stores through the host adapter.
   - Inspect the served peer chain only for public certificate metadata.
   - Match the chain tail to an OS-trusted root using parsed X.509 issuer
     relationships.
   - Build a deterministic, deduplicated PEM bundle from only the matched
     OS-trusted roots.
   - Spawn the Node probe with `NODE_EXTRA_CA_CERTS` pointing at the candidate
     bundle and re-test every divergent target.
   - Select the candidate only when all targets pass.

The served chain is never trusted by itself. A fallback certificate must come
from the OS trust store, and the candidate must pass the live Node verification.
If no candidate passes, `heal` reports the unresolved divergence and emits
read-only diagnostic guidance.

## Apply behavior

Planning performs only bounded read-only probes and trust-store reads. Under
`--apply`, the selected candidate becomes local actions:

- **System trust candidate:** persist `NODE_USE_SYSTEM_CA=1`.
- **Minimal bundle candidate:** atomically write the selected PEM bundle, lock
  it to the current user, and persist `NODE_EXTRA_CA_CERTS=<absolute path>`.

Existing unrelated trust settings remain intact. Re-running the same repair is
idempotent.

Platform persistence:

- **Windows:** write selected values to the current user's environment by
  spawning `setx.exe` directly. Values are literal argv elements and retain the
  existing length guard.
- **macOS:** update the current GUI `launchd` environment and write a
  deterministic user LaunchAgent for login persistence. Plist values are XML
  escaped; no shell interpolation contains untrusted input.
- **Linux:** retain shell-profile persistence. No desktop-session mutation is
  added without a platform-supported user environment seam.

The result tells the operator to fully relaunch affected GUI applications.
`aih` does not terminate or relaunch them. Candidate probes establish Node
runtime behavior; a packaged Electron application may restrict Node environment
controls and therefore remains explicitly unverified until the operator
relaunches and checks that application.

## Explicit `certs` behavior

`aih certs --ca-pattern ... --apply` remains the reviewed, explicit extraction
path. It adds `NODE_USE_SYSTEM_CA=1` to the managed environment block and uses
the shared platform persistence helpers, but it does not silently widen a
subject match into the full OS root store.

Automatic minimal-root selection belongs to `aih heal`, where an OS-pass /
Node-fail divergence and a successful candidate probe provide evidence that the
repair is needed.

## Error handling and security

- Fail closed on malformed or credential-bearing derived origins.
- Skip when Node or the OS probe tool is absent.
- Bound endpoint counts, subprocess timeouts, and captured output.
- Parse certificates with the runtime X.509 parser; reject malformed,
  expired, or non-CA fallback roots.
- Preserve TLS verification and hostname verification in every candidate probe.
- Never emit certificate bodies, workstation paths, endpoint responses, or
  organization identifiers into support text.
- Keep all mutations local and reviewable in the plan.

## Tests

The implementation follows a red-green sequence:

1. OS TLS passes while current Node TLS fails: `heal` reports a divergence.
2. System-CA candidate passes: only `NODE_USE_SYSTEM_CA` is selected.
3. System-CA candidate fails and one OS root matches: the minimal bundle is
   selected and verified.
4. No candidate passes: no trust mutation is planned.
5. Multiple targets requiring different roots produce a stable deduplicated
   bundle.
6. Windows persists literal values without a command-shell wrapper.
7. macOS LaunchAgent output is deterministic, escaped, and idempotent.
8. Healthy OS and Node trust remains a no-op.
9. Missing tools skip without turning a fresh workstation into a failure.
10. Existing `certs`, `heal`, and platform-adapter tests remain green.

The full repository completion gate is `npm run verify`.

## Documentation and release impact

Update the command reference to describe conditional Node trust comparison and
GUI persistence. Add an `[Unreleased]` changelog entry. The change adds no
command, flag, JSON envelope key, or incompatible owned-file schema, so the
committed command-surface fixture does not change.

The expected version classification is `semver:patch`.
