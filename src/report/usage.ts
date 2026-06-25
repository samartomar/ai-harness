import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { aggregateUsage, type Counted } from "../usage/aggregate.js";
import { readUsage } from "../usage/events.js";

const bar = (items: Counted[], label: string): string[] => {
  if (items.length === 0) return [`  ${label}: (none captured yet)`];
  return [`  ${label}:`, ...items.slice(0, 8).map((i) => `    ${i.name}  ·  ${i.count}`)];
};

/**
 * The usage-analytics panel for `aih report` (local). Reads `.aih/usage.jsonl`
 * (written by the capture hooks `aih usage` installs) and renders: activity by
 * tool, top skills by source (ECC / canon / user), and MCP server/tool calls —
 * the multi-tool "what's actually used" view. Honest stub until events exist.
 */
export function usagePanel(ctx: PlanContext): DigestAction {
  const events = readUsage(ctx);
  if (events.length === 0) {
    return digest(
      "Usage — no events captured yet",
      lines(
        "Install the capture layer with `aih usage --apply` — a universal git post-commit",
        "hook starts recording activity for ANY tool; per-tool hooks add skill/MCP detail.",
        "Usage accrues in `.aih/usage.jsonl` and shows up here.",
      ),
      { events: 0 },
    );
  }
  const s = aggregateUsage(events);
  const skillsTotal = s.skills.top.reduce((n, c) => n + c.count, 0);
  const body = lines(
    `Activity by tool: ${s.tools.map((t) => `${t.name} (${t.count})`).join(" · ")}`,
    `Commits captured: ${s.commits.count}  ·  LOC +${s.commits.added}/-${s.commits.removed} across ${s.commits.files} files`,
    "",
    ...(skillsTotal > 0
      ? [
          "Skills used (by source):",
          ...bar(s.skills.bySource.ecc, "ECC"),
          ...bar(s.skills.bySource.canon, "canon"),
          ...bar(s.skills.bySource.user, "user"),
        ]
      : ["Skills: no per-tool skill hook wired yet — see `aih usage` coverage doc."]),
    "",
    ...(s.mcp.servers.length > 0
      ? ["MCP usage:", ...bar(s.mcp.servers, "servers"), ...bar(s.mcp.tools, "tools")]
      : ["MCP: no per-tool MCP hook wired yet."]),
  );
  return digest(
    `Usage — ${s.total} events · ${s.tools.length} tool(s) · ${skillsTotal} skill calls`,
    body,
    {
      total: s.total,
      tools: s.tools,
      commits: s.commits,
      skills: s.skills,
      mcp: s.mcp,
    },
  );
}
