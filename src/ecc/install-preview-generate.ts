import { createRequire } from "node:module";
import { join } from "node:path";
import { entry } from "../internals/cli-registry.js";
import type { Cli } from "../internals/clis.js";
import type { EccComponentId } from "./components.js";
import {
  type ContingentEccInstallOperation,
  type EccInstallPreviewArtifact,
  parseEccInstallPreview,
} from "./install-preview.js";
import { eccMaterializationSpec, filterEccManifestPlan } from "./materialize.js";

const PREVIEW_TARGETS = [
  "claude",
  "codex",
  "cursor",
  "antigravity",
  "gemini",
  "opencode",
  "zed",
] as const satisfies readonly Cli[];
const HOME_FIXTURE = "/home/aih";
const PROJECT_FIXTURE = "/workspace/project";
const CODEX_SHARED_SOURCES = new Set(["AGENTS.md", ".codex/AGENTS.md", ".codex/config.toml"]);
const SCOPED_MCP_COMPONENTS = [
  "mcp:sequential-thinking",
  "mcp:code-review-graph",
  "mcp:codebase-memory-mcp",
  "mcp:github",
  "mcp:context7",
  "mcp:exa",
] as const;

interface UpstreamOperation {
  kind: "copy-file" | "merge-json";
  moduleId: string;
  sourceRelativePath: string;
  destinationPath: string;
}

interface UpstreamPlan {
  operations: UpstreamOperation[];
  statePreview: { operations: UpstreamOperation[] };
}

interface UpstreamInstaller {
  createManifestInstallPlan(input: {
    sourceRoot: string;
    target: string;
    profileId: null;
    moduleIds: string[];
    homeDir: string;
    projectRoot: string;
  }): UpstreamPlan;
}

interface UpstreamManifests {
  listInstallComponents(): Array<{ id: string }>;
}

interface UpstreamTargetRegistry {
  getInstallTargetAdapter(target: string): {
    resolveRoot(input: { repoRoot: string; projectRoot: string; homeDir: string }): string;
  };
}

function destinationTemplate(path: string): string {
  return path
    .replace(HOME_FIXTURE, "<home>")
    .replace(PROJECT_FIXTURE, "<project>")
    .replace(/\\/g, "/");
}

function configDestinationTemplate(path: string): string {
  const posix = path.replace(/\\/g, "/");
  if (posix.startsWith("~/")) return `<home>/${posix.slice(2)}`;
  return `<project>/${posix.replace(/^\.\//, "")}`;
}

function operationKey(operation: ContingentEccInstallOperation): string {
  return [
    operation.target,
    operation.componentId,
    operation.kind,
    operation.destination,
    operation.source ?? "",
  ].join("\0");
}

function componentOperations(
  installer: UpstreamInstaller,
  eccRoot: string,
  componentId: EccComponentId,
  target: (typeof PREVIEW_TARGETS)[number],
): ContingentEccInstallOperation[] {
  const selection = {
    scope: "scoped" as const,
    components: [componentId],
    mcps: [],
    recommendations: [],
  };
  let spec: ReturnType<typeof eccMaterializationSpec>;
  try {
    spec = eccMaterializationSpec(selection);
  } catch {
    return [];
  }
  let upstream: UpstreamPlan;
  try {
    upstream = installer.createManifestInstallPlan({
      sourceRoot: eccRoot,
      target,
      profileId: null,
      moduleIds: spec.moduleIds,
      homeDir: HOME_FIXTURE,
      projectRoot: PROJECT_FIXTURE,
    });
  } catch (error) {
    if (
      target === "opencode" &&
      error instanceof Error &&
      error.message.includes("compiled plugin payload")
    ) {
      return [];
    }
    throw error;
  }
  filterEccManifestPlan(upstream, selection);
  return upstream.operations
    .filter(
      (operation) =>
        target !== "codex" ||
        !CODEX_SHARED_SOURCES.has(operation.sourceRelativePath.replace(/\\/g, "/")),
    )
    .map((operation) => ({
      target,
      kind: operation.kind,
      source: operation.sourceRelativePath.replace(/\\/g, "/"),
      destination: destinationTemplate(operation.destinationPath),
      componentId,
      contingentOn: "evidence-authorization",
    }));
}

export function generateEccInstallPreviewArtifact(
  eccRoot: string,
  pinnedSha: string,
): EccInstallPreviewArtifact {
  const require = createRequire(join(eccRoot, "package.json"));
  const installer = require(join(eccRoot, "scripts/lib/install-executor.js")) as UpstreamInstaller;
  const manifests = require(join(eccRoot, "scripts/lib/install-manifests.js")) as UpstreamManifests;
  const targetRegistry = require(
    join(eccRoot, "scripts/lib/install-targets/registry.js"),
  ) as UpstreamTargetRegistry;
  const operations: ContingentEccInstallOperation[] = [];
  for (const { id } of manifests.listInstallComponents()) {
    for (const target of PREVIEW_TARGETS) {
      operations.push(...componentOperations(installer, eccRoot, id as EccComponentId, target));
    }
  }
  for (const target of PREVIEW_TARGETS) {
    const targetRoot = targetRegistry.getInstallTargetAdapter(target).resolveRoot({
      repoRoot: eccRoot,
      projectRoot: PROJECT_FIXTURE,
      homeDir: HOME_FIXTURE,
    });
    operations.push({
      target,
      kind: "exec",
      source:
        target === "codex" ? "scripts/codex/merge-codex-config.js" : "scripts/install-apply.js",
      destination: destinationTemplate(targetRoot),
      componentId: "runtime:ecc-installer",
      contingentOn: "evidence-authorization",
    });
    if (target === "codex") {
      operations.push(
        {
          target,
          kind: "managed-block",
          source: ".codex/AGENTS.md",
          destination: "<home>/.codex/AGENTS.md",
          componentId: "runtime:ecc-installer",
          contingentOn: "evidence-authorization",
        },
        {
          target,
          kind: "managed-block",
          source: "scripts/codex/merge-codex-config.js",
          destination: "<home>/.codex/config.toml",
          componentId: "runtime:ecc-installer",
          contingentOn: "evidence-authorization",
        },
      );
      for (const componentId of SCOPED_MCP_COMPONENTS) {
        operations.push({
          target,
          kind: "managed-block",
          destination: "<home>/.codex/config.toml",
          componentId,
          contingentOn: "evidence-authorization",
        });
      }
    }
    const mcp = entry(target).mcp;
    if (mcp.support === "native" && mcp.configFormat === "json" && mcp.configPath) {
      for (const componentId of SCOPED_MCP_COMPONENTS) {
        operations.push({
          target,
          kind: "merge-json",
          destination: configDestinationTemplate(mcp.configPath),
          componentId,
          contingentOn: "evidence-authorization",
        });
      }
    }
    operations.push({
      target,
      kind: "exec",
      source: "aih ledger-last writer",
      destination: "<home>/.aih/ecc/registration-ledger.json",
      componentId: "runtime:ecc-installer",
      contingentOn: "evidence-authorization",
    });
  }
  operations.push({
    target: "kiro",
    kind: "exec",
    source: ".kiro/install.sh",
    destination: "<project>/.kiro",
    componentId: "runtime:ecc-kiro",
    contingentOn: "evidence-authorization",
  });
  operations.sort((left, right) => operationKey(left).localeCompare(operationKey(right)));
  return parseEccInstallPreview({
    schemaVersion: 1,
    source: { owner: "samartomar", repo: "ECC", pinnedSha },
    operations,
  });
}
