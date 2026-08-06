import { createHash } from "node:crypto";
import { baselineCatalogById } from "../baseline-evidence/catalogs.js";
import { CORE_ECC_COMPONENTS, ECC_DECLARATION_RIDERS } from "../ecc/components.js";
import { eccProfileModuleIds } from "../ecc/evidence.js";
import { CLI_REGISTRY, REGISTRY_IDS } from "../internals/cli-registry.js";
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
  /**
   * Components this one pulls in with it, from ECC's own declaration riders.
   * Present only where the pinned catalog actually carries every rider, so the
   * surface never names a component the inventory denies.
   */
  riders?: string[];
  source: { repository: string; commit: string; path: string };
}

export interface PolicyAuthoringFramework {
  id: "ecc" | "superpowers";
  repository: string;
  commit: string;
  assets: PolicyAuthoringAsset[];
}

/**
 * What an AIH-owned hook does at event time. Hooks are AIH-owned and custom
 * hooks are unsupported, so the administrator's only lever here is knowing
 * exactly what runs — disclosure is the whole affordance.
 */
export interface AihHookBehaviour {
  /** The CLI event that fires it. */
  trigger: string;
  records: string;
  /** The repo-relative artifact it writes. */
  artifact: string;
  failureMode: string;
}

/** An AIH control already narrowed to its hook identity, so a disclosure can
 * read the pinned script digest without re-proving which variant it holds. */
export type AihHookControl = AihPolicyControl & {
  source: Extract<AihPolicyControl["source"], { type: "hook" }>;
};

export interface PolicyAuthoringHook {
  id: string;
  description: string;
  behaviour: AihHookBehaviour;
  control: AihHookControl;
}

export interface PolicyAuthoringCompositionPart {
  id: string;
  label: string;
  /** The exact product constructor this part is derived from, stated for review. */
  rule: string;
  /**
   * Whether choosing the posture selects this part, or offers it as a choice
   * the administrator makes. The acceptance contract has Enterprise expose "ECC
   * Core and additive choices", and its journey has the administrator select
   * languages and add security — which only works if the posture leaves those
   * parts unselected.
   */
  selection: "composed" | "additive";
  componentIds: string[];
}

/**
 * What a posture composes out of a framework's inventory. Composed parts become
 * requested intent when the posture is chosen; additive parts are named so the
 * administrator can add them. Recording either is not enforcement — ECC installs
 * and runs these components.
 */
export interface PolicyAuthoringComposition {
  framework: "ecc";
  parts: PolicyAuthoringCompositionPart[];
}

/**
 * Every AI CLI this build knows, and whether an org policy can project onto it.
 * AIH's registry carries eleven; `PolicyTargetSchema` carries two. Stating that
 * asymmetry is the point: an administrator who sees only claude and codex has
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
  const targets = new Set(["claude", "codex"]);
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

export interface PolicyAuthoringCatalog {
  mcp: Array<{ id: string; description: string; server: McpServer; control: AihPolicyControl }>;
  hooks: PolicyAuthoringHook[];
  frameworks: PolicyAuthoringFramework[];
  enterpriseComposition: PolicyAuthoringComposition;
  hosts: PolicyAuthoringHost[];
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
  const present = new Set(catalog.components.map((component) => component.id));
  // Only name riders the pinned catalog actually contains: a relation that
  // points at a component this framework does not carry is a claim its own
  // inventory denies, and it must not reach an administrator.
  const ridersFor = (componentId: string): string[] | undefined => {
    const declared = ECC_DECLARATION_RIDERS[componentId];
    if (declared === undefined) return undefined;
    const usable = declared.filter((rider) => present.has(rider));
    return usable.length > 0 ? [...usable] : undefined;
  };
  return {
    id,
    repository: `${catalog.owner}/${catalog.repo}`,
    commit: catalog.pinnedSha,
    assets: catalog.components.map((component) => {
      const path = component.paths[0];
      if (path === undefined)
        throw new Error(`baseline component ${component.id} declares no path`);
      const curation = curationKind(component.id);
      const riders = ridersFor(component.id);
      return {
        kind: assetKind(component.id),
        id: component.id,
        ...(curation === undefined ? {} : { curationKind: curation }),
        ...(riders === undefined ? {} : { riders }),
        source: {
          repository: `${catalog.owner}/${catalog.repo}`,
          commit: catalog.pinnedSha,
          path,
        },
      };
    }),
  };
}

function eccProfileComponentIds(profileId: string): string[] {
  return eccProfileModuleIds(profileId).map((moduleId) => `module:${moduleId}`);
}

/**
 * The enterprise posture's ECC composition, derived from the product's own
 * selectors rather than restated. "ECC Core" is deliberately two parts: ECC's
 * own install profile and AIH's named closure are different objects that the
 * repository gives the same short name, and hiding either one would leave the
 * administrator with a word that means two things.
 */
