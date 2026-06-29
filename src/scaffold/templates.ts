import { frontmatter, lines } from "../internals/render.js";
import type { RepoStack } from "../profile/scan.js";

/** Auto-populated bullets describing what the profiler actually detected. */
function detectedStackBlock(stack: RepoStack): string[] {
  const out = [
    `- Languages: ${stack.languages.length > 0 ? stack.languages.join(", ") : "none detected"}`,
  ];
  if (stack.frameworks.length > 0) out.push(`- Frameworks: ${stack.frameworks.join(", ")}`);
  if (stack.cloud.length > 0) out.push(`- Cloud: ${stack.cloud.join(", ")}`);
  if (stack.databases.length > 0) out.push(`- Databases: ${stack.databases.join(", ")}`);
  if (stack.deployment.length > 0) out.push(`- Deployment: ${stack.deployment.join(", ")}`);
  if (stack.packageManager) out.push(`- Package manager: ${stack.packageManager}`);
  const cmds: string[] = [];
  if (stack.testRunner) cmds.push(`test \`${stack.testRunner}\``);
  if (stack.buildCommand) cmds.push(`build \`${stack.buildCommand}\``);
  if (stack.lintCommand) cmds.push(`lint \`${stack.lintCommand}\``);
  out.push(`- Commands: ${cmds.length > 0 ? cmds.join(" · ") : "none defined in the repo"}`);
  return out;
}

/** A one-line synthesized overview from the detected facts. */
function overviewLine(stack: RepoStack): string {
  if (stack.description) return stack.description;
  const lang = stack.languages[0] ?? "a multi-language";
  const fw = stack.frameworks.length > 0 ? ` using ${stack.frameworks.join(" + ")}` : "";
  const cloud = stack.cloud.length > 0 ? ` on ${stack.cloud.join("/")}` : "";
  return `A ${lang} project${fw}${cloud}.`;
}

/**
 * Canonical context-dir content. Everything routes through {@link lines} /
 * {@link frontmatter} so golden-file tests stay byte-stable (no dates, no
 * random ordering, single trailing newline). `dir` is the context directory
 * name (`ctx.contextDir`) so every generated path/reference honors the override.
 */

/**
 * Dense routing index — the single entry point an agent loads first. Lists what
 * each context file holds and *when* to load it (progressive disclosure), so a
 * model pulls `architecture.md` only for design work, `conventions.md` only when
 * writing code, etc. Kept ~30 lines on purpose.
 */
export function indexDoc(dir: string): string {
  return lines(
    `# ${dir} — context index`,
    "",
    "Canonical, tool-agnostic context for this repository. The root bootloaders",
    "(`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, …) and `RULE_ROUTER.md` are generated",
    "by `aih bootstrap-ai` and point here — edit context in this directory, never",
    "in the bootloaders.",
    "",
    "> **New / freshly scaffolded?** The files below start as skeletons. An AI agent",
    "> can fill them from the code by following **`SETUP-TASKS.md`** in this directory —",
    "> start there before doing other work.",
    "",
    "## Load order (progressive disclosure)",
    "",
    "Read this index first, then load only the file the task needs:",
    "",
    `- **RULE_ROUTER.md** — generated task router and stack fingerprint.`,
    "  Load first in every AI tool; regenerate with `aih bootstrap-ai`.",
    `- **architecture.md** — owns topology: entry points, modules, data flow,`,
    "  external dependencies, and architectural invariants. Load for design/blast radius.",
    `- **conventions.md** — owns observed repo style: naming, file layout,`,
    "  test/lint commands, review/commit conventions. Load before code changes.",
    `- **project-guardrails.md** — owns repo-specific risks and controls:`,
    "  security-sensitive paths, framework footguns, quality gate, never-do rules.",
    `- **tasks.md** — owns transient work: in-progress items, backlog findings,`,
    "  and decisions in flight. Durable rules graduate to the owning canon file.",
    `- **SETUP-TASKS.md** — first-time completion playbook for skeleton canon.`,
    "  Load only when this repo has not yet been filled from code evidence.",
    `- **VALIDATION.md** — post-setup verification playbook and final report shape.`,
    "  Load when proving the harness is usable for this clone.",
    `- **guardrails-taxonomy.md / command-policy.md / risk-gates.json** — generated`,
    "  control vocabulary and machine-readable policy. Load for guardrail work.",
    `- **adapters/** — generated tool-wiring notes only. Do not add repo behavior`,
    "  rules there; put them in architecture/conventions/project-guardrails.",
    `- **rules/agent-behavior-core.md** — generated tool-agnostic working discipline.`,
    `- **REGENERATION.md / harness-update.md** — how managed vs. author-owned`,
    "  canon updates safely.",
    `- **skills/** — focused, reusable how-to playbooks (one dir per skill,`,
    "  each with a `SKILL.md`). Load a skill only when its trigger matches.",
    "",
    "Stack-aware engineering rules, agents, and the brainstorm→plan→TDD→review loop",
    "are installed into your agent CLI by `aih ecc` (affaan-m/ECC) and `aih superpowers`",
    "(obra/Superpowers), not stored here — this directory holds repo-specific context.",
    "",
    "## Conventions for this directory",
    "",
    "- Keep each file focused; prefer many small files over one large one.",
    "- Every durable rule should carry lineage: industry practice -> repo evidence -> local check.",
    "- Do not duplicate rules across files; link to the owning file and prune stale copies.",
    "- One concern per skill; name skills by outcome, not by component.",
    "- This index is the contract: when you add a context file, list it here",
    "  with a one-line *what* and *when to load*.",
  );
}

