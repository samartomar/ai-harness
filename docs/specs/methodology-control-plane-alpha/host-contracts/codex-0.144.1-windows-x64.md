# Codex 0.144.1 load-surface feasibility

> Status: Q1 feasibility record. Coverage is `partial`; this is not an
> activation contract and does not authorize provider execution.

## Compatibility tuple

```text
host: Codex CLI
host version: 0.144.1
package: @openai/codex@0.144.1
operating system: Microsoft Windows 10.0.26200
architecture: x64
Node.js: 24.13.1
npm: 11.8.0
isolation mode under study: profile-home
contract version: codex-0.144.1-windows-x64-v1
coverage: partial
decision: HOST_CONTRACT_PARTIAL
```

The installed executable is the npm Windows x64 binary at
`node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`.
Its SHA-256 is
`CBACBB9726262EF558B4AF0438A1B2A5BBA9076132401D947B5B4D2BF92AB0E4`.
The PowerShell launcher SHA-256 is
`0C149DB80ED0BF442C810146B0AD0163B74982FE4542D673F56C354D7B8229CB`.

## Evidence boundary

This record combines the exact local CLI identity with the Codex manual fetched on
2026-07-15. Official documentation is authoritative for documented discovery and
precedence. Local commands establish only the behavior or inventory they directly
observe; they do not prove that an undocumented surface is absent.

Primary official sources:

