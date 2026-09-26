import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedCodeReviewGraphEnvironment } from "../ecc-profile/code-review-graph-runtime.js";
import { codebaseMemoryCoordinationRoot } from "../ecc-profile/codebase-memory-coordination.js";
import { authenticateDefaultMcpRuntimeRoot } from "../ecc-profile/default-mcp-runtime-auth.js";
import {
  CODE_REVIEW_GRAPH_RUNTIME_PIN,
  CODEBASE_MEMORY_RUNTIME_PIN,
  DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
} from "../ecc-profile/default-mcp-runtime-lock.js";
import { SERENA_RUNTIME_PIN } from "../ecc-profile/mcp-profile.js";
import { SERENA_DEPENDENCY_LOCK_SHA256 } from "../ecc-profile/native-registration.js";
import { prepareOwnedStateDirectory } from "../ecc-profile/native-runtime.js";
import type { PlanContext } from "../internals/plan.js";
import { findOnPath } from "../live/runner.js";
import {
  isRootAwareLauncherId,
  rootAwareLauncherOptionsV1,
  rootAwareLauncherRiskV1,
  rootAwareLauncherSpecV1,
  rootAwareLauncherSubjectV1,
} from "./root-aware-launcher-identity.js";
import type { McpServer } from "./servers.js";

export interface DefaultNativeRuntimeLayout {
  project: string;
  runtimeScript: string;
  defaultMcpLockRoot: string;
  serenaLockRoot: string;
  markitdownLockRoot: string;
  uvCache: string;
  memoryPayloadRoot: string;
  tokenOptimizerRoot: string;
  projectStateRoot: string;
  runtimeReceiptPath: string;
  graphStateRoot: string;
  memoryStateRoot: string;
  memoryCoordinationRoot: string;
  serenaStateRoot: string;
}

function packagedDirectory(
  name: "default-mcp-runtime" | "serena-runtime" | "markitdown-runtime",
): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../ecc-profile", name),
    resolve(moduleDirectory, "../src/ecc-profile", name),
    resolve(moduleDirectory, "../../src/ecc-profile", name),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error(`packaged ${name} dependency lock is missing`);
  return realpathSync(found);
}

export function defaultRuntimeScriptPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return basename(moduleDirectory).toLowerCase() === "dist"
    ? join(moduleDirectory, "ecc-runtime.js")
    : resolve(moduleDirectory, "../../dist/ecc-runtime.js");
}

function stateBase(ctx: PlanContext): string {
  if (ctx.host.platform === "windows") {
    return (
      ctx.env.LOCALAPPDATA ??
      (ctx.env.USERPROFILE ? join(ctx.env.USERPROFILE, "AppData", "Local") : undefined) ??
      join(homedir(), "AppData", "Local")
    );
  }
  return ctx.env.XDG_STATE_HOME ?? join(ctx.env.HOME ?? homedir(), ".local", "state");
}

export function defaultNativeRuntimeLayout(ctx: PlanContext): DefaultNativeRuntimeLayout {
  const project = realpathSync(ctx.root);
  const key = createHash("sha256").update(project).digest("hex").slice(0, 20);
  // MSIX/AppContainer path virtualization adds hidden LocalCache ancestry on
  // Windows. Compact state segments keep pinned Python modules below legacy
  // import-path limits without changing user settings or the Unix layout.
  const compact = ctx.host.platform === "windows";
  const base = join(stateBase(ctx), "aih", compact ? "d" : "developer-tools");
  const shared = join(base, compact ? "r" : "runtime");
  const projectState = join(base, compact ? "p" : "projects", key);
  return {
    project,
    runtimeScript: defaultRuntimeScriptPath(),
    defaultMcpLockRoot: packagedDirectory("default-mcp-runtime"),
    serenaLockRoot: packagedDirectory("serena-runtime"),
    markitdownLockRoot: packagedDirectory("markitdown-runtime"),
    uvCache: join(shared, compact ? "u" : "uv-cache"),
    memoryPayloadRoot: join(shared, compact ? "m" : "codebase-memory-payload"),
    tokenOptimizerRoot: join(shared, compact ? "t" : "token-optimizer"),
    projectStateRoot: projectState,
    runtimeReceiptPath: join(projectState, "developer-tools-receipt.json"),
    graphStateRoot: join(projectState, compact ? "g" : "code-review-graph"),
    memoryStateRoot: join(projectState, compact ? "m" : "codebase-memory"),
    memoryCoordinationRoot: codebaseMemoryCoordinationRoot(ctx.env, project, process.platform),
    serenaStateRoot: join(projectState, compact ? "s" : "serena"),
  };
}

