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

export const PINNED_COMMIT = "5bf4e78011075bcfc0dc295f0724994cd123ee71";

/**
 * The exact descriptor bytes Core serves for Superpowers (C1 format). They pin
 * the previous Superpowers commit until Core adopts the Catalog built at
 * {@link PINNED_COMMIT}; tests that read them refuse with the commit mismatch
 * until then.
 */
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

/**
 * Catalog's full Superpowers descriptor, component list included. It pins the
 * previous commit, so reading it refuses with the commit mismatch until Core
 * adopts the Catalog built at {@link PINNED_COMMIT}.
 */
export function catalogDescriptor(): FrameworkDescriptorBytesV1 {
  return descriptorOf(fixtureDescriptorBytes());
}

export function descriptorFromDocument(document: unknown): FrameworkDescriptorBytesV1 {
  return descriptorOf(new TextEncoder().encode(`${JSON.stringify(document)}\n`));
}

/**
 * Catalog's hookControlInventory section produced at {@link PINNED_COMMIT}
 * (Superpowers v6.4.1), copied byte for byte from the Catalog evidence (CQ2).
 * The file's SHA-256 is the serialized section digest.
 */
export const PINNED_SECTION_FIXTURE = Object.freeze({
  file: "superpowers-hookControlInventory-5bf4e780.json",
  sha256: "ec0866b7bb635885a89c09b9bde198100e8c8fafa8addaa4774183df92f932f5",
});

/** The exact bytes of the pinned hookControlInventory section. */
export function pinnedSectionBytes(): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./fixtures/${PINNED_SECTION_FIXTURE.file}`, import.meta.url)),
  );
}

/**
 * A descriptor holding only what exists at {@link PINNED_COMMIT}: Catalog's
 * hookControlInventory section, unmodified, and a vendor lock carrying the pin
 * and the one component that section's provenance names. Catalog has not
 * produced a vendor lock at this commit yet, so the component's paths are the
 * top-level roots of the section's own recorded sources, never the old pin's
 * component list.
 */
export function pinnedDescriptorDocument(): {
  format: string;
  version: number;
  frameworkId: string;
  sections: { vendorLock: Record<string, unknown>; hookControlInventory: Record<string, unknown> };
} {
  const inventory = JSON.parse(new TextDecoder().decode(pinnedSectionBytes())) as {
    provenance: { component: string; sources: Array<{ path: string }> };
  };
  const roots = [
    ...new Set(inventory.provenance.sources.map((source) => source.path.split("/")[0] ?? "")),
  ];
  return {
    format: "aih-catalog-framework-descriptor",
    version: 1,
    frameworkId: "superpowers",
    sections: {
      vendorLock: {
        id: "superpowers",
        owner: "obra",
        repo: "Superpowers",
        pinnedSha: PINNED_COMMIT,
        components: [{ id: inventory.provenance.component, paths: roots }],
      },
      hookControlInventory: inventory as unknown as Record<string, unknown>,
    },
  };
}

export function pinnedDescriptor(): FrameworkDescriptorBytesV1 {
  return descriptorFromDocument(pinnedDescriptorDocument());
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
    descriptor: pinnedDescriptor(),
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