- [configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic#configuration-precedence)
- [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)
- [environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)
- [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [skills](https://learn.chatgpt.com/docs/skills)
- [plugins](https://learn.chatgpt.com/docs/plugins)
- [hooks](https://learn.chatgpt.com/docs/hooks)
- [MCP](https://learn.chatgpt.com/docs/extend/mcp)

Local evidence commands were read-only:

```powershell
codex --version
codex --help
codex features list
codex plugin list
codex mcp list
codex doctor --help
codex debug --help
npm list -g @openai/codex --depth=0
Get-FileHash -Algorithm SHA256 <launcher-or-executable>
```

No provider checkout, script, preview, dry-run, hook, installer, updater, or repair
command was executed.

## Load-surface matrix

| Surface | Documented or observed behavior | Coverage | Evidence and remaining gap |
| --- | --- | --- | --- |
| Executable identity | `codex-cli 0.144.1`; exact npm package and binary hashes recorded above. | Complete for this machine | Local version, package, path, and hash evidence. A different package channel or binary hash is a different tuple. |
| Project root | Codex walks upward from the current directory to a configured project-root marker; `.git` is the default marker. | Documented | Advanced configuration. Probe must vary working directory and `project_root_markers`. |
| Project configuration | Trusted projects load every `.codex/config.toml` from project root to current directory; the closest layer wins. Untrusted projects skip project `.codex` layers. | Documented | Advanced configuration. Trust-state enumeration and a machine-readable resolved-config view are not established. |
| Configuration precedence | CLI flags/`--config`, project layers, selected profile, user config, system config, then built-in defaults. Managed requirements may constrain the result. | Documented, not exhaustively observable | Configuration precedence. Windows system-level and managed/cloud requirement sources need an exact enumeration API. |
| Project instructions | Codex loads `AGENTS.md` from root toward the current directory; closer guidance has precedence. The instruction chain is rebuilt for each run or TUI session. | Documented | AGENTS.md documentation. Prompt-input probes can show positive inclusion, but absence must include every root marker and fallback filename. |
| Global instructions | User guidance can load from the Codex home. | Partial | AGENTS.md documentation identifies user scope, but this experiment has not established every global/admin/system instruction location or managed injection path on Windows. |
| Skills | Repository skills are scanned in `.agents/skills` from the current directory to the repository root; user/admin/system locations also exist. | Partial | Skills documentation names scopes, but the complete admin/system roots and all enabled/disabled resolution inputs have not been reproduced for this build. |
| Plugins | Installed plugins load from Codex-managed cache locations and may contribute skills, hooks, apps, or MCP configuration. `codex plugin list` exposed enabled plugins from multiple marketplaces and runtime caches on this machine. | Partial | Plugin documentation and local inventory. Marketplace refresh state, bundled runtime caches, workspace-installed plugins, and enablement persistence require a complete machine-readable inventory contract. |
| Hooks | Active user and trusted project config layers can contribute `hooks.json` and inline TOML hooks; both representations in one layer load together. | Partial | Hooks and advanced configuration. Managed/plugin hook composition, trust persistence, and negative enumeration need a resolved hook inventory that does not execute hooks. |
| MCP and apps | User/project configuration can define MCP servers; plugins may add MCP or app capabilities. `codex mcp list` shows the locally resolved configured servers. | Partial | MCP documentation and local list. App-provided, deferred, managed, disabled, and dynamically exposed tools are not proven enumerable through one read-only interface. |
| Environment overrides | `CODEX_HOME` redirects config, auth, logs, sessions, skills, and standalone package metadata; `CODEX_SQLITE_HOME` redirects SQLite state. Other documented variables affect install, auth, TLS, and diagnostics. | Documented, not complete for absence proof | Environment-variable documentation. Provider-defined `env_key` names and inherited process environment are open-ended inputs and must be bounded by policy. |
| CLI overrides | Dedicated flags and `-c`/`--config` override lower configuration layers; `--profile` selects a profile layer. | Documented | CLI help and advanced configuration. A resolved-config dump is still required to prove effective values without starting a model session. |
| Profile-home semantics | `CODEX_HOME` redirects broad user state. A selected profile overlays `$CODEX_HOME/<name>.config.toml` above base user config and below project/CLI layers. | Partial | Environment and advanced-configuration docs. External runtime/plugin caches observed outside `CODEX_HOME` prevent treating `CODEX_HOME` alone as complete isolation. |
| Caches and persistence | Codex may persist history, sessions, logs, SQLite state, credentials, standalone packages, plugin caches, bundled marketplaces, and runtime packages. Instruction chains rebuild per run/session. | Partial | Advanced configuration, plugin documentation, and local paths. The complete cache invalidation and session-resume dependency set is not documented as a closed list. |
| Inherited configuration | Project, profile, user, system, managed requirements, installed plugins, environment, command line, trust state, and session state can all influence the effective host. | Partial | No single redacted read-only command demonstrated a complete resolved load-surface graph for this build. |

## Proposed positive probes

These are designs for a clean disposable environment. They were not run in this Q1
record.

1. Pin the executable hash and start with a new, empty `CODEX_HOME`,
   `CODEX_SQLITE_HOME`, OS account, repository, and working directory.
2. Add one unique inert sentinel at a time to each documented instruction, skill,
   plugin, hook, MCP, profile, project-config, user-config, and system/managed surface.
3. Use redacted diagnostics such as `codex debug prompt-input`, `codex plugin list`,
   `codex mcp list`, and `codex doctor --json` where they expose the relevant surface
   without running hooks or provider content.
4. Start a fresh host session only when a surface cannot be observed statically; bind
   the result to a nonce, executable hash, configuration roots, and exact command line.
5. Repeat from nested directories, trusted and untrusted project states, selected and
   absent profiles, and an empty versus populated plugin cache.

## Proposed negative probes

Negative proof requires more than the absence of a sentinel in one prompt.

1. Enumerate and hash every documented load root and every resolved config, plugin,
   hook, skill, MCP/app, cache, and session dependency before host start.
2. Deny or remove all non-selected-provider sentinels from those roots and capture a
   redacted resolved-surface inventory.
3. Start a new session with a one-time nonce. Do not resume an existing thread.
4. Confirm the selected sentinel is present and every non-selected sentinel is absent
   from model-visible prompt input and resolved tools/hooks.
5. Repeat after process restart and on a second clean machine with the same tuple.
6. Treat any unenumerated cache, injected managed layer, plugin capability, app tool,
   inherited environment input, or session dependency as a failed negative proof.

Provider-authored probes are evidence about the provider, not authority over Codex
visibility, and cannot close any host-coverage gap.

## G1 decision

Decision: `HOST_CONTRACT_PARTIAL`.

Codex 0.144.1 exposes enough documented structure to continue provider-neutral Phase A
qualification through honest `plannable` results. It does not yet expose or document a
closed, reproducible load-surface inventory sufficient for activation absence proof.
In particular:

- plugin and runtime caches are not confined to `CODEX_HOME` on the observed desktop
  installation;
- global/admin/system/managed instruction and skill injection is not fully enumerated;
- hooks, MCP/apps, and plugin contributions lack one complete resolved inventory;
- session-resume and cache dependencies are not established as a closed set; and
- the contract has not been reproduced on a second clean environment.

Therefore work may continue to Q2–Q9 for qualification-only behavior, but activation,
switching, concurrency, and Phase B mutation research for this host stop. A later
contract version may change this decision only with new authoritative evidence and a
clean second-environment reproduction.
