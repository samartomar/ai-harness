import { type EnvBlockAction, envBlock, type PlanContext } from "../internals/plan.js";
import { otelEnvVars } from "./templates.js";

/** aih-managed region scope for the telemetry env block. */
export const TELEMETRY_SCOPE = "telemetry";

/**
 * Build the env-block action that injects the OTel vars into the host shell
 * profile. Emitted as an `envblock` (not a plain write) so it COMPOSES with the
 * other workstation blocks (certs/hardware/vdi) when `bootstrap` targets the same
 * profile — the executor folds each scope in rather than clobbering. Idempotent:
 * re-running replaces only the managed `telemetry` region.
 */
export function buildProfileWrite(ctx: PlanContext, endpoint: string): EnvBlockAction {
  const profilePath = ctx.host.shellProfilePaths()[0] ?? "";
  const shell = ctx.host.envShell();
  return envBlock(
    profilePath,
    TELEMETRY_SCOPE,
    shell,
    otelEnvVars(endpoint),
    `Inject the aih-managed OTEL_* telemetry block into ${profilePath}`,
  );
}
