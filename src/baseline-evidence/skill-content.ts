import { lstatSync, readdirSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import type { BaselineCatalogComponent } from "./catalog.js";

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

/**
 * Whether one component's declared material is skill content. A declared path segment names
 * `skills` or `SKILL.md`, or — when the checkout is given — the material below a declared
 * path holds a `SKILL.md` file there. One decision with three consumers: the analyzer
 * profile (`requiredBaselineAnalyzersForComponent`), the Scanner request Core authors from
 * the resolved catalog, and the declared definition's `skillContent` flag (D79).
 *
 * The path-name half needs no checkout. The tree half does, so a component whose declared
 * path names a host or container directory (`.agents`, `.kiro`, a platform config dir) is
 * skill content only where the caller passes `sourceRoot`; every route that resolves a
 * definition or authors a request already verifies that checkout.
 */
export function componentContainsSkillContentV1(
  component: Pick<BaselineCatalogComponent, "paths" | "skillContent">,
  sourceRoot?: string,
): boolean {
  if (component.skillContent === true) return true;
  if (
    component.paths.some((path) =>
      path.split("/").some((segment) => segment === "skills" || segment === "SKILL.md"),
    )
  ) {
    return true;
  }
  return (
    sourceRoot !== undefined &&
    component.paths.some((path) => treeContainsSkillFile(join(sourceRoot, ...path.split("/"))))
  );
}
