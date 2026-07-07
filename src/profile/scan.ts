import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The synthesized profile of a repository: languages, frameworks, cloud/deploy
 * targets, and the canonical commands a model should run — all derived purely
 * from on-disk signature files and the project's own `package.json` scripts (no
 * network, no execution), so the same tree always yields the same {@link RepoStack}.
 *
 * Commands are only populated when they actually exist: `testRunner` is left
 * `undefined` for a placeholder `echo` test script, and `lintCommand` is omitted
 * when no lint script/linter is present, so downstream hooks never reference a
 * script the repo doesn't have.
 */
export interface WorkspaceStack {
  /** Detected language(s) for this workspace/package root. */
  languages: string[];
  /** Workspace-local package manager, if one is derivable. */
  packageManager?: string;
  /** Workspace-local test command, when derivable from that workspace's manifest. */
  testRunner?: string;
  /** Workspace-local build command, when derivable from that workspace's manifest. */
  buildCommand?: string;
  /** Workspace-local lint command, when derivable from that workspace's manifest. */
  lintCommand?: string;
  /** Workspace-local format command, when derivable from that workspace's manifest. */
  formatCommand?: string;
  /** Workspace-local start command, when declared by that workspace's manifest. */
  startCommand?: string;
  /** Workspace-local aggregate verification command, when declared by its manifest. */
  verifyCommand?: string;
  /** Workspace-local typecheck command, when declared by its manifest. */
  typecheckCommand?: string;
}

export interface DeploymentCommands {
  cdkSynth?: string;
  cdkDiff?: string;
  cdkDeploy?: string;
}

export interface RepoStack {
  /** Detected languages/runtimes, deduped, in first-seen order. */
  languages: string[];
  /** Frameworks detected from manifests (e.g. "Serverless Framework", "Next.js"). */
  frameworks: string[];
  /** Cloud providers in play (e.g. "AWS"), from SDK deps / serverless provider. */
  cloud: string[];
  /** Datastores in play (PostgreSQL / MySQL / MongoDB / SQLite / Redis / DynamoDB). */
  databases: string[];
  /** Deployment targets (Docker / Kubernetes-Helm / Terraform / Serverless Framework / …). */
  deployment: string[];
  /** Primary package manager from manifest/lockfile signals, if any. */
  packageManager?: string;
  /** True when TypeScript is actually present (tsconfig.json or a .ts/.tsx source). */
  hasTypeScript: boolean;
  /** Raw `scripts` from the primary package.json (empty if none). */
  scripts: Record<string, string>;
  /** One-line human description (package.json description or a synthesized one). */
  description?: string;
  /** Notable entry points (serverless functions, main, detected handlers). */
  entryPoints: string[];
  /** How to run the test suite, or undefined when the repo has no real test command. */
  testRunner?: string;
  /** How to produce a build, or undefined when none is defined. */
  buildCommand?: string;
  /** How to lint, or undefined when the repo defines no lint command. */
  lintCommand?: string;
  /** How to check formatting, or undefined when the repo defines no format command. */
  formatCommand?: string;
  /** How to start the local app/server, or undefined when none is defined. */
  startCommand?: string;
  /** Aggregate quality gate, declared-only and never inferred. */
  verifyCommand?: string;
  /** Typecheck gate, declared-only and never inferred. */
  typecheckCommand?: string;
  /** Deployment/tool verbs derived from deployment manifests such as cdk.json. */
  deploymentCommands?: DeploymentCommands;
  /** True when tests run in a real browser (Karma/Cypress/…) — they hang in a headless agent. */
  browserTest: boolean;
  /** True when a workspace/monorepo orchestrator or multiple package manifests are present. */
  isMonorepo: boolean;
  /** Detected workspace tool (turbo/nx/pnpm/rush/lerna/bazel/maven/gradle/npm-yarn), if any. */
  workspaceTool?: string;
  /** Per-workspace command/package facts keyed by repo-relative POSIX workspace path. */
  workspaces?: Record<string, WorkspaceStack>;
  /** Total detected workspace roots before the emitted workspace map was capped. */
  workspaceCount?: number;
  /** Local Python virtualenv directories found and excluded from source scanning. */
  virtualEnvPaths?: string[];
}

export interface ScanOptions {
  /** How deep to recurse below `root` (root itself is depth 0). */
  maxDepth: number;
  /**
   * The repo's configured canonical context dir (e.g. `ai-coding`), excluded from
   * the walk so the scanner never treats its OWN generated canon as repo stack.
   * The static {@link EXCLUDED_DIRS} only covers the legacy `.ai-context` default,
   * so a custom/visible context dir must be excluded dynamically.
   */
  contextDir?: string;
  /** Internal: false when scanning one workspace root to avoid recursive workspace maps. */
  includeWorkspaces?: boolean;
}

/** Directories never worth walking — build output, vendored deps, VCS metadata. */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".ai-context",
  "coverage",
  ".next",
  "target",
  "vendor",
  ".serverless",
  "cdk.out",
  ".terraform",
  ".var",
  ".venv",
  "venv",
]);

/** Python virtualenv directories: signal their presence, but never scan their contents. */
const VIRTUAL_ENV_DIRS = new Set([".venv"]);
const WORKSPACE_CAP = 8;

