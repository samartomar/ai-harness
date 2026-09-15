/** Public generated project MCP loaded and called through a fresh native Codex app-server session. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
const [rootArg, outputArg] = process.argv.slice(2);
if (!isAbsolute(rootArg ?? "") || !isAbsolute(outputArg ?? "") || existsSync(outputArg)) throw Error("Expected absolute public root and new output directory");
const root = resolve(rootArg), output = resolve(outputArg), home = join(output, "home"); mkdirSync(home, { recursive: true });
const binary = "C:/ProgramData/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe";
const configPath = join(root, ".codex/config.toml"), before = readFileSync(configPath), sha = b => createHash("sha256").update(b).digest("hex");
const marker = JSON.parse(readFileSync(join(root, ".aih-config.json")));
if (marker.policyBinding?.state !== "active" || !before.toString().includes("code-review-graph@2.3.7")) throw Error("Requires active public bound MCP output");
writeFileSync(join(home, "config.toml"), `model_provider = "fixture"\nmodel = "fixture-model"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[features]\napps = false\nplugins = false\nremote_plugin = false\nrecommended_plugins = false\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n[model_providers.fixture]\nname = "No inference fixture"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n`);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|comspec|temp|tmp|localappdata|appdata|programfiles|programfiles\(x86\)|programdata)$/i.test(key)));
Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home, UV_CACHE_DIR: join(process.env.LOCALAPPDATA, "uv/cache") });
const report = { root, client: "codex", version: spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim(), providerInference: false, nativeEntry: "app-server --stdio --strict-config; fresh thread/start; native MCP tool calls", configSha256: sha(before), status: "failed", calls: [] };
const child = spawn(binary, ["app-server", "--stdio", "--strict-config"], { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout }), pending = new Map(); let nextId = 0, stderr = "";
child.stderr.on("data", bytes => stderr = (stderr + bytes).slice(-65536));
lines.on("line", line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const item = pending.get(msg.id);
  if (item) { pending.delete(msg.id); clearTimeout(item.timer); msg.error ? item.reject(Error(JSON.stringify(msg.error))) : item.accept(msg.result); }
  else if (msg.method && msg.id !== undefined) child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "No interactive request authorized in this isolated probe" } }) + "\n");
});
function request(method, params) {
  const id = ++nextId;
  return new Promise((accept, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error(method + " timeout")); }, 30000); pending.set(id, { accept, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
}
try {
  await request("initialize", { clientInfo: { name: "aih-public-policy-mcp", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const config = await request("config/read", { cwd: root, includeLayers: true });
  report.effectiveServer = config.config?.mcp_servers?.["code-review-graph"];
  report.projectLayer = config.layers?.filter(layer => layer.name?.type === "project").map(layer => ({ name: layer.name, disabledReason: layer.disabledReason, servers: Object.keys(layer.config?.mcp_servers ?? {}) }));
  const thread = await request("thread/start", { cwd: root, ephemeral: true });
  report.threadId = thread.thread?.id; report.threadRoot = thread.cwd;
  if (!report.threadId || resolve(thread.cwd) !== root) throw Error("Fresh native thread root mismatch");
  const status = await request("mcpServerStatus/list", { threadId: report.threadId, detail: "full", limit: 20 });
  report.serverStatus = status.data?.find(server => server.name === "code-review-graph");
  if (report.serverStatus?.runtimeStatus !== "connected") throw Error("Reviewed server not connected");
  for (const [tool, args] of [["build_or_update_graph_tool", { repo_root: root, full_rebuild: true }], ["list_graph_stats_tool", { repo_root: root }]]) {
    const result = await request("mcpServer/tool/call", { threadId: report.threadId, server: "code-review-graph", tool, arguments: args });
    report.calls.push({ tool, arguments: args, result });
    if (result.isError || !JSON.stringify(result.content).includes("total_nodes")) throw Error("Native MCP call lacked graph result");
  }
  report.configurationUnchanged = sha(readFileSync(configPath)) === report.configSha256;
  if (!report.configurationUnchanged) throw Error("Public MCP config changed");
  report.status = "passed";
} catch (error) { report.failure = error.message; }
finally {
  child.stdin.end();
  await new Promise(accept => { const timer = setTimeout(() => { spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); accept(); }, 1500); child.once("close", () => { clearTimeout(timer); accept(); }); });
  lines.close(); for (const item of pending.values()) clearTimeout(item.timer);
  writeFileSync(join(output, "stderr.txt"), stderr);
  writeFileSync(join(output, "RESULT.json"), JSON.stringify(report, null, 2) + "\n");
}
process.stdout.write(JSON.stringify({ status: report.status, output, failure: report.failure }) + "\n"); process.exitCode = report.status === "passed" ? 0 : 1;
