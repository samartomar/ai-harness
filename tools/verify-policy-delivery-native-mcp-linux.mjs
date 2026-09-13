/** Actual native MCP calls over public AIH output; only model transport is simulated. */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
const [client, root, output, scenario = "allowed"] = process.argv.slice(2);
const clients = {
  claude: { binary: "/home/aih-probe/runtime/claude/claude-2.1.241", config: "managed-mcp.json.example" },
  opencode: { binary: "/home/aih-probe/runtime/opencode-1.18.11/package/bin/opencode", config: "opencode.json" },
  copilot: { binary: "/home/aih-probe/runtime/copilot-1.0.83/extracted/copilot", config: ".github/mcp.json" },
  kimi: { binary: "/home/aih-probe/runtime/kimi-0.36.1/extracted/kimi", config: ".kimi-code/mcp.json" },
};
if (!clients[client] || !isAbsolute(root ?? "") || !isAbsolute(output ?? "") || process.platform !== "linux" || process.getuid() === 0) throw Error("Expected client, absolute consumer root, and new output, as unprivileged Linux user");
if (scenario !== "allowed" && !(client === "claude" && scenario === "foreign-refusal")) throw Error("Unexpected native acceptance scenario");
mkdirSync(dirname(output), { recursive: true });
try { mkdirSync(output, { mode: 0o700 }); } catch (error) {
  if (error?.code === "EEXIST") throw Error("Expected client, absolute consumer root, and new output, as unprivileged Linux user");
  throw error;
}
const hash = value => createHash("sha256").update(value).digest("hex");
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const { binary, config } = clients[client], configBytes = readFileSync(join(root, config));
writeFileSync(join(output, "configuration-before.json"), configBytes);
const marker = JSON.parse(readFileSync(join(root, ".aih-config.json")));
if (marker.policyBinding?.state !== "active" || !configBytes.toString().includes("code-review-graph@2.3.7")) throw Error("Public bound MCP consumer required");
const report = { client, root, version: spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15000 }).stdout.trim(), configuration: { path: config, sha256: hash(configBytes) }, simulation: "Loopback chat provider only; actual code-review-graph@2.3.7 process via generated native config", status: "failed", requests: [], calls: [], auxiliary: [] };
const foreignConfig = join(root, ".mcp.json"), foreignEffect = join(output, "foreign-started.txt");
if (scenario === "foreign-refusal") {
  const launcher = join(output, "foreign-launcher.cjs");
  writeFileSync(launcher, "require('node:fs').writeFileSync(process.argv[2], 'foreign launcher executed\\n');\n");
  // An intentionally unowned competing entry is the negative test input. The
  // governed administrator examples remain exact public CLI output.
  writeFileSync(foreignConfig, JSON.stringify({ mcpServers: { "foreign-lane4": { command: "/home/aih-probe/runtime/bin/node", args: [launcher, foreignEffect] } } }, null, 2) + "\n", { flag: "wx" });
}
const flatten = (value, out = []) => { if (typeof value === "string") out.push(value); else if (Array.isArray(value)) value.forEach(v => flatten(v, out)); else if (value && typeof value === "object") Object.values(value).forEach(v => flatten(v, out)); return out; };
let stage = 0;
const server = createServer((req, res) => {
  if (client === "claude" && req.url === "/api/hello") { req.resume(); res.writeHead(404); res.end(); return; }
  let body = ""; req.on("data", bytes => { body += bytes; if (body.length > 8388608) req.destroy(); });
  req.on("end", () => {
    try {
      if (!(client === "claude" ? req.url.startsWith("/v1/messages") : req.url.endsWith("/chat/completions"))) { res.writeHead(404); res.end(); return; }
      const input = JSON.parse(body);
      if (client === "claude" && req.url.split("?")[0].endsWith("/count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 1000 })); return; }
      save("request-" + (report.requests.length + report.auxiliary.length + 1) + ".json", input);
      const tools = (input.tools ?? []).map(tool => client === "claude" ? tool : tool.function);
      const auxiliary = client === "opencode" && !tools.length;
      let delta = { role: "assistant", content: "Native MCP observation finished." }, finish = "stop";
      if (auxiliary) report.auxiliary.push({ purpose: "title generation" });
      else {
        const lastTool = client === "claude"
          ? (input.messages ?? []).findLast(message => message.role === "user" && Array.isArray(message.content))?.content.find(item => item.type === "tool_result")
          : (input.messages ?? []).findLast(message => message.role === "tool");
        report.requests.push({ names: tools.map(tool => tool.name), lastTool });
        const suffix = stage === 0 ? "build_or_update_graph_tool" : "list_graph_stats_tool";
        const tool = tools.find(tool => tool.name.endsWith(suffix));
        const pendingTool = client === "claude" && !tool && stage < 2 && report.auxiliary.length === 0 ? tools.find(tool => tool.name === "WaitForMcpServers") : undefined;
        if (pendingTool) {
          const args = { servers: ["code-review-graph"] };
          report.auxiliary.push({ purpose: "native asynchronous MCP startup", name: pendingTool.name, arguments: args });
          delta = { role: "assistant", tool_calls: [{ index: 0, id: "call_mcp_wait", type: "function", function: { name: pendingTool.name, arguments: JSON.stringify(args) } }] };
          finish = "tool_calls";
        } else if (stage < 2 && tool) {
          const args = { repo_root: root, ...(stage === 0 ? { full_rebuild: true } : {}) };
          report.calls.push({ name: tool.name, arguments: args });
          delta = { role: "assistant", tool_calls: [{ index: 0, id: "call_mcp_" + stage, type: "function", function: { name: tool.name, arguments: JSON.stringify(args) } }] };
          finish = "tool_calls";
        } else if (stage < 2) report.failure = "Native startup did not advertise reviewed MCP tool: " + suffix;
        if (!pendingTool) stage++;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (client === "claude") {
        const call = delta.tool_calls?.[0];
        const block = call ? { type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) } : { type: "text", text: delta.content };
        const stopReason = call ? "tool_use" : "end_turn";
        const emit = (event, data) => res.write("event: " + event + "\ndata: " + JSON.stringify({ type: event, ...data }) + "\n\n");
        emit("message_start", { message: { id: "msg_" + stage, type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
        emit("content_block_start", { index: 0, content_block: call ? { ...block, input: {} } : { type: "text", text: "" } });
        emit("content_block_delta", { index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
        emit("content_block_stop", { index: 0 }); emit("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }); emit("message_stop", {}); res.end(); return;
      }
      const chunk = choice => ({ id: "chatcmpl-fixture-" + stage, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [choice] });
      res.write("data: " + JSON.stringify(chunk({ index: 0, delta, finish_reason: null })) + "\n\n");
      res.write("data: " + JSON.stringify(chunk({ index: 0, delta: {}, finish_reason: finish })) + "\n\n");
      res.end("data: [DONE]\n\n");
    } catch (error) { report.failure = error.message; if (!res.headersSent) res.writeHead(400); res.end(); }
  });
});
await new Promise(accept => server.listen(0, "127.0.0.1", accept));
const url = "http://127.0.0.1:" + server.address().port + "/v1", home = join(output, "home"); mkdirSync(home);
const env = { PATH: "/home/aih-probe/lane4-mcp-runtime/bin:/home/aih-probe/runtime/bin:/usr/bin:/bin", HOME: home, USER: "aih-probe", LOGNAME: "aih-probe", CI: "1", TERM: "dumb", NO_COLOR: "1", UV_CACHE_DIR: "/home/aih-probe/lane4-mcp-runtime/uv-cache", XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state") };
const prompt = "Inspect this repository using its configured project tools and report readiness.";
async function trustKimiWorkspace() {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const web = spawn(binary, ["web", "--no-open", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let startup = "";
  const capture = bytes => { startup = (startup + bytes).slice(-65536); };
  web.stdout.on("data", capture); web.stderr.on("data", capture);
  const deadline = Date.now() + 30000;
  try {
    let token;
    while (Date.now() < deadline && web.exitCode === null) {
      token = /(?:token[=: ]+|[?&]token=)([A-Za-z0-9_-]{20,})/i.exec(startup)?.[1];
      if (token) break;
      await new Promise(done => setTimeout(done, 100));
    }
    if (!token) throw Error("Kimi local host token unavailable; startup output withheld");
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const call = async (path, method = "GET", body) => {
      const response = await fetch("http://127.0.0.1:" + port + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error("Kimi host route failed: " + path + " HTTP " + response.status);
      return response.json();
    };
    const spec = await call("/openapi.json");
    if (!spec.paths?.["/api/v1/sessions"]?.post || !spec.paths?.["/api/v1/workspaces/{workspace_id}/trust"]?.post) throw Error("Installed Kimi does not advertise the expected native workspace trust route");
    const session = await call("/api/v1/sessions", "POST", { title: "MCP fixture acceptance", metadata: { cwd: root } });
    if (session.code !== 0 || !session.data?.workspace_id) throw Error("Kimi local workspace session was not created");
    const trusted = await call("/api/v1/workspaces/" + encodeURIComponent(session.data.workspace_id) + "/trust", "POST", {});
    if (trusted.code !== 0) throw Error("Kimi host refused fixture workspace trust");
    report.workspaceTrust = { status: "established-through-native-host", sessionId: session.data.id, workspaceId: session.data.workspace_id, root, route: "POST /api/v1/workspaces/{workspace_id}/trust", responseCode: trusted.code, freshCliSessionFollows: true };
  } finally {
    // The generated loopback token is never included in retained evidence.
    try { process.kill(-web.pid, "SIGKILL"); } catch {}
    await new Promise(done => { if (web.exitCode !== null || web.signalCode !== null) done(); else web.once("close", done); });
  }
}
let args, launchBinary = binary;
if (client === "claude") {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["foreign-lane4"], enableAllProjectMcpServers: true } } }));
  env.ANTHROPIC_BASE_URL = url.replace(/\/v1$/, ""); env.ANTHROPIC_API_KEY = "fixture-not-a-credential";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"; env.DISABLE_UPDATES = "1"; env.DISABLE_TELEMETRY = "1";
  if (scenario === "foreign-refusal") {
    const approve = spawnSync(binary, ["mcp", "add", "--scope", "local", "--transport", "stdio", "foreign-lane4", "--", "/home/aih-probe/runtime/bin/node", join(output, "foreign-launcher.cjs"), foreignEffect], { cwd: root, env, encoding: "utf8", timeout: 15000, maxBuffer: 65536 });
    report.foreignApproval = { exitCode: approve.status, beforeManagedSession: true, scope: "local isolated fixture profile" };
    writeFileSync(join(output, "foreign-native-approval.txt"), approve.stdout + approve.stderr);
    if (approve.status !== 0) throw Error("Native fixture MCP approval failed");
  }
  launchBinary = "/usr/bin/bwrap";
  args = ["--die-with-parent", "--ro-bind", "/", "/", "--bind", root, root, "--bind", output, output, "--bind", env.UV_CACHE_DIR, env.UV_CACHE_DIR, "--tmpfs", "/tmp", "--dev", "/dev", "--tmpfs", "/etc", "--dir", "/etc/claude-code", "--ro-bind", join(root, "managed-settings.json.example"), "/etc/claude-code/managed-settings.json", "--ro-bind", join(root, config), "/etc/claude-code/managed-mcp.json", "--", binary, "--permission-mode", "dontAsk", "--allowedTools", "mcp__code-review-graph__build_or_update_graph_tool", "mcp__code-review-graph__list_graph_stats_tool", "--output-format", "json", "--no-session-persistence", "-p", prompt];
  report.nativeConfigurationSelection = "Exact public administrator examples mounted read-only at Claude system paths in a disposable mount namespace; host system configuration unchanged";
} else if (client === "opencode") {
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { "aih-loopback": { npm: "@ai-sdk/openai-compatible", options: { baseURL: url, apiKey: "fixture-not-a-credential" }, models: { "fixture-model": { name: "Fixture", tool_call: true, limit: { context: 200000, output: 1024 } } } } } });
  env.OPENCODE_DISABLE_MODELS_FETCH = "1"; env.OPENCODE_DISABLE_AUTOUPDATE = "1"; env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"; env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1";
  args = ["--pure", "run", "--format", "json", "--model", "aih-loopback/fixture-model", prompt];
} else if (client === "copilot") {
  env.COPILOT_HOME = join(home, ".copilot"); env.COPILOT_OFFLINE = "true"; env.COPILOT_PROVIDER_TYPE = "openai"; env.COPILOT_PROVIDER_BASE_URL = url; env.COPILOT_MODEL = "fixture-model"; env.COPILOT_MCP_TOOL_CACHE = "false";
  args = ["--prompt", prompt, "--silent", "--log-level", "none", "--disable-builtin-mcps", "--additional-mcp-config=@" + join(root, config), "--allow-tool=code-review-graph(build_or_update_graph_tool)", "--allow-tool=code-review-graph(list_graph_stats_tool)", "--deny-tool=write", "--no-sandbox"];
} else {
  // Provider-only fixture configuration; preserve the generated MCP file exactly.
  const configHome = join(home, ".kimi-code"), providerPath = join(configHome, "config.toml");
  mkdirSync(configHome, { recursive: true });
  writeFileSync(providerPath, 'default_model = "fixture"\ndefault_permission_mode = "auto"\ntelemetry = false\n[providers.fixture]\ntype = "openai"\nbase_url = ' + JSON.stringify(url) + '\napi_key = "fixture-not-a-credential"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture-model"\nmax_context_size = 200000\nmax_output_size = 1024\ncapabilities = ["tool_use"]\n', { flag: "wx", mode: 0o600 });
  writeFileSync(join(configHome, "tui.toml"), "[upgrade]\nauto_install = false\n", { flag: "wx" });
  env.KIMI_CODE_HOME = configHome;
  report.nativeConfigurationSelection = "Isolated KIMI_CODE_HOME contains only provider configuration; project MCP loading requires native workspace trust and is verified by the following actual calls";
  await trustKimiWorkspace();
  args = ["--model", "fixture", "--prompt", prompt, "--output-format", "stream-json"];
}
report.invocation = { binary: launchBinary, args, cwd: root };
const child = spawn(launchBinary, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", b => stdout = (stdout + b).slice(-262144)); child.stderr.on("data", b => stderr = (stderr + b).slice(-65536));
const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
const timer = setTimeout(kill, 60000);
report.exitCode = await new Promise(accept => { child.once("error", error => { report.failure = error.message; accept(null); }); child.once("close", accept); });
clearTimeout(timer); kill(); server.closeAllConnections(); await new Promise(accept => server.close(accept));
writeFileSync(join(output, "stdout.jsonl"), stdout); writeFileSync(join(output, "stderr.txt"), stderr);
report.configurationUnchanged = hash(readFileSync(join(root, config))) === report.configuration.sha256;
const afterConfig = readFileSync(join(root, config));
writeFileSync(join(output, "configuration-after.json"), afterConfig);
const mcpEntries = bytes => { const parsed = JSON.parse(bytes); return parsed.mcp ?? parsed.mcpServers; };
report.projectedEntriesUnchanged = JSON.stringify(mcpEntries(configBytes)) === JSON.stringify(mcpEntries(afterConfig));
const result = flatten(report.requests.at(-1)?.lastTool).join("\n");
report.nativeToolResultObserved = /total_nodes|totalNodes|node_count|total_files|files_parsed/.test(result);
report.status = report.exitCode === 0 && report.calls.length === 2 && report.nativeToolResultObserved && report.projectedEntriesUnchanged && !report.failure ? "passed" : "failed";
if (scenario === "foreign-refusal") {
  const managedEffectAbsent = !existsSync(foreignEffect);
  const foreignToolAbsent = report.requests.every(request => request.names.every(name => !name.includes("foreign-lane4")));
  const positive = spawnSync(binary, ["mcp", "list"], { cwd: root, env, encoding: "utf8", timeout: 20000, maxBuffer: 65536 });
  const positiveEffectObserved = existsSync(foreignEffect);
  report.foreignRefusal = { managedEffectAbsent, foreignToolAbsent, positiveControl: "Same native client and already-authorized launcher/profile outside managed administrator namespace; no approval or configuration change between scenarios", nativeApprovalExitCode: report.foreignApproval.exitCode, positiveExitCode: positive.status, positiveEffectObserved, configurationRemovedAfterProbe: true };
  writeFileSync(join(output, "foreign-positive-control.txt"), positive.stdout + positive.stderr);
  unlinkSync(foreignConfig);
  if (!managedEffectAbsent || !foreignToolAbsent || report.foreignApproval.exitCode !== 0 || !positiveEffectObserved) report.status = "failed";
}
save("RESULT.json", report); process.stdout.write(JSON.stringify({ status: report.status, output, failure: report.failure }) + "\n"); process.exitCode = report.status === "passed" ? 0 : 1;
