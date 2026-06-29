export { AIH_ORG_POLICY_FILE } from "../org-policy/constants.js";

import { orgPolicyPath, readOrgPolicy } from "../org-policy/schema.js";
import type { AihConfig } from "./marker.js";
import { readAihConfig } from "./marker.js";

export type Posture = "vibe" | "team" | "enterprise";
export type PostureSource = "flag" | "marker" | "env" | "default" | "org-floor";
export type PolicyVerdict = "allow" | "warn" | "deny";
export type GovernanceControl =
  | "secrets"
  | "path-portability"
  | "command-policy"
  | "risk-gates"
  | "mcp"
  | "ca-trust"
  | "verify";

export interface ResolvedPosture {
  posture: Posture;
  postureSource: PostureSource;
}

interface OrgPolicyFloor {
  minimumPosture: Posture;
  contractRef?: string;
  path: string;
}

interface ResolvePostureInput {
  root: string;
  env: NodeJS.ProcessEnv;
  flag?: unknown;
  flagSource?: string;
  marker?: AihConfig;
}

const POSTURE_RANK: Record<Posture, number> = { vibe: 0, team: 1, enterprise: 2 };

/** Coerce legacy/community input into the v2 three-valued posture dial. */
export function asPosture(value: unknown): Posture {
  if (value === "enterprise") return "enterprise";
  if (value === "team") return "team";
  return "vibe";
}

function stronger(a: Posture, b: Posture): Posture {
  return POSTURE_RANK[a] >= POSTURE_RANK[b] ? a : b;
}

/**
 * The posture spine reads the org floor through the authoritative org-policy
 * schema/path resolver, so malformed policy files fail closed and AIH_ORG_POLICY
 * uses the same env-exclusive precedence as the full org-policy projection.
 */
export function readOrgPolicyFloor(
  root: string,
  env: NodeJS.ProcessEnv,
): OrgPolicyFloor | undefined {
  const policy = readOrgPolicy(root, env);
  if (policy === undefined) return undefined;
  return {
    minimumPosture: policy.minimumPosture,
    contractRef: policy.references.repoContract,
    path: orgPolicyPath(root, env),
  };
}

export function resolvePosture(input: ResolvePostureInput): ResolvedPosture {
  const marker = input.marker ?? readAihConfig(input.root);
  let resolved: ResolvedPosture;
  if (input.flagSource === "cli") {
    resolved = { posture: asPosture(input.flag), postureSource: "flag" };
  } else if (marker?.posture !== undefined) {
    resolved = { posture: marker.posture, postureSource: "marker" };
  } else if (input.env.AIH_POSTURE !== undefined) {
    resolved = { posture: asPosture(input.env.AIH_POSTURE), postureSource: "env" };
  } else {
    resolved = { posture: "vibe", postureSource: "default" };
  }

  const floor = readOrgPolicyFloor(input.root, input.env);
  if (floor !== undefined) {
    const clamped = stronger(resolved.posture, floor.minimumPosture);
    if (POSTURE_RANK[floor.minimumPosture] >= POSTURE_RANK[resolved.posture]) {
      return { posture: clamped, postureSource: "org-floor" };
    }
  }
  return resolved;
}

/**
 * Convert a control finding into the active posture's governance verdict. `risk-gates`
 * deliberately stays advisory/ask even at enterprise; aih never upgrades it to a
 * deny because the consuming CLI owns the ask-at-runtime seam.
 */
export function gradeVerdict(
  finding: PolicyVerdict,
  control: GovernanceControl,
  posture: Posture,
): PolicyVerdict {
  if (finding === "allow") return "allow";
  if (control === "risk-gates") return "warn";
  if (posture === "vibe") return "warn";
  if (posture === "team") {
    return control === "secrets" || control === "path-portability" ? "deny" : "warn";
  }
  return "deny";
}
