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
export const SUPPORT_LEVELS = ["native", "fallback", "absent"] as const;
const Support = z.enum(SUPPORT_LEVELS);

const McpProfile = z.object({
  /**
   * aih's MCP integration level for this tool:
   *  - `native`   — aih deterministically WRITES the config, rendering the canonical
   *                 server map into the tool's exact on-disk shape (JSON or TOML, a
   *                 repo-relative OR `~/home` path), merge-preserving the user's other
   *                 settings. The per-tool shape transforms live in `mcp/render.ts`.
   *  - `fallback` — aih cannot yet render this tool's shape correctly, so it emits
   *                 exact guidance rather than a file it would get wrong.
   *  - `absent`   — the tool exposes no MCP server config at all.
   */
  support: Support,
  /** The file the client reads its MCP server map from (repo-relative or ~/home). */
  configPath: z.string().optional(),
  /** Top-level key holding the server map. */
  configKey: z.enum(["mcpServers", "mcp_servers", "mcp", "servers", "context_servers"]).optional(),
  configFormat: z.enum(["json", "toml"]).optional(),
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
  /** Home-relative machine-level skill discovery dir, when the tool has one aih can sync. */
  machineSkillDir: z.string().optional(),
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
 * per-tool documentation values; `support` is conservative — only the tools whose
 * project config is plain `mcpServers` JSON (Claude's de-facto standard shape) are
 * `native` (aih writes them); everyone else is `fallback` (aih emits guidance).
 */
const RAW: Record<string, z.input<typeof CliEntry>> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    configDirs: [".claude"],
    binaries: ["claude"],
    bootloaders: ["CLAUDE.md"],
    machineSkillDir: ".claude/skills",
    mcp: {
      support: "native",
      configPath: ".mcp.json",
      configKey: "mcpServers",
      configFormat: "json",
    },
    settings: { configPath: ".claude/settings.json", writable: true },
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    configDirs: [".codex"],
    binaries: ["codex"],
    bootloaders: ["AGENTS.md"],
    machineSkillDir: ".codex/skills",
    // Codex reads MCP servers from ~/.codex/config.toml as [mcp_servers.<name>] (TOML, global).
    // aih writes them as an aih-managed block (mcp/render.ts), preserving the rest of the file.
    mcp: {
      support: "native",
      configPath: "~/.codex/config.toml",
      configKey: "mcp_servers",
      configFormat: "toml",
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
    },
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    configDirs: [".gemini"],
    binaries: ["gemini"],
    bootloaders: ["GEMINI.md"],
    // Gemini reads ~/.gemini/settings.json (global, many keys); aih merge-writes only
    // the mcpServers key (httpUrl for http), preserving every other setting.
    mcp: {
      support: "native",
      configPath: "~/.gemini/settings.json",
      configKey: "mcpServers",
      configFormat: "json",
    },
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    configDirs: [".config/github-copilot", ".copilot"],
    binaries: ["copilot"],
    bootloaders: [".github/copilot-instructions.md"],
    // VS Code reads .vscode/mcp.json under a `servers` key ({type, command, args}).
    mcp: {
      support: "native",
      configPath: ".vscode/mcp.json",
      configKey: "servers",
      configFormat: "json",
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
    },
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    configDirs: [".config/opencode", ".opencode"],
    binaries: ["opencode"],
    bootloaders: ["AGENTS.md"],
    // OpenCode's global opencode.json uses an `mcp` key:
    // {type:"local", command:[cmd,...args], enabled}. Preserve providers/models.
    mcp: {
      support: "native",
      configPath: "~/.config/opencode/opencode.json",
      configKey: "mcp",
      configFormat: "json",
    },
  },
  zed: {
    id: "zed",
    label: "Zed",
    configDirs: [".config/zed", ".zed"],
    binaries: ["zed"],
    bootloaders: ["AGENTS.md"],
    // Zed settings.json uses `context_servers` ({command, args}); aih merge-writes that key.
    mcp: {
      support: "native",
      configPath: "~/.config/zed/settings.json",
      configKey: "context_servers",
      configFormat: "json",
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
