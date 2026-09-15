import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readRegularFileWithStats } from "../src/internals/fsxn.ts";
import { evaluateMcpRuntimeObservation } from "../src/heal/mcp-runtime-evidence.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "codex-runtime-fixture.mjs");
const tool = "fixture_probe";
const args = {};
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonicalPath = realpathSync.native;
const reportShape = (status, rest = {}) => ({ kind: "aih-codex-mcp-runtime-report", status, observation: null, evaluation: null, modelTurns: 0, fixtureRoot: null, ...rest });
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const HAS_O_NOFOLLOW = O_NOFOLLOW !== 0;

export function parseArgs(argv) {
  let report, binary, check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--report") { if (report) throw new Error("duplicate-report"); report = argv[++i]; if (!report || report.startsWith("--")) throw new Error("missing-report"); }
    else if (value === "--codex-binary") { if (binary) throw new Error("duplicate-binary"); binary = argv[++i]; if (!binary || binary.startsWith("--")) throw new Error("missing-binary"); }
    else if (value === "--check") { if (check) throw new Error("duplicate-check"); check = true; }
    else throw new Error("unsupported-argument");
  }
  if (!report || !isAbsolute(report)) throw new Error("report-must-be-absolute");
  if ([report, binary].filter(Boolean).some((value) => [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127))) throw new Error("path-control-character");
  if (check && binary) throw new Error("check-does-not-accept-binary");
  if (binary !== undefined && (!isAbsolute(binary) || !existsSync(binary) || !lstatSync(binary).isFile())) throw new Error("binary-must-be-existing-absolute-file");
  return { report, binary, check };
}

export function isolatedEnvironment(root, source = process.env) {
  const home = join(root, "home"); const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]) if (source[key] !== undefined) env[key] = source[key];
  return Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"), CODEX_HOME: join(home, ".codex"), TEMP: join(root, "temp"), TMP: join(root, "temp"), CI: "1", NO_COLOR: "1", NO_OPEN_BROWSER: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1" });
}

export function configText(node, nonce, root) {
  const q = (value) => JSON.stringify(value.replaceAll("\\", "/"));
  return `approval_policy = "never"\nsandbox_mode = "read-only"\n\n[mcp_servers.fixture]\ncommand = ${q(node)}\nargs = [${q(fixture)}, ${q(nonce)}]\ncwd = ${q(root)}\nenabled = true\nrequired = true\n`;
}

function nativeCandidate(path) {
  if (!path || !existsSync(path) || !lstatSync(path).isFile()) return undefined;
  const real = canonicalPath(path);
  if (nativeHeader(real)) return real;
  if (process.platform !== "win32") return undefined;
  const vendor = join(dirname(real), "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  return existsSync(vendor) && lstatSync(vendor).isFile() ? canonicalPath(vendor) : undefined;
}

export function resolveCodexBinary(requested, pathValue = process.env.PATH ?? process.env.Path ?? "") {
  if (requested) return nativeCandidate(requested);
  for (const dir of pathValue.split(delimiter)) for (const name of process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"]) { const found = nativeCandidate(join(dir, name)); if (found) return found; }
  return undefined;
}

function versionOf(binary) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return !result.error && result.status === 0
    ? result.stdout.match(/(?:^|\s|v)(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/)?.[1]
    : undefined;
}

function clientProcess(binary, cwd, env) {
  const child = spawn(binary, ["app-server", "--stdio", "--strict-config"], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map(); let next = 0, bytes = 0, closed = false, terminalError;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const rejectAll = (error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const closedPromise = new Promise((done) => { child.once("error", (error) => { terminalError = error; rejectAll(error); done(); }); child.once("close", () => { closed = true; rejectAll(new Error("client-closed")); done(); }); });
  child.stdin.on("error", (error) => { terminalError = error; rejectAll(error); }); child.stderr.on("data", () => {});
  child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > 1024 * 1024) { terminalError = new Error("stdout-limit"); rejectAll(terminalError); child.kill(); } });
  lines.on("line", (line) => {
    let message; try { message = parseProtocolLine(line); } catch (error) { terminalError = error; rejectAll(error); child.kill(); return; }
    if (message.method) { if (message.id !== undefined) child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "unsupported" } })}\n`); return; }
    const item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error("request-failed")) : item.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => { const label = method.replaceAll(/[^A-Za-z]+/g, "-").toLowerCase(); const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${label}-timeout`)); }, 30_000); pending.set(id, { resolve, reject: (error) => reject(new Error(`${label}-failed`, { cause: error })), timer }); child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); });
  return { child, lines, request, notify: (method) => child.stdin.write(`${JSON.stringify({ method })}\n`), closedPromise, get closed() { return closed; }, get terminalError() { return terminalError; } };
}

