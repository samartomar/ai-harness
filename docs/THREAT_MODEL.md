# aih Threat Model

> Status: shipped threat model for the open-source CLI. Report gaps privately via
> GitHub Security Advisories.

## Protected Assets

- Developer workstations and local repos.
- Committed AI canon, policy, lock files, and generated bootloaders.
- Skill approval evidence and marketplace artifacts.
- Baseline component catalogs, vendor locks, and org-signed override bundles.
- Local run ledgers and support bundles.
- AIH-owned methodology generation bytes, receipts, transaction journals, and
  the complete generation-selection record under the fixed project store.
- Release artifacts and checksums.
- Secrets, tokens, private keys, and sensitive environment files.

## Actors

- **Developer/operator:** intentionally runs `aih` commands.
- **Repo contributor:** can propose code, config, docs, and skill metadata.
- **External skill author:** controls a remote skill/plugin/source repo until it
  is pinned and approved.
- **Compromised dependency or mirror:** can serve unexpected package bytes.
- **Corporate network controls:** can block or intercept TLS/package traffic.

## Trust Boundaries

- CLI flags, env vars, repo files, policy files, package metadata, tar entries,
  downloaded source trees, and MCP configs are untrusted input.
- Org policy is trusted only when it comes through the repo default
  `aih-org-policy.json` or is verified against an operator-provided hash or bundle
  (`aih policy verify --against <sha256|bundle>`). `AIH_ORG_POLICY` is supported as
  an explicit override, but doctor/report surface it as a visible integrity signal.
- `.env*` and `secrets/**` are out of scope for reading; the harness validates
  their presence and writes deny rules instead.
- Symlinks in extracted or fetched trees are contained by realpath checks. A
  symlink may exist only when the resolved target stays inside the trusted root.
- Optional detectors such as SkillSpector, Cisco skill-scanner, Semgrep, Snyk
  Agent Scan, AgentShield, and mcp-scanner are advisory analyzers. Missing
  analyzers produce explicit skips unless policy requires them.
- The core CLI has no default phone-home path and does not transmit telemetry by
  default. Network-capable behavior is limited to named operator-invoked surfaces:
  release verification, source acquisition/trust flows, signing/attestation,
  explicit TLS probes, and generated telemetry assets that the operator runs.

## Baseline methodology projection boundary

The internal Phase 4 store is designed for crashes and interruption, multiple
cooperating AIH processes, stale plans, exact-byte drift, accidental external
edits it detects, path escape, destination collision, incomplete generations,
malformed ownership, hostile payload bytes treated as inert data, and path or
link anomalies observable through bounded Node `lstat`, `realpath`, descriptor,
device/identity, and link-count checks. Those checks reject symbolic links, hard
links, and junction/reparse aliases when Node reports a link, changed realpath,
changed device or identity, or a non-single-link file; they do not claim to
enumerate every reparse form. The store uses a fixed AIH-owned project root,
private staging, content-addressed generations that the library never edits in
place, bounded inventories and tree walks, canonical targets, one-link regular
files, a cooperative lock, a durable journal, and a complete old/new
generation-selection record.

Apply never edits an existing generation in place, so prior generation bytes
remain intact on failure. An interruption around atomic selection replacement
may leave either complete old selection bytes or complete new selection bytes;
recovery verifies whichever selection is present and does not promise that the
old selection remains selected on every failure. Inspection detects
unclassified or changed owned state. Clean accepts only one exact inactive
digest and retains unknown, active, drifted, linked, incomplete, or uncertain
objects rather than deleting them. POSIX reopen also rejects group/other-writable
directories and group/other-writable or executable files.

The baseline does not protect against a malicious process already running with
the same OS identity and write authority over the store. It provides
transactional integrity, containment, deterministic verification, and detection
of changes observable through the checks above within that cooperative boundary;
it is not tamper-proof against a compromised user account. A stronger enterprise
projector needs a broker, protected mount, sandbox, or dedicated OS identity; a
same-process native addon does not create that authority separation.

This boundary is an unwired library only. It adds no provider or host read or
execution, host-native projection, apply/clean CLI, installation, or shipped
switching behavior.

## Primary Threats and Controls

| Threat | Control |
| --- | --- |
| Prompt-injection or hidden Unicode in skills | `aih trust`/`aih skill vet` scan source text and emit findings before approval. |
| Dependency confusion | `trust.internalScopes` lets orgs name private scopes; absent scopes stay inert instead of guessing. |
| Path traversal or symlink escape in fetched sources | Quarantine extraction and trust-tree checks reject escaping paths and links. |
| Unreviewed skill install | Team/enterprise posture blocks installs without committed approval and matching pin. |
| Mutable or swapped ECC/Superpowers install bytes | Baseline commands fetch exact pins into quarantine, require per-component vendor/org hash evidence, and re-hash before constructing install actions. |
| Forged or stale baseline override | Org evidence requires bundle checksums plus a GitHub attestation from the repository named in strict org policy; source, pin, paths, and hashes must all match. |
| Attempt to waive dangerous baseline findings | Exact `blocked` evidence denies at every posture; org evidence cannot replace a vendor-blocked verdict for the same bytes. |
| Remote mutation by automation | The action model is local-only except explicit signing/provenance flows. |
| Secrets exposure | Secret paths are denied to agents and checked with `aih secrets --verify`. |
| Supply-chain release drift | `aih verify-release` checks npm signatures, release checksums, cosign bundle, and tarball hash. |
| Tampering with local audit logs | Logs are local diagnostics; `aih evidence build` packages checksummed evidence for sharing. |
| Policy source drift or override tampering | `aih doctor`/`aih report` surface active policy source and HEAD drift; `aih policy verify --against <sha256|bundle>` pins the trusted channel. |
| Missing evidence or fleet-bundle signature in gated environments | `aih evidence build --require-signature` and `aih verify-bundle --require-signature` fail with coded `bundle.signature` findings instead of skipping. |
| Methodology transaction interruption or cooperating writer contention | Private staging, a durable journal, a cooperative lock, complete old/new selection, and idempotent recovery avoid editing already-published generation bytes in place. |
| Hostile methodology paths or bytes | Canonical targets, exact in-memory digests, bounded inventories and walks, and Node-observable realpath, descriptor, device/identity, and link-count checks reject detected escape or link conditions and treat bytes as inert data. |
| Uncertain methodology clean | Exact inactive-generation verification retains the object and reports a fixed finding instead of deleting unknown or changed content. |

## Security Bugs

Report privately if an `aih` command can:

- execute an unexpected command outside the planned local action;
- mutate a remote system outside explicit signing/provenance;
- read, log, or emit secrets from denied paths;
- approve or install an unpinned/unapproved external source at team or enterprise posture;
- execute ECC/Superpowers bytes that do not match exact component evidence, or accept an
  unattributed org baseline override;
- accept a path traversal, symlink escape, malformed policy, or malformed bundle;
- let the internal methodology store write outside its fixed project root;
- publish a partial or corrupt methodology generation-selection record; or
- delete a methodology object that its bounded checks classified as unknown,
  active, drifted, linked, or uncertain.

A malicious same-user writer is outside the baseline methodology boundary and is
not listed here as a property this library claims to defeat.