function enterpriseComposition(ecc: PolicyAuthoringFramework): PolicyAuthoringComposition {
  const core = eccProfileComponentIds("core");
  const inCore = new Set(core);
  const parts: PolicyAuthoringCompositionPart[] = [
    {
      id: "ecc-install-core",
      label: "ECC install profile: core",
      rule: 'ecc-profiles.json profile "core", dependency-closed by eccProfileModuleIds()',
      selection: "composed",
      componentIds: core,
    },
    {
      id: "aih-core-closure",
      label: "AIH's named ECC Core closure",
      rule: "CORE_ECC_COMPONENTS — AIH's own curation, not a set ECC declares",
      selection: "composed",
      componentIds: [...CORE_ECC_COMPONENTS],
    },
    {
      id: "language",
      label: "Language composition, additive on top of Core",
      rule: "every ECC component in the lang: namespace",
      selection: "additive",
      componentIds: ecc.assets.filter((asset) => asset.kind === "lang").map((asset) => asset.id),
    },
    {
      id: "security",
      label: "Security composition",
      rule: 'capability:security is what selectEccComponents() recommends at team and enterprise posture; module:security is what ECC\'s "security" profile adds over "core"',
      selection: "additive",
      componentIds: [
        "capability:security",
        ...eccProfileComponentIds("security").filter((id) => !inCore.has(id)),
      ],
    },
  ];
  const owned = new Set(ecc.assets.map((asset) => asset.id));
  for (const part of parts) {
    for (const id of part.componentIds) {
      // Fail closed the way assetKind() does: a composition that names a
      // component the pinned catalog does not carry is a claim its own
      // inventory denies, and it must not ship as an empty-looking group.
      if (!owned.has(id))
        throw new Error(
          `enterprise composition part ${part.id} names ${id}, which the pinned ECC catalog does not contain`,
        );
    }
  }
  return { framework: "ecc", parts };
}

/**
 * Serializable, source-controlled authoring data. It is derived directly from
 * the existing pinned MCP and baseline catalog constructors, never copied.
 */
export function policyAuthoringCatalog(): PolicyAuthoringCatalog {
  const mcp = policyAuthoringMcpCatalog();
  const controls = aihPolicyControls(mcp);
  const ecc = frameworkCatalog("ecc");
  return {
    hosts: policyAuthoringHosts(),
    enterpriseComposition: enterpriseComposition(ecc),
    mcp: Object.entries(mcp).flatMap(([id, server]) => {
      const control = controls.find((candidate) => candidate.id === id);
      return control === undefined
        ? []
        : [{ id, description: server.description, server, control }];
    }),
    hooks: controls
      .filter((control): control is AihHookControl => control.source.type === "hook")
      .map((control) => {
        const disclosure = AIH_HOOK_DISCLOSURES[control.id];
        if (disclosure === undefined)
          throw new Error(`AIH hook ${control.id} ships without a behaviour disclosure`);
        return { id: control.id, ...disclosure, control };
      }),
    frameworks: [ecc, frameworkCatalog("superpowers")],
  };
}
