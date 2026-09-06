import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
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

export function packedUiBrowserPreload() {
  return String.raw`import childProcess from "node:child_process";
const originalSpawn = childProcess.spawn.bind(childProcess);
import { syncBuiltinESMExports } from "node:module";

const marker = "__AIH_PACKED_UI_BROWSER_OPEN__";
const expected = process.platform === "win32"
  ? { command: "rundll32.exe", prefix: "url.dll,FileProtocolHandler" }
  : process.platform === "darwin"
    ? { command: "open", prefix: undefined }
    : { command: "xdg-open", prefix: undefined };

childProcess.spawn = function patchedSpawn(command, args = [], options = {}) {
  const values = Array.isArray(args) ? args : [];
  const url = values.at(-1);
  const expectedLength = expected.prefix === undefined ? 1 : 2;
  const matches = command === expected.command &&
    Array.isArray(args) &&
    values.length === expectedLength &&
    typeof url === "string" &&
    url.startsWith("http://127.0.0.1:") &&
    (expected.prefix === undefined || values[0] === expected.prefix) &&
    options.detached === true &&
    options.shell === false &&
    options.stdio === "ignore" &&
    options.windowsHide === true;
  if (!matches) throw new Error("Packed UI browser preload rejected unexpected spawn: " + String(command));
  process.stderr.write(marker + JSON.stringify({
    command,
    args: values,
    detached: options.detached === true,
    shellDisabled: options.shell === false,
    windowsHide: options.windowsHide === true,
  }) + "\n");
  return originalSpawn(process.execPath, ["-e", ""], {
    detached: options.detached === true,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
};
syncBuiltinESMExports();
`;
}

function packedUiSmokeController() {
  return String.raw`import { spawn } from "node:child_process";

const [cli, preload] = process.argv.slice(2);
if (!cli || !preload) throw new Error("Packed UI smoke requires installed CLI and preload paths");
const marker = "__AIH_PACKED_UI_BROWSER_OPEN__";
const child = spawn(process.execPath, ["--import", preload, cli, "--ui"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let stdout = "";
let stderr = "";
let settled = false;
let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
function evidence() {
  const url = stdout.match(/AIH Policy Workbench: (http:\/\/127\.0\.0\.1:\d+\/aih-policy-workbench\.html)/u)?.[1];
  const line = stderr.split(/\r?\n/u).find((value) => value.startsWith(marker));
  if (!url || !line) return undefined;
  return { url, browser: JSON.parse(line.slice(marker.length)) };
}
function check() {
  if (settled) return;
  const value = evidence();
  if (value !== undefined) {
    settled = true;
    resolveReady(value);
  }
}
function waitForClose(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Installed CLI UI did not exit within " + String(timeoutMs) + "ms")), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (value) => { stdout += value; check(); });
child.stderr.on("data", (value) => { stderr += value; check(); });
child.once("error", (error) => {
  if (!settled) {
    settled = true;
    rejectReady(error);
  }
});
const timeout = setTimeout(() => {
  if (!settled) {
    settled = true;
    rejectReady(new Error("Timed out waiting for installed CLI UI startup: " + stderr));
  }
}, 15_000);
try {
  const started = await ready;
  const response = await fetch(started.url, { signal: AbortSignal.timeout(5_000) });
  const html = await response.text();
  const modelMarker = "window.__aihWorkbenchModel=";
  const start = html.indexOf(modelMarker);
  const end = html.indexOf("<\/script>", start);
  if (response.status !== 200 || start < 0 || end < 0) throw new Error("Installed CLI UI did not serve the Workbench document");
  const model = JSON.parse(html.slice(start + modelMarker.length, end).trim().replace(/;$/u, ""));
  const bundle = model.workbenchBundle;
  const catalogAssets = Object.values(bundle?.assets ?? {});
  const catalogSourceIds = [...new Set(catalogAssets.map((asset) => asset?.sourceId).filter((sourceId) => typeof sourceId === "string"))].sort();
  const initialRows = (html.match(/<article\b[^>]*data-workbench-asset-id/gu) ?? []).length;
  if (
    !bundle ||
    typeof bundle.assets !== "object" ||
    bundle.assets === null ||
    typeof bundle.sources !== "object" ||
    bundle.sources === null ||
    catalogAssets.length === 0 ||
    initialRows > 50 ||
    !["source:aih-core", "source:ecc", "source:superpowers"].every((sourceId) => catalogSourceIds.includes(sourceId))
  ) throw new Error("Installed CLI UI returned an invalid baseline catalog");
  const closed = waitForClose(5_000);
  if (!child.kill("SIGTERM")) throw new Error("Installed CLI UI did not accept SIGTERM");
  const shutdown = await closed;
  if (shutdown.code !== 0 && shutdown.signal !== "SIGTERM") throw new Error("Installed CLI UI did not close cleanly: " + JSON.stringify(shutdown));
  process.stdout.write(JSON.stringify({
    url: started.url,
    initialRows,
    catalogSourceIds,
    browser: started.browser,
    shutdown,
    response: {
      cacheControl: response.headers.get("cache-control"),
      contentType: response.headers.get("content-type"),
    },
  }) + "\n");
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) {
    const reaped = waitForClose(5_000);
    if (!child.kill("SIGKILL")) throw new Error("Installed CLI UI could not be force-stopped");
    await reaped;
  }
}
`;
}

