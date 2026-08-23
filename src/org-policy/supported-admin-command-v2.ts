import type { CommandSpec } from "../internals/plan.js";
import {
  supportedCustodyAcceptPlanV2,
  supportedCustodyInspectPlanV2,
} from "./supported-admin-v2.js";

export const policySupportedAcceptCommandV2: CommandSpec = {
  name: "accept",
  summary: "Verify and durably custody one externally attested AIH-supported decision",
  zeroWrite: true,
  requireExplicitApply: true,
  options: [
    { flags: "--decision <id>", description: "exact externally verified governance decision id" },
    {
      flags: "--decision-digest <sha256>",
      description: "exact externally verified governance decision digest",
    },
    { flags: "--target <id>", description: "code-owned supported CLI target" },
  ],
  plan: supportedCustodyAcceptPlanV2,
};

export const policySupportedInspectCommandV2: CommandSpec = {
  name: "inspect",
  summary: "Read the bounded, scrubbed current AIH-supported custody state",
  readOnly: true,
  zeroWrite: true,
  plan: supportedCustodyInspectPlanV2,
};
