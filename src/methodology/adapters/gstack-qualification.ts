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

export const GSTACK_CANONICAL_REPOSITORY = "garrytan/gstack";

const METHODOLOGY_PATHS = ["agents", "claude", "codex", "gstack", "hosts"] as const;
const SETUP_ENTRYPOINTS = [
  "bin/gstack-team-init",
  "bin/gstack-gbrain-install",
  "scripts/setup-scc.sh",
] as const;
const UNINSTALL_ENTRYPOINTS = ["bin/gstack-uninstall", "bin/gstack-brain-uninstall"] as const;
const UPDATE_ENTRYPOINT = "bin/gstack-update-check";
const BROWSER_PATHS = ["browse", "open-gstack-browser"] as const;
const DAEMON_ENTRYPOINTS = ["bin/gstack-ios-qa-daemon", "design/src/daemon.ts"] as const;
const CODEX_DIRECTORY = "codex";
const CODEX_FILES = ["hosts/codex.ts", "bin/gstack-codex-probe"] as const;
const TEAM_MODE_ENTRYPOINTS = ["bin/gstack-team-init"] as const;

export interface GstackAdapterIdentity {
  id: "builtin:gstack-qualification";
  contractVersion: 1;
  implementationHash: string;
}

export interface GstackInertTopology {
  providerKind: "hybrid-host-setup";
  methodologyClosure: readonly string[];
  setupEntrypoints: readonly string[];
  uninstallEntrypoints: readonly string[];
  updateEntrypoint: string | undefined;
  browserPaths: readonly string[];
  daemonEntrypoints: readonly string[];
  codexPaths: readonly string[];
  teamModeEntrypoints: readonly string[];
  binEntrypoints: Readonly<Record<string, string>>;
  declaredRuntimeRequirements: {
    bun: string | undefined;
    node: string | undefined;
  };
  proposedDestinations: readonly {
    isolationMode: "project-native" | "profile-home" | "machine-exclusive";
    destination: "unknown";
  }[];
}

export interface GstackInertQualificationInput {
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

export interface GstackInertQualification {
  source: ExactLocalSource;
  canonicalRepository: typeof GSTACK_CANONICAL_REPOSITORY;
  canonicalSourceMatch: boolean;
  discovery: InertProviderDiscovery;
  topology: GstackInertTopology;
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

function readGstackManifest(root: string): GstackInertTopology["declaredRuntimeRequirements"] & {
  binEntrypoints: Record<string, string>;
} {
  const path = join(root, "package.json");
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
    return qualificationFailure("gstack manifest must be a real package.json file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return qualificationFailure("gstack manifest is not valid JSON");
  }
  const manifest = asRecord(parsed, "gstack manifest");
  if (manifest.name !== "gstack") return qualificationFailure("gstack manifest name is not gstack");
  const engines =
    manifest.engines === undefined ? {} : asRecord(manifest.engines, "gstack engines");
  return {
    bun: optionalString(engines.bun, "gstack engines.bun"),
    node: optionalString(engines.node, "gstack engines.node"),
    binEntrypoints: stringRecord(manifest.bin, "gstack bin"),
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
    if (stat.isSymbolicLink()) qualificationFailure(`gstack ${path} must not be a symbolic link`);
    if (expected === "file" && !stat.isFile()) {
      qualificationFailure(`gstack ${path} must be a regular file`);
    }
    if (expected === "directory" && !stat.isDirectory()) {
      qualificationFailure(`gstack ${path} must be a directory`);
    }
    return true;
  });
}

function presentFile(root: string, path: string): string | undefined {
  return presentPaths(root, [path], "file").at(0);
}

function gstackAdapterIdentity(): GstackAdapterIdentity {
  return {
    id: "builtin:gstack-qualification",
    contractVersion: 1,
    implementationHash: createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
  };
}

function topologyFor(root: string): GstackInertTopology {
  const manifest = readGstackManifest(root);
  return {
    providerKind: "hybrid-host-setup",
    methodologyClosure: presentPaths(root, METHODOLOGY_PATHS, "directory"),
    setupEntrypoints: presentPaths(root, SETUP_ENTRYPOINTS, "file"),
    uninstallEntrypoints: presentPaths(root, UNINSTALL_ENTRYPOINTS, "file"),
    updateEntrypoint: presentFile(root, UPDATE_ENTRYPOINT),
    browserPaths: presentPaths(root, BROWSER_PATHS, "directory"),
    daemonEntrypoints: presentPaths(root, DAEMON_ENTRYPOINTS, "file"),
    codexPaths: [
      ...presentPaths(root, [CODEX_DIRECTORY], "directory"),
      ...presentPaths(root, CODEX_FILES, "file"),
    ],
    teamModeEntrypoints: presentPaths(root, TEAM_MODE_ENTRYPOINTS, "file"),
    binEntrypoints: manifest.binEntrypoints,
    declaredRuntimeRequirements: { bun: manifest.bun, node: manifest.node },
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

export async function qualifyGstackInert(
  input: GstackInertQualificationInput,
): Promise<GstackInertQualification> {
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
    adapter: gstackAdapterIdentity(),
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
  const canonicalSourceMatch = source.repository === GSTACK_CANONICAL_REPOSITORY;
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
    canonicalRepository: GSTACK_CANONICAL_REPOSITORY,
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
