#!/usr/bin/env node
// Explicit native acceptance only; never part of routine doctor or the unit suite.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const opt = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!key?.startsWith("--") || value === undefined || opt[key]) throw new Error("invalid-arguments");
  opt[key] = value;
}
for (const key of ["--aih", "--policy", "--blocked-policy", "--opencode", "--bwrap", "--seccomp",
  "--mcp-script", "--plugin-script", "--plugin-runtime", "--managed-runtime", "--evidence-dir", "--runtime-path"]) {
  if (!isAbsolute(opt[key] ?? "") || !existsSync(opt[key])) throw new Error(`missing-${key.slice(2)}`);
}
if (process.platform !== "linux" || process.getuid?.() === 0) throw new Error("requires-unprivileged-linux");
const evidenceBase = realpathSync(opt["--evidence-dir"]);
if (evidenceBase.startsWith("/tmp/")) throw new Error("evidence-must-survive-private-tmp");
const evidence = mkdtempSync(join(evidenceBase, "attempt-"));
const fixture = mkdtempSync(join(evidenceBase, ".fixture-"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const textHash = (value) => createHash("sha256").update(value).digest("hex");
const jsonLines = (path) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const save = (name, value) => writeFileSync(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const report = {
  kind: "aih-opencode-repeatable-native-v1", status: "failed", startedAt: new Date().toISOString(),
  scope: "Real AIH CLI, OpenCode shell and MCP dispatch; deterministic local provider, no real inference/authentication/paid usage/vendor-native sandbox claim",
  filesystemExposure: "Host / is read-only but generally readable; selected root writable with protected control mounts; explicit hidden paths, private proc/dev/tmp/network and apply-seccomp",
  runtime: { node: process.version, uid: process.getuid(), kernel: readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(),
    hashes: Object.fromEntries(["--opencode", "--bwrap", "--seccomp", "--policy", "--mcp-script", "--plugin-script"].map((key) => [key.slice(2), hash(opt[key])])) },
  evidence, fixture, checks: {}, launches: [],
};
let operation = 0;
async function execute(executable, argv, cwd, { expect = 0, label = argv[0] } = {}) {
  const id = `${String(++operation).padStart(2, "0")}-${label.replaceAll(/[^a-z0-9-]/gi, "_")}`;
  const child = spawn(executable, argv, { cwd, detached: true,
    env: { PATH: `${opt["--runtime-path"]}:/usr/bin:/bin`, HOME: join(fixture, "operator-home"),
      AIH_CREDENTIAL_SENTINEL: "synthetic-fixture-only" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false, overflow = false;
  const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  for (const [stream, name] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      if (name === "stdout") stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 2_000_000) { overflow = true; stop(); }
    });
  }
  const timer = setTimeout(() => { timedOut = true; stop(); }, 150_000);
  let code, signal, spawnError;
  try { [code, signal] = await new Promise((done, reject) => { child.once("error", reject); child.once("close", (...args) => done(args)); }); }
  catch (error) { spawnError = error.message; }
  finally { clearTimeout(timer); stop(); }
  const result = { id, executable, argv, cwd, hostPid: child.pid, code, signal, timedOut, overflow, spawnError, stdout, stderr };
  save(`${id}.json`, result);
  if (spawnError || timedOut || overflow || (expect !== "any" && (expect === "nonzero" ? code === 0 : code !== expect))) throw new Error(`operation-failed:${id}`);
  return result;
}
const aih = (root, args, options) => execute(opt["--aih"], [...args, "--no-log", "--json"], root, options);
const git = (root, args) => execute("/usr/bin/git", args, root);
function snapshot(root) {
  const result = {};
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) result[relative(root, full)] = hash(full);
    }
  }
  visit(root);
  return result;
}
const profile = (root) => join(root, ".aih/sandbox/opencode.json");
const material = (role, path) => ({ role, path: realpathSync(path), sha256: hash(path) });
function packageBinEntry(manifestPath) {
  const packageRoot = dirname(manifestPath);
  const bin = JSON.parse(readFileSync(manifestPath, "utf8"))?.bin;
  const target = typeof bin === "string" ? bin : bin && typeof bin === "object" && !Array.isArray(bin)
    ? bin["mcp-server-sequential-thinking"] : undefined;
  if (typeof target !== "string" || !target || isAbsolute(target)) throw new Error("managed-mcp-bin-invalid");
  const entry = resolve(packageRoot, target);
  const contained = relative(packageRoot, entry);
  if (contained === "" || contained === ".." || contained.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(contained)) throw new Error("managed-mcp-bin-outside-package");
  return realpathSync(entry);
}
function returnedObjects(value) {
  if (Array.isArray(value)) return value.flatMap(returnedObjects);
  if (value && typeof value === "object") return [value, ...returnedObjects(value.text ?? value.content)];
  if (typeof value !== "string") return [];
  try { return returnedObjects(JSON.parse(value)); }
  catch {
    const start = value.indexOf("{"), end = value.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    try { return returnedObjects(JSON.parse(value.slice(start, end + 1))); } catch { return []; }
  }
}
function jsonOutput(value) {
  const candidates = [value, ...value.split("\n").filter(Boolean)];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* keep trying JSON lines */ }
  }
  throw new Error("cli-json-output-invalid");
}
function runtimeEvidenceFrom(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = runtimeEvidenceFrom(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    if (value.requested === true && value.targetCli === "opencode" && typeof value.recordState === "string") return value;
    if (value.runtimeEvidence && typeof value.runtimeEvidence === "object") return value.runtimeEvidence;
    for (const item of Object.values(value)) {
      const found = runtimeEvidenceFrom(item);
      if (found) return found;
    }
  }
  return undefined;
}
function readinessFrom(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readinessFrom(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    if (typeof value.banner === "string" && Array.isArray(value.blockers)) return value;
    for (const item of Object.values(value)) {
      const found = readinessFrom(item);
      if (found) return found;
    }
  }
  return undefined;
}
function assertRuntimeEvidence(result, expectedState) {
  const evidence = runtimeEvidenceFrom(jsonOutput(result.stdout));
  const restrictions = evidence?.restrictions ?? [];
  const statuses = ["supported", "discovered", "exercised", "restart", "enforcement"];
  const restrictionKeys = new Set(restrictions.map((item) => `${item.boundary}\u0000${item.id}`));
  const passed = evidence?.requested === true
    && evidence.targetCli === "opencode"
    && evidence.source === "local-unsigned-observation"
    && evidence.recordState === expectedState
    && (expectedState === "current" ? evidence.reasons?.length === 0 && statuses.every((key) => evidence[key] === "verified")
      : evidence.reasons?.length > 0 && statuses.every((key) => evidence[key] === "unverified"))
    && evidence.operation?.server === "fixture"
    && evidence.operation?.tool === "fixture_probe"
    && (expectedState !== "current" || restrictions.length === 14 && restrictionKeys.size === 14 && restrictions.every((item) => item.status === "verified"));
  if (!passed) throw new Error(`runtime-evidence-${expectedState}-invalid`);
  return evidence;
}
const tcp = createServer((socket) => { tcpHits += 1; socket.on("error", () => {}); socket.end(); });
const unix = createServer((socket) => { unixHits += 1; socket.on("error", () => {}); socket.end(); });
let tcpHits = 0, unixHits = 0, canariesStarted = false;
const unixPath = join(fixture, "host.sock");
const protectedRead = join(fixture, "protected-read"), protectedWrite = join(fixture, "protected-write");
const readBytes = `READ_${randomUUID()}\n`, writeBytes = `WRITE_${randomUUID()}\n`;
let tcpPort;
async function control(endpoint) {
  await new Promise((done, reject) => {
    const socket = connect(endpoint);
    socket.once("connect", () => { socket.destroy(); done(); }); socket.once("error", reject);
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error("host-control-timeout")); });
  });
}
const configs = new Map();
const setupArgs = (root) => ["sandbox", "--root", root, "--cli", "opencode", "--policy", opt["--policy"],
  "--binding", `AIH_OPENCODE_NONCE=${configs.get(root).nonce}`, "--binding", `PATH=${dirname(process.execPath)}:${opt["--runtime-path"]}:/usr/bin:/bin`,
  "--binding", "OPENCODE_DISABLE_MODELS_FETCH=1", "--binding", "OPENCODE_DISABLE_AUTOUPDATE=1",
  "--binding", "OPENCODE_DISABLE_DEFAULT_PLUGINS=1", "--binding", "OPENCODE_DISABLE_LSP_DOWNLOAD=1",
  "--hide-path", protectedRead, "--read-only-path", protectedWrite,
  "--bwrap-executable", opt["--bwrap"], "--opencode-executable", opt["--opencode"], "--seccomp-executable", opt["--seccomp"],
  "--client-arg", "run", "--client-arg=--model", "--client-arg", "aih-loopback/fixture-model",
  "--client-arg", "Execute the three explicitly approved fictional probes once.", "--apply", "--force"];