function wrapperArgs(layout: DefaultNativeRuntimeLayout, mode: string): string[] {
  return [layout.runtimeScript, mode];
}

export function defaultNativeMcpServers(ctx: PlanContext): Record<string, McpServer> {
  const layout = defaultNativeRuntimeLayout(ctx);
  return {
    "code-review-graph": {
      type: "stdio",
      command: process.execPath,
      args: [
        ...wrapperArgs(layout, "code-review-graph"),
        "--package",
        CODE_REVIEW_GRAPH_RUNTIME_PIN.package,
        "--dependency-lock-sha256",
        DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
        "--lock-root",
        layout.defaultMcpLockRoot,
        "--project",
        layout.project,
        "--state-root",
        layout.graphStateRoot,
        "--uv-cache",
        layout.uvCache,
      ],
      description:
        "AIH-owned Code Review Graph 2.3.9 launcher for this canonical worktree. It exposes five reviewed operations, strips cloud-provider settings, and refuses provider/model refresh arguments. This is an environment and protocol boundary, not an operating-system network sandbox.",
      classification: "local",
      egress: "local-only",
      credentials: "none",
      supplyChain: "pinned",
    },
    "codebase-memory-mcp": {
      type: "stdio",
      command: process.execPath,
      args: [
        ...wrapperArgs(layout, "codebase-memory-mcp"),
        "--package",
        CODEBASE_MEMORY_RUNTIME_PIN.package,
        "--dependency-lock-sha256",
        DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
        "--lock-root",
        layout.defaultMcpLockRoot,
        "--project",
        layout.project,
        "--state-root",
        layout.memoryStateRoot,
        "--coordination-root",
        layout.memoryCoordinationRoot,
        "--runtime-home",
        layout.memoryPayloadRoot,
        "--uv-cache",
        layout.uvCache,
      ],
      description:
        "AIH-owned Codebase Memory MCP 0.11.0 launcher with a verified native payload cache, project-specific index, and a short authenticated coordination root. Setup downloads the exact release payload; steady-state launch is offline.",
      classification: "local",
      egress: "local-only",
      credentials: "none",
      supplyChain: "pinned",
    },
    serena: {
      type: "stdio",
      command: process.execPath,
      args: [
        ...wrapperArgs(layout, "serena"),
        "--package",
        SERENA_RUNTIME_PIN.package,
        "--dependency-lock-sha256",
        SERENA_DEPENDENCY_LOCK_SHA256,
        "--lock-root",
        layout.serenaLockRoot,
        "--context",
        "ide-assistant",
        "--mode",
        "no-memories",
        "--project",
        layout.project,
        "--state-root",
        layout.serenaStateRoot,
      ],
      description:
        "AIH-owned Serena 1.7.0 launcher for this canonical worktree, using the authenticated dependency closure, isolated state, disabled memories and a reviewed semantic-tool allowlist.",
      classification: "local",
      egress: "local-only",
      credentials: "none",
      supplyChain: "pinned",
    },
  };
}

const LAUNCHER_FIELDS = new Set([
  "type",
  "command",
  "args",
  "description",
  "classification",
  "egress",
  "credentials",
  "supplyChain",
]);

/**
 * The portable subject of a root-aware launcher, reported only after verifying locally
 * that `server` is exactly Core's own launcher for `id`: this Node executable, Core's own
 * wrapper in that server's mode, every expected option once and nothing else, the pinned
 * package and dependency lock, Core's packaged lock directory, the fixed options, absolute
 * machine paths, no environment and the launcher's risk axes. Anything else reports no
 * identity, so a selection naming the portable subject stays a runtime identity mismatch.
 */
