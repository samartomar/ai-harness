# aih Threat Model

> Status: shipped threat model for the open-source CLI. Report gaps privately via
> GitHub Security Advisories.

## Protected Assets

- Developer workstations and local repos.
- Committed AI canon, policy, lock files, and generated bootloaders.
- Skill approval evidence and marketplace artifacts.
- Local run ledgers and support bundles.
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
- `.env*` and `secrets/**` are out of scope for reading; the harness validates
  their presence and writes deny rules instead.
- Symlinks in extracted or fetched trees are contained by realpath checks. A
  symlink may exist only when the resolved target stays inside the trusted root.
- Optional detectors such as SkillSpector, Cisco skill-scanner, and mcp-scanner
  are advisory analyzers. Missing analyzers produce explicit skips unless policy
  requires them.

## Primary Threats and Controls

| Threat | Control |
| --- | --- |
| Prompt-injection or hidden Unicode in skills | `aih trust`/`aih skill vet` scan source text and emit findings before approval. |
| Dependency confusion | `trust.internalScopes` lets orgs name private scopes; absent scopes stay inert instead of guessing. |
| Path traversal or symlink escape in fetched sources | Quarantine extraction and trust-tree checks reject escaping paths and links. |
| Unreviewed skill install | Team/enterprise posture blocks installs without committed approval and matching pin. |
| Remote mutation by automation | The action model is local-only except explicit signing/provenance flows. |
| Secrets exposure | Secret paths are denied to agents and checked with `aih secrets --verify`. |
| Supply-chain release drift | `aih verify-release` checks npm signatures, release checksums, cosign bundle, and tarball hash. |
| Tampering with local audit logs | Logs are local diagnostics; `aih evidence build` packages checksummed evidence for sharing. |

## Security Bugs

Report privately if an `aih` command can:

- execute an unexpected command outside the planned local action;
- mutate a remote system outside explicit signing/provenance;
- read, log, or emit secrets from denied paths;
- approve or install an unpinned/unapproved external source at team or enterprise posture;
- accept a path traversal, symlink escape, malformed policy, or malformed bundle.