/** Node dependency → framework label. */
const NODE_FRAMEWORKS: Record<string, string> = {
  next: "Next.js",
  express: "Express",
  fastify: "Fastify",
  "@nestjs/core": "NestJS",
  "@nestjs/common": "NestJS",
  koa: "Koa",
  "@hapi/hapi": "hapi",
  react: "React",
  vue: "Vue",
  svelte: "Svelte",
  "@angular/core": "Angular",
  "aws-cdk-lib": "AWS CDK",
  "serverless-http": "Serverless Framework",
};

/** Known JS test-runner deps, in preference order, → the command to run them. */
const TEST_RUNNERS: Array<[dep: string, cmd: string]> = [
  ["vitest", "npx vitest run"],
  ["jest", "npx jest"],
  ["mocha", "npx mocha"],
  ["ava", "npx ava"],
  ["@playwright/test", "npx playwright test"],
];

/** Known JS linter deps → the command to run them. */
const LINTERS: Array<[dep: string, cmd: string]> = [
  ["@biomejs/biome", "npx biome check ."],
  ["eslint", "npx eslint ."],
  ["xo", "npx xo"],
  ["standard", "npx standard"],
];

/** Browser-SPA framework labels — these run in the browser, not on Node. */
const BROWSER_SPA_FRAMEWORKS = new Set(["Angular", "React", "Vue", "Svelte"]);
/** Node-server framework labels — presence means the project DOES run on Node (keep "/Node.js"). */
const NODE_SERVER_FRAMEWORKS = new Set([
  "Next.js",
  "Express",
  "Fastify",
  "NestJS",
  "Koa",
  "hapi",
  "Serverless Framework",
  "AWS CDK",
]);
/** Deps whose tests launch a real browser and hang without a headless flag. */
const BROWSER_TEST_DEPS = ["karma", "cypress", "@web/test-runner", "@playwright/test"];

/** Dependency (Node or Python) → datastore label. */
const DB_DEPS: Record<string, string> = {
  pg: "PostgreSQL",
  postgres: "PostgreSQL",
  "pg-promise": "PostgreSQL",
  psycopg2: "PostgreSQL",
  "psycopg2-binary": "PostgreSQL",
  asyncpg: "PostgreSQL",
  mysql: "MySQL",
  mysql2: "MySQL",
  mongodb: "MongoDB",
  mongoose: "MongoDB",
  pymongo: "MongoDB",
  "better-sqlite3": "SQLite",
  sqlite3: "SQLite",
  redis: "Redis",
  ioredis: "Redis",
  "@aws-sdk/client-dynamodb": "DynamoDB",
};

interface PkgJson {
  name?: string;
  description?: string;
  main?: string;
  binEntries: string[];
  scripts: Record<string, string>;
  deps: Set<string>;
  /** True when the manifest declares a `workspaces` field (npm/yarn workspaces). */
  hasWorkspaces: boolean;
}

/** Mutable accumulator collected during the walk, synthesized into RepoStack at the end. */
interface Raw {
  languages: string[];
  frameworks: string[];
  cloud: string[];
  databases: string[];
  deployment: string[];
  entryPoints: string[];
  packageManager?: string;
  hasTsconfig: boolean;
  sawTsFile: boolean;
  pkg?: PkgJson;
  /** serverless.* provider name, if a serverless manifest was read. */
  serverlessProvider?: string;
  /** Detected workspace-tool signals; precedence-resolved in synthesize. */
  workspaceSignals: Set<string>;
  /** Count of non-excluded package.json manifests seen during the walk. */
  manifestCount: number;
  /** Manifest/toolchain roots seen during the walk, repo-relative POSIX paths. */
  workspaceRoots: Set<string>;
  /** Non-Node toolchains whose manifest lives at the scan root beside package.json. */
  rootToolchains: Set<string>;
  /** Build-tool wrappers present at the repo — prefer ./mvnw / ./gradlew when set. */
  hasMvnw: boolean;
  hasGradlew: boolean;
  /** A linter is configured by a config file even if the root package.json has no lint script/dep. */
  hasEslintConfig: boolean;
  hasBiomeConfig: boolean;
  /** A browser test runner is configured by a `karma.conf.*` file. */
  hasKarmaConfig: boolean;
  /** Local Python virtualenv directories, repo-relative POSIX paths. */
  virtualEnvPaths: string[];
  /** Python package/tooling signals from manifests, lockfiles, and config files. */
  pythonManagers: Set<string>;
  pythonTools: Set<"pytest" | "ruff" | "black" | "mypy">;
  goTools: Set<"golangci-lint">;
  javaTools: Set<"checkstyle" | "spotless">;
}

/**
 * Recursively scan `root` and synthesize an accurate {@link RepoStack}. Pure and
 * side-effect-free beyond reading the filesystem: skips vendored/generated dirs,
 * tolerates unreadable dirs, and reads the project's own manifests to avoid
 * guessing (JS vs TS, real scripts, serverless/SAM/CDK/AWS).
 */
