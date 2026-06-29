# Language Coverage Matrix

Generated from deterministic local fixtures by `runLanguageCoverageBenchmark()`. Grades are `good`, `partial`, or `none`: `good` means the expected signal is detected or correctly omitted when not applicable; `partial` means a subset or root-only signal is detected; `none` means an expected signal is absent.

Wave-2 target order from this matrix: Python, then Rust, then polyglot coexistence with per-workspace commands. Node/TypeScript stays a lock baseline; the only noted Node-adjacent gap is optional AWS CDK verbs.

| Ecosystem | Role | Languages | Frameworks | Test | Build | Lint | DB | Package manager | Monorepo/workspace | Gap note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Node/TypeScript daily stack | lock | good | good | good | good | good | good | good | good | Covered baseline: npm, TS, Angular/Vue/React, Express, PostgreSQL, and AWS CDK labels stay good; do not enhance Node here. Optional gap: CDK verbs (synth/deploy/diff) are not emitted. |
| Python pyproject | wave-2-target | good | good | good | good | good | good | none | good | Python works only as the primary non-Node stack today: pytest/ruff are inferred when no root package.json exists; Poetry/uv package-manager detection is absent. |
| Rust Cargo | wave-2-target | good | good | good | good | none | good | good | good | Cargo test/build defaults are visible, but lint/fmt verbs (cargo clippy/fmt) are not detected. |
| Go module | watch | good | good | good | good | none | good | good | good | Default test/build commands are present; framework, lint, DB, and workspace detail are thin. |
| Java Maven | watch | good | good | good | good | none | good | good | good | Maven defaults are present; framework, lint, DB, and richer build-tool metadata are not. |
| .NET | watch | good | good | good | good | none | good | good | good | .NET default test/build commands are present; framework, lint, DB, and solution detail are thin. |
| Node + Python + Rust polyglot | wave-2-target | good | partial | partial | partial | good | good | good | none | Secondary languages are seen, but root Node commands win; per-workspace commands and workspace classification are missing. |

## Fixture Detection

- `node-typescript-daily-stack`: lang=TypeScript/Node.js; fw=AWS CDK+Express+React+Vue+Angular; test=npm test; build=npm run build; lint=npm run lint; db=PostgreSQL; pm=npm; workspace=none
- `python-pyproject`: lang=Python; fw=FastAPI; test=pytest; build=none; lint=ruff check .; db=PostgreSQL+Redis; pm=none; workspace=none
- `rust-cargo`: lang=Rust; fw=none; test=cargo test; build=cargo build; lint=none; db=none; pm=none; workspace=none
- `go-module`: lang=Go; fw=none; test=go test ./...; build=go build ./...; lint=none; db=none; pm=none; workspace=none
- `java-maven`: lang=Java/Maven; fw=none; test=mvn test; build=mvn clean package; lint=none; db=none; pm=none; workspace=none
- `dotnet`: lang=.NET; fw=none; test=dotnet test; build=dotnet build; lint=none; db=none; pm=none; workspace=none
- `node-python-rust-polyglot`: lang=TypeScript/Node.js+Rust+Python; fw=FastAPI; test=npm test; build=npm run build; lint=none; db=none; pm=none; workspace=none
