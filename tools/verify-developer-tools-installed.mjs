#!/usr/bin/env node
/**
 * Installed developer-tools proof. Builds and packs this Core, installs it into
 * a disposable consumer, and runs the packed CLI only against a disposable
 * project with HOME, USERPROFILE, APPDATA, LOCALAPPDATA and XDG_* redirected
 * into the same disposable root, so no real user configuration is read or
 * written. It proves real Code Review Graph, Codebase Memory and Headroom
 * setups: exact host entries (Claude, Cursor and Codex), receipts, real MCP
 * handshakes launched from those host entries, and Headroom deactivation
 * leaving no AIH-owned Headroom state. An upstream failure is recorded
 * verbatim, never relabelled as success.
 *
 * usage: node tools/verify-developer-tools-installed.mjs --evidence-dir <new-dir>
 *          [--work-root <existing-dir>] [--skip-build]
 *
 * On Windows, Codebase Memory refuses to run below a directory whose ACL lets
 * other identities modify it (the user's %TEMP% on hosts with sandbox ACEs);
 * pass a --work-root inside the user profile, for example %LOCALAPPDATA%.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { packedConsumerInstallFiles, packedNpmChild } from "./lib/packed-consumer.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
const evidenceDir = option("--evidence-dir");
const workRoot = realpathSync(option("--work-root") ?? tmpdir());
const skipBuild = argv.includes("--skip-build");
if (evidenceDir === undefined || !isAbsolute(evidenceDir) || existsSync(evidenceDir)) {
  throw new Error("--evidence-dir must name a new absolute directory");
}
const npmCli =
  process.env.npm_execpath?.endsWith("npm-cli.js") === true
    ? process.env.npm_execpath
    : join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
if (!existsSync(npmCli)) throw new Error("npm-cli.js is required beside the running Node");

const HOSTS = ["claude", "codex", "cursor"];
const PRIMARIES = ["code-review-graph", "codebase-memory-mcp"];
const HEADROOM_TOOLS = ["headroom_compress", "headroom_retrieve", "headroom_stats"];
const PINS = {
  "code-review-graph": "code-review-graph==2.3.8",
  "codebase-memory-mcp": "codebase-memory-mcp==0.10.8",
  headroom: "headroom-ai[mcp]==0.38.0",
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const temp = realpathSync(mkdtempSync(join(workRoot, "aihw4-")));
const home = join(temp, "h");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^AIH(?:_|$)/iu.test(key) && !/^npm_config_/iu.test(key),
  ),
);
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(temp, "r"),
  LOCALAPPDATA: join(temp, "l"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  AIH_LOG: "0",
});
if (process.platform === "win32") {
  env.HOMEDRIVE = home.slice(0, 2);
  env.HOMEPATH = home.slice(2);
} else {
  env.XDG_RUNTIME_DIR = join(temp, "x");
}
const emptyUserConfig = join(temp, "empty.npmrc");
const evidence = {
  format: "aih-developer-tools-installed-proof",
  version: 1,
  timestamp: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  temporaryRoot: "<temp>",
  redirectedEnvironment: [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    ...(process.platform === "win32" ? ["HOMEDRIVE", "HOMEPATH"] : ["XDG_RUNTIME_DIR"]),
  ],
  checks: [],
  failures: [],
};
const redact = (value) =>
  String(value)
    .split(temp)
    .join("<temp>")
    .split(temp.replaceAll("\\", "/"))
    .join("<temp>")
    .split(temp.replaceAll("\\", "\\\\"))
    .join("<temp>");
const scrub = (value) => (value === undefined ? undefined : JSON.parse(redact(JSON.stringify(value))));

function check(name, ok, data = {}) {
  evidence.checks.push({ name, outcome: ok ? "pass" : "fail", ...data });
  if (!ok) evidence.failures.push(name);
  process.stdout.write(`${name}: ${ok ? "pass" : "FAIL"}\n`);
  return ok;
}

function run(args, cwd, options = {}) {
  const started = Date.now();
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    env: options.env ?? env,
    encoding: "utf8",
    timeout: options.timeout ?? 20 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { ...result, durationMs: Date.now() - started };
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (${result.status}): ${redact((result.stderr || result.stdout).slice(-2400))}`,
    );
  }
  return result.stdout;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function lockDigest(directory) {
  const pyproject = sha256(readFileSync(join(directory, "pyproject.toml")));
  const lock = sha256(readFileSync(join(directory, "uv.lock")));
  return sha256([pyproject, lock].join("\0"));
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function listFiles(root) {
  const out = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      out.push(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Launch one host entry exactly as a client would and exchange MCP messages. */
