import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  AIH_CONFIG_FILE,
  type PolicyBinding,
  PolicyBindingSchema,
  readAihConfig,
  readPolicyBinding,
} from "../config/marker.js";
import { readEccMaterializationReceipt } from "../ecc/materialization-receipt.js";
import { AihError, SettingsError } from "../errors.js";
import type { Cli } from "../internals/clis.js";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import {
  type CommandSpec,
  type FileAssertion,
  type Plan,
  plan,
  writeJson,
} from "../internals/plan.js";
import { hasCommandPermissionOwnership } from "./command-permissions.js";
import { verifiedOrgPolicyTargets } from "./project.js";
import { inspectPolicyRequiredGuidance } from "./required-guidance.js";
import { MAX_ORG_POLICY_BYTES, orgPolicyPath } from "./schema.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const MAX_POLICY_BINDING_MARKER_BYTES = 4 * 1024 * 1024;

function policyBindingMarkerExpectation(root: string): { absent: true } | { sha256: string } {
  const inspected = inspectContainedRelativePath(root, AIH_CONFIG_FILE);
  if (inspected.state === "absent") return { absent: true };
  if (inspected.state === "unsafe" || inspected.kind !== "file") {
    throw new AihError("project policy binding marker is not a safe regular file", "AIH_TRUST");
  }
  const opened = readRegularFileWithStats(inspected.realPath, {
    maxBytes: MAX_POLICY_BINDING_MARKER_BYTES,
  });
  if (opened === undefined || opened.identity.nlink !== 1n) {
    throw new AihError(
      "project policy binding marker is not a safe bounded single-link regular file",
      "AIH_TRUST",
    );
  }
  return { sha256: sha256(opened.contents) };
}

/** Commit-time pin for the exact marker observation that carried the binding. */
export function policyBindingFileAssertion(root: string): FileAssertion | undefined {
  if (readPolicyBinding(root) === undefined) return undefined;
  const expected = policyBindingMarkerExpectation(root);
  if ("absent" in expected) {
    throw new AihError("project policy binding disappeared during inspection", "AIH_TRUST");
  }
  return {
    path: AIH_CONFIG_FILE,
    sha256: expected.sha256,
    maxBytes: MAX_POLICY_BINDING_MARKER_BYTES,
    describe: "durable project policy binding marker",
  };
}

