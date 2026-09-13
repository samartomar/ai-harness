// Copied into the fictional consumer's native OpenCode plugin directory.
// Bun.serve runs inside OpenCode's own sandbox namespace. No credentials/egress.
import { appendFileSync, readFileSync, readlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

export async function Plugin({ directory }) {
  const cfg = JSON.parse(readFileSync(`${directory}/fixture.json`, "utf8"));
  const boot = randomUUID();
  const log = (value) => appendFileSync(`${directory}/provider-events.jsonl`, `${JSON.stringify({
    boot, pid: process.pid, pidNamespace: readlinkSync("/proc/self/ns/pid"), ...value,
  })}\n`);
  let requests = 0;
  let toolRequests = 0;
  const expectedIds = ["call_shell", "call_fixture", "call_managed"];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 43792, async fetch(request) {
    if (request.method !== "POST") return new Response("fixture-only", { status: 404 });
    const body = await request.json();
    requests += 1;
    log({ event: "request", requests, body });
    let delta, finish;
    if (!body.tools?.length) {
      // OpenCode also calls its provider to name the session before the tool turn.
      delta = { role: "assistant", content: "Fictional native acceptance" };
      finish = "stop";
    } else if (++toolRequests === 1) {
      const names = body.tools?.map((tool) => tool.function?.name) ?? [];
      const fixtureName = names.find((name) => name === "fixture_fixture_probe");
      const managedName = names.find((name) => name?.endsWith("sequentialthinking"));
      if (!names.includes("bash") || !fixtureName || !managedName) {
        log({ event: "failure", reason: "native-tools-missing", names });
        return new Response("native-tools-missing", { status: 400 });
      }
      const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
      const specs = [
        ["bash", { command: `${quote(cfg.node)} ${quote(cfg.mcpScript)} ${quote(`${directory}/fixture.json`)} --shell-probe`, description: "Run the approved fictional shell boundary probe" }],
        [fixtureName, {}],
        [managedName, { thought: `Fictional marker ${cfg.marker.trim()}`, thoughtNumber: 1, totalThoughts: 1, nextThoughtNeeded: false }],
      ];
      delta = { role: "assistant", tool_calls: specs.map(([name, args], index) => ({
        index, id: expectedIds[index], type: "function", function: { name, arguments: JSON.stringify(args) },
      })) };
      finish = "tool_calls";
      log({ event: "selected-tools", names: specs.map(([name]) => name) });
    } else {
      const returns = body.messages.filter((message) => message.role === "tool");
      const complete = expectedIds.every((id) => returns.some((message) => message.tool_call_id === id));
      log({ event: "tool-results", complete, returns });
      delta = { role: "assistant", content: complete ? "Native fixture tool results received." : "Native fixture results missing." };
      finish = "stop";
    }
    const chunk = (choice) => JSON.stringify({ id: boot, object: "chat.completion.chunk",
      created: 1, model: "fixture-model", choices: [choice] });
    return new Response(`data: ${chunk({ index: 0, delta, finish_reason: null })}\n\ndata: ${chunk({
      index: 0, delta: {}, finish_reason: finish,
    })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  log({ event: "started", root: directory });
  return { dispose() { server.stop(true); } };
}