function mcpSession(label, server, calls, cwd) {
  return new Promise((done) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(server.command, server.args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      done({ label, ok: false, failure: redact(error.message) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const responses = new Map();
    const waiters = new Map();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined) {
            responses.set(message.id, message);
            waiters.get(message.id)?.(message);
          }
        } catch {
          // Non-protocol output surfaces through stderr and the timeout.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8000);
    });
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 10_000).unref();
      done({ label, durationMs: Date.now() - started, stderrTail: redact(stderr.slice(-1500)), ...result });
    };
    timer = setTimeout(() => finish({ ok: false, failure: "session timed out after 600s" }), 600_000);
    child.once("error", (error) => finish({ ok: false, failure: redact(error.message) }));
    child.once("exit", (code) => finish({ ok: false, failure: `server exited ${code} before completing` }));
    const request = (id, method, params) =>
      new Promise((answer) => {
        if (responses.has(id)) answer(responses.get(id));
        waiters.set(id, answer);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    (async () => {
      const initialized = await request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "aih-installed-proof", version: "1" },
      });
      if (initialized.error) return finish({ ok: false, failure: "initialize returned an error" });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
      );
      const listed = await request(2, "tools/list", {});
      const tools = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
      const results = [];
      let id = 3;
      for (const call of calls) {
        const args = typeof call.arguments === "function" ? call.arguments(results) : call.arguments;
        const answer = await request(id++, "tools/call", { name: call.name, arguments: args });
        const text = (answer.result?.content ?? [])
          .filter((item) => item?.type === "text")
          .map((item) => item.text)
          .join("\n");
        results.push({
          name: call.name,
          arguments: scrub(args),
          isError: answer.error !== undefined || answer.result?.isError === true,
          textSha256: sha256(text),
          textBytes: Buffer.byteLength(text),
          preview: redact(text.slice(0, 700)),
          text,
        });
      }
      finish({
        ok: true,
        serverInfo: initialized.result?.serverInfo,
        protocolVersion: initialized.result?.protocolVersion,
        tools,
        calls: results.map(({ text: _text, ...rest }) => rest),
        callTexts: results.map((result) => result.text),
      });
    })().catch((error) => finish({ ok: false, failure: redact(error.message) }));
  });
}

