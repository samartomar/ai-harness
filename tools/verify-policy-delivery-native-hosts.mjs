/**
 * Fresh native loading over two public-CLI-delivered roots; A -> B -> A.
 * Local provider chooses reads. No real-model or autonomous compliance claim.
 * Project configuration and content are never written by this probe.
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";

const fail = message => { throw new Error(message); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!key?.startsWith("--") || !value || key in options) fail("Expected distinct named options");
  options[key] = value;
}
const client = options["--client"];
if (!["claude", "kimi", "opencode"].includes(client)) fail("--client must be claude, kimi or opencode");
for (const key of ["--root-a", "--root-b", "--output", "--binary"])
  if (!isAbsolute(options[key] ?? "")) fail(key + " must be absolute");
if (process.platform !== "linux" || process.getuid?.() === 0) fail("Unprivileged Linux required");
const output = resolve(options["--output"]), binary = resolve(options["--binary"]);
mkdirSync(dirname(output), { recursive: true });
try { mkdirSync(output, { mode: 0o700 }); } catch (error) {
  if (error?.code === "EEXIST") fail("Output already exists");
  throw error;
}
const roots = [options["--root-a"], options["--root-b"], options["--root-a"]];
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15000 });
const report = { schemaVersion: 1, client, binary, binarySha256: hash(readFileSync(binary)), version: version.stdout?.trim(),
  simulation: "Loopback provider chooses native reads; real client context and read results are observed",
  manualSkillAttachment: false, projectConfigurationEdited: false, autonomousComplianceVerified: false, status: "failed", sessions: [] };
function strings(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, result);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, result);
  return result;
}
function containsLines(actual, expected) {
  return expected.split(/\r?\n/).filter(line => line.trim()).every(line => actual.replace(/\r/g, "").includes(line));
}
async function session(root, index) {
  const dir = join(output, "session-" + (index + 1)), home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const markerPath = join(root, ".aih-config.json"), markerBytes = readFileSync(markerPath), marker = JSON.parse(markerBytes);
  if (marker.policyBinding?.state !== "active") fail("Root requires active public CLI binding");
  const context = marker.contextDir ?? "ai-coding", bridgePath = join(root, context, "policy-required-guidance.md");
  const bridge = readFileSync(bridgePath), receipt = JSON.parse(readFileSync(join(root, context, "policy-required-guidance.receipt.json")));
  if (hash(bridge) !== receipt.sha256 || !receipt.targets.includes(client)) fail("Guidance receipt mismatch");
  const nativePrefix = client === "claude" ? ".claude/" : client === "kimi" ? ".kimi-code/" : ".agents/skills/";
  // The guidance receipt is the product's exact selected-content contract.
  // Read every client-native Markdown item it names: a skill entry alone does
  // not establish that selected agents or commands are reachable.
  const nativePaths = [...new Set(receipt.components.flatMap(item => item.paths)
    .filter(path => path.startsWith(nativePrefix) && path.endsWith(".md")))];
  if (!nativePaths.length) fail("No receipt-owned native Markdown guidance");
  const paths = [bridgePath, ...nativePaths.map(path => join(root, path))], expected = paths.map(path => readFileSync(path, "utf8"));
  const result = { root, projectId: marker.policyBinding.projectId, markerSha256: hash(markerBytes), source: receipt.source,
    policyVersion: receipt.policyVersion, components: receipt.components.map(item => item.id),
    files: paths.map((path, i) => ({ path, sha256: hash(expected[i]) })), requests: [], auxiliaryRequests: [], status: "failed" };
  let stage = 0, requestCount = 0, server, child, timer, stdout = "", stderr = "";
  try {
    server = createServer((req, res) => {
      if (client === "claude" && req.url === "/api/hello") {
        result.auxiliaryRequests.push({ route: req.url, method: req.method, purpose: "native provider capability handshake", response: 404 });
        req.resume(); res.writeHead(404); res.end(); return;
      }
      let body = "";
      req.on("data", part => { body += part; if (body.length > 4194304) req.destroy(); });
      req.on("end", () => {
        try {
          if (req.method !== "POST" || !(client === "claude" ? req.url.startsWith("/v1/messages") : req.url.endsWith("/chat/completions"))) fail("Unexpected provider route " + req.url);
          const input = JSON.parse(body);
          const requestNumber = ++requestCount;
          save(join(dir, "request-" + requestNumber + ".json"), input);
          if (client === "claude" && req.url.split("?")[0] === "/v1/messages/count_tokens") {
            result.auxiliaryRequests.push({ requestNumber, route: req.url, purpose: "native token count" });
            res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 1000 })); return;
          }
          if (client === "opencode" && !input.tools?.length) {
            result.auxiliaryRequests.push({ requestNumber, route: req.url, purpose: "native title generation without tools" });
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end("data: " + JSON.stringify({ id: "chatcmpl-title", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "Project readiness" }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n"); return;
          }
          const messages = input.messages ?? [];
          const lastTool = client === "claude"
            ? messages.findLast(item => item.role === "user" && Array.isArray(item.content))?.content.find(item => item.type === "tool_result")
            : messages.findLast(item => item.role === "tool");
          if (client === "claude") stage = lastTool ? Number(lastTool.tool_use_id?.replace("toolu_read_", "")) + 1 : 0;
          const seen = stage === 0 ? strings([input.system, messages]).join("\n").includes("policy-required-guidance.md")
            : containsLines(strings(lastTool?.content).join("\n"), expected[stage - 1]);
          result.requests.push({ requestNumber, route: req.url, stage, normalStartupGuidancePointer: stage === 0 ? seen : undefined,
            nativeReadContentVerified: stage > 0 ? seen : undefined, tools: (input.tools ?? []).map(tool => tool.function?.name ?? tool.name) });
          if (!seen) fail(stage === 0 ? "Native startup omitted guidance pointer" : "Native read did not return expected content");
          if (client === "claude") {
            if (stage < paths.length && !(input.tools ?? []).some(tool => tool.name === "Read")) fail("Native Read tool not advertised");
            const payload = { id: "msg_fixture_" + stage, type: "message", role: "assistant", model: "claude-fixture",
              content: stage < paths.length ? [{ type: "tool_use", id: "toolu_read_" + stage, name: "Read", input: { file_path: paths[stage] } }]
                : [{ type: "text", text: "Native required-content loading observed." }],
              stop_reason: stage < paths.length ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
            if (input.stream === true) {
              res.writeHead(200, { "content-type": "text/event-stream" });
              const emit = (event, data) => res.write("event: " + event + "\ndata: " + JSON.stringify({ type: event, ...data }) + "\n\n");
              emit("message_start", { message: { ...payload, content: [], stop_reason: null } });
              const block = payload.content[0];
              emit("content_block_start", { index: 0, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
              emit("content_block_delta", { index: 0, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
              emit("content_block_stop", { index: 0 });
              emit("message_delta", { delta: { stop_reason: payload.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
              emit("message_stop", {}); res.end();
            } else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); }
            stage++; return;
          }
          let delta, finish;
          if (stage < paths.length) {
            const tool = (input.tools ?? []).find(item => /^(Read|ReadFile|read)$/i.test(item.function?.name));
            if (!tool) fail("Native file-read tool not advertised");
            const properties = tool.function.parameters?.properties ?? {};
            const key = ["file_path", "filePath", "path"].find(key => key in properties);
            if (!key) fail("Native read schema has no path");
            delta = { role: "assistant", tool_calls: [{ index: 0, id: "call_read_" + stage, type: "function",
              function: { name: tool.function.name, arguments: JSON.stringify({ [key]: paths[stage] }) } }] };
            finish = "tool_calls";
          } else { delta = { role: "assistant", content: "Native required-content loading observed." }; finish = "stop"; }
          const chunk = choice => ({ id: "chatcmpl-loading-" + index + "-" + stage, object: "chat.completion.chunk",
            created: 1, model: "fixture-model", choices: [choice] });
          res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
          res.write("data: " + JSON.stringify(chunk({ index: 0, delta, finish_reason: null })) + "\n\n");
          res.write("data: " + JSON.stringify(chunk({ index: 0, delta: {}, finish_reason: finish })) + "\n\n");
          res.end("data: [DONE]\n\n"); stage++;
        } catch (error) {
          result.failure = error.message;
          if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: error.message } }));
        }
      });
    });
    await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
    const url = "http://127.0.0.1:" + server.address().port + "/v1";
    const env = { PATH: "/home/aih-probe/runtime/bin:/usr/bin:/bin", HOME: home, USER: "aih-probe", LOGNAME: "aih-probe", CI: "1", TERM: "dumb", NO_COLOR: "1",
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state") };
    const prompt = "Begin a new task in this repository. Follow its normal project instructions and report readiness.";
    let args;
    if (client === "claude") {
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }));
      env.ANTHROPIC_BASE_URL = url.replace(/\/v1$/, ""); env.ANTHROPIC_API_KEY = "fixture-not-a-credential";
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"; env.DISABLE_UPDATES = "1"; env.DISABLE_TELEMETRY = "1";
      args = ["--setting-sources", "project", "--permission-mode", "dontAsk", "--output-format", "json", "--no-session-persistence", "-p", prompt];
    } else if (client === "kimi") {
      const configHome = join(home, ".kimi-code"); mkdirSync(configHome, { recursive: true });
      writeFileSync(join(configHome, "config.toml"), 'default_model = "fixture"\ndefault_permission_mode = "auto"\ntelemetry = false\n[providers.fixture]\ntype = "openai"\nbase_url = ' + JSON.stringify(url) + '\napi_key = "fixture-not-a-credential"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture-model"\nmax_context_size = 200000\nmax_output_size = 512\ncapabilities = ["tool_use"]\n');
      writeFileSync(join(configHome, "tui.toml"), "[upgrade]\nauto_install = false\n");
      env.KIMI_CODE_HOME = configHome;
      args = ["--model", "fixture", "--prompt", prompt, "--output-format", "stream-json"];
    } else {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { "aih-loopback": { npm: "@ai-sdk/openai-compatible",
        options: { baseURL: url, apiKey: "fixture-not-a-credential" }, models: { "fixture-model": { name: "Fixture model", tool_call: true, limit: { context: 200000, output: 512 } } } } } });
      env.OPENCODE_DISABLE_MODELS_FETCH = "1"; env.OPENCODE_DISABLE_AUTOUPDATE = "1";
      env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"; env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1";
      args = ["--pure", "run", "--format", "json", "--model", "aih-loopback/fixture-model", prompt];
    }
    result.invocation = { binary, args, cwd: root, providerConfiguration: "Isolated home or provider-only environment overlay" };
    child = spawn(binary, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", part => { stdout = (stdout + part).slice(-262144); });
    child.stderr.on("data", part => { stderr = (stderr + part).slice(-16000); });
    result.exit = await new Promise(accept => {
      timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} accept({ timeout: true }); }, 45000);
      child.once("error", error => accept({ error: error.message }));
      child.once("close", (code, signal) => accept({ code, signal }));
    });
    result.markerUnchanged = hash(readFileSync(markerPath)) === result.markerSha256;
    result.filesUnchanged = paths.every((path, i) => hash(readFileSync(path)) === result.files[i].sha256);
    result.status = result.exit.code === 0 && stage === paths.length + 1 && !result.failure && result.markerUnchanged && result.filesUnchanged ? "passed" : "failed";
  } catch (error) { result.failure = error.message; }
  finally {
    clearTimeout(timer);
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    server?.closeAllConnections(); if (server?.listening) await new Promise(accept => server.close(accept));
    writeFileSync(join(dir, "stdout.txt"), stdout); writeFileSync(join(dir, "stderr.txt"), stderr);
    save(join(dir, "RESULT.json"), result);
  }
  return result;
}
try {
  for (let i = 0; i < roots.length; i++) report.sessions.push(await session(roots[i], i));
  report.status = report.sessions.every(item => item.status === "passed") ? "passed" : "failed";
} catch (error) { report.failure = error.message; }
save(join(output, "RESULT.json"), report);
process.stdout.write(JSON.stringify({ status: report.status, output }) + "\n");
process.exitCode = report.status === "passed" ? 0 : 1;
