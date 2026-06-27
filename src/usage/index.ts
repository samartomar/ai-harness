import { join } from "node:path";
import { resolveTargets } from "../internals/cli-detect.js";
import { readIfExists } from "../internals/fsxn.js";
import { aihIgnoreWrite } from "../internals/gitignore.js";
import {
  type Action,
  type CommandSpec,
  doc,
  type Plan,
  type PlanContext,
  plan,
  probe,
  writeText,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import { gitPostCommitChainSnippet, gitPostCommitHook, usageRecorderScript } from "./capture.js";
import { USAGE_PATH } from "./events.js";

const RECORDER_PATH = join(".aih", "usage-record.mjs");
const GIT_HOOK_PATH = join(".git", "hooks", "post-commit");

/**
 * Per-tool behavioral-capture mechanism (verified Jun 2026). The universal git
 * floor is installed for everyone; these are how the per-tool skill/MCP layer
 * wires in (the next slice auto-generates them — for now they're documented so the
 * wiring is exact, not invented). `undefined` = no local hook (parse a log instead).
 */
const TOOL_HOOK: Partial<Record<string, string>> = {
  claude: "`.claude/settings.json` hooks → `PostToolUse` (captures Skill / mcp__ tool calls)",
  codex: "Codex hooks `PostToolUse`/`Stop` (+ `~/.codex/sessions/*.jsonl`)",
  cursor: "`~/.cursor/hooks.json` → `afterMCPExecution` / `beforeSubmitPrompt` / `afterFileEdit`",
  gemini: "`telemetry.outfile` (local) + hooks `AfterTool`",
  copilot: "`~/.copilot/hooks/` → `postToolUse` (+ `events.jsonl`)",
  windsurf: "Windsurf hooks `post_mcp_tool_use` + transcript JSONL",
  opencode: "OpenCode TS plugin (`tool.execute.after`) + storage JSON",
  kimi: "`[[hooks]]` in `config.toml` → `PostToolUse` (+ `wire.jsonl`)",
  kiro: "`.kiro/hooks/*.kiro.hook` Run Command (aih already generates these)",
  antigravity: "Antigravity `hooks.json` `PostToolUse`",
  zed: "no hooks — parse `threads.db` SQLite (deferred)",
};

/** The recorder one-liner a per-tool hook calls to log a skill/MCP event. */
function coverageDoc(clis: string[]): Action {
  const rows = clis.map(
    (c) => `- **${c}** — ${TOOL_HOOK[c] ?? "no documented local hook yet (deferred)"}`,
  );
  return doc(
    "Usage capture — coverage + how the per-tool skill/MCP layer wires in",
    lines(
      "The UNIVERSAL git floor (installed above) records commit activity for EVERY tool —",
      "it keys off the commit, not the agent, so it works for whatever CLI made the change.",
      "It carries no skill/MCP attribution; that comes from per-tool hooks that call:",
      "",
      "  node .aih/usage-record.mjs <tool> skill <name> <ecc|canon|user>",
      "  node .aih/usage-record.mjs <tool> mcp <tool-name> <server>",
      "",
      "Per-tool behavioral hook mechanism (verified) for your selected CLIs:",
      "",
      ...rows,
      "",
      "Dollar cost is the one uneven signal: real USD only from Claude; Codex/Gemini/Kimi/",
      "OpenCode give token counts (× your rate); Cursor/Windsurf lock tokens+cost cloud-only.",
      "`aih report` aggregates whatever `.aih/usage.jsonl` holds, with a per-tool coverage note.",
    ),
  );
}

/**
 * `aih usage` — install the multi-tool usage-capture layer. Writes the recorder +
 * a universal git `post-commit` hook (records commit activity for ANY tool, under
 * `--apply`), ensures `.aih/` is gitignored, and documents the per-tool skill/MCP
 * hook wiring. Read-only/local: it generates capture artifacts and never calls out.
 * Usage accrues in `.aih/usage.jsonl`, which `aih report` renders.
 */
async function usagePlan(ctx: PlanContext): Promise<Plan> {
  const { clis } = await resolveTargets(ctx);
  const actions: Action[] = [
    writeText(
      RECORDER_PATH,
      usageRecorderScript(),
      "usage recorder (.aih/usage-record.mjs) — appends one event per hook call",
      { mode: 0o755 },
    ),
    writeText(
      GIT_HOOK_PATH,
      gitPostCommitHook(),
      "universal git post-commit hook — records commit activity for any tool (best-effort)",
      { mode: 0o755, once: true },
    ),
    aihIgnoreWrite(ctx.root),
    coverageDoc(clis),
  ];

  // A pre-existing post-commit hook is preserved (write-once above), so the capture
  // would otherwise never fire. Hand over a chainable snippet to add to it. (AIH-USAGE-001)
  const existingHook = readIfExists(join(ctx.root, GIT_HOOK_PATH));
  if (existingHook !== undefined && !existingHook.includes("usage-record.mjs")) {
    actions.push(
      doc(
        "existing post-commit hook detected — chain aih usage capture into it",
        lines(
          "A `.git/hooks/post-commit` hook already exists, so aih did NOT overwrite it.",
          "Append this best-effort block to that hook so commit activity is still captured:",
          "",
          gitPostCommitChainSnippet(),
        ),
      ),
    );
  }

  actions.push(
    probe("node on PATH (the recorder needs it)", async (c): Promise<Check> => {
      const res = await c.run(["node", "--version"]);
      return res.spawnError || res.code !== 0
        ? {
            name: "node",
            verdict: "fail",
            detail: "node not found — the recorder won't run",
            code: "env.node-runtime",
          }
        : { name: "node", verdict: "pass", detail: res.stdout.trim() };
    }),
    probe(
      `usage log present (${USAGE_PATH})`,
      async (): Promise<Check> => ({
        name: "usage-log",
        verdict: "skip",
        detail: "accrues after the first commit (or a wired per-tool hook fires)",
        code: "usage.no-data",
      }),
    ),
  );
  return plan("usage", ...actions);
}

export const command: CommandSpec = {
  name: "usage",
  summary:
    "Install the usage-capture layer (universal git hook → .aih/usage.jsonl); powers `aih report` usage analytics",
  plan: usagePlan,
};
