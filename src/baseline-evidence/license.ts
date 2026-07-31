import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";

const REPOSITORY_LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"] as const;

export function repositoryLicensePath(sourceRoot: string): string | undefined {
  for (const name of REPOSITORY_LICENSE_FILES) {
    const source = resolve(sourceRoot, name);
    if (!existsSync(source)) continue;
    const stat = lstatSync(source);
    if (!stat.isSymbolicLink() && stat.isFile()) return name;
  }
  return undefined;
}

/**
 * Component analyzer projections inherit the repository license. Bind those
 * bytes into the component identity as well, so changing legal metadata always
 * invalidates evidence reuse and runtime authorization.
 */
export function componentIdentityPaths(
  sourceRoot: string,
  declaredPaths: readonly string[],
): string[] {
  const license = repositoryLicensePath(sourceRoot);
  return license === undefined || declaredPaths.includes(license)
    ? [...declaredPaths]
    : [...declaredPaths, license];
}