/** Carry an earlier binding observation through an asynchronous plan build to commit. */
export function withPolicyBindingFileAssertion(
  body: Plan,
  assertion: FileAssertion | undefined,
): Plan {
  if (assertion === undefined) return body;
  const isMarkerPath = (path: string) =>
    path.replace(/\\/g, "/").replace(/^\.\//, "") === AIH_CONFIG_FILE;
  const markerWrites = body.actions.filter(
    (action) => action.kind === "write" && isMarkerPath(action.path),
  );
  const existingMarkerAssertions = (body.fileAssertions ?? []).filter((item) =>
    isMarkerPath(item.path),
  );
  for (const existing of existingMarkerAssertions) {
    if (existing.sha256 !== assertion.sha256) {
      throw new AihError("conflicting project policy binding assertions in one plan", "AIH_TRUST");
    }
  }
  if (markerWrites.length > 1) {
    throw new AihError("multiple project policy binding writes in one plan", "AIH_CONFIG");
  }
  const markerWrite = markerWrites[0];
  if (markerWrite !== undefined && markerWrite.kind === "write") {
    if (
      markerWrite.expect !== undefined &&
      (!("sha256" in markerWrite.expect) || markerWrite.expect.sha256 !== assertion.sha256)
    ) {
      throw new AihError(
        "project policy binding write has a conflicting apply-time expectation",
        "AIH_TRUST",
      );
    }
    const actions = body.actions.map((action) =>
      action === markerWrite ? { ...markerWrite, expect: { sha256: assertion.sha256 } } : action,
    );
    const fileAssertions = (body.fileAssertions ?? []).filter((item) => !isMarkerPath(item.path));
    return {
      ...body,
      actions,
      ...(fileAssertions.length === 0 ? { fileAssertions: undefined } : { fileAssertions }),
    };
  }
  if (existingMarkerAssertions.length > 0) return body;
  return {
    ...body,
    fileAssertions: [...(body.fileAssertions ?? []), assertion],
  };
}

export function policyRootSha256(canonicalRoot: string): string {
  const normalized = canonicalRoot.replace(/\\/g, "/");
  return sha256(
    `aih-policy-root-v1\0${process.platform === "win32" ? normalized.toLowerCase() : normalized}`,
  );
}

function canonical(path: string): string {
  return realpathSync.native(resolve(path));
}

function readBoundSource(path: string): { contents: Buffer; sha256: string } {
  const opened = readRegularFileWithStats(path, { maxBytes: MAX_ORG_POLICY_BYTES });
  if (opened === undefined || opened.identity.nlink !== 1n) {
    throw new AihError(
      "bound policy source is not a safe bounded single-link regular file",
      "AIH_ORG_POLICY",
    );
  }
  return { contents: opened.contents, sha256: sha256(opened.contents) };
}

function sourceDigest(path: string): string {
  return readBoundSource(path).sha256;
}

const BOUND_SOURCE_DIGEST_CHANGED =
  "bound policy source digest changed; review the policy and run policy rebind before material mutation";

function assertBindingActiveAtRoot(root: string, binding: PolicyBinding): void {
  if (binding.state === "revoked") {
    throw new AihError(
      `project policy binding for ${binding.projectId} is revoked; use policy rebind with verified authority to recover`,
      "AIH_ORG_POLICY",
    );
  }
  const actualRoot = policyRootSha256(canonical(root));
  if (actualRoot !== binding.rootSha256) {
    throw new AihError(
      `project policy binding belongs to a different canonical root; use policy rebind for ${binding.projectId} to adopt this checkout`,
      "AIH_ORG_POLICY",
    );
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    let resolved = resolve(value);
    try {
      resolved = realpathSync.native(resolved);
    } catch {
      // A missing explicit source still compares by its requested absolute path
      // so the binding conflict is reported before any attempted source read.
    }
    const normalized = resolved.replace(/\\/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function selectedPolicyPath(root: string, env: NodeJS.ProcessEnv): string {
  return canonical(orgPolicyPath(root, env));
}

function sameTargets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function assertPolicyBindingCurrent(
  root: string,
  env: NodeJS.ProcessEnv,
  targets?: readonly Cli[],
  options: { requireIfOwned?: boolean } = {},
): PolicyBinding | undefined {
  const binding = readPolicyBinding(root);
  if (binding === undefined) {
    if (
      options.requireIfOwned === true &&
      (readEccMaterializationReceipt(root).state !== "absent" ||
        inspectPolicyRequiredGuidance(root, readAihConfig(root)?.contextDir ?? "ai-coding")
          .state !== "absent" ||
        hasCommandPermissionOwnership(root))
    ) {
      throw new AihError(
        "governed policy ownership remains but the project policy binding is missing; bind the verified authority before material mutation",
        "AIH_ORG_POLICY",
      );
    }
    return undefined;
  }
  assertBindingActiveAtRoot(root, binding);
  const requestedSource = orgPolicyPath(root, env);
  if (!samePath(requestedSource, binding.source.path)) {
    throw new AihError(
      "selected policy source conflicts with this project's committed policy binding",
      "AIH_ORG_POLICY",
    );
  }
  const selected = selectedPolicyPath(root, env);
  if (sourceDigest(selected) !== binding.source.sha256) {
    throw new AihError(BOUND_SOURCE_DIGEST_CHANGED, "AIH_ORG_POLICY");
  }
  if (targets !== undefined && !sameTargets([...targets].sort(), [...binding.targets].sort())) {
    throw new AihError(
      `selected targets conflict with the committed policy binding (bound: ${binding.targets.join(", ")})`,
      "AIH_ORG_POLICY",
    );
  }
  return binding;
}

/**
 * Read-only: the bound policy source bytes for a project whose binding is
 * current (active, same canonical root, digest unchanged), using the exact
 * checks {@link assertPolicyBindingCurrent} applies with the binding's own
 * source selected (as {@link applyPolicyBindingDefaults} selects it). The
 * digest is of the returned `contents`, so a caller parsing those bytes cannot
 * drift from the digest. Returns undefined when the project has no binding.
 */
export function readCurrentPolicyBindingSource(
  root: string,
): { binding: PolicyBinding; contents: Buffer; sha256: string } | undefined {
  const binding = readPolicyBinding(root);
  if (binding === undefined) return undefined;
  assertBindingActiveAtRoot(root, binding);
  const selected = selectedPolicyPath(root, { AIH_ORG_POLICY: binding.source.path });
  const source = readBoundSource(selected);
  if (source.sha256 !== binding.source.sha256) {
    throw new AihError(BOUND_SOURCE_DIGEST_CHANGED, "AIH_ORG_POLICY");
  }
  return { binding, contents: source.contents, sha256: source.sha256 };
}

/** Restore the durable source/target selection for a fresh process. */
export function applyPolicyBindingDefaults(
  root: string,
  env: NodeJS.ProcessEnv,
  options: Record<string, unknown>,
): { env: NodeJS.ProcessEnv; targets?: Cli[] } {
  const binding = readPolicyBinding(root);
  if (binding === undefined) return { env };
  const selected = env.AIH_ORG_POLICY?.trim();
  const nextEnv =
    selected === undefined || selected === ""
      ? { ...env, AIH_ORG_POLICY: binding.source.path }
      : env;
  const hasTargetOverride =
    (typeof options.cli === "string" && options.cli.trim() !== "") ||
    options.allTools === true ||
    options.detect === true;
  return {
    env: nextEnv,
    ...(hasTargetOverride ? {} : { targets: [...binding.targets] as Cli[] }),
  };
}

/**
 * Preserve valid binding defaults for Governance Doctor while allowing that
 * read-only diagnostic to reach its own malformed-marker probes. Only the
 * strict policyBinding parser's bounded diagnostic is tolerated; filesystem
 * failures and every other settings or authority error still propagate.
 */
export function applyPolicyBindingReadOnlyDiagnosticDefaults(
  root: string,
  env: NodeJS.ProcessEnv,
  options: Record<string, unknown>,
): { env: NodeJS.ProcessEnv; targets?: Cli[] } {
  try {
    return applyPolicyBindingDefaults(root, env, options);
  } catch (error) {
    if (
      error instanceof SettingsError &&
      error.message.startsWith(`invalid policyBinding in ${AIH_CONFIG_FILE}:`)
    ) {
      return { env };
    }
    throw error;
  }
}

type BindingMode = "bind" | "rebind" | "revoke";

function projectId(options: Record<string, unknown>): string {
  const parsed = PolicyBindingSchema.shape.projectId.safeParse(options.project);
  if (!parsed.success) {
    throw new AihError(
      "policy binding requires --project <id> (lowercase letters, digits, and hyphens)",
      "AIH_CONFIG",
    );
  }
  return parsed.data;
}

function bindingPlanWithPins(
  body: Plan,
  pins: Pick<Plan, "fileAssertions" | "commitNotAfter" | "commitLock">,
): Plan {
  return {
    ...body,
    ...(pins.fileAssertions === undefined ? {} : { fileAssertions: pins.fileAssertions }),
    ...(pins.commitNotAfter === undefined ? {} : { commitNotAfter: pins.commitNotAfter }),
    ...(pins.commitLock === undefined ? {} : { commitLock: pins.commitLock }),
  };
}

async function bindingPlan(
  ctx: import("../internals/plan.js").PlanContext,
  mode: BindingMode,
): Promise<Plan> {
  const markerExpectation = policyBindingMarkerExpectation(ctx.root);
  const existing = readPolicyBinding(ctx.root);
  const id = projectId(ctx.options);
  if (mode === "bind" && existing !== undefined) {
    throw new AihError(
      `project is already bound to ${existing.projectId}; use policy rebind`,
      "AIH_CONFIG",
    );
  }
  if (mode !== "bind") {
    if (existing === undefined)
      throw new AihError("project has no committed policy binding", "AIH_CONFIG");
    if (existing.projectId !== id) {
      throw new AihError(
        `policy binding belongs to ${existing.projectId}; --project must match`,
        "AIH_CONFIG",
      );
    }
  }
  if (mode === "revoke") {
    if (existing?.state === "revoked")
      throw new AihError("project policy binding is already revoked", "AIH_CONFIG");
    assertPolicyBindingCurrent(ctx.root, ctx.env, existing?.targets as Cli[]);
    return plan(
      "policy revoke",
      writeJson(
        AIH_CONFIG_FILE,
        { policyBinding: { ...existing, state: "revoked" } },
        "retain revoked organization policy binding",
        {
          merge: true,
          replaceJsonKeys: ["policyBinding"],
          expect: markerExpectation,
        },
      ),
    );
  }
  if (typeof ctx.options.cli !== "string" || ctx.options.cli.trim() === "") {
    throw new AihError("policy binding requires an explicit --cli target list", "AIH_CONFIG");
  }
  const verified = await verifiedOrgPolicyTargets(ctx);
  const targets = verified.resolution.clis;
  const sourcePath = selectedPolicyPath(ctx.root, ctx.env);
  const next: PolicyBinding = PolicyBindingSchema.parse({
    schemaVersion: 1,
    state: "active",
    projectId: id,
    rootSha256: policyRootSha256(canonical(ctx.root)),
    source: { path: sourcePath, sha256: sourceDigest(sourcePath) },
    targets,
  });
  const sourceRelative = relative(ctx.root, sourcePath);
  const insideRoot =
    sourceRelative !== "" && !sourceRelative.startsWith("..") && !isAbsolute(sourceRelative);
  const localAssertion: FileAssertion[] = insideRoot
    ? [
        {
          path: sourceRelative.replace(/\\/g, "/"),
          sha256: next.source.sha256,
          maxBytes: MAX_ORG_POLICY_BYTES,
          describe: "bound organization policy source",
        },
      ]
    : [];
  const pins = {
    ...verified,
    fileAssertions: verified.fileAssertions ?? localAssertion,
  };
  const marker = readAihConfig(ctx.root);
  return bindingPlanWithPins(
    plan(
      `policy ${mode}`,
      writeJson(
        AIH_CONFIG_FILE,
        {
          schemaVersion: 1,
          contextDir: marker?.contextDir ?? ctx.contextDir,
          targets,
          policyBinding: next,
        },
        `${mode} organization policy to project`,
        {
          merge: true,
          replaceJsonKeys: ["targets", "policyBinding"],
          expect: markerExpectation,
        },
      ),
    ),
    pins,
  );
}

function command(mode: BindingMode, summary: string): CommandSpec {
  return {
    name: mode,
    summary,
    options: [{ flags: "--project <id>", description: "stable organization project identifier" }],
    plan: (ctx) => bindingPlan(ctx, mode),
  };
}

export const policyBindCommand = command(
  "bind",
  "Bind this canonical project root to an exact verified policy source and target set",
);
export const policyRebindCommand = command(
  "rebind",
  "Accept a reviewed policy update or recover the same project in a new canonical checkout",
);
export const policyRevokeCommand = command(
  "revoke",
  "Retain a fail-closed revoked project policy binding",
);
