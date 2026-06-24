import { lines } from "../internals/render.js";

/**
 * The bundled ECC (Everything Claude Code) rule library — compact, high-signal
 * rule modules an agent can load with confidence. `common` is the language-
 * agnostic core (always installed); the rest are stack-specific and installed
 * only when the profiler detects that stack. Each module is ONE tight markdown
 * file (kept short on purpose — a crisp checklist beats a wall of prose).
 */

export interface RuleModule {
  /** File slug under `<contextDir>/rules/ecc/<slug>.md`. */
  slug: string;
  /** One-line description shown in the router. */
  summary: string;
  /** When the router should tell the agent to load this module. */
  when: string;
  /** The rule file body. */
  body: string;
}

function rule(slug: string, summary: string, when: string, ...body: string[]): RuleModule {
  return { slug, summary, when, body: lines(...body) };
}

/** The language-agnostic core — always installed. */
export const COMMON: RuleModule = rule(
  "common",
  "Universal engineering discipline (always loaded).",
  "Before any non-trivial change.",
  "# ECC — core discipline",
  "",
  "- **Think before coding.** Read the nearest peer file end-to-end; the existing",
  "  codebase is the spec. Match its conventions; do not re-invent them.",
  "- **Simplicity first (KISS/YAGNI/DRY).** Smallest change that works; no speculative abstractions.",
  "- **Surgical changes.** Touch only what the task needs; keep diffs reviewable.",
  "- **Errors are explicit.** Never swallow them; validate input at boundaries (schema where available).",
  "- **No secrets in code.** No hardcoded keys/tokens; read from env / a secret manager.",
  "- **Tests are a gate, not a flourish.** Add/extend tests for new behavior; run them before",
  '  claiming a change works. "Typecheck clean" is a sanity check, not done.',
  "- **Files small & cohesive** (~200-400 lines, 800 max); functions focused (<50 lines).",
  "- **Report honestly.** Ship-list / skipped-list / unverified-list. Surface gaps even if unasked.",
);

/** Stack-specific modules, keyed by slug. */
export const MODULES: Record<string, RuleModule> = {
  typescript: rule(
    "typescript",
    "TypeScript / Node.js conventions.",
    "Editing .ts/.tsx files.",
    "# ECC — TypeScript",
    "",
    "- Explicit parameter + return types on exported functions; let locals infer.",
    "- Avoid `any`; take `unknown` at boundaries and narrow (type guards or zod).",
    "- `interface` for object shapes, `type` for unions/tuples; prefer string-literal unions over enums.",
    "- Immutable updates (spread / new objects), never in-place mutation of inputs.",
    "- `async`/`await` with try/catch; narrow caught `unknown` before use. No floating promises.",
    "- No `console.log` in shipped code; use a logger.",
  ),
  javascript: rule(
    "javascript",
    "JavaScript / Node.js conventions (no TypeScript).",
    "Editing .js/.jsx/.mjs files.",
    "# ECC — JavaScript (Node.js)",
    "",
    "- Plain JS — do NOT introduce TypeScript syntax or a build step the repo lacks.",
    "- Use JSDoc type annotations where they add clarity.",
    "- `const`/`let` only; small pure functions; avoid mutating shared state.",
    "- Validate external input (request bodies, events, file content) before use.",
    "- Handle promise rejections explicitly; never swallow errors.",
  ),
  python: rule(
    "python",
    "Python conventions.",
    "Editing .py files.",
    "# ECC — Python",
    "",
    "- PEP 8; type hints on public functions; prefer dataclasses/pydantic for shapes.",
    "- Validate at boundaries; raise specific exceptions, never bare `except:`.",
    "- Tests with pytest (AAA); lint/format with ruff. Keep functions small.",
    "- Prefer stdlib + vetted deps; pin versions; no secrets in source.",
  ),
  go: rule(
    "go",
    "Go conventions.",
    "Editing .go files.",
    "# ECC — Go",
    "",
    "- Idiomatic Go: handle every error (`if err != nil`), wrap with `%w` for context.",
    "- Small interfaces at the consumer; accept interfaces, return structs.",
    "- Table-driven tests; `go test ./...` must pass; `go vet` clean.",
    "- Guard goroutines with context; avoid data races (`-race` in CI).",
  ),
  rust: rule(
    "rust",
    "Rust conventions.",
    "Editing .rs files.",
    "# ECC — Rust",
    "",
    "- Prefer `Result`/`?` over panics in library code; reserve `unwrap` for tests/invariants.",
    "- Keep `unsafe` minimal and documented with the invariant it upholds.",
    "- `cargo test` + `cargo clippy -D warnings`; model domain states with enums.",
  ),
  dotnet: rule(
    "dotnet",
    "C# / .NET + EF Core conventions.",
    "Editing .cs files.",
    "# ECC — .NET",
    "",
    "- Async all the way: `ToListAsync`/`FirstOrDefaultAsync`/`SaveChangesAsync`.",
    "- Never block on a Task (`.Result`/`.Wait()`); pass `CancellationToken` through.",
    "- `AsNoTracking()` for read-only queries; nullable reference types on.",
  ),
  java: rule(
    "java",
    "Java (Spring Boot / Quarkus) conventions.",
    "Editing .java files.",
    "# ECC — Java",
    "",
    "- Constructor injection, not field injection; keep controllers thin.",
    "- Validate request DTOs (`@Valid`); never leak entities across the API boundary.",
    "- Tests with JUnit5; no business logic in entities.",
  ),
  "serverless-aws": rule(
    "serverless-aws",
    "Serverless Framework / AWS Lambda conventions.",
    "Editing handlers or serverless.yml / SAM / CDK.",
    "# ECC — Serverless / AWS Lambda",
    "",
    "- Handlers stay thin: validate the event, delegate to a service, return a typed response.",
    "- Stateless — no local disk/session persistence between invocations; reuse SDK clients at module scope.",
    "- Config (table/bucket names, endpoints) from env vars; never hardcode ARNs.",
    "- Least-privilege IAM per function; deploy via the framework, never mutate cloud resources by hand.",
    "- Structured logs (JSON); never log secrets or full request bodies.",
  ),
  web: rule(
    "web",
    "Web / frontend conventions.",
    "Editing components, pages, or styles.",
    "# ECC — Web / frontend",
    "",
    "- Semantic HTML first; meet WCAG AA (labels, focus order, contrast, keyboard paths).",
    "- Keep server state (query libs) separate from client state; derive, don't duplicate.",
    "- Animate only compositor-friendly props (transform/opacity); mind Core Web Vitals.",
    "- Never inject unsanitized HTML; escape dynamic values.",
  ),
};

/** Every installable module slug (common + stack modules) — the "install everything" set. */
export function allModuleSlugs(): string[] {
  return ["common", ...Object.keys(MODULES)];
}

/** Resolve the rule module for a slug ("common" or a stack module). */
export function moduleFor(slug: string): RuleModule | undefined {
  return slug === "common" ? COMMON : MODULES[slug];
}
