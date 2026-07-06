import { homedir } from "node:os";
import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { type Action, doc, type PlanContext, probe } from "../internals/plan.js";
import { lines } from "../internals/render.js";

type CodexMcpTransport = "stdio" | "http" | "mixed" | "unknown";

export interface CodexMcpCollision {
  name: string;
  projectTransport: CodexMcpTransport;
  globalTransport: CodexMcpTransport;
}

const TOML_SERVER_HEADER =
  /^[ \t]*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^.\]'"]+))\][ \t]*(?:#.*)?$/;
const TOML_TABLE_HEADER = /^[ \t]*\[/;

function tomlHeaderName(match: RegExpMatchArray): string {
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function mergeTransport(
  current: CodexMcpTransport,
  next: Exclude<CodexMcpTransport, "mixed" | "unknown">,
): CodexMcpTransport {
  if (current === "unknown") return next;
  return current === next ? current : "mixed";
}

function codexMcpTransports(raw: string): Map<string, CodexMcpTransport> {
  const transports = new Map<string, CodexMcpTransport>();
  let current: string | undefined;
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const table = line.match(TOML_SERVER_HEADER);
    if (table) {
      current = tomlHeaderName(table);
      transports.set(current, transports.get(current) ?? "unknown");
      continue;
    }
    if (TOML_TABLE_HEADER.test(line)) {
      current = undefined;
      continue;
    }
    if (current === undefined) continue;
    const trimmed = line.trim();
    if (/^command\s*=/.test(trimmed)) {
      transports.set(current, mergeTransport(transports.get(current) ?? "unknown", "stdio"));
    } else if (/^url\s*=/.test(trimmed)) {
      transports.set(current, mergeTransport(transports.get(current) ?? "unknown", "http"));
    }
  }
  return transports;
}

export function codexMcpTransportCollisions(ctx: PlanContext): CodexMcpCollision[] {
  const home = ctx.env.USERPROFILE || ctx.env.HOME || homedir();
  const project = codexMcpTransports(readIfExists(join(ctx.root, ".codex", "config.toml")) ?? "");
  const global = codexMcpTransports(readIfExists(join(home, ".codex", "config.toml")) ?? "");
  const collisions: CodexMcpCollision[] = [];
  for (const [name, projectTransport] of project) {
    const globalTransport = global.get(name);
    if (
      globalTransport === undefined ||
      projectTransport === "unknown" ||
      globalTransport === "unknown" ||
      projectTransport === globalTransport
    ) {
      continue;
    }
    collisions.push({ name, projectTransport, globalTransport });
  }
  return collisions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function codexMcpCollisionActions(ctx: PlanContext): Action[] {
  const collisions = codexMcpTransportCollisions(ctx);
  if (collisions.length === 0) return [];
  const summary = collisions
    .map((c) => `${c.name} (project ${c.projectTransport}, global ${c.globalTransport})`)
    .join(", ");
  return [
    doc(
      "Codex MCP server name collision — fix before running ECC",
      lines(
        "The Codex project-local and global MCP configs define the same server name with",
        "different transports. Running ECC now could leave Codex with a combined config",
        "that has both stdio and remote fields for one server name.",
        "",
        `Collision(s): ${summary}.`,
        "",
        "Remove or rename one side of each collision, then rerun `aih ecc --cli codex --apply`.",
      ),
    ),
    probe("Codex MCP server name collision", () => ({
      name: "Codex MCP server name collision",
      verdict: "fail",
      code: "mcp.config-invalid",
      detail: summary,
    })),
  ];
}
