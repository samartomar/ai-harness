export declare const COMPATIBILITY_FORMAT: "core-sibling-compatibility";
export declare const COMPATIBILITY_VERSION: 1;
export declare const PACKAGES: readonly ["@aihq/core", "@aihq/scan", "@aihq/catalog"];

export interface ContractCheckResult {
  readonly id: string;
  readonly status: "passed" | "failed" | "unavailable";
  readonly detail?: string;
}

export interface LegPackage {
  readonly package: string;
  readonly version?: string;
  readonly status?: "tag-absent";
  readonly distTag?: "latest" | "next";
  readonly tarballSha256?: string;
  readonly tarballIntegrity?: string;
  readonly source?: Record<string, unknown>;
}

export interface LegReport {
  readonly leg: "branch" | "registry-latest" | "registry-next";
  readonly status: "tested" | "tag-absent";
  readonly os?: string;
  readonly node?: string;
  readonly packages: readonly LegPackage[];
  readonly lockfileSha256?: string;
  readonly contractChecks?: readonly ContractCheckResult[];
}

export interface CompatibilityArtifact {
  readonly format: "core-sibling-compatibility";
  readonly version: 1;
  readonly runId: string;
  readonly runAttempt: string;
  readonly core: unknown;
  readonly legs: ReadonlyArray<{
    readonly package: string;
    readonly version: string;
    readonly distTag: "next";
    readonly tarballSha256: string;
    readonly tarballIntegrity: string;
    readonly lockfileSha256: string;
    readonly contractChecks: ReadonlyArray<{ readonly id: string; readonly status: string }>;
  }>;
  readonly observations: readonly LegReport[];
  readonly limitation: string;
}

export declare function runContractChecks(input: {
  readonly core: Record<string, unknown>;
  readonly scan: Record<string, unknown>;
  readonly catalog: Record<string, unknown>;
  readonly readSubpath: (specifier: string) => Uint8Array;
}): Promise<ContractCheckResult[]>;

export declare function validateLegReport(report: unknown): LegReport;

export declare function buildCompatibilityArtifact(input: {
  readonly runId: string | number;
  readonly runAttempt: string | number;
  readonly core: unknown;
  readonly reports: readonly unknown[];
}): CompatibilityArtifact;

export declare function runLeg(input: {
  readonly kind: "branch" | "registry";
  readonly tag?: "latest" | "next";
  readonly checkouts: Record<string, string>;
  readonly out: string;
  readonly os: string;
  readonly node: string;
}): LegReport;
