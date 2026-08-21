import {
  ECC_MCP_DISABLED,
  ECC_MCP_SELECTED,
  SERENA_ALLOWED_TOOLS,
} from "../ecc-profile/mcp-profile.js";
import { policyAuthoringMcpCatalog } from "./catalog.js";
import { ECC_MCP_CATALOG_IDS, eccExternalMcpCatalog } from "./ecc-mcp-catalog.js";

export const ADOPTION_RECIPE_ROUTES = [
  "workbench-row",
  "ecc-mcp-approval",
  "aih-ecc-profile-lifecycle",
  "none",
] as const;

export type AdoptionRecipeRoute = (typeof ADOPTION_RECIPE_ROUTES)[number];

export const ADOPTION_RECIPE_USAGE_SIGNALS = ["mcp-server-event", "none-captured"] as const;

export type AdoptionRecipeUsageSignal = (typeof ADOPTION_RECIPE_USAGE_SIGNALS)[number];

export interface AdoptionRecipeEccMcp {
  id: string;
  transport: "stdio" | "http";
  addability: "aih-owned" | "https-configurable" | "manual-localhost" | "manual-stdio";
}

export interface AdoptionRecipeSources {
  eccMcpSelected: string[];
  eccMcpDisabled: string[];
  serenaAllowedTools: string[];
  eccMcpCatalogIds: string[];
  eccMcpCatalog: AdoptionRecipeEccMcp[];
  coreMcpIds: string[];
}

export type AdoptionRecipeRouteSpec =
  | { kind: "workbench-row"; candidate: "code-review-graph" | "codebase-memory-mcp" }
  | { kind: "ecc-mcp-approval"; id: "token-optimizer"; addability: "manual-stdio" }
  | { kind: "aih-ecc-profile-lifecycle"; command: "aih ecc --lifecycle install" }
  | { kind: "none" };

export type AdoptionRecipePrerequisite =
  | "ECC profile lifecycle is installed"
  | "Reviewed Serena symbol/refactor tools"
  | "Existing AIH core catalog Workbench row"
  | "Explicit on-demand overhead audit"
  | "ECC MCP approval";

export type AdoptionRecipeConflict =
  | "The current ECC profile disables token-savior; it is not an MCP route"
  | "Memory, file, shell, project, and mode tools remain outside the reviewed route"
  | "One broad impact/reviewer query owner; no sibling route"
  | "Durable architectural memory stays on this existing row; no sibling route"
  | "manual-stdio only; no HTTPS Add route";

export interface AdoptionRecipeRole {
  id: "token-savior" | "serena" | "code-review-graph" | "codebase-memory-mcp" | "token-optimizer";
  questionClass:
    | "low-token-orientation"
    | "symbol-navigation-and-refactors"
    | "broad-impact-context"
    | "semantic-relationship-memory"
    | "on-demand-overhead-audit";
  label: string;
  guidance: string;
  prerequisites: AdoptionRecipePrerequisite[];
  conflicts: AdoptionRecipeConflict[];
  route: AdoptionRecipeRouteSpec;
  usage: { kind: "none-captured" } | { kind: "mcp-server-event"; serverId: string };
}

export interface AdoptionRecipe {
  roles: AdoptionRecipeRole[];
  sources: AdoptionRecipeSources;
}

const STABLE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SERENA_MINIMUM_TOOLS = [
  "get_symbols_overview",
  "find_symbol",
  "find_referencing_symbols",
  "find_implementations",
  "replace_symbol_body",
  "rename_symbol",
] as const;
const CORE_ROLE_IDS = ["code-review-graph", "codebase-memory-mcp"] as const;
const SERENA_FORBIDDEN_OVERLAP_CLASSES = [
  {
    name: "file",
    pattern: /^(?:read|write|edit|create|delete|list)_(?:file|files|directory|dir)$/,
  },
  { name: "shell", pattern: /(?:^|_)(?:shell|terminal|command|exec)(?:_|$)/ },
  { name: "memory", pattern: /(?:^|_)(?:memory|memories|recall)(?:_|$)/ },
  { name: "project", pattern: /^(?:switch|set|open|close)_project(?:_|$)/ },
  { name: "mode", pattern: /^(?:switch|set|open|close)_mode(?:_|$)/ },
] as const;

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireStableIds(
  values: readonly string[],
  label: string,
  ordinalRequired = false,
): string[] {
  const normalized = [...values];
  if (
    normalized.some((value) => !STABLE_ID.test(value)) ||
    new Set(normalized).size !== normalized.length ||
    (ordinalRequired &&
      normalized.some(
        (value, index) => index > 0 && ordinal(normalized[index - 1] ?? "", value) >= 0,
      ))
  ) {
    throw new Error(`${label} must be unique${ordinalRequired ? " ordinal" : ""} stable ids`);
  }
  return normalized;
}

