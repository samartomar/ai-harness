import { existsSync, lstatSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import { asPosture } from "../config/posture.js";
import { AihError, SettingsError } from "../errors.js";
import { bootloadersFor, entry as registryEntry } from "../internals/cli-registry.js";
import { type Cli, resolveClis } from "../internals/clis.js";
import { readRegularFile } from "../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";
import type { Action, CommandSpec, Plan, PlanContext, WriteAction } from "../internals/plan.js";
import { doc, exec, plan, probe, writeJson, writeText } from "../internals/plan.js";
import { frontmatter } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import { readMcpOrgPolicy } from "../mcp/catalog.js";
import {
  deniedServers,
  evaluateMcpPolicy,
  type McpPosture,
  mcpPolicyOptionsFromConfig,
} from "../mcp/policy.js";
import type { McpServer } from "../mcp/servers.js";
import type { OrgPolicy } from "../org-policy/schema.js";
import { classifyIncomingMcp } from "../trust/mcp-classify.js";
import {
  checkWorkspaceChildPath,
  detectChildRepos,
  discoverChildGitRepos,
  reposOption,
} from "./detect.js";
import { workspaceGitExecs, workspaceGitignoreWrite } from "./git.js";
import { workspaceHydrateCommand } from "./hydrate.js";
import { workspaceLinkCommand } from "./link.js";
import {
  readWorkspaceManifest,
  type WorkspaceManifest,
  type WorkspaceRepo,
  workspaceReposFromPaths,
} from "./manifest.js";
import { snapshotCommand } from "./snapshot.js";
import { taskPlanCommand } from "./task-plan.js";
import {
  codeWorkspace,
  crossRepoArchitectureDoc,
  isLegacyAihWorkspaceMcpServer,
  nextStepsDoc,
  repoDisciplineDoc,
  spanningMcp,
  workspaceBootloader,
  workspaceContractsDoc,
  workspaceMarker,
  workspaceRouterDoc,
} from "./templates.js";

/** Probe: is the child repo scaffolded (its canon present)? Absent → skip with the fix. */
function childScaffoldedProbe(repo: string, dir: string): Action {
  return probe(`child ${repo} scaffolded`, (ctx: PlanContext): Check => {
    const name = `child ${repo} scaffolded`;
    const repoRoot = join(ctx.root, repo);
    if (!existsSync(repoRoot)) {
      return {
        name,
        verdict: "skip",
        detail:
          "child repo path is missing — run `aih workspace hydrate --apply` or create the child repo",
      };
    }
    const present = existsSync(join(repoRoot, dir, "RULE_ROUTER.md"));
    return present
      ? { name, verdict: "pass", detail: `${repo}/${dir}/ canon present` }
      : {
          name,
          verdict: "skip",
          detail: "not scaffolded — run `aih init --apply` inside the child repo",
        };
  });
}

const EXACT_PACKAGE_RE =
  /^(?:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const PACKAGE_RESOLVERS = new Set(["npx", "uvx", "uv", "bunx", "pnpm", "yarn", "pipx"]);

const RESOLVER_BOOLEAN_FLAGS = new Set([
  "-y",
  "--yes",
  "--offline",
  "--no-python-downloads",
  "--no-env-file",
]);

const DOCKER_BOOLEAN_RUN_FLAGS = new Set(["--init", "--read-only", "--rm"]);

const DOCKER_VALUE_RUN_FLAGS = new Set([
  "-e",
  "--env",
  "--env-file",
  "-h",
  "--hostname",
  "--name",
  "--network",
  "-p",
  "--publish",
  "-u",
  "--user",
  "-v",
  "--volume",
  "-w",
  "--workdir",
  "--add-host",
  "--entrypoint",
  "--platform",
  "--pull",
]);

const PINNED_GITHUB_MCP_IMAGE_RE =
  /^ghcr\.io\/github\/github-mcp-server(?::v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|@sha256:[a-f0-9]{64})$/;

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidOrgPolicyError(error: unknown): SettingsError {
  return new SettingsError(`aih-org-policy.json cannot be parsed (${errorDetail(error)})`);
}

function workspaceMcpConfigPath(ctx: PlanContext, repo: string | undefined): string {
  return repo === undefined ? join(ctx.root, ".mcp.json") : join(ctx.root, repo, ".mcp.json");
}

function workspaceMcpConfigRel(repo: string | undefined): string {
  return repo === undefined ? ".mcp.json" : posix.join(repo, ".mcp.json");
}

function readWorkspaceMcpConfig(path: string): { text?: string; absent?: true; issue?: string } {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { absent: true };
    return { issue: `cannot stat .mcp.json (${errorDetail(error)})` };
  }
  if (stat.isSymbolicLink()) {
    return { issue: ".mcp.json is a symlink; replace it with a regular file" };
  }
  if (!stat.isFile()) return { issue: ".mcp.json is not a regular file" };
  const bytes = readRegularFile(path);
  if (bytes === undefined) return { issue: ".mcp.json cannot be read as a regular file" };
  // Defense in depth for platforms where O_NOFOLLOW is unavailable at open time:
  // re-check that the path still names the same regular file after reading. This
  // narrows the Windows race window, though a local writer with directory access
  // can still modify the file directly and must not be considered trusted input.
  let after: ReturnType<typeof lstatSync>;
  try {
    after = lstatSync(path);
  } catch (error) {
    return { issue: `cannot re-stat .mcp.json after reading (${errorDetail(error)})` };
  }
  if (after.isSymbolicLink() || !after.isFile()) {
    return { issue: ".mcp.json changed while it was being read" };
  }
  if (
    after.dev !== stat.dev ||
    after.ino !== stat.ino ||
    after.size !== stat.size ||
    after.mtimeMs !== stat.mtimeMs
  ) {
    return { issue: ".mcp.json changed while it was being read" };
  }
  return { text: bytes.toString("utf8") };
}

function commandName(command: string): string {
  const last = command.split(/[\\/]/).at(-1) ?? command;
  return last.replace(/\.(?:cmd|exe)$/i, "").toLowerCase();
}

function resolverPackageArg(command: string, args: readonly string[]): string | undefined {
  if (!PACKAGE_RESOLVERS.has(commandName(command))) return undefined;
  for (const raw of args) {
    const arg = raw.trim();
    if (arg.length === 0) continue;
    if (RESOLVER_BOOLEAN_FLAGS.has(arg)) continue;
    if (arg.startsWith("-")) return undefined;
    return arg;
  }
  return undefined;
}

function isDockerBooleanShortFlag(arg: string): boolean {
  return /^-[itd]+$/.test(arg);
}

function dockerImageArg(command: string, args: readonly string[]): string | undefined {
  if (!["docker", "podman"].includes(commandName(command))) return undefined;
  if (args[0] !== "run") return undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]?.trim() ?? "";
    if (arg.length === 0) continue;
    if (arg === "--") return args[index + 1];
    if (DOCKER_BOOLEAN_RUN_FLAGS.has(arg) || isDockerBooleanShortFlag(arg)) continue;
    if (DOCKER_VALUE_RUN_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (arg.startsWith("-")) return undefined;
    return arg;
  }
  return undefined;
}

