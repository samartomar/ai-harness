export declare const COMPATIBILITY_FORMAT: "core-sibling-compatibility";
export declare const COMPATIBILITY_VERSION: 2;
export declare const BASELINE_FORMAT: "core-sibling-compatibility-baseline";
export declare const BASELINE_VERSION: 1;
export declare const PACKAGES: readonly ["@aihq/core", "@aihq/scan", "@aihq/catalog"];

export type CombinationId =
  | "baseline"
  | "scan-candidate"
  | "catalog-candidate"
  | "core-candidate"
  | "all-next"
  | "branch";
export declare const COMBINATIONS: readonly CombinationId[];
export declare const CONTRACT_CHECK_IDS: readonly string[];
export declare const READER_REQUIRED_CHECKS: {
  readonly "@aihq/scan": readonly string[];
  readonly "@aihq/catalog": readonly string[];
};

export interface ContractCheckResult {
  readonly id: string;
  readonly status: "passed" | "failed" | "unavailable";
  readonly detail?: string;
}

export interface ResolvedBytes {
  readonly version: string;
  readonly tarballIntegrity: string;
}

export interface CompatibilityBaseline {
  readonly format: "core-sibling-compatibility-baseline";
  readonly version: 1;
  readonly resolvedAt: string;
  readonly packages: Record<
    string,
    { readonly latest: ResolvedBytes | null; readonly next: ResolvedBytes | null }
  >;
  readonly combinations: readonly CombinationId[];
}

export interface TrioEntry {
  readonly package: string;
  readonly version: string;
  readonly distTag: "latest" | "next";
  readonly role: "candidate" | "baseline" | "all-next";
  readonly tarballIntegrity: string;
}

export interface LegPackage {
  readonly package: string;
  readonly version: string;
  readonly distTag?: "latest" | "next";
  readonly role: "candidate" | "baseline" | "all-next" | "branch";
  readonly tarballSha256: string;
  readonly tarballIntegrity: string;
  readonly source?: Record<string, unknown>;
}

export interface LegReport {
  readonly leg: "branch" | "registry";
  readonly combination: CombinationId;
  readonly status: "tested";
  readonly os: string;
  readonly node: string;
  readonly npm?: string;
  readonly packages: readonly LegPackage[];
  readonly lockfileSha256: string;
  readonly contractChecks: readonly ContractCheckResult[];
}

export interface PackageBytes {
  readonly package: string;
  readonly version: string;
  readonly tarballSha256: string;
  readonly tarballIntegrity: string;
}

export interface CandidateEntry {
  readonly combination: "scan-candidate" | "catalog-candidate" | "core-candidate";
  readonly candidate: PackageBytes & { readonly distTag: "next" };
  readonly baseline: ReadonlyArray<PackageBytes & { readonly distTag: "latest" }>;
  readonly environment: { readonly os: string; readonly node: string; readonly npm?: string };
  readonly lockfileSha256: string;
  readonly contractChecks: ReadonlyArray<{
    readonly id: string;
    readonly status: ContractCheckResult["status"];
  }>;
}

export interface CompatibilityArtifact {
  readonly format: "core-sibling-compatibility";
  readonly version: 2;
  readonly runId: string;
  readonly runAttempt: string;
  readonly core: unknown;
  readonly resolvedAt: string;
  readonly baseline: Record<
    string,
    {
      readonly latest: (ResolvedBytes & { readonly tarballSha256: string | null }) | null;
      readonly next: (ResolvedBytes & { readonly tarballSha256: string | null }) | null;
    }
  >;
  readonly candidates: readonly CandidateEntry[];
  readonly observations: readonly LegReport[];
  readonly limitation: string;
}

export declare function runContractChecks(input: {
  readonly core: Record<string, unknown>;
  readonly scan: Record<string, unknown>;
  readonly catalog: Record<string, unknown>;
  readonly readSubpath: (specifier: string) => Uint8Array;
}): Promise<ContractCheckResult[]>;

export declare function planCombinations(packages: unknown): CombinationId[];

export declare function validateBaseline(baseline: unknown): CompatibilityBaseline;

export declare function selectTrio(baseline: unknown, combination: string): TrioEntry[];

export declare function validateLegReport(report: unknown): LegReport;

export declare function buildCompatibilityArtifact(input: {
  readonly runId: string | number;
  readonly runAttempt: string | number;
  readonly core: unknown;
  readonly baseline: unknown;
  readonly reports: readonly unknown[];
}): CompatibilityArtifact;

export declare function renderStepSummary(
  artifact: CompatibilityArtifact,
  baseline: CompatibilityBaseline,
): string;

export declare function resolveBaseline(input: { readonly out: string }): CompatibilityBaseline;

export declare function runLeg(input: {
  readonly kind: "branch" | "registry";
  readonly combination?: string;
  readonly baselinePath?: string;
  readonly checkouts: Record<string, string>;
  readonly out: string;
  readonly os: string;
  readonly node: string;
}): LegReport;
