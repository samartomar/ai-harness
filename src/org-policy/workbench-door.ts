import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AIH_CONFIG_FILE } from "../config/marker.js";
import { readCurrentPolicyBindingSource } from "./binding.js";
import { AIH_ORG_POLICY_FILE } from "./constants.js";
import {
  hasExplicitOrgPolicySource,
  type OrgPolicy,
  OrgPolicyError,
  orgPolicyPath,
  parseOrgPolicyContents,
  readOrgPolicy,
} from "./schema.js";

/** A narrow project-scoped selection file (D5); presence-only check in this slice. */
const AIH_PROJECT_POLICY_FILE = "aih-project-policy.json";

export const WorkbenchDoorV1Schema = z.enum(["admin", "user", "chooser"]);
export type WorkbenchDoorV1 = z.infer<typeof WorkbenchDoorV1Schema>;

export const WorkbenchPolicySourceV1Schema = z
  .object({
    kind: z.enum(["flag", "env", "root", "binding", "none"]),
    path: z.string().min(1).optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    valid: z.boolean(),
    error: z.string().min(1).optional(),
  })
  .strict();
export type WorkbenchPolicySourceV1 = z.infer<typeof WorkbenchPolicySourceV1Schema>;

export interface WorkbenchDoorClassificationV1 {
  readonly door: WorkbenchDoorV1;
  readonly policySource: WorkbenchPolicySourceV1;
  /**
   * Only for a valid `binding` source: the org policy parsed from the exact
   * bytes whose SHA-256 is `policySource.sha256`.
   */
  readonly policy?: OrgPolicy;
}

function sha256OfFile(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    // A digest is best-effort context; a read failure here does not change the
    // fail-closed `valid` verdict already produced by the policy/marker reader.
    return undefined;
  }
}

function noneSource(): WorkbenchPolicySourceV1 {
  return { kind: "none", valid: true };
}

/**
 * Read-only classification of the folder the Workbench server was launched
 * from (`process.cwd()`, injected by the caller — never argv; `--ui` stays
 * exact argv). Never writes. Resolves the org policy the same way the product
 * does (`AIH_ORG_POLICY` → `<root>/aih-org-policy.json`, `schema.ts`'s own
 * lookup order) — no new lookup order is invented here. A `--policy` flag has
 * no bearing on `--ui`, so `kind: "flag"` is never produced by this function;
 * it exists in the type for a future caller that does have one.
 */
export function classifyWorkbenchDoorV1(
  root: string,
  env: NodeJS.ProcessEnv,
): WorkbenchDoorClassificationV1 {
  const explicitEnv = hasExplicitOrgPolicySource(env);
  const policyPath = orgPolicyPath(root, env);
  const kind: "env" | "root" = explicitEnv ? "env" : "root";
  try {
    const policy = readOrgPolicy(root, env);
    if (policy !== undefined) {
      return {
        door: "admin",
        policySource: { kind, path: policyPath, sha256: sha256OfFile(policyPath), valid: true },
      };
    }
    // No org policy at this root (only reachable for kind "root": an explicit
    // AIH_ORG_POLICY that resolves to nothing throws, handled below).
  } catch (error) {
    const message = error instanceof OrgPolicyError ? error.message : String(error);
    return {
      door: "admin",
      policySource: { kind, path: policyPath, valid: false, error: message },
    };
  }

  const bindingPath = join(root, AIH_CONFIG_FILE);
  try {
    // The product's own custody checks (active, same canonical root, safe
    // single-link bounded source, unchanged digest); digest and policy come
    // from the same bytes, so they cannot drift.
    const bound = readCurrentPolicyBindingSource(root);
    if (bound !== undefined) {
      const path = bound.binding.source.path;
      return {
        door: "user",
        policySource: { kind: "binding", path, sha256: bound.sha256, valid: true },
        policy: parseOrgPolicyContents(path, bound.contents),
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      door: "user",
      policySource: { kind: "binding", path: bindingPath, valid: false, error: message },
    };
  }

  if (existsSync(join(root, AIH_PROJECT_POLICY_FILE))) {
    // A selection file without a binding has no org policy to narrow, so the
    // project page fails closed: it explains the gap and keeps Save disabled.
    return {
      door: "user",
      policySource: {
        kind: "none",
        valid: false,
        error: `${AIH_PROJECT_POLICY_FILE} is present but this project has no org policy binding in ${AIH_CONFIG_FILE}.`,
      },
    };
  }

  return { door: "chooser", policySource: noneSource() };
}

export { AIH_ORG_POLICY_FILE, AIH_PROJECT_POLICY_FILE };