export function parseProtocolLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { throw new Error("invalid-json"); }
  if (message === null || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid-json-message");
  return message;
}

async function awaitClose(client, timeout) {
  let timer; const timeoutPromise = new Promise((done) => { timer = setTimeout(() => done(false), timeout); });
  const result = await Promise.race([client.closedPromise.then(() => true), timeoutPromise]); clearTimeout(timer); return result;
}

async function stopClient(client) {
  client.child.stdin.end(); await awaitClose(client, 1500);
  if (!client.closed && client.child.pid) {
    if (process.platform === "win32") spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(client.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5_000 });
    else client.child.kill("SIGKILL");
  }
  await awaitClose(client, 1500);
  client.lines.close(); client.child.stdin.destroy(); client.child.stdout.destroy(); client.child.stderr.destroy();
  return client.closed && client.terminalError === undefined;
}

function fixtureRow(response) {
  return response?.data?.find((entry) => entry?.name === "fixture");
}

function normalizedEffectiveServer(server, expected) {
  if (!server || typeof server !== "object" || Array.isArray(server)) return undefined;
  const allowed = new Set([...Object.keys(expected), "environment_id", "tool_timeout_sec"]);
  if (Object.keys(server).some((key) => !allowed.has(key))) return undefined;
  if (server.environment_id !== undefined && server.environment_id !== "local") return undefined;
  if (server.tool_timeout_sec !== undefined && server.tool_timeout_sec !== null) return undefined;
  return Object.fromEntries(Object.keys(expected).map((key) => [key, server[key]]));
}

export async function exerciseClient(client, canonicalRoot, nonce) {
  await client.request("initialize", { clientInfo: { name: "aih-codex-mcp-runtime", version: "1" } }); client.notify("initialized");
  const configRead = await client.request("config/read", { cwd: canonicalRoot, includeLayers: true });
  const slash = (value) => value.replaceAll("\\", "/");
  const expectedServer = { command: slash(process.execPath), args: [slash(fixture), nonce], cwd: slash(canonicalRoot), enabled: true, required: true };
  const effective = configRead?.config;
  const effectiveServers = effective?.mcp_servers;
  const normalizedFixture = effectiveServers && Object.keys(effectiveServers).length === 1
    ? normalizedEffectiveServer(effectiveServers.fixture, expectedServer)
    : undefined;
  if (!effective || effective.approval_policy !== "never" || effective.sandbox_mode !== "read-only" || !isDeepStrictEqual(normalizedFixture, expectedServer)) throw new Error("effective-config-mismatch");
  if (!Array.isArray(configRead.layers)) throw new Error("config-layers-unavailable");
  let owned = 0;
  for (const layer of configRead.layers) {
    if (layer?.disabledReason) continue;
    const config = layer?.config;
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config-layer-invalid");
    const isOwned = layer.name?.type === "user" && layer.name.file && canonicalPath(layer.name.file) === canonicalPath(join(canonicalRoot, "home", ".codex", "config.toml"));
    const hasMaterial = config.mcp_servers !== undefined || config.approval_policy !== undefined || config.sandbox_mode !== undefined || config.sandbox_workspace_write !== undefined;
    if (isOwned) {
      owned += 1;
      if (config.approval_policy !== "never" || config.sandbox_mode !== "read-only" || !isDeepStrictEqual(config.mcp_servers, { fixture: expectedServer })) throw new Error("owned-config-layer-mismatch");
    } else if (hasMaterial) throw new Error("non-owned-material-config-layer");
  }
  if (owned !== 1) throw new Error("owned-config-layer-missing");
  const thread = await client.request("thread/start", { cwd: canonicalRoot, ephemeral: true });
  const threadId = thread?.thread?.id; const policy = { approvalPolicy: thread?.approvalPolicy, sandbox: thread?.sandbox?.type, networkAccess: thread?.sandbox?.networkAccess };
  if (!threadId || canonicalPath(thread.cwd) !== canonicalRoot) throw new Error("thread-root-mismatch");
  if (policy.approvalPolicy !== "never" || policy.sandbox !== "readOnly" || policy.networkAccess !== false) throw new Error("thread-policy-mismatch");
  const status = await client.request("mcpServerStatus/list", { threadId, detail: "full", limit: 20 }); const server = fixtureRow(status);
  if (status?.data?.length !== 1 || server?.runtimeStatus !== "connected" || server?.tools?.[tool]?.name !== tool) throw new Error("fixture-discovery-failed");
  const reply = await client.request("mcpServer/tool/call", { server: "fixture", threadId, tool, arguments: args });
  if (reply?.isError === true || !Array.isArray(reply?.content) || reply.content.length !== 1 || reply.content[0]?.type !== "text") throw new Error("fixture-result-invalid");
  let proof; try { proof = JSON.parse(reply.content[0].text); } catch { throw new Error("fixture-result-invalid"); }
  if (proof?.fixture !== true || proof?.nonce !== nonce || canonicalPath(proof.root) !== canonicalRoot) throw new Error("fixture-canary-mismatch");
  return { threadId, policy, actualCanary: proof.nonce };
}

