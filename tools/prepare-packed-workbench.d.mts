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

export function productionClosure(lock: NpmLock): Record<string, NpmLockPackageRecord>;
export function packedConsumerInstallFiles(entry: PackedCoreEntry): {
  manifest: Record<string, unknown>;
  lock: Record<string, unknown>;
};
export function preparePackedWorkbench(directory: string): { output: string; packageIntegrity: string };
