import { frontmatter, lines } from "../internals/render.js";
import type { RepoStack } from "../profile/scan.js";

/**
 * Kiro-native content. Kiro can't read `~/.claude/...`, so the agent harness it
 * needs is delivered as `.kiro/steering/*.md` (always-on markdown) and
 * `.kiro/hooks/*.kiro.hook` (JSON). Schemas verified against affaan-m/ECC's real
 * `.kiro/` tree (kiro.dev/docs/steering + /hooks).
 */

/** Wrap a markdown body as an always-loaded Kiro steering file. */
export function kiroAlwaysSteering(body: string): string {
  return `${frontmatter({ inclusion: "always" })}\n\n${body}`;
}

/** Source-file globs for the detected languages (Kiro hook `patterns`). */
function sourceGlobs(stack: RepoStack): string[] {
  const g: string[] = [];
  for (const l of stack.languages) {
    if (l.endsWith("/Node.js")) g.push("*.ts", "*.tsx", "*.js", "*.jsx");
    else if (l === "Python") g.push("*.py");
    else if (l === "Go") g.push("*.go");
    else if (l.startsWith("Java/")) g.push("*.java", "*.kt");
    else if (l === ".NET") g.push("*.cs");
    else if (l === "Rust") g.push("*.rs");
  }
  return g.length > 0 ? [...new Set(g)] : ["*.ts", "*.js", "*.py"];
}

/**
 * Fail-open command for the agentStop metrics snapshot. The hook is still a `node -e`
 * one-shot so it depends only on Node, but the actual `aih track --apply` call uses
 * `execFileSync(..., shell:false)` with this workspace removed from PATH. A missing,
 * failing, or hung global `aih` warns and exits 0 — so the turn is never failed.
 * The inner timeout bounds a stuck `aih` even if the hook host ignores its timeout.
 */
function metricsCommand(): string {
  return `node -e "const cp=require('node:child_process'),path=require('node:path');const cwd=process.cwd();const clean=(process.env.PATH||'').split(path.delimiter).filter(p=>{const r=path.relative(cwd,path.resolve(p));return r.startsWith('..')||path.isAbsolute(r)}).join(path.delimiter);try{cp.execFileSync('aih',['track','--apply'],{stdio:'ignore',timeout:12000,shell:false,env:{...process.env,PATH:clean}})}catch(e){console.warn('aih metrics snapshot skipped: '+(e&&e.message?e.message:e))}"`;
}

/** A single Kiro hook in the real `.kiro.hook` schema. */
interface KiroHook {
  path: string;
  hook: unknown;
}

/**
 * A small, stack-aware hook set in the verified `.kiro.hook` schema, namespaced
 * `aih-` so it never clashes with ECC's hooks. The quality-gate runs the repo's
 * own declared verify gate when present, otherwise its test/lint commands; the
 * others ask the agent on the relevant events.
 */
