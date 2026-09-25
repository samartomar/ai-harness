import { createHash } from "node:crypto";
import { loadCatalogAuthoringBundleV1 } from "../catalog-package/authoring-bundle.js";
import {
  CLI_REGISTRY,
  GOVERNED_MCP_TARGETS,
  GOVERNED_USAGE_TARGETS,
  REGISTRY_IDS,
} from "../internals/cli-registry.js";
import { npxLaunchPins } from "../mcp/pins.js";
import { mcpApprovalSubject } from "../mcp/policy.js";
import { type McpServer, mcpServers } from "../mcp/servers.js";
import { usageRecorderScript } from "../usage/capture.js";
import type {
  AihCatalogSourceV1,
  AihPolicyControl,
  PolicyAuthoringComposition,
  PolicyAuthoringFramework,
  PolicyAuthoringHook,
} from "./catalog-provider-types.js";
import type { ECC_HOOK_PROFILES, EccHookControlCatalogEntry } from "./ecc-hook-controls.js";
import type { EccMcpCatalogEntry } from "./ecc-mcp-catalog.js";
import type {
  AIH_OWNED_ECC_MCP_EXCLUSIONS,
  ECC_MCP_CATALOG_PROVENANCE,
} from "./ecc-mcp-contract.js";
import type { ECC_SKILL_CATALOG_PROVENANCE, EccSkillCatalogEntry } from "./ecc-skill-catalog.js";
import type { HookRegistration, hookOverlaps, hookSpawnProjection } from "./hook-registrar.js";

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

export type {
  AihCatalogSourceV1,
  AihHookBehaviour,
  AihHookControl,
  AihPolicyControl,
  PolicyAuthoringAsset,
  PolicyAuthoringAssetKind,
  PolicyAuthoringComposition,
  PolicyAuthoringCompositionPart,
  PolicyAuthoringFramework,
  PolicyAuthoringHook,
  PolicyAuthoringVet,
  PolicyAuthoringVetFinding,
} from "./catalog-provider-types.js";
export { POLICY_AUTHORING_ASSET_KINDS } from "./catalog-provider-types.js";
/**
 * Every AI CLI this build knows, and whether an org policy can project onto it.
 * Host recognition and projection capabilities are separate: a known host may
 * have no governed projector, and hook targets remain narrower than MCP targets.
 */
export interface PolicyAuthoringHost {
  id: string;
  label: string;
  /** True when an org-policy activation can name this host as a target. */
  policyTarget: boolean;
  mcpSupport: string;
}

export function policyAuthoringHosts(): PolicyAuthoringHost[] {
  const targets = new Set<string>(GOVERNED_MCP_TARGETS);
  return REGISTRY_IDS.map((id) => {
    const cli = CLI_REGISTRY[id];
    if (cli === undefined) throw new Error(`cli registry is missing ${id}`);
    return {
      id,
      label: cli.label,
      policyTarget: targets.has(id),
      mcpSupport: cli.mcp?.support ?? "none",
    };
  });
}

/**
 * One row of the hook registrar's inventory. AIH-owned handlers and third-party
 * hooks appear here together: AIH registers every entry, so an administrator who
 * cannot see both halves cannot see what the destination will contain.
 */
export interface PolicyAuthoringHookRegistryEntry {
  id: string;
  owner: "aih" | "third-party";
  /**
   * The TRUE owner as the workbench ticker names it ("AIH", "ECC",
   * "Superpowers"). Every registrar-related row files under this label; a row
   * under the wrong owner or missing from the tally is a product failure.
   */
  ownerLabel: string;
  /** Where the behaviour comes from — repository@commit path, or AIH itself. */
  source: string;
  description: string;
  /**
   * Whether an AIH-owned gate actually governs this item at run time. A
   * third-party hook is `not-aih-enforced` because ECC installs and runs it —
   * that is a LABEL, never a statement that AIH withheld or blocked it.
   */
  enforcement: "aih-enforced" | "not-aih-enforced";
  /** Always true: absence of AIH enforcement never disables authoring. */
  selectable: true;
}

/**
 * A gating control a third-party source declares for its own hooks. AIH records
 * that it exists and never implements, mirrors, or overrides it.
 */
export interface PolicyAuthoringHookControl {
  name: string;
  owner: string;
  enforcedByAih: false;
  detail: string;
}

export interface PolicyAuthoringHookRegistry {
  entries: PolicyAuthoringHookRegistryEntry[];
  declaredControls: PolicyAuthoringHookControl[];
  /** The registrations this artifact can price — AIH's own, plus any authored. */
  registrations: HookRegistration[];
  overlaps: ReturnType<typeof hookOverlaps>;
  /** Usage metering, never a cost model: entries and process spawns per event. */
  spawnProjection: ReturnType<typeof hookSpawnProjection>;
}

