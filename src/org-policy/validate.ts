import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { type CommandSpec, type Plan, type PlanContext, plan, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { parsePolicyBundle } from "./bundle.js";
import { AIH_ORG_POLICY_FILE } from "./constants.js";
import { sameJson } from "./drift.js";
import { orgPolicyPath, readOrgPolicy } from "./schema.js";

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

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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

function localPolicyRaw(ctx: PlanContext): { raw: string; uri: string } | undefined {
  const raw = readIfExists(orgPolicyPath(ctx.root, ctx.env));
  if (raw === undefined) return undefined;
  return { raw, uri: localPolicyUri(ctx.env) };
}

function failPin(detail: string, uri = AIH_ORG_POLICY_FILE): Check {
  return {
    name: "org policy pin",
    verdict: "fail",
    code: "org-policy.drift",
    detail,
    location: { uri },
    fingerprint: "org-policy-pin",
  };
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function verifyAgainstHash(ctx: PlanContext, expected: string): Check {
  const local = localPolicyRaw(ctx);
  if (local === undefined) {
    return failPin(`no active org policy found to compare with pinned hash ${expected}`);
  }
  const actual = sha256(local.raw);
  if (actual.toLowerCase() === expected.toLowerCase()) {
    return {
      name: "org policy pin",
      verdict: "pass",
      detail: `${local.uri} matches pinned sha256 ${expected.toLowerCase()}`,
    };
  }
  return failPin(
    `${local.uri} sha256 mismatch: expected ${expected.toLowerCase()}, got ${actual}`,
    local.uri,
  );
}

function verifyAgainstFleetBundle(ctx: PlanContext, dir: string): Check | undefined {
  if (!isDir(dir)) return undefined;
  const local = localPolicyRaw(ctx);
  if (local === undefined) {
    return failPin(`no active org policy found to compare with bundle ${dir}`);
  }
  const bundled = readIfExists(join(dir, "files", AIH_ORG_POLICY_FILE));
  if (bundled === undefined) {
    return failPin(
      `bundle ${dir} does not contain files/${AIH_ORG_POLICY_FILE}; run aih bundle/evidence with the policy included`,
    );
  }
  const expected = sha256(bundled);
  const actual = sha256(local.raw);
  if (actual === expected) {
    return {
      name: "org policy pin",
      verdict: "pass",
      detail: `${local.uri} matches bundled files/${AIH_ORG_POLICY_FILE} (${actual.slice(0, 12)}...)`,
    };
  }
  return failPin(
    `${local.uri} differs from bundled files/${AIH_ORG_POLICY_FILE} (` +
      `local ${actual.slice(0, 12)}..., bundle ${expected.slice(0, 12)}...)`,
    local.uri,
  );
}

function verifyAgainstPolicyBundle(ctx: PlanContext, bundlePath: string): Check {
  const local = localPolicyRaw(ctx);
  if (local === undefined) {
    return failPin(`no active org policy found to compare with policy bundle ${bundlePath}`);
  }
  const raw = readIfExists(bundlePath);
  if (raw === undefined) {
    return failPin(`--against target not found: ${bundlePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      name: "org policy pin",
      verdict: "fail",
      code: "org-policy.bundle-invalid",
      detail: `${bundlePath} is not valid JSON`,
      location: { uri: bundlePath.replace(/\\/g, "/") },
      fingerprint: "org-policy-pin:bundle-invalid",
    };
  }
  const bundle = parsePolicyBundle(parsed);
  if (!bundle.ok) {
    return {
      name: "org policy pin",
      verdict: "fail",
      code: "org-policy.bundle-invalid",
      detail: `${bundlePath}: ${bundle.error}`,
      location: { uri: bundlePath.replace(/\\/g, "/") },
      fingerprint: "org-policy-pin:bundle-invalid",
    };
  }
  let localPolicy: ReturnType<typeof readOrgPolicy>;
  try {
    localPolicy = readOrgPolicy(ctx.root, ctx.env);
  } catch (err) {
    return {
      name: "org policy pin",
      verdict: "fail",
      code: "org-policy.invalid",
      detail: (err as Error).message,
      location: { uri: local.uri },
      fingerprint: "org-policy-pin:local-invalid",
    };
  }
  if (localPolicy !== undefined && sameJson(localPolicy, bundle.bundle.policy)) {
    return {
      name: "org policy pin",
      verdict: "pass",
      detail: `${local.uri} semantically matches policy bundle ${bundle.bundle.bundleVersion} from ${bundle.bundle.issuer}`,
    };
  }
  return failPin(
    `${local.uri} does not match policy bundle ${bundle.bundle.bundleVersion} from ${bundle.bundle.issuer}`,
    local.uri,
  );
}

function policyVerifyCheck(ctx: PlanContext, against: string | undefined): Check {
  if (against === undefined) {
    return failPin("policy verify requires --against <sha256|bundle>");
  }
  if (isSha256(against)) return verifyAgainstHash(ctx, against);
  const abs = isAbsolute(against) ? against : join(ctx.root, against);
  return verifyAgainstFleetBundle(ctx, abs) ?? verifyAgainstPolicyBundle(ctx, abs);
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

function policyVerifyPlan(ctx: PlanContext): Plan {
  const against = optionString(ctx, "against");
  return plan(
    "policy verify",
    probe("org policy pin", (c) => policyVerifyCheck(c, against)),
  );
}

export const policyValidateCommand: CommandSpec = {
  name: "validate",
  summary:
    "Validate the local aih-org-policy.json — or a policy-bundle envelope — against its schema (read-only gate)",
  readOnly: true,
  skipOrgPolicyFloor: true,
  options: [
    {
      flags: "--bundle <path>",
      description:
        "validate a policy-bundle envelope file instead of the local aih-org-policy.json",
    },
  ],
  plan: policyValidatePlan,
};

export const policyVerifyCommand: CommandSpec = {
  name: "verify",
  summary: "Verify the active org policy against a pinned sha256, policy bundle, or fleet bundle",
  readOnly: true,
  options: [
    {
      flags: "--against <sha256|bundle>",
      description:
        "expected policy sha256, policy-bundle JSON file, or bundle directory containing files/aih-org-policy.json",
    },
  ],
  plan: policyVerifyPlan,
};