async function setup(root) {
  const cfg = { root, marker: `OPENCODE_${randomUUID()}\n`, nonce: randomUUID(), node: process.execPath,
    mcpScript: opt["--mcp-script"], policy: opt["--policy"], protectedRead: join(protectedRead, "read.txt"),
    protectedWrite: join(protectedWrite, "write.txt"), tcpPort, unixPath };
  configs.set(root, cfg);
  writeFileSync(join(root, "marker.txt"), cfg.marker);
  writeFileSync(join(root, "fixture.json"), JSON.stringify(cfg));
  mkdirSync(join(root, ".opencode/plugins"), { recursive: true });
  cpSync(opt["--plugin-runtime"], join(root, ".opencode"), { recursive: true });
  copyFileSync(opt["--plugin-script"], join(root, ".opencode/plugins/aih-loopback.js"));
  cpSync(join(opt["--managed-runtime"], "node_modules"), join(root, "node_modules"), { recursive: true });
  const config = { $schema: "https://opencode.ai/config.json", autoupdate: false, snapshot: false,
    model: "aih-loopback/fixture-model",
    permission: { "*": "deny", bash: "allow", fixture_fixture_probe: "allow", "sequential-thinking_*": "allow" },
    provider: { "aih-loopback": { npm: "@ai-sdk/openai-compatible", name: "Fictional local provider",
      options: { baseURL: "http://127.0.0.1:43792/v1", apiKey: "fictional-local-marker" },
      models: { "fixture-model": { name: "fixture-model", tool_call: true } } } },
    mcp: { fixture: { type: "local", command: [cfg.node, cfg.mcpScript, join(root, "fixture.json")], enabled: true } } };
  writeFileSync(join(root, "opencode.json"), JSON.stringify(config));
  await aih(root, ["init", root, "--cli", "opencode", "--policy", opt["--policy"], "--apply", "--force"]);
  await aih(root, ["policy", "project", root, "--cli", "opencode", "--policy", opt["--policy"], "--apply", "--force"]);
  await aih(root, ["policy", "evaluate", root, "--cli", "opencode", "--posture", "enterprise", "--policy", opt["--policy"]]);
  await aih(root, setupArgs(root));
  const before = snapshot(root);
  await aih(root, setupArgs(root));
  report.checks[`repeatSetup_${basename(root)}`] = JSON.stringify(before) === JSON.stringify(snapshot(root));
  const projected = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8"));
  report.checks[`permissionsPreserved_${basename(root)}`] = JSON.stringify(config.permission) === JSON.stringify(projected.permission);
  report.checks[`managedIdentity_${basename(root)}`] = JSON.stringify(projected.mcp["sequential-thinking"]?.command) === JSON.stringify(["npx", "-y", "@modelcontextprotocol/server-sequential-thinking@2026.7.4"]);
  report.checks[`operatorMcpPreserved_${basename(root)}`] = JSON.stringify(projected.mcp.fixture) === JSON.stringify(config.mcp.fixture);
  cpSync(opt["--plugin-runtime"], join(root, ".aih/sandbox/opencode-home/.config/opencode"), { recursive: true });
  writeFileSync(join(root, ".aih/sandbox/opencode-home/operator-state.txt"), "unrelated fictional user state\n");
}
const launchArgs = (root) => ["sandbox", "--root", root, "--cli", "opencode", "--launch", "--apply", "--force"];
async function launch(label, root) {
  const observedAt = new Date().toISOString();
  const cfg = configs.get(root);
  const providerPath = join(root, "provider-events.jsonl"), eventsPath = join(root, "fixture.json.events.jsonl");
  const beforeProvider = jsonLines(providerPath).length, beforeEvents = jsonLines(eventsPath).length;
  const cli = await aih(root, launchArgs(root), { label });
  const provider = jsonLines(providerPath).slice(beforeProvider), events = jsonLines(eventsPath).slice(beforeEvents);
  save(`${label}-native.json`, { cliReceipt: cli.id, provider, events });
  const returned = provider.find((entry) => entry.event === "tool-results");
  const probes = events.filter((entry) => entry.event === "probe").map((entry) => entry.result);
  report.checks[`${label}_toolTurnProtocol`] = provider.filter((entry) => entry.event === "request" && entry.body.tools?.length).length === 2;
  const denied = ["EACCES", "EPERM", "EROFS", "EBUSY"];
  report.checks[`${label}_nativeReturns`] = returned?.complete === true && probes.length === 2 && ["shell", "mcp"].every((kind) => probes.some((probe) => probe.kind === kind));
  report.checks[`${label}_returnedValues`] = ["call_shell", "call_fixture"].every((id) => {
    const content = returned?.returns.find((value) => value.tool_call_id === id)?.content;
    const kind = id === "call_shell" ? "shell" : "mcp";
    return returnedObjects(content).some((value) => value.kind === kind && value.root === root
      && value.marker === cfg.marker && value.nonceVerified === true && value.policyVerified === true
      && probes.some((probe) => Object.keys(probe).every((key) => probe[key] === value[key])));
  });
  const managed = returned?.returns.find((value) => value.tool_call_id === "call_managed");
  report.checks[`${label}_managedOperation`] = returnedObjects(managed?.content).some((value) =>
    value.thoughtNumber === 1 && value.totalThoughts === 1 && value.nextThoughtNeeded === false
    && value.thoughtHistoryLength === 1);
  report.checks[`${label}_rootBindingsAndDenials`] = probes.length === 2 && probes.every((p) => p.root === root && p.marker === cfg.marker && p.nonceVerified && p.policyVerified && p.syntheticEnvAbsent && p.homeMatches && p.allowedWrite
    && p.protectedReadCode === "ENOENT" && denied.includes(p.protectedWriteCode) && denied.includes(p.profileWriteCode) && denied.includes(p.configWriteCode) && denied.includes(p.ancestorRenameCode)
    && ["EACCES", "EPERM", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"].includes(p.tcpCode) && p.unixCode === "EPERM");
  const called = events.filter((entry) => entry.method === "tools/call");
  report.checks[`${label}_configuredMcpInvoked`] = called.length === 1
    && events.some((entry) => entry.method === "initialize" && entry.pid === called[0].pid)
    && events.some((entry) => entry.method === "tools/list" && entry.pid === called[0].pid)
    && provider.some((entry) => entry.event === "selected-tools" && entry.names.includes("fixture_fixture_probe"))
    && probes.some((p) => p.kind === "mcp" && p.pid === called[0].pid);
  report.launches.push({ label, root, hostAihPid: cli.hostPid, boot: provider.find((entry) => entry.event === "started")?.boot,
    clientNamespace: provider.find((entry) => entry.event === "started")?.pidNamespace });
  if (Object.entries(report.checks).some(([name, passed]) => name.startsWith(`${label}_`) && !passed)) {
    throw new Error(`native-return-validation-failed:${label}`);
  }
  return { cli, provider, events, probes, boot: provider.find((entry) => entry.event === "started")?.boot, observedAt };
}
function runtimeObservation(root, first, restart, version, effects) {
  const cfg = configs.get(root);
  const restrictions = [
    ["protected-read", "protectedReadCode", (value) => value === "ENOENT"],
    ["protected-write", "protectedWriteCode", (value) => ["EACCES", "EPERM", "EROFS", "EBUSY"].includes(value)],
    ["sandbox-profile-write", "profileWriteCode", (value) => ["EACCES", "EPERM", "EROFS", "EBUSY"].includes(value)],
    ["native-config-write", "configWriteCode", (value) => ["EACCES", "EPERM", "EROFS", "EBUSY"].includes(value)],
    ["control-directory-rename", "ancestorRenameCode", (value) => ["EACCES", "EPERM", "EROFS", "EBUSY"].includes(value)],
    ["tcp-connect", "tcpCode", (value) => ["EACCES", "EPERM", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"].includes(value)],
    ["unix-connect", "unixCode", (value) => value === "EPERM"],
  ];
  const allProbes = [...first.probes, ...restart.probes];
  const rows = ["shell", "mcp"].flatMap((kind) => restrictions.map(([id, key, denied]) => {
    const probes = allProbes.filter((probe) => probe.kind === kind);
    const observed = probes.length === 2 && probes.every((probe) => denied(probe[key]));
    return {
      id,
      boundary: kind === "mcp" ? "mcp-subprocess" : "client-shell",
      denied: observed,
      effectAbsent: observed && effects[id] === true,
    };
  }));
  const firstMarker = first.probes[0]?.marker;
  if (!firstMarker || firstMarker !== cfg.marker || restart.probes.some((probe) => probe.marker !== firstMarker)) throw new Error("runtime-observation-canary-invalid");
  const materials = [
    material("sandbox-profile", profile(root)),
    material("organization-policy", opt["--policy"]),
    material("bubblewrap", opt["--bwrap"]),
    material("seccomp", opt["--seccomp"]),
    material("provider-plugin", join(root, ".opencode/plugins/aih-loopback.js")),
    material("mcp-runtime", cfg.node),
    material("mcp-fixture", cfg.mcpScript),
    material("mcp-fixture-config", join(root, "fixture.json")),
    material("managed-mcp-manifest", join(root, "node_modules/@modelcontextprotocol/server-sequential-thinking/package.json")),
    material("managed-mcp-entry", packageBinEntry(join(root, "node_modules/@modelcontextprotocol/server-sequential-thinking/package.json"))),
  ];
  return {
    schemaVersion: 1,
    kind: "aih-mcp-runtime-observation",
    client: { targetCli: "opencode", executable: realpathSync(opt["--opencode"]), version, sha256: hash(opt["--opencode"]) },
    target: { canonicalRoot: realpathSync(root), configPath: realpathSync(join(root, "opencode.json")), configSha256: hash(join(root, "opencode.json")) },
    policy: { approvalPolicy: "operator-approved", sandbox: "external-linux", networkAccess: false },
    server: { name: "fixture", fixtureIdentity: `sha256:${hash(cfg.mcpScript)}`, runtimeIdentity: `sha256:${hash(cfg.node)}` },
    invocation: { tool: "fixture_probe", argumentsSha256: textHash("{}") },
    observedAt: first.observedAt,
    expiresAt: new Date(Date.parse(first.observedAt) + 60 * 60 * 1000).toISOString(),
    support: { nativeClientStarted: true, configuredServerRecognized: true },
    discovery: { serverConnected: true, tool: "fixture_probe", toolListed: true },
    operation: { expectedCanary: firstMarker, actualCanary: firstMarker, succeeded: true, sessionId: String(first.boot) },
    restart: { actualCanary: firstMarker, succeeded: true, sessionId: String(restart.boot), observedAt: restart.observedAt },
    materials,
    restrictions: rows,
  };
}
try {
  mkdirSync(join(fixture, "operator-home")); mkdirSync(protectedRead); mkdirSync(protectedWrite);
  writeFileSync(join(protectedRead, "read.txt"), readBytes); writeFileSync(join(protectedWrite, "write.txt"), writeBytes);
  report.checks.hostReadControl = readFileSync(join(protectedRead, "read.txt"), "utf8") === readBytes;
  writeFileSync(join(protectedWrite, "write.txt"), `${writeBytes}CONTROL`);
  report.checks.hostWriteControl = readFileSync(join(protectedWrite, "write.txt"), "utf8") === `${writeBytes}CONTROL`;
  writeFileSync(join(protectedWrite, "write.txt"), writeBytes);
  await new Promise((done, reject) => { tcp.once("error", reject); tcp.listen(0, "127.0.0.1", done); });
  await new Promise((done, reject) => { unix.once("error", reject); unix.listen(unixPath, done); });
  canariesStarted = true; tcpPort = tcp.address().port;
  await control({ host: "127.0.0.1", port: tcpPort }); await control({ path: unixPath });
  const repository = join(fixture, "repository"); mkdirSync(repository);
  await git(repository, ["init"]);
  writeFileSync(join(repository, "package.json"), '{"name":"fictional-adopter","private":true}\n');
  writeFileSync(join(repository, "USER-NOTES.txt"), "Preserve this unrelated fictional user file.\n");
  await git(repository, ["add", "package.json", "USER-NOTES.txt"]);
  await git(repository, ["-c", "user.name=Fictional Adopter", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fictional consumer seed"]);
  const a = join(fixture, "consumer-a"), b = join(fixture, "consumer-b");
  await git(repository, ["worktree", "add", "--detach", a]);
  await git(repository, ["worktree", "add", "--detach", b]);
  await setup(a); const a1 = await launch("A1", a);
  const a1Material = {
    profilePath: realpathSync(profile(a)),
    controlDir: realpathSync(join(a, ".aih")),
    profileHash: hash(profile(a)),
    configHash: hash(join(a, "opencode.json")),
  };
  const beforeB = snapshot(a); save("A-before-B.json", beforeB);
  await setup(b); await launch("B1", b);
  report.checks.aPreservedByB = JSON.stringify(beforeB) === JSON.stringify(snapshot(a));
  const a2 = await launch("A2", a);
  report.checks.freshProcesses = new Set(report.launches.map((item) => item.hostAihPid)).size === 3 && new Set(report.launches.map((item) => item.boot)).size === 3;
  report.checks.userStatePreserved = [a, b].every((root) => readFileSync(join(root, "USER-NOTES.txt"), "utf8") === "Preserve this unrelated fictional user file.\n" && readFileSync(join(root, ".aih/sandbox/opencode-home/operator-state.txt"), "utf8") === "unrelated fictional user state\n");
  await aih(a, ["policy", "evaluate", a, "--cli", "opencode", "--posture", "enterprise", "--policy", opt["--blocked-policy"]], { expect: "nonzero", label: "blocked-policy-evaluate" });
  const configuredReady = await aih(a, ["ready", "--root", a, "--cli", "opencode", "--policy", opt["--policy"]], { expect: "any", label: "ready-configured-unverified" });
  const configuredReadiness = readinessFrom(jsonOutput(configuredReady.stdout));
  report.checks.configuredButUnverified = configuredReadiness?.mcp?.servers?.some((server) => server.targetCli === "opencode" && server.name === "fixture" && server.state === "unverified") === true;
  if (!report.checks.configuredButUnverified) throw new Error("configured-unverified-runtime-not-reported");
  const versionResult = await execute(opt["--opencode"], ["--version"], a, { label: "opencode-version" });
  const version = versionResult.stdout.trim().match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
  if (!version) throw new Error("opencode-version-invalid");
  const observationPath = join(evidence, "opencode-runtime-observation.json");
  const effects = {
    "protected-read": readFileSync(join(protectedRead, "read.txt"), "utf8") === readBytes,
    "protected-write": readFileSync(join(protectedWrite, "write.txt"), "utf8") === writeBytes,
    "sandbox-profile-write": realpathSync(profile(a)) === a1Material.profilePath && hash(profile(a)) === a1Material.profileHash,
    "native-config-write": hash(join(a, "opencode.json")) === a1Material.configHash,
    "control-directory-rename": realpathSync(join(a, ".aih")) === a1Material.controlDir,
    "tcp-connect": tcpHits === 1,
    "unix-connect": unixHits === 1,
  };
  if (!Object.values(effects).every(Boolean)) throw new Error("specific-denial-effect-present");
  if (!a1.boot || !a2.boot || a1.boot === a2.boot) throw new Error("runtime-observation-restart-session-invalid");
  const observation = runtimeObservation(a, a1, a2, version, effects);
  save("opencode-runtime-observation.json", observation);
  const runtimeReady = await aih(a, ["ready", "--root", a, "--cli", "opencode", "--policy", opt["--policy"], "--runtime-evidence", observationPath], { expect: "any", label: "ready-runtime-current" });
  const runtimeReport = await aih(a, ["report", "--root", a, "--cli", "opencode", "--v9", "--runtime-evidence", observationPath, "--apply"], { expect: "any", label: "report-runtime-current" });
  const readyEvidence = assertRuntimeEvidence(runtimeReady, "current");
  const reportEvidence = assertRuntimeEvidence(runtimeReport, "current");
  report.checks.runtimeCurrentReadyAndReportAgree = JSON.stringify(readyEvidence) === JSON.stringify(reportEvidence);
  if (!report.checks.runtimeCurrentReadyAndReportAgree) throw new Error("runtime-evidence-consumers-disagree");
  const runtimeReadiness = readinessFrom(jsonOutput(runtimeReady.stdout));
  report.checks.preflightBlockersPreserved = ["banner", "blockers", "score", "rawScore", "grade"].every((key) => JSON.stringify(runtimeReadiness?.[key]) === JSON.stringify(configuredReadiness?.[key]));
  if (!report.checks.preflightBlockersPreserved) throw new Error("runtime-evidence-changed-preflight");
  const runtimeHtml = join(a, ".aih/reports/local-report.html");
  const html = existsSync(runtimeHtml) ? readFileSync(runtimeHtml, "utf8") : "";
  report.checks.runtimeHtmlCurrent = ["Current runtime observation", "fixture_probe", "local unsigned observation", "protected-read", "mcp-subprocess", "Only the recorded fixture operation"].every((value) => html.includes(value));
  if (!report.checks.runtimeHtmlCurrent) throw new Error("runtime-evidence-html-invalid");
  copyFileSync(runtimeHtml, join(evidence, "opencode-runtime-current.html"));
  const nativeBefore = jsonLines(join(a, "provider-events.jsonl")).length;
  const configPath = join(a, "opencode.json");
  const configBytes = readFileSync(configPath);
  try {
    writeFileSync(configPath, Buffer.concat([configBytes, Buffer.from("\n")]));
    const staleReady = await aih(a, ["ready", "--root", a, "--cli", "opencode", "--policy", opt["--policy"], "--runtime-evidence", observationPath], { expect: "any", label: "ready-runtime-stale-config" });
    assertRuntimeEvidence(staleReady, "stale");
  } finally { writeFileSync(configPath, configBytes); }
  const policyBytes = readFileSync(opt["--policy"]);
  try {
    chmodSync(opt["--policy"], 0o600); writeFileSync(opt["--policy"], readFileSync(opt["--blocked-policy"])); chmodSync(opt["--policy"], 0o400);
    await aih(a, launchArgs(a), { expect: "nonzero", label: "changed-policy-launch" });
  } finally { chmodSync(opt["--policy"], 0o600); writeFileSync(opt["--policy"], policyBytes); chmodSync(opt["--policy"], 0o400); }
  const profileBytes = readFileSync(profile(b));
  try { copyFileSync(profile(a), profile(b)); await aih(b, launchArgs(b), { expect: "nonzero", label: "wrong-root-profile" }); }
  finally { writeFileSync(profile(b), profileBytes); }
  renameSync(protectedRead, `${protectedRead}-unavailable`);
  try { await aih(a, launchArgs(a), { expect: "nonzero", label: "missing-required-resource" }); }
  finally { renameSync(`${protectedRead}-unavailable`, protectedRead); }
  await aih(a, ["ready", "--root", a, "--cli", "opencode", "--policy", opt["--policy"]], { expect: "any", label: "ready-preflight" });
  report.checks.negativeAndReadyDoNotLaunch = nativeBefore === jsonLines(join(a, "provider-events.jsonl")).length;
  for (const root of [a, b]) save(`${basename(root)}-final-owned-state.json`, { profile: JSON.parse(readFileSync(profile(root), "utf8")), snapshot: snapshot(root) });
} catch (error) { report.failure = error.message; }
finally {
  if (canariesStarted) {
    try { await control({ host: "127.0.0.1", port: tcpPort }); await control({ path: unixPath }); }
    catch (error) { report.controlFailure = error.message; }
  }
  await Promise.all([tcp, unix].map((server) => new Promise((done) => server.close(done))));
  report.checks.liveTcpControlsAndDenials = tcpHits === 2;
  report.checks.liveUnixControlsAndDenials = unixHits === 2;
  report.checks.protectedBytesUnchanged = existsSync(join(protectedRead, "read.txt")) && readFileSync(join(protectedRead, "read.txt"), "utf8") === readBytes && readFileSync(join(protectedWrite, "write.txt"), "utf8") === writeBytes;
  // Retain native logs even when the first launch fails.
  for (const [root] of configs) {
    for (const file of ["provider-events.jsonl", "fixture.json.events.jsonl"]) {
      if (existsSync(join(root, file))) copyFileSync(join(root, file), join(evidence, `${basename(root)}-${file}`));
    }
    const nativeLogs = join(root, ".aih/sandbox/opencode-home/.local/share/opencode/log");
    if (existsSync(nativeLogs)) cpSync(nativeLogs, join(evidence, `${basename(root)}-opencode-logs`), { recursive: true });
  }
  const cleanupRelative = relative(evidenceBase, realpathSync(fixture));
  if (!cleanupRelative.startsWith(".fixture-") || dirname(cleanupRelative) !== ".") throw new Error("unsafe-fixture-cleanup");
  rmSync(fixture, { recursive: true, force: true });
  report.cleanup = { removedOwnedFixture: !existsSync(fixture), sharedRuntimePreserved: existsSync(opt["--opencode"]), policyRestored: hash(opt["--policy"]) === report.runtime.hashes.policy };
  report.status = !report.failure && !report.controlFailure && Object.values(report.checks).every(Boolean) && Object.values(report.cleanup).every(Boolean) ? "passed" : "failed";
  report.endedAt = new Date().toISOString(); save("RESULT.json", report);
  process.stdout.write(`${JSON.stringify({ status: report.status, evidence, failure: report.failure, checks: report.checks })}\n`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}
