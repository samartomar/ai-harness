import { readAihConfig } from "../config/marker.js";
import { SettingsError } from "../errors.js";
import type { PlanContext } from "../internals/plan.js";

export type KiroHookRuntime = "ide1-cli3" | "cli2" | "unknown";

export function explicitKiroHookRuntime(
  ctx: PlanContext,
): Exclude<KiroHookRuntime, "unknown"> | undefined {
  const explicit = ctx.options.kiroHookRuntime;
  if (explicit === undefined) return undefined;
  if (explicit === "ide1-cli3" || explicit === "cli2") return explicit;
  throw new SettingsError("invalid --kiro-hook-runtime: expected ide1-cli3 or cli2");
}

/**
 * Standalone Kiro v1 hooks are shared by IDE 1.x and CLI 3.x. CLI 2.x keeps
 * hooks inside custom-agent configuration, which AIH never mutates. A file on
 * disk cannot prove which runtime will load it, so only an explicit capability
 * selection (from this run or the committed marker) enables generation and
 * health claims.
 */
export function kiroHookRuntime(ctx: PlanContext): KiroHookRuntime {
  return explicitKiroHookRuntime(ctx) ?? readAihConfig(ctx.root)?.kiroHookRuntime ?? "unknown";
}

export function supportsKiroStandaloneHooks(ctx: PlanContext): boolean {
  return kiroHookRuntime(ctx) === "ide1-cli3";
}

export const KIRO_HOOK_RUNTIME_OPTION = {
  flags: "--kiro-hook-runtime <runtime>",
  description:
    "Kiro hook runtime: ide1-cli3 (standalone v1 JSON) | cli2 (advisory only; persisted when a bootstrap marker exists)",
} as const;
