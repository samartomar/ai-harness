import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  FrameworkDescriptorBytesV1,
  FrameworkEvidenceAuthorizationV1,
  FrameworkEvidenceGatedInstallRequestV1,
  FrameworkHostServicesV1,
  FrameworkOperationContextV1,
  Plan,
  PlanResult,
} from "@aihq/core/framework-host";

export const PINNED_COMMIT = "b36e0829c6d0140e93cfef2ca599b1b07d4a7797";

/** The exact descriptor bytes Core serves for Superpowers (C1 format). */
export function fixtureDescriptorBytes(): Uint8Array {
  return readFileSync(new URL("./fixtures/catalog-framework-superpowers.json", import.meta.url));
}

export function fixtureDescriptorDocument(): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fixtureDescriptorBytes())) as Record<string, unknown>;
}

export function descriptorOf(bytes: Uint8Array): FrameworkDescriptorBytesV1 {
  return {
    frameworkId: "superpowers",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function descriptorFromDocument(document: unknown): FrameworkDescriptorBytesV1 {
  return descriptorOf(new TextEncoder().encode(`${JSON.stringify(document)}\n`));
}

export const EMPTY_RESULT: PlanResult = {
  capability: "host",
  applied: false,
  writes: [],
  docs: [],
  probes: [],
  execs: [],
  digests: [],
  backups: [],
  removed: [],
};

export interface RecordingHost extends FrameworkHostServicesV1 {
  readonly requests: FrameworkEvidenceGatedInstallRequestV1[];
  readonly executed: Plan[];
  readonly progressLines: string[];
}

export function recordingHost(): RecordingHost {
  const requests: FrameworkEvidenceGatedInstallRequestV1[] = [];
  const executed: Plan[] = [];
  const progressLines: string[] = [];
  return {
    requests,
    executed,
    progressLines,
    runEvidenceGatedInstall: async (request) => {
      requests.push(request);
      return EMPTY_RESULT;
    },
    executePlan: async (plan) => {
      executed.push(plan);
      return EMPTY_RESULT;
    },
    progress: (message) => {
      progressLines.push(message);
    },
  };
}

export function operationContext(
  over: Partial<FrameworkOperationContextV1> = {},
): FrameworkOperationContextV1 & { host: RecordingHost } {
  const host = recordingHost();
  return {
    frameworkId: "superpowers",
    root: "/repo",
    targets: ["claude"],
    mode: { apply: false, verify: true },
    descriptor: descriptorOf(fixtureDescriptorBytes()),
    policy: { posture: "vibe", hookControls: { disabled: [] } },
    options: {},
    env: {},
    host,
    ...over,
  } as FrameworkOperationContextV1 & { host: RecordingHost };
}

export function authorization(
  componentId: string,
  pinnedSha = "a".repeat(40),
): FrameworkEvidenceAuthorizationV1 {
  return {
    componentId,
    source: "obra/Superpowers",
    pinnedSha,
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/core release",
    evidenceSha256: "c".repeat(64),
  };
}