export function scanRepo(root: string, opts: ScanOptions): RepoStack {
  const raw: Raw = {
    languages: [],
    frameworks: [],
    cloud: [],
    databases: [],
    deployment: [],
    entryPoints: [],
    hasTsconfig: false,
    sawTsFile: false,
    workspaceSignals: new Set(),
    manifestCount: 0,
    workspaceRoots: new Set(),
    rootToolchains: new Set(),
    hasMvnw: false,
    hasGradlew: false,
    hasEslintConfig: false,
    hasBiomeConfig: false,
    hasKarmaConfig: false,
    virtualEnvPaths: [],
    pythonManagers: new Set(),
    pythonTools: new Set(),
    goTools: new Set(),
    javaTools: new Set(),
  };
  // Exclude the configured context dir (top path segment) alongside the static
  // set, so re-scans never walk the canon aih itself generated (the default is
  // now the VISIBLE `ai-coding`, which EXCLUDED_DIRS does not cover).
  const excluded = new Set<string>(EXCLUDED_DIRS);
  const ctxTop = opts.contextDir?.split(/[/\\]/).find((s) => s.length > 0);
  if (ctxTop) excluded.add(ctxTop);
  walk(root, root, 0, Math.max(0, opts.maxDepth), raw, excluded);
  return synthesize(root, raw, opts);
}

function walk(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  raw: Raw,
  excluded: ReadonlySet<string>,
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip, never throw
  }

  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (isPythonVirtualEnvDir(dir, entry.name)) {
        push(raw.virtualEnvPaths, relative(root, join(dir, entry.name)).replace(/\\/g, "/"));
        continue;
      }
      if (!excluded.has(entry.name)) subdirs.push(entry.name);
      continue;
    }
    if (entry.isFile() || entry.isSymbolicLink()) inspectFile(root, dir, entry.name, raw);
  }

  if (depth >= maxDepth) return;
  for (const name of subdirs) {
    walk(root, join(dir, name), depth + 1, maxDepth, raw, excluded);
  }
}

function isPythonVirtualEnvDir(parent: string, name: string): boolean {
  if (VIRTUAL_ENV_DIRS.has(name)) return true;
  return name === "venv" && existsSync(join(parent, name, "pyvenv.cfg"));
}

function inspectFile(root: string, dir: string, name: string, raw: Raw): void {
  const lower = name.toLowerCase();
  if (isGeneratedWorkspacePath(relative(root, dir).replace(/\\/g, "/"))) return;

  // Source-file extension signals (JS vs TS, Python, Go, …).
  if (/\.tsx?$/.test(lower) && !lower.endsWith(".d.ts")) raw.sawTsFile = true;

  switch (name) {
    case "package.json": {
      raw.manifestCount++;
      rememberWorkspaceRoot(root, dir, raw);
      // Capture the shallowest package.json as the primary manifest; a `workspaces`
      // field on it marks an npm/yarn workspace monorepo (root only).
      if (!raw.pkg) {
        raw.pkg = readPkg(join(dir, name));
        if (raw.pkg.hasWorkspaces) raw.workspaceSignals.add("npm/yarn workspaces");
      }
      return;
    }
    case "tsconfig.json":
      raw.hasTsconfig = true;
      return;
    case "package-lock.json":
      raw.packageManager ??= "npm";
      return;
    case "pnpm-lock.yaml":
      raw.packageManager = "pnpm";
      return;
    case "yarn.lock":
      raw.packageManager ??= "yarn";
      return;
    case "bun.lockb":
      raw.packageManager = "bun";
      return;
    case "pnpm-workspace.yaml":
      raw.workspaceSignals.add("pnpm");
      return;
    case "nx.json":
      raw.workspaceSignals.add("nx");
      return;
    case "turbo.json":
      raw.workspaceSignals.add("turbo");
      return;
    case "lerna.json":
      raw.workspaceSignals.add("lerna");
      return;
    case "rush.json":
      raw.workspaceSignals.add("rush");
      return;
    case "WORKSPACE":
    case "WORKSPACE.bazel":
    case "MODULE.bazel":
      raw.workspaceSignals.add("bazel");
      return;
    case "settings.gradle":
    case "settings.gradle.kts":
      raw.workspaceSignals.add("gradle");
      return;
    case "mvnw":
    case "mvnw.cmd":
      raw.hasMvnw = true;
      return;
    case "gradlew":
    case "gradlew.bat":
      raw.hasGradlew = true;
      return;
    case "go.mod":
      push(raw.languages, "Go");
      rememberWorkspaceRoot(root, dir, raw);
      rememberRootToolchain(root, dir, raw, "Go");
      detectGoManifest(join(dir, name), raw);
      return;
    case "go.work":
      raw.workspaceSignals.add("go workspace");
      return;
    case "Cargo.toml":
      push(raw.languages, "Rust");
      rememberWorkspaceRoot(root, dir, raw);
      rememberRootToolchain(root, dir, raw, "Rust");
      return;
    case "pyproject.toml":
    case "requirements.txt":
      push(raw.languages, "Python");
      rememberWorkspaceRoot(root, dir, raw);
      rememberRootToolchain(root, dir, raw, "Python");
      detectPythonManifest(join(dir, name), name, raw);
      return;
    case "poetry.lock":
      raw.pythonManagers.add("poetry");
      return;
    case "uv.lock":
      raw.pythonManagers.add("uv");
      return;
    case "Pipfile":
      raw.pythonManagers.add("pipenv");
      return;
    case "pom.xml":
      push(raw.languages, "Java/Maven");
      rememberWorkspaceRoot(root, dir, raw);
      rememberRootToolchain(root, dir, raw, "Java/Maven");
      // A <modules> reactor makes this a Maven multi-module monorepo.
      detectMavenPom(join(dir, name), raw);
      return;
    case "build.gradle":
    case "build.gradle.kts":
      push(raw.languages, "Java/Gradle");
      rememberWorkspaceRoot(root, dir, raw);
      rememberRootToolchain(root, dir, raw, "Java/Gradle");
      return;
    case "Dockerfile":
      push(raw.deployment, "Docker");
      return;
    case "docker-compose.yml":
    case "docker-compose.yaml":
    case "compose.yaml":
      push(raw.deployment, "Docker Compose");
      return;
    case "Chart.yaml":
      push(raw.deployment, "Kubernetes/Helm");
      return;
    case "cdk.json":
      push(raw.frameworks, "AWS CDK");
      push(raw.deployment, "AWS CDK");
      push(raw.cloud, "AWS");
      return;
    case "samconfig.toml":
      push(raw.frameworks, "AWS SAM");
      push(raw.deployment, "AWS SAM");
      push(raw.cloud, "AWS");
      return;
    default:
      detectMisc(root, dir, name, lower, raw);
  }
}

