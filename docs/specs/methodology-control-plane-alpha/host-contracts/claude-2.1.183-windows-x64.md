# Claude Code 2.1.183 load-surface feasibility

> Status: post-Q9 local host feasibility record. Coverage is `partial`; this is
> not an activation contract and does not authorize provider execution.

## Compatibility tuple

```text
host: Claude Code CLI
package: @anthropic-ai/claude-code@2.1.183
host version: 2.1.183
operating system: Microsoft Windows 11 Pro 10.0.26200
Windows build: 26200
architecture: x64
Node.js: 24.13.1 (x64)
isolation mode under study: profile-home
contract version: claude-2.1.183-windows-x64-v1
coverage: partial
decision: HOST_CONTRACT_PARTIAL
```

The exact local npm shim and executable identities are:

```text
claude.cmd SHA-256: 7999FBA95DBFFE167D9E0A043F29057979A0518EBE89B60C4FCFC6401EA8C424
claude.ps1 SHA-256: B5F3D62824FFD02D9E9CA8786868F4D1233D78A68A199D8E91D3CD3A9A11B4F7
bin/claude.exe SHA-256: BA6E71D0E39B33C42A519BD10FC6D79B04D62CEDCC918B3991FF863462261EB0
package.json SHA-256: C463F4EDE002DA34B04D235967D1A7A901241B9C4911684FD669F7F960840600
```

The shim targets the local package executable directly. Any package version, Windows
build, architecture, shim, or executable hash change is a different host tuple.

## Evidence boundary

This record combines the local executable identity and presence-only inventory with
first-party Claude Code documentation retrieved on 2026-07-15. The documentation
describes load surfaces and precedence; local evidence establishes only the exact
identity and whether a known surface exists. It does not prove that an undocumented
surface is absent or that any existing file is selected by a session.

Primary official sources:

