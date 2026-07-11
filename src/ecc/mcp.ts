import { join } from "node:path";
import { entry } from "../internals/cli-registry.js";
import type { Cli } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";
import type { Action, PlanContext } from "../internals/plan.js";
import { writeJson } from "../internals/plan.js";
import { isExternalMcp, mcpConfigAbs, mcpEntries } from "../mcp/render.js";
import { type McpServer, mcpServers } from "../mcp/servers.js";
import type { RepoStack } from "../profile/scan.js";
import type { EccComponentSelection, EccMcpComponentId } from "./components.js";
import type { ProjectRegistration } from "./registration.js";

const EMPTY_STACK: RepoStack = {
  languages: [],
  frameworks: [],
  cloud: [],
  databases: [],
  deployment: [],
  hasTypeScript: false,
  scripts: {},
  entryPoints: [],
  browserTest: false,
  isMonorepo: false,
};

function mcpName(component: EccMcpComponentId): string {
  return component.slice("mcp:".length);
}

export function selectedEccMcpServers(
  components: readonly EccMcpComponentId[],
): Record<string, McpServer> {
  const catalog = mcpServers("project", EMPTY_STACK, { githubIncumbent: true });
  const selected: Record<string, McpServer> = {};
  for (const component of components) {
    const name = mcpName(component);
    const server = catalog[name];
    if (server === undefined) throw new Error(`no validated MCP configuration for ${component}`);
    selected[name] = server;
  }
  return selected;
}

function existingJsonServerNames(path: string, key: string): Set<string> {
  const raw = readIfExists(path);
  if (raw === undefined) return new Set();
  const parsed = parseJsoncText(raw);
  if (!isPlainObject(parsed)) return new Set();
  const servers = parsed[key];
  return isPlainObject(servers) ? new Set(Object.keys(servers)) : new Set();
}

function componentsForPath(
  external: boolean,
  selection: EccComponentSelection,
  project: ProjectRegistration | undefined,
): readonly EccMcpComponentId[] {
  return external ? selection.mcps : (project?.mcps ?? selection.mcps);
}

export function scopedEccMcpJsonActions(
  ctx: PlanContext,
  clis: readonly Cli[],
  selection: EccComponentSelection,
  project: ProjectRegistration | undefined,
): Action[] {
  const home = ctx.env.HOME || ctx.env.USERPROFILE;
  const actions: Action[] = [];
  const written = new Set<string>();
  for (const cli of clis) {
    const config = entry(cli).mcp;
    if (
      config.support !== "native" ||
      config.configFormat !== "json" ||
      config.configPath === undefined ||
      config.configKey === undefined
    ) {
      continue;
    }
    const external = isExternalMcp(config.configPath);
    if (external && home === undefined) {
      throw new Error(`cannot resolve global MCP config for ${cli} without HOME or USERPROFILE`);
    }
    const path = external ? mcpConfigAbs(home as string, config.configPath) : config.configPath;
    if (written.has(path)) continue;
    written.add(path);
    const absolute = external ? path : join(ctx.root, path);
    const existing = existingJsonServerNames(absolute, config.configKey);
    const selected = selectedEccMcpServers(componentsForPath(external, selection, project));
    const fresh = Object.fromEntries(
      Object.entries(selected).filter(([name]) => !existing.has(name)),
    );
    if (Object.keys(fresh).length === 0) continue;
    actions.push(
      writeJson(
        path,
        { [config.configKey]: mcpEntries(cli, fresh) },
        `Register scoped ECC MCP servers for ${entry(cli).label}`,
        { merge: true, external },
      ),
    );
  }
  return actions;
}