function workspaceStdioSupplyChain(
  current: McpServer["supplyChain"],
  command: string,
  args: readonly string[],
): McpServer["supplyChain"] {
  const packageArg = resolverPackageArg(command, args);
  if (packageArg !== undefined) return EXACT_PACKAGE_RE.test(packageArg) ? "pinned" : "unpinned";
  const imageArg = dockerImageArg(command, args);
  if (imageArg !== undefined && PINNED_GITHUB_MCP_IMAGE_RE.test(imageArg)) return "pinned";
  return current === "hosted-remote" ? current : "unpinned";
}

function classifyWorkspaceMcpServer(raw: unknown): McpServer {
  const classified = classifyIncomingMcp(raw);
  return classified.type === "stdio"
    ? {
        ...classified,
        supplyChain: workspaceStdioSupplyChain(
          classified.supplyChain,
          classified.command,
          classified.args,
        ),
      }
    : classified;
}

function classifyWorkspaceMcpServers(parsed: unknown): {
  servers?: Record<string, McpServer>;
  error?: string;
} {
  if (!isPlainObject(parsed)) return { error: ".mcp.json root must be an object" };
  const rawServers = parsed.mcpServers;
  if (rawServers === undefined) return { servers: {} };
  if (!isPlainObject(rawServers)) return { error: ".mcp.json mcpServers must be an object" };
  return {
    servers: Object.fromEntries(
      Object.entries(rawServers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, raw]) => [name, classifyWorkspaceMcpServer(raw)]),
    ),
  };
}