/** Processes whose command line still names the disposable root (for example a native daemon). */
function processesUsingTemp() {
  const result =
    process.platform === "win32"
      ? spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.ExecutablePath)`t$($_.CommandLine)\" }",
          ],
          { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        )
      : spawnSync("ps", ["-eo", "pid=,comm=,args="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.includes(temp) && !line.includes("verify-developer-tools-installed"))
    .map((line) => redact(line).slice(0, 300));
}

function safeCleanup() {
  const resolved = realpathSync(temp);
  if (!resolved.startsWith(`${workRoot}${sep}aihw4-`)) {
    return { removed: false, detail: "refusing to remove an unexpected temp target" };
  }
  // A native daemon started by an MCP session can outlive it and keep the
  // project directory open; record it and wait before reporting a leftover.
  const started = Date.now();
  const lingering = processesUsingTemp();
  let last;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      return {
        removed: true,
        attempts: attempt + 1,
        waitedMs: Date.now() - started,
        processesUsingTempAtCleanup: lingering,
      };
    } catch (error) {
      last = error;
      sleep(5_000);
    }
  }
  return {
    removed: false,
    detail: redact(last?.message ?? "unknown"),
    processesUsingTempAtCleanup: lingering,
    processesUsingTempAfterWait: processesUsingTemp(),
  };
}

const commands = [];

async function main() {
  for (const directory of [
    home,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
    env.XDG_STATE_HOME,
  ])
    mkdirSync(directory, { recursive: true });
  if (env.XDG_RUNTIME_DIR) mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(emptyUserConfig, "");

  // Build and pack this Core, then install the exact tarball like a consumer.
  const npmEnv = { ...env, npm_config_userconfig: emptyUserConfig };
  if (!skipBuild)
    requireSuccess(run([process.execPath, npmCli, "run", "build"], repo, { env: { ...process.env } }), "Core build");
  const packed = JSON.parse(
    requireSuccess(
      run([process.execPath, npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", temp], repo, {
        env: npmEnv,
      }),
      "Core pack",
    ),
  );
  const tarball = join(temp, packed[0].filename);
  const consumer = join(temp, "c");
  mkdirSync(consumer);
  const installFiles = packedConsumerInstallFiles(packed[0]);
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify(installFiles.manifest, null, 2)}\n`);
  writeFileSync(join(consumer, "package-lock.json"), `${JSON.stringify(installFiles.lock, null, 2)}\n`);
  const install = packedNpmChild(
    [process.execPath, npmCli, "ci", "--no-audit", "--no-fund", "--ignore-scripts", "--omit=optional"],
    emptyUserConfig,
    npmEnv,
  );
  requireSuccess(run(install.args, consumer, { env: install.environment }), "Core consumer install");
  const installed = realpathSync(join(consumer, "node_modules", "@aihq", "core"));
  const cli = join(installed, "dist", "cli.js");
  check("packed-install", existsSync(cli), {
    version: packed[0].version,
    archiveSha256: sha256(readFileSync(tarball)),
    installedRoot: redact(installed),
    uv: run(["uv", "--version"], temp).stdout.trim(),
    git: run(["git", "--version"], temp).stdout.trim(),
  });

  // Disposable target project, with user-authored host configuration to preserve.
  let project = join(temp, "p");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, ".cursor"));
  mkdirSync(join(home, ".codex"));
  writeFileSync(
    join(project, "src", "app.ts"),
    'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n\nexport function main(): void {\n  console.log(greet("aih"));\n}\n',
  );
  const operator = { command: "operator-tool", args: ["serve"] };
  for (const path of [join(project, ".mcp.json"), join(project, ".cursor", "mcp.json")])
    writeFileSync(path, `${JSON.stringify({ mcpServers: { "operator-owned": operator } }, null, 2)}\n`);
  writeFileSync(join(home, ".codex", "config.toml"), '# operator-owned setting\nmodel = "operator-model"\n');
  writeFileSync(
    join(project, "aih-org-policy.json"),
    `${JSON.stringify(
      {
        schemaVersion: 3,
        minimumCoreVersion: "0.7.0",
        minimumPosture: "vibe",
        references: { repoContract: "ai-coding/project.json" },
        authoringSelections: {
          selectionVersion: "workbench-selection/v1",
          roots: [],
          exclusions: [],
          requests: [],
          drafts: [],
        },
        developerTools: { selected: ["code-review-graph", "codebase-memory-mcp", "headroom"] },
      },
      null,
      2,
    )}\n`,
  );
  for (const args of [
    ["git", "init", "-q"],
    ["git", "add", "-A"],
    ["git", "-c", "user.name=aih proof", "-c", "user.email=proof@example.invalid", "commit", "-q", "-m", "fixture"],
  ])
    requireSuccess(run(args, project), args.slice(0, 2).join(" "));
  project = realpathSync(project);
  evidence.fixture = {
    policySelection: ["code-review-graph", "codebase-memory-mcp", "headroom"],
    hosts: HOSTS,
    reason:
      "the temp V3 policy limits setup to the three tools under proof; the other defaults are covered by their own tests",
  };

  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  const hostEntries = (name) => ({
    claude: readJson(join(project, ".mcp.json")).mcpServers?.[name],
    cursor: readJson(join(project, ".cursor", "mcp.json")).mcpServers?.[name],
    codex: parseToml(readFileSync(join(home, ".codex", "config.toml"), "utf8")).mcp_servers?.[name],
  });
  const preserved = () => {
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8").replace(/\r\n/gu, "\n");
    return (
      stable(hostEntries("operator-owned").claude) === stable(operator) &&
      stable(hostEntries("operator-owned").cursor) === stable(operator) &&
      toml.includes('# operator-owned setting\nmodel = "operator-model"')
    );
  };
  // AIH refuses to overwrite uncommitted configuration, so commit what each run
  // generated, as a user would, before the next run.
  const commitGenerated = (label) => {
    requireSuccess(run(["git", "add", "-A"], project), "git add");
    const staged = run(["git", "diff", "--cached", "--quiet"], project);
    if (staged.status !== 0)
      requireSuccess(
        run(["git", "-c", "user.name=aih proof", "-c", "user.email=proof@example.invalid", "commit", "-q", "-m", label], project),
        "git commit",
      );
  };
  const aih = (label, args) => {
    const command = ["aih", ...args.map((arg) => (arg === project ? "<project>" : arg)), "--json"];
    commands.push({ label, command: command.join(" ") });
    const result = run([process.execPath, cli, ...args, "--json"], project, { timeout: 30 * 60_000 });
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      payload = undefined;
    }
    if (result.status === 0) commitGenerated(label);
    return { ...result, payload };
  };
  const runData = (result) => ({
    exitCode: result.status,
    durationMs: result.durationMs,
    tools: Object.fromEntries(
      (result.payload?.tools ?? []).map((tool) => [
        tool.id,
        { state: tool.state, detail: redact(tool.detail).slice(0, 900) },
      ]),
    ),
    primaryCodeGraph: result.payload?.primaryCodeGraph,
    ...(result.status === 0
      ? {}
      : {
          error: redact(result.payload?.error?.message ?? ""),
          stdoutTail: result.payload === undefined ? redact(result.stdout.slice(-2000)) : undefined,
          stderrTail: redact(result.stderr.slice(-2000)),
        }),
  });
  const toolState = (result, id) => result.payload?.tools?.find((tool) => tool.id === id)?.state;
  const compact = process.platform === "win32";
  const stateBase = compact ? env.LOCALAPPDATA : env.XDG_STATE_HOME;
  const layoutBase = join(stateBase, "aih", compact ? "d" : "developer-tools", compact ? "p" : "projects");
  const projectState = () => {
    const keys = existsSync(layoutBase) ? readdirSync(layoutBase) : [];
    return keys.length === 1 ? join(layoutBase, keys[0]) : undefined;
  };
  const developerToolsReceipt = () => {
    const root = projectState();
    const path = root === undefined ? undefined : join(root, "developer-tools-receipt.json");
    return path !== undefined && existsSync(path) ? readJson(path) : undefined;
  };
  const headroomRoot = () => {
    const root = projectState();
    return root === undefined ? undefined : join(root, compact ? "h" : "headroom");
  };
  const hostArgs = ["--cli", HOSTS.join(",")];

  // 1-2: ordinary apply with each primary code graph; Headroom stays pending.
  for (const primary of PRIMARIES) {
    const result = aih(`apply-primary-${primary}`, [
      "developer-tools",
      project,
      "--apply",
      ...hostArgs,
      "--primary-code-graph",
      primary,
    ]);
    const recorded = developerToolsReceipt()?.primaryCodeGraph;
    check(
      `apply-primary-${primary}`,
      result.status === 0 &&
        toolState(result, "code-review-graph") === "verified" &&
        toolState(result, "codebase-memory-mcp") === "verified" &&
        toolState(result, "headroom") === "selected-pending" &&
        result.payload?.primaryCodeGraph?.id === primary &&
        recorded?.id === primary &&
        recorded?.source === "user",
      { ...runData(result), recordedPrimaryCodeGraph: recorded },
    );
  }
  const pendingRoot = headroomRoot();
  check(
    "headroom-selected-does-nothing",
    Object.values(hostEntries("headroom")).every((entry) => entry === undefined) &&
      (pendingRoot === undefined || !existsSync(pendingRoot)),
    { headroomStateRootPresent: pendingRoot !== undefined && existsSync(pendingRoot) },
  );

  // Exact Code Review Graph and Codebase Memory entries in every host.
  const runtimeScript = join(installed, "dist", "ecc-runtime.js");
  const defaultLock = join(installed, "src", "ecc-profile", "default-mcp-runtime");
  const defaultDigest = lockDigest(defaultLock);
  for (const id of ["code-review-graph", "codebase-memory-mcp"]) {
    const entries = hostEntries(id);
    const entry = entries.claude;
    const args = entry?.args ?? [];
    check(
      `host-entries-${id}`,
      entry?.type === "stdio" &&
        entry.command === process.execPath &&
        entry.env === undefined &&
        args[0] === runtimeScript &&
        args[1] === id &&
        argValue(args, "--package") === PINS[id] &&
        argValue(args, "--dependency-lock-sha256") === defaultDigest &&
        argValue(args, "--lock-root") === defaultLock &&
        argValue(args, "--project") === project &&
        argValue(args, "--state-root")?.startsWith(`${layoutBase}${sep}`) === true &&
        stable(entries.cursor) === stable(entry) &&
        entries.codex?.command === entry.command &&
        stable(entries.codex?.args) === stable(entry.args),
      {
        claude: scrub(entry),
        codex: scrub(entries.codex),
        cursorEqualsClaude: stable(entries.cursor) === stable(entry),
        authenticatedDependencyLockSha256: defaultDigest,
      },
    );
  }
  check("user-config-preserved-after-apply", preserved());

  // 3: activation without egress consent is refused before any change.
  const projectSnapshot = () =>
    listFiles(project)
      .filter((path) => !/[\\/]\.git(?:[\\/]|$)/u.test(path))
      .map((path) => (lstatSync(path).isFile() ? `${redact(path)}:${sha256(readFileSync(path))}` : redact(path)))
      .sort()
      .join("\n");
  const before = projectSnapshot();
  const refused = aih("activate-without-consent", [
    "developer-tools",
    project,
    "--apply",
    ...hostArgs,
    "--activate-headroom",
  ]);
  check(
    "activation-without-consent-refused",
    refused.status !== 0 &&
      /--accept-headroom-egress/u.test(refused.payload?.error?.message ?? "") &&
      projectSnapshot() === before &&
      !existsSync(headroomRoot() ?? join(temp, "absent")),
    { exitCode: refused.status, error: redact(refused.payload?.error?.message ?? "") },
  );

  // 4: explicit, consented activation.
  const activated = aih("activate-headroom", [
    "developer-tools",
    project,
    "--apply",
    ...hostArgs,
    "--activate-headroom",
    "--accept-headroom-egress",
  ]);
  check(
    "activate-headroom",
    activated.status === 0 && toolState(activated, "headroom") === "verified",
    runData(activated),
  );
  const stateRoot = headroomRoot();
  const receiptPath = stateRoot === undefined ? undefined : join(stateRoot, "activation.json");
  const receipt = receiptPath !== undefined && existsSync(receiptPath) ? readJson(receiptPath) : undefined;
  const headroomLock = join(installed, "src", "tools", "headroom-runtime");
  check(
    "headroom-activation-receipt",
    receipt?.version === "aih-headroom-activation-receipt/v1" &&
      receipt.consent?.activateHeadroom === true &&
      receipt.consent?.acceptHeadroomEgress === true &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(receipt.consent?.acceptedAt ?? "") &&
      receipt.pin?.package === PINS.headroom &&
      receipt.lock?.dependencyLockSha256 === lockDigest(headroomLock) &&
      stable(receipt.hosts) === stable(HOSTS) &&
      receipt.launcher?.sha256 === sha256(stable(receipt.launcher?.server ?? {})) &&
      receipt.egressControls?.HEADROOM_BEACON === "off" &&
      receipt.egressControls?.DO_NOT_TRACK === "1" &&
      receipt.egressControls?.HEADROOM_UPDATE_CHECK === "off",
    { receipt: scrub(receipt) },
  );
  const headroom = hostEntries("headroom");
  check(
    "host-entries-headroom",
    headroom.claude !== undefined &&
      stable(headroom.claude) === stable(receipt?.launcher?.server) &&
      stable(headroom.cursor) === stable(receipt?.launcher?.server) &&
      headroom.codex?.command === receipt?.launcher?.server?.command &&
      stable(headroom.codex?.args) === stable(receipt?.launcher?.server?.args) &&
      headroom.claude.command === process.execPath &&
      headroom.claude.args?.[0] === runtimeScript &&
      headroom.claude.args?.[1] === "headroom" &&
      argValue(headroom.claude.args, "--dependency-lock-sha256") === lockDigest(headroomLock) &&
      argValue(headroom.claude.args, "--lock-root") === headroomLock,
    {
      claude: scrub(headroom.claude),
      codex: scrub(headroom.codex),
      authenticatedDependencyLockSha256: lockDigest(headroomLock),
    },
  );
  check("user-config-preserved-after-activation", preserved());

  // 5: real MCP handshakes launched from the exact host entries.
  const crg = await mcpSession(
    "code-review-graph",
    hostEntries("code-review-graph").claude,
    [
      {
        name: "detect_changes_tool",
        arguments: {
          changed_files: ["src/app.ts"],
          include_source: false,
          max_depth: 1,
          detail_level: "minimal",
          max_results: 5,
          max_flows: 5,
        },
      },
    ],
    project,
  );
  check(
    "handshake-code-review-graph",
    crg.ok === true && crg.tools?.includes("detect_changes_tool") && crg.calls?.[0]?.isError === false,
    { session: { ...crg, callTexts: undefined } },
  );
  const cbm = await mcpSession(
    "codebase-memory-mcp",
    hostEntries("codebase-memory-mcp").claude,
    [
      { name: "list_projects", arguments: {} },
      {
        name: "search_graph",
        arguments: (results) => {
          const inventory = JSON.parse(results[0]?.text || "{}");
          return {
            project: inventory.projects?.[0]?.name ?? "",
            label: "Function",
            limit: 5,
            format: "json",
          };
        },
      },
    ],
    project,
  );
  check(
    "handshake-codebase-memory-mcp",
    cbm.ok === true &&
      cbm.tools?.includes("search_graph") &&
      cbm.calls?.every((call) => call.isError === false) &&
      /greet/u.test(cbm.callTexts?.[1] ?? ""),
    { session: { ...cbm, callTexts: undefined } },
  );
  const original = JSON.stringify(
    Array.from({ length: 120 }, (_, index) => ({
      id: index,
      status: index % 9 === 0 ? "error" : "ok",
      message: `event ${index} processed by the installed proof`,
    })),
  );
  const hdr = await mcpSession(
    "headroom",
    headroom.claude ?? { command: "headroom-entry-missing", args: [] },
    [
      { name: "headroom_compress", arguments: { content: original } },
      {
        name: "headroom_retrieve",
        arguments: (results) => ({ hash: JSON.parse(results[0]?.text || "{}").hash ?? "" }),
      },
      { name: "headroom_stats", arguments: {} },
    ],
    project,
  );
  const parse = (text) => {
    try {
      return JSON.parse(text ?? "{}");
    } catch {
      return {};
    }
  };
  const compressed = parse(hdr.callTexts?.[0]);
  const retrieved = parse(hdr.callTexts?.[1]);
  const stats = parse(hdr.callTexts?.[2]);
  check(
    "handshake-headroom",
    hdr.ok === true &&
      stable(hdr.tools) === stable(HEADROOM_TOOLS) &&
      hdr.calls?.every((call) => call.isError === false) &&
      typeof compressed.hash === "string" &&
      retrieved.original_content === original &&
      stats.compressions >= 1,
    {
      session: { ...hdr, callTexts: undefined },
      compression: {
        originalTokens: compressed.original_tokens,
        compressedTokens: compressed.compressed_tokens,
        transforms: compressed.transforms,
      },
      retrievalRoundTrip: retrieved.original_content === original,
      statsCompressions: stats.compressions,
    },
  );
  check("headroom-no-user-home-state", !existsSync(join(home, ".headroom")), {
    userHomeHeadroomDirectory: existsSync(join(home, ".headroom")),
  });
  evidence.processesUsingTempAfterSessions = processesUsingTemp();

  // 6: deactivation removes only AIH-owned Headroom material.
  const deactivated = aih("deactivate-headroom", [
    "developer-tools",
    project,
    "--apply",
    ...hostArgs,
    "--deactivate-headroom",
  ]);
  const remaining = hostEntries("headroom");
  const leftovers = listFiles(stateBase).filter(
    (path) =>
      (stateRoot !== undefined && (path === stateRoot || path.startsWith(`${stateRoot}${sep}`))) ||
      /headroom/iu.test(path),
  );
  check(
    "deactivate-headroom",
    deactivated.status === 0 &&
      toolState(deactivated, "headroom") === "selected-pending" &&
      Object.values(remaining).every((entry) => entry === undefined) &&
      hostEntries("code-review-graph").claude !== undefined &&
      hostEntries("codebase-memory-mcp").claude !== undefined &&
      (stateRoot === undefined || !existsSync(stateRoot)) &&
      leftovers.length === 0 &&
      !existsSync(join(home, ".headroom")),
    {
      ...runData(deactivated),
      remainingHeadroomHostEntries: Object.entries(remaining)
        .filter(([, entry]) => entry !== undefined)
        .map(([host]) => host),
      headroomStateRootPresent: stateRoot !== undefined && existsSync(stateRoot),
      leftoverHeadroomPaths: leftovers.map(redact),
    },
  );
  check("user-config-preserved-after-deactivation", preserved());
}

try {
  await main();
} catch (error) {
  evidence.failures.push("proof-error");
  evidence.error = redact(error instanceof Error ? error.message : String(error));
  process.stderr.write(`${evidence.error}\n`);
} finally {
  evidence.commands = commands;
  evidence.outcome = evidence.failures.length === 0 ? "pass" : "fail";
  evidence.cleanup = safeCleanup();
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "installed-proof.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`outcome: ${evidence.outcome}\n`);
  if (evidence.outcome !== "pass") process.exitCode = 1;
}
