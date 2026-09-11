/**
 * Real host acceptance without inference or private configuration.
 * Run: node --import tsx tools/verify-governed-mcp-hosts.mjs --targets codex,cursor
 * Optional --report ABSOLUTE_JSON_PATH and --copilot-binary ABSOLUTE_EXECUTABLE.
 * Missing/blocked hosts exit 2; failures exit 1.
 * This never invokes AIH against the checkout and never installs a host.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const allTargets = ["claude", "codex", "cursor", "copilot", "opencode", "kimi", "kiro"];
const fixtureScript = fileURLToPath(new URL("./governed-mcp-fixture.mjs", import.meta.url));
const maxOutput = 256 * 1024;
const binaryOverrides = new Map();

export function assertContained(base, target) {
  const parent = realpathSync(base);
  const candidate = realpathSync(target);
  const rel = relative(parent, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || lstatSync(target).isSymbolicLink()) {
    throw new Error("Fixture containment check failed");
  }
}

export function isolatedEnvironment(root, nonce, source = process.env) {
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  const home = join(root, "home");
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"), TEMP: join(root, "temp"), TMP: join(root, "temp"),
    CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
    COPILOT_HOME: join(home, ".copilot"), KIMI_CODE_HOME: join(home, ".kimi-code"), KIRO_HOME: join(home, ".kiro"),
    CI: "1", NO_COLOR: "1", NO_OPEN_BROWSER: "1", DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    AIH_MCP_FIXTURE_NONCE: nonce,
  });
  return env;
}

function executable(name) {
  const paths = (process.env.PATH ?? process.env.Path ?? "").split(delimiter);
  const extensions = process.platform === "win32" ? [".exe", ".ps1", ".cmd"] : [""];
  for (const dir of paths) for (const ext of extensions) {
    const path = join(dir, `${name}${ext}`);
    if (existsSync(path)) return path;
  }
}

function launchFor(target) {
  if (binaryOverrides.has(target)) return { executable: binaryOverrides.get(target), prefix: [] };
  const name = target === "cursor" ? "cursor-agent" : target === "kiro" ? "kiro-cli" : target;
  const path = executable(name);
  if (!path) return undefined;
  if (process.platform !== "win32" || path.endsWith(".exe")) return { executable: path, prefix: [] };
  // Resolve known npm launchers without a shell so stdin remains byte-preserving.
  if (target === "claude" || target === "opencode") {
    const packagePath = target === "claude" ? "@anthropic-ai/claude-code/bin/claude.exe" : "opencode-ai/bin/opencode.exe";
    const binary = join(dirname(path), "node_modules", ...packagePath.split("/"));
    if (existsSync(binary)) return { executable: binary, prefix: [] };
  }
  if (target === "codex") {
    const binary = join(dirname(path), "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    if (existsSync(binary)) return { executable: binary, prefix: [] };
  }
  if (target === "cursor") {
    const versionsPath = join(dirname(path), "versions");
    const versions = existsSync(versionsPath) ? readdirSync(versionsPath).filter((value) => /^\d{4}\.\d{2}\.\d{2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(value)).sort().reverse() : [];
    const runtime = versions.length ? join(versionsPath, versions[0]) : dirname(path);
    if (existsSync(join(runtime, "node.exe")) && existsSync(join(runtime, "index.js"))) return { executable: join(runtime, "node.exe"), prefix: [join(runtime, "index.js")] };
  }
  return undefined;
}

function startChild(launch, args, options) {
  const child = spawn(launch.executable, [...launch.prefix, ...args], { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const append = (current, chunk) => (current + chunk.toString("utf8")).slice(-maxOutput);
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  let error;
  child.on("error", (value) => { error = value.code ?? "spawn-failed"; });
  const completed = new Promise((done) => child.on("close", (code) => done({ code, error, stdout, stderr })));
  return { child, completed, output: () => stdout + stderr };
}

async function stopChild(running) {
  if (running.child.exitCode !== null || !running.child.pid) return;
  running.child.stdin.end();
  await bounded(running.completed, 600);
  if (running.child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(running.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise((done) => { killer.on("error", done); killer.on("close", done); });
  } else running.child.kill("SIGKILL");
  await bounded(running.completed, 1000);
}

async function bounded(work, timeout, fallback) {
  let timer;
  try { return await Promise.race([work, new Promise((done) => { timer = setTimeout(() => done(fallback), timeout); })]); }
  finally { clearTimeout(timer); }
}

async function runBounded(launch, args, options) {
  const running = startChild(launch, args, options);
  try {
    return await bounded(running.completed, options.timeout, { timeout: true, stdout: "", stderr: "" });
  } finally { await stopChild(running); }
}

const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };
function eventsAt(path) { return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []; }
function eventEvidence(events) {
  const methods = new Set(events.map((event) => event.method));
  return { initialized: methods.has("initialize"), catalogRequested: methods.has("tools/list"), toolCalled: methods.has("tools/call"), nonceVerified: events.length > 0 && events.every((event) => event.nonceVerified === true) };
}

export function hostVerdict(target, evidence, probe) {
  // Protocol requests can precede a host failure. They are never a successful
  // native catalog observation, even when the fixture nonce matches.
  if (probe.error || probe.protocolError || probe.protocolErrorCode !== undefined || (probe.code !== undefined && probe.code !== null && probe.code !== 0)) return { status: "failed", reason: "host-probe-failed" };
  if (probe.unavailable || probe.timeout) return { status: "unavailable", reason: probe.unavailable ?? "host-probe-timeout" };
  if (probe.code !== 0) return { status: "unavailable", reason: "host-probe-success-not-proved" };
  if (!evidence.initialized) return { status: "unavailable", reason: "host-did-not-initialize-configured-fixture" };
  if (!evidence.catalogRequested || !evidence.nonceVerified) return { status: "failed", reason: "fixture-handshake-incomplete-or-nonce-mismatch" };
  if (probe.catalogVisible !== true) return { status: "unavailable", reason: "native-tool-discovery-not-proved" };
  if (evidence.initialized && evidence.catalogRequested && evidence.nonceVerified) {
    if (target === "claude") return { status: "unavailable", nativeDefinitionStatus: "passed", reason: "native-definition-connected; governed-system-path-consumption-not-proved" };
    return { status: "passed", reason: "real-host-file-loaded-MCP-handshake-catalog-and-nonce" };
  }
}

async function projectFixture(target, options) {
  const { plan } = await import("../src/internals/plan.ts");
  const { executePlan } = await import("../src/internals/execute.ts");
  const { makeHostAdapter } = await import("../src/platform/detect.ts");
  const { entry } = await import("../src/internals/cli-registry.ts");
  const run = async () => { throw new Error("Projection must not execute a helper"); };
  const ctx = { root: options.cwd, contextDir: "ai-coding", posture: "enterprise", apply: true, verify: false, json: true, run, env: options.env, host: makeHostAdapter({ env: options.env, run }), options: {}, targets: [target] };
  const server = { type: "stdio", command: process.execPath, args: [fixtureScript, options.eventPath, options.nonce], description: "Harmless acceptance fixture", classification: "local", egress: "none", credentials: "none", supplyChain: "pinned" };
  const envReference = { AIH_MCP_FIXTURE_NONCE: "${AIH_MCP_FIXTURE_NONCE}" };
  // Copilot and current Kimi explicitly refuse unverified env-reference syntax.
  if (!["copilot", "kimi"].includes(target)) server.env = envReference;
  const servers = { fixture: server };
  let configPath, kind;
  if (target === "claude") {
    const { mcpEntries } = await import("../src/mcp/render.ts");
    const { managedMcpExample } = await import("../src/mcp/enterprise.ts");
    configPath = ".mcp.json";
    writeJson(join(options.cwd, configPath), { mcpServers: mcpEntries("claude", servers) });
    writeJson(join(options.cwd, "managed-mcp.json.example"), managedMcpExample(servers));
    writeJson(join(options.cwd, ".claude", "settings.local.json"), { enableAllProjectMcpServers: true, enabledMcpjsonServers: ["fixture"] });
    writeJson(join(options.env.HOME, ".claude.json"), { projects: { [options.cwd]: { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["fixture"] } } });
    writeJson(join(options.env.CLAUDE_CONFIG_DIR, ".claude.json"), { projects: { [options.cwd]: { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["fixture"] } } });
    kind = "native-renderer-project-config; managed-policy-not-proved";
  } else if (target === "kiro") {
    const { kiroMcpProjectionActions } = await import("../src/mcp/kiro-managed-projection.ts");
    await executePlan(plan("Fixture MCP", ...kiroMcpProjectionActions(ctx, servers)), ctx, { skipWorktreeGate: true });
    configPath = ".kiro/settings/mcp.json";
    kind = "governed-native-projection";
  } else {
    const { nativeMcpProjectionActions } = await import("../src/mcp/native-managed-projection.ts");
    await executePlan(plan("Fixture MCP", ...nativeMcpProjectionActions(ctx, target, servers)), ctx, { skipWorktreeGate: true });
    configPath = entry(target).mcp.governed.configPath;
    kind = "governed-native-projection";
  }
  return { configPath: join(options.cwd, configPath), kind, envMode: server.env ? "projected-reference" : "inherited-only; references-not-supported" };
}

async function rpcProbe(launch, options) {
  const running = startChild(launch, ["app-server", "--stdio", "--strict-config"], options);
  const pending = new Map();
  let buffer = "", counter = 0;
  running.child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { const msg = JSON.parse(line); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } catch { /* Non-JSON diagnostics are not evidence. */ }
    }
  });
  const request = (method, params) => new Promise((done) => {
    const id = ++counter; pending.set(id, done);
    running.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    const work = async () => {
      await request("initialize", { clientInfo: { name: "aih_fixture_acceptance", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      running.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      const reply = await request("mcpServerStatus/list", { cwd: options.cwd, limit: 20, detail: "toolsAndAuthOnly" });
      return { code: reply.error ? 1 : 0, protocolError: Boolean(reply.error), catalogVisible: JSON.stringify(reply.result ?? {}).includes("fixture_probe") };
    };
    return await bounded(work(), options.timeout, { timeout: true });
  } finally { await stopChild(running); }
}

async function kimiProbe(launch, options) {
  // A random high loopback port and isolated home keep this instance task-owned.
  const port = 30000 + Math.floor(Math.random() * 20000);
  const running = startChild(launch, ["web", "--no-open", "--host", "127.0.0.1", "--port", String(port)], options);
  try {
    const deadline = Date.now() + options.timeout;
    let token;
    while (Date.now() < deadline) {
      const output = running.output();
      // Never return startup output: it can contain the fixture's generated token.
      token = /(?:token[=: ]+|[?&]token=)([A-Za-z0-9_-]{20,})/i.exec(output)?.[1];
      if (token) break;
      if (running.child.exitCode !== null) return { unavailable: "isolated-kimi-server-exited-before-token" };
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!token) return { unavailable: "isolated-kimi-token-not-observed; startup-output-withheld" };
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const specification = await fetch(`${base}/openapi.json`, { headers, signal: AbortSignal.timeout(5000) });
    if (!specification.ok) return { unavailable: "isolated-kimi-live-spec-unavailable" };
    const spec = await specification.json();
    if (!spec.paths?.["/api/v2/mcp/servers:test"]) {
      const availableMcpRoutes = Object.keys(spec.paths ?? {}).filter((path) => path.includes("mcp"));
      if (!spec.paths?.["/api/v1/sessions"]?.post) return { unavailable: "installed-kimi-has-no-model-free-connection-route", availableMcpRoutes };
      const call = async (path, method = "GET", body) => {
        const response = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())) });
        return response.json();
      };
      // Create local runtime state only. Never submit a prompt, activate a skill,
      // generate a title, compact, or call any model-backed endpoint.
      const session = await call("/api/v1/sessions", "POST", { title: "MCP fixture acceptance", metadata: { cwd: options.cwd } });
      if (session.code !== 0 || !session.data?.id) return { unavailable: "isolated-kimi-session-initialization-unavailable", apiCode: session.code, availableMcpRoutes };
      const workspaceId = session.data.workspace_id;
      if (workspaceId && spec.paths?.["/api/v1/workspaces/{workspace_id}/trust"]?.post) await call(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/trust`, "POST", {});
      await call(`/api/v1/sessions/${encodeURIComponent(session.data.id)}/status`);
      while (Date.now() < deadline) {
        const catalog = await call("/api/v1/mcp/servers");
        const rows = catalog.data?.servers ?? [];
        if (rows.some((row) => row.name === "fixture" && row.status === "connected" && row.tool_count > 0)) return { code: 0, catalogVisible: true, availableMcpRoutes, localSessionOnly: true };
        await new Promise((done) => setTimeout(done, 100));
      }
      return { unavailable: "isolated-kimi-session-did-not-load-project-MCP", availableMcpRoutes, localSessionOnly: true };
    }
    const reply = await fetch(`${base}/api/v2/mcp/servers:test`, { method: "POST", headers, body: JSON.stringify({ name: "fixture", cwd: options.cwd }), signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())) });
    const result = await reply.json();
    return { code: result.code === 0 && result.data?.success ? 0 : 1, catalogVisible: String(result.data?.output ?? "").includes("fixture_probe"), apiCode: result.code };
  } finally { await stopChild(running); }
}

async function copilotAcpProbe(launch, options) {
  const running = startChild(launch, ["--acp", "--stdio", "--disable-builtin-mcps", "--no-remote", "--no-remote-export"], options);
  const pending = new Map();
  let buffer = "", counter = 0, acpInitialized = false, acpSessionCreated = false;
  running.child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const msg = JSON.parse(line);
        if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        else if (msg.id !== undefined && msg.method === "session/request_permission") running.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } })}\n`);
      } catch { /* Never disclose raw host output. */ }
    }
  });
  const request = (method, params) => new Promise((done) => {
    const id = ++counter; pending.set(id, done);
    running.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    const work = async () => {
      const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      if (initialized.error) return { unavailable: "copilot-ACP-initialization-rejected", protocolErrorCode: initialized.error.code };
      acpInitialized = true;
      const session = await request("session/new", { cwd: options.cwd, mcpServers: [] });
      if (session.error) return { unavailable: /authenticat|log.?in|sign.?in/i.test(session.error.message ?? "") ? "copilot-ACP-session-requires-authentication" : "copilot-ACP-session-rejected", protocolErrorCode: session.error.code };
      acpSessionCreated = Boolean(session.result?.sessionId);
      // Opening a session is the final request. Never send session/prompt.
      const deadline = Date.now() + options.timeout;
      while (Date.now() < deadline && running.child.exitCode === null) {
        if (eventEvidence(eventsAt(options.eventPath)).catalogRequested) return { code: 0, catalogVisible: false, unavailable: "copilot-native-tool-discovery-not-proved", localSessionOnly: true };
        await new Promise((done) => setTimeout(done, 100));
      }
      return { unavailable: "copilot-ACP-session-did-not-initialize-file-configured-fixture", localSessionOnly: true };
    };
    const reply = await bounded(work(), options.timeout, { timeout: true });
    return { ...reply, acpInitialized, acpSessionCreated };
  } finally { await stopChild(running); }
}