/**
 * Architecture context — the "Detected stack" / "Overview" / "Entry points"
 * blocks are auto-populated from the profiler so the file is useful immediately;
 * the prose sections remain author-fill prompts.
 */
export function architectureDoc(dir: string, stack: RepoStack): string {
  const entryPoints =
    stack.entryPoints.length > 0
      ? stack.entryPoints.map((e) => `- \`${e}\``)
      : ["_None detected — list the main entry points (handlers, CLI, server)._"];
  const externalDeps: string[] = [];
  for (const c of stack.cloud) externalDeps.push(`- ${c} (cloud provider / SDK detected).`);
  for (const f of stack.frameworks) externalDeps.push(`- ${f}.`);
  if (externalDeps.length === 0)
    externalDeps.push("_Services, datastores, and third-party APIs this system relies on._");
  const invariants =
    stack.frameworks.includes("Serverless Framework") || stack.deployment.includes("AWS SAM")
      ? [
          "- Lambda handlers must be stateless — no local disk/session persistence between invocations.",
          "- Resource names (tables/buckets) come from environment/config, never hardcoded ARNs.",
        ]
      : ["_Rules that must hold (security, performance, compliance) and why._"];
  return lines(
    "# Architecture",
    "",
    `> Canonical architecture context. Referenced from \`${dir}/INDEX.md\`.`,
    "> The detected blocks are auto-populated by `aih`; expand the prose sections.",
    "",
    "## Ownership",
    "",
    "- Owns: system topology, runtime boundaries, entry points, module responsibilities,",
    "  data flow, external dependencies, and architectural invariants.",
    "- Does not own: coding style (`conventions.md`), security/risk controls",
    "  (`project-guardrails.md`), or transient backlog (`tasks.md`).",
    "- Acceptance: every entry point, module, dependency, and invariant cites repo",
    "  evidence (paths/config/tests) and any invariant names its local check/review.",
    "",
    "## Overview",
    "",
    overviewLine(stack),
    "",
    "_Expand: what this system does and its shape in two or three sentences._",
    "",
    "## Detected stack",
    "",
    detectedStackBlock(stack),
    "",
    "## Entry points",
    "",
    entryPoints,
    "",
    "## Modules",
    "",
    "_The major modules/packages and the responsibility of each._",
    "",
    "## Data flow",
    "",
    "_Trace the primary request/job from entry point through validation, business",
    "logic, persistence/external calls, and response/output._",
    "",
    "## External dependencies",
    "",
    externalDeps,
    "",
    "## Constraints & invariants",
    "",
    invariants,
    "",
    "## Practice lineage",
    "",
    "- For each invariant, record: source practice, repo evidence, and the check that proves it.",
    "- Prefer standards-backed constraints (secure-by-design, least privilege, fast feedback)",
    "  over generic preference; keep the reasoning close to the paths it affects.",
  );
}

/**
 * Conventions context — coding-style / testing lines are seeded from the detected
 * language, linter, and test command; naming/commit sections stay author-fill.
 */
