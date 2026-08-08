import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { postureGradeCheck } from "../config/governance.js";
import { AIH_CONFIG_FILE } from "../config/marker.js";
import type { Posture } from "../config/posture.js";
import { isTargeted } from "../internals/cli-detect.js";
import { owningCli as registryOwningCli } from "../internals/cli-registry.js";
import type { Cli } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import { gitRead } from "../internals/git.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";
import {
  type DigestAction,
  digest,
  type PlanContext,
  type ProbeAction,
  probe,
  type WriteAction,
} from "../internals/plan.js";
import { ensureTrailingNewline } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import {
  type ManagedAllowlistGenerationDelta,
  managedAllowlistGenerationDelta,
  managedServerDisplayName,
} from "../mcp/allowlist.js";
import {
  MANAGED_MCP_PROJECTION_KEYS,
  MANAGED_SETTINGS_PATH,
  managedMcpProjectionOnDisk,
  occupied,
  unprovableResidueReason,
} from "../mcp/managed-projection.js";
import { AIH_ORG_POLICY_FILE } from "./constants.js";
import { orgPolicyProjectionActions, verifiedOrgPolicyProjectionActions } from "./project.js";
import { OrgPolicyError, orgPolicyPath, readOrgPolicy } from "./schema.js";

const POSTURE_RANK: Record<Posture, number> = { vibe: 0, enterprise: 1 };

function strongerPosture(a: Posture, b: Posture): Posture {
  return POSTURE_RANK[a] >= POSTURE_RANK[b] ? a : b;
}

export function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, stable(v)]),
  );
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function short(value: unknown): string {
  const rendered = JSON.stringify(value);
  if (rendered === undefined) return String(value);
  return rendered.length > 96 ? `${rendered.slice(0, 93)}...` : rendered;
}

function childPath(path: string, key: string): string {
  return path.length > 0 ? `${path}.${key}` : key;
}

