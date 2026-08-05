import { createHash } from "node:crypto";
import { baselineCatalogById } from "../baseline-evidence/catalogs.js";
import { mcpApprovalSubject } from "../mcp/policy.js";
import { type McpServer, mcpServers } from "../mcp/servers.js";
import { usageRecorderScript } from "../usage/capture.js";

/**
 * The no-repository authoring projection deliberately uses the same pure MCP
 * constructor as runtime policy resolution, with an empty stack. Stack-derived
 * servers stay out of this generic catalog until an admin imports audit facts.
 */
const EMPTY_REPO_STACK = {
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
  virtualEnvPaths: [],
};

export interface AihPolicyControl {
  id: string;
  kind: "mcp" | "hook";
  source:
    | { type: "mcp"; server: string; subject: string }
    | { type: "hook"; handler: "usage-metering"; scriptDigest: string };
  targets: ("claude" | "codex")[];
  projector: "mcp-managed-settings" | "usage-hook";
  lifecycle: "supported";
}

/**
 * Every namespace the pinned baseline catalogs use as a component-id prefix.
 * This is the inventory's own vocabulary. It is deliberately not the three-kind
 * `governance.externalCuration` grammar in `schema.ts`: that one is a policy
 * document format, this one describes what a framework actually contains.
 */
export const POLICY_AUTHORING_ASSET_KINDS = [
  "agent",
  "baseline",
  "capability",
  "framework",
  "lang",
  "mcp",
  "module",
  "runtime",
  "skill",
] as const;

export type PolicyAuthoringAssetKind = (typeof POLICY_AUTHORING_ASSET_KINDS)[number];

export interface PolicyAuthoringAsset {
  kind: PolicyAuthoringAssetKind;
  id: string;
  /**
   * Set only when the asset is expressible as an external-curation item, and
   * carrying that schema's kind rather than this one's. Absent means the item
   * stays visible as inventory but cannot be authored into `externalCuration`.
   */
  curationKind?: "agent" | "skill" | "command";
  source: { repository: string; commit: string; path: string };
}

export interface PolicyAuthoringFramework {
  id: "ecc" | "superpowers";
  repository: string;
  commit: string;
  assets: PolicyAuthoringAsset[];
}

export interface PolicyAuthoringCatalog {
  mcp: Array<{ id: string; description: string; server: McpServer; control: AihPolicyControl }>;
  hooks: AihPolicyControl[];
  frameworks: PolicyAuthoringFramework[];
}

export function policyAuthoringMcpCatalog(): Record<string, McpServer> {
  return mcpServers("project", EMPTY_REPO_STACK);
}

function usageMeteringControl(): AihPolicyControl {
  const scriptDigest = `sha256:${createHash("sha256")
    .update(usageRecorderScript(), "utf8")
    .digest("hex")}`;
  return {
    id: "usage-metering",
    kind: "hook",
    source: { type: "hook", handler: "usage-metering", scriptDigest },
    targets: ["claude", "codex"],
    projector: "usage-hook",
    lifecycle: "supported",
  };
}

/** Shared, runtime-independent AIH control identities for the engine and Studio. */
export function aihPolicyControls(
  catalog: Record<string, McpServer> = policyAuthoringMcpCatalog(),
): AihPolicyControl[] {
  return [
    ...Object.entries(catalog).map(([id, server]) => ({
      id,
      kind: "mcp" as const,
      source: { type: "mcp" as const, server: id, subject: mcpApprovalSubject(server) },
      targets: ["claude"] as ("claude" | "codex")[],
      projector: "mcp-managed-settings" as const,
      lifecycle: "supported" as const,
    })),
    usageMeteringControl(),
  ];
}

function assetKind(id: string): PolicyAuthoringAssetKind {
  const prefix = id.slice(0, id.indexOf(":"));
  const kind = POLICY_AUTHORING_ASSET_KINDS.find((candidate) => candidate === prefix);
  // Failing closed keeps the boundary honest: a new prefix must be named here
  // before it can ship, rather than disappearing from the administrator's view.
  if (kind === undefined) throw new Error(`baseline component ${id} has an unknown id namespace`);
  return kind;
}

function curationKind(id: string): PolicyAuthoringAsset["curationKind"] {
  if (id.startsWith("agent:")) return "agent";
  if (id.startsWith("skill:")) return "skill";
  if (id === "baseline:commands" || id === "module:commands-core") return "command";
  return undefined;
}

function frameworkCatalog(id: "ecc" | "superpowers"): PolicyAuthoringFramework {
  const catalog = baselineCatalogById(id);
  return {
    id,
    repository: `${catalog.owner}/${catalog.repo}`,
    commit: catalog.pinnedSha,
    assets: catalog.components.map((component) => {
      const path = component.paths[0];
      if (path === undefined)
        throw new Error(`baseline component ${component.id} declares no path`);
      const curation = curationKind(component.id);
      return {
        kind: assetKind(component.id),
        id: component.id,
        ...(curation === undefined ? {} : { curationKind: curation }),
        source: {
          repository: `${catalog.owner}/${catalog.repo}`,
          commit: catalog.pinnedSha,
          path,
        },
      };
    }),
  };
}

/**
 * Serializable, source-controlled authoring data. It is derived directly from
 * the existing pinned MCP and baseline catalog constructors, never copied.
 */
export function policyAuthoringCatalog(): PolicyAuthoringCatalog {
  const mcp = policyAuthoringMcpCatalog();
  const controls = aihPolicyControls(mcp);
  return {
    mcp: Object.entries(mcp).flatMap(([id, server]) => {
      const control = controls.find((candidate) => candidate.id === id);
      return control === undefined
        ? []
        : [{ id, description: server.description, server, control }];
    }),
    hooks: controls.filter((control) => control.kind === "hook"),
    frameworks: [frameworkCatalog("ecc"), frameworkCatalog("superpowers")],
  };
}
