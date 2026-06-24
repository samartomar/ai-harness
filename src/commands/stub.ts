import { doc, type PlanFn, plan } from "../internals/plan.js";

/**
 * Foundation placeholder. Each capability ships a real CLI surface (name,
 * summary, options) from day one; the Workflow fan-out replaces this `plan` with
 * the real implementation. A pending plan emits a single `doc` action so the
 * command is runnable (and safe) before it is built out.
 */
export function pendingPlan(capability: string, note: string): PlanFn {
  return () => plan(capability, doc(`${capability} — implementation pending`, note));
}