export function conventionsDoc(dir: string, stack: RepoStack): string {
  const isTs = stack.hasTypeScript;
  const isNode = stack.languages.some((l) => l.endsWith("/Node.js"));
  const styleLang = isNode
    ? isTs
      ? "TypeScript (Node.js) — explicit types on exports, no `any`."
      : "JavaScript (Node.js) — plain JS, no TypeScript syntax; JSDoc where it helps."
    : stack.languages.join(", ") || "see repo";
  const naming = isNode
    ? "`camelCase` functions/variables, `PascalCase` types/components, `UPPER_SNAKE_CASE` constants."
    : "match the language's idiom and the nearest peer file; be consistent across the module.";
  return lines(
    "# Conventions",
    "",
    `> Canonical conventions for this repo. Referenced from \`${dir}/INDEX.md\`.`,
    "> Load before writing or reviewing code.",
    "",
    "## Ownership",
    "",
    "- Owns: observed repo style, naming, module layout, import/export patterns,",
    "  error-handling idioms, test layout, quality commands, commits/review norms.",
    "- Does not own: generic agent discipline (`rules/agent-behavior-core.md`),",
    "  architecture (`architecture.md`), or security controls (`project-guardrails.md`).",
    "- Acceptance: cite representative files inspected; record what this repo",
    "  actually does, not aspirational generic standards.",
    "",
    "## Coding style",
    "",
    `- Language: ${styleLang}`,
    `- Lint: ${stack.lintCommand ? `\`${stack.lintCommand}\` — run it before committing` : "no linter configured — consider adding one"}`,
    "- Match the nearest peer file (naming, structure, imports) over personal preference.",
    "- Generic defaults such as small functions, immutability, and explicit errors live",
    "  in `rules/agent-behavior-core.md`; repeat them here only when this repo has",
    "  stricter evidence or a local command/check.",
    "",
    "## Testing",
    "",
    `- Test command: ${stack.testRunner ? `\`${stack.testRunner}\`` : "none configured in the repo — add one and record it here"}`,
    "- New behavior ships with a test; when a test fails, fix the implementation, not the test.",
    "- Cover the boundaries: invalid input, empty and edge cases, error paths.",
    "",
    "## Practice lineage",
    "",
    "- NIST SSDF: protect the codebase and verify changes -> no secrets, explicit review, reproducible gates.",
    "- OWASP: validate inputs and protect CI/CD/LLM surfaces -> boundary checks, secret denial, least privilege.",
    "- DORA: improve delivery with small batches and fast feedback -> focused diffs, green checks, tracked outcomes.",
    "- Translate each practice into a repo-local behavior and command; avoid generic rules with no check.",
    "",
    "## Naming",
    "",
    `- ${naming}`,
    "",
    "## Commits & review",
    "",
    "- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).",
    "- A change merges when tests/lint/types are green, the diff is surgical, and the risk is stated.",
  );
}

/**
 * The agent-executable completion playbook. The harness lays down skeletons; this
 * tells an AI agent exactly how to FILL them from the code — so the harness
 * self-completes instead of waiting on a human. Stack-aware (entry points,
 * commands, frameworks come from the profiler) and evidence-first.
 */
export function setupTasksDoc(dir: string, stack: RepoStack): string {
  const entry =
    stack.entryPoints.length > 0
      ? stack.entryPoints.map((e) => `\`${e}\``).join(", ")
      : "the main handlers / CLI / server entry";
  const lang = stack.languages[0] ?? "the repo language";
  const fw = stack.frameworks.length > 0 ? stack.frameworks.join(", ") : "any framework in use";
  return lines(
    "# Harness setup tasks — run these as an AI agent",
    "",
    "The harness scaffolded this repo but left the project-specific content as",
    "skeletons. Complete them by **reading the code** — ground every statement in",
    "repo evidence (files, tests, configs). Never invent. Do them in order, then",
    "delete the placeholder `_italics_` you replace.",
    "",
    "Do not open `.env*` or `secrets/**` while gathering evidence. Run",
    "`aih secrets --verify` and cite only the redacted finding/status.",
    "",
    "Use the objective practice references already named in `project-guardrails.md`.",
    "Do not web-search for extra canon. Add a durable rule only when it maps to",
    "repo evidence and a local command/review check.",
    "",
    `As you read the code, log any bugs, risks, or EOL/missing dependencies you spot`,
    `into \`${dir}/tasks.md\` (Backlog) — track findings so they aren't lost in chat.`,
    "",
    `## 1. Map the architecture → \`${dir}/architecture.md\``,
    "",
    `- Start from the entry points (${entry}) and trace the main flow(s).`,
    "- Fill: Overview (what it does + shape in 3–5 sentences), Modules (each",
    "  package/dir and its responsibility — cite paths), Data flow, and",
    "  Constraints & invariants (what must hold, and why).",
    "",
    `## 2. Capture conventions → \`${dir}/conventions.md\``,
    "",
    "- Read 5–10 representative files; extract the REAL conventions this repo uses",
    `  (naming, error handling, module layout, test style for ${lang}) — not generic advice.`,
    stack.testRunner
      ? `- The test command is \`${stack.testRunner}\`${stack.lintCommand ? ` and lint is \`${stack.lintCommand}\`` : ""}; record how/where tests live.`
      : "- No test command is configured — note that, and what testing the repo does have.",
    "- Fill the Naming and Commits sections from what the code/history actually does.",
    "",
    `## 3. Enhance guardrails → \`${dir}/project-guardrails.md\``,
    "",
    "Generic gitleaks/pre-commit can't know this repo. From the code, add:",
    `- Security-sensitive paths in THIS repo (auth, payments, PII, ${fw} entry points) — list them.`,
    "- Framework/language footguns to avoid (inferred from the stack + the code).",
    "- The quality gate that must pass before a change is done.",
    '- Repo-specific "never do X" rules you can justify from the code.',
    "- For each added rule, capture `practice -> repo evidence -> local check`; prune duplicates",
    `  instead of copying the same rule into multiple \`${dir}/\` files.`,
    "",
    `## 4. (Workspace only) Cross-repo map → \`${dir}/cross-repo-architecture.md\``,
    "",
    "- If this is a workspace root, map each repo's responsibility and the cross-repo",
    "  feature table (UI ↔ backend ↔ contract). Read each child repo's canon first.",
    "",
    "## Definition of done",
    "",
    `- \`${dir}/INDEX.md\` still lists every canonical file family and their owners.`,
    `- \`${dir}/architecture.md\` has topology, modules, data flow, dependencies,`,
    "  and invariants grounded in real paths/configs.",
    `- \`${dir}/conventions.md\` records observed repo conventions with sampled files`,
    "  and real commands, not a generic style guide.",
    `- \`${dir}/project-guardrails.md\` has repo-specific risks, protected paths,`,
    "  and checks/review triggers tied to the fixed practice references.",
    `- \`${dir}/tasks.md\` contains only active/backlog/decision items; durable rules`,
    "  are promoted to their owning canon file.",
    "- No duplicate durable rules remain across canon files; one owner plus pointers.",
    "- Do not create a separate walkthrough/status report under the canon directory",
    "  unless the user explicitly asks for a new artifact; report validation in chat.",
    "",
    "## When done",
    "",
    `- Run the validation playbook in \`${dir}/VALIDATION.md\` and give the user the`,
    "  final report: ✅ validated, ⚠️ gaps only they can unblock (with the exact",
    "  command/click), and 🔧 workarounds. Don't claim done on anything unverified.",
    `- Do not edit \`${dir}/VALIDATION.md\` to make validation pass. If it fails,`,
    "  report the failing check or the generated-doc bug honestly.",
  );
}