function detectMisc(root: string, dir: string, name: string, lower: string, raw: Raw): void {
  // Linter config files: a linter is configured here even when the ROOT package.json
  // carries no lint script and no linter dep (common in monorepos where eslint lives
  // in a tooling workspace) — so a lint command is still derivable. (AIH-PROFILE-001)
  if (/^eslint\.config\.(js|mjs|cjs|ts)$/.test(lower) || /^\.eslintrc(\.[\w.]+)?$/.test(lower)) {
    raw.hasEslintConfig = true;
    return;
  }
  if (lower === "biome.json" || lower === "biome.jsonc") {
    raw.hasBiomeConfig = true;
    return;
  }
  if (/^karma\.conf\.(js|ts|cjs|mjs)$/.test(lower)) {
    raw.hasKarmaConfig = true;
    return;
  }
  if (lower === "pytest.ini") {
    raw.pythonTools.add("pytest");
    return;
  }
  if (lower === "ruff.toml" || lower === ".ruff.toml") {
    raw.pythonTools.add("ruff");
    return;
  }
  if (lower === "mypy.ini" || lower === ".mypy.ini") {
    raw.pythonTools.add("mypy");
    return;
  }
  if (/^test_.*\.py$/.test(lower) || /_test\.py$/.test(lower)) {
    raw.pythonTools.add("pytest");
    return;
  }
  if (/^serverless\.(yml|yaml|ts|js|json)$/.test(lower)) {
    push(raw.frameworks, "Serverless Framework");
    push(raw.deployment, "Serverless Framework");
    readServerless(join(dir, name), raw);
    return;
  }
  if (/^template\.(yml|yaml)$/.test(lower)) {
    const body = safeRead(join(dir, name));
    if (body.includes("AWS::Serverless")) {
      push(raw.frameworks, "AWS SAM");
      push(raw.deployment, "AWS SAM");
      push(raw.cloud, "AWS");
    }
    return;
  }
  if (lower.endsWith(".tf")) {
    push(raw.deployment, "Terraform");
    return;
  }
  if (matches(lower, ".csproj") || matches(lower, ".slnx") || matches(lower, ".sln")) {
    push(raw.languages, ".NET");
    rememberWorkspaceRoot(root, dir, raw);
    rememberRootToolchain(root, dir, raw, ".NET");
    if (matches(lower, ".slnx") || matches(lower, ".sln"))
      raw.workspaceSignals.add("dotnet solution");
    if (matches(lower, ".csproj")) detectDotnetProject(join(dir, name), raw);
    return;
  }
  if (/^\.golangci\.(yml|yaml|toml|json)$/.test(lower)) {
    raw.goTools.add("golangci-lint");
    return;
  }
  if (lower === "checkstyle.xml") {
    raw.javaTools.add("checkstyle");
    return;
  }
}

function rememberWorkspaceRoot(root: string, dir: string, raw: Raw): void {
  const rel = relative(root, dir).replace(/\\/g, "/");
  if (!isGeneratedWorkspacePath(rel)) raw.workspaceRoots.add(rel);
}

function rememberRootToolchain(root: string, dir: string, raw: Raw, language: string): void {
  const rel = relative(root, dir).replace(/\\/g, "/");
  if (rel.length === 0) raw.rootToolchains.add(language);
}

function isGeneratedWorkspacePath(rel: string): boolean {
  if (rel.length === 0) return false;
  const parts = rel.split("/");
  return parts.some(
    (part) => part === ".var" || part.endsWith(".snapshot") || part.startsWith("asset."),
  );
}

/** Parse a serverless manifest for its provider (cloud) and function entry points. */
function readServerless(path: string, raw: Raw): void {
  const body = safeRead(path);
  const provider = body.match(/provider:\s*[\s\S]*?name:\s*([a-z]+)/i)?.[1]?.toLowerCase();
  const cloud =
    provider === "aws"
      ? "AWS"
      : provider === "google"
        ? "GCP"
        : provider === "azure"
          ? "Azure"
          : undefined;
  if (cloud) push(raw.cloud, cloud);
  // Best-effort: collect `handler:` entries as entry points.
  for (const m of body.matchAll(/handler:\s*([\w./-]+)/g)) {
    if (m[1]) push(raw.entryPoints, m[1]);
  }
}