function requireTools(values: readonly string[]): string[] {
  if (
    values.length === 0 ||
    values.some((value) => !/^[a-z][a-z0-9_]{0,127}$/.test(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("SERENA_ALLOWED_TOOLS must be a unique stable tool set");
  }
  return [...values];
}

function recipeSources(): AdoptionRecipeSources {
  return {
    eccMcpSelected: [...ECC_MCP_SELECTED],
    eccMcpDisabled: [...ECC_MCP_DISABLED],
    serenaAllowedTools: [...SERENA_ALLOWED_TOOLS],
    eccMcpCatalogIds: [...ECC_MCP_CATALOG_IDS],
    eccMcpCatalog: eccExternalMcpCatalog.map((entry) => ({
      id: entry.id,
      transport: entry.transport,
      addability: entry.addability,
    })),
    coreMcpIds: Object.keys(policyAuthoringMcpCatalog()).sort(ordinal),
  };
}

/**
 * Returns inert, code-owned adoption guidance. Unknown or drifted profile and
 * catalog input fails closed; it never creates a new row, selection, route, or
 * usage claim.
 */
export function buildAdoptionRecipe(
  input: AdoptionRecipeSources = recipeSources(),
): AdoptionRecipe {
  const eccMcpSelected = requireStableIds(input.eccMcpSelected, "ECC_MCP_SELECTED");
  const eccMcpDisabled = requireStableIds(input.eccMcpDisabled, "ECC_MCP_DISABLED");
  const serenaAllowedTools = requireTools(input.serenaAllowedTools);
  const eccMcpCatalogIds = requireStableIds(input.eccMcpCatalogIds, "ECC_MCP_CATALOG_IDS");
  const coreMcpIds = requireStableIds(input.coreMcpIds, "Core MCP catalog", true);
  const eccMcpCatalog = input.eccMcpCatalog.map((entry) => ({ ...entry }));
  if (
    eccMcpCatalog.some(
      (entry) =>
        !STABLE_ID.test(entry.id) ||
        !["stdio", "http"].includes(entry.transport) ||
        !["aih-owned", "https-configurable", "manual-localhost", "manual-stdio"].includes(
          entry.addability,
        ),
    ) ||
    new Set(eccMcpCatalog.map((entry) => entry.id)).size !== eccMcpCatalog.length
  ) {
    throw new Error("ECC MCP catalog must contain unique classified stable ids");
  }

  for (const id of ["serena", ...CORE_ROLE_IDS]) {
    if (!eccMcpSelected.includes(id)) {
      throw new Error(`adoption recipe source drift: ${id} is not selected by ECC`);
    }
  }
  if (!eccMcpDisabled.includes("token-savior")) {
    throw new Error("adoption recipe source drift: Token Savior is not disabled by ECC");
  }
  for (const tool of SERENA_MINIMUM_TOOLS) {
    if (!serenaAllowedTools.includes(tool)) {
      throw new Error(`adoption recipe source drift: Serena tool ${tool} is unavailable`);
    }
  }
  for (const { name, pattern } of SERENA_FORBIDDEN_OVERLAP_CLASSES) {
    const overlap = serenaAllowedTools.find((tool) => pattern.test(tool));
    if (overlap !== undefined) {
      throw new Error(
        `adoption recipe source drift: Serena forbidden ${name} overlap tool ${overlap}`,
      );
    }
  }
  for (const id of ["token-savior", "serena", ...CORE_ROLE_IDS]) {
    if (eccMcpSelected.includes(id) && eccMcpDisabled.includes(id)) {
      const label = id === "token-savior" ? "Token Savior" : id === "serena" ? "Serena" : id;
      throw new Error(`adoption recipe source conflict: ${label} appears in selected and disabled`);
    }
  }
  for (const id of CORE_ROLE_IDS) {
    if (!coreMcpIds.includes(id)) {
      throw new Error(`adoption recipe source drift: core MCP ${id} is unavailable`);
    }
  }
  const optimizer = eccMcpCatalog.find((entry) => entry.id === "token-optimizer");
  if (
    !eccMcpCatalogIds.includes("token-optimizer") ||
    optimizer?.transport !== "stdio" ||
    optimizer.addability !== "manual-stdio"
  ) {
    throw new Error("adoption recipe source drift: token-optimizer must remain manual-stdio");
  }

  const roles: AdoptionRecipeRole[] = [
    {
      id: "token-savior",
      questionClass: "low-token-orientation",
      label: "Token Savior",
      guidance: "Use for low-token orientation. No attributable usage signal is captured today.",
      prerequisites: ["ECC profile lifecycle is installed"],
      conflicts: ["The current ECC profile disables token-savior; it is not an MCP route"],
      route: { kind: "aih-ecc-profile-lifecycle", command: "aih ecc --lifecycle install" },
      usage: { kind: "none-captured" },
    },
    {
      id: "serena",
      questionClass: "symbol-navigation-and-refactors",
      label: "Serena",
      guidance: "Use for exact symbol navigation and refactors.",
      prerequisites: [
        "ECC profile lifecycle is installed",
        "Reviewed Serena symbol/refactor tools",
      ],
      conflicts: ["Memory, file, shell, project, and mode tools remain outside the reviewed route"],
      route: { kind: "aih-ecc-profile-lifecycle", command: "aih ecc --lifecycle install" },
      usage: { kind: "mcp-server-event", serverId: "serena" },
    },
    {
      id: "code-review-graph",
      questionClass: "broad-impact-context",
      label: "code-review-graph",
      guidance: "Use for one broad impact/reviewer query.",
      prerequisites: ["Existing AIH core catalog Workbench row"],
      conflicts: ["One broad impact/reviewer query owner; no sibling route"],
      route: { kind: "workbench-row", candidate: "code-review-graph" },
      usage: { kind: "mcp-server-event", serverId: "code-review-graph" },
    },
    {
      id: "codebase-memory-mcp",
      questionClass: "semantic-relationship-memory",
      label: "codebase-memory-mcp",
      guidance: "Use for semantic relationships and durable architectural memory.",
      prerequisites: ["Existing AIH core catalog Workbench row"],
      conflicts: ["Durable architectural memory stays on this existing row; no sibling route"],
      route: { kind: "workbench-row", candidate: "codebase-memory-mcp" },
      usage: { kind: "mcp-server-event", serverId: "codebase-memory-mcp" },
    },
    {
      id: "token-optimizer",
      questionClass: "on-demand-overhead-audit",
      label: "Token Optimizer",
      guidance: "Use only for an explicit on-demand overhead audit.",
      prerequisites: ["Explicit on-demand overhead audit", "ECC MCP approval"],
      conflicts: ["manual-stdio only; no HTTPS Add route"],
      route: { kind: "ecc-mcp-approval", id: "token-optimizer", addability: "manual-stdio" },
      usage: { kind: "mcp-server-event", serverId: "token-optimizer" },
    },
  ];

  if (new Set(roles.map((role) => role.questionClass)).size !== roles.length) {
    throw new Error("adoption recipe question classes must have one owner");
  }
  for (const role of roles) {
    if (role.usage.kind === "mcp-server-event") {
      const server = role.usage.serverId;
      const isCore = CORE_ROLE_IDS.includes(server as (typeof CORE_ROLE_IDS)[number]);
      const isSerena = server === "serena" && eccMcpSelected.includes(server);
      const isOptimizer =
        server === "token-optimizer" &&
        optimizer.transport === "stdio" &&
        optimizer.addability === "manual-stdio";
      if (!isCore && !isSerena && !isOptimizer) {
        throw new Error(`adoption recipe usage signal has unknown server ${server}`);
      }
    }
  }

  return {
    roles,
    sources: {
      eccMcpSelected,
      eccMcpDisabled,
      serenaAllowedTools,
      eccMcpCatalogIds,
      eccMcpCatalog,
      coreMcpIds,
    },
  };
}
