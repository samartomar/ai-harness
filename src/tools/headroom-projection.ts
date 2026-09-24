import type { PlanContext } from "../internals/plan.js";
import type { StdioServer } from "../mcp/servers.js";
import { headroomLayout, headroomMcpServer } from "./headroom.js";
import { type HeadroomReceiptState, readHeadroomReceipt } from "./headroom-receipt.js";

export interface HeadroomMcpCandidates {
  /** Present only for a current, valid activation that is not being deactivated. */
  readonly active?: StdioServer;
  /** The exact entry AIH last wrote (or would write); removed only when byte-identical. */
  readonly retired: StdioServer;
}

/**
 * Headroom's MCP registration follows its activation receipt, never selection
 * alone. A stale, invalid or deactivating record yields no active entry.
 */
export function headroomMcpCandidates(ctx: PlanContext): HeadroomMcpCandidates {
  const generated = headroomMcpServer(ctx);
  let receipt: HeadroomReceiptState;
  try {
    receipt = readHeadroomReceipt(headroomLayout(ctx));
  } catch (error) {
    receipt = { state: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  const recorded =
    receipt.state === "valid" || receipt.state === "stale"
      ? receipt.receipt.launcher.server
      : undefined;
  // The launcher itself refuses a receipt recorded for another platform.
  const active =
    receipt.state === "valid" && ctx.options.deactivateHeadroom !== true ? generated : undefined;
  return { ...(active === undefined ? {} : { active }), retired: recorded ?? generated };
}
