#!/usr/bin/env node
// aih-managed usage recorder. Appends one event to .aih/usage.jsonl. Best-effort:
// it must never throw into a hook, so every step is guarded.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

const argv = process.argv.slice(2);

// --from <cli>: read the CLI's PostToolUse hook payload on stdin and derive the event.
// Used by the per-tool hooks; the positional form below stays for the git floor + scripts.
if (argv[0] === "--from") {
  const cli = argv[1] || "unknown";
  try {
    const p = JSON.parse(readFileSync(0, "utf8") || "{}");
    const e = fromHookPayload(cli, p);
    if (e) writeEvent(e);
  } catch {}
  process.exit(0);
}

// Map a CLI hook payload -> a usage event. mcp/subagent/tool are solid when the
// hook exposes a tool name; skill source stays best-effort by design.
function fromHookPayload(cli, p) {
  const ev = { ts: new Date().toISOString(), tool: cli };
  const ti = inputOf(p);
  const t = toolNameOf(p);
  if (t === "Task" || t === "task" || t === "Agent" || t === "agent") {
    const name = skillId(ti.subagent_type, ti.subagentType, ti.agent_name, ti.agentName, ti.agent, ti.name, p.subagent_type, p.subagentType);
    if (!name) { ev.kind = "tool"; ev.name = t; return ev; }
    ev.kind = "skill"; ev.name = name;
    ev.source = sourceOf(ev.name, ti, p);
    return ev;
  }
  if (t === "Skill" || t === "skill") {
    const name = skillId(ti.skill_name, ti.skillName, ti.skill?.name, ti.skill?.id, ti.command, ti.skill, ti.name, ti.id, p.skill_name, p.skillName, p.skill?.name, p.skill?.id);
    if (!name) { ev.kind = "tool"; ev.name = t; return ev; }
    ev.kind = "skill"; ev.name = name;
    ev.source = sourceOf(ev.name, ti, p);
    return ev;
  }
  const m = mcpOf(t, p, ti);
  if (m) {
    ev.kind = "mcp"; ev.server = m.server; ev.name = m.name;
    return ev;
  }
  if (t) { ev.kind = "tool"; ev.name = t; return ev; }
  return undefined;
}

function obj(v) {
  if (v && typeof v === "object") return v;
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return {};
}

function inputOf(p) {
  return obj(
    p.tool_input ||
      p.toolInput ||
      p.input ||
      p.args ||
      p.arguments ||
      p.toolArgs ||
      p.tool_args ||
      p.toolCall?.input ||
      p.toolCall?.args ||
      p.toolCall?.arguments ||
      p.tool_call?.input ||
      p.tool_call?.args ||
      p.tool_info?.mcp_tool_arguments
  );
}

function str(...xs) {
  for (const x of xs) if (typeof x === "string" && x.trim()) return x.trim();
  return undefined;
}

function skillId(...xs) {
  const id = str(...xs);
  return id && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ? id : undefined;
}

function toolNameOf(p) {
  return str(
    p.tool_name,
    p.toolName,
    p.tool,
    p.name,
    p.function_name,
    p.functionName,
    p.tool_call?.name,
    p.tool_call?.tool_name,
    p.toolCall?.name,
    p.toolCall?.toolName,
    p.tool?.name,
    p.tool_info?.mcp_tool_name,
    p.call?.tool,
    p.call?.name
  );
}

function mcpOf(tool, p, ti) {
  const info = obj(p.tool_info || p.toolInfo);
  const explicitServer = str(
    p.server,
    p.server_name,
    p.serverName,
    ti.server,
    ti.server_name,
    ti.serverName,
    info.mcp_server_name,
    info.mcpServerName,
    info.server
  );
  const explicitName = str(
    p.mcp_tool,
    p.mcpTool,
    ti.tool,
    ti.name,
    ti.mcp_tool,
    ti.mcpTool,
    info.mcp_tool_name,
    info.mcpToolName,
    info.name
  );
  if (explicitServer && explicitName) return { server: explicitServer, name: explicitName };
  if (!tool) return undefined;
  if (tool.startsWith("MCP:")) {
    const m = /^MCP:([^:/.]+)[:/.](.+)$/.exec(tool);
    if (m) return { server: m[1], name: m[2] };
  }
  if (tool.startsWith("mcp__")) {
    const parts = tool.split("__");
    return { server: parts[1], name: parts.slice(2).join("__") || parts[1] };
  }
  if (tool.startsWith("mcp_")) {
    const parts = tool.slice(4).split("_");
    if (parts.length >= 2) return { server: parts[0], name: parts.slice(1).join("_") };
  }
  return undefined;
}

function sourceOf(name, ti, p) {
  const explicit = str(ti.source, ti.provenance, ti.skill_source, ti.skillSource, ti.skill?.source, p.source, p.provenance, p.skill_source, p.skillSource, p.skill?.source);
  if (explicit === "ecc" || explicit === "canon" || explicit === "user") return explicit;
  if (isEccSkillOrAgent(name)) return "ecc";
  return undefined;
}

function isEccSkillOrAgent(name) {
  if (!name) return false;
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return existsSync(home + "/.claude/skills/ecc/" + name + "/SKILL.md") ||
    existsSync(home + "/.claude/ecc/.agents/skills/" + name + "/SKILL.md") ||
    existsSync(home + "/.claude/ecc/skills/" + name + "/SKILL.md") ||
    existsSync(home + "/.claude/ecc/agents/" + name + ".md") ||
    existsSync(home + "/.claude/agents/" + name + ".md");
}

function writeEvent(ev) {
  try {
    mkdirSync(".aih", { recursive: true });
    appendFileSync(".aih/usage.jsonl", JSON.stringify(ev) + "\n");
  } catch {}
}

const [tool = "unknown", kind = "tool", name, extra] = argv;
const ev = { ts: new Date().toISOString(), tool, kind };
if (name) ev.name = name;
if (kind === "mcp" && extra) ev.server = extra;
else if (extra) ev.source = extra;

if (kind === "commit") {
  try {
    const out = execFileSync("git", ["show", "--numstat", "--format=", "HEAD"], { encoding: "utf8" });
    let added = 0, removed = 0, files = 0;
    for (const line of out.split("\n")) {
      const [a, r] = line.split("\t");
      if (a !== undefined && r !== undefined && line.trim()) {
        added += Number.parseInt(a, 10) || 0;
        removed += Number.parseInt(r, 10) || 0;
        files += 1;
      }
    }
    ev.added = added; ev.removed = removed; ev.files = files;
    ev.sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    ev.branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  } catch {}
}

try {
  mkdirSync(".aih", { recursive: true });
  appendFileSync(".aih/usage.jsonl", JSON.stringify(ev) + "\n");
} catch {}
