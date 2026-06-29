import { join, resolve } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import type { AihConfig } from "./marker.js";
import { readAihConfig } from "./marker.js";

export const AIH_ORG_POLICY_FILE = "aih-org-policy.json";

export type Posture = "vibe" | "team" | "enterprise";
export type PostureSource = "flag" | "marker" | "env" | "default" | "org-floor";
export type PolicyVerdict = "allow" | "warn" | "deny";
export type GovernanceControl =
  | "secrets"
  | "path-portability"
  | "command-policy"
  | "risk-gates"
  | "mcp"
  | "ca-drift"
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

function isPosture(value: unknown): value is Posture {
  return value === "vibe" || value === "team" || value === "enterprise";
}

function stronger(a: Posture, b: Posture): Posture {
  return POSTURE_RANK[a] >= POSTURE_RANK[b] ? a : b;
}

function orgPolicyPath(root: string, env: NodeJS.ProcessEnv): string[] {
  const paths = [join(root, AIH_ORG_POLICY_FILE)];
  if (env.AIH_ORG_POLICY && env.AIH_ORG_POLICY.trim().length > 0) {
    const p = env.AIH_ORG_POLICY.trim();
    paths.push(resolve(root, p));
  }
  return paths;
}

/**
 * P1 freezes the org-floor read seam without owning the full P2 schema. The file
 * can carry more fields, but this spine only reads `minimumPosture` and the
 * optional repo-contract reference used later for drift checks.
 */
export function readOrgPolicyFloor(
  root: string,
  env: NodeJS.ProcessEnv,
): OrgPolicyFloor | undefined {
  for (const path of orgPolicyPath(root, env)) {
    const raw = readIfExists(path);
    if (raw === undefined) continue;
    try {
      const parsed = JSON.parse(raw) as {
        minimumPosture?: unknown;
        references?: { repoContract?: unknown };
      };
      if (!isPosture(parsed.minimumPosture)) return undefined;
      return {
        minimumPosture: parsed.minimumPosture,
        contractRef:
          typeof parsed.references?.repoContract === "string"
            ? parsed.references.repoContract
            : undefined,
        path,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
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
    if (clamped !== resolved.posture) return { posture: clamped, postureSource: "org-floor" };
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
