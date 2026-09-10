# Governed MCP configuration

Use organization policy to select reviewed MCP controls, authorize their exact
targets, and distribute receipt-owned configuration. Evaluate the policy, then
run `aih policy project --apply` against the consumer project with every target
named by the activation. The [policy command reference](commands.md#aih-policy)
describes the policy and protected-authority inputs.

## Native targets

The configuration paths below are relative to the consumer project. Selecting
a host does not grant authority for another host or modify its global settings.

| Target | Governed destination | Contract |
| --- | --- | --- |
| Claude | `.claude/managed-settings.json` | Existing Claude policy projection; enterprise output also includes system-path examples requiring administrator deployment |
| Codex | `.codex/config.toml` | Native `mcp_servers` tables; project trust affects loading |
| Cursor | `.cursor/mcp.json` | Native `mcpServers` map; host approval may be required |
| Copilot CLI | `.github/mcp.json` | Native `mcpServers` map in a trusted workspace; distinct from VS Code MCP configuration |
| OpenCode | `opencode.json` | OpenCode V1 `mcp` map; recognized V2 configuration is refused rather than rewritten as V1 |
| Kimi | `.kimi-code/mcp.json` | Kimi Code workspace configuration; this contract does not claim legacy Kimi CLI support |
| Kiro | `.kiro/settings/mcp.json` | Existing workspace distribution; custom agents can override or decline workspace inheritance |

The canonical paths and contract identifiers live in
`src/internals/cli-registry.ts` in the source checkout. Host-native
workspace distribution does not establish system-managed enforcement.

Canonical environment references are translated to each supported host's native
syntax. Codex inherits named variables through `env_vars`; Cursor uses
`${env:NAME}` and OpenCode V1 uses `{env:NAME}`. An environment mapping without a
verified native representation is refused rather than emitted as a literal
placeholder. AIH does not copy secret values into an ownership receipt.

Ordinary `aih mcp` generation shares these environment contracts. Offline mode
uses the selected CLI's ordinary native path and preserves unrelated configuration;
it does not redirect other CLIs into Claude configuration. Ordinary Codex and
OpenCode generation uses their global paths, while governed projection uses the
project paths in the table above.

## Feature support and prerequisites

CLI wiring reports and MCP plans distinguish feature support from installed
configuration and runtime acceptance. Governed MCP supports the seven targets
above. Governed ECC materialization supports Claude, Codex, Cursor, OpenCode,
Kimi and Kiro; Copilot CLI is not a governed ECC target. Ordinary ECC installation
supports a different set: Claude, Codex, Cursor, Antigravity, Gemini, OpenCode and
Zed. Governed AIH usage metering supports Claude and Codex, and the declarative
third-party hook registrar targets Claude settings.

Kimi detection uses Kimi Code configuration, including `KIMI_CODE_HOME`; legacy
`.kimi` directories alone do not identify Kimi Code. Presence detection does not
verify the executable's version. OpenCode's governed adapter supports the V1
contract and refuses recognized V2 or ambiguous alternate configuration. Kiro
standalone hook projection requires the `ide1-cli3` runtime contract; CLI2 remains
advisory. Host login, workspace trust, tool approvals and session reloads remain
host-specific prerequisites.

The current context-load canaries require manual verification. Static wiring
reports do not establish that the host loaded the router or respected a context
budget. A missing protected Scanner evidence record leaves its MCP control
unavailable; selecting a supported host cannot waive that evidence requirement.

## Ownership and updates

Claude and Kiro retain their existing receipt formats. Other governed targets
use independent entries in `.aih-config.json` under `nativeMcpProjections`.
Receipts bind the target, native contract, exact owned entries and effective
decision references. A receipt records comparison and rollback evidence; it
does not grant approval authority.

Repeated projection converges without replacing unrelated settings. An update
or removal must prove the prior entries still match their receipt. Unreceipted
name collisions, ambiguous configuration, unsafe paths and edited owned entries
prevent an overwrite. Prune and uninstall subtract unchanged owned entries;
drifted configuration is preserved and the ownership claim is revoked according
to the existing conservative lifecycle.

Projection acts on the explicitly selected hosts. To remove a host from the
project entirely, persist the reduced CLI selection in the project marker and
run `aih prune --apply`. Prune uses the prior receipt to remove unchanged owned
entries from the removed host while preserving its other settings. Invoking
projection for the remaining hosts alone does not remove an unselected host.

Generic MCP generation cannot bypass an existing governed receipt
because the policy file was removed. Reconcile the governed policy and ownership
state first.

## Existing policies

Existing Claude/Kiro candidate identities and saved Workbench selections retain
their exact historical target bindings. The compatibility path recognizes the
specific historical shipped control declaration and validates all remaining
source, asset and policy bindings. It does not accept arbitrary older or changed
catalog content, rewrite pins, or expand an approval's scope.

Reopen a saved policy by preparing a new Workbench with
`aih policy generate --policy-input <saved-policy.json> --out <workbench.html> --apply`
from an administrator directory. Preparation restores the recognized historical
catalog before editing. Importing the same historical selection into an already
open Workbench with a different catalog can still require source review.

To add a new host, author the expanded selection and obtain authority for its
exact targets. Old approval or decision bytes cannot enable an additional host.
Custom stdio and remote candidate declarations remain authorable/reportable;
this change does not add their missing integrity-enforcing materialization or
remote approval workflow. Governed hooks keep their existing host limitations.

## Verify the result

`aih policy evaluate` and the governance report expose a separate receipt state
for each requested target. Missing or changed host configuration remains visible
even when another target has a clean receipt. A clean receipt verifies owned
configuration bytes; it does **not** prove host trust, approval, startup,
connectivity or tool execution.

CLI wiring reports inspect governed native receipts at the project destination.
A clean project receipt is not reported missing because a separate global file
is absent. Changed, missing, revoked or unsafe owned configuration remains a gap,
even if a populated global configuration exists. The report shows additional
global configuration separately and routes governed remediation to policy review.

Complete host acceptance by checking that the intended host loads the generated
file and connects to the intended server. The repository's
`tools/verify-governed-mcp-hosts.mjs`
exercises isolated, harmless fixture servers and records real handshakes and
tool discovery separately from unavailable or blocked probes. It does not
replace organization-specific host approval or deployment checks.
