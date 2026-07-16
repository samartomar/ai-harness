import type { HostCoverage } from "./host.js";

export interface CompatibilityKey {
  provider: {
    repository: string;
    resolvedCommit: string;
    installerContractFingerprint: string;
  };
  adapter: { id: string; contractVersion: number; implementationHash: string };
  host: {
    id: string;
    version: string;
    build: string;
    loadSurfaceContractVersion: string;
    loadSurfaceCoverage: HostCoverage;
  };
  operatingSystem: { family: "windows" | "linux" | "macos"; version: string; architecture: string };
  isolationMode: string;
  runtimes: Readonly<Record<string, string>>;
  policyVersion: string;
}

export interface CompatibilityResult {
  status: "supported" | "unknown";
  finding?: "ADAPTER_COMPATIBILITY_UNKNOWN";
  safeRetry?: string;
  stopCondition?: string;
}

export function serializeCompatibilityKey(key: CompatibilityKey): string {
  return JSON.stringify({
    provider: key.provider,
    adapter: key.adapter,
    host: key.host,
    operatingSystem: key.operatingSystem,
    isolationMode: key.isolationMode,
    runtimes: Object.fromEntries(
      Object.entries(key.runtimes).sort(([a], [b]) => a.localeCompare(b)),
    ),
    policyVersion: key.policyVersion,
  });
}

export function resolveCompatibility(
  candidate: CompatibilityKey,
  supported: readonly CompatibilityKey[],
): CompatibilityResult {
  const serialized = serializeCompatibilityKey(candidate);
  if (supported.some((key) => serializeCompatibilityKey(key) === serialized)) {
    return { status: "supported" };
  }
  return {
    status: "unknown",
    finding: "ADAPTER_COMPATIBILITY_UNKNOWN",
    safeRetry: "Add an exact reviewed compatibility tuple before qualification.",
    stopCondition: "Do not infer support from a similar provider, host, or adapter tuple.",
  };
}