export function missingProjectionParts(actual: unknown, expected: unknown, path = ""): string[] {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return [`${path || "root"} expected object`];
    const out: string[] = [];
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in actual)) {
        out.push(`${childPath(path, key)} missing`);
        continue;
      }
      out.push(...missingProjectionParts(actual[key], value, childPath(path, key)));
    }
    return out;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path || "root"} expected array`];
    return expected
      .filter((item) => !actual.some((candidate) => sameJson(candidate, item)))
      .map((item) => `${path || "root"} missing ${short(item)}`);
  }

  return sameJson(actual, expected)
    ? []
    : [`${path || "root"} expected ${short(expected)} but found ${short(actual)}`];
}

function exactProjectionParts(
  actual: unknown,
  expected: unknown,
  keys: WriteAction["replaceJsonKeys"],
): string[] {
  if (keys === undefined || !isPlainObject(expected) || !isPlainObject(actual)) return [];
  const out: string[] = [];
  for (const key of new Set(keys)) {
    if (!Object.hasOwn(expected, key)) continue;
    if (!Object.hasOwn(actual, key)) {
      out.push(`${key} missing`);
    } else if (!sameJson(actual[key], expected[key])) {
      out.push(`${key} expected ${short(expected[key])} but found ${short(actual[key])}`);
    }
  }
  return out;
}

function removedProjectionParts(
  actual: unknown,
  keys: WriteAction["removeJsonTopLevelKeys"],
): string[] {
  if (keys === undefined || !isPlainObject(actual)) return [];
  return [...new Set(keys)]
    .filter((key) => Object.hasOwn(actual, key))
    .map((key) => `${key} should be absent`);
}

function serverCommands(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[][] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return undefined;
    const command = (entry as { serverCommand?: unknown }).serverCommand;
    if (
      !Array.isArray(command) ||
      !command.every((arg): arg is string => typeof arg === "string")
    ) {
      return undefined;
    }
    out.push([...command]);
  }
  return out;
}

/**
 * True when some value BOTH sides carry differs (merge semantics: a key or
 * array item the file simply lacks is additive, not a mismatch). A mismatch is
 * a local edit no generation history explains, so attribution must refuse.
 */
function projectionValueMismatch(actual: unknown, expected: unknown): boolean {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return true;
    return Object.entries(expected).some(
      ([key, value]) => key in actual && projectionValueMismatch(actual[key], value),
    );
  }
  if (Array.isArray(expected)) return !Array.isArray(actual);
  return !sameJson(actual, expected);
}

interface ManagedSettingsGenerationDelta {
  allowlist: ManagedAllowlistGenerationDelta;
  missingParts: string[];
}

/**
 * #501 — attribute a managed-settings difference to aih's own generation
 * history: the on-disk managed MCP allowlist must consist entirely of current
 * or recognized previous-generation launch shapes (the positive fingerprint),
 * and every other difference must be purely additive (projection keys a newer
 * aih generates that the older generation never wrote). Any value both sides
 * carry that differs is a local edit and attribution refuses, keeping the
 * ordinary drift verdict.
 */
function managedSettingsGenerationDelta(
  actual: unknown,
  action: WriteAction,
): ManagedSettingsGenerationDelta | undefined {
  if (action.merge !== true || action.removeJsonTopLevelKeys !== undefined) return undefined;
  if (!isPlainObject(action.json) || !isPlainObject(actual)) return undefined;
  const replaceKeys = new Set(action.replaceJsonKeys ?? []);
  if (!MANAGED_MCP_PROJECTION_KEYS.every((key) => replaceKeys.has(key))) return undefined;
  const expected = action.json;
  if (actual.allowManagedMcpServersOnly !== expected.allowManagedMcpServersOnly) return undefined;
  const actualCommands = serverCommands(actual.allowedMcpServers);
  const expectedCommands = serverCommands(expected.allowedMcpServers);
  if (actualCommands === undefined || expectedCommands === undefined) return undefined;
  const allowlist = managedAllowlistGenerationDelta(actualCommands, expectedCommands);
  if (allowlist === undefined) return undefined;
  const withoutManagedKeys = (value: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(value).filter(
        ([key]) => !(MANAGED_MCP_PROJECTION_KEYS as readonly string[]).includes(key),
      ),
    );
  const expectedRest = withoutManagedKeys(expected);
  const actualRest = withoutManagedKeys(actual);
  if (projectionValueMismatch(actualRest, expectedRest)) return undefined;
  return { allowlist, missingParts: missingProjectionParts(actualRest, expectedRest) };
}

function generationDeltaCheck(
  action: WriteAction,
  generation: ManagedSettingsGenerationDelta,
  posture: Posture,
): Check {
  const count = generation.allowlist.previous.length;
  const names = [
    ...new Set(
      generation.allowlist.previous.map((pair) => managedServerDisplayName(pair.expected)),
    ),
  ];
  const parts = [
    `${count} managed MCP allowlist ${count === 1 ? "entry" : "entries"} in an earlier generated launch shape (${names.join(", ")})`,
  ];
  if (generation.allowlist.added.length > 0) {
    parts.push(
      `${generation.allowlist.added.length} newly generated ${generation.allowlist.added.length === 1 ? "entry" : "entries"} not yet present`,
    );
  }
  if (generation.missingParts.length > 0) {
    const shown = generation.missingParts.slice(0, 4).join("; ");
    const more =
      generation.missingParts.length > 4 ? `; +${generation.missingParts.length - 4} more` : "";
    parts.push(`newer projection parts not yet present: ${shown}${more}`);
  }
  const check: Check = {
    name: `org-policy generation delta: ${action.path}`,
    verdict: "fail",
    detail:
      `generation delta in ${action.path}: content matches an earlier aih generation's output, ` +
      `not a local edit (${parts.join("; ")}); a newer aih changed its generated projection — ` +
      "run `aih policy project --apply` to re-project",
    code: "org-policy.generation-delta",
    location: { uri: action.path },
    fingerprint: `org-policy-generation-delta:${action.path}`,
  };
  // Same severity as the managed-key drift path this refines: a hard fail at
  // enterprise (the finding is never suppressed), warning-only at vibe.
  return posture === "vibe" ? postureGradeCheck(check, "verify", posture) : check;
}

