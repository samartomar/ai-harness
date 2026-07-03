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
// hook exposes a tool name; skill identity/source stays best-effort by design.
function fromHookPayload(cli, p) {
  const ev = { ts: new Date().toISOString(), tool: cli };
  const ti = inputOf(p);
  const t = toolNameOf(p);
  if (t === "Task" || t === "task") {
    ev.kind = "skill"; ev.name = str(ti.subagent_type, ti.subagentType, ti.agent, ti.name, "subagent");
    ev.source = sourceOf(ev.name, ti);
    return ev;
  }
  if (t === "Skill" || t === "skill") {
    ev.kind = "skill"; ev.name = str(ti.command, ti.skill, ti.name, ti.id, "skill");
    ev.source = sourceOf(ev.name, ti);
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

function inputOf(p) {
  const v = p.tool_input || p.toolInput || p.input || p.args || p.arguments || {};
  return v && typeof v === "object" ? v : {};
}

function str(...xs) {
  for (const x of xs) if (typeof x === "string" && x.trim()) return x.trim();
  return undefined;
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
    p.toolCall?.name,
    p.tool?.name,
    p.call?.tool,
    p.call?.name
  );
}

function mcpOf(tool, p, ti) {
  const explicitServer = str(p.server, p.server_name, p.serverName, ti.server, ti.server_name, ti.serverName);
  const explicitName = str(p.mcp_tool, p.mcpTool, ti.tool, ti.name, ti.mcp_tool, ti.mcpTool);
  if (explicitServer && explicitName) return { server: explicitServer, name: explicitName };
  if (!tool) return undefined;
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

function sourceOf(name, ti) {
  const explicit = str(ti.source, ti.provenance);
  if (explicit === "ecc" || explicit === "canon" || explicit === "user") return explicit;
  if (isEccSkillOrAgent(name)) return "ecc";
  return undefined;
}

function isEccSkillOrAgent(name) {
  if (!name) return false;
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return existsSync(home + "/.claude/skills/ecc/" + name + "/SKILL.md") ||
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
