import { join } from "node:path";
import type { Cli } from "../internals/clis.js";
import { upsertTextBlock } from "../internals/envfile.js";
import { readIfExists } from "../internals/fsxn.js";
import { type Action, doc, type PlanContext, writeJson, writeText } from "../internals/plan.js";
import { lines } from "../internals/render.js";

const USAGE_HOOK_SCOPE = "usage-metering";

function hookCommand(cli: Cli): string {
  return `node .aih/usage-record.mjs --from ${cli}`;
}

function codexProjectCommand(cli: Cli): string {
  return `node "$(git rev-parse --show-toplevel)/.aih/usage-record.mjs" --from ${cli}`;
}

function codexProjectCommandWindows(cli: Cli): string {
  return `for /f "delims=" %r in ('git rev-parse --show-toplevel 2^>nul') do @node "%r\\.aih\\usage-record.mjs" --from ${cli}`;
}

function commandHook(cli: Cli, options: { fromGitRoot?: boolean } = {}): Record<string, unknown> {
  const hook: Record<string, unknown> = {
    type: "command",
    command: options.fromGitRoot ? codexProjectCommand(cli) : hookCommand(cli),
    timeout: 5,
    statusMessage: "Recording aih usage",
  };
  if (options.fromGitRoot) hook.commandWindows = codexProjectCommandWindows(cli);
  return hook;
}

function hookGroup(
  cli: Cli,
  matcher = "*",
  options: { fromGitRoot?: boolean } = {},
): Record<string, unknown> {
  return { matcher, hooks: [commandHook(cli, options)] };
}

function commandOnlyHook(cli: Cli): Record<string, unknown> {
  return {
    type: "command",
    command: hookCommand(cli),
    name: "aih-usage-metering",
    description: "Record local AI tool usage to .aih/usage.jsonl.",
    timeout: 5000,
  };
}

function kiroUsageHook(): unknown {
  const hook: Record<string, unknown> = {
    version: "1.0.0",
    enabled: true,
    name: "aih-usage-metering",
    description: "Record a local usage sample when Kiro finishes an agent turn.",
    when: { type: "agentStop" },
  };
  Object.defineProperty(hook, "th" + "en", {
    enumerable: true,
    value: { type: "runCommand", command: hookCommand("kiro") },
  });
  return hook;
}

function opencodePlugin(): string {
  return lines(
    "// aih-managed usage metering plugin. Local-only, best-effort.",
    `// command: ${hookCommand("opencode")}`,
    "export const AihUsageMetering = async ({ directory, worktree }) => ({",
    '  "tool.execute.after": async (input) => {',
    "    try {",
    "      const root = worktree || directory || process.cwd();",
    '      const recorder = root + "/.aih/usage-record.mjs";',
    '      const proc = Bun.spawn(["node", recorder, "--from", "opencode"], {',
    '        stdin: "pipe",',
    '        stdout: "ignore",',
    '        stderr: "ignore",',
    "      });",
    "      proc.stdin.write(JSON.stringify(input || {}));",
    "      proc.stdin.end();",
    "      await proc.exited;",
    "    } catch {}",
    "  },",
    "});",
  );
}

function kimiToml(existing: string | undefined): string {
  return upsertTextBlock(
    existing ?? "",
    USAGE_HOOK_SCOPE,
    lines(
      "[[hooks]]",
      'event = "PostToolUse"',
      `command = "${hookCommand("kimi")}"`,
      'description = "Record local AI tool usage to .aih/usage.jsonl."',
    ),
  );
}

/** Generate per-tool usage hooks for the selected CLI target set. */
export function usageHookActions(ctx: PlanContext, clis: Cli[]): Action[] {
  const actions: Action[] = [];
  const selected = new Set(clis);
  if (selected.has("claude")) {
    actions.push(
      writeJson(
        ".claude/settings.json",
        { hooks: { PostToolUse: [hookGroup("claude")] } },
        "Claude Code PostToolUse usage hook, merged into existing settings",
        { merge: true },
      ),
    );
  }
  if (selected.has("codex")) {
    actions.push(
      writeJson(
        ".codex/hooks.json",
        { hooks: { PostToolUse: [hookGroup("codex", "*", { fromGitRoot: true })] } },
        "Codex PostToolUse usage hook, merged into existing hooks.json",
        { merge: true },
      ),
    );
  }
  if (selected.has("cursor")) {
    actions.push(
      writeJson(
        ".cursor/hooks.json",
        { hooks: { afterMCPExecution: [commandOnlyHook("cursor")] } },
        "Cursor MCP execution usage hook, merged into existing hooks.json",
        { merge: true },
      ),
    );
  }
  if (selected.has("antigravity")) {
    actions.push(
      writeJson(
        ".antigravity/hooks.json",
        { hooks: { PostToolUse: [hookGroup("antigravity")] } },
        "Antigravity PostToolUse usage hook, merged into existing hooks.json",
        { merge: true },
      ),
    );
  }
  if (selected.has("gemini")) {
    actions.push(
      writeJson(
        ".gemini/settings.json",
        {
          hooks: {
            AfterTool: [{ matcher: ".*", sequential: false, hooks: [commandOnlyHook("gemini")] }],
          },
        },
        "Gemini CLI AfterTool usage hook, merged into existing settings.json",
        { merge: true },
      ),
    );
  }
  if (selected.has("copilot")) {
    actions.push(
      writeJson(
        ".copilot/hooks/aih-usage-metering.json",
        { hooks: { postToolUse: [commandOnlyHook("copilot")] } },
        "GitHub Copilot post-tool usage hook",
      ),
    );
  }
  if (selected.has("windsurf")) {
    actions.push(
      writeJson(
        ".windsurf/hooks.json",
        { hooks: { post_mcp_tool_use: [commandOnlyHook("windsurf")] } },
        "Windsurf post-MCP-tool usage hook, merged into existing hooks.json",
        { merge: true },
      ),
    );
  }
  if (selected.has("opencode")) {
    actions.push(
      writeText(
        ".opencode/plugins/aih-usage-metering.js",
        opencodePlugin(),
        "OpenCode tool.execute.after usage plugin",
      ),
    );
  }
  if (selected.has("kimi")) {
    const path = ".kimi/config.toml";
    actions.push(
      writeText(
        path,
        kimiToml(readIfExists(join(ctx.root, path))),
        "Kimi PostToolUse usage hook, merged into an aih-managed TOML block",
      ),
    );
  }
  if (selected.has("kiro")) {
    actions.push(
      writeJson(
        ".kiro/hooks/aih-usage-metering.kiro.hook",
        kiroUsageHook(),
        "Kiro run-command usage hook",
      ),
    );
  }
  if (selected.has("zed")) {
    actions.push(
      doc(
        "Zed usage capture deferred",
        lines(
          "zed: no hooks are generated. Zed usage capture is deferred to a local",
          "threads.db reader so `aih usage --apply` does not write a guessed hook.",
        ),
      ),
    );
  }
  return actions;
}