const bindingsOf = (observation) => ({ client: observation.client, target: observation.target, policy: observation.policy, server: observation.server, invocation: observation.invocation });

function materialBindings(binary, version, root, configPath) {
  return {
    client: { targetCli: "codex", executable: binary, version, sha256: sha(safeBytes(binary, 512 * 1024 * 1024)) },
    target: { canonicalRoot: root, configPath: canonicalPath(configPath), configSha256: sha(safeBytes(configPath, 1024 * 1024)) },
    policy: { approvalPolicy: "never", sandbox: "readOnly", networkAccess: false },
    server: { name: "fixture", fixtureIdentity: `sha256:${sha(safeBytes(fixture, 1024 * 1024))}`, runtimeIdentity: `sha256:${sha(safeBytes(process.execPath, 512 * 1024 * 1024))}` },
    invocation: { tool, argumentsSha256: sha(JSON.stringify(args)) },
  };
}

export function checkRetainedReport(reportPath, now = new Date().toISOString()) {
  let report; try { report = JSON.parse(safeBytes(reportPath, 1024 * 1024).toString("utf8")); } catch { return reportShape("failed", { failureCode: "report-invalid" }); }
  if (report?.kind !== "aih-codex-mcp-runtime-report" || !report.observation) return reportShape("failed", { failureCode: "report-invalid" });
  try {
    const original = report.observation;
    const preliminary = evaluateMcpRuntimeObservation(original, bindingsOf(original), now);
    if (preliminary.recordState === "invalid") return { ...report, status: "failed", evaluation: preliminary, modelTurns: 0, failureCode: "report-invalid" };
    if (preliminary.recordState !== "current" || preliminary.exercised !== "verified" || preliminary.restart !== "verified") return { ...report, status: "failed", evaluation: preliminary, modelTurns: 0, failureCode: "observation-not-current" };
    const root = canonicalPath(original.target.canonicalRoot); const configPath = canonicalPath(join(root, "home", ".codex", "config.toml")); const binary = canonicalPath(original.client.executable);
    if (!nativeHeader(binary)) throw new Error("native-client-unavailable");
    const expectedConfig = configText(process.execPath, original.operation.expectedCanary, root);
    const configMatches = safeBytes(configPath, 1024 * 1024).equals(Buffer.from(expectedConfig));
    // A retained observation's version is historical evidence; --check never launches its imported executable.
    const current = materialBindings(binary, original.client.version, root, configPath);
    const evaluation = evaluateMcpRuntimeObservation(original, current, now);
    const passed = configMatches && evaluation.recordState === "current";
    return { ...report, status: passed ? "passed" : "failed", evaluation, modelTurns: 0, fixtureRoot: root, failureCode: passed ? undefined : configMatches ? "observation-not-current" : evaluation.recordState === "current" ? "config-not-fixed" : "observation-not-current", recheckScope: "local observation only: rechecks retained paths and bytes, but does not launch the recorded executable or remeasure its historical version" };
  } catch { return { ...report, status: "failed", evaluation: null, modelTurns: 0, failureCode: "material-binding-unavailable" }; }
}

