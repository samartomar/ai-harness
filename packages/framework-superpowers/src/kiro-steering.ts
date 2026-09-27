import { frontmatter, lines } from "@aihq/core/framework-host";

/**
 * Superpowers methodology as always-on Kiro steering. Kiro cannot read
 * `~/.claude/superpowers`, so aih writes this first-party bridge; it is aih's
 * own text, never labelled as obra/Superpowers vendor evidence.
 */
export function methodologySteering(): string {
  return `${frontmatter({ inclusion: "always" })}\n\n${lines(
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
  )}`;
}
