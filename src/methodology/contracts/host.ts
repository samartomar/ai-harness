export const hostLoadSurfaces = [
  "executable-identity",
  "project-instructions",
  "global-instructions",
  "skills-and-plugins",
  "hooks",
  "mcp-and-configuration",
  "environment-and-cli-overrides",
  "profile-home-semantics",
  "cache-and-session-persistence",
  "inherited-configuration",
  "probe-procedures",
] as const;

export type HostLoadSurface = (typeof hostLoadSurfaces)[number];
export type HostCoverage = "complete" | "partial" | "unknown";

export interface HostLoadSurfaceRow {
  surface: HostLoadSurface;
  coverage: HostCoverage;
  evidence: readonly string[];
  positiveProbe: string;
  negativeProbe: string;
}

export interface HostLoadSurfaceContract {
  id: string;
  host: { id: string; version: string; build: string };
  surfaces: readonly HostLoadSurfaceRow[];
  coverage: HostCoverage;
}

function deriveCoverage(surfaces: readonly HostLoadSurfaceRow[]): HostCoverage {
  if (surfaces.some((surface) => surface.coverage === "unknown")) return "unknown";
  if (surfaces.some((surface) => surface.coverage === "partial")) return "partial";
  return "complete";
}

export function createHostLoadSurfaceContract(
  input: Omit<HostLoadSurfaceContract, "coverage">,
): HostLoadSurfaceContract {
  const found = new Set(input.surfaces.map((surface) => surface.surface));
  for (const surface of hostLoadSurfaces) {
    if (!found.has(surface)) throw new Error(`missing host load surface: ${surface}`);
  }
  if (found.size !== hostLoadSurfaces.length || input.surfaces.length !== hostLoadSurfaces.length) {
    throw new Error("host load surfaces must be unique and complete");
  }
  return { ...input, coverage: deriveCoverage(input.surfaces) };
}
