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
export interface PolicyAuthoringVetFinding {
  code: string;
  count?: number;
  detail: string;
}
export interface PolicyAuthoringVet {
  /** Whether the vet reported findings: a label for the administrator, never a gate. */
  verdict: "no-findings" | "has-findings";
  treeSha256: string;
  analyzers: Array<{ name: string; version: string }>;
  findings: PolicyAuthoringVetFinding[];
  /** Problems with the evidence itself (a detector that did not run), kept apart from findings. */
  evidenceProblems: PolicyAuthoringVetFinding[];
}
export interface PolicyAuthoringAsset {
  kind: PolicyAuthoringAssetKind;
  id: string;
  curationKind?: "agent" | "skill" | "command";
  riders?: string[];
  dependencies?: string[];
  members?: string[];
  source: { repository: string; commit: string; path: string };
  sourcePaths: string[];
  /** Provider-declared host runtime identifier for MCP overlap advisory only. */
  runtimeIdentity?: string;
  vet?: PolicyAuthoringVet;
  metadata?: {
    title: string;
    summary: string;
    usageContext: string;
    allowedTools: readonly string[];
    sourcePath: string;
    sourceSha256: string;
  };
}
export interface PolicyAuthoringFramework {
  id: "ecc" | "superpowers";
  repository: string;
  commit: string;
  assets: PolicyAuthoringAsset[];
}
export interface PolicyAuthoringCompositionPart {
  id: string;
  label: string;
  rule: string;
  selection: "composed" | "additive";
  componentIds: string[];
}
export interface PolicyAuthoringComposition {
  framework: "ecc";
  parts: PolicyAuthoringCompositionPart[];
}
export interface AihPolicyControl {
  id: string;
  kind: "mcp" | "hook";
  source:
    | { type: "mcp"; server: string; subject: string }
    | { type: "hook"; handler: "usage-metering"; scriptDigest: string };
  targets: GovernedMcpTarget[];
  projector: "mcp-managed-settings" | "usage-hook";
  lifecycle: "supported";
}

export interface AihHookBehaviour {
  trigger: string;
  records: string;
  artifact: string;
  failureMode: string;
}

export type AihHookControl = AihPolicyControl & {
  source: Extract<AihPolicyControl["source"], { type: "hook" }>;
};

export interface PolicyAuthoringHook {
  id: string;
  description: string;
  behaviour: AihHookBehaviour;
  control: AihHookControl;
}

export interface AihCatalogContentPackV1 {
  id: string;
  pack: string;
  description: string;
  /** Concise authoring copy; not part of the capability declaration identity. */
  purpose?: string;
  skills: string[];
  sources: Array<{ skill: string; path: string; manifestIdentity: string }>;
}

/** First-party static content prepared from explicit package identity. */
export interface AihCatalogSourceV1 {
  aihCapabilityCatalog: {
    provider: "github";
    repository: "samartomar/aih-catalog";
  };
  aihCapabilityPackage: { name: string; version: string };
  aihSkills: AihCatalogContentPackV1[];
  aihAgents: AihCatalogContentPackV1[];
}

import type { GovernedMcpTarget } from "../internals/cli-registry.js";