/**
 * The registry CLI that owns a projected artifact path, resolved from the registry's
 * declared `configDirs` rather than a hardcoded tool name — so a target added to the
 * registry is scoped correctly here without editing this file.
 */
function owningCli(path: string): Cli | undefined {
  return registryOwningCli(path) as Cli | undefined;
}

/**
 * Verdict for an artifact whose owning CLI is NOT in this repo's target set.
 *
 * `aih policy project` deliberately emits zero actions for an untargeted CLI, so the
 * ordinary "re-run the projection" drift finding would be unsatisfiable by construction
 * (issue #554). Absent → skip with the target-scope reason. aih's own marker is never
 * residue: it DECLARES the target set. Nothing is deleted here, and operator-owned
 * config is never assumed to be ours.
 *
 * Still on disk splits by whether aih can PROVE what it wrote (issue #566). These
 * commands are invoked by agents, so the two cases must never share a code:
 *
 *  - `org-policy.dropped-target-residue` — the marker proves an exact managed-MCP
 *    pair, so the finding names EXACTLY ONE runnable command, `aih prune`, and
 *    running it clears this finding. (#564/#565 removed `aih prune` from this
 *    message because it could not do the job; #566 makes it able, so it returns.)
 *  - `org-policy.dropped-target-unowned` — a DISTINCT code plus the explicit reason,
 *    so an agent escalates instead of re-running the same command forever.
 */
function untargetedCheck(
  action: Pick<WriteAction, "path">,
  owner: Cli,
): (ctx: PlanContext) => Check {
  return (ctx) => {
    const name = `org-policy drift: ${action.path}`;
    // aih's OWN marker is never dropped-target residue. It is the file that DECLARES
    // the target set, and the projection emits an ownership action for it whenever
    // managed-MCP is enabled — so an owner gate that treated it like a projected
    // artifact would tell the operator to delete their own target declaration.
    if (action.path === AIH_CONFIG_FILE) {
      return {
        name,
        verdict: "skip",
        detail: `${owner} is not a target of this repo, so the managed-MCP projection this marker would record is not active; ${AIH_CONFIG_FILE} is aih's own target declaration, not a projected artifact`,
      };
    }
    // PRESENCE only, no-follow: a content read here throws EISDIR on a directory
    // planted at the projected path and would make the classification below —
    // the whole point of this probe — unreachable.
    if (!occupied(resolve(ctx.root, action.path))) {
      return {
        name,
        verdict: "skip",
        detail: `${owner} is not a target of this repo — org-policy projection writes no ${owner} artifacts, so ${action.path} drift is not evaluated`,
      };
    }
    // Name a repair ONLY when it can actually perform it. `aih prune` subtracts the
    // two marker-proven managed-MCP keys from the projected managed-settings file and
    // nothing else, so it is the right prescription exactly when that ownership record
    // matches the live pair (#566) — and the wrong one everywhere else (#564).
    const residue =
      action.path === MANAGED_SETTINGS_PATH ? managedMcpProjectionOnDisk(ctx.root) : undefined;
    if (residue?.matches === true) {
      return {
        name,
        verdict: "fail",
        detail: `dropped-target residue: ${action.path} still carries the aih-owned managed-MCP keys (${MANAGED_MCP_PROJECTION_KEYS.join(", ")}) but ${owner} is not a target of this repo — run \`aih prune\` to subtract exactly those keys; re-projecting cannot fix this while ${owner} is untargeted, and every other key in the file is left untouched`,
        code: "org-policy.dropped-target-residue",
        location: { uri: action.path },
        fingerprint: `org-policy-dropped-target:${action.path}`,
      };
    }
    // Not repairable by any aih command. A DISTINCT code plus the explicit reason, so
    // an agent escalates rather than re-running a command designed to refuse here.
    const reason =
      action.path === MANAGED_SETTINGS_PATH
        ? unprovableResidueReason(residue?.unprovable ?? "no-ownership-record")
        : "aih records no per-key provenance for this artifact, so no part of it is provably aih's";
    return {
      name,
      verdict: "fail",
      detail: `dropped-target residue: ${action.path} is still present but ${owner} is not a target of this repo, so org-policy projection no longer maintains it — re-projecting cannot fix this while ${owner} is untargeted, and aih cannot remove it either because ${reason}; either add ${owner} back to the targets in ${AIH_CONFIG_FILE} to resume maintaining it, or remove the file by hand if ${owner} is genuinely gone`,
      code: "org-policy.dropped-target-unowned",
      location: { uri: action.path },
      fingerprint: `org-policy-dropped-target:${action.path}`,
    };
  };
}

