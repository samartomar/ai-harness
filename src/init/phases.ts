import { command as bootstrapAi } from "../bootstrap-ai/index.js";
import { command as contract } from "../contract/index.js";
import { command as superpowers } from "../framework-plugin/superpowers-command.js";
import { command as guardrails } from "../guardrails/index.js";
import type { CommandSpec } from "../internals/plan.js";
import { command as mcp } from "../mcp/index.js";
import { command as profile } from "../profile/index.js";
import { command as sandbox } from "../sandbox/index.js";
import { command as scaffold } from "../scaffold/index.js";
import { command as secrets } from "../secrets/index.js";
import { command as usage } from "../usage/index.js";

/**
 * One repo-scoped capability folded into `aih init`, paired with the human-facing
 * headline printed before its actions. `init` does not re-implement any of these —
 * it calls each `command.plan(ctx)` and concatenates the result, so the bootstrap
 * stays in lock-step with the leaf capabilities.
 */
export interface InitPhase {
  /**
   * The leaf capability whose `plan(ctx)` supplies this phase's actions (for a
   * framework phase: the command whose evidence-gated executor init runs).
   */
  readonly command: CommandSpec;
  /** Short doc header emitted immediately before the phase's actions. */
  readonly headline: string;
  /**
   * Set for a framework phase: init emits its header in order but runs that
   * framework plugin's evidence-gated command after the local bootstrap commits,
   * because an evidence gate executes (acquire, verify, then plan) and cannot be
   * folded into init's one composed plan.
   */
  readonly framework?: "superpowers";
}

/**
 * The fixed bootstrap order: profile → superpowers → bootstrap-ai → scaffold →
 * secrets → guardrails → mcp → contract → sandbox → usage. Profiling detects the stack
 * (Cursor rules); Superpowers (through @aihq/framework-superpowers, evidence-gated) emits
 * the default ECC-adjacent agent baseline guidance for the selected CLIs; bootstrap-ai lays the Layer-2 canon (the SOLE writer of root bootloaders +
 * RULE_ROUTER); scaffolding lays the context dir the router points at; secrets +
 * guardrails fence the repo before MCP wiring lands on top; contract runs AFTER mcp so
 * first-run synthesis sees the planned `.mcp.json` surface (init threads it via
 * `ctx.plannedMcpServers` — disk alone would say "none" until a second run); the sandbox
 * and usage recorder land last. Each
 * file has exactly one writer, so the composed plan dedupes to one write per path.
 *
 * ECC is deliberately NOT a phase: `aih ecc` runs ECC's own network installer
 * (`npx ecc-install` / a git checkout), so it stays a separate gated step rather
 * than something `aih init --apply` runs silently. `initPlan` points at it.
 */
export const INIT_PHASES: readonly InitPhase[] = [
  {
    command: profile,
    headline: "profile — detect the stack and synthesize CLAUDE.md + cursor rules",
  },
  {
    command: superpowers,
    headline:
      "superpowers — verify exact-pinned obra/Superpowers (brainstorm → plan → TDD → review) and emit evidence-bound guidance for the selected CLIs, through @aihq/framework-superpowers after the local bootstrap",
    framework: "superpowers",
  },
  {
    command: bootstrapAi,
    headline:
      "bootstrap-ai — emit the Layer-2 ai-coding canon: RULE_ROUTER + per-CLI adapters + the root bootloaders",
  },
  {
    command: scaffold,
    headline:
      "scaffold — lay down repo hygiene + local guardrails (and, under --canon legacy, the full doc family)",
  },
  {
    command: secrets,
    headline: "secrets — deny agent reads of plaintext secrets and document vault injection",
  },
  {
    command: guardrails,
    headline: "guardrails — gitleaks + pre-commit gate and the CI license-compliance workflow",
  },
  {
    command: mcp,
    headline: "mcp — configure enterprise MCP servers in .mcp.json",
  },
  {
    command: contract,
    headline:
      "contract — synthesize the repo contract the router points at: project.json + project.md + setup.md",
  },
  {
    command: sandbox,
    headline: "sandbox — generate the devcontainer and managed sandbox policy",
  },
  {
    command: usage,
    headline:
      "usage — install the local usage recorder last so hooks merge with the finished settings policy",
  },
] as const;