/**
 * The post-setup validation playbook. An AI agent runs these checks against the
 * REAL system and gives the user a final verdict — explicitly separating what the
 * agent confirmed from gaps only a human can unblock, with workarounds. Conditional
 * sections key off files actually present (`.kiro/`, `.devcontainer/`, the workspace
 * marker), so one checklist fits every setup.
 */
export function validationDoc(dir: string, stack: RepoStack): string {
  const gate = [stack.lintCommand, stack.testRunner].filter(Boolean) as string[];
  return lines(
    "# Harness validation — run this, then report to the user",
    "",
    "After setup, validate the harness against the ACTUAL system and give the user a",
    "final verdict. For each item, classify the result:",
    "",
    "- ✅ **OK** — confirmed working (say what you checked).",
    "- ⚠️ **GAP** — only the human can unblock it (you cannot); give the exact command/click.",
    "- 🔧 **WORKAROUND** — a fallback exists; name it.",
    "",
    "Never report ✅ on something you could not actually verify.",
    "Do not edit this validation file to make checks pass. If a check fails because",
    "the generated validation itself is wrong, report it as an `aih` bug.",
    "",
    "## Checks",
    "",
    "### 1. Canon in sync",
    "- Run `aih bootstrap-ai --verify` — expect the router present and every bootloader `in sync`.",
    "- You CAN fix: run `aih bootstrap-ai --apply` if anything is missing/drifted.",
    "",
    "### 2. Context filled (not skeletons)",
    `- \`${dir}/architecture.md\` and \`${dir}/conventions.md\` have no \`_italic placeholders_\` left;`,
    `  \`${dir}/project-guardrails.md\` carries real repo rules.`,
    `- You CAN fix: complete \`${dir}/SETUP-TASKS.md\` from the code.`,
    "",
    "### 2a. Canon file ownership",
    `- \`${dir}/INDEX.md\` lists every canonical file family: architecture, conventions,`,
    "  project guardrails, tasks, setup, validation, generated policy, adapters,",
    "  behavior core, harness update docs, and skills.",
    `- \`${dir}/architecture.md\` owns topology/data flow/invariants only.`,
    `- \`${dir}/conventions.md\` owns observed style/tests/review conventions only.`,
    `- \`${dir}/project-guardrails.md\` owns repo-specific risks, protected paths,`,
    "  framework footguns, quality gates, and never-do rules.",
    `- \`${dir}/tasks.md\` owns transient work/backlog/decisions only; durable rules`,
    "  have been promoted out of it.",
    `- \`${dir}/adapters/\` contains wiring notes only, not project behavior rules.`,
    "- You CAN fix: move content to the owning file and leave a pointer where needed.",
    "",
    "### 2b. Canon objective and deduplicated",
    "- Every durable rule maps to the fixed practice reference set, repo evidence, and a local check.",
    "- Generic or duplicate rules are pruned; one file owns the rule and other files link to it.",
    "- No new walkthrough/status report file exists under the canon directory unless the user asked for one.",
    "- You CAN fix: move the rule to its owning file, replace copies with a pointer, or remove it.",
    "",
    "### 3. Agent tooling installed (per CLI you target)",
    "- Run `aih doctor` and read the AI CLI inventory. Count only runnable CLIs as installed;",
    "  config-only traces are advisory and may be stale.",
    "- ECC + Superpowers present for each runnable targeted tool (Claude → `~/.claude/` populated; Kiro →",
    "  `.kiro/agents`/`.kiro/skills` populated after ECC's `.kiro/install.sh`).",
    "- ⚠️ GAP: in-tool installs (`/plugin install ecc@ecc`, Codex `/plugins`) run only by",
    "  the human INSIDE the tool — list the exact command for them.",
    "- 🔧 WORKAROUND: shell installs you CAN run — `aih ecc --cli <tool> --apply`,",
    "  `bash ECC/.kiro/install.sh .` (Kiro).",
    "",
    "### 4. Guardrails active",
    "- `.gitleaks.toml` and `.pre-commit-config.yaml` present.",
    gate.length > 0
      ? `- The quality gate is \`${gate.join(" && ")}\` — confirm it passes.`
      : "- No lint/test command detected — note that as a gap to add one.",
    "- ⚠️ GAP: the pre-commit hook is opt-in — the human runs `git config core.hooksPath .githooks`",
    "  once, and `gitleaks`/`pre-commit` must be installed. 🔧 WORKAROUND: rely on the CI gate.",
    "",
    "### 5. MCP wired",
    "- `.mcp.json` present; its stdio servers need `uv`, the workspace filesystem server needs `npx`.",
    "- ⚠️ GAP if `uv`/`npx` missing → install them. 🔧 WORKAROUND: remove servers you can't launch.",
    "",
    "### 6. Dev tools",
    "- Run `aih doctor` — are `rg`/`fd`/`jq` present?",
    "- ⚠️ GAP: missing → install (winget/scoop/brew) or, on a locked-down VDI, add your bundle to PATH.",
    "",
    "### 7. Kiro (only if `.kiro/` exists)",
    "- Steering files load (`inclusion: always`); `.kiro/hooks/*.kiro.hook` appear in the Agent Hooks panel.",
    "- ⚠️ GAP: enabling a hook is a one-click action in Kiro's Agent Hooks panel — only the human can.",
    "",
    "### 8. Sandbox (only if `.devcontainer/` exists)",
    "- Is Docker available (`docker info`)?",
    "- ⚠️ GAP: Docker not running → the human starts Docker. 🔧 WORKAROUND: skip the devcontainer.",
    "",
    "### 9. Workspace (only if workspace configuration exists)",
    "- Run `aih doctor` (workspace mode): every child repo scaffolded?",
    `  Is \`${dir}/cross-repo-architecture.md\` filled in?`,
    "- You CAN fix: run `aih init` in each child; fill the cross-repo map.",
    "",
    "### 10. Secrets",
    "- Do not open `.env*` or `secrets/**`. Validate with `aih secrets --verify` instead.",
    "- `aih secrets --verify` must pass before you claim no plaintext secrets are committed.",
    "- `.claudeignore` + `.claude/settings.json` deny rules must be present.",
    "- ⚠️ GAP: if a real secret is found, the human must rotate it and remove it from history.",
    "",
    "## Final report (give this to the user)",
    "",
    "- ✅ **Validated** — what's confirmed working.",
    "- ⚠️ **Gaps to unblock** — each item only the human can do, with the exact command/click.",
    "- 🔧 **Workarounds** — where a gap has a fallback.",
    "",
    'End with a one-line verdict: "picture-perfect ✅" or "N gap(s) to unblock".',
  );
}