export function verifiedRootAwareLauncherSubjectV1(
  id: string,
  server: McpServer,
): string | undefined {
  if (!isRootAwareLauncherId(id) || server.type !== "stdio") return undefined;
  if (Object.keys(server).some((field) => !LAUNCHER_FIELDS.has(field))) return undefined;
  const risk = rootAwareLauncherRiskV1();
  if (
    server.classification !== risk.classification ||
    server.egress !== risk.egress ||
    server.credentials !== risk.credentials ||
    server.supplyChain !== risk.supplyChain
  )
    return undefined;
  if (server.command !== process.execPath) return undefined;
  const [wrapper, mode, ...rest] = server.args;
  if (wrapper === undefined || resolve(wrapper) !== resolve(defaultRuntimeScriptPath()))
    return undefined;
  if (mode !== id) return undefined;
  const expected = rootAwareLauncherOptionsV1(id);
  if (rest.length !== expected.length * 2) return undefined;
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index] ?? "";
    const value = rest[index + 1] ?? "";
    if (!expected.includes(flag) || values.has(flag) || value === "" || value.startsWith("--"))
      return undefined;
    values.set(flag, value);
  }
  const spec = rootAwareLauncherSpecV1(id);
  if (values.get("--package") !== spec.package) return undefined;
  if (values.get("--dependency-lock-sha256") !== spec.dependencyLockSha256) return undefined;
  if (resolve(values.get("--lock-root") ?? "") !== packagedDirectory(spec.lockDirectory))
    return undefined;
  for (const [flag, value] of Object.entries(spec.fixedOptions))
    if (values.get(flag) !== value) return undefined;
  for (const flag of spec.pathOptions) if (!isAbsolute(values.get(flag) ?? "")) return undefined;
  return rootAwareLauncherSubjectV1(id);
}

export function managedCodeReviewGraphCliInvocation(
  ctx: PlanContext,
  operation: "status" | "build",
): { argv: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const layout = defaultNativeRuntimeLayout(ctx);
  const lockRoot = authenticateDefaultMcpRuntimeRoot(layout.defaultMcpLockRoot, layout.project, [
    layout.graphStateRoot,
    layout.uvCache,
  ]);
  const uv = findOnPath("uv", ctx.env, process.platform, {
    excludeRoot: layout.project,
    windowsExeOnly: true,
  });
  if (uv === undefined)
    throw new Error("managed Graph uv executable is unavailable on external absolute PATH");
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  };
  const stateRoots = [layout.graphStateRoot, layout.uvCache];
  const assertDisjoint = (state: string) => {
    if (contains(layout.project, state) || contains(state, layout.project))
      throw new Error("managed Graph state must remain outside and disjoint from the project");
  };
  // Reject project overlap before creating either state directory. Validate every
  // path segment so a junction cannot redirect the doctor's direct CLI route.
  stateRoots.forEach(assertDisjoint);
  const graphStateRoot = prepareOwnedStateDirectory(layout.graphStateRoot, "Graph state root");
  const uvCache = prepareOwnedStateDirectory(layout.uvCache, "Graph uv cache");
  [graphStateRoot, uvCache].forEach(assertDisjoint);
  authenticateDefaultMcpRuntimeRoot(lockRoot, layout.project, [graphStateRoot, uvCache]);
  const operationArgs =
    operation === "status"
      ? ["status", "--repo", layout.project, "--data-dir", graphStateRoot, "--json"]
      : ["build", "--repo", layout.project, "--data-dir", graphStateRoot, "--quiet"];
  return {
    argv: [
      uv,
      "--project",
      lockRoot,
      "run",
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "--frozen",
      "code-review-graph",
      ...operationArgs,
    ],
    cwd: layout.project,
    env: isolatedCodeReviewGraphEnvironment(ctx.env, graphStateRoot, uvCache),
  };
}
