export type NpmLockPackageRecord = {
  version: string;
  resolved: string;
  integrity: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
};

export type NpmLock = {
  lockfileVersion?: number;
  packages: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; [key: string]: unknown }>;
};

export type PackedCoreEntry = {
  name: string;
  filename: string;
  version: string;
  integrity: string;
};

export function globalNodeModules(prefix: string, platform?: NodeJS.Platform): string;
export function productionClosure(lock: NpmLock): Record<string, NpmLockPackageRecord>;
export function packedNpmChild(
  args: readonly string[],
  userconfig: string,
  inherited?: NodeJS.ProcessEnv,
): { args: string[]; environment: NodeJS.ProcessEnv };
export function packedConsumerInstallFiles(entry: PackedCoreEntry): {
  manifest: Record<string, unknown>;
  lock: Record<string, unknown>;
};
