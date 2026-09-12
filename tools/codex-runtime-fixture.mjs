import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const fixtureTool = {
  name: "fixture_probe",
  description: "Read one nonce-bound local fixture canary.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export function fixtureReply(message, expectedNonce, cwd) {
  if (message?.id === undefined || typeof message?.method !== "string") return undefined;
  if (message.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "aih-codex-runtime-fixture", version: "1.0.0" },
    };
  }
  if (message.method === "tools/list") return { tools: [fixtureTool] };
  if (message.method === "tools/call" && message.params?.name === fixtureTool.name) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ fixture: true, nonce: expectedNonce, root: realpathSync(cwd) }),
        },
      ],
      isError: false,
    };
  }
  if (message.method === "ping") return {};
  return { error: { code: -32601, message: "Unsupported fixture request" } };
}

async function main() {
  const [expectedNonce] = process.argv.slice(2);
  if (!expectedNonce) process.exit(2);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.exitCode = 3;
      return;
    }
    const reply = fixtureReply(message, expectedNonce, process.cwd());
    if (!reply || message.id === undefined) return;
    const envelope = "error" in reply ? reply : { result: reply };
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...envelope })}\n`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
