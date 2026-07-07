# Language Coverage Matrix

Generated from deterministic local fixtures by `runLanguageCoverageBenchmark()`. Grades are `good`, `partial`, or `none`: `good` means the expected signal is detected or correctly omitted when not applicable; `partial` means a subset or root-only signal is detected; `none` means an expected signal is absent.

Wave-2 target order from this matrix: Python, then Rust, then polyglot coexistence with per-workspace commands. Node/TypeScript stays a lock baseline; CDK verbs ride as inferred deployment commands.

| Ecosystem | Role | Languages | Frameworks | Test | Build | Lint | Format | DB | Package manager | Monorepo/workspace | Gap note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Node/TypeScript daily stack | lock | good | good | good | good | good | good | good | good | good | Covered baseline: npm, TS, Angular/Vue/React, Express, PostgreSQL, and AWS CDK labels stay good; do not enhance Node here. CDK verbs are emitted as inferred commands. |
| Python pyproject | wave-2-target | good | good | good | good | good | good | good | good | good | Python primary-stack coverage detects Poetry plus manifest-backed pytest/ruff when no root package.json exists; polyglot Python commands are covered by the per-workspace fixture. |
| Rust Cargo | wave-2-target | good | good | good | good | good | good | good | good | good | Cargo package manager plus test/build/clippy defaults and rustfmt format checks should be visible. |
| Go module | watch | good | good | good | good | good | good | good | good | good | Go module coverage detects Gin, DB drivers, golangci-lint, go modules, and go.work workspace detail. |
| Java Maven | watch | good | good | good | good | good | good | good | good | good | Maven coverage detects Spring Boot, DB drivers, checkstyle, package manager, and reactor workspace detail. |
| .NET | watch | good | good | good | good | good | good | good | good | good | .NET coverage detects ASP.NET Core, EF Core, DB providers, dotnet format, package manager, and solution detail. |
| Node + Python + Rust polyglot | wave-2-target | good | good | good | good | good | good | good | good | good | Secondary languages now keep root Node commands while exposing per-workspace commands, package managers, and Rust formatting for Python/Rust. |

## Fixture Detection

- `node-typescript-daily-stack`: lang=TypeScript/Node.js; fw=AWS CDK+Express+React+Vue+Angular; test=npm test; build=npm run build; lint=npm run lint; format=none; db=PostgreSQL; pm=npm; workspace=none
- `python-pyproject`: lang=Python; fw=FastAPI; test=pytest; build=none; lint=ruff check .; format=none; db=PostgreSQL+Redis; pm=poetry; workspace=none
- `rust-cargo`: lang=Rust; fw=none; test=cargo test; build=cargo build; lint=cargo clippy; format=cargo fmt --check; db=none; pm=cargo; workspace=none
- `go-module`: lang=Go; fw=Gin; test=go test ./...; build=go build ./...; lint=golangci-lint run; format=none; db=PostgreSQL+Redis; pm=go modules; workspace=go workspace
- `java-maven`: lang=Java/Maven; fw=Spring Boot; test=mvn test; build=mvn clean package; lint=mvn checkstyle:check; format=none; db=PostgreSQL; pm=maven; workspace=maven
- `dotnet`: lang=.NET; fw=ASP.NET Core+Entity Framework Core; test=dotnet test; build=dotnet build; lint=dotnet format --verify-no-changes; format=none; db=PostgreSQL+Redis; pm=dotnet; workspace=dotnet solution
- `node-python-rust-polyglot`: lang=TypeScript/Node.js+Rust+Python; fw=FastAPI; test=npm test+cargo test+pytest; build=npm run build+cargo build; lint=cargo clippy+ruff check .; format=cargo fmt --check; db=none; pm=npm+cargo+poetry; workspace=polyglot
