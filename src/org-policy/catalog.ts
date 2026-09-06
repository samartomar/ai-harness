import { createHash } from "node:crypto";
import { eccBaselineCatalogV1 } from "../baseline-evidence/catalog-providers/ecc.js";
import { superpowersBaselineCatalogV1 } from "../baseline-evidence/catalog-providers/superpowers.js";
import { readVendorBaselineLock } from "../baseline-evidence/vendor.js";
import { CLI_REGISTRY, REGISTRY_IDS } from "../internals/cli-registry.js";
import { mcpApprovalSubject } from "../mcp/policy.js";
import { type McpServer, mcpServers } from "../mcp/servers.js";
import { usageRecorderScript } from "../usage/capture.js";
import { claudeUsageHookCommand } from "../usage/hooks.js";
import { PACKAGE_NAME, VERSION } from "../version.js";
import type {
  AihCatalogSourceV1,
  AihHookBehaviour,
  AihHookControl,
  AihPolicyControl,
  PolicyAuthoringComposition,
  PolicyAuthoringFramework,
  PolicyAuthoringHook,
} from "./catalog-provider-types.js";
import { prepareAihCatalogSourceV1 } from "./catalog-providers/aih.js";
import { eccEnterpriseCompositionV1, prepareEccCatalogSourceV1 } from "./catalog-providers/ecc.js";
import { prepareSuperpowersCatalogSourceV1 } from "./catalog-providers/superpowers.js";
import {
  ECC_DISABLE_ELIGIBLE_HOOK_IDS,
  ECC_HOOK_CONTROL_SOURCE_CONTENT_SHA256,
  ECC_HOOK_PROFILES,
  type EccHookControlCatalogEntry,
  eccHookControlCatalog,
} from "./ecc-hook-controls.js";
import {
  AIH_OWNED_ECC_MCP_EXCLUSIONS,
  ECC_MCP_CATALOG_PROVENANCE,
  type EccMcpCatalogEntry,
  eccExternalMcpCatalog,
  eccMcpCatalogInventory,
} from "./ecc-mcp-catalog.js";
import {
  ECC_SKILL_CATALOG_PROVENANCE,
  type EccSkillCatalogEntry,
  eccSkillCatalogInventory,
} from "./ecc-skill-catalog.js";
import { type HookRegistration, hookOverlaps, hookSpawnProjection } from "./hook-registrar.js";

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
 * AIH's registry carries eleven; `PolicyTargetSchema` carries three. Stating that
 * asymmetry is the point: an administrator who sees only Claude, Codex, and Kiro has
 * no way to tell whether the others are unknown or merely unprojectable.
 */
export interface PolicyAuthoringHost {
  id: string;
  label: string;
  /** True when an org-policy activation can name this host as a target. */
  policyTarget: boolean;
  mcpSupport: string;
}

export function policyAuthoringHosts(): PolicyAuthoringHost[] {
  const targets = new Set(["claude", "codex", "kiro"]);
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
    transport: string;
    reason: string;
  }>;
  /** AIH-owned runtime identities withheld from AIH control until AIH evidence exists. */
  unavailableMcp: Array<{
    id: string;
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
function policyAuthoringNonProjectableMcpCatalog(
  catalog: Record<string, McpServer>,
): PolicyAuthoringCatalog["nonProjectableMcp"] {
  return Object.entries(catalog).flatMap(([id, server]) =>
    server.type === "stdio"
      ? []
      : [
          {
            id,
            transport: server.type,
            reason:
              `Not policy-projectable: AIH's runtime identity for this id uses the ${server.type} transport ` +
              "and the managed stdio projector cannot own it. Selecting it records requested intent only.",
          },
        ],
  );
}

function policyAuthoringUnavailableMcpCatalog(): PolicyAuthoringCatalog["unavailableMcp"] {
  const web = mcpServers("project", {
    ...EMPTY_REPO_STACK,
    frameworks: ["React"],
  });
  const playwright = web.playwright;
  if (
    playwright?.type !== "stdio" ||
    playwright.args.length !== 1 ||
    playwright.args[0] === undefined
  ) {
    throw new Error("AIH's web MCP catalog is missing Playwright");
  }
  const configuredIdentity = playwright.args[0];
  return [
    {
      id: "playwright",
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
    targets: ["claude", "codex"],
    projector: "usage-hook",
    lifecycle: "supported",
  };
}

/**
 * Every AIH-owned hook must state what it does before it can ship into the
 * authoring surface. Keyed by control id so a new hook fails closed here rather
 * than reaching an administrator as a bare identity.
 */
const AIH_HOOK_DISCLOSURES: Record<string, { description: string; behaviour: AihHookBehaviour }> = {
  "usage-metering": {
    description:
      "Appends one usage event per tool call so `aih track` can report this repository's agent activity.",
    behaviour: {
      trigger: "PostToolUse",
      records:
        "one JSON event per tool call — timestamp, CLI, kind (tool, mcp, skill or subagent), name, and a best-effort source",
      artifact: ".aih/usage.jsonl",
      failureMode: "Best-effort: a failure never blocks a commit or an agent turn",
    },
  },
};

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
              targets: ["claude", "kiro"] as ("claude" | "kiro")[],
              projector: "mcp-managed-settings" as const,
              lifecycle: "supported" as const,
            },
          ],
    ),
    usageMeteringControl(),
  ];
}

