import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  packedConsumerInstallFiles,
  packedNpmChild,
  productionClosure,
} from "../../tools/lib/packed-consumer.mjs";

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

it("builds a neutral consumer lock from the exact root production closure", () => {
  const rootLock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8"));
  const entry = {
    name: "@aihq/core",
    filename: "aihq-core-local.tgz",
    version: rootLock.packages[""].version,
    integrity: "sha512-packed-core",
  };
  const { manifest, lock } = packedConsumerInstallFiles(entry);
  const packages = lock.packages as Record<string, unknown>;
  expect(manifest.name).toBe("packed-core-consumer");
  expect(lock.name).toBe("packed-core-consumer");
  expect(packages["node_modules/@aihq/core"]).toMatchObject({
    version: entry.version,
    resolved: "file:../aihq-core-local.tgz",
    integrity: entry.integrity,
  });
  expect(Object.keys(packages).sort()).toEqual(
    ["", "node_modules/@aihq/core", ...Object.keys(productionClosure(rootLock))].sort(),
  );
});

it("isolates packed npm from poisoned script and user config while preserving transport settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "aih-packed-npm-config-"));
  try {
    const emptyUserConfig = join(directory, "empty.npmrc");
    const poisonedUserConfig = join(directory, "poisoned.npmrc");
    writeFileSync(emptyUserConfig, "");
    writeFileSync(poisonedUserConfig, "allow-scripts=unrelated-package\n");
    const npmCandidate = process.env.npm_execpath?.replace(/npx-cli\.js$/u, "npm-cli.js");
    const npmCli =
      npmCandidate && existsSync(npmCandidate)
        ? npmCandidate
        : resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    if (!existsSync(npmCli)) throw new Error("npm CLI is required for the packed fixture test");
    const child = packedNpmChild([npmCli, "config", "get", "userconfig"], emptyUserConfig, {
      ...process.env,
      npm_config_allow_scripts: "unrelated-package",
      NPM_CONFIG_ALLOW_SCRIPTS: "another-package",
      "npm_config_allow-scripts": "hyphen-package",
      "NPM_CONFIG_ALLOW-SCRIPTS": "upper-hyphen-package",
      "NpM_CoNfIg_AlLoW-ScRiPtS": "mixed-hyphen-package",
      npm_config_userconfig: poisonedUserConfig,
      NPM_CONFIG_USERCONFIG: poisonedUserConfig,
      npm_config_registry: "https://registry.npmjs.org/",
      HTTPS_PROXY: "http://fixture-proxy.invalid:8080",
      NODE_EXTRA_CA_CERTS: "fixture-ca.pem",
    });
    expect(child.args.slice(-2)).toEqual(["--userconfig", emptyUserConfig]);
    expect(
      Object.keys(child.environment).filter((key) => /^npm_config_allow[-_]scripts$/iu.test(key)),
    ).toEqual([]);
    expect(
      Object.keys(child.environment).filter((key) => /^npm_config_userconfig$/iu.test(key)),
    ).toEqual(["npm_config_userconfig"]);
    expect(child.environment).toMatchObject({
      npm_config_userconfig: emptyUserConfig,
      npm_config_registry: "https://registry.npmjs.org/",
      HTTPS_PROXY: "http://fixture-proxy.invalid:8080",
      NODE_EXTRA_CA_CERTS: "fixture-ca.pem",
    });
    const actual = spawnSync(process.execPath, child.args, {
      cwd: directory,
      env: child.environment,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(actual.status, actual.stderr).toBe(0);
    expect(resolve(actual.stdout.trim())).toBe(resolve(emptyUserConfig));
  } finally {
    removeTemporaryDirectory(directory);
  }
});
