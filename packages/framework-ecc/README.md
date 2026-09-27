# @aihq/framework-ecc

The [affaan-m/ECC](https://github.com/affaan-m/ECC) framework plugin bundled
with [`@aihq/core`](https://github.com/samartomar/ai-harness).

`aih ecc` prints pinned, target-specific commands for a developer-managed ECC
installation. `aih ecc --status` reports only the presence of ECC's own install
state files. aih does not install, update, configure, or remove ECC.

This plugin also reads authenticated Catalog descriptors for inventory and
policy reporting. Third-party entries stay visible and selectable. Capability
package operations label ECC entries `developer-managed` and route the developer
to `aih ecc` for the exact commands.

The plugin ships inside `@aihq/core`; there is no separate package to install.
Core loads it through framework plugin contract 1 and verifies its bundled
package identity against Catalog when Catalog is installed. A missing bundled
plugin reports `framework-plugin-unavailable` with the Core reinstall route.
