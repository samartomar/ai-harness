import { z } from "zod";

/**
 * The single typed source of truth for per-CLI facts the harness acts on:
 * detection signals, the native bootloader file(s), and MCP config location.
 *
 * Before this, the same 11-CLI key space was hand-maintained across three
 * parallel `Record<Cli, …>` tables (`SIGNALS` in cli-detect.ts, `CLI_BOOTLOADERS`
 * + the data half of `CLI_META` in bootstrap-ai/canon.ts) — three places to edit
 * when adding a tool. They now derive from this one validated table.
 *
 * Data model adapted from the @canonical/harnesses registry (LGPL-3.0 — shape and
 * the objective per-tool MCP facts only; no code copied) and the three-state
 * support vocabulary from RevealUI's DEGRADATION_TABLE (FSL-1.1-MIT — concept only).
 *
 * Scope note: aih is NOT an agent runtime, so runtime-orchestration fields
 * (dispatch / workboard / lifecycleEvents / memory backend) are deliberately
 * excluded — nothing here would consume them. Capability fields (hooks/sandbox
 * granularity, context window) are likewise omitted until a command reads them,
 * to avoid shipping researched-but-unverified numbers.
 */

/** Does the tool support a capability natively, can aih emit a fallback, or is it unavailable. */
const Support = z.enum(["native", "absent"]);

const McpProfile = z.object({
  support: Support,
  /** The file the client reads its MCP server map from (repo-relative or ~/home). */
  configPath: z.string().optional(),
  /** Top-level key holding the server map. */
  configKey: z.enum(["mcpServers", "mcp_servers", "mcp", "servers", "context_servers"]).optional(),
  configFormat: z.enum(["json", "toml"]).optional(),
  /**
   * True only when aih can deterministically WRITE this config: a project-relative
   * JSON file using the standard `mcpServers` shape aih already generates. When
   * false, aih emits guidance (the tool uses TOML, a global path, or a different
   * server shape) rather than writing a file it would get wrong.
   */
  writable: z.boolean(),
});

/**
 * A tool-native settings file aih manages (hooks / permissions / policy). Only a
 * few tools have one (Claude's `.claude/settings.json`); the field is optional, so
 * the per-CLI coverage matrix scores it as n/a for tools without one rather than
 * docking them for a file they don't use.
 */
const SettingsProfile = z.object({
  /** Repo-relative settings file. */
  configPath: z.string(),
  /** True when aih writes it directly (else it only emits guidance). */
  writable: z.boolean(),
});

const CliEntry = z.object({
  id: z.string(),
  label: z.string(),
  /** Home-relative config dirs that imply the tool is installed (detection). */
  configDirs: z.array(z.string()),
  /** Executable names to look for on PATH (detection). */
  binaries: z.array(z.string()),
  /** Root bootloader file(s) the tool auto-loads as system context every turn. */
  bootloaders: z.array(z.string()),
  mcp: McpProfile,
  /** Tool-native settings file aih manages, when the tool has one (else n/a). */
  settings: SettingsProfile.optional(),
  /**
   * Frontmatter a bootloader MUST carry to be ALWAYS-loaded (Cursor `.mdc` needs
   * `alwaysApply: true`; Kiro steering needs `inclusion: always`). Absent → the
   * tool's bootloader is inherently always-on and needs no activation key.
   */
  activation: z.object({ key: z.string(), value: z.string() }).optional(),
  /**
   * Hard character cap on the always-loaded bundle, when the tool documents one.
   * Unset for every tool today (no reliable per-bootloader cap), so the loadability
   * size check is a no-op until a real number is known — never a guessed verdict.
   */
  contextCap: z.number().int().positive().optional(),
});
export type CliEntry = z.infer<typeof CliEntry>;

/**
 * The registry, in canonical order (detection, reports, and the --detect fallback
 * notice all depend on this ordering — keep it stable). MCP facts are objective
 * per-tool documentation values; `writable` is conservative — only the tools whose
 * project config is plain `mcpServers` JSON (Claude's de-facto standard shape) are
 * written, everyone else gets guidance.
 */