/** Framework / stack-specific guardrails auto-derived from the detected stack. */
function frameworkGuardrails(stack: RepoStack): string[] {
  const fw = new Set(stack.frameworks);
  const out: string[] = [];
  if (
    fw.has("Serverless Framework") ||
    stack.deployment.includes("AWS SAM") ||
    stack.deployment.includes("AWS CDK")
  ) {
    out.push("- Lambda handlers stay stateless — no local disk/session between invocations.");
    out.push("- Resource names/ARNs come from env/config, never hardcoded; IAM least-privilege.");
  }
  if (fw.has("Express") || fw.has("Fastify") || fw.has("Koa") || fw.has("NestJS")) {
    out.push(
      "- Validate and sanitize every request input at the boundary; parameterize all queries.",
    );
    out.push("- Set security headers; never build SQL/paths by concatenating user input.");
  }
  if (
    fw.has("React") ||
    fw.has("Next.js") ||
    fw.has("Vue") ||
    fw.has("Svelte") ||
    fw.has("Angular")
  ) {
    out.push("- Escape user content; no `dangerouslySetInnerHTML` / `v-html` without sanitizing.");
    out.push("- Keep secrets server-side; never ship API keys in the client bundle.");
  }
  if (stack.databases.length > 0) {
    out.push(
      `- ${stack.databases.join("/")}: parameterized queries only; least-privilege credentials from env.`,
    );
  }
  if (stack.cloud.length > 0) {
    out.push(
      `- ${stack.cloud.join("/")}: no hardcoded credentials — use roles/managed identity; encrypt at rest.`,
    );
  }
  return out;
}