function workspaceMcpConfigIssue(name: string, rel: string, detail: string): Check {
  return {
    name,
    verdict: "fail",
    detail: `${rel}: ${detail}`,
    code: "mcp.config-invalid",
    location: { uri: rel, startLine: 1 },
  };
}

function displayMcpServerName(name: string): string {
  const printable = [...name]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "?" : char;
    })
    .join("");
  return printable.length <= 120 ? printable : `${printable.slice(0, 117)}...`;
}

function workspacePolicyDetail(
  policy: { name: string; reason: string },
  server: McpServer | undefined,
): string {
  if (server?.egress !== "third-party") return policy.reason;
  return `${policy.reason}; org-policy egress approvals do not apply to workspace on-disk MCP configs`;
}

function workspaceMcpPolicyProbe(
  label: string,
  repo: string | undefined,
  posture: McpPosture,
  policy: OrgPolicy | undefined,
): Action {
  return probe(`${label} MCP policy`, (ctx: PlanContext): Check => {
    const name = `${label} MCP policy`;
    const rel = workspaceMcpConfigRel(repo);
    const config = readWorkspaceMcpConfig(workspaceMcpConfigPath(ctx, repo));
    if (config.absent === true) {
      return {
        name,
        verdict: "skip",
        detail: `${rel} is absent — no on-disk MCP config to evaluate`,
        code: "mcp.config-missing",
        location: { uri: rel, startLine: 1 },
      };
    }
    if (config.issue !== undefined) return workspaceMcpConfigIssue(name, rel, config.issue);

    let parsed: unknown;
    try {
      parsed = parseJsoncText(config.text ?? "");
    } catch (error) {
      return workspaceMcpConfigIssue(name, rel, `malformed MCP config (${errorDetail(error)})`);
    }

    const classified = classifyWorkspaceMcpServers(parsed);
    if (classified.error !== undefined) return workspaceMcpConfigIssue(name, rel, classified.error);
    const servers = classified.servers ?? {};
    const denied = deniedServers(
      evaluateMcpPolicy(
        servers,
        posture,
        mcpPolicyOptionsFromConfig(policy?.mcp, { includeEgressApprovals: false }),
      ),
    );
    if (denied.length > 0) {
      return {
        name,
        verdict: "fail",
        detail: `${rel} denied — self-host, pin, approve, or remove before an enterprise rollout: ${denied
          .map(
            (p) => `${displayMcpServerName(p.name)} (${workspacePolicyDetail(p, servers[p.name])})`,
          )
          .join("; ")}`,
        code: "mcp.policy-denied",
        location: { uri: rel, startLine: 1 },
      };
    }
    const count = Object.keys(servers).length;
    return {
      name,
      verdict: "pass",
      detail: `${rel}: ${count} MCP server${count === 1 ? "" : "s"} allowed under the enterprise posture`,
    };
  });
}

function staleManagedMcpServerKeys(root: string, incomingKeys: readonly string[]): string[] {
  const config = readWorkspaceMcpConfig(resolve(root, ".mcp.json"));
  if (config.text === undefined) return [];
  try {
    const parsed = JSON.parse(config.text) as { mcpServers?: unknown };
    if (
      typeof parsed.mcpServers !== "object" ||
      parsed.mcpServers === null ||
      Array.isArray(parsed.mcpServers)
    ) {
      return [];
    }
    const incoming = new Set(incomingKeys);
    return Object.entries(parsed.mcpServers)
      .filter(([name]) => !incoming.has(name))
      .filter(([name, value]) => isLegacyAihWorkspaceMcpServer(name, value))
      .map(([name]) => name);
  } catch {
    return [];
  }
}

function repoObjectEntriesByPath(manifest: WorkspaceManifest | undefined): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const rawRepos = manifest?.raw.repos;
  if (manifest === undefined || !Array.isArray(rawRepos)) return out;
  manifest.repos.forEach((repo, index) => {
    const raw = rawRepos[index];
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      out.set(repo.path, raw);
    }
  });
  return out;
}

