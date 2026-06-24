import { upsertManagedBlock } from "../internals/envfile.js";
import { readIfExists } from "../internals/fsxn.js";
import type { PlanContext, WriteAction } from "../internals/plan.js";
import { writeText } from "../internals/plan.js";
import { otelEnvVars } from "./templates.js";

/** aih-managed region scope for the telemetry env block. */
export const TELEMETRY_SCOPE = "telemetry";

/**
 * Build the write that injects the OTel env block into the host shell profile.
 *
 * Idempotent by construction: the existing profile is read, the managed
 * `telemetry` region is replaced wholesale (lines outside it are preserved), and
 * the absolute profile path is emitted so the executor writes it in place rather
 * than under the repo root. Re-planning over an already-stamped profile yields a
 * byte-identical block.
 */
export function buildProfileWrite(ctx: PlanContext, endpoint: string): WriteAction {
  const profilePath = ctx.host.shellProfilePaths()[0] ?? "";
  const shell = ctx.host.envShell();
  const existing = readIfExists(profilePath) ?? "";
  const next = upsertManagedBlock(existing, TELEMETRY_SCOPE, otelEnvVars(endpoint), shell);
  return writeText(
    profilePath,
    next,
    `Inject the aih-managed OTEL_* telemetry block into ${profilePath}`,
  );
}
