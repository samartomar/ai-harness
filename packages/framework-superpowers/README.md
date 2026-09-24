# @aihq/framework-superpowers

The [obra/Superpowers](https://github.com/obra/superpowers) framework plugin for
[`@aihq/core`](https://github.com/samartomar/ai-harness). It carries everything
Superpowers-specific that `aih` does: the evidence-bound per-CLI guidance, the
Kiro methodology steering bridge, the Superpowers hook inventory and the hook
control plan. Core keeps the `aih superpowers` command, the policy decisions,
the Catalog access and the evidence gate.

```sh
npm install -g @aihq/core @aihq/framework-superpowers
# in a project
npm install @aihq/core @aihq/framework-superpowers
```

Without this package, `aih superpowers` refuses with
`framework-plugin-unavailable` and names the install command, and `aih init`
reports its Superpowers phase as refused with that reason.

## How Core loads it (framework plugin contract 1)

- Core imports this package only by its literal name, from its own install
  tree, and checks the `aihFrameworkPluginV1` export by `typeof`: contract
  version 1, framework host API version 1, and this package's own
  `package.json` name and version. When `@aihq/catalog` is installed, the
  installed version must equal Catalog's identity record in
  `./catalog-framework-plugins.json`. Anything else wrong is
  `framework-plugin-incompatible`; there is no embedded fallback.
- The plugin imports Core only through `@aihq/core/framework-host`, plus Node
  built-ins and its own files (a Core test enforces this).
- Effectful work (acquiring the pinned source, verifying it against release or
  organization evidence, executing plans) is done by the Core that invoked the
  plugin, through the services in the operation context.

## What `aih superpowers` does through this plugin

1. Reads the Superpowers descriptor bytes Core loaded from Catalog and
   validates the sections below with this package's own schema.
2. Asks Core's evidence gate to acquire obra/Superpowers at the exact pin
   (or an exact `AIH_SUPERPOWERS_REF` commit override) and verify every
   component.
3. Only after verification, returns the guidance plan: per-CLI install
   guidance labelled with the verified pin, the Kiro methodology steering
   (`.kiro/steering/superpowers-methodology.md`, aih's own text, never labelled
   as vendor evidence), labels for policy-disabled hooks, and the evidence
   receipts. No install is executed: marketplace and TUI installers cannot prove
   they consumed the verified commit.

## Descriptor sections this plugin reads

Catalog publishes `./catalog-framework-superpowers.json` as
`{ "format": "aih-catalog-framework-descriptor", "version": 1, "frameworkId": "superpowers", "sections": { ... } }`.
Sections the plugin does not read are ignored.

- `vendorLock` (required by every operation): the vendor-lock source entry,
  `{ "id": "superpowers", "owner": "obra", "repo": "Superpowers", "pinnedSha": "<40 hex>", "components": [{ "id": "runtime:…|skill:…", "paths": ["<contained POSIX path>", …], … }] }`.
  The pin must be the upstream this plugin version supports
  (`obra/Superpowers@b36e0829c6d0140e93cfef2ca599b1b07d4a7797`, v6.3.0).
- `hookControlInventory` (required by hook operations):

  ```json
  {
    "provenance": {
      "repository": "obra/Superpowers",
      "commit": "<the vendorLock pin>",
      "component": "runtime:superpowers-plugin",
      "sources": [{ "path": "hooks/hooks.json", "sha256": "<64 hex>" }]
    },
    "hooks": [
      {
        "id": "hook:session-start",
        "event": "SessionStart",
        "summary": "<visible text>",
        "declarations": [
          {
            "host": "claude",
            "sourcePath": "hooks/hooks.json",
            "event": "SessionStart",
            "matcher": "startup|clear|compact",
            "command": "<verbatim upstream command>",
            "execution": "process | in-process | declarative"
          }
        ],
        "upstreamControl": { "kind": "none" }
      }
    ]
  }
  ```

  Every declaration's `sourcePath` must be one of the recorded `sources`.

## Hooks at the pinned commit (v6.3.0)

One hook, `hook:session-start`: it injects the full `using-superpowers` skill
into the agent's context when a session starts, is cleared, or compacts.

| Host | Declared in | Runs as |
| --- | --- | --- |
| claude, copilot, antigravity | `hooks/hooks.json` (`SessionStart`, matcher `startup\|clear\|compact`) | `hooks/run-hook.cmd session-start` → `hooks/session-start` (bash) |
| cursor | `hooks/hooks-cursor.json` (`sessionStart`) | `./hooks/run-hook.cmd session-start` |
| kimi | `.kimi-plugin/plugin.json` (`sessionStart.skill`) | declarative skill injection |
| opencode | `.opencode/plugins/superpowers.js` (`experimental.chat.messages.transform`) | in-process message transform |

Codex (`.codex-plugin/plugin.json` declares `"hooks": {}`), Gemini, Windsurf,
Zed and Kiro run no Superpowers hook. Each recorded file lies inside the vetted
`runtime:superpowers-plugin` component whose tree digest matches the vendor
lock.

## Hook controls

`planHookControls` decides each hook for the targeted hosts under the disable
requests in Core's policy view (enterprise outranks user). obra/Superpowers has
no per-hook switch at this commit and the host's own plugin manager installs and
runs the plugin, so a disabled hook that runs on a targeted host is labelled
`unenforced` with the next route (leave the plugin disabled on that host, or use
the host's own hook controls). The guidance itself stays visible. An unknown
hook id is refused.

## Development

This package lives in the Core repository. Its tests run with Core's suite
(`npx vitest run packages/framework-superpowers`), with `@aihq/core/framework-host`
resolved to Core's source. `npm run build` (tsup) emits `dist/index.js` with
`@aihq/core` external.

Licensed under Apache-2.0.
