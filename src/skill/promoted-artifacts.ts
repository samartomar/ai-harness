import { posix } from "node:path";
import { parseTrustLockSource, type TrustLockSource } from "../trust/lock.js";

export interface PromotedSkillArtifactTarget {
  skill: string;
  artifactPath: string;
  targetPath: string;
  sha256: string;
}

export type PromotedSkillArtifactProjection =
  | { status: "resolved"; targets: readonly Readonly<PromotedSkillArtifactTarget>[] }
  | {
      status: "refused";
      code: "invalid-source-receipt" | "ambiguous-artifact-route";
    };

interface PromotedSkillRoute {
  skill: string;
  parts: string[];
}

interface PromotedRouteTrie {
  routes: PromotedSkillRoute[];
  children: Map<string, PromotedRouteTrie>;
}

interface PromotedSourceLayout {
  routeTrie: PromotedRouteTrie;
  rootSkill?: string;
}

const GITHUB_PROMOTION_ROOT_SKILL = "tree";
const SHA256 = /^[0-9a-f]{64}$/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function frozenRefusal(
  code: "invalid-source-receipt" | "ambiguous-artifact-route",
): PromotedSkillArtifactProjection {
  return Object.freeze({ status: "refused" as const, code });
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 2_048 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !UNSAFE_TEXT.test(value) &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function cleanRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function promotedRouteTrie(routes: readonly PromotedSkillRoute[]): PromotedRouteTrie {
  const root: PromotedRouteTrie = { routes: [], children: new Map() };
  for (const route of routes) {
    let node = root;
    for (const part of route.parts) {
      let child = node.children.get(part);
      if (child === undefined) {
        child = { routes: [], children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.routes.push(route);
  }
  return root;
}

function matchingPromotedRoutes(
  routeTrie: PromotedRouteTrie,
  artifactPath: string,
): Array<{ route: PromotedSkillRoute; rel: string }> {
  const parts = artifactPath.split("/");
  const starts = [0];
  for (let index = 1; index <= parts.length - 2; index += 1) {
    if (parts[index - 1] === "skills") starts.push(index);
  }
  const matches = new Map<string, { route: PromotedSkillRoute; rel: string }>();
  for (const start of starts) {
    let node = routeTrie;
    for (let index = start; index < parts.length - 1; index += 1) {
      const child = node.children.get(parts[index] ?? "");
      if (child === undefined) break;
      node = child;
      for (const route of node.routes) {
        if (!matches.has(route.skill)) {
          matches.set(route.skill, { route, rel: parts.slice(index + 1).join("/") });
        }
      }
    }
  }
  return [...matches.values()];
}

function promotedSourceLayout(
  source: TrustLockSource,
  routes: PromotedSkillRoute[],
): PromotedSourceLayout {
  const routeTrie = promotedRouteTrie(routes);
  const sourceName =
    source.kind === "github"
      ? GITHUB_PROMOTION_ROOT_SKILL
      : cleanRel(source.source)
          .split("/")
          .at(-1)
          ?.replace(/\.git$/i, "");
  const receiptProvesSourceRoot = source.artifactHashes.some(
    (artifact) => artifact.path === "SKILL.md",
  );
  const explicitSourceRoot = receiptProvesSourceRoot
    ? routes.find((route) => route.skill === sourceName)?.skill
    : undefined;
  const prefixedSkills = new Set<string>();
  for (const artifact of source.artifactHashes) {
    for (const { route } of matchingPromotedRoutes(routeTrie, artifact.path)) {
      if (route.skill !== explicitSourceRoot) prefixedSkills.add(route.skill);
    }
  }
  const rootSkills = routes.filter((route) => !prefixedSkills.has(route.skill));
  return {
    routeTrie,
    rootSkill: explicitSourceRoot ?? (rootSkills.length === 1 ? rootSkills[0]?.skill : undefined),
  };
}

function targetCandidates(
  contextDir: string,
  source: TrustLockSource,
  layout: PromotedSourceLayout,
  artifactPath: string,
): Array<{ skill: string; targetPath: string }> {
  const candidates = matchingPromotedRoutes(layout.routeTrie, artifactPath).flatMap(
    ({ route, rel }) =>
      route.skill === layout.rootSkill
        ? []
        : [
            {
              skill: route.skill,
              targetPath: posix.join(contextDir, "skills", source.id, route.skill, rel),
            },
          ],
  );
  if (layout.rootSkill !== undefined) {
    candidates.push({
      skill: layout.rootSkill,
      targetPath: posix.join(contextDir, "skills", source.id, layout.rootSkill, artifactPath),
    });
  }
  return candidates;
}

/**
 * Project one validated promotion receipt onto its repo-local installed paths.
 * This proves only the receipt's route; callers must still prove current bytes.
 */
export function projectPromotedSkillArtifacts(
  contextDir: string,
  input: TrustLockSource,
): PromotedSkillArtifactProjection {
  const source = parseTrustLockSource(input);
  if (
    source === undefined ||
    !safeRelativePath(contextDir) ||
    !safeRelativePath(source.id) ||
    source.promotedSkills.length === 0 ||
    source.artifactHashes.length === 0 ||
    source.promotedSkills.some((skill) => !safeRelativePath(skill)) ||
    source.artifactHashes.some(
      ({ path, sha256 }) => !safeRelativePath(path) || !SHA256.test(sha256),
    )
  ) {
    return frozenRefusal("invalid-source-receipt");
  }
  const skillKeys = source.promotedSkills.map((skill) => skill.toLowerCase());
  const artifactPaths = source.artifactHashes.map(({ path }) => path);
  if (
    new Set(source.promotedSkills).size !== source.promotedSkills.length ||
    new Set(skillKeys).size !== skillKeys.length ||
    new Set(artifactPaths).size !== artifactPaths.length
  ) {
    return frozenRefusal("invalid-source-receipt");
  }
  const artifactKeys = artifactPaths.map((path) => path.toLowerCase());
  if (new Set(artifactKeys).size !== artifactKeys.length) {
    return frozenRefusal("ambiguous-artifact-route");
  }
  const routes = source.promotedSkills
    .map((skill) => ({ skill, parts: skill.split("/") }))
    .sort((left, right) => compareCodeUnits(left.skill, right.skill));
  const layout = promotedSourceLayout(source, routes);
  const targets: PromotedSkillArtifactTarget[] = [];
  for (const artifact of source.artifactHashes) {
    const candidates = targetCandidates(contextDir, source, layout, artifact.path);
    if (
      candidates.length === 0 ||
      candidates.some(({ targetPath }) => !safeRelativePath(targetPath))
    ) {
      return frozenRefusal("ambiguous-artifact-route");
    }
    for (const candidate of candidates) {
      targets.push({
        skill: candidate.skill,
        artifactPath: artifact.path,
        targetPath: candidate.targetPath,
        sha256: artifact.sha256,
      });
    }
  }
  targets.sort(
    (left, right) =>
      compareCodeUnits(left.targetPath, right.targetPath) ||
      compareCodeUnits(left.artifactPath, right.artifactPath),
  );
  const targetKeys = targets.map(({ targetPath }) => targetPath.toLowerCase());
  if (new Set(targetKeys).size !== targetKeys.length) {
    return frozenRefusal("ambiguous-artifact-route");
  }
  const frozenTargets = targets.map((target) => Object.freeze({ ...target }));
  return Object.freeze({
    status: "resolved" as const,
    targets: Object.freeze(frozenTargets),
  });
}
