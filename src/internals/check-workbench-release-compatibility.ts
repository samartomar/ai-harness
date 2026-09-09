import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKBENCH_MINIMUM_CORE_VERSION } from "../org-policy/workbench/contracts.js";

type Version = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
};

function parseVersion(value: string): Version | undefined {
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined)
    return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: (value.split("+")[0] ?? value).includes("-"),
  };
}

/** Necessary version-floor gate; packed CLI consumption is verified separately. */
export function workbenchReleaseCompatibleV1(
  candidateVersion: string,
  minimumCoreVersion = WORKBENCH_MINIMUM_CORE_VERSION,
): boolean {
  const candidate = parseVersion(candidateVersion);
  const minimum = parseVersion(minimumCoreVersion);
  if (candidate === undefined || minimum === undefined) return false;
  for (const field of ["major", "minor", "patch"] as const) {
    if (candidate[field] !== minimum[field]) return candidate[field] > minimum[field];
  }
  return !candidate.prerelease;
}

export function assertWorkbenchReleaseCompatibleV1(
  candidateVersion: string,
  minimumCoreVersion = WORKBENCH_MINIMUM_CORE_VERSION,
): void {
  if (!workbenchReleaseCompatibleV1(candidateVersion, minimumCoreVersion))
    throw new Error(
      `Release candidate Core ${candidateVersion} cannot consume Workbench policies requiring Core ${minimumCoreVersion}.`,
    );
}

function candidateVersionFromPackage(path: string): string {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { version?: unknown }).version !== "string"
  )
    throw new Error("Release candidate package has no version.");
  return (parsed as { version: string }).version;
}

if (process.argv[1]?.endsWith("check-workbench-release-compatibility.ts")) {
  const candidateVersion = candidateVersionFromPackage(join(process.cwd(), "package.json"));
  assertWorkbenchReleaseCompatibleV1(candidateVersion);
  console.log(
    `Release candidate Core ${candidateVersion} meets the Workbench ${WORKBENCH_MINIMUM_CORE_VERSION} version floor. Packed CLI consumption must also pass.`,
  );
}
