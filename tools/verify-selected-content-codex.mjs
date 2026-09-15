/** Native, unpaid Codex inventory and complete selected-file reads in disposable consumer roots. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parse as parseToml } from "smol-toml";
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => index % 2 ? pairs : [...pairs, [value.replace(/^--/, ""), args[index + 1]]], []));
const roots = options.roots?.split(",").map(value => resolve(value));
if (!roots?.length || !roots.every(isAbsolute) || !isAbsolute(options.binary ?? "") || !isAbsolute(options.output ?? "") || !isAbsolute(options.home ?? "") || existsSync(options.output)) throw Error("Expected --roots ABSOLUTE_A,ABSOLUTE_B,ABSOLUTE_A --binary ABSOLUTE_EXE --output NEW_ABSOLUTE_DIR --home ISOLATED_ABSOLUTE_DIR [--inventory-only true]");
const { binary, output, home } = options;
mkdirSync(output, { recursive: true }); mkdirSync(home, { recursive: true });
const sha = value => createHash("sha256").update(value).digest("hex");
function containedFile(root, path) {
  if (!/^[A-Za-z0-9_.\-/]+$/.test(path) || path.split("/").some(part => !part || part === "." || part === "..") || isAbsolute(path)) throw Error("Invalid fixture-relative path");
  let current = realpathSync(root);
  for (const part of path.split("/")) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw Error("Fixture file path contains a symlink"); }
  const stat = lstatSync(current); if (!stat.isFile() || stat.size > 256 * 1024) throw Error("Fixture file is not a bounded regular file");
  return readFileSync(current);
}
const norm = value => value.replaceAll("\r\n", "\n");
const strings = value => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
const write = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const report = { schemaVersion: 1, status: "failed", client: "codex", version: spawnSync(binary, ["--version"], { encoding: "utf8", windowsHide: true }).stdout.trim(), binarySha256: sha(readFileSync(binary)), host: { platform: process.platform, arch: process.arch }, home, provider: "deterministic loopback Responses; no inference or billing", skillOverrides: false, cache: "same isolated home; forceReload inventory; OS cache uncontrolled", runs: [], accounting: null };
let active;
function send(res, parsed, call) {
  const id = `resp_${active.requests.length}`, item = call ? { type: "function_call", id: `fc_${active.requests.length}`, call_id: `call_${active.requests.length}`, status: "completed", ...call } : { type: "message", id: `msg_${active.requests.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture completed.", annotations: [] }] };
  const response = { id, object: "response", status: "completed", model: parsed.model, output: [item] };
  const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...(call ? { arguments: "" } : { content: [] }) } }];
  if (call) events.push({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments }, { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments });
  else events.push({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Fixture completed." }, { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "Fixture completed." }, { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  events.push({ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}
const server = createServer(async (req, res) => {
  try {
    if (req.url !== "/v1/responses" || req.method !== "POST" || !req.headers["content-type"]?.startsWith("application/json") || !active) { res.writeHead(404); res.end(); return; }
    if (active.requests.length >= 64) throw Error("Diagnostic request count exceeded 64");
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw Error("Bounded diagnostic request exceeded 4 MiB"); chunks.push(chunk); }
    active.totalBytes = (active.totalBytes ?? 0) + bytes;
    if (active.totalBytes > 32 * 1024 * 1024) throw Error("Diagnostic session exceeded 32 MiB");
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    active.requests.push({ bytes, body: parsed });
    const context = strings([parsed.instructions, (parsed.input ?? []).filter(item => item.type === "message")]).join("\n");
    const userText = strings((parsed.input ?? []).filter(item => item.type === "message" && item.role === "user")).join("\n");
    if (active.role && userText.includes("AIH_NATIVE_ROLE_CHILD")) {
      active.role.childRequests += 1;
      active.role.instructionsObserved = norm(context).includes(norm(active.role.instructions));
      send(res, parsed, undefined);
      return;
    }
    active.parentRequests += 1;
    const toolText = norm((parsed.input ?? []).filter(item => item.type === "function_call_output").flatMap(item => {
      const raw = typeof item.output === "string" ? item.output : "";
      const at = raw.indexOf("\nOutput:\n");
      if (at >= 0) { try { const decoded = JSON.parse(raw.slice(at + "\nOutput:\n".length).trim()); if (typeof decoded === "string") return [decoded]; } catch { /* Retain failed/truncated native output as evidence, never as a full read. */ } }
      return strings(item);
    }).join("\n"));
    for (const job of active.jobs) if (toolText.includes(norm(job.text))) job.loaded = true;
    if (active.audit?.requested) {
      for (const item of (parsed.input ?? []).filter(item => item.type === "function_call_output")) {
        const raw = typeof item.output === "string" ? item.output : "";
        const at = raw.indexOf("\nOutput:\n");
        if (at < 0) continue;
        try { const result = JSON.parse(raw.slice(at + 9).trim()); if (typeof result.overall_score === "number" && typeof result.max_score === "number" && resolve(result.root_dir) === active.root) active.audit.result = result; } catch { /* Other native outputs are not command proof. */ }
      }
    }
    for (const file of active.files) file.fullyLoaded = active.jobs.filter(job => job.path === file.path).every(job => job.loaded);
    const job = active.jobs[active.parentRequests - 1];
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    if (!job && active.audit && !active.audit.requested) {
      active.audit.requested = true;
      send(res, parsed, { name: "exec_command", arguments: JSON.stringify({ cmd: "node scripts/harness-audit.js repo --format json | ConvertFrom-Json | Select-Object root_dir,overall_score,max_score,scope | ConvertTo-Json -Compress", workdir: active.root, login: false, max_output_tokens: 2000 }) });
      return;
    }
    if (!job && active.role && !active.role.spawned) {
      active.role.spawned = true;
      send(res, parsed, { name: "spawn_agent", namespace: "multi_agent_v1", arguments: JSON.stringify({ agent_type: active.role.id, fork_context: false, message: "AIH_NATIVE_ROLE_CHILD: Report that your configured project role is available. No tools or changes are needed." }) });
      return;
    }
    if (!job && active.role && !active.role.waited) {
      const toolOutputs = (parsed.input ?? []).filter(item => item.type === "function_call_output").map(item => item.output);
      for (const output of toolOutputs) { try { const result = typeof output === "string" ? JSON.parse(output) : output; if (result.agent_id) active.role.agentId = result.agent_id; } catch { /* Non-spawn outputs are retained in the trace. */ } }
      if (!active.role.agentId) active.failure = "Native role spawn did not return an agent id";
      else { active.role.waited = true; send(res, parsed, { name: "wait_agent", namespace: "multi_agent_v1", arguments: JSON.stringify({ targets: [active.role.agentId], timeout_ms: 10000 }) }); return; }
    }
    send(res, parsed, job ? { name: "exec_command", arguments: JSON.stringify({ cmd: `(Get-Content -Raw -Encoding utf8 -LiteralPath ${quote(job.path)}).Substring(${job.start},${job.text.length}) | ConvertTo-Json -Compress -EscapeHandling EscapeNonAscii`, workdir: active.root, login: false, max_output_tokens: 2000 }) } : undefined);
  } catch (error) { active.failure = error.message; res.writeHead(500); res.end("fixture capture failed"); }
});
await new Promise(accept => server.listen(0, "127.0.0.1", accept));
const port = server.address().port;
const configuration = `model_provider = "fixture"\nmodel = "fixture-model"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[features]\napps = false\nplugins = false\nremote_plugin = false\nrecommended_plugins = false\nmulti_agent = true\n[model_providers.fixture]\nname = "No inference fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\n` + (options["fixture-trust"] === "true" ? [...new Set(roots)].map(root => `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`).join("") : "");
// This is exclusively a caller-designated synthetic home, never the account home.
const configFile = join(home, "config.toml");
if (existsSync(configFile) && !readFileSync(configFile, "utf8").includes('name = "No inference fixture"')) throw Error("Refusing an existing non-fixture home configuration");
const nativeConfiguration = (options["native-default-features"] === "true" ? configuration.replace("multi_agent = true\n", "") : configuration) + (options["windows-backend"] === "unelevated" ? '[windows]\nsandbox = "unelevated"\n' : "");
writeFileSync(configFile, nativeConfiguration);
report.configurationSha256 = sha(nativeConfiguration); report.comparableConfigurationSha256 = sha(nativeConfiguration.replace(String(port), "<loopback-port>"));
report.windowsSandboxBackend = options["windows-backend"] ?? "default";
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|comspec|temp|tmp|localappdata|appdata|programfiles|programfiles\(x86\)|programdata)$/i.test(key)));
Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home });
async function inventory(root) {
  const child = spawn(binary, ["app-server", "--stdio", "--strict-config"], { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }), pending = new Map(); let id = 0, stderr = "";
  child.stderr.on("data", data => stderr = (stderr + data).slice(-65536));
  lines.on("line", line => { let msg; try { msg = JSON.parse(line); } catch { return; } const item = pending.get(msg.id); if (item) { pending.delete(msg.id); clearTimeout(item.timer); msg.error ? item.reject(Error(JSON.stringify(msg.error))) : item.accept(msg.result); } });
  const rpc = (method, params) => new Promise((accept, reject) => { const next = ++id; const timer = setTimeout(() => reject(Error(`${method} timed out`)), 30000); pending.set(next, { accept, reject, timer }); child.stdin.write(JSON.stringify({ id: next, method, params }) + "\n"); });
  try {
    await rpc("initialize", { clientInfo: { name: "aih-selected-discovery", version: "1" }, capabilities: { experimentalApi: true } }); child.stdin.write('{"method":"initialized"}\n');
    const start = performance.now(); const result = await rpc("skills/list", { cwds: [root], forceReload: true });
    const durationMs = performance.now() - start;
    const config = await rpc("config/read", { cwd: root, includeLayers: true });
    return { durationMs, outputBytes: Buffer.byteLength(JSON.stringify(result)), result, agents: config.config?.agents ?? null, skillsConfiguration: config.config?.skills ?? null, configLayers: config.layers?.map(layer => ({ name: layer.name, disabledReason: layer.disabledReason })), stderr };
  } finally { child.stdin.end(); child.kill(); lines.close(); for (const item of pending.values()) clearTimeout(item.timer); }
}
async function nativeRead(root, files) {
  const jobs = options["roles-only"] === "true" ? [] : files.flatMap(file => Array.from({ length: Math.ceil(file.text.length / 2500) }, (_, index) => ({ path: file.path, start: index * 2500, text: file.text.slice(index * 2500, (index + 1) * 2500), loaded: false })));
  const roleFile = options["exercise-roles"] === "true" ? files.find(file => /^\.codex\/agents\/.+\.toml$/.test(file.path)) : undefined;
  const role = roleFile ? { id: roleFile.path.split("/").at(-1).slice(0, -5), instructions: parseToml(roleFile.text).developer_instructions, instructionsObserved: false, childRequests: 0 } : undefined;
  if (options["exercise-roles"] === "true" && (!role || typeof role.instructions !== "string")) throw Error("Expected a selected native role with developer instructions");
  const audit = options["exercise-command"] === "true" ? { requested: false, result: null } : undefined;
  if (audit) {
    const receipt = JSON.parse(containedFile(root, ".aih/ecc/materialization-v1.json"));
    const recorded = receipt.components.flatMap(component => component.files).find(file => file.path === "scripts/harness-audit.js");
    if (!recorded || recorded.contentSha256 !== sha(containedFile(root, "scripts/harness-audit.js"))) throw Error("Expected unchanged receipt-owned harness-audit command runtime");
  }
  active = { root, files, jobs, role, audit, requests: [], parentRequests: 0 };
  const args = ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "--cd", root, "Read the current project's required guidance and the complete selected practice files using native workspace tools. Report the observed selection."];
  const start = performance.now(); const child = spawn(binary, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", data => { if (stdout.length + data.length > 4 * 1024 * 1024) { active.failure = "Native output exceeded 4 MiB"; child.kill(); } else stdout += data; }); child.stderr.on("data", data => stderr = (stderr + data).slice(-65536));
  const exitCode = await new Promise(accept => { const timer = setTimeout(() => { child.kill(); accept(null); }, 180000); child.once("close", code => { clearTimeout(timer); accept(code); }); });
  return { args, durationMs: performance.now() - start, exitCode, stdout, stderr, ...active };
}
try {
  for (const [index, root] of roots.entries()) {
    const marker = JSON.parse(containedFile(root, ".aih-config.json")); if (marker.policyBinding?.state !== "active" || resolve(marker.policyBinding.source.path) !== join(root, "aih-org-policy.json")) throw Error("Requires a disposable actively bound consumer at its current root");
    const receipt = JSON.parse(containedFile(root, ".aih/ecc/materialization-v1.json"));
    const paths = [...new Set(receipt.components.flatMap(component => component.files.map(file => file.path)).filter(path => /^(\.agents|\.codex)\//.test(path) && /\.(md|toml)$/.test(path)))];
    const files = ["ai-coding/policy-required-guidance.md", ...paths].map(path => { const bytes = containedFile(root, path); return { path, text: bytes.toString("utf8"), sha256: sha(bytes), fullyLoaded: false }; });
    const found = await inventory(root); const rows = found.result.data?.find(row => resolve(row.cwd) === root)?.skills ?? [];
    const projectRows = rows.filter(row => row.path.replaceAll("\\", "/").toLowerCase().startsWith(root.replaceAll("\\", "/").toLowerCase() + "/"));
    const run = { root, policySha256: sha(readFileSync(join(root, "aih-org-policy.json"))), source: receipt.source ?? receipt.components.map(component => ({ id: component.id, provenance: component.provenance })), receiptSha256: sha(readFileSync(join(root, ".aih/ecc/materialization-v1.json"))), physicalFiles: paths, uniqueCapabilityIdentities: new Set(receipt.components.map(component => JSON.stringify({ provenance: component.provenance, treeSha256: component.authorization?.treeSha256 }))).size, inventory: found, metrics: { nativeInventoryRows: rows.length, projectInventoryRows: projectRows.length, projectEnabledRows: projectRows.filter(row => row.enabled).length, projectDescriptionBytes: projectRows.reduce((sum, row) => sum + Buffer.byteLength(row.description ?? ""), 0), discoveryDurationMs: found.durationMs, inventoryOutputBytes: found.outputBytes, billedTokens: null, cost: null }, projectRows };
    report.runs.push(run); write(`inventory-${index + 1}.json`, found);
    if (options["inventory-only"] !== "true") { const loaded = await nativeRead(root, files); write(`session-${index + 1}.json`, loaded); run.native = { exitCode: loaded.exitCode, durationMs: loaded.durationMs, requests: loaded.requests.length, modelRequestBytes: loaded.requests.map(request => request.bytes), files: options["roles-only"] === "true" ? [] : loaded.files.map(({ text, ...file }) => file), role: loaded.role ? { id: loaded.role.id, instructionsSha256: sha(loaded.role.instructions), instructionsObserved: loaded.role.instructionsObserved, childRequests: loaded.role.childRequests, agentId: loaded.role.agentId } : null, audit: loaded.audit ?? null, failure: loaded.failure ?? null }; if ((loaded.audit && !loaded.audit.result) || loaded.failure || loaded.exitCode !== 0 || (options["roles-only"] !== "true" && loaded.files.some(file => !file.fullyLoaded)) || (loaded.role && !loaded.role.instructionsObserved)) throw Error(`Native complete reads or role use failed at session ${index + 1}`); }
    run.selectedFilesPreserved = files.every(file => sha(containedFile(root, file.path)) === file.sha256) && sha(containedFile(root, ".aih/ecc/materialization-v1.json")) === run.receiptSha256;
    if (!run.selectedFilesPreserved) throw Error("Native session changed selected files or receipt");
  }
  report.status = "passed";
} catch (error) { report.failure = error.message; }
finally { server.closeAllConnections(); await new Promise(accept => server.close(accept)); write("RESULT.json", report); }
process.stdout.write(JSON.stringify({ status: report.status, output, failure: report.failure }) + "\n"); process.exitCode = report.status === "passed" ? 0 : 1;
