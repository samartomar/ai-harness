# Plan Canvas runtime source fixture

This directory is the minimal runtime closure consumed by the Plan Canvas
adapter tests. It is not the full ECC repository and is not included in the npm
package.

- Source: `affaan-m/ECC`
- Immutable commit: `0c1d7be9a750627fb2a6534c78a998cc46d03f9c`
- Package metadata: `ecc-universal@2.1.0`
- License: MIT; see `LICENSE` in this directory

Every consumed runtime path, byte length, and SHA-256 is independently pinned
by `PLAN_CANVAS_RUNTIME_PIN.sourceFiles`. Tests fail closed if this fixture or a
materialized runtime drifts.