async function produce(options) {
  const binary = resolveCodexBinary(options.binary); if (!binary) return reportShape("unavailable", { failureCode: "native-client-unavailable" }); const version = versionOf(binary); if (!version) return reportShape("unavailable", { failureCode: "native-client-version-unavailable" });
  const root = canonicalPath(mkdtempSync(join(canonicalPath(tmpdir()), "aih-codex-mcp-runtime-"))); const nonce = randomUUID(); const env = isolatedEnvironment(root);
  for (const value of new Set(Object.entries(env).filter(([key]) => /HOME$|APPDATA$|TEMP$|TMP$/.test(key)).map(([, value]) => value))) mkdirSync(value, { recursive: true });
  const configPath = join(env.CODEX_HOME, "config.toml"); const config = configText(process.execPath, nonce, root); writeFileSync(configPath, config, { flag: "wx" }); const observedAt = new Date().toISOString();
  const initialBindings = materialBindings(binary, version, root, configPath);
  let first, second, shutdown = true;
  try {
    const one = clientProcess(binary, root, env); try { first = await exerciseClient(one, root, nonce); } finally { shutdown = (await stopClient(one)) && shutdown; }
    if (!isDeepStrictEqual(initialBindings, materialBindings(binary, version, root, configPath))) throw new Error("material-binding-changed");
    const two = clientProcess(binary, root, env); try { second = await exerciseClient(two, root, nonce); } finally { shutdown = (await stopClient(two)) && shutdown; }
    const finalBindings = materialBindings(binary, version, root, configPath);
    if (!isDeepStrictEqual(initialBindings, finalBindings)) throw new Error("material-binding-changed");
    if (!shutdown || first.threadId === second.threadId || JSON.stringify(first.policy) !== JSON.stringify(second.policy)) throw new Error("restart-not-confirmed");
    const observation = { schemaVersion: 1, kind: "aih-mcp-runtime-observation", ...initialBindings, policy: first.policy, observedAt, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), support: { nativeClientStarted: true, configuredServerRecognized: true }, discovery: { serverConnected: true, tool, toolListed: true }, operation: { expectedCanary: nonce, actualCanary: first.actualCanary, succeeded: true, sessionId: first.threadId }, restart: { actualCanary: second.actualCanary, succeeded: true, sessionId: second.threadId, observedAt: new Date().toISOString() } };
    const evaluation = evaluateMcpRuntimeObservation(observation, finalBindings, new Date().toISOString()); if (evaluation.recordState !== "current" || evaluation.exercised !== "verified" || evaluation.restart !== "verified") throw new Error("observation-evaluation-failed");
    return reportShape("passed", { observation, evaluation, fixtureRoot: root });
  } catch (error) { return reportShape("failed", { fixtureRoot: root, failureCode: error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : "runtime-probe-failed" }); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.check ? checkRetainedReport(options.report) : await writeReport(options);
  process.stdout.write(`${JSON.stringify({ status: result.status, evaluation: result.evaluation, failureCode: result.failureCode, reportPath: options.report })}\n`);
  process.exitCode = result.status === "passed" ? 0 : result.status === "unavailable" ? 2 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
function reserveReport(path) {
  try { return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600); }
  catch (error) { if (error?.code === "EEXIST") throw new Error("report-exists"); throw error; }
}

export async function writeReport(options, producer = produce) {
  const descriptor = reserveReport(options.report);
  try {
    let result;
    try { result = await producer(options); }
    catch (error) { result = reportShape("failed", { failureCode: setupFailureCode(error) }); }
    writeFileSync(descriptor, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally { closeSync(descriptor); }
}

function setupFailureCode(error) {
  // Keep actionable categories without copying native paths or arbitrary error messages.
  switch (error?.code) {
    case "EACCES": case "EPERM": case "EROFS": return "runtime-setup-permission-denied";
    case "ENOSPC": case "EDQUOT": return "runtime-setup-storage-full";
    case "ENOENT": case "ENOTDIR": return "runtime-setup-path-unavailable";
    default: return error?.message === "unsafe-material-file" ? "runtime-material-unavailable" : "runtime-probe-failed";
  }
}

function openedPathStillNamesFile(path, opened) {
  try {
    const named = lstatSync(path);
    return isRegularNonSymlink(named) && named.dev === opened.dev && named.ino === opened.ino;
  } catch { return false; }
}

function openRegularDescriptor(path) {
  const descriptor = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || (!HAS_O_NOFOLLOW && !openedPathStillNamesFile(path, opened))) throw new Error("unsafe-material-file");
    return descriptor;
  } catch (error) { closeSync(descriptor); throw error; }
}

export function safeBytes(path, maximum) {
  const material = readRegularFileWithStats(path, { maxBytes: maximum });
  if (!material) throw new Error("unsafe-material-file");
  return material.contents;
}

export function isRegularNonSymlink(stat) {
  return stat.isFile() && !stat.isSymbolicLink();
}

export function nativeHeader(path) {
  let descriptor;
  try {
    descriptor = openRegularDescriptor(path);
    const bytes = Buffer.alloc(4); readSync(descriptor, bytes, 0, 4, 0);
    return bytes.subarray(0, 2).equals(Buffer.from("MZ")) || bytes.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(bytes.readUInt32BE(0));
  } catch { return false; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