/**
 * A write-once project-guardrails seed. aih fills the detected facts AND derives
 * framework/stack-specific guardrails; the agent fleshes out the rest per
 * `SETUP-TASKS.md`. Write-once so the agent's work is never overwritten on a re-run.
 */
export function projectGuardrailsDoc(dir: string, stack: RepoStack): string {
  const fwGuards = frameworkGuardrails(stack);
  const gate = [stack.lintCommand, stack.testRunner].filter(Boolean) as string[];
  return lines(
    "# Project guardrails",
    "",
    `> Repo-specific guardrails. Seeded by aih from the detected stack; an agent`,
    `> fleshes this out per \`${dir}/SETUP-TASKS.md\`. WRITE-ONCE — aih won't overwrite it.`,
    "",
    "## Ownership",
    "",
    "- Owns: repo-specific security-sensitive paths, framework/language footguns,",
    "  quality gates, review triggers, and never-do rules.",
    "- Does not own: general coding style (`conventions.md`), system topology",
    "  (`architecture.md`), or transient backlog (`tasks.md`).",
    "- Acceptance: each guardrail names practice, repo evidence, and the command",
    "  or review path that enforces/checks it.",
    "",
    "## Detected stack",
    "",
    detectedStackBlock(stack),
    "",
    "## Quality gate",
    "",
    gate.length > 0
      ? `- \`${gate.join(" && ")}\` must pass before a change is considered done.`
      : "- _No lint/test command detected — add one and record it here._",
    "",
    "## Practice lineage",
    "",
    "- Fixed reference set; do not web-search for extra canon:",
    "  - NIST SSDF SP 800-218: https://csrc.nist.gov/pubs/sp/800/218/final",
    "  - OWASP Top 10: https://owasp.org/www-project-top-ten/",
    "  - OWASP Top 10 for LLM Applications: https://owasp.org/www-project-top-10-for-large-language-model-applications/",
    "  - OWASP CI/CD Security Risks: https://owasp.org/www-project-top-10-ci-cd-security-risks/",
    "  - DORA Four Keys: https://dora.dev/guides/dora-metrics-four-keys/",
    "- Secure development (NIST SSDF): protect secrets, review sensitive changes, and verify generated artifacts.",
    "- App/pipeline security (OWASP): validate inputs, minimize privileges, keep CI/CD and LLM surfaces observable.",
    "- Delivery outcomes (DORA): keep changes small, checks fast, and failures recoverable.",
    "- Each guardrail below should name the repo path it protects and the command/review that enforces it.",
    "",
    "## Guardrail entry format",
    "",
    "- Practice: the fixed reference or local invariant behind the rule.",
    "- Repo evidence: the path/config/test showing why this repo needs it.",
    "- Check/review: the command, hook, CI gate, or human review trigger.",
    "",
    "## Security-sensitive paths",
    "",
    "_List the dirs/files that handle auth, secrets, payments, or PII. Changes here",
    "get extra review; never log or hardcode secrets in them._",
    "",
    "## Framework / language guardrails",
    "",
    ...(fwGuards.length > 0
      ? [...fwGuards, "", "_Add any others you infer from the code._"]
      : ["_Stack-specific rules and footguns to avoid (fill from the code)._"]),
    "",
    "## Never do",
    "",
    '_Repo-specific hard "no"s, justified from the code or team conventions._',
  );
}

