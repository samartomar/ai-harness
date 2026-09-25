import { createHash } from "node:crypto";
import { z } from "zod";
import { parseNativeStrictJsonObjectV1 } from "../contract/native-strict-json-object-v1.js";
import {
  FRAMEWORK_IDS_V1,
  FRAMEWORK_PLUGIN_PACKAGE_NAMES,
  type FrameworkIdV1,
} from "../framework-plugin/contract-v1.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import {
  CATALOG_PACKAGE_INSTALL_COMMAND,
  CATALOG_PACKAGE_NAME,
  CATALOG_PACKAGE_PROJECT_INSTALL_COMMAND,
  type CatalogPackageAccessV1,
  type CatalogPackageRefusalV1,
  loadCatalogPackageV1,
} from "./load-catalog-package.js";

/**
 * Framework plugin identities Catalog describes (C1 `./catalog-framework-plugins.json`).
 *
 * Catalog DESCRIBES which plugin package version belongs to which framework and
 * upstream; it never authorizes execution. Core accepts these bytes only after
 * validating them against this Core-owned schema, and the framework plugin
 * loader then requires the installed plugin to equal its record.
 */

export const CATALOG_FRAMEWORK_PLUGINS_SUBPATH_V1 = "./catalog-framework-plugins.json";
export const CATALOG_FRAMEWORK_PLUGINS_FORMAT_V1 = "aih-catalog-framework-plugins";
export const MAX_CATALOG_FRAMEWORK_PLUGINS_BYTES_V1 = 64 * 1024;

const SupportedHostSchema = z.enum(SUPPORTED_CLIS);

const FrameworkPluginIdentitySchema = z
  .object({
    frameworkId: z.enum(FRAMEWORK_IDS_V1 as [FrameworkIdV1, ...FrameworkIdV1[]]),
    packageName: z.string().min(1).max(214),
    version: z
      .string()
      .max(64)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "must be an exact semantic version"),
    contractVersion: z.number().int().min(1).max(1_000),
    upstream: z
      .object({
        repository: z
          .string()
          .max(200)
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be owner/repo"),
        commit: z.string().regex(/^[0-9a-f]{40}$/, "must be a full lowercase commit SHA"),
      })
      .strict(),
    supportedCore: z.string().min(1).max(100),
    supportedHosts: z
      .array(SupportedHostSchema)
      .min(1)
      .max(SUPPORTED_CLIS.length)
      .refine((hosts) => new Set(hosts).size === hosts.length, "hosts must be unique"),
    status: z
      .string()
      .max(40)
      .regex(/^[a-z][a-z-]*$/, "must be a lowercase status word"),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const expected = FRAMEWORK_PLUGIN_PACKAGE_NAMES[entry.frameworkId];
    if (entry.packageName !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["packageName"],
        message: `framework ${entry.frameworkId} must name ${expected}`,
      });
    }
  });

const FrameworkPluginsDocumentSchema = z
  .object({
    format: z.literal(CATALOG_FRAMEWORK_PLUGINS_FORMAT_V1),
    version: z.literal(1),
    entries: z
      .array(FrameworkPluginIdentitySchema)
      .min(1)
      .max(FRAMEWORK_IDS_V1.length)
      .superRefine((entries, ctx) => {
        const seen = new Set<string>();
        for (const [index, entry] of entries.entries()) {
          if (seen.has(entry.frameworkId)) {
            ctx.addIssue({
              code: "custom",
              path: [index, "frameworkId"],
              message: `duplicate framework ${entry.frameworkId}`,
            });
          }
          seen.add(entry.frameworkId);
        }
      }),
  })
  .strict();

export type CatalogFrameworkPluginIdentityV1 = z.infer<typeof FrameworkPluginIdentitySchema>;

export type CatalogFrameworkPluginIdentitiesLoadV1 =
  | {
      readonly ok: true;
      readonly catalogVersion: string | undefined;
      /** Lowercase SHA-256 of the exact bytes Catalog published. */
      readonly sha256: string;
      readonly entries: readonly CatalogFrameworkPluginIdentityV1[];
    }
  | { readonly ok: false; readonly refusal: CatalogPackageRefusalV1 };

const INSTALL_ADVICE = `Install a compatible Catalog with: ${CATALOG_PACKAGE_INSTALL_COMMAND} (in a project: ${CATALOG_PACKAGE_PROJECT_INSTALL_COMMAND}).`;

function incompatible(detail: string): CatalogPackageRefusalV1 {
  return {
    reason: "catalog-package-incompatible",
    detail: `the installed ${CATALOG_PACKAGE_NAME} ${CATALOG_FRAMEWORK_PLUGINS_SUBPATH_V1} ${detail}. ${INSTALL_ADVICE}`,
  };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "is not a framework plugin identity document";
  const where = issue.path.length === 0 ? "the document" : issue.path.join(".");
  return `is invalid at ${where}: ${issue.message}`;
}

/** Validate framework plugin identity bytes against Core's schema. Never throws. */
export function parseFrameworkPluginIdentitiesV1(
  bytes: Uint8Array,
):
  | { readonly ok: true; readonly entries: readonly CatalogFrameworkPluginIdentityV1[] }
  | { readonly ok: false; readonly detail: string } {
  if (bytes.byteLength > MAX_CATALOG_FRAMEWORK_PLUGINS_BYTES_V1) {
    return { ok: false, detail: `exceeds ${MAX_CATALOG_FRAMEWORK_PLUGINS_BYTES_V1} bytes` };
  }
  let document: Record<string, unknown>;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    document = parseNativeStrictJsonObjectV1(text, "framework plugin identities");
  } catch (error) {
    return { ok: false, detail: `is not strict JSON (${(error as Error).message})` };
  }
  const parsed = FrameworkPluginsDocumentSchema.safeParse(document);
  if (!parsed.success) return { ok: false, detail: firstIssue(parsed.error) };
  return {
    ok: true,
    entries: Object.freeze(parsed.data.entries.map((entry) => Object.freeze(entry))),
  };
}

/**
 * Read the installed Catalog's framework plugin identities. `catalog-package-unavailable`
 * means Catalog is not installed (callers skip the identity comparison); every
 * other failure is `catalog-package-incompatible` and must be surfaced.
 */
export async function loadFrameworkPluginIdentitiesV1(
  access?: CatalogPackageAccessV1,
): Promise<CatalogFrameworkPluginIdentitiesLoadV1> {
  const loaded = await loadCatalogPackageV1([], [CATALOG_FRAMEWORK_PLUGINS_SUBPATH_V1], access);
  if (!loaded.ok) return { ok: false, refusal: loaded.refusal };
  const file = loaded.files[CATALOG_FRAMEWORK_PLUGINS_SUBPATH_V1];
  const parsed = parseFrameworkPluginIdentitiesV1(file.bytes);
  if (!parsed.ok) return { ok: false, refusal: incompatible(parsed.detail) };
  return {
    ok: true,
    catalogVersion: loaded.version,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
    entries: parsed.entries,
  };
}
