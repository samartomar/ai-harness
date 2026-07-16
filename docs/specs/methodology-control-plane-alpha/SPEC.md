# Methodology provider control plane specification

> Status: proposed alpha contract. No commands, files, or behavior in this document
> are shipped by AIH v2.11.0.

## 1. Objective

Phase A is a methodology qualification plane. It determines, without executing
provider code or changing provider-visible state, whether an exact provider source
is trustworthy, conformant, plannable, compatible with an adapter/host tuple, and
eligible for separately authorized mutation research.

The long-term objective remains one provider-native methodology per enrolled host
session, with different projects able to use different providers only when isolation
and complete host visibility are proven. Phase A does not install, activate, switch,
deactivate, or claim concurrent provider support.

ECC and gstack are the first qualification subjects. The design must remain capable
of later qualifying GSD Pi, GSD Core, Superpowers, and additional providers without
adding provider assumptions to the qualification core.

## 2. Product boundary

### AIH owns in Phase A

- strict provider, source, host, compatibility, and intent-proposal validation;
- organization and project policy resolution;
- exact source resolution and trust-evidence joins;
- inert source inspection and pure proposed plans;
- provider and host contract qualification;
- isolation feasibility classification;
- deterministic qualification reporting;
- coded stops for every unknown required fact.

### The provider owns

- methodology content and workflow ordering;
- provider commands, skills, hooks, and state model;
- its installer and uninstaller semantics;
- provider-specific loadability and health probes;
- its license and upstream release lifecycle.

### AIH does not own

- a merged workflow assembled from several provider methodologies;
- an AI agent runtime or LLM client;
- a permanent copy, mirror, or cache of provider source;
- repair of an entire provider repository;
- silent provider selection or automatic upstream updates;
- execution of provider code in Phase A;
- deletion of provider or user files;
- project methodology authority, activation receipts, or host canon in Phase A.

This preserves the repository principle "delegate, do not vendor." Acquisition
quarantine is temporary. Phase A retains no persistent provider source and creates no
installed runtime surface. A future Phase B may delegate to a provider installer only
after a separate authorization and the mutation prerequisites in this specification.

## 3. Authority layers

Authority is ordered and deliberately asymmetric:

1. **AIH policy kernel** — always authoritative for trust, permitted actions,
   source identity, installation boundaries, evidence, and external-action limits.
2. **Project methodology provider** — zero or one enrollment per project; exactly one
   workflow authority only inside an enrolled, verified host session.
3. **AIH auxiliary skills** — zero or many, namespaced and explicitly invoked; they
   may assist but never silently reroute the selected methodology.
4. **Detectors and evidence exporters** — additive deterministic tools governed by
   policy and receipts.

AIH policy can deny provider behavior. It does not rewrite the provider methodology
to make denied behavior appear compliant.

## 4. Cardinality

| Surface | Cardinality | Rule |
| --- | --- | --- |
| Project methodology enrollment | zero or one | Unenrolled is valid; an enrollment contains one provider. |
| Enrolled host session | exactly one | One verified provider owns planning through completion. |
| AIH auxiliary skill | zero or many | Must be namespaced and explicit. |
| Required detector category | at least one | Policy defines the category. |
| Additional detector | many | Independent deterministic checks may coexist. |
| Evidence exporter | many | Must not mutate provider behavior. |
| Provider failover | zero or one ordered policy | Never inferred from failure. |

Provider failover is out of scope. An unavailable qualification subject stops; it
does not cause AIH to choose another methodology.

## 5. Provider kinds

```text
skill-pack          host-native skills or instructions
host-plugin         provider installed through a host plugin mechanism
standalone-runtime  provider supplies its own agent process or control loop
hybrid-runtime      provider combines skills, hooks, commands, config, or services
```

An adapter declares exactly one primary kind and any secondary surfaces. The core
does not infer a provider kind from folder names.

## 6. Future project intent proposal