export function kiroHooks(stack: RepoStack): KiroHook[] {
  const globs = sourceGlobs(stack);
  const hooks: KiroHook[] = [
    {
      path: ".kiro/hooks/aih-secret-scan-on-create.kiro.hook",
      hook: {
        version: "1.0.0",
        enabled: true,
        name: "aih-secret-scan-on-create",
        description: "Scan a newly created file for hardcoded secrets, keys, or credentials.",
        when: { type: "fileCreated", patterns: ["*"] },
        then: {
          type: "askAgent",
          prompt:
            "A new file was created. Scan it for hardcoded secrets, API keys, tokens, private keys, or credentials. Flag each with a secure alternative (read from the environment, never commit secrets).",
        },
      },
    },
    {
      path: ".kiro/hooks/aih-tests-on-edit.kiro.hook",
      hook: {
        version: "1.0.0",
        enabled: true,
        name: "aih-tests-on-edit",
        description: "When a source file is edited, ensure tests cover the change.",
        when: { type: "fileEdited", patterns: globs },
        then: {
          type: "askAgent",
          prompt: stack.verifyCommand
            ? `A source file was edited. Check that the modified behavior has test coverage; add missing tests and run \`${stack.verifyCommand}\` before completion.`
            : stack.testRunner
              ? `A source file was edited. Check that the modified behavior has test coverage; add missing tests and run \`${stack.testRunner}\` to verify.`
              : "A source file was edited. Check that the modified behavior has test coverage and suggest tests for anything new (no test command is configured in this repo yet).",
        },
      },
    },
  ];
  // Record a metrics sample on agent turn completion (verified `agentStop` event).
  // `aih track` captures a fuller snapshot (commits, LOC, adoption, branches) into
  // `.aih/history.jsonl`, which powers `aih report` trends — idempotent per commit.
  hooks.push({
    path: ".kiro/hooks/aih-metrics-on-stop.kiro.hook",
    hook: {
      version: "1.0.0",
      enabled: true,
      name: "aih-metrics-on-stop",
      description:
        "Record a metrics sample to .aih/history.jsonl when the agent finishes a turn (powers `aih report` trends). Fail-open: warns and skips the snapshot when `aih` is not on PATH.",
      when: { type: "agentStop" },
      // Kiro hook `timeout` is in SECONDS (default 60). agentStop is non-blocking, but a
      // stuck `aih` would still stall the turn until the default fires — cap it.
      timeout: 15,
      then: {
        type: "runCommand",
        command: metricsCommand(),
      },
    },
  });
  // A manual quality gate — only when the repo actually has commands to run.
  const gate = stack.verifyCommand
    ? [stack.verifyCommand]
    : [stack.lintCommand, stack.testRunner].filter((c): c is string => Boolean(c));
  if (gate.length > 0) {
    hooks.push({
      path: ".kiro/hooks/aih-quality-gate.kiro.hook",
      hook: {
        version: "1.0.0",
        enabled: true,
        name: "aih-quality-gate",
        description: "Run the repo's declared quality gate. Trigger manually from the Hooks panel.",
        when: { type: "userTriggered" },
        then: { type: "runCommand", command: gate.join(" && ") },
      },
    });
  }
  return hooks;
}

/** Stack-aware CLI-tool usage, as always-on Kiro steering. */
export function agentToolsSteering(stack: RepoStack): string {
  const stackTools: string[] = [];
  if (stack.verifyCommand) stackTools.push(`- \`${stack.verifyCommand}\` — completion gate.`);
  if (stack.typecheckCommand) stackTools.push(`- \`${stack.typecheckCommand}\` — typecheck.`);
  if (stack.testRunner) stackTools.push(`- \`${stack.testRunner}\` — run the tests.`);
  if (stack.lintCommand) stackTools.push(`- \`${stack.lintCommand}\` — lint before committing.`);
  if (stack.buildCommand) stackTools.push(`- \`${stack.buildCommand}\` — build.`);
  return kiroAlwaysSteering(
    lines(
      "# Agent tools",
      "",
      "Prefer these CLI tools for fast, precise, parseable work in this repo:",
      "",
      "- `rg` (ripgrep) — search; `rg --json` for structured matches, `rg -l` for file lists.",
      "- `fd` — fast file find by name/pattern.",
      "- `jq` — query/transform JSON (API responses, configs).",
      "- `git` — `git diff`/`log`/`blame` to ground every change in evidence.",
      "- `gh` — PRs, issues, and CI from the terminal.",
      ...(stackTools.length > 0 ? ["", "This repo's commands:", ...stackTools] : []),
      "",
      "Use structured/JSON output modes so results are parseable. If a tool is missing",
      "on a locked-down machine, fall back to the editor's search and say so — don't guess.",
    ),
  );
}

/** Superpowers methodology as always-on Kiro steering (Kiro can't read ~/.claude/superpowers). */
export function methodologySteering(): string {
  return kiroAlwaysSteering(
    lines(
      "# Superpowers methodology",
      "",
      "Kiro can't read `~/.claude/superpowers`, so this carries the same disciplined",
      "loop. Match the situation, follow the method:",
      "",
      "| Situation | Method |",
      "| --- | --- |",
      "| Fuzzy / open-ended problem | **Brainstorm** — diverge on 2–3 approaches, pressure-test against constraints, pick one. |",
      "| About to build a feature | **Plan first** — break into ordered, independently verifiable steps, a check per step. |",
      "| Writing code | **TDD** — write the failing test, make it pass, refactor. New behavior ships with a test. |",
      "| Fixing a bug | **Reproduce first** — a failing test that reproduces it, then fix to green. |",
      "| Risky or large change | **Subagent review** — an independent pass checks correctness + boundaries before committing. |",
      "| Done | **Report** ship / skipped / unverified — never claim done on unverified work. |",
      "",
      "Install Superpowers natively where supported with `aih superpowers --cli <tool>`.",
    ),
  );
}
