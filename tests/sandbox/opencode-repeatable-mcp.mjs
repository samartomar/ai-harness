// Fictional native acceptance only. Also invoked through OpenCode's bash tool.
import { randomUUID } from "node:crypto";
import { appendFile, readFile, readlink, rename, writeFile } from "node:fs/promises";
import { connect } from "node:net";

const path = process.argv[2];
if (!path) throw new Error("fixture-config-required");
const cfg = JSON.parse(await readFile(path, "utf8"));
for (const key of ["root", "marker", "protectedRead", "protectedWrite", "nonce", "policy"]) {
  if (typeof cfg[key] !== "string") throw new Error("invalid-fixture-config");
}
const eventPath = `${path}.events.jsonl`;
const event = async (value) => appendFile(eventPath, `${JSON.stringify(value)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const attempt = async (operation) => {
  try { await operation(); return "UNEXPECTED_SUCCESS"; }
  catch (error) { return error?.code ?? "UNKNOWN"; }
};
const socket = (endpoint) => attempt(() => new Promise((resolve, reject) => {
  const client = connect(endpoint);
  client.once("connect", () => { client.destroy(); resolve(); });
  client.once("error", reject);
  client.setTimeout(1500, () => {
    client.destroy(); reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
  });
}));
async function probe(kind) {
  const marker = await readFile(`${cfg.root}/marker.txt`, "utf8");
  const allowedPath = `${cfg.root}/allowed-${kind}-${randomUUID()}.txt`;
  await writeFile(allowedPath, "fixture allowed write\n", { flag: "wx" });
  const profile = `${cfg.root}/.aih/sandbox/opencode.json`;
  const profileBytes = await readFile(profile);
  const configPath = `${cfg.root}/opencode.json`;
  const configBytes = await readFile(configPath);
  const ancestorRenameCode = await attempt(() => rename(`${cfg.root}/.aih`, `${cfg.root}/.aih-moved`));
  // An unexpected success is still a failed assertion; restore only our fixture.
  if (ancestorRenameCode === "UNEXPECTED_SUCCESS") await rename(`${cfg.root}/.aih-moved`, `${cfg.root}/.aih`);
  const result = {
    kind, pid: process.pid, pidNamespace: await readlink("/proc/self/ns/pid"),
    root: process.cwd(), marker, configuredRoot: cfg.root,
    nonceVerified: process.env.AIH_OPENCODE_NONCE === cfg.nonce,
    policyVerified: process.env.AIH_ORG_POLICY === cfg.policy,
    syntheticEnvAbsent: process.env.AIH_CREDENTIAL_SENTINEL === undefined,
    homeMatches: process.env.HOME === `${cfg.root}/.aih/sandbox/opencode-home`,
    allowedWrite: (await readFile(allowedPath, "utf8")) === "fixture allowed write\n",
    protectedReadCode: await attempt(() => readFile(cfg.protectedRead)),
    protectedWriteCode: await attempt(() => writeFile(cfg.protectedWrite, "forbidden\n")),
    profileWriteCode: await attempt(() => writeFile(profile, profileBytes)),
    configWriteCode: await attempt(() => writeFile(configPath, configBytes)),
    ancestorRenameCode,
    tcpCode: await socket({ host: "127.0.0.1", port: cfg.tcpPort }),
    unixCode: await socket({ path: cfg.unixPath }),
  };
  await event({ event: "probe", result });
  return result;
}
async function handle(message) {
  if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") return;
  await event({ method: message.method, pid: process.pid, cwd: process.cwd() });
  if (!Object.hasOwn(message, "id")) return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
    serverInfo: { name: "aih-repeatable-fixture", version: "1" },
  } });
  if (message.method === "tools/list") return send({ jsonrpc: "2.0", id: message.id, result: {
    tools: [{ name: "fixture_probe", description: "Fictional confined marker probe",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
  } });
  if (message.method === "tools/call" && message.params?.name === "fixture_probe") {
    const result = await probe("mcp");
    return send({ jsonrpc: "2.0", id: message.id, result: {
      content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false,
    } });
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported fixture method" } });
}
if (process.argv[3] === "--shell-probe") {
  send(await probe("shell"));
} else {
  let buffer = "";
  let chain = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) chain = chain.then(() => handle(JSON.parse(line))).catch((error) => {
        process.stderr.write(`${error.message}\n`); process.exitCode = 1;
      });
    }
  });
}