/**
 * `orgPolicyProjectionActions` correctly refuses to plan through an occupied
 * managed-settings path. Doctor must surface that same refusal instead of
 * swallowing it while deriving legacy drift actions. This classifier performs
 * only the established no-follow ownership inspection; it never reads a FIFO,
 * directory, or symlinked projected path.
 */
function unsafeManagedMcpProjectionProbe(
  ctx: PlanContext,
  posture: Posture,
): ProbeAction | undefined {
  if (managedMcpProjectionOnDisk(ctx.root)?.unprovable !== "not-a-regular-file") {
    return undefined;
  }
  const action = { path: MANAGED_SETTINGS_PATH };
  // Doctor scopes legacy org-policy probes from the committed marker before
  // they are scheduled. Preserve that decision: probe execution receives the
  // caller's original context, whose absent target list means "all targets".
  const owner = owningCli(action.path);
  const untargeted = owner !== undefined && !isTargeted(ctx, owner);
  return probe(`org-policy drift: ${action.path}`, (probeCtx) => {
    if (owner !== undefined && untargeted) {
      // Keep target narrowing honest: an existing Claude artifact outside the
      // committed target set is residue, not an active projection to repair.
      return untargetedCheck(action, owner)(probeCtx);
    }
    return postureGradeCheck(
      {
        name: `org-policy drift: ${action.path}`,
        verdict: "fail",
        detail:
          `org-policy drift: ${action.path} is an unsafe managed-MCP projection path; ` +
          `${unprovableResidueReason("not-a-regular-file")}. ` +
          "Remove or repair the occupied path manually before re-running policy projection.",
        code: "org-policy.drift",
        location: { uri: action.path },
        fingerprint: `org-policy-drift:unsafe-path:${action.path}`,
      },
      "verify",
      posture,
    );
  });
}

