/** Native Claude Stop-hook execution and public-policy withdrawal fixture. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const fail = (message) => { throw new Error(`native-registrar: ${message}`); };
const assert = (value, message) => { if (!value) fail(message); };

function args(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help") { process.stdout.write("Usage: node tools/verify-policy-delivery-native-registrar.mjs --node NODE --cli CLI --claude CLAUDE --work-root DIR --output FILE\n"); process.exit(0); }
    if (!key.startsWith("--") || argv[i + 1] === undefined) fail("expected option values");
    values[key.slice(2)] = resolve(argv[++i]);
  }
  for (const key of ["node", "cli", "claude", "work-root", "output"]) assert(typeof values[key] === "string", `--${key} is required`);
  return { node: values.node, cli: values.cli, claude: values.claude, workRoot: values["work-root"], output: values.output };
}

function command(file, argv, cwd) {
  const result = spawnSync(file, argv, { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" } });
  const receipt = { file, argv, cwd, exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  assert(result.status === 0, `${file} ${argv.join(" ")} failed: ${result.stderr || result.stdout}`);
  return receipt;
}

function policy(root, registration) {
  return {
    schemaVersion: 2, minimumPosture: "enterprise", references: { repoContract: "ai-coding/project.json" },
    governance: { policyVersion: "2026-09-13.native-registrar", supportedClis: ["claude"], catalog: { reviewed: [], custom: [] }, hookRegistrations: registration === undefined ? [] : [registration] },
  };
}

async function nativeSession({ claude, root, events, name }) {
  const home = mkdtempSync(join(root, `.native-${name}-home-`));
  writeFileSync(join(home, ".claude.json"), `${JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } })}\n`, { mode: 0o600 });
  const provider = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    if (request.method !== "POST" || chunks.length === 0) { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model: "claude-fixture", content: [{ type: "text", text: "fixture complete" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise((ok, bad) => { provider.once("error", bad); provider.listen(0, "127.0.0.1", ok); });
  try {
    const address = provider.address(); assert(address && typeof address !== "string", "provider did not bind");
    const run = await new Promise((done, bad) => {
      const child = spawn(claude, ["--setting-sources", "project", "--permission-mode", "dontAsk", "--output-format", "json", "--no-session-persistence", "-p", "Give a concise status update."], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "fixture-key-not-a-secret", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_UPDATES: "1", DISABLE_TELEMETRY: "1" } });
      let stdout = "", stderr = ""; const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
      child.stdout.on("data", (chunk) => (stdout += chunk)); child.stderr.on("data", (chunk) => (stderr += chunk)); child.once("error", bad);
      child.once("close", (exitCode, signal) => { clearTimeout(timer); done({ exitCode, signal, stdout, stderr }); });
    });
    const lines = existsSync(events) ? readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    return { name, ...run, events: lines };
  } finally { await new Promise((done) => provider.close(done)); }
}

async function main() {
  const { node, cli, claude, workRoot, output } = args(process.argv.slice(2));
  assert(process.platform === "linux" && existsSync(node) && existsSync(cli) && existsSync(claude) && existsSync(workRoot) && !existsSync(output), "invalid runtime path or output");
  const root = mkdtempSync(join(workRoot, "lane4-native-registrar-")); const thirdParty = join(root, "third-party-stop-source"); const events = join(root, "stop-events.jsonl");
  const report = { schemaVersion: 1, purpose: "native Claude Stop hook via public policy registrar, followed by public withdrawal", root, thirdParty, cli, claude, status: "failed", commands: [] };
  try {
    mkdirSync(join(root, "ai-coding"), { recursive: true }); mkdirSync(thirdParty, { recursive: true }); mkdirSync(join(root, ".claude"), { recursive: true });
    const hook = join(thirdParty, "fixture-stop.mjs"); const operator = join(root, "operator-stop.mjs");
    const script = "import{appendFileSync,readFileSync}from'node:fs';const[o,l]=process.argv.slice(2);appendFileSync(o,JSON.stringify({label:l,stdin:readFileSync(0,'utf8')})+'\\n');";
    writeFileSync(hook, script); writeFileSync(operator, script);
    report.commands.push(command("git", ["init"], root), command("git", ["config", "user.name", "Fixture"], root), command("git", ["config", "user.email", "fixture@example.invalid"], root));
    report.commands.push(command("git", ["init"], thirdParty), command("git", ["config", "user.name", "Fixture"], thirdParty), command("git", ["config", "user.email", "fixture@example.invalid"], thirdParty), command("git", ["add", "fixture-stop.mjs"], thirdParty), command("git", ["commit", "-m", "fixture stop hook"], thirdParty));
    const thirdPartyCommit = command("git", ["rev-parse", "HEAD"], thirdParty).stdout.trim();
    const operatorCommand = `${node} ${operator} ${events} operator`;
    const thirdPartyCommand = `${node} ${hook} ${events} thirdparty`;
    const registration = { id: "fixture-thirdparty-stop", event: "Stop", command: thirdPartyCommand, functionTags: ["fixture-thirdparty-stop"], spawns: 1, owner: { kind: "third-party", framework: "fixture", declaredControls: [], pin: { repository: "fixture/stop-hook", commit: thirdPartyCommit, path: "fixture-stop.mjs", launcherSha256: sha256(thirdPartyCommand), runtimeVersion: "node-24.18.0" } } };
    writeFileSync(join(root, "ai-coding", "project.json"), "{}\n"); writeFileSync(join(root, "aih-org-policy.json"), `${JSON.stringify(policy(root, registration), null, 2)}\n`);
    report.commands.push(command("git", ["add", "aih-org-policy.json", "ai-coding/project.json", "operator-stop.mjs"], root), command("git", ["commit", "-m", "fixture policy"], root));
    const invoke = (subcommand, extra = []) => command(node, [cli, "policy", subcommand, root, "--posture", "enterprise", "--policy", join(root, "aih-org-policy.json"), "--json", "--no-log", ...extra], root);
    report.commands.push(invoke("validate"), invoke("bind", ["--project", "fixture-registrar", "--cli", "claude", "--apply"]), invoke("project", ["--apply"]));
    const projected = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    assert(JSON.stringify(projected.hooks?.Stop ?? []).includes(thirdPartyCommand), "public projection did not register third-party Stop hook");
    projected.hooks.Stop.push({ hooks: [{ type: "command", command: operatorCommand }] });
    writeFileSync(join(root, ".claude", "settings.json"), `${JSON.stringify(projected, null, 2)}\n`);
    report.commands.push(command("git", ["add", ".claude/settings.json"], root), command("git", ["commit", "-m", "operator adds unrelated Stop hook"], root));
    report.beforeWithdrawal = await nativeSession({ claude, root, events, name: "registered" });
    assert(report.beforeWithdrawal.exitCode === 0 && report.beforeWithdrawal.events.some((event) => event.label === "thirdparty"), "fresh native Claude session did not execute registered third-party Stop hook");
    writeFileSync(events, ""); writeFileSync(join(root, "aih-org-policy.json"), `${JSON.stringify(policy(root), null, 2)}\n`); report.commands.push(command("git", ["add", "aih-org-policy.json"], root), command("git", ["commit", "-m", "withdraw fixture registrar hook"], root));
    report.commands.push(invoke("rebind", ["--project", "fixture-registrar", "--cli", "claude", "--apply", "--force"]), invoke("project", ["--apply", "--force"]));
    const withdrawn = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    assert(!JSON.stringify(withdrawn.hooks?.Stop ?? []).includes(thirdPartyCommand) && JSON.stringify(withdrawn.hooks?.Stop ?? []).includes(operatorCommand), "public withdrawal did not remove only the registered hook");
    report.afterWithdrawal = await nativeSession({ claude, root, events, name: "withdrawn" });
    assert(report.afterWithdrawal.exitCode === 0 && !report.afterWithdrawal.events.some((event) => event.label === "thirdparty") && report.afterWithdrawal.events.some((event) => event.label === "operator"), "fresh post-withdrawal native session did not preserve only the unrelated operator Stop hook");
    report.registration = registration; report.status = "passed";
  } catch (error) { report.failure = error instanceof Error ? error.message : String(error); }
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 }); process.stdout.write(`${JSON.stringify({ status: report.status, output })}\n`); process.exitCode = report.status === "passed" ? 0 : 1;
}
await main();
