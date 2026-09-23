import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Keep npm transport settings without inheriting script policy or user config. */
export function packedNpmChild(args, userconfig, inherited = process.env) {
  const environment = Object.fromEntries(
    Object.entries(inherited).filter(
      ([name]) => !/^npm_config_(?:allow[-_]scripts|userconfig)$/iu.test(name),
    ),
  );
  environment.npm_config_userconfig = userconfig;
  return { args: [...args, "--userconfig", userconfig], environment };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rootPackageLock() {
  const lock = JSON.parse(readFileSync(resolve(sourceRoot, "package-lock.json"), "utf8"));
  if (lock.lockfileVersion !== 3 || !lock.packages || !lock.packages[""])
    throw new Error("Packed Core requires the root npm lockfile v3");
  return lock;
}

function packagePathFor(packages, parentPath, dependency) {
  let current = parentPath;
  for (;;) {
    const candidate = current
      ? current + "/node_modules/" + dependency
      : "node_modules/" + dependency;
    if (packages[candidate]) return candidate;
    if (current === "") return undefined;
    const parent = current.lastIndexOf("/node_modules/");
    current = parent < 0 ? "" : current.slice(0, parent);
  }
}

export function productionClosure(lock) {
  const root = lock.packages[""];
  const selected = {};
  const pending = Object.keys({ ...(root.dependencies ?? {}), ...(root.optionalDependencies ?? {}) }).map((name) => ({
    name,
    parentPath: "",
  }));

  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) continue;
    const path = packagePathFor(lock.packages, next.parentPath, next.name);
    if (!path) throw new Error("Missing production dependency in root npm lock: " + next.name);
    if (selected[path]) continue;

    const record = lock.packages[path];
    if (
      !record ||
      typeof record.version !== "string" ||
      typeof record.resolved !== "string" ||
      typeof record.integrity !== "string"
    )
      throw new Error("Root npm lock lacks exact tarball identity for " + path);

    selected[path] = clone(record);
    for (const name of Object.keys({ ...(record.dependencies ?? {}), ...(record.optionalDependencies ?? {}) }))
      pending.push({ name, parentPath: path });
  }
  return selected;
}

export function packedConsumerInstallFiles(entry) {
  if (
    !entry ||
    entry.name !== "@aihq/core" ||
    typeof entry.filename !== "string" ||
    typeof entry.version !== "string" ||
    typeof entry.integrity !== "string" ||
    basename(entry.filename) !== entry.filename
  )
    throw new Error("Unexpected packed Core manifest");

  const lock = rootPackageLock();
  const core = lock.packages[""];
  if (entry.version !== core.version)
    throw new Error("Packed Core version does not match the root npm lock");
  const tarball = "file:../" + entry.filename;
  const dependency = { "@aihq/core": tarball };
  return {
    manifest: {
      name: "packed-core-consumer",
      private: true,
      dependencies: dependency,
    },
    lock: {
      name: "packed-core-consumer",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "packed-core-consumer",
          dependencies: dependency,
        },
        "node_modules/@aihq/core": {
          version: entry.version,
          resolved: tarball,
          integrity: entry.integrity,
          ...(core.bin ? { bin: clone(core.bin) } : {}),
          ...(core.engines ? { engines: clone(core.engines) } : {}),
          dependencies: clone(core.dependencies ?? {}),
          ...(core.optionalDependencies ? { optionalDependencies: clone(core.optionalDependencies) } : {}),
        },
        ...productionClosure(lock),
      },
    },
  };
}