- [settings and precedence](https://code.claude.com/docs/en/settings)
- [memory and instruction loading](https://code.claude.com/docs/en/memory)
- [sessions and persistence](https://code.claude.com/docs/en/sessions)
- [plugin component reference](https://code.claude.com/docs/en/plugins-reference)

The local commands were read-only host diagnostics:

```powershell
claude --version
claude --help
claude --bare --help
Get-FileHash -Algorithm SHA256 <shim-or-executable>
Get-CimInstance Win32_OperatingSystem
Test-Path <known Claude configuration root>
```

No Claude session, `doctor`, plugin command, provider checkout, provider script,
preview, dry-run, hook, installer, updater, repair command, MCP server, or provider
module was executed. `doctor` was excluded because this build's help states that MCP
servers from `.mcp.json` are spawned for health checks.

## Presence-only inventory

The following documented surfaces existed on this machine at probe time; their
contents, values, and state were intentionally not read:

```text
user settings and user state: present
user agents, skills, plugins, hooks, and project cache: present
project shared settings, .mcp.json, and root CLAUDE.md: present
project local settings, local CLAUDE.md, project agents, skills, and hooks: absent
HKLM and HKCU ClaudeCode policy registry keys: absent
CLAUDE_CONFIG_DIR, CLAUDE_CODE_SKIP_PROMPT_HISTORY,
CLAUDE_CODE_DISABLE_AUTO_MEMORY environment variables: unset
```

Presence does not establish selection, precedence, ownership, safety, or absence of
other managed or remote state. In particular, an absent local policy registry key
does not exclude server-managed policy, other OS/MDM delivery, an inherited process
environment, or caches outside the enumerated roots.

## Load-surface matrix

| Surface | Documented or observed behavior | Coverage | Evidence and remaining gap |
| --- | --- | --- | --- |
| Executable identity | `claude --version` reports `2.1.183 (Claude Code)`; exact package, shim, executable, Windows build, and architecture are pinned above. | Complete for this machine | Static local identity. Any changed byte or host build is a different tuple. |
| Project instructions and isolation | Root `CLAUDE.md` and project `.claude/` surfaces can influence a session. Project-level state and the `.mcp.json` surface were present. | Partial | Presence-only probe. The session's selected instruction chain and nested-directory behavior were not observed. |
| Global instructions | User `~/.claude` instruction and extension roots are documented; user settings/state exist locally. | Partial | No contents were read and no session enumerated selected global/managed instructions. |
| Skills, plugins, and agents | Plugins can contribute skills, agents, hooks, MCP servers, LSP servers, monitors, and executables; user agents, skills, and plugin roots exist. `--bare` documents that hooks, LSP, plugin sync, auto-memory, and `CLAUDE.md` discovery are skipped, but explicit inputs and skills remain possible. | Partial | No plugin, agent, or skill was loaded or enumerated. The effective enabled set, cache state, and precedence are not closed. |
| Hooks | User, project, and plugin surfaces can supply hook behavior; a user hook root exists. | Partial | Hooks were not started or enumerated. No safe complete resolved-hook inventory was observed. |
| MCP and configuration | Settings precedence is managed, CLI, local project, shared project, then user. A project `.mcp.json` and user state exist; plugin MCP servers can start automatically when a plugin is enabled. | Partial | `--settings`, `--setting-sources`, and `--mcp-config` are exposed by help, but `/status` was not run and no effective configuration graph was produced. |
| Environment and CLI overrides | CLI exposes `--settings`, `--setting-sources`, `--mcp-config`, `--strict-mcp-config`, `--agent`, `--agents`, and `--plugin-dir`; documented environment variables can relocate configuration and change memory/session behavior. | Partial | The three relevant environment variables were unset in this process, but the inherited environment is open-ended and managed policy can outrank CLI arguments. |
| Profile-home semantics | User state, plugins, agents, skills, hooks, and project session cache exist under the standard user root. Documentation places transcript and auto-memory data under `~/.claude/projects/<project>` unless redirected. | Partial | No fresh OS account or isolated `CLAUDE_CONFIG_DIR` run was performed. Worktrees/subdirectories can share project memory, so profile-home alone is not an isolation proof. |
| Caches and session persistence | Help exposes `--continue`, `--resume`, `--fork-session`, and `--no-session-persistence`. Documentation records transcript and auto-memory persistence under the user project cache. | Partial | A fresh session was not started, resumed, or inspected. Cache invalidation, retention, and complete resume dependencies are not bounded. |
| Inherited state | Managed policy, CLI inputs, local/shared/user settings, user state, plugins, environment, project instructions, MCP, and session/memory data can all affect a session. | Partial | No single redacted read-only command established the complete resolved load surface for this exact build. |
| Probe procedure | `--bare --help` confirmed a host mode designed to omit several discovery surfaces. | Partial | No host session was launched because a normal session could load the present unknown provider surfaces and a live request would exceed this read-only, no-provider-execution spike. |

## Proposed positive probes

These require a separately authorized disposable host experiment. They were not run
in this record.

1. Pin the executable and shim hashes, then start with a new Windows account, empty
   repository, empty project state, and a newly created `CLAUDE_CONFIG_DIR`.
2. Add one inert, unique sentinel at a time to each documented managed, user, shared
   project, local project, instruction, agent, skill, plugin, hook, MCP, session, and
   environment surface.
3. Establish whether `--bare`, `--setting-sources`, and `--strict-mcp-config` produce
   a redacted, reproducible resolved-surface inventory without starting extensions.
4. Start one nonce-bound fresh session only after the host-only experiment has an
   explicit network/auth budget and confirms no provider surface can load.
5. Repeat from a nested directory and a second clean machine with the same exact host
   tuple; compare resolved configuration, tools, loaded instructions, and persistence.

## Proposed negative probes

Negative proof requires more than the absence of a sentinel in a single prompt.

1. Enumerate and hash every documented managed, user, project, local, plugin, agent,
   skill, hook, MCP, configuration, environment, cache, and session input before
   host start.
2. Remove or deny every non-selected-provider sentinel and capture a redacted,
   machine-readable resolved-surface inventory.
3. Start a new nonce-bound session rather than continuing or resuming a prior one.
4. Confirm the selected sentinel is loaded and every non-selected sentinel is absent
   from prompt input, available tools, hooks, agents, skills, plugins, and MCP.
5. Repeat after restart and on a second clean machine. Treat any unenumerated managed
   layer, cache, plugin, environment input, or session dependency as failed proof.

Provider-authored probes are evidence about a provider, not authority over Claude
Code visibility, and cannot close a host-coverage gap.

## Claude decision

Decision: `HOST_CONTRACT_PARTIAL`.

Claude Code 2.1.183 exposes enough documented structure to identify the relevant
qualification surfaces, but it does not provide a complete locally proven resolved
load graph for this machine. The local presence inventory confirms that user and
project extension and persistence surfaces are already populated, while the required
fresh-session and negative probes were intentionally not run. Therefore this record
does not support an ECC/Claude or gstack/Claude tuple qualification. No provider code
executed during this spike.
