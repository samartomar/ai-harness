---
status: guide
owner: AI-Harness maintainers
last_verified: 2026-09-14
truth_home: true
purpose: Author, bind, deliver and reconcile project policy and required guidance through public commands.
---

# Project policy delivery

An adopter can distribute reviewed policy to independently bound projects, then
use AIH to project supported controls and materialize qualified required content.
Project assignment, authorization, installed bytes, native loading and enforced
behavior are separate checks. This guide covers the project workflow; the
[administrator guide](enterprise-admin-guide.md) covers protected policy
distribution and authority provisioning.

**Fictional examples:** Harbor's Node API requires `skill:tdd-workflow` and omits
optional frontend guidance. Cedar's service requires `skill:security-review`
and omits TDD. These choices illustrate different policies; AIH does not infer a
universal practice mandate from a stack or from its own repository.

## Author and review

Prepare and review a schema-valid policy for each project context through the
administrator's own controlled process. Core no longer provides a browser
Workbench, the former policy generator, or a replacement authoring command. Record
the intended clients, posture, exact source revisions, selected roots,
dependency closure, target scope, and optional exclusions in the reviewed JSON.
Required dependencies cannot be removed by optional exclusions. Explicitly
review the complete approved client set before requesting governed MCP
projection. Validate each policy with `aih policy validate` before binding it;
validation is not an authority receipt and does not grant an unsupported
effect. Skills provide instruction guidance; installed
or discoverable skills do not establish TDD compliance or another enforced
practice. Review the effect and target limitations before applying the policy.

## Provide authority and exact content