function detectPythonManifest(path: string, name: string, raw: Raw): void {
  const body = safeRead(path).toLowerCase();
  if (name === "requirements.txt") raw.pythonManagers.add("pip");
  if (name === "pyproject.toml") {
    if (/\[tool\.poetry\b/.test(body)) raw.pythonManagers.add("poetry");
    if (/\[tool\.uv\b/.test(body)) raw.pythonManagers.add("uv");
  }
  if (/\bfastapi\b/.test(body)) push(raw.frameworks, "FastAPI");
  if (/\bflask\b/.test(body)) push(raw.frameworks, "Flask");
  if (/\bdjango\b/.test(body)) push(raw.frameworks, "Django");
  if (/\bpsycopg2\b|\basyncpg\b/.test(body)) push(raw.databases, "PostgreSQL");
  if (/\bpymongo\b/.test(body)) push(raw.databases, "MongoDB");
  if (/\bredis\b/.test(body)) push(raw.databases, "Redis");
  if (/\bpytest\b|\[tool\.pytest\b/.test(body)) raw.pythonTools.add("pytest");
  if (/\bruff\b|\[tool\.ruff\b/.test(body)) raw.pythonTools.add("ruff");
  if (/\bblack\b|\[tool\.black\b/.test(body)) raw.pythonTools.add("black");
  if (/\bmypy\b|\[tool\.mypy\b/.test(body)) raw.pythonTools.add("mypy");
}

function detectGoManifest(path: string, raw: Raw): void {
  const body = safeRead(path).toLowerCase();
  if (hasGoModule(body, "github.com/gin-gonic/gin")) push(raw.frameworks, "Gin");
  if (hasGoModule(body, "github.com/labstack/echo")) push(raw.frameworks, "Echo");
  if (hasGoModule(body, "github.com/gofiber/fiber")) push(raw.frameworks, "Fiber");
  if (hasGoModule(body, "github.com/go-chi/chi")) push(raw.frameworks, "chi");
  if (hasGoModule(body, "github.com/lib/pq") || hasGoModule(body, "github.com/jackc/pgx")) {
    push(raw.databases, "PostgreSQL");
  }
  if (hasGoModule(body, "github.com/go-sql-driver/mysql")) push(raw.databases, "MySQL");
  if (hasGoModule(body, "go.mongodb.org/mongo-driver")) push(raw.databases, "MongoDB");
  if (hasGoModule(body, "github.com/redis/go-redis")) push(raw.databases, "Redis");
  if (hasGoModule(body, "github.com/mattn/go-sqlite3") || hasGoModule(body, "modernc.org/sqlite")) {
    push(raw.databases, "SQLite");
  }
}

function hasGoModule(body: string, modulePath: string): boolean {
  return body
    .split(/\s+/)
    .some((token) => token === modulePath || token.startsWith(`${modulePath}/`));
}

function detectMavenPom(path: string, raw: Raw): void {
  const body = safeRead(path).toLowerCase();
  if (/<modules>/.test(body)) raw.workspaceSignals.add("maven");
  if (/spring-boot-starter|spring-boot-maven-plugin/.test(body))
    push(raw.frameworks, "Spring Boot");
  if (/quarkus-/.test(body)) push(raw.frameworks, "Quarkus");
  if (/micronaut-/.test(body)) push(raw.frameworks, "Micronaut");
  if (/org\.postgresql|<artifactid>postgresql<\/artifactid>/.test(body)) {
    push(raw.databases, "PostgreSQL");
  }
  if (/mysql-connector|mariadb-java-client/.test(body)) push(raw.databases, "MySQL");
  if (/mongodb-driver/.test(body)) push(raw.databases, "MongoDB");
  if (/<artifactid>(jedis|lettuce-core)<\/artifactid>/.test(body)) push(raw.databases, "Redis");
  if (/<artifactid>h2<\/artifactid>/.test(body)) push(raw.databases, "H2");
  if (/maven-checkstyle-plugin/.test(body)) raw.javaTools.add("checkstyle");
  if (/spotless-maven-plugin/.test(body)) raw.javaTools.add("spotless");
}

function detectDotnetProject(path: string, raw: Raw): void {
  const body = safeRead(path).toLowerCase();
  if (/microsoft\.net\.sdk\.web|microsoft\.aspnetcore/.test(body)) {
    push(raw.frameworks, "ASP.NET Core");
  }
  if (/microsoft\.entityframeworkcore/.test(body)) push(raw.frameworks, "Entity Framework Core");
  if (/npgsql/.test(body)) push(raw.databases, "PostgreSQL");
  if (/mysqlconnector|pomelo\.entityframeworkcore\.mysql/.test(body)) push(raw.databases, "MySQL");
  if (/mongodb\.driver/.test(body)) push(raw.databases, "MongoDB");
  if (/stackexchange\.redis/.test(body)) push(raw.databases, "Redis");
  if (/microsoft\.data\.sqlite|sqlite/.test(body)) push(raw.databases, "SQLite");
}

function readPkg(path: string): PkgJson {
  const pkg: PkgJson = { binEntries: [], scripts: {}, deps: new Set(), hasWorkspaces: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return pkg;
  }
  if (!isRecord(parsed)) return pkg;
  if (typeof parsed.name === "string") pkg.name = parsed.name;
  if (typeof parsed.description === "string") pkg.description = parsed.description;
  if (typeof parsed.main === "string") pkg.main = parsed.main;
  if (typeof parsed.bin === "string") pkg.binEntries.push(parsed.bin);
  else if (isRecord(parsed.bin)) {
    for (const [, value] of Object.entries(parsed.bin).sort(([a], [b]) => a.localeCompare(b))) {
      if (typeof value === "string") pkg.binEntries.push(value);
    }
  }
  if (parsed.workspaces !== undefined) pkg.hasWorkspaces = true;
  if (isRecord(parsed.scripts)) {
    for (const [k, v] of Object.entries(parsed.scripts)) {
      if (typeof v === "string") pkg.scripts[k] = v;
    }
  }
  for (const field of ["dependencies", "devDependencies"]) {
    const section = parsed[field];
    if (isRecord(section)) for (const dep of Object.keys(section)) pkg.deps.add(dep);
  }
  return pkg;
}

function normalizeEntrypoint(raw: string): string | undefined {
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return undefined;
  }
  return normalized;
}

function pushEntrypoint(out: string[], raw: string | undefined): void {
  if (raw === undefined) return;
  const normalized = normalizeEntrypoint(raw);
  if (normalized !== undefined) push(out, normalized);
}

function packageEntrypoints(root: string, pkg: PkgJson): string[] {
  const out: string[] = [];
  for (const entry of pkg.binEntries) pushEntrypoint(out, entry);
  pushEntrypoint(out, pkg.main);
  for (const rel of ["src/cli.ts", "src/index.ts", "src/main.ts", "src/server.ts"]) {
    if (existsSync(join(root, rel))) pushEntrypoint(out, rel);
  }
  return out;
}

/** Turn collected raw signals into the final, accurate stack. */
function synthesize(root: string, raw: Raw, opts: ScanOptions): RepoStack {
  const languages = [...raw.languages];
  const frameworks = [...raw.frameworks];
  const cloud = [...raw.cloud];
  const databases = [...raw.databases];
  const deployment = [...raw.deployment];
  const entryPoints = [...raw.entryPoints];
  const pkg = raw.pkg;

  let testRunner: string | undefined;
  let buildCommand: string | undefined;
  let lintCommand: string | undefined;
  let formatCommand: string | undefined;
  let startCommand: string | undefined;
  let verifyCommand: string | undefined;
  let typecheckCommand: string | undefined;

  if (pkg) {
    // JS vs TS: TypeScript only when genuinely present.
    const isTs =
      raw.hasTsconfig || raw.sawTsFile || pkg.deps.has("typescript") || pkg.deps.has("ts-node");
    pushFront(languages, isTs ? "TypeScript/Node.js" : "JavaScript/Node.js");

    // Node frameworks from deps.
    for (const [dep, label] of Object.entries(NODE_FRAMEWORKS)) {
      if (pkg.deps.has(dep)) push(frameworks, label);
    }
    if ([...pkg.deps].some((d) => d === "aws-sdk" || d.startsWith("@aws-sdk/"))) push(cloud, "AWS");
    if (pkg.deps.has("serverless") || "serverless" in pkg.scripts) {
      push(frameworks, "Serverless Framework");
    }
    for (const [dep, db] of Object.entries(DB_DEPS)) {
      if (pkg.deps.has(dep)) push(databases, db);
    }

    // Commands strictly from what the repo actually defines.
    testRunner = deriveTest(pkg);
    buildCommand = "build" in pkg.scripts ? "npm run build" : undefined;
    startCommand = "start" in pkg.scripts ? "npm start" : undefined;
    verifyCommand = "verify" in pkg.scripts ? "npm run verify" : undefined;
    typecheckCommand = "typecheck" in pkg.scripts ? "npm run typecheck" : undefined;
    // A root lint script / linter dep wins; otherwise fall back to a detected linter
    // CONFIG file (eslint.config.* / biome.json), which monorepos have even when the
    // root package.json doesn't declare the lint script or the linter dep.
    lintCommand = deriveLint(pkg) ?? configLint(raw);

    for (const entry of packageEntrypoints(root, pkg)) push(entryPoints, entry);
    if (pkg.name && entryPoints.length === 0 && pkg.scripts.start) {
      entryPoints.push("npm start");
    }
  } else {
    // Non-Node language defaults (only when a Node manifest is absent).
    if (languages.includes("Go")) {
      testRunner = "go test ./...";
      buildCommand = "go build ./...";
      lintCommand = deriveGoLint(raw);
    } else if (languages.includes("Rust")) {
      testRunner = "cargo test";
      buildCommand = "cargo build";
      lintCommand = "cargo clippy";
      formatCommand = "cargo fmt --check";
    } else if (languages.includes("Python")) {
      testRunner = derivePythonTest(raw);
      lintCommand = derivePythonLint(raw);
    } else if (languages.includes("Java/Maven")) {
      // Prefer the project's pinned wrapper over a system mvn/gradle when present.
      const mvn = raw.hasMvnw ? "./mvnw" : "mvn";
      testRunner = `${mvn} test`;
      buildCommand = `${mvn} clean package`;
      lintCommand = deriveMavenLint(raw);
    } else if (languages.includes("Java/Gradle")) {
      const gradle = raw.hasGradlew ? "./gradlew" : "gradle";
      testRunner = `${gradle} test`;
      buildCommand = `${gradle} build`;
    } else if (languages.includes(".NET")) {
      testRunner = "dotnet test";
      buildCommand = "dotnet build";
      lintCommand = "dotnet format --verify-no-changes";
    }
  }

  const finalFrameworks = dedupe(frameworks);
  // A browser SPA doesn't run on Node — don't tag it "/Node.js" (it nudges a weak agent
  // toward server assumptions). A Node-server framework (Next/Express/Nest/…) keeps the tag.
  const isBrowserSpa =
    finalFrameworks.some((f) => BROWSER_SPA_FRAMEWORKS.has(f)) &&
    !finalFrameworks.some((f) => NODE_SERVER_FRAMEWORKS.has(f));
  const finalLanguages = dedupe(languages).map((l) =>
    isBrowserSpa && l === "TypeScript/Node.js"
      ? "TypeScript"
      : isBrowserSpa && l === "JavaScript/Node.js"
        ? "JavaScript"
        : l,
  );
  const packageManager = pkg
    ? raw.packageManager
    : (raw.packageManager ??
      rustPackageManager(languages) ??
      pythonPackageManager(raw) ??
      goPackageManager(languages) ??
      javaPackageManager(languages) ??
      dotnetPackageManager(languages));
  const deploymentCommands = cdkDeploymentCommands(finalFrameworks);
  const explicitWorkspaceTool = resolveWorkspaceTool(raw.workspaceSignals);
  const workspaceTool =
    explicitWorkspaceTool ??
    (isPolyglot(finalLanguages) && raw.workspaceRoots.size > 1 ? "polyglot" : undefined);
  // A workspace orchestrator, multiple package manifests, or multiple manifest roots
  // means a single root command must not be presented as authoritative for every package.
  const isMonorepo =
    workspaceTool !== undefined || raw.manifestCount > 1 || raw.workspaceRoots.size > 1;
  const workspaceSynthesis =
    opts.includeWorkspaces === false ? undefined : synthesizeWorkspaces(root, raw, opts);
  // Browser test runners (Karma's `ng test`, Cypress) launch a real browser and HANG in a
  // headless/agent context — surface it so synth can warn the next agent (the real trap).
  const browserTest =
    raw.hasKarmaConfig || (pkg ? BROWSER_TEST_DEPS.some((d) => pkg.deps.has(d)) : false);

  return {
    languages: finalLanguages,
    frameworks: finalFrameworks,
    cloud: dedupe(cloud),
    databases: dedupe(databases),
    deployment: dedupe(deployment),
    packageManager,
    hasTypeScript: raw.hasTsconfig || raw.sawTsFile || (pkg?.deps.has("typescript") ?? false),
    scripts: pkg?.scripts ?? {},
    description: pkg?.description,
    entryPoints: dedupe(entryPoints).slice(0, 8),
    testRunner,
    buildCommand,
    lintCommand,
    formatCommand,
    startCommand,
    verifyCommand,
    typecheckCommand,
    ...(deploymentCommands ? { deploymentCommands } : {}),
    browserTest,
    isMonorepo,
    workspaceTool,
    ...(workspaceSynthesis?.workspaces ? { workspaces: workspaceSynthesis.workspaces } : {}),
    ...(workspaceSynthesis?.workspaceCount
      ? { workspaceCount: workspaceSynthesis.workspaceCount }
      : {}),
    virtualEnvPaths: raw.virtualEnvPaths,
  };
}

interface WorkspaceSynthesis {
  workspaces?: Record<string, WorkspaceStack>;
  workspaceCount?: number;
}

function synthesizeWorkspaces(root: string, raw: Raw, opts: ScanOptions): WorkspaceSynthesis {
  const rels = [...raw.workspaceRoots]
    .filter((rel) => rel.length > 0)
    .sort((a, b) => a.localeCompare(b));

  const workspaces: Record<string, WorkspaceStack> = {};
  const rootSecondary = synthesizeRootSecondaryWorkspace(raw);
  const workspaceCount = rels.length + (rootSecondary ? 1 : 0);
  if (workspaceCount === 0) return {};

  if (rootSecondary) workspaces["."] = rootSecondary;

  const remaining = Math.max(0, WORKSPACE_CAP - Object.keys(workspaces).length);
  for (const rel of rels.slice(0, remaining)) {
    const stack = scanRepo(join(root, rel), {
      maxDepth: Math.min(4, Math.max(0, opts.maxDepth)),
      contextDir: opts.contextDir,
      includeWorkspaces: false,
    });
    if (stack.languages.length === 0 && stack.packageManager === undefined) continue;
    workspaces[rel] = {
      languages: stack.languages,
      ...(stack.packageManager ? { packageManager: stack.packageManager } : {}),
      ...(stack.testRunner ? { testRunner: stack.testRunner } : {}),
      ...(stack.buildCommand ? { buildCommand: stack.buildCommand } : {}),
      ...(stack.lintCommand ? { lintCommand: stack.lintCommand } : {}),
      ...(stack.formatCommand ? { formatCommand: stack.formatCommand } : {}),
      ...(stack.startCommand ? { startCommand: stack.startCommand } : {}),
      ...(stack.verifyCommand ? { verifyCommand: stack.verifyCommand } : {}),
      ...(stack.typecheckCommand ? { typecheckCommand: stack.typecheckCommand } : {}),
    };
  }

  return Object.keys(workspaces).length > 0 ? { workspaces, workspaceCount } : {};
}

function synthesizeRootSecondaryWorkspace(raw: Raw): WorkspaceStack | undefined {
  if (!raw.pkg) return undefined;
  if (raw.rootToolchains.has("Python")) {
    return {
      languages: ["Python"],
      ...(pythonPackageManager(raw) ? { packageManager: pythonPackageManager(raw) } : {}),
      ...(derivePythonTest(raw) ? { testRunner: derivePythonTest(raw) } : {}),
      ...(derivePythonLint(raw) ? { lintCommand: derivePythonLint(raw) } : {}),
    };
  }
  if (raw.rootToolchains.has("Rust")) {
    return {
      languages: ["Rust"],
      packageManager: "cargo",
      testRunner: "cargo test",
      buildCommand: "cargo build",
      lintCommand: "cargo clippy",
      formatCommand: "cargo fmt --check",
    };
  }
  if (raw.rootToolchains.has("Go")) {
    return { languages: ["Go"], testRunner: "go test ./...", buildCommand: "go build ./..." };
  }
  return undefined;
}

function cdkDeploymentCommands(frameworks: readonly string[]): DeploymentCommands | undefined {
  if (!frameworks.includes("AWS CDK")) return undefined;
  return {
    cdkSynth: "npx cdk synth",
    cdkDiff: "npx cdk diff",
    cdkDeploy: "npx cdk deploy",
  };
}

function pythonPackageManager(raw: Raw): string | undefined {
  if (raw.pythonManagers.has("uv")) return "uv";
  if (raw.pythonManagers.has("poetry")) return "poetry";
  if (raw.pythonManagers.has("pipenv")) return "pipenv";
  if (raw.pythonManagers.has("pip")) return "pip";
  return undefined;
}

function rustPackageManager(languages: readonly string[]): string | undefined {
  return languages.includes("Rust") ? "cargo" : undefined;
}

function goPackageManager(languages: readonly string[]): string | undefined {
  return languages.includes("Go") ? "go modules" : undefined;
}

function javaPackageManager(languages: readonly string[]): string | undefined {
  if (languages.includes("Java/Maven")) return "maven";
  if (languages.includes("Java/Gradle")) return "gradle";
  return undefined;
}

function dotnetPackageManager(languages: readonly string[]): string | undefined {
  return languages.includes(".NET") ? "dotnet" : undefined;
}

function derivePythonTest(raw: Raw): string | undefined {
  return raw.pythonTools.has("pytest") ? "pytest" : undefined;
}

function derivePythonLint(raw: Raw): string | undefined {
  if (raw.pythonTools.has("ruff")) return "ruff check .";
  if (raw.pythonTools.has("black")) return "black --check .";
  if (raw.pythonTools.has("mypy")) return "mypy .";
  return undefined;
}

function deriveGoLint(raw: Raw): string | undefined {
  return raw.goTools.has("golangci-lint") ? "golangci-lint run" : undefined;
}

function deriveMavenLint(raw: Raw): string | undefined {
  const mvn = raw.hasMvnw ? "./mvnw" : "mvn";
  if (raw.javaTools.has("checkstyle")) return `${mvn} checkstyle:check`;
  if (raw.javaTools.has("spotless")) return `${mvn} spotless:check`;
  return undefined;
}

function isPolyglot(languages: readonly string[]): boolean {
  return new Set(languages.map(languageFamily)).size > 1;
}

function languageFamily(language: string): string {
  if (language.includes("Node") || language === "TypeScript" || language === "JavaScript") {
    return "JavaScript";
  }
  if (language.startsWith("Java/")) return "Java";
  return language;
}

/** Derive the test command, ignoring placeholder `echo`/no-op scripts. */
function deriveTest(pkg: PkgJson): string | undefined {
  const script = pkg.scripts.test;
  if (script && !isPlaceholderScript(script)) return "npm test";
  for (const [dep, cmd] of TEST_RUNNERS) {
    if (pkg.deps.has(dep)) return cmd;
  }
  return undefined;
}

/** Derive the lint command only when the repo defines one (script or known linter). */
function deriveLint(pkg: PkgJson): string | undefined {
  if ("lint" in pkg.scripts) return "npm run lint";
  for (const [dep, cmd] of LINTERS) {
    if (pkg.deps.has(dep)) return cmd;
  }
  return undefined;
}

/** Lint command implied by a detected linter CONFIG file (biome wins over eslint). */
function configLint(raw: Raw): string | undefined {
  if (raw.hasBiomeConfig) return "npx biome check .";
  if (raw.hasEslintConfig) return "npx eslint .";
  return undefined;
}

/** A `test` script that doesn't actually test (the npm-init default and friends). */
function isPlaceholderScript(script: string): boolean {
  const s = script.toLowerCase();
  return /no test specified/.test(s) || /^echo\b.*exit\s+[01]\b/.test(s.trim());
}

/** Workspace tools by specificity — the first present signal wins (deterministic). */
const WORKSPACE_PRECEDENCE = [
  "turbo",
  "nx",
  "pnpm",
  "rush",
  "lerna",
  "bazel",
  "go workspace",
  "maven",
  "gradle",
  "dotnet solution",
  "npm/yarn workspaces",
] as const;

/** Resolve the most specific workspace tool from the detected signals. */
function resolveWorkspaceTool(signals: Set<string>): string | undefined {
  return WORKSPACE_PRECEDENCE.find((t) => signals.has(t));
}

function matches(name: string, ext: string): boolean {
  return name.length > ext.length && name.endsWith(ext);
}
function push(arr: string[], v: string): void {
  if (!arr.includes(v)) arr.push(v);
}
function pushFront(arr: string[], v: string): void {
  if (!arr.includes(v)) arr.unshift(v);
}
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