function reposFromPathsWithExistingMetadata(
  paths: readonly string[],
  manifest: WorkspaceManifest | undefined,
  router: string,
): WorkspaceRepo[] {
  const generated = workspaceReposFromPaths(paths, router);
  if (manifest === undefined) return generated;
  const byPath = new Map(manifest.repos.map((repo) => [repo.path, repo]));
  return generated.map((repo) => byPath.get(repo.path) ?? repo);
}

function repoMarkerEntry(repo: WorkspaceRepo): string | WorkspaceRepo {
  const hasMetadata =
    repo.kind !== undefined ||
    repo.owner !== undefined ||
    repo.remote !== undefined ||
    repo.ref !== undefined;
  return hasMetadata ? repo : repo.path;
}

function markerRepoEntries(
  manifest: WorkspaceManifest | undefined,
  repos: readonly WorkspaceRepo[],
): unknown[] {
  const existingObjects = repoObjectEntriesByPath(manifest);
  if (existingObjects.size === 0) return repos.map(repoMarkerEntry);
  return repos.map((repo) => existingObjects.get(repo.path) ?? repo);
}

function markerForWrite(
  manifest: WorkspaceManifest | undefined,
  repos: readonly WorkspaceRepo[],
  dir: string,
  enableGit: boolean,
): unknown {
  const repoPaths = repos.map((repo) => repo.path);
  const marker = workspaceMarker(repoPaths, dir, enableGit) as Record<string, unknown>;
  if (manifest === undefined) return marker;
  return {
    ...manifest.raw,
    ...marker,
    repos: markerRepoEntries(manifest, repos),
    ...(enableGit ? { git: true } : {}),
  };
}

const WORKSPACE_BOOTLOADER_LABELS: Record<string, string> = {
  "CLAUDE.md": "Claude workspace",
  "AGENTS.md": "AGENTS.md workspace",
  "GEMINI.md": "Gemini workspace",
  ".kiro/steering/00-canon.md": "Kiro workspace",
};

function workspaceBootloaderLabel(path: string): string {
  return WORKSPACE_BOOTLOADER_LABELS[path] ?? `${path} workspace`;
}

type BootloaderActivation = { key: string; value: string };

function bootloaderActivationsFor(clis: readonly Cli[]): Map<string, BootloaderActivation> {
  const activations = new Map<string, BootloaderActivation>();
  for (const cli of clis) {
    const cliEntry = registryEntry(cli);
    if (!cliEntry.activation) continue;
    for (const path of cliEntry.bootloaders) activations.set(path, cliEntry.activation);
  }
  return activations;
}

function workspaceBootloaderActivationFrontmatter(
  path: string,
  dir: string,
  activation: BootloaderActivation | undefined,
): string | undefined {
  if (!activation) return undefined;
  const fields: Record<string, string | boolean | number | string[]> = path.endsWith(".mdc")
    ? { description: `Routes to the workspace canon in ${dir}/`, globs: ["**/*"] }
    : {};
  fields[activation.key] = activation.value;
  return frontmatter(fields);
}

function workspaceBootloaderContents(
  path: string,
  name: string,
  repoPaths: readonly string[],
  dir: string,
  activation: BootloaderActivation | undefined,
): string {
  const body = workspaceBootloader(workspaceBootloaderLabel(path), name, [...repoPaths], dir);
  const activationFrontmatter = workspaceBootloaderActivationFrontmatter(path, dir, activation);
  return activationFrontmatter ? `${activationFrontmatter}\n\n${body}` : body;
}

function workspaceBootloaderWrites(
  bootloaders: readonly string[],
  activations: ReadonlyMap<string, BootloaderActivation>,
  name: string,
  repoPaths: readonly string[],
  dir: string,
): WriteAction[] {
  return bootloaders.map((path) =>
    writeText(
      path,
      workspaceBootloaderContents(path, name, repoPaths, dir, activations.get(path)),
      `${path} workspace bootloader → cross-repo canon`,
    ),
  );
}