/**
 * Components a third-party source ships to register its own hooks. These are the
 * ids AIH's pinned catalog actually carries. AIH deliberately does NOT ship a
 * per-hook registration table for them: it has no pinned evidence for one, and
 * naming individual hooks its own inventory does not contain would be a claim
 * the inventory denies.
 */
const THIRD_PARTY_HOOK_COMPONENT_IDS = ["baseline:hooks", "module:hooks-runtime"] as const;

/**
 * Gating controls third-party sources declare for their own hooks. AIH authors
 * only their supported client environment intent; ECC remains the executor.
 *
 * The `detail` on each is the one operational fact an administrator cannot infer
 * from the name: these are evaluated INSIDE the source's launcher, so a hook the
 * control reports as off has already cost an operating-system process by the
 * time the control is read.
 */
const DECLARED_THIRD_PARTY_HOOK_CONTROLS: PolicyAuthoringHookControl[] = [
  {
    name: "ECC_HOOK_PROFILE",
    owner: "ecc",
    enforcedByAih: false,
    detail:
      "AIH projects the selected profile through supported Claude settings environment intent. ECC executes and enforces it; AIH never rewrites ECC hook commands.",
  },
  {
    name: "ECC_DISABLED_HOOKS",
    owner: "ecc",
    enforcedByAih: false,
    detail:
      "AIH projects the disabled list through supported Claude settings environment intent. ECC evaluates it after process spawn, so a disabled hook still spawns one process and disabling does not erase spawn cost.",
  },
];

/** AIH's own registrations, priced from the launcher that actually ships. */
function aihHookRegistrations(): HookRegistration[] {
  const command = claudeUsageHookCommand();
  return [
    {
      id: "usage-metering",
      event: "PostToolUse",
      command,
      functionTags: ["usage-metering"],
      // One process: AIH registers one composite entry per event.
      spawns: 1,
      owner: { kind: "aih" },
    },
  ];
}

function hookRegistry(
  frameworks: readonly PolicyAuthoringFramework[],
): PolicyAuthoringHookRegistry {
  const entries: PolicyAuthoringHookRegistryEntry[] = Object.entries(AIH_HOOK_DISCLOSURES).map(
    ([id, disclosure]) => ({
      id,
      owner: "aih" as const,
      ownerLabel: "AIH",
      source: "AIH",
      description: disclosure.description,
      enforcement: "aih-enforced" as const,
      selectable: true as const,
    }),
  );
  for (const framework of frameworks) {
    for (const asset of framework.assets) {
      if (!(THIRD_PARTY_HOOK_COMPONENT_IDS as readonly string[]).includes(asset.id)) continue;
      entries.push({
        id: asset.id,
        owner: "third-party",
        // The same label the workbench files the framework's inventory rows
        // under, so the panel annotation and the ticker can never disagree.
        ownerLabel: framework.id === "superpowers" ? "Superpowers" : "ECC",
        source: `${asset.source.repository}@${asset.source.commit.slice(0, 7)} ${asset.source.path}`,
        description: `Hook registrations ${framework.id} installs and runs. AIH registers and revokes them; ${framework.id} executes them.`,
        // A label on a selectable item: aih does not install or run these, and
        // is not withholding them.
        enforcement: "not-aih-enforced",
        selectable: true,
      });
    }
  }
  const registrations = aihHookRegistrations();
  return {
    entries,
    declaredControls: DECLARED_THIRD_PARTY_HOOK_CONTROLS.filter((control) =>
      frameworks.some((framework) => framework.id === control.owner),
    ),
    registrations,
    overlaps: hookOverlaps(registrations),
    spawnProjection: hookSpawnProjection(registrations),
  };
}