Phase A may parse this proposed shape from an existing file or an in-memory request,
but it does not create, update, or treat it as runtime authority. The file becomes a
possible Phase B authority only after a separate schema/compatibility decision:

```text
aih-methodology.json
```

Proposed schema shape:

```jsonc
{
  "schemaVersion": 1,
  "provider": {
    "id": "gstack",
    "kind": "hybrid-runtime",
    "source": {
      "type": "github",
      "repository": "garrytan/gstack",
      "requestedRef": "v1.2.0",
      "resolvedCommit": "0123456789abcdef0123456789abcdef01234567"
    },
    "adapter": {
      "id": "builtin:gstack",
      "contractVersion": 1
    }
  },
  "host": {
    "id": "codex",
    "scope": "project",
    "isolationMode": "profile-home"
  },
  "policyProfile": "enterprise-core",
  "auxiliarySkills": [],
  "detectors": [],
  "selection": {
    "selectedBy": "operator@example.invalid",
    "selectedAt": "2026-07-15T00:00:00.000Z",
    "reason": "Evaluate gstack as this project's methodology"
  }
}
```

The example identity is fictional. No provider version is approved by this document.

Rules:

- `resolvedCommit` is a full immutable source identity, never a floating ref.
- `requestedRef` records operator intent and is not execution authority.
- source identity changes require a new qualification.
- the file contains one provider only.
- unknown fields are rejected in alpha schemas unless the compatibility decision
  explicitly says otherwise.
- Phase A never writes the file and never reports the provider active.
- a fresh clone with valid intent but no Phase B journal/receipt is
  `selected-but-inactive`; `status` is non-mutating and activation verification is
  non-successful.

The existing `aih-skills.lock.json` remains the approval authority for independently
installed external skills. It does not become the methodology activation authority.
The alpha must document any join rather than silently inheriting approval by name.

## 7. Phase A qualification report

Phase A returns a deterministic `QualificationReport`. It may be printed as JSON or
packaged later through existing evidence mechanisms, but the first slice does not
write project authority or activation receipts.

Required report fields:

- schema version, AIH version/source identity, and report timestamp;
- provider repository, requested ref, resolved commit, and inert tree hash;
- trust/conformance evidence identities and results;
- adapter ID, contract version, and implementation hash;
- installer entry-point identity discovered without execution;
- compatibility key and support decision;
- proposed destinations, processes, services, network, updater, runtime, and
  uninstall assumptions derived from source;
- host load-surface contract identity and coverage;
- pure proposed plan and plan digest;
- support level, findings, safe next actions, and go/no-go result.

Reports contain hashes and paths, not environment values, secrets, prompts, or user
content.

### Future Phase B receipts

Activation receipts are deferred. If Phase B is authorized, the proposed location is:

```text
.aih/methodology/receipts/<transaction-id>.json
```

Required receipt fields:

- schema version and transaction ID;
- AIH package version and source commit;
- project root digest and intent-file digest;
- policy source, profile, policy hash, and applicable rule IDs;
- provider ID, kind, repository, requested ref, and resolved commit;
- adapter ID, contract version, and implementation hash;
- source component paths and source tree hash;
- trust verdict and evidence identity;
- provider installer identity and invocation digest;
- installer environment allowlist digest;
- declared and observed destination paths;
- before and after destination tree hashes;
- host ID, version, config root, and isolation mode;
- selected-provider positive activation checks;
- non-selected-provider negative activation checks;
- update mechanism state;
- prior receipt and rollback receipt references;
- start/end timestamps and final state;
- failure code and recovery action when not successful.

Receipts must never contain environment values, secrets, prompts, or user content.
They are derived from a terminal write-ahead journal state and never serve as the
journal itself.

## 8. State and support model

The internal state axes remain separate:

```text
trust:       pass | held | blocked | unknown
conformance: pass | fail | unknown
delivery:    exact-source | approved-derivative | guidance-only | none
host:        supported | unsupported | unknown
policy:      allowed | denied
isolation:   proven | conflict | unsupported | unknown
activation:  inactive | staged | materialized | loaded | verified | drifted
```