/**
 * `aih workspace <parent>` — scaffold a MULTI-REPO workspace (parent-only). For a
 * parent folder holding separate repos (e.g. a UI repo and a backend repo), it
 * writes the cross-repo canon that bridges them: a workspace marker, a VS Code
 * multi-root `.code-workspace`, graph MCP scoped per declared child repo, the
 * `cross-repo-architecture.md` map (write-once, user-owned) and `repo-discipline.md`,
 * and tool-native workspace bootloaders. It does NOT touch the
 * child repos — run `aih init` in each. Child repos come from `--repos a,b` or an
 * existing workspace marker; detected child git repos are reported but not auto-enrolled.
 * Honors `--context-dir`.
 */
async function workspacePlan(ctx: PlanContext): Promise<Plan> {
  const dir = ctx.contextDir;
  const posture = ctx.posture ?? asPosture(ctx.options.posture);
  // resolve() first: basename(".") is "." which would plan a "..code-workspace"
  // write that the executor's containment guard rejects as a parent escape.
  const name = basename(resolve(ctx.root)) || "workspace";
  const explicitRepos = reposOption(ctx.options.repos);
  const discoveredRepos = explicitRepos.length === 0 ? discoverChildGitRepos(ctx.root) : [];
  const repos = detectChildRepos(ctx.root, explicitRepos);
  const enableGit = ctx.options.git === true;
  const existing = readWorkspaceManifest(ctx.root, dir);
  if (existing?.status === "ERROR") {
    throw new AihError(
      `workspace requires a valid .aih-workspace.json: ${existing.errors.join("; ")}`,
      "AIH_WORKSPACE",
    );
  }
  const useExistingRepos = explicitRepos.length === 0 && existing && existing.repos.length > 0;
  const normalizedRepos = useExistingRepos
    ? existing.repos
    : reposFromPathsWithExistingMetadata(repos, existing, posix.join(dir, "RULE_ROUTER.md"));
  const repoChecks = normalizedRepos.map((repo) => ({
    repo,
    check: checkWorkspaceChildPath(ctx.root, repo.path),
  }));
  const repoPaths = normalizedRepos.map((repo) => repo.path);
  const presentRepoPaths = repoChecks
    .filter(({ check }) => check.exists)
    .map(({ repo }) => repo.path);
  const absentRepoPaths = repoChecks
    .filter(({ check }) => !check.exists)
    .map(({ repo }) => repo.path);
  const edges = existing?.edges ?? [];
  const mcp = spanningMcp(ctx.root, presentRepoPaths);
  const mcpKeys = Object.keys(mcp.mcpServers);
  const staleMcpKeys = staleManagedMcpServerKeys(ctx.root, mcpKeys);
  const clis = resolveClis(ctx.options, { strict: true });
  const bootloaders = bootloadersFor(clis);
  const bootloaderActivations = bootloaderActivationsFor(clis);
  const policyResult = posture === "enterprise" ? readMcpOrgPolicy(ctx) : {};
  if (policyResult.error !== undefined) throw invalidOrgPolicyError(policyResult.error);

  const writes: WriteAction[] = [
    writeJson(
      ".aih-workspace.json",
      markerForWrite(existing, normalizedRepos, dir, enableGit),
      `workspace marker (multi-repo: ${repoPaths.length > 0 ? repoPaths.join(", ") : "no repos declared"})`,
    ),
    writeJson(`${name}.code-workspace`, codeWorkspace(repoPaths), "VS Code multi-root workspace", {
      merge: true,
    }),
    writeText(
      posix.join(dir, "workspace-router.md"),
      workspaceRouterDoc(normalizedRepos),
      "workspace router (federated child repo table of contents)",
    ),
    writeText(
      posix.join(dir, "workspace-contracts.md"),
      workspaceContractsDoc(edges),
      "workspace contracts (parent-owned cross-repo dependency index)",
    ),
    writeText(
      posix.join(dir, "cross-repo-architecture.md"),
      crossRepoArchitectureDoc(name, repoPaths, dir),
      "cross-repo architecture + feature map (write-once — you own it)",
      { once: true },
    ),
    writeText(
      posix.join(dir, "repo-discipline.md"),
      repoDisciplineDoc(repoPaths, dir),
      "per-repo discipline routing (read a repo's canon before editing it)",
    ),
    ...workspaceBootloaderWrites(bootloaders, bootloaderActivations, name, repoPaths, dir),
    writeJson(
      ".mcp.json",
      mcp,
      `workspace graph MCP scoped to ${repoPaths.length} declared child repo(s), merged into any existing .mcp.json`,
      {
        merge: true,
        replaceJsonChildKeys: { mcpServers: mcpKeys },
        ...(staleMcpKeys.length > 0
          ? { pruneJsonChildKeys: { mcpServers: { exact: staleMcpKeys } } }
          : {}),
      },
    ),
  ];
  if (enableGit) writes.push(workspaceGitignoreWrite(ctx.root, repoPaths));

  const actions: Action[] = [
    ...writes,
    ...(explicitRepos.length === 0 && !useExistingRepos && discoveredRepos.length > 0
      ? [
          doc(
            "workspace auto-enroll skipped",
            [
              "Child git repos were detected but not enrolled automatically.",
              "",
              "Detected candidates:",
              ...discoveredRepos.map((repo) => `- ${repo}`),
              "",
              "Re-run with an explicit allowlist, for example:",
              "aih workspace --repos <comma-separated-child-repos> --apply",
            ].join("\n"),
          ),
        ]
      : []),
    ...(absentRepoPaths.length > 0
      ? [
          doc(
            "workspace child repo absent",
            [
              "Declared child repo paths are missing, so aih skipped their workspace graph MCP scope.",
              "",
              "Missing children:",
              ...absentRepoPaths.map((repo) => `- ${repo}/`),
              "",
              "Run `aih workspace hydrate --apply` to restore committed children, or create the child repo before relying on workspace MCP.",
            ].join("\n"),
          ),
        ]
      : []),
    doc(
      "workspace next steps (run `aih init` per child)",
      nextStepsDoc(name, repoPaths, dir, enableGit),
    ),
    ...(enableGit ? await workspaceGitExecs(ctx, writes) : []),
  ];

  if (posture === "enterprise") {
    actions.push(workspaceMcpPolicyProbe("parent", undefined, posture, policyResult.policy));
    for (const repo of repoPaths) {
      actions.push(workspaceMcpPolicyProbe(`child ${repo}`, repo, posture, policyResult.policy));
    }
  }
  for (const repo of repoPaths) actions.push(childScaffoldedProbe(repo, dir));

  return plan("workspace", ...actions);
}

