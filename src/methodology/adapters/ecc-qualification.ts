import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AihError } from "../../errors.js";
import type { Runner } from "../../internals/proc.js";
import {
  type CompatibilityKey,
  type CompatibilityResult,
  resolveCompatibility,
} from "../contracts/compatibility.js";
import type { HostLoadSurfaceContract } from "../contracts/host.js";
import { discoverInertProvider, type InertProviderDiscovery } from "../discover.js";
import { joinExactEvidence, type MethodologyEvidence } from "../evidence.js";
import { createProposedPlan, type ProposedMethodologyPlan } from "../plan.js";
import { type QualificationResult, qualifyMethodology } from "../qualify.js";
import {
  type ExactLocalSource,
  type ExactLocalSourceRequest,
  resolveExactLocalSource,
} from "../source.js";

export const ECC_CANONICAL_REPOSITORY = "affaan-m/ECC";

const METHODOLOGY_PATHS = [
  ".agents",
  ".codex",
  "agents",
  "commands",
  "hooks",
  "mcp-configs",
  "rules",
  "skills",
] as const;

const INSTALLER_PATHS = [
  "install.ps1",
  "install.sh",
  "scripts/install-apply.js",
  "scripts/install-plan.js",
  "scripts/uninstall.js",
] as const;

const UPDATE_ENTRYPOINT = "scripts/auto-update.js";
const REPAIR_ENTRYPOINT = "scripts/repair.js";

export interface EccAdapterIdentity {
  id: "builtin:ecc-qualification";
  contractVersion: 1;
  implementationHash: string;
}

export interface EccInertTopology {
  providerKind: "hybrid-catalog-runtime";
  methodologyClosure: readonly string[];
  installerEntrypoints: readonly string[];
  updateEntrypoint: string | undefined;
  repairEntrypoint: string | undefined;
  binEntrypoints: Readonly<Record<string, string>>;
  declaredRuntimeRequirements: {
    node: string | undefined;
    packageManager: string | undefined;
  };
  proposedDestinations: readonly {
    isolationMode: "project-native" | "profile-home" | "machine-exclusive";
    destination: "unknown";
  }[];
}

export interface EccInertQualificationInput {
  source: ExactLocalSourceRequest;
  runner: Runner;
  host: HostLoadSurfaceContract;
  environment: Pick<
    CompatibilityKey,
    "operatingSystem" | "isolationMode" | "runtimes" | "policyVersion"
  >;
  supportedCompatibility?: readonly CompatibilityKey[];
  evidence?: readonly MethodologyEvidence[];
}

export interface EccInertQualification {
  source: ExactLocalSource;
  canonicalRepository: typeof ECC_CANONICAL_REPOSITORY;
  canonicalSourceMatch: boolean;
  discovery: InertProviderDiscovery;
  topology: EccInertTopology;
  plan: ProposedMethodologyPlan;
  compatibilityKey: CompatibilityKey;
  compatibility: CompatibilityResult;
  exactEvidence: MethodologyEvidence | undefined;
  qualification: QualificationResult;
  providerCodeExecuted: false;
}

function qualificationFailure(message: string): never {
  throw new AihError(message, "QUALIFICATION_INCOMPLETE");
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return qualificationFailure(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return qualificationFailure(`${name} must be a string`);
  return value;
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  const record = asRecord(value, name);
  if (Object.values(record).some((entry) => typeof entry !== "string")) {
    return qualificationFailure(`${name} must contain only strings`);
  }
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, entry as string]),
  );
}

function readEccManifest(root: string): EccInertTopology["declaredRuntimeRequirements"] & {
  binEntrypoints: Record<string, string>;
} {
  const path = join(root, "package.json");
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
    return qualificationFailure("ECC manifest must be a real package.json file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return qualificationFailure("ECC manifest is not valid JSON");
  }
  const manifest = asRecord(parsed, "ECC manifest");
  if (manifest.name !== "ecc-universal") {
    return qualificationFailure("ECC manifest name is not ecc-universal");
  }
  const engines = manifest.engines === undefined ? {} : asRecord(manifest.engines, "ECC engines");
  return {
    node: optionalString(engines.node, "ECC engines.node"),
    packageManager: optionalString(manifest.packageManager, "ECC packageManager"),
    binEntrypoints: stringRecord(manifest.bin, "ECC bin"),
  };
}