function driftCheck(action: WriteAction, posture: Posture): (ctx: PlanContext) => Check {
  return (ctx) => {
    const abs = resolve(ctx.root, action.path);
    const raw = readIfExists(abs);
    if (raw === undefined) {
      return postureGradeCheck(
        {
          name: `org-policy drift: ${action.path}`,
          verdict: "fail",
          detail: `org-policy drift: missing ${action.path}; re-run org-policy projection`,
          code: "org-policy.drift",
          location: { uri: action.path },
          fingerprint: `org-policy-drift:${action.path}`,
        },
        "verify",
        posture,
      );
    }

    let diffs: string[];
    if (action.json !== undefined) {
      let actual: unknown;
      try {
        actual = parseJsoncText(raw);
      } catch (err) {
        return postureGradeCheck(
          {
            name: `org-policy drift: ${action.path}`,
            verdict: "fail",
            detail: `org-policy drift: ${action.path} is not valid JSON/JSONC (${(err as Error).message})`,
            code: "org-policy.drift",
            location: { uri: action.path },
            fingerprint: `org-policy-drift:${action.path}`,
          },
          "verify",
          posture,
        );
      }
      if (action.merge) {
        const exactDiffs = exactProjectionParts(actual, action.json, action.replaceJsonKeys);
        diffs = [
          ...missingProjectionParts(actual, action.json),
          ...exactDiffs,
          ...removedProjectionParts(actual, action.removeJsonTopLevelKeys),
        ];
        if (diffs.length > 0) {
          // #501 — before reporting drift, check whether the whole difference is
          // explained by aih's own generated output evolving between versions.
          const generation = managedSettingsGenerationDelta(actual, action);
          if (generation !== undefined) return generationDeltaCheck(action, generation, posture);
        }
        if (exactDiffs.length > 0 && posture !== "vibe") {
          return {
            name: `org-policy drift: ${action.path}`,
            verdict: "fail",
            detail: `org-policy drift in ${action.path}: ${diffs.slice(0, 6).join("; ")}${
              diffs.length > 6 ? `; +${diffs.length - 6} more` : ""
            }`,
            code: "org-policy.drift",
            location: { uri: action.path },
            fingerprint: `org-policy-drift:${action.path}`,
          };
        }
      } else {
        diffs = sameJson(actual, action.json)
          ? []
          : ["content differs from compiled org-policy projection"];
      }
    } else {
      const expected = ensureTrailingNewline(action.contents ?? "");
      diffs = raw === expected ? [] : ["content differs from compiled org-policy projection"];
    }

    if (diffs.length === 0) {
      return {
        name: `org-policy drift: ${action.path}`,
        verdict: "pass",
        detail: `${action.path} matches aih-org-policy.json projection`,
      };
    }

    return postureGradeCheck(
      {
        name: `org-policy drift: ${action.path}`,
        verdict: "fail",
        detail: `org-policy drift in ${action.path}: ${diffs.slice(0, 6).join("; ")}${
          diffs.length > 6 ? `; +${diffs.length - 6} more` : ""
        }`,
        code: "org-policy.drift",
        location: { uri: action.path },
        fingerprint: `org-policy-drift:${action.path}`,
      },
      "verify",
      posture,
    );
  };
}

