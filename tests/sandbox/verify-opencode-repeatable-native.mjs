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
  "--binding", `AIH_OPENCODE_NONCE=${configs.get(root).nonce}`, "--binding", `PATH=${opt["--runtime-path"]}:/usr/bin:/bin`,
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
  await setup(a); await launch("A1", a);
  const beforeB = snapshot(a); save("A-before-B.json", beforeB);
  await setup(b); await launch("B1", b);
  report.checks.aPreservedByB = JSON.stringify(beforeB) === JSON.stringify(snapshot(a));
  await launch("A2", a);
  report.checks.freshProcesses = new Set(report.launches.map((item) => item.hostAihPid)).size === 3 && new Set(report.launches.map((item) => item.boot)).size === 3;
  report.checks.userStatePreserved = [a, b].every((root) => readFileSync(join(root, "USER-NOTES.txt"), "utf8") === "Preserve this unrelated fictional user file.\n" && readFileSync(join(root, ".aih/sandbox/opencode-home/operator-state.txt"), "utf8") === "unrelated fictional user state\n");
  await aih(a, ["policy", "evaluate", a, "--cli", "opencode", "--posture", "enterprise", "--policy", opt["--blocked-policy"]], { expect: "nonzero", label: "blocked-policy-evaluate" });
  const nativeBefore = jsonLines(join(a, "provider-events.jsonl")).length;
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
