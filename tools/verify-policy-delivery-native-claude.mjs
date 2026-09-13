/** Native Claude permission acceptance after public AIH guardrails delivery. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

function fail(message) {
  throw new Error(`native-claude-policy-delivery: ${message}`);
}

function assertion(condition, message) {
  if (!condition) fail(message);
}

function parse(argv) {
  const values = {};
  let expectAllowed = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--help") {
      process.stdout.write("Usage: node tools/verify-policy-delivery-native-claude.mjs --claude ABSOLUTE_PATH --root ABSOLUTE_ROOT --output ABSOLUTE_RESULT\n");
      process.exit(0);
    }
    if (argv[index] === "--expect-allowed") {
      expectAllowed = true;
      continue;
    }
    const key = argv[index];
    if (!key.startsWith("--") || argv[index + 1] === undefined) fail("expected option values");
    values[key.slice(2)] = argv[++index];
  }
  for (const key of ["claude", "root", "output"])
    if (typeof values[key] !== "string" || !isAbsolute(values[key])) fail(`--${key} must be absolute`);
  return {
    claude: resolve(values.claude),
    root: resolve(values.root),
    output: resolve(values.output),
    denyCommand: values["deny-command"],
    denyRule: values["deny-rule"] ?? "Bash(git clean -fd*)",
    sentinelName: values["sentinel-name"] ?? "lane4-native-forbidden-sentinel",
    allowedTools: values["allowed-tools"],
    expectAllowed,
  };
}

function generatedSettings(root, denyRule, expectAllowed) {
  const path = join(root, ".claude", "settings.json");
  assertion(existsSync(path), "public AIH guardrails did not produce .claude/settings.json");
  const permissions = JSON.parse(readFileSync(path, "utf8")).permissions;
  assertion(permissions?.allow?.includes("Bash(git status*)"), "generated allow rule is absent");
  if (expectAllowed) assertion(!permissions?.deny?.includes(denyRule), `withdrawn deny rule remains: ${denyRule}`);
  else assertion(permissions?.deny?.includes(denyRule), `generated deny rule is absent: ${denyRule}`);
  return { path, permissions };
}

async function nativePrintSession({ claude, root, command, name, allowedTools }) {
  const record = { name, command, providerRequests: 0, toolResult: undefined };
  // A before/after policy test deliberately runs the same named session twice
  // in one consumer root. Give every native invocation a fresh trusted home so
  // the fixture's no-clobber project-trust marker remains valid on the rerun.
  const home = mkdtempSync(join(root, `.native-${name}-home-`));
  writeFileSync(join(home, ".claude.json"), `${JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } })}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (chunks.length === 0) {
      response.writeHead(400);
      response.end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    record.providerRequests += 1;
    const results = body.messages?.findLast((message) => message.role === "user" && Array.isArray(message.content))?.content;
    const toolResult = results?.find((item) => item.type === "tool_result");
    if (toolResult !== undefined) record.toolResult = toolResult;
    const payload = toolResult === undefined
      ? { id: "msg_fixture_1", type: "message", role: "assistant", model: "claude-fixture", content: [{ type: "tool_use", id: "toolu_fixture_1", name: "Bash", input: { command, timeout: 10_000 } }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
      : { id: "msg_fixture_2", type: "message", role: "assistant", model: "claude-fixture", content: [{ type: "text", text: "fixture complete" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolveListen, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = provider.address();
    assertion(address !== null && typeof address !== "string", "fixture provider did not bind a TCP port");
    record.argv = ["--setting-sources", "project", "--permission-mode", "dontAsk", "--output-format", "json", "--no-session-persistence"];
    if (allowedTools !== undefined) record.argv.push("--allowedTools", allowedTools);
    record.argv.push("-p");
    const run = await new Promise((resolveRun, reject) => {
      const child = spawn(claude, [...record.argv, "Use the supplied Bash tool once."], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: home,
          LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          ANTHROPIC_API_KEY: "fixture-key-not-a-secret",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_UPDATES: "1", DISABLE_TELEMETRY: "1",
        },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolveRun({ exitCode, signal, stdout, stderr });
      });
    });
    record.exitCode = run.exitCode;
    record.signal = run.signal;
    record.stdout = run.stdout;
    record.stderr = run.stderr;
  } finally {
    await new Promise((resolveClose) => provider.close(resolveClose));
  }
  return record;
}

async function main() {
  const { claude, root, output, denyCommand, denyRule, sentinelName, allowedTools, expectAllowed } = parse(process.argv.slice(2));
  assertion(process.platform === "linux", "requires native Linux or WSL2 execution");
  assertion(existsSync(claude) && existsSync(root) && !existsSync(output), "invalid native executable, root, or output path");
  assertion(/^[a-z0-9._-]+$/i.test(sentinelName), "--sentinel-name must be a filename");
  const settings = generatedSettings(root, denyRule, expectAllowed);
  const sentinel = join(root, sentinelName);
  if (expectAllowed) {
    assertion(existsSync(sentinel), "denied sentinel is missing before withdrawal positive control");
  } else {
    let descriptor;
    try {
      descriptor = openSync(sentinel, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") fail("sentinel already exists");
      throw error;
    }
    try {
      writeFileSync(descriptor, "must survive denied command\n", { encoding: "utf8" });
    } finally {
      closeSync(descriptor);
    }
  }
  const report = { schemaVersion: 1, purpose: "fresh native Claude command permission enforcement after public AIH guardrails delivery", claude, root, settings, denyRule, allowedTools: allowedTools ?? null, expectAllowed, provider: "deterministic loopback Anthropic Messages transport; native Claude decides the Bash permission", status: "failed" };
  try {
    report.allowed = await nativePrintSession({ claude, root, name: "allowed", command: "git status --short" });
    assertion(report.allowed.providerRequests >= 2 && report.allowed.toolResult?.is_error !== true, "generated allow rule did not permit git status");
    report.denied = await nativePrintSession({ claude, root, name: "denied", allowedTools, command: denyCommand ?? `git clean -fd -- ${JSON.stringify(sentinel)}` });
    if (expectAllowed) {
      assertion(!existsSync(sentinel), "withdrawn command policy did not permit the positive control");
      assertion(report.denied.toolResult?.is_error !== true, "withdrawn command policy still reported refusal");
    } else {
      assertion(existsSync(sentinel), "forbidden command removed the sentinel");
      assertion(report.denied.toolResult?.is_error === true || /permission|denied/i.test(`${report.denied.stdout}\n${report.denied.stderr}`), "generated deny rule did not report a native refusal");
    }
    report.status = "passed";
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
  }
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, output })}\n`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}

await main();
