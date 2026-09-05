import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve, sep } from "node:path";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rootPackageLock() {
  const lock = JSON.parse(readFileSync(resolve(sourceRoot, "package-lock.json"), "utf8"));
  if (lock.lockfileVersion !== 3 || !lock.packages || !lock.packages[""])
    throw new Error("Packed Workbench requires the root npm lockfile v3");
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
      name: "workbench-packed-consumer",
      private: true,
      dependencies: dependency,
    },
    lock: {
      name: "workbench-packed-consumer",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "workbench-packed-consumer",
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

/** A cold package consumer: no product command ever targets the source checkout. */
export function preparePackedWorkbench(directory) {
  const target = resolve(directory);
  const npmCandidate = process.env.npm_execpath?.replace(/npx-cli\.js$/u, "npm-cli.js");
  const npmCli = npmCandidate && existsSync(npmCandidate) ? npmCandidate
    : resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  if (!existsSync(npmCli)) throw new Error("npm CLI is unavailable for the packed Workbench smoke");
  function run(cwd, args) {
    const environment = { ...process.env };
    delete environment.AIH_ORG_POLICY;
    delete environment.AIH_POLICY_AUTHORITY_REPOSITORY;
    delete environment.AIH_POLICY_AUTHORITY_WORKFLOW;
    const result = spawnSync(process.execPath, args, {
      cwd, env: environment, encoding: "utf8", windowsHide: true, timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Packed Workbench fixture failed: " + (result.stderr || result.stdout).slice(0, 1000));
    return result.stdout;
  }
  const manifest = JSON.parse(run(sourceRoot, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", target]));
  const entry = manifest?.[0];
  const paths = entry?.files?.map(file => file.path);
  if (!Array.isArray(paths) || !paths.includes("dist/bundle.generated.cjs")) throw new Error("Packed Core is missing the browser bundle");
  if (paths.includes("aih-packs.json")) throw new Error("Removed aih-packs.json leaked into the package");
  const consumer = resolve(target, "packed-consumer");
  const admin = resolve(target, "packed-administrator");
  mkdirSync(consumer); mkdirSync(admin);
  const install = packedConsumerInstallFiles(entry);
  writeFileSync(resolve(consumer, "package.json"), JSON.stringify(install.manifest) + "\n");
  writeFileSync(resolve(consumer, "package-lock.json"), JSON.stringify(install.lock, null, 2) + "\n");
  run(consumer, [npmCli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const cli = resolve(consumer, "node_modules/@aihq/core/dist/cli.js");
  if (!cli.startsWith(target + sep) || !existsSync(cli)) throw new Error("Invalid packed Core CLI");
  const organizationManifest = resolve(admin, "organization-manifest.json");
  writeFileSync(organizationManifest, JSON.stringify({
    version: "organization-authoring-manifest/v1",
    source: { id: "source:packed-organization", revisionId: "revision:1", locator: "acme/portable-inputs" },
    assets: [
      { id: "mcp:packed", kind: "mcp", label: "Packed organization MCP", path: "mcp/packed.json" },
      { id: "skill:packed", kind: "skill", label: "Packed organization skill", path: "skills/packed/SKILL.md" },
      { id: "agent:packed", kind: "agent", label: "Packed organization agent", path: "agents/packed.md", requires: ["skill:packed"] },
    ],
  }) + "\n");
  const output = resolve(target, "packed-policy-workbench.html");
  const argumentsFor = out => [cli, "policy", "generate", "--apply", "--out", out, "--organization-manifest", organizationManifest];
  run(admin, argumentsFor(output));
  const repeated = resolve(target, "packed-policy-workbench-repeat.html");
  run(admin, argumentsFor(repeated));
  if (!readFileSync(output).equals(readFileSync(repeated))) throw new Error("Identical pinned inputs generated different offline artifact bytes");
  if (!existsSync(output)) throw new Error("Installed Core did not generate its Workbench");
  return { output, packageIntegrity: entry.integrity };
}