const RAW: Record<string, z.input<typeof CliEntry>> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    configDirs: [".claude"],
    binaries: ["claude"],
    bootloaders: ["CLAUDE.md"],
    mcp: {
      support: "native",
      configPath: ".mcp.json",
      configKey: "mcpServers",
      configFormat: "json",
      writable: true,
    },
    settings: { configPath: ".claude/settings.json", writable: true },
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    configDirs: [".codex"],
    binaries: ["codex"],
    bootloaders: ["AGENTS.md"],
    // Codex reads MCP servers from ~/.codex/config.toml as [mcp_servers.<name>] (TOML, global).
    mcp: {
      support: "native",
      configPath: "~/.codex/config.toml",
      configKey: "mcp_servers",
      configFormat: "toml",
      writable: false,
    },
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    configDirs: [".cursor"],
    binaries: ["cursor"],
    bootloaders: [".cursor/rules/00-canon.mdc"],
    mcp: {
      support: "native",
      configPath: ".cursor/mcp.json",
      configKey: "mcpServers",
      configFormat: "json",
      writable: true,
    },
    activation: { key: "alwaysApply", value: "true" },
  },
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    configDirs: [".gemini/antigravity", ".antigravity", ".config/antigravity"],
    binaries: ["agy", "antigravity"],
    bootloaders: ["AGENTS.md", "GEMINI.md"],
    mcp: {
      support: "native",
      configPath: "~/.antigravity/mcp.json",
      configKey: "mcpServers",
      configFormat: "json",
      writable: false,
    },
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    configDirs: [".gemini"],
    binaries: ["gemini"],
    bootloaders: ["GEMINI.md"],
    // Gemini reads ~/.gemini/settings.json (global, many keys) — guide, don't write.
    mcp: {
      support: "native",
      configPath: "~/.gemini/settings.json",
      configKey: "mcpServers",
      configFormat: "json",
      writable: false,
    },
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    configDirs: [".config/github-copilot", ".copilot"],
    binaries: ["copilot"],
    bootloaders: [".github/copilot-instructions.md"],
    // VS Code reads .vscode/mcp.json under a `servers` key (different shape) — guide.
    mcp: {
      support: "native",
      configPath: ".vscode/mcp.json",
      configKey: "servers",
      configFormat: "json",
      writable: false,
    },
  },
  windsurf: {
    id: "windsurf",
    label: "Windsurf",
    configDirs: [".codeium/windsurf", ".windsurf"],
    binaries: ["windsurf"],
    bootloaders: [".windsurfrules"],
    mcp: {
      support: "native",
      configPath: "~/.codeium/windsurf/mcp_config.json",
      configKey: "mcpServers",
      configFormat: "json",
      writable: false,
    },
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    configDirs: [".config/opencode", ".opencode"],
    binaries: ["opencode"],
    bootloaders: ["AGENTS.md"],
    // OpenCode's opencode.json uses an `mcp` key with a different server shape — guide.
    mcp: {
      support: "native",
      configPath: "opencode.json",
      configKey: "mcp",
      configFormat: "json",
      writable: false,
    },
  },
  zed: {
    id: "zed",
    label: "Zed",
    configDirs: [".config/zed", ".zed"],
    binaries: ["zed"],
    bootloaders: ["AGENTS.md"],
    // Zed settings.json uses `context_servers` with a different shape — guide.
    mcp: {
      support: "native",
      configPath: "~/.config/zed/settings.json",
      configKey: "context_servers",
      configFormat: "json",
      writable: false,
    },
  },
  kimi: {
    id: "kimi",
    label: "Kimi CLI",
    configDirs: [".kimi", ".config/kimi"],
    binaries: ["kimi"],
    bootloaders: ["AGENTS.md"],
    mcp: {
      support: "native",
      configPath: ".mcp.json",
      configKey: "mcpServers",
      configFormat: "json",
      writable: true,
    },
  },
  kiro: {
    id: "kiro",
    label: "Kiro",
    configDirs: [".kiro"],
    binaries: ["kiro"],
    bootloaders: [".kiro/steering/00-canon.md"],
    mcp: {
      support: "native",
      configPath: ".kiro/settings/mcp.json",
      configKey: "mcpServers",
      configFormat: "json",
      writable: true,
    },
    activation: { key: "inclusion", value: "always" },
  },
};

/** The registry, validated once at load — a malformed future edit fails the suite, not prod. */
export const CLI_REGISTRY: Record<string, CliEntry> = z.record(z.string(), CliEntry).parse(RAW);

/** The CLI ids in canonical order (the single source `SUPPORTED_CLIS` derives from). */
export const REGISTRY_IDS = Object.keys(CLI_REGISTRY);

/** One CLI's full registry entry. */
export function entry(cli: string): CliEntry {
  const e = CLI_REGISTRY[cli];
  if (!e) throw new Error(`unknown CLI: ${cli}`);
  return e;
}

/** The deduped, order-stable set of bootloader files for a CLI selection. */
export function bootloadersFor(clis: readonly string[]): string[] {
  const seen: string[] = [];
  for (const cli of clis) {
    for (const p of entry(cli).bootloaders) if (!seen.includes(p)) seen.push(p);
  }
  return seen;
}
