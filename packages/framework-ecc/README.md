# @aihq/framework-ecc

The [affaan-m/ECC](https://github.com/affaan-m/ECC) framework plugin for
[`@aihq/core`](https://github.com/samartomar/ai-harness). It carries everything
ECC-specific that `aih` does: component selection, the evidence-gated install
and materialization planning per CLI, the ECC MCP add/remove plans, the governed
Claude/Codex profile, the ECC hook inventory and the hook control plan. Core
keeps the `aih ecc` command surface, the policy decisions, the Catalog access,
the evidence gate and every executor.

```sh
npm install -g @aihq/core @aihq/framework-ecc
# in a project
npm install @aihq/core @aihq/framework-ecc
```

Without this package, `aih ecc`, governed delivery that selects ECC components
and ECC uninstall/prune refuse with `framework-plugin-unavailable` and name the
install command; `aih doctor` and `aih report` state that ECC checks were not
run. ECC itself is third party: aih records its components with provenance and
ECC's own installer runs them.

## How Core loads it (framework plugin contract 1)

- Core imports this package only by its literal name, from its own install
  tree, and checks the `aihFrameworkPluginV1` export: contract version 1,
  framework host API version 1, and this package's own `package.json` name and
  version. When `@aihq/catalog` is installed, the installed version must equal
  Catalog's identity record. Anything else wrong is
  `framework-plugin-incompatible`; there is no embedded fallback.
- The plugin imports Core only through `@aihq/core/framework-host`, plus Node
  built-ins and its own files (a Core test enforces this).
- Effects run in Core. A command invocation receives a Core runtime bound to
  that invocation (`ctx.host.runtime`): the plan context Core decided, and
  Core's plan executor, evidence pipeline, source acquisition and policy
  readers. The runtime carries the invocation's policy transaction pins and
  refuses once the invocation ends. Read-only operations (description, hook
  inventory, component identification) receive no runtime.
- Governed delivery (`aih policy project`, `aih init` on a policy-bound
  project) uses `policyDelivery`: `prepare` verifies the policy's ECC selection
  and holds the exact bytes in memory, Core projects its own policy settings,
  then Core calls `commit` at most once, with the binding assertion it re-read
  after projection, and ends the invocation.

## Descriptor sections this plugin reads

Catalog publishes `./catalog-framework-ecc.json` as
`{ "format": "aih-catalog-framework-descriptor", "version": 1, "frameworkId": "ecc", "sections": { ... } }`.
Sections the plugin does not read are ignored.

- `vendorLock` (every operation): the vendor-lock source entry. The pin must be
  the upstream this plugin version supports
  (`affaan-m/ECC@5064474d4d762dc9640234a41617cccb79185cec`, v2.2.1); its `components`
  give each evidence component's source paths.
- `hookControlInventory` (hook operations): ECC hook rows, profiles and each
  row's disable eligibility, declarations (`host`, `sourcePath`, `event`,
  `execution`; default: Claude `hooks/hooks.json`) and control
  (`claude-settings-env` or `none`; default: the Claude settings switch for an
  eligible row). None of it is fixed in code: the plugin checks that the
  provenance names the pinned commit and that its content digest is the digest
  of its source list, and that ids are unique and profiles declared.
- `moduleGraph`, `profileGraph`: ECC's install modules and profiles.
- `installPreview`: the source-free install preview for dry runs.

## Hook controls

`planHookControls` accepts the merged request Core builds from enterprise
policy (`governance.frameworkHookControls.ecc`) and the project's
`.aih-config.json` `frameworkHookControls.ecc` list (a user may only add
disables; enterprise wins). It refuses an unknown hook id, a hook that is not
individually disable-eligible, an unknown profile and a hook the chosen profile
never runs. A row with control `none` (for example ECC's OpenCode plugin
`.opencode/plugins/ecc-hooks.ts`) can be disabled and is planned, labelled
`unenforced` with a next route: aih cannot switch it off on its own. For rows
with the Claude settings switch, ECC reads `ECC_HOOK_PROFILE` and the
comma-separated `ECC_DISABLED_HOOKS` from the Claude settings environment, so
the plan returns those two values for Core's hook registrar to write. On a host
a row does not declare, the decision is `not-applicable`.
