import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import type {
  FrameworkDescriptorBytesV1,
  FrameworkHostServicesV1,
  FrameworkOperationContextV1,
  PlanResult,
} from "@aihq/core/framework-host";

export const PINNED_COMMIT = "5064474d4d762dc9640234a41617cccb79185cec";

/**
 * SHA-256 of Catalog's `./catalog-framework-ecc.json` bytes this fixture holds
 * (brotli-compressed to keep the 9.3 MB descriptor out of the diff). Core's
 * descriptor loader accepts exactly these bytes, built at {@link PINNED_COMMIT}.
 */
export const CATALOG_DESCRIPTOR_SHA256 =
  "db4bb0b87e3fc5c9370ea6cb48cd4935a93f333c9ed927aab9fdd8eb8afcde84";

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

/**
 * Catalog's descriptor sections produced at {@link PINNED_COMMIT} (ECC v2.2.1),
 * copied byte for byte from the Catalog evidence (CQ3 profileEvidence, CQ1
 * hookControlInventory). Each file's SHA-256 is its serialized section digest.
 */
export const PINNED_SECTION_FIXTURES = Object.freeze({
  profileEvidence: Object.freeze({
    file: "ecc-profileEvidence-5064474d.json",
    sha256: "83d2d2bc26afeb991130142ecd1b4566645e82f1eddb1c1fd274bcb07dbbccbe",
  }),
  hookControlInventory: Object.freeze({
    file: "ecc-hookControlInventory-5064474d.json",
    sha256: "7be2521e351ad46e62695e989e62b9f829cd72c639670ed672f0cdc6c8b35e67",
  }),
});

/** The exact bytes of one pinned section fixture. */
export function pinnedSectionBytes(section: keyof typeof PINNED_SECTION_FIXTURES): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./fixtures/${PINNED_SECTION_FIXTURES[section].file}`, import.meta.url)),
  );
}

function pinnedSection(section: keyof typeof PINNED_SECTION_FIXTURES): unknown {
  return JSON.parse(new TextDecoder().decode(pinnedSectionBytes(section)));
}

/**
 * A descriptor holding only what exists at {@link PINNED_COMMIT}: the vendor
 * lock's pin and Catalog's two sections, unmodified. Sections Catalog has not
 * produced at this commit yet are absent, never carried over from the old pin.
 */
export function pinnedDescriptorDocument(): {
  format: string;
  version: number;
  frameworkId: string;
  sections: Record<string, unknown>;
} {
  return {
    format: "aih-catalog-framework-descriptor",
    version: 1,
    frameworkId: "ecc",
    sections: {
      vendorLock: { id: "ecc", owner: "affaan-m", repo: "ECC", pinnedSha: PINNED_COMMIT },
      hookControlInventory: pinnedSection("hookControlInventory"),
      profileEvidence: pinnedSection("profileEvidence"),
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
