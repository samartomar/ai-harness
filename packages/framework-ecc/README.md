# @aihq/framework-ecc

The [affaan-m/ECC](https://github.com/affaan-m/ECC) framework plugin for
[`@aihq/core`](https://github.com/samartomar/ai-harness). It owns the ECC-specific guidance, installed-state report, and receipt-bound
legacy cleanup. `aih ecc` does not install or update ECC; full ECC is
developer-managed. The plugin also retains legacy readers needed to identify
files earlier aih versions wrote. Future optional aih-owned copying of approved,
self-contained skills or agents for verified CLI pairs is a separate Cut 2
service and is not shipped here. Bundled code assets inside a self-contained
skill are content; independent runtime scripts and services remain
developer-managed. Core keeps generic command dispatch and Catalog access.

This package ships inside `@aihq/core` (under `packages/framework-ecc`); there
is nothing extra to install, and it is never published on its own:

```sh
npm install -g @aihq/core
```

If an install lacks it, `aih ecc` and ECC cleanup report
`framework-plugin-unavailable` and the reinstall route. ECC itself is third
party; aih reports its provenance, and developers run its own installer.

## How Core loads it (framework plugin contract 1)

- Core imports this package only from its bundled directory inside Core's own
  package directory, and checks the `aihFrameworkPluginV1` export: contract version 1,
  framework host API version 1, and this package's own `package.json` name and
  version. When `@aihq/catalog` is installed, the installed version must equal
  Catalog's identity record. Anything else wrong is
  `framework-plugin-incompatible`; there is no embedded fallback.
- The plugin imports Core only through `@aihq/core/framework-host`, plus Node
  built-ins and its own files (a Core test enforces this).
- Core routes generic framework operations to this plugin. The plugin supplies
  guidance, status, and receipt-bound cleanup for historical aih writes.

## Descriptor and evidence

The currently packaged Catalog descriptor retains historical ECC fields for
compatibility. Guidance and cleanup do not consume its install preview, module
graph, or profile graph. Cut 2 will change the Catalog shape and readers together.

## Hook controls

ECC hook execution and configuration are developer-managed. Historical
aih-written hook-control receipts are examined for cleanup; unproven or modified
settings are preserved and reported.