Phase A additionally reports a support ladder:

```text
discoverable
evaluable
plannable
mutation-research-eligible
deliverable
activatable
switchable
concurrent
```

Phase A can reach no higher than `mutation-research-eligible`. It never derives
`resolvable` or `active`; those formulas are Phase B design targets.

Derived states:

```text
resolvable =
  trust == pass
  AND conformance == pass
  AND delivery IN {exact-source, approved-derivative}
  AND host == supported
  AND policy == allowed
  AND isolation == proven

active =
  resolvable
  AND activation == verified
```

`guidance-only` is never active. `loaded` without negative conflict proof is never
verified. A blocked trust verdict cannot be changed by a more permissive posture.

## 9. Isolation feasibility modes

| Mode | Meaning | Phase A treatment |
| --- | --- | --- |
| `project-native` | Host/provider claims project-local loading. | Qualify claim against host contract; do not activate. |
| `profile-home` | Host claims a redirected configuration home. | Qualify claim against host contract; do not launch. |
| `standalone` | Provider supplies a project-bound runtime. | Record for later provider research. |
| `machine-exclusive` | Provider requires a shared machine discovery location. | Not eligible for concurrent research. |
| `unknown` | Isolation cannot be proven. | Fail closed. |

Phase A may describe a proposed environment block but does not launch a host or write
provider content. `project-native` or `profile-home` is not proven merely because a
provider README claims it; it requires a complete versioned host load-surface contract
and later disposable research.

## 10. Provider adapter contract

The exact TypeScript interface is an implementation decision, but it must preserve
the following Phase A typed operations:

```text
describe()             static identity, provider kind, supported hosts
discover(source)       inventory only; never executes provider content
resolveLocal(source)   immutable local commit/tree identity
evaluate(source)       trust and conformance inputs
fingerprint(source)    installer-contract fingerprint without execution
planProposed(context)  pure proposed actions, dependencies, and boundaries
qualify(context)       support level, findings, and go/no-go result
```

Provider code is data in every Phase A operation. An upstream installer preview or
dry-run is still provider-code execution and is prohibited.

Future Phase B operations such as `planInstall`, `planDeactivate`, `verifyLoaded`,
`verifyAbsent`, and `inspectDrift` are not part of the Phase A adapter contract.

Every result uses a deterministic envelope:

```jsonc
{
  "status": "success | warning | error",
  "summary": "one-line result",
  "nextActions": [],
  "artifacts": [],
  "findings": []
}
```

Error results include a root-cause hint, safe retry instruction, and explicit stop
condition. Adapters cannot return raw prose as their only protocol.

## 11. Bounded compatibility key

Every adapter support decision uses this immutable tuple:

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

An exact commit outside a known tuple is not automatically supported. Unknown tuples
fail with `ADAPTER_COMPATIBILITY_UNKNOWN`; known incompatible contracts fail with
`PROVIDER_CONTRACT_UNSUPPORTED`.

This tuple is not a vendor baseline pin. AIH does not bundle, select, approve, or
require one vendor commit for its release. It bounds only a specific support claim.

## 12. Host load-surface contract

Each qualified host version records:

```text
host executable identity and build
project instruction precedence
global instruction precedence
skills and plugin discovery paths
hook discovery paths
MCP and configuration discovery paths
environment-variable and command-line overrides
profile-home semantics
cache and session persistence
inherited configuration behavior
positive probe procedure
negative probe procedure
coverage: complete | partial | unknown
```

Only `complete` coverage can later contribute to activation verification. `partial`
or `unknown` caps the provider at `mutation-research-eligible`. Filesystem inventory,
canon markers, or provider-authored probes alone do not establish completeness.

The Codex load-surface feasibility experiment is the first technical gate in the
delivery plan. If a complete or defensibly bounded contract cannot be established,
the plan must not proceed toward product mutation commands.

## 13. Phase B installer delegation prerequisites

