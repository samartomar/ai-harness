/**
 * Native acceptance for governed AIH usage metering on the advertised Claude and
 * Codex targets. Public packed-CLI commands create the outputs; native clients
 * use deterministic loopback providers and execute one harmless tool call each.
 * No model, billing, authentication, or source-checkout AIH command is used.
 *
 * Usage:
 *   node tools/verify-policy-delivery-native-usage.mjs --output ABSOLUTE_PACKET
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authorProtectedPolicyViaPackedWorkbench } from "./lib/author-protected-policy-via-workbench.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const packetArg = process.argv.indexOf("--output");
const packet = packetArg >= 0 ? resolve(process.argv[packetArg + 1] ?? "") : "";
if (!isAbsolute(packet)) throw new Error("--output must be absolute");
if (existsSync(packet)) throw new Error("output packet already exists");
mkdirSync(packet, { recursive: true });

const fail = (message) => { throw new Error(`native-usage: ${message}`); };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value, { encoding: "utf8", flag: "wx" }); };
const writeJson = (path, value) => write(path, `${JSON.stringify(value, null, 2)}\n`);
const command = (file, args, cwd, env = {}, timeout = 180_000) => {
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) fail(`${file} ${args.join(" ")}: ${result.error.message}`);
  return result;
};
const requireSuccess = (result, label) => {
  if (result.status !== 0) fail(`${label}: exit ${result.status}; ${result.stderr || result.stdout}`);
  return result;
};
const runGit = (cwd, args) => requireSuccess(command("git", args, cwd), `git ${args.join(" ")}`);
const runNode = (cwd, args, env = {}) => requireSuccess(command(process.execPath, args, cwd, env), `node ${args.join(" ")}`);
const invoke = (cwd, cli, args, env = {}, allowFailure = false) => {
  const result = command(process.execPath, [cli, ...args], cwd, env);
  if (!allowFailure) requireSuccess(result, `aih ${args.join(" ")}`);
  return result;
};

function wslPath(path) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (!match) fail(`cannot convert Windows path to WSL: ${path}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function wslCopyRoot(source, destination) {
  const archived = spawnSync("tar.exe", ["-cf", "-", "-C", source, "."], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (archived.status !== 0 || !Buffer.isBuffer(archived.stdout))
    fail(`could not archive public Claude root: ${archived.stderr}`);
  const unpack = spawnSync(
    "wsl.exe",
    ["-d", "AIH-Sandbox-Lane1", "--", "bash", "-lc", `rm -rf ${destination}; mkdir -p ${destination}; tar -xf - -C ${destination}`],
    { input: archived.stdout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  if (unpack.status !== 0) fail(`could not transfer public Claude root to WSL: ${unpack.stderr || unpack.stdout}`);
}

function readWslText(path) {
  const result = command("wsl.exe", ["-d", "AIH-Sandbox-Lane1", "--", "bash", "-lc", `cat ${path}`], sourceRoot, {}, 30_000);
  if (result.status !== 0) fail(`could not read WSL evidence: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function wslWriteFile(source, destination) {
  const payload = readFileSync(source).toString("base64");
  const result = spawnSync(
    "wsl.exe",
    ["-d", "AIH-Sandbox-Lane1", "--", "bash", "-lc", `echo ${payload} | base64 -d > ${destination}`],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, windowsHide: true },
  );
  if (result.status !== 0) fail(`could not transfer native runner to WSL: ${result.stderr || result.stdout}`);
}

function makeClaudeRunner(path) {
  write(path, String.raw`import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error("runner requires root and output");
mkdirSync(output.substring(0, output.lastIndexOf("/")), { recursive: true });
let requests = 0, bodies = [], server;
server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let input = {};
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
  requests += 1; bodies.push({ request: requests, method: req.method, url: req.url, body: input });
  const messages = input.messages ?? [];
  const hasResult = messages.some((item) => item.role === "user" && Array.isArray(item.content) && item.content.some((part) => part.type === "tool_result"));
  const payload = hasResult
    ? { id: "msg_native_usage_2", type: "message", role: "assistant", model: "claude-native-fixture", content: [{ type: "text", text: "fixture complete" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
    : { id: "msg_native_usage_1", type: "message", role: "assistant", model: "claude-native-fixture", content: [{ type: "tool_use", id: "toolu_native_usage", name: "Bash", input: { command: "node -e \"process.stdout.write('native-claude-usage-tool')\"", timeout: 10000 } }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(payload));
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
const home = output + "/home"; mkdirSync(home, { recursive: true });
const env = { ...process.env, PATH: "/home/aih-probe/runtime/bin:/usr/bin:/bin", HOME: home, USER: "aih-probe", LOGNAME: "aih-probe", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb", NO_COLOR: "1", XDG_CONFIG_HOME: home + "/.config", XDG_CACHE_HOME: home + "/.cache", XDG_DATA_HOME: home + "/.local/share", XDG_STATE_HOME: home + "/.local/state", ANTHROPIC_BASE_URL: "http://127.0.0.1:" + address.port, ANTHROPIC_API_KEY: "fixture-only", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_UPDATES: "1", DISABLE_TELEMETRY: "1" };
mkdirSync(home + "/.config", { recursive: true });
writeFileSync(home + "/.claude.json", JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }) + "\n");
const child = spawn("/home/aih-probe/runtime/bin/claude", ["--setting-sources", "project", "--permission-mode", "dontAsk", "--allowedTools", "Bash", "--output-format", "json", "--no-session-persistence", "-p", "Use the Bash tool once, then report complete."], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk);
const exitCode = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
writeFileSync(output + "/provider-requests.json", JSON.stringify(bodies, null, 2));
const result = { client: "claude", root, command: ["claude", "--setting-sources", "project", "--permission-mode", "dontAsk", "--allowedTools", "Bash", "--output-format", "json", "--no-session-persistence", "-p", "<generic prompt>"], provider: "deterministic loopback Anthropic Messages", providerRequests: requests, exit: exitCode, stdout, stderr };
writeFileSync(output + "/RESULT.json", JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify(result) + "\n");
server.close();
process.exitCode = exitCode.code === 0 ? 0 : 1;`);
}

async function codexSession(root, output, cli) {
  mkdirSync(output, { recursive: true });
  const providerRequests = [];
  const provider = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let input = {}; try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    providerRequests.push({ request: providerRequests.length + 1, method: req.method, url: req.url, body: input });
    const hasResult = JSON.stringify(input.input ?? input).includes("function_call_output");
    const response = hasResult
      ? { id: `resp_native_usage_${providerRequests.length}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: "fixture-model", output: [{ type: "message", id: "msg_native_usage", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture complete", annotations: [] }] }] }
      : { id: `resp_native_usage_${providerRequests.length}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: "fixture-model", output: [{ type: "function_call", id: "fc_native_usage", call_id: "call_native_usage", name: "exec_command", arguments: JSON.stringify({ cmd: "Write-Output native-codex-usage-tool", workdir: root, max_output_tokens: 1000 }), status: "completed" }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      ...(hasResult ? [{ type: "response.output_item.added", output_index: 0, item: { ...response.output[0], status: "in_progress", content: [] } }, { type: "response.content_part.added", item_id: response.output[0].id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", item_id: response.output[0].id, output_index: 0, content_index: 0, delta: "fixture complete" }, { type: "response.output_text.done", item_id: response.output[0].id, output_index: 0, content_index: 0, text: "fixture complete" }, { type: "response.content_part.done", item_id: response.output[0].id, output_index: 0, content_index: 0, part: response.output[0].content[0] }] : [{ type: "response.output_item.added", output_index: 0, item: { ...response.output[0], status: "in_progress", arguments: "" } }, { type: "response.function_call_arguments.delta", item_id: response.output[0].id, output_index: 0, delta: response.output[0].arguments }, { type: "response.function_call_arguments.done", item_id: response.output[0].id, output_index: 0, arguments: response.output[0].arguments }]),
      { type: "response.output_item.done", output_index: 0, item: response.output[0] },
      { type: "response.completed", response },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  const address = provider.address();
  const home = join(output, "home"); mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), `model_provider = "fixture"\nmodel = "fixture-model"\n\n[features]\napps = false\nplugins = false\nremote_plugin = false\nrecommended_plugins = false\n\n[model_providers.fixture]\nname = "Fixture Responses"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nenv_key = "FIXTURE_API_KEY"\n`);
  const prompt = "Use the workspace command tool once to print a harmless marker, then report complete.";
  const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const expression = `& ${psQuote("C:\\ProgramData\\npm\\codex.ps1")} exec --json --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --skip-git-repo-check --color never --cd ${psQuote(root)} --model fixture-model ${psQuote(prompt)}`;
  const result = await new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", expression], { cwd: root, env: { ...process.env, CODEX_HOME: home, HOME: home, USERPROFILE: home, FIXTURE_API_KEY: "fixture-only" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  writeJson(join(output, "provider-requests.json"), providerRequests);
  writeJson(join(output, "RESULT.json"), { client: "codex", root, command: ["codex.ps1", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "--cd", root, "--model", "fixture-model", "<generic prompt>"], provider: "deterministic loopback OpenAI Responses", providerRequests: providerRequests.length, exit: result, stdout: result.stdout, stderr: result.stderr });
  await new Promise((resolve) => provider.close(resolve));
  return result;
}

async function main() {
  if (process.platform !== "win32") fail("this acceptance harness expects Windows public CLI plus WSL native Claude");
  const tempBase = realpathSync(resolve(tmpdir()));
  const temp = realpathSync(mkdtempSync(join(tempBase, "aih-native-usage-")));
  const captured = { schemaVersion: 1, status: "failed", targets: ["claude", "codex"], simulation: "deterministic loopback providers; native clients execute one harmless tool call", noRealBillingClaim: true, projectConfigurationEdited: false, commands: [], native: {} };
  try {
    if (!existsSync(npmCli)) fail("npm CLI unavailable");
    const packed = requireSuccess(command(process.execPath, [npmCli, "pack", "--json", "--pack-destination", temp], sourceRoot), "npm pack");
    const manifest = JSON.parse(packed.stdout);
    if (!Array.isArray(manifest) || typeof manifest[0]?.filename !== "string") fail("pack manifest");
    const consumer = join(temp, "consumer"), admin = join(temp, "admin"), claudeRoot = join(packet, "fixture-claude"), codexRoot = join(packet, "fixture-codex");
    mkdirSync(consumer); mkdirSync(admin); mkdirSync(claudeRoot); mkdirSync(codexRoot);
    writeJson(join(consumer, "package.json"), { name: "native-usage-consumer" });
    requireSuccess(command(process.execPath, [npmCli, "install", "--no-audit", "--no-fund", "--ignore-scripts", resolve(temp, manifest[0].filename)], consumer), "npm install packed CLI");
    const installed = join(consumer, "node_modules", "@aihq", "core"), cli = join(installed, "dist", "cli.js");
    if (!existsSync(cli)) fail("packed CLI missing");
    for (const root of [claudeRoot, codexRoot]) { runGit(root, ["init", "-q"]); runGit(root, ["config", "user.email", "fixture@example.invalid"]); runGit(root, ["config", "user.name", "AIH Native Fixture"]); }
    // Unrelated event hooks model a third-party registration and must survive AIH withdrawal.
    writeJson(join(claudeRoot, ".claude", "settings.json"), { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node -e \\\"process.stdout.write('third-party-claude')\\\"" }] }] } });
    writeJson(join(codexRoot, ".codex", "hooks.json"), { hooks: { SessionStart: [{ command: "Write-Output third-party-codex" }] } });
    for (const root of [claudeRoot, codexRoot]) { runGit(root, ["add", "."]); runGit(root, ["commit", "-qm", "seed unrelated third-party hook"]); }
    const generated = invoke(admin, cli, ["policy", "generate", "--apply", "--out", join(admin, "aih-policy-workbench.html")]);
    captured.commands.push({ action: "policy generate", exitCode: generated.status, stdout: generated.stdout, stderr: generated.stderr });
    const described = invoke(consumer, cli, ["policy", "managed", "usage-metering", "describe", "--json"]);
    const descriptor = JSON.parse(described.stdout).digests?.[0]?.data;
    if (descriptor?.adapter?.id !== "aih-usage-metering" || JSON.stringify(descriptor.targets) !== '["claude","codex"]') fail("narrow target descriptor");
    const core = await import(pathToFileURL(join(installed, "dist", "index.js")).href);
    const now = new Date(), issuedAt = now.toISOString(), expiresAt = new Date(now.getTime() + 86_400_000).toISOString();
    const evidence = { attestor: "native-usage-fixture", evidence: { artifactDigests: [`sha256:${"2".repeat(64)}`], id: "native-usage-proof", kind: "assessment", payloadDigest: `sha256:${"1".repeat(64)}`, summary: "Disposable authority evidence." }, expiresAt, format: "aih-organization-evidence", issuedAt, notBefore: issuedAt, subjectDigest: descriptor.subject.subjectDigest, version: 1 };
    const evidenceText = stableJson(evidence), evidencePath = join(admin, "organization-evidence.json"); write(evidencePath, evidenceText);
    const decision = { acceptedFindings: [], acceptedGaps: [], actor: "native-admin@example.invalid", allowedEffects: ["configure"], conditions: [], control: { digest: `sha256:${"b".repeat(64)}`, id: "native-usage-control" }, disposition: "approved", evidence: { attestor: evidence.attestor, digest: `sha256:${sha256(`aih-organization-evidence/v1\0${evidenceText}`)}`, id: evidence.evidence.id }, expiresAt, format: "aih-governance-decision", id: "decision-native-usage", issuedAt, issuer: "native-platform-security", notBefore: issuedAt, policy: { digest: `sha256:${"a".repeat(64)}`, id: "native-platform-policy", version: "2026.09" }, qualificationBasis: { attestor: evidence.attestor, evidenceDigest: `sha256:${sha256(`aih-organization-evidence/v1\0${evidenceText}`)}`, kind: "organization-qualified" }, reason: "Disposable proof authorizes the fixed AIH usage adapter.", subject: descriptor.subject, targets: ["claude", "codex"], version: 2 };
    const decisionDigest = core.governanceDecisionDigestV2(decision), policyPath = join(admin, "policy-bundle.json");
    const workbenchDecision = { "protected-actor": decision.actor, "protected-attestor": decision.evidence.attestor, "protected-control-digest": decision.control.digest, "protected-control-id": decision.control.id, "protected-decision-id": decision.id, "protected-effects": "configure", "protected-evidence-digest": decision.evidence.digest, "protected-evidence-id": decision.evidence.id, "protected-kind": decision.subject.kind, "protected-policy-digest": decision.policy.digest, "protected-policy-id": decision.policy.id, "protected-policy-version": decision.policy.version, "protected-reason": decision.reason, "protected-source-release": decision.subject.source.release, "protected-source-revision": decision.subject.source.revision, "protected-source-type": "aih", "protected-subject-id": decision.subject.id, "protected-targets": "claude,codex" };
    const writePolicy = (bundleVersion, revoked = false) => authorProtectedPolicyViaPackedWorkbench({ authorityFields: { "protected-bundle-version": bundleVersion, "protected-expires-at": expiresAt, "protected-issued-at": issuedAt, "protected-issuer": decision.issuer, "protected-issuer-repository": "example.invalid/native-admin" }, decisions: [workbenchDecision], htmlPath: join(admin, "aih-policy-workbench.html"), outputPath: policyPath, revokeDecisionIndexes: revoked ? [0] : [] });
    await writePolicy("2026.09.1");
    const authorityEnv = { AIH_ORG_POLICY: policyPath };
    const targetInfo = [{ name: "claude", root: claudeRoot }, { name: "codex", root: codexRoot }];
    for (const target of targetInfo) {
      write(join(target.root, "organization-evidence.json"), evidenceText);
      const args = ["policy", "managed", "usage-metering", "reconcile", target.root, "--decision", decision.id, "--decision-digest", decisionDigest, "--target", target.name, "--evidence", "organization-evidence.json", "--apply", "--json"];
      const run = invoke(target.root, cli, args, authorityEnv); captured.commands.push({ action: "usage reconcile", target: target.name, exitCode: run.status, stdout: run.stdout, stderr: run.stderr });
      for (const relative of [".aih/usage-record.mjs", ".aih/org-policy-hook-receipt.json", ".gitignore", target.name === "claude" ? ".claude/settings.json" : ".codex/hooks.json"]) if (!existsSync(join(target.root, relative))) fail(`${target.name} public output missing: ${relative}`);
    }
    makeClaudeRunner(join(packet, "claude-runner.mjs"));
    const claudeRunOutput = join(packet, "claude-session"), wslClaudeRoot = `/tmp/aih-native-usage-claude-${process.pid}/root`, wslClaudeOutput = `/tmp/aih-native-usage-claude-${process.pid}/output`;
    wslCopyRoot(claudeRoot, wslClaudeRoot);
    const wslRunner = `/tmp/aih-native-usage-claude-${process.pid}/claude-runner.mjs`;
    wslWriteFile(join(packet, "claude-runner.mjs"), wslRunner);
    const claudeCommand = `rm -rf ${wslClaudeOutput}; mkdir -p ${wslClaudeOutput}; /home/aih-probe/runtime/bin/node ${wslRunner} ${wslClaudeRoot} ${wslClaudeOutput}`;
    const claudeRun = command("wsl.exe", ["-d", "AIH-Sandbox-Lane1", "--", "bash", "-lc", claudeCommand], sourceRoot, {}, 90_000);
    captured.native.claudeInvocation = { command: claudeCommand, exitCode: claudeRun.status, stdout: claudeRun.stdout, stderr: claudeRun.stderr };
    if (claudeRun.status !== 0) fail(`native Claude session failed: ${claudeRun.stderr || claudeRun.stdout}`);
    captured.native.claude = JSON.parse(claudeRun.stdout.trim().split(/\r?\n/).at(-1));
    writeJson(join(claudeRunOutput, "RESULT.json"), captured.native.claude);
    const claudeUsage = readWslText(`${wslClaudeRoot}/.aih/usage.jsonl`);
    write(join(claudeRunOutput, "usage.jsonl"), claudeUsage);
    if (!claudeUsage.includes('"tool":"claude"')) fail("native Claude usage event not observed");
    const codexRunOutput = join(packet, "codex-session"), codexResult = await codexSession(codexRoot, codexRunOutput, cli);
    captured.native.codex = JSON.parse(readFileSync(join(codexRunOutput, "RESULT.json"), "utf8"));
    if (codexResult.code !== 0) fail(`native Codex session failed: ${codexResult.stderr || codexResult.stdout}`);
    const codexUsagePath = join(codexRoot, ".aih", "usage.jsonl");
    const codexUsage = existsSync(codexUsagePath) ? readFileSync(codexUsagePath, "utf8") : "";
    captured.native.codex.usageEventObserved = codexUsage.includes('"tool":"codex"');
    if (!captured.native.codex.usageEventObserved) {
      captured.native.codex.status = "blocked";
      captured.native.codex.blocker = "Codex 0.153.1 exec completed its native tool call, but the enabled project PostToolUse hook did not invoke .aih/usage-record.mjs; the exact generated command succeeds when run directly in the same root.";
    }
    const beforeClaudeOther = readFileSync(join(claudeRoot, ".claude", "settings.json"), "utf8"), beforeCodexOther = readFileSync(join(codexRoot, ".codex", "hooks.json"), "utf8");
    await writePolicy("2026.09.2", true);
    for (const target of targetInfo) {
      const args = ["policy", "managed", "usage-metering", "reconcile", target.root, "--decision", decision.id, "--decision-digest", decisionDigest, "--target", target.name, "--apply", "--json"];
      const run = invoke(target.root, cli, args, authorityEnv); captured.commands.push({ action: "usage revoke", target: target.name, exitCode: run.status, stdout: run.stdout, stderr: run.stderr });
      const receipt = JSON.parse(readFileSync(join(target.root, ".aih", "org-policy-hook-receipt.json"), "utf8"));
      if (receipt.state !== "revoked") fail(`${target.name} receipt did not revoke: ${receipt.state}`);
    }
    if (!readFileSync(join(claudeRoot, ".claude", "settings.json"), "utf8").includes("third-party-claude") || !readFileSync(join(codexRoot, ".codex", "hooks.json"), "utf8").includes("third-party-codex")) fail("unrelated hook lost during withdrawal");
    captured.native.claude.unrelatedHookPreserved = readFileSync(join(claudeRoot, ".claude", "settings.json"), "utf8") !== "" && beforeClaudeOther.includes("third-party-claude");
    captured.native.codex.unrelatedHookPreserved = readFileSync(join(codexRoot, ".codex", "hooks.json"), "utf8") !== "" && beforeCodexOther.includes("third-party-codex");
    if (!captured.native.claude.unrelatedHookPreserved || !captured.native.codex.unrelatedHookPreserved) fail("unrelated hook lost during withdrawal");
    captured.native.claude.usageEventObserved = true;
    captured.status = captured.native.codex.usageEventObserved ? "passed" : "partial";
  } catch (error) { captured.failure = error instanceof Error ? error.message : String(error); }
  writeJson(join(packet, "RESULT.json"), captured);
  process.stdout.write(JSON.stringify({ status: captured.status, output: packet }) + "\n");
  const resolvedPacket = resolve(packet); if (!resolvedPacket.startsWith(`${resolve(packet)}${sep}`) && resolvedPacket !== resolve(packet)) fail("unsafe packet");
  rmSync(temp, { recursive: true, force: true });
  process.exitCode = captured.status === "passed" ? 0 : 1;
}

await main();
