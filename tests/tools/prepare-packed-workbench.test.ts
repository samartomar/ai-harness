import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  packedConsumerInstallFiles,
  packedUiBrowserPreload,
  productionClosure,
} from "../../tools/prepare-packed-workbench.mjs";

function removeTemporaryDirectory(directory: string) {
  const target = realpathSync(directory);
  if (dirname(target) === realpathSync(tmpdir())) {
    rmSync(target, { recursive: true, force: true });
  }
}

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

it("fails closed when the UI child attempts an unexpected spawn", () => {
  const directory = mkdtempSync(join(tmpdir(), "aih-packed-ui-preload-"));
  try {
    const preload = join(directory, "packed-ui-browser-preload.mjs");
    writeFileSync(preload, packedUiBrowserPreload());
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        "--input-type=module",
        "--eval",
        'import { spawn } from "node:child_process"; spawn("unexpected-command", []);',
      ],
      { encoding: "utf8", windowsHide: true },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Packed UI browser preload rejected unexpected spawn: unexpected-command",
    );
  } finally {
    removeTemporaryDirectory(directory);
  }
});