This section is non-normative for Phase A. Phase A invokes no provider installer.
Manual disposable experiments can gather evidence, but they are a research runbook,
not a product command or support claim.

Before a separately authorized Phase B adapter invokes an upstream installer, all
compatibility, trust, conformance, policy, host coverage, external containment, and
isolation prerequisites must pass.

Required properties:

1. Installer entry point is contained in the exact verified source checkout.
2. Working directory is the verified source root.
3. Environment variables are allowlisted; secrets and unrelated host config are not
   inherited.
4. Destination roots are declared before execution.
5. Floating package or repository acquisition is not performed during apply.
6. Network behavior is declared and denied when policy requires offline apply.
7. Child processes and services are declared.
8. Before/after destination inventories are captured as evidence, not treated as
   confinement.
9. Unexpected writes, update agents, daemons, or shared-home mutations taint the
   research environment; snapshot destruction is required when restoration cannot be
   positively proven.
10. Provider bytes are not copied into the AIH package or a permanent AIH source
    cache.

An adapter that cannot meet the contract can remain discoverable, evaluable, or
plannable. It is not deliverable.

## 14. Phase B bounded authority transition

"Atomic activation" is not an acceptable claim across arbitrary provider processes,
registries, services, caches, or browser state. Phase B may research a bounded
authority transition only after it defines and tests:

- a durably flushed write-ahead journal before first mutation;
- project, profile/config-root, destination, and authority locks;
- transaction, machine, and process ownership plus lease renewal/expiry rules;
- states `prepared`, `staging`, `pending_activation`, `committing`,
  `rolling_back`, `rolled_back`, `tainted`, and `abandoned`;
- restart reconciliation that never infers success from missing files;
- pending activation that does not make staged bytes authoritative;
- a one-time fresh-session nonce bound to host build, config root, and load evidence;
- positive selected-provider and negative non-selected-provider attestation over a
  complete host contract;
- terminal environment-taint behavior when prior state cannot be reconstructed;
- receipts derived from terminal journal state.

Two concurrent transactions contending for the same project, profile, destination, or
authority lock must deterministically reject one. Stale locks are reconciled through
the journal and lease contract, never guessed away.

AIH does not modify a running host session and does not claim that instructions already
loaded into that session were unloaded. A fresh-host handshake is mandatory. A crash
while the new provider is staged but old intent remains produces a recoverable pending
state or `ENVIRONMENT_TAINTED`, never an active claim.

## 15. Future canonical behavior

AIH owns a small marker-delimited provider declaration in repo canon. It contains:

- active provider ID and exact source identity;
- provider-native bootstrap entry point;
- statement that the selected provider owns workflow ordering;
- names of explicitly enabled AIH auxiliary skills;
- AIH policy precedence for trust and external actions;
- instruction to fail rather than invoke another methodology.

The declaration must not inline a provider's full manuals or translate its workflow
into a generic AIH lifecycle. Provider instructions remain in provider-owned paths.

Canon verification checks marker ownership, intent hash, provider identity, and absence
of stale declarations. It is necessary but not sufficient for activation verification.

Phase A writes no canonical provider declaration. This section applies only after a
Phase B authority model is separately authorized.

## 16. Phase A proposed command surface

The smallest additive qualification surface is:

```text
aih methodology inspect <provider> --source-root <path> [--json]
aih methodology plan <provider> --source-root <path> --host <host> [--json]
aih methodology qualify <provider> --source-root <path> --host <host> [--json]
aih methodology status [--json]
```

Rules:

- all commands are non-mutating in the first slice;
- provider source is an operator-supplied exact local checkout;
- provider files are inspected as inert data;
- no upstream preview, dry-run, setup, doctor, or installer command executes;
- remote source acquisition is deferred;
- `status` reports enrollment proposal, latest supplied qualification result, and
  support level without claiming installation or activation;
- no command writes `aih-methodology.json`, provider-visible host state, canon, an
  activation receipt, or a provider cache;
- no command silently repairs, upgrades, activates, or chooses another provider.