/** Tasks skeleton — section headers an author fills in per repo. */
export function tasksDoc(dir: string): string {
  return lines(
    "# Tasks",
    "",
    `> Active work and decisions. Referenced from \`${dir}/INDEX.md\`.`,
    "> Durable architecture, convention, or guardrail rules do not live here;",
    "> promote them to the owning canon file and leave only the work item.",
    "",
    "## In progress",
    "",
    "Use this shape for active items:",
    "- [ ] `type`: title — evidence: `path:line`; next check: `command` or review path.",
    "",
    "## Backlog",
    "",
    "Use this shape for findings discovered during setup or implementation:",
    "- [ ] `bug|risk|debt|missing-gate`: finding — evidence: `path:line`; unblock/check: `command`.",
    "",
    "## Decisions",
    "",
    "Use this shape for temporary/in-flight decisions; promote durable decisions",
    "to architecture/conventions/project-guardrails when they become standing rules.",
    "- YYYY-MM-DD — decision: summary — rationale: why — owner/check: path or command.",
  );
}

/**
 * The INDEX/SKILL pattern in miniature: YAML frontmatter ({@link frontmatter})
 * giving the skill a `name` + `description` (the trigger), then a few numbered
 * steps. Real skills replace this; its job is to show the shape.
 */
export function exampleSkillDoc(): string {
  return lines(
    frontmatter({
      name: "example-skill",
      description:
        "Replace with a one-line trigger: what task this skill is for and when to load it.",
    }),
    "",
    "# Example skill",
    "",
    "A skill is a focused, reusable playbook. Keep it to one outcome and make the",
    "`description` above a precise trigger so an agent loads it only when relevant.",
    "",
    "## Steps",
    "",
    "1. State the goal and the preconditions that must hold before starting.",
    "2. Do the work as concrete, ordered actions (commands, edits, checks).",
    "3. Verify the outcome and note how to roll back if it went wrong.",
  );
}
