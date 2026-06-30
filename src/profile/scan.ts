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
  /** Node package manager from the lockfile, if any (npm/pnpm/yarn/bun). */
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
  /** How to start the local app/server, or undefined when none is defined. */
  startCommand?: string;
  /** True when tests run in a real browser (Karma/Cypress/…) — they hang in a headless agent. */
  browserTest: boolean;
  /** True when a workspace/monorepo orchestrator or multiple package manifests are present. */
  isMonorepo: boolean;
  /** Detected workspace tool (turbo/nx/pnpm/rush/lerna/bazel/maven/gradle/npm-yarn), if any. */
  workspaceTool?: string;
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
  ".venv",
  "venv",
]);

/** Python virtualenv directories: signal their presence, but never scan their contents. */
const VIRTUAL_ENV_DIRS = new Set([".venv"]);

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
    hasMvnw: false,
    hasGradlew: false,
    hasEslintConfig: false,
    hasBiomeConfig: false,
    hasKarmaConfig: false,
    virtualEnvPaths: [],
    pythonManagers: new Set(),
    pythonTools: new Set(),
  };
  // Exclude the configured context dir (top path segment) alongside the static
  // set, so re-scans never walk the canon aih itself generated (the default is
  // now the VISIBLE `ai-coding`, which EXCLUDED_DIRS does not cover).
  const excluded = new Set<string>(EXCLUDED_DIRS);
  const ctxTop = opts.contextDir?.split(/[/\\]/).find((s) => s.length > 0);
  if (ctxTop) excluded.add(ctxTop);
  walk(root, root, 0, Math.max(0, opts.maxDepth), raw, excluded);
  return synthesize(raw);
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
    if (entry.isFile() || entry.isSymbolicLink()) inspectFile(dir, entry.name, raw);
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

function inspectFile(dir: string, name: string, raw: Raw): void {
  const lower = name.toLowerCase();

  // Source-file extension signals (JS vs TS, Python, Go, …).
  if (/\.tsx?$/.test(lower) && !lower.endsWith(".d.ts")) raw.sawTsFile = true;

  switch (name) {
    case "package.json": {
      raw.manifestCount++;
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
      return;
    case "Cargo.toml":
      push(raw.languages, "Rust");
      return;
    case "pyproject.toml":
    case "requirements.txt":
      push(raw.languages, "Python");
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
      // A <modules> reactor makes this a Maven multi-module monorepo.
      if (/<modules>/.test(safeRead(join(dir, name)))) raw.workspaceSignals.add("maven");
      return;
    case "build.gradle":
    case "build.gradle.kts":
      push(raw.languages, "Java/Gradle");
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
      detectMisc(dir, name, lower, raw);
  }
}

function detectMisc(dir: string, name: string, lower: string, raw: Raw): void {
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
  }
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

function readPkg(path: string): PkgJson {
  const pkg: PkgJson = { scripts: {}, deps: new Set(), hasWorkspaces: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return pkg;
  }
  if (!isRecord(parsed)) return pkg;
  if (typeof parsed.name === "string") pkg.name = parsed.name;
  if (typeof parsed.description === "string") pkg.description = parsed.description;
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

/** Turn collected raw signals into the final, accurate stack. */
function synthesize(raw: Raw): RepoStack {
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
  let startCommand: string | undefined;

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
    // A root lint script / linter dep wins; otherwise fall back to a detected linter
    // CONFIG file (eslint.config.* / biome.json), which monorepos have even when the
    // root package.json doesn't declare the lint script or the linter dep.
    lintCommand = deriveLint(pkg) ?? configLint(raw);

    if (pkg.name && entryPoints.length === 0 && pkg.scripts.start) {
      entryPoints.push("npm start");
    }
  } else {
    // Non-Node language defaults (only when a Node manifest is absent).
    if (languages.includes("Go")) {
      testRunner = "go test ./...";
      buildCommand = "go build ./...";
    } else if (languages.includes("Rust")) {
      testRunner = "cargo test";
      buildCommand = "cargo build";
    } else if (languages.includes("Python")) {
      testRunner = derivePythonTest(raw);
      lintCommand = derivePythonLint(raw);
    } else if (languages.includes("Java/Maven")) {
      // Prefer the project's pinned wrapper over a system mvn/gradle when present.
      const mvn = raw.hasMvnw ? "./mvnw" : "mvn";
      testRunner = `${mvn} test`;
      buildCommand = `${mvn} clean package`;
    } else if (languages.includes("Java/Gradle")) {
      const gradle = raw.hasGradlew ? "./gradlew" : "gradle";
      testRunner = `${gradle} test`;
      buildCommand = `${gradle} build`;
    } else if (languages.includes(".NET")) {
      testRunner = "dotnet test";
      buildCommand = "dotnet build";
    }
  }

  const workspaceTool = resolveWorkspaceTool(raw.workspaceSignals);
  // A workspace orchestrator, or simply more than one package manifest, means a
  // single root command must not be presented as authoritative for every package.
  const isMonorepo = workspaceTool !== undefined || raw.manifestCount > 1;

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
  const packageManager = pkg ? raw.packageManager : (raw.packageManager ?? pythonPackageManager(raw));
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
    startCommand,
    browserTest,
    isMonorepo,
    workspaceTool,
    virtualEnvPaths: raw.virtualEnvPaths,
  };
}

function pythonPackageManager(raw: Raw): string | undefined {
  if (raw.pythonManagers.has("uv")) return "uv";
  if (raw.pythonManagers.has("poetry")) return "poetry";
  if (raw.pythonManagers.has("pipenv")) return "pipenv";
  if (raw.pythonManagers.has("pip")) return "pip";
  return undefined;
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
  "maven",
  "gradle",
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