Use the existing [policy authority](../docs/commands.md#aih-policy) and
[baseline evidence](https://github.com/samartomar/ai-harness/blob/main/docs/security/baseline-evidence.md) contracts. At Enterprise
posture, ECC requires the organization's exact baseline override and attested
evidence even when packaged publisher evidence passes. A source pin, policy
boolean, policy file or ownership receipt is not that approval.

For a project-policy source, the administrator records admission in
`trust.baselineOverrides`: the catalog, owner/repository, exact `pinnedSha`,
attested `bundle` path, `signingRepository`, reviewer, approval time and reason.
Preserve reviewed `authoringSelections` and `externalSelections` while
attaching this separately reviewed authority. Validate the resulting policy
before binding it. AIH verifies the bundle contents and their
attestation; filling in these fields alone cannot authorize delivery.

A protected PolicyBundle stays outside the consumer project on the
administrator's distribution path. AIH checks the supported authority contract;
the administrator remains responsible for the host permissions and distribution
system protecting that path. A project policy and a protected external bundle
are supported selection mechanisms with different custody requirements.

Use a reviewed Core version and a qualified immutable ECC revision. A local ECC
checkout can be supplied with `--ecc-path`; its source and component identities
must still pass the real evidence checks. AIH does not silently replace a saved
revision with the current catalog pin. Host authentication and any paid provider
usage are separate from policy delivery.

Target support also depends on the saved source's qualified runtime. An older
ECC catalog can lack Kiro runtime proof even when current qualified ECC supports
Kiro. The preview reports `historical-kiro-runtime-proof-unavailable` and apply
refuses before mutation. Review a supported target subset and rebind it, or
qualify and review a newer source; a client approval cannot supply missing source
evidence.

## Bind each project

In the Harbor consumer checkout, set `POLICY` to the reviewed policy file or
protected bundle and bind an explicit project identifier and complete target set:

```sh
aih policy validate . --policy "$POLICY"
aih policy bind . --project harbor-api --cli codex,opencode --policy "$POLICY"
aih policy bind . --project harbor-api --cli codex,opencode --policy "$POLICY" --apply
```

Use Cedar's policy and identifier in Cedar's checkout, for example
`--project cedar-service --cli claude,cursor,kimi,kiro`. Select only clients
approved by that policy and supported by every required component. Copilot CLI
can receive governed MCP configuration but is not a governed ECC target.

The binding in `.aih-config.json` records the canonical root identity, project
identifier, exact policy path and digest, and target set. Fresh AIH invocations
restore the source and targets from it. An explicit conflicting selection,
changed policy bytes, a copied root binding or a revoked binding blocks mutation.
This is one selected policy, not a hierarchy or a merge of multiple policies.

The binding is local project configuration, not new administrator authority or
account-wide environment setup. A clone or worktree has a different canonical
root: review it and run `policy rebind` for the same project identifier. Do not
copy a marker and assume it authorizes another project. Bind unrelated projects
independently. Keep the policy source available to fresh processes.

## Install and start a fresh session

Preview and apply setup in the bound consumer root:

```sh
aih init .
aih init . --apply
aih policy project .
aih policy project . --apply
aih policy evaluate . --posture enterprise --json
aih ready . --json
aih report .
```

If supplying a local qualified ECC checkout, add `--ecc-path "$ECC_SOURCE"` to
the delivery command. Writing commands normally require a clean worktree. Review
and commit the setup diff between stages, or deliberately use `--force` for a
reviewed dirty setup branch. `--force` does not waive authority, source identity,
target, ownership or binding checks.

`policy project` projects supported policy settings and reconciles the selected
governed ECC content. Routine governed initialization does not install an
unselected Superpowers baseline. AIH records component ownership in
`.aih/ecc/materialization-v1.json`. Generated native bootloaders route to the
context directory's `policy-required-guidance.md`, which names the admitted
practice files; the guidance file has its own ownership receipt.

Start the selected client normally from that consumer root, without explicitly
attaching a skill. Complete the client's workspace trust, login and approval
steps. Check that the fresh session loads the intended root's entry point,
required guidance and exact component content. Repeat after restart and after
switching A → B → A. An installed-file check alone cannot substitute for this
native observation. For the supported bounded OpenCode Linux launch, use the
[OpenCode sandbox guide](opencode-linux-sandbox.md); its per-root launch setup is
separate from policy assignment.

| Capability | Applicable clients | What still requires observation |
| --- | --- | --- |
| Governed MCP distribution | Claude, Codex, Cursor, Copilot CLI, OpenCode V1, Kimi Code, Kiro | Native trust, discovery and a real tool operation |
| Governed ECC content | Claude, Codex, Cursor, OpenCode, Kimi Code, Kiro, subject to component restrictions | Normal startup loading of required content |
| Governed AIH usage metering | Claude, Codex | The applicable native hook actually runs |
| Declarative third-party hook registrar | Claude | Registered hook runs in the intended lifecycle |
| Command-policy native permission projection | Claude | Allowed operation plus actual refusal, with forbidden effect absent |

Other clients' command-policy guidance is advisory. A project
`.claude/managed-settings.json` file is not proof of system-managed Claude
deployment. Follow the administrator deployment instructions for that control.
Kiro login and its applicable hook runtime remain host prerequisites; unavailable
native evidence is unverified, not unsupported or passed. See the full
[governed target contract](../docs/governed-mcp.md).

For a policy with `command` deny/ask deltas, `policy project` also projects the
composed rules into Claude's native `.claude/settings.json` permissions. The
separate `.aih/org-policy/command-permissions-v1.json` receipt owns only entries
AIH added; matching pre-existing user rules remain user-owned. Generic guardrails
do not restore the fixed lexicon over that policy selection. Command matcher
behavior belongs to Claude: verify both an allowed command and an actual refusal
in its ordinary client mode. A direct MCP server tool-call interface does not
establish the ordinary client's permission enforcement.

## Update, remove and revoke

Review a new policy version through the administrator's controlled process, including optional choices and
new client approvals. Replace the selected policy source through its normal
distribution mechanism, then acknowledge the reviewed bytes and exact targets:

```sh
aih policy rebind . --project harbor-api --cli codex,opencode --policy "$POLICY"
aih policy rebind . --project harbor-api --cli codex,opencode --policy "$POLICY" --apply
aih policy project . --apply
```

An old approval does not authorize a new client, revision or component. Rebinding
does not waive evidence. To withdraw previously required ECC content, retain an
authorized ECC selection with an explicitly empty `items` array; omitting the
governed policy is not an uninstall instruction. Apply the reviewed withdrawal
through `policy project`, then confirm the receipt and remaining files.

To remove a client, first withdraw or retarget its activations in the reviewed
policy and rebind the reduced target set. Reconcile the policy, persist the
reduced bootstrap selection with `init`, and preview `aih prune` before
`aih prune --apply`. Prune reads the committed marker; its `--cli` flag is not a
retargeting mechanism. Review the [CLI lifecycle guide](cli-lifecycle-guide.md)
before a whole-client or whole-project uninstall.

`aih uninstall --apply` subtracts receipt-proven content and command rules. A
bound project retains its marker with the binding revoked, so ordinary setup
cannot fall back to unrestricted defaults. Edited required guidance and its
receipt stay in place, and remaining governance receipts are preserved. Inspect
the uninstall digest for retained paths; retry after reviewed recovery when
ownership cannot be proved. Receipt-only uninstall remains available after
revocation or loss of the policy source.

Cleanup reports a partial failure when edited or unreadable owned destinations
remain. Already absent files do not require restoration: AIH can remove their
completed ownership receipt and reports that cleanup accurately. A dry run of
setup, policy projection or uninstall does not write or withdraw content.

After authorized withdrawal and cleanup, retain a fail-closed project revocation:

```sh
aih policy revoke . --project harbor-api
aih policy revoke . --project harbor-api --apply
```

Revocation blocks later governed mutation; it does not stop a running native
process or remove files. Recover by reviewing current authority and using
`policy rebind` for the same identifier. Deleting the policy or its binding is
not a supported way to turn a governed project into an unrestricted one.

## Recover conservatively and verify the result

Reapplication compares receipts and live owned bytes. Unrelated files and client
settings stay outside AIH's ownership. Edited owned files, malformed receipts,
missing receipts and unowned name collisions cannot be treated as permission to
overwrite or delete user content. Preserve custom guidance, hooks, commands and
roles, inspect the reported paths, and restore only known-good ownership records
and bytes from the project's reviewed backup when appropriate. Never manufacture
a receipt or delete it to make a check pass.

For interrupted application, retain the command's structured result and review
what changed. Correct the identified source, binding, target or ownership issue,
then rerun the same public command. Inspect both the component receipt and the
required-guidance receipt before opening a fresh client session. An intermediate
installation result does not establish complete startup delivery.

## Inspect selection and discovery ownership

Preview the bound project's governed selection before applying it:

```sh
aih ecc --lifecycle install . --ecc-path "$ECC_SOURCE" --json
aih policy evaluate . --json
aih ready . --json
```

The governed ECC preview joins the reviewed selection to exact source files and
planned destinations. Read its selection, exclusion, refusal and subtraction
details together. A destination in a preview is a proposed write, not proof of
installation. Preview does not install content or change ownership receipts.
Without a qualified source on disk, the command explains that its output is not
a file-level preview; provide the exact checkout to inspect the actual paths.

Every admitted `governance.externalSelections` item remains part of the required
delivery set. Root and dependency provenance explain why it is retained;
optional authoring choices do not waive a retained requirement. Schema-v3
exclusions carry their own source revision and content digest. A historical
selection keeps its historical source identity; it cannot inherit the current
catalog's dependency or approval facts merely because names match.

| Owner | Scope and selection path | Disposition |
| --- | --- | --- |
| Governed ECC materializer | Selected project files under `.aih/ecc/materialization-v1.json` | Apply reconciles the exact selection; subtraction requires unchanged receipt-owned bytes |
| Earlier AIH profile installation | Separate `.aih/ecc-profile/` lifecycle and source identity | Its receipts do not authorize governed materialization or replacement; review the existing lifecycle before changing owners |
| Older mirrors without proven ownership | Existing project content | Retained for manual review; matching names or directories grant no removal authority |
| Native plugin or user installation | Client-managed user/account inventory | Project selection does not enumerate or filter this owner's components; its content may remain visible |
| Custom guidance, commands, roles and hooks | User-owned files or settings entries | Preserved; a same-name custom skill is not automatically a duplicate capability |

Ordinary upstream installation, the separate AIH profile lifecycle, governed ECC
materialization and governed MCP support have different target and source
contracts. In this build the separate profile renders new installations at
`affaan-m/ECC@5064474d4d762dc9640234a41617cccb79185cec` and keeps repair, rollback and
uninstall anchors for installations rendered at
`affaan-m/ECC@0c1d7be9a750627fb2a6534c78a998cc46d03f9c`; the packaged current
governed catalog uses `affaan-m/ECC@5064474d4d762dc9640234a41617cccb79185cec`.
Saved historical selections can name another qualified revision. Inspect the
selected source in the actual preview; these identities are not interchangeable.
Use a validated schema-v3 policy with verified source bindings to retain a historical source's
selection. Changing a commit field in a legacy schema-v2 policy does
not establish that authority. After binding the compiled policy, run
`aih policy project --apply --ecc-path <exact-checkout>` for selected delivery,
then ordinary initialization. A sealed older Codex Markdown agent destination
requires reviewed requalification before native TOML role delivery; its
unchanged skill and other client routes retain their original authority.
Copilot CLI's governed MCP support does not give it governed ECC support.

When the qualified source carries a shared Codex skill projection, its selected
project discovery route is `.agents/skills/<name>/SKILL.md`. Sources without
that projection retain their evidenced target mapping. Reconciliation removes an older
`.codex/skills/<name>/SKILL.md` projection only when its unchanged materialization
receipt proves AIH owns it. Edited or unowned copies remain and can still appear
in native discovery. Review the reported residual paths instead of deleting
them by name. Existing client settings, including disabled-skill arrays, are not
replaced to achieve this project selection.

Selected Codex agents use native `.codex/agents/<name>.toml` role files and
project `[agents.<name>]` registration in `.codex/config.toml`. AIH owns only its
marked registration block, tracked by
`.aih/ecc/codex-role-registration-v1.json`. Existing roles, MCP entries and other
settings remain separately owned. A same-name role, invalid configuration or
edited managed registration requires review before reconciliation. Codex must
permit loading the project's configuration through its normal trust settings;
installing a role file alone does not establish that a session loaded it.

Repeat ordinary `init` or `policy project`, then start the client normally in
that root. No remembered process-level skill override is needed for the owned
projection path. Required guidance is reached through the generated startup
pointer; a native catalog entry supplies discovery metadata, and full content
still requires the client's read path. Generated governed adapters describe
this selection without asserting that an unselected global baseline is installed.
The required-guidance pointer lists applicable selected skill, agent, command,
rule and steering Markdown. Native Codex role instructions are carried by the
registered TOML role. Configuration and runtime JSON are not presented as
practice text to read. Component-specific target refusals still apply: for
example, OpenCode's governed project adapter supplies shared skills but has no
project agent or command projection. Review the preview before assigning a
component across several clients.

Command bundles need qualified runtime content as well as Markdown. The current
packaged `commands-core` descriptor omits libraries used by its health command,
so AIH refuses that incomplete bundle instead of installing commands that cannot
run. A reviewed source descriptor can authorize the complete `commands` tree,
`scripts/harness-audit.js`, `scripts/skills-health.js` and `scripts/lib` together.
AIH preserves that source identity, records owned support files and supplies an
owned `scripts/package.json` CommonJS boundary. An existing user file at that
path is a collision; the adopter's root package settings are preserved.

For a complete qualified command source, Codex discovers generated workflow
skills at `.agents/skills/ecc-workflow-<command>/SKILL.md`; use the generated
skill name shown in native discovery. Claude, Cursor and Kimi use their command
paths. This does not authorize copying an unselected hooks runtime or treating
an old sealed destination as permission for a new one. Review and import the
new source qualification before changing the bound selection.

For comparison, record the same project, policy, immutable ECC source, client
version and host before and after reconciliation. Keep physical files, unique
component identities, native inventory rows, enabled entries and complete loaded
content separate. A removed owned projection does not imply removal from another
owner's inventory. Record unavailable usage fields as unavailable; fewer files,
rows or output bytes do not establish lower billed tokens, latency or cost.

`policy evaluate`, `ready` and HTML reports distinguish policy blockers, selected
components, owned-byte drift and unverified native loading. Current component receipts record the
adapter's delivery targets, while older receipts without that field remain
target-unverified until authorized reconciliation. A receipt for another client
requires reconciliation.

A passing canary cannot clear a policy blocker. Policy, project configuration, client or relevant
runtime changes invalidate the applicable runtime observation; obtain a new
observation after the reviewed update. Local observations are not authority and
do not prove arbitrary tool use, real-model behavior or general credential
isolation. The documented Linux outer sandbox leaves general host files readable
unless explicitly hidden.

## Required and optional content contract

Downstream content selection uses the effective policy's exact framework items
and dependency closure as the required set. Schema-v3 authoring exclusions trim
optional inventory only. Explicit roots and legacy selection provenance remain
reviewable; generic policy requests with no supported materializer stay
requested intent. A disabled control is not silently replaced by a same-named
skill, and a skill is not an enforced control.

Each consumer root owns its generated project material through the appropriate
receipt: native MCP receipts, ECC materialization receipt, required-guidance
receipt, native Codex role-registration receipt and native command-permission
receipt are separate. Qualification remains bound to source/component identity
and approved targets. Reconciliation may subtract only unchanged owned material.
User plugin installations, global profiles, custom files and another root's
state remain separately owned. Content pruning must preserve this separation;
this contract does not authorize global ECC cleanup.