export const command: CommandSpec = {
  name: "workspace",
  summary:
    "Scaffold a multi-repo workspace: cross-repo map, declared-repo graph MCP, .code-workspace (parent-only)",
  options: [
    {
      flags: "--repos <list>",
      description: "explicit child repo allowlist (comma-separated)",
    },
    {
      flags: "--git",
      description:
        "initialize a local git repo for workspace coordination files; remote setup remains user-owned",
    },
  ],
  plan: workspacePlan,
};

function currentAihArgv(args: readonly string[]): string[] {
  const entry = process.argv[1];
  if (entry !== undefined && /\.(?:js|ts)$/i.test(entry)) {
    return [process.execPath, ...process.execArgv, entry, ...args];
  }
  return ["aih", ...args];
}

function declaredWorkspaceRepos(ctx: PlanContext): WorkspaceRepo[] {
  const existing = readWorkspaceManifest(ctx.root, ctx.contextDir);
  if (existing?.status === "ERROR") {
    throw new AihError(
      `workspace requires a valid .aih-workspace.json: ${existing.errors.join("; ")}`,
      "AIH_WORKSPACE",
    );
  }
  const explicitRepos = reposOption(ctx.options.repos);
  if (explicitRepos.length > 0) {
    const paths = detectChildRepos(ctx.root, explicitRepos);
    return reposFromPathsWithExistingMetadata(
      paths,
      existing,
      posix.join(ctx.contextDir, "RULE_ROUTER.md"),
    );
  }
  if (existing !== undefined) return existing.repos;
  return [];
}

function childWriteActions(
  ctx: PlanContext,
  repos: readonly WorkspaceRepo[],
  commandName: "init" | "report",
  args: readonly string[],
): Action[] {
  const actions: Action[] = [];
  for (const repo of repos) {
    const checked = checkWorkspaceChildPath(ctx.root, repo.path);
    if (!checked.exists) {
      actions.push(
        doc(
          `workspace child ${commandName} skipped`,
          `${repo.path}: path missing — run \`aih workspace hydrate --apply\` or create the child repo first.`,
        ),
      );
      continue;
    }
    if (!checked.git) {
      actions.push(
        doc(
          `workspace child ${commandName} skipped`,
          `${repo.path}: present but not a git repo; child writes are limited to declared child repos.`,
        ),
      );
      continue;
    }
    actions.push(
      exec(`workspace child ${repo.path} ${commandName}`, currentAihArgv(args), {
        cwd: join(ctx.root, checked.path),
        timeoutMs: 120_000,
      }),
    );
  }
  return actions;
}

