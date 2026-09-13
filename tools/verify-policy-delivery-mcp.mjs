/**
 * Disposable public-CLI acceptance for one reviewed governed MCP control on all
 * seven advertised native configuration targets.  The policy is authority input;
 * every client configuration and ownership receipt must be produced by dist/cli.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const TARGETS = ["claude", "codex", "cursor", "copilot", "opencode", "kimi", "kiro"];
const PATHS = {
  claude: ".claude/managed-settings.json",
  codex: ".codex/config.toml",
  cursor: ".cursor/mcp.json",
  copilot: ".github/mcp.json",
  opencode: "opencode.json",
  kimi: ".kimi-code/mcp.json",
  kiro: ".kiro/settings/mcp.json",
};
const COMMAND = "uvx";
const ARGS = ["--offline", "--no-python-downloads", "--no-env-file", "code-review-graph@2.3.7", "serve"];

function fail(message) { throw new Error(`policy-delivery-mcp: ${message}`); }
function assert(ok, message) { if (!ok) fail(message); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function write(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, { encoding: "utf8", flag: "wx" }); }
function writeJson(path, value) { write(path, `${JSON.stringify(value, null, 2)}\n`); }
function parseArgs(argv) {
  let output; let policyPath;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--output") output = argv[++i]; else if (argv[i] === "--policy") policyPath = argv[++i];
    else if (argv[i] === "--help") { process.stdout.write("Usage: node tools/verify-policy-delivery-mcp.mjs --output ABSOLUTE_EMPTY_DIR\n"); process.exit(0); }
    else fail("expected --output");
  }
  if (typeof output !== "string" || !isAbsolute(output)) fail("--output must be absolute");
  if (typeof policyPath !== "string" || !isAbsolute(policyPath)) fail("--policy must be absolute"); return { output: resolve(output), policyPath: resolve(policyPath) };
}
function policy() {
  const server = { type: "stdio", command: COMMAND, args: ARGS, env: {} };
  const risk = { classification: "local", egress: "none", credentials: "none", supplyChain: "pinned", skillsProvider: undefined };
  const subject = `mcp-server-sha256:${sha256(stable({ shape: server, risk }))}`;
  return {
    schemaVersion: 2, minimumPosture: "enterprise", references: { repoContract: "fictional-adopter/project.json" },
    mcp: { allowManagedOnly: true, allowedServers: [], disabledServers: [] },
    governance: {
      policyVersion: "fictional-lane4-mcp-v1", supportedClis: TARGETS,
      catalog: { reviewed: [{ id: "code-review-graph", kind: "mcp", description: "offline pinned graph fixture", capabilities: [], risks: [], source: { type: "mcp", server: "code-review-graph", subject }, targets: TARGETS, projector: "mcp-managed-settings", lifecycle: "supported", evidence: { record: "lane4-local-reviewed" } }], custom: [] },
      activations: [{ candidate: "code-review-graph", state: "active", targets: TARGETS }], authority: { approvals: [] },
    },
  };
}
function git(root, args) { const run = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }); assert(run.status === 0, `git ${args[0]} failed: ${run.stderr}`); }
function commit(root, label) { git(root, ["add", "-A"]); git(root, ["commit", "-qm", label]); }
function snapshot(root) {
  const result = {};
  const visit = (dir) => { for (const item of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, item.name); if (item.isDirectory() && item.name !== ".git") visit(path); else if (item.isFile()) result[relative(root, path).replaceAll("\\", "/")] = sha256(readFileSync(path)); } };
  visit(root); return result;
}
function invoke(root, args, result, expectSuccess = true) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "AIH_ORG_POLICY"));
  const run = spawnSync(process.execPath, [resolve("dist/cli.js"), ...args], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000, env });
  result.commands.push({ args, exitCode: run.status, stdout: run.stdout, stderr: run.stderr });
  if (expectSuccess) assert(run.status === 0, `${args.slice(0, 2).join(" ")} failed: ${run.stderr || run.stdout}`);
  return run;
}
function assertProjected(root) {
  for (const [target, path] of Object.entries(PATHS)) {
    assert(existsSync(join(root, path)), `${target} projection missing ${path}`);
    assert(readFileSync(join(root, path), "utf8").includes("code-review-graph"), `${target} projection lacks reviewed MCP identity`);
    assert(readFileSync(join(root, path), "utf8").includes("code-review-graph@2.3.7"), `${target} projection lost exact offline pin`);
  }
  const marker = JSON.parse(readFileSync(join(root, ".aih-config.json"), "utf8"));
  assert(Object.keys(marker.nativeMcpProjections ?? {}).sort().join(",") === TARGETS.filter((target) => target !== "claude" && target !== "kiro").sort().join(","), "native receipt target set is incomplete");
}
function main() {
  const { output, policyPath } = parseArgs(process.argv.slice(2));
  assert(!existsSync(output), "--output must not already exist");
  mkdirSync(output, { recursive: true });
  const root = join(output, "McpSeven"); mkdirSync(join(root, "fictional-adopter"), { recursive: true });
  write(join(root, "aih-org-policy.json"), readFileSync(policyPath, "utf8")); writeJson(join(root, "ai-coding", "project.json"), { name: "mcp-seven-consumer" });
  const result = { schemaVersion: 1, purpose: "public dist CLI governed MCP seven-target delivery", targets: TARGETS, root, commands: [], status: "failed" };
  try {
    git(root, ["init", "-q"]); git(root, ["config", "user.email", "fixture@example.invalid"]); git(root, ["config", "user.name", "AIH Fixture"]); commit(root, "reviewed policy input");
    invoke(root, ["policy", "bind", root, "--project", "mcp-seven-consumer", "--cli", TARGETS.join(","), "--policy", join(root, "aih-org-policy.json"), "--apply", "--json", "--no-log"], result);
    commit(root, "reviewed policy binding");
    invoke(root, ["policy", "project", root, "--posture", "enterprise", "--cli", TARGETS.join(","), "--apply", "--json", "--no-log"], result);
    assertProjected(root); commit(root, "public MCP seven-target delivery");
    const before = snapshot(root);
    invoke(root, ["policy", "project", root, "--posture", "enterprise", "--cli", TARGETS.join(","), "--apply", "--json", "--no-log"], result);
    assert(JSON.stringify(snapshot(root)) === JSON.stringify(before), "repeat projection changed owned state");
    const wrong = invoke(root, ["policy", "project", root, "--posture", "enterprise", "--cli", "gemini", "--apply", "--json", "--no-log"], result, false);
    assert(wrong.status !== 0, "unsupported target projection unexpectedly succeeded");
    assert(JSON.stringify(snapshot(root)) === JSON.stringify(before), "rejected target changed delivery state");
    result.status = "passed";
  } catch (error) { result.failure = error instanceof Error ? error.message : String(error); }
  writeJson(join(output, "RESULT.json"), result); process.stdout.write(`${JSON.stringify({ status: result.status, output: join(output, "RESULT.json") })}\n`); process.exitCode = result.status === "passed" ? 0 : 1;
}
main();
