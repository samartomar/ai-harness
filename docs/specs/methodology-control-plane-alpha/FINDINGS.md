# Critical findings and design drivers

> Status: design evidence for the methodology control plane alpha. These are
> architecture findings, not claims that the proposed controls are already shipped.

## Severity model

- **Critical** — can execute or expose the wrong provider, cross project
  boundaries, or present an unverified state as active.
- **High** — can produce persistent conflict, uncontrolled drift, or a design that
  cannot support the stated multi-provider goal.
- **Medium** — increases maintenance or migration risk but has a contained failure
  path.

## Findings

### MCP-001 — Shared machine discovery paths defeat project selection

**Severity:** critical

**Problem:** Upstream installers commonly target automatically discovered machine
locations such as a user-level skills, plugin, hook, or configuration directory.
If ECC and gstack both write to the same host home, a project-local canon file does
not prevent both surfaces from being visible.

**Impact:** Project A can unintentionally load Project B's methodology. Concurrent
sessions can receive different behavior from what their committed intent declares.
Removing one provider may also delete files another project still uses.

**Required control:** No activation may proceed until the adapter proves one of the
supported isolation modes in [SPEC.md](SPEC.md). Activation verification must include
a negative inventory proving that non-selected methodology providers are absent from
the runtime-visible surface.

### MCP-002 — Component-level workflow mixing destroys methodology authority

**Severity:** critical

**Problem:** Resolving planning from one provider, TDD from another, and completion
discipline from a third creates a new, unowned methodology. Each provider's ordering,
state, terminology, and recovery assumptions can conflict.

**Impact:** The user does not receive the value of the selected provider, prompt
precedence becomes ambiguous, and failures cannot be attributed to one methodology.

**Required control:** `methodology` has cardinality `exactly-one` per project and
host session. AIH auxiliary skills are namespaced and explicit. Deterministic
detectors can remain additive because they do not direct the workflow.

### MCP-003 — Source trust, delivery, load, and activation are different facts

**Severity:** critical

**Problem:** An exact source can be scanned successfully without being deliverable
through an exact-source installer. Files can be materialized without the host loading
them. A host can load both the selected and an unintended provider.

**Impact:** A green source verdict can be misreported as an operational provider.

**Required control:** Track trust, conformance, delivery, host support, policy, and
activation separately. `active` is true only after positive selected-provider proof
and negative non-selected-provider proof.

### MCP-004 — Arbitrary upstream installers exceed an in-process path guard

**Severity:** critical

**Problem:** Once an arbitrary installer process executes with the developer's
permissions, AIH cannot guarantee containment merely by checking intended paths.
Installers can spawn children, use the network, mutate shared homes, or persist an
updater.

**Impact:** A trusted source with an unconstrained installer can still escape the
planned destination or make later unreviewed changes.

**Required control:** Phase A never executes provider code, including an upstream
preview or dry-run. Manual disposable experiments may observe provider behavior,
but disposability is research isolation, not product confinement. Before any Phase B
mutation research, the provider must expose a provider-native exact-source,
exact-destination, bounded installer contract under externally enforced containment.
An undeclared or uncontainable behavior is `INSTALLER_CONFINEMENT_UNPROVEN`.

### MCP-005 — Floating references and self-updaters bypass reviewed bytes

**Severity:** high

**Problem:** Commands using `main`, `latest`, a marketplace selection, or a provider
self-updater can replace the reviewed source after planning or after activation.

**Impact:** The activation receipt stops describing the bytes that the host loads.

**Required control:** AIH resolves an operator-requested ref to an immutable commit
and artifact integrity before apply. Provider update mechanisms are disabled or
isolated. Updates require a new plan, evidence decision, activation transaction, and
receipt. AIH never silently tracks upstream.

### MCP-006 — Provider repositories are not one installation shape

**Severity:** high

**Problem:** GSD Pi is a standalone runtime, GSD Core is a cross-runtime workflow
system, gstack is a broad host setup, Superpowers is a methodology/plugin, and ECC is
a hybrid catalog with rules, skills, agents, hooks, and MCP configuration.

**Impact:** A generic "copy skills" adapter either loses provider behavior or gains
provider-specific exceptions until the core is no longer neutral.

**Required control:** The provider contract declares `skill-pack`, `host-plugin`,
`standalone-runtime`, or `hybrid-runtime`. Unsupported lifecycle operations fail
explicitly. Provider-specific logic stays behind adapters.

### MCP-007 — Permanent release pins make vendor maintenance an AIH release gate

**Severity:** high

