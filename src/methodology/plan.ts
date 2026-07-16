import { createHash } from "node:crypto";
import type { InertProviderDiscovery } from "./discover.js";

export interface ProposedMethodologyPlan {
  sourceTreeSha256: string;
  installerEntries: readonly string[];
  impacts: {
    writes: "unknown";
    processes: "unknown";
    services: "unknown";
    network: "unknown";
    updater: "unknown";
    runtime: "unknown";
    uninstall: "unknown";
  };
  providerCodeExecuted: false;
  digest: string;
}

export function createProposedPlan(input: {
  discovery: InertProviderDiscovery;
  sourceTreeSha256: string;
}): ProposedMethodologyPlan {
  const plan = {
    sourceTreeSha256: input.sourceTreeSha256,
    installerEntries: [...input.discovery.installerEntries].sort((a, b) => a.localeCompare(b)),
    impacts: {
      writes: "unknown" as const,
      processes: "unknown" as const,
      services: "unknown" as const,
      network: "unknown" as const,
      updater: "unknown" as const,
      runtime: "unknown" as const,
      uninstall: "unknown" as const,
    },
    providerCodeExecuted: false as const,
  };
  return {
    ...plan,
    digest: createHash("sha256").update(JSON.stringify(plan), "utf8").digest("hex"),
  };
}
