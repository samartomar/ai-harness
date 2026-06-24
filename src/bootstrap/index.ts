import { command as certs } from "../certs/index.js";
import { command as hardware } from "../hardware/index.js";
import {
  type Action,
  type CommandSpec,
  doc,
  type Plan,
  type PlanContext,
  plan,
} from "../internals/plan.js";
import { command as telemetry } from "../telemetry/index.js";
import { command as vdi } from "../vdi/index.js";
import {
  mdmDistributionDoc,
  PHASES,
  type PhaseMeta,
  phaseHeader,
  ssoGatewayDoc,
} from "./phases.js";

/**
 * `aih bootstrap` — orchestrate the WORKSTATION rollout described by the
 * blueprint's "Project Delivery and Scaled Rollout Roadmap". It COMPOSES the
 * workstation-scoped capability plans rather than re-implementing them: each
 * phase emits a `doc` header (title + objective) followed by the concatenated
 * actions from `await cap.plan(ctx)` for that phase's capabilities.
 *
 * The cloud-only halves — Phase 3's Entra/Okta SSO MCP gateway and Phase 4's MDM
 * distribution — are doc-only guidance, so the orchestrator never crosses the
 * remote boundary; it only forwards whatever the leaf plans produced (which are
 * themselves write/exec/doc/probe, never remote).
 *
 * `--phase <n>` (1..4) narrows the run to a single phase; otherwise all four run
 * in blueprint order.
 */

/** Workstation capabilities `bootstrap` composes, keyed by their phase capability name. */
const SUBPLANS: Record<PhaseMeta["capabilities"][number], CommandSpec> = {
  certs,
  hardware,
  vdi,
  telemetry,
};

/** Run a single phase: its header, then the composed actions for its capabilities. */
async function phaseActions(meta: PhaseMeta, ctx: PlanContext): Promise<Action[]> {
  const actions: Action[] = [doc(meta.title, phaseHeader(meta))];

  for (const name of meta.capabilities) {
    const sub = await SUBPLANS[name].plan(ctx);
    actions.push(...sub.actions);
  }

  // Cloud milestones that have no workstation capability are appended as guidance.
  if (meta.id === "3") {
    actions.push(doc("Phase 3 — SSO MCP gateway (cloud, doc-only)", ssoGatewayDoc()));
  }
  if (meta.id === "4") {
    actions.push(doc("Phase 4 — MDM distribution (cloud, doc-only)", mdmDistributionDoc()));
  }

  return actions;
}

/** Resolve `--phase`: a present, in-range "1".."4" selects one phase; else all. */
function selectedPhases(options: Record<string, unknown>): readonly PhaseMeta[] {
  const raw = options.phase;
  if (raw === undefined || raw === null || raw === "") return PHASES;
  const want = String(raw).trim();
  const match = PHASES.find((p) => p.id === want);
  return match ? [match] : PHASES;
}

async function bootstrapPlan(ctx: PlanContext): Promise<Plan> {
  const phases = selectedPhases(ctx.options);
  const actions: Action[] = [];
  for (const meta of phases) {
    actions.push(...(await phaseActions(meta, ctx)));
  }
  return plan("bootstrap", ...actions);
}

export const command: CommandSpec = {
  name: "bootstrap",
  summary: "Bootstrap the workstation: 4-phase rollout (certs, hardware, vdi, telemetry)",
  options: [{ flags: "--phase <n>", description: "run a single phase (1-4) instead of all" }],
  plan: bootstrapPlan,
};
