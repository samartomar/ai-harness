import { createHash } from "node:crypto";
import firstPartyPacksManifest from "../../aih-packs.json";
import { baselineCatalogById } from "../baseline-evidence/catalogs.js";
import { readVendorBaselineLock } from "../baseline-evidence/vendor.js";
import {
  CORE_ECC_COMPONENTS,
  ECC_DECLARATION_RIDERS,
  type EccComponentId,
  type EccMcpComponentId,
} from "../ecc/components.js";
import { eccModuleDependencyIds, eccProfileModuleIds } from "../ecc/evidence.js";
import {
  eccComponentRequiredModuleRootIds,
  eccModuleSelectableMemberIds,
} from "../ecc/materialize.js";
import { CLI_REGISTRY, REGISTRY_IDS } from "../internals/cli-registry.js";
import { mcpApprovalSubject } from "../mcp/policy.js";
import { type McpServer, mcpServers } from "../mcp/servers.js";
import { PacksFileSchema } from "../pack/manifest.js";
import { usageRecorderScript } from "../usage/capture.js";
import { claudeUsageHookCommand } from "../usage/hooks.js";
import { PACKAGE_NAME, VERSION } from "../version.js";
import { eccContentMetadata } from "./ecc-content-metadata.js";
import {
  ECC_DISABLE_ELIGIBLE_HOOK_IDS,
  ECC_HOOK_CONTROL_SOURCE_CONTENT_SHA256,
  ECC_HOOK_PROFILES,
  type EccHookControlCatalogEntry,
  eccHookControlCatalog,
} from "./ecc-hook-controls.js";
import {
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

export interface AihPolicyControl {
  id: string;
  kind: "mcp" | "hook";
  source:
    | { type: "mcp"; server: string; subject: string }
    | { type: "hook"; handler: "usage-metering"; scriptDigest: string };
  targets: ("claude" | "codex" | "kiro")[];
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
  /**
   * Transitive module prerequisites from ECC's pinned module manifest. These
   * are requested with the root selection; omitting one would authorize a
   * partial upstream module configuration.
   */
  dependencies?: string[];
  /**
   * Individually selectable Skill, Agent, and baseline artifacts materially
   * contained by an aggregate module. The Workbench selects these in the same
   * atomic change so inventory and export describe what the module brings.
   */
  members?: string[];
  source: { repository: string; commit: string; path: string };
  /**
   * The verdict AIH's own analyzers reached for this component at the pinned
   * commit. Absent only when the shipped evidence was produced against a
   * different pin, because showing a verdict from another commit would launder a
   * stale result into a current claim.
   */
  vet?: PolicyAuthoringVet;
  /** Source-authored identity shown to administrators, never generic UI prose. */
  metadata?: {
    title: string;
    summary: string;
    usageContext: string;
    allowedTools: readonly string[];
    sourcePath: string;
    sourceSha256: string;
  };
}

/** One blocking observation, reduced to what an administrator can act on. */
export interface PolicyAuthoringVetFinding {
  code: string;
  /** Occurrence count where the analyzer reported one; never invented when absent. */
  count?: number;
  detail: string;
}

/**
 * A vetted component's evidence. `blocked` here means an AIH-owned gate actually
 * failed — the one thing that word is reserved for. It is never a statement
 * about provenance, and it never means aih withheld a third-party component.
 */
export interface PolicyAuthoringVet {
  verdict: "pass" | "blocked";
  /** Content identity of the scanned tree, distinct from the source commit. */
  treeSha256: string;
  /** Who reached the verdict, and at exactly what version. */
  analyzers: Array<{ name: string; version: string }>;
  /** Empty for `pass`; the lock schema guarantees `blocked` carries at least one. */
  findings: PolicyAuthoringVetFinding[];
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

export interface PolicyAuthoringCatalog {
  /** Canonical first-party catalog; the Workbench binds AIH capability intent to it automatically. */
  aihCapabilityCatalog: { provider: "github"; repository: "samartomar/aih-catalog" };
  /** Exact Core package identity that carries the first-party instruction sources. */
  aihCapabilityPackage: { name: string; version: string };
  /** Context-preserving first-party skill packs shipped in this exact @aihq/core package. */
  aihSkills: Array<{
    id: string;
    pack: string;
    description: string;
    skills: string[];
    sources: Array<{ skill: string; path: string; manifestIdentity: string }>;
  }>;
  /** Isolated-execution workflows whose reusable instruction sources remain governed as skills. */
  aihAgents: Array<{
    id: string;
    pack: string;
    description: string;
    skills: string[];
    sources: Array<{ skill: string; path: string; manifestIdentity: string }>;
  }>;
  mcp: Array<{
    id: string;
    description: string;
    server: McpServer;
    control: AihPolicyControl;
    availability: "always" | "web-target";
  }>;
  /** Complete source-locked MCP availability inventory, including AIH-owned declarations. */
  eccMcpInventory: readonly EccMcpCatalogEntry[];
  externalMcp: readonly EccMcpCatalogEntry[];
  eccMcpProvenance: typeof ECC_MCP_CATALOG_PROVENANCE;
  /** Complete source-locked availability inventory; only existing assets are governable. */
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
  const web = mcpServers("project", { ...EMPTY_REPO_STACK, frameworks: ["React"] });
  const playwright = web.playwright;
  if (playwright === undefined) {
    throw new Error("AIH's web MCP catalog is missing Playwright");
  }
  // The Workbench has no target repository to scan. Offer the one conditional
  // AIH control explicitly so an administrator can request it; runtime policy
  // resolution still uses the real target stack and refuses the request when
  // that target does not expose Playwright.
  return { ...generic, playwright };
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
      targets: (server.type === "stdio" ? ["claude", "kiro"] : ["claude"]) as (
        | "claude"
        | "codex"
        | "kiro"
      )[],
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

/**
 * Vetted verdicts for one source, keyed by component id, and only when the
 * evidence was produced against the pin the catalog is serving. A pin mismatch
 * yields an empty map rather than a stale verdict: silence is honest, a verdict
 * from another commit is not.
 */
function vetVerdicts(sourceId: string, pinnedSha: string): Map<string, PolicyAuthoringVet> {
  const source = readVendorBaselineLock().sources.find((entry) => entry.id === sourceId);
  if (source === undefined || source.pinnedSha !== pinnedSha) return new Map();
  return new Map(
    source.components.map((component) => [
      component.id,
      {
        verdict: component.verdict,
        treeSha256: component.treeSha256,
        analyzers: component.analyzers.map((analyzer) => ({
          name: analyzer.name,
          version: analyzer.version,
        })),
        // Fingerprints stay internal: they are dedupe keys for the vet, not
        // something an administrator reviews.
        findings: component.findings.map((finding) => ({
          code: finding.code,
          ...(typeof finding.count === "number" ? { count: finding.count } : {}),
          detail: finding.detail,
        })),
      },
    ]),
  );
}

function frameworkCatalog(id: "ecc" | "superpowers"): PolicyAuthoringFramework {
  const catalog = baselineCatalogById(id);
  const present = new Set(catalog.components.map((component) => component.id));
  const vetted = vetVerdicts(id, catalog.pinnedSha);
  // Only name riders the pinned catalog actually contains: a relation that
  // points at a component this framework does not carry is a claim its own
  // inventory denies, and it must not reach an administrator.
  const ridersFor = (componentId: string): string[] | undefined => {
    const declared = ECC_DECLARATION_RIDERS[componentId];
    if (declared === undefined) return undefined;
    const usable = declared.filter((rider) => present.has(rider));
    return usable.length > 0 ? [...usable] : undefined;
  };
  const dependenciesFor = (componentId: string): string[] | undefined => {
    if (id !== "ecc" || componentId.startsWith("runtime:")) return undefined;
    const roots = eccComponentRequiredModuleRootIds(
      componentId as EccComponentId | EccMcpComponentId,
    );
    const dependencies = [
      ...new Set(roots.flatMap((moduleId) => [moduleId, ...eccModuleDependencyIds(moduleId)])),
    ]
      .map((moduleId) => `module:${moduleId}`)
      .filter((dependencyId) => dependencyId !== componentId);
    for (const dependency of dependencies) {
      if (!present.has(dependency)) {
        throw new Error(
          `baseline component ${componentId} requires ${dependency}, which the pinned catalog does not contain`,
        );
      }
    }
    return dependencies.length > 0 ? dependencies : undefined;
  };
  const membersFor = (componentId: string): string[] | undefined => {
    if (id !== "ecc" || !componentId.startsWith("module:")) return undefined;
    const members = eccModuleSelectableMemberIds(
      componentId.slice("module:".length),
      catalog.components.map((component) => component.id),
    );
    return members.length > 0 ? members : undefined;
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
      const dependencies = dependenciesFor(component.id);
      const members = membersFor(component.id);
      const vet = vetted.get(component.id);
      const kind = assetKind(component.id);
      const name = component.id.slice(component.id.indexOf(":") + 1);
      const metadata =
        id === "ecc" && (kind === "agent" || kind === "skill")
          ? eccContentMetadata(kind, name)
          : undefined;
      if (id === "ecc" && (kind === "agent" || kind === "skill") && metadata === undefined) {
        throw new Error(`ECC ${kind} ${component.id} has no source-authored metadata`);
      }
      return {
        kind,
        id: component.id,
        ...(curation === undefined ? {} : { curationKind: curation }),
        ...(riders === undefined ? {} : { riders }),
        ...(dependencies === undefined ? {} : { dependencies }),
        ...(members === undefined ? {} : { members }),
        ...(vet === undefined ? {} : { vet }),
        ...(metadata === undefined
          ? {}
          : {
              metadata: {
                title: metadata.title,
                summary: metadata.summary,
                usageContext: metadata.usageContext,
                allowedTools: metadata.allowedTools,
                sourcePath: metadata.path,
                sourceSha256: metadata.sourceSha256,
              },
            }),
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
      rule: 'capability:security is what selectEccComponents() recommends at enterprise posture; module:security is what ECC\'s "security" profile adds over "core"',
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

/** The source-locked availability list may name more skills than AIH can govern,
 * but it must never disagree about the governed subset. */
function validateEccSkillCatalog(
  ecc: PolicyAuthoringFramework,
  skills: readonly EccSkillCatalogEntry[],
): void {
  if (
    ECC_SKILL_CATALOG_PROVENANCE.repository !== ecc.repository ||
    ECC_SKILL_CATALOG_PROVENANCE.commit !== ecc.commit
  ) {
    throw new Error(
      "source-locked ECC skill inventory provenance does not match the policy catalog",
    );
  }
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  for (const skill of skills) {
    if (skill.governable && !ecc.assets.some((asset) => asset.id === `skill:${skill.id}`)) {
      throw new Error(`governable ECC skill ${skill.id} is absent from the policy catalog`);
    }
  }
  for (const asset of ecc.assets.filter((asset) => asset.kind === "skill")) {
    const name = asset.id.slice("skill:".length);
    if (!byId.get(name)?.governable) {
      throw new Error(
        `policy skill ${asset.id} is absent or unavailable in the source-locked ECC inventory`,
      );
    }
  }
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
  const controls = aihPolicyControls(mcp);
  const firstPartyPacks = PacksFileSchema.parse(firstPartyPacksManifest);
  const firstPartyCapabilityPacks = firstPartyPacks.packs.map((pack) => ({
    id: `package:skill-pack/${pack.name}`,
    pack: pack.name,
    description: pack.description ?? `AIH first-party ${pack.name} capability pack`,
    skills: pack.skills.map((skill) => skill.name),
    sources: pack.skills.map((skill) => ({
      skill: skill.name,
      path: skill.source,
      manifestIdentity: skill.commit,
    })),
  }));
  const agentSkillNames = new Set(["aih-bugbounty", "aih-gov-doctor"]);
  const isAgentPack = (pack: (typeof firstPartyCapabilityPacks)[number]): boolean =>
    pack.skills.some((skill) => agentSkillNames.has(skill));
  const ecc = frameworkCatalog("ecc");
  const frameworks = [ecc, frameworkCatalog("superpowers")];
  validateEccSkillCatalog(ecc, eccSkillCatalogInventory);
  return {
    aihCapabilityCatalog: { provider: "github", repository: "samartomar/aih-catalog" },
    aihCapabilityPackage: { name: PACKAGE_NAME, version: VERSION },
    aihSkills: firstPartyCapabilityPacks.filter((pack) => !isAgentPack(pack)),
    aihAgents: firstPartyCapabilityPacks.filter(isAgentPack),
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
    enterpriseComposition: enterpriseComposition(ecc),
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
