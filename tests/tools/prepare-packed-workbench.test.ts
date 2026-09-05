import { expect, it } from "vitest";
import {
  packedConsumerInstallFiles,
  productionClosure,
} from "../../tools/prepare-packed-workbench.mjs";

function packageRecord(dependencies = {}) {
  return {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
    integrity: "sha512-example",
    dependencies,
  };
}

it("resolves a nested dependency from its hoisted root-lock location", () => {
  const closure = productionClosure({
    packages: {
      "": { dependencies: { root: "1.0.0" }, optionalDependencies: { optional: "1.0.0" } },
      "node_modules/root": packageRecord({ nested: "1.0.0" }),
      "node_modules/root/node_modules/nested": packageRecord({ hoisted: "1.0.0" }),
      "node_modules/hoisted": packageRecord(),
      "node_modules/optional": packageRecord(),
    },
  });

  expect(Object.keys(closure).sort()).toEqual([
    "node_modules/hoisted",
    "node_modules/optional",
    "node_modules/root",
    "node_modules/root/node_modules/nested",
  ]);
});

it("rejects a packed Core tarball version that differs from the root lock", () => {
  expect(() =>
    packedConsumerInstallFiles({
      name: "@aihq/core",
      filename: "aihq-core-mismatch.tgz",
      version: "999.0.0",
      integrity: "sha512-test",
    }),
  ).toThrow("Packed Core version does not match the root npm lock");
});
