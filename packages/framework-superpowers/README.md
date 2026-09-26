# @aihq/framework-superpowers

The [obra/Superpowers](https://github.com/obra/superpowers) framework plugin for
[`@aihq/core`](https://github.com/samartomar/ai-harness). It carries everything
Superpowers-specific that `aih` does: the evidence-bound per-CLI guidance, the
Kiro methodology steering bridge, the Superpowers hook inventory and the hook
control plan. Core keeps the `aih superpowers` command, the policy decisions,
the Catalog access and the evidence gate.

This package ships inside `@aihq/core` (under `packages/framework-superpowers`);
there is nothing extra to install, and it is never published on its own:

```sh
npm install -g @aihq/core
```

If an install lacks it, `aih superpowers` refuses with
`framework-plugin-unavailable` and names the reinstall: `npm install -g @aihq/core`, or in a project delete `node_modules/@aihq/core` and run
`npm install`. `aih init` reports its Superpowers phase as refused with that reason.

## How Core loads it (framework plugin contract 1)

- Core imports this package only from its bundled directory inside Core's own
  package directory, and checks the `aihFrameworkPluginV1` export by `typeof`: contract
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
  (`obra/Superpowers@5bf4e78011075bcfc0dc295f0724994cd123ee71`, v6.4.1).
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

  Every declaration's `sourcePath` must be one of the recorded `sources`. A
  hook's logical `event` is a letter followed by letters, digits or `_`.

## Hooks at the pinned commit (v6.4.1)

Five hooks, each with no upstream switch:

| Hook | Event | Host: declared in | Runs as |
| --- | --- | --- | --- |
| `hook:session-start` — injects the full `using-superpowers` skill when a session starts, is cleared, or compacts | `SessionStart` | claude, copilot, antigravity: `hooks/hooks.json` (matcher `startup|clear|compact`); cursor: `hooks/hooks-cursor.json` (`sessionStart`); kimi: `.kimi-plugin/plugin.json` (`sessionStart`); muse: `.muse-plugin/plugin.json`; opencode: `.opencode/plugins/superpowers.js` (`experimental.chat.messages.transform`) | `hooks/run-hook.cmd session-start` → `hooks/session-start`; muse runs `sh hooks/session-start`; kimi is declarative; opencode is in-process |
| `hook:skills-path` — adds the Superpowers skills directory to the host's skill search paths | `config` | opencode: `.opencode/plugins/superpowers.js` (`config`) | in-process |
| `hook:skill-registration` — registers every skill with OpenCode V2's native registry | `setup` | opencode: `.opencode/plugins/superpowers.js` (`skill.transform`) | in-process |
| `hook:session-context` — injects `using-superpowers` into each top-level OpenCode V2 session's first message | `context` | opencode: `.opencode/plugins/superpowers.js` (`session.hook.context`) | in-process |
| `hook:first-turn-context` — appends `using-superpowers` and the Hermes skill guidance to the first turn | `pre_llm_call` | hermes: `.hermes-plugin/__init__.py` (`pre_llm_call`) | in-process |

Muse and Hermes are hosts aih does not control: their declarations are
selectable rows labelled `unenforced`, with the host's own hook controls as the
next route. Devin's manifest (`.devin-plugin/plugin.json`) is metadata only at
this commit: Catalog records its digest as a source, and it declares no hook, so
there is no Devin row. Codex, Gemini, Windsurf, Zed and Kiro run no Superpowers
hook. The inventory's provenance must name one of the vendor lock's components
(`runtime:superpowers-plugin`).

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