function defaultBrowserExpectation() {
  if (process.platform === "win32") return { command: "rundll32.exe", prefix: "url.dll,FileProtocolHandler" };
  if (process.platform === "darwin") return { command: "open", prefix: undefined };
  return { command: "xdg-open", prefix: undefined };
}

function packedUiSmoke(target, admin, cli, run) {
  const preload = resolve(target, "packed-ui-browser-preload.mjs");
  const controller = resolve(target, "packed-ui-smoke.mjs");
  writeFileSync(preload, packedUiBrowserPreload());
  writeFileSync(controller, packedUiSmokeController());
  const before = new Set(readdirSync(admin));
  const ui = JSON.parse(run(admin, [controller, cli, pathToFileURL(preload).href]));
  const expected = defaultBrowserExpectation();
  if (
    !Number.isInteger(ui.initialRows) ||
    ui.initialRows < 0 ||
    ui.initialRows > 50 ||
    !Array.isArray(ui.catalogSourceIds) ||
    !["source:aih-core", "source:ecc", "source:superpowers"].every((sourceId) => ui.catalogSourceIds.includes(sourceId)) ||
    ui.browser?.command !== expected.command ||
    ui.browser?.args?.at(-1) !== ui.url ||
    (expected.prefix !== undefined && ui.browser.args[0] !== expected.prefix) ||
    ui.browser?.detached !== true ||
    ui.browser?.shellDisabled !== true ||
    ui.browser?.windowsHide !== true ||
    ui.response?.cacheControl !== "no-store" ||
    ui.response?.contentType !== "text/html; charset=utf-8"
  ) throw new Error("Installed CLI UI smoke receipt is invalid");
  const adminWrites = readdirSync(admin).filter((entry) => !before.has(entry));
  if (adminWrites.length) throw new Error("Installed CLI UI wrote the admin fixture: " + adminWrites.join(", "));
  return { url: ui.url, initialRows: ui.initialRows, catalogSourceIds: ui.catalogSourceIds, browserOpenRequested: true, shutdown: ui.shutdown, adminWrites };
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
  const installedPackage = JSON.parse(readFileSync(resolve(consumer, "node_modules/@aihq/core/package.json"), "utf8"));
  if (installedPackage.bin?.aih !== "dist/cli.js") throw new Error("Installed Core does not expose the aih package bin");
  const ui = packedUiSmoke(target, admin, cli, run);
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
  return { output, packageIntegrity: entry.integrity, ui };
}
