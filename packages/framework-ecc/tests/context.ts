import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import type {
  FrameworkDescriptorBytesV1,
  FrameworkHostServicesV1,
  FrameworkOperationContextV1,
  PlanResult,
} from "@aihq/core/framework-host";

export const PINNED_COMMIT = "5caf398a91599029a176ca6d806409b00d1052c4";

/**
 * SHA-256 of Catalog's `./catalog-framework-ecc.json` bytes this fixture holds
 * (brotli-compressed to keep the 9.3 MB descriptor out of the diff). Core's
 * descriptor loader accepts exactly these bytes.
 */
export const CATALOG_DESCRIPTOR_SHA256 =
  "cc723716e8749862d8e76769a0475d6e788c31c711d98c94e2c9c47695861f47";

let cached: Uint8Array | undefined;

/** The exact descriptor bytes Catalog publishes for ECC (C1 format). */
export function fixtureDescriptorBytes(): Uint8Array {
  cached ??= new Uint8Array(
    brotliDecompressSync(
      readFileSync(new URL("./fixtures/catalog-framework-ecc.json.br", import.meta.url)),
    ),
  );
  return cached;
}

export function fixtureDescriptorDocument(): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fixtureDescriptorBytes())) as Record<string, unknown>;
}

export function descriptorOf(bytes: Uint8Array): FrameworkDescriptorBytesV1 {
  return {
    frameworkId: "ecc",
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

/** Host services for read-only operations: no runtime, no effects. */
export function readOnlyHost(): FrameworkHostServicesV1 {
  return {
    runEvidenceGatedInstall: async () => {
      throw new Error("read-only test host");
    },
    executePlan: async () => EMPTY_RESULT,
    progress: () => undefined,
  };
}

export function operationContext(
  over: Partial<FrameworkOperationContextV1> = {},
): FrameworkOperationContextV1 {
  return {
    frameworkId: "ecc",
    root: "/repo",
    targets: ["claude"],
    mode: { apply: false, verify: true },
    descriptor: descriptorOf(fixtureDescriptorBytes()),
    policy: { posture: "vibe", hookControls: { disabled: [] } },
    options: {},
    env: {},
    host: readOnlyHost(),
    ...over,
  };
}
