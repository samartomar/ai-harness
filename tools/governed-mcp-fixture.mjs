// Harmless stdio MCP fixture: only its own event log; no network or model calls.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [eventPath, expectedNonce] = process.argv.slice(2);
if (!eventPath || !expectedNonce) process.exit(2);
const nonceVerified = process.env.AIH_MCP_FIXTURE_NONCE === expectedNonce;
const record = (method) => appendFileSync(eventPath, `${JSON.stringify({ method, nonceVerified })}\n`);
record("process/start");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const tool = {
  name: "fixture_probe",
  description: "Harmless AIH fixture; returns a fixed local acceptance result.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
input.on("line", (line) => {
  if (line.length > 1024 * 1024) return process.exit(3);
  let message;
  try { message = JSON.parse(line); } catch { return process.exit(3); }
  if (typeof message.method !== "string") return;
  const known = ["initialize", "notifications/initialized", "tools/list", "tools/call", "ping", "resources/list", "resources/templates/list", "prompts/list"];
  if (known.includes(message.method)) record(message.method);
  if (message.id === undefined) return;
  let result;
  switch (message.method) {
    case "initialize": result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "aih-governed-mcp-fixture", version: "1.0.0" } }; break;
    case "tools/list": result = { tools: [tool] }; break;
    case "tools/call":
      if (message.params?.name !== tool.name) return respond({ error: { code: -32602, message: "Unknown fixture tool" } });
      result = { content: [{ type: "text", text: JSON.stringify({ fixture: true, nonceVerified }) }], isError: false }; break;
    case "resources/list": result = { resources: [] }; break;
    case "resources/templates/list": result = { resourceTemplates: [] }; break;
    case "prompts/list": result = { prompts: [] }; break;
    case "ping": result = {}; break;
    default: return respond({ error: { code: -32601, message: "Unsupported fixture method" } });
  }
  respond({ result });
  function respond(value) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...value })}\n`); }
});
input.on("close", () => process.exit(0));
