import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type RepoStack, scanRepo } from "./scan.js";

export type CoverageGrade = "good" | "partial" | "none";
export type CoverageRole = "lock" | "wave-2-target" | "watch";

export type CoverageDimension =
  | "languages"
  | "frameworks"
  | "test"
  | "build"
  | "lint"
  | "db"
  | "packageManager"
  | "workspace";

export interface LanguageCoverageRow {
  id: string;
  ecosystem: string;
  role: CoverageRole;
  grades: Record<CoverageDimension, CoverageGrade>;
  detected: {
    languages: string[];
    frameworks: string[];
    test: string[];
    build: string[];
    lint: string[];
    db: string[];
    packageManager: string[];
    workspace?: string;
  };
  note: string;
}

interface FixtureExpectation {
  languages: string[];
  frameworks?: string[];
  test?: string[];
  build?: string[];
  lint?: string[];
  db?: string[];
  packageManager?: string[];
  workspace?: string[];
}

interface CoverageFixture {
  id: string;
  ecosystem: string;
  role: CoverageRole;
  note: string;
  seed: (root: string) => void;
  expected: FixtureExpectation;
}

function put(root: string, rel: string, contents: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function gradeList(actual: readonly string[], expected: readonly string[] = []): CoverageGrade {
  if (expected.length === 0) return actual.length === 0 ? "good" : "partial";
  const present = expected.filter((value) => actual.includes(value)).length;
  if (present === expected.length) return "good";
  return present > 0 ? "partial" : "none";
}

function gradeWorkspace(stack: RepoStack, expected: readonly string[] = []): CoverageGrade {
  if (expected.length === 0) return stack.isMonorepo ? "partial" : "good";
  if (!stack.isMonorepo) return "none";
  if (stack.workspaceTool === undefined) return "partial";
  return expected.includes(stack.workspaceTool) ? "good" : "partial";
}

function commandValues(
  stack: RepoStack,
  field: "testRunner" | "buildCommand" | "lintCommand",
): string[] {
  return dedupe([
    stack[field],
    ...Object.values(stack.workspaces ?? {}).map((workspace) => workspace[field]),
  ]);
}

function packageManagers(stack: RepoStack): string[] {
  return dedupe([
    stack.packageManager,
    ...Object.values(stack.workspaces ?? {}).map((workspace) => workspace.packageManager),
  ]);
}

function dedupe(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function seedNodeDailyStack(root: string): void {
  put(
    root,
    "package.json",
    json({
      name: "node-daily-stack",
      description: "Node daily-stack coverage baseline",
      scripts: {
        test: "vitest run",
        build: "tsc -p .",
        lint: "biome check .",
        start: "node dist/main.js",
      },
      dependencies: {
        "@angular/core": "^17",
        "aws-cdk-lib": "^2",
        express: "^4",
        pg: "^8",
        react: "^18",
        vue: "^3",
      },
      devDependencies: {
        "@biomejs/biome": "^2",
        typescript: "^5",
        vitest: "^1",
      },
    }),
  );
  put(root, "package-lock.json", json({ lockfileVersion: 3 }));
  put(root, "tsconfig.json", json({ compilerOptions: { strict: true } }));
  put(root, "src/main.ts", "export const main = (): number => 0;\n");
  put(root, "cdk.json", json({ app: "npx ts-node bin/app.ts" }));
}

function seedPython(root: string): void {
  put(
    root,
    "pyproject.toml",
    [
      "[tool.poetry]",
      'name = "py-api"',
      'version = "0.1.0"',
      "",
      "[tool.poetry.dependencies]",
      'python = "^3.12"',
      'fastapi = "*"',
      'asyncpg = "*"',
      'redis = "*"',
      "",
      "[tool.poetry.group.dev.dependencies]",
      'pytest = "*"',
      'ruff = "*"',
      "",
    ].join("\n"),
  );
  put(root, "app/main.py", "from fastapi import FastAPI\napp = FastAPI()\n");
}

function seedRust(root: string): void {
  put(
    root,
    "Cargo.toml",
    ["[package]", 'name = "ruflo"', 'version = "0.1.0"', 'edition = "2021"', ""].join("\n"),
  );
  put(root, "src/main.rs", "fn main() {}\n");
}

function seedGo(root: string): void {
  put(
    root,
    "go.mod",
    [
      "module example.com/app",
      "",
      "go 1.22",
      "",
      "require (",
      "  github.com/gin-gonic/gin v1.9.0",
      "  github.com/lib/pq v1.10.9",
      "  github.com/redis/go-redis/v9 v9.5.1",
      ")",
      "",
    ].join("\n"),
  );
  put(root, ".golangci.yml", "run:\n  timeout: 5m\n");
  put(root, "go.work", "go 1.22\n\nuse ./services/worker\n");
  put(root, "services/worker/go.mod", "module example.com/worker\n\ngo 1.22\n");
  put(root, "main.go", "package main\n\nfunc main() {}\n");
}

function seedJava(root: string): void {
  put(
    root,
    "pom.xml",
    [
      "<project>",
      "  <modelVersion>4.0.0</modelVersion>",
      "  <groupId>com.example</groupId>",
      "  <artifactId>app</artifactId>",
      "  <version>1.0.0</version>",
      "  <modules><module>api</module></modules>",
      "  <dependencies>",
      "    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>",
      "    <dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId></dependency>",
      "  </dependencies>",
      "  <build><plugins>",
      "    <plugin><artifactId>maven-checkstyle-plugin</artifactId></plugin>",
      "  </plugins></build>",
      "</project>",
      "",
    ].join("\n"),
  );
}

function seedDotnet(root: string): void {
  put(root, "App.sln", "Microsoft Visual Studio Solution File\n");
  put(
    root,
    "src/Api/Api.csproj",
    [
      '<Project Sdk="Microsoft.NET.Sdk.Web">',
      "  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>",
      "  <ItemGroup>",
      '    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" />',
      '    <PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8.0.0" />',
      '    <PackageReference Include="StackExchange.Redis" Version="2.7.0" />',
      "  </ItemGroup>",
      "</Project>",
      "",
    ].join("\n"),
  );
}

function seedPolyglot(root: string): void {
  put(
    root,
    "package.json",
    json({
      name: "polyglot-root",
      scripts: { test: "vitest run", build: "tsc -p ." },
      devDependencies: { typescript: "^5", vitest: "^1" },
    }),
  );
  put(root, "package-lock.json", json({ lockfileVersion: 3 }));
  put(root, "tsconfig.json", json({ compilerOptions: { strict: true } }));
  put(root, "src/index.ts", "export const x = 1;\n");
  put(
    root,
    "services/api/pyproject.toml",
    [
      "[tool.poetry]",
      'name = "api"',
      'version = "0.1.0"',
      "",
      "[tool.poetry.dependencies]",
      'python = "^3.12"',
      'fastapi = "*"',
      "",
      "[tool.poetry.group.dev.dependencies]",
      'pytest = "*"',
      'ruff = "*"',
      "",
    ].join("\n"),
  );
  put(root, "crates/worker/Cargo.toml", '[package]\nname = "worker"\nversion = "0.1.0"\n');
}

const FIXTURES: CoverageFixture[] = [
  {
    id: "node-typescript-daily-stack",
    ecosystem: "Node/TypeScript daily stack",
    role: "lock",
    note: "Covered baseline: npm, TS, Angular/Vue/React, Express, PostgreSQL, and AWS CDK labels stay good; do not enhance Node here. CDK verbs are emitted as inferred commands.",
    seed: seedNodeDailyStack,
    expected: {
      languages: ["TypeScript/Node.js"],
      frameworks: ["Angular", "Vue", "React", "Express", "AWS CDK"],
      test: ["npm test"],
      build: ["npm run build"],
      lint: ["npm run lint"],
      db: ["PostgreSQL"],
      packageManager: ["npm"],
    },
  },
  {
    id: "python-pyproject",
    ecosystem: "Python pyproject",
    role: "wave-2-target",
    note: "Python primary-stack coverage detects Poetry plus manifest-backed pytest/ruff when no root package.json exists; polyglot Python commands are covered by the per-workspace fixture.",
    seed: seedPython,
    expected: {
      languages: ["Python"],
      frameworks: ["FastAPI"],
      test: ["pytest"],
      lint: ["ruff check ."],
      db: ["PostgreSQL", "Redis"],
      packageManager: ["poetry"],
    },
  },
  {
    id: "rust-cargo",
    ecosystem: "Rust Cargo",
    role: "wave-2-target",
    note: "Cargo package manager plus test/build/clippy defaults should be visible; rustfmt remains outside the current single lint-command slot.",
    seed: seedRust,
    expected: {
      languages: ["Rust"],
      test: ["cargo test"],
      build: ["cargo build"],
      lint: ["cargo clippy"],
      packageManager: ["cargo"],
    },
  },
  {
    id: "go-module",
    ecosystem: "Go module",
    role: "watch",
    note: "Go module coverage detects Gin, DB drivers, golangci-lint, go modules, and go.work workspace detail.",
    seed: seedGo,
    expected: {
      languages: ["Go"],
      frameworks: ["Gin"],
      test: ["go test ./..."],
      build: ["go build ./..."],
      lint: ["golangci-lint run"],
      db: ["PostgreSQL", "Redis"],
      packageManager: ["go modules"],
      workspace: ["go workspace"],
    },
  },
  {
    id: "java-maven",
    ecosystem: "Java Maven",
    role: "watch",
    note: "Maven coverage detects Spring Boot, DB drivers, checkstyle, package manager, and reactor workspace detail.",
    seed: seedJava,
    expected: {
      languages: ["Java/Maven"],
      frameworks: ["Spring Boot"],
      test: ["mvn test"],
      build: ["mvn clean package"],
      lint: ["mvn checkstyle:check"],
      db: ["PostgreSQL"],
      packageManager: ["maven"],
      workspace: ["maven"],
    },
  },
  {
    id: "dotnet",
    ecosystem: ".NET",
    role: "watch",
    note: ".NET coverage detects ASP.NET Core, EF Core, DB providers, dotnet format, package manager, and solution detail.",
    seed: seedDotnet,
    expected: {
      languages: [".NET"],
      frameworks: ["ASP.NET Core", "Entity Framework Core"],
      test: ["dotnet test"],
      build: ["dotnet build"],
      lint: ["dotnet format --verify-no-changes"],
      db: ["PostgreSQL", "Redis"],
      packageManager: ["dotnet"],
      workspace: ["dotnet solution"],
    },
  },
  {
    id: "node-python-rust-polyglot",
    ecosystem: "Node + Python + Rust polyglot",
    role: "wave-2-target",
    note: "Secondary languages now keep root Node commands while exposing per-workspace commands and package managers for Python/Rust.",
    seed: seedPolyglot,
    expected: {
      languages: ["TypeScript/Node.js", "Python", "Rust"],
      frameworks: ["FastAPI"],
      test: ["npm test", "pytest", "cargo test"],
      build: ["npm run build", "cargo build"],
      lint: ["ruff check .", "cargo clippy"],
      packageManager: ["npm", "poetry", "cargo"],
      workspace: ["polyglot"],
    },
  },
];

function runFixture(fixture: CoverageFixture): LanguageCoverageRow {
  const root = mkdtempSync(join(tmpdir(), "aih-language-coverage-"));
  try {
    fixture.seed(root);
    const stack = scanRepo(root, { maxDepth: 8, contextDir: "ai-coding" });
    const tests = commandValues(stack, "testRunner");
    const builds = commandValues(stack, "buildCommand");
    const lints = commandValues(stack, "lintCommand");
    const managers = packageManagers(stack);
    return {
      id: fixture.id,
      ecosystem: fixture.ecosystem,
      role: fixture.role,
      grades: {
        languages: gradeList(stack.languages, fixture.expected.languages),
        frameworks: gradeList(stack.frameworks, fixture.expected.frameworks),
        test: gradeList(tests, fixture.expected.test),
        build: gradeList(builds, fixture.expected.build),
        lint: gradeList(lints, fixture.expected.lint),
        db: gradeList(stack.databases, fixture.expected.db),
        packageManager: gradeList(managers, fixture.expected.packageManager),
        workspace: gradeWorkspace(stack, fixture.expected.workspace),
      },
      detected: {
        languages: stack.languages,
        frameworks: stack.frameworks,
        test: tests,
        build: builds,
        lint: lints,
        db: stack.databases,
        packageManager: managers,
        workspace: stack.workspaceTool,
      },
      note: fixture.note,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function runLanguageCoverageBenchmark(): LanguageCoverageRow[] {
  return FIXTURES.map(runFixture);
}

function detectedSummary(row: LanguageCoverageRow): string {
  const parts = [
    `lang=${row.detected.languages.join("+") || "none"}`,
    `fw=${row.detected.frameworks.join("+") || "none"}`,
    `test=${row.detected.test.join("+") || "none"}`,
    `build=${row.detected.build.join("+") || "none"}`,
    `lint=${row.detected.lint.join("+") || "none"}`,
    `db=${row.detected.db.join("+") || "none"}`,
    `pm=${row.detected.packageManager.join("+") || "none"}`,
    `workspace=${row.detected.workspace ?? "none"}`,
  ];
  return parts.join("; ");
}

function markdownTableCell(value: unknown): string {
  return String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export function renderLanguageCoverageMarkdown(rows: readonly LanguageCoverageRow[]): string {
  const header = [
    "# Language Coverage Matrix",
    "",
    "Generated from deterministic local fixtures by `runLanguageCoverageBenchmark()`. Grades are `good`, `partial`, or `none`: `good` means the expected signal is detected or correctly omitted when not applicable; `partial` means a subset or root-only signal is detected; `none` means an expected signal is absent.",
    "",
    "Wave-2 target order from this matrix: Python, then Rust, then polyglot coexistence with per-workspace commands. Node/TypeScript stays a lock baseline; CDK verbs ride as inferred deployment commands.",
    "",
    "| Ecosystem | Role | Languages | Frameworks | Test | Build | Lint | DB | Package manager | Monorepo/workspace | Gap note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const table = rows.map((row) =>
    [
      row.ecosystem,
      row.role,
      row.grades.languages,
      row.grades.frameworks,
      row.grades.test,
      row.grades.build,
      row.grades.lint,
      row.grades.db,
      row.grades.packageManager,
      row.grades.workspace,
      row.note,
    ]
      .map((cell) => markdownTableCell(cell))
      .join(" | "),
  );
  const detail = [
    "",
    "## Fixture Detection",
    "",
    ...rows.flatMap((row) => [`- \`${row.id}\`: ${detectedSummary(row)}`]),
    "",
  ];
  return [...header, ...table.map((line) => `| ${line} |`), ...detail].join("\n");
}