function invalidPolicyProbe(error: unknown): ProbeAction {
  return probe("org-policy drift", () => ({
    name: "org-policy drift",
    verdict: "fail",
    detail: `org-policy drift: aih-org-policy.json cannot be parsed (${(error as Error).message})`,
    code: "org-policy.drift",
    fingerprint: "org-policy-drift:policy-parse",
  }));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function policySource(ctx: PlanContext): {
  kind: "repo-default" | "env-override";
  display: string;
  abs: string;
} {
  const override = ctx.env.AIH_ORG_POLICY?.trim();
  if (override !== undefined && override.length > 0) {
    return {
      kind: "env-override",
      display: override.replace(/\\/g, "/"),
      abs: orgPolicyPath(ctx.root, ctx.env),
    };
  }
  return {
    kind: "repo-default",
    display: AIH_ORG_POLICY_FILE,
    abs: orgPolicyPath(ctx.root, ctx.env),
  };
}

function activePosture(ctx: PlanContext): Posture {
  return ctx.posture ?? "vibe";
}

function sourceCheck(ctx: PlanContext): Check {
  const source = policySource(ctx);
  if (source.kind === "repo-default") {
    const present = readIfExists(source.abs) !== undefined;
    return {
      name: "org-policy source",
      verdict: present ? "pass" : "skip",
      detail: present
        ? `policy source: default repo file ${AIH_ORG_POLICY_FILE}`
        : `policy source: default repo file ${AIH_ORG_POLICY_FILE} absent`,
    };
  }

  return postureGradeCheck(
    {
      name: "org-policy source",
      verdict: "fail",
      code: "org-policy.drift",
      detail:
        `policy source: AIH_ORG_POLICY env override (${source.display}); ` +
        "enterprise control planes should use a trusted managed channel or an explicit `aih policy verify --against <pin>` gate",
      location: { uri: source.display },
      fingerprint: "org-policy-source:env-override",
    },
    "verify",
    activePosture(ctx),
  );
}

/**
 * A transient AIH_ORG_POLICY override is inspectable but not a trusted source
 * for any configuration mutation. Refuse before any plan can produce writes;
 * otherwise an override could self-declare a lower posture and mask a committed
 * enterprise floor. The committed default remains the only direct mutation source.
 */
export function assertOrgPolicyMutationSource(ctx: PlanContext): void {
  if (!ctx.apply) return;
  const source = policySource(ctx);
  if (source.kind === "repo-default") return;
  throw new OrgPolicyError(
    `policy source: AIH_ORG_POLICY env override (${source.display}); ` +
      "configuration mutation requires the committed default policy or a trusted managed channel",
  );
}

async function headDriftCheck(ctx: PlanContext): Promise<Check> {
  const source = policySource(ctx);
  if (source.kind !== "repo-default") {
    return {
      name: "org-policy HEAD drift",
      verdict: "skip",
      detail: `HEAD drift checks the default ${AIH_ORG_POLICY_FILE}; active source is AIH_ORG_POLICY (${source.display})`,
    };
  }
  const local = readIfExists(source.abs);
  const head = await gitRead(ctx, ["show", `HEAD:${AIH_ORG_POLICY_FILE}`]);
  if (local === undefined && head === undefined) {
    return {
      name: "org-policy HEAD drift",
      verdict: "skip",
      detail: `${AIH_ORG_POLICY_FILE} is not present locally or in HEAD`,
    };
  }
  if (head === undefined) {
    return {
      name: "org-policy HEAD drift",
      verdict: "skip",
      detail: `${AIH_ORG_POLICY_FILE} is not tracked in HEAD; use a pinned bundle/hash for enterprise enforcement`,
    };
  }
  if (local === undefined) {
    return postureGradeCheck(
      {
        name: "org-policy HEAD drift",
        verdict: "fail",
        code: "org-policy.drift",
        detail: `${AIH_ORG_POLICY_FILE} is tracked in HEAD but missing from the working tree`,
        location: { uri: AIH_ORG_POLICY_FILE },
        fingerprint: "org-policy-head-drift:missing",
      },
      "verify",
      activePosture(ctx),
    );
  }
  const localHash = sha256(local);
  const headHash = sha256(ensureTrailingNewline(head));
  if (localHash === headHash) {
    return {
      name: "org-policy HEAD drift",
      verdict: "pass",
      detail: `${AIH_ORG_POLICY_FILE} matches HEAD (${localHash.slice(0, 12)}...)`,
    };
  }
  return postureGradeCheck(
    {
      name: "org-policy HEAD drift",
      verdict: "fail",
      code: "org-policy.drift",
      detail:
        `${AIH_ORG_POLICY_FILE} differs from HEAD (` +
        `local ${localHash.slice(0, 12)}..., HEAD ${headHash.slice(0, 12)}...); ` +
        "this catches uncommitted local control-plane edits only — use `aih policy verify --against <pin>` for branch/commit weakening",
      location: { uri: AIH_ORG_POLICY_FILE },
      fingerprint: "org-policy-head-drift:hash",
    },
    "verify",
    activePosture(ctx),
  );
}

export function orgPolicyIntegrityProbes(_ctx: PlanContext): ProbeAction[] {
  return [
    probe("org-policy source", (ctx) => sourceCheck(ctx)),
    probe("org-policy HEAD drift", (ctx) => headDriftCheck(ctx)),
  ];
}

export async function orgPolicyIntegrityDigest(
  ctx: PlanContext,
): Promise<DigestAction | undefined> {
  const checks = [];
  for (const p of orgPolicyIntegrityProbes(ctx)) checks.push(await p.run(ctx));
  if (checks.every((check) => check.verdict === "skip")) return undefined;
  const failed = checks.filter((check) => check.verdict === "fail").length;
  const body = [
    "| Row | Verdict | Signal |",
    "|---|---|---|",
    ...checks.map(
      (check) => `| ${check.name} | ${check.verdict.toUpperCase()} | ${check.detail ?? ""} |`,
    ),
  ].join("\n");
  return digest(`Org policy integrity — ${failed} fail · ${checks.length - failed} visible`, body, {
    checks,
  });
}

export function orgPolicyDriftProbes(ctx: PlanContext): ProbeAction[] {
  let policy: ReturnType<typeof readOrgPolicy>;
  try {
    policy = readOrgPolicy(ctx.root, ctx.env);
  } catch (err) {
    return [invalidPolicyProbe(err)];
  }
  if (policy === undefined) return [];

  const posture = ctx.posture ?? policy.minimumPosture;
  const projectionCtx: PlanContext = {
    ...ctx,
    posture: strongerPosture(posture, policy.minimumPosture),
  };
  let actions: WriteAction[];
  try {
    if (policy.governance !== undefined) return [];
    // Legacy managed-settings drift has no governance activation. Keep its
    // historical Claude-residue inspection; governed inventories use the
    // verified path below with the actual invocation target set.
    actions = orgPolicyProjectionActions({ ...projectionCtx, targets: ["claude"] }, policy).filter(
      (a): a is WriteAction => a.kind === "write",
    );
  } catch {
    // `aih doctor` reports the exact fail-closed resolution via
    // orgPolicyEffectiveCheck. Legacy projection can additionally refuse a
    // no-follow managed-settings path before producing its usual Claude action;
    // preserve that unsafe condition as a doctor probe rather than hiding it.
    const unsafe = unsafeManagedMcpProjectionProbe(projectionCtx, posture);
    return unsafe === undefined ? [] : [unsafe];
  }
  // The projection is owned by a single CLI (it writes that tool's managed settings
  // plus their examples). Resolve that owner once from the registry and scope the whole
  // probe set, mirroring policyProjectPlan's all-or-nothing gate — per-path matching
  // would miss the sibling `.example` files that live outside the tool's config dir.
  const owner = actions.map((a) => owningCli(a.path)).find((o) => o !== undefined);
  const untargeted = owner !== undefined && !isTargeted(ctx, owner);
  return actions.map((action) =>
    untargeted && owner !== undefined
      ? probe(`org-policy drift: ${action.path}`, untargetedCheck(action, owner))
      : probe(`org-policy drift: ${action.path}`, driftCheck(action, posture)),
  );
}

/** Receipt-verified doctor path for governed inventories. */
export async function verifiedOrgPolicyDriftProbes(ctx: PlanContext): Promise<ProbeAction[]> {
  let policy: ReturnType<typeof readOrgPolicy>;
  try {
    policy = readOrgPolicy(ctx.root, ctx.env);
  } catch (err) {
    return [invalidPolicyProbe(err)];
  }
  if (policy === undefined || policy.governance === undefined) return orgPolicyDriftProbes(ctx);
  const posture = ctx.posture ?? policy.minimumPosture;
  const projectionCtx: PlanContext = {
    ...ctx,
    posture: strongerPosture(posture, policy.minimumPosture),
  };
  let actions: WriteAction[];
  try {
    actions = (await verifiedOrgPolicyProjectionActions(projectionCtx, policy)).filter(
      (action): action is WriteAction => action.kind === "write",
    );
  } catch {
    return [];
  }
  return actions.map((action) =>
    probe(`org-policy drift: ${action.path}`, driftCheck(action, posture)),
  );
}