export async function verifyTarget(target, fixtureBase, timeout = 15000) {
  if (!allTargets.includes(target)) throw new Error("Unknown acceptance target");
  const root = mkdtempSync(join(fixtureBase, `${target}-`));
  assertContained(fixtureBase, root);
  const nonce = randomUUID();
  const env = isolatedEnvironment(root, nonce);
  const cwd = join(root, "workspace with spaces");
  const eventPath = join(root, "mcp-events.jsonl");
  for (const value of new Set([cwd, ...Object.entries(env).filter(([key]) => /HOME$|APPDATA$|TEMP$|TMP$/.test(key)).map(([, value]) => value)])) mkdirSync(value, { recursive: true });
  const result = { target, platform: process.platform, status: "unavailable", evidence: { initialized: false, catalogRequested: false, toolCalled: false, nonceVerified: false } };
  try {
    const launch = launchFor(target);
    if (!launch) return { ...result, reason: "host-native-executable-unavailable; no-install-attempted" };
    result.executable = launch.executable;
    if (launch.prefix.length) result.executableArguments = launch.prefix;
    const options = { cwd, env, nonce, eventPath, timeout };
    const version = await runBounded(launch, ["--version"], options);
    result.version = ((version.stdout ?? "").match(/(?:codex-cli |kiro-cli-chat )?\d[\w.+-]*(?: \(Claude Code\))?/)?.[0] ?? "unavailable").replace(/\.$/, "");
    if (version.timeout || version.error || version.code !== 0) return { ...result, reason: "isolated-host-version-unavailable" };
    if (target === "opencode" && !result.version.startsWith("1.")) return { ...result, reason: "OpenCode-V1-only; host-generation-not-supported" };
    Object.assign(result, await projectFixture(target, options));
    result.configSha256 = createHash("sha256").update(readFileSync(result.configPath)).digest("hex");
    if (target === "claude") {
      result.governedConsumptionProved = false;
      result.fixtureApproval = "isolated project settings enableAllProjectMcpServers/enabledMcpjsonServers and isolated user project trust/enabledMcpjsonServers";
      result.scopeLimitation = "Project .mcp.json only; system managed-settings.json/managed-mcp.json consumption requires a separate managed runner";
    }
    if (target === "copilot") {
      writeJson(join(env.COPILOT_HOME, "config.json"), { trustedFolders: [cwd] });
      const git = executable("git");
      if (!git || !git.endsWith(process.platform === "win32" ? ".exe" : "git")) return { ...result, reason: "Git-executable-unavailable-for-workspace-discovery" };
      const initialized = await runBounded({ executable: git, prefix: [] }, ["init", "--quiet"], { ...options, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(env.HOME, "empty-gitconfig") } });
      if (initialized.code !== 0) return { ...result, reason: "Fixture-git-initialization-unavailable" };
      result.fixtureApproval = "isolated COPILOT_HOME config.json trustedFolders and new fixture-only Git repository";
    }
    let probe;
    if (target === "codex") {
      // Trust only this temporary project; never copy real Codex config/auth.
      const escaped = cwd.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      writeFileSync(join(env.CODEX_HOME, "config.toml"), `[projects."${escaped}"]\ntrust_level = "trusted"\n`);
      result.probe = "codex app-server --stdio --strict-config; initialize; mcpServerStatus/list";
      probe = await rpcProbe(launch, options);
    } else if (target === "kimi") {
      result.probe = "kimi web --no-open --host 127.0.0.1; registered-server API probe";
      probe = await kimiProbe(launch, options);
      if (probe.availableMcpRoutes) result.availableMcpRoutes = probe.availableMcpRoutes;
      if (probe.localSessionOnly) {
        result.localSessionOnly = true;
        result.probe += "; V1 empty local session, fixture workspace trust, session status, MCP catalog";
      }
    } else {
      if (target === "cursor") {
        await runBounded(launch, ["mcp", "enable", "fixture"], options);
        result.fixtureApproval = "agent mcp enable fixture; isolated home only";
      }
      const args = target === "claude" ? ["mcp", "get", "fixture"] : target === "cursor" ? ["--approve-mcps", "mcp", "list-tools", "fixture"] : target === "opencode" ? ["--pure", "mcp", "list"] : target === "kiro" ? ["mcp", "status", "--name", "fixture"] : ["--disable-builtin-mcps", "mcp", "get", "fixture", "--json"];
      result.probe = `${target} ${args.join(" ")}`;
      probe = await runBounded(launch, args, options);
      probe.catalogVisible = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.includes("fixture_probe");
      const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
      result.fileReadConfirmed = output.includes(fixtureScript) || output.includes(JSON.stringify(fixtureScript).slice(1, -1));
      const diagnostic = output.split(/\r?\n/).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim()).find((line) => /error|unknown|not found|requires|untrusted|approval|permission|no |not |connected|status|loading/i.test(line) && !/[{}]|token|authorization|header|api.?key|environment/i.test(line));
      result.exitCode = probe.code ?? null;
      result.outputBytes = output.length;
      if (diagnostic) result.diagnostic = diagnostic.slice(0, 180);
      if (/authenticat|log.?in|sign.?in|api.?key/i.test(output) && !eventsAt(eventPath).length) probe.unavailable = "host-authentication-required-in-isolated-environment";
      if (/pending approval|not approved|trust/i.test(output) && !eventsAt(eventPath).length) probe.unavailable = "host-project-trust-or-approval-required";
    }
    if (target === "copilot") {
      result.managementProbe = result.probe;
      result.probe = "copilot --acp --stdio --disable-builtin-mcps --no-remote --no-remote-export; initialize; session/new; no prompt";
      probe = await copilotAcpProbe(launch, options);
      for (const key of ["localSessionOnly", "protocolErrorCode", "acpInitialized", "acpSessionCreated"]) if (probe[key] !== undefined) result[key] = probe[key];
    }
    if (target === "claude" && !eventEvidence(eventsAt(eventPath)).initialized) {
      // Remove automatic project discovery from this separate explicit-file probe.
      renameSync(result.configPath, join(cwd, ".mcp.project.json"));
      const examplePath = join(cwd, "managed-mcp.json.example");
      const explicit = await runBounded(launch, ["--mcp-config", examplePath, "--strict-mcp-config", "mcp", "get", "fixture"], options);
      const output = `${explicit.stdout ?? ""}${explicit.stderr ?? ""}`;
      result.explicitDefinitionProbe = { configPath: examplePath, configSha256: createHash("sha256").update(readFileSync(examplePath)).digest("hex"), command: "claude --mcp-config managed-mcp.json.example --strict-mcp-config mcp get fixture", exitCode: explicit.code ?? null, outputBytes: output.length, fileReadConfirmed: output.includes(fixtureScript), serverNotFound: /no MCP server|not found/i.test(output), envMode: "inherited-only; managed example omits env", evidence: eventEvidence(eventsAt(eventPath)), systemManagedEnforcement: false };
    }
    const events = eventsAt(eventPath);
    result.evidence = { ...eventEvidence(events), catalogVisible: Boolean(probe.catalogVisible), methods: [...new Set(events.map((event) => event.method))] };
    Object.assign(result, hostVerdict(target, result.evidence, probe));
    return result;
  } catch (error) {
    const site = String(error.stack ?? "").split("\n").find((line) => /^\s+at /.test(line));
    return { ...result, status: "failed", reason: `acceptance-error:${error.code ?? error.constructor.name}`, errorSite: site?.trim() };
  } finally {
    assertContained(fixtureBase, root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function main() {
  const args = process.argv.slice(2);
  let targets = allTargets, report, timeout = 15000;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--targets") targets = args.shift()?.split(",") ?? [];
    else if (arg === "--report") report = args.shift();
    else if (arg === "--timeout-ms") timeout = Number(args.shift());
    else if (arg === "--copilot-binary") {
      const path = args.shift();
      if (!path || !isAbsolute(path) || !existsSync(path) || !lstatSync(path).isFile()) throw new Error("Expected an existing absolute Copilot executable");
      binaryOverrides.set("copilot", realpathSync(path));
    }
    else throw new Error("Expected --targets, --report, --timeout-ms, or --copilot-binary");
  }
  if (!targets.length || targets.some((target) => !allTargets.includes(target)) || !Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) throw new Error("Invalid acceptance options");
  if (report && !isAbsolute(report)) throw new Error("Report path must be absolute");
  const baseParent = realpathSync(tmpdir());
  const base = mkdtempSync(join(baseParent, "aih-governed-hosts-"));
  const results = [];
  try {
    for (const target of targets) { const result = await verifyTarget(target, base, timeout); results.push(result); process.stdout.write(`${JSON.stringify(result)}\n`); }
  } finally { assertContained(baseParent, base); await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  const summary = { schemaVersion: 1, checkedAt: new Date().toISOString(), inferenceCalls: 0, cleanedUp: !existsSync(base), results };
  if (report) writeJson(report, summary);
  process.exitCode = results.some((result) => result.status === "failed") ? 1 : results.some((result) => result.status !== "passed") ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => {
  const site = String(error.stack ?? "").split("\n").find((line) => /^\s+at /.test(line));
  process.stderr.write(`${JSON.stringify({ error: "Host acceptance aborted; no raw host output disclosed", code: error.code ?? error.constructor.name, site: site?.trim(), operation: error.syscall })}\n`);
  process.exitCode = 1;
});
