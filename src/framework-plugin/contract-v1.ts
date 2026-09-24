import type { baselineCatalogById } from "../baseline-evidence/catalogs.js";
import type { executeBaselineEvidencePipeline } from "../baseline-evidence/pipeline.js";
import type { BaselineAuthorization, BaselineHeldComponent } from "../baseline-evidence/verify.js";
import type { loadCatalogPackageV1 } from "../catalog-package/load-catalog-package.js";
import type { Posture } from "../config/posture.js";
import type { Cli } from "../internals/clis.js";
import type { executePlan, PlanResult } from "../internals/execute.js";
import type { OwnedFileExpectation } from "../internals/owned-file-transaction.js";
import type { Action, FileAssertion, Plan, PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import type {
  assertPolicyBindingCurrent,
  policyBindingFileAssertion,
} from "../org-policy/binding.js";
import type { assertOrgPolicyMutationSource } from "../org-policy/drift.js";
import type { verifiedOrgPolicyTargets } from "../org-policy/project.js";
import type { readOrgPolicy } from "../org-policy/schema.js";
import type {
  historicalEccRuntimeDescriptorsFromSourceDataV1,
  workbenchSourceDataRootV1,
} from "../org-policy/workbench/core/source-data.js";
import type { consumeWorkbenchPolicy } from "../org-policy/workbench/policy-consumption.js";
import type { cleanupQuarantine, resolveTrustSource } from "../trust/fetch.js";

/**
 * Framework plugin contract, version 1 (C3).
 *
 * A framework plugin is a separately installed package that carries ONE
 * framework's behaviour (ECC, Superpowers). Core keeps the command surface,
 * the policy decisions, the Catalog access and the effectful services; the
 * plugin supplies the framework-specific parts through the operations below.
 *
 * The operation set is bounded by the real Core call sites: the framework's own
 * CLI commands, `aih init`, and the optional policy-delivery/uninstall/prune/
 * doctor/report hooks the ECC call sites need in phase 2. Operations receive a context Core
 * builds ({@link FrameworkOperationContextV1}); they never receive Catalog
 * handles, Core's internal plan context or the process environment.
 */

export const FRAMEWORK_PLUGIN_CONTRACT_VERSION = 1;

/**
 * The closed set of framework plugins Core loads. Literal by design: nothing
 * user-controlled (environment, flag, configuration, Catalog data) can add or
 * change a package name. `src/framework-plugin/load-framework-plugin.ts` imports
 * each package by exactly this literal specifier.
 */
export const FRAMEWORK_PLUGIN_PACKAGE_NAMES = Object.freeze({
  ecc: "@aihq/framework-ecc",
  superpowers: "@aihq/framework-superpowers",
} as const);

export type FrameworkIdV1 = keyof typeof FRAMEWORK_PLUGIN_PACKAGE_NAMES;
export type FrameworkPluginPackageNameV1 = (typeof FRAMEWORK_PLUGIN_PACKAGE_NAMES)[FrameworkIdV1];

export const FRAMEWORK_IDS_V1: readonly FrameworkIdV1[] = Object.freeze(["ecc", "superpowers"]);

/**
 * The Core CLI command paths each framework's plugin must execute. Core owns
 * the command surface (names, options, summaries); the plugin implements the
 * behaviour behind each path. A plugin that does not implement every path Core
 * dispatches to is incompatible.
 */
export const FRAMEWORK_PLUGIN_COMMANDS = Object.freeze({
  ecc: Object.freeze(["ecc", "ecc mcp add", "ecc mcp remove"] as const),
  superpowers: Object.freeze(["superpowers"] as const),
} as const);

export type FrameworkCommandPathV1<F extends FrameworkIdV1 = FrameworkIdV1> =
  (typeof FRAMEWORK_PLUGIN_COMMANDS)[F][number];

/** The Catalog subpath (C1) that carries one framework's descriptor bytes. */
export function frameworkDescriptorSubpathV1(frameworkId: FrameworkIdV1): string {
  return `./catalog-framework-${frameworkId}.json`;
}

/** An exact upstream source identity: `owner/repo` and a full lowercase commit SHA. */
export interface FrameworkUpstreamV1 {
  readonly repository: string;
  readonly commit: string;
}

/**
 * Framework descriptor bytes exactly as Core loaded them from Catalog (C1).
 * Core validates the envelope; the plugin validates the sections it reads with
 * its own schema and refuses anything it cannot accept.
 */
export interface FrameworkDescriptorBytesV1 {
  readonly frameworkId: FrameworkIdV1;
  readonly bytes: Uint8Array;
  /** Lowercase SHA-256 of `bytes`. */
  readonly sha256: string;
  /** The installed Catalog version that carried the bytes, when known. */
  readonly catalogVersion?: string;
}

/** A target-relative file a plugin's plans write and Core's uninstall may remove. */
export interface FrameworkOwnedArtifactV1 {
  readonly host: Cli;
  /** POSIX path relative to the target root. */
  readonly path: string;
}

/** Static self-description. Pure: no context, no filesystem, no network. */
export interface FrameworkPluginDescriptionV1 {
  readonly frameworkId: FrameworkIdV1;
  readonly displayName: string;
  /** The upstream this plugin version was built and verified against. */
  readonly upstream: FrameworkUpstreamV1;
  /** Hosts (CLIs) the plugin has a delivery route for. */
  readonly supportedHosts: readonly Cli[];
  /** The Catalog subpath whose bytes the plugin reads ({@link frameworkDescriptorSubpathV1}). */
  readonly catalogSubpath: string;
  /** Descriptor sections the plugin validates and reads. */
  readonly descriptorSections: readonly string[];
  /**
   * Environment variable names the plugin reads through its context. Core
   * passes exactly these names (when set) and nothing else.
   */
  readonly environment: readonly string[];
  readonly ownedArtifacts: readonly FrameworkOwnedArtifactV1[];
}

/** One framework component and the targeted hosts it applies to at the target root. */
export interface FrameworkComponentV1 {
  readonly id: string;
  /** Source-relative POSIX paths inside the upstream tree. */
  readonly paths: readonly string[];
  readonly hosts: readonly Cli[];
}

export interface FrameworkComponentsV1 {
  readonly frameworkId: FrameworkIdV1;
  readonly upstream: FrameworkUpstreamV1;
  readonly components: readonly FrameworkComponentV1[];
  /** Language packs the framework selects for the stack detected at the target root, when it has packs. */
  readonly languagePacks?: readonly string[];
}

/** How a hook declaration runs on its host. */
export type FrameworkHookExecutionV1 = "process" | "in-process" | "declarative";

/** One host's declaration of a hook, recorded from the pinned upstream tree. */
export interface FrameworkHookDeclarationV1 {
  readonly host: Cli;
  /** Source-relative path of the file that declares or implements the hook. */
  readonly sourcePath: string;
  /** Host-native event name. */
  readonly event: string;
  readonly matcher?: string;
  readonly command?: string;
  readonly execution: FrameworkHookExecutionV1;
}

/** Whether the upstream offers its own switch for one hook. */
export type FrameworkHookUpstreamControlV1 =
  | { readonly kind: "none" }
  | { readonly kind: "environment"; readonly name: string; readonly value: string };

export interface FrameworkHookV1 {
  /** Stable hook id, e.g. `hook:session-start`. */
  readonly id: string;
  /** Logical event, e.g. `SessionStart`. */
  readonly event: string;
  readonly summary: string;
  readonly declarations: readonly FrameworkHookDeclarationV1[];
  readonly upstreamControl: FrameworkHookUpstreamControlV1;
  /** The upstream hook profiles that run this hook, when the framework has profiles. */
  readonly profiles?: readonly string[];
  /**
   * False when the upstream cannot turn this one hook off on its own (for
   * example an outer wrapper whose children own the gates). A disable request
   * for such a hook is refused. Absent means eligible.
   */
  readonly disableEligible?: boolean;
}

/** One upstream hook profile a framework offers. */
export interface FrameworkHookProfileV1 {
  readonly id: string;
  readonly label: string;
}

export interface FrameworkHookInventoryV1 {
  readonly frameworkId: FrameworkIdV1;
  readonly upstream: FrameworkUpstreamV1;
  readonly hooks: readonly FrameworkHookV1[];
  /** The upstream hook profiles, when the framework has profiles. */
  readonly profiles?: readonly FrameworkHookProfileV1[];
}

/** Who asked for a hook to be disabled. Enterprise policy outranks a user request. */
export type FrameworkHookControlAuthorityV1 = "enterprise" | "user";

export interface FrameworkHookDisableRequestV1 {
  readonly hookId: string;
  readonly authority: FrameworkHookControlAuthorityV1;
}

/** An upstream hook profile choice. Only enterprise policy sets a profile. */
export interface FrameworkHookProfileRequestV1 {
  readonly id: string;
  readonly authority: "enterprise";
}

/**
 * The hook controls Core's effective policy view carries for this invocation:
 * enterprise policy (`governance.frameworkHookControls`) merged with the
 * project user's list (`.aih-config.json` `frameworkHookControls`). A user can
 * only add disables; the profile comes from enterprise policy alone.
 */
export interface FrameworkHookControlRequestV1 {
  readonly disabled: readonly FrameworkHookDisableRequestV1[];
  readonly profile?: FrameworkHookProfileRequestV1;
}

/**
 * How one decision is enforced on one targeted host:
 * - `not-applicable`: the hook does not run on this host;
 * - `upstream-switch`: the upstream's own switch turns it off (the plan sets it);
 * - `unenforced`: aih has no way to turn it off there. This is a label with a
 *   next route, never a reason to hide the framework: the host's own plugin
 *   manager installs and runs third-party hooks, not aih.
 */
export type FrameworkHookEnforcementV1 = "not-applicable" | "upstream-switch" | "unenforced";

export interface FrameworkHookHostDecisionV1 {
  readonly host: Cli;
  readonly enforcement: FrameworkHookEnforcementV1;
  /** The label, and for `unenforced` the next route an operator can take. */
  readonly detail: string;
}

export interface FrameworkHookControlDecisionV1 {
  readonly hookId: string;
  readonly state: "enabled" | "disabled";
  /** The strongest authority that disabled the hook; absent when enabled. */
  readonly authority?: FrameworkHookControlAuthorityV1;
  readonly hosts: readonly FrameworkHookHostDecisionV1[];
}

/**
 * Upstream switches read from a host's settings environment. Core applies the
 * patch through its hook registrar into the host's settings file and records
 * a receipt that owns exactly `keys`; an owned key absent from `set` is
 * removed. Today Core's registrar serves the `claude` host.
 */
export interface FrameworkHookEnvironmentPatchV1 {
  readonly host: "claude";
  /** Every environment key this framework's hook controls may own. */
  readonly keys: readonly string[];
  /** The values to set; each key must be in `keys`. */
  readonly set: Readonly<Record<string, string>>;
}

export interface FrameworkHookControlPlanV1 {
  readonly frameworkId: FrameworkIdV1;
  readonly decisions: readonly FrameworkHookControlDecisionV1[];
  /** Actions that label what aih cannot enforce (docs). */
  readonly actions: readonly Action[];
  /** The upstream switches Core applies, when the framework's hooks read one. */
  readonly environment?: FrameworkHookEnvironmentPatchV1;
}

/** The effective policy view Core decided for this invocation. */
export interface FrameworkPolicyViewV1 {
  readonly posture: Posture;
  readonly hookControls: FrameworkHookControlRequestV1;
}

/** One component a plugin asks Core to verify against release or organization evidence. */
export interface FrameworkEvidenceComponentV1 {
  readonly id: string;
  readonly paths: readonly string[];
  readonly skillContent?: true;
}

export type FrameworkEvidenceAuthorizationV1 = BaselineAuthorization;
export type FrameworkEvidenceHeldComponentV1 = BaselineHeldComponent;

/** The verified source a plugin builds its install plan from. */
export interface FrameworkVerifiedSourceV1 {
  /** Absolute path of the acquired, evidence-verified source tree (removed after the command). */
  readonly sourceRoot: string;
  readonly authorizations: readonly FrameworkEvidenceAuthorizationV1[];
  readonly held: readonly FrameworkEvidenceHeldComponentV1[];
}

/**
 * Core's evidence gate for a framework: acquire the exact pinned source into a
 * quarantine, verify every requested component against release or organization
 * evidence, and only then ask the plugin for its install plan and execute it.
 * The evidence catalog id is always the plugin's own framework id.
 */
export interface FrameworkEvidenceGatedInstallRequestV1 {
  readonly source: {
    readonly owner: string;
    readonly repo: string;
    /** Exact lowercase 40-character commit SHA. */
    readonly commit: string;
  };
  readonly components: readonly FrameworkEvidenceComponentV1[];
  /** The component ids to verify and install; each must be in `components`. */
  readonly componentIds: readonly string[];
  readonly buildInstallPlan: (verified: FrameworkVerifiedSourceV1) => Plan | Promise<Plan>;
}

/**
 * Core's effectful and policy-bound operations, bound by Core to ONE framework
 * invocation. Each member has the signature of the Core function it names; the
 * bound member runs Core's own implementation under the invocation's decisions:
 * `executePlan` and the evidence pipeline carry the invocation's policy
 * transaction pins and refuse a plan context for another root, policy readers
 * read the invocation's own environment, and every member refuses once the
 * invocation has ended. A framework implementation reaches executors, source
 * acquisition, policy and Catalog reads ONLY through this runtime; the
 * `@aihq/core/framework-host` imports carry no effect of their own.
 */
export interface FrameworkCoreRuntimeV1 {
  /** The invocation's plan context, with `targets` resolved and the policy decided. */
  readonly planContext: PlanContext;
  readonly executePlan: typeof executePlan;
  readonly executeBaselineEvidencePipeline: typeof executeBaselineEvidencePipeline;
  readonly resolveTrustSource: typeof resolveTrustSource;
  readonly cleanupQuarantine: typeof cleanupQuarantine;
  readonly verifiedOrgPolicyTargets: typeof verifiedOrgPolicyTargets;
  readonly assertPolicyBindingCurrent: typeof assertPolicyBindingCurrent;
  readonly policyBindingFileAssertion: typeof policyBindingFileAssertion;
  readonly assertOrgPolicyMutationSource: typeof assertOrgPolicyMutationSource;
  readonly readOrgPolicy: typeof readOrgPolicy;
  readonly baselineCatalogById: typeof baselineCatalogById;
  readonly loadCatalogPackageV1: typeof loadCatalogPackageV1;
  readonly historicalEccRuntimeDescriptorsFromSourceDataV1: typeof historicalEccRuntimeDescriptorsFromSourceDataV1;
  readonly workbenchSourceDataRootV1: typeof workbenchSourceDataRootV1;
  readonly consumeWorkbenchPolicy: typeof consumeWorkbenchPolicy;
}

/** Effectful services Core binds to one invocation. */
export interface FrameworkHostServicesV1 {
  runEvidenceGatedInstall(request: FrameworkEvidenceGatedInstallRequestV1): Promise<PlanResult>;
  /**
   * Report without effects: Core executes only static `doc` actions without a
   * file path and `digest` actions without a callback, and refuses any other
   * action. Every effect runs through {@link runEvidenceGatedInstall}.
   */
  executePlan(plan: Plan): Promise<PlanResult>;
  /** One bounded progress line on the command's diagnostic channel. */
  progress(message: string): void;
  /**
   * Core's executors and policy readers, bound to this invocation and revoked
   * when it ends. Present only for command operations; read-only operations
   * (description, inventory, component identification) get none.
   */
  readonly runtime?: FrameworkCoreRuntimeV1;
}

/** Everything one plugin operation receives. Built by Core; never raw Catalog handles. */
export interface FrameworkOperationContextV1 {
  readonly frameworkId: FrameworkIdV1;
  /** Absolute target root. */
  readonly root: string;
  /** The host/CLI targets Core resolved for this invocation (policy, `--cli`, `--detect`). */
  readonly targets: readonly Cli[];
  readonly mode: { readonly apply: boolean; readonly verify: boolean };
  readonly descriptor: FrameworkDescriptorBytesV1;
  readonly policy: FrameworkPolicyViewV1;
  /** The command's own parsed options (none for commands without options). */
  readonly options: Readonly<Record<string, unknown>>;
  /** Only the variables named by {@link FrameworkPluginDescriptionV1.environment}. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly host: FrameworkHostServicesV1;
}

export interface FrameworkCommandV1 {
  execute(ctx: FrameworkOperationContextV1): Promise<PlanResult>;
}

/** What a framework's receipt-proven removal did (Core call site: `aih uninstall --apply`). */
export interface FrameworkUninstallOutcomeV1 {
  /** POSIX paths relative to the target root, removed because the receipt proved aih wrote them. */
  readonly removed: readonly string[];
  /** Destinations kept because their ownership could not be proven, with the reason. */
  readonly advisories: readonly {
    readonly path: string;
    readonly reason: string;
    readonly detail: string;
  }[];
}

/**
 * Framework-owned state removal for `aih uninstall`. Core reads the receipt
 * and decides; it calls `remove` only under `--apply`, after its own cleanup
 * succeeded, and the plugin removes exactly what the receipt proves.
 */
export interface FrameworkUninstallHookV1 {
  remove(ctx: FrameworkOperationContextV1): Promise<FrameworkUninstallOutcomeV1>;
}

/** A framework's share of an `aih prune` plan. */
export interface FrameworkPrunePlanV1 {
  readonly actions: readonly Action[];
  /** How many managed files the actions subtract framework content from. */
  readonly subtracted: number;
}

/** Framework reconciliation for targets `aih prune` drops; Core executes the actions in its prune plan. */
export interface FrameworkPruneHookV1 {
  plan(ctx: FrameworkOperationContextV1, dropped: readonly Cli[]): Promise<FrameworkPrunePlanV1>;
}

/** Framework-owned read-only checks for `aih doctor`. */
export interface FrameworkDoctorHookV1 {
  checks(ctx: FrameworkOperationContextV1): Promise<readonly Check[]>;
}

/** One framework panel for `aih report`. */
export interface FrameworkReportPanelV1 {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
}

export interface FrameworkReportHookV1 {
  panels(ctx: FrameworkOperationContextV1): Promise<readonly FrameworkReportPanelV1[]>;
}

/**
 * What Core hands a prepared policy delivery when it commits it: the project
 * policy binding assertion Core re-read after its own policy projection, which
 * replaces the assertion on the same path taken at preparation.
 */
export interface FrameworkPolicyDeliveryCommitV1 {
  readonly policyBinding?: FileAssertion;
}

/** One framework delivery the organization policy requires, verified and held in memory. */
export interface FrameworkPreparedPolicyDeliveryV1 {
  /** The prepared delivery as Core's runtime produced it: the preview when not applying. */
  readonly result: PlanResult;
  /**
   * Commit exactly the prepared delivery. Present only when the invocation
   * applies and preparation retained a delivery. Core calls it at most once,
   * after its own policy projection succeeded, in the same invocation.
   */
  readonly commit?: (update: FrameworkPolicyDeliveryCommitV1) => Promise<PlanResult>;
}

/**
 * Policy-required framework delivery around Core's policy projection (Core
 * call sites: `aih policy project`, `aih init` on a policy-bound project).
 */
export interface FrameworkPolicyDeliveryHookV1 {
  prepare(ctx: FrameworkOperationContextV1): Promise<FrameworkPreparedPolicyDeliveryV1>;
  /**
   * Read-only delivery inspection for Core's policy-delivery report (Core call
   * sites: `aih policy evaluate`, `aih doctor`, `aih report`). Core compares
   * its own receipt; the plugin supplies only what is framework knowledge.
   */
  inspect(ctx: FrameworkOperationContextV1): FrameworkPolicyDeliveryInspectorV1;
}

/** One selected component as Core's receipt comparison observed it. */
export interface FrameworkDeliveryComponentInputV1 {
  readonly id: string;
  readonly provenance: {
    readonly repository: string;
    readonly commit: string;
    readonly componentPath: string;
  };
  readonly files: readonly { readonly path: string }[];
  readonly ownership: "planned" | "receipt-recorded" | "missing-receipt" | "source-mismatch";
}

/** Native registration of the framework's Codex agent roles, as the plugin read it. */
export interface FrameworkCodexRoleRegistrationV1 {
  readonly state: "current" | "missing" | "drifted" | "conflict" | "malformed";
  readonly expectedRoleIds: readonly string[];
  readonly receiptRoleIds: readonly string[];
  readonly detail?: string;
}

/** The policy's selection joined to the observed components; installation and loading stay unverified. */
export interface FrameworkGovernedSelectionV1 {
  readonly targets: readonly Cli[];
  readonly components: readonly {
    readonly id: string;
    readonly requirement: "required";
    readonly selectionReason:
      | "selected-root"
      | "selected-choice"
      | "required-dependency"
      | "legacy-unattributed";
    readonly retainedBy: readonly string[];
    readonly source: {
      readonly repository: string;
      readonly commit: string;
      readonly componentPath: string;
    };
    readonly owner: "aih-materialization";
    readonly ownership: FrameworkDeliveryComponentInputV1["ownership"];
    readonly destinations: readonly {
      readonly path: string;
      readonly discovery:
        | "project-skill-entry"
        | "projected-supporting-content"
        | "projected-content";
    }[];
  }[];
  readonly authoringExclusions: readonly {
    readonly assetId: string;
    readonly sourceId: string;
    readonly sourceRevisionId: string;
    readonly contentDigest: string;
  }[];
  readonly unavailable: readonly {
    readonly id: string;
    readonly kind: string;
    readonly framework: string;
    readonly reason: string;
    readonly findingCodes: readonly string[];
    readonly detail: string;
  }[];
  readonly refused: readonly {
    readonly id: string;
    readonly target: Cli;
    readonly reason: string;
    readonly detail: string;
  }[];
  readonly otherOwners: readonly {
    readonly owner: "native-plugin" | "legacy-or-user-content";
    readonly scope: "user-or-account" | "project";
    readonly state: "unverified" | "preserved-unless-receipt-owned";
    readonly detail: string;
  }[];
  readonly dependencyAuthority: "qualified-source-relations" | "unverified";
}

/** The framework knowledge Core's policy-delivery report needs; every member is read-only. */
export interface FrameworkPolicyDeliveryInspectorV1 {
  /** The targets the framework can deliver governed content to. */
  readonly governedTargets: readonly Cli[];
  /** The Codex role registration the receipt-current components expect at the target root. */
  inspectCodexRoles(
    roles: readonly { readonly id: string; readonly configFile: string }[],
  ): FrameworkCodexRoleRegistrationV1;
  describeSelection(input: {
    readonly policy: NonNullable<ReturnType<typeof readOrgPolicy>>;
    readonly targets: readonly Cli[];
    readonly components: readonly FrameworkDeliveryComponentInputV1[];
  }): FrameworkGovernedSelectionV1;
}

/** One owned-file step of a framework's receipt-proven subtraction; Core executes it in its owned-file transaction. */
export interface FrameworkOwnedFileStepV1 {
  readonly kind: "write" | "remove";
  /** POSIX path relative to the target root. */
  readonly path: string;
  readonly mode: number;
  readonly expect: OwnedFileExpectation;
  readonly contents?: Buffer;
  readonly prior?: Buffer;
  readonly priorMode?: number;
}

/** A framework's receipt-proven subtraction of named components. */
export interface FrameworkComponentSubtractionV1 {
  readonly steps: readonly FrameworkOwnedFileStepV1[];
  /** Destinations whose ownership cannot be proven; any advisory means nothing is subtracted. */
  readonly advisories: readonly unknown[];
}

/** The local state of one explicit MCP receipt record. */
export interface FrameworkExplicitMcpReceiptStateV1 {
  readonly id?: string;
  readonly target?: string;
  readonly state: string;
}

/**
 * The framework's pure planning for `aih capability package` (Core call site:
 * the mixed-package coordinator), bound to one invocation. Synchronous and
 * effect-free: Core executes the steps and writes in its own transaction.
 */
export interface FrameworkCapabilityPackageDomainV1 {
  planComponentSubtraction(
    root: string,
    componentIds: readonly string[],
  ): FrameworkComponentSubtractionV1;
  /** Throws when the policy does not approve this explicit MCP for the target. */
  assertExplicitMcpApproved(policy: unknown, id: string, target: string): void;
  /** The config writes that remove one explicit MCP record from its target. */
  planExplicitMcpRemove(input: { root: string; id: string; target: string }): {
    readonly actions: readonly Action[];
  };
  explicitMcpReceiptStates(root: string): readonly FrameworkExplicitMcpReceiptStateV1[];
}

export interface FrameworkCapabilityPackagesHookV1 {
  domain(ctx: FrameworkOperationContextV1): FrameworkCapabilityPackageDomainV1;
}

/** A receipt file the plugin owns under the target root. */
export interface FrameworkReceiptV1 {
  readonly id: string;
  /** POSIX path relative to the target root. */
  readonly path: string;
}

/**
 * What a framework plugin package exports as `aihFrameworkPluginV1`.
 *
 * Required members cover every Core call site both frameworks have today.
 * The optional hooks are Core call sites only ECC has (phase 2); a plugin that
 * provides one must provide it completely.
 */
export interface FrameworkPluginV1 {
  readonly contractVersion: typeof FRAMEWORK_PLUGIN_CONTRACT_VERSION;
  /** `FRAMEWORK_HOST_API_VERSION` of the `@aihq/core/framework-host` the plugin was built against. */
  readonly hostApiVersion: number;
  readonly frameworkId: FrameworkIdV1;
  /** Must equal the installed package's own `package.json` name. */
  readonly packageName: string;
  /** Must equal the installed package's own `package.json` version. */
  readonly packageVersion: string;
  describe(): FrameworkPluginDescriptionV1;
  identifyComponents(ctx: FrameworkOperationContextV1): FrameworkComponentsV1;
  hookInventory(ctx: FrameworkOperationContextV1): FrameworkHookInventoryV1;
  planHookControls(
    ctx: FrameworkOperationContextV1,
    request: FrameworkHookControlRequestV1,
  ): FrameworkHookControlPlanV1;
  /** Keyed by the Core command paths in {@link FRAMEWORK_PLUGIN_COMMANDS}. */
  readonly commands: Readonly<Record<string, FrameworkCommandV1>>;
  readonly receipts?: readonly FrameworkReceiptV1[];
  readonly policyDelivery?: FrameworkPolicyDeliveryHookV1;
  readonly capabilityPackages?: FrameworkCapabilityPackagesHookV1;
  readonly uninstall?: FrameworkUninstallHookV1;
  readonly prune?: FrameworkPruneHookV1;
  readonly doctor?: FrameworkDoctorHookV1;
  readonly report?: FrameworkReportHookV1;
}
