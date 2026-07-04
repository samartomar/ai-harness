import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { postureGradeCheck } from "../config/governance.js";
import type { Posture } from "../config/posture.js";
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
import { AIH_ORG_POLICY_FILE } from "./constants.js";
import { orgPolicyProjectionActions } from "./project.js";
import { orgPolicyPath, readOrgPolicy } from "./schema.js";

const POSTURE_RANK: Record<Posture, number> = { vibe: 0, team: 1, enterprise: 2 };

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
        "team/enterprise control planes should use a trusted managed channel or an explicit `aih policy verify --against <pin>` gate",
      location: { uri: source.display },
      fingerprint: "org-policy-source:env-override",
    },
    "verify",
    activePosture(ctx),
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
  return orgPolicyProjectionActions(projectionCtx, policy)
    .filter((a): a is WriteAction => a.kind === "write")
    .map((action) => probe(`org-policy drift: ${action.path}`, driftCheck(action, posture)));
}