function childInitArgs(ctx: PlanContext, contextDir: string): string[] {
  const args = ["init", "--apply", "--context-dir", contextDir, "--no-log"];
  const cli = ctx.options.cli;
  if (typeof cli === "string" && cli.trim().length > 0) args.push("--cli", cli);
  if (ctx.options.allTools === true) args.push("--all-tools");
  if (ctx.options.force === true) args.push("--force");
  return args;
}

async function workspaceInitPlan(ctx: PlanContext): Promise<Plan> {
  const parent = await workspacePlan(ctx);
  if (ctx.options.recursive !== true) {
    return plan(
      "workspace init",
      ...parent.actions,
      doc(
        "workspace child init skipped (run aih workspace init --recursive --apply)",
        "Child repo onboarding was not run. Re-run with `aih workspace init --recursive --apply` to write child repos.",
      ),
    );
  }
  const declared = declaredWorkspaceRepos(ctx);
  return plan(
    "workspace init",
    ...parent.actions,
    ...childWriteActions(ctx, declared, "init", childInitArgs(ctx, ctx.contextDir)),
  );
}

export const workspaceInitCommand: CommandSpec = {
  name: "init",
  summary: "Scaffold the parent workspace; add --recursive to run child repo onboarding",
  options: [
    {
      flags: "--repos <list>",
      description: "explicit child repo allowlist (comma-separated)",
    },
    {
      flags: "--git",
      description:
        "initialize a local git repo for workspace coordination files; remote setup remains user-owned",
    },
    {
      flags: "--recursive",
      description: "also run `aih init --apply` inside each declared child repo",
    },
  ],
  plan: workspaceInitPlan,
};

function workspaceReportArgs(ctx: PlanContext): string[] {
  const format = typeof ctx.options.format === "string" ? ctx.options.format : "html";
  const args = ["report", "--workspace", "--format", format, "--apply", "--no-log"];
  if (ctx.options.open === true) args.push("--open");
  return args;
}

function childReportArgs(): string[] {
  return ["report", "--format", "html", "--apply", "--no-log"];
}

async function workspaceReportPlan(ctx: PlanContext): Promise<Plan> {
  const parentReport = exec("workspace parent report", currentAihArgv(workspaceReportArgs(ctx)), {
    cwd: ctx.root,
    timeoutMs: 120_000,
  });
  if (ctx.options.refreshChildren !== true) {
    return plan(
      "workspace report",
      parentReport,
      doc(
        "workspace child reports skipped (run aih workspace report --refresh-children --apply)",
        "Child report artifacts were not refreshed. Re-run with `aih workspace report --refresh-children --apply` to write child repos.",
      ),
    );
  }
  const declared = declaredWorkspaceRepos(ctx);
  if (declared.length === 0) {
    throw new AihError(
      "workspace report --refresh-children requires declared child repos in .aih-workspace.json or --repos",
      "AIH_WORKSPACE",
    );
  }
  return plan(
    "workspace report",
    ...childWriteActions(ctx, declared, "report", childReportArgs()),
    parentReport,
  );
}

export const workspaceReportCommand: CommandSpec = {
  name: "report",
  summary: "Write the parent workspace report; add --refresh-children to refresh child reports",
  skipWorktreeGate: true,
  options: [
    {
      flags: "--repos <list>",
      description: "explicit child repo allowlist for --refresh-children (comma-separated)",
    },
    {
      flags: "--format <fmt>",
      description: "parent workspace report artifact format: md | html | terminal",
      default: "html",
    },
    {
      flags: "--open",
      description: "open the parent workspace report after writing it",
    },
    {
      flags: "--refresh-children",
      description: "also run child `aih report --format html --apply` in declared child repos",
    },
  ],
  plan: workspaceReportPlan,
};

export { snapshotCommand, taskPlanCommand, workspaceHydrateCommand, workspaceLinkCommand };
