import { resolve } from "node:path";
import { postureGradeCheck } from "../config/governance.js";
import type { Posture } from "../config/posture.js";
import { readIfExists } from "../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";
import { type PlanContext, type ProbeAction, probe, type WriteAction } from "../internals/plan.js";
import { ensureTrailingNewline } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import { orgPolicyProjectionActions } from "./project.js";
import { readOrgPolicy } from "./schema.js";

const POSTURE_RANK: Record<Posture, number> = { vibe: 0, team: 1, enterprise: 2 };

function strongerPosture(a: Posture, b: Posture): Posture {
  return POSTURE_RANK[a] >= POSTURE_RANK[b] ? a : b;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, stable(v)]),
  );
}

function sameJson(a: unknown, b: unknown): boolean {
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

function missingProjectionParts(actual: unknown, expected: unknown, path = ""): string[] {
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
      diffs = action.merge
        ? missingProjectionParts(actual, action.json)
        : sameJson(actual, action.json)
          ? []
          : ["content differs from compiled org-policy projection"];
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
