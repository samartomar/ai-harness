import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanRepo, type RepoStack } from "./scan.js";

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
    test?: string;
    build?: string;
    lint?: string;
    db: string[];
    packageManager?: string;
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

function gradeOptional(actual: string | undefined, expected: readonly string[] = []): CoverageGrade {
  if (expected.length === 0) return actual === undefined ? "good" : "partial";
  if (actual === undefined) return "none";
  if (!expected.includes(actual)) return "partial";
  return expected.length === 1 ? "good" : "partial";
}

function gradeWorkspace(stack: RepoStack, expected: readonly string[] = []): CoverageGrade {
  if (expected.length === 0) return stack.isMonorepo ? "partial" : "good";
  if (!stack.isMonorepo) return "none";
  if (stack.workspaceTool === undefined) return "partial";
  return expected.includes(stack.workspaceTool) ? "good" : "partial";
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
    ].join("\n"),
  );
  put(root, "app/main.py", "from fastapi import FastAPI\napp = FastAPI()\n");
}

function seedRust(root: string): void {
  put(
    root,
    "Cargo.toml",
    ['[package]', 'name = "ruflo"', 'version = "0.1.0"', 'edition = "2021"', ""].join("\n"),
  );
  put(root, "src/main.rs", "fn main() {}\n");
}

function seedGo(root: string): void {
  put(root, "go.mod", "module example.com/app\n\ngo 1.22\n");
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
      "</project>",
      "",
    ].join("\n"),
  );
}

function seedDotnet(root: string): void {
  put(
    root,
    "App.csproj",
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n',
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
  put(root, "tsconfig.json", json({ compilerOptions: { strict: true } }));
  put(root, "src/index.ts", "export const x = 1;\n");
  put(root, "services/api/pyproject.toml", "[project]\nname = \"api\"\ndependencies = [\"fastapi\"]\n");
  put(root, "crates/worker/Cargo.toml", "[package]\nname = \"worker\"\nversion = \"0.1.0\"\n");
}

const FIXTURES: CoverageFixture[] = [
  {
    id: "node-typescript-daily-stack",
    ecosystem: "Node/TypeScript daily stack",
    role: "lock",
    note:
      "Covered baseline: npm, TS, Angular/Vue/React, Express, PostgreSQL, and AWS CDK labels stay good; do not enhance Node here. Optional gap: CDK verbs (synth/deploy/diff) are not emitted.",
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
    note:
      "Python works only as the primary non-Node stack today: pytest/ruff are inferred when no root package.json exists; Poetry/uv package-manager detection is absent.",
    seed: seedPython,
    expected: {
      languages: ["Python"],
      frameworks: ["FastAPI"],
      test: ["pytest"],
      lint: ["ruff check ."],
      db: ["PostgreSQL", "Redis"],
      packageManager: ["poetry", "uv"],
    },
  },
  {
    id: "rust-cargo",
    ecosystem: "Rust Cargo",
    role: "wave-2-target",
    note:
      "Cargo test/build defaults are visible, but lint/fmt verbs (cargo clippy/fmt) are not detected.",
    seed: seedRust,
    expected: {
      languages: ["Rust"],
      test: ["cargo test"],
      build: ["cargo build"],
      lint: ["cargo clippy", "cargo fmt"],
    },
  },
  {
    id: "go-module",
    ecosystem: "Go module",
    role: "watch",
    note: "Default test/build commands are present; framework, lint, DB, and workspace detail are thin.",
    seed: seedGo,
    expected: {
      languages: ["Go"],
      test: ["go test ./..."],
      build: ["go build ./..."],
      lint: ["golangci-lint run", "go vet ./..."],
    },
  },
  {
    id: "java-maven",
    ecosystem: "Java Maven",
    role: "watch",
    note: "Maven defaults are present; framework, lint, DB, and richer build-tool metadata are not.",
    seed: seedJava,
    expected: {
      languages: ["Java/Maven"],
      test: ["mvn test"],
      build: ["mvn clean package"],
      lint: ["mvn checkstyle:check"],
    },
  },
  {
    id: "dotnet",
    ecosystem: ".NET",
    role: "watch",
    note: ".NET default test/build commands are present; framework, lint, DB, and solution detail are thin.",
    seed: seedDotnet,
    expected: {
      languages: [".NET"],
      test: ["dotnet test"],
      build: ["dotnet build"],
      lint: ["dotnet format --verify-no-changes"],
    },
  },
  {
    id: "node-python-rust-polyglot",
    ecosystem: "Node + Python + Rust polyglot",
    role: "wave-2-target",
    note:
      "Secondary languages are seen, but root Node commands win; per-workspace commands and workspace classification are missing.",
    seed: seedPolyglot,
    expected: {
      languages: ["TypeScript/Node.js", "Python", "Rust"],
      test: ["npm test", "pytest", "cargo test"],
      build: ["npm run build", "cargo build"],
      workspace: ["polyglot"],
    },
  },
];

function runFixture(fixture: CoverageFixture): LanguageCoverageRow {
  const root = mkdtempSync(join(tmpdir(), "aih-language-coverage-"));
  try {
    fixture.seed(root);
    const stack = scanRepo(root, { maxDepth: 8, contextDir: "ai-coding" });
    return {
      id: fixture.id,
      ecosystem: fixture.ecosystem,
      role: fixture.role,
      grades: {
        languages: gradeList(stack.languages, fixture.expected.languages),
        frameworks: gradeList(stack.frameworks, fixture.expected.frameworks),
        test: gradeOptional(stack.testRunner, fixture.expected.test),
        build: gradeOptional(stack.buildCommand, fixture.expected.build),
        lint: gradeOptional(stack.lintCommand, fixture.expected.lint),
        db: gradeList(stack.databases, fixture.expected.db),
        packageManager: gradeOptional(stack.packageManager, fixture.expected.packageManager),
        workspace: gradeWorkspace(stack, fixture.expected.workspace),
      },
      detected: {
        languages: stack.languages,
        frameworks: stack.frameworks,
        test: stack.testRunner,
        build: stack.buildCommand,
        lint: stack.lintCommand,
        db: stack.databases,
        packageManager: stack.packageManager,
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
    `test=${row.detected.test ?? "none"}`,
    `build=${row.detected.build ?? "none"}`,
    `lint=${row.detected.lint ?? "none"}`,
    `db=${row.detected.db.join("+") || "none"}`,
    `pm=${row.detected.packageManager ?? "none"}`,
    `workspace=${row.detected.workspace ?? "none"}`,
  ];
  return parts.join("; ");
}

export function renderLanguageCoverageMarkdown(rows: readonly LanguageCoverageRow[]): string {
  const header = [
    "# Language Coverage Matrix",
    "",
    "Generated from deterministic local fixtures by `runLanguageCoverageBenchmark()`. Grades are `good`, `partial`, or `none`: `good` means the expected signal is detected or correctly omitted when not applicable; `partial` means a subset or root-only signal is detected; `none` means an expected signal is absent.",
    "",
    "Wave-2 target order from this matrix: Python, then Rust, then polyglot coexistence with per-workspace commands. Node/TypeScript stays a lock baseline; the only noted Node-adjacent gap is optional AWS CDK verbs.",
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
      .map((cell) => String(cell).replace(/\|/g, "\\|"))
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
