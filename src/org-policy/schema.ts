/**
 * The Node loader for the canonical organization policy.
 *
 * The grammar itself is `./schema-core.js` and is pure; this file adds reading
 * a policy from disk under the product's file-custody rules. It re-exports the
 * whole grammar, so `./schema.js` remains the one import path every Node caller
 * already uses.
 */
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseNativeStrictJsonObjectV1 } from "../contract/native-strict-json-object-v1.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import { AIH_ORG_POLICY_FILE } from "./constants.js";
import {
  governanceOwnsAihSurfaces,
  MAX_ORG_POLICY_BYTES,
  type OrgPolicy,
  OrgPolicyError,
  parseOrgPolicy,
  parsePolicyBundle,
} from "./schema-core.js";

export * from "./schema-core.js";

/**
 * A governed inventory is the sole authority for AIH-owned MCP and hook
 * mutations. Generic commands must not union legacy selections into it.
 */
export function assertGovernanceOwnsSurface(ctx: PlanContext, surface: "mcp" | "usage"): void {
  const policy = readOrgPolicy(ctx.root, ctx.env);
  if (!governanceOwnsAihSurfaces(policy)) return;
  throw new OrgPolicyError(
    `governance exclusively owns AIH ${surface} projection; use \`aih policy project\` to evaluate and apply the verified policy`,
  );
}

function modulePolicyFormatMessage(path: string, raw: string): string | undefined {
  const trimmed = raw.trimStart();
  if (
    trimmed.startsWith("export default") ||
    trimmed.startsWith("export const") ||
    trimmed.startsWith("module.exports") ||
    trimmed.startsWith("exports.")
  ) {
    return (
      `aih-org-policy could not be read from ${path}: org-policy sources are JSON-only. ` +
      `JavaScript/module policy files are not executed; write ${AIH_ORG_POLICY_FILE} or point ` +
      `AIH_ORG_POLICY at a JSON policy file.`
    );
  }
  return undefined;
}

export function orgPolicyPath(root: string, env: NodeJS.ProcessEnv): string {
  if (hasExplicitOrgPolicySource(env)) {
    return resolve(root, (env.AIH_ORG_POLICY as string).trim());
  }
  return join(root, AIH_ORG_POLICY_FILE);
}

/** Did the operator explicitly name a policy file, rather than relying on the repo default? */
export function hasExplicitOrgPolicySource(env: NodeJS.ProcessEnv): boolean {
  return typeof env.AIH_ORG_POLICY === "string" && env.AIH_ORG_POLICY.trim().length > 0;
}

export function readOrgPolicy(root: string, env: NodeJS.ProcessEnv): OrgPolicy | undefined {
  const path = orgPolicyPath(root, env);
  const opened = readRegularFileWithStats(path, { maxBytes: MAX_ORG_POLICY_BYTES });
  if (opened === undefined) {
    let pathExists = false;
    try {
      lstatSync(path);
      pathExists = true;
    } catch {
      // The missing-path behavior below remains distinct from unsafe custody.
    }
    if (pathExists) {
      throw new OrgPolicyError(
        `aih-org-policy at ${path} is not a safe regular file within the ` +
          `${MAX_ORG_POLICY_BYTES.toLocaleString("en-US")}-byte safety limit`,
      );
    }
    // Absence of the DEFAULT repo file is optional harness state — vibe repos carry no
    // org policy — so it stays an honest `undefined` that callers report as a skip. An
    // explicit AIH_ORG_POLICY is a different claim: the operator named a file and
    // asserted it exists, exactly as `--bundle` does. Collapsing the two made a typo'd or
    // moved path indistinguishable from "no policy", silently dropping the org posture
    // floor, the governed inventory, and every gate keyed off them, while `policy
    // validate` reported a clean skip. Fail closed on the broken control plane instead.
    if (hasExplicitOrgPolicySource(env)) {
      throw new OrgPolicyError(
        `AIH_ORG_POLICY points at ${path}, but no policy file exists there. An explicitly ` +
          `configured org policy must resolve — fix the path, or unset AIH_ORG_POLICY to use ` +
          `${AIH_ORG_POLICY_FILE} when the repo carries one.`,
      );
    }
    return undefined;
  }
  return parseOrgPolicyContents(path, opened.contents);
}

/**
 * Parse org-policy bytes already read under the product's file-custody rules.
 * `readOrgPolicy` and callers that must digest and parse the SAME bytes (the
 * Workbench user door's bound policy) share this one decoder.
 */
export function parseOrgPolicyContents(path: string, contents: Buffer): OrgPolicy {
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new OrgPolicyError(`aih-org-policy at ${path} is not valid UTF-8`);
  }
  try {
    const parsed: unknown = parseNativeStrictJsonObjectV1(raw, "organization policy");
    const bundleLike =
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (Object.hasOwn(parsed, "bundleVersion") || Object.hasOwn(parsed, "policy"));
    if (bundleLike) {
      const bundle = parsePolicyBundle(parsed);
      if (!bundle.ok) {
        throw new OrgPolicyError(`active policy bundle is invalid: ${bundle.error}`);
      }
      return bundle.bundle.policy as OrgPolicy;
    }
    return parseOrgPolicy(parsed);
  } catch (err) {
    if (err instanceof OrgPolicyError) throw err;
    const moduleMessage = modulePolicyFormatMessage(path, raw);
    if (moduleMessage !== undefined) throw new OrgPolicyError(moduleMessage);
    throw new OrgPolicyError(
      `aih-org-policy could not be read from ${path}: ${(err as Error).message}`,
    );
  }
}