**Problem:** Shipping a vendor repository and SHA as part of the AIH baseline turns
upstream churn and held components into release-blocking AIH work.

**Impact:** AIH maintainers must repeatedly vet or repair large catalogs even when a
user does not select them.

**Required control:** AIH releases ship adapter code and policy semantics, not an
active vendor selection. The project intent records the chosen provider and exact
resolved source. Test fixtures may pin deterministic samples, but fixtures are not a
product default or approval.

### MCP-008 — Switching cannot unload instructions already in a live session

**Severity:** high

**Problem:** A host session may have already loaded prompts, skills, hooks, or memory.
Changing files underneath it does not prove those instructions were removed.

**Impact:** A reported switch can leave the old methodology active until the process
ends.

**Required control:** Switching changes the next-session activation. The transaction
must require a fresh host process before it can report the new provider as verified.
The alpha must not claim live-session unload.

### MCP-009 — Existing unowned global installs are ambiguous

**Severity:** high

**Problem:** A machine may already contain manually installed ECC, gstack,
Superpowers, or GSD files without AIH ownership markers or receipts.

**Impact:** AIH cannot distinguish user-owned files from stale provider files and
cannot safely delete them during activation or rollback.

**Required control:** Preflight inventories shared discovery paths. Unowned conflicts
block with `UNOWNED_PROVIDER_CONFLICT`; AIH reports paths and manual remediation but
does not delete or adopt them automatically.

### MCP-010 — Archived names need migration semantics, not live support

**Severity:** medium

**Problem:** `gsd-build/get-shit-done` is archived and `gsd-build/gsd-2` is no longer
the active development home. Treating historical and successor repositories as
interchangeable hides a source-identity change.

**Impact:** An apparent update can silently change owner, repository, package, and
runtime behavior.

**Required control:** Historical repositories are explicit legacy aliases used only
for discovery and migration guidance. Moving to a successor is a reviewed provider
change with a new source identity and receipt.

### MCP-011 — A terminal receipt is not a recovery journal

**Severity:** critical

**Problem:** A receipt written after an installer or activation attempt cannot govern
recovery from process death before that receipt exists. It does not establish lock
ownership, transaction phase, lease expiry, or the last durably completed mutation.

**Impact:** Restart logic can guess the wrong authoritative provider or overwrite a
live concurrent transaction. Rollback may report success without reconstructing the
prior state.

**Required control:** Phase B cannot begin until a durable write-ahead journal,
project/profile/destination locks, transaction ownership, lease rules, restart
reconciliation, pending-activation state, and environment-taint terminal state are
specified and tested. Receipts are derived from terminal journal state; they do not
replace it.

### MCP-012 — Filesystem absence is not runtime absence

**Severity:** critical

**Problem:** A host can load instructions from global canon, project canon, plugin
caches, skills, hooks, MCP configuration, environment overrides, command-line flags,
or an existing session. Inventorying a few known directories cannot prove that a
non-selected provider is absent.

**Impact:** AIH can label a provider verified while another methodology still affects
the session.

**Required control:** Each host version needs a versioned load-surface contract that
enumerates every relevant precedence and discovery path, cache, override, and session
boundary. Coverage is `complete`, `partial`, or `unknown`. Only `complete` can later
support activation verification. Otherwise the provider remains no stronger than
`mutation-research-eligible`.

### MCP-013 — Exact source identity does not imply adapter compatibility

**Severity:** high

**Problem:** An operator can select an immutable provider commit whose installer,
layout, runtime dependencies, or host integration differs from the adapter's
assumptions.

**Impact:** The adapter can be deterministic and still be deterministically wrong for
the selected source.

**Required control:** Every support claim is bound to a compatibility tuple containing
provider repository and commit or installer-contract fingerprint, adapter identity and
implementation hash, host/build and load-surface contract, OS/architecture, isolation
mode, runtime versions, and policy version. Unknown tuples fail with
`ADAPTER_COMPATIBILITY_UNKNOWN` or `PROVIDER_CONTRACT_UNSUPPORTED`.

## Architectural diagnosis

The primary failure mode is authority leakage across the prompt, tool-selection,
tool-execution, and persistence layers. A project file can state one methodology
while a shared user home injects another. A receipt can state one commit while an
updater replaces it. A successful installer can be mistaken for a loaded provider,
and a post-operation inventory can be mistaken for confinement.

The fix is code-gated state and isolation, not stronger canonical prose. Canon tells
the host which provider is authoritative; the activation system must make that claim
true and prove the absence of alternatives.
