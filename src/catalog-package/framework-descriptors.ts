import { createHash } from "node:crypto";
import { readVendorBaselineLock } from "../baseline-evidence/vendor.js";
import type { FrameworkIdV1 } from "../framework-plugin/contract-v1.js";
import type { CatalogPackageAccessV1, CatalogPackageRefusalV1 } from "./load-catalog-package.js";

/**
 * Framework descriptor bytes (C1): `./catalog-framework-<id>.json`, format
 * `aih-catalog-framework-descriptor`, version 1, `frameworkId`, `sections`.
 *
 * PHASE-1 STUB (worker W3). C1 assigns the real implementation to W1, which
 * reads these bytes from the INSTALLED Catalog through the one Catalog loader.
 * Until that lands, this module serves the same signature over Core's embedded
 * data so the Superpowers framework plugin can run end to end. It carries:
 *
 * - `vendorLock`: the `superpowers` source entry of Core's embedded vendor lock
 *   (the same section W1's Catalog generator emits);
 * - `hookControlInventory`: the Superpowers hook inventory recorded from the
 *   pinned v6.3.0 tree. Catalog does not publish this section for Superpowers
 *   yet; it must move to `catalog-framework-superpowers.json` with W1's
 *   implementation (shape: packages/framework-superpowers/README.md).
 *
 * `access` is accepted for signature compatibility and unused by the stub.
 */

export const FRAMEWORK_DESCRIPTOR_FORMAT_V1 = "aih-catalog-framework-descriptor";

export type FrameworkDescriptorLoadV1 =
  | {
      readonly ok: true;
      readonly frameworkId: FrameworkIdV1;
      readonly bytes: Uint8Array;
      readonly sha256: string;
      readonly catalogVersion?: string;
    }
  | { readonly ok: false; readonly refusal: CatalogPackageRefusalV1 };

const SUPERPOWERS_COMMIT = "b36e0829c6d0140e93cfef2ca599b1b07d4a7797";

/** The upstream hooks.json command, verbatim: `${CLAUDE_PLUGIN_ROOT}` is expanded by the host, not by aih. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal host-expanded variable recorded from the upstream file
const CLAUDE_SESSION_START_COMMAND = '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start';

/**
 * Every hook-declaring file inside the vetted `runtime:superpowers-plugin`
 * component of obra/Superpowers@b36e0829 (v6.3.0), with its SHA-256. The
 * component tree these files belong to matches the vendor lock's
 * `runtime:superpowers-plugin` treeSha256 (49d90d72054c…).
 */
const SUPERPOWERS_HOOK_CONTROL_INVENTORY_V1 = {
  provenance: {
    repository: "obra/Superpowers",
    commit: SUPERPOWERS_COMMIT,
    component: "runtime:superpowers-plugin",
    sources: [
      {
        path: ".cursor-plugin/plugin.json",
        sha256: "6bdbd1aba18726b9445196eb341313347870955cb15cdabf3e4b5cb1788af3cb",
      },
      {
        path: ".kimi-plugin/plugin.json",
        sha256: "847469c0c2b1f0cec8dedcce53f9ef14092d0138012d670d65a49e0de30d5031",
      },
      {
        path: ".opencode/plugins/superpowers.js",
        sha256: "a5c5e1dbb0abfbd6ec3322b724b9a7b3318bbbb3d83f9a661c56ae0ed0a3adb8",
      },
      {
        path: "hooks/hooks-cursor.json",
        sha256: "53d8ceb3ff5d8bb1c4f283f238cc868b8c1af22e40a3ac30f6d6e4173effefbd",
      },
      {
        path: "hooks/hooks.json",
        sha256: "47fd72cc8bedf31c72702b35b4ed7bab670294d658c4ce518330337525a3798b",
      },
      {
        path: "hooks/run-hook.cmd",
        sha256: "d3d9c6199678dab2858e60509dde5e7414f13c2a2b5e48a38b1d368b6e1d6abb",
      },
      {
        path: "hooks/session-start",
        sha256: "88a060272ca8047e0d1cd73a016e1cebba8396807a44be1e296d7c02dcbb9934",
      },
    ],
  },
  hooks: [
    {
      id: "hook:session-start",
      event: "SessionStart",
      summary:
        "Injects the full using-superpowers skill into the agent's context when a session starts, is cleared, or compacts.",
      declarations: [
        {
          host: "claude",
          sourcePath: "hooks/hooks.json",
          event: "SessionStart",
          matcher: "startup|clear|compact",
          command: CLAUDE_SESSION_START_COMMAND,
          execution: "process",
        },
        {
          host: "copilot",
          sourcePath: "hooks/hooks.json",
          event: "SessionStart",
          matcher: "startup|clear|compact",
          command: CLAUDE_SESSION_START_COMMAND,
          execution: "process",
        },
        {
          host: "antigravity",
          sourcePath: "hooks/hooks.json",
          event: "SessionStart",
          matcher: "startup|clear|compact",
          command: CLAUDE_SESSION_START_COMMAND,
          execution: "process",
        },
        {
          host: "cursor",
          sourcePath: "hooks/hooks-cursor.json",
          event: "sessionStart",
          command: "./hooks/run-hook.cmd session-start",
          execution: "process",
        },
        {
          host: "kimi",
          sourcePath: ".kimi-plugin/plugin.json",
          event: "sessionStart",
          execution: "declarative",
        },
        {
          host: "opencode",
          sourcePath: ".opencode/plugins/superpowers.js",
          event: "experimental.chat.messages.transform",
          execution: "in-process",
        },
      ],
      upstreamControl: { kind: "none" },
    },
  ],
} as const;

/** Sorted-key JSON with one trailing newline: the canonical descriptor byte form. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function superpowersDescriptor(): Uint8Array {
  const vendorLock = readVendorBaselineLock().sources.find((source) => source.id === "superpowers");
  if (vendorLock === undefined) throw new Error("embedded vendor lock has no superpowers source");
  const document = {
    format: FRAMEWORK_DESCRIPTOR_FORMAT_V1,
    version: 1,
    frameworkId: "superpowers",
    sections: { vendorLock, hookControlInventory: SUPERPOWERS_HOOK_CONTROL_INVENTORY_V1 },
  };
  return new TextEncoder().encode(`${canonical(document)}\n`);
}

/**
 * The C1 signature: the raw bytes of one framework descriptor, or a typed
 * Catalog refusal. Never throws.
 */
export async function loadFrameworkDescriptorBytesV1(
  frameworkId: FrameworkIdV1,
  _access?: CatalogPackageAccessV1,
): Promise<FrameworkDescriptorLoadV1> {
  if (frameworkId !== "superpowers") {
    return {
      ok: false,
      refusal: {
        reason: "catalog-package-incompatible",
        detail: `the phase-1 framework descriptor stub carries no ${frameworkId} descriptor; it is published by @aihq/catalog as ./catalog-framework-${frameworkId}.json`,
      },
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = superpowersDescriptor();
  } catch (error) {
    return {
      ok: false,
      refusal: {
        reason: "catalog-package-incompatible",
        detail: `the embedded superpowers descriptor could not be assembled (${(error as Error).message})`,
      },
    };
  }
  return {
    ok: true,
    frameworkId,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