export interface PolicyAuthoringCatalog extends AihCatalogSourceV1 {
  mcp: Array<{
    id: string;
    description: string;
    server: McpServer;
    control: AihPolicyControl;
    availability: "always" | "web-target";
  }>;
  /** AIH-owned runtime identities the managed stdio projector cannot own. */
  nonProjectableMcp: Array<{
    id: string;
    description: string;
    server: McpServer;
    transport: string;
    reason: string;
  }>;
  /** AIH-owned runtime identities withheld from AIH control until AIH evidence exists. */
  unavailableMcp: Array<{
    id: string;
    description: string;
    server: McpServer;
    configuredIdentity: string;
    transport: string;
    reason: string;
  }>;
  /** Pinned order the Workbench sorts `governance.aihMcpRequests` into. */
  aihMcpRequestIds: typeof AIH_OWNED_ECC_MCP_EXCLUSIONS;
  /** Complete source-locked MCP availability inventory, including AIH-owned declarations. */
  eccMcpInventory: readonly EccMcpCatalogEntry[];
  externalMcp: readonly EccMcpCatalogEntry[];
  eccMcpProvenance: typeof ECC_MCP_CATALOG_PROVENANCE;
  /** Complete source-locked ECC Skill inventory represented by exact policy assets. */
  eccSkills: readonly EccSkillCatalogEntry[];
  eccSkillsProvenance: typeof ECC_SKILL_CATALOG_PROVENANCE;
  /** Digest paired with externalMcp when authoring an exact declarative ECC approval. */
  eccMcpApproval: { sourceContentSha256: string };
  eccHookControls: {
    sourceContentSha256: string;
    profiles: typeof ECC_HOOK_PROFILES;
    hooks: readonly EccHookControlCatalogEntry[];
    disabledHooks: {
      availability: "supported";
      detail: string;
      eligibleIds: readonly string[];
    };
  };
  hooks: PolicyAuthoringHook[];
  hookRegistry: PolicyAuthoringHookRegistry;
  frameworks: PolicyAuthoringFramework[];
  enterpriseComposition: PolicyAuthoringComposition;
  hosts: PolicyAuthoringHost[];
}

export function policyAuthoringMcpCatalog(): Record<string, McpServer> {
  const generic = mcpServers("project", EMPTY_REPO_STACK);
  return generic;
}

/**
 * The gate is read from AIH's own runtime catalog, never inferred from an
 * identity's absence in the projectable set: an id whose AIH runtime transport
 * is not stdio cannot be owned by the managed stdio projector.
 */
export function policyAuthoringNonProjectableMcpCatalog(
  catalog: Record<string, McpServer>,
): PolicyAuthoringCatalog["nonProjectableMcp"] {
  return Object.entries(catalog).flatMap(([id, server]) =>
    server.type === "stdio"
      ? []
      : [
          {
            id,
            description: server.description,
            server,
            transport: server.type,
            reason:
              `Not policy-projectable: AIH's runtime identity for this id uses the ${server.type} transport ` +
              "and the managed stdio projector cannot own it. Selecting it records requested intent only.",
          },
        ],
  );
}

export function policyAuthoringUnavailableMcpCatalog(): PolicyAuthoringCatalog["unavailableMcp"] {
  const web = mcpServers("project", {
    ...EMPTY_REPO_STACK,
    frameworks: ["React"],
  });
  const playwright = web.playwright;
  if (playwright?.type !== "stdio" || playwright.command !== "npx") {
    throw new Error("AIH's MCP catalog is missing the Playwright npm launcher");
  }
  const pins = npxLaunchPins(playwright.args);
  const pin = pins[0];
  if (pins.length !== 1 || pin?.packageName !== "@playwright/mcp")
    throw new Error("AIH's MCP catalog is missing the exact Playwright package pin");
  const configuredIdentity = pin.spec;
  return [
    {
      id: "playwright",
      description: playwright.description,
      server: playwright,
      configuredIdentity,
      transport: playwright.type,
      reason:
        `Unavailable as an AIH control: AIH has no current protected Scanner evidence record for ${configuredIdentity}. ` +
        "This is an AIH-owned evidence gap; an administrator cannot waive it or manufacture organization approval for it.",
    },
  ];
}

function usageMeteringControl(): AihPolicyControl {
  const scriptDigest = `sha256:${createHash("sha256")
    .update(usageRecorderScript(), "utf8")
    .digest("hex")}`;
  return {
    id: "usage-metering",
    kind: "hook",
    source: { type: "hook", handler: "usage-metering", scriptDigest },
    targets: [...GOVERNED_USAGE_TARGETS],
    projector: "usage-hook",
    lifecycle: "supported",
  };
}

/** Shared, runtime-independent AIH control identities for the engine and Studio. */
export function aihPolicyControls(
  catalog: Record<string, McpServer> = policyAuthoringMcpCatalog(),
): AihPolicyControl[] {
  const unavailableMcpIds = new Set(
    policyAuthoringUnavailableMcpCatalog().map((entry) => entry.id),
  );
  return [
    ...Object.entries(catalog).flatMap(([id, server]) =>
      server.type !== "stdio" || unavailableMcpIds.has(id)
        ? []
        : [
            {
              id,
              kind: "mcp" as const,
              source: {
                type: "mcp" as const,
                server: id,
                subject: mcpApprovalSubject(server),
              },
              targets: [...GOVERNED_MCP_TARGETS].sort(),
              projector: "mcp-managed-settings" as const,
              lifecycle: "supported" as const,
            },
          ],
    ),
    usageMeteringControl(),
  ];
}

/**
 * Catalog owns the serializable authoring data. Core admits its exact authority
 * payload and returns a detached view; it never reconstructs Catalog content.
 */
export function policyAuthoringCatalog(): PolicyAuthoringCatalog {
  return loadCatalogAuthoringBundleV1().prepared.catalog;
}
