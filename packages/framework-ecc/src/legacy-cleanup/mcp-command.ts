import {
  type Cli,
  type Plan,
  type PlanContext,
  resolveClis,
  SettingsError,
} from "@aihq/core/framework-host";
import { planExplicitEccMcpRemove } from "../ecc/mcp-explicit-add.js";

export function legacyMcpRemoveRecord(input: {
  root: string;
  home?: string;
  id: string;
  target: string;
}): Plan {
  return planExplicitEccMcpRemove(input);
}

/** Public removal command retained for receipts written by earlier aih versions. */
export function legacyMcpRemovePlan(ctx: PlanContext): Plan {
  if (typeof ctx.options.id !== "string" || ctx.options.id.trim().length === 0)
    throw new SettingsError("ecc mcp remove requires an ECC MCP id");
  if (
    typeof ctx.options.cli !== "string" ||
    ctx.options.cli.trim().length === 0 ||
    ctx.options.allTools === true ||
    ctx.options.detect === true
  )
    throw new SettingsError("ecc mcp remove requires exactly one explicit --cli target");
  const targets: readonly Cli[] = resolveClis(ctx.options, { strict: true });
  const [target] = targets;
  if (targets.length !== 1 || target === undefined)
    throw new SettingsError("ecc mcp remove requires exactly one explicit --cli target");
  const home = ctx.env.HOME ?? ctx.env.USERPROFILE;
  return legacyMcpRemoveRecord({
    root: ctx.root,
    ...(home === undefined ? {} : { home }),
    id: ctx.options.id.trim(),
    target,
  });
}