The command names are proposed. Adding them is a minor-compatible contract change but
requires the command-surface fixture, commands documentation, and changelog updates.
`use`, `deactivate`, `switch`, and any provider `--apply` semantics are deferred.

## 17. Error codes

Minimum stable machine codes for the alpha:

```text
METHODOLOGY_INTENT_INVALID
PROVIDER_UNKNOWN
PROVIDER_SOURCE_UNRESOLVED
PROVIDER_TRUST_HELD
PROVIDER_TRUST_BLOCKED
PROVIDER_CONFORMANCE_FAILED
ADAPTER_COMPATIBILITY_UNKNOWN
PROVIDER_CONTRACT_UNSUPPORTED
HOST_LOAD_SURFACE_UNKNOWN
HOST_UNSUPPORTED
ISOLATION_UNSUPPORTED
ISOLATION_CONFLICT
UNOWNED_PROVIDER_CONFLICT
INSTALLER_CONFINEMENT_UNPROVEN
PROVIDER_SELF_UPDATE_ENABLED
QUALIFICATION_PLAN_NONDETERMINISTIC
QUALIFICATION_INCOMPLETE
```

Phase B may later define `INSTALLER_UNEXPECTED_WRITE`,
`NON_SELECTED_PROVIDER_LOADED`, `SWITCH_REQUIRES_FRESH_SESSION`,
`ROLLBACK_REQUIRED`, and `ENVIRONMENT_TAINTED`. They are not Phase A outcomes.

Each failure reports considered provider, project, host, safe next action, and evidence
path. It never reports fallback, installation, or activation as attempted.

## 18. Status output

Human output is concise:

```text
Qualification subject: gstack
Project enrollment: none
Source: garrytan/gstack@<full-sha>
Trust: pass
Plan: deterministic
Compatibility: unknown
Host load-surface: codex/<build> — partial
Isolation feasibility: profile-home — unproven
Support level: plannable
Mutation research: not eligible
Provider code executed: no
```

JSON includes every qualification axis, finding code, compatibility key, adapter and
host-contract identities, proposed plan digest, and timestamp. Human words are not a
machine protocol.

## 19. Existing v2 behavior and migration

The alpha is additive:

- `aih init` behavior is unchanged;
- `aih ecc` and `aih superpowers` remain unchanged and are not silently redirected;
- current baseline evidence remains valid for its existing commands;
- no vendor is selected by default;
- no existing global install is adopted automatically;
- the methodology alpha cannot claim an installation made by legacy commands;
- existing provider surfaces may be described by non-mutating host qualification,
  but Phase A does not remove, adopt, or activate them.

Stable migration or deprecation of baseline terminology is a later decision. It must
follow AIH's alias-before-removal and major-version rules where covered surfaces would
be removed or changed incompatibly.

## 20. Security and privacy boundaries

- No secrets are read from `.env*`, credential stores, or provider configuration.
- Manual real-provider research uses disposable identities and contains no customer
  data.
- Logs record hashes, paths, codes, and process identities, not prompts or source
  contents.
- Acquisition is read-only and quarantined; Phase A executes no provider code.
- Manual installer experiments are outside the product command and restricted to
  disposable environments; an unexpected mutation taints and destroys that snapshot.
- Remote publishing, repository mutation, and provider marketplace changes remain
  outside the normal action model.
- Host coverage cannot be declared complete from provider prose, filesystem inventory,
  or a provider name found in canon.

## 21. Decisions deferred beyond Phase A

- signed organization distribution of provider adapters;
- remote GitHub/package acquisition for methodology use;
- project methodology authority and activation receipts;
- any provider installer execution through an AIH product command;
- bounded authority transition, deactivation, rollback, and concurrency;
- ordered failover sets;
- standalone-runtime support for GSD Pi;
- stable migration of existing ECC/Superpowers baseline commands;
- fleet rollout and MDM delivery;
- cross-host semantic conformance benchmarks;
- UI/report visualization beyond the structured status envelope.
