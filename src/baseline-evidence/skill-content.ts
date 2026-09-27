import { lstatSync, readdirSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import type { BaselineCatalogComponent } from "./catalog.js";

type SkillContentSubject = Pick<BaselineCatalogComponent, "paths" | "skillContent">;

function treeContainsSkillFile(path: string): boolean {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) return false;
  if (stats.isFile()) return basename(path) === "SKILL.md";
  if (!stats.isDirectory()) return false;
  return readdirSync(path, { withFileTypes: true }).some((entry) => {
    if (entry.isSymbolicLink()) return false;
    return treeContainsSkillFile(join(path, entry.name));
  });
}

/** The half that needs no checkout: a declared path segment names `skills` or `SKILL.md`. */
function declaredPathNamesSkillContentV1(component: SkillContentSubject): boolean {
  return component.paths.some((path) =>
    path.split("/").some((segment) => segment === "skills" || segment === "SKILL.md"),
  );
}

/**
 * Every directory of one COMMITTED tree that holds a `SKILL.md` file — possibly far below
 * it. A declared path naming one of them is skill content in that commit, whatever the
 * working tree now looks like.
 */
export function committedSkillDirectoriesV1(
  committedPaths: readonly string[],
): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const entry of committedPaths) {
    if (basename(entry) !== "SKILL.md") continue;
    const segments = entry.split("/");
    for (let length = 1; length < segments.length; length += 1)
      directories.add(segments.slice(0, length).join("/"));
  }
  return directories;
}

/**
 * Whether one component's declared material is skill content, decided from a COMMITTED tree
 * (the pinned commit's own paths). A declared path segment names `skills`/`SKILL.md`, or a
 * declared path is a directory of the commit that holds a `SKILL.md` file. The working tree
 * is never consulted, so an untracked or modified file cannot change the answer.
 */
export function componentContainsCommittedSkillContentV1(
  component: SkillContentSubject,
  committedSkillDirectories: ReadonlySet<string>,
): boolean {
  if (component.skillContent === true) return true;
  if (declaredPathNamesSkillContentV1(component)) return true;
  return component.paths.some((path) => committedSkillDirectories.has(path));
}

/**
 * Whether one component's declared material is skill content, decided at a checkout the
 * caller already verified: a declared path segment names `skills`/`SKILL.md`, or the
 * material below a declared path holds a `SKILL.md` file there. One decision with two
 * consumers — the analyzer profile (`requiredBaselineAnalyzersForComponent`) and the
 * Scanner request Core authors from a resolved catalog. A definition read from a DECLARED
 * Catalog section uses {@link componentContainsCommittedSkillContentV1} instead, because a
 * declaration is bound to a commit, not to whatever the working tree currently holds.
 */
export function componentContainsSkillContentV1(
  component: SkillContentSubject,
  sourceRoot?: string,
): boolean {
  if (component.skillContent === true) return true;
  if (declaredPathNamesSkillContentV1(component)) return true;
  return (
    sourceRoot !== undefined &&
    component.paths.some((path) => treeContainsSkillFile(join(sourceRoot, ...path.split("/"))))
  );
}
