import { isAbsolute, join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { type CommandSpec, type Plan, type PlanContext, plan, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { parsePolicyBundle } from "./bundle.js";
import { AIH_ORG_POLICY_FILE } from "./constants.js";
import { readOrgPolicy } from "./schema.js";

/**
 * `aih policy validate` — the READ-ONLY schema gate over the org policy, in
 * both of its forms: the LOCAL `aih-org-policy.json` (honoring the
 * `AIH_ORG_POLICY` env override, exactly like every other consumer of
 * `readOrgPolicy`) and, under `--bundle <path>`, a distributable policy-bundle
 * ENVELOPE (`src/org-policy/bundle.ts`). Probes only, pure fs at plan time
 * (#35) — the `verify-bundle` shape.
 *
 * The two forms fail differently on ABSENCE by design: the local file is
 * optional harness state (vibe repos carry no org policy), so a missing file
 * is a friendly `skip`, never a failure — while `--bundle` names an explicit
 * file the operator asked about, so a missing bundle is a coded FAIL. Parse
 * and schema failures are coded findings in both forms
 * (`org-policy.invalid` / `org-policy.bundle-invalid`), and the bundle detail
 * names WHICH layer failed — the envelope, or the embedded org policy — via
 * `parsePolicyBundle`'s layer attribution.
 */

function optionString(ctx: PlanContext, key: string): string | undefined {
  const raw = ctx.options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** The check's file label: the env override when set, else the canonical name. */
function localPolicyUri(env: NodeJS.ProcessEnv): string {
  const override = env.AIH_ORG_POLICY?.trim();
  return override !== undefined && override.length > 0
    ? override.replace(/\\/g, "/")
    : AIH_ORG_POLICY_FILE;
}

/**
 * Grade the local `aih-org-policy.json`. `readOrgPolicy` already folds JSON
 * and schema failures into one `OrgPolicyError` whose message lists the zod
 * issues — that message IS the finding detail, never re-derived here.
 */
function localPolicyCheck(ctx: PlanContext): Check {
  const uri = localPolicyUri(ctx.env);
  try {
    const policy = readOrgPolicy(ctx.root, ctx.env);
    if (policy === undefined) {
      return {
        name: "org policy schema",
        verdict: "skip",
        detail: `no ${uri} in this repo — absence is not a failure (vibe repos carry no org policy)`,
      };
    }
    const blocks = (["command", "riskGates", "licenses", "mcp", "trust"] as const).filter(
      (key) => policy[key] !== undefined,
    );
    return {
      name: "org policy schema",
      verdict: "pass",
      detail:
        `${uri} parses · minimumPosture ${policy.minimumPosture}` +
        (blocks.length > 0 ? ` · policy blocks: ${blocks.join(", ")}` : ""),
    };
  } catch (err) {
    return {
      name: "org policy schema",
      verdict: "fail",
      code: "org-policy.invalid",
      detail: (err as Error).message,
      location: { uri },
      fingerprint: "org-policy-invalid",
    };
  }
}

/** Grade a policy-bundle envelope file (repo-relative or absolute `--bundle` path). */
function bundlePolicyCheck(ctx: PlanContext, bundlePath: string): Check {
  const uri = bundlePath.replace(/\\/g, "/");
  const fail = (detail: string): Check => ({
    name: "policy bundle schema",
    verdict: "fail",
    code: "org-policy.bundle-invalid",
    detail,
    location: { uri },
    fingerprint: `org-policy-bundle-invalid:${uri}`,
  });
  const abs = isAbsolute(bundlePath) ? bundlePath : join(ctx.root, bundlePath);
  const raw = readIfExists(abs);
  if (raw === undefined) {
    return fail(
      `policy bundle not found at ${uri} — --bundle names an explicit file, so absence is an ` +
        `operator error (unlike the local ${AIH_ORG_POLICY_FILE}, whose absence is a skip)`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(`${uri} is not valid JSON`);
  }
  const result = parsePolicyBundle(parsed);
  if (!result.ok) return fail(`${uri}: ${result.error}`);
  const bundle = result.bundle;
  return {
    name: "policy bundle schema",
    verdict: "pass",
    detail:
      `bundle ${bundle.bundleVersion} from ${bundle.issuer} parses · ` +
      `embedded policy minimumPosture ${bundle.policy.minimumPosture}` +
      (bundle.rings !== undefined ? ` · ${bundle.rings.length} ring(s)` : ""),
  };
}

function policyValidatePlan(ctx: PlanContext): Plan {
  const bundlePath = optionString(ctx, "bundle");
  if (bundlePath !== undefined) {
    return plan(
      "policy validate",
      probe("policy bundle schema", (c) => bundlePolicyCheck(c, bundlePath)),
    );
  }
  return plan(
    "policy validate",
    probe("org policy schema", (c) => localPolicyCheck(c)),
  );
}

export const policyValidateCommand: CommandSpec = {
  name: "validate",
  summary:
    "Validate the local aih-org-policy.json — or a policy-bundle envelope — against its schema (read-only gate)",
  readOnly: true,
  options: [
    {
      flags: "--bundle <path>",
      description:
        "validate a policy-bundle envelope file instead of the local aih-org-policy.json",
    },
  ],
  plan: policyValidatePlan,
};
