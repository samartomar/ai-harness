import { createHash } from "node:crypto";
import { z } from "zod";
import { ECC_INSTALL_TARGETS } from "../ecc/install-targets.js";
import type { BaselineCatalog, BaselineCatalogComponent } from "./catalog.js";
import {
  assertPreviewGeneratorDependenciesCovered,
  GENERATOR_ENTRY_PATHS,
} from "./ecc-preview-boundary.js";
import { hashSourceTree } from "./hash.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const PREFLIGHT_SCHEMA_VERSION = 1;
// Bump when the lexical closure algorithm or its refusal semantics change.
const DEPENDENCY_CLOSURE_IMPLEMENTATION_VERSION = 1;

const PreflightCheckSchema = z
  .object({
    id: z.literal("preview-generator-dependency-closure"),
    version: z.string().regex(SHA256),
  })
  .strict();

const EccPreflightReceiptSchema = z
  .object({
    schemaVersion: z.literal(PREFLIGHT_SCHEMA_VERSION),
    source: z
      .object({
        id: z.literal("ecc"),
        owner: z.string().trim().min(1).max(200),
        repo: z.string().trim().min(1).max(200),
        pinnedSha: z.string().regex(GIT_SHA),
        sourceTreeSha256: z.string().regex(SHA256),
      })
      .strict(),
    runtime: z
      .object({
        componentId: z.literal("runtime:ecc-installer"),
        paths: z.array(z.string().trim().min(1).max(2_000)).min(1),
      })
      .strict(),
    checks: z.array(PreflightCheckSchema).length(1),
  })
  .strict();

export type EccPreflightReceipt = z.infer<typeof EccPreflightReceiptSchema>;

function stableSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function runtimeComponent(catalog: BaselineCatalog): BaselineCatalogComponent {
  if (catalog.id !== "ecc") throw new Error("ECC preflight receipt requires the ECC catalog");
  const runtime = catalog.components.find((component) => component.id === "runtime:ecc-installer");
  if (runtime === undefined) {
    throw new Error("ECC preflight receipt requires runtime:ecc-installer catalog paths");
  }
  return runtime;
}

/**
 * The receipt intentionally carries only the generator runtime's ordered paths.
 * Its check version also binds the complete ordered catalog shape, preventing a
 * shard (which omits components) from minting a receipt that a full assembly
 * accepts, without serializing the entire catalog into a transport artifact.
 */
function staticCheckVersion(
  id: EccPreflightReceipt["checks"][number]["id"],
  catalog: BaselineCatalog,
  runtime: BaselineCatalogComponent,
): string {
  return stableSha256({
    id,
    implementationVersion: DEPENDENCY_CLOSURE_IMPLEMENTATION_VERSION,
    generatorEntryPaths: GENERATOR_ENTRY_PATHS,
    installTargets: ECC_INSTALL_TARGETS,
    runtime: { componentId: runtime.id, paths: runtime.paths },
    catalogComponents: catalog.components.map((component) => ({
      id: component.id,
      paths: component.paths,
    })),
  });
}

function expectedChecks(catalog: BaselineCatalog, runtime: BaselineCatalogComponent) {
  return [
    {
      id: "preview-generator-dependency-closure" as const,
      version: staticCheckVersion("preview-generator-dependency-closure", catalog, runtime),
    },
  ];
}

function sourceTreeSha256(eccRoot: string, operation: "create" | "verify"): string {
  try {
    return hashSourceTree(eccRoot).treeSha256;
  } catch {
    throw new Error(`ECC preflight receipt cannot ${operation}: source tree is unavailable`);
  }
}

function assertStaticGeneratorClosure(eccRoot: string, runtime: BaselineCatalogComponent): void {
  try {
    assertPreviewGeneratorDependenciesCovered(eccRoot, runtime.paths);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (
      /^(preview generator dependency (is outside runtime:ecc-installer|is not a regular file):|dynamic (import|import\(\)|require|require\.resolve) is forbidden in preview generator dependency )/.test(
        detail,
      ) &&
      !detail.includes(eccRoot)
    ) {
      throw new Error(`ECC static preflight dependency closure failed: ${detail}`);
    }
    if (detail.startsWith("unvetted package import ")) {
      throw new Error("ECC static preflight dependency closure failed: unvetted package import");
    }
    if (detail.startsWith("could not resolve preview generator dependency ")) {
      throw new Error(
        "ECC static preflight dependency closure failed: relative dependency could not be resolved",
      );
    }
    // This boundary only reports the static contract failure. It must not leak a
    // checkout path, source bytes, or a platform-specific filesystem diagnostic.
    throw new Error("ECC static preflight dependency closure is invalid");
  }
}

export function parseEccPreflightReceipt(value: unknown): EccPreflightReceipt {
  try {
    return EccPreflightReceiptSchema.parse(value);
  } catch {
    throw new Error("invalid ECC preflight receipt");
  }
}

/**
 * Inspect the pinned checkout lexically and issue a transport-safe receipt.
 * It never loads an upstream module: the only generator check is the static
 * literal-dependency closure rooted at GENERATOR_ENTRY_PATHS.
 */
export function buildEccPreflightReceipt(input: {
  eccRoot: string;
  catalog: BaselineCatalog;
}): EccPreflightReceipt {
  const runtime = runtimeComponent(input.catalog);
  const before = sourceTreeSha256(input.eccRoot, "create");
  assertStaticGeneratorClosure(input.eccRoot, runtime);
  const after = sourceTreeSha256(input.eccRoot, "create");
  if (after !== before) {
    throw new Error("ECC static preflight source tree changed during dependency closure");
  }
  return parseEccPreflightReceipt({
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    source: {
      id: input.catalog.id,
      owner: input.catalog.owner,
      repo: input.catalog.repo,
      pinnedSha: input.catalog.pinnedSha,
      sourceTreeSha256: after,
    },
    runtime: { componentId: runtime.id, paths: runtime.paths },
    checks: expectedChecks(input.catalog, runtime),
  });
}

/**
 * Refuse a stale, forged, or sharded receipt before it seeds a shard or fan-in.
 * Receipt verification is orchestration-only; it never replaces the final
 * authorized preview boundary's own static check.
 */
export function assertEccPreflightReceipt(input: {
  eccRoot: string;
  catalog: BaselineCatalog;
  receipt: unknown;
}): EccPreflightReceipt {
  const receipt = parseEccPreflightReceipt(input.receipt);
  const runtime = runtimeComponent(input.catalog);
  if (
    receipt.source.id !== input.catalog.id ||
    receipt.source.owner !== input.catalog.owner ||
    receipt.source.repo !== input.catalog.repo ||
    receipt.source.pinnedSha !== input.catalog.pinnedSha
  ) {
    throw new Error("ECC preflight receipt is not bound to the active catalog pin");
  }
  if (JSON.stringify(receipt.runtime.paths) !== JSON.stringify(runtime.paths)) {
    throw new Error("ECC preflight receipt runtime paths do not match the active catalog");
  }
  if (JSON.stringify(receipt.checks) !== JSON.stringify(expectedChecks(input.catalog, runtime))) {
    throw new Error("ECC preflight receipt checks do not match the active static contract");
  }
  if (receipt.source.sourceTreeSha256 !== sourceTreeSha256(input.eccRoot, "verify")) {
    throw new Error("ECC preflight receipt source tree does not match the pinned checkout");
  }
  return receipt;
}