/**
 * Serializable, source-controlled authoring data. It is derived directly from
 * the existing pinned MCP and baseline catalog constructors, never copied.
 */
export function policyAuthoringCatalog(): PolicyAuthoringCatalog {
  const mcp = policyAuthoringMcpCatalog();
  const unavailableMcp = policyAuthoringUnavailableMcpCatalog();
  const controls = aihPolicyControls(mcp);
  const aih = prepareAihCatalogSourceV1({
    capabilityCatalog: {
      provider: "github",
      repository: "samartomar/aih-catalog",
    },
    capabilityPackage: { name: PACKAGE_NAME, version: VERSION },
  });
  const snapshots = new Map(readVendorBaselineLock().sources.map((source) => [source.id, source]));
  const eccSnapshot = snapshots.get("ecc");
  const superpowersSnapshot = snapshots.get("superpowers");
  if (eccSnapshot === undefined || superpowersSnapshot === undefined)
    throw new Error("missing vetted framework source snapshot");
  const ecc = prepareEccCatalogSourceV1({
    baseline: eccBaselineCatalogV1(),
    sourceSnapshot: eccSnapshot,
  });
  const frameworks = [
    ecc,
    prepareSuperpowersCatalogSourceV1({
      baseline: superpowersBaselineCatalogV1(),
      sourceSnapshot: superpowersSnapshot,
    }),
  ];
  return {
    ...aih,
    hosts: policyAuthoringHosts(),
    eccMcpInventory: eccMcpCatalogInventory,
    externalMcp: eccExternalMcpCatalog,
    eccMcpProvenance: ECC_MCP_CATALOG_PROVENANCE,
    eccSkills: eccSkillCatalogInventory,
    eccSkillsProvenance: ECC_SKILL_CATALOG_PROVENANCE,
    eccMcpApproval: {
      sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
    },
    eccHookControls: {
      sourceContentSha256: ECC_HOOK_CONTROL_SOURCE_CONTENT_SHA256,
      profiles: ECC_HOOK_PROFILES,
      hooks: eccHookControlCatalog,
      disabledHooks: {
        availability: "supported",
        detail:
          "ECC evaluates profile and disabled-hook choices after process spawn. AIH projects only the two supported Claude settings environment keys; ECC executes and enforces its hooks.",
        eligibleIds: ECC_DISABLE_ELIGIBLE_HOOK_IDS,
      },
    },
    hookRegistry: hookRegistry(frameworks),
    enterpriseComposition: eccEnterpriseCompositionV1(ecc),
    nonProjectableMcp: policyAuthoringNonProjectableMcpCatalog(mcp),
    unavailableMcp,
    aihMcpRequestIds: AIH_OWNED_ECC_MCP_EXCLUSIONS,
    mcp: Object.entries(mcp).flatMap(([id, server]) => {
      const control = controls.find((candidate) => candidate.id === id);
      return control === undefined
        ? []
        : [
            {
              id,
              description: server.description,
              server,
              control,
              availability: id === "playwright" ? "web-target" : "always",
            },
          ];
    }),
    hooks: controls
      .filter((control): control is AihHookControl => control.source.type === "hook")
      .map((control) => {
        const disclosure = AIH_HOOK_DISCLOSURES[control.id];
        if (disclosure === undefined)
          throw new Error(`AIH hook ${control.id} ships without a behaviour disclosure`);
        return { id: control.id, ...disclosure, control };
      }),
    frameworks,
  };
}
