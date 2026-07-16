# Provider taxonomy and alpha selection

> Status: discovery record for the proposed alpha. Upstream repositories can change;
> implementation must re-confirm installer and host behavior from the exact selected
> source before writing an adapter.

## Candidate family

| Provider ID | Canonical source | Primary shape | Initial treatment |
| --- | --- | --- | --- |
| `gsd-pi` | [`open-gsd/gsd-pi`](https://github.com/open-gsd/gsd-pi) | standalone runtime | Later adapter; validates runtime-provider contract. |
| `gsd-core` | [`open-gsd/gsd-core`](https://github.com/open-gsd/gsd-core) | cross-runtime methodology | Later adapter. |
| `gstack` | [`garrytan/gstack`](https://github.com/garrytan/gstack) | hybrid host setup | Phase A qualification subject. |
| `superpowers` | [`obra/superpowers`](https://github.com/obra/superpowers) | methodology/plugin | Later adapter; existing AIH integration remains separate. |
| `ecc` | [`affaan-m/ECC`](https://github.com/affaan-m/ECC) | hybrid catalog/runtime | Phase A qualification subject. |

Legacy mappings:

| Historical source | Status as of 2026-07-15 | Successor treatment |
| --- | --- | --- |
| [`gsd-build/get-shit-done`](https://github.com/gsd-build/get-shit-done) | Archived/read-only | Discovery alias to `open-gsd/gsd-core`; never an implicit source substitution. |
| [`gsd-build/gsd-2`](https://github.com/gsd-build/gsd-2) | No longer active development home | Discovery alias to `open-gsd/gsd-pi`; migration requires explicit approval. |

The legacy mapping is metadata, not trust inheritance. A successor repository has a
different source identity and requires independent evaluation.

## Why ECC and gstack are first

The alpha intentionally selects the pair most likely to expose a flawed isolation
model early.

### Shared pressure

- Both can expose broad, opinionated methodology surfaces rather than one isolated
  skill.
- Both can target host discovery locations under a user's home.
- Both can influence canonical instructions and available workflow tools.
- Both have installation/setup logic beyond static Markdown.
- Both can create ambiguity when installed by more than one path.
- Their combination tests whether AIH can preserve provider-native behavior rather
  than flattening both into a generic workflow.

### ECC-specific questions

- Which exact installation mode supports a project-native or profile-home destination?
- Can hooks, MCP configuration, rules, skills, agents, and commands be disabled or
  redirected independently?
- Does the upstream installer have a deterministic preview that names every write?
- Can updater or repair behavior be disabled under AIH authority?
- Which exact component closure is required for ECC to act as the selected methodology?
- Can activation be verified without treating presence of `AGENTS.md` as proof?
- Does uninstall remove only its own receipt/state-owned paths?

The existing AIH ECC evidence remains relevant evidence input, but the current catalog
result is not blanket authorization for the methodology provider.

### gstack-specific questions

- Which host setup modes are project-local, profile-home, or machine-global?
- Can its installer consume an exact local checkout without pulling or updating?
- Can team-mode update behavior be disabled for a reviewed installation?
- Which browser processes, daemons, Bun/Node dependencies, and child processes are
  required by the chosen surface?
- Can the full methodology be activated without modifying a shared user canon?
- What positive probe proves gstack is loaded on Codex?
- What negative probe proves ECC and other methodology providers are absent?
- Does uninstall restore prior host configuration without deleting user-owned files?

No gstack source is authorized by this design record. Vetting starts only after an
operator selects an exact source commit for the disposable alpha environment.

## First host and environment

The first technical gate is a read-only load-surface study for one exact Codex build
on Windows. It runs before provider adapters because its result bounds whether later
activation research is feasible. A disposable Windows Hyper-V VM or cloud workstation
is required only when a separately authorized manual experiment executes provider
code.

Codex is selected because:

- both selected providers advertise Codex-facing surfaces;
- machine skill discovery pressure is easy to observe;
- the target reflects the maintainer's primary environment;
- profile-home and project-native isolation can be compared directly;
- its load-surface feasibility decides whether the same-PC isolation objective can be
  proved without turning AIH into a runtime.

Linux can follow as a second qualification tuple because provider source assumptions
may differ by OS. Claude Code is a later host-contract study after Codex qualification.

## Provider support levels

AIH reports support per provider and host rather than one repository-wide claim:

```text
discoverable    inventory adapter exists; nothing can be installed
evaluable       exact source can enter the trust/conformance pipeline
plannable       inert source analysis produces a deterministic proposed plan
mutation-research-eligible
                one exact compatibility tuple meets the prerequisites for a
                separately authorized disposable Phase B experiment
deliverable     verified upstream installer can target an approved isolation mode
activatable     host can positively load it and negatively exclude others
switchable      activation can replace another provider transactionally
concurrent      two projects can use different providers at the same time
```

A provider may remain `discoverable`, `evaluable`, or `plannable` indefinitely.
Phase A can reach `mutation-research-eligible`, but it cannot report `deliverable`,
`activatable`, `switchable`, or `concurrent`. Those levels require a separately
authorized Phase B. No provider support level is an AIH core release prerequisite.

## Bounded compatibility claims

AIH does not ship a vendor commit as a product baseline. It also does not claim that
an adapter supports every immutable commit. Qualification is keyed by:

```text
provider repository
resolved provider commit
installer-contract fingerprint
adapter ID, contract version, and implementation hash
host ID and exact version/build
host load-surface contract version and coverage
operating system, version, and architecture
isolation mode
required runtime versions
policy version
```

An unknown tuple fails closed. A later upstream commit is a new compatibility claim,
not an automatic update and not an AIH release blocker.

## Adapter admission checklist

Before adding any later provider, record:

1. Canonical repository and license.
2. Provider kind and persistent state directories.
3. Supported hosts and exact host versions tested.
4. Upstream installer and uninstaller entry points.
5. Exact-source/offline installation capability inferred from inert source analysis;
   Phase A does not invoke the installer to confirm it.
6. Declared write roots, child processes, services, and network behavior.
7. Project-native/profile-home/machine-exclusive isolation classification.
8. Update mechanism and how AIH prevents silent updates.
9. Host load-surface contract, coverage status, and proposed positive/negative probes.
10. Declared rollback and state-preservation assumptions; actual recovery is Phase B.
11. Trust and conformance evidence requirements.
12. Compatibility tuple and known unsupported paths with coded failure results.

Adding a provider must not add a provider-specific branch to core qualification,
policy, compatibility, or status code. If it does, the adapter contract is incomplete.
