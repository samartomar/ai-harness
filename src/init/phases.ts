import { command as bootstrapAi } from "../bootstrap-ai/index.js";
import { command as ecc } from "../ecc/index.js";
import { command as guardrails } from "../guardrails/index.js";
import type { CommandSpec } from "../internals/plan.js";
import { command as mcp } from "../mcp/index.js";
import { command as profile } from "../profile/index.js";
import { command as sandbox } from "../sandbox/index.js";
import { command as scaffold } from "../scaffold/index.js";
import { command as secrets } from "../secrets/index.js";
import { command as superpowers } from "../superpowers/index.js";

/**
 * One repo-scoped capability folded into `aih init`, paired with the human-facing
 * headline printed before its actions. `init` does not re-implement any of these —
 * it calls each `command.plan(ctx)` and concatenates the result, so the bootstrap
 * stays in lock-step with the leaf capabilities.
 */
export interface InitPhase {
  /** The leaf capability whose `plan(ctx)` supplies this phase's actions. */
  readonly command: CommandSpec;
  /** Short doc header emitted immediately before the phase's actions. */
  readonly headline: string;
}

/**
 * The fixed bootstrap order: profile → ecc → superpowers → bootstrap-ai →
 * scaffold → secrets → guardrails → mcp → sandbox. Profiling detects the stack
 * (Cursor rules); ECC + Superpowers install the agent baseline for the selected
 * CLIs; bootstrap-ai lays the Layer-2 canon (the SOLE writer of root bootloaders +
 * RULE_ROUTER); scaffolding lays the context dir the router points at; secrets +
 * guardrails fence the repo before MCP wiring and the sandbox land on top. Each
 * file has exactly one writer, so the composed plan dedupes to one write per path.
 */
export const INIT_PHASES: readonly InitPhase[] = [
  {
    command: profile,
    headline: "profile — detect the stack and synthesize CLAUDE.md + cursor rules",
  },
  {
    command: ecc,
    headline: "ecc — install affaan-m/ECC (skills, memory, security) for the stack + selected CLIs",
  },
  {
    command: superpowers,
    headline:
      "superpowers — install obra/Superpowers (brainstorm → plan → TDD → review) for the selected CLIs",
  },
  {
    command: bootstrapAi,
    headline:
      "bootstrap-ai — emit the Layer-2 ai-coding canon: RULE_ROUTER + per-CLI adapters + the root bootloaders",
  },
  {
    command: scaffold,
    headline:
      "scaffold — lay down the canonical context dir (INDEX/SKILL docs) the router points at",
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
    command: sandbox,
    headline: "sandbox — generate the devcontainer and managed sandbox policy",
  },
] as const;
