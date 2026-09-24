import { homedir } from "node:os";
import type {
  Check,
  FrameworkDoctorHookV1,
  FrameworkOperationContextV1,
} from "@aihq/core/framework-host";
import { readExplicitEccMcpReceiptStates } from "./ecc/mcp-explicit-add.js";
import { withEccInvocation } from "./invocation.js";

function safeProbeLabel(value: string): string {
  const safe = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-/ ";
  const label = [...value]
    .map((char) => (safe.includes(char) ? char : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return label.length > 0 ? label : "<unsafe>";
}

/**
 * `aih doctor`: the explicit ECC MCP receipt state. Local receipt and config
 * state only; endpoint reachability and tool surface are not checked.
 */
function explicitEccMcpReceiptChecks(ctx: FrameworkOperationContextV1): Check[] {
  const home = ctx.env.USERPROFILE || ctx.env.HOME || homedir();
  return readExplicitEccMcpReceiptStates({ root: ctx.root, home }).map((result) => {
    const identity =
      result.target !== undefined && result.id !== undefined
        ? `${safeProbeLabel(result.target)}/${safeProbeLabel(result.id)}`
        : "receipt";
    const noReceipt = result.state === "absent" && result.target === undefined;
    return {
      name: `explicit-ecc-mcp:${identity}`,
      verdict: result.state === "clean" ? "pass" : noReceipt ? "skip" : "fail",
      detail: `${result.state}: ${safeProbeLabel(result.detail)} — local receipt/config state only; endpoint reachability and tool surface were not checked`,
    };
  });
}

export const doctor: FrameworkDoctorHookV1 = Object.freeze({
  checks: (ctx: FrameworkOperationContextV1) =>
    withEccInvocation(ctx, async (): Promise<Check[]> => explicitEccMcpReceiptChecks(ctx)),
});