function presentPaths(
  root: string,
  paths: readonly string[],
  expected: "file" | "directory",
): string[] {
  return paths.filter((path) => {
    const candidate = join(root, path);
    if (!existsSync(candidate)) return false;
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) qualificationFailure(`ECC ${path} must not be a symbolic link`);
    if (expected === "file" && !stat.isFile())
      qualificationFailure(`ECC ${path} must be a regular file`);
    if (expected === "directory" && !stat.isDirectory())
      qualificationFailure(`ECC ${path} must be a directory`);
    return true;
  });
}

function presentFile(root: string, path: string): string | undefined {
  return presentPaths(root, [path], "file").at(0);
}

function eccAdapterIdentity(): EccAdapterIdentity {
  return {
    id: "builtin:ecc-qualification",
    contractVersion: 1,
    implementationHash: createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
  };
}

function topologyFor(root: string): EccInertTopology {
  const manifest = readEccManifest(root);
  return {
    providerKind: "hybrid-catalog-runtime",
    methodologyClosure: presentPaths(root, METHODOLOGY_PATHS, "directory"),
    installerEntrypoints: presentPaths(root, INSTALLER_PATHS, "file"),
    updateEntrypoint: presentFile(root, UPDATE_ENTRYPOINT),
    repairEntrypoint: presentFile(root, REPAIR_ENTRYPOINT),
    binEntrypoints: manifest.binEntrypoints,
    declaredRuntimeRequirements: {
      node: manifest.node,
      packageManager: manifest.packageManager,
    },
    proposedDestinations: [
      { isolationMode: "project-native", destination: "unknown" },
      { isolationMode: "profile-home", destination: "unknown" },
      { isolationMode: "machine-exclusive", destination: "unknown" },
    ],
  };
}

function qualificationWithProvenance(
  qualification: QualificationResult,
  canonicalSourceMatch: boolean,
): QualificationResult {
  if (canonicalSourceMatch) return qualification;
  return {
    ...qualification,
    findings: [...qualification.findings, "PROVIDER_REPOSITORY_NONCANONICAL"],
  };
}

export async function qualifyEccInert(
  input: EccInertQualificationInput,
): Promise<EccInertQualification> {
  const source = await resolveExactLocalSource(input.source, input.runner);
  const discovery = discoverInertProvider({ root: source.root, treeSha256: source.treeSha256 });
  const topology = topologyFor(source.root);
  const plan = createProposedPlan({ discovery, sourceTreeSha256: source.treeSha256 });
  const compatibilityKey: CompatibilityKey = {
    provider: {
      repository: source.repository,
      resolvedCommit: source.resolvedCommit,
      installerContractFingerprint: discovery.installerContractFingerprint,
    },
    adapter: eccAdapterIdentity(),
    host: {
      id: input.host.host.id,
      version: input.host.host.version,
      build: input.host.host.build,
      loadSurfaceContractVersion: input.host.id,
      loadSurfaceCoverage: input.host.coverage,
    },
    ...input.environment,
  };
  const compatibility = resolveCompatibility(compatibilityKey, input.supportedCompatibility ?? []);
  const canonicalSourceMatch = source.repository === ECC_CANONICAL_REPOSITORY;
  const qualification = qualificationWithProvenance(
    qualifyMethodology({
      compatibility: compatibility.status,
      hostCoverage: input.host.coverage,
      isolation: "unknown",
      selfUpdater: "unknown",
    }),
    canonicalSourceMatch,
  );
  return {
    source,
    canonicalRepository: ECC_CANONICAL_REPOSITORY,
    canonicalSourceMatch,
    discovery,
    topology,
    plan,
    compatibilityKey,
    compatibility,
    exactEvidence: joinExactEvidence(source, topology.methodologyClosure, input.evidence ?? []),
    qualification,
    providerCodeExecuted: false,
  };
}
